// Exercises the publish-age check through scan()'s real wiring: real
// computeDelta against real lockfiles, against a fake registry client
// (never the real network -- pnpm test must stay fully offline and
// deterministic). This is where "base mode inspects only added/changed,
// audit mode inspects all" is actually falsifiable -- online-publish-age.test.ts
// drives findPublishAgeFindings directly against a hand-built
// ctx.delta.lockEntryChanges, which proves the check consumes that array
// correctly but says nothing about how delta.ts populates it. Only a real
// computeDelta run, across two real lockfiles, can prove the "unchanged
// dependency never becomes a candidate in base mode, but does in audit
// mode" property this check depends on.
//
// Same jest.unstable_mockModule reasoning as scan-online.test.ts (a real
// ESM module's exports cannot be jest.spyOn'd), and a separate mock
// registration from that file's, since Jest isolates the module registry
// per test file.
import { jest } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { scan as ScanFn } from '../src/scan.js';
import type { fetchWeeklyDownloads, fetchPackument } from '../src/online/registry-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CORPUS = path.join(__dirname, '..', 'fixtures', 'corpus');

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'depguard-publish-age-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  return dir;
}

function lockJson(dependencies: Record<string, string>): string {
  const packages: Record<string, unknown> = {
    '': { name: 'root', version: '1.0.0', dependencies },
  };
  for (const [name, version] of Object.entries(dependencies)) {
    packages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      integrity: `sha512-${name}-${version}`,
    };
  }
  return JSON.stringify(
    { name: 'root', version: '1.0.0', lockfileVersion: 3, requires: true, packages },
    null,
    2
  );
}

function commit(dir: string, dependencies: Record<string, string>): void {
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies }));
  writeFileSync(path.join(dir, 'package-lock.json'), lockJson(dependencies));
  execFileSync('git', ['add', '.'], { cwd: dir });
  // --allow-empty: one test commits identical content twice on purpose, to
  // prove an unchanged dependency across the diff is never a candidate, and
  // a no-op commit would otherwise fail with "nothing to commit".
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'update'], { cwd: dir });
}

const fetchWeeklyDownloadsMock: jest.MockedFunction<typeof fetchWeeklyDownloads> = jest.fn();
const fetchPackumentMock: jest.MockedFunction<typeof fetchPackument> = jest.fn();

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

// Computed against the REAL wall clock, not a fixed literal: scan() calls
// findPublishAgeFindings with no injected `now` (only online-publish-age.test.ts's
// unit-level tests inject one), so this file's "fresh" and "old" dates have
// to stay fresh and old relative to whenever the suite actually runs.
// Three days old and sixty days old, against the default 7-day floor.
const FRESH_DATE = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
const OLD_DATE = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

