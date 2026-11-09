import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { jest } from '@jest/globals';
import { parsePnpmLockfile, resolvePnpmRelativeTarballs } from '../src/lockfiles/pnpm.js';
import { scan } from '../src/scan.js';
import { parseNpmrcDefaultRegistry, parseNpmrcPins } from '../src/state.js';

// Each test runs up to five scans over a real git repository.
jest.setTimeout(60_000);

// pnpm lockfile entries read the way pnpm reads them:
//
//   - a packages key that does not split into a name and version. Lockfile
//     versions before 9 key a git or remote-tarball dependency by where it
//     comes from ("github.com/<owner>/<repo>/<commit>", "@<host>/<path>"),
//     and such an entry is read from its resolution under the name it
//     records; a key that carries a registry host in front of a name and
//     version is a registry entry of that name;
//   - a resolution.tarball that is a path rather than a URL, which is read
//     against the scope's or default registry in .npmrc, as ini decodes that
//     file;
//   - a git entry from a repository no earlier entry of its name came from,
//     which is a git-source finding.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CORPUS = path.join(__dirname, '..', 'fixtures', 'corpus');
const execFileAsync = promisify(execFile);

const SHA = '97edff6f525f192a3f83cea1944765f769ae2678';
const OTHER_SHA = '0123456789abcdef0123456789abcdef01234567';

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

async function tagBase(): Promise<void> {
  await commit('base');
  await git('tag', 'base');
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-pnpm-unsplit-'));
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

type Version = '5.4' | '6.0' | '9.0';
const VERSIONS: readonly Version[] = ['5.4', '6.0', '9.0'];

// A registry key in the spelling each lockfile version writes.
function registryKey(version: Version, name: string, semver: string): string {
  if (version === '5.4') {
    return `/${name}/${semver}`;
  }
  return version === '6.0' ? `/${name}@${semver}` : `${name}@${semver}`;
}

// A lockfile whose root depends on chalk (a name the fixture corpus knows),
// with `entries` (already indented packages-map lines) added after chalk's
// own entry.
function lock(version: Version, entries: string[] = []): string {
  const header =
    version === '5.4'
      ? ['lockfileVersion: 5.4', '', 'specifiers:', '  chalk: 5.3.0', '', 'dependencies:', '  chalk: 5.3.0', '']
      : version === '6.0'
        ? ["lockfileVersion: '6.0'", '', 'dependencies:', '  chalk:', '    specifier: 5.3.0', '    version: 5.3.0', '']
        : [
            "lockfileVersion: '9.0'",
            '',
            'importers:',
            '  .:',
            '    dependencies:',
            '      chalk:',
            '        specifier: 5.3.0',
            '        version: 5.3.0',
            '',
          ];
  const lines = [
    ...header,
    'packages:',
    `  '${registryKey(version, 'chalk', '5.3.0')}':`,
    '    resolution: {integrity: sha512-chalk530}',
    ...entries,
  ];
  if (version === '9.0') {
    lines.push('', 'snapshots:', '  chalk@5.3.0: {}');
  }
  return `${lines.join('\n')}\n`;
}

function gitKeyEntry(sha = SHA, owner = 'attacker'): string[] {
  return [
    `  github.com/${owner}/is-positive/${sha}:`,
    `    resolution: {tarball: https://codeload.github.com/${owner}/is-positive/tar.gz/${sha}}`,
    '    name: is-positive',
    '    version: 3.1.0',
  ];
}

type Mode = 'audit' | 'base' | 'trust' | 'staged' | 'stagedTrust';
const ALL_MODES: readonly Mode[] = ['audit', 'base', 'trust', 'staged', 'stagedTrust'];
const DELTA_MODES: readonly Mode[] = ['base', 'trust', 'staged', 'stagedTrust'];

type ScanResult = Awaited<ReturnType<typeof scan>>;

async function stageHeadAboveBase(): Promise<void> {
  await git('reset', '-q', '--soft', 'base');
  const headTree = (await git('write-tree')).trim();
  await git('read-tree', 'base');
  await write('zz-above-base.txt', 'unrelated\n');
  await git('add', 'zz-above-base.txt');
  await git('commit', '-q', '-m', 'above the base');
  await git('read-tree', headTree);
  await git('add', 'zz-above-base.txt');
}

async function runModes(modes: readonly Mode[]): Promise<Map<Mode, ScanResult>> {
  const results = new Map<Mode, ScanResult>();
  const ordered = [...modes.filter((m) => !m.startsWith('staged')), ...modes.filter((m) => m.startsWith('staged'))];
  let reset = false;
  for (const mode of ordered) {
    if (mode.startsWith('staged') && !reset) {
      await stageHeadAboveBase();
      reset = true;
    }
    results.set(
      mode,
      await scan({
        repoRoot: repo,
        mode:
          mode === 'audit' ? { kind: 'audit' } : mode.startsWith('staged') ? { kind: 'staged' } : { kind: 'base', ref: 'base' },
        corpusDir: FIXTURE_CORPUS,
        ...(mode === 'trust' || mode === 'stagedTrust' ? { trustBase: 'base' } : {}),
      })
    );
  }
  return results;
}

function tamperSignals(result: ScanResult, name?: string): string[] {
  return result.findings
    .filter((finding) => finding.ruleId === 'lockfile-tamper' && (name === undefined || finding.packageName === name))
    .map((finding) => String(finding.details?.signal));
}

// Commits `base` as the base, then writes `head` over it and commits that.
async function baseThenHead(files: { base: Record<string, string>; head: Record<string, string> }): Promise<void> {
  await write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { chalk: '5.3.0' } }));
  for (const [file, content] of Object.entries(files.base)) {
    await write(file, content);
  }
  await tagBase();
  for (const [file, content] of Object.entries(files.head)) {
    await write(file, content);
  }
  await commit('head');
}

