// The minimum-publish-age check (issue #58): lets a repository align
// dep-guard's "too new to trust" judgment with its own Dependabot
// minimum-release-age cooldown, rather than only ever answering that
// question through registered-squat's hardcoded thirty-day/fifty-download
// window, which exists to catch a squatted NAME, not to express a general
// age-acceptance policy.
//
// What this inspects, and why it reads the lockfile diff rather than
// candidates.ts's newRegistryNames: candidates.ts answers "which manifest
// dependency names are new", which is the right question for existence and
// typosquat (name-based checks). This check answers a different one --
// "which RESOLVED VERSIONS are new" -- because a manifest range can stay
// unchanged while `npm update` moves the lockfile to a fresh release, and
// that fresh release is exactly the case a minimum-publish-age policy
// exists to catch. delta.ts's lockEntryChanges already answers this
// question on its own terms, independently of what any manifest declares:
// it is every lockfile entry ADDED or CHANGED relative to the before side
// in base mode, and -- because diffLockEntries treats every entry as
// "added" when there is no before lockfile to compare against -- every
// resolved entry in the lockfile in audit mode, with no special-casing
// needed here for either mode. It also already excludes every npm
// workspace-local entry (lockfiles/npm.ts never adds a `link: true` entry
// to its `entries` map), so no separate workspace filter is needed the way
// candidates.ts needs one.
//
// Reuses the shared registry client (registry-client.ts's fetchPackument,
// via scan.ts's cache wrapper) rather than a second HTTP path, exactly the
// way registered-squat and unknown-package do, and degrades to
// could-not-run-for-this-check on a registry error rather than a silent
// pass or a fabricated finding, per docs/INVARIANTS.md's online-degrade
// rule.

import type { CheckContext } from '../checks/types.js';
import { isInternalName } from '../checks/allow.js';
import type { Diagnostic, Finding } from '../types.js';
import type { OnlineDeadline } from './deadline.js';
import { ONLINE_DEADLINE_CODE, deadlineDiagnosticMessage } from './deadline.js';

export interface PublishAgeDeps {
  // `versions` names exactly the resolved versions this call needs an
  // answer for, so a cached implementation (scan.ts's
  // cachedFetchPackumentVersionTimes) can tell a genuinely stale cache
  // entry -- one missing a version this call is asking about -- from one
  // that simply has nothing new to say, and refetch live only for the
  // former. See scan.ts's cache-fail-open note (issue found in review of
  // #58) for why this parameter exists at all.
  fetchPackument(
    name: string,
    versions: string[]
  ): Promise<{ versionTimes: Record<string, string> } | null>;
}

interface Candidate {
  name: string;
  version: string;
  manifestPath: string;
}

// One candidate per (manifestPath, name, version) triple: the same
// resolved version of the same package can legitimately appear more than
// once in a single lockfile's diff (a nested duplicate resolution, say),
// and asking the registry about it twice, or reporting it twice against
// the same manifest, adds nothing a reader can act on twice.
function dedupeKey(candidate: Candidate): string {
  return JSON.stringify([candidate.manifestPath, candidate.name, candidate.version]);
}

