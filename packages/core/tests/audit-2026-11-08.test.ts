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

// How the install-script flag on an npm lock entry is read. npm reads the
// flag by truthiness, so any value other than boolean false or no field at all
// is read as set, and a value that is not a boolean is reported as lockfile
// tampering as well, since npm itself only ever writes true.

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

function npmLock(
  packages: Record<string, Record<string, unknown>>,
  rootDependencies: Record<string, string> = { ms: '2.1.3' }
): string {
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

function signalsOf(result: ScanResult, prefix: string): string[] {
  return result.findings
    .filter((finding) => finding.ruleId === 'lockfile-tamper')
    .map((finding) => String(finding.details?.signal))
    .filter((signal) => signal.startsWith(prefix));
}

function installScriptShape(result: ScanResult): unknown[] {
  return result.findings
    .filter((finding) => finding.ruleId === 'install-script')
    .map((finding) => [finding.severity, finding.packageName, finding.details?.signal]);
}

const FLAG_SIGNAL = 'lockfile-install-flag-shape';
const UNKNOWN_EARLIER_CODE = 'delta-unknown-earlier-entry';

function unknownEarlierNotes(result: ScanResult): string[] {
  return result.run.diagnostics
    .filter((diagnostic) => diagnostic.code === UNKNOWN_EARLIER_CODE)
    .map((diagnostic) => diagnostic.message);
}

function nameMismatches(result: ScanResult): string[] {
  return signalsOf(result, 'tarball-name-mismatch');
}

function nameFindings(result: ScanResult, name: string): ScanResult['findings'] {
  return result.findings.filter(
    (finding) => finding.packageName === name && ['typosquat', 'unknown-package'].includes(finding.ruleId)
  );
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-audit-1108-'));
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

describe('an install-script flag that is not a boolean is read as set, and is lockfile tampering', () => {
  test('a non-boolean flag on a workspace directory entry is the tamper finding too', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': MS_ENTRY,
        'node_modules/a': { resolved: 'packages/a', link: true },
        'packages/a': { name: 'a', version: '1.0.0', hasInstallScript: 'yes' },
      })
    );
    await commit('head');
    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect({
        mode,
        workspace: signalsOf(result, FLAG_SIGNAL).filter((signal) => signal.startsWith(`${FLAG_SIGNAL}:packages/a:`)).length,
      }).toEqual({ mode, workspace: 1 });
    }
  });

  // A new nested entry carrying the flag value given, on top of a base with ms only.
  async function newNestedEntry(flag: unknown): Promise<void> {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': MS_ENTRY,
        'node_modules/ms/node_modules/core-js': registryEntry('core-js', '3.38.1', { hasInstallScript: flag }),
      })
    );
    await commit('head');
  }

  // A same-path bump of an unflagged entry to a version carrying the flag value given.
  async function bumpedEntry(flag: unknown): Promise<void> {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ms': MS_ENTRY, 'node_modules/core-js': registryEntry('core-js', '3.38.0') })
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': MS_ENTRY,
        'node_modules/core-js': registryEntry('core-js', '3.38.1', { hasInstallScript: flag }),
      })
    );
    await commit('head');
  }

  async function shapesFor(setup: (flag: unknown) => Promise<void>, flag: unknown): Promise<Map<Mode, ScanResult>> {
    await setup(flag);
    return runModes(ALL_MODES);
  }

  async function freshRepo(): Promise<void> {
    repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-audit-1108-'));
    tempDirs.push(repo);
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.invalid');
    await git('config', 'user.name', 'dep guard test');
    await git('config', 'commit.gpgsign', 'false');
  }

  test.each([
    ['the string "true" on a new entry', 'true', 'new'],
    ['the string "false" on a new entry', 'false', 'new'],
    ['the number 1 on a new entry', 1, 'new'],
    ['the string "yes" on a same-path bump', 'yes', 'bump'],
    ['the string "false" on a same-path bump', 'false', 'bump'],
  ])('%s gives the install-script finding a boolean true gives, plus the tamper finding', async (_label, flag, shape) => {
    const setup = shape === 'new' ? newNestedEntry : bumpedEntry;
    const control = await shapesFor(setup, true);
    await freshRepo();
    const results = await shapesFor(setup, flag);

    for (const [mode, result] of results) {
      const expected = installScriptShape(control.get(mode) as ScanResult);
      expect({ mode, expectedNonEmpty: expected.length > 0 }).toEqual({ mode, expectedNonEmpty: true });
      expect({ mode, found: installScriptShape(result) }).toEqual({ mode, found: expected });
      const tamper = result.findings.filter((f) => String(f.details?.signal).startsWith(FLAG_SIGNAL));
      expect({ mode, tamper: tamper.map((f) => [f.ruleId, f.severity, f.packageName, f.manifestPath]) }).toEqual({
        mode,
        tamper: [['lockfile-tamper', 'critical', 'core-js', 'package-lock.json']],
      });
      expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 1 });
      // The boolean control carries no tamper finding.
      expect({ mode, control: signalsOf(control.get(mode) as ScanResult, FLAG_SIGNAL) }).toEqual({ mode, control: [] });
    }
  });

  test.each([
    ['the number 0', 0],
    ['null', null],
    ['the empty string', ''],
  ])('%s, falsy to npm, runs nothing and is no install script, but is the tamper finding', async (_label, flag) => {
    await newNestedEntry(flag);
    for (const [mode, result] of await runModes(ALL_MODES)) {
      const tamper = result.findings.filter((f) => String(f.details?.signal).startsWith(FLAG_SIGNAL));
      expect({
        mode,
        found: installScriptShape(result),
        tamper: tamper.map((f) => [f.ruleId, f.severity, f.packageName]),
        exit: result.exitCode,
      }).toEqual({ mode, found: [], tamper: [['lockfile-tamper', 'critical', 'core-js']], exit: 1 });
    }
  });

  test('an allow entry for the package does not clear the tamper finding', async () => {
    await write('.dep-guard.json', JSON.stringify({ allow: ['core-js'] }));
    await newNestedEntry('true');
    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect({ mode, tamper: signalsOf(result, FLAG_SIGNAL).length, exit: result.exitCode }).toEqual({
        mode,
        tamper: 1,
        exit: 1,
      });
    }
  });

  test('a changed non-boolean value gets a different signal, and the signal holds no value', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': MS_ENTRY,
        'node_modules/core-js': registryEntry('core-js', '3.38.1', { hasInstallScript: 'marker-one' }),
      })
    );
    await tagBase();
    const before = signalsOf((await runModes(['audit'])).get('audit') as ScanResult, FLAG_SIGNAL);
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': MS_ENTRY,
        'node_modules/core-js': registryEntry('core-js', '3.38.1', { hasInstallScript: 'marker-two' }),
      })
    );
    await commit('head');
    const results = await runModes(['audit', 'base']);
    const after = signalsOf(results.get('audit') as ScanResult, FLAG_SIGNAL);
    expect(before.length).toBe(1);
    expect(after.length).toBe(1);
    expect(after[0]).not.toEqual(before[0]);
    expect(signalsOf(results.get('base') as ScanResult, FLAG_SIGNAL).length).toBe(1);
    expect(JSON.stringify((results.get('base') as ScanResult).findings)).not.toContain('marker-two');
  });

  test('a delta install-script finding for the non-boolean flag blocks at high', async () => {
    await newNestedEntry('true');
    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, found: installScriptShape(result) }).toEqual({ mode, found: [['high', 'core-js', 'added']] });
    }
  });

  test('an earlier entry whose flag is a non-boolean truthy value counts as having run scripts', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': MS_ENTRY,
        'node_modules/core-js': registryEntry('core-js', '3.38.0', { hasInstallScript: 'true' }),
      })
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': MS_ENTRY,
        'node_modules/core-js': registryEntry('core-js', '3.38.1', { hasInstallScript: true }),
      })
    );
    await commit('head');

    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, found: installScriptShape(result), tamper: signalsOf(result, FLAG_SIGNAL) }).toEqual({
        mode,
        found: [],
        tamper: [],
      });
    }
  });

  test('the same non-boolean value on the comparison side is not new, and audit mode still states it', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': MS_ENTRY,
        'node_modules/core-js': registryEntry('core-js', '3.38.1', { hasInstallScript: 1 }),
      })
    );
    await tagBase();
    await write('README.md', 'unrelated\n');
    await commit('head');

    const results = await runModes(['audit', 'base']);
    expect(signalsOf(results.get('audit') as ScanResult, FLAG_SIGNAL).length).toBe(1);
    expect(signalsOf(results.get('base') as ScanResult, FLAG_SIGNAL)).toEqual([]);
  });

  test.each([
    ['boolean false', false],
    ['no field at all', undefined],
  ])('control: %s is no install script and no tamper finding', async (_label, flag) => {
    await newNestedEntry(flag);
    for (const [mode, result] of await runModes(ALL_MODES)) {
      expect({ mode, found: installScriptShape(result), tamper: signalsOf(result, FLAG_SIGNAL) }).toEqual({
        mode,
        found: [],
        tamper: [],
      });
    }
  });
});

