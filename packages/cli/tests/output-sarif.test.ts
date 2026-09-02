import { renderSarif, SARIF_FINGERPRINT_KEY, SARIF_RULE_NAMESPACE } from '../src/output-sarif.js';
import type { Finding, ScanResult, Severity } from '@vaultcompass/dep-guard-core';

// SARIF is a contract with tools nobody here controls -- GitHub code
// scanning most immediately -- so these tests pin the mapping field by
// field rather than snapshotting a blob. A snapshot would go green on a
// change that quietly stopped uploading and start failing on a
// whitespace edit; neither is what needs guarding.

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: 'unknown-package',
    severity: 'high',
    packageName: 'some-package',
    message: 'the message',
    manifestPath: 'package.json',
    fingerprint: 'abc123',
    details: { specifier: '^1.0.0', depType: 'dependencies' },
    ...overrides,
  };
}

function scanResult(findings: Finding[], overrides: Partial<ScanResult['run']> = {}): ScanResult {
  return {
    findings,
    suppressed: 0,
    ignored: 0,
    run: {
      mode: 'staged',
      failOn: 'medium',
      blockingMatches: 0,
      durationMs: 1,
      corpusBuiltAt: '2026-01-01',
      lockfileFormat: 'npm',
      diagnostics: [],
      ...overrides,
    },
    exitCode: 0,
  };
}

function parse(result: ScanResult, version = '0.2.0') {
  return JSON.parse(renderSarif(result, version)) as {
    version: string;
    $schema: string;
    runs: Array<{
      tool: { driver: { name: string; version: string; rules: Array<{ id: string; shortDescription: { text: string } }> } };
      results: Array<{
        ruleId: string;
        level: string;
        message: { text: string };
        properties: { blocking: boolean; severity: string; details: Record<string, unknown> };
        partialFingerprints: Record<string, string>;
        locations: Array<{
          logicalLocations?: Array<{ kind: string; fullyQualifiedName: string }>;
          physicalLocation?: {
            artifactLocation: { uri: string; uriBaseId: string };
            region?: { startLine: number };
          };
        }>;
      }>;
    }>;
  };
}

describe('renderSarif: the envelope', () => {
  test('is SARIF 2.1.0 with exactly one run', () => {
    const sarif = parse(scanResult([finding()]));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toContain('sarif');
    expect(sarif.runs).toHaveLength(1);
  });

  test('names the tool and takes its version from the caller, not a literal', () => {
    const sarif = parse(scanResult([finding()]), '9.9.9');
    expect(sarif.runs[0].tool.driver.name).toBe('dep-guard');
    expect(sarif.runs[0].tool.driver.version).toBe('9.9.9');
  });

  test('a clean scan is still a valid run with an empty results array', () => {
    const sarif = parse(scanResult([]));
    expect(sarif.runs[0].results).toEqual([]);
    expect(sarif.runs[0].tool.driver.rules.length).toBeGreaterThan(0);
  });

  test('every rule id is declared with a short description, and results point at declared rules', () => {
    // SARIF consumers resolve a result's ruleId against the driver's rules
    // array. A result naming a rule the driver never declared renders
    // without a description and, in some consumers, is dropped.
    const sarif = parse(
      scanResult([finding(), finding({ ruleId: 'typosquat', severity: 'low' })])
    );
    const declared = new Set(sarif.runs[0].tool.driver.rules.map((r) => r.id));
    for (const rule of sarif.runs[0].tool.driver.rules) {
      expect(rule.id.startsWith(`${SARIF_RULE_NAMESPACE}/`)).toBe(true);
      expect(rule.shortDescription.text.length).toBeGreaterThan(0);
    }
    for (const result of sarif.runs[0].results) {
      expect(declared.has(result.ruleId)).toBe(true);
    }
  });
});

