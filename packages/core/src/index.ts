// Public entry point for @vaultcompass/dep-guard-core. scan() and
// checkSingle() are the two questions a consumer -- the CLI, or later an
// MCP tool -- ever asks this package: "is this repository's change clean"
// and "is this package name safe to add". Everything else (the corpus,
// the delta engine, individual checks) is reachable only through relative
// imports inside this package, not re-exported here -- with one
// deliberate exception below.
export { checkSingle, scan } from './scan.js';
export type { ScanResult } from './scan.js';
export type { ScanMode } from './git-source.js';
export { FAIL_ON_LEVELS, loadConfig } from './config.js';
export type { ResolvedConfig } from './config.js';
export { DepGuardError } from './types.js';
export type { Diagnostic, FailOn, Finding, RuleId, Severity } from './types.js';
// Re-exported so scripts/lib/shippable-corpus.mjs (the release gate that
// refuses to publish a corpus this build cannot read) can import the set
// of understood format versions from the built core instead of restating
// `[1]` as a literal of its own -- see docs/INVARIANTS.md, "derive, do not
// describe".
export { SUPPORTED_CORPUS_FORMAT_VERSIONS } from './corpus.js';
