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

export function evaluateGate(
  findings: Finding[],
  failOn: FailOn
): { blockingMatches: number; exitCode: 0 | 1 } {
  if (failOn === 'none') {
    return { blockingMatches: 0, exitCode: 0 };
  }
  const blockingMatches = findings.filter((finding) =>
    severityAtLeast(finding.severity, failOn)
  ).length;
  return { blockingMatches, exitCode: blockingMatches > 0 ? 1 : 0 };
}
