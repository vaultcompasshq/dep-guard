import { createHash } from 'node:crypto';
import type { Finding } from './types.js';

// A finding's identity for baselining purposes: ruleId, packageName (every
// check populates this with the registry name, never the manifest key),
// and manifestPath, plus details.signal.
//
// details.signal is not optional here even though the type-level Finding
// leaves details itself optional: a single dependency can trip several
// signals under one rule at once --
// lockfile-tamper's git-source and integrity-removed, say -- sharing
// every other field. Leaving signal out of the hash would collapse all of
// them onto one fingerprint, and baselining any one signal would silently
// suppress the others too. A finding with no signal at all (most rules
// only ever report one shape of problem) hashes the same as one with an
// explicit empty string, so the absence of the field is not itself a
// distinguishing value.
//
// Deliberately excluded: severity, message, and every OTHER details key
// (specifier, version, corpusBuiltAt, targetRank, ...). Those all move
// under review or a corpus refresh without the underlying finding being a
// different fact, and a fingerprint that shifted with them would silently
// invalidate every stored baseline on the next scan.
//
// The four components are combined with JSON.stringify, not a
// newline-joined string -- delta.ts's compositeKey (delta.ts:41-46)
// already refuses to join composite keys with a plain separator for
// exactly this reason: a separator character that can itself appear
// inside a component lets two different (packageName, manifestPath)
// pairs hash identically ("a\nb" + "c" collides with "a" + "b\nc" under a
// newline join). JSON.stringify escapes any embedded separator inside
// each array element, so no component's content can bleed into the next.
export function fingerprintFinding(f: Omit<Finding, 'fingerprint'>): string {
  const signal = typeof f.details?.signal === 'string' ? f.details.signal : '';
  const payload = JSON.stringify([f.ruleId, f.packageName, f.manifestPath, signal]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
