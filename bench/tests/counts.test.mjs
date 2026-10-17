import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

import {
  assertCountsOnly,
  assertPrivateEntry,
  countedKeys,
  DIAGNOSTIC_CODES,
  LOCKFILE_FORMATS,
  RULE_IDS,
  summarize,
} from '../lib/counts.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_DIRS = [
  path.join(REPO_ROOT, 'packages', 'core', 'src'),
  path.join(REPO_ROOT, 'packages', 'cli', 'src'),
];

function sourceFiles() {
  const files = [];
  for (const dir of SOURCE_DIRS) {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(path.join(entry.parentPath, entry.name));
      }
    }
  }
  return files;
}

// The diagnostic codes the shipped source puts on a run, as far as a text
// scan can see them: a `code:` property given a single-quoted literal or an
// UPPER_CASE constant, the constant resolved against every single-quoted
// string constant the source declares (by name, across files, since codes
// are imported). This is a tripwire, not a parser. It reports, so the test
// can fail on them:
//   - a `code:` whose value is anything else (a template literal, a
//     double-quoted string, a ternary, a lowercase variable), since those
//     forms are exactly what the two patterns above would miss;
//   - a constant it cannot resolve;
//   - a constant name declared twice with different values, which would
//     make the resolution ambiguous.
// What it still cannot see is a code that never appears after `code:` in
// a source file, such as one passed to a helper that builds the object.
// A type annotation (`code: string;`, `(code: number): boolean`), not a value.
const TYPE_ANNOTATION = /^(string|number)[;,)]*:?$/;

function emittedDiagnosticCodes() {
  const constants = new Map();
  const conflicting = new Set();
  const literalCodes = new Set();
  const namedCodes = new Set();
  const unrecognised = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\bconst ([A-Z][A-Z0-9_]*)(?:: [A-Za-z]+)? = '([^']+)'/g)) {
      if (constants.has(match[1]) && constants.get(match[1]) !== match[2]) {
        conflicting.add(match[1]);
      }
      constants.set(match[1], match[2]);
    }
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        continue;
      }
      for (const match of lines[index].matchAll(/\bcode: (\S+)/g)) {
        const value = match[1].replace(/,$/, '');
        const literal = /^'([^']+)'$/.exec(value);
        if (literal !== null) {
          literalCodes.add(literal[1]);
        } else if (/^[A-Z][A-Z0-9_]*$/.test(value)) {
          namedCodes.add(value);
        } else if (!TYPE_ANNOTATION.test(match[1])) {
          unrecognised.push(`${path.relative(REPO_ROOT, file)}:${index + 1}: code: ${match[1]}`);
        }
      }
    }
  }
  const unresolved = [...namedCodes].filter((name) => !constants.has(name));
  const resolved = [...namedCodes]
    .filter((name) => constants.has(name))
    .map((name) => constants.get(name));
  return {
    codes: new Set([...literalCodes, ...resolved]),
    unresolved,
    unrecognised,
    // Only a name used as a code matters; DEFAULT_REGISTRY, say, differs
    // between files and is no code.
    conflicting: [...conflicting].filter((name) => namedCodes.has(name)),
  };
}

function unionMembers(file, typeName) {
  const text = readFileSync(file, 'utf8');
  const match = text.match(new RegExp(`export type ${typeName} =([^;]+);`));
  if (match === null) {
    throw new Error(`no ${typeName} union in ${file}`);
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((member) => member[1]);
}

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

describe('the vocabulary covers what the source emits', () => {
  // Without this the vocabulary goes stale silently: a code added to core
  // and not here is counted under "other", and the public baseline then
  // records a bucket nobody can read.
  it('names every diagnostic code core and the CLI can emit', () => {
    const { codes, unresolved, unrecognised, conflicting } = emittedDiagnosticCodes();
    expect(unresolved).toEqual([]);
    expect(unrecognised).toEqual([]);
    expect(conflicting).toEqual([]);
    // A floor, so a scraper that stopped matching cannot pass by finding
    // nothing.
    expect(codes.size).toBeGreaterThan(40);
    expect(codes).toContain('manifest-unparsed');
    const missing = [...codes].filter((code) => !DIAGNOSTIC_CODES.includes(code)).sort();
    expect(missing).toEqual([]);
  });

  it('names every rule id and lockfile format the types declare', () => {
    const ruleIds = unionMembers(path.join(SOURCE_DIRS[0], 'types.ts'), 'RuleId');
    expect(ruleIds.length).toBeGreaterThan(5);
    expect(ruleIds.filter((ruleId) => !RULE_IDS.includes(ruleId))).toEqual([]);
    const formats = unionMembers(path.join(SOURCE_DIRS[0], 'lockfiles', 'types.ts'), 'LockfileFormat');
    expect(formats.filter((format) => !LOCKFILE_FORMATS.includes(format))).toEqual([]);
  });
});
