import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
  return JSON.stringify({ name: 'app', version: '1.0.0', dependencies });
}

function npmLock(packages: Record<string, Record<string, unknown>>): string {
  return JSON.stringify({
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'app', version: '1.0.0' },
      ...packages,
    },
  });
}

const CLEAN = {
  version: '1.0.0',
  resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz',
  integrity: 'sha512-clean',
};

const TAMPERED = {
  version: '1.0.0',
  resolved: 'https://evil.example/left-pad/-/left-pad-1.0.0.tgz',
  integrity: 'sha512-evil',
};

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-nested-'));
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

describe('manifests below the scan root', () => {
  test('a nested npm lockfile is resolved and a finding reports its path', async () => {
    await write('sub/package.json', manifestJson({}));
    await write('sub/package-lock.json', npmLock({ 'node_modules/left-pad': CLEAN }));
    await commitAll('base');
    await git('tag', 'base');
    await write('sub/package-lock.json', npmLock({ 'node_modules/left-pad': TAMPERED }));
    await commitAll('head');

    const result = await scan({
      repoRoot: repo,
      mode: { kind: 'base', ref: 'base' },
      corpusDir: FIXTURE_CORPUS,
    });

    const finding = result.findings.find((entry) => entry.packageName === 'left-pad');
    expect(finding?.manifestPath).toBe('sub/package-lock.json');
    expect(result.exitCode).toBe(1);
  });

  test('a nested requirements.txt is resolved and a finding reports its path', async () => {
    await write(
      'backend/requirements.txt',
      'requests @ git+https://github.com/example/requests.git\n'
    );

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    const finding = result.findings.find((entry) => entry.packageName === 'requests');
    expect(finding).toMatchObject({
      ruleId: 'lockfile-tamper',
      manifestPath: 'backend/requirements.txt',
    });
  });

  test('a plain requirements.txt dependency is not judged as an npm package', async () => {
    await write('backend/requirements.txt', 'requests==2.31.0\n');

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(result.findings.map((entry) => entry.ruleId)).not.toContain('unknown-package');
    expect(result.exitCode).toBe(0);
  });

  test('a root tool-only pyproject does not fail the scan when a nested lockfile resolved', async () => {
    await write('pyproject.toml', '[tool.ruff]\nline-length = 100\n');
    await write('frontend/package.json', manifestJson({}));
    await write('frontend/package-lock.json', npmLock({ 'node_modules/left-pad': CLEAN }));
    await commitAll('base');
    await git('tag', 'base');
    await write('frontend/package-lock.json', npmLock({ 'node_modules/left-pad': TAMPERED }));

    const result = await scan({
      repoRoot: repo,
      mode: { kind: 'base', ref: 'base' },
      corpusDir: FIXTURE_CORPUS,
    });

    expect(result.findings.find((entry) => entry.packageName === 'left-pad')?.manifestPath).toBe(
      'frontend/package-lock.json'
    );
    expect(result.exitCode).toBe(1);
  });

  test('scan <path> reads that directory and not its siblings', async () => {
    await write('frontend/package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
    await write('backend/package.json', manifestJson({ 'also-not-a-real-package-name': '1.0.0' }));

    const scoped = await scan({
      repoRoot: path.join(repo, 'frontend'),
      mode: { kind: 'audit' },
      corpusDir: FIXTURE_CORPUS,
    });
    const whole = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(scoped.findings.map((entry) => entry.manifestPath)).toEqual(['frontend/package.json']);
    expect(whole.findings.map((entry) => entry.manifestPath).sort()).toEqual([
      'backend/package.json',
      'frontend/package.json',
    ]);
  });

  test('a manifest-shaped file that resolves nowhere is still could-not-run', async () => {
    await write('sub/yarn.lock', '# yarn lockfile v1\n');

    let caught: unknown;
    try {
      await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DepGuardError);
    expect((caught as DepGuardError).code).toBe('manifests-unresolved');
    expect((caught as DepGuardError).message).toMatch(/scan root may be wrong/);
  });

  test('gitignored paths and installed or vendored directories are not scanned', async () => {
    await write('.gitignore', 'secret/\n');
    await write('secret/package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
    await write('node_modules/pkg/package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
    await write('vendor/pkg/package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
    await write('.venv/lib/package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
    await write('app/package.json', manifestJson({ react: '18.0.0' }));

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(result.findings).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('--staged, --base and --trust-base compare each manifest on its own path', async () => {
    await write('apps/web/package.json', manifestJson({ react: '18.0.0' }));
    await write('apps/api/package.json', manifestJson({ react: '18.0.0' }));
    await commitAll('base');
    await git('tag', 'base');
    await write(
      'apps/web/package.json',
      manifestJson({ react: '18.0.0', 'reeact-definitely-not-real': '1.0.0' })
    );
    await git('add', '-A');

    const staged = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });
    expect(staged.findings.map((entry) => entry.manifestPath)).toEqual(['apps/web/package.json']);

    await commitAll('head');
    const base = await scan({
      repoRoot: repo,
      mode: { kind: 'base', ref: 'base' },
      corpusDir: FIXTURE_CORPUS,
    });
    expect(base.findings.map((entry) => entry.manifestPath)).toEqual(['apps/web/package.json']);

    const trusted = await scan({
      repoRoot: repo,
      mode: { kind: 'base', ref: 'base' },
      corpusDir: FIXTURE_CORPUS,
      trustBase: 'base',
    });
    expect(trusted.findings.map((entry) => entry.manifestPath)).toEqual(['apps/web/package.json']);
  });
});
