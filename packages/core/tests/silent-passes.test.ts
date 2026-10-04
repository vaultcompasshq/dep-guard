import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseManifest } from '../src/manifest.js';
import { scan } from '../src/scan.js';
import type { ScanResult } from '../src/scan.js';

// End-to-end pins for four ways a tampered or dangerous dependency change
// used to scan clean. Every test drives the real scan entry point against a
// real git repository, with fixtures shaped like what npm and pnpm write.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CORPUS = path.join(__dirname, '..', 'fixtures', 'corpus');
const execFileAsync = promisify(execFile);

let tempDirs: string[] = [];
let repo = '';

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repo, encoding: 'utf8' });
  return stdout;
}

async function write(relPath: string, content: string): Promise<void> {
  const full = path.join(repo, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

async function commitAll(message: string): Promise<void> {
  await git('add', '-A');
  await git('commit', '-q', '-m', message);
}

async function scanStaged(): Promise<ScanResult> {
  await git('add', '-A');
  return scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });
}

function manifestJson(dependencies: Record<string, string>): string {
  return JSON.stringify({ name: 'root', version: '1.0.0', dependencies });
}

function npmLock(
  packages: Record<string, Record<string, unknown>>,
  rootDependencies: Record<string, string>,
  ...versionArg: [] | [unknown]
): string {
  // An explicit undefined means "delete the field"; omitting the argument
  // means the lockfileVersion 3 npm writes today.
  const lockfileVersion = versionArg.length === 0 ? 3 : versionArg[0];
  const doc: Record<string, unknown> = {
    name: 'root',
    version: '1.0.0',
    lockfileVersion,
    requires: true,
    packages: {
      '': { name: 'root', version: '1.0.0', dependencies: rootDependencies },
      ...packages,
    },
  };
  if (lockfileVersion === undefined) {
    delete doc.lockfileVersion;
  }
  return JSON.stringify(doc);
}

const CLEAN_LODASH = {
  version: '4.17.21',
  resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
  integrity: 'sha512-cleanlodash',
};

const TAMPERED_LODASH = {
  version: '4.17.21',
  resolved: 'https://evil.example.com/lodash/-/lodash-4.17.21.tgz',
  integrity: 'sha512-evilevilevil',
};

