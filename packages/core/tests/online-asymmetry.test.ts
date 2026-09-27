import { applyTyposquatAsymmetry, ASYMMETRY_DOWNLOAD_FLOOR } from '../src/online/asymmetry.js';
import type { CheckContext, ResolvedConfig } from '../src/checks/types.js';
import type { Corpus } from '../src/corpus.js';
import type { Diagnostic, Finding } from '../src/types.js';

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

// A fresh config object every call, never the shared BASE_CONFIG reference
// itself -- a test that wrote onto it in place would leak into every test
// that runs after it in this file.
function makeContext(configOverrides: Partial<ResolvedConfig> = {}): CheckContext {
  return {
    corpus: STUB_CORPUS,
    config: { ...BASE_CONFIG, ...configOverrides },
    delta: {
      changes: [],
      lockEntryChanges: [],
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

function typosquatFinding(overrides: Partial<Finding> = {}): Omit<Finding, 'fingerprint'> {
  return {
    ruleId: 'typosquat',
    severity: 'low',
    packageName: overrides.packageName ?? 'http-proxy-3',
    message: 'resemblance',
    manifestPath: 'package.json',
    details: { matchedBy: 'edit-distance', target: 'http-proxy' },
    ...overrides,
  };
}

// `noRecordNames` models a confirmed "npm answered, no download history"
// name (registry-client.ts's DownloadCountsResult.noRecord) -- distinct
// from a name that is simply absent from `counts` and not listed here,
// which models an unresolved absence: present in neither counts nor
// noRecord. This check does not know or care what upstream cause
// produces that absence (registry-client.ts resolves an ordinary
// single-name 404 into noRecord or throws before it ever reaches here --
// see its own DownloadCountsResult doc comment -- so in production this
// state means a defensive, malformed-response-shaped gap); the check's
// contract is simply that an unresolved name is left alone, regardless of
// why it is unresolved.
function fakeDeps(counts: Record<string, number>, noRecordNames: string[] = []) {
  const asked: string[][] = [];
  return {
    asked,
    fetchWeeklyDownloads: async (names: string[]) => {
      asked.push(names);
      const countsMap = new Map<string, number>();
      const noRecord = new Set<string>();
      for (const name of names) {
        if (name in counts) {
          countsMap.set(name, counts[name]);
        } else if (noRecordNames.includes(name)) {
          noRecord.add(name);
        }
      }
      return { counts: countsMap, noRecord };
    },
  };
}

describe('applyTyposquatAsymmetry', () => {
  test('escalates a low finding below the floor to high', async () => {
    const findings = [typosquatFinding({ packageName: 'react-codeshift' })];
    const diagnostics: Diagnostic[] = [];
    await applyTyposquatAsymmetry(
      findings,
      makeContext(),
      fakeDeps({ 'react-codeshift': 4 }),
      diagnostics
    );
    expect(findings[0].severity).toBe('high');
    expect(findings[0].details).toMatchObject({ onlineWeeklyDownloads: 4 });
  });

  test('leaves a finding at or above the floor as low', async () => {
    const findings = [typosquatFinding({ packageName: 'http-proxy-3' })];
    const diagnostics: Diagnostic[] = [];
    await applyTyposquatAsymmetry(
      findings,
      makeContext(),
      fakeDeps({ 'http-proxy-3': ASYMMETRY_DOWNLOAD_FLOOR }),
      diagnostics
    );
    expect(findings[0].severity).toBe('low');
  });

  test('escalates a finding when the API confirms it has no download record for it at all', async () => {
    // A name in noRecord means the API answered successfully and
    // explicitly confirmed it has no download record for this exact name
    // -- the archetypal case for a freshly-registered squat, and a
    // stronger signal than a low count, not a reason to skip it. This
    // replaces a prior version of this test that asserted the opposite
    // (leaving the finding alone on a name simply missing from the
    // response), which encoded the zero-download-blindness bug: a name
    // with no record at all was the one case the check could never fire
    // on.
    const findings = [typosquatFinding({ packageName: 'no-data-pkg' })];
    const diagnostics: Diagnostic[] = [];
    await applyTyposquatAsymmetry(
      findings,
      makeContext(),
      fakeDeps({}, ['no-data-pkg']),
      diagnostics
    );
    expect(findings[0].severity).toBe('high');
    expect(findings[0].details).toMatchObject({ onlineWeeklyDownloads: 0 });
  });

  test('leaves a finding at its offline severity behind an unresolved absence', async () => {
    // Present in neither counts nor noRecord: genuinely unknown, not a
    // confirmed zero, regardless of what upstream cause produced the
    // absence (see the fakeDeps comment above). Must not escalate:
    // trusting an unresolved absence as a signal would let a broken
    // downloads fetch silently escalate every low typosquat match to high
    // instead of surfacing as online-check-unreachable.
    const findings = [typosquatFinding({ packageName: 'ambiguous-pkg' })];
    const diagnostics: Diagnostic[] = [];
    await applyTyposquatAsymmetry(findings, makeContext(), fakeDeps({}), diagnostics);
    expect(findings[0].severity).toBe('low');
  });

  test('never touches a critical alias-list finding', async () => {
    const findings = [
      typosquatFinding({
        packageName: 'unused-imports',
        severity: 'critical',
        details: { matchedBy: 'alias-list', target: 'eslint-plugin-unused-imports' },
      }),
    ];
    const diagnostics: Diagnostic[] = [];
    await applyTyposquatAsymmetry(
      findings,
      makeContext(),
      fakeDeps({ 'unused-imports': 0 }),
      diagnostics
    );
    expect(findings[0].severity).toBe('critical');
  });

  test('never touches a finding from a different rule', async () => {
    const findings: Omit<Finding, 'fingerprint'>[] = [
      {
        ruleId: 'version-hygiene',
        severity: 'low',
        packageName: 'left-pad',
        message: 'wildcard',
        manifestPath: 'package.json',
        details: {},
      },
    ];
    const diagnostics: Diagnostic[] = [];
    await applyTyposquatAsymmetry(findings, makeContext(), fakeDeps({ 'left-pad': 1 }), diagnostics);
    expect(findings[0].severity).toBe('low');
  });

  test('does nothing, and calls nothing, when there are no low typosquat findings', async () => {
    let called = false;
    const deps = {
      fetchWeeklyDownloads: async () => {
        called = true;
        return { counts: new Map<string, number>(), noRecord: new Set<string>() };
      },
    };
    await applyTyposquatAsymmetry([], makeContext(), deps, []);
    expect(called).toBe(false);
  });

  test('a fetch failure degrades to the offline severities with a diagnostic', async () => {
    const findings = [typosquatFinding({ packageName: 'react-codeshift' })];
    const diagnostics: Diagnostic[] = [];
    const deps = {
      fetchWeeklyDownloads: async () => {
        throw new Error('socket hang up');
      },
    };
    await applyTyposquatAsymmetry(findings, makeContext(), deps, diagnostics);
    expect(findings[0].severity).toBe('low');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('online-check-unreachable');
    expect(diagnostics[0].message).toContain('socket hang up');
  });

  // From the independent review after issues 66/67/70: this check predates
  // isNonPublicName (online/registry-scope.ts) and internalScopes/
  // internalPrefixes filtering entirely, and sent every low typosquat
  // finding's packageName to the downloads API regardless of either --
  // the same leak shape unknown-package and registered-squat had before
  // #70, just left standing in the one online check nobody had re-audited
  // once the shared rule existed.
  test('a name whose scope is pinned to a private registry in .npmrc is never sent to the downloads API', async () => {
    const ctx = makeContext();
    ctx.npmrcRegistryPins.set('@acme', 'https://npm.acme.example/');
    const findings = [typosquatFinding({ packageName: '@acme/pinned-thing' })];
    const diagnostics: Diagnostic[] = [];
    const deps = fakeDeps({ '@acme/pinned-thing': 4 });

    await applyTyposquatAsymmetry(findings, ctx, deps, diagnostics);

    expect(deps.asked).toEqual([]);
    expect(findings[0].severity).toBe('low');
    expect(diagnostics.some((d) => d.code === 'typosquat-asymmetry-private-origin-skipped')).toBe(
      true
    );
    expect(
      diagnostics.find((d) => d.code === 'typosquat-asymmetry-private-origin-skipped')?.message
    ).toContain('@acme/pinned-thing');
  });

  test('a name in a configured internal prefix is never sent to the downloads API', async () => {
    const ctx = makeContext({ internalPrefixes: ['acme-'] });
    const findings = [typosquatFinding({ packageName: 'acme-internal-thing' })];
    const diagnostics: Diagnostic[] = [];
    const deps = fakeDeps({ 'acme-internal-thing': 4 });

    await applyTyposquatAsymmetry(findings, ctx, deps, diagnostics);

    expect(deps.asked).toEqual([]);
    expect(findings[0].severity).toBe('low');
    // Silent by design, like every other check's internalScopes/
    // internalPrefixes filter: an adopter's own declared list needs no
    // diagnostic reminding them of it.
    expect(
      diagnostics.some((d) => d.code === 'typosquat-asymmetry-private-origin-skipped')
    ).toBe(false);
  });

  test('a public name with no npmrc pin still reaches the downloads API, alongside a pinned sibling that does not', async () => {
    const ctx = makeContext();
    ctx.npmrcRegistryPins.set('@acme', 'https://npm.acme.example/');
    const findings = [
      typosquatFinding({ packageName: '@acme/pinned-thing' }),
      typosquatFinding({ packageName: 'public-fresh-thing' }),
    ];
    const diagnostics: Diagnostic[] = [];
    const deps = fakeDeps({ 'public-fresh-thing': 4 });

    await applyTyposquatAsymmetry(findings, ctx, deps, diagnostics);

    expect(deps.asked).toEqual([['public-fresh-thing']]);
    expect(findings.find((f) => f.packageName === 'public-fresh-thing')?.severity).toBe('high');
    expect(findings.find((f) => f.packageName === '@acme/pinned-thing')?.severity).toBe('low');
  });
});