describe('pnpm packages keys that do not split into a name and version', () => {
  test('a pre-v9 git key with a codeload tarball is read under the name it records, with no skip note', () => {
    const result = parsePnpmLockfile('pnpm-lock.yaml', lock('6.0', gitKeyEntry()));
    expect(result.entries.get('is-positive')).toEqual([
      {
        version: '3.1.0',
        resolvedUrl: `https://codeload.github.com/attacker/is-positive/tar.gz/${SHA}`,
        pnpmSnapshotName: 'is-positive',
        pnpmNameField: 'is-positive',
        pnpmRawKey: `github.com/attacker/is-positive/${SHA}`,
      },
    ]);
    expect(result.diagnostics.map((d) => d.code)).not.toContain('pnpm-lockfile-invalid-entry');
  });

  test('a key with a git resolution and no name field is read under the key itself', () => {
    const key = `gitlab.com/attacker/thing/${SHA}`;
    const result = parsePnpmLockfile(
      'pnpm-lock.yaml',
      lock('6.0', [`  ${key}:`, `    resolution: {type: git, repo: 'https://gitlab.com/attacker/thing.git', commit: ${SHA}}`])
    );
    expect(result.entries.get(key)).toEqual([
      { resolvedUrl: `git+https://gitlab.com/attacker/thing.git#${SHA}`, pnpmRawKey: key },
    ]);
  });

  test('a key with no readable location keeps its skip note and no entry', () => {
    const result = parsePnpmLockfile(
      'pnpm-lock.yaml',
      lock('6.0', ['  github.com/attacker/is-positive/abc:', '    resolution: {integrity: sha512-x}', '    name: is-positive'])
    );
    expect(result.entries.has('is-positive')).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('pnpm-lockfile-invalid-entry');
  });

  for (const version of VERSIONS) {
    test(`lockfile ${version}: an added transitive git key is a git-source finding in every mode`, async () => {
      await baseThenHead({ base: { 'pnpm-lock.yaml': lock(version) }, head: { 'pnpm-lock.yaml': lock(version, gitKeyEntry()) } });
      const results = await runModes(ALL_MODES);
      for (const [mode, result] of results) {
        expect([mode, tamperSignals(result, 'is-positive')]).toEqual([mode, ['git-source:codeload.github.com']]);
        // A commit-pinned git source with nothing to compare against is low
        // in audit mode, as it is for every lockfile format.
        expect([mode, result.exitCode]).toEqual([mode, mode === 'audit' ? 0 : 1]);
      }
    });

    test(`lockfile ${version}: an added tarball key on a host the project does not name is a url-source finding`, async () => {
      const entry = [
        "  '@evil.example.com/is-positive/-/is-positive-3.1.0.tgz':",
        '    resolution: {tarball: https://evil.example.com/is-positive/-/is-positive-3.1.0.tgz}',
        '    name: is-positive',
        '    version: 3.1.0',
      ];
      await baseThenHead({ base: { 'pnpm-lock.yaml': lock(version) }, head: { 'pnpm-lock.yaml': lock(version, entry) } });
      const results = await runModes(ALL_MODES);
      for (const [mode, result] of results) {
        expect([mode, tamperSignals(result, 'is-positive')]).toEqual([mode, ['url-source:evil.example.com']]);
        expect([mode, result.exitCode]).toEqual([mode, 1]);
      }
    });
  }

  test('a git key with a git resolution and no name field is a git-source finding under its key', async () => {
    const key = `gitlab.com/attacker/thing/${SHA}`;
    const entry = [`  ${key}:`, `    resolution: {type: git, repo: 'https://gitlab.com/attacker/thing.git', commit: ${SHA}}`];
    await baseThenHead({ base: { 'pnpm-lock.yaml': lock('6.0') }, head: { 'pnpm-lock.yaml': lock('6.0', entry) } });
    const results = await runModes(['base', 'trust']);
    for (const [mode, result] of results) {
      expect([mode, tamperSignals(result, key)]).toEqual([mode, ['git-source:gitlab.com']]);
    }
  });

  test('an unsplit tarball key on the public registry is held to the name it records', async () => {
    const entry = [
      "  '@registry.npmjs.org/event-stream/-/event-stream-3.3.6.tgz':",
      '    resolution: {tarball: https://registry.npmjs.org/event-stream/-/event-stream-3.3.6.tgz}',
      '    name: lodash',
      '    version: 4.17.21',
    ];
    await baseThenHead({ base: { 'pnpm-lock.yaml': lock('6.0') }, head: { 'pnpm-lock.yaml': lock('6.0', entry) } });
    const results = await runModes(ALL_MODES);
    for (const [mode, result] of results) {
      expect([mode, tamperSignals(result, 'lodash')]).toEqual([mode, ['tarball-name-mismatch:event-stream']]);
      expect([mode, result.exitCode]).toEqual([mode, 1]);
    }
  });

  test('an unchanged git key is not reported again', async () => {
    await baseThenHead({
      base: { 'pnpm-lock.yaml': lock('6.0', gitKeyEntry()) },
      head: { 'pnpm-lock.yaml': `${lock('6.0', gitKeyEntry())}\n` },
    });
    const results = await runModes(DELTA_MODES);
    for (const [mode, result] of results) {
      expect([mode, tamperSignals(result)]).toEqual([mode, []]);
      expect([mode, result.exitCode]).toEqual([mode, 0]);
    }
  });

  test('a registry entry replaced by a git key of the same name is reported', async () => {
    const registry = [`  '${registryKey('6.0', 'is-positive', '3.1.0')}':`, '    resolution: {integrity: sha512-ispositive}'];
    await baseThenHead({ base: { 'pnpm-lock.yaml': lock('6.0', registry) }, head: { 'pnpm-lock.yaml': lock('6.0', gitKeyEntry()) } });
    const results = await runModes(DELTA_MODES);
    for (const [mode, result] of results) {
      expect([mode, tamperSignals(result, 'is-positive').length > 0]).toEqual([mode, true]);
      expect([mode, result.exitCode]).toEqual([mode, 1]);
    }
  });

  test('allow does not clear the git-source finding', async () => {
    await write('.dep-guard.json', JSON.stringify({ allow: ['is-positive'] }));
    await baseThenHead({ base: { 'pnpm-lock.yaml': lock('6.0') }, head: { 'pnpm-lock.yaml': lock('6.0', gitKeyEntry()) } });
    const results = await runModes(ALL_MODES);
    for (const [mode, result] of results) {
      expect([mode, tamperSignals(result, 'is-positive')]).toEqual([mode, ['git-source:codeload.github.com']]);
      expect([mode, result.exitCode]).toEqual([mode, mode === 'audit' ? 0 : 1]);
    }
  });
});

