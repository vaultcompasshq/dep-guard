// Release gate: refuses to let a corpus ship unless it is actually fit to
// be published. This is a stricter, narrower check than corpus.ts's own
// loadCorpus() -- see the comment above assertRequiredFilesPresent below
// for why the two deliberately disagree.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { loadCorpus, SUPPORTED_CORPUS_FORMAT_VERSIONS } from '../../packages/core/dist/corpus.js';
import { BloomFilter } from '../../packages/core/dist/bloom.js';

const REQUIRED_FILES = ['names.bloom', 'top.json', 'aliases.json', 'meta.json'];

// A real registry walk is millions of names (4.25 million or so, per
// docs/INVARIANTS.md). This floor is set high enough that a --max-names
// slice -- corpus:slice defaults to 20000 -- can never pass it by accident;
// it exists to catch "someone pointed this gate at a slice and forgot",
// not to be a precisely-tuned threshold. It is applied to the WALKED
// portion of meta.nameCount, not the raw field -- see
// assertWalkedNameCountAtLeast below for why the distinction matters.
export const DEFAULT_MIN_NAME_COUNT = 1_000_000;

// A name virtually every real corpus build will contain, used to prove the
// shipped corpus actually loads through the real reader and its bloom
// filter deserializes and answers correctly -- not merely that its four
// files parse. See the comment inside assertLoadsAndResolvesKnownName for
// exactly what this does and does not establish.
const KNOWN_POPULAR_NAME = 'react';

// corpus.ts's assertMetaShape is deliberately ABSENT-tolerant on both
// formatVersion and walkComplete: a corpus built before those fields
// existed is a local development artifact (nothing has ever shipped
// without going through this gate), and the committed fixture corpus itself
// carries neither field. This gate is the opposite of that tolerance,
// on purpose: it only ever runs against a corpus that is about to be
// published, so there is no "pre-versioning local artifact" excuse
// available to it, and it demands both fields be present and correct. See
// docs/INVARIANTS.md, "The corpus format is versioned" and "A partial
// corpus refuses itself", for the reader's side of this contrast.
//
// This gate is additive to loadCorpus()'s own checks below, not a
// replacement for them -- a corpus this gate accepts still has to load
// through the real reader before it is trusted as fit to ship.
function assertRequiredFilesPresent(dir) {
  const missing = REQUIRED_FILES.filter((name) => !existsSync(path.join(dir, name)));
  if (missing.length > 0) {
    throw new Error(
      `refusing to ship ${dir}: missing corpus file(s) ${missing.join(', ')}. ` +
        'A corpus this gate has not seen all four files for cannot be published -- ' +
        'run scripts/build-corpus.mjs to produce a complete one.'
    );
  }
}

function readJsonCorpusFile(dir, filename) {
  const filePath = path.join(dir, filename);
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`refusing to ship ${dir}: could not read ${filePath} (${err.code ?? err.message})`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`refusing to ship ${dir}: ${filePath} is not valid JSON`);
  }
}

function readMeta(dir) {
  return readJsonCorpusFile(dir, 'meta.json');
}

function assertFormatVersionPresentAndSupported(dir, meta) {
  if (!('formatVersion' in meta)) {
    throw new Error(
      `refusing to ship ${dir}: meta.json has no formatVersion. The reader tolerates an ` +
        'absent formatVersion because a pre-versioning local artifact could legitimately ' +
        'lack it, but nothing that is about to be published gets that excuse -- rebuild the ' +
        'corpus with a build-corpus.mjs that writes formatVersion (see buildMeta in ' +
        'scripts/lib/corpus-guards.mjs).'
    );
  }
  if (!SUPPORTED_CORPUS_FORMAT_VERSIONS.includes(meta.formatVersion)) {
    throw new Error(
      `refusing to ship ${dir}: meta.formatVersion is ${JSON.stringify(meta.formatVersion)}, ` +
        `which this build does not understand (it understands format version(s) ` +
        `${SUPPORTED_CORPUS_FORMAT_VERSIONS.join(', ')}). Shipping it would publish a corpus ` +
        'this same build cannot read back.'
    );
  }
}

