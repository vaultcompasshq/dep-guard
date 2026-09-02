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
