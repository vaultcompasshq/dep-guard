import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from '@jest/globals';

import {
  extractStringLiterals,
  integrityMatches,
  readTarballEntry,
  tarEntries,
} from '../lib/tarball.mjs';

const BLOCK = 512;

// A minimal ustar writer, here rather than in the library because nothing
// this repository ships ever writes a tar; only reading one is needed, and a
// reader is only trustworthy if something independent produced its input.
function tarBlock(name, content) {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'utf8');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  header.write('ustar\0', 257, 6, 'utf8');
  const body = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK);
  content.copy(body);
  return Buffer.concat([header, body]);
}

function tarball(entries) {
  return Buffer.concat([
    ...entries.map(([name, text]) => tarBlock(name, Buffer.from(text, 'utf8'))),
    Buffer.alloc(BLOCK * 2),
  ]);
}

describe('integrityMatches', () => {
  const bytes = Buffer.from('the vendored ranking');

  it('accepts the digest the registry published', () => {
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    expect(integrityMatches(bytes, integrity)).toBe(true);
  });

  it('rejects a tarball that is not the reviewed artifact', () => {
    const integrity = `sha512-${createHash('sha512').update(Buffer.from('something else')).digest('base64')}`;
    expect(integrityMatches(bytes, integrity)).toBe(false);
  });

  it('rejects an integrity string it cannot check rather than passing it', () => {
    expect(integrityMatches(bytes, 'md5-abcdef')).toBe(false);
    expect(integrityMatches(bytes, 'not-an-integrity-string')).toBe(false);
    expect(integrityMatches(bytes, undefined)).toBe(false);
  });
});

describe('tarEntries', () => {
  it('walks every entry with its content', () => {
    const entries = [...tarEntries(tarball([['package/one.js', 'first'], ['package/two.js', 'second']]))];
    expect(entries.map((entry) => entry.path)).toEqual(['package/one.js', 'package/two.js']);
    expect(entries[1].content.toString('utf8')).toBe('second');
  });

  it('stops at the terminating block rather than reading padding as an entry', () => {
    expect([...tarEntries(tarball([['package/one.js', 'first']]))]).toHaveLength(1);
  });

  it('refuses an entry whose size runs past the end of the archive', () => {
    const truncated = tarball([['package/one.js', 'x'.repeat(600)]]).subarray(0, BLOCK + 100);
    expect(() => [...tarEntries(truncated)]).toThrow(/past the end/);
  });
});

describe('readTarballEntry', () => {
  it('returns the one entry asked for out of a gzipped archive', () => {
    const archive = gzipSync(tarball([['package/a.js', 'A'], ['package/lib/top.js', 'TOP']]));
    expect(readTarballEntry(archive, 'package/lib/top.js').toString('utf8')).toBe('TOP');
  });

  it('returns null when the entry is not there', () => {
    const archive = gzipSync(tarball([['package/a.js', 'A']]));
    expect(readTarballEntry(archive, 'package/lib/top.js')).toBeNull();
  });
});

describe('extractStringLiterals', () => {
  it('reads the names out of a module without executing it', () => {
    // The vendored ranking is downloaded from the registry. Evaluating it
    // would be the exact thing this tool tells its users not to do.
    expect(extractStringLiterals("export const top = [\n  'semver',\n  '@types/node'\n]")).toEqual([
      'semver',
      '@types/node',
    ]);
  });

  it('steps over an escaped quote instead of running two literals together', () => {
    // The failure this guards against is not a missing name: it is an
    // invented one, where a mis-parsed escape makes the scanner read the
    // gap between two literals as a literal of its own.
    expect(extractStringLiterals("['fine', 'not\\'fine', 'also-fine']")).toEqual([
      'fine',
      'also-fine',
    ]);
  });

  it('returns nothing for a module with no single-quoted literals', () => {
    expect(extractStringLiterals('export const top = []')).toEqual([]);
  });
});
