import { execFile, spawn } from 'node:child_process';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { MissingPackagesMapError, parseNpmLockfile } from './lockfiles/npm.js';
import { parseOnlyBuilt, parsePnpmLockfile } from './lockfiles/pnpm.js';
import type { ParsedLockfile } from './lockfiles/types.js';
import { parseManifest, type ParsedManifest } from './manifest.js';
import { isPythonManifestPath, parsePyproject, parseRequirements } from './python-manifest.js';
import {
  isReadLockfile,
  parseNpmrcDefaultRegistry,
  parseNpmrcPins,
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
// workspace member a glob resolved, and every lockfile, are still read.
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

function isProjectManifestPath(relPath: string): boolean {
  return isPackageJsonPath(relPath) || isPythonManifestPath(relPath);
}

function parseProjectManifest(relPath: string, content: string): ParsedManifest {
  const name = baseName(relPath);
  if (name === PYPROJECT_TOML) {
    return parsePyproject(relPath, content);
  }
  if (name === REQUIREMENTS_TXT) {
    return parseRequirements(relPath, content);
  }
  return parseManifest(relPath, content);
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
// "workspaces": { "packages": [...] } spelling.
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
  if (!isPlainObject(parsed)) {
    return [];
  }
  const workspaces = parsed.workspaces;
  if (isPlainObject(workspaces)) {
    return stringArray(workspaces.packages);
  }
  return stringArray(workspaces);
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
async function discoverWorkspaceDirs(
  source: FileSource,
  patterns: string[],
  diagnostics: Diagnostic[],
  role: SideRole
): Promise<string[]> {
  const positives: string[] = [];
  let negatedPatterns: string[] = [];
  for (const raw of patterns) {
    const bangs = /^!+/.exec(raw)?.[0].length ?? 0;
    const pattern = raw.slice(bangs).replace(/^\.?\/+/, '');
    if (bangs % 2 === 1) {
      if (
        pattern.includes('\\') ||
        UNEXPANDABLE_GLOB_SYNTAX.test(pattern) ||
        patternReach(pattern) !== 'inside'
      ) {
        diagnostics.push({
          code: GLOB_UNSUPPORTED,
          message: `workspace exclusion "${raw}": this tool cannot apply it exactly, so it was not applied and the directories it names were scanned`,
        });
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
  negatedPatterns = negatedPatterns.map(collapseSlashes);

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
  directory = ''
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
      loaded.push(load(name, content));
    } catch (err) {
      // An npm lockfile whose version promises a packages map it does not
      // have is refused on the judged side. On a comparison side it is an
      // unread lockfile there: no entries and no coverage, so the judged
      // side's lockfile is compared against nothing and its entries count
      // as new, and the pull request that regenerates it is not refused
      // for the file it replaces.
      if (role.kind === 'judged' || !(err instanceof MissingPackagesMapError)) {
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
        `${relPath}: is a symlink on the side being judged. dep-guard does not parse a lockfile or a ` +
          'package.json through a symlink; replace the link with a regular file. A comparison side ' +
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

async function loadState(
  source: FileSource,
  diagnostics: Diagnostic[],
  role: SideRole,
  prefix: string
): Promise<RepoState> {
  const filesInPrefix = (await source.listFiles()).filter((relPath) => underPrefix(relPath, prefix));
  // Lockfiles are never dropped for a directory name. Stray manifests are.
  const files = filesInPrefix.filter((relPath) => isLockfileName(relPath) || !pathSkipped(relPath));
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
    manifests.push(parseManifest(ROOT_MANIFEST, rootManifestContent));
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
    if (!isProjectManifestPath(relPath) || !pathSkipped(relPath) || memberPaths.has(relPath)) {
      continue;
    }
    const segment = skipSegment(relPath);
    if (segment !== null && SILENT_SKIP_DIR_NAMES.has(segment)) {
      continue;
    }
    diagnostics.push({
      code: MANIFEST_SKIPPED_DIRNAME,
      message:
        `${relPath}: not scanned; a directory named ${segment ?? 'unknown'} is skipped unless a workspace ` +
        'pattern names it. A lockfile on this path would still be read',
    });
  }
  const contents = await source.readMany(readPaths);
  for (const manifestPath of readPaths) {
    if (!underPrefix(manifestPath, prefix)) {
      continue;
    }
    const content = contents.get(manifestPath) ?? null;
    if (content !== null) {
      manifests.push(parseManifest(manifestPath, content));
    }
  }

  // Manifests the workspace globs did not name: a package.json outside any
  // workspace, a requirements.txt, a pyproject.toml. Already-parsed paths
  // are skipped so a workspace member is not read twice.
  const seenManifests = new Set(manifests.map((manifest) => manifest.path));
  const extraManifestPaths = listedManifests.filter(
    (relPath) => !seenManifests.has(relPath) && !unread.has(relPath)
  );
  const extraContents = await source.readMany(extraManifestPaths);
  for (const relPath of extraManifestPaths) {
    const content = extraContents.get(relPath) ?? null;
    if (content === null) {
      continue;
    }
    manifests.push(parseProjectManifest(relPath, content));
  }

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
  for (const directory of lockfileDirs) {
    const loaded = await loadLockfiles(source, diagnostics, unread, role, directory);
    if (loaded.lockfile !== null) {
      merged.push(loaded.lockfile);
    }
    merged.push(...loaded.extraLockfiles);
  }
  const lockfile = merged.find(isReadLockfile) ?? merged[0] ?? null;
  const extraLockfiles = merged.filter(
    (parsed) => parsed !== lockfile && (parsed.format === 'npm' || parsed.format === 'pnpm')
  );
  const readRootPaths = new Set(
    [...(lockfile === null ? [] : [lockfile]), ...extraLockfiles]
      .filter(isReadLockfile)
      .map((parsed) => parsed.path)
  );
  const lockfileInventory = (await source.lockfileInventory())
    .filter((entry) => underPrefix(entry.path, prefix))
    .map((entry) => ({
      path: entry.path,
      read: readRootPaths.has(entry.path),
      blobId: entry.blobId,
    }));
  // Read once and handed to both parsers below -- parseNpmrcPins and
  // parseNpmrcDefaultRegistry read the same file for two different keys,
  // and a source's read() is not assumed free of cost (a git source shells
  // out per read).
  const npmrcContent = await source.read(NPMRC);

  return {
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
    // A straight carry of what the lockfile parser already discovered
    // (npm's "link": true entries, one per workspace member); no
    // directory or manifest is re-walked to reconstruct it here.
    workspaceLocalNames: new Set([
      ...(lockfile?.workspaceLocalNames ?? []),
      ...extraLockfiles.flatMap((extra) => [...extra.workspaceLocalNames]),
    ]),
  };
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
  prefix = ''
): Promise<RepoState> {
  if (!isUsableRef(ref)) {
    throw new DepGuardError(`ref "${ref}" is not a usable git ref`, 'git-error');
  }
  const root = await resolveRepoRoot(repoRoot);
  const diagnostics: Diagnostic[] = [];
  const state = await loadState(
    refSource(root, ref),
    diagnostics,
    {
      kind: 'comparison',
      label: `the trust base "${ref}"`,
    },
    prefix
  );
  notes?.push(...diagnostics.filter((d) => COMPARISON_SIDE_CODES.has(d.code)));
  return state;
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

export async function loadStates(repoRoot: string, mode: ScanMode): Promise<StatePair> {
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
      prefix
    );
    return { before: null, after, mode, diagnostics: dedupeDiagnostics(diagnostics) };
  }

  const root = await resolveRepoRoot(repoRoot);
  const prefix = await relativeScanPrefix(repoRoot, root);
  await noteAnchorDifference(repoRoot, root, diagnostics);

  if (mode.kind === 'staged') {
    const before = (await hasCommittedHead(root))
      ? await loadState(refSource(root, 'HEAD'), diagnostics, { kind: 'comparison', label: 'HEAD' }, prefix)
      : null;
    const after = await loadState(indexSource(root), diagnostics, JUDGED, prefix);
    return { before, after, mode, diagnostics: dedupeDiagnostics(diagnostics) };
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
    prefix
  );
  const after = await loadState(await createWorkingTreeSource(root, diagnostics), diagnostics, JUDGED, prefix);
  return { before, after, mode, diagnostics: dedupeDiagnostics(diagnostics) };
}
