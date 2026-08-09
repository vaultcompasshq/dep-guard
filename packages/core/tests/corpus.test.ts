import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadCorpus } from '../src/corpus.js';
import { BloomFilter } from '../src/bloom.js';
import { DepGuardError } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'corpus');

// chmod-based permission tests are meaningless as root, which is how some
// container images run CI.
const asUnprivilegedUser = process.getuid?.() === 0 ? test.skip : test;

function validBloomBytes(): Uint8Array {
  return BloomFilter.create(['react'], 1, 0.01).serialize();
}

interface FixtureOverrides {
  bloom?: Uint8Array;
  top?: unknown;
  aliases?: unknown;
  meta?: unknown;
  rawTop?: string;
}

// Builds a scratch corpus directory with valid defaults for every file, so
// each corrupt-corpus test only needs to override the one file it's
// exercising rather than restating a full valid fixture every time. Uses
// `in` rather than `??` to pick defaults, since some tests deliberately
// override a field with `null` -- `??` would treat that as "not provided"
// and silently fall back to the default instead of writing the null.
function writeFixtureDir(overrides: FixtureOverrides): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'depguard-corpus-'));
  writeFileSync(
    path.join(dir, 'names.bloom'),
    'bloom' in overrides ? (overrides.bloom as Uint8Array) : validBloomBytes()
  );
  writeFileSync(
    path.join(dir, 'top.json'),
    'rawTop' in overrides
      ? (overrides.rawTop as string)
      : JSON.stringify('top' in overrides ? overrides.top : ['react'])
  );
  writeFileSync(
    path.join(dir, 'aliases.json'),
    JSON.stringify('aliases' in overrides ? overrides.aliases : {})
  );
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify(
      'meta' in overrides ? overrides.meta : { builtAt: '2026-08-01', nameCount: 1, fpRate: 0.01 }
    )
  );
  return dir;
}