function assertWalkCompletePresentAndTrue(dir, meta) {
  if (!('walkComplete' in meta)) {
    throw new Error(
      `refusing to ship ${dir}: meta.json has no walkComplete. The reader tolerates an ` +
        'absent walkComplete because a pre-versioning local artifact could legitimately lack ' +
        'it, but nothing that is about to be published gets that excuse -- a corpus with no ' +
        'walkComplete claim cannot be told apart from one whose walk never finished, and ' +
        'shipping that would report every name the walk never reached as unknown.'
    );
  }
  if (meta.walkComplete !== true) {
    throw new Error(
      `refusing to ship ${dir}: meta.walkComplete is ${JSON.stringify(meta.walkComplete)}, not ` +
        'true. A corpus built from a stopped-early or --max-names walk must never be ' +
        'published -- it reports every name the walk never reached as unknown, which is the ' +
        'opposite of what a supply-chain gate is for. Rebuild without --max-names.'
    );
  }
}

// Mirrors collectExtras in scripts/build-corpus.mjs (the corpus builder):
// the set of names the builder injects into the bloom filter regardless of
// what the registry walk found -- every name in top.json, plus every alias
// target in aliases.json. Computed by reading the two files THIS corpus
// ships, not recomputed or re-fetched from anywhere else, so it can never
// drift from what a given corpus actually contains. An unusable shape
// (top.json not an array, aliases.json not an object) contributes no
// extras here rather than throwing -- that malformation is loadCorpus's
// job to catch (assertLoadsAndResolvesKnownName below), and this function
// only ever runs on a meta.nameCount claim, not on shape validity.
function collectExtras(top, aliases) {
  const extras = new Set(Array.isArray(top) ? top : []);
  if (aliases !== null && typeof aliases === 'object' && !Array.isArray(aliases)) {
    for (const targets of Object.values(aliases)) {
      if (!Array.isArray(targets)) {
        continue;
      }
      for (const target of targets) {
        if (typeof target === 'string' && target.length > 0) {
          extras.add(target);
        }
      }
    }
  }
  return extras;
}

// Replaces a bare "meta.nameCount >= floor" check, which a gigantic top
// list could in principle satisfy on its own with zero names actually
// walked. This floor is on meta.nameCount MINUS the names top.json and
// aliases.json inject regardless of the walk -- i.e. on what the walk
// itself is claimed to have contributed.
function assertWalkedNameCountAtLeast(dir, meta, minWalkedNameCount) {
  if (typeof meta.nameCount !== 'number' || !Number.isFinite(meta.nameCount)) {
    throw new Error(`refusing to ship ${dir}: meta.nameCount is ${JSON.stringify(meta.nameCount)}, not a usable number.`);
  }

  const top = readJsonCorpusFile(dir, 'top.json');
  const aliases = readJsonCorpusFile(dir, 'aliases.json');
  const extras = collectExtras(top, aliases);
  const walkedNameCount = meta.nameCount - extras.size;

  if (walkedNameCount < minWalkedNameCount) {
    throw new Error(
      `refusing to ship ${dir}: meta.nameCount is ${meta.nameCount}, but this corpus's own ` +
        `top.json/aliases.json inject ${extras.size} name(s) into the filter regardless of ` +
        `what the walk found, leaving only ${walkedNameCount} names the walk itself ` +
        `contributed -- below the minimum of ${minWalkedNameCount}. A bare nameCount floor ` +
        'could in principle be satisfied by an inflated top list alone; this floor is on what ' +
        'the walk itself contributed. A corpus this small is almost certainly a --max-names ' +
        'slice built for testing, not a real registry walk, and would report the vast ' +
        'majority of real, legitimate package names as unknown.'
    );
  }
}

