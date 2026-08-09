import type { DepChange } from '../delta.js';
import type { Finding } from '../types.js';
import { agreementAcrossCandidates } from './agreement.js';
import { isAllowed } from './allow.js';
import type { Check, CheckContext } from './types.js';

// Install-script escalation: a dependency that now runs an npm lifecycle
// script (preinstall/install/postinstall) it did not run before. That is
// an arbitrary-code-execution surface, so ACQUIRING it is the signal, not
// merely having it -- a routine version bump of a package that already
// ran scripts must stay silent, or every refresh of esbuild/sharp would
// file a finding on every single scan.
//
// The two lockfile formats carry this fact differently. npm records
// hasInstallScript per resolved entry, so the check below compares
// before/after entries directly. pnpm v9 dropped that field from the
// lockfile entirely (see lockfiles/pnpm.ts's standing
// pnpm-no-install-script-flag diagnostic); the only signal pnpm still
// gives is onlyBuiltDependencies, the workspace-wide allowlist of
// packages pnpm is permitted to run install scripts for at all, so a name
// newly added there is reported instead. yarn and bun record neither, and
// their own diagnostics already say so upstream, so this check has
// nothing further to add for those formats.

const PNPM_DIAGNOSTIC_CODE = 'pnpm-no-install-script-flag';

// The delta owns this code; the decision to raise it belongs to whichever
// check had to drop something, because only that check knows it dropped
// anything. See checks/tamper.ts#certainFindings for why predicting it from
// outside the rules kept going wrong.
const AMBIGUOUS_LOCK_ENTRY_CODE = 'delta-ambiguous-lock-entry';

// The one verdict this rule's per-candidate comparison can reach. It exists
// as a named value because the intersection identifies verdicts by signal,
// and a rule with a single verdict still has to name it.
const ACQUISITION_SIGNAL = 'acquisition';

// The setting an onlyBuiltDependencies finding reports on lives in
// pnpm-workspace.yaml, merged with every workspace manifest's own
// pnpm.onlyBuiltDependencies block before this check ever sees it (see
// lockfiles/pnpm.ts#parseOnlyBuilt) -- there is no single package.json to
// attribute the change to. Naming pnpm-workspace.yaml as manifestPath
// would point at a file that might not exist at all (a repo can set this
// entirely from the root package.json's own "pnpm" field, with no
// pnpm-workspace.yaml on disk); the root manifest is used as manifestPath
// instead, since that always exists, and which file the setting actually
// lives in is still named in details.source.
const ROOT_MANIFEST_PATH = 'package.json';
const ONLY_BUILT_SOURCE = 'pnpm-workspace.yaml';

// Git dependencies are not exempt from the delta, and npm records
// hasInstallScript for them same as any registry-resolved entry, so a
// credential-bearing git specifier (git+https://x-access-token:TOKEN@...)
// could reach an install-script finding through details.specifier
// verbatim -- the same leak tamper.ts guards against for its own
// specifiers. Only the host is kept for git/url protocols, the same
// treatment tamper.ts uses -- .host never carries userinfo the way the
// full specifier string can. Every other protocol's specifier (a version
// range or an npm: alias target) carries no credential shape, so it is
// kept as-is.
function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.host === '' ? null : parsed.host;
  } catch {
    return null;
  }
}

function specifierDetail(change: DepChange): { specifier: string } | { host: string | null } {
  if (change.protocol === 'git' || change.protocol === 'url') {
    return { host: hostOf(change.specifier) };
  }
  return { specifier: change.specifier };
}

function acquiredInstallScript(change: DepChange): boolean {
  if (change.after?.hasInstallScript !== true) {
    return false;
  }
  // A dependency newly declared direct is reported the first time it is
  // added, even if it already existed transitively and so already
  // carries a populated `before` entry -- presence of `before` on an
  // added dep is not proof the flag was already known about.
  if (change.kind === 'added') {
    return true;
  }
  // Otherwise this is a changed dependency: only report a flag turning
  // on, never a bump that leaves an already-true flag true.
  return change.before?.hasInstallScript !== true;
}

