import { describe, expect, it } from '@jest/globals';

import { ALIAS_SEED } from '../lib/aliases.mjs';
import {
  aliasKeysShadowingTop,
  assertAliasKeysNotPopular,
  assertTopListWellFormed,
  buildMeta,
} from '../lib/corpus-guards.mjs';
import { TOP_SEED } from '../lib/top-seed.mjs';

describe('aliasKeysShadowingTop', () => {
  it('names every alias key that also appears in the top list', () => {
    const shadowing = aliasKeysShadowingTop({ vue: ['vuex'], harmless: ['react'] }, ['react', 'vue']);
    expect(shadowing).toEqual(['vue']);
  });

  it('returns nothing when no alias key is popular', () => {
    expect(aliasKeysShadowingTop({ crossenv: ['cross-env'] }, ['cross-env', 'react'])).toEqual([]);
  });

  it('does not treat an alias TARGET in the top list as a conflict', () => {
    // Targets are supposed to be popular packages -- that is the point of a
    // curated pair. Only the key side is constrained.
    expect(aliasKeysShadowingTop({ loadash: ['lodash'] }, ['lodash'])).toEqual([]);
  });

  it('ignores inherited object properties rather than reporting them as keys', () => {
    const aliases = Object.create({ react: ['preact'] });
    aliases.loadash = ['lodash'];
    expect(aliasKeysShadowingTop(aliases, ['react', 'lodash'])).toEqual([]);
  });
});

describe('assertAliasKeysNotPopular', () => {
  it('refuses to build a corpus whose alias list keys a popular name', () => {
    expect(() => assertAliasKeysNotPopular({ vue: ['vuex'] }, ['vue'])).toThrow(/vue/);
  });

  it('accepts the shipped seed data', () => {
    expect(() => assertAliasKeysNotPopular(ALIAS_SEED, TOP_SEED)).not.toThrow();
  });
});

describe('assertTopListWellFormed', () => {
  it('accepts the shipped seed', () => {
    expect(() => assertTopListWellFormed(TOP_SEED)).not.toThrow();
  });

  it('rejects a duplicated name, which would waste a rank and skew the split', () => {
    expect(() => assertTopListWellFormed(['react', 'vue', 'react'])).toThrow(/duplicate/i);
  });

  it('rejects an empty name', () => {
    expect(() => assertTopListWellFormed(['react', ''])).toThrow(/empty/i);
  });

  it('rejects a non-string entry', () => {
    expect(() => assertTopListWellFormed(['react', 7])).toThrow(/string/i);
  });
});

describe('buildMeta', () => {
  it('carries the three fields the corpus loader reads', () => {
    const meta = buildMeta({
      builtAt: '2026-08-09T00:00:00.000Z',
      nameCount: 4274469,
      fpRate: 0.0001,
      topCount: 400,
      topOrdering: 'curated',
      aliasCount: 40,
      bitCount: 81_940_000,
      hashCount: 13,
      bloomBytes: 10_242_510,
      source: 'https://replicate.npmjs.com',
      updateSeq: 124098695,
    });
    expect(meta.builtAt).toBe('2026-08-09T00:00:00.000Z');
    expect(meta.nameCount).toBe(4274469);
    expect(meta.fpRate).toBe(0.0001);
  });

  it('emits formatVersion 1, the on-disk corpus format version', () => {
    const meta = buildMeta({
      builtAt: '2026-08-09T00:00:00.000Z',
      nameCount: 4274469,
      fpRate: 0.0001,
      topCount: 400,
      topOrdering: 'curated',
      aliasCount: 40,
      bitCount: 81_940_000,
      hashCount: 13,
      bloomBytes: 10_242_510,
      source: 'https://replicate.npmjs.com',
      updateSeq: 124098695,
    });
    expect(meta.formatVersion).toBe(1);
  });

  it('records the measured filter geometry rather than the design target alone', () => {
    const meta = buildMeta({
      builtAt: '2026-08-09T00:00:00.000Z',
      nameCount: 1000,
      fpRate: 0.0001,
      topCount: 10,
      topOrdering: 'downloads-last-week',
      aliasCount: 2,
      bitCount: 19171,
      hashCount: 13,
      bloomBytes: 2407,
      source: 'https://replicate.npmjs.com',
      updateSeq: 1,
    });
    expect(meta.bitCount).toBe(19171);
    expect(meta.hashCount).toBe(13);
    expect(meta.bloomBytes).toBe(2407);
    expect(meta.topOrdering).toBe('downloads-last-week');
  });

  it('refuses a false-positive rate outside (0, 1), which would size the filter absurdly', () => {
    expect(() => buildMeta({ builtAt: 'x', nameCount: 1, fpRate: 0 })).toThrow(/fpRate/);
    expect(() => buildMeta({ builtAt: 'x', nameCount: 1, fpRate: 1 })).toThrow(/fpRate/);
  });

  it('refuses an empty corpus, which would bless every hallucinated name', () => {
    expect(() => buildMeta({ builtAt: 'x', nameCount: 0, fpRate: 0.0001 })).toThrow(/nameCount/);
  });
});
