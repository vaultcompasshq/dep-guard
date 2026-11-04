import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { jest } from '@jest/globals';
import { scan } from '../src/scan.js';

// Each test runs up to five scans over a real git repository.
jest.setTimeout(60_000);

// How lockfile entries and lockfile headers are judged. Each test is the
// smallest packages map that shows a shape, with lodahs standing in for a name
// the fixture corpus reports and lodash for one it knows.
//
// A name field makes the key a folder name only when an alias asks for the
// field and nothing the entry states about its location disagrees.
//
// An entry that states its location in a form the tool cannot judge, a
// "scripts" key on a lock entry and a lockfileVersion not 2 or more beside a packages
// map are each reported as lockfile tampering.
//
// The flag comparison itself pairs by path: what ran at another path says
// nothing about the entry at this one.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CORPUS = path.join(__dirname, '..', 'fixtures', 'corpus');
const execFileAsync = promisify(execFile);

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

function pkg(dependencies: Record<string, string>): string {
  return JSON.stringify({ name: 'app', version: '1.0.0', dependencies }, null, 2);
}

const NO_VERSION_FIELD = 'no version field';

function npmLock(
  packages: Record<string, Record<string, unknown>>,
  rootDependencies: Record<string, string> = { ms: '2.1.3' },
  version: unknown = 3
): string {
  const header = version === NO_VERSION_FIELD ? {} : { lockfileVersion: version };
  return JSON.stringify(
    {
      name: 'app',
      version: '1.0.0',
      ...header,
      requires: true,
      packages: { '': { name: 'app', version: '1.0.0', dependencies: rootDependencies }, ...packages },
    },
    null,
    2
  );
}

function registryEntry(name: string, version = '1.0.0', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: `sha512-${name}${version}`,
    license: 'MIT',
    ...extra,
  };
}

const MS_ENTRY = registryEntry('ms', '2.1.3');
const SCRIPT_TEXT = 'a-command-text-no-report-may-repeat';
const SCRIPTS = { postinstall: SCRIPT_TEXT };

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

function nameFindings(result: ScanResult, name: string): ScanResult['findings'] {
  return result.findings.filter(
    (finding) => finding.packageName === name && ['typosquat', 'unknown-package'].includes(finding.ruleId)
  );
}

function signalsOf(result: ScanResult, prefix: string): string[] {
  return result.findings
    .filter((finding) => finding.ruleId === 'lockfile-tamper')
    .map((finding) => String(finding.details?.signal))
    .filter((signal) => signal.startsWith(prefix));
}

function installScriptFindings(result: ScanResult): ScanResult['findings'] {
  return result.findings.filter((finding) => finding.ruleId === 'install-script');
}

function ambiguityNotes(result: ScanResult): unknown[] {
  return result.run.diagnostics.filter((diagnostic) => diagnostic.code === 'delta-ambiguous-lock-entry');
}

// The names the name checks reported in this run.
function nameCheckedNames(result: ScanResult): string[] {
  return [
    ...new Set(
      result.findings
        .filter((finding) => ['typosquat', 'unknown-package'].includes(finding.ruleId))
        .map((finding) => finding.packageName)
    ),
  ].sort();
}

const LOCATION_SIGNAL = 'lockfile-location-shape';
const SCRIPTS_SIGNAL = 'lockfile-scripts-key';
const VERSION_SIGNAL = 'lockfile-version-mismatch';

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-audit-1104-'));
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

