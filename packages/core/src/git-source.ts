import { execFile, spawn } from 'node:child_process';
import { lstat, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { MissingPackagesMapError, parseNpmLockfile } from './lockfiles/npm.js';
import { parseOnlyBuilt, parsePnpmLockfile } from './lockfiles/pnpm.js';
import type { ParsedLockfile } from './lockfiles/types.js';
import {
  isLocalPathSpecifier,
  isReadableJson,
  parseManifest,
  workspacePatternsOf,
  type ParsedManifest,
} from './manifest.js';
import { isPythonLockfilePath, parsePythonLockfile, pythonLockfileFormat } from './python-lockfiles.js';
import {
  isPythonManifestPath,
  isReadableToml,
  isRequirementsPath,
  parsePythonManifest,
  parseRequirements,
} from './python-manifest.js';
import { isArchiveFile } from './python-requirement.js';
import { pathFragment } from './python-names.js';
import type { PythonLockfile, PythonManifestInfo } from './python-types.js';
import {
  EMPTY_PROJECTS,
  isReadLockfile,
  parseNpmrcDefaultRegistry,
  parseNpmrcPins,
  projectReasonKey,
  type ProjectClassification,
  type ProjectReason,
  type ProjectRule,
  type RepoState,
} from './state.js';
import { withoutByteOrderMark } from './text.js';
import { DepGuardError, type Diagnostic } from './types.js';

// Loads the two sides of a scan out of a repository. Everything below
// reads bytes and hands them to the existing parsers; no rule logic lives
// here, and the delta engine never learns whether a state came from a git
// blob or from disk.
//
// The three modes differ only in where each side's bytes come from:
//
//   staged  after = the index (git show :0:path)
//           before = HEAD, or null when HEAD is unborn
//   base    after = the working tree
//           before = the named ref (git show REF:path)
//   audit   after = the working tree, before = null
//
// git is always invoked through execFile with an argument array, never
// through a shell, so no value from a manifest, a ref, or a path is ever
// interpolated into a command line.
//
// Every path is anchored to the git toplevel whenever the scanned
// directory sits inside a repository, in all three modes. git resolves
// "REF:path" against the toplevel and nothing else, so a mode-dependent
// anchor would let one manifestPath denote two different files depending
// on how the scan was invoked -- and manifestPath feeds finding
// fingerprints, so that would quietly poison a stored baseline. A
// directory outside any repository can still be audited, and only then is
// the argument itself the anchor.

const execFileAsync = promisify(execFile);

export type ScanMode = { kind: 'staged' } | { kind: 'base'; ref: string } | { kind: 'audit' };

export interface StatePair {
  before: RepoState | null;
  after: RepoState;
  mode: ScanMode;
  // Everything the loader had to skip. Silent non-discovery is the failure
  // this channel exists to prevent: a workspace glob that expands to
  // nothing, or a package directory that turns out to be a symlink out of
  // the repository, would otherwise be indistinguishable from a clean
  // scan of a repository that simply has no such packages.
  diagnostics: Diagnostic[];
}

// Node's default execFile buffer is 1 MB. A real pnpm-lock.yaml and a
// full file listing both exceed that routinely, and an overrun kills the
// child, so the cap is raised well past any plausible lockfile. Hitting it
// still surfaces as a git error rather than as silently truncated content.
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

// git failure text reaches error messages, which reach CI logs, so it is
// trimmed to something quotable rather than pasted wholesale.
const MAX_FAILURE_TEXT = 500;

// git reports a path that the tree or the index does not carry in three
// different wordings, depending on which side is missing. Matching those
// specific sentences -- rather than reading every non-zero exit as absence
// -- keeps a genuine failure (a bad ref, an unmerged path during a
// conflict, a broken repository) loud. If a future git reworded one of
// them, an absent file would start throwing instead of reading as missing:
// loud and fixable, which is the safe direction for a tool whose entire
// job is comparing two sides of a change.
const ABSENT_BLOB_MESSAGES = [
  / does not exist in '/,
  / does not exist \(neither on disk nor in the index\)/,
  / exists on disk, but not in the index/,
];

// A ref reaches git as its own execFile argument, so shell quoting is not
// the concern here -- argument injection is. A ref beginning with "-"
// would be read as an option by whichever git command receives it. Refs
// also cannot legally contain whitespace, control characters, or a colon
// (which would additionally break the "REF:path" spelling used below), so
// anything of that shape is refused before it reaches git.
const SAFE_REF = /^[^-\s:\u0000-\u001f][^\s:\u0000-\u001f]*$/;

/**
 * True when `ref` is safe to hand to git as an argument.
 *
 * Exported so trust-base.ts screens --trust-base against the SAME rule
 * --base is screened against, rather than keeping a second copy of the
 * pattern. Two independently maintained copies of an argument-injection
 * guard is how one entry point ends up hardened and the other not.
 */
export function isUsableRef(ref: string): boolean {
  return SAFE_REF.test(ref);
}

// Errors that mean "this path is not a readable file here", as opposed to
// a permission or I/O failure that has to stay loud.
const MISSING_PATH_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

const GLOB_UNSUPPORTED = 'workspace-glob-unsupported';
const GLOB_UNEXPANDABLE = 'workspace-glob-unexpandable';
// What a comparison side could not read, treated as absent there (see
// SideRole). Each names the path or pattern and the side.
const PATTERN_UNREAD_ON_COMPARISON_SIDE = 'workspace-pattern-unread-comparison-side';
const LOCKFILE_UNREAD_ON_COMPARISON_SIDE = 'lockfile-unread-comparison-side';
// Glob syntax package managers expand that this module does not: "?",
// character classes, brace sets and extglob groups. A pattern using any of
// them would otherwise be read as a literal directory name and quietly
// discover nothing.
const UNEXPANDABLE_GLOB_SYNTAX = /[?[\]{}()]/;
const MAX_WORKSPACE_PATTERN_DEPTH = 32;
const DIR_UNREADABLE = 'workspace-dir-unreadable';
const PATH_OUTSIDE_ROOT = 'path-outside-root';
const SYMLINK_CYCLE = 'symlink-cycle';
const DUPLICATE_DIR = 'workspace-duplicate-directory';
const MULTIPLE_LOCKFILES = 'multiple-lockfiles';
const AUDIT_ANCHOR_DIFFERS = 'audit-anchor-differs';

// Resolving a path can fail because the links form a cycle, or because
// following them built something longer than the platform allows. Neither
// is a broken scan: it is one unusable path in a tree that is otherwise
// fine, and cycle links exist in real fixture trees. Since the links are
// repository content, throwing here would hand anyone who can open a pull
// request a way to abort the whole scan.
const UNRESOLVABLE_LINK_CODES = new Set(['ELOOP', 'ENAMETOOLONG']);

// Never a workspace package, and a bare "*" pattern would otherwise walk
// straight into it.
const NEVER_A_PACKAGE_DIR = 'node_modules';

// Directory names an undeclared stray manifest is not read from. A
// workspace member a glob resolved, a manifest with a lockfile beside it,
// and every lockfile, are still read.
// node_modules and .git are not announced per file. The other names are,
// one diagnostic per stray manifest.
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  'vendor',
  'vendored',
  '.git',
]);

const NEVER_WALK_DIR_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git']);
const SILENT_SKIP_DIR_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git']);
const MANIFEST_SKIPPED_DIRNAME = 'manifest-skipped-dirname';
const LOCKFILE_OUTSIDE_PREFIX = 'lockfile-outside-prefix';
const MANIFEST_UNPARSED = 'manifest-unparsed';

function parentDir(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash === -1 ? '' : relPath.slice(0, slash);
}

function baseName(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash === -1 ? relPath : relPath.slice(slash + 1);
}

function pathSkipped(relPath: string): boolean {
  return relPath.split('/').some((segment) => SKIP_DIR_NAMES.has(segment));
}

function skipSegment(relPath: string): string | null {
  for (const segment of relPath.split('/')) {
    if (SKIP_DIR_NAMES.has(segment)) {
      return segment;
    }
  }
  return null;
}

function underPrefix(relPath: string, prefix: string): boolean {
  if (prefix === '') {
    return true;
  }
  return relPath === prefix || relPath.startsWith(`${prefix}/`);
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

const PYPROJECT_TOML = 'pyproject.toml';
const REQUIREMENTS_TXT = 'requirements.txt';

function isPackageJsonPath(relPath: string): boolean {
  return baseName(relPath) === 'package.json';
}

// go.mod and go.sum: listed for the coverage statement only, never read.
function isGoModuleFile(relPath: string): boolean {
  const name = baseName(relPath);
  return name === 'go.mod' || name === 'go.sum';
}

function isProjectManifestPath(relPath: string): boolean {
  return isPackageJsonPath(relPath) || isPythonManifestPath(relPath);
}

function parseProjectManifest(relPath: string, content: string): ParsedManifest {
  if (isPythonManifestPath(relPath)) {
    return parsePythonManifest(relPath, content);
  }
  return parseManifest(relPath, content);
}

// How deep a chain of -r and -c includes is followed. pip itself has no
// limit; a chain this long is either a cycle (stopped anyway, since each
// file is read once) or not something a real repository writes.
const MAX_INCLUDE_DEPTH = 8;

function includeNote(info: PythonManifestInfo, line: number, detail: string): void {
  info.unread.push({ line, reason: 'include-unread', detail });
  info.exclusions.push({ cls: 'unrecognised', line });
}

// Follows the -r and -c lines of every requirements file read so far, the
// way pip does: relative to the including file, at most MAX_INCLUDE_DEPTH
// levels, each file read once. The target is placed as the operating
// system opens it (walkPhysicalPath, the walk the classifier uses), so a
// ".." after a symlinked directory climbs out of the link's target and a
// file under a symlinked directory is read at its real path, which a git
// side lists. A target that cannot be placed inside the repository, a file
// that is itself a symlink, or a file this side does not have is not read,
// and the including line is counted and named instead
// (requirements-line-unread). A file reached only through -c is read for
// its index lines, and its names are counted under excluded.constraint
// rather than checked: a constraint never installs a name by itself.
async function followRequirementIncludes(source: FileSource, manifests: ParsedManifest[]): Promise<void> {
  const known = new Set(manifests.map((manifest) => manifest.path));
  let frontier = manifests.filter((manifest) => manifest.python?.kind === 'requirements');
  for (let depth = 1; frontier.length > 0; depth += 1) {
    const next: ParsedManifest[] = [];
    for (const manifest of frontier) {
      const info = manifest.python;
      if (info === undefined) {
        continue;
      }
      for (const include of info.includes) {
        const dir = parentDir(manifest.path);
        // Only path characters of the target are echoed (pathFragment), as
        // for an invalid name: the target is head-written text.
        const shown = pathFragment(include.target);
        const cleaned = include.target.replace(/\\/g, '/');
        const placed = await walkPhysicalPath(source, dir, cleaned);
        if (placed === null) {
          includeNote(info, include.line, `"${shown}" is outside the repository or runs through a link that cannot be followed`);
          continue;
        }
        // The walk follows a link on the last segment too; pip would open
        // that file, and this reader never does, as before. The directory
        // part is walked on its own to ask whether the file is a link, and
        // before the known check, since the walk names the link's target.
        const slash = cleaned.lastIndexOf('/');
        const fileName = cleaned.slice(slash + 1);
        if (fileName !== '' && fileName !== '.' && fileName !== '..') {
          const parent = await walkPhysicalPath(source, dir, slash === -1 ? '' : cleaned.slice(0, slash));
          if (parent === null || (await source.isSymlink(joinRepoPath(parent, fileName)))) {
            includeNote(info, include.line, `"${shown}" is a symlink, which is never followed`);
            continue;
          }
        }
        if (known.has(placed)) {
          continue;
        }
        if (depth > MAX_INCLUDE_DEPTH) {
          includeNote(info, include.line, `"${shown}" is more than ${MAX_INCLUDE_DEPTH} includes deep`);
          continue;
        }
        const joined = placed;
        const content = await source.read(joined);
        if (content === null) {
          includeNote(info, include.line, `"${shown}" is not a file on this side`);
          continue;
        }
        known.add(joined);
        const parsed = parseRequirements(joined, content, include.constraint ? { constraint: true } : {});
        manifests.push(parsed);
        next.push(parsed);
      }
    }
    frontier = next;
  }
}

// Every Python lockfile this side has, read for names. A symlink is never
// read; it is reported unreadable like a file that does not parse.
async function loadPythonLockfiles(source: FileSource, files: readonly string[]): Promise<PythonLockfile[]> {
  const lockfiles: PythonLockfile[] = [];
  for (const relPath of files.filter(isPythonLockfilePath).sort()) {
    if (await source.isSymlink(relPath)) {
      lockfiles.push({
        path: relPath,
        format: pythonLockfileFormat(relPath) ?? 'uv',
        entries: [],
        unreadable: 'it is a symlink, which is never read',
        invalidNames: [],
      });
      continue;
    }
    const content = await source.read(relPath);
    if (content !== null) {
      lockfiles.push(parsePythonLockfile(relPath, content));
    }
  }
  return lockfiles;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorCode(err: unknown): string | undefined {
  if (!isPlainObject(err) && !(err instanceof Error)) {
    return undefined;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isMissingPathError(err: unknown): boolean {
  const code = errorCode(err);
  return code !== undefined && MISSING_PATH_CODES.has(code);
}

function failureText(err: unknown): string {
  const stderr =
    isPlainObject(err) || err instanceof Error ? (err as { stderr?: unknown }).stderr : undefined;
  if (typeof stderr === 'string' && stderr.trim() !== '') {
    return stderr.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

function truncate(text: string): string {
  return text.length > MAX_FAILURE_TEXT ? text.slice(0, MAX_FAILURE_TEXT) : text;
}

// Decides whether a failed blob read means "not here" or "something is
// wrong", and produces the quotable message for the latter.
//
// The order matters and is the whole point of this being one function:
// git puts the absence wording at the END of its message, after the path,
// so classifying truncated text turned a plainly absent file with a long
// path into a hard git error. Classification reads the full text;
// truncation happens only on the way out.
//
// Exported for its own unit test. The listing gate in gitSource means a
// blob read is only attempted for paths git has already reported, so this
// classifier is the defence-in-depth layer underneath and cannot be
// exercised through loadStates in ordinary operation.
export function classifyBlobFailure(failure: string): { absent: boolean; message: string } {
  return {
    absent: ABSENT_BLOB_MESSAGES.some((pattern) => pattern.test(failure)),
    message: truncate(failure),
  };
}

type GitRun = { ok: true; stdout: string } | { ok: false; failure: string };

async function runGit(cwd: string, args: string[]): Promise<GitRun> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, failure: failureText(err) };
  }
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const run = await runGit(cwd, args);
  if (!run.ok) {
    throw new DepGuardError(`git ${args.join(' ')}: ${truncate(run.failure)}`, 'git-error');
  }
  return run.stdout;
}

// Many blobs in one git process. Each requested id maps to its utf8
// content; an id git reports as missing, or any failure of the call,
// leaves the id out of the map, and the caller falls back to reading that
// path on its own, so a batch problem can only cost time, never content.
function catFileBatch(root: string, blobIds: string[]): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    const result = new Map<string, string>();
    let child;
    try {
      child = spawn('git', ['cat-file', '--batch'], { cwd: root, windowsHide: true });
    } catch {
      resolve(result);
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total <= MAX_GIT_OUTPUT_BYTES) {
        chunks.push(chunk);
      }
    });
    child.on('error', () => resolve(new Map()));
    child.on('close', (code) => {
      if (code !== 0 || total > MAX_GIT_OUTPUT_BYTES) {
        resolve(new Map());
        return;
      }
      const output = Buffer.concat(chunks);
      let offset = 0;
      for (const blobId of blobIds) {
        const newline = output.indexOf(0x0a, offset);
        if (newline === -1) {
          break;
        }
        const header = output.subarray(offset, newline).toString('utf8').split(' ');
        offset = newline + 1;
        if (header.length !== 3 || header[0] !== blobId) {
          // "<id> missing" or anything unexpected: stop trusting the stream.
          if (header[1] === 'missing' && header[0] === blobId) {
            continue;
          }
          break;
        }
        const size = Number(header[2]);
        if (!Number.isInteger(size) || size < 0 || offset + size > output.length) {
          break;
        }
        if (header[1] === 'blob') {
          result.set(blobId, output.subarray(offset, offset + size).toString('utf8'));
        }
        offset += size + 1;
      }
      resolve(result);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(`${blobIds.join('\n')}\n`);
  });
}

async function readBlob(root: string, spec: string): Promise<string | null> {
  const run = await runGit(root, ['show', spec]);
  if (run.ok) {
    return run.stdout;
  }
  const { absent, message } = classifyBlobFailure(run.failure);
  if (absent) {
    return null;
  }
  throw new DepGuardError(`git show ${spec}: ${message}`, 'git-error');
}

// One side's bytes, whatever they are stored in. Directory listing is part
// of the interface because workspace globs have to be expanded against the
// same snapshot the manifests are read from: a staged scan must expand
// against the index, not against whatever directories happen to exist on
// disk right now.
interface FileSource {
  read(relPath: string): Promise<string | null>;
  // The same answer as read() for each path, possibly fetched together.
  readMany(relPaths: string[]): Promise<Map<string, string | null>>;
  listChildDirs(dir: string): Promise<string[]>;
  // A stable identity for a directory, used to notice that two discovered
  // paths are the same directory reached two ways. Null means the path
  // cannot be used at all (it escapes the root, or its links cycle) and
  // has already been reported. The empty string identifies the root.
  identifyDir(relPath: string): Promise<string | null>;
  // Every file on this side, repository-relative. A git side lists the
  // index or the tree. The working tree lists tracked files and untracked
  // files git does not ignore.
  listFiles(): Promise<string[]>;
  // Every file on this side whose name is a known lockfile name, at any
  // depth, with the git blob id of its bytes (see LockfileInventoryEntry
  // in state.ts). A root lockfile name that exists but is not a readable
  // file is listed too, with a null id.
  lockfileInventory(): Promise<Array<{ path: string; blobId: string | null }>>;
  // True when the path itself is a symlink on this side: mode 120000 on a
  // git side, lstat on the working tree. The link is never followed to
  // answer this.
  isSymlink(relPath: string): Promise<boolean>;
  // The text of the symlink at this path, as stored (the blob on a git
  // side, readlink on the working tree), or null when the path is not a
  // symlink. Never followed.
  readLink(relPath: string): Promise<string | null>;
  // True when workspace pattern segments are matched against this side's
  // directory names without regard to case. Only a git side of a
  // repository whose core.ignorecase is true answers yes; it only ever
  // widens what a pattern reaches.
  ignoresCase(): Promise<boolean>;
}

// path -> blob id, or null when the path has no single stage-0 blob or is
// a symlink.
type GitListing = Map<string, string | null>;
const SYMLINK_MODE = '120000';

interface GitListingResult {
  files: GitListing;
  // Every listed path whose entry is a symlink (mode 120000).
  symlinks: Set<string>;
}

// Parses the -z output of "git ls-tree -r" ("mode type oid<TAB>path") or
// of "git ls-files -s" ("mode oid stage<TAB>path"). -z output is
// NUL-separated, which is the only listing form that survives a path
// containing a newline or a quote character; the path is everything after
// the first tab, verbatim.
async function loadGitListing(
  root: string,
  args: string[],
  shape: 'tree' | 'index'
): Promise<GitListingResult> {
  const stdout = await gitOrThrow(root, args);
  const files: GitListing = new Map();
  const symlinks = new Set<string>();
  for (const entry of stdout.split('\0')) {
    if (entry === '') {
      continue;
    }
    const tab = entry.indexOf('\t');
    if (tab === -1) {
      continue;
    }
    const fields = entry.slice(0, tab).split(' ');
    const filePath = entry.slice(tab + 1);
    // A symlink (mode 120000) gets no identity: its blob is the link text,
    // which stays the same while what the link points at changes.
    if (fields[0] === SYMLINK_MODE) {
      files.set(filePath, null);
      symlinks.add(filePath);
      continue;
    }
    if (shape === 'tree') {
      files.set(filePath, fields[2] ?? null);
      continue;
    }
    // An index path with a conflict carries several stages and no single
    // blob; its identity is unknown, which compares as changed.
    const stage = fields[2];
    const known = files.has(filePath);
    files.set(filePath, stage === '0' && !known ? (fields[1] ?? null) : null);
  }
  return { files, symlinks };
}

