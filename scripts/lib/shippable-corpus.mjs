// Release gate: refuses to let a corpus ship unless it is actually fit to
// be published. This is a stricter, narrower check than corpus.ts's own
// loadCorpus() -- see the comment above assertRequiredFilesPresent below
// for why the two deliberately disagree.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { loadCorpus, SUPPORTED_CORPUS_FORMAT_VERSIONS } from '../../packages/core/dist/corpus.js';

const REQUIRED_FILES = ['names.bloom', 'top.json', 'aliases.json', 'meta.json'];

// A real registry walk is millions of names (4.25 million or so, per
// docs/INVARIANTS.md). This floor is set high enough that a --max-names
// slice -- corpus:slice defaults to 20000 -- can never pass it by accident;
// it exists to catch "someone pointed this gate at a slice and forgot",
// not to be a precisely-tuned threshold.
export const DEFAULT_MIN_NAME_COUNT = 1_000_000;

// A name virtually every real corpus build will contain, used to prove the
// shipped corpus actually loads through the real reader and actually
// resolves a well-known package as present -- not merely that its four
// files parse.
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

function readMeta(dir) {
  const metaPath = path.join(dir, 'meta.json');
  let raw;
  try {
    raw = readFileSync(metaPath, 'utf8');
  } catch (err) {
    throw new Error(`refusing to ship ${dir}: could not read ${metaPath} (${err.code ?? err.message})`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`refusing to ship ${dir}: ${metaPath} is not valid JSON`);
  }
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

function assertNameCountAtLeast(dir, meta, minNameCount) {
  if (typeof meta.nameCount !== 'number' || !Number.isFinite(meta.nameCount) || meta.nameCount < minNameCount) {
    throw new Error(
      `refusing to ship ${dir}: meta.nameCount is ${JSON.stringify(meta.nameCount)}, below the ` +
        `minimum of ${minNameCount}. A corpus this small is almost certainly a --max-names ` +
        'slice built for testing, not a real registry walk, and would report the vast ' +
        'majority of real, legitimate package names as unknown.'
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
    // passes even for a --max-names 1 build. Walk completeness is what
    // assertWalkCompletePresentAndTrue and assertNameCountAtLeast above
    // establish, not this check.
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
//   - meta.nameCount is at least minNameCount
//   - the directory loads through the real reader, and a known-popular
//     name resolves as present in the bloom filter
//
// minNameCount is a parameter (default DEFAULT_MIN_NAME_COUNT) precisely so
// a test can exercise both the accept and refuse sides of the name-count
// rule without needing a real 10-to-15-minute, ~430-request registry walk.
export function assertCorpusShippable(dir, minNameCount = DEFAULT_MIN_NAME_COUNT) {
  assertRequiredFilesPresent(dir);
  const meta = readMeta(dir);
  assertFormatVersionPresentAndSupported(dir, meta);
  assertWalkCompletePresentAndTrue(dir, meta);
  assertNameCountAtLeast(dir, meta, minNameCount);
  assertLoadsAndResolvesKnownName(dir);
}
