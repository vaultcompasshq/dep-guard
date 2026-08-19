// Checks the corpus builder runs before it writes anything, and the shape
// of meta.json.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { BloomFilter } from '../../packages/core/dist/bloom.js';
import { loadCorpus } from '../../packages/core/dist/corpus.js';

// The constraint this file exists for.
//
// typosquat.ts consults the alias list FIRST and returns on a hit, before
// it asks whether the name being judged is itself in the popularity list.
// That order is right -- a curated pair is a fact, and "this name is
// popular" should not be able to launder a name that is a known confusion
// with something else. But it means an alias entry keyed on a genuinely
// popular package reports that package as a critical typosquat for every
// user of the tool, on every scan that adds it, with no way to tell from
// the finding that the corpus is at fault.
//
// A user can reach that state themselves through config.extraAliases, which
// is their own repository's decision. A SHIPPED corpus must never reach it,
// and the builder is the only place that can tell: by the time the finding
// is rendered, the alias list and the top list are two files nobody
// compares. So the comparison happens here, and it fails the build.
export function aliasKeysShadowingTop(aliases, top) {
  const popular = new Set(top);
  const shadowing = [];
  // Own keys only: an alias object built with Object.create carries
  // inherited names that corpus.ts would never return from aliasTargets,
  // and reporting one as a conflict would fail a build over a name the
  // shipped corpus does not actually contain.
  for (const key of Object.keys(aliases)) {
    if (popular.has(key)) {
      shadowing.push(key);
    }
  }
  return shadowing;
}

export function assertAliasKeysNotPopular(aliases, top) {
  const shadowing = aliasKeysShadowingTop(aliases, top);
  if (shadowing.length > 0) {
    throw new Error(
      `alias list keys ${shadowing.length} name(s) that are also in the top list: ` +
        `${shadowing.join(', ')}. The typosquat check reads the alias list before the ` +
        'top-list exemption, so shipping this corpus would report a genuinely popular ' +
        'package as a critical typosquat for every user. Remove the alias entry, or ' +
        'remove the name from the top list -- it cannot be in both.'
    );
  }
}

export function assertTopListWellFormed(top) {
  const seen = new Set();
  for (const name of top) {
    if (typeof name !== 'string') {
      throw new Error(`top list contains a non-string entry: ${JSON.stringify(name)}`);
    }
    if (name.length === 0) {
      throw new Error('top list contains an empty name');
    }
    if (seen.has(name)) {
      // A duplicate is not merely untidy: rank is 1-based array position,
      // so the second copy is dead weight that pushes every name after it
      // down a rank, and rank is what splits typosquat severity.
      throw new Error(`top list contains a duplicate name: ${name}`);
    }
    seen.add(name);
  }
}

// meta.json's first three fields are the ones corpus.ts reads. The rest
// record what the build actually did, because the interesting numbers here
// are measured rather than requested: the design target is a rate, and the
// filter geometry that rate produced at this name count is what a later
// reader needs in order to judge whether a corpus is the size it should be.
export function buildMeta(values) {
  const { builtAt, nameCount, fpRate } = values;
  if (typeof builtAt !== 'string' || builtAt.length === 0) {
    throw new Error('meta.builtAt must be a non-empty string');
  }
  if (!Number.isInteger(nameCount) || nameCount < 1) {
    throw new Error(
      `meta.nameCount must be a positive integer (got ${nameCount}); a corpus that reads ` +
        'as empty would bless every hallucinated name'
    );
  }
  if (!(fpRate > 0 && fpRate < 1)) {
    throw new Error(`meta.fpRate must be between 0 and 1, exclusive (got ${fpRate})`);
  }
  // walkComplete is load-bearing now: corpus.ts's assertMetaShape refuses
  // to load a corpus whose walkComplete is present and not exactly the
  // boolean true, fail-closed on any other value including a stray string
  // or number. A build that passed something other than a real boolean
  // through unchecked would write a meta.json the loader silently trusts
  // or silently refuses for the wrong reason, so the value entering this
  // field has to be a real boolean before it is ever written.
  if (typeof values.walkComplete !== 'boolean') {
    throw new Error(
      `meta.walkComplete must be a boolean (got ${JSON.stringify(values.walkComplete)}); ` +
        'the corpus reader refuses to load a corpus where this field is not exactly true'
    );
  }

  return {
    // The on-disk corpus format version. A reader uses this to tell a
    // corpus it understands from one written by a newer dep-guard. It is
    // emitted from the first published corpus onward -- and not before --
    // precisely because a format version cannot be assigned retroactively
    // once corpora exist in the wild: every corpus already shipped without
    // this field would need a version invented for it after the fact.
    formatVersion: 1,
    builtAt,
    nameCount,
    fpRate,
    // Measured by probing the finished filter, not computed. The formulas
    // say what the geometry should give; this says what it gave.
    observedFpRate: values.observedFpRate,
    topCount: values.topCount,
    topOrdering: values.topOrdering,
    // Which file the popularity list was read from. A corpus that shipped a
    // one-off list passed on the command line, rather than the reviewed one
    // in the repository, should be able to say so about itself.
    topSource: values.topSource,
    aliasCount: values.aliasCount,
    bitCount: values.bitCount,
    hashCount: values.hashCount,
    bloomBytes: values.bloomBytes,
    source: values.source,
    updateSeq: values.updateSeq,
    // False for a corpus built from a stopped-early walk. A partial corpus
    // is useful for testing and dangerous in production -- it reports every
    // name it never reached as unknown -- so it says so about itself.
    walkComplete: values.walkComplete,
  };
}