function isLockfileName(filePath: string): boolean {
  const slash = filePath.lastIndexOf('/');
  return LOCKFILE_NAME_SET.has(slash === -1 ? filePath : filePath.slice(slash + 1));
}

// git records files, never directories, so a subdirectory is only visible
// through the files underneath it: every directory on a file's path is a
// child of the one above it, and the final segment is a file, not a
// directory.
function buildChildIndex(files: Iterable<string>): Map<string, string[]> {
  const index = new Map<string, Set<string>>();
  for (const file of files) {
    const segments = file.split('/');
    let parent = '';
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i];
      if (name === '') {
        break;
      }
      let names = index.get(parent);
      if (names === undefined) {
        names = new Set();
        index.set(parent, names);
      }
      names.add(name);
      parent = parent === '' ? name : `${parent}/${name}`;
    }
  }
  return new Map([...index].map(([dir, names]) => [dir, [...names]]));
}

// A git-backed side: the index (revision ":0") or a ref. The file listing
// doubles as the existence oracle -- asking git to show a path it never
// recorded would produce an error that has to be interpreted, and the
// listing is needed for workspace expansion anyway. readBlob still handles
// the absence wordings underneath, so a listing that goes stale degrades
// to "absent" rather than to a crash.
//
// A git side needs none of the symlink containment the working tree needs:
// git stores a symlink as a blob holding its target text, so a blob read
// can never leave the repository.
function gitSource(
  root: string,
  revision: string,
  listArgs: string[],
  shape: 'tree' | 'index'
): FileSource {
  let listing: Promise<GitListingResult> | null = null;
  const loaded = (): Promise<GitListingResult> => {
    listing ??= loadGitListing(root, listArgs, shape);
    return listing;
  };
  const files = async (): Promise<GitListing> => (await loaded()).files;
  let ignoreCase: Promise<boolean> | null = null;
  // directory -> its child directory names, built once from the listing so
  // a "**" walk does not rescan every path at every directory.
  let childIndex: Promise<Map<string, string[]>> | null = null;
  const children = (): Promise<Map<string, string[]>> => {
    childIndex ??= files().then((listed) => buildChildIndex(listed.keys()));
    return childIndex;
  };
  return {
    async read(relPath: string): Promise<string | null> {
      if (!(await files()).has(relPath)) {
        return null;
      }
      return readBlob(root, `${revision}:${relPath}`);
    },
    // Paths with a known blob id are fetched in one "git cat-file --batch"
    // call; anything else (a symlink, a conflicted index path) goes
    // through read() exactly as before.
    async readMany(relPaths: string[]): Promise<Map<string, string | null>> {
      const listed = await files();
      const result = new Map<string, string | null>();
      const byId = new Map<string, string[]>();
      for (const relPath of relPaths) {
        if (!listed.has(relPath)) {
          result.set(relPath, null);
          continue;
        }
        const blobId = listed.get(relPath) ?? null;
        if (blobId === null) {
          result.set(relPath, await readBlob(root, `${revision}:${relPath}`));
          continue;
        }
        byId.set(blobId, [...(byId.get(blobId) ?? []), relPath]);
      }
      if (byId.size > 0) {
        const blobs = await catFileBatch(root, [...byId.keys()]);
        for (const [blobId, paths] of byId) {
          const content = blobs.get(blobId);
          for (const relPath of paths) {
            result.set(
              relPath,
              content === undefined ? await readBlob(root, `${revision}:${relPath}`) : content
            );
          }
        }
      }
      return result;
    },
    async listChildDirs(dir: string): Promise<string[]> {
      return (await children()).get(dir) ?? [];
    },
    async listFiles(): Promise<string[]> {
      return [...(await files()).keys()];
    },
    async lockfileInventory(): Promise<Array<{ path: string; blobId: string | null }>> {
      const found: Array<{ path: string; blobId: string | null }> = [];
      for (const [filePath, blobId] of await files()) {
        if (isLockfileName(filePath)) {
          found.push({ path: filePath, blobId });
        }
      }
      return found;
    },
    async isSymlink(relPath: string): Promise<boolean> {
      return (await loaded()).symlinks.has(relPath);
    },
    async readLink(relPath: string): Promise<string | null> {
      if (!(await loaded()).symlinks.has(relPath)) {
        return null;
      }
      return readBlob(root, `${revision}:${relPath}`);
    },
    // npm on a case-insensitive file system maps "lib/a" onto a directory
    // spelled "Lib/A", and git records that a checkout is on such a file
    // system in core.ignorecase. An unset or unreadable setting is false,
    // which keeps exact matching.
    ignoresCase(): Promise<boolean> {
      ignoreCase ??= runGit(root, ['config', '--bool', '--get', 'core.ignorecase']).then(
        (run) => run.ok && run.stdout.trim() === 'true'
      );
      return ignoreCase;
    },
    // git stores a symlink as a blob holding its target text and never
    // follows it, so two different paths in a tree are always two
    // different directories. The path is its own identity here.
    async identifyDir(relPath: string): Promise<string | null> {
      return relPath;
    },
  };
}

// True when target is realRoot itself or sits underneath it. Both sides
// have to be fully resolved before this is asked: comparing path text
// alone is exactly what lets a symlink present an outside file under an
// inside-looking name.
function isInsideRoot(realRoot: string, target: string): boolean {
  const rel = path.relative(realRoot, target);
  if (rel === '') {
    return true;
  }
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// The working tree is the only side where a read can leave the repository,
// because it is the only side with real symlinks. Containment is therefore
// enforced on the RESOLVED path rather than on the pattern text, which
// covers a symlinked intermediate directory ("packages/app" pointing
// outside, read as "packages/app/package.json") and a symlinked file
// alike. A symlink that stays inside the root is honoured normally --
// linking a package directory within a repository is a legitimate layout.
async function createWorkingTreeSource(
  root: string,
  diagnostics: Diagnostic[]
): Promise<FileSource> {
  // The root itself is frequently a symlink (macOS hands out /var/folders
  // temp directories that resolve under /private), so the comparison
  // baseline has to be resolved too, or every read would look external.
  let realRoot = root;
  try {
    realRoot = await realpath(root);
  } catch {
    realRoot = root;
  }

  const unreadable = (relPath: string, err: unknown): DepGuardError =>
    // A permission or I/O error is not absence. Reporting it as a missing
    // file would quietly drop a manifest or a lockfile out of the scan, so
    // it fails closed instead.
    new DepGuardError(
      `${relPath}: could not be read (${errorCode(err) ?? 'unknown error'})`,
      'read-error'
    );

  // realpath resolves every symlink along the path, so one call answers
  // "does it exist", "where does it really live", and "do the links form a
  // cycle" at once. Returns null for every path that must be skipped, with
  // a diagnostic for the cases a user would otherwise never learn about.
  const resolveContained = async (relPath: string): Promise<string | null> => {
    try {
      const resolved = await realpath(path.join(root, relPath));
      if (!isInsideRoot(realRoot, resolved)) {
        diagnostics.push({
          code: PATH_OUTSIDE_ROOT,
          message: `${relPath === '' ? '.' : relPath}: resolves outside the scanned root through a symlink; skipped`,
        });
        return null;
      }
      return resolved;
    } catch (err) {
      if (isMissingPathError(err)) {
        return null; // absent, or a symlink pointing at nothing
      }
      const code = errorCode(err);
      if (code !== undefined && UNRESOLVABLE_LINK_CODES.has(code)) {
        diagnostics.push({
          code: SYMLINK_CYCLE,
          message: `${relPath === '' ? '.' : relPath}: could not be resolved (${code}), which normally means the symlinks along it form a cycle; skipped`,
        });
        return null;
      }
      throw unreadable(relPath, err);
    }
  };

  const source: FileSource = {
    // The canonical spelling of a directory is where it really lives,
    // written relative to the root. Reporting that -- rather than whichever
    // pattern happened to reach it first -- is what keeps the two sides of
    // a base scan naming the same package the same way: the git side only
    // ever sees the real path, because it does not follow the link.
    async identifyDir(relPath: string): Promise<string | null> {
      const resolved = await resolveContained(relPath);
      if (resolved === null) {
        return null;
      }
      const relative = path.relative(realRoot, resolved);
      // Separators are normalised because every path this module reports
      // is a repository path, which uses "/" on every platform.
      return relative === '' ? '' : relative.split(path.sep).join('/');
    },

    async read(relPath: string): Promise<string | null> {
      const resolved = await resolveContained(relPath);
      if (resolved === null) {
        return null;
      }

      let stats;
      try {
        stats = await stat(resolved);
      } catch (err) {
        if (isMissingPathError(err)) {
          return null;
        }
        throw unreadable(relPath, err);
      }
      // Opening a FIFO would block the scan until something wrote to it,
      // and a directory or a device node is not a manifest either. Only a
      // regular file is ever opened.
      if (!stats.isFile()) {
        return null;
      }

      try {
        return await readFile(resolved, 'utf8');
      } catch (err) {
        if (isMissingPathError(err)) {
          return null;
        }
        throw unreadable(relPath, err);
      }
    },

    listFiles(): Promise<string[]> {
      return listWorkingTreeFiles(root);
    },
    lockfileInventory(): Promise<Array<{ path: string; blobId: string | null }>> {
      return workingTreeLockfileInventory(root);
    },

    // lstat, so the answer is about the path itself and never about what a
    // link points at. Only the final segment is asked about: a workspace
    // manifest path is built from the directory's resolved identity.
    // The file system itself decides case for a literal path here.
    async ignoresCase(): Promise<boolean> {
      return false;
    },

    async isSymlink(relPath: string): Promise<boolean> {
      try {
        return (await lstat(path.join(root, relPath))).isSymbolicLink();
      } catch (err) {
        if (isMissingPathError(err)) {
          return false;
        }
        throw unreadable(relPath, err);
      }
    },

    async readLink(relPath: string): Promise<string | null> {
      try {
        return await readlink(path.join(root, relPath), 'utf8');
      } catch (err) {
        if (isMissingPathError(err) || errorCode(err) === 'EINVAL') {
          return null; // absent, or not a symlink
        }
        throw unreadable(relPath, err);
      }
    },

    async readMany(relPaths: string[]): Promise<Map<string, string | null>> {
      const result = new Map<string, string | null>();
      for (const relPath of relPaths) {
        result.set(relPath, await source.read(relPath));
      }
      return result;
    },

    async listChildDirs(dir: string): Promise<string[]> {
      let entries;
      try {
        entries = await readdir(path.join(root, dir), { withFileTypes: true });
      } catch (err) {
        if (isMissingPathError(err)) {
          // A glob whose parent directory simply is not there (the
          // packages/ folder of a repository that has none) is ordinary,
          // not something to report.
          return [];
        }
        // Anything else means packages may exist here that this scan
        // cannot see. A direct file read fails closed for the same reason;
        // a listing cannot throw without breaking every repository with
        // one unreadable directory, so it reports instead.
        diagnostics.push({
          code: DIR_UNREADABLE,
          message: `${dir === '' ? '.' : dir}: could not be listed (${
            errorCode(err) ?? 'unknown error'
          }); any workspace packages under it were not scanned`,
        });
        return [];
      }
      // Symlinked entries are kept rather than filtered out here: an
      // in-root symlinked package directory is a legitimate layout, and
      // read() is where an out-of-root one is caught and reported. A
      // symlink to a file simply yields no manifest.
      return entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name);
    },
  };
  return source;
}

// Tracked files plus untracked files git does not ignore. Outside a
// repository the same answer is a directory walk that does not enter
// node_modules or .git and does not follow symlinks.
async function listWorkingTreeFiles(root: string): Promise<string[]> {
  const listed = await runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (listed.ok) {
    return listed.stdout.split('\0').filter((entry) => entry !== '');
  }
  return walkFiles(root);
}

async function walkFiles(root: string, dir = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (NEVER_WALK_DIR_NAMES.has(entry.name) || entry.isSymbolicLink()) {
      continue;
    }
    const relPath = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await walkFiles(root, relPath)));
      continue;
    }
    if (entry.isFile()) {
      found.push(relPath);
    }
  }
  return found;
}

