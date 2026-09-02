// Release gate: refuses to let a corpus ship unless it is actually fit to
// be published. This is a stricter, narrower check than corpus.ts's own
// loadCorpus() -- see the comment above assertRequiredFilesPresent below
// for why the two deliberately disagree.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { loadCorpus, SUPPORTED_CORPUS_FORMAT_VERSIONS } from '../../packages/core/dist/corpus.js';
import { BloomFilter } from '../../packages/core/dist/bloom.js';

const REQUIRED_FILES = ['names.bloom', 'top.json', 'aliases.json', 'meta.json'];

// A real registry walk is millions of names (4,274,632 in the walk that
// produced the checked-in popularity list -- see the header of
// scripts/data/top-packages.txt, not docs/INVARIANTS.md, which only ever
// says "several million"). This floor is set high enough that a --max-names
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

// The geometry cross-check above (assertBloomSizeMatchesMeta) proves only
// that meta.json was not edited AFTER the filter was written: BloomFilter
// .create sizes its bit array from count and fpRate ALONE, and insert()
// only sets bits, so a filter created with the right geometry and
// near-zero content -- the shape a truncated or misread name store
// produces while the walk still self-reports complete -- passes that
// check exactly as cleanly as a fully-populated one. 'react' still
// resolves in that scenario too (assertLoadsAndResolvesKnownName above),
// because collectExtras injects every top-list name regardless of what
// the walk found. Neither check can tell an empty-but-correctly-sized
// filter from a real one; this one can, because it looks at what the bit
// array actually holds rather than how big it is.
//
// The physical fact this is built on: a bloom filter sized the way
// BloomFilter.create sizes one (m and k chosen from n and a target
// false-positive rate by the standard formulas) has an expected bit-fill
// ratio, after n real inserts, of 1 - e^(-kn/m). Plugging in the optimal
// k = (m/n) * ln(2) that BloomFilter.create computes gives kn/m = ln(2),
// so the expected fill is 1 - e^(-ln 2) = 1 - 1/2 = exactly 0.5 --
// independent of n and of the target false-positive rate, because both
// are absorbed into m and k before this ratio is taken. A filter that
// claims n but actually received a handful of inserts reads nowhere near
// that: fill approaches 0 as the real insert count falls far below n.
//
// [0.25, 0.75] is deliberately generous around that ~0.5 expectation --
// hashCount is rounded to the nearest integer (never exactly optimal),
// and small-n filters see more variance -- but every real build measured
// during development landed within a few hundredths of 0.5, while a
// truncated-to-a-handful-of-names build reads within a few thousandths of
// 0. There is no plausible real-content scenario that lands between those
// two clusters and inside this range by accident.
//
// Reading the bits back out goes through the real BloomFilter.deserialize,
// not a reimplementation of the header layout bloom.ts documents --
// "derive, do not describe" (top of docs/INVARIANTS.md) applies to reading
// a corpus artifact as much as to sizing one. bloom.ts types `bits` and
// `bitCount` as private, but TypeScript's `private` erases to a plain
// instance property in the compiled output this script already imports
// BloomFilter from, so a deserialized filter's bits are genuinely
// reachable here without hand-parsing the 10-byte header. If that ever
// stops being true (a real JS `#private` field, a renamed property), the
// property reads come back `undefined` and the guard below throws loudly
// naming the file, rather than silently computing a fill ratio of zero
// from nothing.
//
// That guard is unreachable through on-disk corruption today, and stays
// worth keeping anyway. assertBloomSizeMatchesMeta (above, runs first)
// already refuses any names.bloom whose byte length does not exactly
// match what BloomFilter.create(meta.nameCount, meta.fpRate) implies, and
// that minimum is never zero bits (BloomFilter.create floors bitCount at
// 8), so a truncated, bits-free file can never reach here. Any file whose
// size DOES match still has to pass BloomFilter.deserialize's own header
// checks first, which construct bits/bitCount itself from validated
// input -- there is no on-disk byte pattern that clears both gates while
// still handing this guard something malformed. See
// scripts/tests/shippable-corpus.test.mjs's "names.bloom corruption that
// IS reachable" describe block for the reachable corruption case this
// gate actually catches, and for the fuller version of this argument.
const MIN_FILL_RATIO = 0.25;
const MAX_FILL_RATIO = 0.75;

function fillRatioOf(bloomPath) {
  let buf;
  try {
    buf = readFileSync(bloomPath);
  } catch (err) {
    throw new Error(`refusing to ship ${bloomPath}: could not read the bloom file (${err.code ?? err.message})`);
  }

  const filter = BloomFilter.deserialize(buf);
  const { bits, bitCount } = filter;
  if (!(bits instanceof Uint8Array) || typeof bitCount !== 'number' || !Number.isFinite(bitCount) || bitCount < 1) {
    throw new Error(
      `refusing to ship ${bloomPath}: could not read bits/bitCount back off the deserialized ` +
        'BloomFilter -- its internal shape may have changed (see the comment above fillRatioOf).'
    );
  }

  let setBits = 0;
  for (let i = 0; i < bitCount; i++) {
    if ((bits[i >>> 3] & (1 << (i & 7))) !== 0) {
      setBits++;
    }
  }
  return setBits / bitCount;
}

function assertBloomFillRatioPlausible(dir) {
  const bloomPath = path.join(dir, 'names.bloom');
  const fill = fillRatioOf(bloomPath);
  if (fill < MIN_FILL_RATIO || fill > MAX_FILL_RATIO) {
    throw new Error(
      `refusing to ship ${dir}: ${bloomPath}'s bit-fill ratio is ${fill.toFixed(4)}, outside the ` +
        `plausible [${MIN_FILL_RATIO}, ${MAX_FILL_RATIO}] range for a filter sized the way ` +
        'BloomFilter.create sizes one (expected fill near 0.5 when the claimed name count was ' +
        'actually inserted -- see the comment above this check for the math). The geometry ' +
        "check above this one cannot catch this: it only proves names.bloom's SIZE matches " +
        'meta.nameCount and meta.fpRate, which BloomFilter.create derives without looking at ' +
        'what was actually inserted, so a near-empty filter -- a truncated or misread name ' +
        'store, with the walk still self-reporting complete -- passes it cleanly. This corpus ' +
        'would flag every real dependency as unknown-package.'
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
//   - names.bloom's bit-fill ratio is plausible for a filter that actually
//     received its claimed number of inserts (see assertBloomFillRatioPlausible
//     above): the physical evidence that content, not just size, is there
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
  assertBloomFillRatioPlausible(dir);
}
