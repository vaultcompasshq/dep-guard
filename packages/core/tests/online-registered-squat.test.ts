import {
  findRegisteredSquats,
  REGISTERED_SQUAT_DOWNLOAD_FLOOR,
  REGISTERED_SQUAT_MAX_AGE_DAYS,
} from '../src/online/registered-squat.js';
import { fetchWeeklyDownloads } from '../src/online/registry-client.js';
import { createOnlineDeadline } from '../src/online/deadline.js';
import type { CheckContext, ResolvedConfig } from '../src/checks/types.js';
import type { Corpus } from '../src/corpus.js';
import type { DepChange } from '../src/delta.js';
import type { Diagnostic } from '../src/types.js';

// Minimal scripted-fetch helper, matching online-registry-client.test.ts's
// own, for the integration-style tests below that exercise the REAL
// fetchWeeklyDownloads (including its single-name-404 disambiguation)
// rather than a hand-rolled fakeDeps -- the only way to prove the
// disambiguation logic and this check's consumption of it actually
// compose correctly end to end.
function jsonResponse(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null },
    json: async () => body,
  };
}

function scriptedFetch(script: Array<ReturnType<typeof jsonResponse> | Error>) {
  const calls: Array<{ url: string }> = [];
  let index = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const impl: any = async (url: string | URL) => {
    calls.push({ url: String(url) });
    const next = script[Math.min(index, script.length - 1)];
    index += 1;
    if (next instanceof Error) {
      throw next;
    }
    return next as unknown as Response;
  };
  return Object.assign(impl, { calls });
}

const noSleep = async () => {};

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
};

function makeChange(overrides: Partial<DepChange> & { name: string }): DepChange {
  return {
    name: overrides.name,
    registryName: overrides.registryName ?? overrides.name,
    specifier: overrides.specifier ?? '^1.0.0',
    kind: overrides.kind ?? 'added',
    depType: overrides.depType ?? 'dependencies',
    protocol: overrides.protocol ?? 'registry',
    manifestPath: overrides.manifestPath ?? 'package.json',
    before: overrides.before,
    after: overrides.after,
  };
}

function makeContext(changes: DepChange[]): CheckContext {
  return {
    corpus: STUB_CORPUS,
    config: BASE_CONFIG,
    delta: {
      changes,
      lockEntryChanges: [],
      onlyBuiltAdded: [],
      lockfileFormat: 'npm',
      hasComparisonBase: true,
      workspaceLocalNames: new Set(),
      diagnostics: [],
    },
    npmrcRegistryPins: new Map(),
    diagnostics: [] as Diagnostic[],
  };
}

const NOW = Date.parse('2026-08-16T00:00:00.000Z');
const nowFn = () => NOW;

// Every pre-existing test in this file predates the per-run online
// deadline and is about something else entirely, so each one gets a
// deadline that cannot expire. The deadline's own behaviour is tested
// explicitly at the bottom of this file, and in online-deadline.test.ts.
const NO_DEADLINE = createOnlineDeadline(Number.POSITIVE_INFINITY, () => 0);

// Comfortably inside REGISTERED_SQUAT_MAX_AGE_DAYS of NOW, so a finding
// turns on the test's own subject rather than on the age cutoff.
const NEW_DATE = '2026-08-14T00:00:00.000Z';

// `noRecordNames` models a confirmed "npm answered, no download history"
// name (registry-client.ts's DownloadCountsResult.noRecord) -- distinct
// from a name that is simply absent from `downloads` and not listed here,
// which models an unresolved absence: present in neither counts nor
// noRecord. This check does not know or care what upstream cause
// produces that absence (registry-client.ts resolves an ordinary
// single-name 404 into noRecord or throws before it ever reaches here --
// see its own DownloadCountsResult doc comment -- so in production this
// state means a defensive, malformed-response-shaped gap); the check's
// contract is simply that an unresolved name is skipped, regardless of
// why it is unresolved.
function fakeDeps(
  downloads: Record<string, number>,
  packuments: Record<string, string | null>,
  noRecordNames: string[] = []
) {
  return {
    fetchWeeklyDownloads: async (names: string[]) => {
      const counts = new Map<string, number>();
      const noRecord = new Set<string>();
      for (const name of names) {
        if (name in downloads) {
          counts.set(name, downloads[name]);
        } else if (noRecordNames.includes(name)) {
          noRecord.add(name);
        }
      }
      return { counts, noRecord };
    },
    fetchPackument: async (name: string) => {
      if (!(name in packuments)) {
        return null;
      }
      return { createdAt: packuments[name] };
    },
  };
}

