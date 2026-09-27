// Exercises scan()'s online wiring end to end against a fake registry
// client (never the real network -- pnpm test must stay fully offline and
// deterministic), using the same fixture repository shape existing scan
// tests use. Reads the fixture corpus used elsewhere in this package's
// tests so a typosquat match actually fires offline first.
//
// Mocking note: jest.spyOn cannot intercept a real ESM module's exports.
// This repo's jest config runs ts-jest in genuine ESM mode (see
// jest.config.mjs), so `import * as ns from '../src/online/registry-client.js'`
// yields a real Module Namespace Exotic Object -- its [[Set]] trap
// unconditionally rejects external assignment (ECMA-262 10.4.6), which is
// what jest.spyOn's mock installation relies on. Attempting it throws
// "Cannot assign to read only property" regardless of how the consuming
// module (scan.ts) imports the function -- scan.ts uses plain named
// imports, same as every other module in this package. jest.unstable_mockModule
// sidesteps this by substituting the module in Jest's module registry
// before anything imports it, which requires scan.ts (and the mocked
// module itself) to be imported dynamically, after registration, rather
// than via a static top-level import.
import { jest } from '@jest/globals';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { scan as ScanFn, checkSingle as CheckSingleFn } from '../src/scan.js';
import type { fetchWeeklyDownloads, fetchPackument } from '../src/online/registry-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CORPUS = path.join(__dirname, '..', 'fixtures', 'corpus');
const OFFLINE_GOLDEN_FIXTURE = path.join(
  __dirname,
  '..',
  'fixtures',
  'scan-online-offline-golden.json'
);

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

// A minimal npm lockfile v3, the same shape trust-base.test.ts's own
// lockJson helper builds. Needed here, and not by commitManifest above,
// because findPublishAgeFindings (online/publish-age.ts) reads
// ctx.delta.lockEntryChanges, not the manifest -- a manifest-only commit
// never gives it a single candidate, which is exactly why a whole packument
// increment site (cachedFetchPackumentVersionTimes) could be deleted from
// scan.ts and every test in this file would still stay green (found in
// review of issue #75's first round).
function lockJson(dependencies: Record<string, string>): string {
  const packages: Record<string, unknown> = {
    '': { name: 'x', version: '1.0.0', dependencies },
  };
  for (const name of Object.keys(dependencies)) {
    packages[`node_modules/${name}`] = {
      version: '1.0.0',
      resolved: `https://registry.npmjs.org/${name}/-/pkg-1.0.0.tgz`,
      integrity: 'sha512-notreal',
    };
  }
  return JSON.stringify({ name: 'x', version: '1.0.0', lockfileVersion: 3, requires: true, packages });
}

