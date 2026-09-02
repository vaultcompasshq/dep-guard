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
import { assertScannablePath, loadStates, matchGlobPath, resolveScanRoot } from './git-source.js';
import type { ScanMode } from './git-source.js';
import { DepGuardError } from './types.js';
import type { Diagnostic, FailOn, Finding, Severity } from './types.js';
import { applyTyposquatAsymmetry } from './online/asymmetry.js';
import { findRegisteredSquats } from './online/registered-squat.js';
import { resolveUnknownPackages } from './online/unknown-package.js';
import {
  ONLINE_DEADLINE_CODE,
  createOnlineDeadline,
  deadlineDiagnosticMessage,
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

export interface ScanResult {
  findings: Finding[]; // baseline-suppressed and ignorePaths-dropped findings excluded
  suppressed: number; // count removed by the baseline, specifically (not ignorePaths)
  ignored: number; // count removed by config.ignorePaths, specifically (not the baseline)
  run: {
    mode: 'staged' | 'base' | 'audit';
    failOn: FailOn;
    blockingMatches: number;
    durationMs: number;
    corpusBuiltAt: string;
    lockfileFormat: string;
    diagnostics: Diagnostic[];
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
  npmrcRegistryPins: Map<string, string>
): { findings: Omit<Finding, 'fingerprint'>[]; ctx: CheckContext } {
  const ctx: CheckContext = { corpus, config, delta, npmrcRegistryPins, diagnostics: [] };
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

async function cachedFetchWeeklyDownloads(names: string[]): Promise<DownloadCountsResult> {
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
  if (misses.length > 0) {
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

async function cachedFetchPackument(name: string): Promise<{ createdAt: string | null } | null> {
  const store = sharedCache();
  const hit = store.get(`created:${name}`);
  if (hit !== undefined) {
    return { createdAt: hit as string | null };
  }
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

// The three online steps, in the order the run's one wall-clock budget is
// spent on them. The order is a priority decision, not an accident:
//
//  1. unknown-package resolution, because it is the only step that can
//     REMOVE a false positive from the flagship blocking check, and the
//     only one whose absence gets steadily worse as a release ages away
//     from its corpus walk. If the budget only stretches to one step, this
//     is the one worth having.
//  2. typosquat popularity asymmetry, which escalates an existing low.
//  3. registered-squat, which adds a new medium.
//
// Steps 2 and 3 both only ever add or escalate, so a budget spent before
// them costs a signal that would not have existed offline either. Step 1
// is the one whose omission leaves a user with a blocking finding they
// have no way to clear, which is why it goes first.
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
async function liveFetchPackument(name: string) {
  return fetchPackument(name, { backoffCapMs: SCAN_BACKOFF_CAP_MS });
}

async function enrichOnline(
  rawFindings: Omit<Finding, 'fingerprint'>[],
  ctx: CheckContext
): Promise<Omit<Finding, 'fingerprint'>[]> {
  const deadline = createOnlineDeadline();

  const resolved = await resolveUnknownPackages(
    rawFindings,
    ctx,
    { fetchPackument: liveFetchPackument },
    ctx.diagnostics,
    deadline
  );

  // applyTyposquatAsymmetry issues one bulk request and has no per-name
  // loop, so it is gated here rather than internally: there is exactly one
  // point at which it could stop, and that point is before it starts. Its
  // candidates are counted the same way it counts them itself so the
  // diagnostic names a real number.
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
      { fetchWeeklyDownloads: cachedFetchWeeklyDownloads },
      ctx.diagnostics
    );
  }

  const registeredSquats = await findRegisteredSquats(
    ctx,
    { fetchWeeklyDownloads: cachedFetchWeeklyDownloads, fetchPackument: cachedFetchPackument },
    ctx.diagnostics,
    deadline
  );
  return [...resolved, ...registeredSquats];
}

interface RunInfo {
  mode: 'staged' | 'base' | 'audit';
  lockfileFormat: string;
  corpusBuiltAt: string;
  diagnostics: Diagnostic[];
  startedAt: number;
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

function buildResult(findings: Finding[], suppressed: number, ignored: number, config: ResolvedConfig, info: RunInfo): ScanResult {
  const { blockingMatches, exitCode } = evaluateGate(findings, config.failOn);

  return {
    findings,
    suppressed,
    ignored,
    run: {
      mode: info.mode,
      failOn: config.failOn,
      blockingMatches,
      durationMs: Date.now() - info.startedAt,
      corpusBuiltAt: info.corpusBuiltAt,
      lockfileFormat: info.lockfileFormat,
      diagnostics: dedupeDiagnostics(info.diagnostics),
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
  const config = applyFailOnOverride(loadConfig(root), opts.failOn);
  const corpus = loadCorpus(opts.corpusDir ?? DEFAULT_CORPUS_DIR);
  const statePair = await loadStates(opts.repoRoot, opts.mode);
  const delta = computeDelta(statePair.before, statePair.after);
  const baseline = loadBaseline(root);

  const { findings: checkedFindings, ctx } = runChecks(
    corpus,
    config,
    delta,
    statePair.after.npmrcRegistryPins
  );
  const rawFindings = resolveOnline(config, opts.online)
    ? await enrichOnline(checkedFindings, ctx)
    : checkedFindings;

  const diagnostics = [...statePair.diagnostics, ...delta.diagnostics, ...ctx.diagnostics];
  const { findings, suppressed, ignored } = applyPathFilters(rawFindings, config, baseline, diagnostics);

  return buildResult(findings, suppressed, ignored, config, {
    mode: statePair.mode.kind,
    lockfileFormat: delta.lockfileFormat,
    corpusBuiltAt: corpus.builtAt,
    diagnostics,
    startedAt,
  });
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
const NAME_ONLY_DIAGNOSTIC: Diagnostic = {
  code: 'check-single-name-only',
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
// npmrcRegistryPins is intentionally empty rather than read from the real
// repository: the synthetic delta carries no lockfile resolution for the
// dependency-confusion pin-mismatch rule to compare against a pin, so that
// rule can never fire here regardless; the internal-name rule (the other
// half of confusionCheck) still runs, since it only needs config and the
// name itself.
export async function checkSingle(opts: {
  repoRoot: string;
  name: string;
  corpusDir?: string;
  failOn?: FailOn;
  online?: boolean;
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
  const config = applyFailOnOverride(loadConfig(root), opts.failOn);
  const corpus = loadCorpus(opts.corpusDir ?? DEFAULT_CORPUS_DIR);
  const delta = syntheticDelta(opts.name);

  const { findings: checkedFindings, ctx } = runChecks(corpus, config, delta, new Map());
  const rawFindings = resolveOnline(config, opts.online)
    ? await enrichOnline(checkedFindings, ctx)
    : checkedFindings;

  const findings = skipPathFilters(rawFindings);

  return buildResult(findings, 0, 0, config, {
    mode: 'audit',
    lockfileFormat: delta.lockfileFormat,
    corpusBuiltAt: corpus.builtAt,
    diagnostics: [...ctx.diagnostics, NAME_ONLY_DIAGNOSTIC],
    startedAt,
  });
}
