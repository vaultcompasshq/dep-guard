import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { jest } from '@jest/globals';
import { applyPathFilters, checkSingle, scan } from '../src/scan.js';
import type { ProjectClassification } from '../src/state.js';
import type { Finding } from '../src/types.js';

// The deny list (issue 137): a package this repository refuses by name,
// scope or exact version is a critical finding wherever it installs, in every
// mode, and nothing but a reviewed edit to the list clears it.
jest.setTimeout(60_000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CORPUS = path.join(__dirname, '..', 'fixtures', 'corpus');
const execFileAsync = promisify(execFile);
const SHA = '97edff6f525f192a3f83cea1944765f769ae2678';

let repo = '';
let tempDirs: string[] = [];

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repo, encoding: 'utf8' });
  return stdout;
}

async function write(relPath: string, content: string): Promise<void> {
  const full = path.join(repo, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

async function commit(message: string): Promise<void> {
  await git('add', '-A', '-f');
  await git('commit', '-q', '-m', message);
}

interface DenyInput {
  name: string;
  reason?: string;
  versions?: string[];
  reviewBy?: string;
}

function denyConfig(entries: DenyInput[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ deny: entries.map((entry) => ({ reason: 'refused here', ...entry })), ...extra }, null, 2);
}

function pkg(dependencies: Record<string, string> = {}, name = 'app'): string {
  return JSON.stringify({ name, version: '1.0.0', dependencies }, null, 2);
}

function npmLock(packages: Record<string, Record<string, unknown>>, rootDependencies: Record<string, string> = {}): string {
  return JSON.stringify(
    {
      name: 'app',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'app', version: '1.0.0', dependencies: rootDependencies }, ...packages },
    },
    null,
    2
  );
}

function tarball(name: string, version: string, host = 'registry.npmjs.org'): string {
  const basename = name.slice(name.lastIndexOf('/') + 1);
  return `https://${host}/${name}/-/${basename}-${version}.tgz`;
}

function registryEntry(name: string, version = '1.0.0', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version, resolved: tarball(name, version), integrity: `sha512-${name}${version}`, ...extra };
}

function pnpmLock(version: string, packages: string[], importers: string[] = ['  .: {}']): string {
  return [`lockfileVersion: '${version}'`, 'importers:', ...importers, 'packages:', ...packages, ''].join('\n');
}

async function audit(): Promise<Awaited<ReturnType<typeof scan>>> {
  return scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
}

function denied(result: { findings: Finding[] }): Finding[] {
  return result.findings.filter((finding) => finding.ruleId === 'denied-package');
}

