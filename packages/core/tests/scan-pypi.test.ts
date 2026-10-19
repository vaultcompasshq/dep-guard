// The PyPI existence check end to end, through scan(), against fake PyPI
// and npm clients (never the real network: pnpm test stays offline). One
// test per fail-closed or degrade path in the design
// (docs/design/2026-10-17-python-name-checks-pypi.md, section 10).
//
// Both clients are substituted with jest.unstable_mockModule, for the
// reason scan-online.test.ts gives: a real ESM namespace cannot be spied
// on, so the module is replaced in Jest's registry before scan.ts is
// imported.
import { jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { scan as ScanFn } from '../src/scan.js';
import type { fetchPackument, fetchWeeklyDownloads } from '../src/online/registry-client.js';
import type { fetchPypiProject } from '../src/online/pypi-client.js';
import { renderNamesLine, renderText } from '../../cli/src/output-text.js';
import { renderSarif } from '../../cli/src/output-sarif.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CORPUS = path.join(__dirname, '..', 'fixtures', 'corpus');

const fetchPypiProjectMock: jest.MockedFunction<typeof fetchPypiProject> = jest.fn();
const fetchPackumentMock: jest.MockedFunction<typeof fetchPackument> = jest.fn();
const fetchWeeklyDownloadsMock: jest.MockedFunction<typeof fetchWeeklyDownloads> = jest.fn();

jest.unstable_mockModule('../src/online/pypi-client.js', () => ({
  fetchPypiProject: fetchPypiProjectMock,
  PYPI_JSON_API: 'https://pypi.org/pypi',
}));
jest.unstable_mockModule('../src/online/registry-client.js', () => ({
  fetchWeeklyDownloads: fetchWeeklyDownloadsMock,
  fetchPackument: fetchPackumentMock,
  DEFAULT_REGISTRY: 'https://registry.npmjs.org',
}));

let scan: typeof ScanFn;

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'depguard-scan-pypi-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
}

function remove(dir: string, rel: string): void {
  rmSync(path.join(dir, rel), { force: true, recursive: true });
}

function commit(dir: string, message = 'update'): void {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', message], { cwd: dir });
}

function tag(dir: string, name: string): void {
  execFileSync('git', ['tag', name], { cwd: dir });
}

function lookedUp(): string[] {
  return fetchPypiProjectMock.mock.calls.map(([name]) => name);
}

async function audit(dir: string, extra: Partial<Parameters<typeof ScanFn>[0]> = {}) {
  return scan({ repoRoot: dir, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS, online: true, ...extra });
}

function codes(result: Awaited<ReturnType<typeof ScanFn>>, code: string): string[] {
  return result.run.diagnostics.filter((entry) => entry.code === code).map((entry) => entry.message);
}

function pythonFindings(result: Awaited<ReturnType<typeof ScanFn>>) {
  return result.findings.filter((finding) => finding.details?.ecosystem === 'pypi');
}

beforeEach(async () => {
  fetchPypiProjectMock.mockReset();
  fetchPackumentMock.mockReset();
  fetchWeeklyDownloadsMock.mockReset();
  fetchPypiProjectMock.mockResolvedValue('exists');
  fetchPackumentMock.mockResolvedValue(null);
  fetchWeeklyDownloadsMock.mockResolvedValue({ counts: new Map(), noRecord: new Set() });
  process.env.XDG_CACHE_HOME = mkdtempSync(path.join(tmpdir(), 'depguard-pypi-cache-'));
  jest.resetModules();
  ({ scan } = await import('../src/scan.js'));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('budget and step order', () => {
  test('budget exhausted mid-ecosystem: two lookups, three named, exit from findings only, 2 of 5', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'elder\ndamson\ncherry\nbanana\napple\n');
    commit(dir);
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    fetchPypiProjectMock.mockImplementation(async () => {
      now += 600;
      return 'exists';
    });

    const result = await audit(dir, { onlineBudgetMs: 1_000 });

    expect(lookedUp()).toEqual(['apple', 'banana']);
    expect(pythonFindings(result)).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.run.online.lookupsSkippedByDeadline).toBe(3);
    const note = codes(result, 'online-deadline-exceeded').find((message) => message.startsWith('pypi existence'));
    expect(note).toContain('cherry, damson, elder');
    expect(result.run.ecosystems.pypi).toEqual(
      expect.objectContaining({ candidates: 5, existenceChecked: 2, notChecked: expect.objectContaining({ budget: 3 }) })
    );
    expect(renderNamesLine(result)).toContain('pypi 2 of 5 checked for existence (PyPI); 3 not checked: 3 online budget spent');
  });

  test('npm step 1 spends the whole budget: the PyPI step fetches nothing and names every Python name', async () => {
    const dir = initRepo();
    write(dir, 'package.json', JSON.stringify({ name: 'x', dependencies: { 'some-unknown-thing': '^1.0.0' } }));
    write(dir, 'requirements.txt', 'flask\nrequests\n');
    commit(dir);
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    fetchPackumentMock.mockImplementation(async () => {
      now += 5_000;
      return null;
    });

    const result = await audit(dir, { onlineBudgetMs: 1_000 });

    expect(fetchPypiProjectMock).not.toHaveBeenCalled();
    const note = codes(result, 'online-deadline-exceeded').find((message) => message.startsWith('pypi existence'));
    expect(note).toContain('flask, requests');
    expect(note).toContain('before 2 lookup(s)');
  });

  test('step order: PyPI runs after npm unknown-package resolution and before asymmetry', async () => {
    const dir = initRepo();
    write(dir, 'package.json', JSON.stringify({ name: 'x', dependencies: { 'some-unknown-thing': '^1.0.0', raect: '^1.0.0' } }));
    write(dir, 'requirements.txt', 'flask\n');
    commit(dir);
    const order: string[] = [];
    fetchPackumentMock.mockImplementation(async (name) => {
      order.push(`npm-registry:${name}`);
      return null;
    });
    fetchPypiProjectMock.mockImplementation(async (name) => {
      order.push(`pypi:${name}`);
      return 'exists';
    });
    fetchWeeklyDownloadsMock.mockImplementation(async (names) => {
      order.push(`npm-downloads:${names.join(',')}`);
      return { counts: new Map(), noRecord: new Set() };
    });

    await audit(dir);

    // Step 1 asks the registry about both corpus misses, then step 2 asks
    // PyPI, then step 3 asks the downloads API.
    const pypiAt = order.indexOf('pypi:flask');
    expect(pypiAt).toBeGreaterThan(0);
    expect(order.slice(0, pypiAt).sort()).toEqual(['npm-registry:raect', 'npm-registry:some-unknown-thing']);
    expect(order[pypiAt + 1]).toMatch(/^npm-downloads:/);
  });
});

