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

  test('an allowlisted name@version is skipped with a visible diagnostic', async () => {
    const ctx = makeContext(
      [makeLockEntryChange({ name: 'reviewed-thing', after: { version: '1.0.0' } })],
      { minAgeAllow: ['reviewed-thing@1.0.0'] }
    );
    const deps = fakeDeps({ 'reviewed-thing': { '1.0.0': FRESH_DATE } });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toEqual([]);
    // The skip is a reported decision, not silence: a reader can tell "the
    // user reviewed and allowed this release" from "nothing needed
    // checking", the same visibility the offline `allow` list's own
    // clearances get.
    expect(ctx.diagnostics).toHaveLength(1);
    expect(ctx.diagnostics[0].code).toBe('publish-age-allowed');
    expect(ctx.diagnostics[0].message).toContain('reviewed-thing@1.0.0');
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

  test('an entry resolved from a private registry origin is never sent to the public registry', async () => {
    const ctx = makeContext([
      makeLockEntryChange({
        name: 'private-thing',
        after: { version: '1.0.0', resolvedUrl: 'https://npm.acme.example/private-thing/-/private-thing-1.0.0.tgz' },
      }),
    ]);
    const deps = fakeDeps({ 'private-thing': { '1.0.0': FRESH_DATE } });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toEqual([]);
    expect(deps.calls).toEqual([]);
    expect(ctx.diagnostics).toHaveLength(1);
    expect(ctx.diagnostics[0].code).toBe('publish-age-private-origin-skipped');
    expect(ctx.diagnostics[0].message).toContain('private-thing');
  });

  test('an entry whose scope is pinned to another registry in .npmrc is never sent to the public registry', async () => {
    // Resolved from the PUBLIC registry (a pin mismatch, confusion.ts's own
    // rule 1 territory) but declared private by the project's own .npmrc,
    // which is reason enough on its own not to ask the public registry
    // about it.
    const ctx = makeContext([
      makeLockEntryChange({
        name: '@acme/pinned-thing',
        after: { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/@acme/pinned-thing/-/pinned-thing-1.0.0.tgz' },
      }),
    ]);
    ctx.npmrcRegistryPins.set('@acme', 'https://npm.acme.example/');
    const deps = fakeDeps({ '@acme/pinned-thing': { '1.0.0': FRESH_DATE } });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toEqual([]);
    expect(deps.calls).toEqual([]);
    expect(ctx.diagnostics.some((d) => d.code === 'publish-age-private-origin-skipped')).toBe(true);
  });

  // Issue #67: a scope pin decides by its OWN origin, not by merely
  // existing. Before this fix, isNonPublicResolution treated ANY pinned
  // scope as private, so a scope pinned to the public registry lost
  // publish-age coverage even under a private project default -- a
  // coverage loss, not a leak, but real: a well-behaved project pinning
  // @types at the public registry for clarity got no publish-age check on
  // it at all.
  test('a scope pinned to the public registry is checked even when the project default registry is private', async () => {
    const ctx = makeContext([
      makeLockEntryChange({
        name: '@types/node',
        after: { version: '1.0.0' }, // no resolvedUrl: pnpm's ordinary shape
      }),
    ]);
    ctx.npmrcRegistryPins.set('@types', 'https://registry.npmjs.org/');
    ctx.npmrcDefaultRegistry = 'https://npm.acme.example/';
    const deps = fakeDeps({ '@types/node': { '1.0.0': FRESH_DATE } });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    // Fetched (the pin says public), and fresh, so it flags.
    expect(deps.calls).toEqual(['@types/node']);
    expect(findings).toHaveLength(1);
    expect(findings[0].packageName).toBe('@types/node');
    expect(ctx.diagnostics.some((d) => d.code === 'publish-age-private-origin-skipped')).toBe(false);
  });

  // The inverse: a pin still decides PRIVATE even under a public project
  // default, which was already the pre-fix behaviour but is pinned here
  // explicitly now that the origin comparison actually runs both ways.
  test('a scope pinned to a private registry is skipped even when the project default registry is public', async () => {
    const ctx = makeContext([
      makeLockEntryChange({
        name: '@acme/widget',
        after: { version: '1.0.0' },
      }),
    ]);
    ctx.npmrcRegistryPins.set('@acme', 'https://npm.acme.example/');
    ctx.npmrcDefaultRegistry = 'https://registry.npmjs.org/';
    const deps = fakeDeps({ '@acme/widget': { '1.0.0': FRESH_DATE } });

    const findings = await findPublishAgeFindings(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toEqual([]);
    expect(deps.calls).toEqual([]);
    expect(ctx.diagnostics.some((d) => d.code === 'publish-age-private-origin-skipped')).toBe(true);
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
