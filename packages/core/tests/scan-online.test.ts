// Exercises scan()'s online wiring end to end against a fake registry
// client (never the real network -- pnpm test must stay fully offline and
// deterministic), using the same fixture repository shape existing scan
// tests use. Reads the fixture corpus used elsewhere in this package's
// tests so a typosquat match actually fires offline first.
//
// Mocking note: jest.spyOn cannot intercept a real ESM module's exports.
// This repo's jest config runs ts-jest in genuine ESM mode (see
// jest.config.mjs), so `import * as registryClient from
// '../src/online/registry-client.js'` yields a real Module Namespace
// Exotic Object -- its [[Set]] trap unconditionally rejects external
// assignment (ECMA-262 10.4.6), which is what jest.spyOn's mock
// installation relies on. Attempting it throws "Cannot assign to read
// only property" regardless of how the consuming module (scan.ts) imports
// the function. jest.unstable_mockModule sidesteps this by substituting
// the module in Jest's module registry before anything imports it, which
// requires scan.ts (and the mocked module itself) to be imported
// dynamically, after registration, rather than via a static top-level
// import.
import { jest } from '@jest/globals';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { scan as ScanFn, checkSingle as CheckSingleFn } from '../src/scan.js';
import type { fetchWeeklyDownloads, fetchPackument } from '../src/online/registry-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CORPUS = path.join(__dirname, '..', 'fixtures', 'corpus');

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'depguard-scan-online-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  return dir;
}

function commitManifest(dir: string, deps: Record<string, string>): void {
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: deps }));
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'update'], { cwd: dir });
}

const fetchWeeklyDownloadsMock: jest.MockedFunction<typeof fetchWeeklyDownloads> = jest.fn();
const fetchPackumentMock: jest.MockedFunction<typeof fetchPackument> = jest.fn();

// Registered before scan.js (or registry-client.js itself) is ever
// imported below -- jest.unstable_mockModule substitutes the module in
// Jest's registry at this call, so every subsequent importer (including
// scan.ts's own internal `import * as registryClient from
// './online/registry-client.js'`) resolves to this factory's object
// instead of the real module.
jest.unstable_mockModule('../src/online/registry-client.js', () => ({
  fetchWeeklyDownloads: fetchWeeklyDownloadsMock,
  fetchPackument: fetchPackumentMock,
}));

let scan: typeof ScanFn;
let checkSingle: typeof CheckSingleFn;

