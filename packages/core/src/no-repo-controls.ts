/** Security gates for `scan --no-repo-controls`. */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BASELINE_FILE } from './baseline.js';
import { CONFIG_FILE, LOCAL_CONFIG_FILE } from './config.js';
import { cleanNoRepoControlsGitEnv } from './git-env.js';
import { DepGuardError } from './types.js';
import { parseNpmrcPins, type RepoState } from './state.js';
import { isInsideDir, resolveGitBinary } from './utils/git-binary.js';
import { checkLocalGitConfig, localGitConfigRefusal } from './utils/local-git-config.js';
import { readVerifiedHeadTree, type VerifiedEntry } from './utils/verified-head-tree.js';
import { objectInfo, readVerifiedBlobsBounded } from './utils/verified-objects.js';

const CLONE_FRESH = 'Clone the repository fresh and assess the clone.';

const TOOL_PREFIX = 'dep-guard: ';

// The CLI prints every DepGuardError as "dep-guard: <message> (<code>)", so
// a refusal carries no prefix of its own. Messages built by the shared git
// and object-store helpers start with one; it is removed here, once, for
// every refusal this mode raises.
function withoutToolPrefix(message: string): string {
  let text = message;
  while (text.startsWith(TOOL_PREFIX)) text = text.slice(TOOL_PREFIX.length);
  return text;
}

export class NoRepoControlsError extends DepGuardError {
  constructor(message: string) {
    super(withoutToolPrefix(message), 'no-repo-controls-refused');
    this.name = 'NoRepoControlsError';
  }
}

export interface PreparedNoRepoControlsRepository {
  repoRoot: string;
  git: string;
  head: string;
}

export interface NotScannedEntry {
  path: string;
  reason: string;
  kind: 'submodule' | 'built-in-skip' | 'too-large' | 'unsupported' | 'declined' | 'unparseable';
  line?: number;
}

export interface HeadOnlyRepository extends PreparedNoRepoControlsRepository {
  entries: readonly VerifiedEntry[];
  repoControls: { honoured: false; present: string[] };
  notScanned: NotScannedEntry[];
  excludedPaths: ReadonlySet<string>;
  // The committed .npmrc's scope pins, read as data for
  // dependency-confusion rule 1 only (checks/confusion.ts); never a control.
  npmrcRegistryPins: ReadonlyMap<string, string>;
  objectSizes: ReadonlyMap<string, number>;
  inputBytesLimit: number;
  oversizedBytesLimit: number;
  totalInputBytesLimit: number;
  retainedBytesBeforeSource: number;
  oversizedBytesBeforeSource: number;
}

function compareNotScanned(left: NotScannedEntry, right: NotScannedEntry): number {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  const leftLine = left.line ?? -1;
  const rightLine = right.line ?? -1;
  if (leftLine !== rightLine) return leftLine - rightLine;
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  return left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0;
}

export function recordHeadOnlyNotScanned(
  repository: HeadOnlyRepository,
  entry: Omit<NotScannedEntry, 'kind'> & { kind?: 'declined' | 'too-large' }
): void {
  const row: NotScannedEntry = { ...entry, kind: entry.kind ?? 'declined' };
  const key = JSON.stringify([row.path, row.line ?? null, row.kind, row.reason]);
  const exists = repository.notScanned.some(
    (current) =>
      JSON.stringify([current.path, current.line ?? null, current.kind, current.reason]) === key
  );
  if (!exists) repository.notScanned.push(row);
  repository.notScanned.sort(compareNotScanned);
}