describe('renderSarif: the result mapping', () => {
  test('namespaces the rule id under the product', () => {
    const sarif = parse(scanResult([finding({ ruleId: 'typosquat' })]));
    expect(sarif.runs[0].results[0].ruleId).toBe('dep-guard/typosquat');
  });

  test('maps every severity to its SARIF level', () => {
    const expected: Array<[Severity, string]> = [
      ['critical', 'error'],
      ['high', 'error'],
      ['medium', 'warning'],
      ['low', 'note'],
    ];
    for (const [severity, level] of expected) {
      const sarif = parse(scanResult([finding({ severity })]));
      expect([severity, sarif.runs[0].results[0].level]).toEqual([severity, level]);
    }
  });

  test('carries the finding message verbatim', () => {
    const sarif = parse(scanResult([finding({ message: 'exactly this' })]));
    expect(sarif.runs[0].results[0].message.text).toBe('exactly this');
  });

  test('properties carry dep-guard severity word and the details bag verbatim', () => {
    const details = { specifier: '^1.0.0', signal: 'host-changed:https://x', nested: { a: 1 } };
    const sarif = parse(scanResult([finding({ severity: 'medium', details })]));
    const properties = sarif.runs[0].results[0].properties;
    expect(properties.severity).toBe('medium');
    expect(properties.details).toEqual(details);
  });

  test('a finding with no details still produces a details bag rather than undefined', () => {
    const bare = finding();
    delete bare.details;
    const sarif = parse(scanResult([bare]));
    expect(sarif.runs[0].results[0].properties.details).toEqual({});
  });

  test('partialFingerprints reuse the finding fingerprint unchanged, under one versioned key', () => {
    const sarif = parse(scanResult([finding({ fingerprint: 'deadbeef' })]));
    const fingerprints = sarif.runs[0].results[0].partialFingerprints;
    expect(Object.keys(fingerprints)).toEqual([SARIF_FINGERPRINT_KEY]);
    expect(fingerprints[SARIF_FINGERPRINT_KEY]).toBe('deadbeef');
  });
});

describe('renderSarif: blocking is dep-guard decision, not a recomputed one', () => {
  test('follows the run failOn, so the same finding flips with the threshold', () => {
    const high = finding({ severity: 'high' });
    expect(
      parse(scanResult([high], { failOn: 'medium' })).runs[0].results[0].properties.blocking
    ).toBe(true);
    expect(
      parse(scanResult([high], { failOn: 'critical' })).runs[0].results[0].properties.blocking
    ).toBe(false);
  });

  test('failOn none blocks nothing, including a critical', () => {
    const sarif = parse(scanResult([finding({ severity: 'critical' })], { failOn: 'none' }));
    expect(sarif.runs[0].results[0].properties.blocking).toBe(false);
  });

  test('the blocking flags agree with the count core itself reported', () => {
    // The real cross-check. If this renderer ever grows its own severity
    // ladder, or reads the wrong threshold, the flags it writes and the
    // number core computed will disagree -- and this is the only thing
    // that would notice.
    const findings: Finding[] = [
      finding({ severity: 'low', fingerprint: 'a' }),
      finding({ severity: 'medium', fingerprint: 'b' }),
      finding({ severity: 'high', fingerprint: 'c' }),
      finding({ severity: 'critical', fingerprint: 'd' }),
    ];
    for (const failOn of ['critical', 'high', 'medium', 'low', 'none'] as const) {
      const expectedBlocking = findings.filter((f) => {
        if (failOn === 'none') return false;
        const order = ['low', 'medium', 'high', 'critical'];
        return order.indexOf(f.severity) >= order.indexOf(failOn);
      }).length;
      const sarif = parse(
        scanResult(findings, { failOn, blockingMatches: expectedBlocking })
      );
      const flagged = sarif.runs[0].results.filter((r) => r.properties.blocking).length;
      expect([failOn, flagged]).toEqual([failOn, expectedBlocking]);
    }
  });
});

