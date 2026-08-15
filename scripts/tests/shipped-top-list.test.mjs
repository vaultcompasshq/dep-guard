import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

import { ALIAS_SEED } from '../lib/aliases.mjs';
import { aliasKeysShadowingTop, assertTopListWellFormed } from '../lib/corpus-guards.mjs';
import { isPlausiblePackageName, parseNameList } from '../lib/top-list.mjs';

// The properties the shipped popularity list has to hold, checked against
// the file itself rather than against the code that wrote it. Everything
// here is a property a corpus build would otherwise discover late, or not
// at all: the corpus is ten megabytes of generated data built by a command
// nobody runs on a pull request, so a list that has quietly lost its scoped
// names, or grown an alias key, would ship.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOP_LIST = path.join(REPO_ROOT, 'scripts', 'data', 'top-packages.txt');

const file = readFileSync(TOP_LIST, 'utf8');
const { header, names } = parseNameList(file);

describe('the shipped popularity list', () => {
  it('is large enough for the check that reads it', () => {
    // The typosquat rule treats absence from this list as "not popular", so
    // a short list is not a smaller version of a long one: it is a list that
    // reports ordinary dependencies as squats of their neighbours. Ten
    // thousand is the size the rule was designed around.
    expect(names.length).toBeGreaterThanOrEqual(10_000);
    // The upper bound is a sanity check against a runaway build, not a
    // target. Membership is decided by the usage floor, so the count is
    // whatever clears it; trimming to a round number would drop names that
    // earned their place and make each one flaggable again.
    expect(names.length).toBeLessThanOrEqual(40_000);
  });

  it('is well formed, with no duplicate wasting a rank', () => {
    expect(() => assertTopListWellFormed(names)).not.toThrow();
  });

  it('holds nothing that is not shaped like a package name', () => {
    expect(names.filter((name) => !isPlausiblePackageName(name))).toEqual([]);
  });

  it('keys no alias, which would report a popular package as a critical squat', () => {
    // The alias rule runs before the top-list exemption, so a name in both
    // places is reported as a known confusion for every user on every scan.
    // The corpus build refuses this; catching it here means finding out in
    // a test run rather than an hour into a corpus build.
    expect(aliasKeysShadowingTop(ALIAS_SEED, names)).toEqual([]);
  });

  it('represents scoped packages', () => {
    // The bulk downloads endpoint refuses scoped names, which is exactly why
    // they are the ones an unverified list quietly leaves out, and why
    // "@types/jsesc is a typosquat of @types/jest" was a finding.
    const scoped = names.filter((name) => name.startsWith('@'));
    expect(scoped.length).toBeGreaterThan(1000);
  });

  it('contains the popular packages that were being reported as squats', () => {
    // Regression cases, one per false positive from the first dogfood run
    // against a real corpus. Each is a package with real usage that the
    // curated five-hundred-name list did not name.
    const listed = new Set(names);
    for (const name of [
      'micromatch',
      'npm-run-all2',
      '@types/jsesc',
      'tempy',
      'dashify',
      'esquery',
      '@types/esquery',
      'eslint-plugin-import-x',
      'fsevents',
      'pug',
      '@types/less',
      '@rollup/plugin-terser',
      'tap',
    ]) {
      expect(listed.has(name)).toBe(true);
    }
  });

  it('says where it came from and what it means', () => {
    // A trust input with no provenance is a trust input nobody can review.
    const text = header.join('\n');
    expect(text).toMatch(/trust input/i);
    expect(text).toMatch(/downloads/i);
    expect(text).toMatch(/generated-by/);
  });
});
