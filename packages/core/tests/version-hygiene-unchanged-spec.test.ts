import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hygieneCheck } from '../src/checks/hygiene.js';
import type { CheckContext, ResolvedConfig } from '../src/checks/types.js';
import type { Corpus } from '../src/corpus.js';
import { computeDelta } from '../src/delta.js';
import type { ManifestDep, ParsedManifest } from '../src/manifest.js';
import type { RepoState } from '../src/state.js';
import { scan } from '../src/scan.js';

// A wildcard whose text does not move still blocks when the lockfile
// resolution does. The sentence has to say which of those two things happened.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CORPUS = path.join(__dirname, '..', 'fixtures', 'corpus');
const execFileAsync = promisify(execFile);

let tempDirs: string[] = [];
let repo = '';

async function git(...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: repo });
}

function manifest(specifier: string): string {
  return JSON.stringify({ name: 'root', version: '1.0.0', dependencies: { lodash: specifier } });
}

function lock(
  version: string,
  specifier: string,
  overrides: { resolved?: string; integrity?: string; hasInstallScript?: boolean } = {}
): string {
  const entry: Record<string, unknown> = {
    version,
    resolved: overrides.resolved ?? `https://registry.npmjs.org/lodash/-/lodash-${version}.tgz`,
    integrity: overrides.integrity ?? `sha512-${version}`,
  };
  if (overrides.hasInstallScript === true) {
    entry.hasInstallScript = true;
  }
  return JSON.stringify({
    name: 'root',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'root', version: '1.0.0', dependencies: { lodash: specifier } },
      'node_modules/lodash': entry,
    },
  });
}

const BASE_SENTENCE = '"lodash" is specified as "*", which pins no version at all.';

function heldSentence(manifestPath: string, clause: string): string {
  return `${BASE_SENTENCE} The spec in ${manifestPath} did not change; ${clause}.`;
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-hygiene-spec-'));
  tempDirs.push(repo);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'dep guard test');
  await git('config', 'commit.gpgsign', 'false');
});

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  repo = '';
});

async function commit(relPath: string, content: string, message: string): Promise<void> {
  await writeFile(path.join(repo, relPath), content, 'utf8');
  await git('add', '-A');
  await git('commit', '-q', '-m', message);
}

test('an unchanged wildcard names the lockfile resolution that moved', async () => {
  await commit('package.json', manifest('*'), 'base');
  await commit('package-lock.json', lock('1.0.0', '*'), 'lock base');
  await commit('package-lock.json', lock('1.0.1', '*'), 'lock head');

  const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'HEAD~1' }, corpusDir: FIXTURE_CORPUS });
  const finding = result.findings.find((item) => item.ruleId === 'version-hygiene' && item.packageName === 'lodash');

  expect(result.exitCode).toBe(1);
  expect(finding?.message).toBe(
    '"lodash" is specified as "*", which pins no version at all. ' +
      'The spec in package.json did not change; package-lock.json resolved it from 1.0.0 to 1.0.1.'
  );
});

test('a spec rewritten to a wildcard keeps the original sentence through a real scan', async () => {
  await writeFile(path.join(repo, 'package.json'), manifest('1.0.0'), 'utf8');
  await writeFile(path.join(repo, 'package-lock.json'), lock('1.0.0', '1.0.0'), 'utf8');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'base');
  await writeFile(path.join(repo, 'package.json'), manifest('*'), 'utf8');
  await writeFile(path.join(repo, 'package-lock.json'), lock('1.0.1', '*'), 'utf8');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'head');

  const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'HEAD~1' }, corpusDir: FIXTURE_CORPUS });
  const finding = result.findings.find((item) => item.ruleId === 'version-hygiene' && item.packageName === 'lodash');

  expect(finding?.message).toBe('"lodash" is specified as "*", which pins no version at all.');
});

test('an unchanged wildcard whose resolved URL is the only lockfile difference names the URL', async () => {
  const same = { integrity: 'sha512-same' };
  await commit('package.json', manifest('*'), 'base');
  await commit('package-lock.json', lock('1.0.0', '*', same), 'lock base');
  await commit(
    'package-lock.json',
    lock('1.0.0', '*', { ...same, resolved: 'https://registry.example/lodash/-/lodash-1.0.0.tgz' }),
    'lock head'
  );

  const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'HEAD~1' }, corpusDir: FIXTURE_CORPUS });
  const finding = result.findings.find((item) => item.ruleId === 'version-hygiene' && item.packageName === 'lodash');

  expect(result.exitCode).toBe(1);
  expect(finding?.details).toMatchObject({ kind: 'changed', specifier: '*' });
  expect(finding?.message).toBe(heldSentence('package.json', 'package-lock.json resolved it to a different URL'));
});

