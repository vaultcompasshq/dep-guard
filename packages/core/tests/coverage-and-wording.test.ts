import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fingerprintFinding } from '../src/fingerprint.js';
import { scan } from '../src/scan.js';
import { DepGuardError } from '../src/types.js';

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

function manifestJson(dependencies: Record<string, string>): string {
  return JSON.stringify({ name: 'root', version: '1.0.0', dependencies });
}

function npmLockJson(
  packages: Record<string, Record<string, unknown>>,
  rootDependencies: Record<string, string> = {}
): string {
  return JSON.stringify({
    name: 'root',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'root', version: '1.0.0', dependencies: rootDependencies }, ...packages },
  });
}

function scripted(name: string, version = '1.0.0'): Record<string, unknown> {
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: `sha512-${name}`,
    hasInstallScript: true,
  };
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-coverage-'));
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
});

describe('install-script on a wholly new lockfile', () => {
  const names = ['esbuild', 'fsevents', 'sharp'];
  const packages = Object.fromEntries(names.map((name) => [`node_modules/${name}`, scripted(name)]));
  const rootDeps = Object.fromEntries(names.map((name) => [name, '^1.0.0']));

  test('a change that adds the lockfile is one high install-script finding and still exits 1', async () => {
    await write('package.json', manifestJson(rootDeps));
    await commitAll('manifest only');
    await write('package-lock.json', npmLockJson(packages, rootDeps));
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    const installScript = result.findings.filter((finding) => finding.ruleId === 'install-script');
    expect(installScript).toHaveLength(1);
    expect(installScript[0]?.severity).toBe('high');
    expect(installScript[0]?.details?.packages).toEqual(names);
    expect(result.exitCode).toBe(1);
  });

  async function stageNewLockfile(pkgNames: string[]): Promise<void> {
    const deps = Object.fromEntries(pkgNames.map((name) => [name, '^1.0.0']));
    await write('package.json', manifestJson(deps));
    await write(
      'package-lock.json',
      npmLockJson(Object.fromEntries(pkgNames.map((name) => [`node_modules/${name}`, scripted(name)])), deps)
    );
    await git('add', '-A');
  }

  function blocking(result: Awaited<ReturnType<typeof scan>>) {
    return result.findings.filter((finding) => finding.ruleId === 'install-script' && finding.severity === 'high');
  }

  test('probe A: a base baseline holding one collapsed fingerprint does not suppress a different package set', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('base');
    await stageNewLockfile(names);
    const first = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });
    const collapsedFingerprint = blocking(first)[0]?.fingerprint ?? '';
    expect(collapsedFingerprint).not.toBe('');

    await write('.dep-guard.baseline.json', JSON.stringify({ version: 1, fingerprints: [collapsedFingerprint] }));
    // The same package set is covered by exactly what was reviewed...
    const same = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });
    expect(blocking(same)).toHaveLength(0);
    expect(same.suppressed).toBe(1);

    // ...and a different set of install-script packages is not.
    await stageNewLockfile(['esbuild', 'fsevents', 'unrelated-native']);
    const different = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });
    expect(blocking(different)).toHaveLength(1);
    expect(blocking(different)[0]?.details?.packages).toEqual(['esbuild', 'fsevents', 'unrelated-native']);
    expect(different.suppressed).toBe(0);
    expect(different.exitCode).toBe(1);
  });

  test('probe B: ignorePaths on the lockfile does not drop declared dependencies', async () => {
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['package-lock.json'] }));
    await write('package.json', manifestJson({}));
    await commitAll('base');
    await stageNewLockfile(names);

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(blocking(result)).toHaveLength(1);
    expect(blocking(result)[0]?.details?.packages).toEqual(names);
    expect(result.ignored).toBe(0);
    expect(result.exitCode).toBe(1);
  });

  test('an old per-package baseline entry still clears that package from the collapsed list', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('base');
    await stageNewLockfile(names);
    const entry = fingerprintFinding({
      ruleId: 'install-script',
      severity: 'high',
      packageName: 'esbuild',
      message: '',
      manifestPath: 'package.json',
      details: { signal: 'added' },
    });
    await write('.dep-guard.baseline.json', JSON.stringify({ version: 1, fingerprints: [entry] }));

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(result.suppressed).toBe(1);
    expect(blocking(result)[0]?.details?.packages).toEqual(['fsevents', 'sharp']);
    expect(result.exitCode).toBe(1);
  });

  test('a lockfile that already existed keeps one finding per newly scripted package', async () => {
    await write('package.json', manifestJson({ left: '^1.0.0' }));
    await write('package-lock.json', npmLockJson({ 'node_modules/left': { version: '1.0.0', integrity: 'sha512-left' } }, { left: '^1.0.0' }));
    await commitAll('base');
    await write('package.json', manifestJson({ ...rootDeps, left: '^1.0.0' }));
    await write(
      'package-lock.json',
      npmLockJson(
        { 'node_modules/left': { version: '1.0.0', integrity: 'sha512-left' }, ...packages },
        { ...rootDeps, left: '^1.0.0' }
      )
    );
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    const installScript = result.findings.filter((finding) => finding.ruleId === 'install-script');
    expect(installScript.map((finding) => finding.packageName).sort()).toEqual(names);
  });
});

