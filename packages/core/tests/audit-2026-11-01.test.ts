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

// The 2026-11-01 cohesion audit's reproductions (MB1), each in every mode
// it applies to.
//
// MB1: a lock entry was paired with the base lockfile by installed name
// alone, so an entry at a path the base never had counted as "changed"
// whenever any entry of that name sat at any other path, and a changed
// entry's key was never name-checked. With an npm alias in the base (an
// entry keyed by the alias name whose name field is another package), a
// head that adds a nested registry entry of the alias name installed that
// registry package with no name check. The entry is now paired by its
// packages-map path: an entry at a path the base did not have is added for
// the name checks, and a changed entry keeps the key exemption only when
// the base entry at that path installed the key's own package from the
// registry.
//
// The lockfiles below are the shapes npm 10 writes for the audit's x1 and
// x2 fixtures (npm install --package-lock-only, then the audit's lockfile
// edit), with the audit's crossenv and cross-env written as lodahs and
// lodash, which the fixture corpus knows. In the audit's scratch run,
// npm ci --ignore-scripts on x2 t1 installed the security holding package
// at node_modules/which/node_modules/crossenv.

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

function npmLock(packages: Record<string, Record<string, unknown>>, rootDependencies: Record<string, string>): string {
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

// The alias npm writes for "lodahs": "npm:lodash@4.17.21": keyed by the
// alias, with the target in its own name field and the target's tarball.
const ALIAS_ENTRY = { name: 'lodash', ...registryEntry('lodash', '4.17.21') };

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

// Every mode blocks, with a lodahs name finding anchored on the lockfile.
// (With the shipped corpus, the audit's crossenv is a critical typosquat.)
async function expectLockNameBlocked(modes: readonly Mode[]): Promise<Map<Mode, ScanResult>> {
  const results = await runModes(modes);
  for (const [mode, result] of results) {
    const found = nameFindings(result, 'lodahs');
    expect({ mode, anchors: [...new Set(found.map((finding) => finding.manifestPath))] }).toEqual({
      mode,
      anchors: ['package-lock.json'],
    });
    expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 1 });
  }
  return results;
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-audit-1101-'));
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