describe('pnpm resolution.tarball written as a path', () => {
  test('a path is resolved against the scope pin, then the default registry, then the public registry', () => {
    const parsed = parsePnpmLockfile(
      'pnpm-lock.yaml',
      lock('9.0', [
        '  lodash@4.17.21:',
        '    resolution: {integrity: sha512-a, tarball: lodash/-/lodash-4.17.21.tgz}',
        "  '@corp/lib@1.0.0':",
        '    resolution: {integrity: sha512-b, tarball: "@corp/lib/-/lib-1.0.0.tgz"}',
        '  rooted@1.0.0:',
        '    resolution: {integrity: sha512-c, tarball: /rooted/-/rooted-1.0.0.tgz}',
        '  full@1.0.0:',
        '    resolution: {integrity: sha512-d, tarball: "https://registry.npmjs.org/full/-/full-1.0.0.tgz"}',
      ])
    );
    resolvePnpmRelativeTarballs(parsed, new Map([['@corp', 'https://npm.corp.example/api/npm']]), 'https://mirror.example/npm/');
    const url = (name: string): string | undefined => parsed.entries.get(name)?.[0]?.resolvedUrl;
    expect(url('lodash')).toBe('https://mirror.example/npm/lodash/-/lodash-4.17.21.tgz');
    expect(url('@corp/lib')).toBe('https://npm.corp.example/api/npm/@corp/lib/-/lib-1.0.0.tgz');
    expect(url('rooted')).toBe('https://mirror.example/rooted/-/rooted-1.0.0.tgz');
    expect(url('full')).toBe('https://registry.npmjs.org/full/-/full-1.0.0.tgz');

    const bare = parsePnpmLockfile(
      'pnpm-lock.yaml',
      lock('9.0', ['  lodash@4.17.21:', '    resolution: {integrity: sha512-a, tarball: lodash/-/lodash-4.17.21.tgz}'])
    );
    resolvePnpmRelativeTarballs(bare, new Map(), null);
    expect(bare.entries.get('lodash')?.[0]?.resolvedUrl).toBe('https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz');
  });

  for (const version of VERSIONS) {
    for (const tarball of ['event-stream/-/event-stream-3.3.6.tgz', '/event-stream/-/event-stream-3.3.6.tgz']) {
      test(`lockfile ${version}: an added entry whose tarball path "${tarball}" names another package is reported in every mode`, async () => {
        const entry = [`  '${registryKey(version, 'lodash', '4.17.21')}':`, `    resolution: {integrity: sha512-es, tarball: ${tarball}}`];
        await baseThenHead({ base: { 'pnpm-lock.yaml': lock(version) }, head: { 'pnpm-lock.yaml': lock(version, entry) } });
        const results = await runModes(ALL_MODES);
        for (const [mode, result] of results) {
          expect([mode, tamperSignals(result, 'lodash')]).toEqual([mode, ['tarball-name-mismatch:event-stream']]);
          expect([mode, result.exitCode]).toEqual([mode, 1]);
        }
      });
    }

    test(`lockfile ${version}: a protocol-relative tarball on a host the project does not name is a url-source finding`, async () => {
      const entry = [
        `  '${registryKey(version, 'lodash', '4.17.21')}':`,
        '    resolution: {integrity: sha512-es, tarball: //evil.example.com/lodash/-/lodash-4.17.21.tgz}',
      ];
      await baseThenHead({ base: { 'pnpm-lock.yaml': lock(version) }, head: { 'pnpm-lock.yaml': lock(version, entry) } });
      const results = await runModes(ALL_MODES);
      for (const [mode, result] of results) {
        expect([mode, tamperSignals(result, 'lodash')]).toEqual([mode, ['url-source:evil.example.com']]);
        expect([mode, result.exitCode]).toEqual([mode, 1]);
      }
    });
  }

  test('a scoped path is read against the scope pin and its mount path', async () => {
    const npmrc = '@corp:registry=https://npm.corp.example/api/npm/\n';
    const good = ["  '@corp/lib@1.0.0':", '    resolution: {integrity: sha512-lib, tarball: "@corp/lib/-/lib-1.0.0.tgz"}'];
    const bad = ["  '@corp/lib@1.0.0':", '    resolution: {integrity: sha512-lib, tarball: "@corp/other/-/other-1.0.0.tgz"}'];
    await baseThenHead({
      base: { '.npmrc': npmrc, 'pnpm-lock.yaml': lock('9.0') },
      head: { 'pnpm-lock.yaml': lock('9.0', good) },
    });
    for (const [mode, result] of await runModes(['base', 'trust'])) {
      expect([mode, tamperSignals(result, '@corp/lib')]).toEqual([mode, []]);
      // Read against the public registry instead, the pinned scope would
      // resolve off its pin.
      expect([mode, result.findings.filter((f) => f.packageName === '@corp/lib').map((f) => f.ruleId)]).toEqual([mode, []]);
    }
    await write('pnpm-lock.yaml', lock('9.0', bad));
    await commit('bad');
    for (const [mode, result] of await runModes(['base', 'trust'])) {
      expect([mode, tamperSignals(result, '@corp/lib')]).toEqual([mode, ['tarball-name-mismatch:@corp/other']]);
    }
  });

  test('a path read against a default registry the pull request adds to .npmrc is a url-source finding', async () => {
    const entry = ['  lodash@4.17.21:', '    resolution: {integrity: sha512-l, tarball: lodash/-/lodash-4.17.21.tgz}'];
    await baseThenHead({
      base: { 'pnpm-lock.yaml': lock('9.0') },
      head: { '.npmrc': 'registry=https://evil.example.com/\n', 'pnpm-lock.yaml': lock('9.0', entry) },
    });
    for (const [mode, result] of await runModes(['trust', 'stagedTrust'])) {
      expect([mode, tamperSignals(result, 'lodash')]).toEqual([mode, ['url-source:evil.example.com']]);
      expect([mode, result.exitCode]).toEqual([mode, 1]);
    }
  });

  test('an entry changed to a tarball path naming another package is reported', async () => {
    const before = ['  lodash@4.17.21:', '    resolution: {integrity: sha512-lodash}'];
    const after = ['  lodash@4.17.21:', '    resolution: {integrity: sha512-es, tarball: event-stream/-/event-stream-3.3.6.tgz}'];
    await baseThenHead({ base: { 'pnpm-lock.yaml': lock('9.0', before) }, head: { 'pnpm-lock.yaml': lock('9.0', after) } });
    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect([mode, tamperSignals(result, 'lodash').includes('tarball-name-mismatch:event-stream')]).toEqual([mode, true]);
      expect([mode, result.exitCode]).toEqual([mode, 1]);
    }
  });

  test('an unchanged tarball path is not reported again, and one naming its own package is not reported at all', async () => {
    const entry = ['  lodash@4.17.21:', '    resolution: {integrity: sha512-l, tarball: lodash/-/lodash-4.17.21.tgz}'];
    await baseThenHead({
      base: { 'pnpm-lock.yaml': lock('9.0', entry) },
      head: { 'pnpm-lock.yaml': `${lock('9.0', entry)}\n` },
    });
    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect([mode, tamperSignals(result)]).toEqual([mode, []]);
      expect([mode, result.exitCode]).toEqual([mode, 0]);
    }
  });

  test('allow does not clear the tarball-name finding', async () => {
    await write('.dep-guard.json', JSON.stringify({ allow: ['lodash'] }));
    const entry = ['  lodash@4.17.21:', '    resolution: {integrity: sha512-es, tarball: event-stream/-/event-stream-3.3.6.tgz}'];
    await baseThenHead({ base: { 'pnpm-lock.yaml': lock('9.0') }, head: { 'pnpm-lock.yaml': lock('9.0', entry) } });
    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect([mode, tamperSignals(result, 'lodash')]).toEqual([mode, ['tarball-name-mismatch:event-stream']]);
      expect([mode, result.exitCode]).toEqual([mode, 1]);
    }
  });
});