function tamperSignals(result: ScanResult, name: string): string[] {
  return result.findings
    .filter((finding) => finding.ruleId === 'lockfile-tamper' && finding.packageName === name)
    .map((finding) => String(finding.details?.signal ?? ''));
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-silent-'));
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

describe('D1: lockfileVersion does not decide whether the packages map is read', () => {
  // npm reads the packages map whenever it is there, whatever the
  // lockfileVersion field says (verified with npm ls --package-lock-only),
  // so the scan has to as well.
  const variants: Array<[string, unknown]> = [
    ['the string "3"', '3'],
    ['the number 1', 1],
    ['null', null],
    ['deleted', undefined],
  ];

  for (const [label, version] of variants) {
    test(`a tampered node_modules/lodash is caught when lockfileVersion is ${label}`, async () => {
      await write('package.json', manifestJson({ lodash: '^4.17.21' }));
      await write('package-lock.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
      await commitAll('first');

      await write(
        'package-lock.json',
        npmLock({ 'node_modules/lodash': TAMPERED_LODASH }, { lodash: '^4.17.21' }, version)
      );
      const result = await scanStaged();

      const signals = tamperSignals(result, 'lodash');
      expect(signals.some((signal) => signal.startsWith('host-changed'))).toBe(true);
      expect(result.exitCode).toBe(1);
    });
  }

  test('a real v1 lockfile on both sides keeps only the v1 diagnostic', async () => {
    const v1 = JSON.stringify({
      name: 'root',
      version: '1.0.0',
      lockfileVersion: 1,
      requires: true,
      dependencies: { lodash: { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', integrity: 'sha512-cleanlodash' } },
    });
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('package-lock.json', v1);
    await commitAll('first');
    await write('package.json', manifestJson({ lodash: '^4.17.20' }));
    const result = await scanStaged();

    expect(result.run.diagnostics.map((d) => d.code)).toContain('npm-lockfile-v1');
    expect(result.exitCode).toBe(0);
  });

  test('a base with a packages map whose head loses it (v1 shape) is not a clean pass', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    await commitAll('first');

    // The head keeps the tampered entry only in the legacy dependencies
    // tree, with the packages map removed and the version set to 1.
    await write(
      'package-lock.json',
      JSON.stringify({
        name: 'root',
        version: '1.0.0',
        lockfileVersion: 1,
        requires: true,
        dependencies: { lodash: { version: '4.17.21', resolved: TAMPERED_LODASH.resolved, integrity: TAMPERED_LODASH.integrity } },
      })
    );

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });
});

// pnpm records a registry resolution as {integrity} alone and writes a
// tarball URL only when it is not the registry's standard one, so "no URL"
// on a pnpm entry means "the default registry's tarball for this name and
// version" and gaining a URL is a move away from it.
function pnpmLock(lodashResolution: string): string {
  return [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '  excludeLinksFromLockfile: false',
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      lodash:',
    '        specifier: ^4.17.21',
    '        version: 4.17.21',
    '',
    'packages:',
    '',
    '  lodash@4.17.21:',
    `    resolution: {${lodashResolution}}`,
    '',
    'snapshots:',
    '',
    '  lodash@4.17.21: {}',
    '',
  ].join('\n');
}

describe('D2: a pnpm resolution that gains a tarball URL is compared against the implied registry URL', () => {
  async function commitPnpmBase(baseResolution: string): Promise<void> {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('pnpm-lock.yaml', pnpmLock(baseResolution));
    await commitAll('first');
  }

  test('integrity rewritten and a tarball URL on another host added at the same version', async () => {
    await commitPnpmBase('integrity: sha512-cleanlodash');
    await write(
      'pnpm-lock.yaml',
      pnpmLock('integrity: sha512-evilevilevil, tarball: https://evil.example.com/x.tgz')
    );
    const result = await scanStaged();

    expect(tamperSignals(result, 'lodash').some((s) => s.startsWith('host-changed'))).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  test('integrity rewritten and repointed to another package tarball on the same registry', async () => {
    await commitPnpmBase('integrity: sha512-cleanlodash');
    await write(
      'pnpm-lock.yaml',
      pnpmLock(
        'integrity: sha512-otherpackagehash, tarball: https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz'
      )
    );
    const result = await scanStaged();

    expect(tamperSignals(result, 'lodash').some((s) => s.startsWith('tarball-repointed'))).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  test('a tarball URL on another host added with the integrity unchanged', async () => {
    await commitPnpmBase('integrity: sha512-cleanlodash');
    await write(
      'pnpm-lock.yaml',
      pnpmLock('integrity: sha512-cleanlodash, tarball: https://evil.example.com/x.tgz')
    );
    const result = await scanStaged();

    expect(tamperSignals(result, 'lodash').some((s) => s.startsWith('host-changed'))).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  test('a tarball URL equal to the implied registry tarball is not a finding', async () => {
    await commitPnpmBase('integrity: sha512-cleanlodash');
    await write(
      'pnpm-lock.yaml',
      pnpmLock(
        'integrity: sha512-cleanlodash, tarball: https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz'
      )
    );
    const result = await scanStaged();

    expect(tamperSignals(result, 'lodash')).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('the project default registry is what the implied URL is derived from', async () => {
    await write('.npmrc', 'registry=https://npm.corp.example/\n');
    await commitPnpmBase('integrity: sha512-cleanlodash');
    await write(
      'pnpm-lock.yaml',
      pnpmLock(
        'integrity: sha512-cleanlodash, tarball: https://npm.corp.example/lodash/-/lodash-4.17.21.tgz'
      )
    );
    const held = await scanStaged();
    expect(tamperSignals(held, 'lodash')).toEqual([]);

    await write(
      'pnpm-lock.yaml',
      pnpmLock('integrity: sha512-evilevilevil, tarball: https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz')
    );
    const moved = await scanStaged();
    expect(tamperSignals(moved, 'lodash').some((s) => s.startsWith('host-changed'))).toBe(true);
  });

  test('control: an integrity-only rewrite still gives integrity-changed', async () => {
    await commitPnpmBase('integrity: sha512-cleanlodash');
    await write('pnpm-lock.yaml', pnpmLock('integrity: sha512-evilevilevil'));
    const result = await scanStaged();

    expect(tamperSignals(result, 'lodash')).toContain('integrity-changed');
  });

  test('control: removing the integrity hash still gives integrity-removed', async () => {
    await commitPnpmBase('integrity: sha512-cleanlodash');
    await write('pnpm-lock.yaml', pnpmLock('tarball: https://evil.example.com/x.tgz'));
    const result = await scanStaged();

    expect(tamperSignals(result, 'lodash')).toContain('integrity-removed');
  });

  test('an npm entry that drops "resolved" while rewriting integrity at the same version is integrity-changed', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    await commitAll('first');
    await write(
      'package-lock.json',
      npmLock(
        { 'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-evilevilevil' } },
        { lodash: '^4.17.21' }
      )
    );
    const result = await scanStaged();

    expect(tamperSignals(result, 'lodash')).toContain('integrity-changed');
    expect(result.exitCode).toBe(1);
  });
});

describe('D3: every lockfile at the root is checked, npm-shrinkwrap.json included', () => {
  test('a clean package-lock.json decoy beside a tampered pnpm-lock.yaml', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    await write('pnpm-lock.yaml', pnpmLock('integrity: sha512-cleanlodash'));
    await commitAll('first');

    await write(
      'pnpm-lock.yaml',
      pnpmLock('integrity: sha512-evilevilevil, tarball: https://evil.example.com/x.tgz')
    );
    const result = await scanStaged();

    expect(tamperSignals(result, 'lodash').some((s) => s.startsWith('host-changed'))).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.run.diagnostics.map((d) => d.code)).toContain('multiple-lockfiles');
    const finding = result.findings.find((f) => f.ruleId === 'lockfile-tamper');
    expect(finding?.lockfilePath).toBe('pnpm-lock.yaml');
  });

  test('a tampered npm-shrinkwrap.json beside a clean package-lock.json', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    const clean = npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' });
    await write('package-lock.json', clean);
    await write('npm-shrinkwrap.json', clean);
    await commitAll('first');

    await write(
      'npm-shrinkwrap.json',
      npmLock({ 'node_modules/lodash': TAMPERED_LODASH }, { lodash: '^4.17.21' })
    );
    const result = await scanStaged();

    expect(tamperSignals(result, 'lodash').some((s) => s.startsWith('host-changed'))).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  test('a tampered npm-shrinkwrap.json newly added beside the package-lock.json the base already had', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    await commitAll('first');

    await write(
      'npm-shrinkwrap.json',
      npmLock({ 'node_modules/lodash': TAMPERED_LODASH }, { lodash: '^4.17.21' })
    );
    const result = await scanStaged();

    expect(tamperSignals(result, 'lodash').some((s) => s.startsWith('host-changed'))).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.run.lockfileFormat).toBe('npm');
  });

  test('npm-shrinkwrap.json alone is read as the npm lockfile', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('npm-shrinkwrap.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    await commitAll('first');
    await write(
      'npm-shrinkwrap.json',
      npmLock({ 'node_modules/lodash': TAMPERED_LODASH }, { lodash: '^4.17.21' })
    );
    const result = await scanStaged();

    expect(result.run.lockfileFormat).toBe('npm');
    expect(tamperSignals(result, 'lodash').some((s) => s.startsWith('host-changed'))).toBe(true);
  });

  test('a repo whose only surviving file is an npm-shrinkwrap.json is could-not-run, not dependency-free', async () => {
    await write(
      'npm-shrinkwrap.json',
      JSON.stringify({ name: 'root', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {} })
    );

    await expect(
      scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS })
    ).rejects.toMatchObject({ code: 'manifests-unresolved' });
  });

  test('a single lockfile raises no multiple-lockfiles diagnostic', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    await commitAll('first');
    await write('package.json', manifestJson({ lodash: '^4.17.20' }));
    const result = await scanStaged();

    expect(result.run.diagnostics.map((d) => d.code)).not.toContain('multiple-lockfiles');
  });
});

describe('D4: every git spelling npm accepts is classified as git', () => {
  function protocolOf(specifier: string): string {
    const parsed = parseManifest('package.json', JSON.stringify({ dependencies: { pkg: specifier } }));
    return parsed.deps[0].protocol;
  }

  // Expected values are npm's own answer, taken from the npm-package-arg
  // bundled with npm (npa.resolve('pkg', spec).type), not from this
  // scanner's opinion of the syntax. "git" here is npa type git.
  const gitForms: string[] = [
    'attacker/lodash',
    'attacker/lodash#v1.2.3',
    'attacker/lodash#semver:^1',
    'attacker/lodash#main',
    'foo/bar.tgz',
    'gitlab:o/r',
    'gitlab:o/r#main',
    'bitbucket:o/r',
    'gist:abc123def',
    'gist:o/abc',
    'sourcehut:~u/r',
    'github:o/r',
    'GITHUB:o/r',
    'git@github.com:o/r.git',
    'git@github.com:o/r#v1',
    'user@github.com:o/r',
    'git@gitlab.com:o/r.git',
    'git@bitbucket.org:o/r.git',
    'git@gist.github.com:abc123',
    'git@git.sr.ht:~u/r',
    'ssh://git@github.com/o/r.git',
    'git+ssh://git@github.com/o/r.git',
    'git+https://example.com/o/r.git',
    'git://github.com/o/r.git',
  ];
  for (const specifier of gitForms) {
    test(`${JSON.stringify(specifier)} is git`, () => {
      expect(protocolOf(specifier)).toBe('git');
    });
  }

  // npm reads none of these as git: registry versions, ranges and tags, and
  // the local-path and unknown-host spellings npm-package-arg reports as
  // directory. Over-classifying them would put a critical finding on every
  // ordinary dependency.
  const notGit: Array<[string, string]> = [
    ['^4.17.21', 'registry'],
    ['4.17.21', 'registry'],
    ['latest', 'registry'],
    ['1.x', 'registry'],
    ['>=1.0.0 <2', 'registry'],
    ['1.0.0 - 2.0.0', 'registry'],
    ['~1.2.3', 'registry'],
    ['*', 'registry'],
    ['', 'registry'],
    ['./local', 'registry'],
    ['../local', 'registry'],
    ['/abs/path', 'registry'],
    ['~/x/y', 'registry'],
    ['C:\\x\\y', 'registry'],
    ['a/b/c', 'registry'],
    ['o/r/', 'registry'],
    ['git@gitlab.example.com:o/r', 'registry'],
    ['git@github.com:/o/r', 'registry'],
    ['npm:lodash@4.17.21', 'alias'],
    ['file:../x', 'file'],
    ['https://evil.example.com/x.tgz', 'url'],
  ];
  for (const [specifier, expected] of notGit) {
    test(`${JSON.stringify(specifier)} is ${expected}, not git`, () => {
      expect(protocolOf(specifier)).toBe(expected);
    });
  }

  for (const specifier of ['attacker/lodash', 'gitlab:attacker/lodash', 'git@github.com:attacker/lodash.git']) {
    test(`a manifest that swaps a registry range for ${JSON.stringify(specifier)} scans as a blocking git source`, async () => {
      await write('package.json', manifestJson({ lodash: '^4.17.21' }));
      await commitAll('first');
      await write('package.json', manifestJson({ lodash: specifier }));
      const result = await scanStaged();

      expect(tamperSignals(result, 'lodash').some((s) => s.startsWith('git-source'))).toBe(true);
      expect(result.exitCode).toBe(1);
    });
  }
});

describe('D4: a newly added lockfile entry from a git or non-registry source is a source finding', () => {
  const PINNED = '0123456789abcdef0123456789abcdef01234567';

  async function commitBase(files: Record<string, string>): Promise<void> {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    for (const [file, content] of Object.entries(files)) {
      await write(file, content);
    }
    await commitAll('first');
  }

  test('npm: a new transitive entry resolved from a git URL', async () => {
    await commitBase({ 'package-lock.json': npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }) });
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodash': CLEAN_LODASH,
          'node_modules/evil-dep': {
            version: '1.0.0',
            resolved: `git+ssh://git@github.com/attacker/evil-dep.git#${PINNED}`,
          },
        },
        { lodash: '^4.17.21' }
      )
    );
    const result = await scanStaged();

    expect(tamperSignals(result, 'evil-dep')).toContain('git-source:github.com');
    expect(result.exitCode).toBe(1);
  });

  test('npm: a new transitive entry resolved from a non-registry tarball URL', async () => {
    await commitBase({ 'package-lock.json': npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }) });
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodash': CLEAN_LODASH,
          'node_modules/evil-dep': {
            version: '1.0.0',
            resolved: 'https://evil.example.com/evil-dep-1.0.0.tgz',
            integrity: 'sha512-evilevilevil',
          },
        },
        { lodash: '^4.17.21' }
      )
    );
    const result = await scanStaged();

    expect(tamperSignals(result, 'evil-dep')).toContain('url-source:evil.example.com');
    expect(result.exitCode).toBe(1);
  });

  test('npm: a new entry from an ordinary registry tarball raises nothing', async () => {
    await commitBase({ 'package-lock.json': npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }) });
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodash': CLEAN_LODASH,
          'node_modules/left-pad': {
            version: '1.3.0',
            resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
            integrity: 'sha512-leftpad',
          },
        },
        { lodash: '^4.17.21' }
      )
    );
    const result = await scanStaged();

    expect(tamperSignals(result, 'left-pad')).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('npm: a new entry from the project registry host with no /-/ tarball path raises nothing', async () => {
    await write('.npmrc', '@acme:registry=https://npm.pkg.example.com/\n');
    await commitBase({ 'package-lock.json': npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }) });
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodash': CLEAN_LODASH,
          'node_modules/@acme/widget': {
            version: '1.0.0',
            resolved: 'https://npm.pkg.example.com/download/@acme/widget/1.0.0/abcdef',
            integrity: 'sha512-widget',
          },
        },
        { lodash: '^4.17.21' }
      )
    );
    const result = await scanStaged();

    expect(tamperSignals(result, '@acme/widget')).toEqual([]);
  });

  test('npm: a declared git dependency is reported once, by its specifier, not again by its lock entry', async () => {
    await commitBase({ 'package-lock.json': npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }) });
    await write('package.json', manifestJson({ lodash: '^4.17.21', 'evil-dep': 'github:attacker/evil-dep' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodash': CLEAN_LODASH,
          'node_modules/evil-dep': {
            version: '1.0.0',
            resolved: `git+ssh://git@github.com/attacker/evil-dep.git#${PINNED}`,
          },
        },
        { lodash: '^4.17.21', 'evil-dep': 'github:attacker/evil-dep' }
      )
    );
    const result = await scanStaged();

    expect(tamperSignals(result, 'evil-dep').filter((s) => s.startsWith('git-source'))).toEqual(['git-source']);
  });

  test('pnpm: a new entry whose resolution is a non-registry tarball', async () => {
    await commitBase({ 'pnpm-lock.yaml': pnpmLock('integrity: sha512-cleanlodash') });
    await write(
      'pnpm-lock.yaml',
      pnpmLock('integrity: sha512-cleanlodash').replace(
        'snapshots:',
        [
          '  evil-dep@1.0.0:',
          '    resolution: {tarball: https://evil.example.com/evil-dep.tgz}',
          '    version: 1.0.0',
          '',
          'snapshots:',
        ].join('\n')
      )
    );
    const result = await scanStaged();

    expect(tamperSignals(result, 'evil-dep')).toContain('url-source:evil.example.com');
    expect(result.exitCode).toBe(1);
  });

  test('pnpm: a new entry whose resolution is a git commit', async () => {
    await commitBase({ 'pnpm-lock.yaml': pnpmLock('integrity: sha512-cleanlodash') });
    await write(
      'pnpm-lock.yaml',
      pnpmLock('integrity: sha512-cleanlodash').replace(
        'snapshots:',
        [
          '  evil-dep@https://codeload.github.com/attacker/evil-dep/tar.gz/' + PINNED + ':',
          `    resolution: {tarball: https://codeload.github.com/attacker/evil-dep/tar.gz/${PINNED}}`,
          '    version: 1.0.0',
          '',
          '  evil-git@git+https://github.com/attacker/evil-git.git#' + PINNED + ':',
          `    resolution: {commit: ${PINNED}, repo: https://github.com/attacker/evil-git.git, type: git}`,
          '    version: 1.0.0',
          '',
          'snapshots:',
        ].join('\n')
      )
    );
    const result = await scanStaged();

    expect(tamperSignals(result, 'evil-dep')).toContain('git-source:codeload.github.com');
    expect(tamperSignals(result, 'evil-git')).toContain('git-source:github.com');
    expect(result.exitCode).toBe(1);
  });

  test('pnpm: a new entry with an integrity-only registry resolution raises nothing', async () => {
    await commitBase({ 'pnpm-lock.yaml': pnpmLock('integrity: sha512-cleanlodash') });
    await write(
      'pnpm-lock.yaml',
      pnpmLock('integrity: sha512-cleanlodash').replace(
        'snapshots:',
        ['  left-pad@1.3.0:', '    resolution: {integrity: sha512-leftpad}', '', 'snapshots:'].join('\n')
      )
    );
    const result = await scanStaged();

    expect(tamperSignals(result, 'left-pad')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fix round: review findings B1, B2 and N1 to N6.
// ---------------------------------------------------------------------------

const SHA40 = '0123456789abcdef0123456789abcdef01234567';

describe('B1: a declared git source does not hide a different source under the same name', () => {
  const lockWithNestedEvil = (): string =>
    npmLock(
      {
        'node_modules/foo': {
          version: '1.0.0',
          resolved: `git+ssh://git@github.com/o/r.git#${SHA40}`,
        },
        'node_modules/bar': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/bar/-/bar-1.0.0.tgz',
          integrity: 'sha512-bar',
        },
        'node_modules/bar/node_modules/foo': {
          version: '2.0.0',
          resolved: 'https://evil.example.com/foo-2.0.0.tgz',
          integrity: 'sha512-evilfoo',
        },
      },
      { foo: `github:o/r#${SHA40}`, bar: '^1.0.0' }
    );
  const manifestWithFoo = (): string => manifestJson({ foo: `github:o/r#${SHA40}`, bar: '^1.0.0' });

  test('delta mode reports the nested evil url source as well as the declared git source', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');
    await write('package.json', manifestWithFoo());
    await write('package-lock.json', lockWithNestedEvil());
    const result = await scanStaged();

    const signals = tamperSignals(result, 'foo');
    expect(signals).toContain('url-source:evil.example.com');
    expect(signals).toContain('git-source');
    expect(result.exitCode).toBe(1);
  });

  test('audit mode reports the nested evil url source at critical', async () => {
    await write('package.json', manifestWithFoo());
    await write('package-lock.json', lockWithNestedEvil());
    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    const evil = result.findings.find(
      (f) => f.ruleId === 'lockfile-tamper' && f.details?.signal === 'url-source:evil.example.com'
    );
    expect(evil?.severity).toBe('critical');
  });
});

describe('B2: an added entry is judged by host first, path shape only sets severity', () => {
  const EVIL_SHAPED = 'https://evil.example.com/baz/-/baz-1.0.0.tgz';

  async function baseThenAdd(npmrc: string | null, resolved: string): Promise<void> {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    await commitAll('first');
    if (npmrc !== null) {
      await write('.npmrc', npmrc);
    }
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodash': CLEAN_LODASH,
          'node_modules/baz': { version: '1.0.0', resolved, integrity: 'sha512-baz' },
        },
        { lodash: '^4.17.21' }
      )
    );
  }

  test('an evil host with a registry-shaped path blocks under --base, at high, naming the .npmrc remedy', async () => {
    await baseThenAdd(null, EVIL_SHAPED);
    const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'HEAD' }, corpusDir: FIXTURE_CORPUS });

    const finding = result.findings.find((f) => f.details?.signal === 'url-source:evil.example.com');
    expect(finding?.severity).toBe('high');
    expect(finding?.message).toContain('.npmrc');
    expect(result.exitCode).toBe(1);
  });

  test('an evil host with an unshaped path is critical', async () => {
    await baseThenAdd(null, 'https://evil.example.com/baz-1.0.0.tgz');
    const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'HEAD' }, corpusDir: FIXTURE_CORPUS });

    expect(result.findings.find((f) => f.details?.signal === 'url-source:evil.example.com')?.severity).toBe('critical');
  });

  test('under --trust-base a head .npmrc that vouches for the evil host does not clear it', async () => {
    await baseThenAdd('registry=https://evil.example.com/\n', EVIL_SHAPED);
    await commitAll('head');
    const result = await scan({
      repoRoot: repo,
      mode: { kind: 'base', ref: 'HEAD~1' },
      trustBase: 'HEAD~1',
      corpusDir: FIXTURE_CORPUS,
    });

    expect(tamperSignals(result, 'baz')).toContain('url-source:evil.example.com');
  });

  test('a host pinned in the project .npmrc raises nothing', async () => {
    await write('.npmrc', 'registry=https://npm.corp.example/\n');
    await baseThenAdd(null, 'https://npm.corp.example/baz/-/baz-1.0.0.tgz');
    const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'HEAD' }, corpusDir: FIXTURE_CORPUS });

    expect(tamperSignals(result, 'baz')).toEqual([]);
  });

  test('GitHub Packages with the host pinned raises nothing, and without the pin it is a finding', async () => {
    const url = 'https://npm.pkg.github.com/download/@acme/baz/1.0.0/0123456789abcdef';
    await write('.npmrc', '@acme:registry=https://npm.pkg.github.com\n');
    await baseThenAdd(null, url);
    const pinned = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'HEAD' }, corpusDir: FIXTURE_CORPUS });
    expect(tamperSignals(pinned, 'baz')).toEqual([]);

    await rm(path.join(repo, '.npmrc'));
    const unpinned = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'HEAD' }, corpusDir: FIXTURE_CORPUS });
    const finding = unpinned.findings.find((f) => f.details?.signal === 'url-source:npm.pkg.github.com');
    expect(finding?.severity).toBe('high');
  });
});

