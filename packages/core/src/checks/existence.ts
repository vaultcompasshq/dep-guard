import type { Finding } from '../types.js';
import { isInternalName } from './allow.js';
import { newRegistryNames } from './candidates.js';
import type { Check } from './types.js';

// The hallucination signal: a dependency name that was not on the registry
// when the corpus was built.
//
// The corpus is a bloom filter, so a miss is definitive (no false
// negatives) while a hit may be a collision. That asymmetry is why this
// check only ever reports on a miss, and why the message dates the corpus:
// a package published after the build date is the honest false positive
// here, and the reader needs the date to recognise it.

export const existenceCheck: Check = (ctx) => {
  const findings: Omit<Finding, 'fingerprint'>[] = [];

  // Only new names reach the corpus at all, which is what keeps the check
  // proportional to the delta rather than to the dependency tree.
  for (const { change, registryName } of newRegistryNames(ctx)) {
    if (ctx.corpus.hasName(registryName)) {
      continue;
    }

    // A package the user declared internal is missing from the public
    // registry on purpose. "It may be hallucinated" is the wrong sentence
    // for it, and the dependency-confusion check owns the question that
    // actually matters there (is this name resolving off the pinned
    // internal registry), so reporting it here as well would be one
    // problem told twice, once wrongly.
    if (isInternalName(registryName, ctx.config.internalScopes, ctx.config.internalPrefixes)) {
      continue;
    }

    const via = change.protocol === 'alias' ? ` (aliased by dependency "${change.name}")` : '';
    findings.push({
      ruleId: 'unknown-package',
      severity: 'high',
      packageName: registryName,
      message:
        `"${registryName}"${via} is not in the known-package corpus built ${ctx.corpus.builtAt}. ` +
        'It may be hallucinated, or published after that date.',
      manifestPath: change.manifestPath,
      details: {
        specifier: change.specifier,
        depType: change.depType,
        protocol: change.protocol,
        corpusBuiltAt: ctx.corpus.builtAt,
      },
    });
  }

  return findings;
};
