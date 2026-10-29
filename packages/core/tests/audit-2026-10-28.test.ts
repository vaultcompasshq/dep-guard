import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { jest } from '@jest/globals';
import { fingerprintFinding } from '../src/fingerprint.js';
import { scan } from '../src/scan.js';

// Each test runs up to five scans over a real git repository.
jest.setTimeout(60_000);

// The 2026-10-28 audit's reproductions, each in every mode it applies to:
// plain (audit), --base, --base with --trust-base, --staged and --staged
// with --trust-base.
//
// B1: an added lockfile entry was exempt from the name checks whenever ANY
// read manifest carried its name, whatever that declaration's protocol and
// whether its own finding survived ignorePaths. A "file:" declaration named
// after a malicious package, beside a nested registry entry of that name,
// scanned clean while npm installed the registry package. No declaration
// exempts an entry now (after the review of the fix: every narrower rule
// had a hole); one name in both walks is reported once.
//
// B2: an npm entry with a "name" field and no "resolved" installs the named
// package (npm builds the fetch spec from that name and the version), and
// only the key was name-checked.

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

function pkg(name: string, dependencies: Record<string, string>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name, version: '1.0.0', dependencies, ...extra });
}

function npmLock(packages: Record<string, Record<string, unknown>> = {}, root: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'app', version: '1.0.0', ...root }, ...packages },
  });
}

function registryEntry(name: string, version = '1.0.0'): Record<string, unknown> {
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: `sha512-${name}${version}`,
  };
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

function nameFindings(result: ScanResult, name: string): ScanResult['findings'] {
  return result.findings.filter(
    (finding) => finding.packageName === name && ['typosquat', 'unknown-package'].includes(finding.ruleId)
  );
}

// Every mode blocks, with a lodahs name finding anchored on `anchor`.
async function expectNameBlocked(modes: readonly Mode[], anchor: string): Promise<Map<Mode, ScanResult>> {
  const results = await runModes(modes);
  for (const [mode, result] of results) {
    const anchors = [...new Set(nameFindings(result, 'lodahs').map((finding) => finding.manifestPath))];
    expect({ mode, anchors }).toEqual({ mode, anchors: [anchor] });
    expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 1 });
  }
  return results;
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-audit-1028-'));
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

