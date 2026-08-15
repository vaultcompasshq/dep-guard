// Checks the corpus builder runs before it writes anything, and the shape
// of meta.json.

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

  return {
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