describe('an alias edge makes the key a folder name only when the tarball vouches for the name field', () => {
  async function expectKeyBlocked(key: string, modes: readonly Mode[] = ALL_MODES): Promise<void> {
    const results = await runModes(modes);
    for (const [mode, result] of results) {
      expect({ mode, anchors: [...new Set(nameFindings(result, key).map((finding) => finding.manifestPath))] }).toEqual({
        mode,
        anchors: ['package-lock.json'],
      });
      expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 1 });
    }
  }

  test('an added entry whose tarball names the key has the key checked, whatever edge and field it carries', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': { ...MS_ENTRY, dependencies: { lodahs: 'npm:lodash@*' } },
        'node_modules/lodahs': { name: 'lodash', ...registryEntry('lodahs', '0.0.2') },
      })
    );
    await commit('head');

    await expectKeyBlocked('lodahs');
  });

  test('the same holds for a nested entry', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': { ...MS_ENTRY, dependencies: { lodahs: 'npm:lodash@*' } },
        'node_modules/ms/node_modules/lodahs': { name: 'lodash', ...registryEntry('lodahs', '0.0.2') },
      })
    );
    await commit('head');

    await expectKeyBlocked('lodahs');
  });

  test('a base alias retargeted at the same path, field kept, has the key checked', async () => {
    const alias = { name: 'lodash', ...registryEntry('lodash', '4.17.21') };
    const dependent = { ...MS_ENTRY, dependencies: { lodahs: 'npm:lodash@4.17.21' } };
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': dependent, 'node_modules/lodahs': alias }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': dependent,
        'node_modules/lodahs': { name: 'lodash', ...registryEntry('lodahs', '0.0.2') },
      })
    );
    await commit('head');

    await expectKeyBlocked('lodahs', DELTA_MODES);
  });

  test('a key the corpus does not know is an unknown package, not skipped', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': { ...MS_ENTRY, dependencies: { 'zz-not-in-any-corpus': 'npm:lodash@*' } },
        'node_modules/zz-not-in-any-corpus': { name: 'lodash', ...registryEntry('zz-not-in-any-corpus', '1.0.0') },
      })
    );
    await commit('head');

    await expectKeyBlocked('zz-not-in-any-corpus');
  });

  test('control: a genuine transitive alias, the tarball naming the field, leaves the key alone', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': { ...MS_ENTRY, dependencies: { lodahs: 'npm:lodash@4.17.21' } },
        'node_modules/lodahs': { name: 'lodash', ...registryEntry('lodash', '4.17.21') },
      })
    );
    await commit('head');

    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect({ mode, key: nameFindings(result, 'lodahs') }).toEqual({ mode, key: [] });
      // Audit mode judges ms too, which the fixture corpus does not know.
      expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: mode === 'audit' ? 1 : 0 });
      expect({ mode, names: nameCheckedNames(result) }).toEqual({ mode, names: mode === 'audit' ? ['ms'] : [] });
    }
  });

  test('control: a manifest alias line, the tarball naming the field, leaves the key alone', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    const declared = { ms: '2.1.3', lodahs: 'npm:lodash@4.17.21' };
    await write('package.json', pkg(declared));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/ms': MS_ENTRY,
          'node_modules/lodahs': { name: 'lodash', ...registryEntry('lodash', '4.17.21') },
        },
        declared
      )
    );
    await commit('head');

    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect({ mode, key: nameFindings(result, 'lodahs') }).toEqual({ mode, key: [] });
      expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: mode === 'audit' ? 1 : 0 });
      expect({ mode, names: nameCheckedNames(result) }).toEqual({ mode, names: mode === 'audit' ? ['ms'] : [] });
    }
  });
});