test('an unchanged wildcard whose install-script flag is the only lockfile difference names the flag', async () => {
  await commit('package.json', manifest('*'), 'base');
  await commit('package-lock.json', lock('1.0.0', '*'), 'lock base');
  await commit('package-lock.json', lock('1.0.0', '*', { hasInstallScript: true }), 'lock head');

  const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'HEAD~1' }, corpusDir: FIXTURE_CORPUS });
  const finding = result.findings.find((item) => item.ruleId === 'version-hygiene' && item.packageName === 'lodash');

  expect(result.exitCode).toBe(1);
  expect(finding?.details).toMatchObject({ kind: 'changed', specifier: '*' });
  expect(finding?.message).toBe(heldSentence('package.json', 'package-lock.json turned the install-script flag on'));
});

function workspaceRoot(workspaces: string[] | undefined): string {
  const doc: Record<string, unknown> = { name: 'root', version: '1.0.0' };
  if (workspaces !== undefined) {
    doc.workspaces = workspaces;
  }
  return JSON.stringify(doc);
}

test('a wildcard whose manifest became a project with identical lock entries keeps the original sentence', async () => {
  await mkdir(path.join(repo, 'fixtures', 'demo'), { recursive: true });
  await commit('package.json', workspaceRoot(undefined), 'base root');
  await commit(
    'fixtures/demo/package.json',
    JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { lodash: '*' } }),
    'base nested'
  );
  await commit('package-lock.json', lock('1.0.0', '*'), 'base lock');
  await commit('package.json', workspaceRoot(['fixtures/demo']), 'head workspace');

  const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'HEAD~1' }, corpusDir: FIXTURE_CORPUS });
  const finding = result.findings.find((item) => item.ruleId === 'version-hygiene' && item.packageName === 'lodash');

  expect(result.exitCode).toBe(1);
  expect(finding?.details).toMatchObject({ kind: 'added', specifier: '*', depType: 'dependencies' });
  expect(finding?.manifestPath).toBe('fixtures/demo/package.json');
  expect(finding?.message).toBe(BASE_SENTENCE);
});

test('a wildcard whose manifest became a project keeps the original sentence when the selected version also moved', async () => {
  await mkdir(path.join(repo, 'fixtures', 'demo'), { recursive: true });
  await commit('package.json', workspaceRoot(undefined), 'base root');
  await commit(
    'fixtures/demo/package.json',
    JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { lodash: '*' } }),
    'base nested'
  );
  await commit('package-lock.json', lock('1.0.0', '*'), 'base lock');
  await commit('package.json', workspaceRoot(['fixtures/demo']), 'head workspace');
  await commit('package-lock.json', lock('1.0.1', '*'), 'head lock');

  const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'HEAD~2' }, corpusDir: FIXTURE_CORPUS });
  const finding = result.findings.find((item) => item.ruleId === 'version-hygiene' && item.packageName === 'lodash');

  expect(result.exitCode).toBe(1);
  expect(finding?.details).toMatchObject({ kind: 'added', specifier: '*' });
  expect(finding?.message).toBe(BASE_SENTENCE);
});

const STUB_CORPUS: Corpus = {
  hasName: () => false,
  topRank: () => null,
  aliasTargets: () => [],
  topNames: [],
  builtAt: 'test',
};

const STUB_CONFIG: ResolvedConfig = {
  failOn: 'medium',
  allow: [],
  internalScopes: [],
  internalPrefixes: [],
  extraAliases: {},
  ignorePaths: [],
  online: false,
  minAgeDays: 7,
  minAgeAllow: [],
};

function handState(manifests: ParsedManifest[]): RepoState {
  return {
    manifests,
    lockfile: null,
    onlyBuilt: [],
    npmrcRegistryPins: new Map<string, string>(),
    npmrcDefaultRegistry: null,
    workspaceLocalNames: new Set(),
  };
}

function handManifest(deps: ManifestDep[]): ParsedManifest {
  return { path: 'pyproject.toml', deps, pnpmOnlyBuilt: [] };
}

test('a python git spec with equal text and different pin provenance is not a version-hygiene finding', () => {
  const specifier = 'git+https://example.com/demo.git#main';
  const beforeDep: ManifestDep = {
    name: 'demo',
    registryName: 'demo',
    specifier,
    depType: 'dependencies',
    protocol: 'git',
    gitTable: { rev: null },
  };
  const afterDep: ManifestDep = {
    ...beforeDep,
    gitTable: { rev: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  };
  const delta = computeDelta(handState([handManifest([beforeDep])]), handState([handManifest([afterDep])]));
  const context: CheckContext = {
    corpus: STUB_CORPUS,
    config: STUB_CONFIG,
    delta,
    npmrcRegistryPins: new Map<string, string>(),
    diagnostics: [],
    allowed: [],
  };

  expect(delta.changes).toHaveLength(1);
  expect(delta.changes[0].previousSpecifier).toBe(specifier);
  expect(delta.changes[0].specifier).toBe(specifier);
  expect(delta.changes[0].kind).toBe('changed');
  expect(delta.changes[0].specifierHeld).toBeUndefined();
  expect(hygieneCheck(context)).toEqual([]);
});