describe('MB1 an entry at a path the base did not have is name-checked, whatever other paths carry the name', () => {
  // x2 t1: the base installs an alias under ms (a transitive alias, the
  // shape @isaacs/cliui's string-width-cjs takes in real lockfiles); the
  // head, lockfile only, adds a nested registry entry of the alias name
  // under which.
  test('MB1 t1 a nested registry entry beside a transitive alias of the same key is name-checked', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    const basePackages = {
      'node_modules/isexe': registryEntry('isexe', '2.0.0'),
      'node_modules/lodahs': ALIAS_ENTRY,
      'node_modules/ms': registryEntry('ms', '2.1.3', { dependencies: { lodahs: 'npm:lodash@4.17.21' } }),
      'node_modules/which': registryEntry('which', '2.0.2', { dependencies: { isexe: '^2.0.0' } }),
    };
    await write('package-lock.json', npmLock(basePackages, { ms: '2.1.3' }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          ...basePackages,
          'node_modules/which/node_modules/lodahs': registryEntry('lodahs', '0.0.2-security'),
          'node_modules/which': registryEntry('which', '2.0.2', { dependencies: { lodahs: '0.0.2-security', isexe: '^2.0.0' } }),
        },
        { ms: '2.1.3' }
      )
    );
    await commit('head');

    await expectLockNameBlocked(ALL_MODES);
  });

  // The rule is by path, not by what the other path held: even when the
  // base installed the same registry package at another path, a new path
  // is a new install and its name is checked. This is the case that costs
  // extra online lookups (a new nested copy of an existing name).
  test('MB1 a registry entry at a new path is name-checked even when another path installs the same package', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    const basePackages = {
      'node_modules/lodahs': registryEntry('lodahs', '1.0.0'),
      'node_modules/ms': registryEntry('ms', '2.1.3', { dependencies: { lodahs: '^1.0.0' } }),
      'node_modules/which': registryEntry('which', '2.0.2'),
    };
    await write('package-lock.json', npmLock(basePackages, { ms: '2.1.3' }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          ...basePackages,
          'node_modules/which': registryEntry('which', '2.0.2', { dependencies: { lodahs: '2.0.0' } }),
          'node_modules/which/node_modules/lodahs': registryEntry('lodahs', '2.0.0'),
        },
        { ms: '2.1.3' }
      )
    );
    await commit('head');

    await expectLockNameBlocked(DELTA_MODES);
  });

  // x1 a1: the base declares the alias in the manifest; the head drops the
  // line and adds a nested registry entry of the alias name under ms.
  test('MB1 a1 dropping a declared alias and adding a nested registry entry of its key is name-checked', async () => {
    await write('package.json', pkg({ ms: '2.1.3', lodahs: 'npm:lodash@4.17.21' }));
    await write(
      'package-lock.json',
      npmLock(
        { 'node_modules/lodahs': ALIAS_ENTRY, 'node_modules/ms': registryEntry('ms', '2.1.3') },
        { lodahs: 'npm:lodash@4.17.21', ms: '2.1.3' }
      )
    );
    await tagBase();
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/ms': registryEntry('ms', '2.1.3', { dependencies: { lodahs: '0.0.2-security' } }),
          'node_modules/ms/node_modules/lodahs': registryEntry('lodahs', '0.0.2-security'),
        },
        { ms: '2.1.3' }
      )
    );
    await commit('head');

    await expectLockNameBlocked(DELTA_MODES);
  });

  // The same-path form: the base entry at node_modules/lodahs installed
  // lodash (an alias); the head rewrites that same entry into a plain
  // registry entry of lodahs. The base entry at the path did not install
  // the key's own package, so the key is checked.
  test('MB1 a same-path entry whose base installed an alias target is name-checked by its key', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodahs': ALIAS_ENTRY,
          'node_modules/ms': registryEntry('ms', '2.1.3', { dependencies: { lodahs: 'npm:lodash@4.17.21' } }),
        },
        { ms: '2.1.3' }
      )
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodahs': registryEntry('lodahs', '0.0.2-security'),
          'node_modules/ms': registryEntry('ms', '2.1.3', { dependencies: { lodahs: '0.0.2-security' } }),
        },
        { ms: '2.1.3' }
      )
    );
    await commit('head');

    await expectLockNameBlocked(DELTA_MODES);
  });

  // With no resolved, npm installs the name field's package by name and
  // version (audit 2026-10-28, B2), so that base entry installed lodash.
  test('MB1 a same-path entry whose base had a name field and no resolved is name-checked by its key', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodahs': { name: 'lodash', version: '4.17.21', integrity: 'sha512-lodash4.17.21' },
          'node_modules/ms': registryEntry('ms', '2.1.3', { dependencies: { lodahs: 'npm:lodash@4.17.21' } }),
        },
        { ms: '2.1.3' }
      )
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodahs': registryEntry('lodahs', '0.0.2-security'),
          'node_modules/ms': registryEntry('ms', '2.1.3', { dependencies: { lodahs: '0.0.2-security' } }),
        },
        { ms: '2.1.3' }
      )
    );
    await commit('head');

    await expectLockNameBlocked(DELTA_MODES);
  });

  // Review of the fix, B1 (fixture ib2): a bundled entry ships inside its
  // parent's tarball and has no resolved URL, but it was never fetched
  // from a registry by name. The same path made a registry entry is a
  // first registry install of the key.
  test('MB1 ib2 a same-path entry whose base was bundled is name-checked by its key', async () => {
    await write('package.json', pkg({ which: '2.0.2' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/which': registryEntry('which', '2.0.2', {
            bundleDependencies: ['lodahs'],
            dependencies: { lodahs: '1.0.0' },
          }),
          'node_modules/which/node_modules/lodahs': { version: '1.0.0', inBundle: true },
        },
        { which: '2.0.2' }
      )
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/which': registryEntry('which', '2.0.2', { dependencies: { lodahs: '0.0.2-security' } }),
          'node_modules/which/node_modules/lodahs': registryEntry('lodahs', '0.0.2-security'),
        },
        { which: '2.0.2' }
      )
    );
    await commit('head');

    await expectLockNameBlocked(DELTA_MODES);
  });

  // Review of the fix, B1 (fixture ib3): an entry with no resolved at a new
  // path, the same version as a bundled entry elsewhere. Bundled and
  // fetched by name are different resolutions, so the new entry is not
  // dropped as unchanged before any check sees it.
  test('MB1 ib3 an unresolved entry at a new path beside a bundled one of the same version is name-checked', async () => {
    await write('package.json', pkg({ which: '2.0.2' }));
    const bundled = {
      'node_modules/which': registryEntry('which', '2.0.2', {
        bundleDependencies: ['lodahs'],
        dependencies: { lodahs: '0.0.2-security' },
      }),
      'node_modules/which/node_modules/lodahs': { version: '0.0.2-security', inBundle: true },
    };
    await write(
      'package-lock.json',
      npmLock({ ...bundled, 'node_modules/isexe': registryEntry('isexe', '2.0.0') }, { which: '2.0.2' })
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          ...bundled,
          'node_modules/isexe': registryEntry('isexe', '2.0.0', { dependencies: { lodahs: '0.0.2-security' } }),
          'node_modules/lodahs': { version: '0.0.2-security' },
        },
        { which: '2.0.2' }
      )
    );
    await commit('head');

    await expectLockNameBlocked(DELTA_MODES);
  });

  // Review of the fix, B2 (fixture fl): the name field is exempt only when
  // the base entry at the same path installed that name from a registry. A
  // git entry carrying the same field installed it from git, so the field
  // switched to a registry tarball is a first registry install of it (0.18.0
  // checked it; the first version of this fix did not).
  test('MB1 fl a same-path name field the base installed from git is name-checked when it moves to the registry', async () => {
    const field = 'corp-internal-utils-xyz';
    await write('package.json', pkg({ ms: '2.1.3', which: '2.0.2' }));
    const common = {
      'node_modules/debug': registryEntry('debug', '4.3.4'),
      'node_modules/ms': registryEntry('ms', '2.1.3', { dependencies: { debug: '4.3.4' } }),
    };
    await write(
      'package-lock.json',
      npmLock(
        {
          ...common,
          'node_modules/which': registryEntry('which', '2.0.2', { dependencies: { debug: `github:corp/${field}` } }),
          'node_modules/which/node_modules/debug': {
            name: field,
            version: '1.0.0',
            resolved: `git+ssh://git@github.com/corp/${field}.git#5f0c6a1e2b3c4d5e6f708192a3b4c5d6e7f80912`,
          },
        },
        { ms: '2.1.3', which: '2.0.2' }
      )
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          ...common,
          'node_modules/which': registryEntry('which', '2.0.2', { dependencies: { debug: `npm:${field}@4.3.4` } }),
          'node_modules/which/node_modules/debug': { name: field, ...registryEntry(field, '4.3.4') },
        },
        { ms: '2.1.3', which: '2.0.2' }
      )
    );
    await commit('head');

    const results = await runModes(DELTA_MODES);
    for (const [mode, result] of results) {
      const unknown = result.findings.filter(
        (finding) => finding.packageName === field && finding.ruleId === 'unknown-package'
      );
      expect({ mode, unknown: unknown.map((finding) => finding.manifestPath) }).toEqual({
        mode,
        unknown: ['package-lock.json'],
      });
      expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 1 });
    }
  });

  // A base entry with no name field whose registry tarball is another
  // package's did not install the key either.
  test('MB1 a same-path entry whose base tarball named another package is name-checked by its key', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    const lodashTarball = registryEntry('lodash', '4.17.21');
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodahs': { ...lodashTarball, version: '1.0.0' },
          'node_modules/ms': registryEntry('ms', '2.1.3', { dependencies: { lodahs: '1.0.0' } }),
        },
        { ms: '2.1.3' }
      )
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodahs': registryEntry('lodahs', '1.0.1'),
          'node_modules/ms': registryEntry('ms', '2.1.3', { dependencies: { lodahs: '1.0.1' } }),
        },
        { ms: '2.1.3' }
      )
    );
    await commit('head');

    await expectLockNameBlocked(DELTA_MODES);
  });

  // A base entry at the same path that resolved from git did not install
  // the key from the registry.
  test('MB1 a same-path entry that moves from git to the registry is name-checked by its key', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodahs': {
            version: '1.0.0',
            resolved: 'git+ssh://git@github.com/corp/lodahs.git#5f0c6a1e2b3c4d5e6f708192a3b4c5d6e7f80912',
          },
          'node_modules/ms': registryEntry('ms', '2.1.3', { dependencies: { lodahs: 'github:corp/lodahs' } }),
        },
        { ms: '2.1.3' }
      )
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodahs': registryEntry('lodahs', '1.0.0'),
          'node_modules/ms': registryEntry('ms', '2.1.3', { dependencies: { lodahs: '1.0.0' } }),
        },
        { ms: '2.1.3' }
      )
    );
    await commit('head');

    await expectLockNameBlocked(DELTA_MODES);
  });
});

