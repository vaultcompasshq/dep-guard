import { DepGuardError } from './types.js';

// Serialized layout: 4-byte magic 'DGBF', u8 version, u32 bitCount (big
// endian), u8 hashCount, then ceil(bitCount / 8) bytes of bit array.
const MAGIC = [0x44, 0x47, 0x42, 0x46]; // 'D', 'G', 'B', 'F'
const VERSION = 1;
const HEADER_BYTES = 4 + 1 + 4 + 1;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// FNV-1a 32-bit, parameterized by seed so the two hashes used for double
// hashing come from the same well-understood construction rather than an
// ad hoc mix.
function fnv1a(name: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

function rotl(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

export class BloomFilter {
  private constructor(
    private readonly bits: Uint8Array,
    private readonly bitCount: number,
    private readonly hashCount: number
  ) {}

  static create(names: Iterable<string>, count: number, fpRate: number): BloomFilter {
    // m/k sizing from the standard bloom filter formulas, given expected
    // insert count n and target false-positive rate p.
    const n = Math.max(1, count);
    const bitCount = Math.max(
      8,
      Math.ceil((-n * Math.log(fpRate)) / (Math.LN2 * Math.LN2))
    );
    const hashCount = Math.max(1, Math.round((bitCount / n) * Math.LN2));
    const bits = new Uint8Array(Math.ceil(bitCount / 8));

    const filter = new BloomFilter(bits, bitCount, hashCount);
    for (const name of names) {
      filter.insert(name);
    }
    return filter;
  }

  // Double hashing: index_i = (h1 + i*h2) mod m for i in [0, k). h2 is
  // nudged off zero (mod m) so it never degenerates into re-checking the
  // same bit for every i.
  private hashIndices(name: string): number[] {
    const h1 = fnv1a(name, FNV_OFFSET_BASIS);
    let h2 = rotl(fnv1a(name, FNV_PRIME), 15);
    if (h2 % this.bitCount === 0) {
      h2 += 1;
    }

    const indices: number[] = [];
    for (let i = 0; i < this.hashCount; i++) {
      indices.push((h1 + i * h2) % this.bitCount);
    }
    return indices;
  }

  private insert(name: string): void {
    for (const bit of this.hashIndices(name)) {
      this.bits[bit >>> 3] |= 1 << (bit & 7);
    }
  }

  has(name: string): boolean {
    for (const bit of this.hashIndices(name)) {
      if ((this.bits[bit >>> 3] & (1 << (bit & 7))) === 0) {
        return false;
      }
    }
    return true;
  }

  serialize(): Uint8Array {
    const out = new Uint8Array(HEADER_BYTES + this.bits.length);
    out.set(MAGIC, 0);
    out[4] = VERSION;
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    view.setUint32(5, this.bitCount, false);
    out[9] = this.hashCount;
    out.set(this.bits, HEADER_BYTES);
    return out;
  }

  static deserialize(buf: Uint8Array): BloomFilter {
    if (buf.length < HEADER_BYTES) {
      throw new DepGuardError('bloom filter buffer shorter than header', 'corpus-corrupt');
    }
    const magicMatches = MAGIC.every((byte, i) => buf[i] === byte);
    if (!magicMatches) {
      throw new DepGuardError('bloom filter magic mismatch', 'corpus-corrupt');
    }
    if (buf[4] !== VERSION) {
      throw new DepGuardError('bloom filter version mismatch', 'corpus-corrupt');
    }

    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const bitCount = view.getUint32(5, false);
    const hashCount = buf[9];
    // Zero here would silently fail open (hashCount 0 makes has() vacuously
    // true) or corrupt the length check (bitCount 0 makes it a no-op).
    if (bitCount < 1 || hashCount < 1) {
      throw new DepGuardError('bloom filter header has zero bitCount or hashCount', 'corpus-corrupt');
    }
    const expectedBitsLength = Math.ceil(bitCount / 8);
    if (buf.length < HEADER_BYTES + expectedBitsLength) {
      throw new DepGuardError('bloom filter buffer truncated', 'corpus-corrupt');
    }

    const bits = buf.slice(HEADER_BYTES, HEADER_BYTES + expectedBitsLength);
    return new BloomFilter(bits, bitCount, hashCount);
  }
}