describe('degrade paths', () => {
  test('PyPI 5xx: no finding, online-check-unreachable naming pypi existence, exit 0', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'reqeusts\n');
    commit(dir);
    fetchPypiProjectMock.mockRejectedValue(new Error('giving up after 2 attempt(s): request failed: 503'));

    const result = await audit(dir);

    expect(pythonFindings(result)).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(codes(result, 'online-check-unreachable')).toEqual([expect.stringContaining('pypi existence')]);
    expect(result.run.ecosystems.pypi.notChecked.unreachable).toBe(1);
  });

  test('normalised exists, written does not: one fetch, to the normalised name, no finding', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'Python_Dateutil==2.9\n');
    commit(dir);
    fetchPypiProjectMock.mockImplementation(async (name) => (name === 'python-dateutil' ? 'exists' : 'absent'));

    const result = await audit(dir);

    expect(lookedUp()).toEqual(['python-dateutil']);
    expect(pythonFindings(result)).toEqual([]);
  });

  test('editable, URL, VCS and path lines are never looked up, and each is counted', async () => {
    const dir = initRepo();
    write(
      dir,
      'requirements.txt',
      [
        '-e .',
        '-e git+https://example.com/r.git#egg=editgit',
        'https://example.com/pkg/urlpkg-1.0.tar.gz',
        'vcsname @ git+https://example.com/v.git',
        './vendor/pathpkg',
        'pathwheel-1.0-py3-none-any.whl',
        'flask',
        '',
      ].join('\n')
    );
    commit(dir);

    const result = await audit(dir);

    expect(lookedUp()).toEqual(['flask']);
    expect(result.run.ecosystems.pypi.excluded).toEqual(
      expect.objectContaining({ editable: 2, url: 1, vcs: 1, path: 2 })
    );
  });

  test('a cache never serves PyPI existence: two scans in one process both fetch', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'flask\n');
    commit(dir);

    await audit(dir);
    await audit(dir);

    expect(lookedUp()).toEqual(['flask', 'flask']);
  });

  test('a Python name never leaves for npm, nor does a Python resemblance', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'flask\n');
    commit(dir);
    tag(dir, 'base');
    write(dir, 'requirements.txt', 'flask\nflaks\nreqeusts\n');
    commit(dir);

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'base' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    expect(result.findings.some((finding) => finding.ruleId === 'typosquat' && finding.packageName === 'flaks')).toBe(true);
    expect(fetchPackumentMock).not.toHaveBeenCalled();
    expect(fetchWeeklyDownloadsMock).not.toHaveBeenCalled();
  });
});

describe('requirements lines', () => {
  test('a path-shaped option value does not make a path: both lines are looked up', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'reqeusts==2.31 --config-settings=x=a/b\n');
    write(dir, 'requirements-dev.txt', 'reqeusts --global-option=./x\n');
    commit(dir);
    fetchPypiProjectMock.mockResolvedValue('absent');

    const result = await audit(dir);

    expect(lookedUp()).toEqual(['reqeusts']);
    expect(pythonFindings(result).map((finding) => finding.manifestPath).sort()).toEqual([
      'requirements-dev.txt',
      'requirements.txt',
    ]);
    expect(pythonFindings(result).every((finding) => finding.severity === 'critical')).toBe(true);
  });

  test('unrecognised lines are counted and named; --requirement=more.txt reads more.txt; ${VAR} is never guessed', async () => {
    const dir = initRepo();
    write(
      dir,
      'requirements.txt',
      ['--frobnicate=a', 'café==1.0', '--requirement=more.txt', '${PRIVATE_PKG}==1.0', ''].join('\n')
    );
    write(dir, 'more.txt', 'planted-name\n');
    commit(dir);

    const result = await audit(dir);

    expect(lookedUp()).toEqual(['planted-name']);
    const unread = codes(result, 'requirements-line-unread');
    expect(unread).toEqual([
      expect.stringMatching(/^requirements\.txt:1: /),
      expect.stringMatching(/^requirements\.txt:2: /),
      expect.stringMatching(/^requirements\.txt:4: contains an environment variable reference/),
    ]);
    expect(result.run.ecosystems.pypi.excluded.unrecognised).toBe(3);
  });

  test('-r follows a relative file once, refuses a path leaving the root and a symlink, stops a cycle; -c names are constraints', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', ['-r sub/a.txt', '-r ../outside.txt', '-r link.txt', '-c constraints.in', ''].join('\n'));
    write(dir, 'sub/a.txt', '-r ../requirements.txt\nalpha\n');
    write(dir, 'constraints.in', 'beta==1\n');
    symlinkSync('sub/a.txt', path.join(dir, 'link.txt'));
    commit(dir);

    const result = await audit(dir);

    expect(lookedUp()).toEqual(['alpha']);
    const unread = codes(result, 'requirements-line-unread');
    expect(unread).toEqual([
      expect.stringContaining('requirements.txt:2: includes "../outside.txt" is outside the repository'),
      expect.stringContaining('requirements.txt:3: includes "link.txt" is a symlink'),
    ]);
    expect(result.run.ecosystems.pypi.excluded.constraint).toBe(1);
  });

  test('a Python lockfile that does not parse is a diagnostic and a count, not a could-not-run', async () => {
    const dir = initRepo();
    write(dir, 'pyproject.toml', '[project]\nname = "app"\n');
    write(dir, 'uv.lock', '[[package]\nname = "x"\n');
    commit(dir);

    const result = await audit(dir);

    expect(result.exitCode).toBe(0);
    expect(codes(result, 'python-lockfile-unreadable')).toEqual([expect.stringMatching(/^uv\.lock: could not be read/)]);
    expect(result.run.ecosystems.pypi.notChecked.lockfileUnreadable).toBe(1);
  });

  test('a bare https line reaches the delta and the tamper url-source signal; it is never file', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'https://example.com/pkg/pkg-1.0.tar.gz\n');
    commit(dir);

    const result = await audit(dir, { online: false });

    expect(
      result.findings.some(
        (finding) => finding.ruleId === 'lockfile-tamper' && String(finding.details?.signal).startsWith('url-source')
      )
    ).toBe(true);
  });

  test('a dotted name with a specifier is looked up as the PyPI project it normalises to', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'reqeusts.zip==1.0\npkg.ZIP\n');
    commit(dir);

    await audit(dir);

    expect(lookedUp()).toEqual(['reqeusts-zip']);
  });
});