describe('an entry that states its location in a form the tool cannot judge is lockfile tampering', () => {
  const VALUE = 'https://registry.npmjs.org/lodahs/-/lodahs-0.0.2.tgz';
  const FIELD = { name: 'lodash', version: '4.17.21', integrity: 'sha512-x' };
  const BASE = { 'node_modules/ms': MS_ENTRY };

  async function aliasHead(entry: Record<string, unknown>, entryPath = 'node_modules/lodahs'): Promise<void> {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock(BASE));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ms': { ...MS_ENTRY, dependencies: { lodahs: 'npm:lodash@*' } }, [entryPath]: entry })
    );
    await commit('head');
  }

  function locationFindings(result: ScanResult): ScanResult['findings'] {
    return result.findings.filter((finding) => String(finding.details?.signal).startsWith(LOCATION_SIGNAL));
  }

  const UNPARSABLE_RESOLVED: Array<[string, string]> = [
    ['a hosted shorthand', 'example/x#abc'],
    ['an scp-style git address', 'git@example.invalid:example/x.git'],
    ['a relative path', '../x.tgz'],
    ['a protocol-relative URL', '//example.invalid/x.tgz'],
    ['a name before a URL', 'lodash@https://example.invalid/x.tgz'],
    ['a name and a version', 'lodash@1.0.0'],
    ['blank text', '   '],
  ];

  const SHAPES: Array<[string, Record<string, unknown>, string]> = [
    ['resolved as an object', { ...FIELD, resolved: { raw: VALUE } }, 'resolved'],
    ['resolved as an array', { ...FIELD, resolved: [VALUE] }, 'resolved'],
    ['resolved as a number', { ...FIELD, resolved: 7 }, 'resolved'],
    ['a _resolved field', { ...FIELD, _resolved: VALUE }, '_resolved'],
    ['a _resolved field beside a string resolved', { ...FIELD, resolved: `${VALUE}#x`, _resolved: VALUE }, '_resolved'],
    ['no resolved, the version a URL', { name: 'lodash', version: VALUE }, 'version'],
    ['no resolved, the version a registry alias', { name: 'lodash', version: 'npm:lodahs@0.0.2' }, 'version'],
    ['resolved false, the version a URL', { name: 'lodash', version: VALUE, resolved: false }, 'version'],
    ['an empty resolved, the version a URL', { name: 'lodash', version: VALUE, resolved: '' }, 'version'],
    ['no resolved, the version a number', { name: 'lodash', version: 7 }, 'version'],
    ...UNPARSABLE_RESOLVED.map(([label, resolved]): [string, Record<string, unknown>, string] => [
      `resolved as ${label}`,
      { ...FIELD, resolved },
      'resolved',
    ]),
  ];

  test.each(SHAPES)('with an alias edge: %s has the key checked', async (_label, entry, field) => {
    await aliasHead(entry);

    for (const [mode, result] of await runModes(ALL_MODES)) {
      const found = locationFindings(result);
      expect({ mode, found: found.map((f) => [f.ruleId, f.severity, f.packageName, f.manifestPath, f.details?.fields]) }).toEqual({
        mode,
        found: [['lockfile-tamper', 'critical', 'lodahs', 'package-lock.json', [field]]],
      });
      expect({ mode, key: nameFindings(result, 'lodahs').length > 0 }).toEqual({ mode, key: true });
      expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 1 });
      expect(JSON.stringify(found)).not.toContain('lodahs-0.0.2');
      expect(JSON.stringify(found)).not.toContain('npm:lodahs');
    }
  });

  test.each([
    ['resolved as an object', { version: '4.17.21', resolved: { raw: 'https://example.invalid/x.tgz' } }],
    ['a _resolved field', { version: '4.17.21', _resolved: 'https://example.invalid/x.tgz' }],
    ['no resolved, the version a URL', { version: 'https://example.invalid/x.tgz' }],
    ['no resolved, the version a registry alias', { version: 'npm:lodahs@0.0.2' }],
    ...UNPARSABLE_RESOLVED.map(([label, resolved]): [string, Record<string, unknown>] => [
      `resolved as ${label}`,
      { version: '4.17.21', resolved },
    ]),
  ])('with no alias, a new nested entry of a known name: %s', async (_label, entry) => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock(BASE));
    await tagBase();
    await write('package-lock.json', npmLock({ ...BASE, 'node_modules/ms/node_modules/lodash': entry }));
    await commit('head');

    for (const [mode, result] of await runModes(ALL_MODES)) {
      const found = locationFindings(result);
      expect({ mode, found: found.map((f) => [f.severity, f.packageName]) }).toEqual({ mode, found: [['critical', 'lodash']] });
      expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 1 });
      expect(JSON.stringify(found)).not.toContain('example.invalid');
    }
  });

  test.each([
    ['resolved false', { ...FIELD, resolved: false }],
    ['resolved null', { ...FIELD, resolved: null }],
    ['no resolved', FIELD],
    ['no resolved, the version null', { name: 'lodash', version: null }],
    ['no resolved, no version', { name: 'lodash' }],
  ])('control: %s states no location, so the alias still clears the key', async (_label, entry) => {
    await aliasHead(entry);

    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, found: locationFindings(result) }).toEqual({ mode, found: [] });
      expect({ mode, key: nameFindings(result, 'lodahs') }).toEqual({ mode, key: [] });
      expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 0 });
    }
  });

  test('control: an empty resolved with a plain version keeps the key on the list and is not this finding', async () => {
    await aliasHead({ ...FIELD, resolved: '' });

    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, found: locationFindings(result) }).toEqual({ mode, found: [] });
      expect({ mode, key: nameFindings(result, 'lodahs').length > 0 }).toEqual({ mode, key: true });
      expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 1 });
    }
  });

  test('control: a string resolved on a foreign host keeps its critical url-source finding', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock(BASE));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({ ...BASE, 'node_modules/ms/node_modules/lodash': { version: '4.17.21', resolved: 'https://example.invalid/x.tgz' } })
    );
    await commit('head');

    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect({ mode, found: locationFindings(result) }).toEqual({ mode, found: [] });
      const urlSource = result.findings.filter((f) => f.packageName === 'lodash' && String(f.details?.signal).startsWith('url-source'));
      expect({ mode, found: urlSource.map((f) => [f.ruleId, f.severity]) }).toEqual({ mode, found: [['lockfile-tamper', 'critical']] });
      expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 1 });
    }
  });

  test('control: workspace, link, bundled and plain no-resolved entries do not hit', async () => {
    const packages = {
      ...BASE,
      'packages/app-a': { version: '1.0.0', dependencies: { lodash: '*' } },
      'node_modules/app-a': { resolved: 'packages/app-a', link: true },
      'node_modules/ms/node_modules/lodash': { version: '4.17.21', inBundle: true },
      'node_modules/ms/node_modules/isexe': { version: '2.0.0-beta.1+build.5', integrity: 'sha512-x' },
    };
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock(BASE));
    await tagBase();
    await write('package-lock.json', npmLock(packages));
    await commit('head');

    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect({ mode, found: locationFindings(result) }).toEqual({ mode, found: [] });
    }
  });

  test('an entry that only gains the field is reported, though the entry diff drops it as unchanged', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock(BASE));
    await tagBase();
    await write('package-lock.json', npmLock({ 'node_modules/ms': { ...MS_ENTRY, _resolved: VALUE } }));
    await commit('head');

    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect({ mode, found: locationFindings(result).map((f) => f.packageName) }).toEqual({ mode, found: ['ms'] });
    }
  });

  test('the same shape on the comparison side is not new, and audit mode still states it', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': { ...MS_ENTRY, _resolved: VALUE } }));
    await tagBase();
    await write('README.md', 'unrelated\n');
    await commit('head');

    const results = await runModes(['audit', 'base']);
    expect(locationFindings(results.get('audit') as ScanResult).length).toBe(1);
    expect(locationFindings(results.get('base') as ScanResult)).toEqual([]);
  });

  test('a changed value at the same path is reported under a different signal, with no value in it', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': { ...MS_ENTRY, _resolved: VALUE } }));
    await tagBase();
    const before = locationFindings((await runModes(['audit'])).get('audit') as ScanResult);
    await write('package-lock.json', npmLock({ 'node_modules/ms': { ...MS_ENTRY, _resolved: `${VALUE}#moved` } }));
    await commit('head');

    const after = locationFindings((await runModes(['base'])).get('base') as ScanResult);
    expect(after.map((f) => f.packageName)).toEqual(['ms']);
    expect(after[0].details?.signal).not.toEqual(before[0].details?.signal);
    expect(after[0].fingerprint).not.toEqual(before[0].fingerprint);
    expect(String(after[0].details?.signal)).not.toContain('lodahs');
  });

  test('control: a link entry with a relative resolved is not a location shape', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock(BASE));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({ ...BASE, 'node_modules/local': { resolved: 'packages/local', link: true } })
    );
    await commit('head');

    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect({ mode, found: locationFindings(result) }).toEqual({ mode, found: [] });
    }
  });

  test('a link flag that is not true does not excuse a string resolved', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock(BASE));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({ ...BASE, 'node_modules/local': { version: '1.0.0', resolved: 'packages/local', link: 1 } })
    );
    await commit('head');

    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect({ mode, found: locationFindings(result).map((f) => f.packageName) }).toEqual({ mode, found: ['local'] });
    }
  });

  test.each([
    ['a user at a host', 'git+ssh://git@git.example.invalid:team/x.git', 'git+ssh://git@git.example.invalid/team/x.git'],
    ['a host in capitals', 'git+ssh://git@GIT.example.invalid:team/x.git', 'git+ssh://git@GIT.example.invalid/team/x.git'],
  ])('npm form of an scp-style git address is judged as the same address written with a slash: %s', async (_label, colon, slashed) => {
    const sha = 'a'.repeat(40);
    const judged = (result: ScanResult): string[] =>
      result.findings.map((f) => `${f.ruleId} ${f.severity} ${f.packageName} ${String(f.details?.signal)}`).sort();
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock(BASE));
    await tagBase();

    const nested = (resolved: string): string =>
      npmLock({ ...BASE, 'node_modules/ms/node_modules/lodash': { version: '4.17.21', resolved } });
    await write('package-lock.json', nested(`${slashed}#${sha}`));
    await commit('slash');
    const slash = await runModes(ALL_MODES);
    await write('package-lock.json', nested(`${colon}#${sha}`));
    await commit('scp');
    const scp = await runModes(ALL_MODES);

    for (const [mode, result] of scp) {
      const expected = judged(slash.get(mode) as ScanResult);
      expect({ mode, some: expected.length > 0 }).toEqual({ mode, some: true });
      expect({ mode, findings: judged(result) }).toEqual({ mode, findings: expected });
      expect({ mode, found: locationFindings(result) }).toEqual({ mode, found: [] });
    }
  });

  test.each([
    ['a space in the path', 'git+ssh://git@git.example.invalid:team/x y.git'],
    ['no user', 'git+ssh://git.example.invalid:team/x.git'],
    ['no user, with a credential-shaped path', 'git+ssh://git.example.invalid:o@github.com/o/r.git'],
    ['a colon after the first slash', 'git+ssh://git@github.com/o/r:x.git'],
    ['an at sign in the path', 'git+ssh://git@git.example.invalid:o@github.com/o/r.git'],
    ['a second colon in the path', 'git+ssh://git@github.com:o@git.example.invalid:u/r.git'],
    ['a query mark before the at sign', 'git+ssh://github.com?x@git.example.invalid:o/r.git'],
    ['a backslash in the host', 'git+ssh://git@github.com\\@git.example.invalid:o/r.git'],
    ['another scheme', 'git+https://git@git.example.invalid:team/x.git'],
  ])('only the exact npm form is read as a git address: %s stays a location shape', async (_label, resolved) => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock(BASE));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({ ...BASE, 'node_modules/ms/node_modules/lodash': { version: '4.17.21', resolved } })
    );
    await commit('head');

    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect({ mode, found: locationFindings(result).map((f) => f.details?.fields) }).toEqual({ mode, found: [['resolved']] });
    }
  });

  test.each([
    ['a port and a path', 'git+ssh://git@git.example.invalid:22/team/x.git'],
    ['a plain slash address', 'git+ssh://git@git.example.invalid/team/x.git'],
  ])('control: %s is a URL and no location shape', async (_label, resolved) => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock(BASE));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({ ...BASE, 'node_modules/ms/node_modules/lodash': { version: '4.17.21', resolved } })
    );
    await commit('head');

    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect({ mode, found: locationFindings(result) }).toEqual({ mode, found: [] });
    }
  });

  test('a link flag does not excuse a resolved that is not a string', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock(BASE));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({ ...BASE, 'node_modules/local': { resolved: { raw: VALUE }, link: true } })
    );
    await commit('head');

    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect({ mode, found: locationFindings(result).map((f) => f.packageName) }).toEqual({ mode, found: ['local'] });
    }
  });

  test('dropping the string resolved beside an unchanged _resolved is reported', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': { ...MS_ENTRY, _resolved: VALUE } }));
    await tagBase();
    const { resolved: _dropped, ...withoutResolved } = MS_ENTRY as Record<string, unknown>;
    expect(_dropped).toBeDefined();
    await write('package-lock.json', npmLock({ 'node_modules/ms': { ...withoutResolved, _resolved: VALUE } }));
    await commit('head');

    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, found: locationFindings(result).map((f) => f.packageName) }).toEqual({ mode, found: ['ms'] });
    }
  });

  test('the same value moving to a different field is reported', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': { version: '2.1.3', _resolved: VALUE } }));
    await tagBase();
    await write('package-lock.json', npmLock({ 'node_modules/ms': { version: VALUE } }));
    await commit('head');

    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, found: locationFindings(result).map((f) => f.details?.fields) }).toEqual({ mode, found: [['version']] });
    }
  });

  test('a shape on the comparison side does not count as the key having been installed from a registry', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodahs': { version: '0.0.1', _resolved: VALUE } }));
    await tagBase();
    await write('package-lock.json', npmLock({ 'node_modules/lodahs': { version: '0.0.2', _resolved: VALUE } }));
    await commit('head');

    for (const [mode, result] of await runModes(['base'])) {
      expect({ mode, key: nameFindings(result, 'lodahs').length > 0 }).toEqual({ mode, key: true });
    }
  });
});

