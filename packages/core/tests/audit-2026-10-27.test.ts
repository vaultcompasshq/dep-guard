import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadStates } from '../src/git-source.js';
import { scan } from '../src/scan.js';

// The 2026-10-27 audit's reproductions, each in every mode it applies to:
// plain (audit), --base, --base with --trust-base, --staged and --staged
// with --trust-base.
//
// M1: a file:, link: or portal: target, or an npm lockfile link entry,
// that sits under a node_modules directory is installed by the package
// manager (npm 11 installs the dependencies of "file:tools/node_modules/x"
// at the root), so it is read for names like any other local target.
// Ordinary node_modules contents nobody names stay unread.
//
// S1: a workspace member that is a symlink into a node_modules directory is
// caught in --staged as it already was in --base.
//
// N5: an added npm or pnpm lockfile entry that no manifest declares is
// name-checked, as Python lockfile names already were.

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

async function link(target: string, relPath: string): Promise<void> {
  const full = path.join(repo, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  try {
    await unlink(full);
  } catch {
    // not there yet
  }
  await symlink(target, full);
}

// -f: a node_modules directory is gitignored in a real repository, and
// committing one takes "git add -f". The attack needs exactly that.
async function commit(message: string): Promise<void> {
  await git('add', '-A', '-f');
  await git('commit', '-q', '-m', message);
}

function pkg(name: string, dependencies: Record<string, string>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name, version: '1.0.0', dependencies, ...extra });
}

function npmLock(packages: Record<string, Record<string, unknown>> = {}): string {
  return JSON.stringify({
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'app', version: '1.0.0' }, ...packages },
  });
}

const PNPM_LOCK_EMPTY = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n";

function registryEntry(name: string, version = '1.0.0'): Record<string, unknown> {
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: `sha512-${name}${version}`,
  };
}

const EVIL = (name = 'helper'): string => pkg(name, { lodahs: '^1.0.0' });

type Mode = 'audit' | 'base' | 'trust' | 'staged' | 'stagedTrust';
const ALL_MODES: readonly Mode[] = ['audit', 'base', 'trust', 'staged', 'stagedTrust'];
const DELTA_MODES: readonly Mode[] = ['base', 'trust', 'staged', 'stagedTrust'];

type ScanResult = Awaited<ReturnType<typeof scan>>;

// The base is committed and tagged "base", the head committed on top. The
// staged modes run last: HEAD becomes the base plus one unrelated file, and
// the index the head plus that file, so the staged change is exactly the
// head's and the trust base "base" is neither HEAD nor HEAD's tree, both of
// which --trust-base refuses.
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

function findingsFor(result: ScanResult, name: string): ScanResult['findings'] {
  return result.findings.filter((finding) => finding.packageName === name);
}

function codes(result: ScanResult): string[] {
  return result.run.diagnostics.map((diagnostic) => diagnostic.code);
}

// Every mode blocks, with a lodahs finding anchored on `manifestPath`.
async function expectBlockedEverywhere(modes: readonly Mode[], manifestPath: string): Promise<void> {
  const results = await runModes(modes);
  for (const [mode, result] of results) {
    const lodahs = findingsFor(result, 'lodahs');
    expect({ mode, anchors: [...new Set(lodahs.map((finding) => finding.manifestPath))] }).toEqual({
      mode,
      anchors: [manifestPath],
    });
    expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 1 });
  }
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-audit-1027-'));
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