// The working tree's lockfile inventory: every tracked file with a
// lockfile name at any depth, plus each root lockfile name present on disk
// whether tracked or not (the root files are the ones loadLockfiles reads
// from disk). Blob ids come from git hash-object, which applies the same
// clean filters git applies when it stores the file, so a checkout with
// converted line endings still compares equal to the committed blob.
//
// Identity is the blob id rather than a hash of decoded text: reads here
// are utf8 strings, and two different binary lockfiles can decode to the
// same string. A lockfile name that exists but is a symlink, a directory or
// a device is listed with a null id instead of being treated as absent. A
// symlink is never followed and never identified by its link text: the
// text stays the same while what it points at changes.
async function workingTreeLockfileInventory(
  root: string
): Promise<Array<{ path: string; blobId: string | null }>> {
  const candidates = new Set<string>(LOCKFILE_FILE_NAMES);
  const tracked = await runGit(root, ['ls-files', '-z', '--cached']);
  if (tracked.ok) {
    for (const entry of tracked.stdout.split('\0')) {
      if (entry !== '' && isLockfileName(entry)) {
        candidates.add(entry);
      }
    }
  }

  const found: Array<{ path: string; blobId: string | null }> = [];
  const regular: string[] = [];
  for (const candidate of [...candidates].sort()) {
    let stats;
    try {
      stats = await lstat(path.join(root, candidate));
    } catch (err) {
      if (isMissingPathError(err)) {
        continue;
      }
      found.push({ path: candidate, blobId: null });
      continue;
    }
    if (stats.isFile()) {
      regular.push(candidate);
    } else {
      found.push({ path: candidate, blobId: null });
    }
  }

  if (regular.length > 0) {
    const hashed = await runGit(root, ['hash-object', '--', ...regular]);
    const ids = hashed.ok ? hashed.stdout.split('\n').filter((line) => line !== '') : [];
    regular.forEach((candidate, index) => {
      found.push({ path: candidate, blobId: ids.length === regular.length ? ids[index] : null });
    });
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

// npm accepts both "workspaces": ["packages/*"] and the older
// "workspaces": { "packages": [...] } spelling (workspacePatternsOf).
function workspaceGlobsFromManifest(content: string | null): string[] {
  if (content === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutByteOrderMark(content));
  } catch {
    // Unreachable in practice: parseManifest reads the same bytes and
    // raises the manifest-parse error for them. Returning nothing here
    // avoids emitting a second, competing error for one bad file.
    return [];
  }
  return workspacePatternsOf(parsed);
}

function workspaceGlobsFromWorkspaceYaml(content: string | null): string[] {
  if (content === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(withoutByteOrderMark(content));
  } catch {
    // Same reasoning as above: parseOnlyBuilt parses this exact content
    // later in the same load and raises the DepGuardError for a malformed
    // workspace file, so this only has to avoid throwing a different one.
    return [];
  }
  if (!isPlainObject(parsed)) {
    return [];
  }
  return stringArray(parsed.packages);
}

// Collapses runs of slashes and drops trailing ones, the way a glob reads
// a path: "packages//a/" is "packages/a".
function collapseSlashes(pattern: string): string {
  return pattern.replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

// How a pattern's segments relate to the repository. "outside" (a ".."
// segment, or a drive letter) names something this scan cannot read;
// "dot" (a "." segment left after npm's single leading "./" or "/" strip)
// is a pattern npm itself maps to nothing.
function patternReach(pattern: string): 'inside' | 'outside' | 'dot' {
  if (/^[a-zA-Z]:/.test(pattern)) {
    return 'outside';
  }
  const segments = collapseSlashes(pattern).split('/');
  if (segments.includes('..')) {
    return 'outside';
  }
  return segments.includes('.') ? 'dot' : 'inside';
}

// A minimatch-shaped match for patterns made of literal text, "*" and
// "**": a "*" never matches a name that starts with "." unless the pattern
// segment starts with "." too, and "**" never crosses such a name. Used
// both to match a directory against an exclusion and, as npm does, to
// match one pattern's text against another. Dynamic programming over
// segment positions, so no input can make it backtrack.
function matchNpmGlob(pattern: string, candidate: string): boolean {
  const patternSegments = collapseSlashes(pattern).split('/');
  const candidateSegments = collapseSlashes(candidate).split('/');
  const segmentMatches = (segment: string, name: string): boolean =>
    !(name.startsWith('.') && !segment.startsWith('.')) && matchWildcard(segment, name);
  // reachable[j]: the pattern prefix processed so far can consume exactly
  // the first j candidate segments.
  let reachable = candidateSegments.map((_, index) => index === 0).concat([candidateSegments.length === 0]);
  for (const segment of patternSegments) {
    const next = new Array<boolean>(candidateSegments.length + 1).fill(false);
    for (let j = 0; j <= candidateSegments.length; j += 1) {
      if (!reachable[j]) {
        continue;
      }
      if (segment === '**') {
        next[j] = true;
        for (let k = j; k < candidateSegments.length && !candidateSegments[k].startsWith('.'); k += 1) {
          next[k + 1] = true;
        }
      } else if (j < candidateSegments.length && segmentMatches(segment, candidateSegments[j])) {
        next[j + 1] = true;
      }
    }
    reachable = next;
  }
  return reachable[candidateSegments.length];
}

// Wildcard matching is done by hand rather than by translating a pattern
// into a regular expression. The regex spelling this replaced ("a*a*a*..."
// becoming /^a[^/]*a[^/]*.../) backtracks exponentially: ten wildcards
// against a sixty-character directory name ran for minutes. Both halves of
// that input are repository content -- the pattern comes from a
// workspaces array, the name from a directory on disk or in the index --
// so it was reachable by anyone who could open a pull request. Same class
// of bug as the npmrc credential-stripping ReDoS.
//
// The algorithm below is the classic greedy star matcher: walk both
// strings once, remember the most recent "*" and how much it had consumed,
// and on a mismatch let that star swallow one more character instead of
// exploring every split. Worst case is the product of the two lengths, and
// there is no recursion and no backtracking stack.
function matchWildcard(pattern: string, text: string): boolean {
  let patternIndex = 0;
  let textIndex = 0;
  let starIndex = -1;
  let starTextIndex = 0;

  while (textIndex < text.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
      starIndex = patternIndex;
      starTextIndex = textIndex;
      patternIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === text[textIndex]) {
      patternIndex += 1;
      textIndex += 1;
    } else if (starIndex !== -1) {
      starTextIndex += 1;
      textIndex = starTextIndex;
      patternIndex = starIndex + 1;
    } else {
      return false;
    }
  }

  while (patternIndex < pattern.length && pattern[patternIndex] === '*') {
    patternIndex += 1;
  }
  return patternIndex === pattern.length;
}

// Whole-path matcher used for pnpm's "!packages/excluded" exclusions. Both
// sides are split on "/" first, so a "**" segment can span directory
// separators while a "*" inside any other segment cannot -- the same
// greedy-star walk as above, one level up, matching segments instead of
// characters.
//
// Exported for scan.ts's ignorePaths filter: config.ignorePaths is
// attacker-writable content shaped exactly like a workspace pattern, and
// reusing this hardened, no-RegExp matcher rather than writing a second
// pattern matcher is what keeps a third ReDoS from being written against
// it.
export function matchGlobPath(pattern: string, candidate: string): boolean {
  const patternSegments = pattern.split('/');
  const candidateSegments = candidate.split('/');
  let patternIndex = 0;
  let candidateIndex = 0;
  let starIndex = -1;
  let starCandidateIndex = 0;

  while (candidateIndex < candidateSegments.length) {
    if (patternIndex < patternSegments.length && patternSegments[patternIndex] === '**') {
      starIndex = patternIndex;
      starCandidateIndex = candidateIndex;
      patternIndex += 1;
    } else if (
      patternIndex < patternSegments.length &&
      matchWildcard(patternSegments[patternIndex], candidateSegments[candidateIndex])
    ) {
      patternIndex += 1;
      candidateIndex += 1;
    } else if (starIndex !== -1) {
      starCandidateIndex += 1;
      candidateIndex = starCandidateIndex;
      patternIndex = starIndex + 1;
    } else {
      return false;
    }
  }

  while (patternIndex < patternSegments.length && patternSegments[patternIndex] === '**') {
    patternIndex += 1;
  }
  return patternIndex === patternSegments.length;
}

async function expandPattern(
  source: FileSource,
  pattern: string,
  diagnostics: Diagnostic[]
): Promise<string[]> {
  const segments = collapseSlashes(pattern).split('/');
  const ignoreCase = await source.ignoresCase();
  const literal = !segments.some((segment) => segment.includes('*'));
  if (literal && !ignoreCase) {
    return [segments.join('/')];
  }
  // With case ignored, a literal segment is matched against the names the
  // side lists, and a wildcard against lowercased names, so every spelling
  // of the directory is reached.
  const fold = (text: string): string => (ignoreCase ? text.toLowerCase() : text);

  // A segment-by-segment walk. "*" inside a segment matches within one
  // directory name; a segment that is exactly "**" matches zero or more
  // directories. As in npm's glob, a wildcard does not match a name that
  // starts with "." unless the pattern segment does, and "**" does not
  // descend into one.
  //
  // A "**" walk visits each real directory once per pattern position, by
  // identity, so a symlink that loops back ends the walk instead of
  // recursing. The depth cap is a backstop: a tree deeper than it cannot
  // be expanded completely, and that is could-not-run, not a quiet miss.
  const results: string[] = [];
  const visited = new Set<string>();
  const walk = async (dir: string, index: number, depth: number): Promise<void> => {
    if (index === segments.length) {
      results.push(dir);
      return;
    }
    if (depth > MAX_WORKSPACE_PATTERN_DEPTH) {
      throw new DepGuardError(
        `workspace pattern "${pattern}": the directory tree under it is deeper than ` +
          `${MAX_WORKSPACE_PATTERN_DEPTH} levels, so it could not be expanded completely; list the ` +
          'workspace directories explicitly instead of this pattern. Refusing to report a clean pass ' +
          'over workspace packages that were not discovered',
        GLOB_UNEXPANDABLE
      );
    }
    const segment = segments[index];
    const childPath = (child: string): string => (dir === '' ? child : `${dir}/${child}`);
    if (segment === '**') {
      const identity = await source.identifyDir(dir);
      if (identity === null) {
        return; // outside the root, or an unresolvable link; already reported
      }
      const key = JSON.stringify([identity, index]);
      if (visited.has(key)) {
        return;
      }
      visited.add(key);
      await walk(dir, index + 1, depth);
      for (const child of await source.listChildDirs(dir)) {
        if (child === NEVER_A_PACKAGE_DIR || child.startsWith('.')) {
          continue;
        }
        await walk(childPath(child), index, depth + 1);
      }
      return;
    }
    if (segment.includes('*')) {
      for (const child of await source.listChildDirs(dir)) {
        if (
          child === NEVER_A_PACKAGE_DIR ||
          (child.startsWith('.') && !segment.startsWith('.')) ||
          !matchWildcard(fold(segment), fold(child))
        ) {
          continue;
        }
        await walk(childPath(child), index + 1, depth + 1);
      }
      return;
    }
    if (ignoreCase) {
      for (const child of await source.listChildDirs(dir)) {
        if (fold(child) === fold(segment)) {
          await walk(childPath(child), index + 1, depth + 1);
        }
      }
      return;
    }
    await walk(childPath(segment), index + 1, depth + 1);
  };
  await walk('', 0, 0);
  if (literal && results.length === 0) {
    // Nothing on this side under any spelling: the pattern stands as
    // written, exactly as when case is not ignored.
    return [segments.join('/')];
  }
  return results;
}

// One workspaces list, resolved the way npm's own workspace mapper resolves
// it (checked against npm 10.9.8's @npmcli/map-workspaces; see the
// git-source tests). Patterns are taken in order:
//
//   - a run of leading "!" negates when its length is odd;
//   - one leading "./" or run of "/" is stripped, so "/packages/a" is
//     repository-relative;
//   - a positive pattern cancels every earlier exclusion its own text
//     matches, and every exclusion left at the end removes the positive
//     patterns whose text it matches;
//   - a backslash in a positive pattern is a separator;
//   - the directories the remaining positive patterns match, minus those an
//     exclusion matches, are the workspaces.
//
// What this module cannot reproduce exactly refuses (exit 2) on the side
// being judged rather than discovering less, and on a comparison side names
// no members there, with a note: a positive pattern with ".." or a drive or with glob
// syntax beyond "*" and "**". The message for a ".." pattern that resolves
// inside the repository says to drop the segment; otherwise it says the
// pattern names something outside the repository. The pattern "." is the
// root, which is always read, and is noted; any other positive pattern
// with a "." segment is one npm maps to nothing, and is noted. An
// exclusion this module cannot apply exactly is not applied and is noted,
// which only ever widens the scan.
// The positive patterns and the exclusions that survive npm's ordering
// rules (see discoverWorkspaceDirs). An exclusion this module cannot apply
// exactly is dropped and handed to onUnsupportedExclusion.
function partitionWorkspacePatterns(
  patterns: readonly string[],
  onUnsupportedExclusion: (raw: string) => void = () => {}
): { positives: string[]; negatedPatterns: string[] } {
  const positives: string[] = [];
  const negatedPatterns: string[] = [];
  for (const raw of patterns) {
    const bangs = /^!+/.exec(raw)?.[0].length ?? 0;
    const pattern = raw.slice(bangs).replace(/^\.?\/+/, '');
    if (bangs % 2 === 1) {
      if (
        pattern.includes('\\') ||
        UNEXPANDABLE_GLOB_SYNTAX.test(pattern) ||
        patternReach(pattern) !== 'inside'
      ) {
        onUnsupportedExclusion(raw);
        continue;
      }
      negatedPatterns.push(pattern);
      continue;
    }
    // npm's own loop, reproduced with its quirk: an exclusion removed here
    // shifts the next one into its index, and that next one is not tested
    // against this pattern.
    for (let i = 0; i < negatedPatterns.length; i += 1) {
      if (matchNpmGlob(negatedPatterns[i], pattern)) {
        negatedPatterns.splice(i, 1);
      }
    }
    positives.push(pattern);
  }
  for (const negated of negatedPatterns) {
    for (const matched of positives.filter((pattern) => matchNpmGlob(negated, pattern))) {
      positives.splice(positives.indexOf(matched), 1);
    }
  }
  return { positives, negatedPatterns: negatedPatterns.map(collapseSlashes) };
}

// Whether a directory, relative to an install root, is one of that root's
// workspace members under these patterns, decided by matching rather than
// by walking the tree, so it never throws. A pattern this module cannot
// match exactly (glob syntax beyond "*" and "**", a ".." or a drive)
// counts as `unsupported` says: "covers" where the stricter answer is to
// read more (MB2, reading members), "excludes" where it is to exempt less
// (B1, confirming a link). No directory with a node_modules segment is a
// member, as in discoverWorkspaceDirs.
/**
 * Whether a directory, relative to a uv workspace root, is a member under
 * that root's [tool.uv.workspace] `members` and not under its `exclude`,
 * with the same exact-matching rule the npm workspace patterns use. A
 * member pattern that cannot be matched exactly covers nothing, and an
 * exclude pattern that cannot be matched exactly excludes: both read as
 * "not a member", which exempts less.
 */
export function uvWorkspaceCovers(
  members: readonly string[],
  exclude: readonly string[],
  relDir: string
): boolean {
  if (!members.some((pattern) => workspacePatternsCover([pattern], relDir, 'excludes'))) {
    return false;
  }
  return !exclude.some((pattern) => workspacePatternsCover([pattern], relDir, 'covers'));
}

function workspacePatternsCover(
  patterns: readonly string[],
  relDir: string,
  unsupported: 'covers' | 'excludes'
): boolean {
  const coverage = workspaceCoverage(patterns, relDir);
  return coverage.exact || (unsupported === 'covers' && coverage.inexact.length > 0);
}

// How one list of workspace patterns reaches a directory: `exact` when a
// pattern this module matches exactly covers it, and `inexact` the text of
// every positive pattern it cannot match exactly (which "covers" under the
// stricter reading). A matching negation in the same list reaches nothing.
function workspaceCoverage(patterns: readonly string[], relDir: string): { exact: boolean; inexact: string[] } {
  const none = { exact: false, inexact: [] };
  if (relDir === '' || relDir.split('/').includes(NEVER_A_PACKAGE_DIR)) {
    return none;
  }
  const { positives, negatedPatterns } = partitionWorkspacePatterns(patterns);
  if (negatedPatterns.some((negated) => matchNpmGlob(negated, relDir))) {
    return none;
  }
  let exact = false;
  const inexact: string[] = [];
  for (const raw of positives) {
    const pattern = collapseSlashes(raw.replace(/\\/g, '/'));
    if (pattern === '') {
      continue;
    }
    if (patternReach(pattern) !== 'inside' || UNEXPANDABLE_GLOB_SYNTAX.test(pattern)) {
      inexact.push(raw);
      continue;
    }
    if (matchNpmGlob(pattern, relDir)) {
      exact = true;
    }
  }
  return { exact, inexact };
}

// One input's workspace patterns as the key of a fail-closed reason: the
// positives and the negations as matching reads them, each list
// canonical and sorted, so the same patterns written in another order are
// the same key and any change to what they cover is a different one.
function canonicalPatterns(patterns: readonly string[]): string {
  const { positives, negatedPatterns } = partitionWorkspacePatterns(patterns);
  return JSON.stringify([canonicalPatternList(positives), canonicalPatternList(negatedPatterns)]);
}

function canonicalPatternList(patterns: readonly string[]): string[] {
  return [...new Set(patterns.map((raw) => collapseSlashes(raw.replace(/\\/g, '/'))))].sort();
}

// Whether expanding a list of workspace patterns would pass through relDir
// to reach a directory strictly below it: a proper prefix of a pattern's
// segments matches relDir, or a pattern ending in "**" matches it and can
// continue past it. A pattern this module cannot match exactly counts when
// inexactCounts is set, as it covers in workspaceCoverage. Negations are
// not applied: this only decides whether to fail closed on a symlinked
// directory at that position.
function workspacePatternsReachBelow(patterns: readonly string[], relDir: string, inexactCounts: boolean): boolean {
  if (relDir === '' || relDir.split('/').includes(NEVER_A_PACKAGE_DIR)) {
    return false;
  }
  const { positives } = partitionWorkspacePatterns(patterns);
  for (const raw of positives) {
    const pattern = collapseSlashes(raw.replace(/\\/g, '/'));
    if (pattern === '') {
      continue;
    }
    if (patternReach(pattern) !== 'inside' || UNEXPANDABLE_GLOB_SYNTAX.test(pattern)) {
      if (inexactCounts) {
        return true;
      }
      continue;
    }
    const segments = pattern.split('/');
    for (let count = 1; count <= segments.length; count += 1) {
      const continues = count < segments.length || segments[count - 1] === '**';
      if (continues && matchNpmGlob(segments.slice(0, count).join('/'), relDir)) {
        return true;
      }
    }
  }
  return false;
}

async function discoverWorkspaceDirs(
  source: FileSource,
  patterns: string[],
  diagnostics: Diagnostic[],
  role: SideRole
): Promise<string[]> {
  const { positives, negatedPatterns } = partitionWorkspacePatterns(patterns, (raw) => {
    diagnostics.push({
      code: GLOB_UNSUPPORTED,
      message: `workspace exclusion "${raw}": this tool cannot apply it exactly, so it was not applied and the directories it names were scanned`,
    });
  });

  const dirs = new Set<string>();
  const resolvePositive = async (raw: string): Promise<void> => {
    const pattern = collapseSlashes(raw.replace(/\\/g, '/'));
    if (pattern === '') {
      return; // the repository root, which is always read
    }
    const reach = patternReach(pattern);
    const staysInside = !/^[a-zA-Z]:/.test(pattern) && !path.posix.normalize(pattern).startsWith('..');
    if (reach === 'outside' && staysInside) {
      throw new DepGuardError(
        `workspace pattern "${raw}": contains a ".." parent segment, which this tool does not expand; ` +
          'refusing to report a clean pass over workspace packages that were not read. Write the ' +
          'pattern without it',
        GLOB_UNEXPANDABLE
      );
    }
    if (reach === 'outside') {
      throw new DepGuardError(
        `workspace pattern "${raw}": names a directory outside the repository, which this scan cannot ` +
          'read; refusing to report a clean pass over workspace packages that were not read. Rewrite it ' +
          'as a path inside the repository, or remove it',
        GLOB_UNEXPANDABLE
      );
    }
    if (reach === 'dot') {
      diagnostics.push({
        code: GLOB_UNSUPPORTED,
        message:
          pattern === '.'
            ? `workspace pattern "${raw}": npm maps it to the repository root, whose package.json is always scanned; it adds nothing`
            : `workspace pattern "${raw}": has a "." segment, which npm maps to no workspace; it was ignored`,
      });
      return;
    }
    if (UNEXPANDABLE_GLOB_SYNTAX.test(pattern)) {
      // Provably empty: the directory above the first segment that needs
      // expanding has no subdirectories at all, so nothing could match.
      const segments = pattern.split('/');
      const firstGlob = segments.findIndex(
        (segment) => segment.includes('*') || UNEXPANDABLE_GLOB_SYNTAX.test(segment)
      );
      const literalParent = segments.slice(0, firstGlob).join('/');
      if ((await source.listChildDirs(literalParent)).length === 0) {
        diagnostics.push({
          code: GLOB_UNSUPPORTED,
          message: `workspace pattern "${raw}": uses glob syntax this tool does not expand, and "${literalParent === '' ? '.' : literalParent}" has no subdirectories for it to match`,
        });
        return;
      }
      throw new DepGuardError(
        `workspace pattern "${raw}": uses glob syntax this tool does not expand (only "*" and "**" ` +
          'are), so the workspace packages it names could not be discovered; refusing to report a ' +
          'clean pass over manifests that were not read. Rewrite it with "*" and "**", or list the ' +
          'directories explicitly',
        GLOB_UNEXPANDABLE
      );
    }
    for (const dir of await expandPattern(source, pattern, diagnostics)) {
      if (
        dir === '' ||
        dir.split('/').includes(NEVER_A_PACKAGE_DIR) ||
        negatedPatterns.some((negated) => matchNpmGlob(negated, dir))
      ) {
        continue;
      }
      dirs.add(dir);
    }
  };
  for (const raw of positives) {
    try {
      await resolvePositive(raw);
    } catch (err) {
      // On a comparison side a pattern this tool cannot expand contributes
      // no members there. The judged side's members are then compared
      // against fewer manifests, so their dependencies count as new: the
      // stricter direction, and the pull request that rewrites the pattern
      // is not refused for the side it replaces.
      if (role.kind === 'judged' || !(err instanceof DepGuardError) || err.code !== GLOB_UNEXPANDABLE) {
        throw err;
      }
      diagnostics.push({
        code: PATTERN_UNREAD_ON_COMPARISON_SIDE,
        message:
          `workspace pattern "${raw}": could not be expanded on ${role.label}, so it named no ` +
          "workspace packages there; the scanned side's packages are judged against what remains",
      });
    }
  }
  return [...dirs];
}

type LockfileLoader = (lockfilePath: string, content: string) => ParsedLockfile;

// yarn.lock and bun.lock are text formats dep-guard does not parse. They
// still produce a ParsedLockfile -- with the format tag, an empty entries
// map, and a diagnostic -- so the scan reports itself as manifest-only
// rather than looking like a repository with no lockfile at all.
function manifestOnlyLockfile(format: 'yarn' | 'bun'): LockfileLoader {
  return (lockfilePath) => ({
    format,
    path: lockfilePath,
    entries: new Map(),
    diagnostics: [
      {
        code: 'lockfile-format-manifest-only',
        message: `${lockfilePath}: this lockfile format is not parsed; lockfile-backed checks fall back to manifest evidence for this scan`,
      },
    ],
    workspaceLocalNames: new Set(),
  });
}

function binaryLockfile(lockfilePath: string): ParsedLockfile {
  return {
    format: 'bun',
    path: lockfilePath,
    entries: new Map(),
    diagnostics: [
      {
        code: 'lockfile-binary-skipped',
        message: `${lockfilePath}: binary lockfiles cannot be inspected; lockfile-backed checks fall back to manifest evidence for this scan`,
      },
    ],
    workspaceLocalNames: new Set(),
  };
}

// Detection order. The first one present is the scan's primary lockfile
// (the one its run summary names); npm and pnpm come first because they are
// the two formats with real parsers behind them. npm-shrinkwrap.json leads
// because npm gives it precedence over package-lock.json when both exist.
//
// Order is NOT "first present wins" any more: every npm or pnpm lockfile
// present at the root is parsed and checked (loadLockfiles below). Which
// file an install honours depends on the package manager the developer
// runs, and a clean file beside a tampered one -- a package-lock.json decoy
// next to a pnpm-lock.yaml, or a package-lock.json beside a tampered
// npm-shrinkwrap.json -- scanned clean when only one was read.
const LOCKFILE_CANDIDATES: Array<[string, LockfileLoader]> = [
  ['npm-shrinkwrap.json', parseNpmLockfile],
  ['package-lock.json', parseNpmLockfile],
  ['pnpm-lock.yaml', parsePnpmLockfile],
  ['yarn.lock', manifestOnlyLockfile('yarn')],
  ['bun.lock', manifestOnlyLockfile('bun')],
  ['bun.lockb', (lockfilePath) => binaryLockfile(lockfilePath)],
];

// The lockfile names this module recognizes, exported so a caller that
// needs to recognize the same variety of file without duplicating this
// list -- scan.ts's empty-scan-fail-closed existence probe -- stays in
// sync with whatever loadLockfile actually looks for. Unlike
// LOCKFILE_CANDIDATES, order carries no meaning here: every consumer of
// this array only ever asks "is this name one of them".
export const LOCKFILE_FILE_NAMES: readonly string[] = LOCKFILE_CANDIDATES.map(([name]) => name);
const LOCKFILE_NAME_SET: ReadonlySet<string> = new Set(LOCKFILE_FILE_NAMES);

// A parse failure propagates. A null return means the file is genuinely
// absent and nothing else: swallowing a malformed before-side lockfile
// into a null would turn a one-line change into a whole-repository delta,
// which is exactly the shape an attacker would want a corrupt lockfile to
// produce.
//
// Returns the primary lockfile (the first READ one in detection order, else
// the first present) and every other present lockfile that has a real
// parser behind it. yarn.lock and bun lockfiles are not added as extras:
// they have no entries to diff. Their presence is still recorded, in the
// lockfile inventory, which is what the downgrade rule and the
// lockfile-unread-sibling note read.
async function loadLockfiles(
  source: FileSource,
  diagnostics: Diagnostic[],
  // Lockfiles treated as absent on this side (a symlink on a comparison
  // side); they are never read. Paths are repository-relative.
  unread: ReadonlySet<string>,
  role: SideRole,
  directory = '',
  // npm lockfiles this side already parsed for classification, reused
  // rather than parsed twice.
  parsedNpm: ReadonlyMap<string, ParsedLockfile> = new Map(),
  // Where a lockfile-parse failure is collected instead of thrown, so the
  // caller can name every one at once. Without it the first one throws.
  parseFailures?: DepGuardError[]
): Promise<{ lockfile: ParsedLockfile | null; extraLockfiles: ParsedLockfile[] }> {
  const loaded: ParsedLockfile[] = [];
  for (const [base, load] of LOCKFILE_CANDIDATES) {
    const name = directory === '' ? base : `${directory}/${base}`;
    if (unread.has(name)) {
      continue;
    }
    // bun.lockb is binary and is read only to learn that it exists; the
    // lossily decoded content it returns is never parsed.
    const content = await source.read(name);
    if (content === null) {
      continue;
    }
    try {
      loaded.push((load === parseNpmLockfile ? parsedNpm.get(name) : undefined) ?? load(name, content));
    } catch (err) {
      // An npm lockfile whose version promises a packages map it does not
      // have is refused on the judged side. On a comparison side it is an
      // unread lockfile there: no entries and no coverage, so the judged
      // side's lockfile is compared against nothing and its entries count
      // as new, and the pull request that regenerates it is not refused
      // for the file it replaces.
      if (role.kind === 'judged' || !(err instanceof MissingPackagesMapError)) {
        if (parseFailures !== undefined && err instanceof DepGuardError && err.code === 'lockfile-parse') {
          parseFailures.push(err);
          continue;
        }
        throw err;
      }
      const message =
        `${name}: could not be read on ${role.label} (${err.message}), so it is treated as a ` +
        "lockfile this tool does not read there; the scanned side's lockfile entries count as new";
      diagnostics.push({ code: LOCKFILE_UNREAD_ON_COMPARISON_SIDE, message });
      loaded.push({
        format: 'npm',
        path: name,
        entries: new Map(),
        diagnostics: [],
        workspaceLocalNames: new Set(),
        notRead: true,
      });
    }
  }
  // The primary is the first lockfile this tool actually reads, so a v1
  // npm file listed ahead of a pnpm lockfile does not become the file the
  // manifest walk and the run summary describe. With nothing read, the
  // first present one stands.
  const lockfile = loaded.find(isReadLockfile) ?? loaded[0] ?? null;
  const extraLockfiles = loaded.filter(
    (parsed) => parsed !== lockfile && (parsed.format === 'npm' || parsed.format === 'pnpm')
  );
  if (lockfile !== null && extraLockfiles.length > 0) {
    diagnostics.push({
      code: MULTIPLE_LOCKFILES,
      message:
        `${[lockfile, ...extraLockfiles].map((entry) => entry.path).join(', ')}: more than one ` +
        `lockfile is present in ${directory === '' ? 'the repository root' : directory}; every one of ` +
        'them was checked, because which one an install honours depends on the package manager in use',
    });
  }
  // The further documents of a multi-document pnpm lockfile ride as extra
  // lockfiles of their own, after the files themselves.
  for (const parsed of lockfile === null ? extraLockfiles : [lockfile, ...extraLockfiles]) {
    extraLockfiles.push(...(parsed.additionalDocuments ?? []));
  }
  return { lockfile, extraLockfiles };
}

const ROOT_MANIFEST = 'package.json';
const WORKSPACE_YAML = 'pnpm-workspace.yaml';
// Exported so trust-base.ts reads the same path out of the base ref that
// loadState reads from the scanned side. .npmrc is a CONTROL INPUT, not a
// subject: its scope pins are what decides whether the
// dependency-confusion pin-mismatch rule fires at all, so on a
// pull-request run it has to come from the base like the config and the
// baseline do. See docs/INVARIANTS.md, "A control input is not read from
// the tree being judged".
export const NPMRC = '.npmrc';

// The root lockfiles this module parses. yarn.lock and the bun lockfiles
// are only recorded as present, and keep the inventory rule for a
// symlinked unread lockfile.
const PARSED_LOCKFILE_NAMES: readonly string[] = LOCKFILE_CANDIDATES.filter(
  ([, load]) => load === parseNpmLockfile || load === parsePnpmLockfile
).map(([name]) => name);

const SYMLINK_ON_COMPARISON_SIDE = 'symlinked-input-comparison-side';
const COMPARISON_SIDE_CODES: ReadonlySet<string> = new Set([
  SYMLINK_ON_COMPARISON_SIDE,
  PATTERN_UNREAD_ON_COMPARISON_SIDE,
  LOCKFILE_UNREAD_ON_COMPARISON_SIDE,
]);

// Which part a side plays in a scan. The judged side is the change under
// review (the index under --staged, the working tree otherwise); a
// comparison side is what it is compared against (HEAD under --staged, the
// --base ref, the trust base), named in diagnostics by its label.
type SideRole = { kind: 'judged' } | { kind: 'comparison'; label: string };
const JUDGED: SideRole = { kind: 'judged' };

// A lockfile or manifest this scan parses is never read through a symlink,
// on any side. A git side stores a symlink as its link text and the working
// tree follows it, so the two kinds of side would parse different bytes for
// one path.
//
// On the judged side such a path is could-not-run. On a comparison side it
// is treated as absent there, with a diagnostic: it contributes no entries
// and no coverage, so the judged side's regular file is compared against
// nothing and every entry in it is judged as new. That is the stricter
// direction, and it is what lets the pull request that replaces the link
// with a regular file pass. Returns the paths treated as absent.
// The kind of file a parsed input is, for a message.
function inputKindText(relPath: string): string {
  if (isRecognisedLockfilePath(relPath)) {
    return 'a lockfile';
  }
  const name = baseName(relPath);
  if (isPackageJsonPath(relPath)) {
    return 'a package.json';
  }
  return name === PYPROJECT_TOML || name === 'Pipfile' ? `a ${name}` : 'a requirements file';
}

async function screenSymlinkedInputs(
  source: FileSource,
  relPaths: string[],
  role: SideRole,
  diagnostics: Diagnostic[]
): Promise<Set<string>> {
  const absent = new Set<string>();
  for (const relPath of relPaths) {
    if (!(await source.isSymlink(relPath))) {
      continue;
    }
    if (role.kind === 'judged') {
      throw new DepGuardError(
        `${relPath}: is a symlink on the side being judged. dep-guard does not parse ${inputKindText(relPath)} ` +
          'through a symlink; replace the link with a regular file. A comparison side ' +
          'that still has the link does not block that change',
        'symlinked-input'
      );
    }
    absent.add(relPath);
    diagnostics.push({
      code: SYMLINK_ON_COMPARISON_SIDE,
      message:
        `${relPath}: is a symlink on ${role.label}, so it was not read there; the scanned side's ` +
        'file is judged as if that side had no such file',
    });
  }
  return absent;
}

function isParsedLockfilePath(relPath: string): boolean {
  return (PARSED_LOCKFILE_NAMES as readonly string[]).includes(baseName(relPath));
}

const WORKSPACE_LINK_UNCONFIRMED = 'workspace-link-unconfirmed';
const NPM_SHRINKWRAP = 'npm-shrinkwrap.json';
const NPM_LOCKFILE_NAMES: ReadonlySet<string> = new Set([NPM_SHRINKWRAP, 'package-lock.json']);

function manifestPathIn(dir: string): string {
  return dir === '' ? ROOT_MANIFEST : `${dir}/${ROOT_MANIFEST}`;
}

// Why an npm lockfile's link entries cannot vouch for anything in its
// directory, or null when it is the lockfile npm installs from there.
//
// npm reads npm-shrinkwrap.json in preference to package-lock.json, so a
// package-lock.json beside a shrinkwrap is never the one installed from. A
// "packageManager" field in the directory's own package.json names the
// manager outright (pnpm 9 and corepack refuse to install under a field
// naming another one, so setting it falsely is loud rather than silent).
// Without that field, another lockfile format in the same directory means
// this scan cannot tell which manager the developer runs, and the stricter
// answer is that no link entry vouches for anything.
function inactiveNpmLockfileReason(
  lockfilePath: string,
  presentLockfilePaths: readonly string[],
  manifests: readonly ParsedManifest[]
): string | null {
  const dir = parentDir(lockfilePath);
  const presentHere = presentLockfilePaths
    .filter((present) => parentDir(present) === dir)
    .map(baseName);
  if (baseName(lockfilePath) !== NPM_SHRINKWRAP && presentHere.includes(NPM_SHRINKWRAP)) {
    return `npm installs from ${NPM_SHRINKWRAP} in that directory, not from this file`;
  }
  const declared = manifests.find((manifest) => manifest.path === manifestPathIn(dir))?.packageManager;
  if (declared !== undefined) {
    const manager = declared.split('@')[0]?.trim() ?? '';
    return manager === 'npm' ? null : `${manifestPathIn(dir)} declares "packageManager": "${declared}"`;
  }
  const others = presentHere.filter((name) => !NPM_LOCKFILE_NAMES.has(name));
  return others.length === 0
    ? null
    : `${others.join(', ')} sits beside it and no "packageManager" field says which one is installed from`;
}

// The workspace-local names one side may exempt from the name checks.
//
// A "link": true entry is a claim written by whoever wrote the lockfile, on
// a pull request its author. Taken at its word, a nine-line decoy
// package-lock.json beside the pnpm-lock.yaml an install actually reads
// switched off unknown-package and typosquat for any name it listed. So a
// claim is confirmed only when both hold on this same side:
//
//   - its lockfile is the npm lockfile the install reads in its directory
//     (inactiveNpmLockfileReason), and
//   - its "resolved" path, joined to that directory, names a directory
//     inside the repository whose package.json this side parsed and whose
//     own "name" field is exactly the linked name, and
//   - that directory is a workspace member of the install root: the npm
//     "workspaces" field of the package.json in the lockfile's own
//     directory covers it (workspacePatternsCover). A package.json planted
//     anywhere else is not a workspace, npm does not link it, and npm
//     install rewrites the entry to a registry fetch.
//
// Under --trust-base the workspaces field is read from the trust base when
// the base has that package.json (`workspaceSource`), so a pull request
// that widens the field cannot confirm its own link; the diagnostic says
// when that is why. A install root new in the pull request has nothing on
// the base and is judged by its own field.
//
// A link entry with no "resolved" confirms nothing: npm always writes one.
// Every claim that fails is named in one diagnostic per lockfile, with its
// reason, so a reader can see why a sibling is being name-checked.
//
// A confirmed name is keyed by its lockfile's directory, because that
// lockfile is what installs the manifests it covers and nothing else: a
// sibling that is real in one npm project says nothing about a manifest
// that a pnpm lockfile in another directory installs from the registry.
// The trust base's side of that question is its RepoState.projects
// `workspaceFields`, the same classification the ignorePaths rule reads:
// one value per side, two consumers. Keyed on "the base has a package.json
// at that path", whether or not the base has a lockfile there, and only the
// field is read, never pnpm-workspace.yaml.
export interface WorkspaceSource {
  label: string;
  workspaceFields: ReadonlyMap<string, readonly string[]>;
}

export function confirmWorkspaceLocalNames(
  lockfiles: readonly ParsedLockfile[],
  presentLockfilePaths: readonly string[],
  manifests: readonly ParsedManifest[],
  diagnostics: Diagnostic[],
  workspaceSource: WorkspaceSource | null = null
): Map<string, Set<string>> {
  const byDir = new Map<string, Set<string>>();
  const unconfirmed: Array<{ lockfilePath: string; failures: Map<string, string> }> = [];
  for (const lockfile of lockfiles) {
    if (lockfile.format !== 'npm' || lockfile.workspaceLocalNames.size === 0) {
      continue;
    }
    const links: Array<{ name: string; resolved?: string }> =
      lockfile.workspaceLinks ?? [...lockfile.workspaceLocalNames].map((name) => ({ name }));
    const inactive = inactiveNpmLockfileReason(lockfile.path, presentLockfilePaths, manifests);
    const dir = parentDir(lockfile.path);
    const rootManifestPath = manifestPathIn(dir);
    const headPatterns = manifests.find((manifest) => manifest.path === rootManifestPath)?.workspaces ?? [];
    const baseRoot = workspaceSource?.workspaceFields.get(rootManifestPath);
    const patterns = baseRoot === undefined ? headPatterns : baseRoot;
    const failures = new Map<string, string>();
    for (const link of links) {
      const reason = ((): string | null => {
        if (inactive !== null) {
          return inactive;
        }
        if (link.resolved === undefined) {
          return 'the entry records no linked path';
        }
        const target = path.posix.normalize(dir === '' ? link.resolved : `${dir}/${link.resolved}`);
        const targetDir = target === '.' ? '' : target.replace(/\/+$/, '');
        if (path.posix.isAbsolute(target) || target === '..' || target.startsWith('../')) {
          return `it links to "${link.resolved}", outside the repository`;
        }
        // "read", not "found": the scan may have left a package.json there
        // unread (one outside a subdirectory scan), and a note that says a
        // file in the tree is not there is false.
        if (!manifests.some((manifest) => manifest.path === manifestPathIn(targetDir) && manifest.name === link.name)) {
          return `this scan read no package.json named "${link.name}" at ${targetDir === '' ? 'the root' : targetDir}`;
        }
        const relDir = dir === '' ? targetDir : targetDir.startsWith(`${dir}/`) ? targetDir.slice(dir.length + 1) : null;
        if (relDir !== null && workspacePatternsCover(patterns, relDir, 'excludes')) {
          return null;
        }
        const where = baseRoot === undefined ? rootManifestPath : `${rootManifestPath} on ${workspaceSource?.label}`;
        const widened =
          baseRoot !== undefined && relDir !== null && workspacePatternsCover(headPatterns, relDir, 'excludes')
            ? '; this change edits that field to cover it, and a pull request cannot widen it for its own link'
            : '';
        return `the "workspaces" field of ${where} does not cover ${targetDir}${widened}`;
      })();
      if (reason === null) {
        const names = byDir.get(dir) ?? new Set<string>();
        names.add(link.name);
        byDir.set(dir, names);
      } else if (!failures.has(link.name)) {
        failures.set(link.name, reason);
      }
    }
    if (failures.size > 0) {
      unconfirmed.push({ lockfilePath: lockfile.path, failures });
    }
  }
  for (const { lockfilePath, failures } of unconfirmed) {
    const still = [...failures]
      .filter(([name]) => !(byDir.get(parentDir(lockfilePath))?.has(name) ?? false))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    if (still.length === 0) {
      continue;
    }
    diagnostics.push({
      code: WORKSPACE_LINK_UNCONFIRMED,
      message:
        `${lockfilePath}: records "link": true for ` +
        `${still.map(([name, reason]) => `"${name}" (${reason})`).join(', ')}, so ` +
        `${still.length === 1 ? 'that name is' : 'those names are'} name-checked like any registry dependency`,
    });
  }
  return byDir;
}

// The judged side's workspace-local names, re-confirmed with the install
// roots' "workspaces" fields read from the trust base (see
// confirmWorkspaceLocalNames). Replaces the judged side's own
// workspace-link-unconfirmed notes with the ones this pass produces.
export function reconfirmWorkspaceLocalNames(
  judged: RepoState,
  trusted: RepoState,
  trustedLabel: string,
  diagnostics: Diagnostic[]
): RepoState {
  for (let i = diagnostics.length - 1; i >= 0; i -= 1) {
    if (diagnostics[i].code === WORKSPACE_LINK_UNCONFIRMED) {
      diagnostics.splice(i, 1);
    }
  }
  const byDir = confirmWorkspaceLocalNames(
    [...(judged.lockfile === null ? [] : [judged.lockfile]), ...(judged.extraLockfiles ?? [])],
    (judged.lockfileInventory ?? []).map((entry) => entry.path),
    judged.manifests,
    diagnostics,
    {
      label: trustedLabel,
      // A state built by hand has no classification; its parsed manifests
      // stand in for the field, as before the shared value existed.
      workspaceFields:
        trusted.projects?.workspaceFields ??
        new Map(
          trusted.manifests
            .filter((manifest) => isPackageJsonPath(manifest.path))
            .map((manifest) => [manifest.path, manifest.workspaces ?? []])
        ),
    }
  );
  return {
    ...judged,
    workspaceLocalNames: new Set([...byDir.values()].flatMap((names) => [...names])),
    workspaceLocalNamesByDir: byDir,
  };
}

// ---------------------------------------------------------------------------
// Which manifests are projects
//
// A manifest that does not parse stops the scan (manifest-parse) unless it
// is a stray that ignorePaths covers. There is no default drop for a file
// that is not JSON: bun installs from package.json files with comments,
// trailing commas and text after the value, so "not JSON" is not "not
// installable". A manifest is a project, and stops the scan when it does
// not parse whatever ignorePaths says, when on this side's listing it is:
//
//   1. the root package.json;
//   2. a member named by the root package.json "workspaces" or the root
//      pnpm-workspace.yaml;
//   3. in a directory that also holds a lockfile this tool recognises, of
//      any ecosystem (npm, pnpm, yarn, bun, uv.lock, poetry.lock, pdm.lock,
//      Pipfile.lock). The kinds do not have to match;
//   4. a package.json named by the workspace patterns of such an install
//      root, or a pyproject.toml named by [tool.uv.workspace].members and
//      not exclude of a pyproject.toml beside uv.lock;
//   5. the package.json in the directory a file:, link: or portal:
//      specifier, or a bare local path ("./x", "../x"), of a parsed
//      package.json resolves to, or in the resolved directory of a
//      "link": true entry of a parsed npm lockfile, followed through any
//      symlinked directory on this side. A target that cannot be placed
//      inside the repository is a reason on every package.json, never on
//      none (see rule 5 below).
//
// Nothing under node_modules is a project by rules 1 to 4, and nothing there
// is an input on its own. Rule 5, and a symlinked member whose workspace path
// is outside node_modules, are the exceptions (0.17.0): the package manager
// installs what they name wherever it sits, and a manifest under
// node_modules that one of them promotes has its own local specifiers
// followed in turn. Every input is subject
// content, and a claim in one can only add a path to the set, which makes a
// parse error fatal. A negation inside one input (a "!" workspace pattern)
// can remove a path that input alone would add, never one another input
// adds: each input is evaluated with only its own negations. Every reason
// a path is a project is recorded, not just the first (RepoState.projects),
// plus one rule the parse decision does not use: a requirements file
// another requirements file includes. The set is computed from the whole
// listing whatever the scan prefix: a file outside the prefix is read for
// this and nothing else, raises no diagnostic of its own, and when it cannot
// be read (and a root scan would have stopped on it) every manifest under
// the prefix is treated as a project, with classification-input-unread.
// See docs/design/2026-10-18-unparseable-stray-manifests.md.

const CLASSIFICATION_INPUT_UNREAD = 'classification-input-unread';
const UV_LOCK = 'uv.lock';
const LOCAL_SPECIFIER_PREFIXES = ['file:', 'link:', 'portal:'];
// How many manifests the one manifest-parse error names before it counts.
const MAX_LISTED_PARSE_FAILURES = 10;

type ProtectedPosition =
  | 'root'
  | 'root-member'
  | 'install-root-member'
  | 'uv-member'
  | 'beside-lockfile'
  | 'reference-target'
  | 'link-target';

const POSITION_TEXT: Readonly<Record<ProtectedPosition, string>> = {
  root: 'the root package.json',
  'root-member': 'a root workspace member',
  'install-root-member': "a member named by a nested install root's workspace patterns",
  'uv-member': 'a uv workspace member',
  'beside-lockfile': 'a manifest beside a lockfile',
  'reference-target': 'the target of a file:, link: or portal: dependency',
  'link-target': 'the target of an npm lockfile link entry',
};

// The listing order of the one manifest-parse error: the root, then
// members, then the rest.
const POSITION_RANK: Readonly<Record<ProtectedPosition, number>> = {
  root: 0,
  'root-member': 1,
  'install-root-member': 1,
  'uv-member': 1,
  'beside-lockfile': 2,
  'reference-target': 2,
  'link-target': 2,
};

interface ClassificationInputFailure {
  path: string;
  // 'manifest': a manifest that did not parse, which a root scan drops when
  // it is a stray ignorePaths covers. 'symlink': a symlinked input, which a
  // root scan refuses on the judged side and treats as absent on a
  // comparison side. 'other': anything else, which a root scan stops on.
  kind: 'manifest' | 'symlink' | 'other';
}

interface SideClassification {
  // Every project manifest path on this side, with the first rule that
  // makes it one.
  positions: Map<string, ProtectedPosition>;
  // The paths read past the skipped-directory-name filter. A manifest that
  // is a project only through a Python lockfile beside it, or as a uv
  // workspace member, is not: whether its names are read is its own change
  // (open point 2 of the design), so it is parsed only to decide whether it
  // stops the scan. A fail-closed reason of an input that promotes adds its
  // manifests here too, with no position (classifySide, standIn).
  promoted: Set<string>;
  // Inputs outside the scan prefix that could not be read.
  inputFailures: ClassificationInputFailure[];
  // Every reason each path is a project, not only the first, including
  // requirements includes (RepoState.projects).
  reasons: Map<string, ProjectReason[]>;
  // The "workspaces" field of every package.json that parsed.
  workspaceFields: Map<string, string[]>;
}

interface ParseFailure {
  path: string;
  // The parser's own fixed text, without the path.
  reason: string;
  // Whether the file failed on syntax (it is not JSON or not TOML once a
  // byte order mark is stripped) or on shape (it is, and a field in it is
  // not what this tool reads).
  syntax: boolean;
  // Set by the parse sites that reach a file only because it is a project:
  // the root manifest, and every member the root workspace walk read. The
  // walk can reach a member the listing does not show under any pattern (a
  // symlinked member directory resolves to its real path on the working
  // tree; a gitignored directory on disk is listed by readdir, not by git;
  // case-insensitive expansion under core.ignorecase), so the position is
  // taken from the site, never from the classification.
  position?: ProtectedPosition;
}

// One side, loaded, with what decides its parse failures. Nothing is
// judged until every side the run loads is here (settleParseFailures).
interface LoadedSide {
  state: RepoState;
  role: SideRole;
  isIgnoredPath: (relPath: string) => boolean;
  classification: SideClassification;
  failures: ParseFailure[];
  // The comparison sides this side was loaded against (none for a
  // comparison side), and the unread inputs decided against them
  // (stoppingUnreadInputs), which the read gate already used.
  loadedAgainst: readonly LoadedSide[];
  unreadInputs: readonly string[];
}

type ParseOutcome = { manifest: ParsedManifest } | { error: DepGuardError };
type ManifestParser = (relPath: string, content: string) => ParseOutcome;

// Each manifest on a side is parsed once, whether classification or the
// scan reaches it first.
function manifestParser(): ManifestParser {
  const cache = new Map<string, ParseOutcome>();
  return (relPath, content) => {
    let outcome = cache.get(relPath);
    if (outcome === undefined) {
      try {
        outcome = { manifest: parseProjectManifest(relPath, content) };
      } catch (err) {
        if (!(err instanceof DepGuardError) || err.code !== 'manifest-parse') {
          throw err;
        }
        outcome = { error: err };
      }
      cache.set(relPath, outcome);
    }
    return outcome;
  };
}

// Each path on a side is read once. A read that throws is not cached.
function cachingSource(source: FileSource): FileSource {
  const cache = new Map<string, string | null>();
  return {
    ...source,
    async read(relPath: string): Promise<string | null> {
      if (cache.has(relPath)) {
        return cache.get(relPath) ?? null;
      }
      const content = await source.read(relPath);
      cache.set(relPath, content);
      return content;
    },
    async readMany(relPaths: string[]): Promise<Map<string, string | null>> {
      const missing = relPaths.filter((relPath) => !cache.has(relPath));
      if (missing.length > 0) {
        for (const [relPath, content] of await source.readMany(missing)) {
          cache.set(relPath, content);
        }
      }
      return new Map(relPaths.map((relPath) => [relPath, cache.get(relPath) ?? null]));
    },
  };
}

function isRecognisedLockfilePath(relPath: string): boolean {
  return isLockfileName(relPath) || isPythonLockfilePath(relPath);
}

function underNodeModules(relPath: string): boolean {
  return relPath.split('/').includes(NEVER_A_PACKAGE_DIR);
}

function joinRepoPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

function dirRelativeTo(root: string, dir: string): string | null {
  if (root === '') {
    return dir;
  }
  if (dir === root) {
    return '';
  }
  return dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : null;
}

// The repository directory a local specifier or a link entry names,
// relative to the directory it is written in, or null when it leaves the
// repository or is absolute. String normalization, as npm's path.resolve
// does for a specifier: only package.json specifiers and npm lockfile link
// entries are read this way. Symlink text and requirements includes are
// opened by the operating system and go through walkPhysicalPath instead.
function localTargetDir(fromDir: string, target: string): string | null {
  const cleaned = target.replace(/\\/g, '/');
  if (unplaceablePathText(cleaned)) {
    return null;
  }
  const joined = path.posix.normalize(fromDir === '' ? cleaned || '.' : `${fromDir}/${cleaned}`);
  if (joined === '..' || joined.startsWith('../')) {
    return null;
  }
  return joined === '.' ? '' : joined.replace(/\/+$/, '');
}

// Linux's MAXSYMLINKS: how many links one path is followed through.
const MAX_SYMLINK_HOPS = 40;

// Text this tool never places inside the repository: absolute, home,
// drive-letter or "//" paths.
function unplaceablePathText(text: string): boolean {
  return text.startsWith('//') || text.startsWith('~') || path.posix.isAbsolute(text) || /^[a-zA-Z]:/.test(text);
}

// The repository path that path text names when the operating system
// opens it from fromDir, a directory that is already real (no symlink on
// it): the realpath walk over this side's FileSource, never the disk, since
// a git side has no files there. One segment at a time: "." is skipped,
// ".." pops the path resolved so far (so after a symlinked segment it
// climbs out of the link's target, not out of the link's own directory), a
// name is appended and, when it is a symlink on this side, its text is
// walked the same way from the link's parent. Null when the text, or any
// link on it, is absolute or home, climbs above the root, cannot be read,
// or runs past MAX_SYMLINK_HOPS. Never throws: a path that cannot be placed
// is one every caller fails closed on. When a trace is given, every link
// the walk reads is appended to it as [path, text], and a link whose text
// (or whose symlink answer) cannot be read as [path, null].
async function walkPhysicalPath(
  source: FileSource,
  fromDir: string,
  text: string,
  trace?: LinkTrace
): Promise<string | null> {
  const cleaned = text.replace(/\\/g, '/');
  if (unplaceablePathText(cleaned)) {
    return null;
  }
  const resolved = fromDir === '' ? [] : fromDir.split('/');
  let pending = cleaned.split('/');
  let hops = 0;
  let current = fromDir;
  try {
    while (pending.length > 0) {
      const [segment, ...rest] = pending;
      pending = rest;
      if (segment === '' || segment === '.') {
        continue;
      }
      if (segment === '..') {
        if (resolved.length === 0) {
          return null;
        }
        resolved.pop();
        continue;
      }
      resolved.push(segment);
      current = resolved.join('/');
      if (!(await source.isSymlink(current))) {
        continue;
      }
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) {
        return null;
      }
      const linkText = await source.readLink(current);
      trace?.push([current, linkText]);
      if (linkText === null) {
        return null;
      }
      const linkCleaned = linkText.replace(/\\/g, '/');
      if (unplaceablePathText(linkCleaned)) {
        return null;
      }
      resolved.pop(); // the link's text is read from the link's own directory
      pending = [...linkCleaned.split('/'), ...pending];
    }
  } catch {
    trace?.push([current, null]);
    return null;
  }
  return resolved.join('/');
}

