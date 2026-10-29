import { readFileSync } from 'node:fs';
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
import { collapseInstallScriptFindings } from './install-script-collapse.js';
import { evaluateGate, severityAtLeast } from './gate.js';
import {
  assertScannablePath,
  loadRefProjects,
  loadRefState,
  loadStates,
  refsNameSameTree,
  probeManifestOnDisk,
  projectManifestForLockfile,
  projectReasonText,
  reconfirmWorkspaceLocalNames,
  relativeScanPrefix,
  resolveScanRoot,
} from './git-source.js';
import type { ScanMode } from './git-source.js';
import { matchingIgnoreEntries, normalizeIgnorePattern } from './ignore-paths.js';
import { assertBaseNotHeadUnderTrustBase, loadConfigAtRef, loadTrustedControls } from './trust-base.js';
import type { ControlShapeChange, TrustedControls } from './trust-base.js';
import {
  EMPTY_PROJECTS,
  isReadLockfile,
  projectReasonKey,
  type ProjectClassification,
  type ProjectReason,
  type RepoState,
} from './state.js';
import { DepGuardError } from './types.js';
import type { Diagnostic, FailOn, Finding, Severity } from './types.js';
import { applyTyposquatAsymmetry, asymmetryCandidateNames } from './online/asymmetry.js';
import { isAllowed, isInternalName, isPypiAllowed, isPypiInternalName } from './checks/allow.js';
import {
  ONLINE_NAMES_UNCHECKED,
  settleUnchecked,
  uncheckedMessage,
  type UncheckedName,
  type UncheckedSink,
} from './online/unchecked.js';
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
import { newNames } from './checks/candidates.js';
import { pythonTyposquatCheck } from './checks/python-typosquat.js';
import { pypiNamesNotChecked, summarizeEcosystems, type EcosystemsSummary } from './ecosystems.js';
import { fetchPypiProject } from './online/pypi-client.js';
import { checkPypiExistence, type PypiExistenceStats } from './online/pypi-existence.js';
import { applyUvSources, judgedPythonControls, PythonIndexRule } from './python-sources.js';
import { loadPythonControls } from './python-trust.js';

// The version of this installed package, for a message that has to say which
// dep-guard read the repository. package.json sits one level above both src/
// and dist/. Never throws: a version that cannot be read is said as unknown.
function installedVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
    ) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : '(version unknown)';
  } catch {
    return '(version unknown)';
  }
}

// Every check runs against one shared corpus + config + delta, in a fixed
// order (RuleId's own declaration order in types.ts) so a scan's finding
// list has a stable ordering that does not depend on which check happened
// to be fastest.
const CHECKS: Check[] = [
  existenceCheck,
  typosquatCheck,
  pythonTyposquatCheck,
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
  // True when this change makes a path under an ignorePaths entry a
  // project the trust base does not install that way (0.16.0); those paths,
  // sorted and uncapped. The proposals carry at most ten of them.
  projectPathsChanged: boolean;
  ignoredPathsMadeProjects: string[];
}

export interface ScanResult {
  findings: Finding[]; // baseline-suppressed and ignorePaths-dropped findings excluded
  suppressed: number; // count removed by the baseline, specifically (not ignorePaths)
  ignored: number; // count removed by config.ignorePaths, specifically (not the baseline)
  // Findings an ignorePaths entry matched and did not drop, because the
  // change makes their path a project the reference side does not install
  // that way, or because they are lockfile-tamper findings on a project the
  // reference side installs (0.16.0). Present at zero on every run.
  ignoreKept: number;
  // True when the run had a reference side, so that rule applied: --base,
  // --trust-base, or --staged with a committed HEAD. False on an audit, a
  // staged run with no HEAD and no trust base, and check. Optional in the
  // type only so a result built by hand need not carry it; scan() and
  // check always set it.
  ignoreRuleApplied?: boolean;
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
    // Per ecosystem: how many new names were checked and how, and how many
    // were read but not checked and why (ecosystems.ts). Always present;
    // additive under the stability policy.
    ecosystems: EcosystemsSummary;
    // Set when this run scanned and still could not stand behind a clean
    // verdict: today only online-names-unchecked, a --base or --trust-base
    // run that left a candidate name unchecked online. The report is built
    // in full and the exit is 2. Absent otherwise.
    couldNotRun?: { code: string; message: string };
  };
  // 0 or 1 from the gate; 2 only for run.couldNotRun. Every other
  // could-not-run throws before a result exists.
  exitCode: 0 | 1 | 2;
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

