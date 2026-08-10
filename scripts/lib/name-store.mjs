// The corpus builder's accumulator: a newline-delimited file of package
// names, plus the state that makes a walk resumable.
//
// Four and a quarter million names is roughly ninety megabytes of text, and
// holding them all as JavaScript strings at once costs several hundred
// megabytes of heap for no benefit -- the only thing the build does with
// them is insert each into a bloom filter, once. So the file is written a
// page at a time and read back through a synchronous generator that never
// holds more than one chunk. BloomFilter.create takes an Iterable, which is
// exactly the shape a generator has, so nothing in core needed changing to
// accommodate this.

import { closeSync, openSync, readSync, existsSync, statSync } from 'node:fs';
import {
  appendFileSync,
  ftruncateSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const CHUNK_BYTES = 1 << 20;
const NEWLINE = 0x0a;

// A name carrying a newline would split into two on the next read and turn
// one unknown package into two. The registry cannot produce one, but the
// store is the wrong place to find that out, so such a name is refused
// rather than written.
export function isStorableName(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\n');
}

export function appendNames(filePath, names) {
  const storable = names.filter(isStorableName);
  if (storable.length === 0) {
    return { written: 0, refused: names.length };
  }
  appendFileSync(filePath, `${storable.join('\n')}\n`);
  return { written: storable.length, refused: names.length - storable.length };
}

// A run killed between writing a page and recording its start key resumes
// from the previous key and re-fetches that page, which is harmless. A run
// killed part way through the write itself leaves half a name on the last
// line, which is not: that fragment would be inserted into the filter as
// though it were a package. Trimming back to the last complete line makes
// the file safe to append to again.
export function repairTrailingLine(filePath) {
  if (!existsSync(filePath)) {
    return { truncatedBytes: 0 };
  }
  const size = statSync(filePath).size;
  if (size === 0) {
    return { truncatedBytes: 0 };
  }

  const fd = openSync(filePath, 'r+');
  try {
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size));
    let end = size;
    while (end > 0) {
      const length = Math.min(buffer.length, end);
      const start = end - length;
      readSync(fd, buffer, 0, length, start);
      for (let index = length - 1; index >= 0; index -= 1) {
        if (buffer[index] === NEWLINE) {
          const keep = start + index + 1;
          if (keep < size) {
            ftruncateSync(fd, keep);
          }
          return { truncatedBytes: size - keep };
        }
      }
      end = start;
    }
    // No newline anywhere: the whole file is one unterminated fragment.
    ftruncateSync(fd, 0);
    return { truncatedBytes: size };
  } finally {
    closeSync(fd);
  }
}

// Synchronous on purpose: it feeds BloomFilter.create, which walks a plain
// Iterable. An async iterator would mean either buffering the whole corpus
// or changing core's constructor to accommodate the builder, and core's
// shape should not bend around a build script.
export function* readNames(filePath) {
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let carry = '';
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      // A multi-byte character can straddle a chunk boundary, so the tail
      // is decoded as part of the next chunk rather than on its own.
      const text = carry + buffer.toString('utf8', 0, bytesRead);
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) {
          yield line;
        }
      }
    }
    if (carry.length > 0) {
      yield carry;
    }
  } finally {
    closeSync(fd);
  }
}

export function countNames(filePath) {
  let count = 0;
  for (const _name of readNames(filePath)) {
    count += 1;
  }
  return count;
}

// The incremental path. Every id the changes feed reported is removed from
// the store and the still-live ones are appended back, which handles a
// rename, a deletion and an ordinary republish with one pass and without
// holding the corpus in memory. Order is not preserved and does not matter:
// nothing downstream reads this file in order.
//
// A deleted name is genuinely dropped here, and that is the honest choice
// even though it is not the conservative one -- a bloom filter cannot
// forget, so a name removed upstream would otherwise stay "known" until
// somebody ran a full rebuild, which is how a squatter's unpublished name
// keeps vouching for itself.
export function rewriteNames(filePath, { drop, add }) {
  const dropSet = drop instanceof Set ? drop : new Set(drop);
  const tempPath = `${filePath}.next`;
  let kept = 0;
  let removed = 0;

  const pending = [];
  const flush = () => {
    if (pending.length > 0) {
      appendFileSync(tempPath, `${pending.join('\n')}\n`);
      pending.length = 0;
    }
  };

  writeFileSync(tempPath, '');
  for (const name of readNames(filePath)) {
    if (dropSet.has(name)) {
      removed += 1;
      continue;
    }
    pending.push(name);
    kept += 1;
    if (pending.length >= 50_000) {
      flush();
    }
  }
  for (const name of add) {
    if (!isStorableName(name)) {
      continue;
    }
    pending.push(name);
    kept += 1;
    if (pending.length >= 50_000) {
      flush();
    }
  }
  flush();
  renameSync(tempPath, filePath);
  return { kept, removed, added: add.length };
}

export function readState(statePath) {
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    // A state file that cannot be read is not a resumable state file. The
    // caller decides what to do about it; silently continuing from "no
    // state" would restart a four-hundred-request walk without saying so.
    return null;
  }
}

export function writeState(statePath, state) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}
