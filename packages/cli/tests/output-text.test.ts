import { renderNamesLine, renderText } from '../src/output-text.js';
import type { EcosystemsSummary, ScanResult } from '@vaultcompass/dep-guard-core';

function ecosystems(): EcosystemsSummary {
  return {
    npm: { manifests: 1, candidates: 0, checked: 0, notChecked: { privateScope: 0 } },
    pypi: {
      manifests: 0,
      lockfiles: 0,
      candidates: 0,
      existenceChecked: 0,
      resemblanceChecked: 0,
      notChecked: { offline: 0, budget: 0, unreachable: 0, privateIndex: 0, internal: 0, lockfileUnreadable: 0 },
      excluded: { url: 0, vcs: 0, path: 0, editable: 0, constraint: 0, self: 0, invalidName: 0, unrecognised: 0 },
    },
  };
}

function scanResult(online: ScanResult['run']['online'], names: EcosystemsSummary = ecosystems()): ScanResult {
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
      ecosystems: names,
    },
    exitCode: 0,
  };
}

const OFFLINE = {
  enabled: false,
  budgetMs: 0,
  lookupsAttempted: 0,
  cacheHits: 0,
  lookupsSkippedByDeadline: 0,
  deadlineExceeded: false,
};
const ONLINE = { ...OFFLINE, enabled: true, budgetMs: 20000, lookupsAttempted: 7 };

// The design's three sample lines: 3 npm names, 7 Python names in two
// Python manifests, one vcs requirement excluded.
function sample(existenceChecked: number, notChecked: Partial<EcosystemsSummary['pypi']['notChecked']>): EcosystemsSummary {
  const base = ecosystems();
  base.npm = { manifests: 2, candidates: 3, checked: 3, notChecked: { privateScope: 0 } };
  base.pypi.manifests = 2;
  base.pypi.lockfiles = 1;
  base.pypi.candidates = 7;
  base.pypi.resemblanceChecked = 7;
  base.pypi.existenceChecked = existenceChecked;
  base.pypi.notChecked = { ...base.pypi.notChecked, ...notChecked };
  base.pypi.excluded.vcs = 1;
  return base;
}

describe('renderText: the names line', () => {
  test('plain run, no --online, byte for byte', () => {
    expect(renderNamesLine(scanResult(OFFLINE, sample(0, { offline: 7 })))).toBe(
      'names: npm 3 checked (corpus); pypi 7 not checked for existence (no PyPI corpus ships; pass --online), ' +
        "resemblance checked against this repository's own Python names; 1 url, path or vcs requirement excluded"
    );
  });

  test('--online, everything answered, byte for byte', () => {
    expect(renderNamesLine(scanResult(ONLINE, sample(7, {})))).toBe(
      'names: npm 3 checked (corpus, registry); pypi 7 of 7 checked for existence (PyPI), resemblance checked ' +
        "against this repository's own Python names; 1 url, path or vcs requirement excluded"
    );
  });

  test('--online, degraded, byte for byte', () => {
    expect(renderNamesLine(scanResult(ONLINE, sample(5, { budget: 1, unreachable: 1 })))).toBe(
      'names: npm 3 checked (corpus, registry); pypi 5 of 7 checked for existence (PyPI); 2 not checked: 1 ' +
        "online budget spent, 1 PyPI unreachable; resemblance checked against this repository's own Python " +
        'names; 1 url, path or vcs requirement excluded'
    );
  });

  test('an unreadable lockfile is its own clause, never added to the names not checked', () => {
    const names = sample(6, { privateIndex: 1, lockfileUnreadable: 1 });
    expect(renderNamesLine(scanResult(ONLINE, names))).toBe(
      'names: npm 3 checked (corpus, registry); pypi 6 of 7 checked for existence (PyPI); 1 not checked: 1 ' +
        "private index; resemblance checked against this repository's own Python names; 1 lockfile unreadable, " +
        'its names not checked; 1 url, path or vcs requirement excluded'
    );
  });

  test('the line is printed under the run summary', () => {
    const text = renderText(scanResult(OFFLINE, sample(0, { offline: 7 })));
    const lines = text.split('\n');
    const summary = lines.findIndex((line) => line.startsWith('dep-guard base:'));
    expect(lines[summary + 1]).toMatch(/^names: /);
  });

  test('no names line when no Python file was read', () => {
    expect(renderNamesLine(scanResult(OFFLINE))).toBeNull();
    expect(renderText(scanResult(OFFLINE))).not.toContain('names:');
  });
});

describe('renderText: online summary line', () => {
  test('prints cache hits beside lookups (issue #80)', () => {
    const text = renderText(
      scanResult({
        enabled: true,
        budgetMs: 300000,
        lookupsAttempted: 0,
        cacheHits: 5,
        lookupsSkippedByDeadline: 0,
        deadlineExceeded: false,
      })
    );

    expect(text).toContain(
      'online: budgetMs=300000, lookupsAttempted=0, cacheHits=5, ' +
        'lookupsSkippedByDeadline=0, deadlineExceeded=false'
    );
  });

  test('prints no online line when online checks did not run', () => {
    const text = renderText(
      scanResult({
        enabled: false,
        budgetMs: 0,
        lookupsAttempted: 0,
        cacheHits: 0,
        lookupsSkippedByDeadline: 0,
        deadlineExceeded: false,
      })
    );

    expect(text).not.toContain('online:');
  });
});
