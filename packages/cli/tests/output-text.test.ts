import { renderCoverageLines, renderNamesLine, renderText } from '../src/output-text.js';
import type { EcosystemsSummary, ScanResult } from '@vaultcompass/dep-guard-core';

function ecosystems(): EcosystemsSummary {
  return {
    npm: { manifests: 1, candidates: 0, checked: 0, notChecked: { privateScope: 0 }, lockfile: 'read', notParsed: 0 },
    go: { files: 0 },
    pypi: {
      requirements: 0,
      pinned: 0,
      notParsed: 0,
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
    ignoreKept: 0,
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
  base.npm = { manifests: 2, candidates: 3, checked: 3, notChecked: { privateScope: 0 }, lockfile: 'read', notParsed: 0 };
  base.pypi.manifests = 2;
  base.pypi.lockfiles = 1;
  base.pypi.candidates = 7;
  base.pypi.resemblanceChecked = 7;
  base.pypi.existenceChecked = existenceChecked;
  base.pypi.notChecked = { ...base.pypi.notChecked, ...notChecked };
  base.pypi.excluded.vcs = 1;
  return base;
}

describe('renderText: kept over ignorePaths', () => {
  test('H34 printed, at zero, only when the run applied the ignorePaths project rule', () => {
    const applied = { ...scanResult(OFFLINE), ignoreRuleApplied: true };
    const notApplied: ScanResult = {
      ...scanResult(OFFLINE),
      ignoreRuleApplied: false,
      run: { ...scanResult(OFFLINE).run, mode: 'staged' },
    };

    expect(renderText(applied)).toContain('0 ignored, 0 kept over ignorePaths, 0 allowed');
    expect(renderText(notApplied)).toContain('0 ignored, 0 allowed');
    expect(renderText(notApplied)).not.toContain('kept over ignorePaths');
  });
});

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

function withEcosystems(
  names: EcosystemsSummary,
  online: ScanResult['run']['online'] = OFFLINE
): ScanResult {
  const result = scanResult(online, names);
  result.run.lockfileFormat = 'npm';
  return result;
}

describe('renderCoverageLines', () => {
  test('npm with a read lockfile, offline', () => {
    expect(renderCoverageLines(withEcosystems(ecosystems()))).toEqual([
      'coverage:',
      '  npm: read, with a lockfile. Ran: unknown-package, typosquat, version-hygiene, dependency-confusion, ' +
        'lockfile-tamper, install-script. Did not run: registered-squat and publish-age (they need --online).',
    ]);
  });

  test('a pnpm lockfile qualifies install-script: there is no per-entry flag', () => {
    const result = withEcosystems(ecosystems(), ONLINE);
    result.run.lockfileFormat = 'pnpm';
    const [, npm] = renderCoverageLines(result);
    expect(npm).toContain('lockfile-tamper, install-script (onlyBuiltDependencies only; pnpm lockfiles carry no per-entry flag)');
  });

  test('an audit scan qualifies lockfile-tamper: nothing to compare against', () => {
    const result = withEcosystems(ecosystems(), ONLINE);
    result.run.mode = 'audit';
    const [, npm] = renderCoverageLines(result);
    expect(npm).toContain(
      'lockfile-tamper (git-source and url-source signals only; no earlier revision to compare), install-script'
    );
  });

  test('a comparison run on an npm lockfile qualifies neither', () => {
    const [, npm] = renderCoverageLines(withEcosystems(ecosystems(), ONLINE));
    expect(npm).toContain('lockfile-tamper, install-script,');
  });

  test('npm online runs the registry checks too', () => {
    expect(renderCoverageLines(withEcosystems(ecosystems(), ONLINE))).toEqual([
      'coverage:',
      '  npm: read, with a lockfile. Ran: unknown-package, typosquat, version-hygiene, dependency-confusion, ' +
        'lockfile-tamper, install-script, registered-squat, publish-age.',
    ]);
  });

  test('npm with no lockfile says which checks could not run and why', () => {
    const names = ecosystems();
    names.npm.lockfile = 'missing';
    expect(renderCoverageLines(withEcosystems(names, ONLINE))).toEqual([
      'coverage:',
      '  npm: read, no lockfile. Ran: unknown-package, typosquat, version-hygiene, dependency-confusion, ' +
        'registered-squat, publish-age. Did not run: lockfile-tamper and install-script (no npm or pnpm lockfile found).',
    ]);
  });

  test('npm with a lockfile in a format dep-guard does not read', () => {
    const names = ecosystems();
    names.npm.lockfile = 'not-read';
    const [, npm] = renderCoverageLines(withEcosystems(names, ONLINE));
    expect(npm).toContain('Did not run: lockfile-tamper and install-script (a lockfile is present but dep-guard does not read its format).');
  });

  test('pypi offline with every requirement pinned says pinned requirements are not a lockfile it compares', () => {
    const names = ecosystems();
    names.npm.manifests = 0;
    names.pypi.manifests = 1;
    names.pypi.requirements = 4;
    names.pypi.pinned = 4;
    expect(renderCoverageLines(withEcosystems(names))).toEqual([
      'coverage:',
      "  pypi: read (1 manifest, 0 lockfiles). Ran: typosquat against this repository's own Python names, " +
        'tamper for git and url requirements. Did not run: unknown-package (it needs --online; no PyPI corpus ships), ' +
        'lockfile-tamper comparison and install-script (dep-guard reads npm and pnpm lockfiles only; Python ' +
        'lockfiles are read for names). All 4 requirements are pinned exactly; pinned requirements are not a ' +
        'lockfile dep-guard compares.',
    ]);
  });

  test('pypi online with some requirements unpinned makes no pinning claim', () => {
    const names = ecosystems();
    names.npm.manifests = 0;
    names.pypi.manifests = 2;
    names.pypi.lockfiles = 1;
    names.pypi.requirements = 4;
    names.pypi.pinned = 3;
    const [, pypi] = renderCoverageLines(withEcosystems(names, ONLINE));
    expect(pypi).toContain('pypi: read (2 manifests, 1 lockfile). Ran: unknown-package (PyPI), typosquat');
    expect(pypi).not.toContain('pinned');
  });

  test('go is seen and not read', () => {
    const names = ecosystems();
    names.npm.manifests = 0;
    names.go.files = 2;
    expect(renderCoverageLines(withEcosystems(names))).toEqual([
      'coverage:',
      '  go: not read. go.mod and go.sum are not read by dep-guard (2 files seen).',
    ]);
  });

  test('all three ecosystems print in order', () => {
    const names = ecosystems();
    names.pypi.manifests = 1;
    names.go.files = 1;
    const lines = renderCoverageLines(withEcosystems(names));
    expect(lines.map((line) => line.trim().split(':')[0])).toEqual(['coverage', 'npm', 'pypi', 'go']);
    expect(lines[3]).toBe('  go: not read. go.mod and go.sum are not read by dep-guard (1 file seen).');
  });

  test('nothing to say for a run with no repository behind it', () => {
    const names = ecosystems();
    names.npm.lockfile = 'not-applicable';
    expect(renderCoverageLines(withEcosystems(names))).toEqual([]);
  });

  test('printed under the names line, before the online line', () => {
    const names = ecosystems();
    names.pypi.manifests = 1;
    const text = renderText(withEcosystems(names, ONLINE));
    const lines = text.split('\n');
    const at = lines.findIndex((line) => line.startsWith('coverage:'));
    expect(lines[at - 1]).toMatch(/^names: /);
    expect(lines.findIndex((line) => line.startsWith('online:'))).toBeGreaterThan(at);
  });
});

describe('renderText: the limits of an audit scan', () => {
  function auditResult(codes: string[], mode: ScanResult['run']['mode'] = 'audit'): ScanResult {
    const result = scanResult(OFFLINE);
    result.run.mode = mode;
    result.run.diagnostics = codes.map((code) => ({ code, message: `message of ${code}` }));
    return result;
  }

  test('several audit limits become one note carrying every message', () => {
    const text = renderText(
      auditResult(['audit-no-tamper-comparison', 'pnpm-no-install-script-flag', 'pypi-names-not-checked'])
    );
    const notes = text.split('\n').filter((line) => line.startsWith('note ('));
    expect(notes).toEqual([
      'note (audit-limits): limits of this scan: (1) message of audit-no-tamper-comparison; ' +
        '(2) message of pnpm-no-install-script-flag; (3) message of pypi-names-not-checked',
    ]);
  });

  test('other notes stay as they were, in place', () => {
    const text = renderText(
      auditResult(['ignore-path-unmatched', 'audit-no-tamper-comparison', 'pnpm-no-install-script-flag'])
    );
    const notes = text.split('\n').filter((line) => line.startsWith('note ('));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toBe('note (ignore-path-unmatched): message of ignore-path-unmatched');
    expect(notes[1]).toMatch(/^note \(audit-limits\)/);
  });

  test('a single limit is left as its own note', () => {
    const text = renderText(auditResult(['audit-no-tamper-comparison']));
    expect(text).toContain('note (audit-no-tamper-comparison): message of audit-no-tamper-comparison');
    expect(text).not.toContain('audit-limits');
  });

  test('a run with a base keeps one note per item', () => {
    const text = renderText(auditResult(['audit-no-tamper-comparison', 'pnpm-no-install-script-flag'], 'base'));
    expect(text).not.toContain('audit-limits');
    expect(text.split('\n').filter((line) => line.startsWith('note ('))).toHaveLength(2);
  });

  test('the JSON diagnostics are not touched', () => {
    const result = auditResult(['audit-no-tamper-comparison', 'pnpm-no-install-script-flag']);
    renderText(result);
    expect(result.run.diagnostics.map((entry) => entry.code)).toEqual([
      'audit-no-tamper-comparison',
      'pnpm-no-install-script-flag',
    ]);
  });

  test('a limit message is sanitized like any note', () => {
    const result = auditResult(['audit-no-tamper-comparison', 'pnpm-no-install-script-flag']);
    result.run.diagnostics[0] = { code: 'audit-no-tamper-comparison', message: 'a\u001b[31mb\nc' };
    const text = renderText(result);
    expect(text).not.toContain('\u001b');
    expect(text).toContain('(1) a[31mb c;');
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