// What this check can honestly say about a flagged entry, given whether
// the scan has an earlier revision behind it.
//
// With no comparison base -- an audit sweep, or a staged scan of a
// repository with no commit yet -- every dependency and every lock entry
// reads as added, so "now runs an install script that it did not run
// before" is a true fact wearing a false sentence, filed once per flagged
// package in the whole tree. The fact is still worth having: which
// dependencies execute code at install time is most of what someone
// adopting a repository wants to know. So it is stated as a standing fact
// rather than as an event, and at low, which sits under the default medium
// gate -- a first sweep must not be unusable because of coverage that
// announced itself correctly.
//
// The delta modes are untouched: there, an acquisition really did happen
// between two revisions, and it blocks.
function presenceReport(hasComparisonBase: boolean, acquisitionSignal: 'added' | 'flag-acquired'): {
  severity: Finding['severity'];
  signal: string;
  message: (packageName: string) => string;
} {
  if (hasComparisonBase) {
    return {
      severity: 'high',
      signal: acquisitionSignal,
      message: (packageName) => `"${packageName}" now runs an install script that it did not run before.`,
    };
  }
  return {
    severity: 'low',
    signal: 'present',
    message: (packageName) =>
      `"${packageName}" runs an install script when it is installed; this scan has no earlier ` +
      'revision to compare against, so it cannot say whether that is new.',
  };
}

// The acquisition this check could not judge, named, with the candidates
// counted rather than named -- the same rule that keeps one candidate's
// origin out of a tamper message.
function noteSuppressedByPairing(
  ctx: CheckContext,
  packageName: string,
  candidateCount: number
): void {
  const lockfilePath = ctx.delta.lockfilePath;
  const inLockfile = lockfilePath === undefined ? '' : ` in ${lockfilePath}`;
  const diagnostic = {
    code: AMBIGUOUS_LOCK_ENTRY_CODE,
    message:
      `"${packageName}": each of the ${candidateCount} earlier entries recorded under this name` +
      `${inLockfile} could be the counterpart of a changed entry, and at least one of them already ` +
      'ran an install script, so this scan cannot say whether running one is new for it',
  };
  for (const existing of ctx.diagnostics) {
    if (existing.code === diagnostic.code && existing.message === diagnostic.message) {
      return;
    }
  }
  ctx.diagnostics.push(diagnostic);
}

function passThroughDiagnostic(ctx: CheckContext): void {
  const diagnostic = ctx.delta.diagnostics.find((entry) => entry.code === PNPM_DIAGNOSTIC_CODE);
  if (diagnostic === undefined) {
    return;
  }
  for (const existing of ctx.diagnostics) {
    if (existing.code === diagnostic.code && existing.message === diagnostic.message) {
      return;
    }
  }
  ctx.diagnostics.push(diagnostic);
}

