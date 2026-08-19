//
// The typosquat popularity-asymmetry escalation: typosquatCheck already
// reports every non-alias-list resemblance match at 'low' (the severity
// split's binary model). This confirms the asymmetry the binary model
// could not measure offline -- is the candidate itself actually unpopular,
// not merely less popular than an extremely popular target -- and
// escalates to 'high' when confirmed. Never touches alias-list matches
// (already 'critical') or any other rule's findings.
//
// Severity is excluded from the fingerprint hash (docs/INVARIANTS.md), so
// this mutation never invalidates a baseline: an offline run and an online
// run of the same scan produce identical finding identities.
//
// The 2,000/week floor is a measured starting point (see the design doc),
// not a permanent constant -- refine it via the dogfood harness's --online
// mode.

import type { Diagnostic, Finding } from '../types.js';

export const ASYMMETRY_DOWNLOAD_FLOOR = 2_000;

export interface AsymmetryDeps {
  fetchWeeklyDownloads(names: string[]): Promise<Map<string, number>>;
}

export async function applyTyposquatAsymmetry(
  findings: Omit<Finding, 'fingerprint'>[],
  deps: AsymmetryDeps,
  diagnostics: Diagnostic[]
): Promise<void> {
  const candidates = findings.filter((f) => f.ruleId === 'typosquat' && f.severity === 'low');
  if (candidates.length === 0) {
    return;
  }

  let counts: Map<string, number>;
  try {
    counts = await deps.fetchWeeklyDownloads(candidates.map((f) => f.packageName));
  } catch (err) {
    diagnostics.push({
      code: 'online-check-unreachable',
      message:
        `typosquat popularity asymmetry: could not reach the npm downloads API ` +
        `(${(err as Error).message}); ${candidates.length} finding(s) kept their offline severity`,
    });
    return;
  }

  for (const finding of candidates) {
    // A key missing from counts here means the API answered for this batch
    // (a whole-batch failure would have thrown above and been caught as
    // online-check-unreachable) but has no download record for this exact
    // name. That is a stronger unpopularity signal than a low recorded
    // count, not a reason to skip escalation -- treat it as zero downloads
    // rather than leaving the candidate at its offline severity.
    const downloads = counts.get(finding.packageName) ?? 0;
    if (downloads >= ASYMMETRY_DOWNLOAD_FLOOR) {
      continue;
    }
    finding.severity = 'high';
    (finding.details as Record<string, unknown>).onlineWeeklyDownloads = downloads;
  }
}
