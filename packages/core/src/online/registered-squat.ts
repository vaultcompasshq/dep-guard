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
import type { Diagnostic, Finding } from '../types.js';

export const REGISTERED_SQUAT_DOWNLOAD_FLOOR = 50;
export const REGISTERED_SQUAT_MAX_AGE_DAYS = 30;

export interface RegisteredSquatDeps {
  fetchWeeklyDownloads(names: string[]): Promise<Map<string, number>>;
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

  let counts: Map<string, number>;
  try {
    counts = await deps.fetchWeeklyDownloads(candidates.map((c) => c.registryName));
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
    const downloads = counts.get(registryName);
    if (downloads === undefined || downloads >= REGISTERED_SQUAT_DOWNLOAD_FLOOR) {
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