describe('scan(): publish-age through the real delta', () => {
  beforeEach(async () => {
    fetchWeeklyDownloadsMock.mockReset();
    fetchPackumentMock.mockReset();
    fetchWeeklyDownloadsMock.mockResolvedValue({ counts: new Map(), noRecord: new Set() });
    fetchPackumentMock.mockResolvedValue(null);
    process.env.XDG_CACHE_HOME = mkdtempSync(path.join(tmpdir(), 'depguard-publish-age-cache-'));
    jest.resetModules();
    ({ scan } = await import('../src/scan.js'));
  });

  test('base mode: an unchanged dependency across the diff is never a candidate, even though its publish date is fresh', async () => {
    fetchPackumentMock.mockImplementation(async (name: string) => {
      if (name === 'unchanged-thing') {
        return {
          createdAt: OLD_DATE,
          latestVersion: '1.0.0',
          latestPublishedAt: FRESH_DATE,
          deprecated: false,
          unpublished: false,
          securityHolder: false,
          versionTimes: { '1.0.0': FRESH_DATE },
        };
      }
      return null;
    });
    const dir = initRepo();
    commit(dir, { 'unchanged-thing': '1.0.0' });
    commit(dir, { 'unchanged-thing': '1.0.0' }); // no change at all between the two commits

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    expect(result.findings.some((f) => f.ruleId === 'publish-age')).toBe(false);
  });

  test('base mode: a version bump between the two commits is a candidate, and a fresh one flags', async () => {
    fetchPackumentMock.mockImplementation(async (name: string) => {
      if (name === 'bumped-thing') {
        return {
          createdAt: OLD_DATE,
          latestVersion: '2.0.0',
          latestPublishedAt: FRESH_DATE,
          deprecated: false,
          unpublished: false,
          securityHolder: false,
          versionTimes: { '1.0.0': OLD_DATE, '2.0.0': FRESH_DATE },
        };
      }
      return null;
    });
    const dir = initRepo();
    commit(dir, { 'bumped-thing': '1.0.0' });
    commit(dir, { 'bumped-thing': '2.0.0' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    const finding = result.findings.find((f) => f.ruleId === 'publish-age');
    expect(finding).toMatchObject({ packageName: 'bumped-thing', details: { version: '2.0.0' } });
  });

  test('audit mode: every resolved dependency is a candidate, including one that never changed', async () => {
    fetchPackumentMock.mockImplementation(async (name: string) => {
      if (name === 'first-ever-scan-thing') {
        return {
          createdAt: OLD_DATE,
          latestVersion: '1.0.0',
          latestPublishedAt: FRESH_DATE,
          deprecated: false,
          unpublished: false,
          securityHolder: false,
          versionTimes: { '1.0.0': FRESH_DATE },
        };
      }
      return null;
    });
    const dir = initRepo();
    commit(dir, { 'first-ever-scan-thing': '1.0.0' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'audit' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    const finding = result.findings.find((f) => f.ruleId === 'publish-age');
    expect(finding).toMatchObject({ packageName: 'first-ever-scan-thing', details: { version: '1.0.0' } });
  });

  test('the check is skipped without --online', async () => {
    fetchPackumentMock.mockResolvedValue({
      createdAt: OLD_DATE,
      latestVersion: '2.0.0',
      latestPublishedAt: FRESH_DATE,
      deprecated: false,
      unpublished: false,
      securityHolder: false,
      versionTimes: { '1.0.0': OLD_DATE, '2.0.0': FRESH_DATE },
    });
    const dir = initRepo();
    commit(dir, { 'bumped-thing': '1.0.0' });
    commit(dir, { 'bumped-thing': '2.0.0' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: false,
    });

    expect(result.findings.some((f) => f.ruleId === 'publish-age')).toBe(false);
    expect(fetchPackumentMock).not.toHaveBeenCalled();
  });

  test('a repository-level minAgeDays override reaches the check end to end', async () => {
    // A publish date that is old enough to pass the default 7-day floor
    // but not a repository that opted into a much longer cooldown.
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    fetchPackumentMock.mockImplementation(async (name: string) => {
      if (name === 'moderately-fresh-thing') {
        return {
          createdAt: OLD_DATE,
          latestVersion: '1.0.0',
          latestPublishedAt: twentyDaysAgo,
          deprecated: false,
          unpublished: false,
          securityHolder: false,
          versionTimes: { '1.0.0': twentyDaysAgo },
        };
      }
      return null;
    });
    const dir = initRepo();
    writeFileSync(path.join(dir, '.dep-guard.json'), JSON.stringify({ minAgeDays: 30 }));
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'config'], { cwd: dir });
    commit(dir, { 'moderately-fresh-thing': '1.0.0' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'audit' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    const finding = result.findings.find((f) => f.ruleId === 'publish-age');
    expect(finding).toMatchObject({ packageName: 'moderately-fresh-thing', details: { minAgeDays: 30 } });
  });

  test('a version published after the cached time map was written still flags, from exactly two fetches', async () => {
    // Regression for the cache fail-open found in review of #58:
    // cachedFetchPackumentVersionTimes (scan.ts) used to serve a cached
    // version-times map for up to a full day even when the map predated a
    // version this call was actually asked about. Run 1 caches a map that
    // only knows 0.9.0 and 1.0.0; the registry then gains 1.0.1, published
    // an hour ago; run 2 bumps the lockfile to 1.0.1, which the stale cache
    // entry has never heard of. The fix bypasses the cache and refetches
    // live whenever a requested version is missing from the cached map, so
    // this must still flag -- and must cost exactly one fetch per run (two
    // in total), not one per candidate, since a cache HIT never triggers a
    // second request and a cache MISS still asks about "thing" only once.
    let versionTimes: Record<string, string> = { '0.9.0': OLD_DATE, '1.0.0': OLD_DATE };
    fetchPackumentMock.mockImplementation(async (name: string) =>
      name === 'thing'
        ? {
            createdAt: OLD_DATE,
            latestVersion: '1.0.0',
            latestPublishedAt: OLD_DATE,
            deprecated: false,
            unpublished: false,
            securityHolder: false,
            versionTimes,
          }
        : null
    );
    const dir = initRepo();
    commit(dir, { thing: '0.9.0' });
    commit(dir, { thing: '1.0.0' });

    const first = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });
    expect(first.findings.some((f) => f.ruleId === 'publish-age')).toBe(false);
    expect(fetchPackumentMock).toHaveBeenCalledTimes(1);

    // 1.0.1 is published one hour ago, after the map above was cached.
    const FRESH = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    versionTimes = { '0.9.0': OLD_DATE, '1.0.0': OLD_DATE, '1.0.1': FRESH };
    commit(dir, { thing: '1.0.1' });

    const second = await scan({
      repoRoot: dir,
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    expect(second.findings.find((f) => f.ruleId === 'publish-age')).toMatchObject({
      details: { version: '1.0.1' },
    });
    expect(fetchPackumentMock).toHaveBeenCalledTimes(2);
  });

  test('a repository-level minAgeAllow override reaches the check end to end', async () => {
    fetchPackumentMock.mockImplementation(async (name: string) => {
      if (name === 'reviewed-release-thing') {
        return {
          createdAt: OLD_DATE,
          latestVersion: '1.0.0',
          latestPublishedAt: FRESH_DATE,
          deprecated: false,
          unpublished: false,
          securityHolder: false,
          versionTimes: { '1.0.0': FRESH_DATE },
        };
      }
      return null;
    });
    const dir = initRepo();
    writeFileSync(
      path.join(dir, '.dep-guard.json'),
      JSON.stringify({ minAgeAllow: ['reviewed-release-thing@1.0.0'] })
    );
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'config'], { cwd: dir });
    commit(dir, { 'reviewed-release-thing': '1.0.0' });

    const result = await scan({
      repoRoot: dir,
      mode: { kind: 'audit' },
      corpusDir: FIXTURE_CORPUS,
      online: true,
    });

    expect(result.findings.some((f) => f.ruleId === 'publish-age')).toBe(false);
  });
});