const PUBLIC_LODASH = 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz';

describe('pnpm keys below v9 that carry a registry host', () => {
  const HOSTED: Array<[Version, string]> = [
    ['5.4', 'registry.npmjs.org/lodash/4.17.21'],
    ['6.0', 'registry.npmjs.org/lodash@4.17.21'],
  ];

  test('a host-prefixed key is read as the registry entry of its name and version', () => {
    const cases: Array<[Version, string, string, string]> = [
      ['5.4', 'registry.npmjs.org/lodash/4.17.21', 'lodash', '4.17.21'],
      ['6.0', 'registry.npmjs.org/lodash@4.17.21', 'lodash', '4.17.21'],
      ['6.0', 'registry.npmjs.org/@scope/pkg@1.0.0', '@scope/pkg', '1.0.0'],
      ['5.4', 'registry.npmjs.org/@scope/pkg/1.0.0', '@scope/pkg', '1.0.0'],
      ['5.4', 'registry.npmjs.org/react-dom/17.0.2_react@17.0.2', 'react-dom', '17.0.2'],
      ['6.0', 'registry.npmjs.org/react-dom@17.0.2(react@17.0.2)', 'react-dom', '17.0.2'],
    ];
    for (const [version, key, name, semver] of cases) {
      const result = parsePnpmLockfile('pnpm-lock.yaml', lock(version, [`  '${key}':`, '    resolution: {integrity: sha512-x}']));
      expect([key, result.entries.get(name)]).toEqual([key, [{ version: semver, integrity: 'sha512-x' }]]);
      expect(result.diagnostics.map((d) => d.code)).not.toContain('pnpm-lockfile-invalid-entry');
    }
  });

  for (const [version, key] of HOSTED) {
    test(`lockfile ${version}: a host-prefixed registry key with its own tarball is judged as a plain key is`, async () => {
      const entry = [`  '${key}':`, `    resolution: {integrity: sha512-l, tarball: "${PUBLIC_LODASH}"}`];
      await baseThenHead({ base: { 'pnpm-lock.yaml': lock(version) }, head: { 'pnpm-lock.yaml': lock(version, entry) } });
      for (const [mode, result] of await runModes(ALL_MODES)) {
        expect([mode, result.findings.map((f) => [f.ruleId, f.packageName])]).toEqual([mode, []]);
        expect([mode, result.exitCode]).toEqual([mode, 0]);
      }
    });

    test(`lockfile ${version}: a host-prefixed registry key with no tarball is judged by its name as a plain key is`, async () => {
      // is-positive is not in the fixture corpus, so a registry entry of it
      // is an unknown-package finding.
      const hostedKey = key.replace('lodash', 'is-positive').replace('4.17.21', '3.1.0');
      const body = ['    resolution: {integrity: sha512-ip}', '    requiresBuild: true'];
      await baseThenHead({
        base: { 'pnpm-lock.yaml': lock(version) },
        head: { 'pnpm-lock.yaml': lock(version, [`  '${hostedKey}':`, ...body]) },
      });
      const shape = (result: ScanResult): unknown[] =>
        result.findings.map((f) => [f.ruleId, f.packageName, f.severity, f.details?.signal ?? null]).sort();
      const hosted = await runModes(['base', 'trust']);
      await write('pnpm-lock.yaml', lock(version, [`  '${registryKey(version, 'is-positive', '3.1.0')}':`, ...body]));
      await commit('plain key');
      const plain = await runModes(['base', 'trust']);
      for (const mode of ['base', 'trust'] as const) {
        const result = hosted.get(mode) as ScanResult;
        expect([mode, result.findings.some((f) => f.ruleId === 'unknown-package' && f.packageName === 'is-positive')]).toEqual([
          mode,
          true,
        ]);
        expect([mode, shape(result)]).toEqual([mode, shape(plain.get(mode) as ScanResult)]);
        expect([mode, result.exitCode]).toEqual([mode, 1]);
      }
    });

    test(`lockfile ${version}: a host-prefixed registry key whose tarball is on another host is a url-source finding`, async () => {
      const entry = [`  '${key}':`, '    resolution: {integrity: sha512-l, tarball: "https://evil.example.com/lodash/-/lodash-4.17.21.tgz"}'];
      await baseThenHead({ base: { 'pnpm-lock.yaml': lock(version) }, head: { 'pnpm-lock.yaml': lock(version, entry) } });
      for (const [mode, result] of await runModes(ALL_MODES)) {
        expect([mode, tamperSignals(result, 'lodash')]).toEqual([mode, ['url-source:evil.example.com']]);
      }
    });
  }
});