describe('a scripts key on a lock entry is lockfile tampering', () => {
  test('an unchanged entry that gains the key is reported, with no flag on it, and the command is not repeated', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    await write('package-lock.json', npmLock({ 'node_modules/ms': { ...MS_ENTRY, scripts: SCRIPTS } }));
    await commit('head');

    for (const [mode, result] of await runModes(ALL_MODES)) {
      const found = result.findings.filter((finding) => String(finding.details?.signal).startsWith(SCRIPTS_SIGNAL));
      expect({ mode, found: found.map((f) => [f.ruleId, f.severity, f.packageName, f.manifestPath]) }).toEqual({
        mode,
        found: [['lockfile-tamper', 'critical', 'ms', 'package-lock.json']],
      });
      expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 1 });
      expect(JSON.stringify(result.findings)).not.toContain(SCRIPT_TEXT);
    }
  });

  test('a new entry carrying the key is reported', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': MS_ENTRY,
        'node_modules/ms/node_modules/lodash': registryEntry('lodash', '4.17.21', { scripts: SCRIPTS }),
      })
    );
    await commit('head');

    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect({ mode, signals: signalsOf(result, SCRIPTS_SIGNAL).length }).toEqual({ mode, signals: 1 });
    }
  });

  test('two nested copies of one name are two findings', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': { ...MS_ENTRY, scripts: SCRIPTS },
        'node_modules/lodash/node_modules/ms': { ...MS_ENTRY, scripts: SCRIPTS },
      })
    );
    await commit('head');

    for (const [mode, result] of await runModes(['base'])) {
      expect({ mode, signals: signalsOf(result, SCRIPTS_SIGNAL).length }).toEqual({ mode, signals: 2 });
    }
  });

  test('a workspace directory entry and a link entry are not exempt', async () => {
    const link = { resolved: 'packages/app', link: true };
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY, 'node_modules/app-b': link, 'packages/app-a': { version: '1.0.0' } }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': MS_ENTRY,
        'node_modules/app-b': { ...link, scripts: SCRIPTS },
        'packages/app-a': { version: '1.0.0', scripts: SCRIPTS },
      })
    );
    await commit('head');

    for (const [mode, result] of await runModes(['base'])) {
      expect({ mode, signals: signalsOf(result, SCRIPTS_SIGNAL).length }).toEqual({ mode, signals: 2 });
    }
  });

  test('an allow entry for the name does not clear it', async () => {
    await write('.dep-guard.json', JSON.stringify({ allow: ['ms'] }));
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    await write('package-lock.json', npmLock({ 'node_modules/ms': { ...MS_ENTRY, scripts: SCRIPTS } }));
    await commit('head');

    for (const [mode, result] of await runModes(['base'])) {
      expect({ mode, signals: signalsOf(result, SCRIPTS_SIGNAL).length, exit: result.exitCode }).toEqual({
        mode,
        signals: 1,
        exit: 1,
      });
    }
  });

  test('a changed value at the same path is reported, and a key copied to a new path is reported there', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': { ...MS_ENTRY, scripts: SCRIPTS } }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': { ...MS_ENTRY, scripts: { postinstall: 'another-command' } },
        'node_modules/lodash/node_modules/ms': { ...MS_ENTRY, scripts: SCRIPTS },
      })
    );
    await commit('head');

    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, signals: signalsOf(result, SCRIPTS_SIGNAL).length }).toEqual({ mode, signals: 2 });
    }
  });

  test('a changed value gets a different signal and fingerprint, and the signal holds no command text', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': { ...MS_ENTRY, scripts: SCRIPTS } }));
    await tagBase();
    const finding = (result: ScanResult) =>
      result.findings.filter((f) => String(f.details?.signal).startsWith(SCRIPTS_SIGNAL))[0];
    const before = finding((await runModes(['audit'])).get('audit') as ScanResult);
    await write('package-lock.json', npmLock({ 'node_modules/ms': { ...MS_ENTRY, scripts: { postinstall: 'another-command' } } }));
    await commit('head');

    const after = finding((await runModes(['audit'])).get('audit') as ScanResult);
    expect(after.details?.signal).not.toEqual(before.details?.signal);
    expect(after.fingerprint).not.toEqual(before.fingerprint);
    expect(JSON.stringify(after)).not.toContain('another-command');
  });

  test('the same key on the comparison side is not new, and audit mode still states it', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': { ...MS_ENTRY, scripts: SCRIPTS } }));
    await tagBase();
    await write('README.md', 'unrelated\n');
    await commit('head');

    const results = await runModes(['audit', 'base']);
    expect(signalsOf(results.get('audit') as ScanResult, SCRIPTS_SIGNAL).length).toBe(1);
    expect(signalsOf(results.get('base') as ScanResult, SCRIPTS_SIGNAL)).toEqual([]);
  });

  test('an npm lockfile below a primary pnpm lockfile is read for the key', async () => {
    await write('package.json', pkg({}));
    await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
    await write('tools/package.json', pkg({ ms: '2.1.3' }));
    await write('tools/package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    await write('tools/package-lock.json', npmLock({ 'node_modules/ms': { ...MS_ENTRY, scripts: SCRIPTS } }));
    await commit('head');

    for (const [mode, result] of await runModes(['base'])) {
      expect({ mode, primary: result.findings.filter((f) => f.manifestPath === 'tools/package-lock.json').length }).toEqual({
        mode,
        primary: 1,
      });
    }
  });

  test('control: the root entry is the project itself, and is not a lock entry', async () => {
    const lock = JSON.parse(npmLock({ 'node_modules/ms': MS_ENTRY })) as { packages: Record<string, Record<string, unknown>> };
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', JSON.stringify(lock));
    await tagBase();
    lock.packages[''].scripts = { postinstall: 'project-script' };
    await write('package-lock.json', JSON.stringify(lock));
    await commit('head');

    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect({ mode, signals: signalsOf(result, SCRIPTS_SIGNAL) }).toEqual({ mode, signals: [] });
    }
  });
});