describe('N1: losing every parsed lockfile is a downgrade, not a clean pass', () => {
  async function baseWithNpmLock(): Promise<void> {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    await commitAll('first');
  }

  test('npm lockfile replaced by a yarn.lock', async () => {
    await baseWithNpmLock();
    await rm(path.join(repo, 'package-lock.json'));
    await write('yarn.lock', '# yarn lockfile v1\n');

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('pnpm lockfile replaced by a v1 npm lockfile', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('pnpm-lock.yaml', pnpmLock('integrity: sha512-cleanlodash'));
    await commitAll('first');
    await rm(path.join(repo, 'pnpm-lock.yaml'));
    await write('package-lock.json', JSON.stringify({ name: 'root', lockfileVersion: 1, dependencies: {} }));

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('control: npm lockfile replaced by a parsed pnpm lockfile is not a downgrade', async () => {
    await baseWithNpmLock();
    await rm(path.join(repo, 'package-lock.json'));
    await write('pnpm-lock.yaml', pnpmLock('integrity: sha512-cleanlodash'));

    await expect(scanStaged()).resolves.toBeDefined();
  });

  test('a lockfile deleted with nothing in its place while dependencies are declared is a downgrade', async () => {
    await baseWithNpmLock();
    await rm(path.join(repo, 'package-lock.json'));

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('control: a lockfile deleted together with every dependency is left to the lockfile-missing path', async () => {
    await baseWithNpmLock();
    await rm(path.join(repo, 'package-lock.json'));
    await write('package.json', manifestJson({}));
    const result = await scanStaged();

    expect(result.run.diagnostics.map((d) => d.code)).toContain('lockfile-missing');
  });
});

describe('N2: an extra lockfile that exists only on the head side is still compared', () => {
  test('a new pnpm-lock.yaml pointing lodash at another package tarball, beside an existing package-lock.json', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    await commitAll('first');
    await write(
      'pnpm-lock.yaml',
      pnpmLock(
        'integrity: sha512-otherpackagehash, tarball: https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz'
      )
    );
    const result = await scanStaged();

    expect(tamperSignals(result, 'lodash').some((s) => s.startsWith('tarball-repointed'))).toBe(true);
    expect(result.exitCode).toBe(1);
  });
});

describe('N3: pnpm git resolutions are recognised in every spelling pnpm writes', () => {
  async function addEntry(lines: string[]): Promise<ScanResult> {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('pnpm-lock.yaml', pnpmLock('integrity: sha512-cleanlodash'));
    await commitAll('first');
    await write(
      'pnpm-lock.yaml',
      pnpmLock('integrity: sha512-cleanlodash').replace('snapshots:', [...lines, '', 'snapshots:'].join('\n'))
    );
    return scanStaged();
  }

  test('an scp-style repo in a git resolution is git', async () => {
    const result = await addEntry([
      `  evil-git@git+ssh://git@github.com/attacker/evil-git.git#${SHA40}:`,
      `    resolution: {commit: ${SHA40}, repo: git@github.com:attacker/evil-git.git, type: git}`,
      '    version: 1.0.0',
    ]);

    expect(tamperSignals(result, 'evil-git')).toContain('git-source:github.com');
  });

  test('a key with an embedded "@" is parsed, and its entry is a finding rather than a skip diagnostic', async () => {
    const result = await addEntry([
      `  baz@git+ssh://git@github.com/attacker/baz.git#${SHA40}:`,
      `    resolution: {commit: ${SHA40}, repo: ssh://git@github.com/attacker/baz.git, type: git}`,
      '    version: 1.0.0',
    ]);

    expect(tamperSignals(result, 'baz')).toContain('git-source:github.com');
    expect(result.run.diagnostics.map((d) => d.code)).not.toContain('pnpm-lockfile-invalid-entry');
  });
});

describe('N6: the same signal in two lockfiles names both files', () => {
  test('a host change identical in package-lock.json and pnpm-lock.yaml is reported for each', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    await write('pnpm-lock.yaml', pnpmLock('integrity: sha512-cleanlodash'));
    await commitAll('first');
    await write('package-lock.json', npmLock({ 'node_modules/lodash': TAMPERED_LODASH }, { lodash: '^4.17.21' }));
    await write(
      'pnpm-lock.yaml',
      pnpmLock('integrity: sha512-evilevilevil, tarball: https://evil.example.com/x.tgz')
    );
    const result = await scanStaged();

    const files = result.findings
      .filter((f) => f.ruleId === 'lockfile-tamper' && f.packageName === 'lodash' && String(f.details?.signal).startsWith('host-changed'))
      .map((f) => f.lockfilePath)
      .sort();
    expect(files).toEqual(['package-lock.json', 'pnpm-lock.yaml']);
  });
});

describe('N7: the lockfile set may not lose coverage or gain unread bytes', () => {
  const L = { lodash: '^4.17.21' };
  const TAMPERED_YARN = [
    '# yarn lockfile v1',
    '',
    'lodash@^4.17.21:',
    '  version "4.17.21"',
    '  resolved "https://evil.example.com/lodash-4.17.21.tgz#deadbeef"',
    '  integrity sha512-evilevilevil',
    '',
  ].join('\n');
  const GUTTED_NPM = npmLock({}, L);
  const PNPM_NO_PACKAGES = [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      lodash:',
    '        specifier: ^4.17.21',
    '        version: 4.17.21',
    '',
  ].join('\n');

  async function baseWith(files: Record<string, string>, deps: Record<string, string> = L): Promise<void> {
    await write('package.json', manifestJson(deps));
    for (const [relPath, content] of Object.entries(files)) {
      await write(relPath, content);
    }
    await commitAll('first');
    await git('tag', 'base');
  }

  const NPM_BASE = { 'package-lock.json': npmLock({ 'node_modules/lodash': CLEAN_LODASH }, L) };
  const PNPM_BASE = { 'pnpm-lock.yaml': pnpmLock('integrity: sha512-cleanlodash') };

  async function refusal(promise: Promise<unknown>): Promise<(Error & { code?: string }) | null> {
    return promise.then(
      () => null,
      (err: unknown) => err as Error & { code?: string }
    );
  }

  test('a clean package-lock.json kept and a new yarn.lock added is refused', async () => {
    await baseWith(NPM_BASE);
    await write('yarn.lock', TAMPERED_YARN);

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('a gutted package-lock.json beside a new yarn.lock is refused', async () => {
    await baseWith(NPM_BASE);
    await write('package-lock.json', GUTTED_NPM);
    await write('yarn.lock', TAMPERED_YARN);

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('a pnpm-lock.yaml with no packages key beside a new yarn.lock is refused', async () => {
    await baseWith(PNPM_BASE);
    await write('pnpm-lock.yaml', PNPM_NO_PACKAGES);
    await write('yarn.lock', TAMPERED_YARN);

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('a package-lock.json gutted to zero entries while package.json declares lodash is refused', async () => {
    await baseWith(NPM_BASE);
    await write('package-lock.json', GUTTED_NPM);

    const error = await refusal(scanStaged());
    expect(error?.code).toBe('lockfile-downgrade');
    expect(error?.message).toContain('no lockfile this tool reads has an entry');
  });

  test('a package-lock.json gutted by marking lodash "link": true is refused', async () => {
    await baseWith(NPM_BASE);
    await write('package-lock.json', npmLock({ 'node_modules/lodash': { resolved: 'lodash', link: true } }, L));

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('a gutted lockfile is refused when the only dependency left is a peerDependency', async () => {
    await baseWith(NPM_BASE);
    await write('package.json', JSON.stringify({ name: 'root', version: '1.0.0', peerDependencies: L }));
    await write('package-lock.json', GUTTED_NPM);

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('a v1 package-lock.json added beside a parsed pnpm-lock.yaml is refused', async () => {
    await baseWith(PNPM_BASE);
    await write('package-lock.json', JSON.stringify({ name: 'root', lockfileVersion: 1, dependencies: {} }));

    const error = await refusal(scanStaged());
    expect(error?.code).toBe('lockfile-downgrade');
    expect(error?.message).toContain('package-lock.json');
    expect(error?.message).toContain('a lockfile at the repository root that this tool does not read');
  });

  test('a yarn.lock beside a covering package-lock.json that changes is refused', async () => {
    await baseWith({ ...NPM_BASE, 'yarn.lock': '# yarn lockfile v1\n' });
    await write('yarn.lock', TAMPERED_YARN);

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('a bun.lockb that changes in one invalid utf8 byte beside a covering lockfile is refused', async () => {
    await baseWith(NPM_BASE);
    await writeFile(path.join(repo, 'bun.lockb'), Buffer.from([0x62, 0x75, 0x6e, 0xff, 0x00]));
    await commitAll('bun added');
    await git('tag', '-f', 'base');
    await writeFile(path.join(repo, 'bun.lockb'), Buffer.from([0x62, 0x75, 0x6e, 0xfe, 0x00]));

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('a head yarn.lock that is a directory beside a covering lockfile is refused', async () => {
    await baseWith(NPM_BASE);
    await mkdir(path.join(repo, 'yarn.lock'));

    await expect(
      scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS })
    ).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('a head yarn.lock that is a symlink cycle beside a covering lockfile is refused', async () => {
    await baseWith(NPM_BASE);
    await symlink('yarn.lock', path.join(repo, 'yarn.lock'));

    await expect(
      scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS })
    ).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('the only lockfile deleted while dependencies are still declared is refused, and the message says so', async () => {
    await baseWith(NPM_BASE);
    await rm(path.join(repo, 'package-lock.json'));

    const error = await refusal(scanStaged());
    expect(error?.code).toBe('lockfile-downgrade');
    expect(error?.message).toContain('no lockfile this tool reads has an entry');
    expect(error?.message).toContain('package-lock.json');
  });

  test('pnpm-lock.yaml deleted while an unchanged bun.lockb remains is refused', async () => {
    await baseWith({ ...PNPM_BASE, 'bun.lockb': 'bun-binary' });
    await rm(path.join(repo, 'pnpm-lock.yaml'));

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('control: pnpm replaced by an npm v3 lockfile with entries resolves', async () => {
    await baseWith(PNPM_BASE);
    await rm(path.join(repo, 'pnpm-lock.yaml'));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, L));

    await expect(scanStaged()).resolves.toBeDefined();
  });

  test('control: a pnpm lockfileVersion 5.4 lockfile migrated to v9 resolves', async () => {
    const v5 = [
      'lockfileVersion: 5.4',
      '',
      'specifiers:',
      '  lodash: ^4.17.21',
      '',
      'dependencies:',
      '  lodash: 4.17.21',
      '',
      'packages:',
      '',
      '  /lodash/4.17.21:',
      '    resolution: {integrity: sha512-cleanlodash}',
      '    dev: false',
      '',
    ].join('\n');
    await baseWith({ 'pnpm-lock.yaml': v5 });
    await write('pnpm-lock.yaml', pnpmLock('integrity: sha512-cleanlodash'));

    const result = await scanStaged();
    expect(tamperSignals(result, 'lodash')).toEqual([]);
  });

  test('control: every dependency removed and the lockfile emptied resolves', async () => {
    await baseWith(NPM_BASE);
    await write('package.json', manifestJson({}));
    await write('package-lock.json', npmLock({}, {}));

    await expect(scanStaged()).resolves.toBeDefined();
  });

  test('control: bun.lockb replaced by bun.lock with no readable lockfile on the base resolves', async () => {
    await baseWith({ 'bun.lockb': 'bun-binary' });
    await rm(path.join(repo, 'bun.lockb'));
    await write('bun.lock', '{}\n');

    await expect(scanStaged()).resolves.toBeDefined();
  });

  test('control: one of two covering lockfiles deleted resolves', async () => {
    await baseWith({ ...NPM_BASE, ...PNPM_BASE });
    await rm(path.join(repo, 'pnpm-lock.yaml'));

    await expect(scanStaged()).resolves.toBeDefined();
  });

  test('control: an unchanged legacy yarn.lock beside package-lock.json resolves with lockfile-unread-sibling', async () => {
    await baseWith({ ...NPM_BASE, 'yarn.lock': '# yarn lockfile v1\n' });
    await write('package.json', manifestJson({ ...L, chalk: '^5.0.0' }));

    const result = await scanStaged();
    const note = result.run.diagnostics.find((d) => d.code === 'lockfile-unread-sibling');
    expect(note?.message).toContain('yarn.lock');
  });

  test('control: a lockfile left with only workspace links while only workspace packages are declared resolves', async () => {
    await baseWith(NPM_BASE);
    await write(
      'package.json',
      JSON.stringify({ name: 'root', version: '1.0.0', workspaces: ['packages/*'], dependencies: { '@me/lib': '^1.0.0' } })
    );
    await write('packages/lib/package.json', JSON.stringify({ name: '@me/lib', version: '1.0.0' }));
    await write(
      'package-lock.json',
      npmLock({ 'packages/lib': { name: '@me/lib', version: '1.0.0' }, 'node_modules/@me/lib': { resolved: 'packages/lib', link: true } }, { '@me/lib': '^1.0.0' })
    );

    await expect(scanStaged()).resolves.toBeDefined();
  });

  const selfManagementDoc = (tarball: string): string =>
    [
      '---',
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    packageManagerDependencies:',
      '      pnpm:',
      '        specifier: 10.0.0',
      '        version: 10.0.0',
      '',
      'packages:',
      '',
      '  pnpm@10.0.0:',
      `    resolution: {integrity: sha512-pnpmpnpm, tarball: ${tarball}}`,
      '',
      'snapshots:',
      '',
      '  pnpm@10.0.0: {}',
      '',
    ].join('\n');
  const PNPM_REGISTRY_TARBALL = 'https://registry.npmjs.org/pnpm/-/pnpm-10.0.0.tgz';
  const multiDoc = (tarball: string): string =>
    `${selfManagementDoc(tarball)}\n---\n${pnpmLock('integrity: sha512-cleanlodash')}`;

  test('a pnpm self-management document prepended with a tarball on another host is a finding, exit 1', async () => {
    await baseWith(PNPM_BASE);
    await write('pnpm-lock.yaml', multiDoc('https://evil.example.com/pnpm.tgz'));

    const result = await scanStaged();
    const finding = result.findings.find((f) => f.packageName === 'pnpm' && f.ruleId === 'lockfile-tamper');
    expect(finding?.lockfilePath).toBe('pnpm-lock.yaml#package-manager');
    expect(result.exitCode).toBe(1);
  });

  test('a pnpm self-management document repointed to another host is a finding, exit 1', async () => {
    await baseWith({ 'pnpm-lock.yaml': multiDoc(PNPM_REGISTRY_TARBALL) });
    await write('pnpm-lock.yaml', multiDoc('https://evil.example.com/pnpm.tgz'));

    const result = await scanStaged();
    expect(tamperSignals(result, 'pnpm').some((s) => s.startsWith('host-changed'))).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  // Modelled on the pnpm repository's own self-update commits: the
  // self-management document moves pnpm to a new version with a new
  // registry integrity hash.
  test('an honest pnpm self-update is exit 0 with no refusal', async () => {
    const selfAt = (version: string, integrity: string): string =>
      [
        '---',
        "lockfileVersion: '9.0'",
        '',
        'importers:',
        '',
        '  .:',
        '    configDependencies: {}',
        '    packageManagerDependencies:',
        '      pnpm:',
        `        specifier: ${version}`,
        `        version: ${version}`,
        '',
        'packages:',
        '',
        `  pnpm@${version}:`,
        `    resolution: {integrity: ${integrity}}`,
        '',
        'snapshots:',
        '',
        `  pnpm@${version}: {}`,
        '',
      ].join('\n');
    const project = `---\n${pnpmLock('integrity: sha512-cleanlodash')}`;
    await baseWith({ 'pnpm-lock.yaml': `${selfAt('12.8.0', 'sha512-pnpmold')}\n${project}` });
    await write('pnpm-lock.yaml', `${selfAt('12.8.1', 'sha512-pnpmnew')}\n${project}`);

    const result = await scanStaged();
    expect(result.exitCode).toBe(0);
    expect(result.findings).toEqual([]);
  });

  const ODD_DOC = '---\nnotALockfile: 1\n';
  const ODD_DOC_2 = '---\nnotALockfile: 2\n';
  const projectDoc = (): string => `---\n${pnpmLock('integrity: sha512-cleanlodash')}`;

  test('a document not shaped like a pnpm lockfile, newly added, is refused', async () => {
    await baseWith(PNPM_BASE);
    await write('pnpm-lock.yaml', `${ODD_DOC}${projectDoc()}`);

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('a document not shaped like a pnpm lockfile that is duplicated is refused', async () => {
    await baseWith({ 'pnpm-lock.yaml': `${ODD_DOC}${projectDoc()}` });
    await write('pnpm-lock.yaml', `${ODD_DOC}${ODD_DOC}${projectDoc()}`);

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('one of several documents not shaped like a pnpm lockfile, removed, is refused', async () => {
    await baseWith({ 'pnpm-lock.yaml': `${ODD_DOC}${ODD_DOC_2}${projectDoc()}` });
    await write('pnpm-lock.yaml', `${ODD_DOC}${projectDoc()}`);

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('the only document not shaped like a pnpm lockfile, removed, is refused', async () => {
    await baseWith({ 'pnpm-lock.yaml': `${ODD_DOC}${projectDoc()}` });
    await write('pnpm-lock.yaml', pnpmLock('integrity: sha512-cleanlodash'));

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('a YAML directive added before a document not shaped like a pnpm lockfile is refused', async () => {
    await baseWith({ 'pnpm-lock.yaml': `${ODD_DOC}${projectDoc()}` });
    await write('pnpm-lock.yaml', `%YAML 1.2\n${ODD_DOC}${projectDoc()}`);

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('control: an unchanged document not shaped like a pnpm lockfile keeps the multi-document note', async () => {
    await baseWith({ 'pnpm-lock.yaml': `${ODD_DOC}${projectDoc()}` });
    await write('package.json', manifestJson({ ...L, chalk: '^5.0.0' }));

    const result = await scanStaged();
    expect(result.run.diagnostics.map((d) => d.code)).toContain('pnpm-multi-document-lockfile');
  });

  test('the primary lockfile is the first one this tool reads', async () => {
    const v1 = JSON.stringify({ name: 'root', lockfileVersion: 1, dependencies: {} });
    await baseWith({ ...PNPM_BASE, 'package-lock.json': v1 });
    await write('package.json', manifestJson({ ...L, chalk: '^5.0.0' }));

    const result = await scanStaged();
    expect(result.run.lockfileFormat).toBe('pnpm');
  });
});

describe('N9: a .npmrc that differs from the comparison side makes every integrity rewrite count', () => {
  const L = { lodash: '^4.17.21' };

  async function commitBaseThenHead(base: Record<string, string>, head: Record<string, string>): Promise<void> {
    await write('package.json', manifestJson(L));
    for (const [relPath, content] of Object.entries(base)) {
      await write(relPath, content);
    }
    await commitAll('first');
    await git('tag', 'base');
    for (const [relPath, content] of Object.entries(head)) {
      await write(relPath, content);
    }
    await commitAll('head');
  }

  function scanPullRequest(): Promise<ScanResult> {
    return scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS, trustBase: 'base' });
  }

  test('npm: a head .npmrc plus a sha1 to sha512 rehash at the same URL is integrity-changed', async () => {
    await commitBaseThenHead(
      { 'package-lock.json': npmLock({ 'node_modules/lodash': { ...CLEAN_LODASH, integrity: 'sha1-oldsha1value' } }, L) },
      {
        '.npmrc': 'registry=https://evil.example.com/\n',
        'package-lock.json': npmLock({ 'node_modules/lodash': { ...CLEAN_LODASH, integrity: 'sha512-forged' } }, L),
      }
    );
    const result = await scanPullRequest();
    expect(tamperSignals(result, 'lodash')).toContain('integrity-changed');
    expect(result.exitCode).toBe(1);
  });

  test('pnpm: a head .npmrc plus a sha1 to sha512 rehash is integrity-changed', async () => {
    await commitBaseThenHead(
      { 'pnpm-lock.yaml': pnpmLock('integrity: sha1-oldsha1value') },
      { '.npmrc': 'registry=https://evil.example.com/\n', 'pnpm-lock.yaml': pnpmLock('integrity: sha512-forged') }
    );
    const result = await scanPullRequest();
    expect(tamperSignals(result, 'lodash')).toContain('integrity-changed');
    expect(result.exitCode).toBe(1);
  });

  test('control: the same rehash with .npmrc unchanged is not a finding', async () => {
    await commitBaseThenHead(
      { 'package-lock.json': npmLock({ 'node_modules/lodash': { ...CLEAN_LODASH, integrity: 'sha1-oldsha1value' } }, L) },
      { 'package-lock.json': npmLock({ 'node_modules/lodash': { ...CLEAN_LODASH, integrity: 'sha512-forged' } }, L) }
    );
    const result = await scanPullRequest();
    expect(tamperSignals(result, 'lodash')).toEqual([]);
  });

  test('a .npmrc that matches the --base side but differs from the trust base still makes the rehash count', async () => {
    const sha1Lock = npmLock({ 'node_modules/lodash': { ...CLEAN_LODASH, integrity: 'sha1-oldsha1value' } }, L);
    await write('package.json', manifestJson(L));
    await write('package-lock.json', sha1Lock);
    await commitAll('trusted');
    await git('tag', 'trusted');
    await write('.npmrc', 'registry=https://evil.example.com/\n');
    await commitAll('add an npmrc');
    await git('tag', 'base');
    await write('package-lock.json', npmLock({ 'node_modules/lodash': { ...CLEAN_LODASH, integrity: 'sha512-forged' } }, L));
    await commitAll('rehash');

    const result = await scan({
      repoRoot: repo,
      mode: { kind: 'base', ref: 'base' },
      corpusDir: FIXTURE_CORPUS,
      trustBase: 'trusted',
    });
    expect(tamperSignals(result, 'lodash')).toContain('integrity-changed');
    expect(result.exitCode).toBe(1);
  });
});

describe('N11: the lockfile downgrade rule is evaluated against every comparison side', () => {
  const L = { lodash: '^4.17.21' };
  const NPM_LOCK = npmLock({ 'node_modules/lodash': CLEAN_LODASH }, L);
  const YARN = '# yarn lockfile v1\n\nlodash@^4.17.21:\n  version "4.17.21"\n  resolved "https://evil.example.com/l.tgz"\n';

  test('--trust-base alone: npm replaced by yarn is refused against the trust base', async () => {
    await write('package.json', manifestJson(L));
    await write('package-lock.json', NPM_LOCK);
    await commitAll('first');
    await git('tag', 'trusted');
    await rm(path.join(repo, 'package-lock.json'));
    await write('yarn.lock', YARN);
    await commitAll('head');

    await expect(
      scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS, trustBase: 'trusted' })
    ).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('--trust-base alone does not turn the run into a comparison of findings', async () => {
    await write('package.json', manifestJson(L));
    await write('package-lock.json', NPM_LOCK);
    await commitAll('first');
    await git('tag', 'trusted');
    await write('package.json', manifestJson({ ...L, chalk: '^5.0.0' }));
    await commitAll('head');

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS, trustBase: 'trusted' });
    expect(result.run.mode).toBe('audit');
  });

  test('--base X --trust-base Y where X already has the yarn.lock and Y does not is refused', async () => {
    await write('package.json', manifestJson(L));
    await write('package-lock.json', NPM_LOCK);
    await commitAll('trusted state');
    await git('tag', 'trusted');
    await write('yarn.lock', YARN);
    await commitAll('yarn.lock added');
    await git('tag', 'weaker');
    await write('package.json', manifestJson({ ...L, chalk: '^5.0.0' }));
    await commitAll('head');

    await expect(
      scan({ repoRoot: repo, mode: { kind: 'base', ref: 'weaker' }, corpusDir: FIXTURE_CORPUS, trustBase: 'trusted' })
    ).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('control: --staged with --trust-base compares the index against HEAD only', async () => {
    await write('package.json', manifestJson(L));
    await write('package-lock.json', NPM_LOCK);
    await commitAll('trusted state');
    await git('tag', 'trusted');
    await rm(path.join(repo, 'package-lock.json'));
    await write('yarn.lock', YARN);
    await write('package.json', manifestJson({}));
    await commitAll('migration branch, first commit');
    await write('package.json', manifestJson({ chalk: '^5.0.0' }));

    await git('add', '-A');
    await expect(
      scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS, trustBase: 'trusted' })
    ).resolves.toBeDefined();
  });
});

describe('N12: every workspace pattern npm honours reaches its manifests', () => {
  for (const pattern of ['packages//app', 'packages/*/app', 'packages/**']) {
    test(`a dependency added in a workspace named by "${pattern}" is checked`, async () => {
      const lock = (deps: Record<string, string>): string =>
        npmLock(
          { 'packages/group/app': { name: 'app', version: '1.0.0', dependencies: deps }, 'node_modules/app': { resolved: 'packages/group/app', link: true } },
          {}
        );
      const dir = pattern === 'packages//app' ? 'packages/app' : 'packages/group/app';
      await write('package.json', JSON.stringify({ name: 'root', version: '1.0.0', workspaces: [pattern] }));
      await write(`${dir}/package.json`, JSON.stringify({ name: 'app', version: '1.0.0', dependencies: {} }));
      await write('package-lock.json', lock({}));
      await commitAll('first');
      await write(
        `${dir}/package.json`,
        JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'zz-made-up-hallucinated-pkg': '^1.0.0' } })
      );
      const result = await scanStaged();

      expect(result.findings.map((f) => `${f.ruleId}:${f.packageName}`)).toContain(
        'unknown-package:zz-made-up-hallucinated-pkg'
      );
    });
  }
});

describe('N13: an acknowledgement on the comparison side lets exactly the named lockfile bytes through', () => {
  const L = { lodash: '^4.17.21' };
  const NPM_LOCK = npmLock({ 'node_modules/lodash': CLEAN_LODASH }, L);
  const YARN = '# yarn lockfile v1\n\nlodash@^4.17.21:\n  version "4.17.21"\n';
  const OTHER_YARN = '# yarn lockfile v1\n\nlodash@^4.17.21:\n  version "4.17.20"\n';

  async function blobOf(content: string): Promise<string> {
    await write('.blob-probe', content);
    const id = (await git('hash-object', '.blob-probe')).trim();
    await rm(path.join(repo, '.blob-probe'));
    return id;
  }

  function config(acknowledgedLockfiles: string[]): string {
    return JSON.stringify({ acknowledgedLockfiles });
  }

  async function base(files: Record<string, string>): Promise<void> {
    await write('package.json', manifestJson(L));
    for (const [relPath, content] of Object.entries(files)) {
      await write(relPath, content);
    }
    await commitAll('base');
    await git('tag', 'base');
  }

  function pullRequest(): Promise<ScanResult> {
    return scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS, trustBase: 'base' });
  }

  async function migrateToYarn(content = YARN): Promise<void> {
    await rm(path.join(repo, 'package-lock.json'));
    await write('yarn.lock', content);
    await commitAll('migrate to yarn');
  }

  test('an entry on the trust base for the head yarn.lock blob clears a migration, and the run names it', async () => {
    const blob = await blobOf(YARN);
    await base({ 'package-lock.json': NPM_LOCK, '.dep-guard.json': config([`yarn.lock:${blob}`]) });
    await migrateToYarn();

    const result = await pullRequest();
    const note = result.run.diagnostics.find((d) => d.code === 'lockfile-downgrade-acknowledged');
    expect(note?.message).toContain(`yarn.lock:${blob}`);
  });

  test('an entry added only on the head does not clear', async () => {
    await base({ 'package-lock.json': NPM_LOCK });
    await write('.dep-guard.json', config([`yarn.lock:${await blobOf(YARN)}`]));
    await migrateToYarn();

    await expect(pullRequest()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  // The covering package-lock.json stays, so only the unread-bytes half of
  // the rule can refuse here.
  test('an entry for a different blob id does not clear', async () => {
    await base({ 'package-lock.json': NPM_LOCK, '.dep-guard.json': config([`yarn.lock:${await blobOf(OTHER_YARN)}`]) });
    await write('yarn.lock', YARN);
    await commitAll('add yarn.lock');

    await expect(pullRequest()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('an entry for the right blob clears a changed unread lockfile beside a covering one', async () => {
    const blob = await blobOf(YARN);
    await base({ 'package-lock.json': NPM_LOCK, '.dep-guard.json': config([`yarn.lock:${blob}`]) });
    await write('yarn.lock', YARN);
    await commitAll('add yarn.lock');

    const result = await pullRequest();
    expect(result.run.diagnostics.map((d) => d.code)).toContain('lockfile-downgrade-acknowledged');
  });

  test('the deletion form clears only when every covering base lockfile is named with its base blob id', async () => {
    const npmBlob = await blobOf(NPM_LOCK);
    const pnpmContent = pnpmLock('integrity: sha512-cleanlodash');
    const pnpmBlob = await blobOf(pnpmContent);
    await base({
      'package-lock.json': NPM_LOCK,
      'pnpm-lock.yaml': pnpmContent,
      '.dep-guard.json': config([`package-lock.json:${npmBlob}`, `pnpm-lock.yaml:${pnpmBlob}`]),
    });
    await rm(path.join(repo, 'package-lock.json'));
    await rm(path.join(repo, 'pnpm-lock.yaml'));
    await commitAll('stop committing lockfiles');

    const result = await pullRequest();
    expect(result.run.diagnostics.map((d) => d.code)).toContain('lockfile-downgrade-acknowledged');
  });

  test('a partial deletion set does not clear', async () => {
    const npmBlob = await blobOf(NPM_LOCK);
    await base({
      'package-lock.json': NPM_LOCK,
      'pnpm-lock.yaml': pnpmLock('integrity: sha512-cleanlodash'),
      '.dep-guard.json': config([`package-lock.json:${npmBlob}`]),
    });
    await rm(path.join(repo, 'package-lock.json'));
    await rm(path.join(repo, 'pnpm-lock.yaml'));
    await commitAll('stop committing lockfiles');

    await expect(pullRequest()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('without a trust base, the entry is read from the --base ref', async () => {
    const blob = await blobOf(YARN);
    await base({ 'package-lock.json': NPM_LOCK, '.dep-guard.json': config([`yarn.lock:${blob}`]) });
    await migrateToYarn();

    const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS });
    expect(result.run.diagnostics.map((d) => d.code)).toContain('lockfile-downgrade-acknowledged');
  });

  test('without a trust base, an entry only in the working tree does not clear', async () => {
    await base({ 'package-lock.json': NPM_LOCK });
    await write('.dep-guard.json', config([`yarn.lock:${await blobOf(YARN)}`]));
    await migrateToYarn();

    await expect(
      scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS })
    ).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('on a staged scan an entry only in the index does not clear', async () => {
    await base({ 'package-lock.json': NPM_LOCK });
    await write('.dep-guard.json', config([`yarn.lock:${await blobOf(YARN)}`]));
    await rm(path.join(repo, 'package-lock.json'));
    await write('yarn.lock', YARN);

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('on a staged scan an entry committed at HEAD clears', async () => {
    await base({ 'package-lock.json': NPM_LOCK, '.dep-guard.json': config([`yarn.lock:${await blobOf(YARN)}`]) });
    await rm(path.join(repo, 'package-lock.json'));
    await write('yarn.lock', YARN);

    const result = await scanStaged();
    expect(result.run.diagnostics.map((d) => d.code)).toContain('lockfile-downgrade-acknowledged');
  });

  test('an acknowledgement does not suppress a finding in a lockfile this tool reads', async () => {
    const blob = await blobOf(YARN);
    await base({ 'package-lock.json': NPM_LOCK, '.dep-guard.json': config([`yarn.lock:${blob}`]) });
    await write('yarn.lock', YARN);
    await write('package-lock.json', npmLock({ 'node_modules/lodash': TAMPERED_LODASH }, L));
    await commitAll('add yarn.lock and tamper');

    const result = await pullRequest();
    expect(tamperSignals(result, 'lodash').some((s) => s.startsWith('host-changed'))).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  // The varying first document is one not shaped like a pnpm lockfile, so
  // it stays unread and its change is the refusal under test.
  const twoDocs = (tarball: string, lodash = 'integrity: sha512-cleanlodash'): string =>
    `---\nnotALockfile: ${tarball}\n---\n${pnpmLock(lodash)}`;
  const PNPM_TARBALL = 'https://registry.npmjs.org/pnpm/-/pnpm-10.0.0.tgz';
  const OTHER_TARBALL = 'https://registry.npmjs.org/pnpm/-/pnpm-9.0.0.tgz';

  async function refusalOf(promise: Promise<unknown>): Promise<string> {
    return promise.then(
      () => '',
      (err: unknown) => (err as Error).message
    );
  }

  test('a changed pnpm document this tool does not read prints exactly one entry, for the plain lockfile path and its head blob', async () => {
    await base({ 'pnpm-lock.yaml': twoDocs(PNPM_TARBALL) });
    await write('pnpm-lock.yaml', twoDocs(OTHER_TARBALL));
    await commitAll('change the unread document');
    const blob = await blobOf(twoDocs(OTHER_TARBALL));

    const message = await refusalOf(pullRequest());
    expect(message.match(/"pnpm-lock\.yaml:[0-9a-f]+"/g)).toEqual([`"pnpm-lock.yaml:${blob}"`]);
    expect(message.split('pnpm-lock.yaml (a YAML document').length).toBe(2);
  });

  test('that entry on the trust base clears it', async () => {
    const blob = await blobOf(twoDocs(OTHER_TARBALL));
    await base({ 'pnpm-lock.yaml': twoDocs(PNPM_TARBALL), '.dep-guard.json': config([`pnpm-lock.yaml:${blob}`]) });
    await write('pnpm-lock.yaml', twoDocs(OTHER_TARBALL));
    await commitAll('change the unread document');

    const result = await pullRequest();
    expect(result.run.diagnostics.map((d) => d.code)).toContain('lockfile-downgrade-acknowledged');
  });

  test('an entry for pnpm-lock.yaml with a different blob does not clear it', async () => {
    const wrong = await blobOf(twoDocs(PNPM_TARBALL));
    await base({ 'pnpm-lock.yaml': twoDocs(PNPM_TARBALL), '.dep-guard.json': config([`pnpm-lock.yaml:${wrong}`]) });
    await write('pnpm-lock.yaml', twoDocs(OTHER_TARBALL));
    await commitAll('change the unread document');

    await expect(pullRequest()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('an acknowledged lockfile this tool reads still has its entries checked', async () => {
    const tampered = 'integrity: sha512-evilevilevil, tarball: https://evil.example.com/lodash.tgz';
    const blob = await blobOf(twoDocs(OTHER_TARBALL, tampered));
    await base({ 'pnpm-lock.yaml': twoDocs(PNPM_TARBALL), '.dep-guard.json': config([`pnpm-lock.yaml:${blob}`]) });
    await write('pnpm-lock.yaml', twoDocs(OTHER_TARBALL, tampered));
    await write('package.json', manifestJson({ ...L, 'zz-made-up-hallucinated-pkg': '^1.0.0' }));
    await commitAll('change the unread document and tamper the read one');

    const result = await pullRequest();
    expect(result.run.diagnostics.map((d) => d.code)).toContain('lockfile-downgrade-acknowledged');
    expect(tamperSignals(result, 'lodash').some((s) => s.startsWith('host-changed'))).toBe(true);
    expect(result.findings.map((f) => `${f.ruleId}:${f.packageName}`)).toContain(
      'unknown-package:zz-made-up-hallucinated-pkg'
    );
    expect(result.exitCode).toBe(1);
  });

  async function baseWithSymlinkedYarn(acknowledgements: string[] = []): Promise<void> {
    await mkdir(path.join(repo, 'misc'), { recursive: true });
    await write('misc/y.txt', YARN);
    await symlink('misc/y.txt', path.join(repo, 'yarn.lock'));
    await base({ 'package-lock.json': NPM_LOCK, '.dep-guard.json': config(acknowledgements) });
  }

  test('a symlinked root lockfile whose target changes is refused on the working tree', async () => {
    await baseWithSymlinkedYarn();
    await write('misc/y.txt', OTHER_YARN);
    await commitAll('change the link target');

    await expect(pullRequest()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('a symlinked root lockfile is refused on a staged scan, from its git mode', async () => {
    await baseWithSymlinkedYarn();
    await write('misc/y.txt', OTHER_YARN);

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });

  test('an acknowledgement can never match a symlinked lockfile', async () => {
    const linkText = await blobOf('misc/y.txt');
    const target = await blobOf(OTHER_YARN);
    await baseWithSymlinkedYarn([`yarn.lock:${linkText}`, `yarn.lock:${target}`]);
    await write('misc/y.txt', OTHER_YARN);
    await commitAll('change the link target');

    const message = await refusalOf(pullRequest());
    expect(message).toContain('has no identity to acknowledge');
    expect(message).not.toMatch(/"yarn\.lock:[0-9a-f]+"/);
  });

  test('on a staged scan the refusal says to commit the entry first, because it is read from HEAD', async () => {
    await base({ 'package-lock.json': NPM_LOCK });
    await rm(path.join(repo, 'package-lock.json'));
    await write('yarn.lock', YARN);

    const message = await refusalOf(scanStaged());
    expect(message).toContain(`commit these entries to "acknowledgedLockfiles" in .dep-guard.json first`);
    expect(message).toContain('A staged scan reads them from HEAD');
    expect(message).not.toContain('on the base branch first');
  });

  test('on a --base run without a trust base the refusal names the --base ref', async () => {
    await base({ 'package-lock.json': NPM_LOCK });
    await migrateToYarn();

    const message = await refusalOf(
      scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS })
    );
    expect(message).toContain('on the --base ref first');
  });

  test('the refusal prints the exact entry to add and says it goes on the base branch first', async () => {
    await base({ 'package-lock.json': NPM_LOCK });
    await migrateToYarn();
    const blob = await blobOf(YARN);

    const error = await pullRequest().then(
      () => null,
      (err: unknown) => err as Error
    );
    expect(error?.message).toContain(`"yarn.lock:${blob}"`);
    expect(error?.message).toContain('on the base branch first');
    expect(error?.message).toContain('admin override');
  });
});

describe('N14: a file that starts with a UTF-8 byte order mark is read', () => {
  test('a root manifest and a workspace manifest with a byte order mark are both read', async () => {
    const BOM = '﻿';
    await write('package.json', `${BOM}${JSON.stringify({ name: 'root', version: '1.0.0', workspaces: ['packages/*'] })}`);
    await write('packages/bom/package.json', `${BOM}${JSON.stringify({ name: 'bom', version: '1.0.0' })}`);
    await commitAll('first');
    await write(
      'packages/bom/package.json',
      `${BOM}${JSON.stringify({ name: 'bom', version: '1.0.0', dependencies: { 'zz-made-up-hallucinated-pkg': '^1.0.0' } })}`
    );

    const result = await scanStaged();
    expect(result.findings.map((f) => `${f.ruleId}:${f.packageName}`)).toContain(
      'unknown-package:zz-made-up-hallucinated-pkg'
    );
  });
});

describe('N10: a scope pinned to a private registry is read from the trust base for the corpus check', () => {
  const PIN = '@corp:registry=https://npm.corp.example/\n';

  async function pullRequest(base: Record<string, string>, head: Record<string, string | null>): Promise<ScanResult> {
    await write('package.json', manifestJson({}));
    for (const [relPath, content] of Object.entries(base)) {
      await write(relPath, content);
    }
    await commitAll('first');
    await git('tag', 'base');
    for (const [relPath, content] of Object.entries(head)) {
      if (content === null) {
        await rm(path.join(repo, relPath));
      } else {
        await write(relPath, content);
      }
    }
    await write('package.json', manifestJson({ '@corp/internal-lib': '^1.0.0' }));
    await commitAll('head');
    return scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS, trustBase: 'base' });
  }

  function unknownNames(result: ScanResult): string[] {
    return result.findings.filter((f) => f.ruleId === 'unknown-package').map((f) => f.packageName);
  }

  test('a pin added only on the head does not clear a new private-scope name', async () => {
    const result = await pullRequest({}, { '.npmrc': PIN });
    expect(unknownNames(result)).toEqual(['@corp/internal-lib']);
  });

  test('a pin on the trust base clears it even when the head deletes .npmrc', async () => {
    const result = await pullRequest({ '.npmrc': PIN }, { '.npmrc': null });
    expect(unknownNames(result)).toEqual([]);
    expect(result.run.diagnostics.map((d) => d.code)).toContain('unknown-package-private-scope-skipped');
  });
});

describe('N8: a lockfile below the repository root that changes is named in a diagnostic', () => {
  // A lockfile below the root is not read by this tool, so a change to its
  // bytes is a change this run cannot judge. The run says so by path
  // (lockfile-nested-changed) and continues; the exit code is decided by
  // the findings alone. An ignorePaths entry on the comparison side turns
  // the note into lockfile-nested-ignored.
  const NESTED = 'apps/web/package-lock.json';

  async function baseWithNestedLock(extra: Record<string, string> = {}): Promise<void> {
    await write('package.json', manifestJson({}));
    await write('apps/web/package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(NESTED, npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    for (const [relPath, content] of Object.entries(extra)) {
      await write(relPath, content);
    }
    await commitAll('first');
    await git('tag', 'base');
  }

  async function scanBase(ref: string, trustBase?: string): Promise<ScanResult> {
    return scan({
      repoRoot: repo,
      mode: { kind: 'base', ref },
      corpusDir: FIXTURE_CORPUS,
      ...(trustBase === undefined ? {} : { trustBase }),
    });
  }

  function nestedChanged(result: ScanResult): string | undefined {
    return result.run.diagnostics.find((d) => d.code === 'lockfile-nested-changed')?.message;
  }

  test('a tampered nested package-lock.json is named on a staged scan, and the run continues', async () => {
    await baseWithNestedLock();
    await write(NESTED, npmLock({ 'node_modules/lodash': TAMPERED_LODASH }, { lodash: '^4.17.21' }));

    const result = await scanStaged();
    expect(nestedChanged(result)).toContain(NESTED);
    expect(result.exitCode).toBe(0);
  });

  test('a tampered nested package-lock.json is named on a pull-request shaped scan, with what it means and the ignorePaths way out', async () => {
    await baseWithNestedLock();
    await write(NESTED, npmLock({ 'node_modules/lodash': TAMPERED_LODASH }, { lodash: '^4.17.21' }));
    await commitAll('head');

    const result = await scanBase('base');
    const message = nestedChanged(result) ?? '';
    expect(message).toContain(NESTED);
    expect(message).toContain('This tool did not read it');
    expect(message).toContain('this run says nothing about what a package manager would install from it');
    expect(message).toContain('ignorePaths');
    expect(message).not.toContain('exit 2');
    expect(result.exitCode).toBe(0);
  });

  test('a nested yarn.lock that is new on the head is named', async () => {
    await baseWithNestedLock();
    await write('examples/demo/yarn.lock', '# yarn lockfile v1\n');
    await commitAll('head');

    expect(nestedChanged(await scanBase('base'))).toContain('examples/demo/yarn.lock');
  });

  test('the nested note does not change the exit code a root finding decides', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    await write(NESTED, npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    await commitAll('first');
    await write('package-lock.json', npmLock({ 'node_modules/lodash': TAMPERED_LODASH }, { lodash: '^4.17.21' }));
    await write(NESTED, npmLock({ 'node_modules/lodash': TAMPERED_LODASH }, { lodash: '^4.17.21' }));

    const result = await scanStaged();
    expect(nestedChanged(result)).toContain(NESTED);
    expect(tamperSignals(result, 'lodash').some((s) => s.startsWith('host-changed'))).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  test('control: an unchanged nested lockfile resolves, with a note that names it and no lockfile-missing note', async () => {
    await baseWithNestedLock();
    await write('apps/web/package.json', manifestJson({ lodash: '^4.17.21', chalk: '^5.0.0' }));
    await commitAll('head');

    const result = await scanBase('base', 'base');
    const codes = result.run.diagnostics.map((d) => d.code);
    expect(codes).not.toContain('lockfile-missing');
    const note = result.run.diagnostics.find((d) => d.code === 'lockfile-not-read');
    expect(note?.message).toContain(NESTED);
  });

  test('control: a nested lockfile deleted on the head resolves', async () => {
    await baseWithNestedLock();
    await rm(path.join(repo, NESTED));
    await commitAll('head');

    await expect(scanBase('base', 'base')).resolves.toBeDefined();
  });

  test('ignorePaths on the base clears a changed nested lockfile, with a note', async () => {
    await baseWithNestedLock({ '.dep-guard.json': JSON.stringify({ ignorePaths: ['apps/web'] }) });
    await write(NESTED, npmLock({ 'node_modules/lodash': TAMPERED_LODASH }, { lodash: '^4.17.21' }));
    await commitAll('head');

    const result = await scanBase('base', 'base');
    const note = result.run.diagnostics.find((d) => d.code === 'lockfile-nested-ignored');
    expect(note?.message).toContain(NESTED);
    expect(nestedChanged(result)).toBeUndefined();
  });

  test('an ignorePaths entry that covers only a nested lockfile is not reported as unmatched', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    await write(NESTED, npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['apps/web'] }));
    await commitAll('first');
    await write('package-lock.json', npmLock({ 'node_modules/lodash': TAMPERED_LODASH }, { lodash: '^4.17.21' }));
    await write(NESTED, npmLock({ 'node_modules/lodash': TAMPERED_LODASH }, { lodash: '^4.17.21' }));

    const result = await scanStaged();
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.run.diagnostics.map((d) => d.code)).not.toContain('ignore-path-unmatched');
  });

  test('under --trust-base, ignorePaths added only on the head does not clear it', async () => {
    await baseWithNestedLock();
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['apps/web'] }));
    await write(NESTED, npmLock({ 'node_modules/lodash': TAMPERED_LODASH }, { lodash: '^4.17.21' }));
    await commitAll('head');

    const result = await scanBase('base', 'base');
    expect(nestedChanged(result)).toContain(NESTED);
  });
});

describe('N5: the lockfile-downgrade message says what happened, why, and what to do', () => {
  test('a format switch names the files, the reason, and the two ways to land a genuine migration', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    await commitAll('first');
    await rm(path.join(repo, 'package-lock.json'));
    await write('yarn.lock', '# yarn lockfile v1\n');

    const error = await scanStaged().then(
      () => null,
      (err: unknown) => err as Error
    );
    expect(error).not.toBeNull();
    const message = error?.message ?? '';
    expect(message).toContain('package-lock.json');
    expect(message).toContain('yarn.lock');
    expect(message).toContain('a format switch is how a tampered lockfile escapes inspection');
    expect(message).toContain('review the new lockfile by hand');
    expect(message).toContain('an admin override of the failing check');
    expect(message).toContain('separate, reviewed pull request that relaxes the gate on the base branch');
    expect(message).toContain('enforce: false');
    expect(message).toContain('continue-on-error');
    expect(message).toContain('restore the setting in a third pull request');
    expect(message).toContain('cannot relax the gate for itself');
    expect(message).toContain('exit 2');
  });
});

describe('N15: a symlinked root lockfile or manifest is not parsed on any side', () => {
  const L = { lodash: '^4.17.21' };
  const CLEAN = pnpmLock('integrity: sha512-cleanlodash');
  const EVIL = pnpmLock('integrity: sha512-evilevilevil, tarball: https://evil.example.com/lodash.tgz');
  // A link text that is itself a valid pnpm lockfile, in YAML flow form
  // with no slash, so it can also be the name of the file it points at.
  const DECOY =
    "{lockfileVersion: '9.0', importers: {.: {dependencies: {lodash: {specifier: ^4.17.21, version: 4.17.21}}}}, " +
    'packages: {lodash@4.17.21: {resolution: {integrity: sha512-cleanlodash}}}}';

  async function linkTo(target: string, linkPath: string, content: string): Promise<void> {
    await write(target, content);
    await rm(path.join(repo, linkPath), { force: true });
    await mkdir(path.dirname(path.join(repo, linkPath)), { recursive: true });
    await symlink(target, path.join(repo, linkPath));
  }

  async function refusal(promise: Promise<unknown>): Promise<{ code?: string; message: string } | null> {
    return promise.then(
      () => null,
      (err: unknown) => err as { code?: string; message: string }
    );
  }

  function expectLinkRefusal(err: { code?: string; message: string } | null, relPath: string): void {
    expect(err?.code).toBe('symlinked-input');
    expect(err?.message).toContain(`${relPath}: is a symlink on the side being judged`);
    expect(err?.message).toContain('replace the link with a regular file');
  }

  test('a symlinked pnpm-lock.yaml whose link text is a valid lockfile is refused on a staged scan', async () => {
    await write('package.json', manifestJson(L));
    await write('pnpm-lock.yaml', CLEAN);
    await commitAll('base');
    await linkTo(DECOY, 'pnpm-lock.yaml', EVIL);

    expectLinkRefusal(await refusal(scanStaged()), 'pnpm-lock.yaml');
  });

  function pullRequest(): Promise<ScanResult> {
    return scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS, trustBase: 'base' });
  }

  function comparisonNotes(result: ScanResult): string[] {
    return result.run.diagnostics
      .filter((d) => d.code === 'symlinked-input-comparison-side')
      .map((d) => d.message);
  }

  // The base keeps a link whose text is a clean lockfile; the pull request
  // replaces it with a regular file.
  async function baseWithLinkedLockfile(): Promise<void> {
    await write('package.json', manifestJson(L));
    await linkTo(DECOY, 'pnpm-lock.yaml', EVIL);
    await commitAll('base');
    await git('tag', 'base');
    await rm(path.join(repo, 'pnpm-lock.yaml'));
    await rm(path.join(repo, DECOY));
  }

  test('a pull request that replaces a symlinked pnpm-lock.yaml on the base with a clean regular file passes', async () => {
    await baseWithLinkedLockfile();
    await write('pnpm-lock.yaml', CLEAN);
    await commitAll('replace the link');

    const result = await pullRequest();
    expect(result.exitCode).toBe(0);
    expect(result.findings).toEqual([]);
    expect(comparisonNotes(result)).toEqual([
      'pnpm-lock.yaml: is a symlink on the --base ref "base", so it was not read there; the scanned ' +
        "side's file is judged as if that side had no such file",
    ]);
  });

  test('a symlinked pnpm-lock.yaml on the base never makes a tampered head lockfile look unchanged', async () => {
    await baseWithLinkedLockfile();
    await write('pnpm-lock.yaml', EVIL);
    await commitAll('replace the link with a tampered file');

    const result = await pullRequest();
    expect(result.exitCode).toBe(1);
    expect(result.findings.some((f) => f.packageName === 'lodash')).toBe(true);
  });

  test('a symlinked pnpm-lock.yaml on the trust base alone is noted, not refused', async () => {
    await baseWithLinkedLockfile();
    await git('tag', 'trusted', 'base');
    await git('tag', '-d', 'base');
    await write('pnpm-lock.yaml', CLEAN);
    await commitAll('regular file');
    await git('tag', 'base');
    await write('README.md', 'head\n');
    await commitAll('head');

    const result = await scan({
      repoRoot: repo,
      mode: { kind: 'base', ref: 'base' },
      corpusDir: FIXTURE_CORPUS,
      trustBase: 'trusted',
    });
    expect(result.exitCode).toBe(0);
    expect(comparisonNotes(result).join('\n')).toContain('pnpm-lock.yaml: is a symlink on the trust base "trusted"');
  });

  test('a symlinked pnpm-lock.yaml at HEAD replaced by a regular file in the index passes a staged scan', async () => {
    await baseWithLinkedLockfile();
    await write('pnpm-lock.yaml', CLEAN);

    const result = await scanStaged();
    expect(result.exitCode).toBe(0);
    expect(comparisonNotes(result).join('\n')).toContain('pnpm-lock.yaml: is a symlink on HEAD');
  });

  test('a symlinked pnpm-lock.yaml on the head side of a pull request is refused', async () => {
    await write('package.json', manifestJson(L));
    await write('pnpm-lock.yaml', CLEAN);
    await commitAll('base');
    await git('tag', 'base');
    await linkTo(DECOY, 'pnpm-lock.yaml', CLEAN);
    await commitAll('link');

    expectLinkRefusal(await refusal(pullRequest()), 'pnpm-lock.yaml');
  });

  async function baseWithLinkedManifest(): Promise<void> {
    await linkTo('misc/root.json', 'package.json', manifestJson(L));
    await write('pnpm-lock.yaml', CLEAN);
    await commitAll('base');
    await git('tag', 'base');
    await rm(path.join(repo, 'package.json'));
  }

  test('a pull request that replaces a symlinked root package.json on the base with a regular file passes', async () => {
    await baseWithLinkedManifest();
    await write('package.json', manifestJson(L));
    await commitAll('replace the link');

    const result = await pullRequest();
    expect(result.exitCode).toBe(0);
    expect(comparisonNotes(result).join('\n')).toContain('package.json: is a symlink on the --base ref "base"');
  });

  test('a symlinked root package.json on the base never hides a dependency the head adds', async () => {
    await baseWithLinkedManifest();
    await write('package.json', manifestJson({ ...L, 'zz-made-up-hallucinated-pkg': '^1.0.0' }));
    await commitAll('replace the link and add a dependency');

    const result = await pullRequest();
    expect(result.exitCode).toBe(1);
    expect(result.findings.map((f) => `${f.ruleId}:${f.packageName}`)).toContain(
      'unknown-package:zz-made-up-hallucinated-pkg'
    );
  });

  test('a symlinked root package.json on the head side of a pull request is refused', async () => {
    await write('package.json', manifestJson(L));
    await commitAll('base');
    await git('tag', 'base');
    await linkTo('misc/root.json', 'package.json', manifestJson(L));
    await commitAll('link');

    expectLinkRefusal(await refusal(pullRequest()), 'package.json');
  });

  test('a symlinked pnpm-lock.yaml in the working tree is refused without following it', async () => {
    await write('package.json', manifestJson(L));
    await linkTo('locks/pnpm-lock.yaml', 'pnpm-lock.yaml', CLEAN);
    await git('add', '-A');

    expectLinkRefusal(
      await refusal(scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS })),
      'pnpm-lock.yaml'
    );
  });

  test('a symlinked package-lock.json is refused on a staged scan', async () => {
    const lock = npmLock({ 'node_modules/lodash': CLEAN_LODASH }, L);
    await write('package.json', manifestJson(L));
    await write('package-lock.json', lock);
    await commitAll('base');
    await linkTo('locks/pl.json', 'package-lock.json', lock);

    expectLinkRefusal(await refusal(scanStaged()), 'package-lock.json');
  });

  test('a symlinked root package.json is refused on a staged scan', async () => {
    await write('package.json', manifestJson(L));
    await commitAll('base');
    await linkTo('misc/root.json', 'package.json', manifestJson({ ...L, 'zz-made-up-hallucinated-pkg': '^1.0.0' }));

    expectLinkRefusal(await refusal(scanStaged()), 'package.json');
  });

  test('a symlinked workspace member package.json is refused on a staged scan', async () => {
    await write('package.json', JSON.stringify({ name: 'root', version: '1.0.0', workspaces: ['packages/*'] }));
    await write('packages/app/package.json', JSON.stringify({ name: 'app', version: '1.0.0' }));
    await commitAll('base');
    await linkTo(
      'misc/app.json',
      'packages/app/package.json',
      JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'zz-made-up-hallucinated-pkg': '^1.0.0' } })
    );

    expectLinkRefusal(await refusal(scanStaged()), 'packages/app/package.json');
  });
});

describe('N16: on a git side, workspace patterns follow core.ignorecase', () => {
  const ADDED = JSON.stringify({
    name: 'a',
    version: '1.0.0',
    dependencies: { 'zz-made-up-hallucinated-pkg': '^1.0.0' },
  });

  async function memberFindings(pattern: string, ignoreCase: boolean): Promise<string[]> {
    await git('config', 'core.ignorecase', ignoreCase ? 'true' : 'false');
    await write('package.json', JSON.stringify({ name: 'root', version: '1.0.0', workspaces: [pattern] }));
    await write('Lib/A/package.json', JSON.stringify({ name: 'a', version: '1.0.0' }));
    await commitAll('first');
    await write('Lib/A/package.json', ADDED);
    const result = await scanStaged();
    return result.findings
      .filter((f) => f.packageName === 'zz-made-up-hallucinated-pkg')
      .map((f) => f.manifestPath);
  }

  for (const pattern of ['lib/a', 'lib/*']) {
    test(`with core.ignorecase true, "${pattern}" reaches Lib/A on a staged scan`, async () => {
      expect(await memberFindings(pattern, true)).toEqual(['Lib/A/package.json']);
    });

    test(`with core.ignorecase false, "${pattern}" does not reach Lib/A on a staged scan`, async () => {
      expect(await memberFindings(pattern, false)).toEqual([]);
    });
  }
});

describe('N17: what a comparison side cannot read is refused only on the side being judged', () => {
  const L = { lodash: '^4.17.21' };
  const BAD_PATTERN = 'packages/{a,b}';
  const BAD_NPM = JSON.stringify({ name: 'root', lockfileVersion: '3', requires: true });
  const GOOD_NPM = npmLock({ 'node_modules/lodash': CLEAN_LODASH }, L);
  const HALLUCINATED = { 'zz-made-up-hallucinated-pkg': '^1.0.0' };

  function pullRequest(trustBase = 'base'): Promise<ScanResult> {
    return scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS, trustBase });
  }

  function notes(result: ScanResult, code: string): string[] {
    return result.run.diagnostics.filter((d) => d.code === code).map((d) => d.message);
  }

  async function refusalCode(promise: Promise<unknown>): Promise<string | undefined> {
    return promise.then(
      () => undefined,
      (err: unknown) => (err as { code?: string }).code
    );
  }

  function workspaceRoot(pattern: string): string {
    return JSON.stringify({ name: 'root', version: '1.0.0', private: true, workspaces: [pattern] });
  }

  async function baseWithPattern(pattern: string): Promise<void> {
    await write('package.json', workspaceRoot(pattern));
    await write('packages/a/package.json', JSON.stringify({ name: 'a', version: '1.0.0' }));
    await write('packages/b/package.json', JSON.stringify({ name: 'b', version: '1.0.0' }));
    await commitAll('base');
    await git('tag', 'base');
  }

  async function baseWithLockfile(lock: string): Promise<void> {
    await write('package.json', manifestJson(L));
    await write('package-lock.json', lock);
    await commitAll('base');
    await git('tag', 'base');
  }

  test('a pull request that rewrites an unexpandable base workspace pattern passes, with a note', async () => {
    await baseWithPattern(BAD_PATTERN);
    await write('package.json', workspaceRoot('packages/*'));
    await commitAll('rewrite the pattern');

    const result = await pullRequest();
    expect(result.exitCode).toBe(0);
    expect(notes(result, 'workspace-pattern-unread-comparison-side')).toEqual([
      `workspace pattern "${BAD_PATTERN}": could not be expanded on the --base ref "base", so it named no ` +
        "workspace packages there; the scanned side's packages are judged against what remains",
    ]);
  });

  test('a staged commit that rewrites an unexpandable workspace pattern at HEAD passes', async () => {
    await baseWithPattern(BAD_PATTERN);
    await write('package.json', workspaceRoot('packages/*'));

    const result = await scanStaged();
    expect(result.exitCode).toBe(0);
    expect(notes(result, 'workspace-pattern-unread-comparison-side').join('\n')).toContain('on HEAD');
  });

  test('an unexpandable workspace pattern on a trust base that is a different tree is noted, not refused', async () => {
    await baseWithPattern(BAD_PATTERN);
    await git('tag', 'trusted', 'base');
    await git('tag', '-d', 'base');
    await write('package.json', workspaceRoot('packages/*'));
    await commitAll('rewrite the pattern');
    await git('tag', 'base');
    await write('README.md', 'head\n');
    await commitAll('head');

    const result = await pullRequest('trusted');
    expect(result.exitCode).toBe(0);
    expect(notes(result, 'workspace-pattern-unread-comparison-side').join('\n')).toContain(
      'on the trust base "trusted"'
    );
  });

  test('an unexpandable workspace pattern on the head side is still refused', async () => {
    await baseWithPattern('packages/*');
    await write('package.json', workspaceRoot(BAD_PATTERN));
    await commitAll('break the pattern');

    expect(await refusalCode(pullRequest())).toBe('workspace-glob-unexpandable');
  });

  test('an unexpandable base workspace pattern never hides a dependency the head adds to a member', async () => {
    await baseWithPattern(BAD_PATTERN);
    await write('package.json', workspaceRoot('packages/*'));
    await write('packages/a/package.json', JSON.stringify({ name: 'a', version: '1.0.0', dependencies: HALLUCINATED }));
    await commitAll('rewrite the pattern and add a dependency');

    const result = await pullRequest();
    expect(result.exitCode).toBe(1);
    expect(result.findings.map((f) => `${f.ruleId}:${f.packageName}`)).toContain(
      'unknown-package:zz-made-up-hallucinated-pkg'
    );
  });

  test('a pull request that regenerates a base npm lockfile with no packages map passes, with a note', async () => {
    await baseWithLockfile(BAD_NPM);
    await write('package-lock.json', GOOD_NPM);
    await commitAll('regenerate');

    const result = await pullRequest();
    expect(result.exitCode).toBe(0);
    const [note, ...rest] = notes(result, 'lockfile-unread-comparison-side');
    expect(rest).toEqual([]);
    expect(note).toContain('package-lock.json: could not be read on the --base ref "base"');
    expect(note).toContain("the scanned side's lockfile entries count as new");
    expect(notes(result, 'npm-lockfile-v1')).toEqual([]);
  });

  test('a staged commit that regenerates an npm lockfile with no packages map at HEAD passes', async () => {
    await baseWithLockfile(BAD_NPM);
    await write('package-lock.json', GOOD_NPM);

    const result = await scanStaged();
    expect(result.exitCode).toBe(0);
    expect(notes(result, 'lockfile-unread-comparison-side').join('\n')).toContain('could not be read on HEAD');
  });

  test('an npm lockfile with no packages map on a trust base that is a different tree is noted, not refused', async () => {
    await baseWithLockfile(BAD_NPM);
    await git('tag', 'trusted', 'base');
    await git('tag', '-d', 'base');
    await write('package-lock.json', GOOD_NPM);
    await commitAll('regenerate');
    await git('tag', 'base');
    await write('README.md', 'head\n');
    await commitAll('head');

    const result = await pullRequest('trusted');
    expect(result.exitCode).toBe(0);
    expect(notes(result, 'lockfile-unread-comparison-side').join('\n')).toContain(
      'could not be read on the trust base "trusted"'
    );
  });

  test('an npm lockfile with no packages map on the head side is still refused', async () => {
    await baseWithLockfile(GOOD_NPM);
    await write('package-lock.json', BAD_NPM);
    await commitAll('break the lockfile');

    expect(await refusalCode(pullRequest())).toBe('lockfile-parse');
  });

  test('an unreadable base npm lockfile never makes a tampered head lockfile look clean', async () => {
    await baseWithLockfile(BAD_NPM);
    await write('package-lock.json', npmLock({ 'node_modules/lodash': TAMPERED_LODASH }, L));
    await commitAll('regenerate with a tampered entry');

    const result = await pullRequest();
    expect(result.exitCode).toBe(1);
    expect(tamperSignals(result, 'lodash').length).toBeGreaterThan(0);
  });

  test('an unreadable base npm lockfile is not coverage the head may drop, and no acknowledgement of it clears a refusal', async () => {
    const pnpm = pnpmLock('integrity: sha512-cleanlodash');
    await write('.blob-probe', BAD_NPM);
    const badBlob = (await git('hash-object', '.blob-probe')).trim();
    await rm(path.join(repo, '.blob-probe'));
    await write('package.json', manifestJson(L));
    await write('package-lock.json', BAD_NPM);
    await write('pnpm-lock.yaml', pnpm);
    await write('.dep-guard.json', JSON.stringify({ acknowledgedLockfiles: [`package-lock.json:${badBlob}`] }));
    await commitAll('base');
    await git('tag', 'base');
    await rm(path.join(repo, 'package-lock.json'));
    await rm(path.join(repo, 'pnpm-lock.yaml'));
    await commitAll('stop committing lockfiles');

    expect(await refusalCode(pullRequest())).toBe('lockfile-downgrade');
  });
});
