// Catches what the offline existence check structurally cannot: a
// hallucinated or attacker-registered name that has since been absorbed by
// a corpus refresh (a routine release-checklist item), after which the
// offline check goes silent on it forever, because it now genuinely exists
// in every corpus built from that point on. Runs over every added or
// changed registry dependency, independent of what the offline passes
// said, because a hallucinated name is not necessarily a near-typo of
// anything the resemblance-based typosquat check would catch.
//
// Deliberately conservative: no resemblance filter narrows the candidate
// set the way it does for typosquat-asymmetry, so this is structurally the
// same false-positive risk the existence check's own "Known risks" section
// already documents -- a legitimately brand-new package looks identical to
// a squat by age and downloads alone. Both conditions (near-zero downloads
// AND recent creation) are required, and severity is medium, not high or
// critical, to keep this reading as circumstantial evidence rather than a
// confirmed finding. See the design doc's "Known limitation" section.

import type { CheckContext } from '../checks/types.js';
import { newRegistryNames } from '../checks/candidates.js';
import type { DownloadCountsResult } from './registry-client.js';
import type { Diagnostic, Finding } from '../types.js';

export const REGISTERED_SQUAT_DOWNLOAD_FLOOR = 50;
export const REGISTERED_SQUAT_MAX_AGE_DAYS = 30;

export interface RegisteredSquatDeps {
  fetchWeeklyDownloads(names: string[]): Promise<DownloadCountsResult>;
  fetchPackument(name: string): Promise<{ createdAt: string | null } | null>;
}

function ageInDays(isoDate: string, now: () => number): number {
  const created = Date.parse(isoDate);
  if (Number.isNaN(created)) {
    return Infinity;
  }
  return (now() - created) / (1000 * 60 * 60 * 24);
}

export async function findRegisteredSquats(
  ctx: CheckContext,
  deps: RegisteredSquatDeps,
  diagnostics: Diagnostic[],
  now: () => number = Date.now
): Promise<Omit<Finding, 'fingerprint'>[]> {
  const candidates = newRegistryNames(ctx);
  if (candidates.length === 0) {
    return [];
  }

  let downloadsResult: DownloadCountsResult;
  try {
    downloadsResult = await deps.fetchWeeklyDownloads(candidates.map((c) => c.registryName));
  } catch (err) {
    diagnostics.push({
      code: 'online-check-unreachable',
      message:
        `registered-squat: could not reach the npm downloads API ` +
        `(${(err as Error).message}); ${candidates.length} dependency(ies) were not checked`,
    });
    return [];
  }

  const findings: Omit<Finding, 'fingerprint'>[] = [];

  for (const { change, registryName } of candidates) {
    // Three states, not two -- see DownloadCountsResult in
    // registry-client.ts. A real count is used as-is. A name in
    // `noRecord` means the downloads fetch confirmed it has no download
    // history for this exact name -- either a null entry in a bulk
    // response, or (a scoped name, or an unscoped name that happened to
    // be the only cache miss) a single-name 404 that registry-client.ts's
    // own sentinel probe confirmed was genuine rather than a symptom of a
    // broken downloadsApi. Either way this is the archetypal
    // registered-squat case (a freshly-registered attacker name is
    // precisely the name with no download history yet), so it is treated
    // as zero rather than skipped, letting this check fire on its own
    // defining example instead of going structurally silent on it. A name
    // in neither is unresolved -- in production this reaches here only if
    // the upstream fetch had a defensive, malformed-response-shaped gap,
    // since a single-name 404 is resolved (into `noRecord`) or turned
    // into a thrown, diagnosed failure before it would ever otherwise
    // land here -- and is skipped exactly as it would have been before
    // this fix -- an unresolved absence is not evidence of anything, and
    // must not mint a finding regardless of which upstream implementation
    // produced it.
    const fromCounts = downloadsResult.counts.get(registryName);
    let downloads: number;
    if (fromCounts !== undefined) {
      downloads = fromCounts;
    } else if (downloadsResult.noRecord.has(registryName)) {
      downloads = 0;
    } else {
      continue;
    }
    if (downloads >= REGISTERED_SQUAT_DOWNLOAD_FLOOR) {
      continue;
    }

    let packument: { createdAt: string | null } | null;
    try {
      packument = await deps.fetchPackument(registryName);
    } catch (err) {
      diagnostics.push({
        code: 'online-check-unreachable',
        message: `registered-squat: could not reach the npm registry for "${registryName}" (${(err as Error).message})`,
      });
      continue;
    }
    if (packument === null || packument.createdAt === null) {
      continue;
    }

    const days = ageInDays(packument.createdAt, now);
    if (days > REGISTERED_SQUAT_MAX_AGE_DAYS) {
      continue;
    }

    findings.push({
      ruleId: 'registered-squat',
      severity: 'medium',
      packageName: registryName,
      message:
        `"${registryName}" was published to npm ${Math.floor(days)} day(s) ago and has ` +
        `${downloads} download(s) in the last week. A hallucinated or attacker-registered ` +
        'name can pass every offline check once a corpus refresh has absorbed it; confirm ' +
        'this is the package you meant to install.',
      manifestPath: change.manifestPath,
      details: {
        signal: 'registered-squat',
        specifier: change.specifier,
        depType: change.depType,
        weeklyDownloads: downloads,
        createdDaysAgo: Math.floor(days),
      },
    });
  }

  return findings;
}