// The links a walk read, each as [path, text], text null when it could
// not be read.
type LinkTrace = Array<[string, string | null]>;

// Each classified side gets its own serial, so a pattern that carries it
// can never equal a pattern the other side recorded.
let classifiedSides = 0;

// The pattern of a fail-closed reason: the written text alone when no
// link was read on the way, as before; otherwise the text with every link
// read (path and text, sorted, once each), so the same text through a
// link the other side points somewhere else is a different reason. A link
// whose text could not be read is not known to be the same link on the
// other side, so it carries this side's own serial and is never excused.
function tracedPattern(text: string, trace: LinkTrace, side: number): string {
  if (trace.length === 0) {
    return text;
  }
  return JSON.stringify([text, ...traceKey(trace, side)]);
}

// Every link a trace read, as sorted, de-duplicated text: [path, text], or
// [path, null, side] for one that could not be read.
function traceKey(trace: LinkTrace, side: number): string[] {
  return [
    ...new Set(trace.map(([linkPath, linkText]) => JSON.stringify(linkText === null ? [linkPath, null, side] : [linkPath, linkText]))),
  ].sort();
}

// How many virtual paths the symlinked member walk of one input visits
// before it stops and fails closed: a chain of links that fans out (two
// links to one directory, under each of which two more, and so on) cannot
// make the classifier run for exponential time. A side's walks together
// make at most this many visits per workspace input. A real monorepo's
// links come nowhere near it.
const MAX_SYMLINKED_VISITS = 10_000;

