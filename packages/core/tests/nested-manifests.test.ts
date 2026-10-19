import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { computeDelta } from '../src/delta.js';
import { fingerprintFinding } from '../src/fingerprint.js';
import { loadRefState, loadStates, projectReasonText, reconfirmWorkspaceLocalNames } from '../src/git-source.js';
import { applyUvSources, judgedPythonControls } from '../src/python-sources.js';
import { applyPathFilters, scan } from '../src/scan.js';
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

// docs/design/2026-10-18-head-defined-projects-and-ignore-paths.md, the
// test plan in section 7. Each test names its id. The fixture corpus has
// no malicious list, so "lodahs" (a typosquat of lodash there) stands in.
describe('a change that wires an ignored path into the install (0.16.0)', () => {
  const MS = {
    version: '2.1.3',
    resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
    integrity: 'sha512-ms',
  };
  const LODAHS = {
    version: '1.0.0',
    resolved: 'https://registry.npmjs.org/lodahs/-/lodahs-1.0.0.tgz',
    integrity: 'sha512-lodahs',
  };
  const LODAHS_EVIL = {
    version: '1.0.0',
    resolved: 'https://evil.example/lodahs/-/lodahs-1.0.0.tgz',
    integrity: 'sha512-lodahs',
  };

  function pkg(name: string, dependencies: Record<string, string>, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ name, version: '1.0.0', dependencies, ...extra });
  }

  async function writeAll(files: Record<string, string>): Promise<void> {
    for (const [relPath, content] of Object.entries(files)) {
      await write(relPath, content);
    }
  }

  // Commits the base on main and moves to a pull-request branch.
  async function commitBase(files: Record<string, string>): Promise<void> {
    await writeAll(files);
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
  }

  async function commitHead(files: Record<string, string>): Promise<void> {
    await writeAll(files);
    await commitAll('head');
  }

  function pullRequest(options: { trustBase?: string | null; repoRoot?: string } = {}) {
    const trustBase = options.trustBase === undefined ? 'main' : options.trustBase;
    return scan({
      repoRoot: options.repoRoot ?? repo,
      mode: { kind: 'base', ref: 'main' },
      corpusDir: FIXTURE_CORPUS,
      ...(trustBase === null ? {} : { trustBase }),
    });
  }

  const BASE_FILES = (ignorePaths: string[] = ['fixtures']): Record<string, string> => ({
    'package.json': pkg('app', { ms: '^2.1.3' }),
    'package-lock.json': npmLock({ 'node_modules/ms': MS }),
    '.dep-guard.json': JSON.stringify({ ignorePaths }),
  });

  // H1's head: a file: dependency on fixtures/helper, which declares lodahs,
  // with the npm lock entries including the link entry.
  const H1_HEAD: Record<string, string> = {
    'package.json': pkg('app', { ms: '^2.1.3', helper: 'file:fixtures/helper' }),
    'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }),
    'package-lock.json': npmLock({
      'node_modules/ms': MS,
      'fixtures/helper': { name: 'helper', version: '1.0.0', dependencies: { lodahs: '^1.0.0' } },
      'node_modules/helper': { resolved: 'fixtures/helper', link: true },
      'node_modules/lodahs': LODAHS,
    }),
  };

  // H3's base: the wiring and the manifest are already there, declaring
  // nothing yet.
  const H3_BASE: Record<string, string> = {
    ...BASE_FILES(),
    'package.json': pkg('app', { ms: '^2.1.3', helper: 'file:fixtures/helper' }),
    'fixtures/helper/package.json': pkg('helper', {}),
    'package-lock.json': npmLock({
      'node_modules/ms': MS,
      'fixtures/helper': { name: 'helper', version: '1.0.0' },
      'node_modules/helper': { resolved: 'fixtures/helper', link: true },
    }),
  };

  const lodahsFindings = (result: ScanResultLike) =>
    result.findings.filter((finding) => finding.packageName === 'lodahs');
  const codes = (result: ScanResultLike) => result.run.diagnostics.map((entry) => entry.code);
  const diagnostic = (result: ScanResultLike, code: string) =>
    result.run.diagnostics.find((entry) => entry.code === code)?.message ?? '';
  type ScanResultLike = Awaited<ReturnType<typeof scan>>;

  test('H1 a file: dependency on an ignored directory keeps its findings and is proposed', async () => {
    await commitBase(BASE_FILES());
    await commitHead(H1_HEAD);

    const result = await pullRequest();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'fixtures/helper/package.json')).toBe(true);
    expect(kept.every((finding) => JSON.stringify(finding.ignoreOverride?.entries) === '["fixtures"]')).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.ignoreKept).toBe(kept.length);
    expect(result.ignored).toBe(0);
    expect(result.trustBase?.proposals).toEqual([
      'ignorePaths: this change makes ignored path fixtures/helper/package.json a project ' +
        '(the target of a file:, link: or portal: dependency; the target of an npm lockfile link entry); ' +
        'its findings are kept',
    ]);
    expect(result.trustBase?.projectPathsChanged).toBe(true);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/helper/package.json']);
    expect(diagnostic(result, 'ignore-path-project-kept')).toBe(
      'fixtures/helper/package.json: covered by ignorePaths entry "fixtures", but this change makes it a ' +
        'project (the target of a file:, link: or portal: dependency; the target of an npm lockfile link entry) ' +
        `and the trust base "main" does not install it that way; ${kept.length} finding(s) kept`
    );
  });

  test.each([
    ['pnpm-lock.yaml in place of package-lock.json', true],
    ['no lockfile at all', false],
  ])('H1n the file: reason alone keeps the findings (%s)', async (_label, pnpm) => {
    const lock: Record<string, string> = pnpm ? { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" } : {};
    await commitBase({
      'package.json': pkg('app', { ms: '^2.1.3' }),
      '.dep-guard.json': JSON.stringify({ ignorePaths: ['fixtures'] }),
      ...lock,
    });
    await commitHead({
      'package.json': pkg('app', { ms: '^2.1.3', helper: 'file:fixtures/helper' }),
      'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }),
    });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/helper/package.json']);
  });

  test('H1b a base that already counts the path as a project through rule 3 does not excuse a new file: wiring', async () => {
    await commitBase({
      ...BASE_FILES(),
      'fixtures/helper/package.json': pkg('helper', {}),
      'fixtures/helper/package-lock.json': npmLock({}),
    });
    await commitHead(H1_HEAD);

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.proposals.join('\n')).toContain('fixtures/helper/package.json a project');
  });

  test('H2 a workspaces glob widened over an ignored directory keeps its findings', async () => {
    await commitBase({
      'package.json': pkg('app', { ms: '^2.1.3' }, { workspaces: ['packages/*'] }),
      'packages/a/package.json': pkg('a', {}),
      'package-lock.json': npmLock({ 'node_modules/ms': MS }),
      '.dep-guard.json': JSON.stringify({ ignorePaths: ['examples/**'] }),
    });
    await commitHead({
      'package.json': pkg('app', { ms: '^2.1.3' }, { workspaces: ['packages/*', 'examples/*'] }),
      'examples/demo/package.json': pkg('demo', { lodahs: '^1.0.0' }),
      'package-lock.json': npmLock({
        'node_modules/ms': MS,
        'node_modules/demo': { resolved: 'examples/demo', link: true },
        'examples/demo': { name: 'demo', version: '1.0.0', dependencies: { lodahs: '^1.0.0' } },
        'node_modules/lodahs': LODAHS,
      }),
    });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.proposals.join('\n')).toContain(
      'examples/demo/package.json a project (a root workspace member'
    );
    expect(diagnostic(result, 'workspace-link-unconfirmed')).toContain('this change edits that field to cover it');
  });

  test('H3 a project the base already installs that way keeps ignorePaths, with the standing choice noted', async () => {
    await commitBase(H3_BASE);
    await commitHead({
      'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }),
      'package-lock.json': npmLock({
        'node_modules/ms': MS,
        'fixtures/helper': { name: 'helper', version: '1.0.0', dependencies: { lodahs: '^1.0.0' } },
        'node_modules/helper': { resolved: 'fixtures/helper', link: true },
        'node_modules/lodahs': LODAHS,
      }),
    });

    const result = await pullRequest();

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.ignored).toBeGreaterThan(0);
    expect(result.ignoreKept).toBe(0);
    expect(diagnostic(result, 'ignore-path-dropped')).toContain(
      `${result.ignored} of them on installed projects (fixtures/helper/package.json)`
    );
    expect(result.trustBase?.proposals).toEqual([]);
    expect(result.trustBase?.projectPathsChanged).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  test('H3t a lockfile-tamper finding on a project the base installs is never dropped', async () => {
    await commitBase({
      ...H3_BASE,
      'fixtures/helper/package.json': pkg('helper', { 'left-pad': '^1.0.0' }),
      'package-lock.json': npmLock({
        'node_modules/ms': MS,
        'fixtures/helper': { name: 'helper', version: '1.0.0', dependencies: { 'left-pad': '^1.0.0' } },
        'node_modules/helper': { resolved: 'fixtures/helper', link: true },
        'node_modules/left-pad': CLEAN,
      }),
    });
    await commitHead({
      'package-lock.json': npmLock({
        'node_modules/ms': MS,
        'fixtures/helper': { name: 'helper', version: '1.0.0', dependencies: { 'left-pad': '^1.0.0' } },
        'node_modules/helper': { resolved: 'fixtures/helper', link: true },
        'node_modules/left-pad': TAMPERED,
      }),
    });

    const result = await pullRequest();

    const tamper = result.findings.filter((finding) => finding.ruleId === 'lockfile-tamper');
    expect(tamper.length).toBeGreaterThan(0);
    expect(tamper.every((finding) => finding.manifestPath === 'fixtures/helper/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.proposals).toEqual([]);
  });

  test('H4 a manifest under an ignored path that nothing installs is dropped as before', async () => {
    await commitBase(BASE_FILES());
    await commitHead({ 'fixtures/x/package.json': pkg('x', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.ignored).toBeGreaterThan(0);
    expect(result.ignoreKept).toBe(0);
    expect(result.trustBase?.proposals).toEqual([]);
    expect(codes(result)).not.toContain('ignore-path-project-kept');
    expect(result.exitCode).toBe(0);
  });

  test('H5 a lockfile added beside an ignored manifest keeps its findings', async () => {
    await commitBase({ ...BASE_FILES(), 'fixtures/helper/package.json': pkg('helper', {}) });
    await commitHead({
      'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }),
      'fixtures/helper/package-lock.json': npmLock({ 'node_modules/lodahs': LODAHS }),
    });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.proposals.join('\n')).toContain(
      'fixtures/helper/package.json a project (a manifest beside a lockfile)'
    );
  });

  test('H6 a scan of the ignored directory itself keeps the findings and makes the same proposal', async () => {
    await commitBase(BASE_FILES());
    await commitHead(H1_HEAD);

    const result = await pullRequest({ repoRoot: path.join(repo, 'fixtures') });

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/helper/package.json']);
  });

  test('H7 a reference side whose out-of-prefix input is unreadable excuses nothing under the prefix', async () => {
    const unreadable = {
      'other/pnpm-workspace.yaml': 'packages: [\n',
      'other/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    };
    await commitBase({ ...H3_BASE, ...unreadable });
    await commitHead({ 'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });

    const result = await pullRequest({ repoRoot: path.join(repo, 'fixtures') });

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(codes(result)).toContain('classification-input-unread');
  });

  test('H7 control: the same tree with the input readable is excused', async () => {
    await commitBase(H3_BASE);
    await commitHead({ 'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });

    const result = await pullRequest({ repoRoot: path.join(repo, 'fixtures') });

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  const H8_FILES = (pattern: string, deps: Record<string, string>): Record<string, string> => ({
    'sub/package.json': pkg('sub', {}, { workspaces: [pattern] }),
    'sub/yarn.lock': '# yarn lockfile v1\n',
    'sub/packages/x/package.json': pkg('x', deps),
  });

  test('H8 an inexact workspace pattern whose text changes is a new reason', async () => {
    await commitBase({ ...BASE_FILES(['sub/packages']), ...H8_FILES('packages/{a,x}', {}) });
    await commitHead(H8_FILES('packages/{b,x}', { lodahs: '^1.0.0' }));

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['sub/packages/x/package.json']);
  });

  test('H8b the same inexact pattern on both sides excuses, with no proposal', async () => {
    await commitBase({ ...BASE_FILES(['sub/packages']), ...H8_FILES('packages/{a,x}', {}) });
    await commitHead(H8_FILES('packages/{a,x}', { lodahs: '^1.0.0' }));

    const result = await pullRequest();

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.trustBase?.proposals).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('H9 the same rule applies to a --base run without --trust-base, as a diagnostic', async () => {
    await commitBase(BASE_FILES());
    await commitHead(H1_HEAD);

    const result = await pullRequest({ trustBase: null });

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result).not.toHaveProperty('trustBase');
    expect(diagnostic(result, 'ignore-path-project-kept')).toContain(
      'and the --base ref "main" does not install it that way'
    );
  });

  // H10 and H20: an earlier commit on the branch wires fixtures/helper in;
  // main does not have it; the staged change adds lodahs there.
  async function stagedOnWiredBranch(): Promise<void> {
    await commitBase(BASE_FILES());
    await commitHead({
      'package.json': pkg('app', { ms: '^2.1.3', helper: 'file:fixtures/helper' }),
      'fixtures/helper/package.json': pkg('helper', {}),
      'package-lock.json': npmLock({
        'node_modules/ms': MS,
        'fixtures/helper': { name: 'helper', version: '1.0.0' },
        'node_modules/helper': { resolved: 'fixtures/helper', link: true },
      }),
    });
    await writeAll({
      'fixtures/helper/package.json': H1_HEAD['fixtures/helper/package.json'],
      'package-lock.json': H1_HEAD['package-lock.json'],
    });
    await git('add', '-A');
  }

  test('H10 a staged change is judged against HEAD without --trust-base and against the trust base with it', async () => {
    await stagedOnWiredBranch();

    const local = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });
    const trusted = await scan({
      repoRoot: repo,
      mode: { kind: 'staged' },
      corpusDir: FIXTURE_CORPUS,
      trustBase: 'main',
    });

    expect(lodahsFindings(local)).toHaveLength(0);
    expect(local.exitCode).toBe(0);
    expect(lodahsFindings(trusted).length).toBeGreaterThan(0);
    expect(trusted.exitCode).toBe(1);
  });

  test('H11 an audit has no reference side and drops as before', async () => {
    await commitBase(BASE_FILES());
    await writeAll(H1_HEAD);

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.ignored).toBeGreaterThan(0);
    expect(result.ignoreKept).toBe(0);
    expect(codes(result)).not.toContain('ignore-path-project-kept');
  });

  test('H12 a pull request that removes the wiring is dropped, with no proposal', async () => {
    await commitBase(H3_BASE);
    await commitHead({
      'package.json': pkg('app', { ms: '^2.1.3' }),
      'package-lock.json': npmLock({ 'node_modules/ms': MS }),
      'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }),
    });

    const result = await pullRequest();

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.trustBase?.proposals).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('H13 an entry whose only matches were kept findings is not reported unmatched', async () => {
    await commitBase(BASE_FILES());
    await commitHead(H1_HEAD);

    const result = await pullRequest();

    expect(result.ignored).toBe(0);
    expect(codes(result)).not.toContain('ignore-path-unmatched');
  });

  test('H14 both states reaching the filter carry projects, and a judged state without them is an internal error', async () => {
    await commitBase(BASE_FILES());
    await commitHead(H1_HEAD);

    const pair = await loadStates(repo, { kind: 'base', ref: 'main' });
    const trusted = await loadRefState(repo, 'main');
    const judged = reconfirmWorkspaceLocalNames(pair.after, trusted, 'the trust base "main"', []);
    applyUvSources(judged.manifests, judgedPythonControls(judged.manifests), [], new Set());
    expect(judged.projects?.reasons.get('fixtures/helper/package.json')?.length).toBeGreaterThan(0);
    expect(trusted.projects).toBeDefined();

    const raw = [
      {
        ruleId: 'typosquat' as const,
        severity: 'low' as const,
        packageName: 'lodahs',
        message: 'm',
        manifestPath: 'fixtures/helper/package.json',
      },
    ];
    const run = (judgedProjects: typeof judged.projects) =>
      applyPathFilters(raw, { ignorePaths: ['fixtures'] }, new Set(), [], new Set(), {
        judged: judgedProjects,
        reference: trusted.projects ?? null,
        referenceLabel: 'the trust base "main"',
        prefix: '',
        audit: false,
      });
    expect(run(judged.projects).ignoreKept).toBe(1);
    expect(() => run(undefined)).toThrow(DepGuardError);
  });

  test('H15 a stray declaring a root-lockfile name does not pull its tamper finding into an ignored path', async () => {
    await commitBase({
      ...BASE_FILES(),
      'package-lock.json': npmLock({ 'node_modules/ms': MS, 'node_modules/left-pad': CLEAN }),
    });
    await commitHead({
      'fixtures/stray/package.json': pkg('stray', { 'left-pad': '^1.0.0' }),
      'package-lock.json': npmLock({ 'node_modules/ms': MS, 'node_modules/left-pad': TAMPERED }),
    });

    const result = await pullRequest();

    const tamper = result.findings.filter((finding) => finding.ruleId === 'lockfile-tamper');
    expect(tamper.length).toBeGreaterThan(0);
    expect(tamper[0]).toMatchObject({ manifestPath: 'fixtures/stray/package.json', lockfilePath: 'package-lock.json' });
    expect(result.exitCode).toBe(1);

    // The fingerprint still hashes manifestPath: it equals the same
    // finding's fingerprint on a run with no ignorePaths at all.
    await write('.dep-guard.json', '{}');
    const unfiltered = await pullRequest({ trustBase: null });
    const same = unfiltered.findings.find(
      (finding) => finding.ruleId === 'lockfile-tamper' && finding.manifestPath === tamper[0].manifestPath
    );
    expect(same?.fingerprint).toBe(tamper[0].fingerprint);
  });

  // The anchor rule moves only a finding about an entry the lockfile
  // records. tamper.ts names the primary lockfile on every finding,
  // including one about a stray's own git specifier, which nothing
  // installs and the lockfile does not record.
  test('H15c a stray under an ignored path with its own git specifier is still dropped', async () => {
    await commitBase(BASE_FILES());
    await commitHead({ 'fixtures/stray/package.json': pkg('stray', { gitdep: 'github:example/gitdep' }) });

    const result = await pullRequest();

    expect(result.findings.filter((finding) => finding.ruleId === 'lockfile-tamper')).toHaveLength(0);
    expect(result.ignored).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
  });

  test('H16 a requirements file the root includes with -r keeps its findings', async () => {
    await commitBase({
      'requirements.txt': 'requests==2.31.0\n',
      '.dep-guard.json': JSON.stringify({ ignorePaths: ['fixtures'] }),
    });
    await commitHead({
      'requirements.txt': 'requests==2.31.0\n-r fixtures/extra.txt\n',
      'fixtures/extra.txt': 'reqeusts==1.0.0\n',
    });

    const result = await pullRequest();

    expect(result.findings.filter((finding) => finding.packageName === 'reqeusts').length).toBeGreaterThan(0);
    expect(result.ignoreKept).toBeGreaterThan(0);
    expect(result.trustBase?.proposals.join('\n')).toContain(
      'fixtures/extra.txt a project (a requirements file another requirements file includes with -r or -c)'
    );
  });

  test('H16s the include is seen from a scan of the ignored directory, outside which it is written', async () => {
    // Named as a requirements file so that a scan of fixtures reads it on
    // its own: a file reached only through -r is read only from the
    // including file, which this scan does not read. On the base nothing
    // includes it.
    await commitBase({
      'requirements.txt': 'requests==2.31.0\n',
      'fixtures/requirements-extra.txt': 'requests==2.31.0\n',
      '.dep-guard.json': JSON.stringify({ ignorePaths: ['fixtures'] }),
    });
    await commitHead({
      'requirements.txt': 'requests==2.31.0\n-r fixtures/requirements-extra.txt\n',
      'fixtures/requirements-extra.txt': 'requests==2.31.0\nreqeusts==1.0.0\n',
    });

    const result = await pullRequest({ repoRoot: path.join(repo, 'fixtures') });

    expect(result.findings.filter((finding) => finding.packageName === 'reqeusts').length).toBeGreaterThan(0);
    expect(result.trustBase?.proposals.join('\n')).toContain(
      'fixtures/requirements-extra.txt a project (a requirements file another requirements file includes with -r or -c)'
    );
  });

  test('H17 a pnpm-workspace.yaml negation does not cancel a member the workspaces field adds', async () => {
    await commitBase({
      'package.json': pkg('app', {}, { workspaces: ['packages/*'] }),
      'packages/a/package.json': pkg('a', {}),
      'pnpm-workspace.yaml': "packages:\n  - '!examples/demo'\n",
      'yarn.lock': '# yarn lockfile v1\n',
      '.dep-guard.json': JSON.stringify({ ignorePaths: ['examples'] }),
    });
    await commitHead({
      'package.json': pkg('app', {}, { workspaces: ['packages/*', 'examples/*'] }),
      'examples/demo/package.json': pkg('demo', { lodahs: '^1.0.0' }),
    });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
  });

  test('H18 a nested lockfile whose only wiring is itself stays excused by ignorePaths', async () => {
    await commitBase({ ...BASE_FILES(), 'fixtures/x/package.json': pkg('x', {}) });
    await commitHead({ 'fixtures/x/yarn.lock': '# yarn lockfile v1\n' });

    const before = await pullRequest();

    expect(codes(before)).toContain('lockfile-nested-ignored');
    expect(codes(before)).not.toContain('lockfile-nested-changed');
    expect(before.exitCode).toBe(0);
  });

  test('H19 a nested lockfile in a directory the change wires in is judged, and the hint names the wiring', async () => {
    await commitBase({ ...BASE_FILES(), 'fixtures/x/package.json': pkg('x', {}) });
    await commitHead({
      'fixtures/x/yarn.lock': '# yarn lockfile v1\n',
      'package.json': pkg('app', { ms: '^2.1.3', x: 'file:fixtures/x' }),
    });

    const result = await pullRequest();

    expect(codes(result).filter((code) => code === 'lockfile-nested-changed')).toHaveLength(1);
    expect(codes(result)).not.toContain('lockfile-nested-ignored');
    expect(result.exitCode).toBe(0);
    const message = diagnostic(result, 'lockfile-nested-changed');
    expect(message).toContain('fixtures/x/yarn.lock is covered by ignorePaths');
    expect(message).toContain('the target of a file:, link: or portal: dependency');
    expect(codes(result)).not.toContain('ignore-path-unmatched');
  });

  test('H20 --staged --trust-base judges against the trust base, not HEAD', async () => {
    await stagedOnWiredBranch();

    const result = await scan({
      repoRoot: repo,
      mode: { kind: 'staged' },
      corpusDir: FIXTURE_CORPUS,
      trustBase: 'main',
    });

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/helper/package.json']);
  });

  test('H21 with --base X --trust-base Y, Y decides even where X installs the path', async () => {
    await commitBase(BASE_FILES());
    await git('checkout', '-q', '-b', 'x');
    await commitHead({
      'package.json': pkg('app', { ms: '^2.1.3', helper: 'file:fixtures/helper' }),
      'fixtures/helper/package.json': pkg('helper', {}),
    });
    await git('checkout', '-q', '-b', 'pr-on-x');
    await writeAll({ 'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });
    await commitAll('pr');

    const result = await scan({
      repoRoot: repo,
      mode: { kind: 'base', ref: 'x' },
      corpusDir: FIXTURE_CORPUS,
      trustBase: 'main',
    });

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
  });

  test('H22 --trust-base without --base applies the rule with the trust base as reference', async () => {
    await commitBase(BASE_FILES());
    await commitHead(H1_HEAD);

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS, trustBase: 'main' });

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
  });

  test('H23 the proposal is made when the newly wired path has no findings', async () => {
    await commitBase(BASE_FILES());
    await commitHead({
      'package.json': pkg('app', { ms: '^2.1.3', helper: 'file:fixtures/helper' }),
      'fixtures/helper/package.json': pkg('helper', {}),
    });

    const result = await pullRequest();

    expect(result.ignoreKept).toBe(0);
    expect(result.trustBase?.proposals).toHaveLength(1);
    expect(result.trustBase?.projectPathsChanged).toBe(true);
  });

  test('H24 twelve wired paths give ten proposal lines and one count line; JSON lists all twelve', async () => {
    await commitBase(BASE_FILES());
    const names = Array.from({ length: 12 }, (_unused, index) => `h${String(index + 1).padStart(2, '0')}`);
    const files: Record<string, string> = {
      'package.json': pkg('app', {
        ms: '^2.1.3',
        ...Object.fromEntries(names.map((name) => [name, `file:fixtures/${name}`])),
      }),
    };
    for (const name of names) {
      files[`fixtures/${name}/package.json`] = pkg(name, {});
    }
    await commitHead(files);

    const result = await pullRequest();

    const proposals = result.trustBase?.proposals ?? [];
    expect(proposals).toHaveLength(11);
    expect(proposals[9]).toContain('fixtures/h10/package.json');
    expect(proposals[10]).toBe('ignorePaths: and 2 more ignored paths this change makes projects; their findings are kept');
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(names.map((name) => `fixtures/${name}/package.json`));
  });

  test('H25 an audit of a tree that installs an ignored path says so in the dropped note', async () => {
    await commitBase(H3_BASE);
    await writeAll({ 'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(result.ignored).toBeGreaterThan(0);
    expect(diagnostic(result, 'ignore-path-dropped')).toContain(
      `${result.ignored} of them on installed projects (fixtures/helper/package.json)`
    );
  });

  test('H26 a clean pull request reports the new fields at zero', async () => {
    await commitBase(BASE_FILES());
    await commitHead({ 'README.md': 'hello\n' });

    const result = await pullRequest();

    expect(result).toHaveProperty('ignoreKept', 0);
    expect(result.trustBase).toHaveProperty('projectPathsChanged', false);
    expect(result.trustBase).toHaveProperty('ignoredPathsMadeProjects', []);
  });

  test('H27 the link exemption still reads the base field where the base has the package.json and no lockfile', async () => {
    await commitBase({
      'package.json': pkg('app', { ms: '^2.1.3' }),
      'package-lock.json': npmLock({ 'node_modules/ms': MS }),
      'sub/package.json': pkg('sub', {}, { workspaces: ['packages/*'] }),
    });
    await commitHead({
      'sub/package.json': pkg('sub', { lodahs: '^1.0.0' }, { workspaces: ['packages/*', 'evil/*'] }),
      'sub/evil/lodahs/package.json': JSON.stringify({ name: 'lodahs', version: '1.0.0' }),
      'sub/package-lock.json': npmLock({ 'node_modules/lodahs': { resolved: 'evil/lodahs', link: true } }),
    });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(diagnostic(result, 'workspace-link-unconfirmed')).toContain('this change edits that field to cover it');
  });

  test('H28 a kept finding has the fingerprint it would have with no ignorePaths', async () => {
    await commitBase(BASE_FILES());
    await commitHead(H1_HEAD);

    const kept = lodahsFindings(await pullRequest());
    await write('.dep-guard.json', '{}');
    const unfiltered = lodahsFindings(await pullRequest({ trustBase: null }));

    expect(kept.length).toBeGreaterThan(0);
    expect(kept.map((finding) => finding.fingerprint).sort()).toEqual(
      unfiltered.map((finding) => finding.fingerprint).sort()
    );
    expect(kept.every((finding) => finding.fingerprint === fingerprintFinding(finding))).toBe(true);
  });

  // The implementation review's three bypasses (design note, "Implementation
  // review rulings", F1 to F3), each with the standing-base control.
  const PNPM_OR_NONE: Array<[string, Record<string, string>]> = [
    ['no lockfile', {}],
    ['pnpm-lock.yaml', { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" }],
  ];
  const ignoreOnly = { '.dep-guard.json': JSON.stringify({ ignorePaths: ['fixtures'] }) };

  test.each(PNPM_OR_NONE)('H29 a bare relative-path dependency on an ignored directory keeps its findings (%s)', async (_label, lock) => {
    await commitBase({ 'package.json': pkg('app', { ms: '^2.1.3' }), ...ignoreOnly, ...lock });
    await commitHead({
      'package.json': pkg('app', { ms: '^2.1.3', helper: './fixtures/helper' }),
      'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }),
    });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/helper/package.json']);
  });

  test('H29c a bare-path wiring the base already has keeps ignorePaths', async () => {
    await commitBase({
      'package.json': pkg('app', { ms: '^2.1.3', helper: './fixtures/helper' }),
      'fixtures/helper/package.json': pkg('helper', {}),
      ...ignoreOnly,
    });
    await commitHead({ 'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.ignored).toBeGreaterThan(0);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test.each([
    ['an absolute bare path', '/opt/elsewhere/helper'],
    ['an absolute file: path', 'file:/opt/elsewhere/helper'],
    ['a relative path that leaves the repository', 'file:../checkout/fixtures/helper'],
  ])('H30 %s cannot be placed, so every ignored package.json keeps its findings', async (_label, specifier) => {
    await commitBase({
      'package.json': pkg('app', { ms: '^2.1.3' }),
      'fixtures/helper/package.json': pkg('helper', {}),
      'fixtures/other/package.json': pkg('other', {}),
      ...ignoreOnly,
    });
    await commitHead({
      'package.json': pkg('app', { ms: '^2.1.3', helper: specifier }),
      'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }),
    });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual([
      'fixtures/helper/package.json',
      'fixtures/other/package.json',
    ]);
  });

  test('H30c the same absolute specifier on the base is the same reason and excuses', async () => {
    await commitBase({
      'package.json': pkg('app', { ms: '^2.1.3', helper: 'file:/opt/elsewhere/helper' }),
      'fixtures/helper/package.json': pkg('helper', {}),
      ...ignoreOnly,
    });
    await commitHead({ 'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test.each([
    ['without a lockfile', false],
    ['with a full npm lockfile', true],
  ])('H31 a file: target reached through a symlinked directory keeps the real manifest\'s findings (%s)', async (_label, withLock) => {
    await commitBase({ 'package.json': pkg('app', { ms: '^2.1.3' }), ...ignoreOnly });
    await writeAll({
      'package.json': pkg('app', { ms: '^2.1.3', helper: 'file:vendor' }),
      'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }),
      ...(withLock
        ? {
            'package-lock.json': npmLock({
              'node_modules/ms': MS,
              vendor: { name: 'helper', version: '1.0.0', dependencies: { lodahs: '^1.0.0' } },
              'node_modules/helper': { resolved: 'vendor', link: true },
              'node_modules/lodahs': LODAHS,
            }),
          }
        : {}),
    });
    await symlink('fixtures/helper', path.join(repo, 'vendor'));
    await commitAll('head');

    const result = await pullRequest();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.some((finding) => finding.manifestPath === 'fixtures/helper/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/helper/package.json']);
  });

  test('H31c a symlinked wiring the base already has keeps ignorePaths', async () => {
    await writeAll({
      'package.json': pkg('app', { ms: '^2.1.3', helper: 'file:vendor' }),
      'fixtures/helper/package.json': pkg('helper', {}),
      ...ignoreOnly,
    });
    await symlink('fixtures/helper', path.join(repo, 'vendor'));
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await commitHead({ 'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('H31o a symlinked target that leaves the repository fails closed over every ignored package.json', async () => {
    await commitBase({
      'package.json': pkg('app', { ms: '^2.1.3' }),
      'fixtures/helper/package.json': pkg('helper', {}),
      ...ignoreOnly,
    });
    await writeAll({
      'package.json': pkg('app', { ms: '^2.1.3', helper: 'file:vendor' }),
      'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }),
    });
    await symlink('../elsewhere/helper', path.join(repo, 'vendor'));
    await commitAll('head');

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/helper/package.json']);
    expect(result.exitCode).toBe(1);
  });

  test.each(PNPM_OR_NONE)('H32 a reference from a newly wired manifest is not excused by a stray\'s identical base reason (%s)', async (_label, lock) => {
    await commitBase({
      'package.json': pkg('app', { ms: '^2.1.3' }),
      'fixtures/a/package.json': pkg('a', { b: 'file:../b' }),
      'fixtures/b/package.json': pkg('b', {}),
      ...ignoreOnly,
      ...lock,
    });
    await commitHead({
      'package.json': pkg('app', { ms: '^2.1.3', a: 'file:fixtures/a' }),
      'fixtures/b/package.json': pkg('b', { lodahs: '^1.0.0' }),
    });

    const result = await pullRequest();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'fixtures/b/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/a/package.json', 'fixtures/b/package.json']);
    expect(diagnostic(result, 'ignore-path-dropped')).not.toContain('on installed projects');
  });

  test('H32d the kept status propagates down a chain of stray references', async () => {
    await commitBase({
      'package.json': pkg('app', { ms: '^2.1.3' }),
      'fixtures/a/package.json': pkg('a', { b: 'file:../b' }),
      'fixtures/b/package.json': pkg('b', { c: 'file:../c' }),
      'fixtures/c/package.json': pkg('c', {}),
      ...ignoreOnly,
    });
    await commitHead({
      'package.json': pkg('app', { ms: '^2.1.3', a: 'file:fixtures/a' }),
      'fixtures/c/package.json': pkg('c', { lodahs: '^1.0.0' }),
    });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual([
      'fixtures/a/package.json',
      'fixtures/b/package.json',
      'fixtures/c/package.json',
    ]);
  });

  test('H32c a reference chain the base already installs keeps ignorePaths', async () => {
    await commitBase({
      'package.json': pkg('app', { ms: '^2.1.3', a: 'file:fixtures/a' }),
      'fixtures/a/package.json': pkg('a', { b: 'file:../b' }),
      'fixtures/b/package.json': pkg('b', {}),
      ...ignoreOnly,
    });
    await commitHead({ 'fixtures/b/package.json': pkg('b', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual([]);
    expect(diagnostic(result, 'ignore-path-dropped')).toContain('on installed projects (fixtures/b/package.json)');
    expect(result.exitCode).toBe(0);
  });

  test('H32y a base-standing reference cycle stays excused', async () => {
    await commitBase({
      'package.json': pkg('app', { ms: '^2.1.3', a: 'file:fixtures/a' }),
      'fixtures/a/package.json': pkg('a', { b: 'file:../b' }),
      'fixtures/b/package.json': pkg('b', { a: 'file:../a' }),
      ...ignoreOnly,
    });
    await commitHead({ 'fixtures/b/package.json': pkg('b', { a: 'file:../a', lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  test('H33 an absolute requirements include fails closed over every ignored requirements file', async () => {
    await commitBase({
      'requirements.txt': 'requests==2.31.0\n',
      'fixtures/requirements-extra.txt': 'requests==2.31.0\n',
      ...ignoreOnly,
    });
    await commitHead({
      'requirements.txt': 'requests==2.31.0\n-r /opt/elsewhere/requirements-extra.txt\n',
      'fixtures/requirements-extra.txt': 'requests==2.31.0\nreqeusts==1.0.0\n',
    });

    const result = await pullRequest();

    expect(result.findings.filter((finding) => finding.packageName === 'reqeusts').length).toBeGreaterThan(0);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/requirements-extra.txt']);
  });

  // Named in reverse so the propagation loop cannot settle in one pass: the
  // reasons map holds x before y (y's manifest is read before z's), so the
  // first pass keeps x excused (its source y still is) and only drops y; x
  // falls only on the second pass.
  test('H32r the kept status propagates down a reverse-named chain that needs a second pass', async () => {
    await commitBase({
      'package.json': pkg('app', { ms: '^2.1.3' }),
      'fixtures/z/package.json': pkg('z', { y: 'file:../y' }),
      'fixtures/y/package.json': pkg('y', { x: 'file:../x' }),
      'fixtures/x/package.json': pkg('x', {}),
      ...ignoreOnly,
    });
    await commitHead({
      'package.json': pkg('app', { ms: '^2.1.3', z: 'file:fixtures/z' }),
      'fixtures/x/package.json': pkg('x', { lodahs: '^1.0.0' }),
    });

    const result = await pullRequest();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'fixtures/x/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual([
      'fixtures/x/package.json',
      'fixtures/y/package.json',
      'fixtures/z/package.json',
    ]);
  });

  // Four levels: the final re-check against the partial set (scan.ts,
  // reasonsMissingFromReference) catches one level the fixed point missed,
  // so only a chain this long fails when the second pass is dropped.
  test('H32r4 the kept status propagates down a four-level reverse-named chain', async () => {
    await commitBase({
      'package.json': pkg('app', { ms: '^2.1.3' }),
      'fixtures/z/package.json': pkg('z', { y: 'file:../y' }),
      'fixtures/y/package.json': pkg('y', { x: 'file:../x' }),
      'fixtures/x/package.json': pkg('x', { w: 'file:../w' }),
      'fixtures/w/package.json': pkg('w', {}),
      ...ignoreOnly,
    });
    await commitHead({
      'package.json': pkg('app', { ms: '^2.1.3', z: 'file:fixtures/z' }),
      'fixtures/w/package.json': pkg('w', { lodahs: '^1.0.0' }),
    });

    const result = await pullRequest();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'fixtures/w/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual([
      'fixtures/w/package.json',
      'fixtures/x/package.json',
      'fixtures/y/package.json',
      'fixtures/z/package.json',
    ]);
  });

  // The re-check's two bypasses: ".." in link or include text after a
  // symlinked segment, and a workspace member reached through a symlink.
  // "sub" links to fixtures/inner, so "sub/.." is fixtures, not the root.
  const DOTDOT_LINKS = async (): Promise<void> => {
    await symlink('fixtures/inner', path.join(repo, 'sub'));
    await symlink('sub/../helper', path.join(repo, 'vendor'));
  };

  test('H35 a link whose text climbs out of a symlinked directory is followed physically', async () => {
    await commitBase({
      'package.json': pkg('app', { ms: '^2.1.3' }),
      'fixtures/inner/package.json': pkg('inner', {}),
      'fixtures/helper/package.json': pkg('helper', {}),
      ...ignoreOnly,
    });
    await writeAll({
      'package.json': pkg('app', { ms: '^2.1.3', helper: 'file:vendor' }),
      'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }),
    });
    await DOTDOT_LINKS();
    await commitAll('head');

    const result = await pullRequest();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'fixtures/helper/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/helper/package.json']);
  });

  test('H35c the same climbing link the base already has keeps ignorePaths', async () => {
    await writeAll({
      'package.json': pkg('app', { ms: '^2.1.3', helper: 'file:vendor' }),
      'fixtures/inner/package.json': pkg('inner', {}),
      'fixtures/helper/package.json': pkg('helper', {}),
      ...ignoreOnly,
    });
    await DOTDOT_LINKS();
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await commitHead({ 'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('H36 a requirements include that climbs out of a symlinked directory is followed physically', async () => {
    await commitBase({
      'requirements.txt': 'requests==2.31.0\n',
      'fixtures/inner/requirements.txt': 'requests==2.31.0\n',
      'fixtures/requirements-extra.txt': 'requests==2.31.0\n',
      ...ignoreOnly,
    });
    await writeAll({
      'requirements.txt': 'requests==2.31.0\n-r sub/../requirements-extra.txt\n',
      'fixtures/requirements-extra.txt': 'requests==2.31.0\nreqeusts==1.0.0\n',
    });
    await symlink('fixtures/inner', path.join(repo, 'sub'));
    await commitAll('head');

    const result = await pullRequest();

    const kept = result.findings.filter((finding) => finding.packageName === 'reqeusts');
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'fixtures/requirements-extra.txt')).toBe(true);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/requirements-extra.txt']);
  });

  const WORKSPACE_INPUTS: Array<[string, Record<string, string>]> = [
    ['the workspaces field', { 'package.json': pkg('app', { ms: '^2.1.3' }, { workspaces: ['packages/*'] }) }],
    [
      'pnpm-workspace.yaml',
      { 'package.json': pkg('app', { ms: '^2.1.3' }), 'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n" },
    ],
  ];

  test.each(WORKSPACE_INPUTS)('H37 a workspace member that is a symlinked directory keeps the real manifest\'s findings (%s)', async (_label, root) => {
    await commitBase({ ...root, 'fixtures/helper/package.json': pkg('helper', {}), ...ignoreOnly });
    await writeAll({ 'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });
    await mkdir(path.join(repo, 'packages'), { recursive: true });
    await symlink('../fixtures/helper', path.join(repo, 'packages/helper'));
    await commitAll('head');

    const result = await pullRequest();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'fixtures/helper/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/helper/package.json']);
  });

  test('H37c a symlinked member the base already has keeps ignorePaths', async () => {
    await writeAll({ ...WORKSPACE_INPUTS[0][1], 'fixtures/helper/package.json': pkg('helper', {}), ...ignoreOnly });
    await mkdir(path.join(repo, 'packages'), { recursive: true });
    await symlink('../fixtures/helper', path.join(repo, 'packages/helper'));
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await commitHead({ 'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('H37o a symlinked member that leaves the repository fails closed over every ignored package.json', async () => {
    await commitBase({
      ...WORKSPACE_INPUTS[0][1],
      'fixtures/helper/package.json': pkg('helper', {}),
      'fixtures/other/package.json': pkg('other', {}),
      ...ignoreOnly,
    });
    await writeAll({ 'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });
    await mkdir(path.join(repo, 'packages'), { recursive: true });
    await symlink('../../elsewhere/helper', path.join(repo, 'packages/helper'));
    await commitAll('head');

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual([
      'fixtures/helper/package.json',
      'fixtures/other/package.json',
    ]);
    expect(diagnostic(result, 'ignore-path-project-kept')).toContain('the symlink packages/helper could not be followed');
    expect(diagnostic(result, 'ignore-path-project-kept')).not.toContain('this change makes it a project');
  });

  test('H37i an install root\'s symlinked member keeps the real manifest\'s findings', async () => {
    await commitBase({
      'package.json': pkg('app', { ms: '^2.1.3' }),
      'apps/package.json': pkg('apps', {}, { workspaces: ['packages/*'] }),
      'apps/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'fixtures/helper/package.json': pkg('helper', {}),
      ...ignoreOnly,
    });
    await writeAll({ 'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });
    await mkdir(path.join(repo, 'apps/packages'), { recursive: true });
    await symlink('../../fixtures/helper', path.join(repo, 'apps/packages/helper'));
    await commitAll('head');

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/helper/package.json']);
  });

  // Since fix round 4 a placeable directory the pattern passes through is
  // mapped rather than failed closed: the manifest the pattern reaches
  // through the link is a member, and a manifest outside it is not.
  test('H38 a workspace pattern that passes through a symlinked directory makes the member behind it a project', async () => {
    await commitBase({
      ...WORKSPACE_INPUTS[0][1],
      'fixtures/pkgs/helper/package.json': pkg('helper', {}),
      'fixtures/other/package.json': pkg('other', {}),
      ...ignoreOnly,
    });
    await writeAll({
      'fixtures/pkgs/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }),
      'fixtures/other/package.json': pkg('other', { lodahs: '^1.0.0' }),
    });
    await symlink('fixtures/pkgs', path.join(repo, 'packages'));
    await commitAll('head');

    const result = await pullRequest();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'fixtures/pkgs/helper/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/pkgs/helper/package.json']);
    expect(diagnostic(result, 'ignore-path-project-kept')).toContain(
      'a root workspace member reached through the symlink packages'
    );
  });

  test('H38c a symlinked workspace directory the base already has keeps ignorePaths', async () => {
    await writeAll({
      ...WORKSPACE_INPUTS[0][1],
      'fixtures/pkgs/helper/package.json': pkg('helper', {}),
      ...ignoreOnly,
    });
    await symlink('fixtures/pkgs', path.join(repo, 'packages'));
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await commitHead({ 'fixtures/pkgs/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  // The second re-check's B-1: a fail-closed symlink reason keyed on the
  // link's path alone let a head that retargets a link the base already
  // has excuse itself. Same path, different link text, is a new reason.
  async function relink(target: string, linkPath: string): Promise<void> {
    await rm(path.join(repo, linkPath), { force: true });
    await mkdir(path.dirname(path.join(repo, linkPath)), { recursive: true });
    await symlink(target, path.join(repo, linkPath));
  }

  test('ZZ1 a head that retargets a pass-through symlinked workspace directory keeps its findings', async () => {
    await writeAll({
      ...WORKSPACE_INPUTS[0][1],
      'fixtures/pkgs/helper/package.json': pkg('helper', {}),
      'fixtures/evil/helper/package.json': pkg('helper', {}),
      ...ignoreOnly,
    });
    await relink('fixtures/pkgs', 'packages');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await relink('fixtures/evil', 'packages');
    await commitHead({ 'fixtures/evil/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
  });

  test('ZZ1n a head that retargets a pass-through symlinked directory to a new directory keeps its findings', async () => {
    await writeAll({
      ...WORKSPACE_INPUTS[0][1],
      'fixtures/pkgs/helper/package.json': pkg('helper', {}),
      ...ignoreOnly,
    });
    await relink('fixtures/pkgs', 'packages');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await relink('fixtures/fresh', 'packages');
    await commitHead({ 'fixtures/fresh/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
  });

  test('ZZ1m a head that retargets a placeable symlinked member keeps its findings', async () => {
    await writeAll({
      ...WORKSPACE_INPUTS[0][1],
      'fixtures/a/package.json': pkg('a', {}),
      'fixtures/b/package.json': pkg('b', {}),
      ...ignoreOnly,
    });
    await relink('../fixtures/a', 'packages/helper');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await relink('../fixtures/b', 'packages/helper');
    await commitHead({ 'fixtures/b/package.json': pkg('b', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'fixtures/b/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  // ZZ2 and ZZ2b: the base's member link is unplaceable, and the head's is
  // a different unplaceable text that the operating system resolves into
  // fixtures/helper (absolute, or out through the checkout's own name).
  test.each([
    ['absolute', (): string => path.join(repo, 'fixtures/helper')],
    ['through the checkout directory name', (): string => `../../${path.basename(repo)}/fixtures/helper`],
  ])('ZZ2 a head that retargets an unplaceable symlinked member keeps its findings (%s)', async (_label, headLink) => {
    await writeAll({
      ...WORKSPACE_INPUTS[0][1],
      'fixtures/helper/package.json': pkg('helper', {}),
      ...ignoreOnly,
    });
    await relink('../../elsewhere/helper', 'packages/helper');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await relink(headLink(), 'packages/helper');
    await commitHead({ 'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
  });

  test('ZZ2c the same unplaceable symlinked member the base already has keeps ignorePaths', async () => {
    await writeAll({
      ...WORKSPACE_INPUTS[0][1],
      'fixtures/helper/package.json': pkg('helper', {}),
      ...ignoreOnly,
    });
    await relink('../../elsewhere/helper', 'packages/helper');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await commitHead({ 'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('ZZ5 a head that retargets a link on an unplaceable file: specifier keeps its findings', async () => {
    await writeAll({
      'package.json': pkg('app', { ms: '^2.1.3', helper: 'file:vendor' }),
      'fixtures/helper/package.json': pkg('helper', {}),
      ...ignoreOnly,
    });
    await relink('../elsewhere/helper', 'vendor');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await relink(path.join(repo, 'fixtures/helper'), 'vendor');
    await commitHead({ 'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
  });

  test('ZZ6 a head that retargets a link on an unplaceable requirements include keeps its findings', async () => {
    await writeAll({
      'requirements.txt': 'requests==2.31.0\n-r vendor/requirements-extra.txt\n',
      'fixtures/requirements-extra.txt': 'requests==2.31.0\n',
      ...ignoreOnly,
    });
    await relink('../elsewhere', 'vendor');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await relink(path.join(repo, 'fixtures'), 'vendor');
    await commitHead({ 'fixtures/requirements-extra.txt': 'requests==2.31.0\nreqeusts==1.0.0\n' });

    const result = await pullRequest();

    expect(result.findings.filter((finding) => finding.packageName === 'reqeusts').length).toBeGreaterThan(0);
  });

  // The scan-side include reader resolves -r and -c targets physically
  // and reads the real path, as the classifier does (pre-existing since
  // 0.13.0: it normalized the text and missed names behind a link).
  const DEPS_LIST = 'reqeusts==1.0.0\n';

  test('ZZ3 an include that climbs out of a symlinked directory is read for names', async () => {
    await commitBase({ 'requirements.txt': 'requests==2.31.0\n' });
    await writeAll({
      'requirements.txt': 'requests==2.31.0\n-r sub/../deps.list\n',
      'lib/inner/keep.txt': 'kept\n',
      'lib/deps.list': DEPS_LIST,
    });
    await symlink('lib/inner', path.join(repo, 'sub'));
    await commitAll('head');

    const result = await pullRequest({ trustBase: null });

    const kept = result.findings.filter((finding) => finding.packageName === 'reqeusts');
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'lib/deps.list')).toBe(true);
  });

  test('ZZ3c an include written as the real path is read for names', async () => {
    await commitBase({ 'requirements.txt': 'requests==2.31.0\n' });
    await commitHead({
      'requirements.txt': 'requests==2.31.0\n-r lib/deps.list\n',
      'lib/deps.list': DEPS_LIST,
    });

    const result = await pullRequest({ trustBase: null });

    expect(result.findings.map((finding) => `${finding.packageName}:${finding.severity}`)).toContain('reqeusts:low');
  });

  // A git side (the index, in a staged scan) has no files under a
  // symlinked directory, so the include is read at its real path.
  test('ZZ3g an include through a symlinked directory is read for names on a git side', async () => {
    await writeAll({ 'requirements.txt': 'requests==2.31.0\n' });
    await commitAll('base');
    await writeAll({
      'requirements.txt': 'requests==2.31.0\n-r sub/deps.list\n',
      'lib/deps.list': DEPS_LIST,
    });
    await symlink('lib', path.join(repo, 'sub'));
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    const kept = result.findings.filter((finding) => finding.packageName === 'reqeusts');
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'lib/deps.list')).toBe(true);
  });

  test('ZZ3w an include through a symlinked directory is read for names on the working tree', async () => {
    await commitBase({ 'requirements.txt': 'requests==2.31.0\n' });
    await writeAll({
      'requirements.txt': 'requests==2.31.0\n-r sub/deps.list\n',
      'lib/deps.list': DEPS_LIST,
    });
    await symlink('lib', path.join(repo, 'sub'));
    await commitAll('head');

    const result = await pullRequest({ trustBase: null });

    expect(result.findings.filter((finding) => finding.packageName === 'reqeusts').length).toBeGreaterThan(0);
  });

  const UV_MEMBERS_ROOT = ['[project]', 'name = "root"', 'version = "0"', '[tool.uv.workspace]', 'members = ["packages/*"]', ''].join(
    '\n'
  );
  const HELPER_PYPROJECT = ['[project]', 'name = "helper"', 'version = "0"', ''].join('\n');

  // A uv member's names come from uv.lock, never from its pyproject.toml
  // (P4 control), so the member position shows as the reason the base does
  // not record, and as a parse failure that is fatal.
  test('H39 a uv workspace member that is a symlinked directory is a member at its real path', async () => {
    await commitBase({
      'pyproject.toml': UV_MEMBERS_ROOT,
      'uv.lock': UV_LOCK,
      'fixtures/helper/pyproject.toml': HELPER_PYPROJECT,
      ...ignoreOnly,
    });
    await mkdir(path.join(repo, 'packages'), { recursive: true });
    await symlink('../fixtures/helper', path.join(repo, 'packages/helper'));
    await commitAll('head');

    const result = await pullRequest();

    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/helper/pyproject.toml']);
  });

  test('H39p an ignored symlinked uv member that is not TOML exits 2', async () => {
    await ignore('fixtures');
    await write('pyproject.toml', UV_MEMBERS_ROOT);
    await write('uv.lock', UV_LOCK);
    await write('fixtures/helper/pyproject.toml', BROKEN_PYPROJECT);
    await mkdir(path.join(repo, 'packages'), { recursive: true });
    await symlink('../fixtures/helper', path.join(repo, 'packages/helper'));

    const error = await auditError();

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('fixtures/helper/pyproject.toml');
    expect(error.message).toContain('a uv workspace member');
  });

  test('H39b a uv members pattern that passes through a symlinked directory makes the member behind it a project', async () => {
    await commitBase({
      'pyproject.toml': UV_MEMBERS_ROOT,
      'uv.lock': UV_LOCK,
      'fixtures/pkgs/helper/pyproject.toml': HELPER_PYPROJECT,
      ...ignoreOnly,
    });
    await symlink('fixtures/pkgs', path.join(repo, 'packages'));
    await commitAll('head');

    const result = await pullRequest();

    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/pkgs/helper/pyproject.toml']);
  });

  // Fix round 4. A placeable symlinked directory a pattern covers or
  // passes through is mapped: each manifest under its real directory is a
  // member exactly when the pattern covers its path through the link, with
  // the path through the link, the pattern and the link texts in the
  // reason. B4: a widened pattern through a link the base already has is
  // a new reason, as it is without the link. FK1: a placeable link says
  // nothing about a manifest outside it.
  const B4_INPUTS: Array<[string, (pattern: string) => Record<string, string>]> = [
    ['the workspaces field', (pattern) => ({ 'package.json': pkg('app', { ms: '^2.1.3' }, { workspaces: [pattern] }) })],
    [
      'pnpm-workspace.yaml',
      (pattern) => ({ 'package.json': pkg('app', { ms: '^2.1.3' }), 'pnpm-workspace.yaml': `packages:\n  - '${pattern}'\n` }),
    ],
  ];

  test.each(B4_INPUTS)('B4 a pattern widened through a symlinked directory the base already has keeps its findings (%s)', async (_label, root) => {
    await writeAll({ ...root('packages/*'), 'fixtures/pkgs/deep/inner/package.json': pkg('inner', {}), ...ignoreOnly });
    await relink('fixtures/pkgs', 'packages');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await commitHead({ ...root('packages/*/*'), 'fixtures/pkgs/deep/inner/package.json': pkg('inner', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'fixtures/pkgs/deep/inner/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/pkgs/deep/inner/package.json']);
    expect(diagnostic(result, 'ignore-path-project-kept')).toContain('reached through the symlink packages');
  });

  // The covering pattern is part of the reason through a link as it is
  // for a listed member (H8): an inexact pattern whose text changes is a
  // new reason even where both texts cover the path. As in H8, the pattern
  // sits under a yarn install root, whose patterns this tool does not
  // discover from, so the inexact text does not stop the run.
  const B4I_ROOT = (pattern: string): Record<string, string> => ({
    'package.json': pkg('app', { ms: '^2.1.3' }),
    'sub/package.json': pkg('sub', {}, { workspaces: [pattern] }),
    'sub/yarn.lock': '# yarn lockfile v1\n',
  });

  test('B4i an inexact pattern through a symlinked directory whose text changes is a new reason', async () => {
    await writeAll({ ...B4I_ROOT('packages/{a,x}'), 'fixtures/pkgs/x/package.json': pkg('x', {}), ...ignoreOnly });
    await relink('../fixtures/pkgs', 'sub/packages');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await commitHead({ ...B4I_ROOT('packages/{b,x}'), 'fixtures/pkgs/x/package.json': pkg('x', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/pkgs/x/package.json']);
  });

  test('B4u a uv members pattern widened through a symlinked directory the base already has is a new reason', async () => {
    const uvRoot = (pattern: string): string => UV_MEMBERS_ROOT.replace('packages/*', pattern);
    await writeAll({
      'pyproject.toml': uvRoot('packages/*'),
      'uv.lock': UV_LOCK,
      'fixtures/pkgs/deep/inner/pyproject.toml': HELPER_PYPROJECT,
      ...ignoreOnly,
    });
    await relink('fixtures/pkgs', 'packages');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await commitHead({ 'pyproject.toml': uvRoot('packages/*/*') });

    const result = await pullRequest();

    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/pkgs/deep/inner/pyproject.toml']);
  });

  const FK1_BASE: Record<string, string> = {
    'package.json': pkg('app', { ms: '^2.1.3' }),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/**'\n",
    'packages/a/package.json': pkg('a', {}),
    ...ignoreOnly,
  };

  test.each([
    ['a directory symlink', { 'packages/a/real/.gitkeep': '' }, 'real', 'packages/a/link'],
    ['a file symlink', { 'packages/a/real.txt': 'text\n' }, 'real.txt', 'packages/a/link.txt'],
  ])('FK1 a placeable symlink under a pattern does not make a new stray outside it a project (%s)', async (_label, extra, target, linkPath) => {
    await writeAll({ ...FK1_BASE, ...extra });
    await relink(target, linkPath);
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await commitHead({ 'fixtures/x/package.json': pkg('x', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('FK1c a new manifest the pattern reaches only through a placeable link is kept, and a stray beside it is not', async () => {
    await writeAll({ ...FK1_BASE, 'fixtures/real/.gitkeep': '' });
    await relink('../../fixtures/real', 'packages/a/link');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await commitHead({
      'fixtures/real/x/package.json': pkg('x', { lodahs: '^1.0.0' }),
      'fixtures/other/package.json': pkg('other', { lodahs: '^1.0.0' }),
    });

    const result = await pullRequest();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'fixtures/real/x/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/real/x/package.json']);
    expect(diagnostic(result, 'ignore-path-project-kept')).toContain(
      'a root workspace member reached through the symlink packages/a/link'
    );
  });

  // TB1 and TB2: a link nested under a symlinked workspace directory is
  // followed at its path through the outer link, with both link texts in
  // the reason.
  const TB_BASE: Record<string, string> = {
    ...WORKSPACE_INPUTS[0][1],
    'fixtures/a/helper/package.json': pkg('helper', {}),
    'fixtures/evil/helper/package.json': pkg('helper', {}),
    'fixtures/other/package.json': pkg('other', {}),
    ...ignoreOnly,
  };

  test('TB1 a head that retargets a link nested under a symlinked workspace directory keeps its findings', async () => {
    await writeAll(TB_BASE);
    await relink('fixtures/pkgs', 'packages');
    await relink('../a/helper', 'fixtures/pkgs/helper');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await relink('../evil/helper', 'fixtures/pkgs/helper');
    await commitHead({ 'fixtures/evil/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'fixtures/evil/helper/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/evil/helper/package.json']);
  });

  test('TB2 an unchanged nested link chain still excuses a manifest change behind it and beside it', async () => {
    await writeAll(TB_BASE);
    await relink('fixtures/pkgs', 'packages');
    await relink('../a/helper', 'fixtures/pkgs/helper');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await commitHead({
      'fixtures/a/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }),
      'fixtures/other/package.json': pkg('other', { lodahs: '^1.0.0' }),
    });

    const result = await pullRequest();

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('U5 a pattern widened past an unplaceable symlinked member keeps its findings', async () => {
    await writeAll({ ...WORKSPACE_INPUTS[0][1], 'fixtures/helper/package.json': pkg('helper', {}), ...ignoreOnly });
    await relink('../../elsewhere/helper', 'packages/out');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await commitHead({
      'package.json': pkg('app', { ms: '^2.1.3' }, { workspaces: ['packages/*', 'packages/*/*'] }),
      'fixtures/helper/package.json': pkg('helper', { lodahs: '^1.0.0' }),
    });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(diagnostic(result, 'ignore-path-project-kept')).toContain('the symlink packages/out could not be followed');
  });

  // Fix round 5. RC1: a base whose links already fan out past the visit
  // limit must not excuse a head that retargets a link the walk never
  // reached; the limit's reason carries the side's serial and excuses
  // nothing. RC1c is the same retarget without the fan-out.
  test('RC1 a retarget past the symlink fan-out limit keeps its findings', async () => {
    const files: Record<string, string> = {
      'package.json': pkg('app', { ms: '^2.1.3' }, { workspaces: ['packages/**'] }),
      'fixtures/a/package.json': pkg('a', {}),
      'fixtures/evil/package.json': pkg('evil', {}),
      ...ignoreOnly,
    };
    for (let i = 0; i <= 15; i += 1) {
      files[`fan/L${i}/.gitkeep`] = '';
    }
    await writeAll(files);
    await relink('../fan/L0', 'packages/start');
    for (let i = 0; i < 15; i += 1) {
      await relink(`../L${i + 1}`, `fan/L${i}/x`);
      await relink(`../L${i + 1}`, `fan/L${i}/y`);
    }
    await relink('../fixtures/a', 'packages/z');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await relink('../fixtures/evil', 'packages/z');
    await commitHead({ 'fixtures/evil/package.json': pkg('evil', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'fixtures/evil/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
    // Past the limit every ignored manifest of the kind counts on each
    // side, and no side excuses the other's, so the unchanged one is
    // listed too; only the changed one has findings to keep.
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/a/package.json', 'fixtures/evil/package.json']);
    expect(diagnostic(result, 'ignore-path-project-kept')).toContain(
      'the symlinks under packages/start fan out past the limit of 10000'
    );
  }, 60_000);

  test('RC1c the same retarget of a symlinked member with no fan-out keeps its findings', async () => {
    await writeAll({
      'package.json': pkg('app', { ms: '^2.1.3' }, { workspaces: ['packages/**'] }),
      'fixtures/a/package.json': pkg('a', {}),
      'fixtures/evil/package.json': pkg('evil', {}),
      ...ignoreOnly,
    });
    await relink('../fixtures/a', 'packages/z');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await relink('../fixtures/evil', 'packages/z');
    await commitHead({ 'fixtures/evil/package.json': pkg('evil', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/evil/package.json']);
  });

  // RC2: a link that loops back into a directory already on its path fails
  // closed. A self-link under ** therefore puts the reason on every
  // manifest of that kind, and a new ignored stray outside the patterns is
  // kept: a known, accepted over-keep, pinned here so a walk that skips the
  // loop instead of failing closed turns this red.
  test('RC2 a self-link under ** fails closed, so a new ignored stray outside the patterns is kept', async () => {
    await writeAll({
      'package.json': pkg('app', { ms: '^2.1.3' }),
      'pnpm-workspace.yaml': "packages:\n  - 'packages/**'\n",
      'packages/a/package.json': pkg('a', {}),
      ...ignoreOnly,
    });
    await relink('.', 'packages/a/self');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await commitHead({ 'fixtures/x/package.json': pkg('x', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/x/package.json']);
    expect(diagnostic(result, 'ignore-path-project-kept')).toContain(
      'following the symlink packages/a/self/self loops back into a directory already on its path'
    );
  });

  // RC2b: a two-link loop on both sides, with one link retargeted on the
  // head so the loop runs through another directory. The loop's reason
  // carries every link text read, so the head's is new, and the ignored
  // manifest the change touches is kept.
  test('RC2b a retargeted link in a two-link loop keeps its findings', async () => {
    await writeAll({
      'package.json': pkg('app', { ms: '^2.1.3' }, { workspaces: ['packages/**'] }),
      'packages/a/package.json': pkg('a', {}),
      'packages/b/package.json': pkg('b', {}),
      'packages/c/package.json': pkg('c', {}),
      'fixtures/x/package.json': pkg('x', {}),
      ...ignoreOnly,
    });
    await relink('../b', 'packages/a/l');
    await relink('../a', 'packages/b/l');
    await relink('../a', 'packages/c/l');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await relink('../c', 'packages/b/l');
    await commitHead({ 'fixtures/x/package.json': pkg('x', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/x/package.json']);
    expect(diagnostic(result, 'ignore-path-project-kept')).toContain('loops back into a directory already on its path');
  });

  test('RC2c an unchanged two-link loop the base already has still excuses a manifest change', async () => {
    await writeAll({
      'package.json': pkg('app', { ms: '^2.1.3' }, { workspaces: ['packages/**'] }),
      'packages/a/package.json': pkg('a', {}),
      'packages/b/package.json': pkg('b', {}),
      'fixtures/x/package.json': pkg('x', {}),
      ...ignoreOnly,
    });
    await relink('../b', 'packages/a/l');
    await relink('../a', 'packages/b/l');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await commitHead({ 'fixtures/x/package.json': pkg('x', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  // Fix round 6. A fail-closed symlink, local target or include reason
  // stands in for promotion: every manifest it lands on is read past the
  // skipped-directory-name filter, so a member under build/ that the walk
  // could not place is still read for names. Staged mode, where the judged
  // side is the index and the workspace walk does not follow the link.
  const stagedScan = () => scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

  async function writeFanOut(top: string): Promise<void> {
    const files: Record<string, string> = {};
    for (let i = 0; i <= 15; i += 1) {
      files[`fan/L${i}/.gitkeep`] = '';
    }
    await writeAll(files);
    await relink('../fan/L0', top);
    for (let i = 0; i < 15; i += 1) {
      await relink(`../L${i + 1}`, `fan/L${i}/x`);
      await relink(`../L${i + 1}`, `fan/L${i}/y`);
    }
  }

  async function stageLodahsUnderBuild(relPath = 'build/a/package.json'): Promise<void> {
    await commitAll('base');
    await write(relPath, pkg('a', { lodahs: '^1.0.0' }));
    await git('add', '-A');
  }

  const TMPX7_BASE: Record<string, string> = {
    'package.json': pkg('app', { ms: '^2.1.3' }, { workspaces: ['packages/**'] }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
    'build/a/package.json': pkg('a', {}),
  };

  test('TMPX7 a fan-out under one input does not drop a member another input reaches under build/', async () => {
    await writeAll(TMPX7_BASE);
    await writeFanOut('packages/start');
    await relink('../build/a', 'apps/z');
    await stageLodahsUnderBuild();

    const result = await stagedScan();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'build/a/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
  }, 60_000);

  test('TMPX7c the same member with no fan-out keeps its findings', async () => {
    await writeAll(TMPX7_BASE);
    await relink('../build/a', 'apps/z');
    await stageLodahsUnderBuild();

    const result = await stagedScan();

    expect(lodahsFindings(result).length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
  });

  // TMPX7p: the visit budget is per input, so the apps/* input still walks
  // apps/z and gives build/a/package.json its root-member position. A
  // shared budget would leave it only the fan-out stand-in, which has no
  // position, and ignorePaths would then drop the broken file.
  test('TMPX7p past another input\'s fan-out the member keeps its position, so a broken one stops the scan', async () => {
    await writeAll({ ...TMPX7_BASE, '.dep-guard.json': JSON.stringify({ ignorePaths: ['build'] }) });
    await writeFanOut('packages/start');
    await relink('../build/a', 'apps/z');
    await commitAll('base');
    await write('build/a/package.json', '{"name": "a", "pnpm": "x", "dependencies": {"lodahs": "^1.0.0"}}');
    await git('add', '-A');

    const error = await scanError(stagedScan);

    expect(error.code).toBe('manifest-parse');
    expect(error.message).toContain('build/a/package.json (judged side)');
    expect(error.message).toContain('is a project and stops the scan whatever ignorePaths says');
  }, 60_000);

  test('TMPX6 a fan-out under the same input does not drop a member under build/', async () => {
    await writeAll({
      'package.json': pkg('app', { ms: '^2.1.3' }, { workspaces: ['packages/**'] }),
      'build/a/package.json': pkg('a', {}),
    });
    await writeFanOut('packages/start');
    await relink('../build/a', 'packages/z');
    await stageLodahsUnderBuild();

    const result = await stagedScan();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'build/a/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
  }, 60_000);

  // N1: each input has its own budget, so the fan-out reason of each names
  // the link under which that input's own walk ran out.
  test('N1 each input\'s fan-out reason names its own link', async () => {
    await writeAll({
      'package.json': pkg('app', { ms: '^2.1.3' }, { workspaces: ['packages/**'] }),
      'pnpm-workspace.yaml': "packages:\n  - 'apps/**'\n",
      ...ignoreOnly,
    });
    await writeFanOut('packages/start');
    await relink('../fan/L0', 'apps/start');
    await commitAll('base');
    await git('checkout', '-q', '-b', 'pr');
    await commitHead({ 'fixtures/x/package.json': pkg('x', { lodahs: '^1.0.0' }) });

    const result = await pullRequest();

    expect(result.exitCode).toBe(1);
    const kept = diagnostic(result, 'ignore-path-project-kept');
    expect(kept).toContain('the symlinks under packages/start fan out past the limit of 10000');
    expect(kept).toContain('the symlinks under apps/start fan out past the limit of 10000');
  }, 60_000);

  // TMPX8: a symlinked member the walk cannot place (an absolute link, or
  // one that climbs out and back in through the checkout's own name).
  test.each([
    ['an absolute link', () => path.join(repo, 'build', 'a')],
    ['a link out and back in through the checkout name', () => `../../${path.basename(repo)}/build/a`],
  ])('TMPX8 %s to a member under build/ does not drop it', async (_label, target) => {
    await writeAll({
      'package.json': pkg('app', { ms: '^2.1.3' }, { workspaces: ['packages/*'] }),
      'build/a/package.json': pkg('a', {}),
    });
    await relink(target(), 'packages/z');
    await stageLodahsUnderBuild();

    const result = await stagedScan();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'build/a/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  // TMPX8c: build/a is a member only at packages/l/self/a, past the loop
  // build/self -> build, where the walk fails closed.
  test('TMPX8c a member under build/ reached only past a link loop is not dropped', async () => {
    await writeAll({
      'package.json': pkg('app', { ms: '^2.1.3' }, { workspaces: ['packages/*/*/*'] }),
      'build/a/package.json': pkg('a', {}),
    });
    await relink('../build', 'packages/l');
    await relink('.', 'build/self');
    await stageLodahsUnderBuild();

    const result = await stagedScan();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'build/a/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  // TMPX9: rule 5 and the requirements include fall back the same way.
  test('TMPX9 a file: target under build/ the tool cannot place is not dropped', async () => {
    await writeAll({
      'package.json': pkg('app', { ms: '^2.1.3', a: `file:../${path.basename(repo)}/build/a` }),
      'build/a/package.json': pkg('a', {}),
    });
    await stageLodahsUnderBuild();

    const result = await stagedScan();

    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'build/a/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  test('TMPX9r a requirements include under build/ the tool cannot place is not dropped', async () => {
    await writeAll({
      'requirements.txt': `requests==2.31.0\n-r ../${path.basename(repo)}/build/requirements.txt\n`,
      'build/requirements.txt': 'requests==2.31.0\n',
    });
    await commitAll('base');
    await write('build/requirements.txt', 'requests==2.31.0\nreqeusts==1.0.0\n');
    await git('add', '-A');

    const result = await stagedScan();

    const kept = result.findings.filter((finding) => finding.packageName === 'reqeusts');
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'build/requirements.txt')).toBe(true);
  });

  // TMPX10: the stand-in gives no position. A broken manifest under build/
  // that it reads is judged as one outside a skipped name would be: covered
  // by ignorePaths it is dropped with manifest-unparsed; not covered, it
  // stops the scan with the ordinary advice, never "whatever ignorePaths
  // says".
  test.each([
    ['covered by ignorePaths', true],
    ['not covered by ignorePaths', false],
  ])('TMPX10 a fail-closed link and an unrelated broken manifest under build/ (%s)', async (_label, covered) => {
    await writeAll({
      'package.json': pkg('app', { ms: '^2.1.3' }, { workspaces: ['packages/*'] }),
      'build/a/package.json': pkg('a', {}),
      ...(covered ? { '.dep-guard.json': JSON.stringify({ ignorePaths: ['build/other'] }) } : {}),
    });
    await relink(path.join(repo, 'build', 'a'), 'packages/z');
    await commitAll('base');
    await write('build/other/package.json', BROKEN_PACKAGE_JSON);
    await git('add', '-A');

    if (covered) {
      const result = await stagedScan();
      expect(result.exitCode).toBe(0);
      expect(diagnostic(result, 'manifest-unparsed')).toBe('build/other/package.json: not parsed; covered by ignorePaths');
    } else {
      const error = await scanError(stagedScan);
      expect(error.code).toBe('manifest-parse');
      expect(error.message).toContain('build/other/package.json (judged side)');
      expect(error.message).toContain('fix the file, or cover it with ignorePaths on the base branch');
      expect(error.message).not.toContain('whatever ignorePaths says');
    }
  });

  // Fix round 7. A subdirectory scan whose side has a classification input
  // outside the prefix that could not be read says every manifest under the
  // prefix was treated as a project; the read gate makes that true, so a
  // manifest under build/ inside the prefix is read for names. Pre-existing
  // since 0.15.0: the scan exited 0 with lodahs dropped.
  const SD_INPUTS: ReadonlyArray<[string, Record<string, string>]> = [
    ['a broken root pnpm-workspace.yaml', { 'pnpm-workspace.yaml': "packages: ['app/build/*'\n  - [\n" }],
    ['a broken root package-lock.json', { 'package-lock.json': '{ nope' }],
  ];
  const SD_TREE: Record<string, string> = {
    'package.json': pkg('root', {}),
    'app/package.json': pkg('app', {}),
    'app/build/a/package.json': pkg('a', {}),
  };
  const appScan = (kind: 'staged' | 'audit') =>
    scan({ repoRoot: path.join(repo, 'app'), mode: { kind }, corpusDir: FIXTURE_CORPUS });

  describe.each(SD_INPUTS)('SD1 a subdirectory scan with %s outside it', (_label, broken) => {
    test.each([['staged' as const], ['audit' as const]])('reads a manifest under build/ for names (%s)', async (kind) => {
      await writeAll({ ...SD_TREE, ...broken });
      await stageLodahsUnderBuild('app/build/a/package.json');

      const result = await appScan(kind);

      const kept = lodahsFindings(result);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.every((finding) => finding.manifestPath === 'app/build/a/package.json')).toBe(true);
      expect(codes(result)).toContain('classification-input-unread');
      expect(codes(result)).not.toContain('manifest-skipped-dirname');
      expect(result.exitCode).toBe(1);
    });

    test('reads a manifest under build/ for names on the working tree under --base', async () => {
      await commitBase({ ...SD_TREE, ...broken });
      await commitHead({ 'app/build/a/package.json': pkg('a', { lodahs: '^1.0.0' }) });

      const result = await pullRequest({ trustBase: null, repoRoot: path.join(repo, 'app') });

      const kept = lodahsFindings(result);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.every((finding) => finding.manifestPath === 'app/build/a/package.json')).toBe(true);
      expect(codes(result)).not.toContain('manifest-skipped-dirname');
      expect(result.exitCode).toBe(1);
    });
  });

  // SD1n: the stand-in covers the prefix outside node_modules only. A
  // committed node_modules manifest under the prefix is a dependency's file
  // and stays unread for names whatever the unread input.
  test('SD1n a subdirectory scan with an unread input still does not read under node_modules', async () => {
    await writeAll({ ...SD_TREE, 'package-lock.json': '{ nope', 'app/node_modules/x/package.json': pkg('x', {}) });
    await stageLodahsUnderBuild('app/node_modules/x/package.json');

    const result = await appScan('staged');

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(codes(result)).toContain('classification-input-unread');
  });

  // SD1c: with every input readable the diagnostic is not raised and the
  // read gate is unchanged: a stray under build/ is skipped as before.
  test('SD1c control: a subdirectory scan with every input readable still skips build/', async () => {
    await writeAll({
      ...SD_TREE,
      'pnpm-workspace.yaml': "packages:\n  - 'libs/*'\n",
      'package-lock.json': npmLock({}),
    });
    await stageLodahsUnderBuild('app/build/a/package.json');

    const result = await appScan('staged');

    expect(lodahsFindings(result)).toHaveLength(0);
    expect(codes(result)).not.toContain('classification-input-unread');
    expect(diagnostic(result, 'manifest-skipped-dirname')).toContain('app/build/a/package.json: not scanned');
    expect(result.exitCode).toBe(0);
  });

  // SC1: the side-wide visit limit. Ten install roots r00 to r09 each run
  // their own walk to the per-input limit of 10000 visits, reaching the
  // side-wide limit of 100000 together; r10's walk, which would map
  // r10/z -> ../build/a as a member, then fails closed at its first visit
  // with the never-excusable fan-out key, and stands in for the promotion,
  // so build/a is still read for names.
  test('SC1 past the side-wide visit limit a later input fails closed and still reads its member for names', async () => {
    const files: Record<string, string> = { 'package.json': pkg('root', {}), 'build/a/package.json': pkg('a', {}) };
    for (let i = 0; i < 10; i += 1) {
      const dir = `r0${i}`;
      files[`${dir}/package.json`] = pkg(dir, {}, { workspaces: ['start/**'] });
      files[`${dir}/package-lock.json`] = npmLock({});
    }
    files['r10/package.json'] = pkg('r10', {}, { workspaces: ['z'] });
    files['r10/package-lock.json'] = npmLock({});
    await writeAll(files);
    await writeFanOut('r00/start');
    for (let i = 1; i < 10; i += 1) {
      await relink('../fan/L0', `r0${i}/start`);
    }
    await relink('../build/a', 'r10/z');
    await stageLodahsUnderBuild();

    const states = await loadStates(repo, { kind: 'staged' });
    const reasons = states.after.projects?.reasons.get('build/a/package.json') ?? [];
    const fromR10 = reasons.filter((reason) => reason.root === 'r10');
    expect(fromR10.map((reason) => reason.link?.cause)).toEqual(['side-fan-out']);
    expect(fromR10[0]?.pattern?.startsWith('["symlink-fan-out",')).toBe(true);
    expect(projectReasonText(fromR10[0]!)).toBe(
      "possibly a member named by a nested install root's workspace patterns: the symlink walks on this side ran " +
        'past the limit of 100000 visits in all before the symlink r10/z, so every manifest of this kind on this side counts'
    );
    expect(reasons.filter((reason) => reason.root === 'r00').map((reason) => reason.link?.cause)).toEqual(['fan-out']);

    const result = await stagedScan();
    const kept = lodahsFindings(result);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((finding) => finding.manifestPath === 'build/a/package.json')).toBe(true);
    expect(result.exitCode).toBe(1);
  }, 120_000);

  test('H34 the rule is recorded as applied only on a run with a reference side', async () => {
    await writeAll({ 'package.json': pkg('app', { ms: '^2.1.3' }), ...ignoreOnly });
    await git('add', '-A');

    const unborn = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });
    expect(unborn.ignoreRuleApplied).toBe(false);

    await commitAll('base');
    const staged = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });
    const audited = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
    expect(staged.ignoreRuleApplied).toBe(true);
    expect(audited.ignoreRuleApplied).toBe(false);
  });
});
