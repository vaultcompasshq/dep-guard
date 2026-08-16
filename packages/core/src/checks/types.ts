import type { Corpus } from '../corpus.js';
import type { DependencyDelta } from '../delta.js';
import type { Diagnostic, FailOn, Finding } from '../types.js';

// The resolved user configuration every check reads.
//
// config.ts owns the file format, the local overlay, and the validation
// that rejects unknown keys. It re-exports this interface rather than
// declaring a second copy, because the checks were written against these
// keys first and two declarations would drift.
export interface ResolvedConfig {
  failOn: FailOn;
  allow: string[]; // exact names or '@scope/*' patterns, silences any finding for that package
  internalScopes: string[]; // '@acme'
  internalPrefixes: string[]; // 'acme-'
  extraAliases: Record<string, string[]>;
  ignorePaths: string[];
  online: boolean; // turns on the registry-backed checks in packages/core/src/online/
}

// Everything a check may read, plus one thing it may write.
//
// `diagnostics` is a sink, not an input: a check that has to decline a
// dependency for a reason the user should hear about (a malformed npm:
// alias with no target, say) pushes a Diagnostic here rather than
// inventing a finding for a package it cannot name. The Check signature
// returns findings only, so the sink is how "I looked at this and could
// not judge it" reaches the run block. The orchestrator de-duplicates the
// sink, since two checks looking at the same malformed dependency report
// the same one fact.
export interface CheckContext {
  corpus: Corpus;
  config: ResolvedConfig;
  delta: DependencyDelta;
  npmrcRegistryPins: Map<string, string>;
  diagnostics: Diagnostic[];
}

// Fingerprints are computed centrally so that every rule hashes the same
// fields the same way; a check never sets one.
export type Check = (ctx: CheckContext) => Omit<Finding, 'fingerprint'>[];