describe('a lockfileVersion that does not match a present packages map is lockfile tampering', () => {
  test.each([
    ['the number 1', 1],
    ['null', null],
    ['no field at all', NO_VERSION_FIELD],
    ['text that is not a number', 'three'],
  ])('%s beside a packages map is reported, the flags being no account of what runs', async (_label, version) => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }, { ms: '2.1.3' }, version));
    await commit('head');

    for (const [mode, result] of await runModes(ALL_MODES)) {
      const found = result.findings.filter((finding) => String(finding.details?.signal) === VERSION_SIGNAL);
      expect({ mode, found: found.map((f) => [f.ruleId, f.severity, f.packageName, f.manifestPath]) }).toEqual({
        mode,
        found: [['lockfile-tamper', 'high', 'package-lock.json', 'package-lock.json']],
      });
      expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 1 });
    }
  });

  test('a new lockfile with the shape is reported', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await tagBase();
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }, { ms: '2.1.3' }, 1));
    await commit('head');

    for (const [mode, result] of await runModes(['base'])) {
      expect({ mode, signals: signalsOf(result, VERSION_SIGNAL).length }).toEqual({ mode, signals: 1 });
    }
  });

  test('the same shape on the comparison side is not new, and audit mode still states it', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }, { ms: '2.1.3' }, 1));
    await tagBase();
    await write('README.md', 'unrelated\n');
    await commit('head');

    const results = await runModes(['audit', 'base']);
    expect(signalsOf(results.get('audit') as ScanResult, VERSION_SIGNAL).length).toBe(1);
    expect(signalsOf(results.get('base') as ScanResult, VERSION_SIGNAL)).toEqual([]);
  });

  test.each([
    ['the number 2', 2],
    ['the number 3', 3],
    ['a string of digits, which npm compares as a number', '3'],
  ])('control: %s is no finding', async (_label, version) => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }, { ms: '2.1.3' }, version));
    await write('README.md', 'unrelated\n');
    await commit('head');

    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect({ mode, signals: signalsOf(result, VERSION_SIGNAL) }).toEqual({ mode, signals: [] });
    }
  });

  test('control: a real v1 lockfile has no packages map and keeps its own diagnostic', async () => {
    const v1 = JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 1, dependencies: {} });
    await write('package.json', pkg({}));
    await write('package-lock.json', v1);
    await tagBase();
    await write('package-lock.json', `${v1}\n`);
    await commit('head');

    for (const [mode, result] of await runModes(['audit', 'base'])) {
      expect({ mode, signals: signalsOf(result, VERSION_SIGNAL) }).toEqual({ mode, signals: [] });
    }
  });
});

