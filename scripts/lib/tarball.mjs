// Just enough tar to read one file out of an npm tarball, plus the integrity
// check that has to happen before anything in it is believed.
//
// Why this exists rather than a dependency: the one thing this repository
// vendors from outside itself is a popularity ranking, and reaching for a
// third-party extractor to open it would add exactly the kind of install-time
// code this tool exists to warn people about. A tar entry is a 512-byte
// header followed by its content rounded up to the next 512 bytes, which is
// forty lines of arithmetic, so the arithmetic is here.
//
// Nothing is written to disk from the archive. The single entry the caller
// asks for is returned as a Buffer, and the caller parses it.

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const BLOCK = 512;

// npm publishes an integrity string (sha512, base64) and a legacy shasum
// (sha1, hex) in the registry metadata. The integrity string is the one
// checked: it is what a modern npm client verifies, and a tarball that does
// not match the metadata the registry served alongside it is not the
// artifact that was reviewed.
export function integrityMatches(bytes, integrity) {
  if (typeof integrity !== 'string' || !integrity.includes('-')) {
    return false;
  }
  const separator = integrity.indexOf('-');
  const algorithm = integrity.slice(0, separator);
  const expected = integrity.slice(separator + 1);
  if (algorithm !== 'sha512' && algorithm !== 'sha384' && algorithm !== 'sha256') {
    return false;
  }
  const actual = createHash(algorithm).update(bytes).digest('base64');
  // Both sides are fixed-length digests of public data, so a plain
  // comparison is not leaking anything a timing-safe one would hide.
  return actual === expected;
}

function readString(block, offset, length) {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) {
    end += 1;
  }
  return block.toString('utf8', offset, end);
}

// Sizes are octal ASCII in a twelve byte field. The GNU base-256 extension
// exists for files above eight gigabytes, which no npm tarball entry is, so
// an unparseable size is treated as a malformed archive rather than
// something to guess at.
function readOctal(block, offset, length) {
  const text = readString(block, offset, length).trim();
  if (text.length === 0) {
    return 0;
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('tarball has an unreadable entry size');
  }
  return value;
}

export function* tarEntries(bytes) {
  let offset = 0;
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    const name = readString(header, 0, 100);
    if (name.length === 0) {
      // Two zero blocks end the archive; one is enough to stop reading.
      return;
    }
    const size = readOctal(header, 124, 12);
    const prefix = readString(header, 345, 155);
    const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    const start = offset + BLOCK;
    const end = start + size;
    if (end > bytes.length) {
      throw new Error(`tarball entry ${path} runs past the end of the archive`);
    }
    yield { path, size, content: bytes.subarray(start, end) };
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
}

export function readTarballEntry(gzipped, wantedPath) {
  const bytes = gunzipSync(gzipped);
  for (const entry of tarEntries(bytes)) {
    if (entry.path === wantedPath) {
      return Buffer.from(entry.content);
    }
  }
  return null;
}

// The vendored ranking arrives as an ES module exporting an array of string
// literals. It is read with a scanner rather than evaluated, because
// evaluating a module downloaded from the registry is the exact thing this
// project tells its users not to do. Only single-quoted literals are
// recognised, which is what the source uses; anything else is ignored, and
// the caller sees a short list and can say so.
//
// Escapes are stepped over rather than decoded. Getting the boundaries of a
// literal right matters, because a mis-parsed escape would run two literals
// together and invent a name; what an escape decodes to does not, because
// no package name contains one, and a literal carrying a backslash is
// dropped for that reason.
export function extractStringLiterals(source) {
  const names = [];
  let index = 0;
  while (index < source.length) {
    const quote = source.indexOf("'", index);
    if (quote === -1) {
      break;
    }
    let cursor = quote + 1;
    let escaped = false;
    while (cursor < source.length) {
      const character = source[cursor];
      if (character === '\\') {
        escaped = true;
        cursor += 2;
        continue;
      }
      if (character === "'") {
        break;
      }
      cursor += 1;
    }
    if (cursor >= source.length) {
      break;
    }
    const value = source.slice(quote + 1, cursor);
    if (value.length > 0 && !escaped) {
      names.push(value);
    }
    index = cursor + 1;
  }
  return names;
}
