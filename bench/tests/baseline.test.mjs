import { describe, expect, it } from '@jest/globals';

import { compareToBaseline, flattenCounts, formatComparison } from '../lib/baseline.mjs';

function entry(name, sha, counts) {
  return { repo: name, sha, counts };
}

const counts = (overrides = {}) => ({
  exitCode: 0,
  findings: { total: 2, byRule: { typosquat: 1, 'unknown-package': 1 } },
  ...overrides,
});

describe('flattenCounts', () => {
  it('reduces a nested count structure to comparable leaf paths', () => {
    expect(flattenCounts({ findings: { total: 2, byRule: { typosquat: 1 } } })).toEqual({
      'findings.total': 2,
      'findings.byRule.typosquat': 1,
    });
  });
});

describe('compareToBaseline', () => {
  const baseline = {
    version: 1,
    corpus: { builtAt: '2026-08-01T00:00:00.000Z', nameCount: 10 },
    repos: [entry('owner/one', 'aaa', counts()), entry('owner/two', 'bbb', counts())],
  };

  it('reports no drift when a run reproduces the baseline', () => {
    const result = compareToBaseline({ repos: baseline.repos, corpus: baseline.corpus }, baseline);
    expect(result.changed).toBe(false);
    expect(result.drift).toEqual([]);
  });

  it('names the count that moved, and both values', () => {
    const moved = [
      entry('owner/one', 'aaa', counts({ findings: { total: 3, byRule: { typosquat: 2, 'unknown-package': 1 } } })),
      baseline.repos[1],
    ];
    const result = compareToBaseline({ repos: moved, corpus: baseline.corpus }, baseline);
    expect(result.changed).toBe(true);
    expect(result.drift).toContainEqual({
      repo: 'owner/one',
      kind: 'count',
      key: 'findings.total',
      before: 2,
      after: 3,
    });
    expect(result.drift).toContainEqual({
      repo: 'owner/one',
      kind: 'count',
      key: 'findings.byRule.typosquat',
      before: 1,
      after: 2,
    });
  });

  it('flags a repinned commit even when the counts happen to match', () => {
    // This is the whole reason the pins exist. Identical counts against a
    // different commit are not evidence of anything, and reading them as
    // "no change" is how someone else's dependency bump gets mistaken for
    // a clean run.
    const repinned = [entry('owner/one', 'zzz', counts()), baseline.repos[1]];
    const result = compareToBaseline({ repos: repinned, corpus: baseline.corpus }, baseline);
    expect(result.changed).toBe(true);
    expect(result.drift).toContainEqual({
      repo: 'owner/one',
      kind: 'repinned',
      before: 'aaa',
      after: 'zzz',
    });
  });

  it('reports a repository the baseline knows and the run did not cover', () => {
    const result = compareToBaseline(
      { repos: [baseline.repos[0]], corpus: baseline.corpus },
      baseline
    );
    expect(result.drift).toContainEqual({ repo: 'owner/two', kind: 'not-run' });
    expect(result.changed).toBe(true);
  });

  it('reports a repository the run covered and the baseline does not know', () => {
    const result = compareToBaseline(
      { repos: [...baseline.repos, entry('owner/three', 'ccc', counts())], corpus: baseline.corpus },
      baseline
    );
    expect(result.drift).toContainEqual({ repo: 'owner/three', kind: 'unbaselined' });
    expect(result.changed).toBe(true);
  });

  it('notes a different corpus as context rather than as drift', () => {
    // A corpus refresh moves unknown-package counts on its own. That is a
    // real explanation for a difference, so it is reported -- but it is not
    // itself a regression, and folding it into the drift list would make
    // every run after a rebuild look like a code change.
    const result = compareToBaseline(
      { repos: baseline.repos, corpus: { builtAt: '2026-09-01T00:00:00.000Z', nameCount: 4_000_000 } },
      baseline
    );
    expect(result.changed).toBe(false);
    expect(result.context).toContainEqual(
      expect.objectContaining({ kind: 'corpus-differs' })
    );
  });

  it('refuses to compare against a baseline that is not one', () => {
    expect(() => compareToBaseline({ repos: [] }, null)).toThrow(/baseline/i);
    expect(() => compareToBaseline({ repos: [] }, { repos: 'nope' })).toThrow(/baseline/i);
  });
});

describe('formatComparison', () => {
  it('says so plainly when nothing moved', () => {
    expect(formatComparison({ changed: false, drift: [], context: [] })).toMatch(/matches the baseline/i);
  });

  it('lists what moved', () => {
    const text = formatComparison({
      changed: true,
      drift: [
        { repo: 'owner/one', kind: 'count', key: 'findings.total', before: 2, after: 3 },
        { repo: 'owner/two', kind: 'not-run' },
      ],
      context: [],
    });
    expect(text).toContain('owner/one');
    expect(text).toContain('findings.total');
    expect(text).toContain('2');
    expect(text).toContain('3');
    expect(text).toContain('owner/two');
  });
});
