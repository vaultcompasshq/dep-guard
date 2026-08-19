import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { BloomFilter } from '../../packages/core/dist/bloom.js';
import { assertCorpusShippable, DEFAULT_MIN_NAME_COUNT } from '../lib/shippable-corpus.mjs';

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function tempCorpusDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'depguard-shippable-'));
  tempDirs.push(dir);
  return dir;
}

// A large-enough name count clears DEFAULT_MIN_NAME_COUNT (1,000,000) so
// tests that only want to exercise a different rule can use this without
// also tripping the name-count floor. Individual tests still pass a small
// minNameCount override so they don't need a filter actually sized in the
// millions.
const PLAUSIBLE_NAME_COUNT = 1_500_000;

function writeCorpusFiles(dir, { names = ['react'], top = ['react'], aliases = {} } = {}) {
  const filter = BloomFilter.create(names, Math.max(names.length, 1), 0.01);
  writeFileSync(path.join(dir, 'names.bloom'), filter.serialize());
  writeFileSync(path.join(dir, 'top.json'), JSON.stringify(top));
  writeFileSync(path.join(dir, 'aliases.json'), JSON.stringify(aliases));
}

function writeMeta(dir, meta) {
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
}

// The full set of fields a real, ready-to-publish meta.json carries, so
// each test only has to override the one field it's exercising.
function validMeta(overrides = {}) {
  return {
    formatVersion: 1,
    builtAt: '2026-08-18T00:00:00.000Z',
    nameCount: PLAUSIBLE_NAME_COUNT,
    fpRate: 0.0001,
    walkComplete: true,
    ...overrides,
  };
}

describe('assertCorpusShippable', () => {
  it('accepts a corpus with all four files, present-and-correct formatVersion and walkComplete, and a nameCount clearing a low test floor', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir);
    writeMeta(dir, validMeta());

    expect(() => assertCorpusShippable(dir, 1)).not.toThrow();
  });

  it('refuses a directory missing one of the four required files', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir);
    writeMeta(dir, validMeta());
    rmSync(path.join(dir, 'aliases.json'));

    expect(() => assertCorpusShippable(dir, 1)).toThrow(/aliases\.json/);
  });

  it('refuses a directory missing meta.json itself', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir);
    writeMeta(dir, validMeta());
    rmSync(path.join(dir, 'meta.json'));

    expect(() => assertCorpusShippable(dir, 1)).toThrow(/meta\.json/);
  });

  // readMeta's two failure branches, exercised directly: a meta.json that
  // exists (so assertRequiredFilesPresent does not catch it) but cannot be
  // read as a file, and one that reads fine but is not valid JSON.
  it('refuses a corpus whose meta.json cannot be read as a file', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir);
    // A directory in place of meta.json reproduces "exists but cannot be
    // read as a file" (readFileSync throws EISDIR) without relying on
    // chmod, which a test runner with elevated privileges can bypass.
    mkdirSync(path.join(dir, 'meta.json'));

    expect(() => assertCorpusShippable(dir, 1)).toThrow(/could not read/);
  });

  it('refuses a corpus whose meta.json is not valid JSON', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir);
    writeFileSync(path.join(dir, 'meta.json'), 'not json');

    expect(() => assertCorpusShippable(dir, 1)).toThrow(/not valid JSON/);
  });

  // The whole point of this gate: the reader tolerates an absent
  // formatVersion (a pre-versioning local artifact excuse), but nothing
  // about to be published gets that excuse.
  it('refuses a corpus whose meta.json has no formatVersion, even though loadCorpus itself would accept it', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir);
    writeMeta(dir, validMeta({ formatVersion: undefined }));

    // Matches the PRESENCE-check message specifically (assertFormatVersion-
    // PresentAndSupported's "has no formatVersion" branch), not the
    // present-but-wrong-value message ("formatVersion is X, which this
    // build does not understand") that a deleted presence check would fall
    // through to. A bare /formatVersion/ regex would pass either way and
    // not actually prove the presence check ran.
    expect(() => assertCorpusShippable(dir, 1)).toThrow(/has no formatVersion/);
  });

  it('refuses a corpus whose formatVersion is not one this build understands', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir);
    writeMeta(dir, validMeta({ formatVersion: 2 }));

    expect(() => assertCorpusShippable(dir, 1)).toThrow(/formatVersion/);
  });

  // The other half of the whole point: the reader tolerates an absent
  // walkComplete for the same pre-versioning-artifact reason, and this gate
  // does not extend that tolerance to a corpus about to ship.
  it('refuses a corpus whose meta.json has no walkComplete, even though loadCorpus itself would accept it', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir);
    writeMeta(dir, validMeta({ walkComplete: undefined }));

    // Matches the PRESENCE-check message specifically (assertWalkComplete-
    // PresentAndTrue's "has no walkComplete" branch), not the
    // present-but-wrong-value message ("walkComplete is X, not true") that
    // a deleted presence check would fall through to. A bare /walkComplete/
    // regex would pass either way and not actually prove the presence
    // check ran.
    expect(() => assertCorpusShippable(dir, 1)).toThrow(/has no walkComplete/);
  });

  it('refuses a corpus whose walkComplete is false', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir);
    writeMeta(dir, validMeta({ walkComplete: false }));

    expect(() => assertCorpusShippable(dir, 1)).toThrow(/walkComplete/);
  });

  it('refuses a corpus whose walkComplete is truthy but not the literal boolean true', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir);
    writeMeta(dir, validMeta({ walkComplete: 'true' }));

    expect(() => assertCorpusShippable(dir, 1)).toThrow(/walkComplete/);
  });

  it('refuses a corpus whose nameCount is below the minimum floor', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir);
    writeMeta(dir, validMeta({ nameCount: 999 }));

    expect(() => assertCorpusShippable(dir, 1000)).toThrow(/nameCount/);
  });

  it('accepts a corpus whose nameCount meets the minimum floor exactly', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir);
    writeMeta(dir, validMeta({ nameCount: 1000 }));

    expect(() => assertCorpusShippable(dir, 1000)).not.toThrow();
  });

  // DEFAULT_MIN_NAME_COUNT is what the command-line entry point (and
  // therefore the release workflow) actually uses -- proves it is set high
  // enough that corpus:slice's own default (20,000 names, per
  // package.json's "corpus:slice" script) could never pass it by accident.
  it('the default floor refuses a corpus:slice-sized nameCount (20,000)', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir);
    writeMeta(dir, validMeta({ nameCount: 20_000 }));

    expect(() => assertCorpusShippable(dir)).toThrow(/nameCount/);
    expect(DEFAULT_MIN_NAME_COUNT).toBeGreaterThan(20_000);
  });

  it('refuses a corpus whose files are well-formed but does not load through the real reader (malformed JSON)', () => {
    const dir = tempCorpusDir();
    writeCorpusFiles(dir);
    writeMeta(dir, validMeta());
    // Overwrite top.json with something loadCorpus rejects (not an array).
    writeFileSync(path.join(dir, 'top.json'), JSON.stringify({ react: 1 }));

    expect(() => assertCorpusShippable(dir, 1)).toThrow(/real reader/);
  });

  it('refuses a corpus that loads fine but does not resolve a known-popular name as present', () => {
    const dir = tempCorpusDir();
    // Filter built over names that do not include "react" at all.
    writeCorpusFiles(dir, { names: ['some-other-package'], top: ['some-other-package'] });
    writeMeta(dir, validMeta());

    expect(() => assertCorpusShippable(dir, 1)).toThrow(/react/);
  });
});