describe('index declarations', () => {
  test('private index, plain run: no fetch for any of its names, and a skip diagnostic', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', '--index-url https://private.example/simple\ncorp-thing\nother-thing\n');
    commit(dir);

    const result = await audit(dir);

    expect(fetchPypiProjectMock).not.toHaveBeenCalled();
    expect(codes(result, 'pypi-private-index-skipped')).toEqual([
      expect.stringContaining('requirements.txt: 2 Python name(s) not checked for existence on PyPI'),
    ]);
    expect(result.run.ecosystems.pypi.notChecked.privateIndex).toBe(2);
  });

  test('--extra-index-url adds the dependency-confusion sentence', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', '--extra-index-url https://private.example/simple\ncorp-thing\n');
    commit(dir);

    const result = await audit(dir);

    expect(codes(result, 'pypi-private-index-skipped')[0]).toContain('exposed to dependency confusion');
  });

  test('private index added on the head, --trust-base: the name is looked up and the change is a proposal', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'flask\n');
    commit(dir);
    tag(dir, 'base');
    write(dir, 'requirements.txt', '--extra-index-url https://private.example/simple\nflask\ndepguard-planted-absent\n');
    commit(dir);
    fetchPypiProjectMock.mockImplementation(async (name) => (name === 'depguard-planted-absent' ? 'absent' : 'exists'));

    const result = await audit(dir, { trustBase: 'base' });

    expect(lookedUp()).toContain('depguard-planted-absent');
    expect(pythonFindings(result)).toEqual([
      expect.objectContaining({ packageName: 'depguard-planted-absent', severity: 'critical' }),
    ]);
    expect(result.trustBase?.proposals).toContain('python index changed in this pull request (requirements.txt)');
  });

  test('a new requirements file added on the head has its index lines ignored under --trust-base', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'flask\n');
    commit(dir);
    tag(dir, 'base');
    write(dir, 'requirements-extra.txt', '--index-url https://private.example/simple\nhead-only-name\n');
    commit(dir);

    await audit(dir, { trustBase: 'base' });

    expect(lookedUp()).toContain('head-only-name');
  });

  test('explicit index: only the name pinned to it is skipped', async () => {
    const dir = initRepo();
    write(
      dir,
      'pyproject.toml',
      [
        '[project]',
        'name = "app"',
        'dependencies = ["corp-lib", "flask"]',
        '[[tool.uv.index]]',
        'name = "corp"',
        'url = "https://private.example/simple"',
        'explicit = true',
        '[tool.uv.sources]',
        'corp-lib = { index = "corp" }',
        '',
      ].join('\n')
    );
    commit(dir);

    const result = await audit(dir);

    expect(lookedUp()).toEqual(['flask']);
    expect(codes(result, 'pypi-private-index-skipped')).toHaveLength(1);
  });

  test('userinfo never prints: the skip names the origin without it, and the token appears nowhere', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', '--index-url https://user:secret@private.example/simple\nthing\n');
    commit(dir);

    const result = await audit(dir);

    expect(codes(result, 'pypi-private-index-skipped')[0]).toContain('https://private.example/simple');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('a PR that replaces a symlinked base requirements.txt with a regular file passes: no base declarations, named', async () => {
    // Ruled (N3): the screenSymlinkedInputs rule, a comparison side that
    // still holds the link does not block the fix. The base contributes no
    // index declarations, so the head's own private-index line is not
    // obeyed and every name is looked up, which fails closed.
    const dir = initRepo();
    write(dir, 'requirements/base.txt', 'flask\n');
    symlinkSync('requirements/base.txt', path.join(dir, 'requirements.txt'));
    commit(dir);
    tag(dir, 'base');
    remove(dir, 'requirements.txt');
    write(dir, 'requirements.txt', '--index-url https://private.example/simple\nflask\ncorp-thing\n');
    commit(dir);

    const result = await audit(dir, { trustBase: 'base' });

    expect(lookedUp().sort()).toEqual(['corp-thing', 'flask']);
    expect(codes(result, 'python-index-unread-comparison-side')).toEqual([
      expect.stringContaining('requirements.txt: is a symlink on the trust base "base"'),
    ]);
  });

  test('a requirements.txt that is a symlink on the head as well still stops the run', async () => {
    const dir = initRepo();
    write(dir, 'requirements/base.txt', 'flask\n');
    symlinkSync('requirements/base.txt', path.join(dir, 'requirements.txt'));
    commit(dir);
    tag(dir, 'base');
    write(dir, 'requirements/base.txt', 'flask\nrequests\n');
    commit(dir);

    await expect(audit(dir, { trustBase: 'base' })).rejects.toMatchObject({
      code: 'symlinked-input',
      message: expect.stringContaining('dep-guard does not parse a requirements file through a symlink'),
    });
  });

  test('a base copy that is a gitlink still stops a --trust-base run', async () => {
    const dir = initRepo();
    write(dir, 'README.md', 'x\n');
    commit(dir);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${sha},requirements.txt`], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'gitlink'], { cwd: dir });
    tag(dir, 'base');
    execFileSync('git', ['rm', '-q', '--cached', 'requirements.txt'], { cwd: dir });
    write(dir, 'requirements.txt', 'flask\n');
    commit(dir);

    await expect(audit(dir, { trustBase: 'base' })).rejects.toMatchObject({
      code: 'python-index-invalid',
      message: expect.stringContaining('base:requirements.txt is a gitlink'),
    });
  });
});

describe('lockfile sources', () => {
  const uvLock = (origin: string): string =>
    ['version = 1', '[[package]]', 'name = "corp-thing"', 'version = "1.0"', `source = { registry = "${origin}" }`, ''].join(
      '\n'
    );

  test('a recorded origin no manifest declares is looked up', async () => {
    const dir = initRepo();
    write(dir, 'pyproject.toml', '[project]\nname = "app"\n');
    write(dir, 'uv.lock', uvLock('https://anything.example/simple'));
    commit(dir);

    await audit(dir);

    expect(lookedUp()).toEqual(['corp-thing']);
  });

  test('the same origin declared by the base [[tool.uv.index]] is skipped under --trust-base', async () => {
    const dir = initRepo();
    const pyproject = ['[project]', 'name = "app"', '[[tool.uv.index]]', 'url = "https://anything.example/simple/"', ''].join('\n');
    write(dir, 'pyproject.toml', pyproject);
    commit(dir);
    tag(dir, 'base');
    write(dir, 'uv.lock', uvLock('https://anything.example/simple'));
    commit(dir);

    const result = await audit(dir, { trustBase: 'base' });

    expect(fetchPypiProjectMock).not.toHaveBeenCalled();
    expect(codes(result, 'pypi-private-index-skipped')).toHaveLength(1);
  });

  test('the same origin declared only on the head is looked up under --trust-base', async () => {
    const dir = initRepo();
    write(dir, 'pyproject.toml', '[project]\nname = "app"\n');
    commit(dir);
    tag(dir, 'base');
    write(dir, 'pyproject.toml', ['[project]', 'name = "app"', '[[tool.uv.index]]', 'url = "https://anything.example/simple"', ''].join('\n'));
    write(dir, 'uv.lock', uvLock('https://anything.example/simple'));
    commit(dir);

    await audit(dir, { trustBase: 'base' });

    expect(lookedUp()).toEqual(['corp-thing']);
  });

  test('an entry naming https://pypi.org/simple/ is looked up as PyPI', async () => {
    const dir = initRepo();
    write(dir, 'pyproject.toml', '[project]\nname = "app"\n');
    write(dir, 'uv.lock', uvLock('https://pypi.org/simple/'));
    commit(dir);

    await audit(dir);

    expect(lookedUp()).toEqual(['corp-thing']);
  });

  test('a Pipfile.lock whose _meta.sources remaps the pypi index name is looked up', async () => {
    const dir = initRepo();
    write(dir, 'Pipfile', '[packages]\n');
    write(
      dir,
      'Pipfile.lock',
      JSON.stringify({
        _meta: { sources: [{ name: 'pypi', url: 'https://evil.example/simple', verify_ssl: true }] },
        default: { 'corp-thing': { index: 'pypi', version: '==1.0' } },
        develop: {},
      })
    );
    commit(dir);

    await audit(dir);

    expect(lookedUp()).toEqual(['corp-thing']);
  });

  test('a lockfile-only absent name is one critical, anchored to the lockfile', async () => {
    const dir = initRepo();
    write(dir, 'pyproject.toml', '[project]\nname = "app"\n');
    write(dir, 'uv.lock', uvLock('https://pypi.org/simple'));
    commit(dir);
    fetchPypiProjectMock.mockResolvedValue('absent');

    const result = await audit(dir);

    expect(pythonFindings(result)).toEqual([
      expect.objectContaining({ packageName: 'corp-thing', manifestPath: 'uv.lock', severity: 'critical' }),
    ]);
  });
});

describe('internalPrefixes and allow', () => {
  test('pypi:acme- skips Acme_Utils with no request', async () => {
    const dir = initRepo();
    write(dir, '.dep-guard.json', JSON.stringify({ internalPrefixes: ['pypi:acme-'] }));
    write(dir, 'requirements.txt', 'Acme_Utils\n');
    commit(dir);

    const result = await audit(dir);

    expect(fetchPypiProjectMock).not.toHaveBeenCalled();
    expect(result.run.ecosystems.pypi.notChecked.internal).toBe(1);
  });

  test('a bare acme- entry does not skip Acme_Utils, and still covers the npm name acme-ui', async () => {
    const dir = initRepo();
    write(dir, '.dep-guard.json', JSON.stringify({ internalPrefixes: ['acme-'] }));
    write(dir, 'package.json', JSON.stringify({ name: 'x', dependencies: { 'acme-ui': '^1.0.0' } }));
    write(dir, 'requirements.txt', 'Acme_Utils\n');
    commit(dir);

    const result = await audit(dir, { online: true });

    expect(lookedUp()).toEqual(['acme-utils']);
    expect(result.findings.some((finding) => finding.packageName === 'acme-ui' && finding.ruleId === 'unknown-package')).toBe(false);
  });

  test('a bare allow entry does not clear the Python finding; pypi:Reqeusts does and is counted', async () => {
    const dir = initRepo();
    write(dir, '.dep-guard.json', JSON.stringify({ allow: ['reqeusts'] }));
    write(dir, 'requirements.txt', 'reqeusts\n');
    commit(dir);
    fetchPypiProjectMock.mockResolvedValue('absent');

    const bare = await audit(dir);
    expect(pythonFindings(bare)).toHaveLength(1);

    write(dir, '.dep-guard.json', JSON.stringify({ allow: ['pypi:Reqeusts'] }));
    commit(dir);
    const prefixed = await audit(dir);
    expect(pythonFindings(prefixed)).toEqual([]);
    expect(prefixed.allowedNames).toEqual(['pypi:reqeusts']);
    expect(prefixed.allowed).toBe(1);
  });
});

describe('typosquat for Python', () => {
  test('a Python resemblance needs a different project: Flask and flask are one', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'Flask\n');
    write(dir, 'pyproject.toml', '[project]\nname = "app"\ndependencies = ["flask"]\n');
    commit(dir);

    const result = await audit(dir, { online: false });

    expect(result.findings.filter((finding) => finding.ruleId === 'typosquat')).toEqual([]);
  });

  test('a re-spelled name the base already declares is not a typosquat of itself', async () => {
    // In an audit run both spellings are new and the pairing rule hides an
    // exact match; here the base declares the project, so only an exact
    // normalised match could make Flask a finding.
    const dir = initRepo();
    write(dir, 'requirements.txt', 'flask\n');
    commit(dir);
    tag(dir, 'base');
    write(dir, 'pyproject.toml', '[project]\nname = "app"\ndependencies = ["Flask"]\n');
    commit(dir);

    const result = await scan({ repoRoot: dir, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS, online: false });

    expect(result.findings.filter((finding) => finding.ruleId === 'typosquat')).toEqual([]);
  });

  test('flask declared and flaks added: one low typosquat naming flask', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'flask\n');
    commit(dir);
    tag(dir, 'base');
    write(dir, 'requirements.txt', 'flask\nflaks\n');
    commit(dir);

    const result = await scan({ repoRoot: dir, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS, online: false });

    const typosquats = result.findings.filter((finding) => finding.ruleId === 'typosquat');
    expect(typosquats).toEqual([
      expect.objectContaining({
        packageName: 'flaks',
        severity: 'low',
        details: expect.objectContaining({ target: 'flask', comparedAgainst: 'repository', ecosystem: 'pypi' }),
      }),
    ]);
  });

  test('an offline run with Python names says they were not checked for existence', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'flask\nrequests\n');
    commit(dir);

    const result = await audit(dir, { online: false });

    expect(codes(result, 'pypi-names-not-checked')).toEqual([
      expect.stringMatching(/^2 Python dependency names in requirements\.txt were read and not checked for existence/),
    ]);
    expect(result.run.ecosystems.pypi.notChecked.offline).toBe(2);
  });
});

describe('[tool.uv.sources] scope', () => {
  const rootWithWorkspaceSource = (members: string | null): string =>
    [
      '[project]',
      'name = "app"',
      'dependencies = ["reqeusts"]',
      '[tool.uv.sources]',
      'reqeusts = { workspace = true }',
      ...(members === null ? [] : ['[tool.uv.workspace]', `members = [${members}]`]),
      '',
    ].join('\n');

  test('the B3 attack: a stray pyproject named reqeusts and a root workspace source exempt nothing', async () => {
    const dir = initRepo();
    write(dir, 'tools/x/pyproject.toml', '[project]\nname = "reqeusts"\n');
    write(dir, 'pyproject.toml', rootWithWorkspaceSource(null));
    write(dir, 'requirements.txt', 'reqeusts\n');
    commit(dir);
    fetchPypiProjectMock.mockResolvedValue('absent');

    const result = await audit(dir);

    expect(pythonFindings(result).map((finding) => finding.manifestPath).sort()).toEqual([
      'pyproject.toml',
      'requirements.txt',
    ]);
  });

  test('control: with tools/x a member, the root dependency is exempt and the requirements line is not', async () => {
    const dir = initRepo();
    write(dir, 'tools/x/pyproject.toml', '[project]\nname = "reqeusts"\n');
    write(dir, 'pyproject.toml', rootWithWorkspaceSource('"tools/*"'));
    write(dir, 'requirements.txt', 'reqeusts\n');
    commit(dir);
    fetchPypiProjectMock.mockResolvedValue('absent');

    const result = await audit(dir);

    expect(pythonFindings(result).map((finding) => finding.manifestPath)).toEqual(['requirements.txt']);
  });

  test('members widened only on the head under --trust-base: both are looked up, and the reason is named', async () => {
    const dir = initRepo();
    write(dir, 'tools/x/pyproject.toml', '[project]\nname = "reqeusts"\n');
    write(dir, 'pyproject.toml', rootWithWorkspaceSource('"libs/*"'));
    write(dir, 'requirements.txt', 'reqeusts\n');
    commit(dir);
    tag(dir, 'base');
    write(dir, 'pyproject.toml', rootWithWorkspaceSource('"libs/*", "tools/*"'));
    commit(dir);
    fetchPypiProjectMock.mockResolvedValue('absent');

    const result = await audit(dir, { trustBase: 'base' });

    expect(pythonFindings(result).map((finding) => finding.manifestPath).sort()).toEqual([
      'pyproject.toml',
      'requirements.txt',
    ]);
    expect(codes(result, 'python-workspace-unconfirmed')).toHaveLength(1);
  });

  test('a path source in project A does not exempt the same name in project B', async () => {
    const dir = initRepo();
    write(dir, 'libs/lib/pyproject.toml', '[project]\nname = "lib"\n');
    write(dir, 'a/pyproject.toml', '[project]\nname = "a"\ndependencies = ["lib"]\n[tool.uv.sources]\nlib = { path = "../libs/lib" }\n');
    write(dir, 'b/pyproject.toml', '[project]\nname = "b"\ndependencies = ["lib"]\n');
    commit(dir);
    fetchPypiProjectMock.mockResolvedValue('absent');

    const result = await audit(dir);

    expect(pythonFindings(result).map((finding) => finding.manifestPath)).toEqual(['b/pyproject.toml']);
  });

  test('root sources do not follow a head-widened members under --trust-base', async () => {
    const dir = initRepo();
    const root = (members: string): string =>
      ['[project]', 'name = "app"', '[tool.uv.sources]', 'x = { path = "libs/x" }', '[tool.uv.workspace]', `members = [${members}]`, ''].join(
        '\n'
      );
    write(dir, 'libs/x/pyproject.toml', '[project]\nname = "x"\n');
    write(dir, 'pyproject.toml', root('"libs/*"'));
    commit(dir);
    tag(dir, 'base');
    write(dir, 'pyproject.toml', root('"libs/*", "apps/*"'));
    write(dir, 'apps/new/pyproject.toml', '[project]\nname = "new"\ndependencies = ["x"]\n');
    commit(dir);
    fetchPypiProjectMock.mockResolvedValue('absent');

    const trusted = await audit(dir, { trustBase: 'base' });
    expect(pythonFindings(trusted).map((finding) => finding.manifestPath)).toEqual(['apps/new/pyproject.toml']);

    // Outside pull-request mode the tree's own members decide, and the
    // same dependency is inside the root source's scope.
    const plain = await audit(dir);
    expect(pythonFindings(plain)).toEqual([]);
  });
});

describe('[tool.uv.sources] rewrites on the comparison side', () => {
  test('an unchanged git source is not a change on a --base run', async () => {
    // Found by the real-registry validation: the rewrite was applied to
    // the judged side only, so an untouched git-sourced dependency read as
    // moved from pypi to git and raised a tamper critical on every PR.
    const dir = initRepo();
    write(
      dir,
      'pyproject.toml',
      ['[project]', 'name = "app"', 'dependencies = ["docs-theme"]', '[tool.uv.sources]', 'docs-theme = { git = "https://example.com/docs-theme" }', ''].join('\n')
    );
    write(dir, 'requirements.txt', 'flask\n');
    commit(dir);
    tag(dir, 'base');
    write(dir, 'requirements.txt', 'flask\nrequests\n');
    commit(dir);

    const result = await scan({ repoRoot: dir, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS, online: false });

    expect(result.findings.filter((finding) => finding.ruleId === 'lockfile-tamper')).toEqual([]);
  });

  test('a git source added on the head is still a tamper finding', async () => {
    const dir = initRepo();
    write(dir, 'pyproject.toml', '[project]\nname = "app"\ndependencies = ["docs-theme"]\n');
    commit(dir);
    tag(dir, 'base');
    write(
      dir,
      'pyproject.toml',
      ['[project]', 'name = "app"', 'dependencies = ["docs-theme"]', '[tool.uv.sources]', 'docs-theme = { git = "https://example.com/docs-theme" }', ''].join('\n')
    );
    commit(dir);

    const result = await scan({ repoRoot: dir, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS, online: false });

    expect(result.findings.filter((finding) => finding.ruleId === 'lockfile-tamper')).toEqual([
      expect.objectContaining({ packageName: 'docs-theme', severity: 'critical' }),
    ]);
  });
});

describe('a path source needs a real target', () => {
  const app = (target: string): string =>
    ['[project]', 'name = "app"', 'dependencies = ["reqeusts"]', '[tool.uv.sources]', `reqeusts = { path = "${target}" }`, ''].join('\n');

  test('a head-only path = "docs" with no project named reqeusts there is looked up, under --trust-base', async () => {
    const dir = initRepo();
    write(dir, 'pyproject.toml', '[project]\nname = "app"\n');
    write(dir, 'docs/README.md', 'docs\n');
    commit(dir);
    tag(dir, 'base');
    write(dir, 'pyproject.toml', app('docs'));
    commit(dir);
    fetchPypiProjectMock.mockResolvedValue('absent');

    const result = await audit(dir, { trustBase: 'base' });

    expect(pythonFindings(result).map((finding) => finding.packageName)).toEqual(['reqeusts']);
  });

  test.each([
    ['a directory holding a parsed project named reqeusts', 'libs/reqeusts', true],
    ['a wheel whose distribution name is reqeusts', 'wheels/reqeusts-1.0-py3-none-any.whl', true],
    ['an sdist whose distribution name is reqeusts', 'wheels/Reqeusts-1.0.tar.gz', true],
    ['an archive whose distribution name is another project', 'wheels/other-1.0-py3-none-any.whl', false],
    ['a target outside the repository root', '../outside', false],
  ])('%s: exempt is %s', async (_label, target, exempt) => {
    const dir = initRepo();
    write(dir, 'libs/reqeusts/pyproject.toml', '[project]\nname = "reqeusts"\n');
    write(dir, 'pyproject.toml', app(target));
    if (target.startsWith('wheels/')) {
      write(dir, target, 'archive bytes\n');
    }
    commit(dir);
    fetchPypiProjectMock.mockResolvedValue('absent');

    const result = await audit(dir);

    expect(pythonFindings(result).length === 0).toBe(exempt);
  });

  test('an archive target that is not on the judged side exempts nothing', async () => {
    const dir = initRepo();
    write(dir, 'pyproject.toml', app('wheels/reqeusts-1.0-py3-none-any.whl'));
    commit(dir);
    fetchPypiProjectMock.mockResolvedValue('absent');

    const result = await audit(dir);

    expect(pythonFindings(result).map((finding) => finding.packageName)).toEqual(['reqeusts']);
  });
});

describe('uv source precedence: the nearest declaring file wins', () => {
  const root = (source: string): string =>
    [
      '[project]',
      'name = "app"',
      '[tool.uv.sources]',
      `foo = ${source}`,
      '[tool.uv.workspace]',
      'members = ["services/*", "libs/*"]',
      '',
    ].join('\n');
  const member = (override: boolean): string =>
    [
      '[project]',
      'name = "a"',
      'dependencies = ["foo"]',
      ...(override ? ['[tool.uv.sources]', 'foo = { git = "https://evil.example.org/foo" }'] : []),
      '',
    ].join('\n');

  async function headOverride(rootSource: string, memberDir: string) {
    const dir = initRepo();
    write(dir, 'libs/foo/pyproject.toml', '[project]\nname = "foo"\n');
    write(dir, 'pyproject.toml', root(rootSource).replace('services/*', `${memberDir}/*`));
    write(dir, `${memberDir}/a/pyproject.toml`, member(false));
    commit(dir);
    tag(dir, 'base');
    write(dir, `${memberDir}/a/pyproject.toml`, member(true));
    commit(dir);
    return scan({ repoRoot: dir, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS, online: false });
  }

  function evilTamper(result: Awaited<ReturnType<typeof ScanFn>>) {
    return result.findings.filter(
      (finding) => finding.ruleId === 'lockfile-tamper' && String(finding.details?.signal).includes('evil.example.org')
    );
  }

  test('a member under services/ (sorting after the root) overriding a root git source is a tamper finding', async () => {
    const result = await headOverride('{ git = "https://example.com/foo" }', 'services');
    expect(evilTamper(result)).toEqual([expect.objectContaining({ packageName: 'foo', manifestPath: 'services/a/pyproject.toml' })]);
  });

  test('a member overriding a confirmed root path source is a tamper finding', async () => {
    const result = await headOverride('{ path = "libs/foo" }', 'services');
    expect(evilTamper(result)).toEqual([expect.objectContaining({ packageName: 'foo', manifestPath: 'services/a/pyproject.toml' })]);
  });

  test('control: a member under apps/ (sorting before the root) fires as well', async () => {
    const result = await headOverride('{ git = "https://example.com/foo" }', 'apps');
    expect(evilTamper(result)).toHaveLength(1);
  });
});

describe('index skip notes and unreachable notes', () => {
  test('a name looked up at another anchor is not counted as skipped', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', '--index-url https://private.example/simple\nflask\ncorp-only\n');
    write(dir, 'requirements-dev.txt', 'flask\n');
    commit(dir);

    const result = await audit(dir);

    expect(lookedUp()).toEqual(['flask']);
    expect(codes(result, 'pypi-private-index-skipped')).toEqual([
      expect.stringContaining('requirements.txt: 1 Python name(s) not checked for existence on PyPI'),
    ]);
    expect(result.run.ecosystems.pypi.notChecked.privateIndex).toBe(1);
  });

  test('a PyPI outage gives one online-check-unreachable for the ecosystem, with a count and the first names', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'alpha\nbravo\ncharlie\n');
    commit(dir);
    fetchPypiProjectMock.mockRejectedValue(new Error('request failed: 503'));

    const result = await audit(dir);

    expect(codes(result, 'online-check-unreachable')).toEqual([
      expect.stringMatching(/^pypi existence: could not get an answer from PyPI for 3 name\(s\) \(alpha, bravo, charlie\)/),
    ]);
  });
});

describe('an invalid requirement string never prints its tail', () => {
  test('a token after the name of an invalid PEP 508 string reaches no output surface', async () => {
    const dir = initRepo();
    write(
      dir,
      'pyproject.toml',
      [
        '[project]',
        'name = "app"',
        'dependencies = [',
        '  "_x @ git+https://user:s3cr3tTOKEN@example.com/r.git",',
        '  "x[extra @ git+https://user:s3cr3tTOKEN@example.com/r.git",',
        '  "user:s3cr3tTOKEN@example.com/r.git",',
        ']',
        '',
      ].join('\n')
    );
    write(
      dir,
      'uv.lock',
      ['version = 1', '[[package]]', 'name = "y @ https://user:s3cr3tTOKEN@example.com/y.whl"', 'version = "1"', 'source = { registry = "https://pypi.org/simple" }', ''].join('\n')
    );
    commit(dir);

    const result = await audit(dir);

    expect(codes(result, 'python-name-invalid').length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(result)).not.toContain('s3cr3tTOKEN');
    expect(renderText(result)).not.toContain('s3cr3tTOKEN');
    expect(renderSarif(result, '0.13.0')).not.toContain('s3cr3tTOKEN');
  });

  const tokenName = 'y @ https://user:s3cr3tTOKEN@example.com/y.whl';
  test.each([
    [
      'a uv.lock entry with a version that is not a string',
      'uv.lock',
      ['version = 1', '[[package]]', `name = "${tokenName}"`, 'version = 1', 'source = { registry = "https://pypi.org/simple" }', ''].join('\n'),
    ],
    [
      'a poetry.lock entry with a version that is not a string',
      'poetry.lock',
      ['[[package]]', `name = "${tokenName}"`, 'version = 1', ''].join('\n'),
    ],
    [
      'a pdm.lock entry with a version that is not a string',
      'pdm.lock',
      ['[[package]]', `name = "${tokenName}"`, 'version = 1', ''].join('\n'),
    ],
    ['a Pipfile.lock entry that is not an object', 'Pipfile.lock', JSON.stringify({ default: { [tokenName]: 3 } })],
    [
      'a Pipfile.lock entry with neither a version nor a source',
      'Pipfile.lock',
      JSON.stringify({ default: { [tokenName]: { hashes: [] } } }),
    ],
    [
      'a Pipfile.lock entry whose index is not a string',
      'Pipfile.lock',
      JSON.stringify({ default: { [tokenName]: { version: '==1', index: 3 } } }),
    ],
  ])('%s never prints the token in python-lockfile-unreadable', async (_label, file, content) => {
    const dir = initRepo();
    write(dir, 'pyproject.toml', '[project]\nname = "app"\n');
    write(dir, file, content);
    commit(dir);

    const result = await audit(dir);

    expect(codes(result, 'python-lockfile-unreadable')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('s3cr3tTOKEN');
    expect(renderText(result)).not.toContain('s3cr3tTOKEN');
    expect(renderSarif(result, '0.13.0')).not.toContain('s3cr3tTOKEN');
  });

  test('an unread -r target prints only its path characters', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', '-r user:s3cr3tTOKEN@missing.txt\n');
    commit(dir);

    const result = await audit(dir);

    expect(codes(result, 'requirements-line-unread')).toEqual([expect.stringContaining('includes "user...')]);
    expect(JSON.stringify(result)).not.toContain('s3cr3tTOKEN');
  });
});

describe('index labels in skip notes', () => {
  test('a named index carrying a token is never printed in full, by a per-name mapping or a lockfile match', async () => {
    const dir = initRepo();
    const label = 'corp@https://user:s3cr3tTOKEN@example.com';
    write(
      dir,
      'pyproject.toml',
      [
        '[project]',
        'name = "app"',
        'dependencies = ["corp-lib"]',
        '[[tool.uv.index]]',
        `name = "${label}"`,
        'url = "https://private.example/simple"',
        'explicit = true',
        '[tool.uv.sources]',
        `corp-lib = { index = "${label}" }`,
        '',
      ].join('\n')
    );
    write(
      dir,
      'uv.lock',
      ['version = 1', '[[package]]', 'name = "corp-other"', 'version = "1"', 'source = { registry = "https://private.example/simple" }', ''].join('\n')
    );
    commit(dir);

    const result = await audit(dir);

    expect(fetchPypiProjectMock).not.toHaveBeenCalled();
    // The per-name mapping and the lockfile match name the same file,
    // origin and index, so they share one note covering both names.
    expect(codes(result, 'pypi-private-index-skipped')).toEqual([expect.stringContaining('2 Python name(s)')]);
    expect(JSON.stringify(result)).not.toContain('s3cr3tTOKEN');
    expect(renderText(result)).not.toContain('s3cr3tTOKEN');
  });
});

describe('a symlinked base copy of a workspace root', () => {
  test('contributes no workspace members: a root path source no longer reaches a member', async () => {
    const dir = initRepo();
    const root = [
      '[project]',
      'name = "app"',
      '[tool.uv.sources]',
      'foo = { path = "libs/foo" }',
      '[tool.uv.workspace]',
      'members = ["services/*", "libs/*"]',
      '',
    ].join('\n');
    write(dir, 'libs/foo/pyproject.toml', '[project]\nname = "foo"\n');
    write(dir, 'services/a/pyproject.toml', '[project]\nname = "a"\ndependencies = ["foo"]\n');
    write(dir, 'config/root.toml', root);
    symlinkSync('config/root.toml', path.join(dir, 'pyproject.toml'));
    commit(dir);
    tag(dir, 'base');
    remove(dir, 'pyproject.toml');
    write(dir, 'pyproject.toml', root);
    commit(dir);
    fetchPypiProjectMock.mockResolvedValue('absent');

    const result = await audit(dir, { trustBase: 'base' });

    expect(pythonFindings(result).map((finding) => [finding.packageName, finding.manifestPath])).toEqual([
      ['foo', 'services/a/pyproject.toml'],
    ]);
    expect(codes(result, 'python-index-unread-comparison-side')).toHaveLength(1);
  });
});

describe('a --trust-base and --base run with a separate trust base', () => {
  test('an unchanged git source is the same non-PyPI dependency on the trust base as well', async () => {
    // The trust base here is a different tree from the --base side, so it
    // is read as its own comparison side and gets its own rewrite. Left
    // unrewritten, its git-sourced "foo" counted as a Python name and the
    // new "foq" was reported as a resemblance of it.
    const dir = initRepo();
    write(dir, 'pyproject.toml', '[project]\nname = "app"\ndependencies = ["foo"]\n[tool.uv.sources]\nfoo = { git = "https://example.com/foo" }\n');
    commit(dir);
    tag(dir, 'trust');
    write(dir, 'requirements.txt', 'flask\n');
    commit(dir);
    tag(dir, 'base');
    write(dir, 'requirements.txt', 'flask\nfoq\n');
    commit(dir);

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'base' },
      trustBase: 'trust',
      corpusDir: FIXTURE_CORPUS,
      online: false,
    });

    expect(result.findings.filter((finding) => finding.ruleId === 'typosquat' || finding.ruleId === 'lockfile-tamper')).toEqual([]);
  });
});

// Audit B2 (docs/design/2026-10-18-head-defined-projects-and-ignore-paths.md,
// section 8): on a --base or --trust-base run, a candidate name an online
// step left unchecked is a could-not-run, exit 2, with the full report.
// Each test names its id. An onlineBudgetMs of 0 is a budget spent before
// the first step, with no request made.
describe('an unchecked name does not pass a pull request (0.16.0)', () => {
  const NONEXIST = 'zz-dg-audit-nonexist-1018';

  function npmLock(packages: Record<string, Record<string, unknown>>): string {
    return JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app', version: '1.0.0' }, ...packages } });
  }

  const LODASH_ENTRY = {
    version: '4.17.21',
    resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
    integrity: 'sha512-lodash',
  };

  // The adv/p1 shape: the base declares requests; the head adds a name PyPI
  // does not have and a transposition of requests.
  function p1(baseConfig: Record<string, unknown> = {}, headConfig: Record<string, unknown> | null = null): string {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'requests==2.31.0\n');
    write(dir, '.dep-guard.json', JSON.stringify(baseConfig));
    commit(dir, 'base');
    tag(dir, 'base');
    write(dir, 'requirements.txt', `requests==2.31.0\n${NONEXIST}==1.0.0\nreqeusts==1.0.0\n`);
    if (headConfig !== null) {
      write(dir, '.dep-guard.json', JSON.stringify(headConfig));
    }
    commit(dir, 'head');
    return dir;
  }

  function pullRequest(dir: string, extra: Partial<Parameters<typeof ScanFn>[0]> = {}) {
    return scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'base' },
      trustBase: 'base',
      corpusDir: FIXTURE_CORPUS,
      online: true,
      ...extra,
    });
  }

  const entries = (result: Awaited<ReturnType<typeof ScanFn>>) => result.run.online.unchecked?.names ?? [];

  test('U1 a spent budget on a pull request is exit 2 with both names and the full report', async () => {
    const dir = p1();

    const result = await pullRequest(dir, { onlineBudgetMs: 0 });

    expect(result.exitCode).toBe(2);
    expect(entries(result)).toEqual([
      { name: 'reqeusts', ecosystem: 'pypi', step: 'pypi-existence', reason: 'budget' },
      { name: NONEXIST, ecosystem: 'pypi', step: 'pypi-existence', reason: 'budget' },
    ]);
    expect(result.run.online.unchecked?.count).toBe(2);
    expect(result.run.couldNotRun?.code).toBe('online-names-unchecked');
    expect(result.run.couldNotRun?.message).toContain('could not run: 2 candidate name(s) were not checked online');
    // The full report: the offline resemblance finding is still there.
    expect(result.findings.some((finding) => finding.packageName === 'reqeusts')).toBe(true);
  });

  test('U2 npm names queued for registered-squat and publish-age, budget spent: exit 2 with the steps named', async () => {
    const dir = initRepo();
    write(dir, 'package.json', JSON.stringify({ name: 'app', version: '1.0.0', dependencies: {} }));
    write(dir, 'package-lock.json', npmLock({}));
    commit(dir, 'base');
    tag(dir, 'base');
    write(dir, 'package.json', JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { lodash: '^4.17.21' } }));
    write(dir, 'package-lock.json', npmLock({ 'node_modules/lodash': LODASH_ENTRY }));
    commit(dir, 'head');

    const result = await pullRequest(dir, { onlineBudgetMs: 0 });

    expect(result.exitCode).toBe(2);
    expect(entries(result)).toEqual([
      { name: 'lodash', ecosystem: 'npm', step: 'publish-age', reason: 'budget' },
      { name: 'lodash', ecosystem: 'npm', step: 'registered-squat', reason: 'budget' },
    ]);
    // One name left unchecked by two steps is one candidate name; the
    // per-step detail stays beside it.
    expect(result.run.couldNotRun?.message).toContain(
      'could not run: 1 candidate name(s) were not checked online ' +
        '(lodash: online budget spent (publish-age); online budget spent (registered-squat))'
    );
  });

  test('U3 a PyPI 404 for one name and a spent budget for the other: one critical and one unchecked name, exit 2', async () => {
    const dir = p1();
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    fetchPypiProjectMock.mockImplementation(async () => {
      now += 5_000;
      return 'absent';
    });

    const result = await pullRequest(dir, { onlineBudgetMs: 1_000 });

    expect(lookedUp()).toEqual(['reqeusts']);
    expect(result.findings.filter((finding) => finding.severity === 'critical').map((finding) => finding.packageName)).toEqual([
      'reqeusts',
    ]);
    expect(entries(result)).toEqual([{ name: NONEXIST, ecosystem: 'pypi', step: 'pypi-existence', reason: 'budget' }]);
    expect(result.exitCode).toBe(2);
  });

  test('U4 every name answered, one 404: exit 1 and nothing unchecked', async () => {
    const dir = p1();
    fetchPypiProjectMock.mockImplementation(async (name) => (name === NONEXIST ? 'absent' : 'exists'));

    const result = await pullRequest(dir);

    expect(result.exitCode).toBe(1);
    expect(result.run.online.unchecked).toEqual({ count: 0, names: [] });
    expect(result.run.couldNotRun).toBeUndefined();
  });

  test('U5 every unreachable answer is unchecked, with its status where known', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'requests==2.31.0\n');
    write(dir, 'package.json', JSON.stringify({ name: 'app', version: '1.0.0', dependencies: {} }));
    commit(dir, 'base');
    tag(dir, 'base');
    write(dir, 'requirements.txt', 'requests==2.31.0\nalpha==1\nbravo==1\ncharlie==1\ndelta==1\n');
    write(dir, 'package.json', JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'zz-unknown-npm-name': '^1.0.0' } }));
    commit(dir, 'head');
    const failure = (message: string, status?: number) =>
      Object.assign(new Error(message), status === undefined ? {} : { status });
    fetchPypiProjectMock.mockImplementation(async (name) => {
      if (name === 'alpha') throw failure('giving up after 2 attempt(s): request failed: 503', 503);
      if (name === 'bravo') throw failure('PyPI answered 302, a redirect, which is not followed', 302);
      if (name === 'charlie') throw failure('request failed: 403 Forbidden', 403);
      throw failure('unexpected response: the body does not describe the project that was asked for');
    });
    fetchPackumentMock.mockRejectedValue(failure('giving up after 2 attempt(s): request failed: 429', 429));

    const result = await pullRequest(dir);

    expect(result.exitCode).toBe(2);
    expect(entries(result).filter((entry) => entry.step === 'pypi-existence' || entry.step === 'unknown-package')).toEqual([
      { name: 'alpha', ecosystem: 'pypi', step: 'pypi-existence', reason: 'unreachable', status: 503 },
      { name: 'bravo', ecosystem: 'pypi', step: 'pypi-existence', reason: 'unreachable', status: 302 },
      { name: 'charlie', ecosystem: 'pypi', step: 'pypi-existence', reason: 'unreachable', status: 403 },
      { name: 'delta', ecosystem: 'pypi', step: 'pypi-existence', reason: 'unreachable' },
      { name: 'zz-unknown-npm-name', ecosystem: 'npm', step: 'unknown-package', reason: 'unreachable', status: 429 },
    ]);
  });

  test('U6 allowed, workspace-local and internal names are never counted', async () => {
    const dir = initRepo();
    const config = { allow: ['lodash', 'pypi:reqeusts'], internalPrefixes: ['pypi:zz-'] };
    write(dir, '.dep-guard.json', JSON.stringify(config));
    write(dir, 'requirements.txt', 'requests==2.31.0\n');
    write(dir, 'package.json', JSON.stringify({ name: 'app', version: '1.0.0', workspaces: ['packages/*'], dependencies: {} }));
    write(dir, 'packages/sib/package.json', JSON.stringify({ name: 'sib', version: '1.0.0' }));
    write(dir, 'package-lock.json', npmLock({}));
    commit(dir, 'base');
    tag(dir, 'base');
    write(dir, 'requirements.txt', `requests==2.31.0\n${NONEXIST}==1.0.0\nreqeusts==1.0.0\n`);
    write(
      dir,
      'package.json',
      JSON.stringify({ name: 'app', version: '1.0.0', workspaces: ['packages/*'], dependencies: { lodash: '^4.17.21', sib: '^1.0.0' } })
    );
    write(
      dir,
      'package-lock.json',
      npmLock({
        'node_modules/lodash': LODASH_ENTRY,
        'node_modules/sib': { resolved: 'packages/sib', link: true },
      })
    );
    commit(dir, 'head');

    const result = await pullRequest(dir, { onlineBudgetMs: 0 });

    expect(result.run.online.unchecked).toEqual({ count: 0, names: [] });
    expect(result.run.couldNotRun).toBeUndefined();
    expect(result.findings.filter((finding) => finding.severity !== 'low')).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('U7 a plain run and an audit keep the diagnostics only', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'requests==2.31.0\n');
    commit(dir, 'base');
    write(dir, 'requirements.txt', `requests==2.31.0\n${NONEXIST}==1.0.0\nreqeusts==1.0.0\n`);
    execFileSync('git', ['add', '-A'], { cwd: dir });

    const staged = await scan({ repoRoot: dir, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS, online: true, onlineBudgetMs: 0 });
    const audited = await audit(dir, { onlineBudgetMs: 0 });

    for (const result of [staged, audited]) {
      expect(result.exitCode).toBe(0);
      expect(result.run.couldNotRun).toBeUndefined();
      expect(result.run.diagnostics.map((entry) => entry.code)).toContain('online-deadline-exceeded');
    }
    expect(audited.run.online.unchecked?.count).toBeGreaterThan(0);
  });

  test('U8 the base sets onlineUnchecked note: exit 0, the count still reported', async () => {
    const dir = p1({ onlineUnchecked: 'note' });

    const result = await pullRequest(dir, { onlineBudgetMs: 0 });

    expect(result.exitCode).toBe(0);
    expect(result.run.online.unchecked?.count).toBe(2);
    expect(result.run.couldNotRun).toBeUndefined();
  });

  test('U9 only the head sets onlineUnchecked note: exit 2, and the config proposal names the key', async () => {
    const dir = p1({}, { onlineUnchecked: 'note' });

    const result = await pullRequest(dir, { onlineBudgetMs: 0 });

    expect(result.exitCode).toBe(2);
    expect(result.trustBase?.proposals.join('\n')).toContain('onlineUnchecked set to note');
  });

  test('U10 twelve unchecked names: the line lists ten and a count, the JSON all twelve', async () => {
    const dir = initRepo();
    write(dir, 'requirements.txt', 'requests==2.31.0\n');
    commit(dir, 'base');
    tag(dir, 'base');
    const names = Array.from({ length: 12 }, (_unused, index) => `name-${String(index + 1).padStart(2, '0')}`);
    write(dir, 'requirements.txt', `requests==2.31.0\n${names.map((name) => `${name}==1`).join('\n')}\n`);
    commit(dir, 'head');

    const result = await pullRequest(dir, { onlineBudgetMs: 0 });

    expect(result.run.online.unchecked?.names.map((entry) => entry.name)).toEqual(names);
    const message = result.run.couldNotRun?.message ?? '';
    expect(message).toContain('name-10: online budget spent (pypi-existence), and 2 more)');
    expect(message).not.toContain('name-11');
    expect(renderText(result)).toContain(message);
  });

  test('U12 check with --trust-base and --online, budget spent: exit 2', async () => {
    const dir = initRepo();
    write(dir, '.dep-guard.json', '{}');
    commit(dir, 'base');
    tag(dir, 'base');
    write(dir, 'README.md', 'head\n');
    commit(dir, 'head');
    const { checkSingle } = await import('../src/scan.js');

    const result = await checkSingle({
      repoRoot: dir,
      name: 'lodash',
      corpusDir: FIXTURE_CORPUS,
      trustBase: 'base',
      online: true,
      onlineBudgetMs: 0,
    });

    expect(result.exitCode).toBe(2);
    expect(result.run.couldNotRun?.code).toBe('online-names-unchecked');
  });

  test('U13 the base config requires online and the command line turned it off: every candidate is unchecked', async () => {
    const dir = p1({ online: true });

    const result = await pullRequest(dir, { online: false });

    expect(fetchPypiProjectMock).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(2);
    expect(entries(result)).toEqual([
      { name: 'reqeusts', ecosystem: 'pypi', step: 'pypi-existence', reason: 'online-disabled' },
      { name: NONEXIST, ecosystem: 'pypi', step: 'pypi-existence', reason: 'online-disabled' },
    ]);
    expect(result.run.couldNotRun?.message).toContain(
      'online lookups disabled on the command line while the base config requires them'
    );
  });

  test.each([
    ['false', { online: false }],
    ['absent', {}],
  ])('U14 a base config with online %s and --no-online is unchanged', async (_label, baseConfig) => {
    const dir = p1(baseConfig);

    const result = await pullRequest(dir, { online: false });

    expect(result.exitCode).toBe(0);
    expect(result.run.online.unchecked).toBeUndefined();
    expect(result.run.couldNotRun).toBeUndefined();
  });

  test('U15 a budget spent before the asymmetry step names the queued low typosquat with that step', async () => {
    const dir = initRepo();
    write(dir, 'package.json', JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { lodash: '^4.17.21' } }));
    write(dir, 'package-lock.json', npmLock({ 'node_modules/lodash': LODASH_ENTRY }));
    commit(dir, 'base');
    tag(dir, 'base');
    write(
      dir,
      'package.json',
      JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { lodash: '^4.17.21', lodahs: '^1.0.0' } })
    );
    commit(dir, 'head');
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    fetchPackumentMock.mockImplementation(async () => {
      now += 5_000;
      return {
        createdAt: '2020-01-01T00:00:00.000Z',
        latestVersion: '1.0.0',
        latestPublishedAt: '2020-01-01T00:00:00.000Z',
        deprecated: false,
        unpublished: false,
        securityHolder: false,
        versionTimes: {},
      };
    });

    const result = await pullRequest(dir, { onlineBudgetMs: 1_000 });

    expect(entries(result)).toContainEqual({ name: 'lodahs', ecosystem: 'npm', step: 'asymmetry', reason: 'budget' });
    expect(result.exitCode).toBe(2);
  });
});