export const installScriptCheck: Check = (ctx) => {
  const { delta, config } = ctx;
  const findings: Omit<Finding, 'fingerprint'>[] = [];

  if (delta.lockfileFormat === 'npm') {
    // Same fingerprint-collision hazard as candidates.ts's name checks: two
    // DepChanges resolving to the same (manifestPath, registryName) --
    // two aliases retargeting one package, or one name declared in both
    // dependencies and devDependencies -- produce findings that hash
    // identically (the fingerprint never sees depType or which manifest
    // key produced the change), so the second one has to be dropped here
    // rather than left to collide silently under one baseline entry.
    const seen = new Set<string>();
    const report = (finding: Omit<Finding, 'fingerprint'>): void => {
      const key = JSON.stringify([finding.manifestPath, finding.packageName]);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      findings.push(
        delta.lockfilePath === undefined ? finding : { ...finding, lockfilePath: delta.lockfilePath }
      );
    };

    for (const change of delta.changes) {
      if (!acquiredInstallScript(change) || isAllowed(change.registryName, config.allow)) {
        continue;
      }
      // 'added' and 'flag-acquired' are genuinely different signals
      // sharing one rule, and each needs its own stable details.signal for
      // the same fingerprint-collision reason the tamper and confusion
      // checks do.
      const shape = presenceReport(
        delta.hasComparisonBase,
        change.kind === 'added' ? 'added' : 'flag-acquired'
      );
      report({
        ruleId: 'install-script',
        severity: shape.severity,
        packageName: change.registryName,
        message: shape.message(change.registryName),
        manifestPath: change.manifestPath,
        details: {
          signal: shape.signal,
          ...specifierDetail(change),
          depType: change.depType,
          kind: change.kind,
        },
      });
    }

    // The flag lives on a lockfile entry, and a hand edit can set it on
    // any of them. Almost every entry in a real lockfile is transitive, so
    // reading only the entries some manifest declares left the acquisition
    // event -- the whole point of this rule -- invisible across the great
    // majority of the tree. The manifest loop above stays because it is the
    // one that knows the specifier and the dependency section; the dedupe
    // in report() collapses the two views of a declared dependency.
    for (const entryChange of delta.lockEntryChanges) {
      if (entryChange.after.hasInstallScript !== true) {
        continue;
      }
      // Acquisition is a comparison, and the delta cannot always say which
      // earlier entry this one succeeds. What that costs is only the
      // ability to point at one of them -- if NONE of the candidates ran an
      // install script, then this entry did not run one before whichever of
      // them it succeeds, and the acquisition is a fact about the lockfile.
      //
      // This runs through the same intersection tamper.ts uses rather than
      // through a local approximation of it. A local approximation --
      // some(flagged) and more than one candidate -- gets the all-flagged
      // cell wrong in both directions at once: it suppresses correctly but
      // then announces an ambiguity, when in fact every candidate agrees
      // there was no acquisition and the scan CAN say so. A bump of a
      // scripted package beside a flagged nested duplicate is routine, so
      // that would fire on nearly every refresh.
      const candidates =
        entryChange.beforeCandidates ??
        (entryChange.before === undefined ? [] : [entryChange.before]);
      if (entryChange.kind === 'changed') {
        const { agreed, dropped } = agreementAcrossCandidates(
          candidates,
          // The whole comparison this rule makes, per candidate: an entry
          // that already ran scripts yields no acquisition, one that did not
          // yields one.
          (candidate) => (candidate.hasInstallScript === true ? [] : [ACQUISITION_SIGNAL]),
          (signal) => signal
        );
        if (dropped.length > 0) {
          // The drop and the admission are one event, exactly as in tamper.
          noteSuppressedByPairing(ctx, entryChange.packageName, candidates.length);
        }
        if (agreed.length === 0) {
          continue;
        }
      }
      if (isAllowed(entryChange.packageName, config.allow)) {
        continue;
      }
      const shape = presenceReport(
        delta.hasComparisonBase,
        entryChange.kind === 'added' ? 'added' : 'flag-acquired'
      );
      report({
        ruleId: 'install-script',
        severity: shape.severity,
        packageName: entryChange.packageName,
        message: shape.message(entryChange.packageName),
        manifestPath: entryChange.manifestPath,
        details: {
          signal: shape.signal,
          kind: entryChange.kind,
          lockfileEntry: entryChange.name,
        },
      });
    }
    return findings;
  }

  if (delta.lockfileFormat === 'pnpm') {
    for (const name of delta.onlyBuiltAdded) {
      if (isAllowed(name, config.allow)) {
        continue;
      }
      // Same rule as the npm branch, in the sibling code path: with no
      // earlier revision behind the scan, onlyBuiltDifference reads the
      // whole allowlist as added, so "newly added" is a sentence about the
      // scan rather than about the repository. The allowlist is short
      // enough that this could never wreck a sweep the way the per-entry
      // flag could -- it is fixed because the two paths saying different
      // things about the same situation is exactly the drift the
      // invariants exist to stop.
      const present = !delta.hasComparisonBase;
      findings.push({
        ruleId: 'install-script',
        severity: present ? 'low' : 'high',
        packageName: name,
        message: present
          ? `"${name}" is in pnpm's onlyBuiltDependencies allowlist, so pnpm runs its install scripts; this scan has no earlier revision to compare against, so it cannot say whether that is new.`
          : `"${name}" was newly added to pnpm's onlyBuiltDependencies allowlist, so pnpm will now run its install scripts.`,
        manifestPath: ROOT_MANIFEST_PATH,
        details: {
          signal: present ? 'present' : 'only-built-added',
          source: ONLY_BUILT_SOURCE,
        },
      });
    }
    // pnpm carries no per-entry hasInstallScript flag, so the branch above
    // this one cannot see a flag-acquisition event the npm branch can.
    // Rather than go quiet about that gap, the standing diagnostic the
    // pnpm parser already raised is forwarded so the orchestrator can
    // surface "this coverage was skipped" instead of the scan looking
    // clean by omission -- but only when there was something in this
    // delta the check would otherwise have had reason to look at.
    if (delta.changes.length > 0) {
      passThroughDiagnostic(ctx);
    }
    return findings;
  }

  // yarn/bun: neither format records install-script metadata this tool can
  // read, and the diagnostics saying so are set upstream by their own
  // loaders. 'none' is different: there is no parser to have said anything,
  // so the delta raises its own lockfile-missing diagnostic for it.
  return findings;
};
