// Resolves the unknown-package rule against the live registry.
//
// Why this exists at all. unknown-package is dep-guard's flagship blocking
// check (high severity, above the default medium gate) and it is answered
// entirely from a bloom filter built by one dated walk of the registry.
// Every package published after that walk is absent from the filter, so it
// reads as unknown to that release forever, and the false-positive rate on
// the check that actually blocks commits therefore climbs continuously
// from the moment a release is cut. The finding's own message already
// admits the ambiguity ("It may be hallucinated, or published after that
// date"), and until now nothing could settle it: --online enriched the
// typosquat and registered-squat rules and left this one alone.
//
// The registry can settle it, and the answer is cheap and already cached
// (scan.ts's cachedFetchPackument). Three outcomes, and each of them is
// constrained by docs/INVARIANTS.md's degrade rule rather than chosen
// freely:
//
//  - The packument exists. The name is real, so the corpus was merely
//    stale about it, and the finding stands DOWN -- it is removed from the
//    results. This is the one place in the whole online subsystem that
//    removes a finding, and it is allowed only because what it removes is
//    an assertion the registry has just directly contradicted. It removes
//    nothing else: whether the name is SUSPICIOUS is the typosquat and
//    registered-squat rules' question, both of which still run over the
//    same name and neither of which is touched here. "It exists" and "it
//    is safe" are different sentences, and only the first one is being
//    made.
//
//  - The packument 404s. npm has no such name at all, which is strictly
//    stronger evidence than absence from a dated corpus: the innocent
//    explanation the offline message offers ("published after that date")
//    has just been ruled out. The finding is escalated to critical and its
//    message is rewritten to say what was actually established.
//
//  - Anything else -- a timeout, a 5xx, a malformed response, or a per-run
//    deadline that was already spent -- leaves the finding EXACTLY as the
//    offline check made it: still high, still blocking at the default
//    gate. A network problem must never mean fewer findings, and it must
//    never throw: enrichOnline's contract (docs/INVARIANTS.md) is that a
//    flaky connection cannot block a commit, and a thrown error here would
//    do precisely that. What the run could not establish is recorded in
//    the finding's own details and in a diagnostic, so a reader can tell
//    "the registry says this name is fine" from "nobody managed to ask".
//
// Names inside a configured internal scope or prefix are never sent to the
// registry. Two reasons, and either alone would be enough: an internal
// package is absent from npm by design, so a 404 for it would be a
// fabricated critical rather than evidence of anything; and a private
// package name is not a thing this tool may put on the wire to a public
// service. existenceCheck already skips internal names, so no such finding
// should reach this function in the first place -- the guard is here
// anyway, because "the caller already filtered it" is exactly the kind of
// second-hand claim docs/INVARIANTS.md's opening warns about, and the cost
// of being wrong is a private name leaving the machine.

import type { CheckContext } from '../checks/types.js';
import { isInternalName } from '../checks/allow.js';
import type { Diagnostic, Finding } from '../types.js';
import type { OnlineDeadline } from './deadline.js';
import { ONLINE_DEADLINE_CODE, deadlineDiagnosticMessage } from './deadline.js';

// The facts this check needs about a 200 from the registry. Deliberately
// NOT `{ createdAt }`: a creation date cannot distinguish a real package
// from a name npm has taken over for security reasons, and the previous
// version of this file narrowed the dep to exactly that, discarding the
// discriminator registry-client had already computed. A 200 then read as
// "the name is fine" for a package npm had seized precisely because it
// was not.
export interface PackumentFacts {
  latestVersion: string | null;
  unpublished: boolean;
  securityHolder: boolean;
}

export interface UnknownPackageDeps {
  fetchPackument(name: string): Promise<PackumentFacts | null>;
}

const CHECK_LABEL = 'unknown-package online resolution';

// Why each not-present answer left the finding alone, in the finding's
// own details. A consumer reading one finding out of a JSON or SARIF
// report has no other way to learn that the registry did answer and that
// the answer was not reassuring.
const NOT_PRESENT_REASONS: Record<'tombstone' | 'security-holder' | 'no-usable-version', string> = {
  tombstone:
    'the registry answered, but every version of this name has been unpublished, so there is no package here to install',
  'security-holder':
    'the registry answered with an npm security-holding placeholder, which means npm took this name over rather than that the package is real',
  'no-usable-version':
    'the registry answered, but the response carried no usable latest version, so it does not confirm the package exists',
};

// Recorded on the finding itself, not only in a diagnostic. A diagnostic
// describes the run; this describes THIS finding, and a consumer reading
// one finding out of a JSON report (a code review bot, a dashboard) has no
// way to attribute a run-level note to it. The three values are the three
// ways the question can fail to be settled -- there is deliberately no
// value for "resolved, exists", because that finding no longer exists.
type OnlineResolution =
  | 'registry-absent'
  | 'unreachable'
  | 'deadline-exceeded'
  // The three "200, but not a usable package" answers. Each keeps the
  // finding exactly as the offline check made it, and each says which
  // kind of 200 it was, because they mean different things to a reader:
  // a tombstone is a name that was withdrawn, a security holder is a name
  // npm seized, and no-usable-version is a body that answered nothing.
  | 'tombstone'
  | 'security-holder'
  | 'no-usable-version';