function expectCorpusCorrupt(fn: () => void): void {
  try {
    fn();
    throw new Error('expected loadCorpus to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(DepGuardError);
    expect((err as DepGuardError).code).toBe('corpus-corrupt');
  }
}

describe('loadCorpus', () => {
  test('hasName is true for a name in the fixture corpus', () => {
    const corpus = loadCorpus(FIXTURE_DIR);
    expect(corpus.hasName('react')).toBe(true);
  });

  test('hasName is false for a name never inserted into the fixture corpus', () => {
    const corpus = loadCorpus(FIXTURE_DIR);
    expect(corpus.hasName('reactt-definitely-not-real-xyz')).toBe(false);
  });

  test('topRank returns the 1-based rank of a top-list name', () => {
    const corpus = loadCorpus(FIXTURE_DIR);
    expect(corpus.topRank('react')).toBe(1);
  });

  test('topRank returns null for a name not in the top list', () => {
    const corpus = loadCorpus(FIXTURE_DIR);
    expect(corpus.topRank('not-top')).toBeNull();
  });

  test('aliasTargets returns known-confusion targets for a name', () => {
    const corpus = loadCorpus(FIXTURE_DIR);
    expect(corpus.aliasTargets('unused-imports')).toContain('eslint-plugin-unused-imports');
  });

  test('aliasTargets returns an empty array for a name with no known aliases', () => {
    const corpus = loadCorpus(FIXTURE_DIR);
    expect(corpus.aliasTargets('react')).toEqual([]);
  });

  // The typosquat check's distance scan reads the whole list, so its order
  // is part of the contract: position is rank.
  test('topNames exposes the top list in rank order', () => {
    const corpus = loadCorpus(FIXTURE_DIR);
    expect(corpus.topNames[0]).toBe('react');
    expect(corpus.topNames.length).toBeGreaterThan(1);
    expect(corpus.topRank(corpus.topNames[3])).toBe(4);
  });

  test('topNames cannot be mutated by a caller', () => {
    const corpus = loadCorpus(FIXTURE_DIR);
    expect(Object.isFrozen(corpus.topNames)).toBe(true);
  });

  test('builtAt reflects meta.json', () => {
    const corpus = loadCorpus(FIXTURE_DIR);
    expect(corpus.builtAt).toBe('2026-08-01');
  });

  test('loadCorpus throws DepGuardError with code corpus-missing when the directory does not exist', () => {
    const missingDir = path.join(__dirname, '..', 'fixtures', 'does-not-exist');
    expect(() => loadCorpus(missingDir)).toThrow(DepGuardError);
    try {
      loadCorpus(missingDir);
      throw new Error('expected loadCorpus to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DepGuardError);
      expect((err as DepGuardError).code).toBe('corpus-missing');
    }
  });

  // A present-but-permission-denied file is not fixed by reinstalling the
  // corpus, which is what "missing" tells a caller to do. It has to come
  // back as a distinct code so a caller (and a human reading the message)
  // is pointed at file permissions instead.
  asUnprivilegedUser(
    'a corpus file denied by permissions throws corpus-unreadable, not corpus-missing',
    () => {
      const dir = writeFixtureDir({});
      const topPath = path.join(dir, 'top.json');
      chmodSync(topPath, 0o000);
      try {
        expect(() => loadCorpus(dir)).toThrow(DepGuardError);
        try {
          loadCorpus(dir);
          throw new Error('expected loadCorpus to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(DepGuardError);
          expect((err as DepGuardError).code).toBe('corpus-unreadable');
        }
      } finally {
        chmodSync(topPath, 0o644);
      }
    }
  );

  // "constructor" and "__proto__" are legal npm package names. A plain
  // `aliases[name]` lookup on a JSON.parse'd object returns inherited
  // Object.prototype members for these instead of undefined, which is not
  // a string[] and breaks any caller that calls .includes() on the result.
  test('aliasTargets returns an empty array for the inherited "constructor" property', () => {
    const corpus = loadCorpus(FIXTURE_DIR);
    expect(corpus.aliasTargets('constructor')).toEqual([]);
  });

  test('aliasTargets returns an empty array for "__proto__"', () => {
    const corpus = loadCorpus(FIXTURE_DIR);
    expect(corpus.aliasTargets('__proto__')).toEqual([]);
  });

  test('malformed JSON in top.json throws corpus-corrupt', () => {
    const dir = writeFixtureDir({ rawTop: '{not valid json' });
    expectCorpusCorrupt(() => loadCorpus(dir));
  });

  test('top.json that is an object instead of an array throws corpus-corrupt', () => {
    const dir = writeFixtureDir({ top: { react: 1 } });
    expectCorpusCorrupt(() => loadCorpus(dir));
  });

  test('top.json with a non-string entry throws corpus-corrupt', () => {
    const dir = writeFixtureDir({ top: ['react', 42] });
    expectCorpusCorrupt(() => loadCorpus(dir));
  });

  test('meta.json that is null throws corpus-corrupt', () => {
    const dir = writeFixtureDir({ meta: null });
    expectCorpusCorrupt(() => loadCorpus(dir));
  });

  test('meta.json missing builtAt throws corpus-corrupt', () => {
    const dir = writeFixtureDir({ meta: { nameCount: 1, fpRate: 0.01 } });
    expectCorpusCorrupt(() => loadCorpus(dir));
  });

  test('aliases.json that is null throws corpus-corrupt', () => {
    const dir = writeFixtureDir({ aliases: null });
    expectCorpusCorrupt(() => loadCorpus(dir));
  });

  test('aliases.json with a non-array value throws corpus-corrupt', () => {
    const dir = writeFixtureDir({ aliases: { foo: 'not-an-array' } });
    expectCorpusCorrupt(() => loadCorpus(dir));
  });

  // names.bloom is loaded lazily (only hasName touches it), so a
  // truncated bloom file does not throw at loadCorpus() itself -- it
  // throws the first time hasName() actually needs the filter.
  test('truncated names.bloom throws corpus-corrupt when a name check first needs it', () => {
    const full = validBloomBytes();
    const truncated = full.slice(0, full.length - 1);
    const dir = writeFixtureDir({ bloom: truncated });
    const corpus = loadCorpus(dir);
    expectCorpusCorrupt(() => corpus.hasName('react'));
  });

  // names.bloom is the one corpus artifact whose size scales with the
  // corpus itself -- megabytes for a real 10k+ name list -- so loading
  // and deserializing it eagerly would cost measurable time on every
  // scan, including ones that touch no manifest and so never call
  // hasName at all. A directory with no
  // names.bloom on disk at all is the sharpest proof of laziness: loadCorpus
  // must not fail just because that one file happens to be missing, only
  // hasName() may.
  test('a missing names.bloom does not throw until hasName is called', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'depguard-corpus-'));
    writeFileSync(path.join(dir, 'top.json'), JSON.stringify(['react']));
    writeFileSync(path.join(dir, 'aliases.json'), JSON.stringify({}));
    writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ builtAt: '2026-08-01', nameCount: 1, fpRate: 0.01 })
    );

    const corpus = loadCorpus(dir); // must not throw yet -- names.bloom was never read
    expect(corpus.builtAt).toBe('2026-08-01'); // meta.json stays eager
    expect(corpus.topRank('react')).toBe(1); // top.json stays eager

    expect(() => corpus.hasName('react')).toThrow(DepGuardError);
    try {
      corpus.hasName('react');
    } catch (err) {
      expect((err as DepGuardError).code).toBe('corpus-missing');
    }
  });
});
