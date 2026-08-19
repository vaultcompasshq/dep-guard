import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { BloomFilter } from '../../packages/core/dist/bloom.js';
import { loadCorpus } from '../../packages/core/dist/corpus.js';
import { ALIAS_SEED } from '../lib/aliases.mjs';
import {
  aliasKeysShadowingTop,
  assertAliasKeysNotPopular,
  assertTopListWellFormed,
  buildMeta,
  verifyBuiltCorpus,
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
      walkComplete: true,
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
      walkComplete: true,
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
      walkComplete: true,
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

  it('carries a walkComplete: false meta straight through, for a --max-names build', () => {
    const meta = buildMeta({
      builtAt: 'x',
      nameCount: 1,
      fpRate: 0.0001,
      walkComplete: false,
    });
    expect(meta.walkComplete).toBe(false);
  });

  // walkComplete is load-bearing: corpus.ts's reader refuses to load a
  // corpus where it is present and not exactly true, fail-closed on any
  // other value. The value the build writes has to already be a real
  // boolean, not something that merely happens to compare loosely equal
  // to one, or the build could write a meta.json the loader mistrusts (or
  // silently trusts) for the wrong reason.
  it('refuses a missing walkComplete, since the reader now treats the field as load-bearing', () => {
    expect(() => buildMeta({ builtAt: 'x', nameCount: 1, fpRate: 0.0001 })).toThrow(
      /walkComplete/
    );
  });

  it('refuses a walkComplete that is not a real boolean', () => {
    expect(() =>
      buildMeta({ builtAt: 'x', nameCount: 1, fpRate: 0.0001, walkComplete: 'true' })
    ).toThrow(/walkComplete/);
  });
});

describe('verifyBuiltCorpus', () => {
  // Names chosen distinct from any seed data this suite also exercises,
  // so a filter sized for exactly these members has no accidental
  // collisions of its own to confound a missing-name assertion.
  const TOP = ['zz-verify-alpha', 'zz-verify-beta'];

  function writeCorpusFiles(dir, { topOverride, includeAllNames = true } = {}) {
    const names = includeAllNames ? TOP : TOP.slice(1);
    const filter = BloomFilter.create(names, Math.max(names.length, 1), 0.01);
    writeFileSync(path.join(dir, 'names.bloom'), filter.serialize());
    writeFileSync(path.join(dir, 'top.json'), JSON.stringify(topOverride ?? TOP));
    writeFileSync(path.join(dir, 'aliases.json'), JSON.stringify({}));
  }

  function tempCorpusDir() {
    return mkdtempSync(path.join(tmpdir(), 'depguard-verify-'));
  }

  it('verifies a complete build through loadCorpus, the same path a real scan takes', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir);
    const meta = { builtAt: '2026-08-01', nameCount: 2, fpRate: 0.01, walkComplete: true };
    writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));

    expect(() => verifyBuiltCorpus(dir, TOP, meta)).not.toThrow();
  });

  // This is the CRITICAL regression the fix exists for: a --max-names
  // build writes walkComplete: false on purpose, and loadCorpus refuses
  // that meta by design. Before the fix, verifyBuiltCorpus's predecessor
  // called loadCorpus unconditionally and so always threw here, which
  // broke every --max-names build (including corpus:slice) even though
  // the artifacts it had just written were perfectly well-formed.
  it('verifies a partial (walkComplete: false) build directly, without routing through loadCorpus', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir);
    const meta = { builtAt: '2026-08-01', nameCount: 2, fpRate: 0.01, walkComplete: false };
    writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));

    expect(() => verifyBuiltCorpus(dir, TOP, meta)).not.toThrow();
    // Proves the two paths are genuinely different, not just that neither
    // throws: the same directory, read through the real loader a scan
    // uses, is refused for exactly the reason verifyBuiltCorpus had to
    // route around.
    expect(() => loadCorpus(dir)).toThrow(/walkComplete/);
  });

  it('a partial build still catches a top-list name missing from the bloom filter', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir, { includeAllNames: false });
    const meta = { builtAt: '2026-08-01', nameCount: 2, fpRate: 0.01, walkComplete: false };
    writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));

    expect(() => verifyBuiltCorpus(dir, TOP, meta)).toThrow(/absent from the/);
  });

  it('a partial build still catches the most popular name not loading as rank 1', () => {
    const dir = tempCorpusDir();
    const shuffledTop = [TOP[1], TOP[0]];
    writeCorpusFiles(dir, { topOverride: shuffledTop });
    const meta = { builtAt: '2026-08-01', nameCount: 2, fpRate: 0.01, walkComplete: false };
    writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));

    expect(() => verifyBuiltCorpus(dir, TOP, meta)).toThrow(/did not load as rank 1/);
  });
});
