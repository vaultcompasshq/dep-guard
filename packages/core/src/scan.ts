import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadBaseline } from './baseline.js';
import { confusionCheck } from './checks/confusion.js';
import { hygieneCheck } from './checks/hygiene.js';
import { installScriptCheck } from './checks/install-script.js';
import { tamperCheck } from './checks/tamper.js';
import { typosquatCheck } from './checks/typosquat.js';
import { existenceCheck } from './checks/existence.js';
import type { Check, CheckContext, ResolvedConfig } from './checks/types.js';
import { loadConfig } from './config.js';
import type { Corpus } from './corpus.js';
import { loadCorpus } from './corpus.js';
import { computeDelta } from './delta.js';
import type { DepChange, DependencyDelta } from './delta.js';
import { fingerprintFinding } from './fingerprint.js';
import { evaluateGate, severityAtLeast } from './gate.js';
import {
  assertScannablePath,
  loadStates,
  matchGlobPath,
  probeManifestOnDisk,
  resolveScanRoot,
} from './git-source.js';
import type { ScanMode } from './git-source.js';
import { assertBaseNotHeadUnderTrustBase, loadTrustedControls } from './trust-base.js';
import type { ControlShapeChange, TrustedControls } from './trust-base.js';
import { DepGuardError } from './types.js';
import type { Diagnostic, FailOn, Finding, Severity } from './types.js';
import { applyTyposquatAsymmetry } from './online/asymmetry.js';
import { findPublishAgeFindings } from './online/publish-age.js';
import { findRegisteredSquats } from './online/registered-squat.js';
import { resolveUnknownPackages } from './online/unknown-package.js';
import {
  CI_ONLINE_BUDGET_MS,
  DEFAULT_ONLINE_BUDGET_MS,
  ONLINE_DEADLINE_CODE,
  createOnlineDeadline,
  deadlineDiagnosticMessage,
  sumDeadlineSkipped,
} from './online/deadline.js';
import { defaultCachePath, loadCache } from './online/cache.js';
import { fetchPackument, fetchWeeklyDownloads } from './online/registry-client.js';
import type { DownloadCountsResult } from './online/registry-client.js';

// Every check runs against one shared corpus + config + delta, in a fixed
// order (RuleId's own declaration order in types.ts) so a scan's finding
// list has a stable ordering that does not depend on which check happened
// to be fastest.
const CHECKS: Check[] = [
  existenceCheck,
  typosquatCheck,
  installScriptCheck,
  tamperCheck,
  hygieneCheck,
  confusionCheck,
];

// The real corpus is published data shipped alongside the compiled
// package, not source; it lives beside src/ (or dist/ once built) rather
// than inside either, so the same relative path resolves whether this
// module is running from src/ under ts-jest or from dist/ after a build.
// No fixture data ships under this path -- every current caller (every
// test in this package, and the CLI's own test suite) passes corpusDir
// explicitly, pointed at fixtures/corpus or a real published corpus.
const DEFAULT_CORPUS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'corpus'
);

// What a pull-request run says about the control inputs it did NOT obey.
// The umbrella sums `proposals` across its children, so that field is a
// plain string array with one entry per proposed change and nothing
// nested; the flags beside it let a consumer act on the kind of change
// without parsing the prose.
export interface TrustBaseReport {
  ref: string;
  proposals: string[];
  configChanged: boolean;
  baselineChanged: boolean;
  // .npmrc is a control input, not a subject: its scope pins are what
  // decide whether the dependency-confusion pin-mismatch rule has anything
  // to compare against, so a pull request that deletes .npmrc deletes a
  // rule. Reported separately from the config because it is a separate
  // file a reviewer will look for by name.
  npmrcChanged: boolean;
  configShapeChange: ControlShapeChange | null;
  baselineShapeChange: ControlShapeChange | null;
  npmrcShapeChange: ControlShapeChange | null;
}

export interface ScanResult {
  findings: Finding[]; // baseline-suppressed and ignorePaths-dropped findings excluded
  suppressed: number; // count removed by the baseline, specifically (not ignorePaths)
  ignored: number; // count removed by config.ignorePaths, specifically (not the baseline)
  // Distinct package names an `allow` entry cleared from the checks this
  // scan, and their count. A separate field rather than folded into
  // `suppressed` on purpose: `suppressed` means the baseline specifically,
  // and the stability policy freezes an existing JSON field's meaning, so
  // broadening it would be a breaking change; a new additive field is the
  // minor-safe path and keeps the three user decisions (baseline,
  // ignorePaths, allow) as three distinct numbers. `allowed` always equals
  // `allowedNames.length`; both are present even at zero, like the two
  // counts above, because an allow entry is the user's earlier decision and
  // leaving it silent is the footgun this field closes.
  allowed: number;
  allowedNames: string[]; // sorted, de-duplicated across checks
  // Present ONLY on a pull-request run (--trust-base). Absent, not null,
  // on every other run: JSON.stringify drops an undefined property
  // outright, so a scan without the flag serialises to exactly the bytes
  // it serialised to before this field existed. That byte-for-byte parity
  // is the point -- pull-request mode is a mode you enter, and a consumer
  // that never enters it should not have to learn a new key.
  trustBase?: TrustBaseReport;
  run: {
    mode: 'staged' | 'base' | 'audit';
    failOn: FailOn;
    blockingMatches: number;
    durationMs: number;
    corpusBuiltAt: string;
    lockfileFormat: string;
    diagnostics: Diagnostic[];
    // Run-level online facts (issue #75), always present so the umbrella
    // (conductor#72) and any other JSON consumer can read it unconditionally
    // rather than branching on whether --online was on. See
    // OnlineRunSummary's own doc comment for what each field means, and
    // docs/INVARIANTS.md's "one wall clock" section for the online
    // subsystem this reports on.
    online: OnlineRunSummary;
  };
  exitCode: 0 | 1;
}

// Diagnostics reach this point from several independent origins that can
// legitimately overlap: git-source.ts's StatePair (e.g. an unsupported
// workspace glob, noticed once per loadStates call but possibly on both
// sides of a scan), delta.ts's own dedupe of the two lockfiles'
// diagnostics, whatever the six checks pushed into their shared
// CheckContext.diagnostics sink, and this module's own ignore-path-unmatched
// notices -- the pnpm-no-install-script-flag notice in particular arrives
// BOTH ways: unconditionally from the pnpm lockfile parser (via
// delta.diagnostics) and again, deliberately, passed through by
// installScriptCheck (via the checks' own sink) so the check can say "this
// coverage was skipped" even when nothing else surfaces it. Same
// loop-based, JSON-keyed dedupe as delta.ts and git-source.ts use for their
// own internal merges.
function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const unique: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify([diagnostic.code, diagnostic.message]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(diagnostic);
  }
  return unique;
}

