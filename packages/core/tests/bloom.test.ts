import { BloomFilter } from '../src/bloom.js';
import { DepGuardError } from '../src/types.js';

// Deterministic PRNG (mulberry32) so "random" name sets are reproducible
// across runs. An earlier project in this family used a low-quality LCG
// mod 2^31 whose low bits cycle -- mulberry32 avoids that failure mode.
function mulberry32(seed: number): () => number {
  let a = seed;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomToken(rng: () => number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += Math.floor(rng() * 36).toString(36);
  }
  return out;
}

// Two disjoint-by-construction name sets: "ins-" names are the ones
// inserted into the filter, "qry-" names never are. Different prefixes
// guarantee no accidental overlap, so the FP measurement below is exact.
function buildNameSet(prefix: string, count: number, seed: number): string[] {
  const rng = mulberry32(seed);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    names.push(`${prefix}-${i}-${randomToken(rng, 12)}`);
  }
  return names;
}

const INSERTED = buildNameSet('ins', 10_000, 0xc0ffee);
const NOT_INSERTED = buildNameSet('qry', 100_000, 0xdecaf);

describe('BloomFilter', () => {
  test('no false negatives: every inserted name reports true', () => {
    const filter = BloomFilter.create(INSERTED, INSERTED.length, 0.001);
    for (const name of INSERTED) {
      expect(filter.has(name)).toBe(true);
    }
  });

  test('measured false-positive rate stays below 2x the configured rate', () => {
    const configuredRate = 0.001;
    const filter = BloomFilter.create(INSERTED, INSERTED.length, configuredRate);
    let falsePositives = 0;
    for (const name of NOT_INSERTED) {
      if (filter.has(name)) {
        falsePositives++;
      }
    }
    const measuredRate = falsePositives / NOT_INSERTED.length;
    expect(measuredRate).toBeLessThan(configuredRate * 2);
  });

  test('serialize/deserialize round-trips to identical answers', () => {
    const filter = BloomFilter.create(INSERTED, INSERTED.length, 0.001);
    const restored = BloomFilter.deserialize(filter.serialize());

    for (const name of INSERTED) {
      expect(restored.has(name)).toBe(filter.has(name));
    }
    for (const name of NOT_INSERTED.slice(0, 1000)) {
      expect(restored.has(name)).toBe(filter.has(name));
    }
  });

  test('deserialize of a truncated buffer throws with code corpus-corrupt', () => {
    const filter = BloomFilter.create(INSERTED, INSERTED.length, 0.001);
    const full = filter.serialize();
    const truncated = full.slice(0, full.length - 1);

    expect(() => BloomFilter.deserialize(truncated)).toThrow(DepGuardError);
    try {
      BloomFilter.deserialize(truncated);
      throw new Error('expected deserialize to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DepGuardError);
      expect((err as DepGuardError).code).toBe('corpus-corrupt');
    }
  });

  function expectCorpusCorrupt(buf: Uint8Array): void {
    try {
      BloomFilter.deserialize(buf);
      throw new Error('expected deserialize to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DepGuardError);
      expect((err as DepGuardError).code).toBe('corpus-corrupt');
    }
  }

  // Hand-crafts a header matching the documented wire format: magic
  // 'DGBF', u8 version, u32 bitCount (big-endian), u8 hashCount, followed
  // by ceil(bitCount / 8) zeroed bit-array bytes.
  function buildBuffer(opts: {
    magic?: number[];
    version?: number;
    bitCount: number;
    hashCount: number;
  }): Uint8Array {
    const magic = opts.magic ?? [0x44, 0x47, 0x42, 0x46];
    const version = opts.version ?? 1;
    const bitsLength = Math.ceil(Math.max(opts.bitCount, 0) / 8);
    const buf = new Uint8Array(10 + bitsLength);
    buf.set(magic, 0);
    buf[4] = version;
    const view = new DataView(buf.buffer);
    view.setUint32(5, opts.bitCount, false);
    buf[9] = opts.hashCount;
    return buf;
  }

  test('deserialize rejects a header with hashCount 0 (fails open otherwise)', () => {
    const buf = buildBuffer({ bitCount: 64, hashCount: 0 });
    expectCorpusCorrupt(buf);
  });

  test('deserialize rejects a header with bitCount 0', () => {
    const buf = buildBuffer({ bitCount: 0, hashCount: 3 });
    expectCorpusCorrupt(buf);
  });

  test('deserialize rejects a valid-length buffer with wrong magic bytes', () => {
    const buf = buildBuffer({ magic: [0x00, 0x00, 0x00, 0x00], bitCount: 64, hashCount: 3 });
    expectCorpusCorrupt(buf);
  });

  test('serialize() writes a stable, versioned wire format', () => {
    const n = 1;
    const fpRate = 0.1;
    const filter = BloomFilter.create(['only-name'], n, fpRate);

    // Same sizing formulas the brief specifies, computed independently
    // here so this test pins the wire format without depending on
    // bloom.ts's internal constants.
    const expectedBitCount = Math.max(
      8,
      Math.ceil((-n * Math.log(fpRate)) / (Math.LN2 * Math.LN2))
    );
    const expectedHashCount = Math.max(1, Math.round((expectedBitCount / n) * Math.LN2));

    const bytes = filter.serialize();

    expect(Array.from(bytes.slice(0, 4))).toEqual([0x44, 0x47, 0x42, 0x46]); // 'D','G','B','F'
    expect(bytes[4]).toBe(1); // version

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(5, false)).toBe(expectedBitCount); // big-endian bitCount
    expect(bytes[9]).toBe(expectedHashCount);
  });
});