describe('MB1 controls', () => {
  // x2 a2: the alias line stays in the manifest, so the nested entry is
  // declared and its tarball is held to the alias target.
  test('MB1 a2 a kept alias declaration still raises tarball identity on a nested entry of its key', async () => {
    await write('package.json', pkg({ ms: '2.1.3', lodahs: 'npm:lodash@4.17.21' }));
    const basePackages = {
      'node_modules/lodahs': ALIAS_ENTRY,
      'node_modules/ms': registryEntry('ms', '2.1.3'),
    };
    await write('package-lock.json', npmLock(basePackages, { lodahs: 'npm:lodash@4.17.21', ms: '2.1.3' }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          ...basePackages,
          'node_modules/ms': registryEntry('ms', '2.1.3', { dependencies: { lodahs: '0.0.2-security' } }),
          'node_modules/ms/node_modules/lodahs': registryEntry('lodahs', '0.0.2-security'),
        },
        { lodahs: 'npm:lodash@4.17.21', ms: '2.1.3' }
      )
    );
    await commit('head');

    const results = await runModes(DELTA_MODES);
    for (const [mode, result] of results) {
      const tamper = result.findings.filter(
        (finding) => finding.ruleId === 'lockfile-tamper' && finding.severity === 'critical'
      );
      expect({ mode, tamper: tamper.length > 0 }).toEqual({ mode, tamper: true });
      expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 1 });
    }
  });

  // x1 g1 and f1: a base entry of the name resolved from git or a file:
  // tarball; the head adds a nested registry entry of it. The host change
  // is still reported, and the new path is now name-checked as well.
  for (const [label, baseEntry, spec] of [
    [
      'g1 git',
      { version: '1.0.0', resolved: 'git+ssh://git@github.com/corp/lodahs.git#5f0c6a1e2b3c4d5e6f708192a3b4c5d6e7f80912' },
      'github:corp/lodahs#5f0c6a1e2b3c4d5e6f708192a3b4c5d6e7f80912',
    ],
    ['f1 file: tarball', { version: '1.0.0', resolved: 'file:vendor/lodahs-1.0.0.tgz', integrity: 'sha512-x' }, 'file:vendor/lodahs-1.0.0.tgz'],
  ] as const) {
    test(`MB1 ${label} a base entry from another origin still raises host-changed beside the name check`, async () => {
      await write('package.json', pkg({ ms: '2.1.3', lodahs: spec }));
      await write(
        'package-lock.json',
        npmLock({ 'node_modules/lodahs': baseEntry, 'node_modules/ms': registryEntry('ms', '2.1.3') }, { lodahs: spec, ms: '2.1.3' })
      );
      await tagBase();
      await write('package.json', pkg({ ms: '2.1.3' }));
      await write(
        'package-lock.json',
        npmLock(
          {
            'node_modules/ms': registryEntry('ms', '2.1.3', { dependencies: { lodahs: '0.0.2-security' } }),
            'node_modules/ms/node_modules/lodahs': registryEntry('lodahs', '0.0.2-security'),
          },
          { ms: '2.1.3' }
        )
      );
      await commit('head');

      const results = await expectLockNameBlocked(DELTA_MODES);
      for (const [mode, result] of results) {
        const hostChanged = result.findings.filter(
          (finding) => finding.ruleId === 'lockfile-tamper' && /now resolves from origin/.test(finding.message)
        );
        expect({ mode, hostChanged: hostChanged.length > 0 }).toEqual({ mode, hostChanged: true });
      }
    });
  }

  // The exemption the fix keeps: the same path, a registry entry of the
  // key's own package on the base, bumped. Its name was judged when it was
  // added, and re-checking every transitive bump would spend the online
  // budget on refreshes.
  test('MB1 a same-path bump of a registry entry of the key is not name-checked again', async () => {
    await write('package.json', pkg({ ms: '2.1.3' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/ms': registryEntry('ms', '2.1.3', { dependencies: { lodahs: '^1.0.0' } }),
          'node_modules/ms/node_modules/lodahs': registryEntry('lodahs', '1.0.0'),
        },
        { ms: '2.1.3' }
      )
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/ms': registryEntry('ms', '2.1.3', { dependencies: { lodahs: '^1.0.0' } }),
          'node_modules/ms/node_modules/lodahs': registryEntry('lodahs', '1.0.1'),
        },
        { ms: '2.1.3' }
      )
    );
    await commit('head');

    const results = await runModes(DELTA_MODES);
    for (const [mode, result] of results) {
      expect({ mode, named: nameFindings(result, 'lodahs').length }).toEqual({ mode, named: 0 });
    }
  });
});
