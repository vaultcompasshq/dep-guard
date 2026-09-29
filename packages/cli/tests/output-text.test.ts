import { renderText } from '../src/output-text.js';
import type { ScanResult } from '@vaultcompass/dep-guard-core';

function scanResult(online: ScanResult['run']['online']): ScanResult {
  return {
    findings: [],
    suppressed: 0,
    ignored: 0,
    allowed: 0,
    allowedNames: [],
    run: {
      mode: 'base',
      failOn: 'medium',
      blockingMatches: 0,
      durationMs: 1,
      corpusBuiltAt: '2026-01-01',
      lockfileFormat: 'pnpm',
      diagnostics: [],
      online,
    },
    exitCode: 0,
  };
}

describe('renderText: online summary line', () => {
  test('prints candidates evaluated and cache hits beside lookups (issue #80)', () => {
    const text = renderText(
      scanResult({
        enabled: true,
        budgetMs: 300000,
        candidatesEvaluated: 5,
        lookupsAttempted: 0,
        cacheHits: 5,
        lookupsSkippedByDeadline: 0,
        deadlineExceeded: false,
      })
    );

    expect(text).toContain(
      'online: budgetMs=300000, candidatesEvaluated=5, lookupsAttempted=0, cacheHits=5, ' +
        'lookupsSkippedByDeadline=0, deadlineExceeded=false'
    );
  });

  test('prints no online line when online checks did not run', () => {
    const text = renderText(
      scanResult({
        enabled: false,
        budgetMs: 0,
        candidatesEvaluated: 0,
        lookupsAttempted: 0,
        cacheHits: 0,
        lookupsSkippedByDeadline: 0,
        deadlineExceeded: false,
      })
    );

    expect(text).not.toContain('online:');
  });
});
