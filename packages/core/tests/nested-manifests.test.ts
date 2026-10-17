import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { computeDelta } from '../src/delta.js';
import { loadStates } from '../src/git-source.js';
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

const BROKEN_PYPROJECT = '[project\nname = "demo"\n';
const POETRY_REV = '0123456789abcdef0123456789abcdef01234567';

describe('pyproject.toml', () => {
  test('a poetry git dependency produces a git-source finding', async () => {
    await write(
      'pyproject.toml',
      [
        '[tool.poetry.dependencies]',
        'python = "^3.11"',
        `foo = { git = "https://example.com/r.git", rev = "${POETRY_REV}" }`,
        '',
      ].join('\n')
    );

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    const finding = result.findings.find((entry) => entry.packageName === 'foo');
    expect(String(finding?.details?.signal ?? '')).toContain('git-source');
  });

  test('an unreadable pyproject on an ignorePaths path does not exit 2', async () => {
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['apps/bad'] }));
    await write('apps/bad/pyproject.toml', BROKEN_PYPROJECT);
    await write('package.json', manifestJson({}));

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(result.exitCode).not.toBe(2);
    const notice = result.run.diagnostics.find((entry) => entry.message.includes('apps/bad/pyproject.toml'));
    expect(notice?.message).toMatch(/not parsed/i);
  });

  test('an unreadable pyproject with no ignore entry exits 2 and names the path', async () => {
    await write('apps/bad/pyproject.toml', BROKEN_PYPROJECT);

    let caught: unknown;
    try {
      await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DepGuardError);
    expect((caught as DepGuardError).code).toBe('manifest-parse');
    expect((caught as DepGuardError).message).toContain('apps/bad/pyproject.toml');
  });
});

// The shape of the fixture npm/cli carries at
// workspaces/arborist/test/fixtures/bad/package.json.
const BROKEN_PACKAGE_JSON = '{\nNOPE\n';

async function scanError(run: () => Promise<unknown>): Promise<DepGuardError> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DepGuardError);
  return caught as DepGuardError;
}

