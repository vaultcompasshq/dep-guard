import { bandedDistance } from '../src/levenshtein.js';

// Plain full-matrix Levenshtein, kept deliberately naive: it is the
// oracle the banded implementation is checked against, and the banded one
// only earns its optimizations if it agrees with this everywhere.
function referenceDistance(a: string, b: string): number {
  let previous: number[] = [];
  for (let column = 0; column <= b.length; column += 1) {
    previous.push(column);
  }
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      current.push(
        Math.min(previous[column - 1] + cost, previous[column] + 1, current[column - 1] + 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

// A tiny deterministic generator, so a failure is reproducible rather than
// a flake nobody can reproduce.
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe('bandedDistance', () => {
  test('identical names are distance 0', () => {
    expect(bandedDistance('react', 'react', 1)).toBe(0);
  });

  test('a single substitution is distance 1', () => {
    expect(bandedDistance('lodash', 'lodask', 1)).toBe(1);
  });

  test('a single omission is distance 1', () => {
    expect(bandedDistance('react', 'rect', 1)).toBe(1);
  });

  test('a single insertion is distance 1', () => {
    expect(bandedDistance('react', 'reactt', 1)).toBe(1);
  });

  test('distance 2 is out of band when maxK is 1', () => {
    expect(bandedDistance('react', 'rct', 1)).toBeNull();
  });

  test('distance 2 is reported when maxK is 2', () => {
    expect(bandedDistance('commander', 'comandr', 2)).toBe(2);
  });

  test('an adjacent transposition costs 2 under plain Levenshtein', () => {
    expect(bandedDistance('lodash', 'lodahs', 2)).toBe(2);
  });

  test('distance 3 is out of band when maxK is 2', () => {
    expect(bandedDistance('react', 'rt', 2)).toBeNull();
  });

  test('a length gap wider than the band returns null', () => {
    expect(bandedDistance('a', 'abcdef', 2)).toBeNull();
  });

  test('an empty name is the other name away, within the band', () => {
    expect(bandedDistance('', 'ab', 2)).toBe(2);
  });

  test('an empty name beyond the band returns null', () => {
    expect(bandedDistance('', 'abc', 2)).toBeNull();
  });

  test('the distance is symmetric in its arguments', () => {
    expect(bandedDistance('rect', 'react', 1)).toBe(bandedDistance('react', 'rect', 1));
  });

  test('agrees with a full-matrix Levenshtein on random name-shaped pairs', () => {
    const random = makeRandom(20260801);
    const alphabet = 'abcr-_';
    const makeName = (): string => {
      const length = Math.floor(random() * 9);
      let name = '';
      for (let index = 0; index < length; index += 1) {
        name += alphabet[Math.floor(random() * alphabet.length)];
      }
      return name;
    };

    for (let trial = 0; trial < 2000; trial += 1) {
      const left = makeName();
      const right = makeName();
      const expected = referenceDistance(left, right);
      for (const maxK of [1, 2] as const) {
        const actual = bandedDistance(left, right, maxK);
        if (expected > maxK) {
          expect([left, right, maxK, actual]).toEqual([left, right, maxK, null]);
        } else {
          expect([left, right, maxK, actual]).toEqual([left, right, maxK, expected]);
        }
      }
    }
  });

  // The band means work is proportional to length times k, not length
  // squared, and a row whose best cell already exceeds the band ends the
  // scan. Package names are attacker-controlled strings, so a pathological
  // pair has to stay cheap rather than merely finish eventually.
  test('pathological long names stay fast', () => {
    const long = 'a'.repeat(20000);
    const nearlyLong = `${'a'.repeat(19999)}b`;
    const started = Date.now();
    for (let i = 0; i < 100; i += 1) {
      expect(bandedDistance(long, nearlyLong, 2)).toBe(1);
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('long names that diverge immediately exit early', () => {
    const left = 'x'.repeat(20000);
    const right = 'y'.repeat(20000);
    const started = Date.now();
    for (let i = 0; i < 100; i += 1) {
      expect(bandedDistance(left, right, 2)).toBeNull();
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
