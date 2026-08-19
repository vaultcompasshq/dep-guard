import { applyTyposquatAsymmetry, ASYMMETRY_DOWNLOAD_FLOOR } from '../src/online/asymmetry.js';
import type { Diagnostic, Finding } from '../src/types.js';

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
// which models an unresolved/ambiguous absence (e.g. a swallowed
// single-name 404): present in neither counts nor noRecord.
function fakeDeps(counts: Record<string, number>, noRecordNames: string[] = []) {
  return {
    fetchWeeklyDownloads: async (names: string[]) => {
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
    await applyTyposquatAsymmetry(findings, fakeDeps({ 'react-codeshift': 4 }), diagnostics);
    expect(findings[0].severity).toBe('high');
    expect(findings[0].details).toMatchObject({ onlineWeeklyDownloads: 4 });
  });

  test('leaves a finding at or above the floor as low', async () => {
    const findings = [typosquatFinding({ packageName: 'http-proxy-3' })];
    const diagnostics: Diagnostic[] = [];
    await applyTyposquatAsymmetry(
      findings,
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
    await applyTyposquatAsymmetry(findings, fakeDeps({}, ['no-data-pkg']), diagnostics);
    expect(findings[0].severity).toBe('high');
    expect(findings[0].details).toMatchObject({ onlineWeeklyDownloads: 0 });
  });

  test('leaves a finding at its offline severity behind an unresolved (ambiguous) absence', async () => {
    // Present in neither counts nor noRecord -- the shape a swallowed
    // single-name 404 produces (see registry-client.ts). This is
    // genuinely unknown, not a confirmed zero, and must not escalate:
    // otherwise a misconfigured downloadsApi (every single-name lookup
    // 404ing) would silently escalate every low typosquat match to high
    // instead of surfacing as online-check-unreachable.
    const findings = [typosquatFinding({ packageName: 'ambiguous-pkg' })];
    const diagnostics: Diagnostic[] = [];
    await applyTyposquatAsymmetry(findings, fakeDeps({}), diagnostics);
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
    await applyTyposquatAsymmetry(findings, fakeDeps({ 'unused-imports': 0 }), diagnostics);
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
    await applyTyposquatAsymmetry(findings, fakeDeps({ 'left-pad': 1 }), diagnostics);
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
    await applyTyposquatAsymmetry([], deps, []);
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
    await applyTyposquatAsymmetry(findings, deps, diagnostics);
    expect(findings[0].severity).toBe('low');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('online-check-unreachable');
    expect(diagnostics[0].message).toContain('socket hang up');
  });
});