describe('B1 a lock entry is name-checked whatever manifest line carries its name', () => {
  // The audit's h4: a file: dependency named after the malicious package,
  // its npm link entry, and a registry entry of that name nested under
  // another package. npm 10 installs node_modules/react/node_modules/lodahs
  // from the registry.
  test('B1 a file: declaration beside a nested registry entry of the same name (npm)', async () => {
    await write('package.json', pkg('app', { react: '18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await tagBase();
    await write('package.json', pkg('app', { react: '18.0.0', lodahs: 'file:tools/lodahs' }));
    await write('tools/lodahs/package.json', pkg('lodahs', {}));
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/lodahs': { link: true, resolved: 'tools/lodahs' },
        'node_modules/react': { ...registryEntry('react', '18.0.0'), dependencies: { lodahs: '1.0.0' } },
        'node_modules/react/node_modules/lodahs': registryEntry('lodahs'),
        'tools/lodahs': { name: 'lodahs', version: '1.0.0' },
      })
    );
    await commit('head');

    await expectNameBlocked(ALL_MODES, 'package-lock.json');
  });

  test('B1 a link: declaration beside a registry entry of the same name (pnpm)', async () => {
    await write('package.json', pkg('app', { react: '18.0.0' }));
    await write(
      'pnpm-lock.yaml',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      react:\n        specifier: 18.0.0\n        version: 18.0.0\n" +
        'packages:\n  react@18.0.0:\n    resolution: {integrity: sha512-react}\n'
    );
    await tagBase();
    await write('package.json', pkg('app', { react: '18.0.0', lodahs: 'link:tools/lodahs' }));
    await write('tools/lodahs/package.json', pkg('lodahs', {}));
    await write(
      'pnpm-lock.yaml',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n" +
        '      lodahs:\n        specifier: link:tools/lodahs\n        version: link:tools/lodahs\n' +
        '      react:\n        specifier: 18.0.0\n        version: 18.0.0\n' +
        'packages:\n  lodahs@1.0.0:\n    resolution: {integrity: sha512-lodahs}\n' +
        '  react@18.0.0:\n    resolution: {integrity: sha512-react}\n'
    );
    await commit('head');

    await expectNameBlocked(ALL_MODES, 'pnpm-lock.yaml');
  });

  // The audit's h1: the declaring manifest is a stray the base's
  // ignorePaths covers, so its own finding is dropped; the lockfile entry
  // npm installs used to be re-anchored onto it and dropped with it.
  test('B1 a declaration in a manifest ignorePaths covers does not exempt the lock entry', async () => {
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['docs'] }));
    await write('package.json', pkg('app', { react: '18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await tagBase();
    await write('docs/example/package.json', pkg('example', { lodahs: '^1.0.0' }));
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react': { ...registryEntry('react', '18.0.0'), dependencies: { lodahs: '1.0.0' } },
        'node_modules/react/node_modules/lodahs': registryEntry('lodahs'),
      })
    );
    await commit('head');

    await expectNameBlocked(ALL_MODES, 'package-lock.json');
  });

  // The audit's h3: the ignored declaration was already on the base, so
  // the head adds only the lock entries. N5d's exemption (a declared name
  // the base already had) holds only for a declaration whose findings are
  // kept.
  test('B1 an ignored declaration already on the base does not exempt the lock entry', async () => {
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['docs'] }));
    await write('docs/example/package.json', pkg('example', { lodahs: '^1.0.0' }));
    await write('package.json', pkg('app', { react: '18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react': { ...registryEntry('react', '18.0.0'), dependencies: { lodahs: '1.0.0' } },
        'node_modules/react/node_modules/lodahs': registryEntry('lodahs'),
      })
    );
    await commit('head');

    await expectNameBlocked(ALL_MODES, 'package-lock.json');
  });

  // The workspace: form of B1 for npm: a real workspace member named
  // lodahs is linked, and a registry package of the same name is nested
  // under react. The member is local; the nested entry is not.
  test('B1 an npm workspace member does not exempt a registry entry of the same name', async () => {
    await write('package.json', pkg('app', { react: '18.0.0' }, { workspaces: ['packages/*'] }));
    await write('packages/lodahs/package.json', pkg('lodahs', {}));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodahs': { link: true, resolved: 'packages/lodahs' },
          'node_modules/react': registryEntry('react', '18.0.0'),
          'packages/lodahs': { name: 'lodahs', version: '1.0.0' },
        },
        { workspaces: ['packages/*'] }
      )
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodahs': { link: true, resolved: 'packages/lodahs' },
          'node_modules/react': { ...registryEntry('react', '18.0.0'), dependencies: { lodahs: '1.0.0' } },
          'node_modules/react/node_modules/lodahs': registryEntry('lodahs'),
          'packages/lodahs': { name: 'lodahs', version: '1.0.0' },
        },
        { workspaces: ['packages/*'] }
      )
    );
    await commit('head');

    await expectNameBlocked(DELTA_MODES, 'package-lock.json');
  });

  // npm gives a workspace sibling a plain version range, so the root's
  // "lodahs": "^1.0.0" reads as a registry line; the manifest walk skips it
  // as workspace-local, so it judges nothing and cannot exempt the
  // registry entry nested under react.
  test('B1 a registry-looking line for an npm workspace package does not exempt a registry entry', async () => {
    const workspace = { workspaces: ['packages/*'] };
    await write('package.json', pkg('app', { react: '18.0.0', lodahs: '^1.0.0' }, workspace));
    await write('packages/lodahs/package.json', pkg('lodahs', {}));
    const entries = {
      'node_modules/lodahs': { link: true, resolved: 'packages/lodahs' },
      'packages/lodahs': { name: 'lodahs', version: '1.0.0' },
    };
    await write('package-lock.json', npmLock({ ...entries, 'node_modules/react': registryEntry('react', '18.0.0') }, workspace));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          ...entries,
          'node_modules/react': { ...registryEntry('react', '18.0.0'), dependencies: { lodahs: '2.0.0' } },
          'node_modules/react/node_modules/lodahs': registryEntry('lodahs', '2.0.0'),
        },
        workspace
      )
    );
    await commit('head');

    await expectNameBlocked(DELTA_MODES, 'package-lock.json');
  });

  // An npm alias declaration judges its target, not its key: a nested
  // registry entry under the key's name installs a different package,
  // which nobody judged.
  test('B1 an alias declaration does not exempt a nested entry that installs the key name', async () => {
    await write('package.json', pkg('app', { react: '18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await tagBase();
    await write('package.json', pkg('app', { react: '18.0.0', lodahs: 'npm:lodash@4.17.21' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodahs': { ...registryEntry('lodash', '4.17.21'), name: 'lodash' },
          'node_modules/react': { ...registryEntry('react', '18.0.0'), dependencies: { lodahs: '1.0.0' } },
          'node_modules/react/node_modules/lodahs': registryEntry('lodahs'),
        },
        { dependencies: { react: '18.0.0', lodahs: 'npm:lodash@4.17.21' } }
      )
    );
    await commit('head');

    await expectNameBlocked(DELTA_MODES, 'package-lock.json');
  });

  // Controls: a registry declaration in a kept manifest still judges its
  // own entry, once, at the manifest (N5 and N5d in audit-2026-10-27).
  test('B1 a nested entry of a name a kept registry declaration judges is not checked twice', async () => {
    await write('package.json', pkg('app', { react: '18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await tagBase();
    await write('package.json', pkg('app', { react: '18.0.0', lodahs: '^1.0.0' }));
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/lodahs': registryEntry('lodahs', '1.1.0'),
        'node_modules/react': { ...registryEntry('react', '18.0.0'), dependencies: { lodahs: '1.0.0' } },
        'node_modules/react/node_modules/lodahs': registryEntry('lodahs'),
      })
    );
    await commit('head');

    await expectNameBlocked(DELTA_MODES, 'package.json');
  });
});

// N-b: the pnpm directory-version skip holds only with no tarball. Whether
// pnpm fetches the tarball for such an entry was not established, so the
// entry is judged as a registry name rather than assumed local.
describe('N-b a pnpm directory version with a registry tarball', () => {
  test('N-b a "file:" version carrying a registry tarball is name-checked', async () => {
    await write('package.json', pkg('app', {}));
    await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
    await tagBase();
    await write(
      'pnpm-lock.yaml',
      "lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n" +
        '  lodahs@file:libs/lodahs:\n' +
        '    resolution: {integrity: sha512-x, tarball: https://registry.npmjs.org/lodahs/-/lodahs-1.0.0.tgz}\n'
    );
    await commit('head');

    await expectNameBlocked(ALL_MODES, 'pnpm-lock.yaml');
  });
});

describe('B2 an npm entry installs the package its name field names when nothing resolves it', () => {
  // The audit's h5b: npm ci installs crossenv (here lodahs) into
  // node_modules/supports-color, building the fetch spec from the entry's
  // own name and version.
  test('B2 an added entry with a name field, an alias edge and no resolved', async () => {
    await write('package.json', pkg('app', { react: '18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react': {
          ...registryEntry('react', '18.0.0'),
          dependencies: { 'supports-color': 'npm:lodahs@1.0.0' },
        },
        'node_modules/supports-color': { name: 'lodahs', version: '1.0.0', integrity: 'sha512-lodahs' },
      })
    );
    await commit('head');

    const results = await expectNameBlocked(ALL_MODES, 'package-lock.json');
    for (const [mode, result] of results) {
      // The alias edge says the key is a folder name, not a package.
      expect({ mode, key: nameFindings(result, 'supports-color') }).toEqual({ mode, key: [] });
      // An alias npm records is not a substitution.
      const unvouched = result.findings.filter((finding) => String(finding.details?.signal).startsWith('name-field-unvouched'));
      expect({ mode, unvouched }).toEqual({ mode, unvouched: [] });
    }
  });

  test('B2 a name field with no alias edge is checked, and is lockfile tampering', async () => {
    await write('package.json', pkg('app', { react: '18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react': registryEntry('react', '18.0.0'),
        'node_modules/react/node_modules/supports-color': { name: 'lodahs', version: '1.0.0', integrity: 'sha512-lodahs' },
      })
    );
    await commit('head');

    const results = await expectNameBlocked(ALL_MODES, 'package-lock.json');
    for (const [mode, result] of results) {
      const tamper = result.findings.filter(
        (finding) => finding.ruleId === 'lockfile-tamper' && finding.details?.signal === 'name-field-unvouched:lodahs'
      );
      expect({ mode, tamper: tamper.map((finding) => [finding.packageName, finding.severity, finding.manifestPath]) }).toEqual({
        mode,
        tamper: [['supports-color', 'medium', 'package-lock.json']],
      });
    }
  });

  // A changed entry was skipped as "the base had the name already"; the
  // base had the key, and the package that installs under it is new.
  test('B2 a changed entry whose name field now names another package', async () => {
    await write('package.json', pkg('app', { react: '18.0.0' }));
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react': registryEntry('react', '18.0.0'),
        'node_modules/supports-color': registryEntry('supports-color', '7.2.0'),
      })
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react': {
          ...registryEntry('react', '18.0.0'),
          dependencies: { 'supports-color': 'npm:lodahs@1.0.0' },
        },
        'node_modules/supports-color': { name: 'lodahs', version: '1.0.0', integrity: 'sha512-lodahs' },
      })
    );
    await commit('head');

    await expectNameBlocked(DELTA_MODES, 'package-lock.json');
  });

  // Same version, same integrity, no resolved: only the name field moved,
  // and with it the package npm fetches.
  test('B2 an entry whose only change is its name field', async () => {
    await write('package.json', pkg('app', { react: '18.0.0' }));
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react': registryEntry('react', '18.0.0'),
        'node_modules/supports-color': { version: '1.0.0', integrity: 'sha512-same' },
      })
    );
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react': registryEntry('react', '18.0.0'),
        'node_modules/supports-color': { name: 'lodahs', version: '1.0.0', integrity: 'sha512-same' },
      })
    );
    await commit('head');

    await expectNameBlocked(DELTA_MODES, 'package-lock.json');
  });

  // Controls that already held before this fix: a resolved URL naming
  // another package is a critical tarball-identity finding whether or not
  // a manifest declares the key, and a genuine declared alias is judged by
  // its target at the manifest only.
  test('B2 a resolved URL naming another package is blocked, declared or not', async () => {
    await write('package.json', pkg('app', { react: '18.0.0', debug: '^4.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react': registryEntry('react', '18.0.0'),
        'node_modules/debug': { ...registryEntry('lodahs'), version: '4.0.0', name: 'lodahs' },
        'node_modules/react/node_modules/supports-color': registryEntry('lodahs'),
      })
    );
    await commit('head');

    const results = await runModes(DELTA_MODES);
    for (const [mode, result] of results) {
      const mismatch = result.findings
        .filter((finding) => finding.details?.signal === 'tarball-name-mismatch:lodahs')
        .map((finding) => [finding.packageName, finding.severity])
        .sort();
      expect({ mode, mismatch }).toEqual({
        mode,
        mismatch: [
          ['debug', 'critical'],
          ['supports-color', 'critical'],
        ],
      });
      expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 1 });
    }
  });

  test('B2 a declared alias entry is judged by its target at the manifest, once', async () => {
    await write('package.json', pkg('app', {}));
    await write('package-lock.json', npmLock());
    await tagBase();
    await write('package.json', pkg('app', { 'my-lib': 'npm:lodahs@1.0.0' }));
    // No root dependency map, so no alias edge: the manifest's alias line
    // alone says the key is a folder name.
    await write('package-lock.json', npmLock({ 'node_modules/my-lib': { ...registryEntry('lodahs'), name: 'lodahs' } }));
    await commit('head');

    const results = await expectNameBlocked(DELTA_MODES, 'package.json');
    for (const [mode, result] of results) {
      expect({ mode, key: nameFindings(result, 'my-lib') }).toEqual({ mode, key: [] });
    }
  });

  // Review N-1: npm treats "resolved": "" as absent and installs the name
  // field at its version.
  test('R-N1 an empty resolved is no resolved for name-field-unvouched', async () => {
    await write('package.json', pkg('app', { react: '18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react': registryEntry('react', '18.0.0'),
        'node_modules/supports-color': { name: 'lodash', version: '4.17.21', resolved: '', integrity: 'sha512-lodash' },
      })
    );
    await commit('head');

    const results = await runModes(DELTA_MODES);
    for (const [mode, result] of results) {
      const tamper = result.findings
        .filter((finding) => finding.details?.signal === 'name-field-unvouched:lodash')
        .map((finding) => [finding.packageName, finding.severity]);
      expect({ mode, tamper }).toEqual({ mode, tamper: [['supports-color', 'medium']] });
    }
  });
});

