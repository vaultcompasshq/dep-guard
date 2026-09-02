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

import type { DownloadCountsResult } from './registry-client.js';
import type { Diagnostic, Finding } from '../types.js';

export const ASYMMETRY_DOWNLOAD_FLOOR = 2_000;

export interface AsymmetryDeps {
  fetchWeeklyDownloads(names: string[]): Promise<DownloadCountsResult>;
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

  let downloadsResult: DownloadCountsResult;
  try {
    downloadsResult = await deps.fetchWeeklyDownloads(candidates.map((f) => f.packageName));
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
    // Three states, not two -- see DownloadCountsResult in
    // registry-client.ts. A real count is used as-is. A name in
    // `noRecord` means the downloads fetch confirmed it has no download
    // history for this exact name -- either a null entry in a bulk
    // response, or a single-name 404 that registry-client.ts's own
    // sentinel probe confirmed was genuine rather than a symptom of a
    // broken downloadsApi -- a stronger unpopularity signal than a low
    // recorded count, so it is treated as zero rather than left at the
    // offline severity. A name in neither is unresolved -- as a matter of
    // what this function could establish it reaches here only if the
    // upstream fetch had a defensive, malformed-response-shaped gap,
    // since a single-name 404 is resolved (into `noRecord`) or turned
    // into a thrown, diagnosed failure before it would ever otherwise
    // land here -- and is left alone exactly as it would have been before
    // this fix -- an unresolved absence is not evidence the candidate is
    // unpopular, regardless of which upstream implementation produced it.
    // In the actual production wiring (scan.ts's
    // cachedFetchWeeklyDownloads), `noRecord` always arrives here empty:
    // the cache wrapper has already folded any confirmed no-record answer
    // into `counts` as a literal 0 before this function ever sees it, so
    // this branch is exercised by this file's own tests, not by a real
    // scan.
    const fromCounts = downloadsResult.counts.get(finding.packageName);
    let downloads: number;
    if (fromCounts !== undefined) {
      downloads = fromCounts;
    } else if (downloadsResult.noRecord.has(finding.packageName)) {
      downloads = 0;
    } else {
      continue;
    }
    if (downloads >= ASYMMETRY_DOWNLOAD_FLOOR) {
      continue;
    }
    finding.severity = 'high';
    (finding.details as Record<string, unknown>).onlineWeeklyDownloads = downloads;
  }
}
