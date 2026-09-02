// Shared by scripts/build-corpus.mjs (the corpus builder) and
// scripts/lib/shippable-corpus.mjs (the release gate): the set of names the
// builder injects into the bloom filter regardless of what the registry
// walk found -- every name in top.json, plus every alias target in
// aliases.json.
//
// One implementation, one type (a Set), because the two former copies of
// this function were the exact parallel-logic defect shape docs/INVARIANTS.md
// opens by naming: if the builder ever gained a new extras source and the
// gate's copy went unupdated, the gate would under-subtract, overstate
// walkedNameCount, and become MORE permissive -- silently, and in the
// direction that ships a bad corpus.
//
// The defensive shape handling below (tolerating a non-array top or a
// non-object aliases) is harmless for the builder, which always calls this
// with values it just built itself, but load-bearing for the gate, which
// calls it with values read back off disk. An unusable shape (top.json not
// an array, aliases.json not an object) contributes no extras here rather
// than throwing -- that malformation is loadCorpus's job to catch
// (assertLoadsAndResolvesKnownName in shippable-corpus.mjs), and this
// function only ever runs on a meta.nameCount claim, not on shape validity.
export function collectExtras(top, aliases) {
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