describe('scan(): online enrichment', () => {
  beforeEach(async () => {
    fetchWeeklyDownloadsMock.mockReset();
    fetchPackumentMock.mockReset();
    // registry-client's real fetchPackument contract is Packument | null,
    // never undefined (see registry-client.ts) -- registered-squat.ts
    // relies on that. "raect" (this file's typosquat fixture) also
    // qualifies as a newly-added registry dependency, so tests that don't
    // care about the registered-squat check still exercise this path;
    // defaulting to "not found" here keeps them from crashing on an
    // unconfigured mock while leaving individual tests free to override it.
    fetchPackumentMock.mockResolvedValue(null);

    // scan.ts keeps a process-lifetime cache singleton backed by a
    // machine-global file (defaultCachePath() reads XDG_CACHE_HOME). Left
    // alone, one test's cached "raect" download count would leak into the
    // next test via that on-disk file, silently turning a mocked-rejection
    // test (say) into a cache hit that never calls the mock at all. A
    // fresh XDG_CACHE_HOME plus a fresh module instance (resetModules,
    // then a new dynamic import -- scan.ts's `cache` singleton is only
    // reset when the module itself is re-evaluated) gives every test both
    // an empty in-memory cache and an empty on-disk one, so each test's
    // mock behavior is what actually decides the result. This also means
    // these tests never touch the developer's real ~/.cache/dep-guard.
    process.env.XDG_CACHE_HOME = mkdtempSync(path.join(tmpdir(), 'depguard-online-cache-'));
    jest.resetModules();
    ({ scan, checkSingle } = await import('../src/scan.js'));
  });

  test('online defaults off: a typosquat finding stays at its offline severity', async () => {
    const dir = initRepo();
    commitManifest(dir, {});
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    commitManifest(dir, { raect: '^1.0.0' });

    const result = await scan({ repoRoot: dir, mode: { kind: 'base', ref: 'HEAD~1' }, corpusDir: FIXTURE_CORPUS });
    expect(fetchWeeklyDownloadsMock).not.toHaveBeenCalled();
    const typosquat = result.findings.find((f) => f.ruleId === 'typosquat');
    expect(typosquat?.severity).toBe('low');
  });

  test('--online escalates a confirmed-unpopular typosquat match to high', async () => {
    fetchWeeklyDownloadsMock.mockResolvedValue(new Map([['raect', 4]]));
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { raect: '^1.0.0' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });
    const typosquat = result.findings.find((f) => f.ruleId === 'typosquat');
    expect(typosquat?.severity).toBe('high');
  });

  test('--online adds a registered-squat finding for a young, unpopular new dependency', async () => {
    fetchWeeklyDownloadsMock.mockResolvedValue(new Map([['some-brand-new-thing', 2]]));
    fetchPackumentMock.mockResolvedValue({
      createdAt: new Date().toISOString(),
      latestVersion: '0.0.1',
      latestPublishedAt: new Date().toISOString(),
      deprecated: false,
    });
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { 'some-brand-new-thing': '^0.0.1' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });
    expect(result.findings.some((f) => f.ruleId === 'registered-squat')).toBe(true);
  });

  test('config online:true turns it on without the flag', async () => {
    fetchWeeklyDownloadsMock.mockResolvedValue(new Map([['raect', 4]]));
    const dir = initRepo();
    writeFileSync(path.join(dir, '.dep-guard.json'), JSON.stringify({ online: true }));
    commitManifest(dir, {});
    commitManifest(dir, { raect: '^1.0.0' });

    const result = await scan({ repoRoot: dir, mode: { kind: 'base', ref: 'HEAD~1' }, corpusDir: FIXTURE_CORPUS });
    const typosquat = result.findings.find((f) => f.ruleId === 'typosquat');
    expect(typosquat?.severity).toBe('high');
  });

  test('the online:false CLI override wins over an online:true config', async () => {
    const dir = initRepo();
    writeFileSync(path.join(dir, '.dep-guard.json'), JSON.stringify({ online: true }));
    commitManifest(dir, {});
    commitManifest(dir, { raect: '^1.0.0' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: false,
    });
    expect(fetchWeeklyDownloadsMock).not.toHaveBeenCalled();
    const typosquat = result.findings.find((f) => f.ruleId === 'typosquat');
    expect(typosquat?.severity).toBe('low');
  });

  test('checkSingle honors --online the same way scan() does', async () => {
    fetchWeeklyDownloadsMock.mockResolvedValue(new Map([['raect', 4]]));
    const dir = initRepo();
    commitManifest(dir, {});

    const result = await checkSingle({ repoRoot: dir, name: 'raect', corpusDir: FIXTURE_CORPUS, online: true });
    const typosquat = result.findings.find((f) => f.ruleId === 'typosquat');
    expect(typosquat?.severity).toBe('high');
  });

  test('a fetch failure degrades cleanly: offline findings survive, a diagnostic is added', async () => {
    fetchWeeklyDownloadsMock.mockRejectedValue(new Error('socket hang up'));
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { raect: '^1.0.0' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
      // "raect" is not itself in the fixture corpus (only "react" is), so
      // the unrelated existence check also reports it as an
      // unknown-package finding at 'high' -- true regardless of --online,
      // since existenceCheck is one of the six offline checks this task
      // does not touch. failOn is raised here so that pre-existing, this-
      // package's-own-name-shaped finding does not confound what this
      // test actually verifies: that a failed online fetch does not
      // itself introduce anything blocking. (typosquat, the finding under
      // test, tops out at 'high' when escalated and never reaches
      // 'critical' either way.)
      failOn: 'critical',
    });
    const typosquat = result.findings.find((f) => f.ruleId === 'typosquat');
    expect(typosquat?.severity).toBe('low');
    expect(result.run.diagnostics.some((d) => d.code === 'online-check-unreachable')).toBe(true);
    expect(result.exitCode).toBe(0); // typosquat stayed low; the failed fetch did not itself escalate or block
  });
});