// How many visits the symlinked member walks of every input on one side make
// together before the next visit stops and fails closed, as the per-input
// limit does, for that input and every later one that still has a link to
// visit. The per-input limit alone bounds a side by the number of inputs,
// and a tree can have as many install roots as it likes: 50 roots each
// reaching one 2^15 fan-out took about 25 s. Ten inputs can each run to
// their own limit before this one is reached, so it only comes into play
// on a side where at least ten inputs fan out pathologically, or many
// inputs together make a hundred thousand visits; a real monorepo makes a
// handful of visits per committed symlink per input.
const MAX_SIDE_SYMLINKED_VISITS = 100_000;

// The repository path a target path names once every symlink on it is
// followed on this side (the target itself or any directory above it),
// each link's text walked physically from its own directory; or null when
// a link on it leaves the repository, is absolute, cannot be read, or the
// hops run out. The target itself is already normalized text, so walking it
// from the root follows only what is a link on it.
function resolveLinkedDir(source: FileSource, target: string, trace?: LinkTrace): Promise<string | null> {
  return walkPhysicalPath(source, '', target, trace);
}

// pnpm-workspace.yaml "packages", or null when the file is not YAML.
function workspaceYamlPatterns(content: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(withoutByteOrderMark(content));
  } catch {
    return null;
  }
  return isPlainObject(parsed) ? stringArray(parsed.packages) : [];
}

// Reads classification inputs. A read that throws contributes nothing and
// is returned in `failed`; outside the scan prefix the reads raise no
// diagnostics (`quiet`), since a file read only to classify is not scanned.
async function readClassificationInputs(
  source: FileSource,
  relPaths: string[],
  diagnostics: Diagnostic[],
  quiet: boolean
): Promise<{ contents: Map<string, string | null>; failed: string[] }> {
  const mark = diagnostics.length;
  const failed: string[] = [];
  let contents: Map<string, string | null>;
  try {
    contents = await source.readMany(relPaths);
  } catch {
    contents = new Map();
    for (const relPath of relPaths) {
      try {
        contents.set(relPath, await source.read(relPath));
      } catch {
        failed.push(relPath);
      }
    }
  }
  if (quiet) {
    diagnostics.splice(mark);
  }
  return { contents, failed };
}

