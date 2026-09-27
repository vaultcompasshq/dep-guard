import type { Diagnostic } from '../types.js';

// One wall-clock budget for every online call a single scan makes.
//
// The per-request budget registry-client.ts already sets (SCAN_TIMEOUT_MS,
// SCAN_ATTEMPTS, and the caller-supplied backoff cap) bounds ONE request.
// It does not bound a run: a modest delta carrying twenty new names, each
// resolving in a second or two, is a pre-commit hook that takes half a
// minute, and nothing in the per-request budget notices. dep-guard runs
// per commit, so a latency budget that only holds per request is not a
// latency budget at all.
//
// So one deadline is created per scan and shared by every online step.
// Each step asks it before spending a request, and skips the rest of its
// work once it is spent. What "skips" means is fixed by
// docs/INVARIANTS.md's degrade rule and is the same as a network failure:
// the affected findings are left exactly as the offline checks made them,
// nothing is removed, nothing is downgraded, and the reason is recorded
// rather than implied. A spent deadline is therefore never a reason for a
// scan to report LESS than it would have offline -- only for it to stop
// adding more.
//
// The clock is injected so tests drive it rather than sleeping. A test
// that slept would be slower and flakier and would prove nothing this
// does not.

export interface OnlineDeadline {
  /** True once the run's whole online budget has been spent. */
  expired(): boolean;
  /** Milliseconds left in the budget, floored at zero. */
  remainingMs(): number;
  /**
   * The budget this deadline was created with. Carried on the object so a
   * diagnostic can name the real number rather than restating the default
   * constant, which would be wrong for any deadline built with anything
   * else -- every test here builds one, and so could a future config key.
   */
  readonly budgetMs: number;
}

// Twenty seconds for every online call in one scan, together. Chosen
// against what this subsystem actually costs: registry-client.ts allows
// two attempts at five seconds each per request, and scan.ts caps a
// retry backoff at eight, so a single worst-case name is already most of
// twenty seconds. The budget is therefore roughly "one pathological name,
// or a couple of dozen healthy ones" -- long enough that a normal delta
// finishes every lookup it wanted, short enough that a degraded network
// cannot turn a commit into a coffee break. It is not configurable today;
// if it ever needs to be, it becomes a config key rather than a second
// constant somewhere else.
export const DEFAULT_ONLINE_BUDGET_MS = 20_000;

// Five minutes, used instead of DEFAULT_ONLINE_BUDGET_MS when the run is a
// --base or --trust-base run rather than a plain commit hook (issue #75).
// The pre-commit trade-off above is exactly backwards for that shape: a CI
// job has minutes to spend, and the expensive outcome is not a slow commit
// but a large dependency change whose remaining lookups quietly keep their
// offline result once twenty seconds run out, with only a diagnostic to
// show for it. A hook still gets the tight default because a developer is
// waiting on it; CI is not a developer waiting, so it gets minutes instead
// of seconds. Both are only ever a DEFAULT -- an explicit onlineBudgetMs
// config key or --online-budget-ms flag always wins over either one (see
// scan.ts's resolveOnlineBudgetMs).
export const CI_ONLINE_BUDGET_MS = 300_000;

export function createOnlineDeadline(
  budgetMs: number = DEFAULT_ONLINE_BUDGET_MS,
  now: () => number = Date.now
): OnlineDeadline {
  const startedAt = now();
  // A non-positive budget is expired from the first question rather than
  // allowing one free request: a caller asking for no online time at all
  // must get no online calls, not one.
  const clamped = Math.max(0, budgetMs);
  const endsAt = startedAt + clamped;
  return {
    expired: () => now() >= endsAt,
    remainingMs: () => Math.max(0, endsAt - now()),
    budgetMs: clamped,
  };
}

// The one diagnostic code every online step raises when it stopped
// because the budget ran out rather than because the network failed.
// Declared here, next to the mechanism, so the several steps that raise
// it cannot drift into three spellings of the same fact --
// docs/INVARIANTS.md's "derive, do not describe" applied to a string.
export const ONLINE_DEADLINE_CODE = 'online-deadline-exceeded';

export function deadlineDiagnosticMessage(
  check: string,
  skipped: number,
  deadline: OnlineDeadline
): string {
  return (
    `${check}: the per-run online budget (${deadline.budgetMs}ms) was spent before ` +
    `${skipped} lookup(s) could run; those findings kept their offline result`
  );
}

// The number embedded in every `deadlineDiagnosticMessage` this run raised,
// summed. scan.ts's JSON `online.lookupsSkippedByDeadline` field is built
// from this rather than from a second count kept alongside the deadline
// object, on purpose: the four online steps already compute and report
// this number (one of them, the typosquat asymmetry gate in scan.ts's own
// enrichOnline, counts it BEFORE that step's internal-name and
// private-origin filters run, so it can overstate skipped lookups but never
// understate them), and a caller reading it back out of the diagnostics is
// guaranteed to match what a human reading the same diagnostics sees,
// rather than risking a second, independently-computed number drifting
// from the first. The message format is this module's own
// (deadlineDiagnosticMessage above), so the pattern below only ever has to
// agree with one writer.
export function sumDeadlineSkipped(diagnostics: readonly Diagnostic[]): number {
  let total = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== ONLINE_DEADLINE_CODE) {
      continue;
    }
    const match = /before (\d+) lookup/.exec(diagnostic.message);
    if (match) {
      total += Number(match[1]);
    }
  }
  return total;
}
