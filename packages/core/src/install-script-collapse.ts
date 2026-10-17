import { createHash } from 'node:crypto';
import type { Finding } from './types.js';

// A change that adds the npm lockfile, or replaces it with one sharing no
// entry, makes every install-script package in it read as acquired. That is
// one fact about the change, not one per package, so the per-package
// findings are replaced by a single one at the same severity (high): the
// exit is the same and only the count differs.
//
// This runs in scan(), AFTER ignorePaths and the baseline have filtered the
// per-package findings, and only over the ones that survived. Doing it in
// the check, before the filters, let a baseline entry or an ignorePaths
// entry written for one package set (or for the lockfile path alone) swallow
// another. Here, ignorePaths and per-package baseline entries behave exactly
// as they did before the collapse existed, and the collapsed finding's own
// fingerprint is derived from the sorted package set, so a baseline entry
// for it covers the packages that were seen and no others.

export const NEW_LOCKFILE_SIGNAL = 'acquired-on-new-lockfile';
// Packages named in the message; the complete list is in details.packages.
const MAX_NAMED_PACKAGES = 10;
// The per-package signals the npm install-script check reports on a delta.
const PER_PACKAGE_SIGNALS: ReadonlySet<string> = new Set(['added', 'flag-acquired']);

export interface CollapseOptions {
  hasComparisonBase: boolean;
  lockfileWhollyNew: boolean | undefined;
  lockfilePath: string | undefined;
  baseline: ReadonlySet<string>;
}

function collapsedFingerprint(lockfilePath: string, packages: readonly string[]): string {
  const payload = JSON.stringify(['install-script', NEW_LOCKFILE_SIGNAL, lockfilePath, packages]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function collapseInstallScriptFindings(
  findings: Finding[],
  options: CollapseOptions
): { findings: Finding[]; suppressed: number } {
  const { lockfilePath } = options;
  if (!options.hasComparisonBase || options.lockfileWhollyNew !== true || lockfilePath === undefined) {
    return { findings, suppressed: 0 };
  }
  const scripted = findings.filter(
    (finding) =>
      finding.ruleId === 'install-script' &&
      finding.severity === 'high' &&
      typeof finding.details?.signal === 'string' &&
      PER_PACKAGE_SIGNALS.has(finding.details.signal)
  );
  const packages = [...new Set(scripted.map((finding) => finding.packageName))].sort();
  if (packages.length < 2) {
    return { findings, suppressed: 0 };
  }
  const rest = packages.length - MAX_NAMED_PACKAGES;
  const fingerprint = collapsedFingerprint(lockfilePath, packages);
  const kept = findings.filter((finding) => !scripted.includes(finding));
  if (options.baseline.has(fingerprint)) {
    return { findings: kept, suppressed: 1 };
  }
  const collapsed: Finding = {
    ruleId: 'install-script',
    severity: 'high',
    packageName: lockfilePath,
    message:
      `${packages.length} packages in ${lockfilePath} now run an install script that they did not run ` +
      `before: ${packages.slice(0, MAX_NAMED_PACKAGES).join(', ')}${rest > 0 ? ` and ${rest} more` : ''}. ` +
      'This npm lockfile is new in this change or no entry in it was there before, so each one reads as ' +
      'acquired. Review the list; to clear packages you have reviewed, add them to the allow list in ' +
      '.dep-guard.json.',
    manifestPath: lockfilePath,
    lockfilePath,
    fingerprint,
    details: { signal: NEW_LOCKFILE_SIGNAL, count: packages.length, packages },
  };
  return { findings: [...kept, collapsed], suppressed: 0 };
}