describe('M1 a local target under a nested node_modules directory is read', () => {
  test('M1 file:tools/node_modules/helper, the lockfile records no entry for the name', async () => {
    await write('package.json', pkg('app', { react: '^18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await commit('base');
    await git('tag', 'base');
    await write('package.json', pkg('app', { react: '^18.0.0', helper: 'file:tools/node_modules/helper' }));
    await write('tools/node_modules/helper/package.json', EVIL());
    await commit('head');

    await expectBlockedEverywhere(ALL_MODES, 'tools/node_modules/helper/package.json');
  });

  // The audit's real npm 11 run: npm writes the link entry, the target's own
  // entry, and the registry entry for the name the target declares.
  test('M1b the same with the lockfile npm 11 writes, and no false "was found" note', async () => {
    await write('package.json', pkg('app', { react: '^18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await commit('base');
    await git('tag', 'base');
    await write('package.json', pkg('app', { react: '^18.0.0', helper: 'file:tools/node_modules/helper' }));
    await write('tools/node_modules/helper/package.json', EVIL());
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react': registryEntry('react', '18.0.0'),
        'node_modules/helper': { resolved: 'tools/node_modules/helper', link: true },
        'tools/node_modules/helper': { name: 'helper', version: '1.0.0', dependencies: { lodahs: '^1.0.0' } },
        'node_modules/lodahs': registryEntry('lodahs'),
      })
    );
    await commit('head');

    const results = await runModes(ALL_MODES);
    for (const [mode, result] of results) {
      const anchors = new Set(findingsFor(result, 'lodahs').map((finding) => finding.manifestPath));
      expect({ mode, helper: anchors.has('tools/node_modules/helper/package.json') }).toEqual({ mode, helper: true });
      expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 1 });
      const notes = result.run.diagnostics
        .filter((diagnostic) => diagnostic.code === 'workspace-link-unconfirmed')
        .map((diagnostic) => diagnostic.message);
      expect({ mode, notes: notes.filter((message) => /no package\.json named/.test(message)) }).toEqual({
        mode,
        notes: [],
      });
    }
  });

  test('M1 pnpm link:tools/node_modules/helper', async () => {
    await write('package.json', pkg('app', {}));
    await write('pnpm-lock.yaml', PNPM_LOCK_EMPTY);
    await commit('base');
    await git('tag', 'base');
    await write('package.json', pkg('app', { helper: 'link:tools/node_modules/helper' }));
    await write('tools/node_modules/helper/package.json', EVIL());
    await commit('head');

    await expectBlockedEverywhere(ALL_MODES, 'tools/node_modules/helper/package.json');
  });

  test('M1 portal:tools/node_modules/helper', async () => {
    await write('package.json', pkg('app', {}));
    await write('pnpm-lock.yaml', PNPM_LOCK_EMPTY);
    await commit('base');
    await git('tag', 'base');
    await write('package.json', pkg('app', { helper: 'portal:tools/node_modules/helper' }));
    await write('tools/node_modules/helper/package.json', EVIL());
    await commit('head');

    await expectBlockedEverywhere(ALL_MODES, 'tools/node_modules/helper/package.json');
  });

  test('M1 file: through a symlinked directory into tools/node_modules/helper', async () => {
    await write('package.json', pkg('app', {}));
    await write('package-lock.json', npmLock());
    await commit('base');
    await git('tag', 'base');
    await write('tools/node_modules/helper/package.json', EVIL());
    await link('tools/node_modules/helper', 'helperdir');
    await write('package.json', pkg('app', { helper: 'file:helperdir' }));
    await commit('head');

    await expectBlockedEverywhere(ALL_MODES, 'tools/node_modules/helper/package.json');
  });

  test('M1 file:node_modules/helper at the root', async () => {
    await write('package.json', pkg('app', {}));
    await write('package-lock.json', npmLock());
    await commit('base');
    await git('tag', 'base');
    await write('package.json', pkg('app', { helper: 'file:node_modules/helper' }));
    await write('node_modules/helper/package.json', EVIL());
    await commit('head');

    await expectBlockedEverywhere(ALL_MODES, 'node_modules/helper/package.json');
  });

  test('M1 an npm lockfile link entry alone names the target', async () => {
    await write('package.json', pkg('app', {}));
    await write('package-lock.json', npmLock());
    await commit('base');
    await git('tag', 'base');
    await write('package-lock.json', npmLock({ 'node_modules/helper': { resolved: 'tools/node_modules/helper', link: true } }));
    await write('tools/node_modules/helper/package.json', EVIL());
    await commit('head');

    await expectBlockedEverywhere(ALL_MODES, 'tools/node_modules/helper/package.json');
  });

  // The note for a link entry whose target was not read says what the scan
  // did, not that the file is absent: before 0.17.0 it said "no
  // package.json ... was found" for a target that was in the tree.
  test('M1n a link entry whose target was not read says the scan read none there', async () => {
    await write('package.json', pkg('app', {}));
    await write('package-lock.json', npmLock());
    await commit('base');
    await git('tag', 'base');
    await write('package-lock.json', npmLock({ 'node_modules/helper': { resolved: 'tools/helper', link: true } }));
    await commit('head');

    const results = await runModes(['base', 'staged']);
    for (const [mode, result] of results) {
      const note = result.run.diagnostics.find((diagnostic) => diagnostic.code === 'workspace-link-unconfirmed');
      expect({ mode, note: note?.message }).toEqual({
        mode,
        note: expect.stringContaining('"helper" (this scan read no package.json named "helper" at tools/helper)'),
      });
    }
  });

  // The target's own local specifiers are followed too, as they are for a
  // target outside node_modules: npm installs the whole chain.
  test('M1 a chain of file: targets under node_modules is followed to its end', async () => {
    await write('package.json', pkg('app', {}));
    await write('package-lock.json', npmLock());
    await commit('base');
    await git('tag', 'base');
    await write('package.json', pkg('app', { helper: 'file:tools/node_modules/helper' }));
    await write('tools/node_modules/helper/package.json', pkg('helper', { inner: 'file:../inner' }));
    await write('tools/node_modules/inner/package.json', EVIL('inner'));
    await commit('head');

    await expectBlockedEverywhere(ALL_MODES, 'tools/node_modules/inner/package.json');
  });

  // A target that leaves the repository and comes back in through the
  // checkout directory's own name cannot be placed, so it fails closed: it
  // stands in on every package.json, now including one under node_modules.
  test('M1 an unplaceable target stands in for a manifest under node_modules too', async () => {
    await write('package.json', pkg('app', {}));
    await write('package-lock.json', npmLock());
    await commit('base');
    await git('tag', 'base');
    const checkout = path.basename(repo);
    await write('package.json', pkg('app', { helper: `file:../${checkout}/tools/node_modules/helper` }));
    await write('tools/node_modules/helper/package.json', EVIL());
    await commit('head');

    await expectBlockedEverywhere(ALL_MODES, 'tools/node_modules/helper/package.json');
  });

  // Fix round 2: npm on a case-insensitive file system (macOS) installs a
  // target spelled in another case. An explicit target that names no
  // listed path exactly is matched against the listed manifests without
  // regard to case.
  test.each([
    ['file:tools/NODE_MODULES/helper', 'tools/node_modules/helper/package.json'],
    ['file:Build/helper', 'build/helper/package.json'],
  ])('M1f a target spelled %s in another case is read at its listed path', async (specifier, listed) => {
    await write('package.json', pkg('app', {}));
    await write('package-lock.json', npmLock());
    await commit('base');
    await git('tag', 'base');
    await write('package.json', pkg('app', { helper: specifier }));
    await write(listed, EVIL());
    await commit('head');

    await expectBlockedEverywhere(ALL_MODES, listed);
  });

  // The case-folded match places the target, so it is the exact project
  // (a reason with no fail-closed pattern), not one stand-in among many.
  test('M1f a case-folded target is placed, not stood in for', async () => {
    await write('package.json', pkg('app', { helper: 'file:tools/NODE_MODULES/helper' }));
    await write('tools/node_modules/helper/package.json', EVIL());
    await write('libs/other/package.json', pkg('other', {}));
    await commit('base');

    const states = await loadStates(repo, { kind: 'audit' });
    const reasons = states.after.projects?.reasons;
    expect(reasons?.get('tools/node_modules/helper/package.json')).toEqual([
      { rule: 'reference-target', root: '', input: 'package.json' },
    ]);
    expect(reasons?.get('libs/other/package.json')).toBeUndefined();
  });

  // A target that names no listed manifest in any case cannot be placed on
  // this side, so it fails closed like one that leaves the repository: it
  // stands in on every package.json, one under node_modules included.
  test('M1f a target that names no listed manifest fails closed', async () => {
    await write('package.json', pkg('app', {}));
    await write('package-lock.json', npmLock());
    await commit('base');
    await git('tag', 'base');
    await write('package.json', pkg('app', { helper: 'file:tools/absent' }));
    await write('tools/node_modules/helper/package.json', EVIL());
    await commit('head');

    await expectBlockedEverywhere(ALL_MODES, 'tools/node_modules/helper/package.json');
  });

  // Control: a committed node_modules package nobody names is a
  // dependency's own file and stays unread, in every mode.
  test('M1c a committed node_modules manifest no reference names is still not read', async () => {
    await write('package.json', pkg('app', { react: '^18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await commit('base');
    await git('tag', 'base');
    await write('tools/node_modules/helper/package.json', EVIL());
    await write('node_modules/other/package.json', EVIL('other'));
    await commit('head');

    const results = await runModes(ALL_MODES);
    for (const [mode, result] of results) {
      expect({ mode, lodahs: findingsFor(result, 'lodahs') }).toEqual({ mode, lodahs: [] });
      expect({ mode, exit: result.exitCode }).toEqual({ mode, exit: 0 });
    }
  });

  // An explicitly named target under node_modules is a project: one that
  // does not parse stops the scan, as any local target does.
  test('M1p an explicitly named target under node_modules that does not parse stops the scan', async () => {
    await write('package.json', pkg('app', {}));
    await write('package-lock.json', npmLock());
    await commit('base');
    await git('tag', 'base');
    await write('package.json', pkg('app', { helper: 'file:tools/node_modules/helper' }));
    await write('tools/node_modules/helper/package.json', '{ "name": "helper", ');
    await commit('head');

    for (const mode of ['audit', 'base', 'staged'] as const) {
      if (mode === 'staged') {
        await git('reset', '-q', '--soft', 'base');
      }
      await expect(
        scan({
          repoRoot: repo,
          mode: mode === 'staged' ? { kind: 'staged' } : mode === 'audit' ? { kind: 'audit' } : { kind: 'base', ref: 'base' },
          corpusDir: FIXTURE_CORPUS,
        })
      ).rejects.toMatchObject({ code: 'manifest-parse' });
    }
  });
});

describe('S1 a workspace member linked into a node_modules directory', () => {
  test('S1 packages/a -> ../node_modules/evil', async () => {
    await write('package.json', pkg('root', {}, { workspaces: ['packages/*'] }));
    await write('package-lock.json', npmLock());
    await write('libs/a/package.json', pkg('a', { react: '^18.0.0' }));
    await link('../libs/a', 'packages/a');
    await commit('base');
    await git('tag', 'base');
    await write('node_modules/evil/package.json', EVIL('evil'));
    await link('../node_modules/evil', 'packages/a');
    await commit('head');

    await expectBlockedEverywhere(DELTA_MODES, 'node_modules/evil/package.json');
  });

  test('S1 packages/b -> ../tools/node_modules/evil', async () => {
    await write('package.json', pkg('root', {}, { workspaces: ['packages/*'] }));
    await write('package-lock.json', npmLock());
    await write('packages/a/package.json', pkg('a', {}));
    await commit('base');
    await git('tag', 'base');
    await write('tools/node_modules/evil/package.json', EVIL('evil'));
    await link('../tools/node_modules/evil', 'packages/b');
    await commit('head');

    await expectBlockedEverywhere(DELTA_MODES, 'tools/node_modules/evil/package.json');
  });

  // A member link that leaves the repository and comes back in through the
  // checkout directory's own name cannot be placed, so it fails closed and
  // stands in on every package.json, one under node_modules included.
  test('S1 an unplaceable member link stands in for a manifest under node_modules too', async () => {
    await write('package.json', pkg('root', {}, { workspaces: ['packages/*'] }));
    await write('package-lock.json', npmLock());
    await write('packages/a/package.json', pkg('a', {}));
    await commit('base');
    await git('tag', 'base');
    await write('node_modules/evil/package.json', EVIL('evil'));
    await link(`../../${path.basename(repo)}/node_modules/evil`, 'packages/b');
    await commit('head');

    await expectBlockedEverywhere(DELTA_MODES, 'node_modules/evil/package.json');
  });

  // Fix round 3: a member walk that fans out past the per-input limit
  // fails closed and stands in on every package.json, one under
  // node_modules included. packages/start sorts before packages/zz, so the
  // walk stops before it ever maps packages/zz, and only the stand-in can
  // read node_modules/evil.
  test('S1 a fan-out past the visit limit stands in for a manifest under node_modules', async () => {
    await write('package.json', pkg('root', {}, { workspaces: ['packages/**'] }));
    await write('package-lock.json', npmLock());
    await commit('base');
    await git('tag', 'base');
    for (let i = 0; i <= 15; i += 1) {
      await write(`fan/L${i}/.gitkeep`, '');
    }
    await link('../fan/L0', 'packages/start');
    for (let i = 0; i < 15; i += 1) {
      await link(`../L${i + 1}`, `fan/L${i}/x`);
      await link(`../L${i + 1}`, `fan/L${i}/y`);
    }
    await write('node_modules/evil/package.json', EVIL('evil'));
    await link('../node_modules/evil', 'packages/zz');
    await commit('head');

    await expectBlockedEverywhere(['staged'], 'node_modules/evil/package.json');
  }, 120_000);
});

describe('N5 an added lockfile entry no manifest declares is name-checked', () => {
  test('N5 a new node_modules/lodahs registry entry in package-lock.json', async () => {
    await write('package.json', pkg('app', {}));
    await write('package-lock.json', npmLock());
    await commit('base');
    await git('tag', 'base');
    await write('package-lock.json', npmLock({ 'node_modules/lodahs': registryEntry('lodahs') }));
    await commit('head');

    await expectBlockedEverywhere(ALL_MODES, 'package-lock.json');
  });

  test('N5 a nested node_modules/x/node_modules/lodahs entry with no resolved field', async () => {
    await write('package.json', pkg('app', { react: '^18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await commit('base');
    await git('tag', 'base');
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react': registryEntry('react', '18.0.0'),
        'node_modules/react/node_modules/lodahs': { version: '1.0.0' },
      })
    );
    await commit('head');

    await expectBlockedEverywhere(ALL_MODES, 'package-lock.json');
  });

  test('N5 a new lodahs entry in pnpm-lock.yaml', async () => {
    await write('package.json', pkg('app', {}));
    await write('pnpm-lock.yaml', PNPM_LOCK_EMPTY);
    await commit('base');
    await git('tag', 'base');
    await write(
      'pnpm-lock.yaml',
      "lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n  lodahs@1.0.0:\n    resolution: {integrity: sha512-x}\n"
    );
    await commit('head');

    await expectBlockedEverywhere(ALL_MODES, 'pnpm-lock.yaml');
  });

  // Fix round B1: npm records a dependency asked for by tarball URL with
  // that URL as its "version". npm ci installs it like any registry
  // package; the first 0.17.0 candidate skipped every version holding a
  // ":" (meant for pnpm directory versions) and passed it.
  test('N5u an npm entry whose version is a registry tarball URL is name-checked', async () => {
    const url = 'https://registry.npmjs.org/lodahs/-/lodahs-1.0.0.tgz';
    await write('package.json', pkg('app', { react: '18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await commit('base');
    await git('tag', 'base');
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react': { ...registryEntry('react', '18.0.0'), dependencies: { lodahs: url } },
        'node_modules/lodahs': { version: url, resolved: url, integrity: 'sha512-lodahs' },
      })
    );
    await commit('head');

    await expectBlockedEverywhere(ALL_MODES, 'package-lock.json');
  });

  test('N5u a pnpm entry whose version is a registry tarball URL is name-checked', async () => {
    await write('package.json', pkg('app', {}));
    await write('pnpm-lock.yaml', PNPM_LOCK_EMPTY);
    await commit('base');
    await git('tag', 'base');
    await write(
      'pnpm-lock.yaml',
      "lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n" +
        '  lodahs@https://registry.npmjs.org/lodahs/-/lodahs-1.0.0.tgz:\n' +
        '    resolution: {integrity: sha512-x, tarball: https://registry.npmjs.org/lodahs/-/lodahs-1.0.0.tgz}\n'
    );
    await commit('head');

    await expectBlockedEverywhere(ALL_MODES, 'pnpm-lock.yaml');
  });

  // An entry npm marks inBundle ships inside its parent's tarball and is
  // never fetched by name, so "may be hallucinated" is the wrong sentence
  // for an unknown one.
  test('N5b an unknown bundled entry is reported as bundled, not as possibly hallucinated', async () => {
    await write('package.json', pkg('app', { react: '18.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/react': registryEntry('react', '18.0.0') }));
    await commit('base');
    await git('tag', 'base');
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react': registryEntry('react', '18.0.0'),
        'node_modules/react/node_modules/privbundle': { version: '1.0.0', inBundle: true },
      })
    );
    await commit('head');

    const results = await runModes(['base', 'staged']);
    for (const [mode, result] of results) {
      const unknown = findingsFor(result, 'privbundle').filter((finding) => finding.ruleId === 'unknown-package');
      expect({ mode, count: unknown.length }).toEqual({ mode, count: 1 });
      expect(unknown[0]?.message).not.toContain('hallucinated');
      expect(unknown[0]?.message).toContain("inside its parent package's tarball");
    }
  });

  // Not name checks' business: a version bump of a name the base already
  // had, a git or file resolution (the tamper check judges those), and a
  // pnpm directory dependency.
  test('N5c an entry that is not a new registry name is not name-checked', async () => {
    await write('package.json', pkg('app', {}));
    await write('package-lock.json', npmLock({ 'node_modules/react/node_modules/lodahs': registryEntry('lodahs', '1.0.0') }));
    await commit('base');
    await git('tag', 'base');
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/react/node_modules/lodahs': registryEntry('lodahs', '1.0.1'),
        'node_modules/expresss': { version: '1.0.0', resolved: 'git+ssh://git@github.com/example/expresss.git#0123456789abcdef0123456789abcdef01234567' },
        'node_modules/reactt': { version: '1.0.0', resolved: 'file:vendor/reactt-1.0.0.tgz' },
      })
    );
    await commit('head');

    const results = await runModes(['base', 'trust', 'staged']);
    for (const [mode, result] of results) {
      const named = result.findings.filter((finding) => ['typosquat', 'unknown-package'].includes(finding.ruleId));
      expect({ mode, named: named.map((finding) => finding.packageName) }).toEqual({ mode, named: [] });
    }
  });

  test('N5c a pnpm directory dependency entry is not name-checked', async () => {
    await write('package.json', pkg('app', {}));
    await write('pnpm-lock.yaml', PNPM_LOCK_EMPTY);
    await commit('base');
    await git('tag', 'base');
    await write(
      'pnpm-lock.yaml',
      "lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n  lodahs@file:libs/lodahs:\n    resolution: {directory: libs/lodahs, type: directory}\n"
    );
    await commit('head');

    const results = await runModes(['base', 'trust', 'staged']);
    for (const [mode, result] of results) {
      expect({ mode, lodahs: findingsFor(result, 'lodahs').map((finding) => finding.ruleId) }).toEqual({ mode, lodahs: [] });
    }
  });

  // An accepted transitive alias (npm writes one for @isaacs/cliui's
  // string-width-cjs) is judged by its target, which is what installs; the
  // key is only the folder name and is not a registry name.
  test('N5a an accepted transitive alias is judged by its target, not its key', async () => {
    await write('package.json', pkg('app', {}));
    await write('package-lock.json', npmLock());
    await commit('base');
    await git('tag', 'base');
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/cliui': { ...registryEntry('cliui', '8.0.2'), dependencies: { 'lodahs-cjs': 'npm:lodahs@^1.0.0' } },
        'node_modules/lodahs-cjs': { ...registryEntry('lodahs'), name: 'lodahs' },
      })
    );
    await commit('head');

    const results = await runModes(['base', 'staged']);
    for (const [mode, result] of results) {
      expect({ mode, key: findingsFor(result, 'lodahs-cjs') }).toEqual({ mode, key: [] });
      expect({ mode, target: findingsFor(result, 'lodahs').length > 0 }).toEqual({ mode, target: true });
    }
  });

  test('N5 a declared entry is still anchored on its manifest, once', async () => {
    await write('package.json', pkg('app', {}));
    await write('package-lock.json', npmLock());
    await commit('base');
    await git('tag', 'base');
    await write('package.json', pkg('app', { lodahs: '^1.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodahs': registryEntry('lodahs') }));
    await commit('head');

    const results = await runModes(['base', 'staged']);
    for (const [mode, result] of results) {
      const anchors = findingsFor(result, 'lodahs')
        .filter((finding) => finding.ruleId === 'typosquat')
        .map((finding) => finding.manifestPath);
      expect({ mode, anchors }).toEqual({ mode, anchors: ['package.json'] });
    }
  });

  // A name the base manifest already declared was accepted then; its lock
  // entry appearing later (a lockfile regenerated after the fact) is a
  // declared entry and is not re-checked as new.
  test('N5d a declared name the base already had is not re-checked when its lock entry first appears', async () => {
    await write('package.json', pkg('app', { lodahs: '^1.0.0' }));
    await write('package-lock.json', npmLock());
    await commit('base');
    await git('tag', 'base');
    await write('package-lock.json', npmLock({ 'node_modules/lodahs': registryEntry('lodahs') }));
    await commit('head');

    const results = await runModes(['base', 'trust', 'staged']);
    for (const [mode, result] of results) {
      const named = findingsFor(result, 'lodahs').filter((finding) => ['typosquat', 'unknown-package'].includes(finding.ruleId));
      expect({ mode, named }).toEqual({ mode, named: [] });
    }
  });

  test('N5 codes stay quiet for an unchanged lockfile', async () => {
    await write('package.json', pkg('app', {}));
    await write('package-lock.json', npmLock({ 'node_modules/lodahs': registryEntry('lodahs') }));
    await commit('base');
    await git('tag', 'base');
    await write('README.md', 'x\n');
    await commit('head');

    const results = await runModes(['base', 'staged']);
    for (const [mode, result] of results) {
      expect({ mode, lodahs: findingsFor(result, 'lodahs'), exit: result.exitCode }).toEqual({ mode, lodahs: [], exit: 0 });
      expect(codes(result)).not.toContain('delta-new-lock-entries');
    }
  });
});
