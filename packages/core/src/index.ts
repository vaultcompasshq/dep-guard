// Public entry point for @vaultcompass/dep-guard-core. scan() and
// checkSingle() are the two questions a consumer -- the CLI, or later an
// MCP tool -- ever asks this package: "is this repository's change clean"
// and "is this package name safe to add". Everything else (the corpus,
// the delta engine, individual checks) is reachable only through relative
// imports inside this package, not re-exported here.
//
// As of 0.1.0, packages/core/package.json's "exports" field makes this the
// ONLY module specifier this package resolves for external consumers --
// "." (this file) and "./package.json", nothing else. That is a deliberate
// decision, not an oversight: this package's public API at 0.1.0 is the
// surface re-exported from this file, full stop, and every deep import
// (`@vaultcompass/dep-guard-core/dist/corpus.js` or similar) becomes
// unsupported the moment "exports" ships, because Node's resolution
// algorithm stops falling back to "main" once "exports" is present at all.
// Widening this later (adding another export, or an explicit deep path) is
// backward compatible; narrowing it after something outside this repo
// depends on a deep import is not, so this file is where that surface is
// decided. It is enforced separately, in
// scripts/tests/core-package-files.test.mjs's "exports map" describe
// block, which pins both packages' package.json "exports" fields exactly
// (membership and key order) -- deleting a key, adding one, or reordering
// "types" ahead of or behind "default" fails that test. Edit this file and
// that test together, deliberately, not by accident.
//
// This does NOT affect this repository's own build/release scripts, which
// import core by relative FILE PATH into the dist output
// (packages/core/dist/bloom.js, dist/corpus.js, dist/online/registry-client.js,
// from scripts/*.mjs) rather than through the package specifier
// "@vaultcompass/dep-guard-core". Node's "exports" field governs
// resolution of a bare package specifier; it has no say over a relative
// path reaching directly into another package's directory on disk. Verified
// by running the script test suite (scripts/tests/*.test.mjs, which import
// core this same relative-path way) after "exports" was added: unaffected.
export { checkSingle, scan, CHECK_SINGLE_DIAGNOSTIC_CODE } from './scan.js';
export type { ScanResult } from './scan.js';
export type { ScanMode } from './git-source.js';
export { FAIL_ON_LEVELS, loadConfig } from './config.js';
export type { ResolvedConfig } from './config.js';
// The gate's per-finding decision, exported for the CLI's SARIF renderer
// (properties.blocking). Deliberately the same function evaluateGate is
// built on rather than a description of it -- see the comment on
// isBlocking in gate.ts. Widening "exports" this way is backward
// compatible; see the note at the top of this file, and update
// scripts/tests/core-package-files.test.mjs's exports-map assertions
// together with any change to package.json's own "exports" field.
export { isBlocking } from './gate.js';
export { DepGuardError } from './types.js';
export type { Diagnostic, FailOn, Finding, RuleId, Severity } from './types.js';