describe('.npmrc registries are read as ini reads them', () => {
  test('keys are unquoted, values end at an inline comment, and a [section] ends the top-level keys', () => {
    expect(parseNpmrcDefaultRegistry('"registry"=https://evil.example.com/\n')).toBe('https://evil.example.com/');
    expect(parseNpmrcDefaultRegistry("'registry' = 'https://evil.example.com/'\n")).toBe('https://evil.example.com/');
    expect(parseNpmrcDefaultRegistry('registry=https://a.example/ ; note\n')).toBe('https://a.example/');
    expect(
      parseNpmrcDefaultRegistry('registry=https://evil.example.com/\n[x]\nregistry=https://registry.npmjs.org/\n')
    ).toBe('https://evil.example.com/');
    expect(parseNpmrcPins('"@corp:registry"=https://evil.example.com/\n').get('@corp')).toBe('https://evil.example.com/');
    expect(parseNpmrcPins('[x]\n@corp:registry=https://evil.example.com/\n').has('@corp')).toBe(false);
    expect(parseNpmrcDefaultRegistry('registry=https://a.example/\r\nregistry=https://b.example/\r\n')).toBe(
      'https://b.example/'
    );
  });

  const PATH_LODASH = ['  lodash@4.17.21:', '    resolution: {integrity: sha512-l, tarball: lodash/-/lodash-4.17.21.tgz}'];
  const PATH_CORP = ["  '@corp/lib@1.0.0':", '    resolution: {integrity: sha512-b, tarball: "@corp/lib/-/lib-1.0.0.tgz"}'];
  const SPELLINGS: Array<[string, string, string[], string]> = [
    ['a quoted registry key', '"registry"=https://evil.example.com/\n', PATH_LODASH, 'lodash'],
    [
      'a top-level registry followed by a section that restates the public one',
      'registry=https://evil.example.com/\n[x]\nregistry=https://registry.npmjs.org/\n',
      PATH_LODASH,
      'lodash',
    ],
    ['a quoted scope pin', '"@corp:registry"=https://evil.example.com/\n', PATH_CORP, '@corp/lib'],
  ];
  for (const [label, npmrc, entry, name] of SPELLINGS) {
    test(`a tarball path read against ${label} the pull request adds is a url-source finding`, async () => {
      await baseThenHead({
        base: { 'pnpm-lock.yaml': lock('9.0') },
        head: { '.npmrc': npmrc, 'pnpm-lock.yaml': lock('9.0', entry) },
      });
      for (const [mode, result] of await runModes(['trust', 'stagedTrust'])) {
        expect([mode, tamperSignals(result, name)]).toEqual([mode, ['url-source:evil.example.com']]);
        expect([mode, result.exitCode]).toEqual([mode, 1]);
      }
    });
  }
});