// The 2026-10-28 review of the fix found every narrowing of "a declaration
// exempts the lock entry" still wider than its reason. No declaration
// exempts one now: every added or changed registry entry is name-checked,
// and a manifest finding and a lockfile finding of one package under one
// rule are reported as one finding with both anchors.
describe('R no declaration exempts a lock entry; one name is reported once', () => {
  // Re-review RB1: the baseline holds lodahs for an unused stray; the change
  // adds a second lodahs line there and a registry lodahs nested under
  // react. The suppressed manifest finding must not take the new install's
  // lockfile finding with it.
  test('RB1 a baselined manifest finding does not swallow a new lockfile install', async () => {
    const baseline = (['typosquat', 'unknown-package'] as const).map((ruleId) =>
      fingerprintFinding({
        ruleId,
        severity: 'low',
        packageName: 'lodahs',
        message: 'irrelevant to the hash',
        manifestPath: 'examples/demo/package.json',
      })
    );
    await write('.dep-guard.baseline.json', JSON.stringify({ version: 1, fingerprints: baseline }));
    await write('examples/demo/package.json', pkg('demo', { lodahs: '^1.0.0' }));
    await write('package.json', pkg('app', { react: '18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await tagBase();
    await write('examples/demo/package.json', pkg('demo', { lodahs: '^1.0.0' }, { devDependencies: { lodahs: '^1.0.0' } }));
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react': { ...registryEntry('react', '18.0.0'), dependencies: { lodahs: '1.0.0' } },
        'node_modules/react/node_modules/lodahs': registryEntry('lodahs'),
      })
    );
    await commit('head');

    const results = await expectNameBlocked(DELTA_MODES, 'package-lock.json');
    for (const [mode, result] of results) {
      expect({ mode, suppressed: result.suppressed > 0 }).toEqual({ mode, suppressed: true });
    }
  });

  test('R a manifest line and its lock entry give one finding per rule, listing both anchors', async () => {
    await write('package.json', pkg('app', {}));
    await write('package-lock.json', npmLock());
    await tagBase();
    await write('package.json', pkg('app', { lodahs: '^1.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodahs': registryEntry('lodahs') }));
    await commit('head');

    const results = await runModes(DELTA_MODES);
    for (const [mode, result] of results) {
      const rows = nameFindings(result, 'lodahs')
        .map((finding) => [finding.ruleId, finding.manifestPath, finding.lockfilePath])
        .sort();
      expect({ mode, rows }).toEqual({
        mode,
        rows: [
          ['typosquat', 'package.json', 'package-lock.json'],
          ['unknown-package', 'package.json', 'package-lock.json'],
        ],
      });
    }
  });

  // Review R1: the ignored stray was on the base with its line; this change
  // makes it a project with one file: line. Its old line now installs.
  test('R1 an ignored stray this change makes a project has its old lines judged', async () => {
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['docs'] }));
    await write('docs/example/package.json', pkg('docs-example', { lodahs: '^1.0.0' }));
    await write('package.json', pkg('app', { react: '18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await tagBase();
    await write('package.json', pkg('app', { react: '18.0.0', 'docs-example': 'file:docs/example' }));
    await write(
      'package-lock.json',
      npmLock({
        'docs/example': { name: 'docs-example', version: '1.0.0', dependencies: { lodahs: '^1.0.0' } },
        'node_modules/docs-example': { link: true, resolved: 'docs/example' },
        'node_modules/lodahs': registryEntry('lodahs'),
        'node_modules/react': registryEntry('react', '18.0.0'),
      })
    );
    await commit('head');

    // The manifest walk judges the promoted manifest's old line (kept over
    // ignorePaths, since this change made it a project), and the lock
    // entry's finding is the same one, listed under it.
    const results = await runModes(DELTA_MODES);
    for (const [mode, result] of results) {
      const anchors = [...new Set(nameFindings(result, 'lodahs').map((finding) => [finding.manifestPath, finding.lockfilePath].join(' ')))];
      expect({ mode, anchors, exit: result.exitCode }).toEqual({
        mode,
        anchors: ['docs/example/package.json package-lock.json'],
        exit: 1,
      });
    }
  });

  // Review R2: a local package switched to a registry spec of the same name
  // is the dependency-confusion move; the line is a new registry line.
  test('R2 a line whose protocol moves from file: to registry is judged as added', async () => {
    await write('package.json', pkg('app', { lodahs: 'file:tools/lodahs' }));
    await write('tools/lodahs/package.json', pkg('lodahs', {}));
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/lodahs': { link: true, resolved: 'tools/lodahs' },
        'tools/lodahs': { name: 'lodahs', version: '1.0.0' },
      })
    );
    await tagBase();
    await write('package.json', pkg('app', { lodahs: '^1.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodahs': registryEntry('lodahs') }));
    await commit('head');

    await expectNameBlocked(ALL_MODES, 'package.json');
  });

  test('R2 a line whose protocol moves from workspace: to registry is judged as added (pnpm)', async () => {
    await write('package.json', pkg('app', { lodahs: 'workspace:*' }));
    await write(
      'pnpm-lock.yaml',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      lodahs:\n        specifier: workspace:*\n        version: link:packages/lodahs\n"
    );
    await tagBase();
    await write('package.json', pkg('app', { lodahs: '^1.0.0' }));
    await write(
      'pnpm-lock.yaml',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      lodahs:\n        specifier: ^1.0.0\n        version: 1.0.0\n" +
        'packages:\n  lodahs@1.0.0:\n    resolution: {integrity: sha512-lodahs}\n'
    );
    await commit('head');

    await expectNameBlocked(ALL_MODES, 'package.json');
  });

  // Review N-2: the stray is not ignored but npm installs nothing from it,
  // so its base line never caused an install and accepted nothing.
  test('R-N2 a base line in a stray npm does not install from does not exempt a new install', async () => {
    await write('examples/demo/package.json', pkg('demo', { lodahs: '^1.0.0' }));
    await write('package.json', pkg('app', { react: '18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await tagBase();
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react': { ...registryEntry('react', '18.0.0'), dependencies: { lodahs: '1.0.0' } },
        'node_modules/react/node_modules/lodahs': registryEntry('lodahs'),
      })
    );
    await commit('head');

    await expectNameBlocked(DELTA_MODES, 'package-lock.json');
  });

  // A base line in an ignored project the base installs is the adopter's
  // standing choice for that project's findings, but it was never judged:
  // it does not exempt a new lock entry.
  test('R a base line in an ignored project does not exempt a new lock entry', async () => {
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['fixtures'] }));
    await write('fixtures/helper/package.json', pkg('helper', { lodahs: '^1.0.0' }));
    await write('package.json', pkg('app', { helper: 'file:fixtures/helper' }));
    const wiring = {
      'fixtures/helper': { name: 'helper', version: '1.0.0', dependencies: { lodahs: '^1.0.0' } },
      'node_modules/helper': { link: true, resolved: 'fixtures/helper' },
    };
    await write('package-lock.json', npmLock(wiring));
    await tagBase();
    await write('package-lock.json', npmLock({ ...wiring, 'node_modules/lodahs': registryEntry('lodahs') }));
    await commit('head');

    await expectNameBlocked(DELTA_MODES, 'package-lock.json');
  });
});