// Reads a just-written corpus directory back and checks it is fit for
// what it claims to be, either as a real scan would load it or, for a
// deliberately partial build, as the raw artifact files.
//
// corpus.ts's assertMetaShape refuses to load ANY corpus whose
// walkComplete is present and not exactly true -- a partial corpus
// reports every name the walk never reached as unknown, and must never
// serve a real scan. But `--max-names` (scripts/build-corpus.mjs,
// package.json's corpus:slice) deliberately writes walkComplete: false,
// and the builder still needs to know its own output is well-formed.
// Routing a partial build through loadCorpus for that check would mean
// the build fails its own verification of the exact artifact it just
// wrote on purpose, every time. So a partial build is verified directly
// against the files on disk (bloom membership and top-list order)
// instead of through the reader's real-scan fitness gate; a complete
// build is verified through loadCorpus itself, which is the stronger
// check -- it proves the artifact is what the scanner will actually
// accept, not merely that the raw files are well-formed.
export function verifyBuiltCorpus(outDir, top, meta) {
  if (meta.walkComplete === false) {
    verifyArtifactsDirectly(outDir, top);
    return;
  }
  const corpus = loadCorpus(outDir);
  if (corpus.topRank(top[0]) !== 1) {
    throw new Error(`corpus verification failed: ${top[0]} did not load as rank 1`);
  }
  const missing = top.filter((name) => !corpus.hasName(name));
  if (missing.length > 0) {
    throw new Error(
      `corpus verification failed: ${missing.length} top-list name(s) are absent from the ` +
        `bloom filter, starting with ${missing.slice(0, 5).join(', ')}`
    );
  }
}

function verifyArtifactsDirectly(outDir, top) {
  const bloomBuf = readFileSync(path.join(outDir, 'names.bloom'));
  // Same defensive copy loadBloom() takes in corpus.ts: a Buffer from
  // readFileSync can alias Node's shared memory pool, and
  // BloomFilter.deserialize expects its input not to move under it.
  const bloomBytes = new Uint8Array(
    bloomBuf.buffer.slice(bloomBuf.byteOffset, bloomBuf.byteOffset + bloomBuf.byteLength)
  );
  const filter = BloomFilter.deserialize(bloomBytes);

  const topOnDisk = JSON.parse(readFileSync(path.join(outDir, 'top.json'), 'utf8'));
  if (topOnDisk[0] !== top[0]) {
    throw new Error(`corpus verification failed: ${top[0]} did not load as rank 1`);
  }

  const missing = top.filter((name) => !filter.has(name));
  if (missing.length > 0) {
    throw new Error(
      `corpus verification failed: ${missing.length} top-list name(s) are absent from the ` +
        `bloom filter, starting with ${missing.slice(0, 5).join(', ')}`
    );
  }
}