describe('findRegisteredSquats', () => {
  test('flags a name below the download floor and newly created', async () => {
    const ctx = makeContext([makeChange({ name: 'react-codeshift' })]);
    const findings = await findRegisteredSquats(
      ctx,
      fakeDeps({ 'react-codeshift': 4 }, { 'react-codeshift': '2026-08-01T00:00:00.000Z' }),
      ctx.diagnostics,
      NO_DEADLINE,
      nowFn
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'registered-squat',
      severity: 'medium',
      packageName: 'react-codeshift',
      details: { signal: 'registered-squat' },
    });
  });

  test('does not flag a name at or above the download floor', async () => {
    const ctx = makeContext([makeChange({ name: 'remark-man' })]);
    const findings = await findRegisteredSquats(
      ctx,
      fakeDeps(
        { 'remark-man': REGISTERED_SQUAT_DOWNLOAD_FLOOR },
        { 'remark-man': '2026-08-01T00:00:00.000Z' }
      ),
      ctx.diagnostics,
      NO_DEADLINE,
      nowFn
    );
    expect(findings).toEqual([]);
  });

  test('does not flag a name below the floor but old enough', async () => {
    const ctx = makeContext([makeChange({ name: 'crossenv' })]);
    const oldDate = new Date(NOW - (REGISTERED_SQUAT_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    const findings = await findRegisteredSquats(
      ctx,
      fakeDeps({ crossenv: 10 }, { crossenv: oldDate }),
      ctx.diagnostics,
      NO_DEADLINE,
      nowFn
    );
    expect(findings).toEqual([]);
  });

  test('flags a recently-created name the downloads API confirms it has no record for at all', async () => {
    // A name in noRecord means the API answered successfully and
    // explicitly confirmed it has no download record for this exact name
    // -- precisely the archetypal registered-squat case (a
    // freshly-registered attacker name), and a stronger signal than a low
    // recorded count, not a reason to skip it.
    const ctx = makeContext([makeChange({ name: 'totally-made-up-hallucinated-xyz123' })]);
    const findings = await findRegisteredSquats(
      ctx,
      fakeDeps(
        {},
        { 'totally-made-up-hallucinated-xyz123': '2026-08-10T00:00:00.000Z' },
        ['totally-made-up-hallucinated-xyz123']
      ),
      ctx.diagnostics,
      NO_DEADLINE,
      nowFn
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'registered-squat',
      severity: 'medium',
      packageName: 'totally-made-up-hallucinated-xyz123',
      details: { signal: 'registered-squat', weeklyDownloads: 0 },
    });
  });

  test('does not flag a recently-created name behind an unresolved absence', async () => {
    // Present in neither counts nor noRecord: genuinely unknown, not a
    // confirmed zero, regardless of what upstream cause produced the
    // absence (see the fakeDeps comment above). Must not mint a finding:
    // trusting an unresolved absence as a signal would let a broken
    // downloads fetch silently flag every young candidate as a registered
    // squat instead of surfacing as online-check-unreachable.
    const ctx = makeContext([makeChange({ name: 'ambiguous-pkg' })]);
    const findings = await findRegisteredSquats(
      ctx,
      fakeDeps({}, { 'ambiguous-pkg': '2026-08-10T00:00:00.000Z' }),
      ctx.diagnostics,
      NO_DEADLINE,
      nowFn
    );
    expect(findings).toEqual([]);
  });

  test('does not flag a name with no packument data', async () => {
    const ctx = makeContext([makeChange({ name: 'ghost-pkg' })]);
    const findings = await findRegisteredSquats(
      ctx,
      fakeDeps({ 'ghost-pkg': 1 }, {}),
      ctx.diagnostics,
      NO_DEADLINE,
      nowFn
    );
    expect(findings).toEqual([]);
  });

  test('a workspace-local name is never a candidate', async () => {
    const ctx = makeContext([makeChange({ name: 'react-codeshift' })]);
    ctx.delta.workspaceLocalNames = new Set(['react-codeshift']);
    const findings = await findRegisteredSquats(
      ctx,
      fakeDeps({ 'react-codeshift': 1 }, { 'react-codeshift': '2026-08-15T00:00:00.000Z' }),
      ctx.diagnostics,
      NO_DEADLINE,
      nowFn
    );
    expect(findings).toEqual([]);
  });

  test('does nothing, and calls nothing, when the delta has no candidates', async () => {
    const ctx = makeContext([]);
    let called = false;
    const deps = {
      fetchWeeklyDownloads: async () => {
        called = true;
        return { counts: new Map<string, number>(), noRecord: new Set<string>() };
      },
      fetchPackument: async () => null,
    };
    const findings = await findRegisteredSquats(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);
    expect(findings).toEqual([]);
    expect(called).toBe(false);
  });

  test('a downloads fetch failure degrades to no findings with a diagnostic', async () => {
    const ctx = makeContext([makeChange({ name: 'react-codeshift' })]);
    const diagnostics: Diagnostic[] = [];
    const deps = {
      fetchWeeklyDownloads: async () => {
        throw new Error('socket hang up');
      },
      fetchPackument: async () => null,
    };
    const findings = await findRegisteredSquats(ctx, deps, diagnostics, NO_DEADLINE, nowFn);
    expect(findings).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('online-check-unreachable');
  });

  test('a packument fetch failure for one name diagnoses and skips just that name', async () => {
    const ctx = makeContext([
      makeChange({ name: 'react-codeshift' }),
      makeChange({ name: 'unused-imports' }),
    ]);
    const diagnostics: Diagnostic[] = [];
    const deps = {
      fetchWeeklyDownloads: async () => ({
        counts: new Map([['react-codeshift', 4], ['unused-imports', 9]]),
        noRecord: new Set<string>(),
      }),
      fetchPackument: async (name: string) => {
        if (name === 'react-codeshift') {
          throw new Error('timed out');
        }
        return { createdAt: '2026-08-01T00:00:00.000Z' };
      },
    };
    const findings = await findRegisteredSquats(ctx, deps, diagnostics, NO_DEADLINE, nowFn);
    expect(findings).toHaveLength(1);
    expect(findings[0].packageName).toBe('unused-imports');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('online-check-unreachable');
    expect(diagnostics[0].message).toContain('react-codeshift');
  });

  test('a name in a configured internal scope is never sent to either API', async () => {
    // An internal package is absent from npm by design, so npm's answer
    // about it is guaranteed to look exactly like a freshly-registered
    // squat: no download history, and either no packument or a very young
    // one. This check would therefore fire on every internal dependency
    // in a repository that declares its scopes, which is both a wave of
    // false positives and, worse, a private package name put on the wire
    // to a public service. Neither API may be asked at all.
    const ctx = makeContext([makeChange({ name: '@acme/internal-thing' })]);
    ctx.config.internalScopes = ['@acme'];
    const askedDownloads: string[][] = [];
    const askedPackuments: string[] = [];
    const deps = {
      fetchWeeklyDownloads: async (names: string[]) => {
        askedDownloads.push(names);
        return { counts: new Map<string, number>(), noRecord: new Set(names) };
      },
      fetchPackument: async (name: string) => {
        askedPackuments.push(name);
        return { createdAt: NEW_DATE };
      },
    };

    const findings = await findRegisteredSquats(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(findings).toEqual([]);
    expect(askedDownloads).toEqual([]);
    expect(askedPackuments).toEqual([]);
  });

  test('an internal prefix is honoured the same way a scope is, and a public sibling still runs', async () => {
    // The falsifiable half: the filter has to remove the internal name
    // and nothing else. A test that only asserted "internal name absent"
    // would pass just as well against a filter that removed everything.
    const ctx = makeContext([
      makeChange({ name: 'acme-internal-thing' }),
      makeChange({ name: 'public-fresh-thing' }),
    ]);
    ctx.config.internalPrefixes = ['acme-'];
    const asked: string[][] = [];
    const deps = {
      fetchWeeklyDownloads: async (names: string[]) => {
        asked.push(names);
        return { counts: new Map(names.map((n) => [n, 1])), noRecord: new Set<string>() };
      },
      fetchPackument: async () => ({ createdAt: NEW_DATE }),
    };

    const findings = await findRegisteredSquats(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);

    expect(asked).toEqual([['public-fresh-thing']]);
    expect(findings.map((f) => f.packageName)).toEqual(['public-fresh-thing']);
  });

  test('a spent per-run deadline skips the whole check and records why', async () => {
    const ctx = makeContext([makeChange({ name: 'react-codeshift' })]);
    const diagnostics: Diagnostic[] = [];
    let called = false;
    const deps = {
      fetchWeeklyDownloads: async () => {
        called = true;
        return { counts: new Map<string, number>(), noRecord: new Set<string>() };
      },
      fetchPackument: async () => ({ createdAt: NEW_DATE }),
    };

    const findings = await findRegisteredSquats(
      ctx,
      deps,
      diagnostics,
      createOnlineDeadline(0, () => 0),
      nowFn
    );

    expect(called).toBe(false);
    expect(findings).toEqual([]);
    expect(diagnostics.some((d) => d.code === 'online-deadline-exceeded')).toBe(true);
  });

  test('a deadline spent during the per-name packument loop stops it and adds nothing more', async () => {
    // The downloads fetch succeeds for both names and the clock runs out
    // while the first packument is in flight. The second name must not be
    // asked about, and -- the part that matters -- the check must not
    // invent a finding for a name it never priced.
    let now = 0;
    const ctx = makeContext([
      makeChange({ name: 'first-fresh-thing' }),
      makeChange({ name: 'second-fresh-thing' }),
    ]);
    const diagnostics: Diagnostic[] = [];
    const asked: string[] = [];
    const deps = {
      fetchWeeklyDownloads: async (names: string[]) => ({
        counts: new Map(names.map((n) => [n, 1])),
        noRecord: new Set<string>(),
      }),
      fetchPackument: async (name: string) => {
        asked.push(name);
        now = 10_000;
        return { createdAt: NEW_DATE };
      },
    };

    const findings = await findRegisteredSquats(
      ctx,
      deps,
      diagnostics,
      createOnlineDeadline(5_000, () => now),
      nowFn
    );

    expect(asked).toEqual(['first-fresh-thing']);
    expect(findings.map((f) => f.packageName)).toEqual(['first-fresh-thing']);
    expect(diagnostics.some((d) => d.code === 'online-deadline-exceeded')).toBe(true);
  });
});

// Integration coverage against the REAL fetchWeeklyDownloads (not
// fakeDeps): the single-name-404 disambiguation this round of the fix
// added lives in registry-client.ts, and the only way to prove it and
// this check's counts/noRecord consumption compose correctly is to run
// them together, the way scan.ts's cachedFetchWeeklyDownloads actually
// does in production.
describe('findRegisteredSquats, against the real fetchWeeklyDownloads', () => {
  test('a scoped name with no download record produces the finding', async () => {
    // The headline case this round of the fix exists for: every scoped
    // name goes through the single-name lookup path (the bulk downloads
    // endpoint rejects scoped names outright, verified live), so a
    // freshly-registered scoped package 404s on its download lookup and
    // is confirmed via a sentinel probe (a single-name point lookup for
    // DOWNLOAD_DISAMBIGUATION_SENTINEL, unrelated to the packument path)
    // -- which succeeds, proving the downloads API's single-name path is
    // healthy, so the original 404 means "no download record", not
    // "unknown". Before this round's fix, this case could never fire.
    const ctx = makeContext([makeChange({ name: '@scope/fresh-thing' })]);
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 404 }), // the downloads lookup 404s
      jsonResponse({ downloads: 100_000, package: 'react' }), // the sentinel probe succeeds
    ]);
    const deps = {
      fetchWeeklyDownloads: (names: string[]) =>
        fetchWeeklyDownloads(names, { fetchImpl, sleepImpl: noSleep }),
      // The check's own age lookup, unrelated to the sentinel probe above
      // (a separate function, never routed through fetchImpl) -- this is
      // what drives the "recently created" check.
      fetchPackument: async () => ({ createdAt: '2026-08-10T00:00:00.000Z' }),
    };
    const findings = await findRegisteredSquats(ctx, deps, ctx.diagnostics, NO_DEADLINE, nowFn);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'registered-squat',
      severity: 'medium',
      packageName: '@scope/fresh-thing',
      details: { weeklyDownloads: 0 },
    });
  });

  test('an unscoped name with no download record produces the same finding whether fetched alone or alongside others', async () => {
    // Non-determinism was the bug this round of the fix closed: whether a
    // freshly-registered unscoped name was even checkable used to depend
    // on how many OTHER unscoped cache misses happened to share its
    // 128-name batch (a batch of exactly one hits the ambiguous
    // single-name path; a batch of two or more reaches the bulk endpoint
    // directly, and scoped names never share a batch at all). Both
    // shapes must now resolve identically -- same severity, same
    // weeklyDownloads -- regardless of unrelated batch membership.
    const soloFetchImpl = scriptedFetch([
      jsonResponse(null, { status: 404 }), // single-name lookup 404s
      jsonResponse({ downloads: 100_000, package: 'react' }), // sentinel probe confirms healthy
    ]);
    const soloCtx = makeContext([makeChange({ name: 'hallucinated-solo' })]);
    const soloFindings = await findRegisteredSquats(
      soloCtx,
      {
        fetchWeeklyDownloads: (names: string[]) =>
          fetchWeeklyDownloads(names, { fetchImpl: soloFetchImpl, sleepImpl: noSleep }),
        fetchPackument: async () => ({ createdAt: '2026-08-10T00:00:00.000Z' }),
      },
      soloCtx.diagnostics,
      NO_DEADLINE,
      nowFn
    );

    const pairedFetchImpl = scriptedFetch([
      // A real bulk batch of two unscoped names -- no 404, no sentinel
      // probe needed, straight to a name-keyed 200.
      jsonResponse({ 'hallucinated-solo': null, 'another-real-thing': { downloads: 500 } }),
    ]);
    const pairedCtx = makeContext([
      makeChange({ name: 'hallucinated-solo' }),
      makeChange({ name: 'another-real-thing' }),
    ]);
    const pairedFindings = await findRegisteredSquats(
      pairedCtx,
      {
        fetchWeeklyDownloads: (names: string[]) =>
          fetchWeeklyDownloads(names, { fetchImpl: pairedFetchImpl, sleepImpl: noSleep }),
        fetchPackument: async () => ({ createdAt: '2026-08-10T00:00:00.000Z' }),
      },
      pairedCtx.diagnostics,
      NO_DEADLINE,
      nowFn
    );

    const soloFinding = soloFindings.find((f) => f.packageName === 'hallucinated-solo');
    const pairedFinding = pairedFindings.find((f) => f.packageName === 'hallucinated-solo');
    expect(soloFinding).toBeDefined();
    expect(pairedFinding).toBeDefined();
    expect(soloFinding).toMatchObject({
      severity: pairedFinding?.severity,
      details: { weeklyDownloads: 0 },
    });
    expect(pairedFinding).toMatchObject({ details: { weeklyDownloads: 0 } });
  });

  test('a single-name 404 whose sentinel probe fails outright degrades quietly: no finding, no fabricated zero', async () => {
    // The sentinel probe is a genuine network failure, not a clean answer
    // either way -- this propagates out of fetchWeeklyDownloads exactly
    // like any other unreachable downloads API, so findRegisteredSquats's
    // own try/catch around the whole fetchWeeklyDownloads call diagnoses
    // it, rather than a finding being invented from an ambiguous failure
    // or a zero being fabricated.
    const ctx = makeContext([makeChange({ name: 'flaky-lookup' })]);
    const diagnostics: Diagnostic[] = [];
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 404 }),
      jsonResponse(null, { status: 500 }),
    ]);
    const deps = {
      fetchWeeklyDownloads: (names: string[]) =>
        fetchWeeklyDownloads(names, { fetchImpl, sleepImpl: noSleep, attempts: 1 }),
      fetchPackument: async () => ({ createdAt: '2026-08-10T00:00:00.000Z' }),
    };
    const findings = await findRegisteredSquats(ctx, deps, diagnostics, NO_DEADLINE, nowFn);
    expect(findings).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('online-check-unreachable');
  });

  test('a single-name 404 whose sentinel probe itself 404s degrades quietly: no finding, no fabricated zero', async () => {
    // The sentinel is certain to exist and certain to have downloads, so
    // it 404ing too means the downloads API itself is misbehaving, not
    // the candidate name -- this must not be read as "confirmed no
    // record for every single-name candidate in this batch". Propagates
    // the same as any other unreachable downloads API.
    const ctx = makeContext([makeChange({ name: 'flaky-lookup' })]);
    const diagnostics: Diagnostic[] = [];
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 404 }),
      jsonResponse(null, { status: 404 }),
    ]);
    const deps = {
      fetchWeeklyDownloads: (names: string[]) =>
        fetchWeeklyDownloads(names, { fetchImpl, sleepImpl: noSleep, attempts: 1 }),
      fetchPackument: async () => ({ createdAt: '2026-08-10T00:00:00.000Z' }),
    };
    const findings = await findRegisteredSquats(ctx, deps, diagnostics, NO_DEADLINE, nowFn);
    expect(findings).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('online-check-unreachable');
  });

  test('a multi-name bulk 404 still propagates to a quiet degrade, not a fabricated result', async () => {
    const ctx = makeContext([
      makeChange({ name: 'pkg-a' }),
      makeChange({ name: 'pkg-b' }),
    ]);
    const diagnostics: Diagnostic[] = [];
    const fetchImpl = scriptedFetch([jsonResponse(null, { status: 404 })]);
    const deps = {
      fetchWeeklyDownloads: (names: string[]) =>
        fetchWeeklyDownloads(names, { fetchImpl, sleepImpl: noSleep, attempts: 1 }),
      fetchPackument: async () => ({ createdAt: '2026-08-10T00:00:00.000Z' }),
    };
    const findings = await findRegisteredSquats(ctx, deps, diagnostics, NO_DEADLINE, nowFn);
    expect(findings).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('online-check-unreachable');
  });
});