// Rules 1 to 5 over one side's whole listing.
async function classifySide(
  source: FileSource,
  listedFiles: readonly string[],
  prefix: string,
  role: SideRole,
  diagnostics: Diagnostic[],
  parse: ManifestParser,
  npmLockfiles: Map<string, ParsedLockfile>
): Promise<SideClassification> {
  classifiedSides += 1;
  const side = classifiedSides;
  const listed = new Set(listedFiles);
  // Every listed package.json, and those outside node_modules: the inputs
  // are the latter; an input that names a target explicitly (rule 5, a
  // symlinked member) can land on either.
  const listedPackageJsons = listedFiles.filter(isPackageJsonPath);
  const packageJsons = listedPackageJsons.filter((relPath) => !underNodeModules(relPath));
  const lockfilePaths = listedFiles.filter(
    (relPath) => isRecognisedLockfilePath(relPath) && !underNodeModules(relPath)
  );
  const lockDirs = uniquePaths(lockfilePaths.map(parentDir));
  const lockDirSet = new Set(lockDirs);
  const npmFamilyLockDirs = new Set(lockfilePaths.filter(isLockfileName).map(parentDir));
  const uvRootPaths = uniquePaths(lockfilePaths.filter((relPath) => baseName(relPath) === UV_LOCK).map(parentDir))
    .map((dir) => joinRepoPath(dir, PYPROJECT_TOML))
    .filter((relPath) => listed.has(relPath));
  const yamlInputs = uniquePaths(['', ...lockDirs].map((dir) => joinRepoPath(dir, WORKSPACE_YAML))).filter(
    (relPath) => listed.has(relPath)
  );
  const npmLockInputs = lockfilePaths.filter((relPath) => NPM_LOCKFILE_NAMES.has(baseName(relPath)));
  const inputs = uniquePaths([...packageJsons, ...yamlInputs, ...uvRootPaths, ...npmLockInputs]).sort();

  const failures = new Map<string, ClassificationInputFailure['kind']>();
  // Only an input outside the prefix is recorded: one under it is scanned,
  // and the scan reports it exactly as before.
  const fail = (relPath: string, kind: ClassificationInputFailure['kind']): void => {
    if (!underPrefix(relPath, prefix) && !failures.has(relPath)) {
      failures.set(relPath, kind);
    }
  };

  const readable: string[] = [];
  for (const relPath of inputs) {
    if (await source.isSymlink(relPath)) {
      fail(relPath, 'symlink');
      continue;
    }
    readable.push(relPath);
  }
  const contents = new Map<string, string | null>();
  for (const quiet of [false, true]) {
    const batch = readable.filter((relPath) => underPrefix(relPath, prefix) !== quiet);
    const read = await readClassificationInputs(source, batch, diagnostics, quiet);
    for (const [relPath, content] of read.contents) {
      contents.set(relPath, content);
    }
    for (const relPath of read.failed) {
      fail(relPath, 'other');
    }
  }
  const text = (relPath: string): string | null => contents.get(relPath) ?? null;
  const manifestOf = (relPath: string): ParsedManifest | null => {
    const content = text(relPath);
    if (content === null) {
      return null;
    }
    const outcome = parse(relPath, content);
    if ('error' in outcome) {
      fail(relPath, 'manifest');
      return null;
    }
    return outcome.manifest;
  };
  const yamlPatterns = (relPath: string): string[] => {
    const content = text(relPath);
    if (content === null) {
      return [];
    }
    const patterns = workspaceYamlPatterns(content);
    if (patterns === null) {
      fail(relPath, 'other');
      return [];
    }
    return patterns;
  };

  const positions = new Map<string, ProtectedPosition>();
  const promoted = new Set<string>();
  const reasons = new Map<string, ProjectReason[]>();
  const reasonKeys = new Set<string>();
  const addReason = (relPath: string, reason: ProjectReason): void => {
    const key = JSON.stringify([relPath, projectReasonKey(reason)]);
    if (reasonKeys.has(key)) {
      return;
    }
    reasonKeys.add(key);
    const list = reasons.get(relPath) ?? [];
    list.push(reason);
    reasons.set(relPath, list);
  };
  // A manifest under node_modules is skipped unless the input names it
  // explicitly (`named`): a rule-5 target, or a member a symlinked
  // workspace path outside node_modules reaches. The package manager
  // installs such a manifest whatever directory names are on its real path
  // (npm 11 installs the dependencies of "file:tools/node_modules/x"), so
  // the node_modules exception covers only what sits there unnamed.
  const mark = (
    relPath: string,
    position: ProtectedPosition,
    promote: boolean,
    reason: ProjectReason,
    named = false
  ): void => {
    if (underNodeModules(relPath) && !named) {
      return;
    }
    if (!positions.has(relPath)) {
      positions.set(relPath, position);
    }
    if (promote) {
      promoted.add(relPath);
    }
    addReason(relPath, reason);
  };
  // A fail-closed reason for an input that promotes (a symlinked member walk
  // that could not finish, a local target or an include that cannot be
  // placed) stands in for the promotion it could not decide: the manifest
  // it lands on is read past the skipped-directory-name filter, so a member
  // under build/ or vendor/ the walk never placed is still read for names.
  // It gives no position, so it does not make a parse failure fatal
  // whatever ignorePaths says: a stand-in that does not parse is judged as
  // a manifest outside any skipped name is. A stand-in for a named input
  // (`named`, as in mark) covers a manifest under node_modules too, since
  // the target it could not place may be one.
  const standIn = (relPath: string, named = false): void => {
    if (!underNodeModules(relPath) || named) {
      promoted.add(relPath);
    }
  };
  // Whether a listed path is itself a symlink on this side, asked once. A
  // path whose answer cannot be read counts as one: the walk that follows
  // it then fails, and the caller fails closed.
  const symlinkAnswers = new Map<string, boolean>();
  const listedSymlink = async (relPath: string): Promise<boolean> => {
    let answer = symlinkAnswers.get(relPath);
    if (answer === undefined) {
      try {
        answer = await source.isSymlink(relPath);
      } catch {
        answer = true;
      }
      symlinkAnswers.set(relPath, answer);
    }
    return answer;
  };
  // Every listed symlink outside node_modules on this side, found once.
  let listedSymlinks: string[] | null = null;
  const allListedSymlinks = async (): Promise<string[]> => {
    if (listedSymlinks === null) {
      const found: string[] = [];
      for (const relPath of listedFiles) {
        if (!underNodeModules(relPath) && (await listedSymlink(relPath))) {
          found.push(relPath);
        }
      }
      listedSymlinks = found;
    }
    return listedSymlinks;
  };
  // The physical walk of each listed link on this side, done once. The walk
  // reads only this side's source, from the link's own directory, so the
  // path it reaches and the links it reads on the way are the same every
  // time it is asked, whatever chain of links led to it.
  const linkWalks = new Map<string, { target: string | null; read: LinkTrace }>();
  // The visits every input's symlinked member walk on this side has made
  // together (MAX_SIDE_SYMLINKED_VISITS).
  let sideSymlinkedVisits = 0;
  const walkLink = async (linkPath: string): Promise<{ target: string | null; read: LinkTrace }> => {
    let walk = linkWalks.get(linkPath);
    if (walk === undefined) {
      const read: LinkTrace = [];
      const target = await walkPhysicalPath(source, parentDir(linkPath), baseName(linkPath), read);
      walk = { target, read };
      linkWalks.set(linkPath, walk);
    }
    return walk;
  };
  // Whether a real path is a directory with something listed under it.
  // A link to a listed file, or to a path with nothing listed under it, is
  // not a member directory: nothing is installed through it.
  let listedDirs: Set<string> | null = null;
  const listedDirectory = (real: string): boolean => {
    if (listedDirs === null) {
      const dirs = new Set<string>();
      for (const relPath of listedFiles) {
        for (let dir = parentDir(relPath); dir !== '' && !dirs.has(dir); dir = parentDir(dir)) {
          dirs.add(dir);
        }
      }
      listedDirs = dirs;
    }
    return real === '' || listedDirs.has(real);
  };
  // One input's patterns at a time, each with only its own negations: a
  // negation in pnpm-workspace.yaml does not cancel a member the
  // "workspaces" field names, since a package manager that reads one of
  // the two never reads the other's exclusions.
  const markMembers = async (
    rootDir: string,
    input: string,
    patterns: string[],
    position: ProtectedPosition & ProjectRule,
    promote: boolean
  ): Promise<void> => {
    if (patterns.length === 0) {
      return;
    }
    for (const relPath of packageJsons) {
      const relDir = dirRelativeTo(rootDir, parentDir(relPath));
      if (relDir === null || relDir === '') {
        continue;
      }
      // A pattern this module cannot match exactly covers: it can only make
      // more files fatal. Its text is part of the reason, so the same
      // inexact pattern on two sides is the same reason on both.
      const coverage = workspaceCoverage(patterns, relDir);
      if (coverage.exact) {
        mark(relPath, position, promote, { rule: position, root: rootDir, input });
      } else {
        for (const pattern of coverage.inexact) {
          mark(relPath, position, promote, { rule: position, root: rootDir, input, pattern });
        }
      }
    }
    // npm and pnpm install a member that is a symlinked directory, and the
    // listing never walks into one, so its manifest is not among the
    // package.json paths above.
    await markSymlinkedMembers(
      rootDir,
      (relDir) => {
        const coverage = workspaceCoverage(patterns, relDir);
        return coverage.exact ? [undefined] : coverage.inexact;
      },
      (relDir) => workspacePatternsReachBelow(patterns, relDir, true),
      listedPackageJsons,
      canonicalPatterns(patterns),
      position,
      promote,
      { rule: position, root: rootDir, input }
    );
  };
  // npm, pnpm and uv expand a pattern through a symlinked directory, which
  // the listing never walks into. A listed symlink outside node_modules
  // under rootDir whose path a pattern covers or passes through is
  // followed with walkPhysicalPath, and mapped:
  //   - when it reaches a listed file, or a path with nothing listed under
  //     it, it is not a member directory and says nothing;
  //   - when it reaches a directory R, each listed manifest R/<sub>/<name>
  //     is a member exactly when the patterns cover <link>/<sub>, the path
  //     a package manager sees, and is marked as a listed member would be.
  //     R may be under node_modules (0.17.0): the path the package manager
  //     sees is <link>/<sub>, and the npm member walk's candidates are
  //     every listed package.json for that reason. The reason's pattern holds that path, the covering pattern (null
  //     when exact, the text when inexact) and every link text read on the
  //     way (traceKey): a widened pattern, a retargeted link or the same
  //     path reached through another link is a different reason;
  //   - every listed symlink under R is a further candidate at its path
  //     through the link, followed the same way, sharing one hop budget.
  // A link that cannot be placed (it leaves the repository, is absolute,
  // cannot be read, runs out of hops, or comes back to a directory already
  // on its own chain) fails closed: the reason goes on every manifest of
  // that kind on this side, keyed on the link's path through the links, the
  // input's patterns and every link text read, so only the same links and
  // the same patterns on the reference side excuse it, and a link that
  // could not be read carries this side's serial and excuses nothing.
  // Once one input's walk has made MAX_SYMLINKED_VISITS visits, a walk that
  // still has a link to visit stops and fails closed once for that input,
  // keyed on the patterns and this side's serial alone: no reference side
  // can excuse it, since the links past the limit were never read and a
  // retarget among them would otherwise pass unseen. The budget is per
  // input, so one input's fan-out never cuts another input's walk short;
  // only the link walks themselves are shared, memoized per side. Above it
  // sits one side-wide limit, MAX_SIDE_SYMLINKED_VISITS over every input's
  // visits together: once it is reached, the next visit of any input fails
  // closed the same way, with the same key, so a tree with very many
  // fanning install roots cannot make the classifier run without bound.
  // Every fail-closed reason of an input that promotes also stands in for
  // its promotion (standIn) on every manifest it lands on.
  const markSymlinkedMembers = async (
    rootDir: string,
    covering: (relDir: string) => Array<string | undefined>,
    reachesBelow: (relDir: string) => boolean,
    candidates: readonly string[],
    patternsKey: string,
    position: ProtectedPosition & ProjectRule,
    promote: boolean,
    reason: ProjectReason
  ): Promise<void> => {
    const links = await allListedSymlinks();
    const linkPaths = (trace: LinkTrace): string[] => [...new Set(trace.map(([linkPath]) => linkPath))];
    const failClosed = (virtualPath: string, trace: LinkTrace, cause?: 'cycle'): void => {
      const pattern = JSON.stringify(['unfollowed-symlink', virtualPath, patternsKey, ...traceKey(trace, side)]);
      for (const candidate of candidates) {
        addReason(candidate, {
          ...reason,
          pattern,
          link: { paths: [virtualPath], followed: false, ...(cause === undefined ? {} : { cause }) },
        });
        if (promote) {
          standIn(candidate, true);
        }
      }
    };
    // The visits this input's walk has made, and the top-level link under
    // which it ran past MAX_SYMLINKED_VISITS.
    let symlinkedVisits = 0;
    let fanOutAt: string | null = null;
    let stopped = false;
    // virtualPath: the link's path as a package manager sees it (through
    // every link above it); linkPath: where it is listed; chain: the links
    // read to reach linkPath's directory; reals: the real directories
    // already entered on the way; top: the top-level link this visit is
    // under.
    const visit = async (
      virtualPath: string,
      linkPath: string,
      chain: LinkTrace,
      reals: readonly string[],
      top: string
    ): Promise<void> => {
      if (stopped) {
        return;
      }
      const relDir = dirRelativeTo(rootDir, virtualPath);
      if (relDir === null || relDir === '' || underNodeModules(virtualPath)) {
        return;
      }
      if (!reachesBelow(relDir) && covering(relDir).length === 0) {
        return;
      }
      if (symlinkedVisits >= MAX_SYMLINKED_VISITS || sideSymlinkedVisits >= MAX_SIDE_SYMLINKED_VISITS) {
        fanOutAt = top;
        stopped = true;
        const cause = symlinkedVisits >= MAX_SYMLINKED_VISITS ? 'fan-out' : 'side-fan-out';
        const pattern = JSON.stringify(['symlink-fan-out', patternsKey, side]);
        for (const candidate of candidates) {
          addReason(candidate, { ...reason, pattern, link: { paths: [fanOutAt], followed: false, cause } });
          if (promote) {
            standIn(candidate, true);
          }
        }
        return;
      }
      symlinkedVisits += 1;
      sideSymlinkedVisits += 1;
      const walk = await walkLink(linkPath);
      const trace: LinkTrace = [...chain, ...walk.read];
      const target = walk.target;
      if (target === null || trace.length > MAX_SYMLINK_HOPS) {
        failClosed(virtualPath, trace);
        return;
      }
      if (reals.some((real) => underPrefix(real, target))) {
        failClosed(virtualPath, trace, 'cycle');
        return;
      }
      if (listed.has(target) || !listedDirectory(target)) {
        return;
      }
      const key = traceKey(trace, side);
      const through = linkPaths(trace);
      for (const candidate of candidates) {
        const sub = dirRelativeTo(target, parentDir(candidate));
        if (sub === null) {
          continue;
        }
        const memberPath = sub === '' ? virtualPath : `${virtualPath}/${sub}`;
        const memberDir = dirRelativeTo(rootDir, memberPath);
        if (memberDir === null) {
          continue;
        }
        // A member whose real path is under node_modules is still one: the
        // package manager sees memberPath, which the coverage above never
        // finds under node_modules.
        for (const covered of covering(memberDir)) {
          mark(
            candidate,
            position,
            promote,
            {
              ...reason,
              pattern: JSON.stringify(['symlinked-member', memberPath, covered ?? null, ...key]),
              link: { paths: through, followed: true },
            },
            true
          );
        }
      }
      for (const nested of links) {
        const sub = nested === target ? null : dirRelativeTo(target, nested);
        if (sub !== null && sub !== '') {
          await visit(`${virtualPath}/${sub}`, nested, trace, [...reals, target], top);
        }
      }
    };
    for (const linkPath of links) {
      await visit(linkPath, linkPath, [], [], linkPath);
    }
  };

  const parsedPackageJsons = new Map<string, ParsedManifest>();
  for (const relPath of packageJsons) {
    const manifest = manifestOf(relPath);
    if (manifest !== null) {
      parsedPackageJsons.set(relPath, manifest);
    }
  }

  // Rule 1.
  mark(ROOT_MANIFEST, 'root', true, { rule: 'root', root: '', input: ROOT_MANIFEST });
  // Rule 2. The workspaces field is read as JSON, as the workspace walk
  // reads it, so a manifest that is JSON and fails only on shape still
  // names its members.
  await markMembers('', ROOT_MANIFEST, workspaceGlobsFromManifest(text(ROOT_MANIFEST)), 'root-member', true);
  await markMembers('', WORKSPACE_YAML, yamlPatterns(WORKSPACE_YAML), 'root-member', true);
  // Rule 3.
  const lockfilesByDir = new Map<string, string[]>();
  for (const lockPath of lockfilePaths) {
    const list = lockfilesByDir.get(parentDir(lockPath)) ?? [];
    list.push(lockPath);
    lockfilesByDir.set(parentDir(lockPath), list);
  }
  for (const relPath of listedFiles) {
    const dir = parentDir(relPath);
    if (isProjectManifestPath(relPath) && lockDirSet.has(dir)) {
      for (const lockPath of lockfilesByDir.get(dir) ?? []) {
        mark(relPath, 'beside-lockfile', npmFamilyLockDirs.has(dir), {
          rule: 'beside-lockfile',
          root: dir,
          input: lockPath,
        });
      }
    }
  }
  // Rule 4.
  for (const dir of lockDirs) {
    if (dir === '') {
      continue; // the root's members are rule 2
    }
    const promote = npmFamilyLockDirs.has(dir);
    const fieldInput = manifestPathIn(dir);
    const yamlInput = joinRepoPath(dir, WORKSPACE_YAML);
    await markMembers(dir, fieldInput, workspaceGlobsFromManifest(text(fieldInput)), 'install-root-member', promote);
    await markMembers(dir, yamlInput, yamlPatterns(yamlInput), 'install-root-member', promote);
  }
  const pyprojects = listedFiles.filter((relPath) => baseName(relPath) === PYPROJECT_TOML && !underNodeModules(relPath));
  for (const rootPath of uvRootPaths) {
    const workspace = manifestOf(rootPath)?.python?.uvWorkspace;
    if (workspace === undefined) {
      continue;
    }
    const rootDir = parentDir(rootPath);
    for (const relPath of listedFiles) {
      if (baseName(relPath) !== PYPROJECT_TOML || relPath === rootPath) {
        continue;
      }
      const relDir = dirRelativeTo(rootDir, parentDir(relPath));
      if (relDir !== null && relDir !== '' && uvWorkspaceCovers(workspace.members, workspace.exclude, relDir)) {
        mark(relPath, 'uv-member', false, { rule: 'uv-member', root: rootDir, input: rootPath });
      }
    }
    // uv's members glob matches a symlinked directory too, which the
    // listing never walks into. The same coverage as above: a members
    // pattern this module cannot match exactly covers nothing here either.
    await markSymlinkedMembers(
      rootDir,
      (relDir) => (uvWorkspaceCovers(workspace.members, workspace.exclude, relDir) ? [undefined] : []),
      (relDir) => workspacePatternsReachBelow(workspace.members, relDir, false),
      pyprojects,
      JSON.stringify([canonicalPatternList(workspace.members), canonicalPatternList(workspace.exclude)]),
      'uv-member',
      false,
      { rule: 'uv-member', root: rootDir, input: rootPath }
    );
  }
  // Rule 5. A target is followed through every symlinked directory on its
  // path inside this side's listing, and the reason lands on the manifest
  // the scan reads. One this tool cannot place inside the repository (an
  // absolute or home path, a relative path that leaves the root and can
  // come back in through the checkout directory's own name, a link that
  // does either or cannot be followed) fails closed like an inexact
  // workspace pattern: the reason, with the target text as its pattern, is
  // on every package.json on this side, so only the same specifier in the
  // same file, through the same link texts (tracedPattern), on the
  // reference side excuses it. It also stands in for the promotion the
  // target would have had (standIn), on every package.json: one under
  // build/ is read for names, since the target may be it. Neither gives a
  // position, so neither makes a parse failure fatal whatever ignorePaths
  // says.
  //
  // A target placed inside the repository is matched against the listed
  // package.json paths (fix round 2 of 0.17.0): exactly, else without regard
  // to case when exactly one listed path matches that way, since npm on a
  // case-insensitive file system (macOS) installs "file:tools/NODE_MODULES/x"
  // from tools/node_modules/x. A target that names no listed manifest, or
  // several that differ only in case, fails closed as an unplaceable one
  // does: this side cannot tell which manifest it is. Before, the reason
  // went on a path nothing lists and nothing was read.
  let packageJsonsByFoldedPath: Map<string, string[]> | null = null;
  const listedManifestFor = (manifestPath: string): string | null => {
    if (listed.has(manifestPath)) {
      return manifestPath;
    }
    if (packageJsonsByFoldedPath === null) {
      const byFolded = new Map<string, string[]>();
      for (const relPath of listedPackageJsons) {
        const folded = relPath.toLowerCase();
        byFolded.set(folded, [...(byFolded.get(folded) ?? []), relPath]);
      }
      packageJsonsByFoldedPath = byFolded;
    }
    const matches = packageJsonsByFoldedPath.get(manifestPath.toLowerCase()) ?? [];
    return matches.length === 1 ? matches[0] : null;
  };
  const markTarget = async (
    fromDir: string,
    targetText: string,
    position: ProtectedPosition & ProjectRule,
    reason: ProjectReason
  ): Promise<void> => {
    const written = localTargetDir(fromDir, targetText);
    const trace: LinkTrace = [];
    const target = written === null ? null : await resolveLinkedDir(source, written, trace);
    const manifest = target === null ? null : listedManifestFor(manifestPathIn(target));
    if (manifest !== null) {
      mark(manifest, position, true, reason, true);
      return;
    }
    const pattern = tracedPattern(targetText, trace, side);
    for (const candidate of listedPackageJsons) {
      addReason(candidate, { ...reason, pattern });
      standIn(candidate, true);
    }
  };
  const followLocalSpecifiers = async (relPath: string, manifest: ParsedManifest): Promise<void> => {
    for (const dep of manifest.deps) {
      // npm reads a bare "./x", "../x", "/x" or "~/x" as a local directory
      // too (npm-package-arg's isFilespec); the whole specifier is the path.
      const used = LOCAL_SPECIFIER_PREFIXES.find((specPrefix) => dep.specifier.startsWith(specPrefix));
      const targetText =
        used !== undefined ? dep.specifier.slice(used.length) : isLocalPathSpecifier(dep.specifier) ? dep.specifier : null;
      if (targetText === null) {
        continue;
      }
      await markTarget(parentDir(relPath), targetText, 'reference-target', {
        rule: 'reference-target',
        root: parentDir(relPath),
        input: relPath,
      });
    }
  };
  for (const [relPath, manifest] of parsedPackageJsons) {
    await followLocalSpecifiers(relPath, manifest);
  }
  for (const lockPath of npmLockInputs) {
    const content = text(lockPath);
    if (content === null) {
      continue;
    }
    let parsed = npmLockfiles.get(lockPath);
    if (parsed === undefined) {
      try {
        parsed = parseNpmLockfile(lockPath, content);
      } catch (err) {
        // A comparison side reads an npm lockfile with no packages map as
        // an unread lockfile there, so a root scan would not stop on it.
        if (!(role.kind === 'comparison' && err instanceof MissingPackagesMapError)) {
          fail(lockPath, 'other');
        }
        continue;
      }
      npmLockfiles.set(lockPath, parsed);
    }
    for (const link of parsed.workspaceLinks ?? []) {
      if (link.resolved === undefined) {
        continue;
      }
      await markTarget(parentDir(lockPath), link.resolved, 'link-target', {
        rule: 'link-target',
        root: parentDir(lockPath),
        input: lockPath,
      });
    }
  }
  // Every package.json outside node_modules is an input above, so its own
  // local specifiers were followed. One under node_modules is an input only
  // once something names it (promoted above, by a target, a symlinked
  // member or a stand-in): the package manager installs its local
  // dependencies too, so they are followed the same way, until no new one
  // is promoted. Each is read and parsed once, like any input, and one that
  // cannot be read or parsed is a failed input like any other.
  const followedUnderNodeModules = new Set<string>();
  for (;;) {
    const next = listedPackageJsons.filter(
      (relPath) => underNodeModules(relPath) && promoted.has(relPath) && !followedUnderNodeModules.has(relPath)
    );
    if (next.length === 0) {
      break;
    }
    const readableNext: string[] = [];
    for (const relPath of next) {
      followedUnderNodeModules.add(relPath);
      if (await listedSymlink(relPath)) {
        fail(relPath, 'symlink');
        continue;
      }
      readableNext.push(relPath);
    }
    for (const quiet of [false, true]) {
      const batch = readableNext.filter((relPath) => underPrefix(relPath, prefix) !== quiet);
      const read = await readClassificationInputs(source, batch, diagnostics, quiet);
      for (const [relPath, content] of read.contents) {
        contents.set(relPath, content);
      }
      for (const relPath of read.failed) {
        fail(relPath, 'other');
      }
    }
    for (const relPath of readableNext) {
      const manifest = manifestOf(relPath);
      if (manifest !== null) {
        await followLocalSpecifiers(relPath, manifest);
      }
    }
  }
  // A requirements file another one includes with -r or -c is installed by
  // pip. Followed over the whole listing, from every requirements file this
  // side lists, with the loader's rules (relative to the including file, at
  // most MAX_INCLUDE_DEPTH levels, each file read once), so a scan of a
  // subdirectory still sees an include written outside it. A reason only:
  // whether such a file stops the scan is unchanged.
  // An include this tool cannot place inside the repository fails closed
  // as rule 5 does, over every requirements file on this side, and stands
  // in for the read the include follower would have given it (standIn): a
  // requirements file under build/ is read for names, since the include may
  // be it.
  const requirementsFiles = listedFiles.filter((relPath) => isRequirementsPath(relPath) && !underNodeModules(relPath));
  for (const [target, reason] of await requirementIncludeReasons(source, listedFiles, diagnostics, side)) {
    if (target === null) {
      for (const candidate of requirementsFiles) {
        addReason(candidate, reason);
        standIn(candidate);
      }
      continue;
    }
    addReason(target, reason);
  }

  const workspaceFields = new Map<string, string[]>();
  for (const [relPath, manifest] of parsedPackageJsons) {
    workspaceFields.set(relPath, manifest.workspaces ?? []);
  }

  return {
    positions,
    promoted,
    inputFailures: [...failures].map(([relPath, kind]) => ({ path: relPath, kind })),
    reasons,
    workspaceFields,
  };
}

