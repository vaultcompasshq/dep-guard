import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { compareToBaseline, formatComparison } from '../lib/baseline.mjs';
import { applyRowConfig, baselineEntry, CONFIG_REFUSED, validateRepoList } from '../lib/row-config.mjs';

const NOTE = 'upstream does not carry this ignorePaths entry; the bench applies it so the repository can be measured';
const CONFIG = { ignorePaths: ['test/fixtures/bad'] };

function row(overrides = {}) {
  return { repo: 'owner/one', url: 'https://example.invalid/one.git', sha: 'aaa', ...overrides };
}

let dirs = [];
function clone() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dep-guard-row-config-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe('validateRepoList', () => {
  it('B1 refuses a row with config and no configNote, before anything is cloned', () => {
    expect(() => validateRepoList({ repos: [row({ config: CONFIG })] })).toThrow(/needs a configNote/);
  });

  it('B2 refuses a config key other than ignorePaths', () => {
    expect(() =>
      validateRepoList({ repos: [row({ config: { ...CONFIG, failOn: 'none' }, configNote: NOTE })] })
    ).toThrow(/may only carry ignorePaths; found failOn/);
  });

  it('refuses an ignorePaths that is not a non-empty array of strings', () => {
    expect(() => validateRepoList({ repos: [row({ config: { ignorePaths: [] }, configNote: NOTE })] })).toThrow(
      /non-empty array/
    );
    expect(() => validateRepoList({ repos: [row({ config: { ignorePaths: [3] }, configNote: NOTE })] })).toThrow(
      /non-empty array/
    );
  });

  it('accepts a row with ignorePaths and a configNote, and a row with neither', () => {
    expect(() => validateRepoList({ repos: [row({ config: CONFIG, configNote: NOTE }), row()] })).not.toThrow();
  });
});

describe('applyRowConfig', () => {
  it('writes the config into the clone as .dep-guard.json and returns it verbatim', () => {
    const dir = clone();
    expect(applyRowConfig(dir, row({ config: CONFIG, configNote: NOTE }))).toEqual(CONFIG);
    expect(JSON.parse(readFileSync(path.join(dir, '.dep-guard.json'), 'utf8'))).toEqual(CONFIG);
  });

  it('does nothing for a row without config', () => {
    expect(applyRowConfig(clone(), row())).toBeNull();
  });

  it.each(['.dep-guard.json', '.dep-guard.local.json'])(
    'B3 refuses a clone that already carries %s, and leaves it untouched',
    (name) => {
      const dir = clone();
      writeFileSync(path.join(dir, name), '{"ignorePaths": ["upstream"]}\n');
      let caught;
      try {
        applyRowConfig(dir, row({ config: CONFIG, configNote: NOTE }));
      } catch (err) {
        caught = err;
      }
      expect(caught?.skipReason).toBe(CONFIG_REFUSED);
      expect(readFileSync(path.join(dir, name), 'utf8')).toBe('{"ignorePaths": ["upstream"]}\n');
    }
  );

  it('B3 refuses a dangling .dep-guard.json symlink rather than writing through it', () => {
    const dir = clone();
    const outside = path.join(clone(), 'target.json');
    symlinkSync(outside, path.join(dir, '.dep-guard.json'));
    expect(() => applyRowConfig(dir, row({ config: CONFIG, configNote: NOTE }))).toThrow(/already carries/);
    expect(() => readFileSync(outside, 'utf8')).toThrow();
  });
});

describe('configApplied in the baseline', () => {
  const counts = { exitCode: 0, findings: { total: 1 } };

  it('B4 the baseline row carries configApplied and configNote', () => {
    expect(baselineEntry(row({ config: CONFIG, configNote: NOTE }), CONFIG, counts)).toEqual({
      repo: 'owner/one',
      sha: 'aaa',
      configApplied: CONFIG,
      configNote: NOTE,
      counts,
    });
    expect(baselineEntry(row(), null, counts)).toEqual({ repo: 'owner/one', sha: 'aaa', counts });
  });

  const withConfig = { repo: 'owner/one', sha: 'aaa', configApplied: CONFIG, configNote: NOTE, counts };
  const withoutConfig = { repo: 'owner/one', sha: 'aaa', counts };

  it('B4 a row with config against a baseline row without configApplied is drift', () => {
    const result = compareToBaseline({ repos: [withConfig] }, { repos: [withoutConfig] }, [
      row({ config: CONFIG, configNote: NOTE }),
    ]);
    expect(result.drift).toEqual([{ repo: 'owner/one', kind: 'config-changed', before: null, after: CONFIG }]);
    expect(formatComparison(result)).toContain('recorded with config none');
  });

  it('B4 a row without config against a baseline row with configApplied is drift', () => {
    const result = compareToBaseline({ repos: [withoutConfig] }, { repos: [withConfig] }, [row()]);
    expect(result.drift).toEqual([{ repo: 'owner/one', kind: 'config-changed', before: CONFIG, after: null }]);
  });

  it('B4 a different config is drift, and the same config in another key order is not', () => {
    const other = { ignorePaths: ['test/fixtures/other'] };
    const moved = compareToBaseline({ repos: [withConfig] }, { repos: [withConfig] }, [
      row({ config: other, configNote: NOTE }),
    ]);
    expect(moved.drift.map((item) => item.kind)).toEqual(['config-changed']);
    const same = compareToBaseline({ repos: [withConfig] }, { repos: [withConfig] }, [
      row({ config: { ignorePaths: [...CONFIG.ignorePaths] }, configNote: NOTE }),
    ]);
    expect(same.changed).toBe(false);
  });
});