async function deniedInAudit(): Promise<Finding[]> {
  await commit('tree');
  return denied(await audit());
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-deny-'));
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

describe('identity: every name an entry carries is matched', () => {
  test('13 key at any depth', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream' }]));
    await write('package.json', pkg({ a: '1.0.0' }));
    await write(
      'package-lock.json',
      npmLock(
        { 'node_modules/a': registryEntry('a'), 'node_modules/a/node_modules/event-stream': registryEntry('event-stream', '3.3.6') },
        { a: '1.0.0' }
      )
    );
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].packageName).toBe('event-stream');
    expect(findings[0].details?.signal).toBe('denied:event-stream');
    expect(findings[0].message).toContain('node_modules/a/node_modules/event-stream');
  });

  test('14 alias name field when the key is the folder', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream' }]));
    await write('package.json', pkg());
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/safe': { version: '3.3.6', name: 'event-stream', integrity: 'sha512-x' } })
    );
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.matchedBy).toEqual(['name-field']);
  });

  test('15 tarball path when key and field both say otherwise', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream' }]));
    await write('package.json', pkg());
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/safe': { version: '3.3.6', name: 'safe', resolved: tarball('event-stream', '3.3.6'), integrity: 'sha512-x' } })
    );
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.matchedBy).toEqual(['tarball']);
  });

  test('16 a partly percent-encoded scoped tarball path', async () => {
    await write('.dep-guard.json', denyConfig([{ name: '@evil/pkg' }]));
    await write('package.json', pkg());
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/safe': { version: '1.0.0', resolved: 'https://registry.npmjs.org/@evil%2fpkg/-/pkg-1.0.0.tgz', integrity: 'sha512-x' },
      })
    );
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.matchedBy).toEqual(['tarball']);
  });

  test('17 a fully percent-encoded tarball name', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream' }]));
    await write('package.json', pkg());
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/safe': {
          version: '3.3.6',
          resolved: 'https://registry.npmjs.org/%65%76%65%6e%74-stream/-/event-stream-3.3.6.tgz',
          integrity: 'sha512-x',
        },
      })
    );
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.matchedBy).toEqual(['tarball']);
  });

  test('18 an alias edge alone does not match (ajv shape)', async () => {
    await write('.dep-guard.json', denyConfig([{ name: '@redocly/ajv' }]));
    await write('package.json', pkg({ foo: '1.0.0' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/ajv': registryEntry('ajv', '6.12.6'),
          'node_modules/foo': registryEntry('foo', '1.0.0', { dependencies: { ajv: 'npm:@redocly/ajv@8.11.0' } }),
        },
        { foo: '1.0.0' }
      )
    );
    expect(await deniedInAudit()).toEqual([]);
  });

  test('19 no resolved: matches the field', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream' }]));
    await write('package.json', pkg());
    await write('package-lock.json', npmLock({ 'node_modules/x': { version: '3.3.6', name: 'event-stream' } }));
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.matchedBy).toEqual(['name-field']);
  });

  test.each([
    ['git', `git+ssh://git@github.com/attacker/thing.git#${SHA}`],
    ['url', 'https://evil.example/thing.tgz'],
    ['file', 'file:vendor/thing.tgz'],
  ])('20 a %s sourced npm entry matches key and field', async (_label, resolved) => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream' }, { name: 'flatmap-stream' }]));
    await write('package.json', pkg());
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/event-stream': { version: '3.3.6', name: 'flatmap-stream', resolved, integrity: 'sha512-x' } })
    );
    const findings = await deniedInAudit();
    expect(findings.map((finding) => finding.details?.signal).sort()).toEqual(['denied:event-stream', 'denied:flatmap-stream']);
  });

  test('21 an npm link entry matches by name', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream' }]));
    await write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', workspaces: ['packages/*'] }));
    await write('packages/es/package.json', pkg({}, 'event-stream'));
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/event-stream': { resolved: 'packages/es', link: true },
        'packages/es': { name: 'event-stream', version: '1.0.0' },
      })
    );
    const findings = await deniedInAudit();
    expect(findings.flatMap((finding) => finding.details?.matchedBy as string[])).toContain('link');
  });

  test('22 an inBundle entry matches', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream' }]));
    await write('package.json', pkg({ a: '1.0.0' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/a': registryEntry('a'),
          'node_modules/a/node_modules/event-stream': { version: '3.3.6', inBundle: true },
        },
        { a: '1.0.0' }
      )
    );
    expect(await deniedInAudit()).toHaveLength(1);
  });

  test.each([
    ['5.4', '  /event-stream/3.3.6:'],
    ['6.0', '  /event-stream@3.3.6:'],
    ['9.0', '  event-stream@3.3.6:'],
  ])('23 pnpm v%s keys match on the registry name', async (version, key) => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream', versions: ['3.3.6'] }]));
    await write('package.json', pkg());
    await write('pnpm-lock.yaml', pnpmLock(version, [key, '    resolution: {integrity: sha512-x}']));
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.signal).toBe('denied:event-stream@3.3.6');
  });

  test('24 a pnpm local file: version matches on its key', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream' }]));
    await write('package.json', pkg());
    await write(
      'pnpm-lock.yaml',
      pnpmLock('9.0', ['  event-stream@file:vendor/es:', '    resolution: {directory: vendor/es, type: directory}'])
    );
    expect(await deniedInAudit()).toHaveLength(1);
  });

  test('25 a pnpm snapshot name differing from the key, no tarball, matches on the snapshot name', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream' }]));
    await write('package.json', pkg());
    await write(
      'pnpm-lock.yaml',
      pnpmLock('6.0', ['  /safe-name@1.0.0:', '    name: event-stream', '    version: 3.3.6', '    resolution: {integrity: sha512-x}'])
    );
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.matchedBy).toEqual(['snapshot-name']);
  });

  test('26 a pnpm pre-v9 git key the parser skips matches on its raw name', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream' }]));
    await write('package.json', pkg());
    await write(
      'pnpm-lock.yaml',
      pnpmLock('6.0', [`  github.com/attacker/event-stream/${SHA}:`, '    resolution: {integrity: sha512-x}'])
    );
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.matchedBy).toEqual(['key-segment']);
  });

  test('26b a pnpm pre-v9 git key the parser carries from its resolution, with no name field, matches on its key segment', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream' }]));
    await write('package.json', pkg());
    await write(
      'pnpm-lock.yaml',
      pnpmLock('6.0', [
        `  gitlab.com/x/event-stream/${SHA}:`,
        `    resolution: {commit: ${SHA}, repo: https://gitlab.com/x/event-stream.git, type: git}`,
      ])
    );
    await commit('tree');
    const result = await audit();
    // Carried, not skipped: no parser note for the entry.
    expect(codes(result)).not.toContain('pnpm-lockfile-invalid-entry');
    const findings = denied(result);
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.matchedBy).toEqual(['key-segment']);
  });

  test('R1 a pnpm relative tarball is resolved against the registry before the deny list reads it', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream', versions: ['3.3.6'] }]));
    await write('package.json', pkg());
    await write(
      'pnpm-lock.yaml',
      pnpmLock('9.0', ['  safe@1.0.0:', '    resolution: {tarball: event-stream/-/event-stream-3.3.6.tgz}'])
    );
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.matchedBy).toEqual(['tarball']);
    expect(findings[0].details?.matchedVersions).toEqual([{ version: '3.3.6', from: 'tarball' }]);
    expect(findings[0].details?.source).toEqual({ kind: 'registry', host: 'registry.npmjs.org' });
  });

  test('27 a multi-document pnpm lockfile whose package-manager document holds the banned name', async () => {
    await write('.dep-guard.json', denyConfig([{ name: '@pnpm/exe.darwin-arm64' }]));
    await write('package.json', pkg({ lodash: '^4.17.21' }));
    await write(
      'pnpm-lock.yaml',
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    packageManagerDependencies:',
        '      pnpm:',
        '        specifier: 12.2.1',
        '        version: 12.2.1',
        'packages:',
        "  '@pnpm/exe.darwin-arm64@12.2.1':",
        '    resolution: {integrity: sha512-a}',
        '  pnpm@12.2.1:',
        '    resolution: {integrity: sha512-b}',
        '---',
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      lodash:',
        '        specifier: ^4.17.21',
        '        version: 4.17.21',
        'packages:',
        '  lodash@4.17.21:',
        '    resolution: {integrity: sha512-c}',
        '',
      ].join('\n')
    );
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].lockfilePath).toContain('pnpm-lock.yaml');
  });

  test('28 npm-shrinkwrap.json beside package-lock.json, and a nested lockfile in a subdirectory, each holding the banned name', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream' }]));
    await write('package.json', pkg());
    await write('package-lock.json', npmLock({ 'node_modules/ms': registryEntry('ms', '2.1.3') }));
    await write('npm-shrinkwrap.json', npmLock({ 'node_modules/event-stream': registryEntry('event-stream', '3.3.6') }));
    await write('apps/web/package.json', pkg({}, 'web'));
    await write('apps/web/package-lock.json', npmLock({ 'node_modules/event-stream': registryEntry('event-stream', '3.3.6') }));
    const findings = await deniedInAudit();
    expect(findings.map((finding) => finding.lockfilePath).sort()).toEqual(['apps/web/package-lock.json', 'npm-shrinkwrap.json']);
  });

  test.each([
    ['registry', 'event-stream', '3.3.6'],
    ['alias', 'safe', 'npm:event-stream@3.3.6'],
    ['git', 'event-stream', 'git+https://github.com/attacker/thing.git'],
    ['github shorthand', 'event-stream', 'github:attacker/thing'],
    ['url', 'event-stream', 'https://evil.example/thing.tgz'],
    ['file', 'event-stream', 'file:./vendor/thing'],
  ])('29 manifest alias target and key match for every protocol (%s)', async (_label, name, specifier) => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream' }]));
    await write('package.json', pkg({ [name]: specifier }));
    await write('vendor/thing/package.json', pkg({}, 'thing'));
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].manifestPath).toBe('package.json');
  });

  test('30 a manifest url specifier matches by its tarball name', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream' }]));
    await write('package.json', pkg({ safe: tarball('event-stream', '3.3.6') }));
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.matchedBy).toEqual(['url-tarball']);
  });

  test('31 a scope wildcard, and not a lookalike scope', async () => {
    await write('.dep-guard.json', denyConfig([{ name: '@evil/*' }]));
    await write('package.json', pkg({ '@evil/a': '1.0.0', '@evil-other/a': '1.0.0', evil: '1.0.0' }));
    const findings = await deniedInAudit();
    expect(findings.map((finding) => finding.packageName)).toEqual(['@evil/a']);
  });

  test('32 npm names match case-insensitively', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream' }]));
    await write('package.json', pkg());
    await write('package-lock.json', npmLock({ 'node_modules/Event-Stream': registryEntry('Event-Stream', '3.3.6') }));
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].packageName).toBe('Event-Stream');
  });
});

describe('identity: Python', () => {
  const pyproject = (dependencies: string[]): string =>
    ['[project]', 'name = "app"', 'version = "1.0"', `dependencies = [${dependencies.map((dep) => `"${dep}"`).join(', ')}]`, ''].join('\n');

  test.each([
    ['requirements.txt', 'Evil_Pkg==1.0\n'],
    ['pyproject.toml', pyproject(['evil.pkg>=1'])],
    [
      'poetry.lock',
      ['[[package]]', 'name = "Evil-Pkg"', 'version = "1.0"', 'description = ""', 'optional = false', 'python-versions = "*"', 'files = []', ''].join('\n'),
    ],
    [
      'uv.lock',
      ['version = 1', '', '[[package]]', 'name = "evil-pkg"', 'version = "1.0"', 'source = { registry = "https://pypi.org/simple" }', ''].join('\n'),
    ],
    ['pdm.lock', ['[metadata]', 'lock_version = "4.5.0"', '', '[[package]]', 'name = "evil_pkg"', 'version = "1.0"', ''].join('\n')],
    [
      'Pipfile.lock',
      JSON.stringify({
        _meta: { sources: [{ name: 'pypi', url: 'https://pypi.org/simple', verify_ssl: true }], 'pipfile-spec': 6 },
        default: { 'evil-pkg': { hashes: [], index: 'pypi', version: '==1.0' } },
        develop: {},
      }),
    ],
  ])('33 pypi entries in %s; a bare entry never matches Python', async (file, content) => {
    await write('.dep-guard.json', denyConfig([{ name: 'pypi:Evil-Pkg' }, { name: 'evil-pkg' }]));
    if (file.endsWith('.lock')) {
      await write('pyproject.toml', pyproject([]));
    }
    await write(file, content);
    const findings = await deniedInAudit();
    expect(findings.length).toBeGreaterThan(0);
    expect(new Set(findings.map((finding) => finding.details?.signal))).toEqual(new Set(['denied:pypi:evil-pkg']));
  });

  test('34 a Python git requirement matches by normalised name', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'pypi:evil-pkg' }]));
    await write('requirements.txt', `Evil.Pkg @ git+https://github.com/attacker/thing.git@${SHA}\n`);
    expect(await deniedInAudit()).toHaveLength(1);
  });

  test('35 a Python wheel or sdist URL line matches by its derived distribution name', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'pypi:evil-pkg' }]));
    await write(
      'requirements.txt',
      'safe @ https://files.example/Evil_Pkg-1.0-py3-none-any.whl\nother @ https://files.example/evil.pkg-2.0.tar.gz\n'
    );
    const findings = await deniedInAudit();
    // One finding per entry, package and install root: both lines fold in.
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.matchedBy).toEqual(['archive-name']);
    expect(findings[0].details?.locations).toHaveLength(2);
  });
});

describe('versions', () => {
  test('36 listed versions only, build metadata ignored', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream', versions: ['3.3.6'] }]));
    await write('package.json', pkg());
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/event-stream': { version: '3.3.6+build.7', integrity: 'sha512-x' },
        'node_modules/a/node_modules/event-stream': registryEntry('event-stream', '3.3.5'),
      })
    );
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.matchedVersions).toEqual([{ version: '3.3.6+build.7', from: 'recorded' }]);
  });

  test('37 prerelease only when listed exactly', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream', versions: ['3.3.6'] }, { name: 'ms', versions: ['2.1.3-beta.1'] }]));
    await write('package.json', pkg());
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/event-stream': registryEntry('event-stream', '3.3.6-beta.1'),
        'node_modules/ms': registryEntry('ms', '2.1.3-beta.1'),
      })
    );
    const findings = await deniedInAudit();
    expect(findings.map((finding) => finding.packageName)).toEqual(['ms']);
  });

  test('38 an npm entry recording one version with the tarball of a listed version matches', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream', versions: ['3.3.6'] }]));
    await write('package.json', pkg());
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/event-stream': { version: '3.3.5', resolved: tarball('event-stream', '3.3.6'), integrity: 'sha512-x' } })
    );
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.matchedVersions).toEqual([{ version: '3.3.6', from: 'tarball' }]);
  });

  test.each([['0.7.29'], ['0.7.30']])(
    '39 a pnpm key version differing from the snapshot version: either one listed matches (%s)',
    async (listed) => {
      await write('.dep-guard.json', denyConfig([{ name: 'ua-parser-js', versions: [listed] }]));
      await write('package.json', pkg());
      await write('pnpm-lock.yaml', pnpmLock('9.0', ['  ua-parser-js@0.7.29:', '    version: 0.7.30', '    resolution: {integrity: sha512-x}']));
      expect(await deniedInAudit()).toHaveLength(1);
    }
  );

  test('40 an unreadable version matches a versioned ban and says so', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream', versions: ['3.3.6'] }]));
    await write('package.json', pkg());
    await write('package-lock.json', npmLock({ 'node_modules/event-stream': { integrity: 'sha512-x' } }));
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.versionUnread).toBe(true);
    expect(findings[0].message).toContain('No version could be read');
  });

  test.each([
    ['a non-standard tarball file name', { version: '3.3.5', resolved: 'https://registry.npmjs.org/event-stream/-/download.tgz', integrity: 'sha512-x' }],
    ['a git source', { version: '3.3.5', resolved: `git+https://github.com/attacker/thing.git#${SHA}` }],
    ['a url source', { version: '3.3.5', resolved: 'https://evil.example/event-stream-3.3.5.tgz' }],
    [
      'a registry-shaped tarball on a host the project does not name',
      { version: '3.3.5', resolved: tarball('event-stream', '3.3.5', 'evil.example') },
    ],
    ['a file source', { version: '3.3.5', resolved: 'file:vendor/event-stream-3.3.5.tgz' }],
  ])('40 %s counts as versionUnread under a versioned ban', async (_label, entry) => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream', versions: ['3.3.6'] }]));
    await write('package.json', pkg());
    await write('package-lock.json', npmLock({ 'node_modules/event-stream': entry }));
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.versionUnread).toBe(true);
  });

  test('41 a manifest range under a read lockfile is judged by the lockfile; with none it matches', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream', versions: ['3.3.6'] }]));
    await write('package.json', pkg({ 'event-stream': '^3.3.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/event-stream': registryEntry('event-stream', '3.3.5') }, { 'event-stream': '^3.3.0' }));
    expect(await deniedInAudit()).toEqual([]);

    await git('rm', '-q', 'package-lock.json');
    const findings = await deniedInAudit();
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.versionUnread).toBe(true);
  });

  test('42 check with a versioned entry matches and says no version was given', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream', versions: ['3.3.6'] }]));
    await commit('tree');
    const result = await checkSingle({ repoRoot: repo, name: 'Event-Stream', corpusDir: FIXTURE_CORPUS });
    const findings = denied(result);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('No version was given to check');
    expect(result.exitCode).toBe(1);
  });
});

type ScanResult = Awaited<ReturnType<typeof scan>>;

async function tagBase(): Promise<void> {
  await commit('base');
  await git('tag', 'base');
}

function scanBase(trust = false): Promise<ScanResult> {
  return scan({
    repoRoot: repo,
    mode: { kind: 'base', ref: 'base' },
    corpusDir: FIXTURE_CORPUS,
    ...(trust ? { trustBase: 'base' } : {}),
  });
}

function scanStaged(): Promise<ScanResult> {
  return scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });
}

function codes(result: ScanResult): string[] {
  return result.run.diagnostics.map((diagnostic) => diagnostic.code);
}

function proposals(result: ScanResult): string {
  return (result.trustBase?.proposals ?? []).join('\n');
}

const ES_LOCK = npmLock({ 'node_modules/event-stream': registryEntry('event-stream', '3.3.6') }, { 'event-stream': '3.3.6' });
const MS_LOCK = npmLock({ 'node_modules/ms': registryEntry('ms', '2.1.3') }, { ms: '2.1.3' });
const ES_BAN = [{ name: 'event-stream', reason: 'compromised in 2018' }];

describe('which list a run applies, in each mode', () => {
  test('43 an incumbent the change did not touch blocks a --base run', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await write('package.json', pkg({ 'event-stream': '3.3.6' }));
    await write('package-lock.json', ES_LOCK);
    await tagBase();
    await write('README.md', 'unrelated\n');
    await commit('head');
    for (const trust of [false, true]) {
      const result = await scanBase(trust);
      const findings = denied(result);
      expect(findings).toHaveLength(1);
      expect(findings[0].details?.kind).toBe('present');
      expect(result.exitCode).toBe(1);
    }
  });

  test('44 audit reports present', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await write('package.json', pkg({ 'event-stream': '3.3.6' }));
    await write('package-lock.json', ES_LOCK);
    const findings = await deniedInAudit();
    expect(findings.map((finding) => finding.details?.kind)).toEqual(['present']);
    expect(findings[0].manifestPath).toBe('package.json');
    expect(findings[0].lockfilePath).toBe('package-lock.json');
  });

  test('45 staged judges the index', async () => {
    await write('.dep-guard.json', denyConfig([...ES_BAN, { name: 'flatmap-stream' }]));
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await commit('base');
    await write('package.json', pkg({ ms: '2.1.3', 'event-stream': '3.3.6' }));
    await git('add', 'package.json');
    await write('package.json', pkg({ ms: '2.1.3', 'event-stream': '3.3.6', 'flatmap-stream': '0.1.1' }));
    const findings = denied(await scanStaged());
    expect(findings.map((finding) => [finding.packageName, finding.details?.kind])).toEqual([['event-stream', 'added']]);
  });

  test('46 --trust-base: a head removing the ban still blocks, and the proposal names the lift', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await tagBase();
    await write('.dep-guard.json', denyConfig([]));
    await write('package.json', pkg({ 'event-stream': '3.3.6' }));
    await write('package-lock.json', ES_LOCK);
    await commit('head');
    const result = await scanBase(true);
    expect(denied(result).map((finding) => finding.details?.kind)).toEqual(['added']);
    expect(proposals(result)).toContain('proposed: lift deny event-stream');
  });

  test('47 --trust-base: a head adding a ban does not apply it, and the proposal counts it', async () => {
    await write('package.json', pkg({ 'event-stream': '3.3.6' }));
    await write('package-lock.json', ES_LOCK);
    await tagBase();
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await commit('head');
    const result = await scanBase(true);
    expect(denied(result)).toEqual([]);
    expect(proposals(result)).toContain('1 deny entry added');
  });

  test('48 --trust-base: a head .dep-guard.local.json with an empty deny has no effect and is named as a lift', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await write('package.json', pkg({ 'event-stream': '3.3.6' }));
    await write('package-lock.json', ES_LOCK);
    await tagBase();
    await write('.dep-guard.local.json', JSON.stringify({ deny: [] }));
    await commit('head');
    const result = await scanBase(true);
    expect(denied(result)).toHaveLength(1);
    expect(proposals(result)).toContain('proposed: lift deny event-stream');
  });

  test('49 --base without trust base: a change that removes the ban and adds the package still blocks, with deny-entry-kept-from-comparison-side', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await tagBase();
    await write('.dep-guard.json', denyConfig([{ name: 'event-stream', reason: 'fine now' }].slice(1)));
    await write('package.json', pkg({ 'event-stream': '3.3.6' }));
    await write('package-lock.json', ES_LOCK);
    await commit('head');
    const result = await scanBase();
    const findings = denied(result);
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.reason).toBe('compromised in 2018');
    expect(codes(result)).toContain('deny-entry-kept-from-comparison-side');
    expect(result.exitCode).toBe(1);
  });

  test('49 --base: the comparison side entry wins wholesale over a reworded head entry', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await write('package.json', pkg({ 'event-stream': '3.3.6' }));
    await write('package-lock.json', ES_LOCK);
    await tagBase();
    await write('.dep-guard.json', denyConfig([{ name: 'Event-Stream', reason: 'reworded', reviewBy: '2000-01-01' }]));
    await commit('head');
    const findings = denied(await scanBase());
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.reason).toBe('compromised in 2018');
    expect(findings[0].details?.reviewBy).toBeNull();
  });

  test('50 --staged: HEAD\'s ban stays applied when the working tree drops it', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await commit('base');
    await write('.dep-guard.json', denyConfig([]));
    await write('package.json', pkg({ 'event-stream': '3.3.6' }));
    await write('package-lock.json', ES_LOCK);
    await git('add', '.dep-guard.json', 'package.json', 'package-lock.json');
    const result = await scanStaged();
    expect(denied(result)).toHaveLength(1);
    expect(codes(result)).toContain('deny-entry-kept-from-comparison-side');
  });

  test('51 --base: a ban added in the change applies at once', async () => {
    await write('package.json', pkg({ 'event-stream': '3.3.6' }));
    await write('package-lock.json', ES_LOCK);
    await tagBase();
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await commit('head');
    const result = await scanBase();
    expect(denied(result)).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  test('52 describeConfigChange names a dropped version as a lift and ignores a case-only rename', async () => {
    await write(
      '.dep-guard.json',
      denyConfig([{ name: 'ua-parser-js', versions: ['0.7.29', '0.7.30'] }, { name: 'Event-Stream' }, { name: 'left-pad' }])
    );
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await tagBase();
    await write('.dep-guard.json', denyConfig([{ name: 'ua-parser-js', versions: ['0.7.29'] }, { name: 'event-stream' }]));
    await commit('head');
    const text = proposals(await scanBase(true));
    expect(text).toContain('proposed: lift deny ua-parser-js@0.7.30, left-pad');
    expect(text).not.toMatch(/lift deny[^\n;]*event-stream/i);
  });

  test('R2 --staged: a HEAD config that does not validate is read leniently, with a diagnostic', async () => {
    await write(
      '.dep-guard.json',
      JSON.stringify({ deny: [{ name: 'event-stream', reason: 'compromised in 2018' }, 'flatmap-stream'], failOn: 'bogus' })
    );
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await commit('base');
    await write('.dep-guard.json', denyConfig([]));
    await write('package.json', pkg({ 'event-stream': '3.3.6' }));
    await write('package-lock.json', ES_LOCK);
    await git('add', '.dep-guard.json', 'package.json', 'package-lock.json');
    const result = await scanStaged();
    expect(result.exitCode).toBe(1);
    expect(denied(result)).toHaveLength(1);
    expect(codes(result)).toContain('deny-head-config-invalid');
  });

  test('R2 plain --base: a base config that does not validate is config-invalid, with or without a deny list', async () => {
    await write('.dep-guard.json', JSON.stringify({ failOn: 'bogus' }));
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await tagBase();
    await write('.dep-guard.json', JSON.stringify({}));
    await commit('head');
    await expect(scanBase()).rejects.toMatchObject({ code: 'config-invalid' });
  });

  test.each([
    ['note', undefined, 'fail'],
    [undefined, 'note', 'fail'],
    ['note', 'note', 'note'],
    ['fail', 'note', 'fail'],
  ])('R4 denyUnreadLockfiles takes the stricter side under --base and --staged (base %s, head %s)', async (baseValue, headValue, expected) => {
    const withUnread = (value: string | undefined): Record<string, unknown> => (value === undefined ? {} : { denyUnreadLockfiles: value });
    await write('.dep-guard.json', denyConfig(ES_BAN, withUnread(baseValue)));
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('yarn.lock', '# yarn lockfile v1\n');
    await tagBase();
    await write('.dep-guard.json', denyConfig(ES_BAN, withUnread(headValue)));
    await write('README.md', 'unrelated\n');
    await commit('head');
    const result = await scanBase();
    const couldNotRun = result.run.couldNotRun?.code === 'deny-lockfile-unread';
    expect(couldNotRun).toBe(expected === 'fail');
    await git('reset', '-q', '--soft', 'base');
    const staged = await scanStaged();
    expect(codes(staged)).toContain('deny-lockfile-unread');
  });
});

describe('what can and cannot clear a deny finding', () => {
  test('53 allow and a baseline holding the fingerprint each leave the finding, from base and head', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await write('package.json', pkg({ 'event-stream': '3.3.6' }));
    await write('package-lock.json', ES_LOCK);
    await commit('first');
    const [first] = denied(await audit());
    const cleared = { allow: ['event-stream'] };
    await write('.dep-guard.json', denyConfig(ES_BAN, cleared));
    await write('.dep-guard.baseline.json', JSON.stringify({ version: 1, fingerprints: [first.fingerprint] }));
    await tagBase();
    await write('README.md', 'unrelated\n');
    await commit('head');
    for (const result of [await audit(), await scanBase(), await scanBase(true)]) {
      const findings = denied(result);
      expect(findings.map((finding) => finding.fingerprint)).toEqual([first.fingerprint]);
      expect(result.exitCode).toBe(1);
      expect(codes(result)).toEqual(expect.arrayContaining(['deny-overrides-allow', 'deny-kept-over-baseline']));
    }
  });

  test('54 ignorePaths on a fixture nothing installs on either side drops the finding', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN, { ignorePaths: ['fixtures'] }));
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await tagBase();
    await write('fixtures/case/package-lock.json', ES_LOCK);
    await commit('head');
    for (const result of [await audit(), await scanBase(), await scanBase(true)]) {
      expect(denied(result)).toEqual([]);
      expect(codes(result)).toContain('ignore-path-dropped');
    }
    // The control: without the entry the fixture is judged.
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await commit('no ignore');
    expect(denied(await audit()).map((finding) => finding.lockfilePath)).toEqual(['fixtures/case/package-lock.json']);
  });

  test('55 ignorePaths on a path the change makes a project keeps it', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN, { ignorePaths: ['tools'] }));
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await tagBase();
    await write('tools/package.json', pkg({ 'event-stream': '3.3.6' }, 'tools'));
    await write('tools/package-lock.json', ES_LOCK);
    await commit('head');
    for (const result of [await scanBase(), await scanBase(true)]) {
      const findings = denied(result);
      expect(findings).toHaveLength(1);
      expect(findings[0].ignoreOverride).toEqual({ entries: ['tools'], position: 'a denied package on an installed path' });
      expect(result.exitCode).toBe(1);
    }
  });

  test('56 ignorePaths on a project the base already installs keeps it', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN, { ignorePaths: ['tools'] }));
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await write('tools/package.json', pkg({ 'event-stream': '3.3.6' }, 'tools'));
    await write('tools/package-lock.json', ES_LOCK);
    await tagBase();
    await write('README.md', 'unrelated\n');
    await commit('head');
    for (const result of [await audit(), await scanBase(), await scanBase(true)]) {
      const findings = denied(result);
      expect(findings).toHaveLength(1);
      expect(findings[0].ignoreOverride?.position).toBe('a denied package on an installed path');
      expect(result.exitCode).toBe(1);
    }
  });

  // A nested manifest no rule makes a project, under an ignored directory,
  // that declares a name the root project installs transitively: the entry
  // lives in the root lockfile and the root project installs it, so the
  // fixture can neither take the finding nor drop it.
  const MS_212_BAN = [{ name: 'ms', versions: ['2.1.2'], reason: 'retired version' }];
  const FIXTURE_IGNORE = { ignorePaths: ['test/fixtures/**'] };

  test('56c a pnpm v9 transitive ban stays when an ignored non-project fixture declares the name', async () => {
    await write('.dep-guard.json', denyConfig(MS_212_BAN, FIXTURE_IGNORE));
    await write('package.json', pkg({ debug: '4.3.4' }));
    await write(
      'pnpm-lock.yaml',
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      debug:',
        '        specifier: 4.3.4',
        '        version: 4.3.4',
        'packages:',
        '  debug@4.3.4:',
        '    resolution: {integrity: sha512-debug434}',
        '  ms@2.1.2:',
        '    resolution: {integrity: sha512-ms212}',
        'snapshots:',
        '  debug@4.3.4:',
        '    dependencies:',
        '      ms: 2.1.2',
        '  ms@2.1.2: {}',
        '',
      ].join('\n')
    );
    await tagBase();
    await write('test/fixtures/a/package.json', pkg({ ms: '^2.0.0' }, 'fixture-a'));
    await commit('head');
    for (const [mode, result] of [
      ['audit', await audit()],
      ['base', await scanBase()],
      ['trust', await scanBase(true)],
    ] as const) {
      const findings = denied(result);
      expect({ mode, signals: findings.map((finding) => String(finding.details?.signal)) }).toEqual({
        mode,
        signals: ['denied:ms@2.1.2'],
      });
      expect(findings[0].severity).toBe('critical');
      expect(findings[0].manifestPath).toBe('pnpm-lock.yaml');
    }
  });

  test('56d an npm nested transitive ban stays when an ignored non-project fixture declares the name', async () => {
    await write('.dep-guard.json', denyConfig(MS_212_BAN, FIXTURE_IGNORE));
    await write('package.json', pkg({ debug: '4.3.4' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/debug': registryEntry('debug', '4.3.4', { dependencies: { ms: '2.1.2' } }),
          'node_modules/debug/node_modules/ms': registryEntry('ms', '2.1.2'),
        },
        { debug: '4.3.4' }
      )
    );
    await tagBase();
    await write('test/fixtures/z/package.json', pkg({ ms: '*' }, 'fixture-z'));
    await commit('head');
    for (const [mode, result] of [
      ['audit', await audit()],
      ['base', await scanBase()],
      ['trust', await scanBase(true)],
    ] as const) {
      const findings = denied(result);
      expect({ mode, count: findings.length }).toEqual({ mode, count: 1 });
      expect(findings[0].lockfilePath).toBe('package-lock.json');
      expect(findings[0].manifestPath).toBe('package-lock.json');
    }
  });

  test('56e a Python lockfile entry stays when an ignored requirements file beside it declares the name', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'pypi:evil-pkg' }], { ignorePaths: ['tools/py/requirements.txt'] }));
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await write('tools/py/pyproject.toml', ['[project]', 'name = "tool"', 'version = "1.0"', 'dependencies = []', ''].join('\n'));
    await write(
      'tools/py/uv.lock',
      ['version = 1', '', '[[package]]', 'name = "evil-pkg"', 'version = "1.0"', 'source = { registry = "https://pypi.org/simple" }', ''].join('\n')
    );
    await tagBase();
    await write('tools/py/requirements.txt', 'evil-pkg\n');
    await commit('head');
    for (const [mode, result] of [
      ['audit', await audit()],
      ['base', await scanBase()],
      ['trust', await scanBase(true)],
    ] as const) {
      const findings = denied(result);
      expect({ mode, lockfiles: findings.map((finding) => finding.lockfilePath) }).toEqual({ mode, lockfiles: ['tools/py/uv.lock'] });
    }
  });

  test('56f the filter keeps a deny finding on a non-project anchor when its lockfile has a project beside it', () => {
    const raw: Parameters<typeof applyPathFilters>[0] = [
      {
        ruleId: 'denied-package',
        severity: 'critical',
        packageName: 'ms',
        message: 'denied',
        manifestPath: 'test/fixtures/a/package.json',
        lockfilePath: 'package-lock.json',
      },
    ];
    const rootProject = (): ProjectClassification => ({
      reasons: new Map([['package.json', [{ rule: 'beside-lockfile', root: '', input: 'package-lock.json' }]]]),
      workspaceFields: new Map(),
      unreadInputs: [],
    });
    const none = (): ProjectClassification => ({ reasons: new Map(), workspaceFields: new Map(), unreadInputs: [] });
    const run = (judged: ProjectClassification, reference: ProjectClassification) =>
      applyPathFilters(raw, { ignorePaths: ['test/fixtures/**'] }, new Set(), [], new Set(), {
        judged,
        reference,
        referenceLabel: 'the --base ref "base"',
        prefix: '',
        audit: false,
      });
    // Installed on either side keeps it; on neither it is dropped.
    expect(run(rootProject(), none()).findings.map((finding) => finding.ignoreOverride?.position)).toEqual([
      'a denied package on an installed path',
    ]);
    expect(run(none(), rootProject()).findings).toHaveLength(1);
    expect(run(none(), none()).findings).toEqual([]);
  });

  test('56b ignorePaths on a path only the reference side installs keeps it', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN, { ignorePaths: ['tools'] }));
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await write('tools/package.json', pkg({ 'event-stream': '3.3.6' }, 'tools'));
    await write('tools/package-lock.json', ES_LOCK);
    await tagBase();
    await git('rm', '-q', 'tools/package.json');
    await commit('head');
    for (const result of [await scanBase(), await scanBase(true)]) {
      const findings = denied(result);
      expect(findings).toHaveLength(1);
      expect(findings[0].lockfilePath).toBe('tools/package-lock.json');
      expect(findings[0].ignoreOverride?.position).toBe('a denied package on an installed path');
    }
  });

  test('57 failOn none reports without blocking; failOn critical blocks', async () => {
    await write('package.json', pkg({ 'event-stream': '3.3.6' }));
    await write('package-lock.json', ES_LOCK);
    await write('.dep-guard.json', denyConfig(ES_BAN, { failOn: 'none' }));
    await commit('none');
    const reported = await audit();
    expect(denied(reported)).toHaveLength(1);
    expect(reported.exitCode).toBe(0);
    await write('.dep-guard.json', denyConfig(ES_BAN, { failOn: 'critical' }));
    await commit('critical');
    const blocked = await audit();
    expect(denied(blocked)).toHaveLength(1);
    expect(blocked.exitCode).toBe(1);
  });

  test('58 a passed reviewBy still blocks and raises deny-review-overdue, also with no match', async () => {
    await write(
      '.dep-guard.json',
      denyConfig([
        { name: 'event-stream', reviewBy: '2001-01-01' },
        { name: 'left-pad', reviewBy: '2001-01-01' },
      ])
    );
    await write('package.json', pkg({ 'event-stream': '3.3.6' }));
    await write('package-lock.json', ES_LOCK);
    await commit('tree');
    const result = await audit();
    const findings = denied(result);
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.reviewOverdue).toBe(true);
    expect(findings[0].message).toContain('review date, 2001-01-01, has passed');
    expect(result.exitCode).toBe(1);
    const overdue = result.run.diagnostics.filter((diagnostic) => diagnostic.code === 'deny-review-overdue');
    expect(overdue.map((diagnostic) => diagnostic.message.includes('left-pad'))).toContain(true);
    expect(overdue).toHaveLength(2);
  });

  test('59 check reports a denied name', async () => {
    await write('.dep-guard.json', denyConfig([{ name: '@evil/*' }]));
    await commit('tree');
    const result = await checkSingle({ repoRoot: repo, name: '@evil/thing', corpusDir: FIXTURE_CORPUS });
    expect(denied(result).map((finding) => [finding.packageName, finding.details?.signal])).toEqual([
      ['@evil/thing', 'denied:@evil/*'],
    ]);
    expect(result.exitCode).toBe(1);
    const clean = await checkSingle({ repoRoot: repo, name: 'ms', corpusDir: FIXTURE_CORPUS });
    expect(denied(clean)).toEqual([]);
  });
});

describe('lockfiles the deny list cannot read', () => {
  async function yarnProject(extra: Record<string, unknown> = {}): Promise<void> {
    await write('.dep-guard.json', denyConfig(ES_BAN, extra));
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await tagBase();
    await write('apps/web/package.json', pkg({ 'left-pad': '1.3.0' }, 'web'));
    await write('apps/web/yarn.lock', '# yarn lockfile v1\n');
    await commit('head');
  }

  test('60 --base with a project yarn.lock and a non-empty list exits 2 with deny-lockfile-unread', async () => {
    await yarnProject();
    for (const result of [await scanBase(), await scanBase(true)]) {
      expect(result.exitCode).toBe(2);
      expect(result.run.couldNotRun?.code).toBe('deny-lockfile-unread');
      expect(result.run.couldNotRun?.message).toContain('apps/web/yarn.lock');
    }
  });

  test('61 the same with denyUnreadLockfiles note exits by findings, with the diagnostic', async () => {
    await yarnProject({ denyUnreadLockfiles: 'note' });
    for (const result of [await scanBase(), await scanBase(true)]) {
      expect(result.run.couldNotRun).toBeUndefined();
      expect(result.exitCode).not.toBe(2);
      expect(codes(result)).toContain('deny-lockfile-unread');
    }
  });

  test('62 audit and staged with a project yarn.lock give the diagnostic only', async () => {
    await yarnProject();
    const audited = await audit();
    await git('reset', '-q', '--soft', 'base');
    const staged = await scanStaged();
    for (const result of [audited, staged]) {
      expect(result.run.couldNotRun).toBeUndefined();
      expect(codes(result)).toContain('deny-lockfile-unread');
    }
  });

  test('63 an unread lockfile nothing installs gives lockfile-not-read with the deny sentence only', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await tagBase();
    await write('fixtures/case/yarn.lock', '# yarn lockfile v1\n');
    await commit('head');
    const result = await scanBase(true);
    expect(result.run.couldNotRun).toBeUndefined();
    expect(codes(result)).not.toContain('deny-lockfile-unread');
    const notRead = result.run.diagnostics.filter((diagnostic) => diagnostic.code === 'lockfile-not-read');
    expect(notRead.length).toBeGreaterThan(0);
    expect(notRead.every((diagnostic) => diagnostic.message.includes('the deny list judged manifest names only'))).toBe(true);
  });

  // The axios shape: a smoke-test project with its own bun.lock beside its
  // package.json, which the deny list cannot read.
  const BUN_LOCK = '{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "smoke" } }\n}\n';
  async function smokeBase(acknowledge: boolean, extra: Record<string, unknown> = {}): Promise<string> {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await write('tests/smoke/bun/package.json', pkg({ 'left-pad': '1.3.0' }, 'smoke'));
    await write('tests/smoke/bun/bun.lock', BUN_LOCK);
    const blob = (await git('hash-object', 'tests/smoke/bun/bun.lock')).trim();
    const entry = `tests/smoke/bun/bun.lock:${blob}`;
    await write('.dep-guard.json', denyConfig(ES_BAN, { ...(acknowledge ? { denyUnreadAcknowledged: [entry] } : {}), ...extra }));
    await tagBase();
    return entry;
  }

  test('71 a base acknowledgement of an unread lockfile lets a docs-only change pass; any other unread lockfile still exits 2', async () => {
    await smokeBase(true);
    await write('README.md', 'docs only\n');
    await commit('docs');
    for (const result of [await scanBase(), await scanBase(true)]) {
      expect(result.run.couldNotRun).toBeUndefined();
      expect(result.exitCode).toBe(0);
      const acknowledged = result.run.diagnostics.filter((diagnostic) => diagnostic.code === 'deny-lockfile-acknowledged');
      expect(acknowledged).toHaveLength(1);
      expect(acknowledged[0].message).toContain('tests/smoke/bun/bun.lock');
      expect(codes(result)).not.toContain('deny-lockfile-unread');
    }
    await write('apps/web/package.json', pkg({ 'left-pad': '1.3.0' }, 'web'));
    await write('apps/web/yarn.lock', '# yarn lockfile v1\n');
    await commit('another');
    for (const result of [await scanBase(), await scanBase(true)]) {
      expect(result.exitCode).toBe(2);
      expect(result.run.couldNotRun?.code).toBe('deny-lockfile-unread');
      expect(result.run.couldNotRun?.message).toContain('apps/web/yarn.lock');
      expect(result.run.couldNotRun?.message).not.toContain('tests/smoke/bun/bun.lock');
      expect(codes(result)).toContain('deny-lockfile-acknowledged');
    }
  });

  test('72 without the acknowledgement the same docs-only change exits 2, and the message prints the entry to add', async () => {
    const entry = await smokeBase(false);
    await write('README.md', 'docs only\n');
    await commit('docs');
    for (const result of [await scanBase(), await scanBase(true)]) {
      expect(result.exitCode).toBe(2);
      expect(result.run.couldNotRun?.message).toContain('tests/smoke/bun/bun.lock');
      expect(result.run.couldNotRun?.message).toContain(entry);
    }
  });

  test('73 an acknowledgement covers those bytes only: a changed lockfile exits 2 again', async () => {
    const entry = await smokeBase(true);
    await write('tests/smoke/bun/bun.lock', BUN_LOCK.replace('"smoke"', '"smoke2"'));
    await commit('change the smoke lockfile');
    for (const result of [await scanBase(), await scanBase(true)]) {
      expect(result.exitCode).toBe(2);
      expect(result.run.couldNotRun?.message).toContain('tests/smoke/bun/bun.lock');
      expect(result.run.couldNotRun?.message).not.toContain(entry);
      expect(codes(result)).not.toContain('deny-lockfile-acknowledged');
    }
  });

  test('74 an acknowledgement only the head adds does not count; a --trust-base run names it as proposed', async () => {
    const blobLess = await smokeBase(false);
    await write('.dep-guard.json', denyConfig(ES_BAN, { denyUnreadAcknowledged: [blobLess] }));
    await commit('acknowledge in the head');
    const plain = await scanBase();
    const trusted = await scanBase(true);
    for (const result of [plain, trusted]) {
      expect(result.exitCode).toBe(2);
      expect(result.run.couldNotRun?.code).toBe('deny-lockfile-unread');
    }
    expect(proposals(trusted)).toContain(`proposed: accept unread lockfile ${blobLess}`);
  });

  test('75 --staged reads the acknowledgement from HEAD, never from the index', async () => {
    const entry = await smokeBase(false);
    await write('.dep-guard.json', denyConfig(ES_BAN, { denyUnreadAcknowledged: [entry] }));
    await git('add', '.dep-guard.json');
    const fromIndex = await scanStaged();
    expect(codes(fromIndex)).toContain('deny-lockfile-unread');
    expect(codes(fromIndex)).not.toContain('deny-lockfile-acknowledged');
    await git('commit', '-q', '-m', 'acknowledge');
    await write('README.md', 'docs only\n');
    await git('add', 'README.md');
    const fromHead = await scanStaged();
    expect(codes(fromHead)).toContain('deny-lockfile-acknowledged');
    expect(codes(fromHead)).not.toContain('deny-lockfile-unread');
  });

  // The head tree staged on a HEAD one commit above the base, for a
  // --staged --trust-base run (a pull-request run).
  async function stageAboveBase(): Promise<void> {
    await git('reset', '-q', '--soft', 'base');
    const headTree = (await git('write-tree')).trim();
    await git('read-tree', 'base');
    await write('zz-above-base.txt', 'unrelated\n');
    await git('add', 'zz-above-base.txt');
    await git('commit', '-q', '-m', 'above the base');
    await git('read-tree', headTree);
    await git('add', 'zz-above-base.txt');
  }

  function stagedTrust(): Promise<ScanResult> {
    return scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS, trustBase: 'base' });
  }

  test('77 an acknowledgement breaks when the package.json beside the lockfile changes', async () => {
    await smokeBase(true);
    await write('tests/smoke/bun/package.json', pkg({ 'left-pad': '1.3.0', debug: '^4.3.0' }, 'smoke'));
    await commit('add a dependency beside the acknowledged lockfile');
    const base = await scanBase();
    const trust = await scanBase(true);
    await stageAboveBase();
    const staged = await stagedTrust();
    for (const [mode, result] of [
      ['base', base],
      ['trust', trust],
      ['stagedTrust', staged],
    ] as const) {
      expect({ mode, exitCode: result.exitCode, code: result.run.couldNotRun?.code }).toEqual({
        mode,
        exitCode: 2,
        code: 'deny-lockfile-unread',
      });
      expect(result.run.couldNotRun?.message).toContain('tests/smoke/bun/bun.lock');
      expect(result.run.couldNotRun?.message).toContain('tests/smoke/bun/package.json changed');
      expect(codes(result)).not.toContain('deny-lockfile-acknowledged');
    }
  });

  test('78 an acknowledgement of a root yarn.lock breaks when a workspace member is added', async () => {
    await write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', private: true, workspaces: ['packages/*'] }, null, 2));
    await write('packages/a/package.json', pkg({ 'left-pad': '1.3.0' }, 'a'));
    await write('yarn.lock', '# yarn lockfile v1\n');
    const blob = (await git('hash-object', 'yarn.lock')).trim();
    await write('.dep-guard.json', denyConfig(ES_BAN, { denyUnreadAcknowledged: [`yarn.lock:${blob}`] }));
    await tagBase();
    await write('README.md', 'docs only\n');
    await commit('docs');
    // The control: nothing that installs changed, so the acknowledgement holds.
    for (const result of [await scanBase(), await scanBase(true)]) {
      expect(result.run.couldNotRun).toBeUndefined();
      expect(codes(result)).toContain('deny-lockfile-acknowledged');
    }
    await write('packages/b/package.json', pkg({ debug: '^4.3.0' }, 'b'));
    await commit('add a workspace member');
    const base = await scanBase();
    const trust = await scanBase(true);
    await stageAboveBase();
    const staged = await stagedTrust();
    for (const [mode, result] of [
      ['base', base],
      ['trust', trust],
      ['stagedTrust', staged],
    ] as const) {
      expect({ mode, exitCode: result.exitCode, code: result.run.couldNotRun?.code }).toEqual({
        mode,
        exitCode: 2,
        code: 'deny-lockfile-unread',
      });
      expect(result.run.couldNotRun?.message).toContain('packages/b/package.json added');
    }
  });

  test('79 an acknowledgement holds when only an unrelated file changes, in every pull-request mode', async () => {
    await smokeBase(true);
    await write('src/index.js', 'export {};\n');
    await commit('unrelated');
    const base = await scanBase();
    const trust = await scanBase(true);
    await stageAboveBase();
    const staged = await stagedTrust();
    for (const [mode, result] of [
      ['base', base],
      ['trust', trust],
      ['stagedTrust', staged],
    ] as const) {
      expect({ mode, couldNotRun: result.run.couldNotRun?.code, exitCode: result.exitCode }).toEqual({
        mode,
        couldNotRun: undefined,
        exitCode: 0,
      });
      expect(codes(result)).toContain('deny-lockfile-acknowledged');
    }
  });

  test('64 a non-empty list with nothing read at all exits 0 with deny-nothing-to-judge', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await write('README.md', 'nothing installs here\n');
    await tagBase();
    await write('NOTES.md', 'still nothing\n');
    await commit('head');
    for (const result of [await audit(), await scanBase(), await scanBase(true)]) {
      expect(result.exitCode).toBe(0);
      expect(codes(result)).toContain('deny-nothing-to-judge');
    }
  });

  test('R3 a project with declared dependencies and no read lockfile is deny-lockfile-unread on a pull-request run', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await write('package.json', pkg({ ms: '2.1.3' }));
    await tagBase();
    await write('README.md', 'unrelated\n');
    await commit('head');
    const result = await scanBase(true);
    expect(result.run.couldNotRun?.code).toBe('deny-lockfile-unread');
    expect(result.run.couldNotRun?.message).toContain('projects with declared dependencies and no lockfile');
    expect(result.run.couldNotRun?.message).toContain('package.json');
    expect(codes(result)).not.toContain('deny-nothing-to-judge');
  });

  test('R3 a pypi entry and a requirements file with no Python lockfile is deny-lockfile-unread on a pull-request run', async () => {
    await write('.dep-guard.json', denyConfig([{ name: 'pypi:evil-pkg' }]));
    await write('requirements.txt', 'requests==2.31.0\n');
    await tagBase();
    await write('README.md', 'unrelated\n');
    await commit('head');
    const result = await scanBase(true);
    expect(result.run.couldNotRun?.code).toBe('deny-lockfile-unread');
    expect(result.run.couldNotRun?.message).toContain('requirements.txt');
  });

  test('R3 a list with npm entries only does not ask for a Python lockfile', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await write('requirements.txt', 'requests==2.31.0\n');
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await tagBase();
    await write('README.md', 'unrelated\n');
    await commit('head');
    const result = await scanBase(true);
    expect(result.run.couldNotRun).toBeUndefined();
  });

  test('70 a prefix scan names the deny list in lockfile-outside-prefix', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', workspaces: ['apps/*'] }));
    await write('apps/web/package.json', pkg({ ms: '2.1.3' }, 'web'));
    await write('package-lock.json', MS_LOCK);
    await commit('tree');
    const result = await scan({ repoRoot: path.join(repo, 'apps', 'web'), mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
    const outside = result.run.diagnostics.filter((diagnostic) => diagnostic.code === 'lockfile-outside-prefix');
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.every((diagnostic) => diagnostic.message.includes('the deny list did not judge that lockfile'))).toBe(true);
  });

  test('an npm packages value the parser skips is counted in deny-entries-unread', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ms': registryEntry('ms', '2.1.3'), 'node_modules/event-stream': 'not an object' as never }, { ms: '2.1.3' })
    );
    await commit('tree');
    const result = await audit();
    const unread = result.run.diagnostics.filter((diagnostic) => diagnostic.code === 'deny-entries-unread');
    expect(unread).toHaveLength(1);
    expect(unread[0].message).toContain('1 lockfile entry');
  });

  test('run.deny is present only with a non-empty list', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', MS_LOCK);
    await commit('none');
    expect((await audit()).run.deny).toBeUndefined();
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await commit('one');
    expect((await audit()).run.deny).toEqual({ entries: 1 });
  });
});

describe('acceptance: a pnpm lockfileVersion 9.0 tree with three bans', () => {
  const FIXTURE = readFileSync(path.join(__dirname, 'fixtures', 'pnpm-lock-v9-deny.yaml'), 'utf8');
  const BANS = [
    { name: 'ms', versions: ['2.1.2'], reason: 'retired version' },
    { name: 'ms', versions: ['2.1.3'], reason: 'retired version' },
    { name: 'left-pad', versions: ['1.3.0'], reason: 'retired package' },
  ];
  const SIGNALS = ['denied:left-pad@1.3.0', 'denied:ms@2.1.2', 'denied:ms@2.1.3'];

  test('blocks in every mode', async () => {
    await write('.dep-guard.json', denyConfig(BANS));
    await write('package.json', pkg({ debug: '4.3.4', 'left-pad': '1.3.0', ms: '2.1.3' }));
    await write('pnpm-lock.yaml', FIXTURE);
    await tagBase();
    await write('README.md', 'unrelated\n');
    await commit('head');
    const results: Array<[string, ScanResult]> = [
      ['audit', await audit()],
      ['base', await scanBase()],
      ['trust', await scanBase(true)],
    ];
    // HEAD one commit above the base, the head tree staged on top of it.
    await git('reset', '-q', '--soft', 'base');
    const headTree = (await git('write-tree')).trim();
    await git('read-tree', 'base');
    await write('zz-above-base.txt', 'unrelated\n');
    await git('add', 'zz-above-base.txt');
    await git('commit', '-q', '-m', 'above the base');
    await git('read-tree', headTree);
    await git('add', 'zz-above-base.txt');
    results.push(['staged', await scanStaged()]);
    results.push([
      'stagedTrust',
      await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS, trustBase: 'base' }),
    ]);
    for (const [mode, result] of results) {
      const signals = denied(result).map((finding) => String(finding.details?.signal)).sort();
      expect({ mode, signals, exitCode: result.exitCode }).toEqual({ mode, signals: SIGNALS, exitCode: 1 });
    }
    const checked = await checkSingle({ repoRoot: repo, name: 'ms', corpusDir: FIXTURE_CORPUS });
    expect(denied(checked).map((finding) => String(finding.details?.signal)).sort()).toEqual(['denied:ms@2.1.2', 'denied:ms@2.1.3']);
    expect(checked.exitCode).toBe(1);
  });
});

describe('finding shape', () => {
  test('66 a manifest line and its lockfile entry fold into one; two roots give two', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN));
    for (const root of ['apps/a', 'apps/b']) {
      await write(`${root}/package.json`, pkg({ 'event-stream': '3.3.6' }, root.slice(5)));
      await write(`${root}/package-lock.json`, ES_LOCK);
    }
    const findings = await deniedInAudit();
    expect(findings.map((finding) => [finding.manifestPath, finding.lockfilePath]).sort()).toEqual([
      ['apps/a/package.json', 'apps/a/package-lock.json'],
      ['apps/b/package.json', 'apps/b/package-lock.json'],
    ]);
    expect(findings.every((finding) => (finding.details?.locations as string[]).length === 2)).toBe(true);
  });

  test('67 fingerprint unchanged across a version bump and a hoisting move', async () => {
    await write('.dep-guard.json', denyConfig(ES_BAN));
    await write('package.json', pkg({ 'event-stream': '^3.3.0', a: '1.0.0' }));
    await write('package-lock.json', ES_LOCK);
    const [before] = await deniedInAudit();
    await write(
      'package-lock.json',
      npmLock(
        { 'node_modules/a': registryEntry('a'), 'node_modules/a/node_modules/event-stream': registryEntry('event-stream', '3.3.7') },
        { 'event-stream': '^3.3.0', a: '1.0.0' }
      )
    );
    const [after] = await deniedInAudit();
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.message).toContain('3.3.7');
  });

  test('68 two entries for one name with different versions give distinct fingerprints', async () => {
    await write(
      '.dep-guard.json',
      denyConfig([
        { name: 'event-stream', versions: ['3.3.6'] },
        { name: 'event-stream', versions: ['3.3.5'] },
      ])
    );
    await write('package.json', pkg({ a: '1.0.0' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/a': registryEntry('a'),
          'node_modules/event-stream': registryEntry('event-stream', '3.3.6'),
          'node_modules/a/node_modules/event-stream': registryEntry('event-stream', '3.3.5'),
        },
        { a: '1.0.0' }
      )
    );
    const findings = await deniedInAudit();
    expect(findings.map((finding) => finding.details?.signal).sort()).toEqual([
      'denied:event-stream@3.3.5',
      'denied:event-stream@3.3.6',
    ]);
    expect(new Set(findings.map((finding) => finding.fingerprint)).size).toBe(2);
  });
});
