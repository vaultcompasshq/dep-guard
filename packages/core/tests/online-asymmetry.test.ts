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

function fakeDeps(counts: Record<string, number>) {
  return {
    fetchWeeklyDownloads: async (names: string[]) => {
      const map = new Map<string, number>();
      for (const name of names) {
        if (name in counts) {
          map.set(name, counts[name]);
        }
      }
      return map;
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

  test('escalates a finding when the API has no download record for it at all', async () => {
    // A name missing from the counts Map means the API answered but has no
    // download record for this exact name -- the archetypal case for a
    // freshly-registered squat, and a stronger signal than a low count, not
    // a reason to skip it. This replaces a prior version of this test that
    // asserted the opposite (leaving the finding alone), which encoded the
    // zero-download-blindness bug: a name with no record at all was the one
    // case the check could never fire on.
    const findings = [typosquatFinding({ packageName: 'no-data-pkg' })];
    const diagnostics: Diagnostic[] = [];
    await applyTyposquatAsymmetry(findings, fakeDeps({}), diagnostics);
    expect(findings[0].severity).toBe('high');
    expect(findings[0].details).toMatchObject({ onlineWeeklyDownloads: 0 });
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
        return new Map<string, number>();
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