function commitManifestWithLock(dir: string, deps: Record<string, string>): void {
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: deps }));
  writeFileSync(path.join(dir, 'package-lock.json'), lockJson(deps));
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
  // online/publish-age.ts reads this constant directly (its
  // private-registry-leak guard), so a mock that replaces the whole module
  // has to carry it too, or importing publish-age.ts through scan.ts throws
  // at import time rather than merely serving fake data. The literal has to
  // match registry-client.ts's own DEFAULT_REGISTRY exactly.
  DEFAULT_REGISTRY: 'https://registry.npmjs.org',
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
    fetchWeeklyDownloadsMock.mockResolvedValue({ counts: new Map([['raect', 4]]), noRecord: new Set() });
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
    fetchWeeklyDownloadsMock.mockResolvedValue({ counts: new Map([['some-brand-new-thing', 2]]), noRecord: new Set() });
    fetchPackumentMock.mockResolvedValue({
      createdAt: new Date().toISOString(),
      latestVersion: '0.0.1',
      latestPublishedAt: new Date().toISOString(),
      deprecated: false,
      unpublished: false,
      securityHolder: false,
      // Deliberately empty: these tests are about registered-squat, not
      // publish-age, and an empty map means publish-age's own online step
      // (also driven by this same mocked fetchPackument) finds no
      // timestamp for whatever version is under test and stays silent
      // rather than inventing a signal these tests do not assert on.
      versionTimes: {},
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

  test('--online adds a registered-squat finding when npm confirms it has no download record at all', async () => {
    // The headline zero-download-blindness case, exercised through the
    // real cachedFetchWeeklyDownloads wiring rather than a check-level
    // fake: a name absent from counts but present in noRecord (npm
    // answered and explicitly said "nothing on record") must still
    // escalate, not be skipped.
    fetchWeeklyDownloadsMock.mockResolvedValue({
      counts: new Map(),
      noRecord: new Set(['totally-made-up-hallucinated-xyz123']),
    });
    fetchPackumentMock.mockResolvedValue({
      createdAt: new Date().toISOString(),
      latestVersion: '0.0.1',
      latestPublishedAt: new Date().toISOString(),
      deprecated: false,
      unpublished: false,
      securityHolder: false,
      // Deliberately empty: these tests are about registered-squat, not
      // publish-age, and an empty map means publish-age's own online step
      // (also driven by this same mocked fetchPackument) finds no
      // timestamp for whatever version is under test and stays silent
      // rather than inventing a signal these tests do not assert on.
      versionTimes: {},
    });
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { 'totally-made-up-hallucinated-xyz123': '^0.0.1' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });
    expect(result.findings.some((f) => f.ruleId === 'registered-squat')).toBe(true);
  });

  test('--online does not invent a registered-squat finding behind an unresolved absence', async () => {
    // A name absent from BOTH counts and noRecord is unresolved, not a
    // confirmed zero, regardless of what upstream cause produced it (this
    // test mocks the whole registry-client module, so it exercises
    // scan()'s wiring against that result directly rather than any
    // particular upstream cause). This must not mint a finding even
    // though the candidate is otherwise young enough to qualify.
    fetchWeeklyDownloadsMock.mockResolvedValue({ counts: new Map(), noRecord: new Set() });
    fetchPackumentMock.mockResolvedValue({
      createdAt: new Date().toISOString(),
      latestVersion: '0.0.1',
      latestPublishedAt: new Date().toISOString(),
      deprecated: false,
      unpublished: false,
      securityHolder: false,
      // Deliberately empty: these tests are about registered-squat, not
      // publish-age, and an empty map means publish-age's own online step
      // (also driven by this same mocked fetchPackument) finds no
      // timestamp for whatever version is under test and stays silent
      // rather than inventing a signal these tests do not assert on.
      versionTimes: {},
    });
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { 'ambiguous-new-thing': '^0.0.1' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });
    expect(result.findings.some((f) => f.ruleId === 'registered-squat')).toBe(false);
  });

  test('a real count in the fetch result is never overwritten by noRecord, even from a malformed result carrying the same name in both', async () => {
    // scan.ts's cachedFetchWeeklyDownloads iterates fetched.counts before
    // fetched.noRecord and writes noRecord entries as a cached 0 -- so a
    // malformed fetch result carrying the SAME name in both sets (which
    // registry-client.ts's own intersection guard should prevent, but
    // this wrapper does not get to assume its caller is well-behaved)
    // must not let the noRecord pass overwrite the real count with a
    // fabricated zero and cache that zero for 24 hours. The candidate's
    // real count (5) is well below the registered-squat floor either way,
    // so this asserts on the finding's own weeklyDownloads detail --
    // the only way to tell "5 survived" apart from "0 overwrote it".
    fetchWeeklyDownloadsMock.mockResolvedValue({
      counts: new Map([['both-sets-thing', 5]]),
      noRecord: new Set(['both-sets-thing']),
    });
    fetchPackumentMock.mockResolvedValue({
      createdAt: new Date().toISOString(),
      latestVersion: '0.0.1',
      latestPublishedAt: new Date().toISOString(),
      deprecated: false,
      unpublished: false,
      securityHolder: false,
      // Deliberately empty: these tests are about registered-squat, not
      // publish-age, and an empty map means publish-age's own online step
      // (also driven by this same mocked fetchPackument) finds no
      // timestamp for whatever version is under test and stays silent
      // rather than inventing a signal these tests do not assert on.
      versionTimes: {},
    });
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { 'both-sets-thing': '^0.0.1' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });
    const finding = result.findings.find((f) => f.ruleId === 'registered-squat');
    expect(finding?.details).toMatchObject({ weeklyDownloads: 5 });
  });

  test('config online:true turns it on without the flag', async () => {
    fetchWeeklyDownloadsMock.mockResolvedValue({ counts: new Map([['raect', 4]]), noRecord: new Set() });
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
    fetchWeeklyDownloadsMock.mockResolvedValue({ counts: new Map([['raect', 4]]), noRecord: new Set() });
    const dir = initRepo();
    commitManifest(dir, {});

    const result = await checkSingle({ repoRoot: dir, name: 'raect', corpusDir: FIXTURE_CORPUS, online: true });
    const typosquat = result.findings.find((f) => f.ruleId === 'typosquat');
    expect(typosquat?.severity).toBe('high');
  });

  test('a fetch failure degrades cleanly: offline findings survive, a diagnostic is added, exit code is unaffected', async () => {
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { raect: '^1.0.0' });

    // "raect" is not itself in the fixture corpus (only "react" is), so
    // the unrelated existence check also reports it as an unknown-package
    // finding at 'high' -- true regardless of --online, since
    // existenceCheck is one of the six offline checks this task does not
    // touch. That means a plain "exitCode is 0" assertion on the online
    // run can never actually hold here, and asserting a raised failOn
    // instead (an earlier version of this test did) would be vacuous:
    // nothing reachable in this scenario is 'critical' either, so it
    // could never fail. The real, falsifiable contract is comparative --
    // a degraded online failure changes nothing about the exit code, so
    // the SAME scenario run online (with the fetch mocked to reject) has
    // to produce the SAME exit code as running it offline, default
    // failOn both times.
    const offlineResult = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: false,
    });

    fetchWeeklyDownloadsMock.mockRejectedValue(new Error('socket hang up'));
    const onlineResult = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    const typosquat = onlineResult.findings.find((f) => f.ruleId === 'typosquat');
    expect(typosquat?.severity).toBe('low');
    expect(onlineResult.run.diagnostics.some((d) => d.code === 'online-check-unreachable')).toBe(true);
    expect(onlineResult.exitCode).toBe(offlineResult.exitCode);
  });

  test('a 404 packument lookup does not permanently cache a package as unregistered', async () => {
    // Regression coverage for a real bug: cachedFetchPackument used to
    // cache a MISSING creation date (packument null, i.e. a 404) with no
    // expiry, pinning "created: null" for the life of the on-disk cache
    // file. That silently defeated the registered-squat check's whole
    // purpose -- a hallucinated name that 404s today can be
    // attacker-registered tomorrow and absorbed by a later corpus
    // refresh, and a machine that had queried the name while it was still
    // unregistered would never flag it again. This test runs scan() twice
    // against the SAME module instance (this file's beforeEach gives each
    // TEST a fresh cache, but does not reset it between two scan() calls
    // within one test), so both calls share one cache the way two real
    // scans of the same repo on one machine would.
    fetchWeeklyDownloadsMock.mockResolvedValue({ counts: new Map([['some-fresh-thing', 2]]), noRecord: new Set() });
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { 'some-fresh-thing': '^0.0.1' });

    // beforeEach's fetchPackumentMock default (resolves null) simulates a
    // 404: this name is not registered yet.
    const firstResult = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });
    expect(firstResult.findings.some((f) => f.ruleId === 'registered-squat')).toBe(false);

    // The name gets attacker-registered between scans. If the first
    // lookup's null had been cached, this second scan would read that
    // stale "created: null" back out of the cache instead of calling
    // fetchPackument again, and would stay silent forever.
    //
    // mockResolvedValue rather than mockResolvedValueOnce: as of 0.2.0
    // the unknown-package resolver asks the registry about this same name
    // too, and runs first, so a one-shot mock would be consumed by that
    // call and registered-squat would still see the default null. Both
    // callers ask about one name and in production both get one answer,
    // which is what this now models.
    fetchPackumentMock.mockResolvedValue({
      createdAt: new Date().toISOString(),
      latestVersion: '0.0.1',
      latestPublishedAt: new Date().toISOString(),
      deprecated: false,
      unpublished: false,
      securityHolder: false,
      // Deliberately empty: these tests are about registered-squat, not
      // publish-age, and an empty map means publish-age's own online step
      // (also driven by this same mocked fetchPackument) finds no
      // timestamp for whatever version is under test and stays silent
      // rather than inventing a signal these tests do not assert on.
      versionTimes: {},
    });
    const secondResult = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });
    expect(secondResult.findings.some((f) => f.ruleId === 'registered-squat')).toBe(true);
  });
});