describe('an unparseable stray package.json', () => {
  test('an unreadable stray package.json on an ignorePaths path does not exit 2', async () => {
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['test/fixtures'] }));
    await write('package.json', manifestJson({}));
    await write('test/fixtures/bad/package.json', BROKEN_PACKAGE_JSON);

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(result.exitCode).not.toBe(2);
    const notice = result.run.diagnostics.find((entry) =>
      entry.message.includes('test/fixtures/bad/package.json')
    );
    expect(notice?.code).toBe('manifest-unparsed');
    expect(notice?.message).toMatch(/not parsed/i);
  });

  test('an unreadable stray package.json with no ignore entry exits 2 and names the path', async () => {
    await write('package.json', manifestJson({}));
    await write('test/fixtures/bad/package.json', BROKEN_PACKAGE_JSON);

    const error = await scanError(() =>
      scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS })
    );

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('test/fixtures/bad/package.json');
  });

  test('under --trust-base, a head that adds the ignorePaths entry for its own broken package.json still exits 2', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('base');
    await git('tag', 'base');
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['test/fixtures'] }));
    await write('test/fixtures/bad/package.json', BROKEN_PACKAGE_JSON);
    await commitAll('head');

    const error = await scanError(() =>
      scan({
        repoRoot: repo,
        mode: { kind: 'base', ref: 'base' },
        corpusDir: FIXTURE_CORPUS,
        trustBase: 'base',
      })
    );

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('test/fixtures/bad/package.json');
  });

  test('an ignored package.json beside its own lockfile that does not parse still exits 2', async () => {
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['apps/web'] }));
    await write('package.json', manifestJson({}));
    await write('apps/web/package.json', BROKEN_PACKAGE_JSON);
    await write('apps/web/package-lock.json', npmLock({}));

    const error = await scanError(() =>
      scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS })
    );

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('apps/web/package.json');
  });

  test('an ignored workspace member that does not parse still exits 2', async () => {
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['packages/broken'] }));
    await write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', workspaces: ['packages/*'] }));
    await write('packages/broken/package.json', BROKEN_PACKAGE_JSON);

    const error = await scanError(() =>
      scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS })
    );

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('packages/broken/package.json');
  });

  test('an ignored member a nested install root\'s workspace patterns name that does not parse still exits 2', async () => {
    // Root workspace members are parsed before the catch; this member is
    // reached only through the nested install root apps/x, so it is the
    // case the install-root guard in the catch exists for.
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['apps/x/pkgs'] }));
    await write('package.json', manifestJson({}));
    await write('apps/x/package.json', JSON.stringify({ name: 'x', version: '1.0.0', workspaces: ['pkgs/*'] }));
    await write('apps/x/package-lock.json', npmLock({}));
    await write('apps/x/pkgs/a/package.json', BROKEN_PACKAGE_JSON);

    const error = await scanError(() =>
      scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS })
    );

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('apps/x/pkgs/a/package.json');
  });
});

describe('lockfile coverage is judged per directory', () => {
  const ROOT_YARN = '# yarn lockfile v1\n\nlodash@^4.17.21:\n  version "4.17.21"\n';

  test('a root yarn.lock edit is not a downgrade when only a nested npm lockfile is read', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('yarn.lock', ROOT_YARN);
    await write('apps/web/package.json', manifestJson({ 'left-pad': '^1.0.0' }));
    await write('apps/web/package-lock.json', npmLock({ 'node_modules/left-pad': CLEAN }));
    await commitAll('base');
    await git('tag', 'base');
    await write('yarn.lock', `${ROOT_YARN}\nleft-pad@^1.0.0:\n  version "1.0.0"\n`);

    const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS });

    expect(result.exitCode).toBe(0);
    const nestedChanged = result.run.diagnostics.find((entry) => entry.code === 'lockfile-nested-changed');
    expect(nestedChanged).toBeUndefined();
  });

  test('deleting a nested lockfile is named, and is a downgrade when its manifest still declares dependencies', async () => {
    await write('package.json', manifestJson({}));
    await write('package-lock.json', npmLock({}));
    await write('apps/web/package.json', manifestJson({ 'left-pad': '^1.0.0' }));
    await write('apps/web/package-lock.json', npmLock({ 'node_modules/left-pad': CLEAN }));
    await commitAll('base');
    await git('tag', 'base');
    await rm(path.join(repo, 'apps/web/package-lock.json'));

    let caught: unknown;
    try {
      await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DepGuardError);
    expect((caught as DepGuardError).code).toBe('lockfile-downgrade');
    expect((caught as DepGuardError).message).toContain('apps/web');
  });

  test('deleting a nested lockfile together with its dependencies is reported, not silent', async () => {
    await write('package.json', manifestJson({}));
    await write('package-lock.json', npmLock({}));
    await write('apps/web/package.json', manifestJson({ 'left-pad': '^1.0.0' }));
    await write('apps/web/package-lock.json', npmLock({ 'node_modules/left-pad': CLEAN }));
    await commitAll('base');
    await git('tag', 'base');
    await rm(path.join(repo, 'apps/web/package-lock.json'));
    await write('apps/web/package.json', manifestJson({}));

    const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS });

    const removed = result.run.diagnostics.find((entry) => entry.code === 'lockfile-nested-removed');
    expect(removed?.message).toContain('apps/web/package-lock.json');
  });

  test('a root npm lockfile replaced by a changed yarn.lock is still a downgrade beside a nested lockfile', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLock({
        'node_modules/lodash': {
          version: '4.17.21',
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
          integrity: 'sha512-cleanlodash',
        },
      })
    );
    await write('apps/web/package.json', manifestJson({ 'left-pad': '^1.0.0' }));
    await write('apps/web/package-lock.json', npmLock({ 'node_modules/left-pad': CLEAN }));
    await commitAll('base');
    await git('tag', 'base');
    await rm(path.join(repo, 'package-lock.json'));
    await write('yarn.lock', ROOT_YARN);

    await expect(
      scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS })
    ).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });
});

describe('a finding names the lockfile that changed', () => {
  test('a tampered nested lockfile is named once, not the root lockfile', async () => {
    await write('package.json', manifestJson({}));
    await write('package-lock.json', npmLock({}));
    await write('apps/web/package.json', manifestJson({ 'left-pad': '^1.0.0' }));
    await write('apps/web/package-lock.json', npmLock({ 'node_modules/left-pad': CLEAN }));
    await commitAll('base');
    await git('tag', 'base');
    await write('apps/web/package-lock.json', npmLock({ 'node_modules/left-pad': TAMPERED }));

    const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS });

    const tamper = result.findings.filter(
      (entry) => entry.ruleId === 'lockfile-tamper' && entry.packageName === 'left-pad'
    );
    expect(tamper.map((entry) => entry.lockfilePath)).toEqual(['apps/web/package-lock.json']);
  });
});

describe('scan <path> says when an ancestor lockfile was not read', () => {
  test('a root lockfile outside the scanned directory is noted and not applied', async () => {
    await write('package.json', manifestJson({}));
    await write('package-lock.json', npmLock({ 'node_modules/left-pad': TAMPERED }));
    await write('apps/web/package.json', manifestJson({ 'left-pad': '^1.0.0' }));

    const result = await scan({
      repoRoot: path.join(repo, 'apps/web'),
      mode: { kind: 'audit' },
      corpusDir: FIXTURE_CORPUS,
    });

    expect(result.findings.filter((entry) => entry.ruleId === 'lockfile-tamper')).toEqual([]);
    const note = result.run.diagnostics.find((entry) => entry.code === 'lockfile-outside-prefix');
    expect(note?.message).toContain('package-lock.json');
  });

  test('a scan of the repository root does not emit the note', async () => {
    await write('package.json', manifestJson({}));
    await write('package-lock.json', npmLock({}));

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(result.run.diagnostics.map((entry) => entry.code)).not.toContain('lockfile-outside-prefix');
  });
});

describe('a frontend and backend layout with nothing at the root', () => {
  async function layout(): Promise<void> {
    await write('frontend/package.json', manifestJson({ 'left-pad': '^1.0.0' }));
    await write('frontend/package-lock.json', npmLock({ 'node_modules/left-pad': CLEAN }));
    await write('backend/requirements.txt', 'requests==2.31.0\n');
  }

  test('an audit resolves both manifests and the nested lockfile', async () => {
    await layout();

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(result.exitCode).toBe(0);
    expect(result.run.diagnostics.map((entry) => entry.code)).not.toContain('lockfile-missing');
    const states = await loadStates(repo, { kind: 'audit' });
    expect(states.after.manifests.map((entry) => entry.path).sort()).toEqual([
      'backend/requirements.txt',
      'frontend/package.json',
    ]);
    expect(states.after.lockfile?.path).toBe('frontend/package-lock.json');
  });

  test('a dependency added only in frontend/package.json is a finding', async () => {
    await layout();
    await commitAll('base');
    await git('tag', 'base');
    await write('frontend/package.json', manifestJson({ 'left-pad': '^1.0.0', 'reeact-definitely-not-real': '1.0.0' }));

    const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS });

    expect(result.exitCode).toBe(1);
    expect(result.findings.map((entry) => entry.manifestPath)).toContain('frontend/package.json');
  });

  test('a requirement added only in backend/requirements.txt is a pypi dependency in the delta', async () => {
    await layout();
    await commitAll('base');
    await git('tag', 'base');
    await write('backend/requirements.txt', 'requests==2.31.0\nflask==3.0.0\n');

    const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS });
    const states = await loadStates(repo, { kind: 'base', ref: 'base' });
    const delta = computeDelta(states.before, states.after);

    expect(result.findings.map((entry) => entry.ruleId)).not.toContain('unknown-package');
    expect(delta.changes).toContainEqual(
      expect.objectContaining({ name: 'flask', protocol: 'pypi', manifestPath: 'backend/requirements.txt' })
    );
  });
});

describe('an unread lockfile beside a read one is judged in its own directory', () => {
  test('editing apps/web/yarn.lock beside a read apps/web/package-lock.json is a downgrade', async () => {
    await write('package.json', manifestJson({}));
    await write('apps/web/package.json', manifestJson({ 'left-pad': '^1.0.0' }));
    await write('apps/web/package-lock.json', npmLock({ 'node_modules/left-pad': CLEAN }));
    await write('apps/web/yarn.lock', '# yarn lockfile v1\n');
    await commitAll('base');
    await git('tag', 'base');
    await write('apps/web/yarn.lock', '# yarn lockfile v1\n\nleft-pad@^1.0.0:\n  resolved "https://evil.example/left-pad.tgz"\n');

    await expect(
      scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS })
    ).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });
});

describe('an ignored Python manifest that parses is still read', () => {
  test('its dependencies are in the state and no not-parsed note is printed', async () => {
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['backend'] }));
    await write('package.json', manifestJson({}));
    await write('backend/requirements.txt', 'requests==2.31.0\n');

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
    const states = await loadStates(repo, { kind: 'audit' });

    // The offline pypi-names-not-checked note names the file because its
    // name WAS read (0.13.0); what must be absent is any note saying it
    // was not parsed.
    expect(
      result.run.diagnostics.find(
        (entry) => entry.code !== 'pypi-names-not-checked' && entry.message.includes('backend/requirements.txt')
      )
    ).toBeUndefined();
    expect(states.after.manifests.map((entry) => entry.path)).toContain('backend/requirements.txt');
  });
});

// 0.15.0: one fatal set of project manifests for every position, side and
// scan prefix (docs/design/2026-10-18-unparseable-stray-manifests.md).

async function ignore(...paths: string[]): Promise<void> {
  await write('.dep-guard.json', JSON.stringify({ ignorePaths: paths }));
}

async function auditError(at = repo): Promise<DepGuardError> {
  return scanError(() => scan({ repoRoot: at, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS }));
}

function linkLock(target: string): string {
  return npmLock({
    [target]: { name: 'x', version: '1.0.0' },
    'node_modules/x': { resolved: target, link: true },
  });
}

const UV_LOCK = 'version = 1\n';

describe('vouched positions (0.15.0)', () => {
  test('T1 an ignored build/package.json that does not parse beside build/package-lock.json exits 2', async () => {
    await ignore('build');
    await write('package.json', manifestJson({}));
    await write('build/package.json', BROKEN_PACKAGE_JSON);
    await write('build/package-lock.json', npmLock({}));

    const error = await auditError();

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('build/package.json');
  });

  test.each([
    ['file:', 'file:./tools/x'],
    ['link:', 'link:./tools/x'],
    ['portal:', 'portal:tools/x'],
  ])('T4 an ignored package.json named by a %s specifier that does not parse exits 2', async (_label, spec) => {
    await ignore('tools');
    await write('package.json', manifestJson({ x: spec }));
    await write('tools/x/package.json', BROKEN_PACKAGE_JSON);

    const error = await auditError();

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('tools/x/package.json');
    expect(error.message).toContain('file:, link: or portal:');
  });

  test('T5 an ignored package.json recorded as the resolved directory of a lockfile link entry exits 2', async () => {
    await ignore('tools');
    await write('package.json', manifestJson({}));
    await write('package-lock.json', linkLock('tools/x'));
    await write('tools/x/package.json', BROKEN_PACKAGE_JSON);

    const error = await auditError();

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('tools/x/package.json');
    expect(error.message).toContain('lockfile link entry');
  });

  test('T7 the measured bun shape, text after the value, as an unignored stray exits 2', async () => {
    await write('package.json', manifestJson({}));
    await write('tools/x/package.json', '{"dependencies": {"reqeusts": "1.0.0"}} x');

    const error = await auditError();

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('tools/x/package.json');
    expect(error.message).not.toContain('reqeusts');
  });
});

describe('Python manifests beside a lockfile (0.15.0)', () => {
  test.each([
    ['pyproject.toml', 'uv.lock', BROKEN_PYPROJECT, UV_LOCK],
    ['pyproject.toml', 'poetry.lock', BROKEN_PYPROJECT, ''],
    ['pyproject.toml', 'pdm.lock', BROKEN_PYPROJECT, ''],
    ['Pipfile', 'Pipfile.lock', '[[source]\n', '{}'],
    ['uv.toml', 'uv.lock', 'index-url = \n', UV_LOCK],
    ['pyproject.toml', 'package-lock.json', BROKEN_PYPROJECT, npmLock({})],
  ])('P1 an ignored %s that is not TOML beside %s exits 2', async (manifest, lockName, content, lockContent) => {
    await ignore('py');
    await write('package.json', manifestJson({}));
    await write(`py/x/${manifest}`, content);
    await write(`py/x/${lockName}`, lockContent);

    const error = await auditError();

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain(`py/x/${manifest}`);
    expect(error.message).toContain('a manifest beside a lockfile');
  });

  const UV_ROOT = ['[project]', 'name = "root"', 'version = "0"', '[tool.uv.workspace]', 'members = ["libs/*"]', ''].join('\n');

  test('P2 an ignored uv workspace member that is not TOML exits 2', async () => {
    await ignore('py/libs');
    await write('package.json', manifestJson({}));
    await write('py/pyproject.toml', UV_ROOT);
    await write('py/uv.lock', UV_LOCK);
    await write('py/libs/a/pyproject.toml', BROKEN_PYPROJECT);

    const error = await auditError();

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('py/libs/a/pyproject.toml');
    expect(error.message).toContain('a uv workspace member');
  });

  test('P2 control: an ignored pyproject.toml that is not a uv member is dropped', async () => {
    await ignore('py/tools');
    await write('package.json', manifestJson({}));
    await write('py/pyproject.toml', UV_ROOT);
    await write('py/uv.lock', UV_LOCK);
    await write('py/tools/b/pyproject.toml', BROKEN_PYPROJECT);

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(result.exitCode).not.toBe(2);
    expect(result.run.diagnostics.find((entry) => entry.code === 'manifest-unparsed')?.message).toContain(
      'py/tools/b/pyproject.toml'
    );
    expect(result.run.ecosystems.pypi.notParsed).toBe(1);
    expect(result.run.ecosystems.npm.notParsed).toBe(0);
  });

  test('P3 an ignored shape-broken pyproject.toml beside uv.lock exits 2 and names the shape class', async () => {
    await ignore('py');
    await write('package.json', manifestJson({}));
    await write('py/pyproject.toml', '[dependency-groups]\ndev = "x"\n');
    await write('py/uv.lock', UV_LOCK);

    const error = await auditError();

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('py/pyproject.toml');
    expect(error.message).toContain('it is valid TOML, so a package manager may install from it');
  });

  test.each([
    ['ignored', true],
    ['not ignored', false],
  ])('P4 a vendor/x/pyproject.toml that is not TOML beside vendor/x/uv.lock exits 2 (%s)', async (_label, ignored) => {
    if (ignored) {
      await ignore('vendor');
    }
    await write('package.json', manifestJson({}));
    await write('vendor/x/pyproject.toml', BROKEN_PYPROJECT);
    await write('vendor/x/uv.lock', UV_LOCK);

    const error = await auditError();

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('vendor/x/pyproject.toml');
  });

  test('P4 control: a vendor/x/pyproject.toml that parses beside vendor/x/uv.lock is still not read for names', async () => {
    await write('package.json', manifestJson({}));
    await write('vendor/x/pyproject.toml', '[project]\nname = "x"\nversion = "0"\ndependencies = ["reqeusts"]\n');
    await write('vendor/x/uv.lock', UV_LOCK);

    const states = await loadStates(repo, { kind: 'audit' });

    expect(states.after.manifests.map((entry) => entry.path)).not.toContain('vendor/x/pyproject.toml');
    const note = states.diagnostics.find((entry) => entry.message.startsWith('vendor/x/pyproject.toml'));
    expect(note?.code).toBe('manifest-skipped-dirname');
    expect(note?.message).not.toContain('this one has neither');
    expect(note?.message).toContain('a Python lockfile beside it');
    expect(note?.message).toContain('parsed only to decide whether it stops the scan');
  });
});

describe('an ignorePaths entry that only drops an unparsed manifest (0.15.0)', () => {
  test('is a match, so it is not reported as ignore-path-unmatched', async () => {
    await ignore('test/fixtures/bad', 'nowhere');
    await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
    await write('test/fixtures/bad/package.json', BROKEN_PACKAGE_JSON);

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(result.findings.length).toBeGreaterThan(0);
    const unmatched = result.run.diagnostics.filter((entry) => entry.code === 'ignore-path-unmatched');
    expect(unmatched.map((entry) => entry.message)).toEqual([
      'ignorePaths entry "nowhere" did not match any finding\'s manifestPath in this scan',
    ]);
  });

  test('a drop on the base side counts as a match too', async () => {
    await ignore('tools/x', 'nowhere');
    await write('package.json', manifestJson({}));
    await write('tools/x/package.json', BROKEN_PACKAGE_JSON);
    await commitAll('base');
    await git('tag', 'base');
    await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
    await rm(path.join(repo, 'tools'), { recursive: true });
    await commitAll('head');

    const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS });

    const unmatched = result.run.diagnostics.filter((entry) => entry.code === 'ignore-path-unmatched');
    expect(unmatched.map((entry) => entry.message)).toEqual([
      'ignorePaths entry "nowhere" did not match any finding\'s manifestPath in this scan',
    ]);
  });
});

describe('which side decides (0.15.0)', () => {
  async function unvouchThenBreak(): Promise<void> {
    await ignore('packages/a');
    await write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', workspaces: ['packages/*'] }));
    await write('packages/a/package.json', manifestJson({}));
    await commitAll('base');
    await git('tag', 'base');
    await write('package.json', manifestJson({}));
    await write('packages/a/package.json', BROKEN_PACKAGE_JSON);
    await commitAll('head');
  }

  test('T11 a head that removes a member from the base workspaces and breaks it exits 2 under --base', async () => {
    await unvouchThenBreak();

    const error = await scanError(() =>
      scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS })
    );

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('packages/a/package.json (judged side)');
    expect(error.message).toContain('a root workspace member on the --base ref "base"');
  });

  test('T11 the same exits 2 under --trust-base', async () => {
    await unvouchThenBreak();

    const error = await scanError(() =>
      scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS, trustBase: 'base' })
    );

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('packages/a/package.json');
  });

  test('T11 an audit of the head alone drops it', async () => {
    await unvouchThenBreak();

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(result.exitCode).not.toBe(2);
    expect(result.run.diagnostics.find((entry) => entry.code === 'manifest-unparsed')?.message).toContain(
      'packages/a/package.json'
    );
    expect(result.run.ecosystems.npm.notParsed).toBe(1);
  });

  test('T11b a head that fixes a base-side broken stray and adds a lockfile beside it does not exit 2', async () => {
    await ignore('tools/x');
    await write('package.json', manifestJson({}));
    await write('tools/x/package.json', BROKEN_PACKAGE_JSON);
    await commitAll('base');
    await git('tag', 'base');
    await write('tools/x/package.json', manifestJson({ 'left-pad': '1.0.0' }));
    await write('tools/x/package-lock.json', npmLock({ 'node_modules/left-pad': CLEAN }));
    await commitAll('head');

    const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS });
    const states = await loadStates(repo, { kind: 'base', ref: 'base' }, {
      isIgnoredPath: (relPath) => relPath.startsWith('tools/x/'),
    });
    const delta = computeDelta(states.before, states.after);

    expect(result.exitCode).not.toBe(2);
    expect(result.run.diagnostics.find((entry) => entry.code === 'manifest-unparsed')?.message).toContain(
      'tools/x/package.json'
    );
    expect(delta.changes).toContainEqual(
      expect.objectContaining({ name: 'left-pad', kind: 'added', manifestPath: 'tools/x/package.json' })
    );
  });

  // The trust base contributes ignorePaths only. tools/x has a lockfile
  // beside it on the trust base and on neither --base nor the head, so only
  // the trust base would call it a project.
  async function trustBaseProtectsOnly(baseKeepsLockfile: boolean): Promise<void> {
    await ignore('tools/x');
    await write('package.json', manifestJson({}));
    await write('tools/x/package.json', manifestJson({}));
    await write('tools/x/package-lock.json', npmLock({}));
    await commitAll('trust');
    await git('tag', 'trust');
    if (!baseKeepsLockfile) {
      await rm(path.join(repo, 'tools/x/package-lock.json'));
    }
    await write('README.md', 'base\n');
    await commitAll('base');
    await git('tag', 'base');
    await rm(path.join(repo, 'tools/x/package-lock.json'), { force: true });
    await write('tools/x/package.json', BROKEN_PACKAGE_JSON);
    await commitAll('head');
  }

  test('T13 a separate trust base that alone counts a path as a project does not make it fatal', async () => {
    await trustBaseProtectsOnly(false);

    const result = await scan({
      repoRoot: repo,
      mode: { kind: 'base', ref: 'base' },
      corpusDir: FIXTURE_CORPUS,
      trustBase: 'trust',
    });

    expect(result.exitCode).not.toBe(2);
    expect(result.run.diagnostics.find((entry) => entry.code === 'manifest-unparsed')?.message).toContain(
      'tools/x/package.json'
    );
  });

  test('T13 control: the same path is fatal when the --base side counts it as a project', async () => {
    await trustBaseProtectsOnly(true);

    const error = await scanError(() =>
      scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS, trustBase: 'trust' })
    );

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('a manifest beside a lockfile on the --base ref "base"');
  });

  test('T12 a head that fixes an ignored base-side broken stray has its dependencies judged', async () => {
    await ignore('tools/x');
    await write('package.json', manifestJson({}));
    await write('tools/x/package.json', BROKEN_PACKAGE_JSON);
    await commitAll('base');
    await git('tag', 'base');
    await write('tools/x/package.json', manifestJson({ reqeusts: '1.0.0' }));
    await commitAll('head');

    const states = await loadStates(repo, { kind: 'base', ref: 'base' }, {
      isIgnoredPath: (relPath) => relPath.startsWith('tools/x/'),
    });
    const delta = computeDelta(states.before, states.after);

    expect(delta.changes).toContainEqual(
      expect.objectContaining({ name: 'reqeusts', kind: 'added', manifestPath: 'tools/x/package.json' })
    );
  });
});

describe('a root workspace member the walk reaches is always a project (0.15.0)', () => {
  // The workspace walk reaches members the listing does not show under a
  // pattern: a symlinked member directory resolves to its real path, and a
  // gitignored directory present on disk is listed by readdir, not by git.
  // Either failure is still a root workspace member and stops the scan.
  test('a symlinked member directory pointing at an ignored broken manifest exits 2 under --base and --trust-base', async () => {
    await ignore('fixtures');
    await write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', workspaces: ['packages/*'] }));
    await write('packages/ok/package.json', manifestJson({}));
    await commitAll('base');
    await git('tag', 'base');
    await write('fixtures/evil/package.json', '{"dependencies": {"reqeusts": "1.0.0"}} x');
    await symlink('../fixtures/evil', path.join(repo, 'packages', 'evil'));
    await commitAll('head');

    const error = await scanError(() =>
      scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS, trustBase: 'base' })
    );

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('fixtures/evil/package.json (judged side)');
    expect(error.message).toContain('a root workspace member is a project');
  });

  test('a gitignored member directory present on disk with an ignored broken manifest exits 2', async () => {
    await ignore('packages/hidden');
    await write('.gitignore', 'packages/hidden/\n');
    await write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', workspaces: ['packages/*'] }));
    await write('packages/hidden/package.json', BROKEN_PACKAGE_JSON);

    const error = await auditError();

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('packages/hidden/package.json');
    expect(error.message).toContain('a root workspace member is a project');
  });
});

describe('subdirectory scans (0.15.0)', () => {
  test('S1 a broken ignored root workspace member is fatal on scan packages', async () => {
    await ignore('packages/a');
    await write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', workspaces: ['packages/*'] }));
    await write('packages/a/package.json', BROKEN_PACKAGE_JSON);

    const error = await auditError(path.join(repo, 'packages'));

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('packages/a/package.json');
  });

  test('S2 a broken ignored root workspace member is fatal on a scan of its own directory', async () => {
    await ignore('packages/a');
    await write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', workspaces: ['packages/a'] }));
    await write('package-lock.json', npmLock({}));
    await write('packages/a/package.json', BROKEN_PACKAGE_JSON);

    const error = await auditError(path.join(repo, 'packages', 'a'));

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('packages/a/package.json');
  });

  test('S3 an unreadable root package.json makes every manifest under the scanned path a project', async () => {
    await ignore('tools/y');
    await write('package.json', BROKEN_PACKAGE_JSON);
    await write('tools/y/package.json', BROKEN_PACKAGE_JSON);

    const error = await auditError(path.join(repo, 'tools'));

    expect(error.code).toBe('manifest-parse');
    // The root's own failure is not listed: a subdirectory scan reads it
    // for classification only, and a root scan reports it.
    expect(error.message.startsWith('1 manifest does not parse and stops the scan: tools/y/package.json')).toBe(true);
    expect(error.message).toContain('because package.json outside it could not be read');
  });

  test('S3 control: with every file under the path valid, the scan passes and notes the unread root', async () => {
    await write('package.json', BROKEN_PACKAGE_JSON);
    await write('tools/z/package.json', manifestJson({}));

    const result = await scan({ repoRoot: path.join(repo, 'tools'), mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(result.exitCode).toBe(0);
    const notes = result.run.diagnostics.filter((entry) => entry.code === 'classification-input-unread');
    expect(notes.map((entry) => entry.message)).toEqual([
      'package.json: outside the scanned directory tools and could not be read to decide which manifests are projects, so every manifest under tools was treated as a project for this scan',
    ]);
    expect(result.run.diagnostics.map((entry) => entry.code)).not.toContain('manifest-parse');
  });

  test('S4 an out-of-prefix file: reference makes its target a project', async () => {
    await ignore('tools/x');
    await write('package.json', manifestJson({}));
    await write('apps/web/package.json', manifestJson({ x: 'file:../../tools/x' }));
    await write('tools/x/package.json', BROKEN_PACKAGE_JSON);

    const error = await auditError(path.join(repo, 'tools'));

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('tools/x/package.json');
  });

  test('S5 an out-of-prefix lockfile link entry makes its target a project', async () => {
    await ignore('tools/x');
    await write('package.json', manifestJson({}));
    await write('package-lock.json', linkLock('tools/x'));
    await write('tools/x/package.json', BROKEN_PACKAGE_JSON);

    const error = await auditError(path.join(repo, 'tools'));

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('tools/x/package.json');
  });

  test.each([
    ['a pnpm-workspace.yaml beside a lockfile', 'other/pnpm-workspace.yaml', 'packages: [\n', 'other/pnpm-lock.yaml', "lockfileVersion: '9.0'\n"],
    ['a pyproject.toml beside uv.lock', 'other/pyproject.toml', BROKEN_PYPROJECT, 'other/uv.lock', UV_LOCK],
    ['an npm lockfile', 'other/package-lock.json', '{not json', 'other/package.json', manifestJson({})],
  ])('S6 an unreadable out-of-prefix classification input (%s) makes every manifest under the path a project', async (_label, input, content, beside, besideContent) => {
    await ignore('tools/y');
    await write('package.json', manifestJson({}));
    await write(input, content);
    await write(beside, besideContent);
    await write('tools/y/package.json', BROKEN_PACKAGE_JSON);

    const error = await auditError(path.join(repo, 'tools'));

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('tools/y/package.json');
    expect(error.message).toContain(`because ${input}`);
  });

  test('S7 an out-of-prefix ignored broken stray a root scan would drop contributes nothing', async () => {
    await ignore('other', 'tools/y');
    await write('package.json', manifestJson({}));
    await write('other/package.json', BROKEN_PACKAGE_JSON);
    await write('tools/y/package.json', BROKEN_PACKAGE_JSON);
    await write('tools/z/package.json', manifestJson({}));

    const result = await scan({ repoRoot: path.join(repo, 'tools'), mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(result.exitCode).not.toBe(2);
    const codes = result.run.diagnostics.map((entry) => entry.code);
    expect(codes).not.toContain('classification-input-unread');
    expect(result.run.diagnostics.filter((entry) => entry.code === 'manifest-unparsed').map((entry) => entry.message)).toEqual([
      'tools/y/package.json: not parsed; covered by ignorePaths',
    ]);
  });

  test('S8 scan packages reads a root workspace member under a skipped directory name', async () => {
    await write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', workspaces: ['packages/build/x'] }));
    await write('packages/build/x/package.json', manifestJson({ reqeusts: '1.0.0' }));

    const states = await loadStates(path.join(repo, 'packages'), { kind: 'audit' });

    const member = states.after.manifests.find((entry) => entry.path === 'packages/build/x/package.json');
    expect(member?.deps.map((dep) => dep.name)).toEqual(['reqeusts']);
  });

  test('S9 a classification read outside the path raises no diagnostic of its own (path-outside-root)', async () => {
    // A tracked directory later replaced on disk by a symlink out of the
    // repository: the working tree still lists other/package.json, and
    // reading it resolves outside the root.
    const outside = await mkdtemp(path.join(tmpdir(), 'dep-guard-outside-'));
    tempDirs.push(outside);
    await writeFile(path.join(outside, 'package.json'), manifestJson({}), 'utf8');
    await write('package.json', manifestJson({}));
    await write('other/package.json', manifestJson({}));
    await write('tools/z/package.json', manifestJson({}));
    await commitAll('base');
    await rm(path.join(repo, 'other'), { recursive: true });
    await symlink(outside, path.join(repo, 'other'));

    const sub = await scan({ repoRoot: path.join(repo, 'tools'), mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(sub.run.diagnostics.map((entry) => entry.code)).not.toContain('path-outside-root');
    expect(sub.run.diagnostics.map((entry) => entry.code)).not.toContain('classification-input-unread');
  });

  test('S10 a symlinked package.json outside the path is unread on the judged side', async () => {
    await ignore('tools/y');
    await write('package.json', manifestJson({}));
    await write('real/package.json', manifestJson({}));
    await mkdir(path.join(repo, 'other'), { recursive: true });
    await symlink('../real/package.json', path.join(repo, 'other', 'package.json'));
    await write('tools/y/package.json', BROKEN_PACKAGE_JSON);

    const error = await auditError(path.join(repo, 'tools'));

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('because other/package.json outside it could not be read');
  });

  test('S10 a symlinked package.json outside the path on a comparison side contributes nothing there', async () => {
    await ignore('tools/y');
    await write('package.json', manifestJson({}));
    await write('real/package.json', manifestJson({}));
    await mkdir(path.join(repo, 'other'), { recursive: true });
    await symlink('../real/package.json', path.join(repo, 'other', 'package.json'));
    await write('tools/y/package.json', BROKEN_PACKAGE_JSON);
    await write('tools/z/package.json', manifestJson({}));
    await commitAll('base');
    await git('tag', 'base');
    await rm(path.join(repo, 'other', 'package.json'));
    await write('other/package.json', manifestJson({}));
    await commitAll('head');

    const result = await scan({
      repoRoot: path.join(repo, 'tools'),
      mode: { kind: 'base', ref: 'base' },
      corpusDir: FIXTURE_CORPUS,
    });

    expect(result.exitCode).not.toBe(2);
    expect(result.run.diagnostics.map((entry) => entry.code)).not.toContain('classification-input-unread');
  });

  test('S9 files outside the scanned path raise no scanned-file diagnostics', async () => {
    await write('package.json', manifestJson({}));
    await write('build/package.json', manifestJson({}));
    await write('tools/z/package.json', manifestJson({}));

    const result = await scan({ repoRoot: path.join(repo, 'tools'), mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(result.run.diagnostics.map((entry) => entry.code)).not.toContain('manifest-skipped-dirname');
    expect(result.run.diagnostics.map((entry) => entry.code)).not.toContain('classification-input-unread');
  });
});

describe('every fatal parse error in one exit 2 (0.15.0)', () => {
  test('E1 every side and every parse site is listed, judged side first, in order', async () => {
    await write('package.json', manifestJson({}));
    await write('old/package.json', BROKEN_PACKAGE_JSON);
    await commitAll('base');
    await git('tag', 'base');
    await rm(path.join(repo, 'old'), { recursive: true });
    await write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', workspaces: ['packages/*'], pnpm: 'x' }));
    await write('packages/broken/package.json', BROKEN_PACKAGE_JSON);
    await write('tools/x/package.json', BROKEN_PACKAGE_JSON);
    await commitAll('head');

    const error = await scanError(() =>
      scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS })
    );

    expect(error.code).toBe('manifest-parse');
    expect(error.message.startsWith('4 manifests do not parse and stop the scan: ')).toBe(true);
    const order = [
      'package.json (judged side): "pnpm" field is not an object',
      'packages/broken/package.json (judged side)',
      'tools/x/package.json (judged side)',
      'old/package.json (the --base ref "base")',
    ].map((needle) => error.message.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(error.message).toContain('fix the file on the base branch, or cover it with ignorePaths there');
  });

  test('E2 eleven broken strays list ten and count the rest', async () => {
    await write('package.json', manifestJson({}));
    for (let index = 1; index <= 11; index += 1) {
      await write(`s${String(index).padStart(2, '0')}/package.json`, BROKEN_PACKAGE_JSON);
    }

    const error = await auditError();

    expect(error.code).toBe('manifest-parse');
    expect(error.message.startsWith('11 manifests do not parse')).toBe(true);
    expect(error.message).toContain('s10/package.json');
    expect(error.message).not.toContain('s11/package.json');
    expect(error.message).toContain('and 1 more');
  });

  test('E3 a lockfile parse error beside a broken stray keeps its own error and code', async () => {
    await write('package.json', manifestJson({}));
    await write('package-lock.json', '{not json');
    await write('tools/x/package.json', BROKEN_PACKAGE_JSON);

    const error = await auditError();

    expect(error.code).toBe('lockfile-parse');
  });
});

describe('manifest-parse messages carry no file content (0.15.0)', () => {
  test('M1 a byte order mark before a shape-broken file beside a lockfile names the shape class', async () => {
    await ignore('apps/w');
    await write('package.json', manifestJson({}));
    await write('apps/w/package.json', '﻿{"pnpm": "x"}');
    await write('apps/w/package-lock.json', npmLock({}));

    const error = await auditError();

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('it is valid JSON, so a package manager may install from it');
    expect(error.message).not.toContain('some package managers accept JSON');
  });

  test('M2 a dependency key is printed only up to its leading name characters', async () => {
    await write('package.json', manifestJson({}));
    await write('apps/s/package.json', JSON.stringify({ dependencies: { 'tok_SECRET-123 abc\u0001': 1 } }));

    const error = await auditError();

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('"tok_SECRET-123..."');
    expect(error.message).not.toContain(' abc');
    expect(error.message).not.toContain('\u0001');
  });

  // Two bodies: the npm/cli shape, and one whose JSON.parse error text
  // quotes the input (V8 echoes the source around an unexpected token), so
  // a message that passed parser text through would carry NOPE.
  const positions: Array<[string, (body: string) => Promise<void>]> = [
    ['the root package.json', async (body) => write('package.json', body)],
    [
      'a root workspace member',
      async (body) => {
        await write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', workspaces: ['packages/*'] }));
        await write('packages/a/package.json', body);
      },
    ],
    [
      'a manifest beside a lockfile',
      async (body) => {
        await write('package.json', manifestJson({}));
        await write('apps/x/package.json', body);
        await write('apps/x/package-lock.json', npmLock({}));
      },
    ],
    [
      'a nested install root member',
      async (body) => {
        await write('package.json', manifestJson({}));
        await write('apps/x/package.json', JSON.stringify({ name: 'x', version: '1.0.0', workspaces: ['pkgs/*'] }));
        await write('apps/x/package-lock.json', npmLock({}));
        await write('apps/x/pkgs/a/package.json', body);
      },
    ],
    [
      'a file: target',
      async (body) => {
        await write('package.json', manifestJson({ x: 'file:tools/x' }));
        await write('tools/x/package.json', body);
      },
    ],
    [
      'a lockfile link target',
      async (body) => {
        await write('package.json', manifestJson({}));
        await write('package-lock.json', linkLock('tools/x'));
        await write('tools/x/package.json', body);
      },
    ],
  ];
  describe.each([
    ['the npm/cli shape', BROKEN_PACKAGE_JSON],
    ['a body the parser quotes', '{"dependencies": NOPE}'],
  ])('M3 with %s', (_bodyLabel, body) => {
    test.each(positions)('no message echoes the fixture body: %s', async (_label, setup) => {
      await ignore('apps', 'packages', 'tools');
      await setup(body);

      const error = await auditError();

      expect(error.code).toBe('manifest-parse');
      expect(error.message).not.toContain('NOPE');
      expect(error.message).toContain('is a project and stops the scan whatever ignorePaths says');
    });
  });
});

describe('a root lockfile does not stand in for a deleted nested one', () => {
  test('deleting apps/web/package-lock.json beside a root lockfile with entries is still a downgrade', async () => {
    await write('package.json', manifestJson({ 'left-pad': '^1.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/left-pad': CLEAN }));
    await write('apps/web/package.json', manifestJson({ 'left-pad': '^1.0.0' }));
    await write('apps/web/package-lock.json', npmLock({ 'node_modules/left-pad': CLEAN }));
    await commitAll('base');
    await git('tag', 'base');
    await rm(path.join(repo, 'apps/web/package-lock.json'));

    let caught: unknown;
    try {
      await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DepGuardError);
    expect((caught as DepGuardError).code).toBe('lockfile-downgrade');
    expect((caught as DepGuardError).message).toContain('apps/web/package-lock.json');
  });
});
