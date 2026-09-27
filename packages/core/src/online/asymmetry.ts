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
//
// This is the fourth online check, and until an independent review after
// issues 66/67/70 it was the one left outside the shared npmrc-scoped rule
// (online/registry-scope.ts's isNonPublicName): it sent every low
// typosquat finding's packageName to the downloads API regardless of
// internalScopes/internalPrefixes or the project's own .npmrc, the exact
// leak shape unknown-package and registered-squat had before #70. It now
// filters the same way they do, before the fetch: an internal name is
// dropped silently (the same silent-by-design filter every other check
// applies -- an adopter's own configured list needs no diagnostic
// reminding them of it), and a name isNonPublicName excludes is dropped
// with its own `typosquat-asymmetry-private-origin-skipped` diagnostic
// naming it, the same visibility the other three checks' own npmrc-derived
// skips give.

import type { CheckContext } from '../checks/types.js';
import { isInternalName } from '../checks/allow.js';
import { isNonPublicName } from './registry-scope.js';
import type { DownloadCountsResult } from './registry-client.js';
import type { Diagnostic, Finding } from '../types.js';

export const ASYMMETRY_DOWNLOAD_FLOOR = 2_000;

export interface AsymmetryDeps {
  fetchWeeklyDownloads(names: string[]): Promise<DownloadCountsResult>;
}

export async function applyTyposquatAsymmetry(
  findings: Omit<Finding, 'fingerprint'>[],
  ctx: CheckContext,
  deps: AsymmetryDeps,
  diagnostics: Diagnostic[]
): Promise<void> {
  const candidates: Omit<Finding, 'fingerprint'>[] = [];
  for (const finding of findings) {
    if (finding.ruleId !== 'typosquat' || finding.severity !== 'low') {
      continue;
    }
    if (isInternalName(finding.packageName, ctx.config.internalScopes, ctx.config.internalPrefixes)) {
      continue;
    }
    if (isNonPublicName(ctx, finding.packageName)) {
      diagnostics.push({
        code: 'typosquat-asymmetry-private-origin-skipped',
        message:
          `typosquat popularity asymmetry: "${finding.packageName}" is declared private by the ` +
          "project's .npmrc (its scope is pinned to another registry, or the default registry is " +
          'private), so it was not sent to the downloads API',
      });
      continue;
    }
    candidates.push(finding);
  }
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