async function requirementIncludeReasons(
  source: FileSource,
  listedFiles: readonly string[],
  diagnostics: Diagnostic[],
  side: number
): Promise<Array<[string | null, ProjectReason]>> {
  // A null target is an include this tool cannot place inside the
  // repository, with its text and the link texts the walk read as the
  // reason's pattern (tracedPattern).
  const found: Array<[string | null, ProjectReason]> = [];
  const start = listedFiles.filter((relPath) => isRequirementsPath(relPath) && !underNodeModules(relPath)).sort();
  const known = new Set(start);
  const firstRead = await readClassificationInputs(source, start, diagnostics, true);
  let frontier: Array<{ path: string; content: string; constraint: boolean }> = start.flatMap((relPath) => {
    const content = firstRead.contents.get(relPath) ?? null;
    return content === null ? [] : [{ path: relPath, content, constraint: false }];
  });
  for (let depth = 1; frontier.length > 0; depth += 1) {
    const next: typeof frontier = [];
    for (const file of frontier) {
      let includes: Array<{ target: string; constraint: boolean }>;
      try {
        includes = parseRequirements(file.path, file.content, file.constraint ? { constraint: true } : {}).python?.includes ?? [];
      } catch {
        continue;
      }
      const dir = parentDir(file.path);
      for (const include of includes) {
        const reason: ProjectReason = { rule: 'requirements-include', root: dir, input: file.path };
        // pip opens dirname(file)/target through the operating system, so a
        // ".." after a symlinked segment climbs out of the link's target:
        // walked physically from the including file's directory, which is
        // real (a listed path, or one this walk already resolved).
        const trace: LinkTrace = [];
        const joined = await walkPhysicalPath(source, dir, include.target, trace);
        if (joined === '') {
          continue; // the root directory itself, which pip cannot read as a file
        }
        if (joined === null) {
          found.push([null, { ...reason, pattern: tracedPattern(include.target, trace, side) }]);
          continue;
        }
        if (known.has(joined)) {
          found.push([joined, reason]);
          continue;
        }
        if (depth > MAX_INCLUDE_DEPTH) {
          continue;
        }
        let content: string | null;
        try {
          if (await source.isSymlink(joined)) {
            continue;
          }
          const mark = diagnostics.length;
          content = await source.read(joined);
          diagnostics.splice(mark);
        } catch {
          continue;
        }
        if (content === null) {
          continue;
        }
        known.add(joined);
        found.push([joined, reason]);
        next.push({ path: joined, content, constraint: include.constraint });
      }
    }
    frontier = next;
  }
  return found;
}

function parseFailureReason(relPath: string, err: DepGuardError): string {
  const lead = `${relPath}: `;
  return err.message.startsWith(lead) ? err.message.slice(lead.length) : err.message;
}

function classClause(failure: ParseFailure): string | null {
  if (isPackageJsonPath(failure.path)) {
    return failure.syntax
      ? 'some package managers accept JSON with comments, trailing commas or text after the value, so this file may still install'
      : 'it is valid JSON, so a package manager may install from it';
  }
  return failure.syntax ? null : 'it is valid TOML, so a package manager may install from it';
}

/**
 * The classification inputs outside the scan prefix on one side that could
 * not be read and that a scan of the repository root would have stopped on:
 * an input that is not a manifest; a symlinked input the side looked at, on
 * the judged side only (a comparison side treats it as absent); a manifest
 * the side looked at that the side, or for the judged side a comparison
 * side, counts as a project, or that ignorePaths does not cover. Each one
 * raises classification-input-unread, and while there is one, every
 * manifest under the prefix outside node_modules is a project on this side:
 * read past the skipped-directory-name filter (loadState) and fatal when it
 * does not parse (settleParseFailures, protectionOn).
 */
function stoppingUnreadInputs(
  classification: SideClassification,
  role: SideRole,
  isIgnoredPath: (relPath: string) => boolean,
  comparisons: readonly SideClassification[]
): string[] {
  const stopsRootScan = (relPath: string): boolean =>
    classification.positions.has(relPath) ||
    (role.kind === 'judged' && comparisons.some((other) => other.positions.has(relPath))) ||
    !isIgnoredPath(relPath);
  return classification.inputFailures
    .filter((failure) => {
      const lookedAt = !pathSkipped(failure.path) || classification.positions.has(failure.path);
      return (
        failure.kind === 'other' ||
        (failure.kind === 'symlink' && role.kind === 'judged' && lookedAt) ||
        (failure.kind === 'manifest' && lookedAt && stopsRootScan(failure.path))
      );
    })
    .map((failure) => failure.path);
}

/**
 * Decides every parse failure of every side the run loaded, after all of
 * them are loaded, and throws one manifest-parse error listing the fatal
 * ones. A judged-side failure is fatal when the judged side or a comparison
 * side counts the path as a project, or when ignorePaths does not cover it.
 * A comparison-side failure is fatal when that side counts it as a project,
 * or when ignorePaths does not cover it: the judged side never makes a
 * comparison-side failure fatal. Every other failure is dropped with
 * manifest-unparsed.
 */
function settleParseFailures(sides: readonly LoadedSide[], prefix: string, diagnostics: Diagnostic[]): void {
  const comparisons = sides.filter((side) => side.role.kind === 'comparison');
  const ordered = [...sides.filter((side) => side.role.kind === 'judged'), ...comparisons];

  // The unread inputs of each side were decided when it was loaded, since
  // its read gate depends on them (loadState, standsInForPrefix), against
  // the comparison sides already loaded. The same sides must be the ones
  // judged here, or the diagnostic and the read gate could disagree.
  for (const side of ordered) {
    const against = side.role.kind === 'judged' ? comparisons : [];
    if (side.loadedAgainst.length !== against.length || side.loadedAgainst.some((other, i) => other !== against[i])) {
      throw new Error('internal error: a side was loaded against different comparison sides than it is settled with');
    }
  }
  const unreadBySide = new Map<LoadedSide, readonly string[]>();
  for (const side of ordered) {
    for (const relPath of side.unreadInputs) {
      diagnostics.push({
        code: CLASSIFICATION_INPUT_UNREAD,
        message:
          `${relPath}: outside the scanned directory ${prefix} and could not be read to decide which ` +
          `manifests are projects, so every manifest under ${prefix} was treated as a project for this scan`,
      });
    }
    unreadBySide.set(side, side.unreadInputs);
    side.state.projects = { ...(side.state.projects ?? EMPTY_PROJECTS), unreadInputs: [...side.unreadInputs] };
  }

  const protectionOn = (side: LoadedSide, relPath: string): { text: string; rank: number } | null => {
    const position = side.classification.positions.get(relPath);
    if (position !== undefined) {
      return { text: POSITION_TEXT[position], rank: POSITION_RANK[position] };
    }
    const unread = unreadBySide.get(side) ?? [];
    if (unread.length > 0 && prefix !== '' && underPrefix(relPath, prefix)) {
      return {
        text: `every manifest under ${prefix}, because ${unread.join(', ')} outside it could not be read,`,
        rank: 2,
      };
    }
    return null;
  };

  const fatal: Array<{ sideOrder: number; rank: number; path: string; entry: string }> = [];
  ordered.forEach((side, sideOrder) => {
    const notParsed: string[] = [];
    for (const failure of side.failures) {
      let protection =
        failure.position === undefined
          ? protectionOn(side, failure.path)
          : { text: POSITION_TEXT[failure.position], rank: POSITION_RANK[failure.position] };
      if (protection === null && side.role.kind === 'judged') {
        for (const other of comparisons) {
          const found = protectionOn(other, failure.path);
          if (found !== null && other.role.kind === 'comparison') {
            protection = { text: `${found.text} on ${other.role.label}`, rank: found.rank };
            break;
          }
        }
      }
      if (protection === null && side.isIgnoredPath(failure.path)) {
        diagnostics.push({ code: MANIFEST_UNPARSED, message: `${failure.path}: not parsed; covered by ignorePaths` });
        notParsed.push(failure.path);
        continue;
      }
      const sideName = side.role.kind === 'judged' ? 'judged side' : side.role.label;
      const tail =
        protection !== null
          ? `${protection.text} is a project and stops the scan whatever ignorePaths says`
          : side.role.kind === 'comparison'
            ? 'fix the file on the base branch, or cover it with ignorePaths there'
            : comparisons.length > 0
              ? 'fix the file, or cover it with ignorePaths on the base branch'
              : 'fix the file, or cover it with ignorePaths';
      const clauses = [classClause(failure), tail].filter((clause): clause is string => clause !== null);
      fatal.push({
        sideOrder,
        rank: protection?.rank ?? 2,
        path: failure.path,
        entry: `${failure.path} (${sideName}): ${failure.reason}; ${clauses.join('; ')}.`,
      });
    }
    side.state.notParsed = notParsed;
  });
  if (fatal.length === 0) {
    return;
  }
  fatal.sort(
    (a, b) => a.sideOrder - b.sideOrder || a.rank - b.rank || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
  const shown = fatal.slice(0, MAX_LISTED_PARSE_FAILURES).map((item) => item.entry);
  const rest = fatal.length - shown.length;
  const lead =
    fatal.length === 1
      ? '1 manifest does not parse and stops the scan: '
      : `${fatal.length} manifests do not parse and stop the scan: `;
  throw new DepGuardError(`${lead}${[...shown, ...(rest > 0 ? [`and ${rest} more`] : [])].join(' | ')}`, 'manifest-parse');
}

// Every lockfile on one side that does not parse, in one lockfile-parse
// error, so fixing one does not just reveal the next. One failure keeps its
// own message unchanged; several are listed the way the manifest-parse
// error lists manifests, up to the same cap, in the order the lockfiles were
// read (the root directory first, then the rest by path).
function throwLockfileParseFailures(failures: readonly DepGuardError[]): void {
  if (failures.length === 0) {
    return;
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  const shown = failures.slice(0, MAX_LISTED_PARSE_FAILURES).map((failure) => failure.message);
  const rest = failures.length - shown.length;
  throw new DepGuardError(
    `${failures.length} lockfiles do not parse and stop the scan: ` +
      [...shown, ...(rest > 0 ? [`and ${rest} more`] : [])].join(' | '),
    'lockfile-parse'
  );
}

async function loadState(
  rawSource: FileSource,
  diagnostics: Diagnostic[],
  role: SideRole,
  prefix: string,
  isIgnoredPath: (relPath: string) => boolean,
  // Every comparison side the run loads, already loaded, for the judged
  // side; none for a comparison side. settleParseFailures checks it.
  comparisons: readonly LoadedSide[]
): Promise<LoadedSide> {
  if (role.kind === 'comparison' && comparisons.length > 0) {
    throw new Error('internal error: a comparison side was loaded against other sides');
  }
  const source = cachingSource(rawSource);
  const listedFiles = await source.listFiles();
  const filesInPrefix = listedFiles.filter((relPath) => underPrefix(relPath, prefix));
  // A [tool.uv.sources] path to an archive exempts only when the file is
  // really on this side (python-sources.ts, pathTargetConfirms).
  const pythonArchiveFiles = listedFiles.filter(isArchiveFile);
  const parse = manifestParser();
  const npmLockfiles = new Map<string, ParsedLockfile>();
  // Lockfiles are never dropped for a directory name, and neither is a
  // manifest that is a project (classifySide): a manifest with an
  // npm-family lockfile beside it, that install root's workspace members,
  // a root workspace member, and the target of a local reference are read
  // whatever directory names are on their path. Reading a lockfile while
  // dropping the manifest beside it meant its entries were read and its
  // names never checked, since the name checks run over manifest lines; a
  // build/ project declaring a known-malicious name scanned clean that way.
  // The classification reads the whole listing, so a subdirectory scan
  // promotes exactly what a root scan does.
  //
  // node_modules is the one exception, for what sits there unnamed: a
  // committed node_modules package that ships its own lockfile, or that a
  // workspace pattern would cover, is a dependency's file, not a project of
  // this repository's. It is not an exception for a manifest an input names
  // explicitly (a file:, link: or portal: target, an npm lockfile link
  // entry, a member reached through a symlinked workspace path, or a
  // stand-in for one that could not be placed): the package manager
  // installs that one wherever it sits (npm 11 installs the dependencies of
  // "file:tools/node_modules/x"; audit 2026-10-27, M1). Before 0.17.0 the
  // exception covered both, on the ruling that nothing is installed from
  // inside node_modules, and such a target was never read.
  const classification = await classifySide(source, listedFiles, prefix, role, diagnostics, parse, npmLockfiles);
  const failures: ParseFailure[] = [];
  const attempted = new Set<string>();
  // Every parse site collects its failure here and the load goes on;
  // settleParseFailures decides each one once every side is loaded.
  const collect = (relPath: string, content: string, position?: ProtectedPosition): ParsedManifest | null => {
    attempted.add(relPath);
    const outcome = parse(relPath, content);
    if ('manifest' in outcome) {
      return outcome.manifest;
    }
    failures.push({
      path: relPath,
      reason: parseFailureReason(relPath, outcome.error),
      syntax: isPythonManifestPath(relPath) ? !isReadableToml(content) : !isReadableJson(content),
      ...(position === undefined ? {} : { position }),
    });
    return null;
  };
  // An unread classification input outside the prefix that a root scan
  // would have stopped on (stoppingUnreadInputs) means this side cannot
  // tell which manifests under the prefix are projects, and the diagnostic
  // says every one was treated as a project. The read gate makes that true:
  // every manifest under the prefix outside node_modules is read past the
  // skipped-directory-name filter, a stand-in with no position, as standIn
  // in classifySide gives. Without it a manifest under build/ that a root
  // scan would never have reached cleanly (the root scan stops on the
  // input) was dropped and the scan exited 0.
  const unreadInputs = stoppingUnreadInputs(
    classification,
    role,
    isIgnoredPath,
    comparisons.map((other) => other.classification)
  );
  const standsInForPrefix = prefix !== '' && unreadInputs.length > 0;
  const readDespiteSkippedName = (relPath: string): boolean =>
    classification.promoted.has(relPath) ||
    (standsInForPrefix && isProjectManifestPath(relPath) && underPrefix(relPath, prefix) && !underNodeModules(relPath));
  const files = filesInPrefix.filter(
    (relPath) => isLockfileName(relPath) || !pathSkipped(relPath) || readDespiteSkippedName(relPath)
  );
  const listedManifests = files.filter(isProjectManifestPath).sort();
  const listedLockfiles = files.filter(isLockfileName);
  const rootInScope = underPrefix(ROOT_MANIFEST, prefix);
  const unread = await screenSymlinkedInputs(
    source,
    uniquePaths([
      ...(rootInScope ? [ROOT_MANIFEST] : []),
      ...listedManifests,
      ...listedLockfiles.filter(isParsedLockfilePath),
    ]),
    role,
    diagnostics
  );
  const rootManifestContent =
    rootInScope && !unread.has(ROOT_MANIFEST) ? await source.read(ROOT_MANIFEST) : null;
  // Workspace globs name packages anywhere in the repository. They apply
  // only when the scan covers the root; a scan of one directory reads the
  // manifests under that directory and does not pull the rest in.
  const workspaceYamlContent = prefix === '' ? await source.read(WORKSPACE_YAML) : null;

  const manifests: ParsedManifest[] = [];
  if (rootManifestContent !== null) {
    const parsedRoot = collect(ROOT_MANIFEST, rootManifestContent, 'root');
    if (parsedRoot !== null) {
      manifests.push(parsedRoot);
    }
  }

  // Every discovered directory is taken by identity, never by the spelling
  // that reached it, and is then REPORTED under that identity. Two things
  // depend on this:
  //
  // A symlinked package directory can reach a directory the scan already
  // has -- "packages/self" pointing at the root is the sharpest case --
  // and taking it twice would list one manifest under two paths.
  //
  // More subtly, the git side of a base scan never follows a symlink, so
  // it only ever sees a package at its real path. If the working-tree side
  // reported the link's spelling instead, the two sides would name the
  // same package differently and every dependency of it would read as
  // removed from one path and added at the other. Reporting the real
  // spelling on both sides is what makes them agree.
  //
  // The root directory is always already taken; its identity is the empty
  // string on both kinds of source.
  const seenDirs = new Set<string>(['']);

  // Each workspace source is resolved on its own, in its own order, and the
  // directories are combined; a directory either source names is scanned.
  const workspaceDirs = new Set<string>([
    ...(await discoverWorkspaceDirs(source, workspaceGlobsFromManifest(rootManifestContent), diagnostics, role)),
    ...(await discoverWorkspaceDirs(
      source,
      workspaceGlobsFromWorkspaceYaml(workspaceYamlContent),
      diagnostics,
      role
    )),
  ]);
  const manifestPaths: string[] = [];
  for (const dir of workspaceDirs) {
    const identity = await source.identifyDir(dir);
    if (identity === null) {
      continue; // outside the root, or an unresolvable link; already reported
    }
    if (seenDirs.has(identity)) {
      diagnostics.push({
        code: DUPLICATE_DIR,
        // Phrased as "resolves to" because the surviving spelling is the
        // real one, which may well be this same string: two patterns can
        // reach one directory with the link claiming it first, and saying
        // "the same directory as X" would then print X twice.
        message:
          identity === ''
            ? `${dir}: resolves to the repository root, which is already scanned; skipped`
            : `${dir}: resolves to "${identity}", which is already scanned; skipped`,
      });
      continue;
    }
    seenDirs.add(identity);
    manifestPaths.push(`${identity}/${ROOT_MANIFEST}`);
  }
  // Read together, in one git call on a git side, then parsed in discovery
  // order.
  const unreadMembers = await screenSymlinkedInputs(source, manifestPaths, role, diagnostics);
  const readPaths = manifestPaths.filter((manifestPath) => !unreadMembers.has(manifestPath));
  const memberPaths = new Set(manifestPaths);
  for (const relPath of filesInPrefix) {
    if (
      !isProjectManifestPath(relPath) ||
      !pathSkipped(relPath) ||
      memberPaths.has(relPath) ||
      readDespiteSkippedName(relPath)
    ) {
      continue;
    }
    const segment = skipSegment(relPath);
    if (segment !== null && SILENT_SKIP_DIR_NAMES.has(segment)) {
      continue;
    }
    const position = classification.positions.get(relPath);
    diagnostics.push({
      code: MANIFEST_SKIPPED_DIRNAME,
      message:
        position === undefined
          ? `${relPath}: not scanned; a manifest under a directory named ${segment ?? 'unknown'} is skipped ` +
            'unless a workspace pattern names it or a lockfile sits beside it, and this one has neither'
          : `${relPath}: its dependencies were not read; a manifest under a directory named ${segment ?? 'unknown'} ` +
            'is read only when an npm-family lockfile sits beside it or a workspace pattern names it. It is a ' +
            `project (${
              position === 'uv-member'
                ? 'a uv workspace member'
                : position === 'install-root-member'
                  ? 'named by the workspace patterns of a directory whose lockfile is a Python lockfile'
                  : 'a Python lockfile beside it'
            }), so ` +
            'it was parsed only to decide whether it stops the scan',
    });
  }
  const contents = await source.readMany(readPaths);
  for (const manifestPath of readPaths) {
    if (!underPrefix(manifestPath, prefix)) {
      continue;
    }
    const content = contents.get(manifestPath) ?? null;
    if (content !== null) {
      const member = collect(manifestPath, content, 'root-member');
      if (member !== null) {
        manifests.push(member);
      }
    }
  }

  // Manifests the workspace globs did not name: a package.json outside any
  // workspace, a requirements.txt, a pyproject.toml. Already-parsed paths
  // are skipped so a workspace member is not read twice.
  const seenManifests = new Set(manifests.map((manifest) => manifest.path));
  const extraManifestPaths = listedManifests.filter(
    (relPath) => !seenManifests.has(relPath) && !attempted.has(relPath) && !unread.has(relPath)
  );
  const extraContents = await source.readMany(extraManifestPaths);
  for (const relPath of extraManifestPaths) {
    const content = extraContents.get(relPath) ?? null;
    if (content === null) {
      continue;
    }
    // A file that parses is read whether or not it is ignored: its
    // findings are filtered later, like any other path under ignorePaths.
    // One that does not is collected, and settleParseFailures decides it.
    const parsed = collect(relPath, content);
    if (parsed !== null) {
      manifests.push(parsed);
    }
  }
  // A project manifest under a skipped directory name that is not read for
  // names (a pyproject.toml beside vendor/x/uv.lock, a uv workspace member
  // under build/) is still parsed, so that one that does not parse stops
  // the scan as it would anywhere else. Its dependencies are not read.
  const fatalityOnly: string[] = [];
  for (const relPath of filesInPrefix) {
    if (
      isProjectManifestPath(relPath) &&
      classification.positions.has(relPath) &&
      !attempted.has(relPath) &&
      !(await source.isSymlink(relPath))
    ) {
      fatalityOnly.push(relPath);
    }
  }
  const fatalityContents = await source.readMany(fatalityOnly);
  for (const relPath of fatalityOnly) {
    const content = fatalityContents.get(relPath) ?? null;
    if (content !== null) {
      collect(relPath, content);
    }
  }
  await followRequirementIncludes(source, manifests);
  const pythonLockfiles = await loadPythonLockfiles(source, files);

  const lockfileDirs = uniquePaths(listedLockfiles.map(parentDir)).sort((left, right) => {
    if (left === right) {
      return 0;
    }
    if (left === '') {
      return -1;
    }
    if (right === '') {
      return 1;
    }
    return left < right ? -1 : 1;
  });
  const merged: ParsedLockfile[] = [];
  const lockfileParseFailures: DepGuardError[] = [];
  for (const directory of lockfileDirs) {
    const loaded = await loadLockfiles(source, diagnostics, unread, role, directory, npmLockfiles, lockfileParseFailures);
    if (loaded.lockfile !== null) {
      merged.push(loaded.lockfile);
    }
    merged.push(...loaded.extraLockfiles);
  }
  throwLockfileParseFailures(lockfileParseFailures);
  const lockfile = merged.find(isReadLockfile) ?? merged[0] ?? null;
  const extraLockfiles = merged.filter(
    (parsed) => parsed !== lockfile && (parsed.format === 'npm' || parsed.format === 'pnpm')
  );
  const readRootPaths = new Set(
    [...(lockfile === null ? [] : [lockfile]), ...extraLockfiles]
      .filter(isReadLockfile)
      .map((parsed) => parsed.path)
  );
  const fullInventory = await source.lockfileInventory();
  const lockfileInventory = fullInventory
    .filter((entry) => underPrefix(entry.path, prefix))
    .map((entry) => ({
      path: entry.path,
      read: readRootPaths.has(entry.path),
      blobId: entry.blobId,
    }));
  // `scan <path>` reads that directory and nothing above it. A lockfile in
  // an ancestor directory may record what this directory installs, and
  // this scan did not read it; the reader has to know that a full gate is
  // a scan of the repository root. Only the ancestor paths are looked at,
  // not a second walk of the tree.
  if (prefix !== '') {
    const ancestors = new Set<string>();
    for (let dir = parentDir(prefix); ; dir = parentDir(dir)) {
      ancestors.add(dir);
      if (dir === '') {
        break;
      }
    }
    const above = fullInventory
      .map((entry) => entry.path)
      .filter((entryPath) => ancestors.has(parentDir(entryPath)))
      .sort();
    if (above.length > 0) {
      diagnostics.push({
        code: LOCKFILE_OUTSIDE_PREFIX,
        message:
          `${above.join(', ')}: above the scanned directory ${prefix} and not read by this scan, so ` +
          'what it installs was not judged here; a scan of the repository root reads it',
      });
    }
  }
  // Read once and handed to both parsers below -- parseNpmrcPins and
  // parseNpmrcDefaultRegistry read the same file for two different keys,
  // and a source's read() is not assumed free of cost (a git source shells
  // out per read).
  const npmrcContent = await source.read(NPMRC);
  const workspaceLocalNamesByDir = confirmWorkspaceLocalNames(
    [...(lockfile === null ? [] : [lockfile]), ...extraLockfiles],
    listedLockfiles,
    manifests,
    diagnostics
  );

  const state: RepoState = {
    manifests,
    lockfile,
    extraLockfiles,
    lockfileInventory,
    // pnpm honours the workspace-level allowlist and every manifest's own
    // pnpm block together, and computeDelta reads only this merged list,
    // so the merge has to happen here rather than in the install-script
    // check. Skipping it would leave that check permanently empty.
    onlyBuilt: parseOnlyBuilt(workspaceYamlContent, manifests),
    npmrcContent,
    npmrcRegistryPins: parseNpmrcPins(npmrcContent),
    npmrcDefaultRegistry: parseNpmrcDefaultRegistry(npmrcContent),
    // npm's "link": true entries, each confirmed against this side's own
    // manifests and the lockfile npm actually installs from in that
    // directory. A claim alone exempts nothing; see
    // confirmWorkspaceLocalNames.
    workspaceLocalNames: new Set([...workspaceLocalNamesByDir.values()].flatMap((names) => [...names])),
    workspaceLocalNamesByDir,
    pythonLockfiles,
    pythonArchiveFiles,
    goFiles: files.filter(isGoModuleFile).sort(),
    projects: {
      reasons: classification.reasons,
      workspaceFields: classification.workspaceFields,
      // Filled in by settleParseFailures from unreadInputs below, the
      // unread inputs that would have stopped a root scan.
      unreadInputs: [],
    },
  };
  return { state, role, isIgnoredPath, classification, failures, loadedAgainst: comparisons, unreadInputs };
}

// Both sides of a scan usually read the same workspace configuration, so
// an unsupported glob would otherwise be reported once per side.
function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const unique: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify([diagnostic.code, diagnostic.message]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(diagnostic);
  }
  return unique;
}

// A path that does not exist is a typo, a stale CI variable, or the wrong
// working directory -- never a repository that happens to hold nothing.
// Scanning it as an empty state would report a clean result for a
// directory nobody looked at, so it is refused up front, before git is
// spawned (a missing cwd otherwise surfaces as a spawn failure that reads
// like "git is not installed").
export async function assertScannablePath(repoRoot: string): Promise<void> {
  let stats;
  try {
    stats = await stat(repoRoot);
  } catch (err) {
    if (isMissingPathError(err)) {
      throw new DepGuardError(`${repoRoot}: no such directory to scan`, 'path-missing');
    }
    throw new DepGuardError(
      `${repoRoot}: could not be read (${errorCode(err) ?? 'unknown error'})`,
      'read-error'
    );
  }
  if (!stats.isDirectory()) {
    throw new DepGuardError(`${repoRoot}: is not a directory`, 'path-missing');
  }
}

// Names probeManifestOnDisk treats as "this is a manifest", the union of
// the root manifest name and every lockfile format loadLockfile
// recognizes -- the exact set loadState can turn into a resolved
// RepoState, so a hit here can never be a file the resolver would not
// also have recognized by name.
const MANIFEST_PROBE_NAMES = new Set<string>([
  ROOT_MANIFEST,
  PYPROJECT_TOML,
  REQUIREMENTS_TXT,
  ...LOCKFILE_FILE_NAMES,
]);

/**
 * Whether a manifest-shaped file sits on disk inside this scan. Used by
 * scan.ts when the resolver produced nothing, to tell a dependency-free
 * tree from one that holds a file the resolver did not turn into a
 * manifest or a lockfile it reads.
 *
 * Uses the same listing as the working-tree side: gitignored paths are
 * absent. A stray manifest under a skipped directory name is not a
 * could-not-run. A lockfile is, whatever directory names are in its path.
 * `prefix` limits the question to the directory `scan <path>` was asked
 * to read.
 *
 * Not called for --staged. That mode judges the index, and an untracked
 * manifest on disk is outside that scope.
 */
export async function probeManifestOnDisk(root: string, prefix = ''): Promise<boolean> {
  const files = await listWorkingTreeFiles(root);
  return files.some((relPath) => {
    if (!underPrefix(relPath, prefix) || !MANIFEST_PROBE_NAMES.has(baseName(relPath))) {
      return false;
    }
    if (isLockfileName(relPath)) {
      return true;
    }
    return !pathSkipped(relPath);
  });
}

// git resolves "REF:path" against the top of the working tree, so the
// toplevel is what every path in this module is relative to. Resolving it
// (rather than trusting the argument) also doubles as the "is this a git
// repository at all" check, and normalises the symlinked temp directories
// that macOS hands out.
async function resolveRepoRoot(repoRoot: string): Promise<string> {
  const toplevel = (await gitOrThrow(repoRoot, ['rev-parse', '--show-toplevel'])).trim();
  return toplevel === '' ? repoRoot : toplevel;
}

// Audit takes the same anchor as the other two modes whenever there is a
// repository to anchor to, so a manifestPath -- and therefore a finding
// fingerprint -- means the same file whichever mode produced it. Outside a
// repository there is nothing to resolve and the argument stands, which is
// what keeps an unpacked tarball auditable.
async function resolveAuditRoot(repoRoot: string): Promise<string> {
  const run = await runGit(repoRoot, ['rev-parse', '--show-toplevel']);
  if (!run.ok) {
    return repoRoot;
  }
  const toplevel = run.stdout.trim();
  return toplevel === '' ? repoRoot : toplevel;
}

// Exported for scan.ts: manifestPath is always anchored to the git root
// regardless of which directory a scan is invoked from (both resolvers
// above), but reading config and the baseline from whatever directory the
// caller happened to name would silently discard a repository's own
// .dep-guard.json and baseline when scanning a subdirectory. This lets a
// caller resolve the SAME root
// loadStates itself will use, before it needs to read anything else
// anchored to the repository. Mirrors loadStates' own per-mode tolerance:
// audit never requires being inside a git repository at all; staged and
// base do, since neither mode can do anything meaningful outside one.
export async function resolveScanRoot(repoRoot: string, mode: ScanMode): Promise<string> {
  return mode.kind === 'audit' ? resolveAuditRoot(repoRoot) : resolveRepoRoot(repoRoot);
}

// The directory `scan <path>` named, relative to the git root and using
// "/" separators. Empty when the named path is the root itself. A path
// outside the root does not narrow the scan.
export async function relativeScanPrefix(named: string, anchor: string): Promise<string> {
  const [resolvedNamed, resolvedAnchor] = await Promise.all([
    resolveOrKeep(named),
    resolveOrKeep(anchor),
  ]);
  if (resolvedNamed === resolvedAnchor) {
    return '';
  }
  const rel = path.relative(resolvedAnchor, resolvedNamed);
  if (rel === '' || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return '';
  }
  return rel.split(path.sep).join('/');
}

async function resolveOrKeep(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return candidate;
  }
}