describe('a tarball path below v9 is read against the registry of the name field', () => {
  const entry = [
    "  '/lodash@4.17.21':",
    '    resolution: {integrity: sha512-l, tarball: lodash/-/lodash-4.17.21.tgz}',
    "    name: '@evil/x'",
    '    version: 4.17.21',
  ];

  test('a v6 entry whose name field names a scope the pull request pins is read against that pin', async () => {
    await baseThenHead({
      base: { 'pnpm-lock.yaml': lock('6.0') },
      head: { '.npmrc': '@evil:registry=https://evil.example.com/\n', 'pnpm-lock.yaml': lock('6.0', entry) },
    });
    for (const [mode, result] of await runModes(['trust', 'stagedTrust'])) {
      expect([mode, tamperSignals(result, 'lodash')]).toEqual([mode, ['url-source:evil.example.com']]);
      expect([mode, result.exitCode]).toEqual([mode, 1]);
    }
  });

  test('from v9 on the key name decides, as pnpm 9 reads it', () => {
    const parsed = parsePnpmLockfile(
      'pnpm-lock.yaml',
      lock('9.0', ['  lodash@4.17.21:', '    resolution: {integrity: sha512-l, tarball: lodash/-/lodash-4.17.21.tgz}', "    name: '@evil/x'"])
    );
    resolvePnpmRelativeTarballs(parsed, new Map([['@evil', 'https://evil.example.com/']]), null);
    expect(parsed.entries.get('lodash')?.[0]?.resolvedUrl).toBe(PUBLIC_LODASH);
    const v6 = parsePnpmLockfile('pnpm-lock.yaml', lock('6.0', entry));
    resolvePnpmRelativeTarballs(v6, new Map([['@evil', 'https://evil.example.com/']]), null);
    expect(v6.entries.get('lodash')?.[0]?.resolvedUrl).toBe('https://evil.example.com/lodash/-/lodash-4.17.21.tgz');
  });
});