// The unknown-package rule is the one --online could not touch before
// 0.2.0, and it is the one that blocks. These tests exercise it through
// the real scan() wiring (config, delta, the shared cache, the gate)
// rather than against the resolver in isolation -- the unit tests in
// online-unknown-package.test.ts cover the resolver's own branches.
describe('scan(): --online resolves unknown-package against the registry', () => {
  beforeEach(async () => {
    fetchWeeklyDownloadsMock.mockReset();
    fetchPackumentMock.mockReset();
    fetchPackumentMock.mockResolvedValue(null);
    fetchWeeklyDownloadsMock.mockResolvedValue({ counts: new Map(), noRecord: new Set() });
    process.env.XDG_CACHE_HOME = mkdtempSync(path.join(tmpdir(), 'depguard-online-cache-'));
    jest.resetModules();
    ({ scan, checkSingle } = await import('../src/scan.js'));
  });

  test('a name the registry knows about stands its unknown-package finding down', async () => {
    fetchPackumentMock.mockResolvedValue({
      createdAt: '2020-01-01T00:00:00.000Z',
      latestVersion: '3.0.0',
      latestPublishedAt: '2026-08-01T00:00:00.000Z',
      deprecated: false,
      unpublished: false,
      securityHolder: false,
      versionTimes: {},
    });
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { 'published-after-the-corpus-walk': '^1.0.0' });

    const offline = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: false,
    });
    expect(offline.findings.some((f) => f.ruleId === 'unknown-package')).toBe(true);
    expect(offline.exitCode).toBe(1);

    const online = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });
    // The finding SURVIVES, downgraded to low. The corpus really is stale
    // about this name and that is worth saying; what changes is that it
    // no longer blocks.
    const downgraded = online.findings.find((f) => f.ruleId === 'unknown-package');
    expect(downgraded).toBeDefined();
    expect(downgraded?.severity).toBe('low');
    expect(downgraded?.details).toMatchObject({ onlineResolution: 'registry-present' });
    // The exit code is the behaviour a user actually feels: low sits below
    // the default medium gate, so the run that was failing now passes
    // without the finding having been thrown away.
    expect(online.exitCode).toBe(0);
    expect(online.run.blockingMatches).toBe(0);
    // And it is still in the report, so a JSON or SARIF consumer can see
    // that dep-guard looked at this name and what it concluded.
    expect(online.findings.length).toBe(offline.findings.length);
  });

  test('a downgraded finding keeps the fingerprint the offline scan gave it', async () => {
    fetchPackumentMock.mockResolvedValue({
      createdAt: '2020-01-01T00:00:00.000Z',
      latestVersion: '3.0.0',
      latestPublishedAt: '2026-08-01T00:00:00.000Z',
      deprecated: false,
      unpublished: false,
      securityHolder: false,
      versionTimes: {},
    });
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { 'published-after-the-corpus-walk': '^1.0.0' });

    const offline = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: false,
    });
    const online = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    const offlineFinding = offline.findings.find((f) => f.ruleId === 'unknown-package');
    const onlineFinding = online.findings.find((f) => f.ruleId === 'unknown-package');
    expect(onlineFinding?.severity).toBe('low');
    expect(onlineFinding?.fingerprint).toBe(offlineFinding?.fingerprint);
  });

  test('standing unknown-package down leaves the typosquat finding for the same name', async () => {
    // "raect" trips both rules offline: it is absent from the fixture
    // corpus (unknown-package, high) and resembles "react" (typosquat,
    // low). A registry that knows the name settles the first question and
    // says nothing at all about the second.
    fetchPackumentMock.mockResolvedValue({
      createdAt: '2026-08-01T00:00:00.000Z',
      latestVersion: '1.0.0',
      latestPublishedAt: '2026-08-01T00:00:00.000Z',
      deprecated: false,
      unpublished: false,
      securityHolder: false,
      versionTimes: {},
    });
    fetchWeeklyDownloadsMock.mockResolvedValue({
      counts: new Map([['raect', 999_999]]),
      noRecord: new Set(),
    });
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { raect: '^1.0.0' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    expect(result.findings.find((f) => f.ruleId === 'unknown-package')?.severity).toBe('low');
    const typosquat = result.findings.find((f) => f.ruleId === 'typosquat');
    expect(typosquat).toBeDefined();
    expect(typosquat?.severity).toBe('low');
  });

  test('a 404 escalates unknown-package to critical, and the gate follows', async () => {
    fetchPackumentMock.mockResolvedValue(null);
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { 'definitely-not-a-real-package-xyz': '^1.0.0' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
      failOn: 'critical',
    });

    const finding = result.findings.find((f) => f.ruleId === 'unknown-package');
    expect(finding?.severity).toBe('critical');
    // failOn 'critical' is the falsifiable part: offline the finding is
    // 'high' and would NOT block at this threshold, so a run that blocks
    // here can only be blocking on the escalation.
    expect(result.exitCode).toBe(1);
    expect(result.run.blockingMatches).toBe(1);
  });

  test('the escalated finding keeps the fingerprint the offline scan gave it', async () => {
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { 'definitely-not-a-real-package-xyz': '^1.0.0' });

    const offline = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: false,
    });
    const online = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    const offlineFinding = offline.findings.find((f) => f.ruleId === 'unknown-package');
    const onlineFinding = online.findings.find((f) => f.ruleId === 'unknown-package');
    expect(onlineFinding?.severity).toBe('critical');
    expect(onlineFinding?.fingerprint).toBe(offlineFinding?.fingerprint);
  });

  test('a registry failure leaves unknown-package exactly as the offline scan had it', async () => {
    fetchPackumentMock.mockRejectedValue(new Error('ETIMEDOUT'));
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { 'some-unknown-thing': '^1.0.0' });

    const offline = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: false,
    });
    const online = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    const offlineFinding = offline.findings.find((f) => f.ruleId === 'unknown-package');
    const onlineFinding = online.findings.find((f) => f.ruleId === 'unknown-package');
    expect(onlineFinding?.severity).toBe(offlineFinding?.severity);
    expect(onlineFinding?.message).toBe(offlineFinding?.message);
    expect(online.exitCode).toBe(offline.exitCode);
    expect(online.run.diagnostics.some((d) => d.code === 'online-check-unreachable')).toBe(true);
    expect(onlineFinding?.details).toMatchObject({ onlineResolution: 'unreachable' });
  });

  test('a name in a configured internal scope is never asked about', async () => {
    // internalScopes already keeps existenceCheck quiet about internal
    // names, so this asserts the stronger property the online path owes:
    // no request is made for the name at all, whatever any finding says.
    const dir = initRepo();
    writeFileSync(
      path.join(dir, '.dep-guard.json'),
      JSON.stringify({ internalScopes: ['@acme'] })
    );
    commitManifest(dir, {});
    commitManifest(dir, { '@acme/private-thing': '^1.0.0' });

    await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    for (const call of fetchPackumentMock.mock.calls) {
      expect(call[0]).not.toBe('@acme/private-thing');
    }
    for (const call of fetchWeeklyDownloadsMock.mock.calls) {
      expect(call[0]).not.toContain('@acme/private-thing');
    }
  });

  test('offline output is unchanged by all of this, field for field', async () => {
    // The whole online subsystem is additive. durationMs is the only field
    // that legitimately moves between runs, so it is the only one excluded
    // from both comparisons below.
    //
    // MUTATION-CHECKED 2026-09-02. This test used to compare two same-process
    // scan() calls (both with online: false) against EACH OTHER instead of
    // against a fixed expectation. That self-comparison cannot detect a bug
    // in the offline path itself: mutating typosquat.ts's severityFor to
    // return 'medium' instead of 'low' for a non-alias match (a one-line
    // change, reverted immediately after) changed both same-process calls
    // identically, so `strip(second) === strip(first)` kept passing -- the
    // whole suite still went from 22 to 15 passing, but this specific test
    // was among the 15, not among the 7 that caught it. Confirmed by running
    // the mutation with `-t "offline output is unchanged"` in isolation: 1
    // passed, 0 failed.
    //
    // Fix: compare against OFFLINE_GOLDEN_FIXTURE, a committed JSON snapshot
    // of the real offline ScanResult for this exact scenario (durationMs
    // zeroed the same way). Re-running the identical severityFor mutation
    // with the golden comparison in place now fails this test directly, on
    // the typosquat finding's severity field ("low" expected, "medium"
    // received) -- see the git history of this file for the transcript. The
    // same-process double-call is kept alongside it (renamed `first`/
    // `second`) because it still catches a different bug class: nondeterminism
    // that a golden fixture alone would not surface (two calls disagreeing
    // with each other even if neither matches the fixture).
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { raect: '^1.0.0', 'some-unknown-thing': '^1.0.0' });

    const first = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: false,
    });
    const second = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: false,
    });

    expect(fetchPackumentMock).not.toHaveBeenCalled();
    expect(fetchWeeklyDownloadsMock).not.toHaveBeenCalled();
    const strip = (r: typeof first) => JSON.stringify({ ...r, run: { ...r.run, durationMs: 0 } });
    expect(strip(second)).toBe(strip(first));
    const golden = JSON.parse(readFileSync(OFFLINE_GOLDEN_FIXTURE, 'utf8'));
    expect(JSON.parse(strip(first))).toEqual(golden);
    // No online detail ever reaches an offline finding's details bag.
    for (const finding of first.findings) {
      expect(finding.details ?? {}).not.toHaveProperty('onlineResolution');
    }
  });

  test('a security-holding placeholder does not clear the finding, through the real wiring', async () => {
    // The case that matters most: npm seizes a name precisely because it
    // was malicious, and a 200 for a seized name used to read as "the
    // package is fine" all the way through scan().
    fetchPackumentMock.mockResolvedValue({
      createdAt: '2019-01-01T00:00:00.000Z',
      latestVersion: '0.0.1-security',
      latestPublishedAt: '2019-01-02T00:00:00.000Z',
      deprecated: false,
      unpublished: false,
      securityHolder: true,
      versionTimes: {},
    });
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { 'seized-name-xyz': '^1.0.0' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    const finding = result.findings.find((f) => f.ruleId === 'unknown-package');
    expect(finding?.severity).toBe('high');
    expect(finding?.details).toMatchObject({ onlineResolution: 'security-holder' });
    expect(result.exitCode).toBe(1);
  });

  test('existence is asked live every scan, never served from the created cache', async () => {
    // The created: cache never expires and was written for a different
    // question (registered-squat's age check). Serving this check from it
    // would mean a name that existed when some earlier scan asked reads
    // as present forever, including a name npm has since removed for
    // security reasons. Two scans in one process share one cache, so a
    // second scan reaching the network is the observable property.
    fetchPackumentMock.mockResolvedValue({
      createdAt: '2020-01-01T00:00:00.000Z',
      latestVersion: '1.0.0',
      latestPublishedAt: '2020-01-01T00:00:00.000Z',
      deprecated: false,
      unpublished: false,
      securityHolder: false,
      versionTimes: {},
    });
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { 'cached-name-thing': '^1.0.0' });

    const options = {
      repoRoot: dir,
      mode: { kind: 'base' as const, ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    };
    await scan(options);
    const callsAfterFirst = fetchPackumentMock.mock.calls.filter(
      (c) => c[0] === 'cached-name-thing'
    ).length;
    await scan(options);
    const callsAfterSecond = fetchPackumentMock.mock.calls.filter(
      (c) => c[0] === 'cached-name-thing'
    ).length;

    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);
  });

  test('checkSingle resolves its unknown-package finding the same way scan() does', async () => {
    fetchPackumentMock.mockResolvedValue(null);
    const dir = initRepo();
    commitManifest(dir, {});

    const result = await checkSingle({
      repoRoot: dir,
      name: 'definitely-not-a-real-package-xyz',
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    expect(result.findings.find((f) => f.ruleId === 'unknown-package')?.severity).toBe('critical');
  });
});

