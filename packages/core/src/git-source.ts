import { execFile } from 'node:child_process';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { parseNpmLockfile } from './lockfiles/npm.js';
import { parseOnlyBuilt, parsePnpmLockfile } from './lockfiles/pnpm.js';
import type { ParsedLockfile } from './lockfiles/types.js';
import { parseManifest, type ParsedManifest } from './manifest.js';
import { parseNpmrcPins, type RepoState } from './state.js';
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

// Errors that mean "this path is not a readable file here", as opposed to
// a permission or I/O failure that has to stay loud.
const MISSING_PATH_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

const GLOB_UNSUPPORTED = 'workspace-glob-unsupported';
const DIR_UNREADABLE = 'workspace-dir-unreadable';
const PATH_OUTSIDE_ROOT = 'path-outside-root';
const SYMLINK_CYCLE = 'symlink-cycle';
const DUPLICATE_DIR = 'workspace-duplicate-directory';
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
  listChildDirs(dir: string): Promise<string[]>;
  // A stable identity for a directory, used to notice that two discovered
  // paths are the same directory reached two ways. Null means the path
  // cannot be used at all (it escapes the root, or its links cycle) and
  // has already been reported. The empty string identifies the root.
  identifyDir(relPath: string): Promise<string | null>;
}

async function loadGitListing(root: string, args: string[]): Promise<Set<string>> {
  const stdout = await gitOrThrow(root, args);
  const files = new Set<string>();
  // -z output is NUL-separated, which is the only listing form that
  // survives a path containing a newline or a quote character.
  for (const entry of stdout.split('\0')) {
    if (entry !== '') {
      files.add(entry);
    }
  }
  return files;
}