describe('an entry below v9 with no tarball is fetched from the registry of its name field', () => {
  const EVIL_PIN = '@evil:registry=https://evil.example.com/\n';
  const added = [
    "  '/lodash@4.17.21':",
    '    resolution: {integrity: sha512-l}',
    "    name: '@evil/x'",
    '    version: 4.17.21',
  ];

  test('an added entry whose name field names a scope the pull request pins is a url-source finding', async () => {
    await baseThenHead({
      base: { 'pnpm-lock.yaml': lock('6.0') },
      head: { '.npmrc': EVIL_PIN, 'pnpm-lock.yaml': lock('6.0', added) },
    });
    for (const [mode, result] of await runModes(['trust', 'stagedTrust'])) {
      expect([mode, tamperSignals(result, 'lodash')]).toEqual([mode, ['url-source:evil.example.com']]);
      expect([mode, result.exitCode]).toEqual([mode, 1]);
    }
    // Plain --base trusts the head's .npmrc, which names that registry.
    const base = (await runModes(['base'])).get('base') as ScanResult;
    expect(base.exitCode).toBe(0);
  });

  test('a name field added to an existing entry, with a pin for its scope, is a host change', async () => {
    const before = ["  '/lodash@4.17.21':", '    resolution: {integrity: sha512-l}'];
    const after = [...before, "    name: '@evil/x'"];
    await baseThenHead({
      base: { 'pnpm-lock.yaml': lock('6.0', before) },
      head: { '.npmrc': EVIL_PIN, 'pnpm-lock.yaml': lock('6.0', after) },
    });
    for (const [mode, result] of await runModes(['base', 'trust'])) {
      expect([mode, tamperSignals(result, 'lodash').some((s) => s.startsWith('host-changed'))]).toEqual([mode, true]);
      expect([mode, result.exitCode]).toEqual([mode, 1]);
    }
  });

  test('control: a name field that picks the same registry as the key leaves the entry as it was', () => {
    const same = ["  '/lodash@4.17.21':", '    resolution: {integrity: sha512-l}', '    name: lodash-alias', '    version: 4.17.21'];
    const parsed = parsePnpmLockfile('pnpm-lock.yaml', lock('6.0', same));
    resolvePnpmRelativeTarballs(parsed, new Map([['@evil', 'https://evil.example.com/']]), null);
    expect(parsed.entries.get('lodash')?.[0]?.resolvedUrl).toBeUndefined();
    const v9 = parsePnpmLockfile(
      'pnpm-lock.yaml',
      lock('9.0', ['  lodash@4.17.21:', '    resolution: {integrity: sha512-l}', "    name: '@evil/x'"])
    );
    resolvePnpmRelativeTarballs(v9, new Map([['@evil', 'https://evil.example.com/']]), null);
    expect(v9.entries.get('lodash')?.[0]?.resolvedUrl).toBeUndefined();
    const built = parsePnpmLockfile('pnpm-lock.yaml', lock('6.0', added));
    resolvePnpmRelativeTarballs(built, new Map([['@evil', 'https://evil.example.com']]), null);
    expect(built.entries.get('lodash')?.[0]?.resolvedUrl).toBe('https://evil.example.com/lodash/-/lodash-4.17.21.tgz');
  });

  test('control: the same entry with no pin for the name field scope is unchanged end to end', async () => {
    await baseThenHead({ base: { 'pnpm-lock.yaml': lock('6.0') }, head: { 'pnpm-lock.yaml': lock('6.0', added) } });
    const plain = ["  '/lodash@4.17.21':", '    resolution: {integrity: sha512-l}', '    version: 4.17.21'];
    const withName = await runModes(['base', 'trust']);
    await write('pnpm-lock.yaml', lock('6.0', plain));
    await commit('no name field');
    const without = await runModes(['base', 'trust']);
    const shape = (result: ScanResult): unknown[] =>
      result.findings.map((f) => [f.ruleId, f.packageName, f.severity, f.details?.signal ?? null]).sort();
    for (const mode of ['base', 'trust'] as const) {
      expect([mode, shape(withName.get(mode) as ScanResult)]).toEqual([mode, shape(without.get(mode) as ScanResult)]);
    }
  });
});