// Issue #75: the run-level online budget and its JSON summary
// (result.run.online). A name the fixture corpus does not know
// ("published-after-the-corpus-walk", reused from the unknown-package
// describe block above) gives resolveUnknownPackages exactly one real
// candidate, which is all these tests need: either it is looked up (a real
// mocked request, counted) or it is skipped by an already-spent deadline
// (counted the other way).
describe('scan(): run.online summary', () => {
  beforeEach(async () => {
    fetchWeeklyDownloadsMock.mockReset();
    fetchPackumentMock.mockReset();
    fetchPackumentMock.mockResolvedValue(null);
    fetchWeeklyDownloadsMock.mockResolvedValue({ counts: new Map(), noRecord: new Set() });
    process.env.XDG_CACHE_HOME = mkdtempSync(path.join(tmpdir(), 'depguard-online-cache-'));
    jest.resetModules();
    ({ scan, checkSingle } = await import('../src/scan.js'));
  });

  test('online off reports enabled:false and all zeros', async () => {
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { 'published-after-the-corpus-walk': '^1.0.0' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: false,
    });

    expect(result.run.online).toEqual({
      enabled: false,
      budgetMs: 0,
      lookupsAttempted: 0,
      lookupsSkippedByDeadline: 0,
      deadlineExceeded: false,
    });
  });

  test('the onlineBudgetMs config key is honoured', async () => {
    const dir = initRepo();
    writeFileSync(
      path.join(dir, '.dep-guard.json'),
      JSON.stringify({ online: true, onlineBudgetMs: 12345 })
    );
    commitManifest(dir, {});

    const result = await scan({ repoRoot: dir, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(result.run.online.enabled).toBe(true);
    expect(result.run.online.budgetMs).toBe(12345);
  });

  test('the --online-budget-ms flag overrides the config key', async () => {
    const dir = initRepo();
    writeFileSync(
      path.join(dir, '.dep-guard.json'),
      JSON.stringify({ online: true, onlineBudgetMs: 12345 })
    );
    commitManifest(dir, {});

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'audit' },
      corpusDir: FIXTURE_CORPUS,
      onlineBudgetMs: 999,
    });

    expect(result.run.online.budgetMs).toBe(999);
  });

  test('the default is 20000 with no --base and no --trust-base', async () => {
    const dir = initRepo();
    commitManifest(dir, {});

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'audit' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    expect(result.run.online.budgetMs).toBe(20_000);
  });

  test('the default is 300000 with --base', async () => {
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, { 'published-after-the-corpus-walk': '^1.0.0' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    expect(result.run.online.budgetMs).toBe(300_000);
  });

  test('the default is 300000 with --trust-base, even without --base', async () => {
    const dir = initRepo();
    writeFileSync(path.join(dir, '.dep-guard.json'), JSON.stringify({ failOn: 'medium' }));
    commitManifest(dir, {});
    commitManifest(dir, { 'published-after-the-corpus-walk': '^1.0.0' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'audit' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
      trustBase: 'HEAD~1',
    });

    expect(result.run.online.budgetMs).toBe(300_000);
  });

  // checkSingle has its own isPullRequestRun (scan.ts, "controls !== null"
  // -- checkSingle has no --base concept at all, only --trust-base), a
  // separate line from scan()'s own. A coverage gap in the previous round:
  // every default-budget test above went through scan(), so a mutation
  // that broke checkSingle's line specifically had nothing here to catch
  // it.
  test('checkSingle: the default is 300000 with --trust-base, even with no flag or key', async () => {
    const dir = initRepo();
    writeFileSync(path.join(dir, '.dep-guard.json'), JSON.stringify({ failOn: 'medium' }));
    commitManifest(dir, {});
    writeFileSync(path.join(dir, '.dep-guard.json'), JSON.stringify({ failOn: 'high' }));
    commitManifest(dir, {});

    const result = await checkSingle({
      repoRoot: dir,
      name: 'some-name-for-budget-default-test',
      corpusDir: FIXTURE_CORPUS,
      online: true,
      trustBase: 'HEAD~1',
    });

    expect(result.run.online.budgetMs).toBe(300_000);
  });

  // lookupsAttempted has to count NAMES, not wrapper calls or raw HTTP
  // requests -- issue #75's review found the first version counted once
  // per CALL to cachedFetchWeeklyDownloads regardless of how many names
  // were batched into it, which undercounts badly the moment more than one
  // name misses the cache in the same bulk downloads call (registered-squat
  // and the typosquat asymmetry step each issue exactly one such call for
  // every candidate they have, never one per name -- see registered-squat.ts
  // and asymmetry.ts). It also has to stay in the same unit as
  // lookupsSkippedByDeadline (already a name count, read out of the
  // diagnostics), or the two fields cannot be added to answer "how many
  // names did the online checks want to look at".
  //
  // The three tests below sum lookups the SAME way scan.ts now does --
  // every name in every downloads batch call, plus one per packument call
  // (each already for exactly one name) -- and compare that sum against
  // result.run.online.lookupsAttempted, rather than asserting a
  // hand-computed magic number. That keeps each test tied to the real
  // fetch traffic instead of to internal step-ordering details that could
  // shift for unrelated reasons.
  function namesAttemptedFromMocks(): number {
    const downloadsNames = fetchWeeklyDownloadsMock.mock.calls.reduce(
      (total, call) => total + (call[0] as string[]).length,
      0
    );
    return downloadsNames + fetchPackumentMock.mock.calls.length;
  }

  test('lookupsAttempted counts every name in one batched downloads call, not once per call', async () => {
    const names = ['brand-new-one', 'brand-new-two', 'brand-new-three'];
    // High enough to clear registered-squat's download floor, so its own
    // per-candidate packument loop never fires here -- this test isolates
    // the downloads BATCH call's own counting. The next test covers the
    // packument path, including publish-age's.
    fetchWeeklyDownloadsMock.mockResolvedValue({
      counts: new Map(names.map((name) => [name, 100_000])),
      noRecord: new Set(),
    });
    fetchPackumentMock.mockResolvedValue(null);
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, Object.fromEntries(names.map((name) => [name, '^1.0.0'])));

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    // All three names batched into exactly one bulk call, the real shape a
    // large dependency change takes -- never one call per name.
    expect(fetchWeeklyDownloadsMock).toHaveBeenCalledTimes(1);
    expect(fetchWeeklyDownloadsMock.mock.calls[0][0]).toEqual(expect.arrayContaining(names));
    expect(namesAttemptedFromMocks()).toBeGreaterThanOrEqual(3);
    expect(result.run.online.lookupsAttempted).toBe(namesAttemptedFromMocks());
  });

  test('a cache hit adds nothing to lookupsAttempted', async () => {
    const names = ['brand-new-cache-a', 'brand-new-cache-b'];
    fetchWeeklyDownloadsMock.mockResolvedValue({
      counts: new Map(names.map((name) => [name, 100_000])),
      noRecord: new Set(),
    });
    fetchPackumentMock.mockResolvedValue(null);
    const dir = initRepo();
    commitManifest(dir, {});
    commitManifest(dir, Object.fromEntries(names.map((name) => [name, '^1.0.0'])));

    const scanOpts = {
      repoRoot: dir,
      mode: { kind: 'base' as const, ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    };

    await scan(scanOpts);
    expect(fetchWeeklyDownloadsMock).toHaveBeenCalledTimes(1);
    const packumentCallsAfterFirst = fetchPackumentMock.mock.calls.length;

    // Same repo, same on-disk cache (XDG_CACHE_HOME is not reset between
    // these two calls, deliberately): both names' downloads answers are now
    // cached, so a second scan must not ask the registry again for them.
    const second = await scan(scanOpts);

    expect(fetchWeeklyDownloadsMock).toHaveBeenCalledTimes(1);
    const packumentNamesInSecondRun = fetchPackumentMock.mock.calls.length - packumentCallsAfterFirst;
    // unknown-package's existence check is deliberately never cached (see
    // liveFetchPackument's own comment), so it still contributes to the
    // second run's count; the cached downloads batch must contribute
    // nothing beyond that -- a pure cache hit adds zero.
    expect(second.run.online.lookupsAttempted).toBe(packumentNamesInSecondRun);
  });

  test('a lockfile change exercises publish-age own packument fetch, and it counts', async () => {
    fetchWeeklyDownloadsMock.mockResolvedValue({ counts: new Map(), noRecord: new Set() });
    fetchPackumentMock.mockResolvedValue({
      createdAt: '2020-01-01T00:00:00.000Z',
      latestVersion: '1.0.0',
      latestPublishedAt: new Date().toISOString(),
      deprecated: false,
      unpublished: false,
      securityHolder: false,
      versionTimes: { '1.0.0': new Date().toISOString() },
    });
    const dir = initRepo();
    commitManifestWithLock(dir, {});
    commitManifestWithLock(dir, { 'freshly-resolved-thing': '^1.0.0' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    // Proof this actually reached publish-age's own candidate loop (built
    // from ctx.delta.lockEntryChanges, which only a real lockfile change
    // populates), not just the name-only checks: a real publish-age
    // finding for the freshly-resolved, today-published version.
    expect(result.findings.some((f) => f.ruleId === 'publish-age')).toBe(true);
    expect(namesAttemptedFromMocks()).toBeGreaterThan(0);
    expect(result.run.online.lookupsAttempted).toBe(namesAttemptedFromMocks());
  });

  test('an exceeded deadline is reported: enabled, the configured budget, no lookups, and a skipped count matching the diagnostics', async () => {
    const dir = initRepo();
    writeFileSync(
      path.join(dir, '.dep-guard.json'),
      // A budget of 0 is expired from the very first question (see
      // online-deadline.test.ts), the same device that file's own unit
      // tests use to force expiry, applied here at the scan() level.
      JSON.stringify({ online: true, onlineBudgetMs: 0 })
    );
    commitManifest(dir, {});
    commitManifest(dir, { 'published-after-the-corpus-walk': '^1.0.0' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
    });

    expect(fetchPackumentMock).not.toHaveBeenCalled();
    expect(fetchWeeklyDownloadsMock).not.toHaveBeenCalled();
    expect(result.run.online.enabled).toBe(true);
    expect(result.run.online.budgetMs).toBe(0);
    expect(result.run.online.lookupsAttempted).toBe(0);
    expect(result.run.online.deadlineExceeded).toBe(true);

    // The number has to match what a human reading the diagnostics would
    // add up themselves, not a second, independently-derived count.
    const skippedFromDiagnostics = result.run.diagnostics
      .filter((d) => d.code === 'online-deadline-exceeded')
      .reduce((total, d) => {
        const match = /before (\d+) lookup/.exec(d.message);
        return total + (match ? Number(match[1]) : 0);
      }, 0);
    expect(skippedFromDiagnostics).toBeGreaterThan(0);
    expect(result.run.online.lookupsSkippedByDeadline).toBe(skippedFromDiagnostics);
  });
});
