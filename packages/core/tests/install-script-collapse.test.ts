import { collapseInstallScriptFindings } from '../src/install-script-collapse.js';
import type { Finding } from '../src/types.js';

// The collapse runs in scan(), after ignorePaths and the baseline, over the
// per-package findings that survived them. It keeps the severity (high) and
// so the exit; only the count changes.

function perPackage(name: string, overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: 'install-script',
    severity: 'high',
    packageName: name,
    message: `"${name}" now runs an install script that it did not run before.`,
    manifestPath: 'package-lock.json',
    lockfilePath: 'package-lock.json',
    fingerprint: `fp-${name}`,
    details: { signal: 'added', kind: 'added', lockfileEntry: `node_modules/${name}` },
    ...overrides,
  };
}

const NAMES = ['esbuild', 'fsevents', 'sharp'];
const base = {
  hasComparisonBase: true,
  lockfileWhollyNew: true as boolean | undefined,
  lockfilePath: 'package-lock.json' as string | undefined,
  baseline: new Set<string>() as ReadonlySet<string>,
};

describe('collapseInstallScriptFindings', () => {
  test('several per-package findings on a wholly new lockfile become one high finding', () => {
    const { findings, suppressed } = collapseInstallScriptFindings(NAMES.map((name) => perPackage(name)), base);
    expect(suppressed).toBe(0);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding?.severity).toBe('high');
    expect(finding?.details?.signal).toBe('acquired-on-new-lockfile');
    expect(finding?.details?.count).toBe(3);
    expect(finding?.details?.packages).toEqual(NAMES);
    expect(finding?.message).toContain('3 packages');
    expect(finding?.message).toContain('esbuild, fsevents, sharp');
    expect(finding?.message).toContain('allow');
    expect(finding?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a long list is capped in the message and complete in details', () => {
    const many = Array.from({ length: 30 }, (_, index) => perPackage(`pkg-${String(index).padStart(2, '0')}`));
    const [finding] = collapseInstallScriptFindings(many, base).findings;
    expect(finding?.details?.packages).toHaveLength(30);
    expect(finding?.message).toContain('and 20 more');
    expect(finding?.message).not.toContain('pkg-29');
  });

  test('the fingerprint is derived from the sorted package set', () => {
    const fingerprintOf = (names: string[]) =>
      collapseInstallScriptFindings(names.map((name) => perPackage(name)), base).findings[0]?.fingerprint;
    expect(fingerprintOf(['sharp', 'esbuild', 'fsevents'])).toBe(fingerprintOf(NAMES));
    expect(fingerprintOf(['esbuild', 'fsevents', 'other'])).not.toBe(fingerprintOf(NAMES));
    expect(fingerprintOf(['esbuild', 'fsevents'])).not.toBe(fingerprintOf(NAMES));
  });

  test('a baseline entry for the collapsed fingerprint covers exactly that package set', () => {
    const first = collapseInstallScriptFindings(NAMES.map((name) => perPackage(name)), base);
    const baseline = new Set([first.findings[0]?.fingerprint ?? '']);
    const same = collapseInstallScriptFindings(NAMES.map((name) => perPackage(name)), { ...base, baseline });
    expect(same.findings).toEqual([]);
    expect(same.suppressed).toBe(1);
    const other = collapseInstallScriptFindings(['esbuild', 'fsevents', 'other'].map((name) => perPackage(name)), {
      ...base,
      baseline,
    });
    expect(other.findings).toHaveLength(1);
    expect(other.suppressed).toBe(0);
  });

  test('a lockfile that is not wholly new keeps one finding per package', () => {
    const input = NAMES.map((name) => perPackage(name));
    expect(collapseInstallScriptFindings(input, { ...base, lockfileWhollyNew: false }).findings).toEqual(input);
    expect(collapseInstallScriptFindings(input, { ...base, lockfileWhollyNew: undefined }).findings).toEqual(input);
  });

  test('audit mode keeps its per-package findings', () => {
    const input = NAMES.map((name) => perPackage(name, { severity: 'low' }));
    expect(collapseInstallScriptFindings(input, { ...base, hasComparisonBase: false }).findings).toEqual(input);
  });

  test('a single surviving package keeps its own finding', () => {
    const input = [perPackage('esbuild')];
    expect(collapseInstallScriptFindings(input, base).findings).toEqual(input);
  });

  test('findings of other rules and signals are left alone', () => {
    const other: Finding = { ...perPackage('x'), ruleId: 'typosquat', details: { signal: 'edit-distance' } };
    const pnpmStyle: Finding = { ...perPackage('y'), details: { signal: 'only-built-added' } };
    const result = collapseInstallScriptFindings([other, pnpmStyle, ...NAMES.map((name) => perPackage(name))], base);
    expect(result.findings).toContain(other);
    expect(result.findings).toContain(pnpmStyle);
    expect(result.findings).toHaveLength(3);
  });
});
