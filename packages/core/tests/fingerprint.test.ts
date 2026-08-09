import { fingerprintFinding } from '../src/fingerprint.js';
import type { Finding } from '../src/types.js';

type RawFinding = Omit<Finding, 'fingerprint'>;

function makeFinding(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    ruleId: 'unknown-package',
    severity: 'high',
    packageName: 'reeact-definitely-not-real',
    message: 'a message that can change freely',
    manifestPath: 'package.json',
    ...overrides,
  };
}

describe('fingerprintFinding', () => {
  test('is deterministic for identical input', () => {
    const finding = makeFinding();

    expect(fingerprintFinding(finding)).toBe(fingerprintFinding(finding));
  });

  test('is a lowercase 64-character sha256 hex digest', () => {
    const fingerprint = fingerprintFinding(makeFinding());

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test('excludes severity: two findings differing only in severity share a fingerprint', () => {
    const critical = makeFinding({ severity: 'critical' });
    const low = makeFinding({ severity: 'low' });

    expect(fingerprintFinding(critical)).toBe(fingerprintFinding(low));
  });

  test('excludes message and version-bearing details: only ruleId/packageName/manifestPath/signal matter', () => {
    const before = makeFinding({
      message: '"left-pad" is specified as "1.0.0"',
      details: { specifier: '1.0.0', corpusBuiltAt: '2026-08-01' },
    });
    const after = makeFinding({
      message: '"left-pad" is specified as "2.0.0", published after the corpus was built',
      details: { specifier: '2.0.0', corpusBuiltAt: '2026-09-01' },
    });

    expect(fingerprintFinding(before)).toBe(fingerprintFinding(after));
  });

  test('changes when ruleId differs', () => {
    const a = makeFinding({ ruleId: 'unknown-package' });
    const b = makeFinding({ ruleId: 'typosquat' });

    expect(fingerprintFinding(a)).not.toBe(fingerprintFinding(b));
  });

  test('changes when packageName differs', () => {
    const a = makeFinding({ packageName: 'left-pad' });
    const b = makeFinding({ packageName: 'right-pad' });

    expect(fingerprintFinding(a)).not.toBe(fingerprintFinding(b));
  });

  test('changes when manifestPath differs', () => {
    const a = makeFinding({ manifestPath: 'package.json' });
    const b = makeFinding({ manifestPath: 'packages/app/package.json' });

    expect(fingerprintFinding(a)).not.toBe(fingerprintFinding(b));
  });

  // The binding requirement this whole file exists to pin down: a single
  // dependency can trip three lockfile-tamper signals at once (a git-source
  // swap that also lost its integrity hash, say), sharing ruleId,
  // packageName, and manifestPath. Without details.signal in the hash, all
  // three would collide onto one fingerprint, and baselining any one of
  // them would silently suppress the other two.
  test('details.signal is required: three findings sharing every other field get three distinct fingerprints', () => {
    const gitSource = makeFinding({
      ruleId: 'lockfile-tamper',
      packageName: 'left-pad',
      manifestPath: 'package.json',
      details: { signal: 'git-source' },
    });
    const integrityRemoved = makeFinding({
      ruleId: 'lockfile-tamper',
      packageName: 'left-pad',
      manifestPath: 'package.json',
      details: { signal: 'integrity-removed' },
    });
    const hostChanged = makeFinding({
      ruleId: 'lockfile-tamper',
      packageName: 'left-pad',
      manifestPath: 'package.json',
      details: { signal: 'host-changed' },
    });

    const fingerprints = new Set([
      fingerprintFinding(gitSource),
      fingerprintFinding(integrityRemoved),
      fingerprintFinding(hostChanged),
    ]);
    expect(fingerprints.size).toBe(3);
  });

  test('a missing details.signal is treated as an empty string, distinct from any real signal', () => {
    const noSignal = makeFinding({
      ruleId: 'lockfile-tamper',
      packageName: 'left-pad',
      manifestPath: 'package.json',
    });
    const emptySignal = makeFinding({
      ruleId: 'lockfile-tamper',
      packageName: 'left-pad',
      manifestPath: 'package.json',
      details: { signal: '' },
    });
    const realSignal = makeFinding({
      ruleId: 'lockfile-tamper',
      packageName: 'left-pad',
      manifestPath: 'package.json',
      details: { signal: 'git-source' },
    });

    expect(fingerprintFinding(noSignal)).toBe(fingerprintFinding(emptySignal));
    expect(fingerprintFinding(noSignal)).not.toBe(fingerprintFinding(realSignal));
  });

  // delta.ts:41-46 already refuses to build a composite key by joining
  // parts with a plain separator, for exactly this reason -- a separator
  // character that can itself appear inside a part lets two different
  // (packageName, manifestPath) pairs hash identically. A literal newline
  // in either field (a corrupted or adversarial manifest key/path) would
  // otherwise let one part's suffix bleed into the next part's prefix.
  test('does not collide when packageName and manifestPath together contain an embedded newline', () => {
    const a = makeFinding({ packageName: 'a\nb', manifestPath: 'c' });
    const b = makeFinding({ packageName: 'a', manifestPath: 'b\nc' });

    expect(fingerprintFinding(a)).not.toBe(fingerprintFinding(b));
  });

  test('no details object at all is the same as details with no signal key', () => {
    const noDetails = makeFinding();
    const detailsNoSignal = makeFinding({ details: { specifier: '1.0.0' } });

    expect(fingerprintFinding(noDetails)).toBe(fingerprintFinding(detailsNoSignal));
  });
});