// normalizeIgnorePattern and matchingIgnoreEntries live in ignore-paths.ts,
// shared with the name-candidate step.

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
  npmrcDefaultRegistry: string | null,
  npmrcChanged: boolean,
  pythonIndex: PythonIndexRule | null = null
): { findings: Omit<Finding, 'fingerprint'>[]; ctx: CheckContext } {
  const ctx: CheckContext = {
    corpus,
    config,
    delta,
    npmrcRegistryPins,
    npmrcDefaultRegistry,
    npmrcChanged,
    ...(pythonIndex === null ? {} : { pythonIndex }),
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
// cacheHits (issue #80) counts the other outcome of the same name lookups:
// the ones the on-disk cache answered, so nothing was sent to the registry.
// A cached fetch counts each name it is asked about in exactly one of the
// two. lookupsAttempted 0 with cacheHits above 0 is a warm cache; 0 and 0 is
// a run with nothing to look up.
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

// The five online steps, in the order the run's one wall-clock budget is
// spent on them. The order is a priority decision, not an accident:
//
//  1. npm unknown-package resolution, because it is the only step that can
//     stand a blocking false positive down (to low), and the only one
//     whose absence gets steadily worse as a release ages away from its
//     corpus walk. It looks up only corpus misses, usually a handful.
//  2. PyPI existence, which adds a critical for a Python name PyPI answers
//     404 for. It is the only existence check Python names have at all,
//     offline or online, while an npm name has already been judged offline
//     by the corpus and the popularity list before step 3 runs.
//  3. typosquat popularity asymmetry, which escalates an existing low.
//  4. registered-squat, which adds a new medium.
//  5. publish-age, which adds a new high.
//
// Steps 3 to 5 are not mere refinements: each adds or escalates a signal
// that does not exist offline. So putting PyPI second is a trade between
// two online-only signals, and the cost is stated: on a tight budget an
// npm registered-squat or publish-age finding can be lost to PyPI lookups,
// and those steps' online-deadline-exceeded diagnostics say so. A budget
// spent before step 2 would leave every Python name with no existence
// answer at all, whereas one spent before step 3 leaves npm names with
// their offline verdict. Step 1 stays first because its absence leaves a
// user holding a blocking finding they cannot clear.
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

// PyPI existence, asked live for the same reasons as liveFetchPackument
// above, and never cached at all: there is no PyPI cache entry in 0.13.0,
// read or written (docs/INVARIANTS.md). Any later one uses a
// "pypi:<kind>:<normalised>" key, so it cannot collide with the unprefixed
// npm keys (downloads:, created:, version-times:), which are npm keys.
async function liveFetchPypiProject(name: string, lookups: LookupCounter) {
  lookups.attempted += 1;
  return fetchPypiProject(name, { backoffCapMs: SCAN_BACKOFF_CAP_MS });
}

// The run-level facts scan.ts's JSON `online` field reports (issue #75).
// enrichOnline builds one of these per call; a disabled run (online never
// turned on) gets the all-zero, enabled:false shape directly from scan()
// and checkSingle() instead, so the field is present either way -- see
// buildResult.
export interface OnlineRunSummary {
  enabled: boolean;
  budgetMs: number;
  // Package NAMES for which a real registry or downloads lookup was
  // actually issued, summed across all four online steps -- see
  // LookupCounter's own doc comment above for why this counts names, never
  // wrapper calls or raw HTTP requests: a single batched downloads call can
  // carry many names in one request, and this field has to stay in the same
  // unit as lookupsSkippedByDeadline for the two to be addable. Counted once
  // per lookup, never per distinct name: one step can count a name twice
  // (registered-squat looks up its downloads and then its creation date),
  // and every other step that looks it up counts it again.
  lookupsAttempted: number;
  // Name lookups answered from the on-disk cache, so nothing was sent to
  // the registry (issue #80). Same unit and same once-per-lookup counting
  // as lookupsAttempted.
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
  // Candidate names an online step left unchecked, with the step and the
  // reason (online/unchecked.ts), uncapped and sorted. Present, at count
  // zero too, whenever online lookups are on, and on a pull-request run
  // whose governing config requires them while the command line turned
  // them off (every candidate then has the reason online-disabled).
  unchecked?: { count: number; names: UncheckedName[] };
}

const ONLINE_DISABLED_SUMMARY: OnlineRunSummary = {
  enabled: false,
  budgetMs: 0,
  lookupsAttempted: 0,
  cacheHits: 0,
  lookupsSkippedByDeadline: 0,
  deadlineExceeded: false,
};

async function enrichOnline(
  rawFindings: Omit<Finding, 'fingerprint'>[],
  ctx: CheckContext,
  budgetMs: number
): Promise<{
  findings: Omit<Finding, 'fingerprint'>[];
  summary: OnlineRunSummary;
  pypiStats: PypiExistenceStats;
  unchecked: UncheckedName[];
}> {
  const deadline = createOnlineDeadline(budgetMs);
  // Threaded through every real fetch below rather than kept at module
  // scope: see LookupCounter's own comment for why a fresh one per call is
  // what keeps two scans in one process from mixing counts.
  const lookups: LookupCounter = { attempted: 0, cacheHits: 0 };
  // Every step returns the names it could not check, with the reason,
  // instead of only a count read back from its diagnostics.
  const unchecked: UncheckedName[] = [];
  const sink: UncheckedSink = (entry) => {
    unchecked.push(entry);
  };

  const resolvedNpm = await resolveUnknownPackages(
    rawFindings,
    ctx,
    { fetchPackument: (name) => liveFetchPackument(name, lookups) },
    ctx.diagnostics,
    deadline,
    sink
  );

  // 2. PyPI existence. Appends findings only; never removes or lowers one.
  const pypi = await checkPypiExistence(
    newNames(ctx).pypi,
    ctx,
    ctx.pythonIndex ?? null,
    { fetchPypiProject: (name) => liveFetchPypiProject(name, lookups) },
    ctx.diagnostics,
    deadline,
    sink
  );
  const resolved = [...resolvedNpm, ...pypi.findings];

  // applyTyposquatAsymmetry issues one bulk request and has no per-name
  // loop, so it is gated here rather than internally: there is exactly one
  // point at which it could stop, and that point is before it starts. The
  // count here is the low typosquat findings before the check's own
  // internal-name and private-origin filters run, so on an expired deadline
  // it can overstate how many lookups were skipped, never understate; no
  // name is emitted with it.
  const asymmetryCandidates = resolved.filter(
    (f) => f.ruleId === 'typosquat' && f.severity === 'low' && f.details?.ecosystem !== 'pypi'
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
    // The names, filtered the way the step filters them, so a spent budget
    // here is named like any other step's.
    for (const name of asymmetryCandidateNames(resolved, ctx)) {
      sink({ name, ecosystem: 'npm', step: 'asymmetry', reason: 'budget' });
    }
  } else {
    await applyTyposquatAsymmetry(
      resolved,
      ctx,
      { fetchWeeklyDownloads: (names) => cachedFetchWeeklyDownloads(names, lookups) },
      ctx.diagnostics,
      sink
    );
  }

  const registeredSquats = await findRegisteredSquats(
    ctx,
    {
      fetchWeeklyDownloads: (names) => cachedFetchWeeklyDownloads(names, lookups),
      fetchPackument: (name) => cachedFetchPackument(name, lookups),
    },
    ctx.diagnostics,
    deadline,
    undefined,
    sink
  );

  // 5. publish-age, added last among the npm steps: it only ever ADDS a new
  // finding, and nothing orders it against registered-squat (step 4).
  const publishAgeFindings = await findPublishAgeFindings(
    ctx,
    { fetchPackument: (name, versions) => cachedFetchPackumentVersionTimes(name, versions, lookups) },
    ctx.diagnostics,
    deadline,
    undefined,
    sink
  );
  return {
    findings: [...resolved, ...registeredSquats, ...publishAgeFindings],
    summary: {
      enabled: true,
      budgetMs,
      lookupsAttempted: lookups.attempted,
      cacheHits: lookups.cacheHits,
      // Read back out of ctx.diagnostics rather than kept as a second,
      // independently-incremented count: see sumDeadlineSkipped's own
      // comment for why this is the number a human reading the same
      // diagnostics would also compute.
      lookupsSkippedByDeadline: sumDeadlineSkipped(ctx.diagnostics),
      deadlineExceeded: deadline.expired(),
    },
    pypiStats: pypi.stats,
    unchecked,
  };
}

// Every candidate the online steps would look up, each with the reason
// online-disabled: the run's governing config requires online lookups and
// the command line turned them off. Enumerated by the steps themselves,
// over copies, against a budget that is already spent, so no request is
// made and the list is exactly the set a run with online on would have
// queued. Nothing the steps write to the copies reaches the result.
async function onlineDisabledCandidates(
  rawFindings: readonly Omit<Finding, 'fingerprint'>[],
  ctx: CheckContext
): Promise<UncheckedName[]> {
  const copy: CheckContext = { ...ctx, diagnostics: [], allowed: [] };
  const enriched = await enrichOnline(structuredClone([...rawFindings]), copy, 0);
  return enriched.unchecked.map(({ name, ecosystem, step }) => ({ name, ecosystem, step, reason: 'online-disabled' }));
}

// Not candidates, never counted: a name an allow entry clears, a name
// exempted as workspace-local, and a name internalPrefixes or an internal
// scope keeps off the wire. The steps already skip workspace-local names
// (per lockfile directory, which a run-wide filter here would widen),
// internal names, and names from a private registry or index. PyPI looks a
// name up before asking allow, so allowed names are filtered here,
// afterwards, without recording a clearance; internal names again, since
// "the step already skipped it" is a second-hand claim.
function countableUnchecked(entries: readonly UncheckedName[], ctx: CheckContext): UncheckedName[] {
  return settleUnchecked(
    entries.filter((entry) =>
      entry.ecosystem === 'pypi'
        ? !isPypiAllowed(entry.name, ctx.config.allow) && !isPypiInternalName(entry.name, ctx.config.internalPrefixes)
        : !isAllowed(entry.name, ctx.config.allow) &&
          !isInternalName(entry.name, ctx.config.internalScopes, ctx.config.internalPrefixes)
    )
  );
}

interface RunInfo {
  mode: 'staged' | 'base' | 'audit';
  lockfileFormat: string;
  corpusBuiltAt: string;
  diagnostics: Diagnostic[];
  startedAt: number;
  online: OnlineRunSummary;
  ecosystems: EcosystemsSummary;
  couldNotRun?: { code: string; message: string } | null;
}

// Audit B2 (design note section 8): on a --base or --trust-base run, a
// candidate name an online step left unchecked is a could-not-run, exit 2,
// with the full report, unless the governing config (the trust base's on
// a --trust-base run) sets "onlineUnchecked": "note". Only a definitive
// "exists" or a 404 is a checked name. When that config says "online":
// true and the command line turned online off, every candidate counts as
// unchecked with the reason online-disabled. Plain and audit runs keep the
// diagnostics only, and report the names.
async function settleOnlineUnchecked(args: {
  enriched: UncheckedName[] | null;
  rawFindings: readonly Omit<Finding, 'fingerprint'>[];
  ctx: CheckContext;
  config: ResolvedConfig;
  cliOnline: boolean | undefined;
  isPullRequestRun: boolean;
  online: OnlineRunSummary;
}): Promise<{ online: OnlineRunSummary; couldNotRun: { code: string; message: string } | null }> {
  let entries: UncheckedName[] | null = args.enriched;
  if (entries === null && args.isPullRequestRun && args.config.online && args.cliOnline === false) {
    entries = await onlineDisabledCandidates(args.rawFindings, args.ctx);
  }
  if (entries === null) {
    return { online: args.online, couldNotRun: null };
  }
  const names = countableUnchecked(entries, args.ctx);
  const online = { ...args.online, unchecked: { count: names.length, names } };
  const fails = args.isPullRequestRun && names.length > 0 && (args.config.onlineUnchecked ?? 'fail') !== 'note';
  return {
    online,
    couldNotRun: fails ? { code: ONLINE_NAMES_UNCHECKED, message: uncheckedMessage(names) } : null,
  };
}

// checkSingle's manifestPath is fabricated (SYNTHETIC_MANIFEST_PATH
// below) -- there is no real file behind the propose-time question -- so
// neither ignorePaths nor the baseline, both keyed off that path (directly,
// or via the fingerprint), are meaningful filters for it. Applying them
// would let a repo's config for a completely unrelated location silently
// launder "is this name safe" into "clean". scan()'s real findings, with
// real manifestPath values, get both filters; checkSingle's synthetic ones
// get neither.
// ignorePaths cannot cover a path the change wires into the install
// (0.16.0, docs/design/2026-10-18-head-defined-projects-and-ignore-paths.md).
// On a run with a reference side, an entry drops a finding only when its
// anchor is not a project on the judged side, or when every reason the
// judged side records for the anchor is also recorded on the reference
// side. Otherwise the finding is kept and the path reported. The reference
// side is the trust base on a --trust-base run, with or without --base, and
// only the trust base; without --trust-base it is the --base ref, or HEAD
// for --staged. An audit, and a staged run with no committed HEAD and no
// trust base, have none, and drop exactly as before.
export interface PathFilterSides {
  judged: ProjectClassification | undefined;
  reference: ProjectClassification | null;
  referenceLabel: string;
  prefix: string;
  audit: boolean;
  // Whether the judged side's lockfile at this path records an entry under
  // this name. Absent: every lockfilePath counts.
  lockfileRecords?: (lockfilePath: string, packageName: string) => boolean;
}

export interface IgnoredPathMadeProject {
  path: string;
  entries: string[];
  position: string;
  kept: number;
  // Every reason missing from the reference side is a symlink that could
  // not be followed (the message then says the path counts as a project).
  unfollowed: boolean;
}

export interface PathFilterResult {
  findings: Finding[];
  suppressed: number;
  ignored: number;
  ignoreKept: number;
  madeProjects: IgnoredPathMadeProject[];
  // Whether the run had a reference side, so the rule above applied.
  applied: boolean;
}

const NO_REFERENCE: PathFilterSides = {
  judged: undefined,
  reference: null,
  referenceLabel: '',
  prefix: '',
  audit: true,
};

const MAX_LISTED_IGNORE_PATHS = 10;

function underScanPrefix(relPath: string, prefix: string): boolean {
  return prefix === '' || relPath === prefix || relPath.startsWith(`${prefix}/`);
}

// The project manifest a finding is about: its manifestPath, or, when that
// names a lockfile, the manifest in the lockfile's directory.
function anchorOf(manifestPath: string): string {
  return projectManifestForLockfile(manifestPath) ?? manifestPath;
}

function judgedReasonsOf(projects: ProjectClassification, relPath: string): readonly ProjectReason[] {
  return projects.reasons.get(relPath) ?? [];
}

// The judged reasons for a path that the reference side does not record,
// read one path at a time. A reference side with an input outside the
// prefix it could not read excuses nothing under the prefix: that
// expansion is never a reason.
function reasonsAbsentFromReference(
  sides: PathFilterSides,
  reference: ProjectClassification,
  reasons: readonly ProjectReason[],
  relPath: string
): ProjectReason[] {
  const excusesNothing =
    reference.unreadInputs.length > 0 && sides.prefix !== '' && underScanPrefix(relPath, sides.prefix);
  const known = excusesNothing
    ? new Set<string>()
    : new Set((reference.reasons.get(relPath) ?? []).map(projectReasonKey));
  return reasons.filter((reason) => !known.has(projectReasonKey(reason)));
}

// The manifest a reason depends on: the file that names the path for a
// reference, an include or a uv member; the package.json of the install
// root for a workspace member or a link entry. Null for the root and for a
// manifest beside a lockfile, which depend on nothing but themselves.
function reasonSource(reason: ProjectReason): string | null {
  switch (reason.rule) {
    case 'root':
    case 'beside-lockfile':
      return null;
    case 'reference-target':
    case 'requirements-include':
    case 'uv-member':
      return reason.input;
    case 'root-member':
    case 'install-root-member':
    case 'link-target':
      return reason.root === '' ? 'package.json' : `${reason.root}/package.json`;
  }
}

// Reasons are transitive: a judged reason counts as present on the
// reference side only when the manifest it comes from is itself excused,
// or is not a project on the judged side at all (it installs nothing).
// Otherwise a base stray "fixtures/a" referencing "fixtures/b" records b's
// reason on the base too, and a change that wires only "fixtures/a" into
// the install would excuse b. Excused is the greatest fixed point: every
// judged project whose reasons all appear on the reference side, less any
// whose reason's source is not excused, repeated until nothing changes.
// Each pass removes a path or stops, so one pass per path bounds it; a run
// that did not settle within that excuses nothing.
const excusedCache = new WeakMap<PathFilterSides, ReadonlySet<string>>();

function excusedProjects(sides: PathFilterSides, judged: ProjectClassification): ReadonlySet<string> {
  const cached = excusedCache.get(sides);
  if (cached !== undefined) {
    return cached;
  }
  const reference = sides.reference;
  const excused = new Set<string>();
  if (reference !== null) {
    for (const [relPath, reasons] of judged.reasons) {
      if (reasons.length > 0 && reasonsAbsentFromReference(sides, reference, reasons, relPath).length === 0) {
        excused.add(relPath);
      }
    }
  }
  let settled = false;
  for (let pass = 0; pass <= judged.reasons.size && !settled; pass += 1) {
    settled = true;
    for (const relPath of [...excused]) {
      if (judgedReasonsOf(judged, relPath).some((reason) => !sourceExcused(judged, excused, reason, relPath))) {
        excused.delete(relPath);
        settled = false;
      }
    }
  }
  const result: ReadonlySet<string> = settled ? excused : new Set<string>();
  excusedCache.set(sides, result);
  return result;
}

function sourceExcused(
  judged: ProjectClassification,
  excused: ReadonlySet<string>,
  reason: ProjectReason,
  relPath: string
): boolean {
  const source = reasonSource(reason);
  return source === null || source === relPath || judgedReasonsOf(judged, source).length === 0 || excused.has(source);
}

// The reasons the judged side records for a path that the reference side
// does not, counting a reason whose source manifest is not excused as not
// recorded there (transitive, see excusedProjects).
function reasonsMissingFromReference(
  sides: PathFilterSides,
  judged: ProjectClassification,
  relPath: string,
  exclude: (reason: ProjectReason) => boolean = () => false
): ProjectReason[] {
  const reference = sides.reference;
  const own = judgedReasonsOf(judged, relPath).filter((reason) => !exclude(reason));
  if (reference === null) {
    return [];
  }
  const absent = new Set(reasonsAbsentFromReference(sides, reference, own, relPath));
  const excused = excusedProjects(sides, judged);
  return own.filter((reason) => absent.has(reason) || !sourceExcused(judged, excused, reason, relPath));
}

function positionTextOf(reasons: readonly ProjectReason[]): string {
  return [...new Set(reasons.map(projectReasonText))].join('; ');
}

// Whether every one of these reasons is a symlink that could not be
// followed: the change did not then make the path a project in any way
// this tool can show, so the message says the path counts as one.
function onlyUnfollowedLinks(reasons: readonly ProjectReason[]): boolean {
  return reasons.length > 0 && reasons.every((reason) => reason.link?.followed === false);
}

function listIgnorePaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED_IGNORE_PATHS);
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

// The trust-base proposals for ignored paths a change makes projects: one
// line per path, at most ten, then one count line, so the umbrella's
// summed proposal count stays bounded. The JSON list is uncapped.
function ignoredPathProposals(madeProjects: readonly IgnoredPathMadeProject[]): string[] {
  const lines = madeProjects
    .slice(0, MAX_LISTED_IGNORE_PATHS)
    .map((made) =>
      made.unfollowed
        ? `ignorePaths: ignored path ${made.path} counts as a project (${made.position}); its findings are kept`
        : `ignorePaths: this change makes ignored path ${made.path} a project (${made.position}); its findings are kept`
    );
  const rest = madeProjects.length - lines.length;
  if (rest > 0) {
    lines.push(`ignorePaths: and ${rest} more ignored paths this change makes projects; their findings are kept`);
  }
  return lines;
}

// The name rules both walks raise for one package.
const NAME_RULES: ReadonlySet<string> = new Set(['typosquat', 'unknown-package', 'registered-squat']);

// Which lockfile-anchored name findings repeat a manifest finding: same
// rule, same package, and the manifest is one that lockfile records. A
// lockfile name finding is anchored on its lockfile (manifestPath is the
// lockfile's path).
function mergeLockfileNameFindings(
  raws: readonly Omit<Finding, 'fingerprint'>[],
  manifestLockfile: (manifestPath: string) => string | undefined
): {
  dropped: Set<Omit<Finding, 'fingerprint'>>;
  lockfileOf: Map<Omit<Finding, 'fingerprint'>, Omit<Finding, 'fingerprint'>>;
} {
  const dropped = new Set<Omit<Finding, 'fingerprint'>>();
  const lockfileOf = new Map<Omit<Finding, 'fingerprint'>, Omit<Finding, 'fingerprint'>>();
  const manifestFindings = new Map<string, Omit<Finding, 'fingerprint'>>();
  for (const raw of raws) {
    const lockfile = NAME_RULES.has(raw.ruleId) ? manifestLockfile(raw.manifestPath) : undefined;
    if (lockfile === undefined || lockfile === raw.manifestPath) {
      continue;
    }
    const key = JSON.stringify([raw.ruleId, raw.packageName, lockfile]);
    if (!manifestFindings.has(key)) {
      manifestFindings.set(key, raw);
    }
  }
  for (const raw of raws) {
    if (!NAME_RULES.has(raw.ruleId)) {
      continue;
    }
    const manifestFinding = manifestFindings.get(JSON.stringify([raw.ruleId, raw.packageName, raw.manifestPath]));
    if (manifestFinding === undefined) {
      continue;
    }
    dropped.add(raw);
    lockfileOf.set(manifestFinding, raw);
  }
  return { dropped, lockfileOf };
}

export function applyPathFilters(
  rawFindings: Omit<Finding, 'fingerprint'>[],
  config: Pick<ResolvedConfig, 'ignorePaths'>,
  baseline: Set<string>,
  diagnostics: Diagnostic[],
  alreadyMatched: ReadonlySet<string> = new Set(),
  sides: PathFilterSides = NO_REFERENCE,
  manifestLockfile: (manifestPath: string) => string | undefined = () => undefined
): PathFilterResult {
  const findings: Finding[] = [];
  const survivors: Array<{
    raw: Omit<Finding, 'fingerprint'>;
    keep: { position: string } | null;
    matches: string[];
  }> = [];
  let suppressed = 0;
  let ignored = 0;
  let ignoreKept = 0;
  const matchedEntries = new Set<string>(alreadyMatched);
  let droppedSeverity: Severity | null = null;
  const droppedOnProjects = new Set<string>();
  let droppedOnProjectsCount = 0;
  const keptByAnchor = new Map<string, number>();

  const judged = sides.judged;
  if (sides.reference !== null && judged === undefined) {
    // Never read as "nothing is kept": a judged side with no classification
    // would silently restore the drop this rule exists to stop.
    throw new DepGuardError(
      'internal error: the judged side reached the ignorePaths filter without its project classification',
      'internal-error'
    );
  }
  const isJudgedProject = (relPath: string): boolean =>
    judged !== undefined && judgedReasonsOf(judged, relPath).length > 0;

  for (const raw of rawFindings) {
    let matchPath = raw.manifestPath;
    let anchor = anchorOf(matchPath);
    // A stray that declares a root-lockfile name cannot pull that lockfile's
    // finding into an ignored directory: when the manifest is not a project,
    // ignorePaths is matched against the lockfile the finding is about.
    // Only a finding about an entry that lockfile records: tamper.ts
    // stamps the delta's primary lockfile on every finding it raises,
    // including one about a stray's own specifier or a requirements line,
    // and those are facts about the manifest, dropped as before.
    if (
      sides.reference !== null &&
      !isJudgedProject(anchor) &&
      raw.lockfilePath !== undefined &&
      (sides.lockfileRecords?.(raw.lockfilePath, raw.packageName) ?? true)
    ) {
      matchPath = raw.lockfilePath;
      anchor = anchorOf(matchPath);
    }
    const matches = matchingIgnoreEntries(matchPath, config.ignorePaths);
    let keep: { position: string } | null = null;
    if (matches.length > 0) {
      for (const matched of matches) {
        matchedEntries.add(matched);
      }
      if (sides.reference !== null && judged !== undefined && isJudgedProject(anchor)) {
        const missing = reasonsMissingFromReference(sides, judged, anchor);
        if (missing.length > 0) {
          keep = { position: positionTextOf(missing) };
          keptByAnchor.set(anchor, (keptByAnchor.get(anchor) ?? 0) + 1);
        } else if (raw.ruleId === 'lockfile-tamper') {
          // allow never covers lockfile-tamper either (checks/allow.ts).
          keep = { position: positionTextOf(judgedReasonsOf(judged, anchor)) };
        }
      }
      if (keep === null) {
        ignored += 1;
        if (droppedSeverity === null || severityAtLeast(raw.severity, droppedSeverity)) {
          droppedSeverity = raw.severity;
        }
        const installedOn = sides.reference ?? judged ?? null;
        if (installedOn !== null && (installedOn.reasons.get(anchor) ?? []).length > 0) {
          droppedOnProjects.add(anchor);
          droppedOnProjectsCount += 1;
        }
        continue;
      }
      ignoreKept += 1;
    }
    // The baseline, before the merge below (lockfilePath is not part of a
    // fingerprint, so merging cannot move one).
    if (baseline.has(fingerprintFinding(raw))) {
      suppressed += 1;
      continue;
    }
    survivors.push({ raw, keep, matches });
  }

  // One package, one rule, one lockfile: a name a manifest line and a
  // lockfile entry both carry is checked twice (checks/candidates.ts,
  // lockEntryNames, exempts nothing), and reported once. Only over what
  // survived ignorePaths AND the baseline: a manifest finding either one
  // dropped never takes the lockfile's with it (re-review RB1: a baselined
  // stray line swallowed a new nested install). The kept finding is the
  // manifest's, with the lockfile added as its second anchor.
  const mergedInto = mergeLockfileNameFindings(
    survivors.map((survivor) => survivor.raw),
    manifestLockfile
  );
  for (const { raw: survivorRaw, keep, matches } of survivors) {
    if (mergedInto.dropped.has(survivorRaw)) {
      continue;
    }
    // The merged finding names the lockfile finding's own fingerprint, so a
    // reader who baselines what this run shows can baseline both at once:
    // each is suppressed only by its own entry.
    const lockfileFinding = mergedInto.lockfileOf.get(survivorRaw);
    const raw =
      lockfileFinding === undefined
        ? survivorRaw
        : {
            ...survivorRaw,
            lockfilePath: lockfileFinding.manifestPath,
            details: { ...survivorRaw.details, lockfileFingerprint: fingerprintFinding(lockfileFinding) },
          };
    const fingerprint = fingerprintFinding(raw);
    findings.push(
      keep === null ? { ...raw, fingerprint } : { ...raw, fingerprint, ignoreOverride: { entries: matches, position: keep.position } }
    );
  }

  // R2: every path under an ignorePaths entry that this change makes a
  // project the reference side does not install that way, whether or not a
  // finding was kept there, since the change to the control is the point.
  const madeProjects: IgnoredPathMadeProject[] = [];
  if (sides.reference !== null && judged !== undefined) {
    for (const relPath of [...judged.reasons.keys()].sort()) {
      if (!underScanPrefix(relPath, sides.prefix)) {
        continue;
      }
      const entries = matchingIgnoreEntries(relPath, config.ignorePaths);
      if (entries.length === 0) {
        continue;
      }
      const missing = reasonsMissingFromReference(sides, judged, relPath);
      if (missing.length === 0) {
        continue;
      }
      for (const matched of entries) {
        matchedEntries.add(matched);
      }
      madeProjects.push({
        path: relPath,
        entries,
        position: positionTextOf(missing),
        kept: keptByAnchor.get(relPath) ?? 0,
        unfollowed: onlyUnfollowedLinks(missing),
      });
    }
    for (const made of madeProjects) {
      const covered =
        `${made.path}: covered by ignorePaths ${made.entries.length === 1 ? 'entry' : 'entries'} ` +
        `${made.entries.map((entry) => `"${entry}"`).join(', ')}, `;
      diagnostics.push({
        code: 'ignore-path-project-kept',
        message: made.unfollowed
          ? `${covered}but it counts as a project here (${made.position}) and ${sides.referenceLabel} does not ` +
            `record that reason for it; ${made.kept} finding(s) kept`
          : `${covered}but this change makes it a project (${made.position}) and ${sides.referenceLabel} does not ` +
            `install it that way; ${made.kept} finding(s) kept`,
      });
    }
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
  //
  // A finding dropped on a path that is a project anyway (on the reference
  // side, or on an audit on the judged side) is the adopter's standing
  // choice, made on the base: said, never an exit change.
  if (droppedSeverity !== null) {
    const installed =
      droppedOnProjectsCount > 0
        ? `; ${droppedOnProjectsCount} of them on installed projects (${listIgnorePaths([...droppedOnProjects].sort())})`
        : '';
    diagnostics.push({
      code: 'ignore-path-dropped',
      message: `ignorePaths dropped ${ignored} finding(s) before the gate, the most severe of them ${droppedSeverity}${installed}`,
    });
  }

  return { findings, suppressed, ignored, ignoreKept, madeProjects, applied: sides.reference !== null };
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
  controls: TrustedControls | null,
  ignoreRule: { ignoreKept: number; madeProjects: readonly IgnoredPathMadeProject[]; applied: boolean } = {
    ignoreKept: 0,
    madeProjects: [],
    applied: false,
  }
): ScanResult {
  const { blockingMatches, exitCode } = evaluateGate(findings, config.failOn);
  const distinctAllowed = [...new Set(allowedNames)].sort();

  return {
    findings,
    suppressed,
    ignored,
    ignoreKept: ignoreRule.ignoreKept,
    ignoreRuleApplied: ignoreRule.applied,
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
            projectPathsChanged: ignoreRule.madeProjects.length > 0,
            ignoredPathsMadeProjects: ignoreRule.madeProjects.map((made) => made.path),
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
      ecosystems: info.ecosystems,
      ...(info.couldNotRun === undefined || info.couldNotRun === null ? {} : { couldNotRun: info.couldNotRun }),
    },
    // evaluateGate stays 0 or 1; the one could-not-run that reaches a
    // built result widens the exit here.
    exitCode: info.couldNotRun === undefined || info.couldNotRun === null ? exitCode : 2,
  };
}

// The full pipeline: loadConfig -> loadCorpus -> loadStates -> computeDelta
// -> run all six checks -> fingerprint -> ignorePaths/baseline filter ->
// evaluateGate.
function sideResolvedSomething(state: RepoState): boolean {
  if (state.manifests.length > 0) {
    return true;
  }
  if (state.lockfile !== null && isReadLockfile(state.lockfile)) {
    return true;
  }
  return (state.extraLockfiles ?? []).some(isReadLockfile);
}

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
  // Manifests under this prefix are the scan. Empty when the named path
  // is the git root. Config and the baseline stay on `root` either way.
  const prefix = await relativeScanPrefix(opts.repoRoot, root);
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
  const isIgnoredPath = (repoPath: string): boolean =>
    matchingIgnoreEntries(repoPath, config.ignorePaths).length > 0;
  const statePair = await loadStates(opts.repoRoot, opts.mode, { isIgnoredPath });

  // Ported from a sibling scanner's whole-tree "examined zero files is
  // could-not-run" invariant, adapted to dep-guard's own unit of work: a
  // manifest, not a file. statePair.after is the side under judgment in
  // every mode (the working tree for audit/base, the index for staged), so
  // nothing resolved on it is the dep-guard analogue of a walk that
  // opened nothing. A parsed manifest counts even when it declares no
  // dependencies (a pyproject.toml that holds only [tool.*] config), and a
  // read npm or pnpm lockfile counts on its own. That zero-dependency
  // manifest must not, by itself, turn a scan that resolved something
  // else into could-not-run.
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
  if (opts.mode.kind !== 'staged' && !sideResolvedSomething(statePair.after)) {
    const manifestOnDisk = await probeManifestOnDisk(root, prefix);
    if (manifestOnDisk) {
      throw new DepGuardError(
        'found a manifest on disk but resolved none; the scan root may be wrong. In CI ' +
          'this is a could-not-run, not a clean pass. Check that the action runs at the ' +
          'repository root. Or this dep-guard may be out of date: the file may be in a ' +
          `format that a newer dep-guard reads and dep-guard ${installedVersion()} does not.`,
        'manifests-unresolved'
      );
    }
  }

  // ignorePaths comes from the same effective config as the findings
  // filter below: the trust base's on a --trust-base run.
  // An entry that covers only a lockfile below the root did match
  // something, so it must not be reported as unmatched later.
  const lockfileIgnoreMatches = new Set<string>();
  // So did an entry whose only effect was to drop a manifest that does not
  // parse (manifest-unparsed), on the judged or the comparison side: it is
  // the one way to clear a broken fixture, and reporting it as a no-op
  // would tell the reader to delete it.
  for (const side of [statePair.after, statePair.before]) {
    for (const dropped of side?.notParsed ?? []) {
      for (const matched of matchingIgnoreEntries(dropped, config.ignorePaths)) {
        lockfileIgnoreMatches.add(matched);
      }
    }
  }
  // The comparison sides for the lockfile downgrade rule. With --base, both
  // the --base side and the trust base, so a run cannot choose the weaker
  // one. With --trust-base alone, the trust base, while the run stays an
  // audit of findings. With --staged, HEAD only: comparing every commit on
  // a migration branch with the trust base would refuse each one of them.
  // When the trust base is the same tree as the --base side (the usual
  // pull-request shape), that side is reused rather than read twice.
  const trustState =
    controls === null || opts.mode.kind === 'staged'
      ? null
      : opts.mode.kind === 'base' &&
          statePair.before !== null &&
          (await refsNameSameTree(root, opts.mode.ref, controls.ref))
        ? statePair.before
        : await loadRefState(root, controls.ref, statePair.diagnostics, prefix, isIgnoredPath);
  // Which npm workspace siblings are exempt from the name checks is decided
  // against each install root's "workspaces" field, and on a pull-request
  // run that field comes from the trust base wherever the base has it, so
  // the pull request cannot widen it to confirm a link it adds itself
  // (confirmWorkspaceLocalNames in git-source.ts).
  if (trustState !== null && controls !== null) {
    statePair.after = reconfirmWorkspaceLocalNames(
      statePair.after,
      trustState,
      `the trust base "${controls.ref}"`,
      statePair.diagnostics
    );
  }
  // Python index declarations and uv workspace members are control inputs
  // (python-trust.ts): on a pull-request run they come from the trust base
  // copy of each judged Python file, and a head-side change to them is a
  // proposal that does not take effect. [tool.uv.sources] entries are then
  // applied within their scope, before the delta is computed, so a git or
  // url rewrite reaches the tamper check and a confirmed path or workspace
  // source leaves the name checks.
  let pythonControls = judgedPythonControls(statePair.after.manifests);
  if (controls !== null) {
    const loaded = await loadPythonControls(
      root,
      controls.ref,
      `the trust base "${controls.ref}"`,
      statePair.after.manifests
    );
    pythonControls = loaded.controls;
    statePair.diagnostics.push(...loaded.diagnostics);
    if (loaded.proposal !== null) {
      controls.proposals.push(loaded.proposal);
    }
  }
  applyUvSources(
    statePair.after.manifests,
    pythonControls,
    statePair.diagnostics,
    new Set(statePair.after.pythonArchiveFiles ?? [])
  );
  // Every comparison side gets the same rewrite, by its own sources and
  // members, so a dependency whose git or url source did not move is the
  // same dependency on both sides. Applied to the judged side only, an
  // untouched git-sourced name read as moved from pypi to git and raised a
  // tamper critical on every pull request. Its notes are dropped: what a
  // comparison side's own scope says is not news about this change.
  for (const side of new Set([statePair.before, trustState])) {
    if (side !== null && side !== statePair.after) {
      applyUvSources(side.manifests, judgedPythonControls(side.manifests), [], new Set(side.pythonArchiveFiles ?? []));
    }
  }
  const pythonIndex = new PythonIndexRule(statePair.after.manifests, pythonControls);
  // The reference side of the ignorePaths rule (applyPathFilters): the
  // trust base on a --trust-base run, and only the trust base, even with
  // --staged, where trustState is null for the lockfile rules and the trust
  // base is classified on its own, by a load that never throws. Without
  // --trust-base it is the comparison side the run already has. A side
  // loaded without a classification excuses nothing.
  const referenceProjects: ProjectClassification | null =
    controls !== null
      ? trustState !== null
        ? trustState.projects ?? EMPTY_PROJECTS
        : await loadRefProjects(root, controls.ref, prefix, isIgnoredPath)
      : opts.mode.kind === 'audit' || statePair.before === null
        ? null
        : statePair.before.projects ?? EMPTY_PROJECTS;
  const pathFilterSides: PathFilterSides = {
    judged: statePair.after.projects,
    reference: referenceProjects,
    referenceLabel:
      controls !== null
        ? `the trust base "${controls.ref}"`
        : opts.mode.kind === 'base'
          ? `the --base ref "${opts.mode.ref}"`
          : 'HEAD',
    prefix,
    audit: opts.mode.kind === 'audit',
    lockfileRecords: (lockfilePath, packageName) =>
      [...(statePair.after.lockfile === null ? [] : [statePair.after.lockfile]), ...(statePair.after.extraLockfiles ?? [])]
        .filter((lockfile) => lockfile.path === lockfilePath)
        .some((lockfile) => lockfile.entries.has(packageName)),
  };
  // A changed nested lockfile this tool does not read is excused by
  // ignorePaths only when the rule above would drop a finding anchored to
  // the manifest in its directory, without the reason that lockfile itself
  // gives (a manifest beside a lockfile): otherwise every new fixture
  // lockfile would make its own directory a project and be judged.
  const nestedWiring = new Map<string, string>();
  const nestedLockfileIgnored = (repoPath: string): boolean => {
    const matches = matchingIgnoreEntries(repoPath, config.ignorePaths);
    for (const matched of matches) {
      lockfileIgnoreMatches.add(matched);
    }
    if (matches.length === 0) {
      return false;
    }
    const judged = pathFilterSides.judged;
    if (pathFilterSides.reference === null || judged === undefined) {
      return true;
    }
    const anchor = projectManifestForLockfile(repoPath);
    if (anchor === null) {
      return true;
    }
    const missing = reasonsMissingFromReference(
      pathFilterSides,
      judged,
      anchor,
      (reason) => reason.rule === 'beside-lockfile' && reason.input === repoPath
    );
    if (missing.length === 0) {
      return true;
    }
    nestedWiring.set(repoPath, positionTextOf(missing));
    return false;
  };
  const deltaWith = (acknowledgedLockfiles: readonly string[]): DependencyDelta =>
    computeDelta(statePair.before, statePair.after, {
      extraComparisonSides: trustState === null ? [] : [trustState],
      acknowledgedLockfiles,
      acknowledgementSource:
        controls !== null ? 'trust-base' : opts.mode.kind === 'staged' ? 'head-commit' : 'base-ref',
      isIgnoredPath: nestedLockfileIgnored,
      ignoredPathWiring: (repoPath) => nestedWiring.get(repoPath) ?? null,
    });
  // Lockfile acknowledgements come from the comparison side's config, never
  // from the tree being judged: the trust base's when there is one;
  // otherwise the --base ref's, or HEAD's for a staged scan. Without a
  // trust base that config is read only once the downgrade rule has
  // actually refused, so a run the rule does not touch reads nothing new.
  let delta: DependencyDelta;
  if (controls !== null) {
    delta = deltaWith(controls.config.acknowledgedLockfiles ?? []);
  } else {
    try {
      delta = deltaWith([]);
    } catch (err) {
      if (!(err instanceof DepGuardError) || err.code !== 'lockfile-downgrade' || opts.mode.kind === 'audit') {
        throw err;
      }
      const ref = opts.mode.kind === 'base' ? opts.mode.ref : 'HEAD';
      const acknowledged = (await loadConfigAtRef(root, ref)).acknowledgedLockfiles ?? [];
      if (acknowledged.length === 0) {
        throw err;
      }
      delta = deltaWith(acknowledged);
    }
  }
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
    controls === null ? statePair.after.npmrcDefaultRegistry : controls.npmrcDefaultRegistry,
    // The judged side's .npmrc against every comparison side: the --base
    // or HEAD side by bytes, and the trust base by its own comparison.
    [statePair.before, trustState].some(
      (side) => side !== null && (side.npmrcContent ?? null) !== (statePair.after.npmrcContent ?? null)
    ) || (controls?.npmrcChanged ?? false),
    pythonIndex
  );
  // A --base or --trust-base run is the pull-request/CI shape (issue #75):
  // never a commit hook, so the online budget's default is minutes rather
  // than seconds when either is present. controls !== null is exactly
  // "opts.trustBase was given".
  const isPullRequestRun = controls !== null || opts.mode.kind === 'base';
  let rawFindings: Omit<Finding, 'fingerprint'>[];
  let online: OnlineRunSummary;
  let pypiStats: PypiExistenceStats | null = null;
  let enrichedUnchecked: UncheckedName[] | null = null;
  if (resolveOnline(config, opts.online)) {
    const budgetMs = resolveOnlineBudgetMs(config, opts.onlineBudgetMs, isPullRequestRun);
    const enriched = await enrichOnline(checkedFindings, ctx, budgetMs);
    rawFindings = enriched.findings;
    online = enriched.summary;
    pypiStats = enriched.pypiStats;
    enrichedUnchecked = enriched.unchecked;
  } else {
    rawFindings = checkedFindings;
    online = ONLINE_DISABLED_SUMMARY;
    const notChecked = pypiNamesNotChecked(ctx);
    if (notChecked !== null) {
      ctx.diagnostics.push(notChecked);
    }
  }
  const settledOnline = await settleOnlineUnchecked({
    enriched: enrichedUnchecked,
    rawFindings: checkedFindings,
    ctx,
    config,
    cliOnline: opts.online,
    isPullRequestRun,
    online,
  });
  online = settledOnline.online;
  const ecosystems = summarizeEcosystems(ctx, statePair.after.manifests, pypiStats, statePair.after.notParsed ?? []);

  const diagnostics = [...statePair.diagnostics, ...delta.diagnostics, ...ctx.diagnostics];
  const lockfileByManifest = new Map<string, string>();
  for (const change of delta.changes) {
    if (change.lockfilePath !== undefined && !lockfileByManifest.has(change.manifestPath)) {
      lockfileByManifest.set(change.manifestPath, change.lockfilePath);
    }
  }
  const filtered = applyPathFilters(
    rawFindings,
    config,
    baseline,
    diagnostics,
    lockfileIgnoreMatches,
    pathFilterSides,
    (manifestPath) => lockfileByManifest.get(manifestPath)
  );
  // On a pull-request run, a path the change makes a project under an
  // ignorePaths entry is a change to that control, so it is a proposal,
  // pushed the way the Python index proposal is.
  if (controls !== null) {
    controls.proposals.push(...ignoredPathProposals(filtered.madeProjects));
  }
  // After the filters, over what survived them: see install-script-collapse.ts.
  const collapse = collapseInstallScriptFindings(filtered.findings, {
    hasComparisonBase: delta.hasComparisonBase,
    lockfileWhollyNew: delta.lockfileWhollyNew,
    lockfilePath: delta.lockfilePath,
    baseline,
  });
  const { ignored } = filtered;
  const findings = collapse.findings;
  const suppressed = filtered.suppressed + collapse.suppressed;

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
      ecosystems,
      couldNotRun: settledOnline.couldNotRun,
    },
    controls,
    filtered
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

  const { findings: checkedFindings, ctx } = runChecks(corpus, config, delta, new Map(), null, false);
  // checkSingle has no --base concept -- only --trust-base -- so the
  // pull-request/CI shape here is exactly "a trust base was given".
  const isPullRequestRun = controls !== null;
  let rawFindings: Omit<Finding, 'fingerprint'>[];
  let online: OnlineRunSummary;
  let pypiStats: PypiExistenceStats | null = null;
  let enrichedUnchecked: UncheckedName[] | null = null;
  if (resolveOnline(config, opts.online)) {
    const budgetMs = resolveOnlineBudgetMs(config, opts.onlineBudgetMs, isPullRequestRun);
    const enriched = await enrichOnline(checkedFindings, ctx, budgetMs);
    rawFindings = enriched.findings;
    online = enriched.summary;
    pypiStats = enriched.pypiStats;
    enrichedUnchecked = enriched.unchecked;
  } else {
    rawFindings = checkedFindings;
    online = ONLINE_DISABLED_SUMMARY;
  }
  // `check --trust-base` is a pull-request run too (audit B2).
  const settledOnline = await settleOnlineUnchecked({
    enriched: enrichedUnchecked,
    rawFindings: checkedFindings,
    ctx,
    config,
    cliOnline: opts.online,
    isPullRequestRun,
    online,
  });
  online = settledOnline.online;
  // checkSingle stays npm-only (design open point 9): its one synthetic
  // name is an npm name, and no Python file is read.
  const ecosystems = summarizeEcosystems(ctx, null, pypiStats);

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
      ecosystems,
      couldNotRun: settledOnline.couldNotRun,
    },
    controls
  );
}