function recordResolution(
  finding: Omit<Finding, 'fingerprint'>,
  resolution: OnlineResolution,
  reason?: string
): void {
  // details is optional on the Finding type even though existenceCheck
  // always populates it, so this must not assume the bag is there.
  //
  // Nothing written here may be named `signal`: fingerprintFinding hashes
  // ruleId, packageName, manifestPath and details.signal, and ONLY those.
  // Adding a signal to a finding that had none would mint a new identity
  // for it, so a user who baselined an unknown-package finding offline
  // would see it return the first time they passed --online. Every other
  // details key is excluded from the hash by design, which is what makes
  // these two safe to add.
  const details = (finding.details ?? {}) as Record<string, unknown>;
  details.onlineResolution = resolution;
  if (reason !== undefined) {
    details.onlineResolutionReason = reason;
  }
  finding.details = details;
}

function registryAbsentMessage(name: string, corpusBuiltAt: unknown): string {
  const corpusNote =
    typeof corpusBuiltAt === 'string' && corpusBuiltAt.length > 0
      ? ` It is also absent from the known-package corpus built ${corpusBuiltAt}.`
      : '';
  return (
    `"${name}" does not exist on the npm registry: the registry was queried directly ` +
    `for this name and answered 404.${corpusNote} A name that is on no registry cannot ` +
    'be installed, so this is a hallucinated or mistyped dependency rather than a ' +
    'package that is merely newer than the corpus.'
  );
}

/**
 * Resolves every unknown-package finding against the live registry and
 * returns the surviving findings.
 *
 * The input array is not mutated in place as a list -- a new array is
 * returned -- but the finding objects themselves are mutated (severity,
 * message, details), the same way applyTyposquatAsymmetry mutates the
 * findings it escalates. Never throws: every failure becomes a diagnostic.
 */
export async function resolveUnknownPackages(
  findings: Omit<Finding, 'fingerprint'>[],
  ctx: CheckContext,
  deps: UnknownPackageDeps,
  diagnostics: Diagnostic[],
  deadline: OnlineDeadline
): Promise<Omit<Finding, 'fingerprint'>[]> {
  const candidates = findings.filter(
    (f) =>
      f.ruleId === 'unknown-package' &&
      !isInternalName(f.packageName, ctx.config.internalScopes, ctx.config.internalPrefixes)
  );
  if (candidates.length === 0) {
    return findings;
  }

  // One question per distinct name, however many findings mention it. The
  // same hallucinated name declared in two workspace manifests is two
  // findings and one fact about npm, and asking twice would double the
  // latency of exactly the monorepo-wide sweep the deadline exists to
  // bound. Keyed by name alone (not by name and manifest path) because the
  // registry's answer cannot differ between two manifests.
  const byName = new Map<string, Omit<Finding, 'fingerprint'>[]>();
  for (const finding of candidates) {
    const existing = byName.get(finding.packageName);
    if (existing === undefined) {
      byName.set(finding.packageName, [finding]);
    } else {
      existing.push(finding);
    }
  }

  const stoodDown = new Set<Omit<Finding, 'fingerprint'>>();
  let skippedByDeadline = 0;

  for (const [name, group] of byName) {
    // Re-asked before every name, not once at the top: the budget is a
    // wall clock and a single slow lookup can spend the whole of it, so a
    // run that started inside the budget can legitimately fall outside it
    // partway through. Findings past that point are left untouched, which
    // is the same outcome a network failure produces.
    if (deadline.expired()) {
      skippedByDeadline += group.length;
      for (const finding of group) {
        recordResolution(
          finding,
          'deadline-exceeded',
          'the per-run online budget was already spent when this name came up'
        );
      }
      continue;
    }

    let packument: PackumentFacts | null;
    try {
      packument = await deps.fetchPackument(name);
    } catch (err) {
      const reason = (err as Error).message;
      for (const finding of group) {
        recordResolution(finding, 'unreachable', reason);
      }
      diagnostics.push({
        code: 'online-check-unreachable',
        message:
          `${CHECK_LABEL}: could not reach the npm registry for "${name}" (${reason}); ` +
          `${group.length} finding(s) kept their offline severity`,
      });
      continue;
    }

    if (packument !== null) {
      // A 200 is not by itself an answer. Only a body carrying a real
      // latest version, with no unpublish record and no security-holder
      // placeholder, means an installable package exists under this name.
      // Everything else is a 200 about a name that is NOT a usable
      // package, and each of those keeps the offline finding exactly as
      // it was while saying which case it hit.
      //
      // The order matters: a seized name is reported as seized even if it
      // somehow also carries a version, because that is the fact a reader
      // most needs, and the check is deliberately made before the
      // has-a-version test rather than after it.
      const notPresent: OnlineResolution | null = packument.unpublished
        ? 'tombstone'
        : packument.securityHolder
          ? 'security-holder'
          : packument.latestVersion === null
            ? 'no-usable-version'
            : null;

      if (notPresent !== null) {
        for (const finding of group) {
          recordResolution(finding, notPresent, NOT_PRESENT_REASONS[notPresent]);
        }
        continue;
      }

      // The name is real. The corpus was stale, not the manifest.
      for (const finding of group) {
        stoodDown.add(finding);
      }
      continue;
    }

    for (const finding of group) {
      finding.severity = 'critical';
      finding.message = registryAbsentMessage(name, finding.details?.corpusBuiltAt);
      recordResolution(finding, 'registry-absent');
    }
  }

  if (skippedByDeadline > 0) {
    diagnostics.push({
      code: ONLINE_DEADLINE_CODE,
      message: deadlineDiagnosticMessage(CHECK_LABEL, skippedByDeadline, deadline),
    });
  }

  // Filtered rather than spliced, and filtered by object identity against
  // a set this function built, so nothing but a finding this function
  // itself resolved as present can ever be dropped. Every other finding in
  // the list -- including a typosquat finding for the very same package
  // name -- passes through untouched.
  return stoodDown.size === 0 ? findings : findings.filter((f) => !stoodDown.has(f));
}
