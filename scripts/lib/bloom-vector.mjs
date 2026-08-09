// A frozen parity vector for the corpus bloom filter, checked from both
// sides of the boundary it protects.
//
// The corpus builder and the scanner have to agree, byte for byte, on how a
// package name becomes bits. The builder therefore imports BloomFilter from
// the built core rather than hashing names itself -- but "therefore" is a
// convention, and a convention is exactly the thing a later edit breaks
// quietly. A second FNV-1a written here would look right, pass every ASCII
// eyeball test, and disagree with core's on the first name carrying a
// character outside the Basic Latin range, because core hashes UTF-16 code
// units via charCodeAt. Nothing about that failure is loud: every affected
// name simply reads as unknown, which is also what a genuinely unknown name
// reads as.
//
// So the agreement is pinned to a value instead of to an intention.
// VECTOR_DIGEST is the sha256 of a serialized filter built over
// VECTOR_NAMES with fixed parameters. The builder asserts it before it
// writes anything, and the test suite asserts it against core's own source.
// The two sides never import each other; they both have to land on this
// constant. A changed hash function, a changed serialization layout, or a
// second implementation sneaking in all move the digest, and both sides
// fail at once.
//
// The names are deliberately awkward. Accented Latin, CJK, an astral-plane
// character that occupies two UTF-16 code units, a scoped name, a name that
// is a bare separator, and the empty string all exist as npm package names
// or are close enough to them to be worth pinning. Do not "tidy" this list:
// changing it invalidates the digest and the protection with it.

import { createHash } from 'node:crypto';

export const VECTOR_FP_RATE = 0.001;

export const VECTOR_NAMES = Object.freeze([
  'react',
  'lodash',
  '@babel/core',
  'left-pad',
  '-',
  '',
  'café-loader',
  'naïve-parser',
  'straße',
  '日本語-utils',
  'пакет',
  'emoji-🎉-pkg',
  '𝟘-width',
  'ünïcödé',
  'a'.repeat(214),
]);

export const VECTOR_DIGEST = '1263b8e5eda0b1b164b8c27df7e724340f59b15c6e53b93680be25c212ff45ac';

// Takes the BloomFilter constructor rather than importing one, so the two
// callers can each supply the copy they actually use -- the builder's from
// the built core, the test's from core's source.
export function bloomVectorDigest(BloomFilter) {
  const filter = BloomFilter.create(VECTOR_NAMES, VECTOR_NAMES.length, VECTOR_FP_RATE);
  return createHash('sha256').update(filter.serialize()).digest('hex');
}

export function assertBloomParity(BloomFilter) {
  const actual = bloomVectorDigest(BloomFilter);
  if (actual !== VECTOR_DIGEST) {
    throw new Error(
      'bloom filter parity check failed: the filter used to build the corpus does not ' +
        'hash or serialize names the way the scanner does. Expected digest ' +
        `${VECTOR_DIGEST}, got ${actual}. Rebuild the core package (pnpm build); if that ` +
        'does not fix it, the hash function or the serialized layout changed and every ' +
        'shipped corpus is now unreadable by the scanner.'
    );
  }
}