function collectCandidates(ctx: CheckContext): Candidate[] {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const entryChange of ctx.delta.lockEntryChanges) {
    const version = entryChange.after.version;
    if (version === undefined) {
      // No resolved version to ask the registry about at all -- a git or
      // url source, say, which lockfile-tamper's own specifier-based
      // signals already cover.
      continue;
    }
    const name = entryChange.packageName;
    if (ctx.delta.workspaceLocalNames.has(name)) {
      // Belt and suspenders: lockfiles/npm.ts never puts a workspace-local
      // entry in `entries` in the first place, so lockEntryChanges should
      // never carry one, but a workspace sibling is never a registry
      // install regardless of which parser produced the delta, and this is
      // the same guard candidates.ts applies for the name-based checks.
      continue;
    }
    if (isInternalName(name, ctx.config.internalScopes, ctx.config.internalPrefixes)) {
      // A private package name is not something this tool may put on the
      // wire to a public registry just to price a heuristic -- the same
      // reasoning registered-squat.ts spells out at length for its own
      // candidate filter.
      continue;
    }
    const candidate: Candidate = { name, version, manifestPath: entryChange.manifestPath };
    const key = dedupeKey(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

function ageInDays(iso: string, now: () => number): number {
  const published = Date.parse(iso);
  if (Number.isNaN(published)) {
    // A malformed timestamp is something this check could not establish,
    // not evidence of anything -- Infinity means "never flags", the same
    // defensive choice registered-squat.ts's own ageInDays makes for the
    // same reason.
    return Infinity;
  }
  return (now() - published) / (1000 * 60 * 60 * 24);
}

function buildMessage(
  name: string,
  version: string,
  publishedAtIso: string,
  ageDays: number,
  minAgeDays: number
): string {
  if (ageDays < 0) {
    return (
      `"${name}@${version}" has a publish timestamp of ${publishedAtIso}, which is in the ` +
      `future; the configured minimum publish age is ${minAgeDays} day(s), so any future-dated ` +
      'publish is refused regardless of the floor.'
    );
  }
  return (
    `"${name}@${version}" was published ${publishedAtIso}, ${Math.floor(ageDays)} day(s) ago, ` +
    `which is below the configured minimum publish age of ${minAgeDays} day(s).`
  );
}

/**
 * The minimum-publish-age check. Runs only under --online (gated the same
 * way as the other three online checks, in scan.ts's enrichOnline), over
 * every added-or-changed resolved dependency in base mode and every
 * resolved dependency in audit mode (see the module comment above for why
 * ctx.delta.lockEntryChanges already answers both without branching on
 * ctx.delta.hasComparisonBase here).
 */
export async function findPublishAgeFindings(
  ctx: CheckContext,
  deps: PublishAgeDeps,
  diagnostics: Diagnostic[],
  deadline: OnlineDeadline,
  now: () => number = Date.now
): Promise<Omit<Finding, 'fingerprint'>[]> {
  const candidates = collectCandidates(ctx);
  if (candidates.length === 0) {
    return [];
  }

  const allowSet = new Set(ctx.config.minAgeAllow);
  const minAgeDays = ctx.config.minAgeDays;

  // Grouped by name, not by (name, version): one packument carries every
  // version's publish timestamp, so a package appearing at several
  // versions across a monorepo's manifests -- or, after dedupeKey above,
  // even just at several manifestPaths for the SAME version -- is still
  // one fetch.
  const byName = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const existing = byName.get(candidate.name);
    if (existing === undefined) {
      byName.set(candidate.name, [candidate]);
    } else {
      existing.push(candidate);
    }
  }

  const findings: Omit<Finding, 'fingerprint'>[] = [];
  let skippedByDeadline = 0;

  for (const [name, group] of byName) {
    if (deadline.expired()) {
      skippedByDeadline += group.length;
      continue;
    }

    let packument: { versionTimes: Record<string, string> } | null;
    try {
      packument = await deps.fetchPackument(
        name,
        group.map((candidate) => candidate.version)
      );
    } catch (err) {
      diagnostics.push({
        code: 'online-check-unreachable',
        message:
          `publish-age: could not reach the npm registry for "${name}" (${(err as Error).message}); ` +
          `${group.length} dependency(ies) were not checked`,
      });
      continue;
    }

    if (packument === null) {
      // The registry does not know this name at all. unknown-package's own
      // online resolution answers this for a name a MANIFEST declares (it
      // reads only newRegistryNames -- see checks/existence.ts), but this
      // check's own candidates come from the lockfile walk instead, which
      // is overwhelmingly transitive entries no manifest ever names. A
      // transitive dependency the registry no longer knows about would
      // therefore reach no online check at all if this stayed a silent
      // continue, so it is a diagnostic rather than a note: this check
      // still raises no finding of its own (unknown-package's rule id is
      // the right one for "this name looks wrong"), but the gap in
      // coverage has to be visible rather than indistinguishable from
      // "nothing needed checking".
      diagnostics.push({
        code: 'publish-age-package-unknown',
        message: `publish-age: the npm registry does not know package "${name}"; ${group.length} dependency(ies) resolved to it were not checked for publish age`,
      });
      continue;
    }

    for (const candidate of group) {
      const key = `${candidate.name}@${candidate.version}`;
      if (allowSet.has(key)) {
        // A reviewed exception for one specific release, not a standing
        // exemption for the name -- see ResolvedConfig.minAgeAllow.
        continue;
      }

      const publishedAt = packument.versionTimes[candidate.version];
      if (publishedAt === undefined) {
        // The registry knows the NAME but this exact resolved version is
        // missing from its time map even after a live fetch that was asked
        // about exactly this version (deps.fetchPackument's `versions`
        // parameter -- see scan.ts's cachedFetchPackumentVersionTimes) -- a
        // malformed or unexpectedly shaped response, not evidence the
        // version is suspicious. Still no finding of its own (inventing one
        // from data this check could not actually read would be worse than
        // saying nothing), but a diagnostic rather than a silent continue,
        // for the same "gap in coverage must be visible" reason as the
        // unknown-package case above.
        diagnostics.push({
          code: 'publish-age-version-unknown',
          message: `publish-age: "${candidate.name}@${candidate.version}" is missing from the registry's publish-time record for "${candidate.name}"; publish age could not be checked for this version`,
        });
        continue;
      }

      const days = ageInDays(publishedAt, now);
      if (!(days < minAgeDays)) {
        continue;
      }

      findings.push({
        ruleId: 'publish-age',
        severity: 'high',
        packageName: candidate.name,
        manifestPath: candidate.manifestPath,
        message: buildMessage(candidate.name, candidate.version, publishedAt, days, minAgeDays),
        details: {
          signal: 'publish-age',
          version: candidate.version,
          publishedAt,
          ageDays: Math.floor(days),
          minAgeDays,
        },
      });
    }
  }

  if (skippedByDeadline > 0) {
    diagnostics.push({
      code: ONLINE_DEADLINE_CODE,
      message: deadlineDiagnosticMessage('publish-age', skippedByDeadline, deadline),
    });
  }

  return findings;
}
