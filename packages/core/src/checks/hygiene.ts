import type { DepChange } from '../delta.js';
import { versionRangeOf } from '../delta.js';
import type { DepType } from '../manifest.js';
import type { Finding, Severity } from '../types.js';
import { isAllowed } from './allow.js';
import type { Check } from './types.js';

// Version-range hygiene: a specifier that pins nothing at all. "*",
// "latest", and an empty string all mean "install whatever is newest at
// resolve time", which hands the actual version decision to whoever
// publishes next -- worth flagging even though nothing has been tampered
// with.
//
// Kept deliberately narrow for v1: only these three exact forms are
// flagged, not every wide range ("^1.0.0" stays silent). Checked on both
// an added AND a changed dependency for the same reason as the tamper
// check -- a specifier rewritten from a pinned range to a wildcard is a
// changed dependency, not an added one, and would otherwise go unseen.
//
// An alias IS a registry install of its target at a version range
// ("pkg": "npm:lodash@*" installs lodash at "*"), so it cannot be grouped
// with the truly wiring-only protocols (workspace/catalog/link/patch/file)
// as exempt by construction. Those five remain exempt -- none of them
// names a version range at all -- but an alias is judged on delta.ts's
// versionRangeOf, which strips the
// "npm:" wrapper and target name so "npm:lodash@*" is judged on its "*"
// rather than on the literal wrapper string, which would never match any
// flagged form. git/url specifiers are not version ranges either and stay
// exempt.

const FLAGGED_SPECIFIERS: ReadonlySet<string> = new Set(['*', 'latest', '']);

// peerDependencies are exempt, and this is a statement about what a peer
// range IS rather than a tolerance for noise. Nothing is installed from a
// peer range by the package declaring it: it is a compatibility statement
// addressed to whoever installs that package, and "*" there means "any
// version of this works with me", which is a claim about compatibility and
// not a decision to accept whatever gets published next. Paired with
// peerDependenciesMeta.optional it is how a library declares an optional
// integration, which is completely standard -- and because this rule
// reports at medium, and medium is the default threshold, flagging it
// blocked any such library on its very first run.
//
// The remaining three sections split on who carries the risk. npm resolves
// a package's runtime dependencies for everyone who installs it, so a
// wildcard in dependencies is inflicted on strangers; it does not install
// dependencies' dev dependencies, so a wildcard in devDependencies is
// inflicted only on whoever works in this repository. optionalDependencies
// ship to consumers exactly as runtime ones do, so they group with
// dependencies. Low keeps the dev case visible while leaving it under the
// default gate. Nothing here looks at whether the package is a library or
// an application: that is not knowable from a manifest, and guessing it
// would make the severity depend on a heuristic rather than on the section
// the author actually wrote.
const SEVERITY_BY_DEP_TYPE: Readonly<Record<DepType, Severity | null>> = {
  dependencies: 'medium',
  optionalDependencies: 'medium',
  devDependencies: 'low',
  peerDependencies: null,
};

// An unpinned range is flagged because you do not know what code you will
// get from it. That reasoning is about type-only packages, not about the
// @types scope specifically: a package whose declarations are erased at
// compile time ships no runtime code, so an unpinned range on one cannot
// hand an attacker code that executes. @types is the only scope this rule
// can currently recognize as type-only without registry metadata this
// check does not have -- every DefinitelyTyped package lives there, and
// nothing else does -- so it is what the check keys on, but the exemption
// is conceptually about the property, not the scope. A future rule
// widening detection to other type-only packages should read as extending
// this same reasoning, not as a second, unrelated rule.
//
// Demoted rather than exempted: an auditor scanning the manifest should
// still see that the range is unpinned, and install-script still covers
// whatever residual risk a compromised @types package's install scripts
// would carry. Only dependencies and optionalDependencies move -- both
// scored medium, which blocks at the default gate -- because
// devDependencies is already low and peerDependencies is already exempt.
function isTypeOnlyPackage(registryName: string): boolean {
  return registryName.startsWith('@types/');
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function rangeToJudge(change: DepChange): string | null {
  if (change.protocol === 'registry') {
    return change.specifier;
  }
  if (change.protocol === 'alias') {
    return versionRangeOf(change);
  }
  return null;
}

export const hygieneCheck: Check = (ctx) => {
  const { delta, config } = ctx;
  const findings: Omit<Finding, 'fingerprint'>[] = [];
  // A registry name can reach this loop more than once: two aliases
  // retargeting the same package, or the same name declared in both
  // dependencies and devDependencies of one manifest. Each is a separate
  // DepChange, but the resulting findings would share every field the
  // fingerprint hashes (ruleId, packageName, manifestPath; version-hygiene
  // sets no details.signal), so without this guard they collapse onto one
  // fingerprint and baselining it silently suppresses the rest -- the same
  // hazard candidates.ts's newRegistryNames already guards against for the
  // two name checks.
  const seen = new Map<string, number>();

  for (const change of delta.changes) {
    const range = rangeToJudge(change);
    if (range === null || !FLAGGED_SPECIFIERS.has(range)) {
      continue;
    }
    let severity = SEVERITY_BY_DEP_TYPE[change.depType];
    if (severity === null) {
      continue;
    }
    if (isTypeOnlyPackage(change.registryName)) {
      severity = 'low';
    }
    if (isAllowed(change.registryName, config.allow)) {
      continue;
    }

    const key = JSON.stringify([change.manifestPath, change.registryName]);
    const existing = seen.get(key);
    if (existing !== undefined) {
      // One name declared in two sections collapses to one finding, because
      // both would hash to the same fingerprint. Which severity survives is
      // therefore decided by comparing them rather than by whichever the
      // delta happened to produce first: a name that is a wildcard in both
      // dependencies and devDependencies carries the runtime risk, and
      // taking the first arrival would silently report it as low the day
      // that ordering changed.
      const kept = findings[existing];
      if (SEVERITY_RANK[severity] > SEVERITY_RANK[kept.severity]) {
        kept.severity = severity;
        (kept.details as Record<string, unknown>).depType = change.depType;
      }
      continue;
    }
    seen.set(key, findings.length);

    const shown = change.specifier === '' ? '(empty)' : change.specifier;
    findings.push({
      ruleId: 'version-hygiene',
      severity,
      packageName: change.registryName,
      message: `"${change.registryName}" is specified as "${shown}", which pins no version at all.`,
      manifestPath: change.manifestPath,
      // depType is here because the severity is decided by it, and without
      // it a reader cannot tell why one wildcard reported low and another
      // medium.
      details: { specifier: change.specifier, kind: change.kind, depType: change.depType },
    });
  }

  return findings;
};
