import { findPublishAgeFindings } from '../src/online/publish-age.js';
import { createOnlineDeadline } from '../src/online/deadline.js';
import type { CheckContext, ResolvedConfig } from '../src/checks/types.js';
import type { Corpus } from '../src/corpus.js';
import type { LockEntryChange } from '../src/delta.js';
import type { Diagnostic } from '../src/types.js';

const STUB_CORPUS: Corpus = {
  hasName: () => false,
  topRank: () => null,
  aliasTargets: () => [],
  topNames: [],
  builtAt: 'test',
};

const BASE_CONFIG: ResolvedConfig = {
  failOn: 'medium',
  allow: [],
  internalScopes: [],
  internalPrefixes: [],
  extraAliases: {},
  ignorePaths: [],
  online: true,
  minAgeDays: 7,
  minAgeAllow: [],
};

function makeLockEntryChange(overrides: Partial<LockEntryChange> & { name: string }): LockEntryChange {
  return {
    name: overrides.name,
    packageName: overrides.packageName ?? overrides.name,
    kind: overrides.kind ?? 'added',
    manifestPath: overrides.manifestPath ?? 'package.json',
    lockfilePath: overrides.lockfilePath ?? 'package-lock.json',
    before: overrides.before,
    after: overrides.after ?? { version: '1.0.0' },
  };
}

function makeContext(
  lockEntryChanges: LockEntryChange[],
  configOverrides: Partial<ResolvedConfig> = {}
): CheckContext {
  return {
    corpus: STUB_CORPUS,
    config: { ...BASE_CONFIG, ...configOverrides },
    delta: {
      changes: [],
      lockEntryChanges,
      onlyBuiltAdded: [],
      lockfileFormat: 'npm',
      hasComparisonBase: true,
      workspaceLocalNames: new Set(),
      diagnostics: [],
    },
    npmrcRegistryPins: new Map(),
    diagnostics: [] as Diagnostic[],
    allowed: [] as string[],
  };
}

const NOW = Date.parse('2026-09-26T00:00:00.000Z');
const nowFn = () => NOW;

// Every test here predates nothing -- unlike registered-squat.test.ts's
// NO_DEADLINE constant this is simply a deadline that cannot expire, built
// fresh per describe so nothing here is about the deadline's own mechanism
// except the two tests that name it explicitly.
const NO_DEADLINE = createOnlineDeadline(Number.POSITIVE_INFINITY, () => 0);

// Six days old: inside the default 7-day floor, so a finding turns on the
// test's own subject rather than on an unrelated boundary.
const FRESH_DATE = '2026-09-20T00:00:00.000Z';
// Thirty days old: comfortably outside the default floor.
const OLD_DATE = '2026-08-27T00:00:00.000Z';
// After NOW: a future-dated publish, however small the floor.
const FUTURE_DATE = '2026-09-27T00:00:00.000Z';

function fakeDeps(packuments: Record<string, Record<string, string> | null>) {
  const calls: string[] = [];
  return {
    calls,
    fetchPackument: async (name: string) => {
      calls.push(name);
      const versionTimes = packuments[name];
      if (versionTimes === undefined) {
        return null;
      }
      return versionTimes === null ? null : { versionTimes };
    },
  };
}