// meta.json is self-reported; names.bloom is a physical artifact. This
// checks that they agree, so a hand-edited or stale meta.json claiming a
// nameCount the on-disk filter never actually grew to cannot pass this
// gate merely because every field in meta.json reads as a plausible type.
function assertBloomSizeMatchesMeta(dir, meta) {
  if (typeof meta.fpRate !== 'number' || !Number.isFinite(meta.fpRate) || meta.fpRate <= 0 || meta.fpRate >= 1) {
    throw new Error(
      `refusing to ship ${dir}: meta.fpRate is ${JSON.stringify(meta.fpRate)}, not a usable ` +
        'false-positive rate. This gate needs it to derive the expected names.bloom size for ' +
        'meta.nameCount and cross-check that against the file actually on disk.'
    );
  }

  // Derived by calling the real BloomFilter.create, not a restated sizing
  // formula -- see docs/INVARIANTS.md, "derive, do not describe", at the
  // top of that file. BloomFilter.create sizes its bit array from the
  // count and fpRate it is given, never from what it actually inserts, so
  // an empty filter built with the corpus's own claimed nameCount and
  // fpRate has exactly the serialized geometry a real one built with those
  // same values would -- verified against a filter built over real names
  // of the same count before this check was written; the two produced
  // identical serialized byte lengths.
  const expectedBytes = BloomFilter.create([], meta.nameCount, meta.fpRate).serialize().byteLength;
  const bloomPath = path.join(dir, 'names.bloom');
  const actualBytes = statSync(bloomPath).size;

  if (actualBytes !== expectedBytes) {
    throw new Error(
      `refusing to ship ${dir}: ${bloomPath} is ${actualBytes} bytes on disk, but ` +
        `meta.nameCount (${meta.nameCount}) and meta.fpRate (${meta.fpRate}) together imply a ` +
        `filter of ${expectedBytes} bytes. meta.json is self-reported and names.bloom is a ` +
        'physical artifact; a mismatch means they disagree about how many names this corpus ' +
        'actually holds -- exactly what stops a hand-edited or stale meta.json from claiming a ' +
        'walk that never happened, even when every field in it reads as a plausible type.'
    );
  }
}

function assertLoadsAndResolvesKnownName(dir) {
  let corpus;
  try {
    corpus = loadCorpus(dir);
  } catch (err) {
    throw new Error(
      `refusing to ship ${dir}: the corpus does not load through the real reader (${err.message}). ` +
        'A corpus that fails loadCorpus() would fail every scan that ships with it.'
    );
  }
  if (!corpus.hasName(KNOWN_POPULAR_NAME)) {
    // What this actually establishes: the bloom filter deserializes and
    // answers correctly for a name every real build includes, which is
    // enough to catch a corrupted, truncated, or substituted filter file.
    // It does NOT establish walk completeness -- collectExtras
    // (scripts/build-corpus.mjs) injects every name in
    // scripts/data/top-packages.txt, "react" included, into the filter
    // regardless of what the registry walk itself found, so this check
    // passes even for a --max-names 1 build, and swapping "react" for any
    // other popular name would not help: any name popular enough to be
    // worth probing is on that same top list. Walk completeness is what
    // walkComplete, assertWalkedNameCountAtLeast, and
    // assertBloomSizeMatchesMeta above establish, not this check.
    throw new Error(
      `refusing to ship ${dir}: "${KNOWN_POPULAR_NAME}" does not resolve as present in the ` +
        'bloom filter. A corpus whose filter cannot recognise one of the most-downloaded ' +
        'packages on the registry has a corrupted, truncated, or substituted bloom filter.'
    );
  }
}

// Refuses (throws) unless every one of the following holds:
//   - all four corpus files exist
//   - meta.formatVersion is present and understood by this build
//   - meta.walkComplete is present and exactly the boolean true
//   - meta.nameCount, minus the names top.json/aliases.json inject
//     regardless of the walk, is at least minWalkedNameCount
//   - names.bloom's actual on-disk byte size matches what meta.nameCount
//     and meta.fpRate together imply, derived by calling the real
//     BloomFilter.create rather than a restated formula
//   - the directory loads through the real reader, and a known-popular
//     name resolves as present in the bloom filter (catches corruption or
//     substitution; does not by itself establish walk completeness -- the
//     two checks above do that)
//
// minWalkedNameCount is a parameter (default DEFAULT_MIN_NAME_COUNT)
// precisely so a test can exercise both the accept and refuse sides of the
// walked-name-count rule without needing a real 10-to-15-minute,
// ~430-request registry walk.
export function assertCorpusShippable(dir, minWalkedNameCount = DEFAULT_MIN_NAME_COUNT) {
  assertRequiredFilesPresent(dir);
  const meta = readMeta(dir);
  assertFormatVersionPresentAndSupported(dir, meta);
  assertWalkCompletePresentAndTrue(dir, meta);
  assertWalkedNameCountAtLeast(dir, meta, minWalkedNameCount);
  assertBloomSizeMatchesMeta(dir, meta);
  assertLoadsAndResolvesKnownName(dir);
}
