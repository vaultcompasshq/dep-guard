import { describe, expect, it } from '@jest/globals';

import {
  assertCountsOnly,
  assertPrivateEntry,
  countedKeys,
  DIAGNOSTIC_CODES,
  RULE_IDS,
  summarize,
} from '../lib/counts.mjs';

function scanResult(overrides = {}) {
  return {
    findings: [],
    suppressed: 0,
    ignored: 0,
    run: { lockfileFormat: 'npm', diagnostics: [] },
    exitCode: 0,
    ...overrides,
  };
}

function finding(ruleId, severity, packageName = 'secret-internal-package') {
  return {
    ruleId,
    severity,
    packageName,
    message: `${packageName} is a problem`,
    manifestPath: 'services/billing/package.json',
    fingerprint: 'abc',
  };
}

describe('summarize', () => {
  it('counts findings by rule and by severity', () => {
    const summary = summarize(
      scanResult({
        findings: [
          finding('unknown-package', 'high'),
          finding('unknown-package', 'high'),
          finding('typosquat', 'critical'),
        ],
      })
    );
    expect(summary.findings.total).toBe(3);
    expect(summary.findings.byRule['unknown-package']).toBe(2);
    expect(summary.findings.byRule.typosquat).toBe(1);
    expect(summary.findings.bySeverity.high).toBe(2);
    expect(summary.findings.bySeverity.critical).toBe(1);
  });

  it('seeds every bucket, so an absent rule reads as zero rather than as missing', () => {
    const summary = summarize(scanResult());
    for (const ruleId of RULE_IDS) {
      expect(summary.findings.byRule[ruleId]).toBe(0);
    }
    expect(summary.findings.total).toBe(0);
  });

  it('counts diagnostics by code', () => {
    const summary = summarize(
      scanResult({
        run: {
          lockfileFormat: 'pnpm',
          diagnostics: [
            { code: 'lockfile-missing', message: 'no lockfile at services/billing' },
            { code: 'lockfile-missing', message: 'again' },
          ],
        },
      })
    );
    expect(summary.diagnostics.total).toBe(2);
    expect(summary.diagnostics.byCode['lockfile-missing']).toBe(2);
  });

  it('records the lockfile format as a one-hot count rather than a string', () => {
    const summary = summarize(scanResult({ run: { lockfileFormat: 'yarn', diagnostics: [] } }));
    expect(summary.lockfile.yarn).toBe(1);
    expect(summary.lockfile.npm).toBe(0);
  });

  it('files a value it does not recognise under "other" instead of minting a key for it', () => {
    // This is the property that makes the harness safe to point at private
    // work: a value that came out of the scanned repository can never
    // become a key in the output, however new it is.
    const summary = summarize(
      scanResult({
        findings: [finding('some-future-rule', 'catastrophic')],
        run: {
          lockfileFormat: 'deno',
          diagnostics: [{ code: 'brand-new-code', message: 'x' }],
        },
      })
    );
    expect(summary.findings.byRule.other).toBe(1);
    expect(summary.findings.bySeverity.other).toBe(1);
    expect(summary.diagnostics.byCode.other).toBe(1);
    expect(summary.lockfile.other).toBe(1);
    expect(Object.keys(summary.findings.byRule)).not.toContain('some-future-rule');
  });

  it('emits no package name, path, message or fingerprint anywhere', () => {
    const summary = summarize(
      scanResult({
        findings: [finding('typosquat', 'critical', 'acme-internal-auth')],
        run: {
          lockfileFormat: 'npm',
          diagnostics: [{ code: 'lockfile-missing', message: 'apps/secret/package.json' }],
        },
      })
    );
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('acme-internal-auth');
    expect(serialized).not.toContain('services/billing');
    expect(serialized).not.toContain('apps/secret');
    expect(serialized).not.toContain('abc');
  });

  it('carries the gate outcome, which is a number and says nothing about the repository', () => {
    const summary = summarize(scanResult({ exitCode: 1, suppressed: 2, ignored: 3 }));
    expect(summary.exitCode).toBe(1);
    expect(summary.suppressed).toBe(2);
    expect(summary.ignored).toBe(3);
  });
});

describe('assertCountsOnly', () => {
  it('accepts a summary', () => {
    expect(() => assertCountsOnly(summarize(scanResult()))).not.toThrow();
  });

  it('rejects a string value even under a key it does allow', () => {
    const summary = summarize(scanResult());
    summary.findings.total = 'critical';
    expect(() => assertCountsOnly(summary)).toThrow(/string/i);
  });

  it('rejects a key outside the vocabulary the harness declares', () => {
    const summary = summarize(scanResult());
    summary.findings.byRule['acme-internal-auth'] = 1;
    expect(() => assertCountsOnly(summary)).toThrow(/acme-internal-auth/);
  });

  it('rejects an array, which could carry names positionally', () => {
    const summary = summarize(scanResult());
    summary.findings.byRule.other = ['acme-internal-auth'];
    expect(() => assertCountsOnly(summary)).toThrow(/array/i);
  });

  it('rejects a non-finite number, which JSON cannot round-trip', () => {
    const summary = summarize(scanResult());
    summary.findings.total = Number.NaN;
    expect(() => assertCountsOnly(summary)).toThrow(/number/i);
  });

  it('rejects a private entry identified by anything but its position', () => {
    const counts = summarize(scanResult());
    expect(() => assertPrivateEntry({ repo: 'local-1', sha: null, counts })).not.toThrow();
    expect(() => assertPrivateEntry({ repo: 'acme/billing', sha: null, counts })).toThrow(
      /position/
    );
    expect(() => assertPrivateEntry({ repo: 'local-1', sha: 'abc', counts })).toThrow(/commit/);
  });

  it('rejects a private entry that has grown an extra field', () => {
    const counts = summarize(scanResult());
    expect(() =>
      assertPrivateEntry({ repo: 'local-1', sha: null, counts, path: '/srv/acme' })
    ).toThrow(/exactly repo, sha and counts/);
  });

  it('derives its vocabulary from the same lists summarize counts into', () => {
    // Not a second copy of the key list: if a rule id is added in one place
    // and not the other, this is what catches it.
    for (const ruleId of RULE_IDS) {
      expect(countedKeys()).toContain(ruleId);
    }
    for (const code of DIAGNOSTIC_CODES) {
      expect(countedKeys()).toContain(code);
    }
  });
});