describe('an earlier entry with no resolved, no integrity and no flag is unknown, not a baseline', () => {
  // The shape of a lockfile written without resolution metadata: npm records an
  // entry this way when it did not fetch it, for instance an optional platform
  // package on another platform, or a file written by an older client.
  const bare = (version: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    version,
    license: 'MIT',
    ...extra,
  });
  const ALIAS_EDGES = { 'string-width-cjs': 'npm:string-width@^4.2.0', 'strip-ansi-cjs': 'npm:strip-ansi@^6.0.1' };
  const FSEVENTS_SHAPE = { optional: true, os: ['darwin'] };

  async function regeneration(head: Record<string, Record<string, unknown>>): Promise<void> {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': bare('2.1.3', { dependencies: ALIAS_EDGES }),
        'node_modules/string-width-cjs': bare('4.2.3', { name: 'string-width' }),
        'node_modules/strip-ansi-cjs': bare('6.0.1', { name: 'strip-ansi' }),
        'node_modules/fsevents': bare('2.3.3', FSEVENTS_SHAPE),
      })
    );
    await tagBase();
    await write('package-lock.json', npmLock(head));
    await commit('head');
  }

  const REGENERATED = {
    'node_modules/ms': { ...MS_ENTRY, dependencies: ALIAS_EDGES },
    'node_modules/string-width-cjs': { name: 'string-width', ...registryEntry('string-width', '4.2.3') },
    'node_modules/strip-ansi-cjs': { name: 'strip-ansi', ...registryEntry('strip-ansi', '6.0.1') },
    'node_modules/fsevents': registryEntry('fsevents', '2.3.3', { hasInstallScript: true, ...FSEVENTS_SHAPE }),
  };

  test('a regeneration that adds metadata to genuine aliases and a platform package is notes, not findings', async () => {
    await regeneration(REGENERATED);
    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, mismatches: nameMismatches(result), installScripts: installScriptShape(result) }).toEqual({
        mode,
        mismatches: [],
        installScripts: [],
      });
      const notes = unknownEarlierNotes(result);
      expect({ mode, notes: notes.length }).toEqual({ mode, notes: 3 });
      for (const name of ['string-width-cjs', 'strip-ansi-cjs', 'fsevents']) {
        expect({ mode, name, noted: notes.some((note) => note.includes(`"${name}"`)) }).toEqual({ mode, name, noted: true });
      }
    }
  });

  test('a tarball naming another package with no alias edge for it is still a mismatch', async () => {
    await regeneration({
      ...REGENERATED,
      'node_modules/string-width-cjs': { name: 'string-width', ...registryEntry('lodahs', '4.2.3') },
    });
    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, mismatches: nameMismatches(result) }).toEqual({ mode, mismatches: ['tarball-name-mismatch:lodahs'] });
    }
  });

  test('an alias edge retargeted with the entry to a squat still has the squat name-checked', async () => {
    await regeneration({
      ...REGENERATED,
      'node_modules/ms': { ...MS_ENTRY, dependencies: { ...ALIAS_EDGES, 'string-width-cjs': 'npm:lodahs@^4.2.0' } },
      'node_modules/string-width-cjs': { name: 'lodahs', ...registryEntry('lodahs', '4.2.3') },
    });
    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, squat: nameFindings(result, 'lodahs').length > 0, exit: result.exitCode }).toEqual({
        mode,
        squat: true,
        exit: 1,
      });
    }
  });

  test('a flag that appears with a version bump is still an acquisition', async () => {
    await regeneration({
      ...REGENERATED,
      'node_modules/fsevents': registryEntry('fsevents', '2.3.4', { hasInstallScript: true, ...FSEVENTS_SHAPE }),
    });
    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, found: installScriptShape(result) }).toEqual({ mode, found: [['high', 'fsevents', 'flag-acquired']] });
    }
  });

  test('a flag that appears on a tarball of another package is still an acquisition', async () => {
    await regeneration({
      ...REGENERATED,
      'node_modules/fsevents': registryEntry('lodash', '2.3.3', { hasInstallScript: true, ...FSEVENTS_SHAPE }),
    });
    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, found: installScriptShape(result).filter((f) => (f as unknown[])[1] === 'fsevents') }).toEqual({
        mode,
        found: [['high', 'fsevents', 'flag-acquired']],
      });
    }
  });

  test('control: an earlier entry with an integrity hash is a baseline, and its flag acquisition is reported', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': MS_ENTRY,
        'node_modules/fsevents': bare('2.3.3', { integrity: 'sha512-fsevents2.3.3', ...FSEVENTS_SHAPE }),
      })
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': MS_ENTRY,
        'node_modules/fsevents': registryEntry('fsevents', '2.3.3', { hasInstallScript: true, ...FSEVENTS_SHAPE }),
      })
    );
    await commit('head');
    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, found: installScriptShape(result), notes: unknownEarlierNotes(result) }).toEqual({
        mode,
        found: [['high', 'fsevents', 'flag-acquired']],
        notes: [],
      });
    }
  });

  test('control: an earlier entry with a resolved URL and no alias edge keeps the mismatch', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ms': MS_ENTRY, 'node_modules/string-width-cjs': registryEntry('string-width-cjs', '4.2.3') })
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': { ...MS_ENTRY, dependencies: ALIAS_EDGES },
        'node_modules/string-width-cjs': { name: 'string-width', ...registryEntry('string-width', '4.2.3') },
      })
    );
    await commit('head');
    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, mismatches: nameMismatches(result), notes: unknownEarlierNotes(result) }).toEqual({
        mode,
        mismatches: ['tarball-name-mismatch:string-width'],
        notes: [],
      });
    }
  });

  // The later entry of an unknown earlier one is judged as an added entry is,
  // where it comes from included.
  const OFF_HOST = 'http://127.0.0.1:4873/ms/-/ms-2.1.3.tgz';

  async function repointedMs(extra: Record<string, unknown>): Promise<void> {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': bare('2.1.3') }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ms': { ...registryEntry('ms', '2.1.3'), resolved: OFF_HOST, ...extra } })
    );
    await commit('head');
  }

  test('a same-version entry that gains the flag on a host the project does not name is still an acquisition', async () => {
    await repointedMs({ hasInstallScript: true });
    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({
        mode,
        found: installScriptShape(result),
        source: signalsOf(result, 'url-source'),
        notes: unknownEarlierNotes(result),
        exit: result.exitCode,
      }).toEqual({ mode, found: [['high', 'ms', 'flag-acquired']], source: ['url-source:127.0.0.1:4873'], notes: [], exit: 1 });
    }
  });

  test('a same-version entry moved to a host the project does not name is reported as its source, flag or not', async () => {
    await repointedMs({});
    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, source: signalsOf(result, 'url-source'), exit: result.exitCode }).toEqual({
        mode,
        source: ['url-source:127.0.0.1:4873'],
        exit: 1,
      });
    }
  });

  test('control: a same-version entry that gains the flag on a registry the project .npmrc names is a note', async () => {
    await write('.npmrc', 'registry=https://npm.example.test/\n');
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': bare('2.1.3') }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': {
          ...registryEntry('ms', '2.1.3'),
          resolved: 'https://npm.example.test/ms/-/ms-2.1.3.tgz',
          hasInstallScript: true,
        },
      })
    );
    await commit('head');
    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({
        mode,
        found: installScriptShape(result),
        source: signalsOf(result, 'url-source'),
        notes: unknownEarlierNotes(result).length,
      }).toEqual({ mode, found: [], source: [], notes: 1 });
    }
  });

  test('an alias edge retargeted with the entry to another known package is still a mismatch', async () => {
    await regeneration({
      ...REGENERATED,
      'node_modules/ms': { ...MS_ENTRY, dependencies: { ...ALIAS_EDGES, 'string-width-cjs': 'npm:ms@^2.1.3' } },
      'node_modules/string-width-cjs': { name: 'ms', ...registryEntry('ms', '2.1.3') },
    });
    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, mismatches: nameMismatches(result), exit: result.exitCode }).toEqual({
        mode,
        mismatches: ['tarball-name-mismatch:ms'],
        exit: 1,
      });
    }
  });

  test.each([
    ['a bundled earlier entry', { inBundle: true }],
    ['an earlier entry whose location could not be read', { _resolved: 'https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz' }],
  ])('control: %s is a baseline, and its flag acquisition is reported', async (_label, shape) => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ms': MS_ENTRY, 'node_modules/fsevents': bare('2.3.3', { ...shape, ...FSEVENTS_SHAPE }) })
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/ms': MS_ENTRY,
        'node_modules/fsevents': registryEntry('fsevents', '2.3.3', { hasInstallScript: true, ...FSEVENTS_SHAPE }),
      })
    );
    await commit('head');
    for (const [mode, result] of await runModes(DELTA_MODES)) {
      expect({ mode, found: installScriptShape(result), notes: unknownEarlierNotes(result) }).toEqual({
        mode,
        found: [['high', 'fsevents', 'flag-acquired']],
        notes: [],
      });
    }
  });
});