async function auditCodes(): Promise<{ codes: string[]; result: Awaited<ReturnType<typeof scan>> }> {
  const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
  return { codes: result.run.diagnostics.map((entry) => entry.code), result };
}

describe('lockfile-missing is raised only for an ecosystem whose lockfile dep-guard reads', () => {
  test('a Go repository with go.mod and go.sum, and no package.json, does not get lockfile-missing', async () => {
    await write('go.mod', 'module example.invalid/app\n\ngo 1.22\n');
    await write('go.sum', 'example.invalid/dep v1.0.0 h1:abc=\n');
    await commitAll('go');

    const { codes, result } = await auditCodes();

    expect(codes).not.toContain('lockfile-missing');
    expect(result.run.ecosystems.go).toEqual({ files: 2 });
    expect(result.exitCode).toBe(0);
  });

  test('a Python manifest with every requirement pinned exactly does not get lockfile-missing', async () => {
    await write('requirements.txt', 'flask==3.0.0\nrequests==2.31.0\n');
    await commitAll('py');

    const { codes, result } = await auditCodes();

    expect(codes).not.toContain('lockfile-missing');
    expect(result.run.ecosystems.pypi.requirements).toBe(2);
    expect(result.run.ecosystems.pypi.pinned).toBe(2);
  });

  test('a Python manifest with a range counts one requirement as not pinned', async () => {
    await write('requirements.txt', 'flask==3.0.0\nrequests>=2.0\nclick\n');
    await commitAll('py');

    const { result } = await auditCodes();

    expect(result.run.ecosystems.pypi.requirements).toBe(3);
    expect(result.run.ecosystems.pypi.pinned).toBe(1);
  });

  test('a wildcard version is not an exact pin', async () => {
    await write('requirements.txt', 'flask==1.*\nrequests==2.0.0\n');
    await commitAll('py');

    const { result } = await auditCodes();

    expect(result.run.ecosystems.pypi.requirements).toBe(2);
    expect(result.run.ecosystems.pypi.pinned).toBe(1);
  });

  test('a two-letter name absent from the corpus is still reported by unknown-package', async () => {
    await write('package.json', manifestJson({ zq: '^1.0.0' }));
    await commitAll('short');

    const { result } = await auditCodes();

    expect(result.findings.filter((finding) => finding.ruleId === 'unknown-package').map((f) => f.packageName)).toEqual(['zq']);
  });

  test('a package.json with no lockfile still gets lockfile-missing, beside a go.mod', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('go.mod', 'module example.invalid/app\n');
    await commitAll('both');

    const { codes, result } = await auditCodes();

    expect(codes).toContain('lockfile-missing');
    expect(result.run.ecosystems.go).toEqual({ files: 1 });
    expect(result.run.ecosystems.npm.lockfile).toBe('missing');
  });

  test('a go.mod inside node_modules is not a Go project of this repository', async () => {
    await write('package.json', manifestJson({}));
    await write('node_modules/dep/go.mod', 'module example.invalid/dep\n');
    await commitAll('vendored');

    const { result } = await auditCodes();

    expect(result.run.ecosystems.go).toEqual({ files: 0 });
  });

  test('the npm lockfile fact says read when a lockfile is read', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson({ 'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-l' } }, { lodash: '^4.17.21' })
    );
    await commitAll('npm');

    const { result } = await auditCodes();

    expect(result.run.ecosystems.npm.lockfile).toBe('read');
  });

  test('the npm lockfile fact says not-read for a yarn lockfile', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('yarn.lock', '# yarn lockfile v1\n');
    await commitAll('yarn');

    const { result } = await auditCodes();

    expect(result.run.ecosystems.npm.lockfile).toBe('not-read');
  });
});

describe('the unresolved-manifests message', () => {
  test('names the installed version and says a newer dep-guard may read a format this one does not', async () => {
    await write('yarn.lock', '# yarn lockfile v1\n');
    const installed = (
      JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }
    ).version;

    let caught: unknown;
    try {
      await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DepGuardError);
    const message = (caught as DepGuardError).message;
    expect((caught as DepGuardError).code).toBe('manifests-unresolved');
    expect(message).toContain('the scan root may be wrong');
    expect(message).toContain(`dep-guard ${installed}`);
    expect(message).toContain('out of date');
    expect(message).toContain('newer dep-guard');
  });
});