describe('the install-script comparison pairs by path', () => {
  const entry = (name: string, version: string, flagged: boolean): Record<string, unknown> =>
    registryEntry(name, version, flagged ? { hasInstallScript: true } : {});

  test('a same-path bump that acquires the flag is reported, whatever an older nested copy ran', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    const packages = {
      'node_modules/ms': MS_ENTRY,
      'node_modules/esbuild': entry('esbuild', '0.20.0', false),
      'node_modules/ms/node_modules/esbuild': entry('esbuild', '0.18.0', true),
    };
    await write('package-lock.json', npmLock(packages));
    await tagBase();
    await write('package-lock.json', npmLock({ ...packages, 'node_modules/esbuild': entry('esbuild', '0.21.0', true) }));
    await commit('head');

    for (const [mode, result] of await runModes(DELTA_MODES)) {
      const found = installScriptFindings(result);
      expect({ mode, found: found.map((f) => [f.severity, f.packageName, f.details?.signal]) }).toEqual({
        mode,
        found: [['high', 'esbuild', 'flag-acquired']],
      });
      expect({ mode, notes: ambiguityNotes(result) }).toEqual({ mode, notes: [] });
    }
  });

  test('a new path is reported beside a flagged alias of the key, which ran another package', async () => {
    const dependent = { ...MS_ENTRY, dependencies: { lodash: 'npm:isexe@2.0.0' } };
    await write('package.json', pkg({ ms: '2.1.3' }));
    const packages = {
      'node_modules/ms': dependent,
      'node_modules/lodash': { name: 'isexe', ...entry('isexe', '2.0.0', true) },
    };
    await write('package-lock.json', npmLock(packages));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({ ...packages, 'node_modules/ms/node_modules/lodash': entry('lodash', '4.17.21', true) })
    );
    await commit('head');

    for (const [mode, result] of await runModes(DELTA_MODES)) {
      const found = installScriptFindings(result).filter((f) => f.packageName === 'lodash');
      expect({ mode, severities: found.map((f) => f.severity) }).toEqual({ mode, severities: ['high'] });
    }
  });

  test('a same-path alias retargeted to the key itself is reported, though the alias ran a script there', async () => {
    const dependent = { ...MS_ENTRY, dependencies: { lodash: 'npm:isexe@2.0.0' } };
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': dependent,
        'node_modules/lodash': { name: 'isexe', ...entry('isexe', '2.0.0', true) },
      })
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ms': MS_ENTRY, 'node_modules/lodash': entry('lodash', '4.17.21', true) })
    );
    await commit('head');

    for (const [mode, result] of await runModes(DELTA_MODES)) {
      const found = installScriptFindings(result).filter((f) => f.packageName === 'lodash');
      expect({ mode, severities: found.map((f) => f.severity) }).toEqual({ mode, severities: ['high'] });
    }
  });

  test('a same-path entry that keeps its name field while its tarball moves to the key is reported', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ms': MS_ENTRY, 'node_modules/lodash': { name: 'isexe', ...entry('isexe', '2.0.0', true) } })
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ms': MS_ENTRY, 'node_modules/lodash': { name: 'isexe', ...entry('lodash', '4.17.21', true) } })
    );
    await commit('head');

    for (const [mode, result] of await runModes(DELTA_MODES)) {
      const found = installScriptFindings(result).filter((f) => f.packageName === 'lodash');
      expect({ mode, found: found.map((f) => [f.severity, f.details?.signal]) }).toEqual({
        mode,
        found: [['high', 'flag-acquired']],
      });
    }
  });

  test('control: a flagged alias bumped within its own tarball name stays silent', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    const dependent = { ...MS_ENTRY, dependencies: { lodash: 'npm:isexe@*' } };
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ms': dependent, 'node_modules/lodash': { name: 'isexe', ...entry('isexe', '2.0.0', true) } })
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ms': dependent, 'node_modules/lodash': { name: 'isexe', ...entry('isexe', '2.0.1', true) } })
    );
    await commit('head');

    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, found: installScriptFindings(result).filter((f) => f.details?.signal === 'flag-acquired') }).toEqual({
        mode,
        found: [],
      });
    }
  });

  test('control: a bump of a flagged entry stays silent beside an unflagged copy, with no note', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    const packages = {
      'node_modules/ms': MS_ENTRY,
      'node_modules/esbuild': entry('esbuild', '0.20.0', true),
      'node_modules/ms/node_modules/esbuild': entry('esbuild', '0.18.0', false),
    };
    await write('package-lock.json', npmLock(packages));
    await tagBase();
    await write('package-lock.json', npmLock({ ...packages, 'node_modules/esbuild': entry('esbuild', '0.21.0', true) }));
    await commit('head');

    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, found: installScriptFindings(result), notes: ambiguityNotes(result) }).toEqual({
        mode,
        found: [],
        notes: [],
      });
    }
  });

  test('control: a new nested copy of a package that already ran scripts stays silent', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    const packages = { 'node_modules/ms': MS_ENTRY, 'node_modules/esbuild': entry('esbuild', '0.21.0', true) };
    await write('package-lock.json', npmLock(packages));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({ ...packages, 'node_modules/ms/node_modules/esbuild': entry('esbuild', '0.18.0', true) })
    );
    await commit('head');

    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, found: installScriptFindings(result), notes: ambiguityNotes(result) }).toEqual({
        mode,
        found: [],
        notes: [],
      });
    }
  });
});