describe('a git entry from another repository than every earlier entry of its name', () => {
  function npmGitLock(owner: string, sha: string): string {
    return JSON.stringify({
      name: 'app',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'app', version: '1.0.0', dependencies: { chalk: '5.3.0' } },
        'node_modules/chalk': { version: '5.3.0', resolved: 'https://registry.npmjs.org/chalk/-/chalk-5.3.0.tgz', integrity: 'sha512-chalk' },
        'node_modules/is-positive': { version: '3.1.0', resolved: `git+ssh://git@github.com/${owner}/is-positive.git#${sha}` },
      },
    });
  }
  const v9GitKey = (owner: string, sha: string, repoName = 'is-positive'): string[] => [
    `  'is-positive@https://codeload.github.com/${owner}/${repoName}/tar.gz/${sha}':`,
    `    resolution: {tarball: https://codeload.github.com/${owner}/${repoName}/tar.gz/${sha}}`,
    '    version: 3.1.0',
  ];
  const v6GitKey = (owner: string, sha: string, repoName = 'is-positive'): string[] => [
    `  github.com/${owner}/${repoName}/${sha}:`,
    `    resolution: {tarball: https://codeload.github.com/${owner}/${repoName}/tar.gz/${sha}}`,
    '    name: is-positive',
    '    version: 3.1.0',
  ];

  const CASES: Array<[string, Record<string, string>, Record<string, string>, string[]]> = [
    [
      'an npm git entry repointed to another owner on the same host',
      { 'package-lock.json': npmGitLock('owner', SHA) },
      { 'package-lock.json': npmGitLock('attacker', OTHER_SHA) },
      ['git-source:github.com'],
    ],
    [
      'a v6 git key replaced by one of another repository',
      { 'pnpm-lock.yaml': lock('6.0', v6GitKey('owner', SHA)) },
      { 'pnpm-lock.yaml': lock('6.0', v6GitKey('attacker', OTHER_SHA)) },
      ['git-source:codeload.github.com'],
    ],
    [
      'a second v6 git entry of the same name from another repository',
      { 'pnpm-lock.yaml': lock('6.0', v6GitKey('owner', SHA)) },
      { 'pnpm-lock.yaml': lock('6.0', [...v6GitKey('owner', SHA), ...v6GitKey('attacker', OTHER_SHA, 'payload')]) },
      ['git-source:codeload.github.com'],
    ],
    [
      'a second v9 git entry of the same name from another repository',
      { 'pnpm-lock.yaml': lock('9.0', v9GitKey('owner', SHA)) },
      { 'pnpm-lock.yaml': lock('9.0', [...v9GitKey('owner', SHA), ...v9GitKey('attacker', OTHER_SHA, 'payload')]) },
      ['git-source:codeload.github.com'],
    ],
    [
      'control: an npm git entry bumped to another commit of the same repository',
      { 'package-lock.json': npmGitLock('owner', SHA) },
      { 'package-lock.json': npmGitLock('owner', OTHER_SHA) },
      [],
    ],
    [
      'control: a v6 git key bumped to another commit of the same repository',
      { 'pnpm-lock.yaml': lock('6.0', v6GitKey('owner', SHA)) },
      { 'pnpm-lock.yaml': lock('6.0', v6GitKey('owner', OTHER_SHA)) },
      [],
    ],
  ];
  for (const [label, base, head, signals] of CASES) {
    test(`${label} ${signals.length === 0 ? 'is not reported' : 'is a git-source finding'}`, async () => {
      await baseThenHead({ base, head });
      for (const [mode, result] of await runModes(DELTA_MODES)) {
        expect([mode, tamperSignals(result, 'is-positive')]).toEqual([mode, signals]);
        expect([mode, result.exitCode]).toEqual([mode, signals.length === 0 ? 0 : 1]);
      }
    });
  }
});