describe('findPublishAgeFindings', () => {
  test('flags a fresh version below the floor', async () => {
    const ctx = makeContext([makeLockEntryChange({ name: 'fresh-thing', after: { version: '1.0.0' } })]);
    const deps = fakeDeps({ 'fresh-thing': { '1.0.0': FRESH_DATE } });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'publish-age',
      severity: 'high',
      packageName: 'fresh-thing',
      manifestPath: 'package.json',
      details: { signal: 'publish-age', version: '1.0.0', minAgeDays: 7 },
    });
    expect(findings[0].message).toContain('fresh-thing@1.0.0');
    expect(findings[0].message).toContain('7 day');
  });

  test('does not flag a version older than the floor', async () => {
    const ctx = makeContext([makeLockEntryChange({ name: 'old-thing', after: { version: '2.0.0' } })]);
    const deps = fakeDeps({ 'old-thing': { '2.0.0': OLD_DATE } });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toEqual([]);
  });

  test('a future-dated publish is a finding even at minAgeDays 0', async () => {
    const ctx = makeContext(
      [makeLockEntryChange({ name: 'time-traveler', after: { version: '9.9.9' } })],
      { minAgeDays: 0 }
    );
    const deps = fakeDeps({ 'time-traveler': { '9.9.9': FUTURE_DATE } });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('future');
  });

  test('minAgeDays 0 does not flag a version published exactly now or in the past', async () => {
    const ctx = makeContext(
      [makeLockEntryChange({ name: 'just-published', after: { version: '1.0.0' } })],
      { minAgeDays: 0 }
    );
    const deps = fakeDeps({ 'just-published': { '1.0.0': new Date(NOW).toISOString() } });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toEqual([]);
  });

  test('an allowlisted name@version is skipped with a note', async () => {
    const ctx = makeContext(
      [makeLockEntryChange({ name: 'reviewed-thing', after: { version: '1.0.0' } })],
      { minAgeAllow: ['reviewed-thing@1.0.0'] }
    );
    const deps = fakeDeps({ 'reviewed-thing': { '1.0.0': FRESH_DATE } });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toEqual([]);
  });

  test('an allowlist entry for a different version of the same name does not suppress it', async () => {
    // The falsifiable half: minAgeAllow names an exact version, not the
    // package, so a different fresh version of the same name still fires.
    const ctx = makeContext(
      [makeLockEntryChange({ name: 'reviewed-thing', after: { version: '2.0.0' } })],
      { minAgeAllow: ['reviewed-thing@1.0.0'] }
    );
    const deps = fakeDeps({ 'reviewed-thing': { '2.0.0': FRESH_DATE } });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toHaveLength(1);
  });

  test('a package the registry does not know is a diagnostic, never a finding', async () => {
    const ctx = makeContext([makeLockEntryChange({ name: 'ghost-pkg', after: { version: '1.0.0' } })]);
    const deps = fakeDeps({ 'ghost-pkg': null });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toEqual([]);
    // This check's own candidates come from the lockfile walk, which is
    // overwhelmingly transitive entries no manifest names -- unknown-package
    // never sees those (it reads only manifest-declared names), so a
    // transitive dependency the registry no longer knows about would
    // otherwise vanish with no trace at all.
    expect(ctx.diagnostics).toHaveLength(1);
    expect(ctx.diagnostics[0].code).toBe('publish-age-package-unknown');
    expect(ctx.diagnostics[0].message).toContain('ghost-pkg');
  });

  test('a version missing from the time map is a diagnostic, never a finding', async () => {
    const ctx = makeContext([makeLockEntryChange({ name: 'partial-pkg', after: { version: '3.0.0' } })]);
    // The registry knows the name and has SOME versions on record, just not
    // this exact one.
    const deps = fakeDeps({ 'partial-pkg': { '1.0.0': OLD_DATE } });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toEqual([]);
    expect(ctx.diagnostics).toHaveLength(1);
    expect(ctx.diagnostics[0].code).toBe('publish-age-version-unknown');
    expect(ctx.diagnostics[0].message).toContain('partial-pkg@3.0.0');
  });

  test('a registry error is a could-not-run for this check, never a silent pass', async () => {
    const ctx = makeContext([makeLockEntryChange({ name: 'flaky-thing', after: { version: '1.0.0' } })]);
    const diagnostics: Diagnostic[] = [];
    const deps = {
      fetchPackument: async () => {
        throw new Error('socket hang up');
      },
    };

    const findings = await findPublishAgeFindings(ctx, deps, diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('online-check-unreachable');
    expect(diagnostics[0].message).toContain('flaky-thing');
  });

  test('a dependency with no resolved version is not a candidate', async () => {
    const ctx = makeContext([
      makeLockEntryChange({ name: 'git-source-thing', after: { resolvedUrl: 'git+https://example.invalid/x.git' } }),
    ]);
    const deps = fakeDeps({});

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toEqual([]);
    expect(deps.calls).toEqual([]);
  });

  test('a workspace-local name is never a candidate', async () => {
    const ctx = makeContext([makeLockEntryChange({ name: 'sibling-pkg', after: { version: '1.0.0' } })]);
    ctx.delta.workspaceLocalNames = new Set(['sibling-pkg']);
    const deps = fakeDeps({ 'sibling-pkg': { '1.0.0': FRESH_DATE } });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toEqual([]);
    expect(deps.calls).toEqual([]);
  });

  test('a name in a configured internal scope is never sent to the registry', async () => {
    const ctx = makeContext(
      [makeLockEntryChange({ name: '@acme/internal-thing', after: { version: '1.0.0' } })],
      { internalScopes: ['@acme'] }
    );
    const deps = fakeDeps({ '@acme/internal-thing': { '1.0.0': FRESH_DATE } });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toEqual([]);
    expect(deps.calls).toEqual([]);
  });


  test('does nothing, and calls nothing, when the delta has no candidates', async () => {
    const ctx = makeContext([]);
    const deps = fakeDeps({});

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toEqual([]);
    expect(deps.calls).toEqual([]);
  });

  test('one packument fetch per package name, even across several resolved versions', async () => {
    // Two manifest paths (a monorepo shape) resolving the SAME name at two
    // different versions is still one name, and one packument answers both.
    const ctx = makeContext([
      makeLockEntryChange({ name: 'shared-thing', manifestPath: 'a/package.json', after: { version: '1.0.0' } }),
      makeLockEntryChange({ name: 'shared-thing', manifestPath: 'b/package.json', after: { version: '2.0.0' } }),
    ]);
    const deps = fakeDeps({
      'shared-thing': { '1.0.0': OLD_DATE, '2.0.0': FRESH_DATE },
    });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(deps.calls).toEqual(['shared-thing']);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ manifestPath: 'b/package.json', details: { version: '2.0.0' } });
  });

  test('the same (manifestPath, name, version) triple is reported once even if the lockfile diff lists it twice', async () => {
    const ctx = makeContext([
      makeLockEntryChange({ name: 'duplicated-thing', after: { version: '1.0.0' } }),
      makeLockEntryChange({ name: 'duplicated-thing', after: { version: '1.0.0' } }),
    ]);
    const deps = fakeDeps({ 'duplicated-thing': { '1.0.0': FRESH_DATE } });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toHaveLength(1);
  });

  test('a spent per-run deadline skips the whole check and records why', async () => {
    const ctx = makeContext([makeLockEntryChange({ name: 'fresh-thing', after: { version: '1.0.0' } })]);
    const diagnostics: Diagnostic[] = [];
    const deps = fakeDeps({ 'fresh-thing': { '1.0.0': FRESH_DATE } });

    const findings = await findPublishAgeFindings(
      ctx,
      deps,
      diagnostics,
      createOnlineDeadline(0, () => 0),
      nowFn
    );

    expect(deps.calls).toEqual([]);
    expect(findings).toEqual([]);
    expect(diagnostics.some((d) => d.code === 'online-deadline-exceeded')).toBe(true);
  });
});