const CONTROL_NAMES = new Set(
  [
    CONFIG_FILE,
    LOCAL_CONFIG_FILE,
    BASELINE_FILE,
    '.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    'pnpm-workspace.yaml',
    'pyproject.toml',
    'uv.toml',
    'Pipfile',
  ].map((name) => name.toLowerCase())
);
export const MAX_DEPENDENCY_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_OVERSIZED_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_TOTAL_DEPENDENCY_INPUT_BYTES = 512 * 1024 * 1024;
const LOCKFILE_NAMES = new Set([
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);
const CANONICAL_INPUT_NAMES: ReadonlyMap<string, string> = new Map(
  [
    'package.json',
    ...LOCKFILE_NAMES,
    'pyproject.toml',
    'uv.toml',
    'Pipfile',
    'requirements.in',
    'poetry.lock',
    'uv.lock',
    'pdm.lock',
    'Pipfile.lock',
  ].map((name) => [name.toLowerCase(), name])
);
const SKIPPED_DIR_NAMES = new Set([
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  'vendor',
  'vendored',
  '.git',
]);

function baseName(relative: string): string {
  const slash = relative.lastIndexOf('/');
  return slash === -1 ? relative : relative.slice(slash + 1);
}

export function canonicalDependencyInputPath(relative: string): string | null {
  const name = baseName(relative);
  const lower = name.toLowerCase();
  const slash = relative.lastIndexOf('/');
  const parent = slash === -1 ? '' : baseName(relative.slice(0, slash)).toLowerCase();
  let canonical = CANONICAL_INPUT_NAMES.get(lower) ?? null;
  let dir = relative.slice(0, relative.length - name.length);
  if (canonical === null && lower.endsWith('.txt')) {
    if (lower.startsWith('requirements') || lower.endsWith('requirements.txt')) {
      canonical = lower;
    } else if (parent === 'requirements') {
      // Matched only by its directory: that directory's own spelling is
      // part of what makes it an input, so it is canonical too.
      canonical = lower;
      dir = `${dir.slice(0, dir.length - 'requirements/'.length)}requirements/`;
    }
  }
  if (canonical === null) return null;
  return dir + canonical;
}

// Dependency files of ecosystems this tool does not parse. Under
// --no-repo-controls each one is listed in notScanned, so a repository
// whose dependencies live only in them is not reported as clean by
// omission. Matched case-insensitively, like the inputs above.
const UNSUPPORTED_INPUTS: ReadonlyMap<string, string> = new Map([
  ['go.mod', 'Go'],
  ['go.sum', 'Go'],
  ['setup.py', 'Python setuptools'],
  ['setup.cfg', 'Python setuptools'],
  ['environment.yml', 'Conda'],
  ['environment.yaml', 'Conda'],
  ['cargo.toml', 'Rust'],
  ['cargo.lock', 'Rust'],
  ['gemfile', 'Ruby'],
  ['gemfile.lock', 'Ruby'],
  ['composer.json', 'PHP'],
  ['composer.lock', 'PHP'],
  ['pom.xml', 'Maven'],
  ['build.gradle', 'Gradle'],
  ['build.gradle.kts', 'Gradle'],
  ['gradle.lockfile', 'Gradle'],
  ['packages.config', 'NuGet'],
  ['packages.lock.json', 'NuGet'],
  ['directory.packages.props', 'NuGet'],
  ['package.swift', 'Swift'],
  ['package.resolved', 'Swift'],
  ['pubspec.yaml', 'Dart'],
  ['pubspec.lock', 'Dart'],
  ['mix.exs', 'Elixir'],
  ['mix.lock', 'Elixir'],
  ['deno.json', 'Deno'],
  ['deno.lock', 'Deno'],
]);

export function unsupportedDependencyEcosystem(relative: string): string | null {
  return UNSUPPORTED_INPUTS.get(baseName(relative).toLowerCase()) ?? null;
}

function dependencyInput(relative: string): boolean {
  return canonicalDependencyInputPath(relative) !== null;
}

function skippedSegment(relative: string): string | null {
  return relative.split('/').find((segment) => SKIPPED_DIR_NAMES.has(segment)) ?? null;
}

function git(
  gitBin: string,
  cwd: string,
  args: string[]
): { ok: true; out: string } | { ok: false; detail: string } {
  const result = spawnSync(gitBin, ['-c', 'core.quotePath=false', ...args], {
    cwd,
    env: cleanNoRepoControlsGitEnv(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error === undefined && result.status === 0) {
    return { ok: true, out: result.stdout };
  }
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
  return {
    ok: false,
    detail:
      stderr.length > 0
        ? stderr
        : String(result.error ?? `git exited with status ${String(result.status)}`),
  };
}

function realOrSelf(candidate: string): string {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return candidate;
  }
}

function lstatOrCode(candidate: string): fs.Stats | string {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code ?? 'error';
  }
}

function gitInsideRepo(gitBin: string, dir: string): NoRepoControlsError {
  return new NoRepoControlsError(
    `dep-guard: refusing to run: the git found on PATH (${gitBin}) is inside ${dir}, the directory being ` +
      'assessed, so running it would run code the repository supplies. Put git on PATH from outside the ' +
      'repository. Nothing was scanned.'
  );
}

function assertNotNested(repoRoot: string): void {
  let dir = path.dirname(repoRoot);
  for (;;) {
    const stat = lstatOrCode(path.join(dir, '.git'));
    if (typeof stat === 'string' ? stat !== 'ENOENT' && stat !== 'ENOTDIR' : true) {
      throw new NoRepoControlsError(
        `dep-guard: refusing to run: ${repoRoot} sits inside another git work tree (${dir} has a .git ` +
          `${typeof stat === 'string' ? `that cannot be examined (${stat})` : 'entry'}), so which repository is being ` +
          `assessed is ambiguous. ${CLONE_FRESH} Place it outside any repository. Nothing was scanned.`
      );
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function notOwnStore(what: string): NoRepoControlsError {
  return new NoRepoControlsError(
    `dep-guard: refusing to run: ${what}, so git may read this repository's objects or config from ` +
      `somewhere a fresh plain clone does not. ${CLONE_FRESH} Nothing was scanned.`
  );
}

function shown(candidate: string): string {
  return candidate.length <= 200
    ? candidate
    : `${candidate.slice(0, 200)}... (${candidate.length} characters)`;
}

function assertNoLinkIn(dir: string, label: string): void {
  const top = lstatOrCode(dir);
  if (typeof top === 'string') throw notOwnStore(`${label} cannot be examined (${top})`);
  if (!top.isDirectory()) throw notOwnStore(`${label} is not a real directory (a link or a file)`);
  const stack: Array<{ abs: string; rel: string }> = [{ abs: dir, rel: label }];
  while (stack.length > 0) {
    const { abs, rel } = stack.pop() as { abs: string; rel: string };
    let names: string[];
    try {
      names = fs.readdirSync(abs);
    } catch (error) {
      throw notOwnStore(
        `${shown(rel)} cannot be read (${(error as NodeJS.ErrnoException | undefined)?.code ?? 'error'})`
      );
    }
    for (const name of names) {
      const childAbs = path.join(abs, name);
      const childRel = `${rel}/${name}`;
      const child = lstatOrCode(childAbs);
      if (typeof child === 'string') {
        throw notOwnStore(`${shown(childRel)} cannot be examined (${child})`);
      }
      if (child.isDirectory()) stack.push({ abs: childAbs, rel: childRel });
      else if (!child.isFile()) {
        throw notOwnStore(`${shown(childRel)} is a link or a special file, not a regular file`);
      }
    }
  }
}

function assertOwnObjectStore(repoRoot: string, gitBin: string): void {
  const dotGit = path.join(repoRoot, '.git');
  const stat = lstatOrCode(dotGit);
  if (typeof stat === 'string') {
    throw notOwnStore(`.git at the repository root cannot be examined (${stat})`);
  }
  if (!stat.isDirectory()) {
    throw notOwnStore(
      '.git at the repository root is a file or a link, not a directory (a worktree, a submodule, or a pointer)'
    );
  }
  const commondir = lstatOrCode(path.join(dotGit, 'commondir'));
  if (commondir !== 'ENOENT') {
    throw notOwnStore(
      '.git/commondir exists (or cannot be examined): it points git at another git directory'
    );
  }
  for (const name of ['alternates', 'http-alternates']) {
    const relative = `.git/objects/info/${name}`;
    if (lstatOrCode(path.join(repoRoot, relative)) !== 'ENOENT') {
      throw notOwnStore(
        `${relative} exists (or cannot be examined): git would read objects from another object store`
      );
    }
  }
  const objects = path.join(dotGit, 'objects');
  assertNoLinkIn(objects, '.git/objects');

  const common = git(gitBin, repoRoot, ['rev-parse', '--git-common-dir']);
  const objectPath = git(gitBin, repoRoot, ['rev-parse', '--git-path', 'objects']);
  if (!common.ok || !objectPath.ok) {
    throw notOwnStore(
      `git could not name its git directory (${!common.ok ? common.detail : !objectPath.ok ? objectPath.detail : ''})`
    );
  }
  if (realOrSelf(path.resolve(repoRoot, common.out.trim())) !== realOrSelf(dotGit)) {
    throw notOwnStore("git's common git directory is not .git at the repository root");
  }
  if (realOrSelf(path.resolve(repoRoot, objectPath.out.trim())) !== realOrSelf(objects)) {
    throw notOwnStore("git's object directory is not .git/objects at the repository root");
  }
}

/**
 * Resolve and vet the repository before any object is read. The local config
 * query is the first git process started by this function.
 */
export function prepareNoRepoControlsRepository(
  startDir: string,
  workingDirectory?: string
): PreparedNoRepoControlsRepository {
  let gitBin: string;
  try {
    gitBin = resolveGitBinary();
  } catch (error) {
    throw new NoRepoControlsError(error instanceof Error ? error.message : String(error));
  }
  const realGit = realOrSelf(gitBin);
  // The CLI passes process.cwd() as workingDirectory: the directory the
  // operator runs from must itself be the repository root, and the path
  // argument only has to name that root or a directory inside it. A
  // library caller that passes no working directory names the root itself.
  const here = realOrSelf(workingDirectory ?? startDir);
  const hereLabel = workingDirectory === undefined ? 'the directory given' : 'the current directory';
  if (workingDirectory !== undefined) {
    const target = realOrSelf(path.resolve(workingDirectory, startDir));
    if (!isInsideDir(target, here)) {
      throw new NoRepoControlsError(
        `--no-repo-controls assesses the repository at the current directory (${here}), and the path ` +
          `argument ${target} is outside the repository there. Pass the repository root or a ` +
          'directory inside it, from the root. Nothing was scanned.'
      );
    }
  }
  if (isInsideDir(realGit, here)) throw gitInsideRepo(gitBin, here);

  const config = checkLocalGitConfig(here, cleanNoRepoControlsGitEnv(), gitBin);
  if (!config.ok) {
    // git could not read a local config at all: say plainly when that is
    // because the directory is not in a repository, rather than leave the
    // operator with git's own wording.
    if (config.reason === 'git' && typeof lstatOrCode(path.join(here, '.git')) === 'string') {
      throw new NoRepoControlsError(
        `--no-repo-controls must run from the root of the repository being assessed: ${hereLabel} ` +
          `(${here}) is not the root of a git repository (${config.detail}). Change to the repository ` +
          'root and run it there. Nothing was scanned.'
      );
    }
    throw new NoRepoControlsError(localGitConfigRefusal(config, 'dep-guard'));
  }

  const top = git(gitBin, here, ['rev-parse', '--show-toplevel']);
  if (!top.ok || top.out.trim() === '') {
    throw new NoRepoControlsError(
      `dep-guard: --no-repo-controls needs a git work tree: ${
        top.ok ? 'git printed no toplevel' : top.detail
      }. ${CLONE_FRESH} Nothing was scanned.`
    );
  }
  const repoRoot = realOrSelf(top.out.trim());
  if (isInsideDir(realGit, repoRoot)) throw gitInsideRepo(gitBin, repoRoot);
  if (path.relative(here, repoRoot) !== '') {
    throw new NoRepoControlsError(
      `--no-repo-controls must run from the root of the repository being assessed: ${hereLabel} ` +
        `is ${here}, but the top level git reports for it is ${repoRoot}. Run it from the root. ` +
        'Nothing was scanned.'
    );
  }

  assertNotNested(repoRoot);
  assertOwnObjectStore(repoRoot, gitBin);

  const head = git(gitBin, repoRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    'HEAD^{commit}',
  ]);
  if (!head.ok || head.out.trim() === '') {
    throw new NoRepoControlsError(
      'dep-guard: --no-repo-controls judges the tree as at HEAD, and HEAD does not resolve to a ' +
        `commit here. ${CLONE_FRESH} Nothing was scanned.`
    );
  }
  return { repoRoot, git: gitBin, head: head.out.trim() };
}

export async function loadHeadOnlyRepository(
  startDir: string,
  limits: { inputBytes?: number; oversizedBytes?: number; totalInputBytes?: number } = {},
  workingDirectory?: string
): Promise<HeadOnlyRepository> {
  const prepared = prepareNoRepoControlsRepository(startDir, workingDirectory);
  let entries: VerifiedEntry[];
  try {
    entries = readVerifiedHeadTree(prepared.repoRoot, prepared.head, prepared.git);
  } catch (error) {
    throw new NoRepoControlsError(error instanceof Error ? error.message : String(error));
  }
  const inputSpellings = new Map<string, string[]>();
  for (const entry of entries) {
    const canonical = canonicalDependencyInputPath(entry.path);
    if (canonical === null) continue;
    inputSpellings.set(canonical, [...(inputSpellings.get(canonical) ?? []), entry.path]);
  }
  for (const paths of inputSpellings.values()) {
    if (paths.length < 2) continue;
    const names = [...paths].sort().map((entry) => `"${entry}"`).join(', ');
    throw new NoRepoControlsError(
      `dep-guard: refusing to run: committed dependency inputs collide when names are compared ` +
        `case-insensitively: ${names}. Keep only one spelling. Nothing was scanned.`
    );
  }
  entries = entries.map((entry) => {
    const canonical = canonicalDependencyInputPath(entry.path);
    return canonical === null ? entry : { ...entry, path: canonical };
  });
  const present: string[] = [];
  const notScanned: NotScannedEntry[] = [];
  const excludedPaths = new Set<string>();
  const inputLimit = limits.inputBytes ?? MAX_DEPENDENCY_INPUT_BYTES;
  const oversizedLimit = limits.oversizedBytes ?? MAX_OVERSIZED_INPUT_BYTES;
  const totalInputLimit = limits.totalInputBytes ?? MAX_TOTAL_DEPENDENCY_INPUT_BYTES;
  const inputEntries = entries.filter(
    (entry) => entry.type === 'blob' && dependencyInput(entry.path)
  );
  const npmrcEntry = entries.find((entry) => entry.type === 'blob' && entry.path === '.npmrc');
  const sizedEntries = npmrcEntry === undefined ? inputEntries : [...inputEntries, npmrcEntry];
  const sizes = objectInfo(
    prepared.repoRoot,
    entries.filter((entry) => entry.type !== 'commit').map((entry) => entry.oid),
    prepared.git
  );
  const retainedInputBytes = sizedEntries.reduce((total, entry) => {
    const size = sizes.get(entry.oid)?.size ?? 0;
    return size <= inputLimit ? total + size : total;
  }, 0);
  if (retainedInputBytes > totalInputLimit) {
    throw new NoRepoControlsError(
      `dep-guard: refusing to run: committed dependency inputs need ${retainedInputBytes} bytes, ` +
        `over the ${totalInputLimit} byte total retained-input budget. Reduce the committed dependency ` +
        'inputs or assess them separately. Nothing was scanned.'
    );
  }
  const oversizedEntries = inputEntries.filter(
    (entry) => (sizes.get(entry.oid)?.size ?? 0) > inputLimit
  );
  const oversizedBytesBeforeSource = oversizedEntries.reduce(
    (total, entry) => total + (sizes.get(entry.oid)?.size ?? 0),
    0
  );
  if (oversizedEntries.length > 0) {
    await readVerifiedBlobsBounded(
      prepared.repoRoot,
      oversizedEntries.map((entry) => entry.oid),
      prepared.git,
      0,
      oversizedLimit
    );
    for (const entry of oversizedEntries) {
      excludedPaths.add(entry.path);
      notScanned.push({
        path: entry.path,
        kind: 'too-large',
        reason: `dependency input is ${sizes.get(entry.oid)?.size ?? 0} bytes, over the ${inputLimit} byte parse limit`,
      });
    }
  }
  let npmrcContent: string | null = null;
  if (npmrcEntry !== undefined) {
    const npmrcSize = sizes.get(npmrcEntry.oid)?.size ?? 0;
    if (npmrcSize > inputLimit) {
      await readVerifiedBlobsBounded(
        prepared.repoRoot,
        [npmrcEntry.oid],
        prepared.git,
        0,
        oversizedLimit
      );
      notScanned.push({
        path: npmrcEntry.path,
        kind: 'too-large',
        reason: `dependency-confusion data is ${npmrcSize} bytes, over the ${inputLimit} byte parse limit`,
      });
    } else {
      npmrcContent =
        (await readVerifiedBlobsBounded(
          prepared.repoRoot,
          [npmrcEntry.oid],
          prepared.git,
          inputLimit,
          0,
          totalInputLimit
        )).blobs.get(npmrcEntry.oid)?.toString('utf8') ?? null;
    }
  }
  for (const entry of entries) {
    const name = baseName(entry.path);
    if (CONTROL_NAMES.has(name.toLowerCase())) present.push(entry.path);
    if (entry.type === 'commit') {
      notScanned.push({
        path: entry.path,
        kind: 'submodule',
        reason: 'submodule content is not part of this HEAD tree',
      });
      continue;
    }
    if (entry.type === 'symlink' && dependencyInput(entry.path)) {
      throw new NoRepoControlsError(
        `dep-guard: refusing to run: ${entry.path} is a manifest or lockfile stored as a symlink in HEAD. ` +
          `The link is not followed. Replace it with a regular committed file. Nothing was scanned.`
      );
    }
    const segment =
      dependencyInput(entry.path) && !excludedPaths.has(entry.path)
        ? skippedSegment(entry.path)
        : null;
    if (segment !== null) {
      notScanned.push({
        path: entry.path,
        kind: 'built-in-skip',
        reason: `dependency input under the built-in skipped directory ${segment}`,
      });
    }
    const unsupported = unsupportedDependencyEcosystem(entry.path);
    if (unsupported !== null) {
      notScanned.push({
        path: entry.path,
        kind: 'unsupported',
        reason: `${unsupported} dependency files are detected but not parsed`,
      });
    }
  }
  present.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  notScanned.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    ...prepared,
    entries,
    repoControls: { honoured: false, present },
    notScanned,
    excludedPaths,
    npmrcRegistryPins: parseNpmrcPins(npmrcContent),
    objectSizes: new Map([...sizes].map(([oid, info]) => [oid, info.size])),
    inputBytesLimit: inputLimit,
    oversizedBytesLimit: oversizedLimit,
    totalInputBytesLimit: totalInputLimit,
    retainedBytesBeforeSource:
      npmrcEntry === undefined || npmrcContent === null ? 0 : sizes.get(npmrcEntry.oid)?.size ?? 0,
    oversizedBytesBeforeSource,
  };
}

export function finalizeHeadOnlyNotScanned(
  repository: HeadOnlyRepository,
  state: RepoState
): void {
  const judged = new Set<string>([
    ...state.manifests.map((manifest) => manifest.path),
    ...(state.lockfileInventory ?? [])
      .filter((entry) => entry.read)
      .map((entry) => entry.path),
    ...(state.pythonLockfiles ?? [])
      .filter((lockfile) => lockfile.unreadable === undefined)
      .map((lockfile) => lockfile.path),
  ]);
  repository.notScanned = repository.notScanned.filter(
    (entry) => entry.kind !== 'built-in-skip' || !judged.has(entry.path)
  );

  for (const manifest of state.manifests) {
    const python = manifest.python;
    if (python === undefined) continue;
    for (const exclusion of python.exclusions) {
      repository.notScanned.push({
        path: manifest.path,
        kind: 'declined',
        ...(exclusion.line === undefined ? {} : { line: exclusion.line }),
        reason:
          `Python dependency candidate was not sent to name checks because it was classified as ` +
          exclusion.cls,
      });
    }
  }
  for (const lockfile of state.pythonLockfiles ?? []) {
    if (lockfile.unreadable !== undefined) {
      repository.notScanned.push({
        path: lockfile.path,
        kind: 'unparseable',
        reason: lockfile.unreadable,
      });
    }
  }
  for (const entry of state.lockfileInventory ?? []) {
    const alreadyExplained = repository.notScanned.some(
      (row) =>
        row.path === entry.path &&
        (row.kind === 'unparseable' || row.kind === 'too-large' || row.kind === 'built-in-skip')
    );
    if (!entry.read && !alreadyExplained) {
      repository.notScanned.push({
        path: entry.path,
        kind: 'unsupported',
        reason: 'lockfile format is present but is not parsed for dependency entries',
      });
    } else if (entry.read) {
      repository.notScanned.push({
        path: entry.path,
        kind: 'declined',
        reason: 'whole-HEAD mode has no comparison side; comparison-only lockfile tamper signals were not judged',
      });
    }
  }

  const parentDir = (file: string): string => {
    const slash = file.lastIndexOf('/');
    return slash === -1 ? '' : file.slice(0, slash);
  };
  const covers = (directory: string, file: string): boolean => {
    const manifestDir = parentDir(file);
    return directory === '' || manifestDir === directory || manifestDir.startsWith(`${directory}/`);
  };
  const npmLockDirs = new Set(
    (state.lockfileInventory ?? [])
      .filter((entry) => entry.read)
      .map((entry) => parentDir(entry.path))
  );
  const pythonLockDirs = new Set(
    (state.pythonLockfiles ?? [])
      .filter((entry) => entry.unreadable === undefined)
      .map((entry) => parentDir(entry.path))
  );
  for (const manifest of state.manifests) {
    if (manifest.deps.length === 0) continue;
    const covered = [...(manifest.python === undefined ? npmLockDirs : pythonLockDirs)].some((dir) =>
      covers(dir, manifest.path)
    );
    if (!covered) {
      repository.notScanned.push({
        path: manifest.path,
        kind: 'declined',
        reason: 'manifest has dependencies but no covering supported lockfile; lockfile-only checks were not run',
      });
    }
  }
  const manifestDirs = new Set(state.manifests.map((manifest) => parentDir(manifest.path)));
  for (const entry of state.lockfileInventory ?? []) {
    if (!manifestDirs.has(parentDir(entry.path))) {
      repository.notScanned.push({
        path: entry.path,
        kind: 'declined',
        reason: 'lockfile has no manifest in its directory; its dependency entries were still judged',
      });
    }
  }
  for (const entry of state.pythonLockfiles ?? []) {
    if (!manifestDirs.has(parentDir(entry.path))) {
      repository.notScanned.push({
        path: entry.path,
        kind: 'declined',
        reason: 'Python lockfile has no manifest in its directory; its dependency names were still judged',
      });
    }
  }

  const seen = new Set<string>();
  repository.notScanned = repository.notScanned
    .filter((entry) => {
      const key = JSON.stringify([entry.path, entry.line ?? null, entry.kind, entry.reason]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareNotScanned);
}
