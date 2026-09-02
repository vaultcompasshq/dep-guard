import { DepGuardError } from './types.js';
import type { FailOn, Finding, Severity } from './types.js';

const SEVERITY_ORDER: Severity[] = ['low', 'medium', 'high', 'critical'];

// T2-3: an unrecognized severity used to score -1 and therefore sit below
// every threshold, so a finding carrying one passed the gate in silence --
// the one failure mode a gate must never have. No rule can produce that
// today; this is here so that the day one starts to, the scan stops instead
// of quietly blessing it.
function rankOf(severity: Severity | FailOn, what: string): number {
  const rank = SEVERITY_ORDER.indexOf(severity as Severity);
  if (rank === -1) {
    throw new DepGuardError(
      `${what} "${String(severity)}" is not one of ${SEVERITY_ORDER.join(', ')}`,
      'severity-invalid'
    );
  }
  return rank;
}

export function severityAtLeast(s: Severity, floor: Severity): boolean {
  return rankOf(s, 'severity') >= rankOf(floor, 'fail_on threshold');
}

/**
 * Whether this one finding blocks at this threshold.
 *
 * evaluateGate is defined in terms of this rather than the other way
 * round, and that direction is the point. A consumer that needs the
 * decision PER FINDING -- the SARIF renderer's `properties.blocking`, and
 * anything after it -- would otherwise have to reconstruct it from
 * `run.failOn` and its own copy of the severity ladder, which is a second
 * implementation of the gate living outside the gate. docs/INVARIANTS.md
 * calls that shape out by name: a hand-maintained description of what
 * some other code does, which stays correct exactly until that code
 * changes. There is one implementation, and both callers use it.
 *
 * Throws for an unrecognized severity or threshold, via severityAtLeast,
 * for the reason rankOf documents above: failing closed beats scoring an
 * unknown severity below every threshold and passing it.
 */
export function isBlocking(finding: Finding, failOn: FailOn): boolean {
  if (failOn === 'none') {
    return false;
  }
  return severityAtLeast(finding.severity, failOn);
}

export function evaluateGate(
  findings: Finding[],
  failOn: FailOn
): { blockingMatches: number; exitCode: 0 | 1 } {
  if (failOn === 'none') {
    return { blockingMatches: 0, exitCode: 0 };
  }
  const blockingMatches = findings.filter((finding) => isBlocking(finding, failOn)).length;
  return { blockingMatches, exitCode: blockingMatches > 0 ? 1 : 0 };
}
