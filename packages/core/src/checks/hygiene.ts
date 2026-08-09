import type { DepChange } from '../delta.js';
import { versionRangeOf } from '../delta.js';
import type { Finding } from '../types.js';
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
  const seen = new Set<string>();

  for (const change of delta.changes) {
    const range = rangeToJudge(change);
    if (range === null || !FLAGGED_SPECIFIERS.has(range)) {
      continue;
    }
    if (isAllowed(change.registryName, config.allow)) {
      continue;
    }
    const key = JSON.stringify([change.manifestPath, change.registryName]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const shown = change.specifier === '' ? '(empty)' : change.specifier;
    findings.push({
      ruleId: 'version-hygiene',
      severity: 'medium',
      packageName: change.registryName,
      message: `"${change.registryName}" is specified as "${shown}", which pins no version at all.`,
      manifestPath: change.manifestPath,
      details: { specifier: change.specifier, kind: change.kind },
    });
  }

  return findings;
};