describe('a version with no resolved must be plain semver to its end', () => {
  test.each([
    ['text after the patch number', '1.2.3x'],
    ['a range after a version', '1.2.3 || 2'],
  ])('%s is an unread location', async (_label, version) => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ms': MS_ENTRY, 'node_modules/ms/node_modules/lodash': { version, license: 'MIT' } })
    );
    await commit('head');
    for (const [mode, result] of await runModes(['audit', 'base'])) {
      expect({ mode, signals: signalsOf(result, 'lockfile-location-shape').length }).toEqual({ mode, signals: 1 });
    }
  });

  test('control: a plain semver with prerelease and build parts is not', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ms': MS_ENTRY, 'node_modules/ms/node_modules/lodash': { version: '1.2.3-rc.1+b.2', license: 'MIT' } })
    );
    await commit('head');
    for (const [mode, result] of await runModes(['audit', 'base'])) {
      expect({ mode, signals: signalsOf(result, 'lockfile-location-shape') }).toEqual({ mode, signals: [] });
    }
  });
});

describe('a local replace ref does not change what the trust base reads', () => {
  test('the trust base reads the real base commit, not the object a replace ref swaps in for it', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await write('.dep-guard.json', JSON.stringify({}));
    await tagBase();
    const baseSha = (await git('rev-parse', 'base')).trim();

    // A parentless commit whose config allows the name the head adds.
    await git('checkout', '-q', '--orphan', 'side');
    await write('.dep-guard.json', JSON.stringify({ allow: ['lodahs'] }));
    await commit('replacement');
    const replacement = (await git('rev-parse', 'HEAD')).trim();

    await git('checkout', '-q', '-f', 'main');
    await write('package.json', pkg({ ms: '2.1.3', lodahs: '1.0.0' }));
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ms': MS_ENTRY, 'node_modules/lodahs': registryEntry('lodahs') }, { ms: '2.1.3', lodahs: '1.0.0' })
    );
    await commit('head');
    await git('replace', baseSha, replacement);
    // The replace ref is live for an ordinary git read in this repository.
    expect(await git('show', `${baseSha}:.dep-guard.json`)).toContain('lodahs');

    // The staged modes are left out: building their fixture runs git reset
    // and read-tree against the base, which the replace ref would rewrite.
    for (const [mode, result] of await runModes(['trust'])) {
      expect({ mode, squat: nameFindings(result, 'lodahs').length > 0, exit: result.exitCode }).toEqual({
        mode,
        squat: true,
        exit: 1,
      });
    }
  });

  // A base whose files already hold what the head adds would make the change
  // look like no change at all.
  async function baseAndHead(): Promise<{ baseSha: string }> {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write('package-lock.json', npmLock({ 'node_modules/ms': MS_ENTRY }));
    await tagBase();
    const baseSha = (await git('rev-parse', 'base')).trim();
    await write('package.json', pkg({ ms: '2.1.3', lodahs: '1.0.0' }));
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ms': MS_ENTRY, 'node_modules/lodahs': registryEntry('lodahs') }, { ms: '2.1.3', lodahs: '1.0.0' })
    );
    await commit('head');
    return { baseSha };
  }

  async function expectBaseScanSeesTheChange(): Promise<void> {
    for (const [mode, result] of await runModes(['base'])) {
      expect({ mode, squat: nameFindings(result, 'lodahs').length > 0, exit: result.exitCode }).toEqual({
        mode,
        squat: true,
        exit: 1,
      });
    }
  }

  test('--base reads the real base commit, not a commit a replace ref swaps in for it', async () => {
    const { baseSha } = await baseAndHead();
    // A commit with the head's tree and no parent stands in for the base.
    const headTree = (await git('rev-parse', 'HEAD^{tree}')).trim();
    const replacement = (await git('commit-tree', headTree, '-m', 'replacement')).trim();
    await git('replace', baseSha, replacement);
    expect(await git('show', `${baseSha}:package.json`)).toContain('lodahs');
    await expectBaseScanSeesTheChange();
  });

  test('--base reads the real base files, not blobs a replace ref swaps in for them', async () => {
    await baseAndHead();
    for (const file of ['package.json', 'package-lock.json']) {
      const baseBlob = (await git('rev-parse', `base:${file}`)).trim();
      const headBlob = (await git('rev-parse', `HEAD:${file}`)).trim();
      await git('replace', baseBlob, headBlob);
    }
    expect(await git('show', 'base:package.json')).toContain('lodahs');
    await expectBaseScanSeesTheChange();
  });
});
