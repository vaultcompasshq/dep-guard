import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  test('control: a lockfile deleted with nothing in its place is left to the lockfile-missing path', async () => {
    await baseWithNpmLock();
    await rm(path.join(repo, 'package-lock.json'));
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