// Naming a directory inside a repository still anchors every path at the
// git toplevel (that is the only place git can resolve blob paths), and
// the scan reads manifests under the named directory. The notice says so,
// because the paths in the output are not relative to the directory the
// caller typed. It applies to every mode.
//
// Both paths are compared AND reported after resolution. Quoting the raw
// argument beside a resolved anchor would print "/var/..." next to
// "/private/var/...", which reads as two unrelated directories.
async function noteAnchorDifference(
  named: string,
  anchor: string,
  diagnostics: Diagnostic[]
): Promise<void> {
  const [resolvedNamed, resolvedAnchor] = await Promise.all([
    resolveOrKeep(named),
    resolveOrKeep(anchor),
  ]);
  if (resolvedNamed === resolvedAnchor) {
    return;
  }
  diagnostics.push({
    code: AUDIT_ANCHOR_DIFFERS,
    message: `${resolvedNamed} sits inside the git repository at ${resolvedAnchor}; that directory was scanned and every reported path is relative to the repository root`,
  });
}

async function hasCommittedHead(root: string): Promise<boolean> {
  // --quiet keeps a fresh repository's unborn HEAD from printing anything;
  // the caller already knows this is a repository, so a failure here can
  // only mean HEAD does not resolve to a commit yet.
  const run = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return run.ok && run.stdout.trim() !== '';
}

function indexSource(root: string): FileSource {
  return gitSource(root, ':0', ['ls-files', '-s', '-z'], 'index');
}

function refSource(root: string, ref: string): FileSource {
  // The trailing "--" keeps a ref whose name also matches a file in the
  // repository from being read as a pathspec.
  return gitSource(root, ref, ['ls-tree', '-r', '-z', ref, '--'], 'tree');
}

/**
 * One side read out of a git ref, for use as an additional comparison side
 * (the trust base of a pull-request run). Diagnostics from reading it are
 * dropped, since the same workspace configuration is reported from the
 * sides the scan itself loads, except the notes for what this side could
 * not read and treated as absent, which are added to `notes` when given.
 */
export async function loadRefState(
  repoRoot: string,
  ref: string,
  notes?: Diagnostic[],
  prefix = '',
  isIgnoredPath: (relPath: string) => boolean = () => false
): Promise<RepoState> {
  if (!isUsableRef(ref)) {
    throw new DepGuardError(`ref "${ref}" is not a usable git ref`, 'git-error');
  }
  const root = await resolveRepoRoot(repoRoot);
  const diagnostics: Diagnostic[] = [];
  const side = await loadState(
    refSource(root, ref),
    diagnostics,
    {
      kind: 'comparison',
      label: `the trust base "${ref}"`,
    },
    prefix,
    isIgnoredPath,
    []
  );
  // The trust base's own parse failures are decided by its own projects
  // only. It contributes control input (ignorePaths) to the other sides,
  // never project paths.
  settleParseFailures([side], prefix, diagnostics);
  notes?.push(
    ...diagnostics.filter((d) => COMPARISON_SIDE_CODES.has(d.code) || d.code === CLASSIFICATION_INPUT_UNREAD)
  );
  return side.state;
}

/**
 * Which manifests are projects on a git ref, and why, without loading the
 * side for the scan: the trust base of a --staged --trust-base run, which
 * the ignorePaths rule reads as its reference side while the lockfile rules
 * keep HEAD. Never throws. A manifest there that does not parse contributes
 * no reasons, and a ref that cannot be classified at all contributes none,
 * so either way it excuses nothing and the commit hook gains no exit 2.
 */
export async function loadRefProjects(
  repoRoot: string,
  ref: string,
  prefix = '',
  isIgnoredPath: (relPath: string) => boolean = () => false
): Promise<ProjectClassification> {
  try {
    if (!isUsableRef(ref)) {
      return EMPTY_PROJECTS;
    }
    const root = await resolveRepoRoot(repoRoot);
    const source = cachingSource(refSource(root, ref));
    const listedFiles = await source.listFiles();
    const classification = await classifySide(
      source,
      listedFiles,
      prefix,
      { kind: 'comparison', label: `the trust base "${ref}"` },
      [],
      manifestParser(),
      new Map()
    );
    // The same decision loadState makes for a comparison side loaded on
    // its own.
    const unreadInputs = stoppingUnreadInputs(
      classification,
      { kind: 'comparison', label: `the trust base "${ref}"` },
      isIgnoredPath,
      []
    );
    return { reasons: classification.reasons, workspaceFields: classification.workspaceFields, unreadInputs };
  } catch {
    return EMPTY_PROJECTS;
  }
}

// How a project rule reads in a message.
export function projectRuleText(rule: ProjectRule): string {
  return rule === 'requirements-include'
    ? 'a requirements file another requirements file includes with -r or -c'
    : POSITION_TEXT[rule];
}

// How one project reason reads in a message: its rule, and for a
// symlinked member the links it was reached through, or the link that
// could not be followed.
export function projectReasonText(reason: ProjectReason): string {
  const text = projectRuleText(reason.rule);
  if (reason.link === undefined) {
    return text;
  }
  const paths = reason.link.paths.join(', ');
  if (reason.link.followed) {
    return `${text} reached through the ${reason.link.paths.length === 1 ? 'symlink' : 'symlinks'} ${paths}`;
  }
  const why =
    reason.link.cause === 'cycle'
      ? `following the symlink ${paths} loops back into a directory already on its path`
      : reason.link.cause === 'fan-out'
        ? `the symlinks under ${paths} fan out past the limit of ${MAX_SYMLINKED_VISITS}`
        : reason.link.cause === 'side-fan-out'
          ? `the symlink walks on this side ran past the limit of ${MAX_SIDE_SYMLINKED_VISITS} visits in all before the symlink ${paths}`
          : `the symlink ${paths} could not be followed`;
  return `possibly ${text}: ${why}, so every manifest of this kind on this side counts`;
}

// The project manifest a lockfile at this path installs, in its own
// directory, or null when the path is not a lockfile this tool recognises.
export function projectManifestForLockfile(relPath: string): string | null {
  const dir = parentDir(relPath);
  if (isLockfileName(relPath)) {
    return manifestPathIn(dir);
  }
  if (isPythonLockfilePath(relPath)) {
    return joinRepoPath(dir, baseName(relPath) === 'Pipfile.lock' ? 'Pipfile' : PYPROJECT_TOML);
  }
  return null;
}

/**
 * True when two refs name the same tree, so a side already read from one
 * is exactly the side the other would give. Any failure answers false and
 * the caller reads the side again.
 */
export async function refsNameSameTree(repoRoot: string, a: string, b: string): Promise<boolean> {
  if (!isUsableRef(a) || !isUsableRef(b)) {
    return false;
  }
  const root = await resolveRepoRoot(repoRoot);
  const [left, right] = await Promise.all([
    runGit(root, ['rev-parse', '--verify', '--quiet', `${a}^{tree}`]),
    runGit(root, ['rev-parse', '--verify', '--quiet', `${b}^{tree}`]),
  ]);
  return left.ok && right.ok && left.stdout.trim() !== '' && left.stdout.trim() === right.stdout.trim();
}

export async function loadStates(
  repoRoot: string,
  mode: ScanMode,
  options: { isIgnoredPath?: (relPath: string) => boolean } = {}
): Promise<StatePair> {
  const isIgnoredPath = options.isIgnoredPath ?? (() => false);
  await assertScannablePath(repoRoot);
  const diagnostics: Diagnostic[] = [];

  if (mode.kind === 'audit') {
    const root = await resolveAuditRoot(repoRoot);
    const prefix = await relativeScanPrefix(repoRoot, root);
    await noteAnchorDifference(repoRoot, root, diagnostics);
    const after = await loadState(
      await createWorkingTreeSource(root, diagnostics),
      diagnostics,
      JUDGED,
      prefix,
      isIgnoredPath,
      []
    );
    settleParseFailures([after], prefix, diagnostics);
    return { before: null, after: after.state, mode, diagnostics: dedupeDiagnostics(diagnostics) };
  }

  const root = await resolveRepoRoot(repoRoot);
  const prefix = await relativeScanPrefix(repoRoot, root);
  await noteAnchorDifference(repoRoot, root, diagnostics);

  // Every side is loaded before any parse failure is decided, so one exit 2
  // lists them all and a comparison-side failure never hides a judged one.
  if (mode.kind === 'staged') {
    const before = (await hasCommittedHead(root))
      ? await loadState(
          refSource(root, 'HEAD'),
          diagnostics,
          { kind: 'comparison', label: 'HEAD' },
          prefix,
          isIgnoredPath,
          []
        )
      : null;
    const after = await loadState(
      indexSource(root),
      diagnostics,
      JUDGED,
      prefix,
      isIgnoredPath,
      before === null ? [] : [before]
    );
    settleParseFailures(before === null ? [after] : [after, before], prefix, diagnostics);
    return { before: before?.state ?? null, after: after.state, mode, diagnostics: dedupeDiagnostics(diagnostics) };
  }

  if (!isUsableRef(mode.ref)) {
    throw new DepGuardError(`base ref "${mode.ref}" is not a usable git ref`, 'git-error');
  }
  const before = await loadState(
    refSource(root, mode.ref),
    diagnostics,
    {
      kind: 'comparison',
      label: `the --base ref "${mode.ref}"`,
    },
    prefix,
    isIgnoredPath,
    []
  );
  const after = await loadState(
    await createWorkingTreeSource(root, diagnostics),
    diagnostics,
    JUDGED,
    prefix,
    isIgnoredPath,
    [before]
  );
  settleParseFailures([after, before], prefix, diagnostics);
  return { before: before.state, after: after.state, mode, diagnostics: dedupeDiagnostics(diagnostics) };
}