describe('renderSarif: locations', () => {
  test('carries a package logical location and a repo-relative physical one', () => {
    const sarif = parse(
      scanResult([finding({ packageName: '@scope/thing', manifestPath: 'packages/app/package.json' })])
    );
    const location = sarif.runs[0].results[0].locations[0];
    expect(location.logicalLocations?.[0]).toEqual({
      kind: 'package',
      fullyQualifiedName: '@scope/thing',
    });
    expect(location.physicalLocation?.artifactLocation).toEqual({
      uri: 'packages/app/package.json',
      uriBaseId: '%SRCROOT%',
    });
  });

  test('omits the region entirely when no line is known', () => {
    // "Never invent a line number": a fabricated startLine puts a code
    // scanning annotation on an unrelated line of somebody's manifest, and
    // it is indistinguishable from a real one once uploaded.
    const sarif = parse(scanResult([finding()]));
    expect(sarif.runs[0].results[0].locations[0].physicalLocation).not.toHaveProperty('region');
  });

  test('includes a region when the finding actually carries a manifest line', () => {
    const sarif = parse(scanResult([finding({ details: { manifestLine: 42 } })]));
    expect(sarif.runs[0].results[0].locations[0].physicalLocation?.region).toEqual({
      startLine: 42,
    });
  });

  test('ignores a manifest line that is not a usable line number', () => {
    for (const bad of [0, -3, 1.5, '7', null, undefined, Number.NaN]) {
      const sarif = parse(scanResult([finding({ details: { manifestLine: bad } })]));
      expect([bad, sarif.runs[0].results[0].locations[0].physicalLocation?.region]).toEqual([
        bad,
        undefined,
      ]);
    }
  });

  test('never emits an absolute path or a backslash separator', () => {
    // Windows manifest paths and any future absolute anchor would both
    // break %SRCROOT% resolution, and an absolute path leaks a local
    // directory layout into an artifact that gets uploaded to GitHub.
    const sarif = parse(
      scanResult([
        finding({ manifestPath: 'packages\\app\\package.json' }),
        finding({ manifestPath: './nested/package.json', fingerprint: 'z' }),
      ])
    );
    for (const result of sarif.runs[0].results) {
      const uri = result.locations[0].physicalLocation?.artifactLocation.uri ?? '';
      expect(uri.length).toBeGreaterThan(0);
      expect(uri.startsWith('/')).toBe(false);
      expect(uri).not.toContain('\\');
      expect(uri.startsWith('./')).toBe(false);
    }
    const uris = sarif.runs[0].results.map(
      (r) => r.locations[0].physicalLocation?.artifactLocation.uri
    );
    expect(uris).toEqual(['packages/app/package.json', 'nested/package.json']);
  });

  test('strips a Windows drive letter rather than emitting an absolute uri', () => {
    // A leading "/" was already stripped, but "C:/Users/..." is just as
    // absolute and survived it untouched, so it would have reached an
    // uploaded artifact carrying a local directory layout, and %SRCROOT%
    // could not resolve it either.
    const sarif = parse(
      scanResult([
        finding({ manifestPath: 'C:\\project\\package.json' }),
        finding({ manifestPath: 'D:/work/app/package.json', fingerprint: 'y' }),
      ])
    );
    const uris = sarif.runs[0].results.map(
      (r) => r.locations[0].physicalLocation?.artifactLocation.uri
    );
    expect(uris).toEqual(['project/package.json', 'work/app/package.json']);
    for (const uri of uris) {
      expect(uri).not.toMatch(/^[A-Za-z]:/);
    }
  });
});

describe('renderSarif: the synthetic anchor of dep-guard check', () => {
  // checkSingle answers "is this name safe to add", a question with no
  // file behind it. Core fabricates a "package.json" manifestPath for it
  // (scan.ts's SYNTHETIC_MANIFEST_PATH). Pointing a SARIF physical
  // location at that path would annotate the consumer's REAL root
  // manifest with a finding about a package that is not in it, which is
  // a fabricated location rather than a missing one.
  function checkSingleResult(findings: Finding[]): ScanResult {
    return scanResult(findings, {
      mode: 'audit',
      diagnostics: [
        {
          code: 'check-single-name-only',
          message: 'checkSingle only evaluates the name-based checks',
        },
      ],
    });
  }

  test('omits the physical location entirely, keeping the logical one', () => {
    const sarif = parse(checkSingleResult([finding({ packageName: 'raect' })]));
    const location = sarif.runs[0].results[0].locations[0];
    expect(location.physicalLocation).toBeUndefined();
    expect(location.logicalLocations?.[0]).toEqual({
      kind: 'package',
      fullyQualifiedName: 'raect',
    });
  });

  test('an ordinary audit scan of a real root manifest keeps its physical location', () => {
    // The falsifiable half: the suppression has to key on the synthetic
    // question, not on the path spelling, or every real finding at the
    // repository root would lose its location too.
    const sarif = parse(scanResult([finding({ manifestPath: 'package.json' })], { mode: 'audit' }));
    expect(sarif.runs[0].results[0].locations[0].physicalLocation?.artifactLocation.uri).toBe(
      'package.json'
    );
  });
});