function childDirsOf(files: ReadonlySet<string>, dir: string): string[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const names = new Set<string>();
  for (const file of files) {
    if (!file.startsWith(prefix)) {
      continue;
    }
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf('/');
    // git records files, never directories, so a subdirectory is only
    // visible through the files underneath it. No remaining slash means
    // this entry is a file sitting directly in dir, not a package
    // directory.
    if (slash > 0) {
      names.add(rest.slice(0, slash));
    }
  }
  return [...names];
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
function gitSource(root: string, revision: string, listArgs: string[]): FileSource {
  let listing: Promise<Set<string>> | null = null;
  const files = (): Promise<Set<string>> => {
    listing ??= loadGitListing(root, listArgs);
    return listing;
  };
  return {
    async read(relPath: string): Promise<string | null> {
      if (!(await files()).has(relPath)) {
        return null;
      }
      return readBlob(root, `${revision}:${relPath}`);
    },
    async listChildDirs(dir: string): Promise<string[]> {
      return childDirsOf(await files(), dir);
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

  return {
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
    parsed = JSON.parse(content);
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
    parsed = parseYaml(content);
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

function normalizePattern(pattern: string): string {
  let normalized = pattern.trim();
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

// A workspaces list is attacker-writable content in the very repository
// being scanned, so a pattern that reaches outside the root -- "../*",
// "/etc/*", a Windows drive letter -- is dropped rather than expanded.
// Every path this module reads is built from a pattern that passed here.
//
// A backslash is rejected outright rather than analysed: this check only
// understands "/" as a separator, while path.join treats "\" as one on
// win32, so "..\evil" would otherwise sail through a "/"-only containment
// test and then escape once joined.
function isContainedRelativePath(candidate: string): boolean {
  if (candidate === '' || candidate.startsWith('/') || candidate.includes('\\')) {
    return false;
  }
  if (/^[a-zA-Z]:/.test(candidate)) {
    return false;
  }
  return candidate
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
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
  const segments = pattern.split('/');
  const wildcardIndex = segments.findIndex((segment) => segment.includes('*'));
  if (wildcardIndex === -1) {
    return [pattern];
  }
  const lastSegment = segments[segments.length - 1];
  if (wildcardIndex !== segments.length - 1) {
    // One level of expansion, so the wildcard has to be in the final
    // segment. A deeper pattern ("packages/*/inner") would need a
    // recursive walk and a glob dependency; rather than guess, it expands
    // to nothing and says so, because a workspace package that silently
    // never gets scanned is the one blind spot this tool must not have.
    diagnostics.push({
      code: GLOB_UNSUPPORTED,
      message: `workspace pattern "${pattern}": only a wildcard in the final path segment is expanded, so no packages were discovered for it`,
    });
    return [];
  }
  if (lastSegment.includes('**')) {
    // A trailing "**" means "at any depth" to pnpm. One level is still
    // expanded, since discovering more is the safe direction, but anything
    // nested deeper is missed and that has to be visible.
    diagnostics.push({
      code: GLOB_UNSUPPORTED,
      message: `workspace pattern "${pattern}": "**" is expanded one level only, so packages nested more deeply were not discovered`,
    });
  }
  const parent = segments.slice(0, -1).join('/');
  const children = await source.listChildDirs(parent);
  return children
    .filter((child) => child !== NEVER_A_PACKAGE_DIR && matchWildcard(lastSegment, child))
    .map((child) => (parent === '' ? child : `${parent}/${child}`));
}

async function discoverWorkspaceDirs(
  source: FileSource,
  patterns: string[],
  diagnostics: Diagnostic[]
): Promise<string[]> {
  const includes: string[] = [];
  const excludes: string[] = [];
  for (const raw of patterns) {
    const trimmed = raw.trim();
    const negated = trimmed.startsWith('!');
    const pattern = normalizePattern(negated ? trimmed.slice(1) : trimmed);
    if (!isContainedRelativePath(pattern)) {
      diagnostics.push({
        code: GLOB_UNSUPPORTED,
        message: `workspace pattern "${raw}": only repository-relative patterns without "..", a leading "/", or a backslash are expanded; it was ignored`,
      });
      continue;
    }
    if (negated) {
      excludes.push(pattern);
    } else {
      includes.push(pattern);
    }
  }

  const dirs = new Set<string>();
  for (const pattern of includes) {
    for (const dir of await expandPattern(source, pattern, diagnostics)) {
      if (excludes.some((exclusion) => matchGlobPath(exclusion, dir))) {
        continue;
      }
      dirs.add(dir);
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

// Detection order, first present wins. npm and pnpm come first because
// they are the two formats with real parsers behind them.
const LOCKFILE_CANDIDATES: Array<[string, LockfileLoader]> = [
  ['package-lock.json', parseNpmLockfile],
  ['pnpm-lock.yaml', parsePnpmLockfile],
  ['yarn.lock', manifestOnlyLockfile('yarn')],
  ['bun.lock', manifestOnlyLockfile('bun')],
  ['bun.lockb', (lockfilePath) => binaryLockfile(lockfilePath)],
];

// A parse failure propagates. A null return means the file is genuinely
// absent and nothing else: swallowing a malformed before-side lockfile
// into a null would turn a one-line change into a whole-repository delta,
// which is exactly the shape an attacker would want a corrupt lockfile to
// produce.
async function loadLockfile(source: FileSource): Promise<ParsedLockfile | null> {
  for (const [name, load] of LOCKFILE_CANDIDATES) {
    // bun.lockb is binary and is read only to learn that it exists; the
    // lossily decoded content it returns is never parsed.
    const content = await source.read(name);
    if (content === null) {
      continue;
    }
    return load(name, content);
  }
  return null;
}

const ROOT_MANIFEST = 'package.json';
const WORKSPACE_YAML = 'pnpm-workspace.yaml';
const NPMRC = '.npmrc';

async function loadState(source: FileSource, diagnostics: Diagnostic[]): Promise<RepoState> {
  const rootManifestContent = await source.read(ROOT_MANIFEST);
  const workspaceYamlContent = await source.read(WORKSPACE_YAML);

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

  const patterns = [
    ...workspaceGlobsFromManifest(rootManifestContent),
    ...workspaceGlobsFromWorkspaceYaml(workspaceYamlContent),
  ];
  // discoverWorkspaceDirs already returns each spelling once, so a pattern
  // listed by both workspace sources costs nothing here and says nothing.
  for (const dir of await discoverWorkspaceDirs(source, patterns, diagnostics)) {
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

    const manifestPath = `${identity}/${ROOT_MANIFEST}`;
    const content = await source.read(manifestPath);
    if (content !== null) {
      manifests.push(parseManifest(manifestPath, content));
    }
  }

  const lockfile = await loadLockfile(source);

  return {
    manifests,
    lockfile,
    // pnpm honours the workspace-level allowlist and every manifest's own
    // pnpm block together, and computeDelta reads only this merged list,
    // so the merge has to happen here rather than in the install-script
    // check. Skipping it would leave that check permanently empty.
    onlyBuilt: parseOnlyBuilt(workspaceYamlContent, manifests),
    npmrcRegistryPins: parseNpmrcPins(await source.read(NPMRC)),
    // A straight carry of what the lockfile parser already discovered
    // (npm's "link": true entries, one per workspace member); no
    // directory or manifest is re-walked to reconstruct it here.
    workspaceLocalNames: lockfile?.workspaceLocalNames ?? new Set(),
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

async function resolveOrKeep(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return candidate;
  }
}

// Naming a directory that sits inside a repository scans the enclosing
// repository instead, and never reads the named directory on its own
// terms. That is defensible -- the repository toplevel is the only anchor
// git can resolve blob paths against -- but surprising enough that it has
// to be said out loud rather than inferred from paths in the output. It
// applies to every mode, not just audit: staged and base substitute the
// toplevel just as silently.
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
    message: `${resolvedNamed} sits inside the git repository at ${resolvedAnchor}; that repository was scanned and every reported path is relative to it`,
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
  return gitSource(root, ':0', ['ls-files', '-z']);
}

function refSource(root: string, ref: string): FileSource {
  // The trailing "--" keeps a ref whose name also matches a file in the
  // repository from being read as a pathspec.
  return gitSource(root, ref, ['ls-tree', '-r', '--name-only', '-z', ref, '--']);
}

export async function loadStates(repoRoot: string, mode: ScanMode): Promise<StatePair> {
  await assertScannablePath(repoRoot);
  const diagnostics: Diagnostic[] = [];

  if (mode.kind === 'audit') {
    const root = await resolveAuditRoot(repoRoot);
    await noteAnchorDifference(repoRoot, root, diagnostics);
    const after = await loadState(await createWorkingTreeSource(root, diagnostics), diagnostics);
    return { before: null, after, mode, diagnostics: dedupeDiagnostics(diagnostics) };
  }

  const root = await resolveRepoRoot(repoRoot);
  await noteAnchorDifference(repoRoot, root, diagnostics);

  if (mode.kind === 'staged') {
    const before = (await hasCommittedHead(root))
      ? await loadState(refSource(root, 'HEAD'), diagnostics)
      : null;
    const after = await loadState(indexSource(root), diagnostics);
    return { before, after, mode, diagnostics: dedupeDiagnostics(diagnostics) };
  }

  if (!SAFE_REF.test(mode.ref)) {
    throw new DepGuardError(`base ref "${mode.ref}" is not a usable git ref`, 'git-error');
  }
  const before = await loadState(refSource(root, mode.ref), diagnostics);
  const after = await loadState(await createWorkingTreeSource(root, diagnostics), diagnostics);
  return { before, after, mode, diagnostics: dedupeDiagnostics(diagnostics) };
}
