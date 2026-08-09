import { describe, expect, it } from '@jest/globals';

import { BloomFilter } from '../../packages/core/src/bloom.js';
import {
  assertBloomParity,
  bloomVectorDigest,
  VECTOR_DIGEST,
  VECTOR_FP_RATE,
  VECTOR_NAMES,
} from '../lib/bloom-vector.mjs';

// The corpus builder writes names into a bloom filter and the scanner reads
// them back out of it. Both sides have to hash identically, and the
// characters where they could quietly stop doing so are exactly the ones
// nobody checks by hand.
//
// This test holds the scanner's end: it runs core's own source against the
// shared vector. The builder holds the other end, asserting the same digest
// against the compiled filter before it writes a corpus. Neither side reads
// the other; both have to land on the same constant.
describe('bloom parity vector', () => {
  it('pins the digest the scanner and the builder both have to produce', () => {
    // A failure here after a change to bloom.ts means every corpus ever
    // built is now unreadable by the scanner. That is a corpus format
    // break, not a constant to update.
    expect(bloomVectorDigest(BloomFilter)).toBe(
      '1263b8e5eda0b1b164b8c27df7e724340f59b15c6e53b93680be25c212ff45ac'
    );
  });

  it('states that pin in one place, so the builder and this test cannot drift apart', () => {
    expect(VECTOR_DIGEST).toBe(
      '1263b8e5eda0b1b164b8c27df7e724340f59b15c6e53b93680be25c212ff45ac'
    );
  });

  it('accepts the filter the scanner uses', () => {
    expect(() => assertBloomParity(BloomFilter)).not.toThrow();
  });

  it('rejects a filter whose hashing has drifted', () => {
    // The realistic drift is a second FNV-1a written beside the builder
    // that folds UTF-8 bytes instead of UTF-16 code units. It agrees on
    // every ASCII name, which is why nothing else would catch it.
    const driftedFilter = {
      create(names, count, fpRate) {
        const asBytes = [];
        for (const name of names) {
          asBytes.push(Buffer.from(name, 'utf8').toString('latin1'));
        }
        return BloomFilter.create(asBytes, count, fpRate);
      },
    };
    expect(() => assertBloomParity(driftedFilter)).toThrow(/parity check failed/);
  });

  it('covers names outside the Basic Latin range, where a drifted hash first diverges', () => {
    const nonAscii = VECTOR_NAMES.filter((name) =>
      [...name].some((char) => (char.codePointAt(0) ?? 0) > 0x7f)
    );
    expect(nonAscii.length).toBeGreaterThanOrEqual(6);
  });

  it('covers a name that occupies two UTF-16 code units', () => {
    const astral = VECTOR_NAMES.filter((name) =>
      [...name].some((char) => (char.codePointAt(0) ?? 0) > 0xffff)
    );
    expect(astral.length).toBeGreaterThanOrEqual(1);
  });

  it('round-trips every vector name through a serialize and deserialize cycle', () => {
    const filter = BloomFilter.create(VECTOR_NAMES, VECTOR_NAMES.length, VECTOR_FP_RATE);
    const reloaded = BloomFilter.deserialize(filter.serialize());
    for (const name of VECTOR_NAMES) {
      expect(reloaded.has(name)).toBe(true);
    }
  });
});