function normalizeIgnorePattern(pattern: string): string {
  let normalized = pattern.trim();
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

// config.ignorePaths was validated by config.ts from the day it landed but
// consumed nowhere until this filter. Three ways an entry can cover a
// finding's manifestPath: an exact match, a directory prefix (a plain
// "vendor/" entry covers every manifest underneath it, gitignore-style), or
// -- for an entry that actually contains a wildcard -- the same
// greedy-star, no-RegExp matcher git-source.ts uses for workspace globs.
// ignorePaths is attacker-writable content exactly like a workspaces
// array, and two ReDoS bugs already came from a regex built out of pattern
// text shaped like this; reusing the hardened matcher rather than writing
// a second one is the point.
//
// Returns every normalized entry that matches manifestPath, in
// configuration order -- not just the first one found. Callers use the
// full list (not a boolean, and not a single winner) to track, across a
// whole scan, which configured entries ever matched anything at all --
// see the ignore-path-unmatched diagnostic in applyPathFilters() below:
// the matcher's whole-path, segment-for-segment semantics are
// exactly right for safety, but they also mean a natural-looking entry
// like "packages/*" silently matches nothing against a manifest one
// segment deeper ("packages/app/package.json"), and a user has no other
// way to notice.
//
// Returning on the FIRST match and stopping would mean ignorePaths
// ["package.json", "**"] reports "**" unmatched for a finding at
// "package.json" -- "**" genuinely covers it too, it would just never be
// reached because the exact entry ahead of it in the array matched first.
// Every matching entry is credited instead, not only whichever one
// happened to be checked first.
function matchingIgnoreEntries(manifestPath: string, ignorePaths: readonly string[]): string[] {
  const matches: string[] = [];
  for (const raw of ignorePaths) {
    const pattern = normalizeIgnorePattern(raw);
    if (pattern.length === 0) {
      continue;
    }
    if (
      pattern === manifestPath ||
      manifestPath.startsWith(`${pattern}/`) ||
      (pattern.includes('*') && matchGlobPath(pattern, manifestPath))
    ) {
      matches.push(pattern);
    }
  }
  return matches;
}

// Runs all six checks against one shared CheckContext. The context's
// diagnostics array has to be the SAME array across every check call, not
// one per check: candidates.ts's noteEmptyAlias (shared by existence and
// typosquat) and the confusion/install-script checks' own dedupe guards
// all check ctx.diagnostics for an existing entry before pushing, which
// only works if every check sees what the others already reported.
function runChecks(
  corpus: Corpus,
  config: ResolvedConfig,
  delta: DependencyDelta,
  npmrcRegistryPins: Map<string, string>,
  npmrcDefaultRegistry: string | null
): { findings: Omit<Finding, 'fingerprint'>[]; ctx: CheckContext } {
  const ctx: CheckContext = {
    corpus,
    config,
    delta,
    npmrcRegistryPins,
    npmrcDefaultRegistry,
    diagnostics: [],
    allowed: [],
  };
  const findings: Omit<Finding, 'fingerprint'>[] = [];
  for (const check of CHECKS) {
    findings.push(...check(ctx));
  }
  return { findings, ctx };
}

// Lets a caller (the CLI's --fail-on) override config.failOn for one
// call without a second gate path -- blockingMatches, run.failOn, and the
// ignorePaths/baseline filtering all read the SAME effective config this
// produces, so an override can never leave any of them looking at the
// config value instead.
function applyFailOnOverride(config: ResolvedConfig, failOn: FailOn | undefined): ResolvedConfig {
  return failOn === undefined ? config : { ...config, failOn };
}

// Same shape as applyFailOnOverride: a caller's explicit online option wins
// over config.online when given; when the caller passes nothing, config
// decides. This is what lets the CLI's --online (or its absence) override
// .dep-guard.json's "online" key rather than only ever adding to it.
function resolveOnline(config: ResolvedConfig, online: boolean | undefined): boolean {
  return online ?? config.online;
}

// Issue #75: the per-run online wall-clock budget. Same precedence shape
// as resolveOnline and applyFailOnOverride -- an explicit CLI override
// always wins, then an explicit config key, and only once both are absent
// does the default get picked at all. Only then does the RUN SHAPE matter:
// a --base or --trust-base run is the pull-request/CI shape (minutes to
// spend, and a large dependency change is the expensive failure mode), so
// it gets CI_ONLINE_BUDGET_MS; a plain audit or staged run is the commit
// hook shape and keeps DEFAULT_ONLINE_BUDGET_MS. Only matters at all when
// online checks are actually on -- see resolveOnline above -- but that is
// the caller's decision, not this function's.
function resolveOnlineBudgetMs(
  config: ResolvedConfig,
  cliOverride: number | undefined,
  isPullRequestRun: boolean
): number {
  if (cliOverride !== undefined) {
    return cliOverride;
  }
  if (config.onlineBudgetMs !== undefined) {
    return config.onlineBudgetMs;
  }
  return isPullRequestRun ? CI_ONLINE_BUDGET_MS : DEFAULT_ONLINE_BUDGET_MS;
}

// Runs strictly after runChecks(): the six offline checks stay synchronous
// and untouched by this. Uses one process-lifetime cache instance so a
// single CLI invocation that calls scan() more than once (it does not
// today, but checkSingle() and scan() could both run in one process via
// the MCP server later) reuses one cache load rather than reading the
// cache file from disk on every call.
let cache: ReturnType<typeof loadCache> | null = null;
function sharedCache(): ReturnType<typeof loadCache> {
  if (cache === null) {
    cache = loadCache(defaultCachePath());
  }
  return cache;
}

const DOWNLOADS_TTL_MS = 24 * 60 * 60 * 1000; // one day: the API answers a rolling weekly window
const CREATED_TTL_MS: number | null = null; // a package's creation date never changes

// The registry client's own default backoff cap (60s) is right for the
// patient corpus builder, which pays this cost once per rebuild, but wrong
// here: config's "online": true reaches a pre-commit hook, and a modest
// delta with several rate-limited or slow names could otherwise stall a
// commit for minutes in aggregate. A live scan gets a much tighter cap,
// roughly matching the per-request budget SCAN_TIMEOUT_MS already sets.
const SCAN_BACKOFF_CAP_MS = 8_000;

// A single run's count of package NAMES actually looked up online (scan.ts's
// JSON `online.lookupsAttempted` field, issue #75) -- not wrapper calls, and
// not raw HTTP requests. Those two differ from "names" for exactly one of
// the four cached fetches below: cachedFetchWeeklyDownloads is called ONCE
// per online step with every candidate batched into a single array
// (registered-squat.ts and asymmetry.ts each issue one bulk
// fetchWeeklyDownloads call for every candidate they have, never one per
// name), and that one call can in turn cost the registry client several
// real HTTP requests internally (a 128-name unscoped batch, one request per
// scoped name, and a possible sentinel probe -- registry-client.ts's own
// fetchWeeklyDownloads). Counting "1 per call" undercounts a large batch
// badly; counting "1 per underlying HTTP request" would require this file
// to know registry-client.ts's private batching shape and would still not
// match lookupsSkippedByDeadline, which is a count of skipped CANDIDATE
// NAMES, not requests. Names are the one unit both fields can share, so a
// consumer can add them to answer "how many names did the online checks
// want to look up in total". The other three cached fetches below already
// take one name per call, so "1 per call" and "1 per name" already agree
// there; only the downloads batch needed to change.
//
// Threaded explicitly into each cached fetch below rather than kept as a
// module-level counter: enrichOnline creates one fresh per call, so two
// scans in one process (checkSingle and scan() can both run in a single
// CLI invocation, per the `cache` singleton's own comment above) never mix
// each other's counts the way a module-level mutable total would.
//
// cacheHits (issue #80) is the other half of the same count: names a step
// asked about that the cache answered, so no lookup was issued. Every name a
// cached fetch is asked about lands in exactly one of the two, which is what
// lets the summary report candidatesEvaluated as their sum and tell a run
// answered from a warm cache apart from a run with nothing to check.
interface LookupCounter {
  attempted: number;
  cacheHits: number;
}

async function cachedFetchWeeklyDownloads(
  names: string[],
  lookups: LookupCounter
): Promise<DownloadCountsResult> {
  const store = sharedCache();
  const counts = new Map<string, number>();
  const misses: string[] = [];
  for (const name of names) {
    const hit = store.get(`downloads:${name}`);
    if (typeof hit === 'number') {
      counts.set(name, hit);
    } else {
      misses.push(name);
    }
  }
  lookups.cacheHits += names.length - misses.length;
  if (misses.length > 0) {
    // One name per miss, regardless of how many HTTP requests
    // fetchWeeklyDownloads itself turns this array into -- see this
    // function's own doc comment above (LookupCounter) for why "names",
    // not "calls" or "requests", is the field's unit.
    lookups.attempted += misses.length;
    const fetched = await fetchWeeklyDownloads(misses, { backoffCapMs: SCAN_BACKOFF_CAP_MS });
    for (const [name, count] of fetched.counts) {
      counts.set(name, count);
      store.set(`downloads:${name}`, count, DOWNLOADS_TTL_MS);
    }
    // A confirmed no-record answer (registry-client.ts's DownloadCountsResult
    // -- npm answered and explicitly said it has no download history for
    // this name) is a real, timely fact about npm's rolling weekly window,
    // not a gap in what we know, so it is cached and expires exactly like a
    // real count: DOWNLOADS_TTL_MS, not withheld the way cachedFetchPackument
    // withholds a missing creation date below. Once cached as 0, it is
    // deliberately indistinguishable from an actual zero-download week --
    // that is the resolved answer, not a placeholder for one.
    //
    // Guarded on `!counts.has(name)`: fetched.counts is authoritative and
    // must never be overwritten by fetched.noRecord. readDownloadCounts
    // now intersects noRecord with what was actually requested, so this
    // should not fire against npm's real behavior -- but a malformed
    // downloads response is exactly the case a fetch layer has to be
    // defensive about, not trusting, and the cost of getting this wrong is
    // a real count silently replaced by a fabricated 0 that then persists
    // in the cache for a full day.
    for (const name of fetched.noRecord) {
      if (counts.has(name)) {
        continue;
      }
      counts.set(name, 0);
      store.set(`downloads:${name}`, 0, DOWNLOADS_TTL_MS);
    }
    // Anything neither counted nor confirmed no-record is left out of
    // both the cache and the returned counts: unresolved, not a signal
    // either way. In production this is rare -- registry-client.ts's own
    // sentinel probe (see probeDownloadsApiHealth) resolves a single-name
    // 404 (scoped or unscoped) into a confirmed `noRecord` entry before
    // it ever reaches here, or makes the whole fetchWeeklyDownloads call
    // throw (caught above, per-name results discarded, an
    // online-check-unreachable diagnostic raised by the check instead);
    // a name landing here at all means the upstream fetch had a
    // defensive, malformed-bulk-response-shaped gap, not an unresolved
    // 404. Returning an always-empty noRecord here is correct, not a
    // shortcut -- every name this function could confirm as no-record has
    // already been folded into `counts` above, so by the time a caller
    // sees this result, a name in `counts` may be a real count OR a
    // resolved zero, and a name in neither is still unresolved.
  }
  store.save();
  return { counts, noRecord: new Set() };
}

async function cachedFetchPackument(
  name: string,
  lookups: LookupCounter
): Promise<{ createdAt: string | null } | null> {
  const store = sharedCache();
  const hit = store.get(`created:${name}`);
  if (hit !== undefined) {
    lookups.cacheHits += 1;
    return { createdAt: hit as string | null };
  }
  lookups.attempted += 1;
  const packument = await fetchPackument(name, { backoffCapMs: SCAN_BACKOFF_CAP_MS });
  // A real creation date never changes, so it is safe -- and worth doing
  // -- to cache one forever (CREATED_TTL_MS). A MISSING one (a 404, or a
  // malformed packument with no time.created) is exactly the
  // registered-squat check's target scenario: a name that does not exist
  // today can be attacker-registered tomorrow and absorbed by a corpus
  // refresh. Caching that miss at all would pin "created: null" for the
  // life of the cache file, making the check permanently blind to that
  // name on any machine that happened to query it while it was still
  // unregistered -- so a miss is never cached, and every scan re-checks
  // it live instead.
  if (packument?.createdAt != null) {
    store.set(`created:${name}`, packument.createdAt, CREATED_TTL_MS);
    store.save();
  }
  return packument;
}

// publish-age.ts's own cached fetch. Deliberately keyed and cached
// DIFFERENTLY from cachedFetchPackument's `created:` entries just above,
// even though both read the same underlying packument: `created:` is safe
// to cache forever because a package's creation date never changes once
// set, but a version-times MAP grows every time the package publishes
// again, and the whole point of this check is to catch a version that was
// published recently -- exactly the version most likely to be missing from
// a map fetched before that publish happened. Caching it forever would make
// the check permanently blind to a name's newest release on any machine
// that happened to query it before that release went out. DOWNLOADS_TTL_MS
// (a day) bounds that staleness window the same way it already bounds the
// downloads cache's, and a miss (the name does not exist at all) is never
// cached, for the same not-yet-registered reason cachedFetchPackument's own
// miss is not cached above.
//
// The TTL bound alone is not enough, and used to be the whole story: a
// cache entry written just before a package published a fresh release
// stayed the answer for up to a full day, so the exact release this check
// exists to catch -- a lockfile bump that landed minutes ago -- read as
// "not in the time map" and was silently treated as a note rather than a
// finding for as long as the entry lived. `requestedVersions` closes that
// gap: a cache hit is only trusted when its map already carries every
// version this call was actually asked about. Anything short of that
// bypasses the cache entirely, asks the registry live, and overwrites the
// stale entry with the fresh answer -- so a hit can only ever save a
// request, never manufacture a false "unknown" for a version the registry
// has actually published. See the two-run regression test in
// scan-online-publish-age.test.ts.
async function cachedFetchPackumentVersionTimes(
  name: string,
  requestedVersions: string[],
  lookups: LookupCounter
): Promise<{ versionTimes: Record<string, string> } | null> {
  const store = sharedCache();
  const hit = store.get(`version-times:${name}`);
  if (hit !== undefined) {
    const cached = hit as Record<string, string>;
    if (requestedVersions.every((version) => version in cached)) {
      lookups.cacheHits += 1;
      return { versionTimes: cached };
    }
    // A version this call needs is missing from the cached map -- refetch
    // live rather than serve a map known to be incomplete for this
    // question, and fall through to the same live-fetch-and-overwrite path
    // a cold cache takes.
  }
  lookups.attempted += 1;
  const packument = await fetchPackument(name, { backoffCapMs: SCAN_BACKOFF_CAP_MS });
  if (packument === null) {
    return null;
  }
  store.set(`version-times:${name}`, packument.versionTimes, DOWNLOADS_TTL_MS);
  store.save();
  return { versionTimes: packument.versionTimes };
}

// The four online steps, in the order the run's one wall-clock budget is
// spent on them. The order is a priority decision, not an accident:
//
//  1. unknown-package resolution, because it is the only step that can
//     REMOVE a false positive from the flagship blocking check, and the
//     only one whose absence gets steadily worse as a release ages away
//     from its corpus walk. If the budget only stretches to one step, this
//     is the one worth having.
//  2. typosquat popularity asymmetry, which escalates an existing low.
//  3. registered-squat, which adds a new medium.
//  4. publish-age, which adds a new high.
//
// Steps 2 through 4 all only ever add or escalate, so a budget spent
// before them costs a signal that would not have existed offline either.
// Step 1 is the one whose omission leaves a user with a blocking finding
// they have no way to clear, which is why it goes first.
//
// Never throws, per docs/INVARIANTS.md: each step owns its own error
// handling and turns a failure into a diagnostic, because --online
// reaching a pre-commit hook must not let a flaky connection block a
// commit.
// Existence for the unknown-package check is asked LIVE, never served
// from the shared cache, and the two reasons are independent.
//
// First, the cache cannot answer this question. It stores a `created:`
// date, written for registered-squat's age question, and a date cannot
// tell a real package from an npm security-holding placeholder or from a
// name whose every version has been unpublished. Handing a cache hit to
// this check is handing it a fact about a different question.
//
// Second, even a cache that did store presence would be the wrong input
// here. `created:` entries never expire, so a name that existed when some
// earlier scan asked would read as present forever afterwards on that
// machine -- including a name npm has since removed for security reasons,
// which is the single case where a stale "it exists" is most harmful.
// Standing a blocking finding down, or downgrading it, is the one place
// in this subsystem where a wrong answer costs coverage rather than
// costing an extra signal, so it goes to the network or it leaves the
// finding alone.
//
// The cache stays exactly as valid as it was for registered-squat's age
// question, which is what it was written for: a real creation date does
// not change.
async function liveFetchPackument(name: string, lookups: LookupCounter) {
  lookups.attempted += 1;
  return fetchPackument(name, { backoffCapMs: SCAN_BACKOFF_CAP_MS });
}

// The run-level facts scan.ts's JSON `online` field reports (issue #75).
// enrichOnline builds one of these per call; a disabled run (online never
// turned on) gets the all-zero, enabled:false shape directly from scan()
// and checkSingle() instead, so the field is present either way -- see
// buildResult.
export interface OnlineRunSummary {
  enabled: boolean;
  budgetMs: number;
  // Package NAMES the online steps asked about, counted per step in the
  // same unit as lookupsAttempted (issue #80). Always lookupsAttempted plus
  // cacheHits: every name a step asks about is either looked up or answered
  // from the cache. A run answered entirely from a warm cache and a run with
  // nothing to check both report lookupsAttempted 0; this is what tells them
  // apart. Names skipped by the deadline were never asked about and are not
  // included here (see lookupsSkippedByDeadline).
  candidatesEvaluated: number;
  // Package NAMES for which a real registry or downloads lookup was
  // actually issued, summed across all four online steps -- see
  // LookupCounter's own doc comment above for why this counts names, never
  // wrapper calls or raw HTTP requests: a single batched downloads call can
  // carry many names in one request, and this field has to stay in the same
  // unit as lookupsSkippedByDeadline for the two to be addable. Counted per
  // check, never per distinct name: a name that unknown-package,
  // registered-squat and publish-age each look up counts once for each.
  lookupsAttempted: number;
  // Package NAMES answered from the on-disk cache, so no lookup was issued
  // for them. Same unit and same per-step counting as lookupsAttempted.
  cacheHits: number;
  // Skipped LOOKUPS once the budget was spent, read back out of every
  // online-deadline-exceeded diagnostic this run raised (deadline.ts's
  // sumDeadlineSkipped) rather than kept as a second, independently
  // incremented count. "Skipped lookups", not "candidates skipped": the
  // same package name can be counted here more than once if two different
  // online steps both had it queued and both ran out of budget before
  // reaching it (each step tracks and reports its own skips independently),
  // so this is not a count of distinct packages the budget cost coverage
  // for.
  lookupsSkippedByDeadline: number;
  deadlineExceeded: boolean;
}

const ONLINE_DISABLED_SUMMARY: OnlineRunSummary = {
  enabled: false,
  budgetMs: 0,
  candidatesEvaluated: 0,
  lookupsAttempted: 0,
  cacheHits: 0,
  lookupsSkippedByDeadline: 0,
  deadlineExceeded: false,
};

async function enrichOnline(
  rawFindings: Omit<Finding, 'fingerprint'>[],
  ctx: CheckContext,
  budgetMs: number
): Promise<{ findings: Omit<Finding, 'fingerprint'>[]; summary: OnlineRunSummary }> {
  const deadline = createOnlineDeadline(budgetMs);
  // Threaded through every real fetch below rather than kept at module
  // scope: see LookupCounter's own comment for why a fresh one per call is
  // what keeps two scans in one process from mixing counts.
  const lookups: LookupCounter = { attempted: 0, cacheHits: 0 };

  const resolved = await resolveUnknownPackages(
    rawFindings,
    ctx,
    { fetchPackument: (name) => liveFetchPackument(name, lookups) },
    ctx.diagnostics,
    deadline
  );

  // applyTyposquatAsymmetry issues one bulk request and has no per-name
  // loop, so it is gated here rather than internally: there is exactly one
  // point at which it could stop, and that point is before it starts. The
  // count here is the low typosquat findings before the check's own
  // internal-name and private-origin filters run, so on an expired deadline
  // it can overstate how many lookups were skipped, never understate; no
  // name is emitted with it.
  const asymmetryCandidates = resolved.filter(
    (f) => f.ruleId === 'typosquat' && f.severity === 'low'
  ).length;
  if (deadline.expired()) {
    if (asymmetryCandidates > 0) {
      ctx.diagnostics.push({
        code: ONLINE_DEADLINE_CODE,
        message: deadlineDiagnosticMessage(
          'typosquat popularity asymmetry',
          asymmetryCandidates,
          deadline
        ),
      });
    }
  } else {
    await applyTyposquatAsymmetry(
      resolved,
      ctx,
      { fetchWeeklyDownloads: (names) => cachedFetchWeeklyDownloads(names, lookups) },
      ctx.diagnostics
    );
  }

  const registeredSquats = await findRegisteredSquats(
    ctx,
    {
      fetchWeeklyDownloads: (names) => cachedFetchWeeklyDownloads(names, lookups),
      fetchPackument: (name) => cachedFetchPackument(name, lookups),
    },
    ctx.diagnostics,
    deadline
  );

  // 4. publish-age, added last for the same reason registered-squat is
  // third: it only ever ADDS a new finding, so a budget spent before it
  // costs a signal that would not have existed offline either, unlike
  // step 1's removals.
  const publishAgeFindings = await findPublishAgeFindings(
    ctx,
    { fetchPackument: (name, versions) => cachedFetchPackumentVersionTimes(name, versions, lookups) },
    ctx.diagnostics,
    deadline
  );
  return {
    findings: [...resolved, ...registeredSquats, ...publishAgeFindings],
    summary: {
      enabled: true,
      budgetMs,
      candidatesEvaluated: lookups.attempted + lookups.cacheHits,
      lookupsAttempted: lookups.attempted,
      cacheHits: lookups.cacheHits,
      // Read back out of ctx.diagnostics rather than kept as a second,
      // independently-incremented count: see sumDeadlineSkipped's own
      // comment for why this is the number a human reading the same
      // diagnostics would also compute.
      lookupsSkippedByDeadline: sumDeadlineSkipped(ctx.diagnostics),
      deadlineExceeded: deadline.expired(),
    },
  };
}

interface RunInfo {
  mode: 'staged' | 'base' | 'audit';
  lockfileFormat: string;
  corpusBuiltAt: string;
  diagnostics: Diagnostic[];
  startedAt: number;
  online: OnlineRunSummary;
}

// checkSingle's manifestPath is fabricated (SYNTHETIC_MANIFEST_PATH
// below) -- there is no real file behind the propose-time question -- so
// neither ignorePaths nor the baseline, both keyed off that path (directly,
// or via the fingerprint), are meaningful filters for it. Applying them
// would let a repo's config for a completely unrelated location silently
// launder "is this name safe" into "clean". scan()'s real findings, with
// real manifestPath values, get both filters; checkSingle's synthetic ones
// get neither.
function applyPathFilters(
  rawFindings: Omit<Finding, 'fingerprint'>[],
  config: ResolvedConfig,
  baseline: Set<string>,
  diagnostics: Diagnostic[]
): { findings: Finding[]; suppressed: number; ignored: number } {
  const findings: Finding[] = [];
  let suppressed = 0;
  let ignored = 0;
  const matchedEntries = new Set<string>();
  let droppedSeverity: Severity | null = null;

  for (const raw of rawFindings) {
    const matches = matchingIgnoreEntries(raw.manifestPath, config.ignorePaths);
    if (matches.length > 0) {
      for (const matched of matches) {
        matchedEntries.add(matched);
      }
      ignored += 1;
      if (droppedSeverity === null || severityAtLeast(raw.severity, droppedSeverity)) {
        droppedSeverity = raw.severity;
      }
      continue;
    }
    const fingerprint = fingerprintFinding(raw);
    if (baseline.has(fingerprint)) {
      suppressed += 1;
      continue;
    }
    findings.push({ ...raw, fingerprint });
  }

  // Name any configured entry that never matched a single finding's
  // manifestPath in this scan. The matcher itself is not changed -- its
  // whole-path precision is the point -- this only makes a silent no-op
  // entry visible instead of indistinguishable from "there was nothing to
  // ignore".
  //
  // Gated on there having been at least one raw finding at all. dep-guard
  // runs per commit, where most runs are clean, so deriving "unmatched"
  // from findings alone would mean a clean scan with any ignorePaths
  // configured reports every single entry as unmatched, which is noise on
  // nearly every invocation of a correctly configured repo, not a signal.
  if (rawFindings.length > 0) {
    for (const raw of config.ignorePaths) {
      const normalized = normalizeIgnorePattern(raw);
      if (normalized.length === 0 || matchedEntries.has(normalized)) {
        continue;
      }
      diagnostics.push({
        code: 'ignore-path-unmatched',
        message: `ignorePaths entry "${raw}" did not match any finding's manifestPath in this scan`,
      });
    }
  }

  // config.ts refuses an entry that matches everything, but a narrower
  // entry can still drop a critical, and dropping happens before the gate
  // ever weighs severity. What was dropped is therefore invisible in the
  // exit code by design -- so it is said out loud instead, with the worst
  // severity that went, since "1 ignored" reads the same whether it hid a
  // wildcard-version nit or a repointed tarball.
  if (droppedSeverity !== null) {
    diagnostics.push({
      code: 'ignore-path-dropped',
      message: `ignorePaths dropped ${ignored} finding(s) before the gate, the most severe of them ${droppedSeverity}`,
    });
  }

  return { findings, suppressed, ignored };
}

// checkSingle's counterpart to applyPathFilters: fingerprints every raw
// finding but applies neither ignorePaths nor the baseline (see the note
// on applyPathFilters above).
function skipPathFilters(rawFindings: Omit<Finding, 'fingerprint'>[]): Finding[] {
  return rawFindings.map((raw) => ({ ...raw, fingerprint: fingerprintFinding(raw) }));
}

// allowedNames is the raw list of names checks recorded via allowClears
// (one push per drop site); it is de-duplicated and sorted here so the
// result carries distinct cleared names in a stable order, and `allowed` is
// their count. Done in one place so every ScanResult -- scan() and
// checkSingle() alike -- reports the two the same way.
function buildResult(
  findings: Finding[],
  suppressed: number,
  ignored: number,
  allowedNames: string[],
  config: ResolvedConfig,
  info: RunInfo,
  controls: TrustedControls | null
): ScanResult {
  const { blockingMatches, exitCode } = evaluateGate(findings, config.failOn);
  const distinctAllowed = [...new Set(allowedNames)].sort();

  return {
    findings,
    suppressed,
    ignored,
    allowed: distinctAllowed.length,
    allowedNames: distinctAllowed,
    // Spread rather than assigned, so the key is genuinely ABSENT outside
    // pull-request mode rather than present-and-undefined. The two
    // serialise the same through JSON.stringify but not through a deep
    // equality assertion, and the no-flag parity test asserts on the
    // object.
    ...(controls === null
      ? {}
      : {
          trustBase: {
            ref: controls.ref,
            proposals: controls.proposals,
            configChanged: controls.configChanged,
            baselineChanged: controls.baselineChanged,
            npmrcChanged: controls.npmrcChanged,
            configShapeChange: controls.configShapeChange,
            baselineShapeChange: controls.baselineShapeChange,
            npmrcShapeChange: controls.npmrcShapeChange,
          },
        }),
    run: {
      mode: info.mode,
      failOn: config.failOn,
      blockingMatches,
      durationMs: Date.now() - info.startedAt,
      corpusBuiltAt: info.corpusBuiltAt,
      lockfileFormat: info.lockfileFormat,
      diagnostics: dedupeDiagnostics(info.diagnostics),
      online: info.online,
    },
    exitCode,
  };
}

// The full pipeline: loadConfig -> loadCorpus -> loadStates -> computeDelta
// -> run all six checks -> fingerprint -> ignorePaths/baseline filter ->
// evaluateGate.
export async function scan(opts: {
  repoRoot: string;
  mode: ScanMode;
  corpusDir?: string;
  failOn?: FailOn;
  online?: boolean;
  // The CLI's --online-budget-ms, overriding config.onlineBudgetMs for one
  // run the same way opts.online overrides config.online (issue #75). Only
  // matters when online checks are actually on; see resolveOnlineBudgetMs.
  onlineBudgetMs?: number;
  // Pull-request mode. When set, .dep-guard.json, .dep-guard.local.json
  // and the baseline are read from this ref through git and the head tree
  // is the thing judged; a head-side change to any of them is reported and
  // ignored. Independent of opts.mode.ref: --base decides WHAT changed,
  // --trust-base decides by WHOSE RULES it is judged. See trust-base.ts.
  trustBase?: string;
}): Promise<ScanResult> {
  const startedAt = Date.now();
  // Checked before anything else touches opts.repoRoot -- resolveScanRoot
  // spawns git against it, and loadConfig below joins config file names
  // onto it, both of which turn a missing directory or a file-where-a-
  // directory-belongs into a confusing git-spawn or config-read error
  // instead of the plain path-missing this is. loadStates re-checks this
  // internally too (it can be called on its own, from tests and any
  // future direct caller), so this is belt-and-suspenders, not a moved
  // check -- but it has to run first here for scan()'s own error to be
  // the right one.
  await assertScannablePath(opts.repoRoot);
  // Manifests always resolve against the git root, in every mode
  // (git-source.ts anchors every path there) -- config and the baseline
  // have to be read from that SAME root, not from whatever directory
  // opts.repoRoot happened to name, or scanning a subdirectory would
  // silently discard the repository's own .dep-guard.json and baseline.
  // Resolved independently of loadStates (which re-resolves internally)
  // rather than reusing its result, so loadStates still gets the raw
  // opts.repoRoot and can still raise its own scan-anchor-differs notice
  // when the two disagree.
  const root = await resolveScanRoot(opts.repoRoot, opts.mode);
  // Runs before the corpus is loaded and before any state is read, so an
  // unusable trust base is could-not-run with NOTHING scanned, which is
  // what the exit-2 message promises. Null outside pull-request mode, and
  // then every line below reads exactly as it did before this flag
  // existed.
  const controls =
    opts.trustBase === undefined ? null : await loadTrustedControls(root, opts.trustBase);
  // Issue #64's companion refusal to assertTrustBaseUsable's own: an
  // explicit --base of HEAD is not itself a trust-base misconfiguration,
  // so loadTrustedControls above would not have caught it, but it is
  // exactly as empty a comparison once --trust-base is also present. Gated
  // on controls !== null (opts.trustBase given) and mode.kind === 'base'
  // (opts.base given): a local --base run with no --trust-base is
  // untouched, per the issue.
  if (controls !== null && opts.mode.kind === 'base') {
    await assertBaseNotHeadUnderTrustBase(root, opts.mode.ref);
  }
  const config = applyFailOnOverride(controls?.config ?? loadConfig(root), opts.failOn);
  const corpus = loadCorpus(opts.corpusDir ?? DEFAULT_CORPUS_DIR);
  const statePair = await loadStates(opts.repoRoot, opts.mode);

  // Ported from a sibling scanner's whole-tree "examined zero files is
  // could-not-run" invariant, adapted to dep-guard's own unit of work: a
  // manifest, not a file. statePair.after is the side under judgment in
  // every mode (the working tree for audit/base, the index for staged), so
  // zero resolved manifests on it is the dep-guard analogue of a walk that
  // opened nothing.
  //
  // Zero resolved manifests is ambiguous on its own, unlike that sibling
  // scanner's zero-files case: it is both what a genuinely dependency-free
  // repository looks like (legitimate, common, and must stay a clean pass --
  // a repo with nothing to depend on has nothing to check) and what a
  // misrooted or glob-missed scan looks like (a real manifest exists, but
  // the resolver's rules -- a workspace glob, the git index, symlink
  // containment -- never reached it). probeManifestOnDisk is a second,
  // deliberately cruder, resolver-INDEPENDENT check that tells the two
  // apart: only when it finds a manifest-shaped file that the real resolver
  // did NOT is this could-not-run, never when both agree there is nothing.
  //
  // Deliberately excludes checkSingle(): that function never calls
  // loadStates and has no "resolved manifests" of its own to be zero --
  // its synthetic one-dependency delta is unconditional.
  //
  // Also deliberately excludes staged mode. statePair.after there is the
  // git INDEX, not the working tree, so a package.json a developer just
  // created but has not yet `git add`-ed is a legitimate, imposed-empty
  // staged scope -- zero staged manifests is exactly what an empty index
  // looks like, not evidence of a wrong scan root. probeManifestOnDisk
  // reads the filesystem, which will disagree with the index the instant
  // an untracked manifest exists, so running it here would misdiagnose a
  // normal not-yet-staged file as a misrooted scan on every commit through
  // the init pre-commit hook (`dep-guard scan --staged`). The sibling
  // scanner makes this same exclusion for the same reason.
  if (opts.mode.kind !== 'staged' && statePair.after.manifests.length === 0) {
    const manifestOnDisk = await probeManifestOnDisk(root);
    if (manifestOnDisk) {
      throw new DepGuardError(
        'found a manifest on disk but resolved none; the scan root may be wrong. In CI ' +
          'this is a could-not-run, not a clean pass. Check that the action runs at the ' +
          'repository root.',
        'manifests-unresolved'
      );
    }
  }

  const delta = computeDelta(statePair.before, statePair.after);
  // Left at this point in the sequence deliberately for the no-flag case:
  // moving the on-disk read earlier would change which error a repository
  // with BOTH a malformed baseline and an unreadable base ref reports, and
  // outside pull-request mode nothing about this function changes.
  const baseline = controls === null ? loadBaseline(root) : controls.baseline;

  // The scope pins are a CONTROL INPUT, so in pull-request mode they come
  // from the base ref like the config and the baseline do.
  //
  // statePair.after is the tree under judgment, and the pin-mismatch rule
  // fires only for a scope that HAS a pin, so sourcing the pins from there
  // meant a pull request could delete .npmrc and delete the rule along
  // with it. That was live, and it was worse than silent: the run reported
  // "no control input changed in this pull request" while a control input
  // had just been removed. loadStates still reads the head-side .npmrc as
  // it always did; its pins are simply not what the rule is judged
  // against here.
  //
  // The unscoped default registry is the same kind of control input, for
  // the same reason: online/publish-age.ts's isNonPublicResolution reads
  // it to judge a pnpm integrity-only resolution, and sourcing it from
  // statePair.after would let a pull request silence that check for a
  // package it introduces by adding or changing this one .npmrc line.
  const { findings: checkedFindings, ctx } = runChecks(
    corpus,
    config,
    delta,
    controls === null ? statePair.after.npmrcRegistryPins : controls.npmrcPins,
    controls === null ? statePair.after.npmrcDefaultRegistry : controls.npmrcDefaultRegistry
  );
  // A --base or --trust-base run is the pull-request/CI shape (issue #75):
  // never a commit hook, so the online budget's default is minutes rather
  // than seconds when either is present. controls !== null is exactly
  // "opts.trustBase was given".
  const isPullRequestRun = controls !== null || opts.mode.kind === 'base';
  let rawFindings: Omit<Finding, 'fingerprint'>[];
  let online: OnlineRunSummary;
  if (resolveOnline(config, opts.online)) {
    const budgetMs = resolveOnlineBudgetMs(config, opts.onlineBudgetMs, isPullRequestRun);
    const enriched = await enrichOnline(checkedFindings, ctx, budgetMs);
    rawFindings = enriched.findings;
    online = enriched.summary;
  } else {
    rawFindings = checkedFindings;
    online = ONLINE_DISABLED_SUMMARY;
  }

  const diagnostics = [...statePair.diagnostics, ...delta.diagnostics, ...ctx.diagnostics];
  const { findings, suppressed, ignored } = applyPathFilters(rawFindings, config, baseline, diagnostics);

  return buildResult(
    findings,
    suppressed,
    ignored,
    ctx.allowed,
    config,
    {
      mode: statePair.mode.kind,
      lockfileFormat: delta.lockfileFormat,
      corpusBuiltAt: corpus.builtAt,
      diagnostics,
      startedAt,
      online,
    },
    controls
  );
}

const SYNTHETIC_MANIFEST_PATH = 'package.json';
// A pinned, non-flagged placeholder version. checkSingle answers "is this
// PACKAGE NAME safe to add", a question with no real specifier behind it
// yet; using one of hygiene.ts's flagged forms ("*", "latest", "") here
// would make every checkSingle call report a version-hygiene finding that
// has nothing to do with the name being asked about.
const SYNTHETIC_SPECIFIER = '0.0.0';

// checkSingle structurally exercises only existence, typosquat, and
// confusion's internal-name rule -- there is no lockfile for tamper or
// install-script to read (a synthetic delta carries none), and the
// synthetic specifier above can never be one of hygiene's flagged forms.
// install-script.ts's own doctrine for its standing pnpm diagnostic is
// "say when coverage was skipped instead of going quiet and looking
// clean"; this is the same courtesy for checkSingle's structural gap, so
// a caller can tell "checkSingle found nothing" apart from "checkSingle
// found nothing AND could only look at three of six rules".
// Exported because it is the only reliable way, from outside, to tell a
// checkSingle result from an ordinary audit scan: both report mode
// 'audit', and checkSingle's fabricated manifestPath is the literal
// "package.json", which a real root-manifest finding also carries. The
// CLI's SARIF renderer needs that distinction to avoid pointing a
// physical location at a file the finding has nothing to do with, and
// importing the constant is how it gets it without a second copy of the
// string that could drift from this one.
export const CHECK_SINGLE_DIAGNOSTIC_CODE = 'check-single-name-only';

const NAME_ONLY_DIAGNOSTIC: Diagnostic = {
  code: CHECK_SINGLE_DIAGNOSTIC_CODE,
  message:
    'checkSingle only evaluates the name-based checks (existence, typosquat, and the ' +
    'dependency-confusion internal-name rule); lockfile-tamper, install-script, and ' +
    'version-hygiene need a real lockfile or a real specifier and were not meaningfully ' +
    'run against this synthetic one-dependency check.',
};

// The propose-time question ("is this package safe to add?") has no real
// git state to diff against -- there is no before, and the "after" is a
// manifest that does not exist yet. Rather than maintain a second judgment
// path that could drift from the real one, a synthetic one-dependency
// delta is built and run through the exact same six checks, fingerprinting,
// and gate that scan() uses (see applyPathFilters's note above for why the
// baseline and ignorePaths filters are the one thing NOT shared).
function syntheticDelta(name: string): DependencyDelta {
  const change: DepChange = {
    name,
    registryName: name,
    specifier: SYNTHETIC_SPECIFIER,
    kind: 'added',
    depType: 'dependencies',
    protocol: 'registry',
    manifestPath: SYNTHETIC_MANIFEST_PATH,
  };
  return {
    changes: [change],
    lockEntryChanges: [],
    onlyBuiltAdded: [],
    lockfileFormat: 'none',
    // The propose-time question has no repository revision behind it, and
    // no lockfile either, so nothing about this synthetic delta may be
    // read as "this changed".
    hasComparisonBase: false,
    workspaceLocalNames: new Set(),
    diagnostics: [],
  };
}

// Shares the run block's shape with scan() (mode reads 'audit': there is
// no git state behind this question, same as an audit scan of a
// repository with no history) so a caller -- the CLI's `dep-guard check`,
// and later an MCP tool -- can treat both results identically.
//
// npmrcRegistryPins is intentionally empty, and npmrcDefaultRegistry
// intentionally null, rather than read from the real repository: the
// synthetic delta carries no lockfile resolution at all -- neither for the
// dependency-confusion pin-mismatch rule to compare against a pin, nor for
// publish-age's isNonPublicResolution to judge against a default registry
// -- so neither rule can act on either value here regardless; the
// internal-name rule (the other half of confusionCheck) still runs, since
// it only needs config and the name itself.
export async function checkSingle(opts: {
  repoRoot: string;
  name: string;
  corpusDir?: string;
  failOn?: FailOn;
  online?: boolean;
  // The CLI's --online-budget-ms; see scan()'s own field of the same name.
  onlineBudgetMs?: number;
  // The same pull-request mode scan() takes, and for the same reason:
  // "is this name safe to add" is answered against `allow`,
  // `internalScopes`, `internalPrefixes` and `failOn`, every one of which
  // a pull request can rewrite in the commit that adds the name. The
  // baseline is loaded and REPORTED here as well but, as always for
  // checkSingle, is not applied -- a synthetic manifest path makes a
  // fingerprint match meaningless (see applyPathFilters above).
  trustBase?: string;
}): Promise<ScanResult> {
  // An empty (or whitespace-only) name has no meaningful answer. Reporting
  // "safe" for it -- which an empty name would otherwise do, via a
  // manifest-alias-empty diagnostic that has nothing to do with what
  // actually happened -- would be actively misleading, so it is rejected
  // at the boundary instead.
  if (opts.name.trim().length === 0) {
    throw new DepGuardError('checkSingle: "name" must not be empty or whitespace-only', 'name-invalid');
  }

  const startedAt = Date.now();
  // Same reasoning as the check at the top of scan(): a missing directory
  // or a file where a directory belongs has to be reported as
  // path-missing, before loadConfig below turns it into a confusing
  // config-read error by joining a config file name onto a path that was
  // never a directory. assertScannablePath only checks the path itself,
  // so this does not make checkSingle require a git repository.
  await assertScannablePath(opts.repoRoot);
  // Same reasoning as scan() above -- config has to be read from the
  // repository root, not from wherever opts.repoRoot happens to point, or
  // a subdirectory call would silently miss the repo's allow list,
  // internalScopes, and every other config key. Resolved the tolerant
  // (audit-mode) way: checkSingle must not require being inside a git
  // repository just to read config.
  const root = await resolveScanRoot(opts.repoRoot, { kind: 'audit' });
  const controls =
    opts.trustBase === undefined ? null : await loadTrustedControls(root, opts.trustBase);
  const config = applyFailOnOverride(controls?.config ?? loadConfig(root), opts.failOn);
  const corpus = loadCorpus(opts.corpusDir ?? DEFAULT_CORPUS_DIR);
  const delta = syntheticDelta(opts.name);

  const { findings: checkedFindings, ctx } = runChecks(corpus, config, delta, new Map(), null);
  // checkSingle has no --base concept -- only --trust-base -- so the
  // pull-request/CI shape here is exactly "a trust base was given".
  const isPullRequestRun = controls !== null;
  let rawFindings: Omit<Finding, 'fingerprint'>[];
  let online: OnlineRunSummary;
  if (resolveOnline(config, opts.online)) {
    const budgetMs = resolveOnlineBudgetMs(config, opts.onlineBudgetMs, isPullRequestRun);
    const enriched = await enrichOnline(checkedFindings, ctx, budgetMs);
    rawFindings = enriched.findings;
    online = enriched.summary;
  } else {
    rawFindings = checkedFindings;
    online = ONLINE_DISABLED_SUMMARY;
  }

  const findings = skipPathFilters(rawFindings);

  return buildResult(
    findings,
    0,
    0,
    ctx.allowed,
    config,
    {
      mode: 'audit',
      lockfileFormat: delta.lockfileFormat,
      corpusBuiltAt: corpus.builtAt,
      diagnostics: [...ctx.diagnostics, NAME_ONLY_DIAGNOSTIC],
      startedAt,
      online,
    },
    controls
  );
}
