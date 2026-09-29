import type { LockEntry, LockfileFormat, ParsedLockfile } from './lockfiles/types.js';
import type { DepType, ManifestDep, Protocol } from './manifest.js';
import { originOf } from './resolution.js';
import type { RepoState } from './state.js';
import { comparisonTamperSignalList } from './tamper-signals.js';
import { DepGuardError, type Diagnostic } from './types.js';
import { NPM_LOCKFILE_V1_CODE } from './lockfiles/npm.js';

export interface DepChange {
  name: string;
  registryName: string;
  specifier: string;
  kind: 'added' | 'changed';
  depType: DepType;
  protocol: Protocol;
  manifestPath: string;
  before?: LockEntry;
  after?: LockEntry;
}

// One resolved lockfile entry that is not in the before lockfile in the
// same shape, paired with the closest thing the before lockfile had for
// that name. This is the lockfile read on its own terms, independently of
// which dependencies a manifest happens to declare: in any real lockfile
// the overwhelming majority of entries are transitive, no manifest names
// them, and that is precisely where a tampered resolution hides.
//
// `name` is the key the lockfile itself uses (the installed name for npm,
// the registry name for pnpm); `packageName` is the registry name a
// manifest declares for it when one does, so a MANIFEST-DECLARED aliased
// dependency is reported under what actually installs rather than under
// the alias key. Deliberately never anything else.
//
// packageName is dep-guard's identity for this entry: every allow entry,
// every pin, every tamper/confusion/install-script dedupe key, and the
// fingerprint itself are keyed off it (fingerprint.ts). It therefore must
// never be sourced from anything the lockfile author controls without a
// manifest line vouching for it -- a `name` field an npm packages entry
// carries is exactly that, on a real pull request the author of the
// lockfile, and it is round-tripped verbatim by npm whatever it says (see
// lockfiles/npm.ts's entryFromPackageValue, and the vouching rule on
// LockEntry.lookupName in lockfiles/types.ts). An earlier version
// of this fix (issue #69) read that field into packageName for a purely
// transitive alias no manifest declares, and an independent review proved
// the consequence directly against this engine: a nested
// node_modules/host/node_modules/@corp/secret entry, @corp pinned private,
// hasInstallScript true, produces dependency-confusion and install-script
// findings; adding "name": "left-pad" to that same entry produced ZERO
// findings, because pinMismatch's scope lookup and allowClears's allow-list
// match both ran against "left-pad" instead of "@corp/secret" (see
// checks/confusion.ts's lockfile-walk loop and checks/install-script.ts's
// lockfile-walk loop, both of which read entryChange.packageName directly).
// The same trick lands an entry on an already-baselined fingerprint.
//
// See lookupName below (on LockEntry, in lockfiles/types.ts) for how a
// transitive alias's real target is recovered WITHOUT touching identity:
// only online/publish-age.ts's registry query reads it, nothing that
// decides what a finding IS.
export interface LockEntryChange {
  name: string;
  packageName: string;
  kind: 'added' | 'changed';
  manifestPath: string;
  lockfilePath: string;
  // The format of the lockfile this entry came from. Optional so a change
  // built by hand falls back to the delta's own format; set by the lockfile
  // walk because a scan can now diff several lockfiles of different formats
  // in one delta, and only the entry knows which one it belongs to.
  lockfileFormat?: LockfileFormat;
  before?: LockEntry;
  after: LockEntry;
  // The `before` entry was a guess between several the selector could not
  // tell apart (see pickCounterpart). A check must not assert a difference
  // against the guessed entry alone: the before-value it would print is a
  // fact about which candidate was picked, not about the lockfile.
  counterpartAmbiguous?: boolean;
  // Every candidate that survived the narrowing, present only when the
  // pairing was a guess. The verdict a comparison reaches is frequently
  // the same against all of them -- an entry
  // repointed to a host none of them ever resolved from is repointed
  // whichever one it succeeds -- and that verdict is a fact about the
  // lockfile that a check may report, phrased in terms of what is certain.
  // Only a difference that depends on which candidate was picked stays
  // unreported. A check that reads `before` alone here is asserting the
  // guess.
  beforeCandidates?: LockEntry[];
}

export interface DependencyDelta {
  changes: DepChange[];
  lockEntryChanges: LockEntryChange[];
  onlyBuiltAdded: string[];
  lockfileFormat: LockfileFormat;
  lockfilePath?: string;
  diagnostics: Diagnostic[];
  // Whether this delta has an earlier revision behind it at all. False in
  // audit mode, and in a staged scan of a repository with no commit yet.
  // A check reads it to know whether "this is new" is something it can
  // actually claim: with no before side every dependency and every lock
  // entry reads as added, which is true of the scan and not of the
  // repository. Deliberately not optional -- a caller building a delta has
  // to decide, because the wrong default is a check asserting a change it
  // has no evidence for.
  hasComparisonBase: boolean;
  // Package names the AFTER side's lockfile records as workspace-local
  // (RepoState.workspaceLocalNames, itself a carry of
  // ParsedLockfile.workspaceLocalNames -- see lockfiles/types.ts). A
  // dependency whose registry name is in this set was never installed from
  // a registry, so it cannot be an unpublished/hallucinated name and it
  // cannot be a typosquat of anything either; candidates.ts's
  // newRegistryNames is what both name-based checks share, and where this
  // set is actually consulted, so it stays a single fact read once rather
  // than two checks each deciding for themselves what "workspace-local"
  // means.
  workspaceLocalNames: ReadonlySet<string>;
}

const LOCKFILE_MISSING = 'lockfile-missing';
const AUDIT_NO_TAMPER_COMPARISON = 'audit-no-tamper-comparison';
const AMBIGUOUS_LOCK_ENTRY = 'delta-ambiguous-lock-entry';
const NEW_LOCK_ENTRIES = 'delta-new-lock-entries';

// workspace/catalog/link/patch/file specifiers are internal wiring, not
// registry installs, and are exempt from every registry-oriented check.
// git and url are NOT exempt: an added dependency pointing at a git or
// http source is exactly what the tamper check reports, so those deps
// have to reach it as changes.
const EXEMPT_PROTOCOLS: ReadonlySet<Protocol> = new Set<Protocol>([
  'workspace',
  'catalog',
  'link',
  'patch',
  'file',
]);

const WILDCARD_SEGMENTS: ReadonlySet<string> = new Set(['', 'x', 'X', '*']);

// A package name may hold anything a JSON key may hold, including every
// punctuation character one would reach for as a separator, so composite
// keys are built by JSON-encoding their parts rather than by joining on
// a character some package could contain.
function compositeKey(parts: string[]): string {
  return JSON.stringify(parts);
}

function depKey(manifestPath: string, depType: DepType, name: string): string {
  return compositeKey([manifestPath, depType, name]);
}

function indexDeps(stateSide: RepoState | null): Map<string, ManifestDep> {
  const index = new Map<string, ManifestDep>();
  if (stateSide === null) {
    return index;
  }
  for (const manifest of stateSide.manifests) {
    for (const dep of manifest.deps) {
      index.set(depKey(manifest.path, dep.depType, dep.name), dep);
    }
  }
  return index;
}

// The version range a specifier asks for, with the alias wrapper removed:
// "npm:lodash@^4.17.0" asks for "^4.17.0", and "npm:@scope/pkg@~2.3.0"
// for "~2.3.0" (the scope's own "@" is at index 0, never the separator).
//
// Exported for checks/hygiene.ts: an alias dependency is a registry
// install of its target at this range, not exempt the way
// workspace/link/patch/file truly are, and this is the one place that
// range is pulled out from behind the "npm:" wrapper. Takes anything
// shaped like a ManifestDep's protocol/specifier pair -- a DepChange
// satisfies that structurally, so the same function serves both without
// a second copy of this parsing to drift from.
export function versionRangeOf(dep: ManifestDep): string {
  if (dep.protocol !== 'alias') {
    return dep.specifier;
  }
  const target = dep.specifier.slice('npm:'.length);
  const separator = target.lastIndexOf('@');
  return separator > 0 ? target.slice(separator + 1) : '';
}

interface VersionConstraint {
  // The range's numeric part with wildcard tails dropped: "1.2.x" -> "1.2".
  core: string;
  // The widest prefix the range can resolve to: "^1.2.0" -> "1", since a
  // caret range may land on any 1.x version. This is deliberately coarser
  // than semver -- it can only over-match, which surfaces as an explicit
  // ambiguity diagnostic rather than a silently wrong pick.
  prefix: string;
}

function parseConstraint(range: string): VersionConstraint | null {
  // Only the first term of a compound range is considered: "1.2.0 - 1.5.0"
  // and ">=1.2.0 <2.0.0" both narrow to a single-term prefix, which is as
  // much as a no-semver-library selector can honestly claim.
  const firstTerm = range.trim().split(/[\s|]/)[0];
  const segments = firstTerm.replace(/^[v=<>^~]+/, '').split('.');
  while (segments.length > 0 && WILDCARD_SEGMENTS.has(segments[segments.length - 1])) {
    segments.pop();
  }
  if (segments.length === 0) {
    return null;
  }
  let widened = segments;
  if (firstTerm.startsWith('^')) {
    widened = segments.slice(0, 1);
  } else if (firstTerm.startsWith('~')) {
    widened = segments.slice(0, 2);
  }
  return { core: segments.join('.'), prefix: widened.join('.') };
}

function isPlausible(entry: LockEntry, constraint: VersionConstraint): boolean {
  if (entry.version === undefined) {
    return false;
  }
  return (
    entry.version === constraint.core ||
    entry.version === constraint.prefix ||
    entry.version.startsWith(`${constraint.prefix}.`)
  );
}

// The outcome of resolving one dependency against one side's lockfile. The
// ambiguity note travels with the selection rather than being pushed
// straight into the delta's diagnostics, because whether it is worth
// reporting depends on what the caller does with the selection afterwards
// (see the material flag, and computeDelta's use of it).
interface Selection {
  entry: LockEntry | undefined;
  ambiguity?: { diagnostic: Diagnostic; material: boolean };
}

// Two entries the selector could not choose between are worth telling a
// user about only when the choice could have mattered. Differing versions
// alone do not qualify -- one of them is simply the newer resolution of the
// same package from the same place. Differing integrity hashes or resolved
// URLs do: they are the two facts the tamper rules judge, so a guess
// between them is a guess about whether this scan looked at the tampered
// entry or the clean one.
function ambiguityIsMaterial(entries: LockEntry[]): boolean {
  const first = entries[0];
  return entries.some(
    (entry) => entry.integrity !== first.integrity || entry.resolvedUrl !== first.resolvedUrl
  );
}

// npm lockfiles key entries by the installed name (the manifest key),
// pnpm by the registry name, so both are tried in that order. A name can
// carry several entries when a tree resolves it to more than one version;
// the specifier picks between them where it can, and says so where it
// cannot.
function selectEntry(
  lockfile: ParsedLockfile | null,
  dep: ManifestDep,
  side: 'before' | 'after'
): Selection {
  if (lockfile === null) {
    return { entry: undefined };
  }
  const byName = lockfile.entries.get(dep.name);
  const entries =
    byName !== undefined && byName.length > 0 ? byName : lockfile.entries.get(dep.registryName);
  if (entries === undefined || entries.length === 0) {
    return { entry: undefined };
  }
  if (entries.length === 1) {
    return { entry: entries[0] };
  }

  let plausibleCount = 0;
  const constraint = parseConstraint(versionRangeOf(dep));
  if (constraint !== null) {
    const plausible = entries.filter((entry) => isPlausible(entry, constraint));
    plausibleCount = plausible.length;
    if (plausible.length === 1) {
      return { entry: plausible[0] };
    }
    if (plausible.length > 1) {
      // Several versions satisfy the range. One that the range names
      // outright is the defensible pick: it is always a legal resolution,
      // and choosing it keeps the two sides of a scan on the same entry
      // instead of flapping to whichever version happens to sort last.
      const exact = plausible.filter((entry) => entry.version === constraint.core);
      if (exact.length === 1) {
        return { entry: exact[0] };
      }
    }
  }

  const fallback = entries[entries.length - 1];
  return {
    entry: fallback,
    ambiguity: {
      material: ambiguityIsMaterial(entries),
      diagnostic: {
        code: AMBIGUOUS_LOCK_ENTRY,
        message:
          `${dep.name}: specifier "${dep.specifier}" matches ${plausibleCount} of ${entries.length} ` +
          `${side} entries in ${lockfile.path}; using version ${fallback.version ?? 'unknown'}`,
      },
    },
  };
}

// Everything about an entry that says WHICH bytes it resolves to. Two
// entries sharing this string are the same resolution; anything else is a
// difference the tamper and install-script rules have to be given the
// chance to judge.
function resolutionIdentity(entry: LockEntry): string {
  return compositeKey([
    entry.version ?? '',
    entry.resolvedUrl ?? '',
    entry.integrity ?? '',
    entry.hasInstallScript === true ? 'install-script' : '',
  ]);
}

// The before-side entry a changed entry is most fairly compared against,
// and whether picking it was a guess.
//
// Deliberately NOT a consuming match: a decoy entry appended under the same
// name at the same version must not be allowed to claim the one clean
// before entry and leave the tampered entry looking like a brand-new
// resolution with nothing to compare it to. Every changed entry is compared
// against the best before candidate independently.
//
// The narrowing runs from the strongest evidence to the weakest: a
// matching version, then an identical resolved URL, then a shared origin,
// then a matching install-script flag. A matching version means this is
// almost certainly the same package's prior resolution; an identical
// resolved URL means this entry did not move at all; a shared origin means
// the bytes still come from the same place; a matching install-script flag
// means the acquisition rule has a like-for-like comparison.
//
// The version rung is different from the other three, and deliberately
// so: it is the only one that is NOT gated on `candidates.length > 1`, so
// it runs (whenever `after.version` is defined) even when it is about to
// decide the pairing entirely on its own, with no other rung ever seeing
// the candidates it narrowed away. The other three only ever apply when
// they leave at least one candidate standing. This is load-bearing, not
// an oversight -- it is what lets docs/INVARIANTS.md's "The narrowing
// ladder is the list that is still a description" attacker analysis go
// through: a before side holding one hashed entry at one version and one
// hashless entry at another lets an attacker's entry be steered to the
// hashless candidate by matching its version, and the version rung alone
// decides that pairing before the URL, origin, or install-script rungs
// ever run.
//
// What is NOT allowed any more is the last step this used to take on its
// own -- falling through to whichever entry the lockfile happened to list
// first and then asserting a change against it. Two entries of one name
// are routine (a mirrored older copy nested under another package, a
// second version for a different peer set), and a positional pick turned
// every bump beside one into a host repoint or an install-script
// acquisition that had not happened.
interface Counterpart {
  entry: LockEntry | undefined;
  ambiguous: boolean;
  // Every candidate still standing after the narrowing above. One element
  // when the pairing was decided; several when it was a guess.
  candidates: LockEntry[];
}

function narrow(candidates: LockEntry[], keep: (entry: LockEntry) => boolean): LockEntry[] {
  const kept = candidates.filter(keep);
  return kept.length > 0 ? kept : candidates;
}

function pickCounterpart(after: LockEntry, beforeEntries: LockEntry[]): Counterpart {
  if (beforeEntries.length === 0) {
    return { entry: undefined, ambiguous: false, candidates: [] };
  }
  if (beforeEntries.length === 1) {
    return { entry: beforeEntries[0], ambiguous: false, candidates: beforeEntries };
  }

  let candidates = beforeEntries;
  if (after.version !== undefined) {
    candidates = narrow(candidates, (entry) => entry.version === after.version);
  }
  if (candidates.length > 1) {
    candidates = narrow(
      candidates,
      (entry) => entry.resolvedUrl !== undefined && entry.resolvedUrl === after.resolvedUrl
    );
  }
  if (candidates.length > 1) {
    const afterOrigin = originOf(after.resolvedUrl);
    candidates = narrow(
      candidates,
      (entry) => afterOrigin !== null && originOf(entry.resolvedUrl) === afterOrigin
    );
  }
  if (candidates.length > 1) {
    candidates = narrow(
      candidates,
      (entry) => (entry.hasInstallScript === true) === (after.hasInstallScript === true)
    );
  }

  return { entry: candidates[0], ambiguous: candidates.length > 1, candidates };
}

// A guessed pairing used to be judged here, by comparabilityKey: a
// hand-written description of the FACTS the comparison rules read -- origin,
// hash presence, hash equality, version, URL, install-script flag -- from
// which the delta decided whether the guess could have changed an answer and
// raised delta-ambiguous-lock-entry itself. It is gone, and nothing like it
// should come back.
//
// A description of rules living somewhere else stays correct only until the
// next rule reads something it does not mention, and its failure mode is
// silent and one-directional: two candidates the description calls
// identical, a check quietly dropping a verdict they disagree about, and no
// note, because the description said there was nothing to disagree about.
// That is how a forged sha512 hid beside a nested duplicate still carrying
// its pre-migration sha1 -- both candidates same origin, same version, same
// URL, both "other-hash", so the key was equal and the ladder's verdict was
// not. Four consecutive defects arrived through parallel lists of this kind.
//
// What replaces it is derivation: the delta hands every surviving candidate
// to the checks and says nothing about what a comparison will make of them,
// and the check that actually drops a verdict raises the diagnostic in the
// same breath (checks/tamper.ts#certainFindings,
// checks/install-script.ts). Drop and announcement cannot drift apart when
// they are the same event.

// Which manifest, and under which registry name, a lockfile key belongs to
// -- for the minority of entries some manifest declares. Keyed under both
// the manifest key and the registry name because npm lockfiles key their
// entries by the installed name and pnpm by the registry name. First
// declaration wins, so a name declared in two workspace manifests is
// attributed consistently rather than by iteration accident.
function attributeLockNames(manifests: RepoState['manifests']): Map<string, ManifestDep & { manifestPath: string }> {
  const attribution = new Map<string, ManifestDep & { manifestPath: string }>();
  for (const manifest of manifests) {
    for (const dep of manifest.deps) {
      for (const key of [dep.name, dep.registryName]) {
        if (!attribution.has(key)) {
          attribution.set(key, { ...dep, manifestPath: manifest.path });
        }
      }
    }
  }
  return attribution;
}

// Diffs the two lockfiles entry by entry, independently of the manifest
// walk. This is the only path by which a transitive entry -- or a second,
// tampered entry sitting beside a clean one under the same name -- reaches
// a check at all.
function diffLockEntries(
  before: ParsedLockfile | null,
  after: ParsedLockfile | null,
  manifests: RepoState['manifests']
): { changes: LockEntryChange[]; diagnostics: Diagnostic[] } {
  if (after === null) {
    return { changes: [], diagnostics: [] };
  }
  const attribution = attributeLockNames(manifests);
  const entryChanges: LockEntryChange[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const [name, afterEntries] of after.entries) {
    const beforeEntries = before?.entries.get(name) ?? [];
    const unchanged = new Set(beforeEntries.map(resolutionIdentity));
    for (const entry of afterEntries) {
      if (unchanged.has(resolutionIdentity(entry))) {
        continue;
      }
      const declared = attribution.get(name);
      const counterpart = pickCounterpart(entry, beforeEntries);
      entryChanges.push({
        name,
        // Identity comes from a manifest declaration or the lockfile key,
        // exactly as on main -- see the LockEntryChange doc comment above
        // for why entry-carried data (LockEntry.lookupName) must never
        // enter this line.
        packageName: declared?.registryName ?? name,
        kind: beforeEntries.length === 0 ? 'added' : 'changed',
        // An entry no manifest declares is anchored to the LOCKFILE, not
        // to the root package.json. Three consumers key off this path and
        // none can tell a different spelling from a different file --
        // ignorePaths matches it, the fingerprint hashes it, and the two
        // sides of a delta are paired by it -- so anchoring a transitive
        // entry to the root manifest would mean "ignorePaths:
        // [package.json]", which config.ts deliberately allows, silently
        // deleting the entire lockfile walk. The lockfile is where a
        // reader has to look for this finding, so it is where the finding
        // is; ignoring it is a comprehensible choice rather than a side
        // effect. An entry a manifest DOES declare keeps that manifest,
        // which is also what lets the two walks deduplicate one fact into
        // one finding.
        manifestPath: declared?.manifestPath ?? after.path,
        lockfilePath: after.path,
        lockfileFormat: after.format,
        before: counterpart.entry,
        after: entry,
        ...(counterpart.ambiguous
          ? { counterpartAmbiguous: true, beforeCandidates: counterpart.candidates }
          : {}),
      });
    }
  }

  return { changes: entryChanges, diagnostics };
}

// The tampering this tool exists to catch does not have to touch
// package.json at all: stripping an integrity hash or repointing a
// resolved URL inside the lockfile leaves every specifier identical. So a
// dependency whose selected lock entries disagree across the two sides is
// a change even when its specifier did not move.
//
// hasInstallScript is compared in one direction only. A flag turning on is
// an escalation a hand-edited lockfile can perform without moving the
// tarball, so it has to reach the install-script check; a flag turning off
// is pure de-escalation and would only add noise, and the parsers never
// write false, so "not true before" is the honest test for the before side.
function lockEntriesDiffer(before: LockEntry | undefined, after: LockEntry | undefined): boolean {
  if (before === undefined && after === undefined) {
    return false;
  }
  if (before === undefined || after === undefined) {
    return true;
  }
  return (
    before.version !== after.version ||
    before.integrity !== after.integrity ||
    before.resolvedUrl !== after.resolvedUrl ||
    (before.hasInstallScript !== true && after.hasInstallScript === true)
  );
}

function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const unique: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    // Both sides of a scan usually parse the same lockfile format, so a
    // standing per-format note (pnpm's missing install-script flag, say)
    // arrives twice and would otherwise be reported twice.
    const key = compositeKey([diagnostic.code, diagnostic.message]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(diagnostic);
  }
  return unique;
}

function onlyBuiltDifference(before: RepoState | null, after: RepoState): string[] {
  const known = new Set(before === null ? [] : before.onlyBuilt);
  const added: string[] = [];
  for (const name of after.onlyBuilt) {
    if (known.has(name)) {
      continue;
    }
    known.add(name);
    added.push(name);
  }
  return added;
}

// The npm lockfile parser reads a "packages" map whenever one exists, and
// reports a v1 diagnostic only for a lockfile that has none (a real v1
// lockfile, whose nested "dependencies" tree this tool does not read). A
// base side that HAD a packages map and a head side that does not is
// therefore not a legacy repository: it is a change that removes the only
// structure the tamper checks read while the package manager keeps
// installing from the head file. Treating that as a diagnostic is the
// silent pass this refuses, so it stops the scan (exit 2) instead.
//
// Two shapes are refused. Per file: an npm lockfile that had a packages map
// on the base side and has none now. Per repository: the base had a parsed
// lockfile (npm with a packages map, or pnpm, with entries) and the head has
// lockfiles but not one of them is parsed -- only v1 npm files, manifest-only
// formats (yarn, bun) or a binary one -- so swapping the tampered lockfile
// for a format this tool cannot read is not a way out. A head with NO
// lockfile at all is deliberately not this rule's case: that is the
// lockfile-missing path, handled separately.
// Why the scan stops, and what a maintainer with a genuine migration (npm to
// yarn or bun, say) does about it. The refusal is deliberate and cannot be
// escaped from inside the tree being judged: switching to a format this
// tool cannot read is exactly how a tampered lockfile would escape
// inspection.
const DOWNGRADE_REMEDY =
  'This is refused because a format switch is how a tampered lockfile escapes inspection. ' +
  'For a genuine migration, either (a) review the new lockfile by hand and merge with an admin ' +
  'override of the failing check, or (b) first land a separate, reviewed pull request that relaxes ' +
  'the gate on the base branch (under conductor, enforce: false on the dependencies gate in ' +
  '.guardrails.yaml; for the standalone action, continue-on-error on the workflow step), then land ' +
  'the migration, then restore the setting in a third pull request. The migration pull request ' +
  'cannot relax the gate for itself, and an advisory mode does not help: this is a could-not-run ' +
  '(exit 2), not a finding.';

function refuseLockfileDowngrade(before: RepoState | null, after: RepoState): void {
  if (before === null) {
    return;
  }
  const isParsed = (lockfile: ParsedLockfile): boolean =>
    (lockfile.format === 'npm' && !hasV1Diagnostic(lockfile)) || lockfile.format === 'pnpm';
  const beforeParsed = lockfilesOf(before).filter(
    (lockfile) => isParsed(lockfile) && (lockfile.format === 'npm' || lockfile.entries.size > 0)
  );
  const afterAll = lockfilesOf(after);
  if (beforeParsed.length > 0 && afterAll.length > 0 && !afterAll.some(isParsed)) {
    throw new DepGuardError(
      `${afterAll.map((lockfile) => lockfile.path).join(', ')}: the base side of this scan had a ` +
        `lockfile this tool reads (${beforeParsed[0].path}) and this side has only lockfiles it cannot ` +
        'read (a v1 npm lockfile, or a yarn, bun or binary one), so the lockfile-backed checks would ' +
        'silently stop while the package manager keeps installing; refusing to report a clean pass. ' +
        DOWNGRADE_REMEDY,
      'lockfile-downgrade'
    );
  }
  const beforeNpm = lockfilesOf(before).filter(
    (lockfile) => lockfile.format === 'npm' && !hasV1Diagnostic(lockfile)
  );
  if (beforeNpm.length === 0) {
    return;
  }
  for (const lockfile of lockfilesOf(after)) {
    if (lockfile.format !== 'npm' || !hasV1Diagnostic(lockfile)) {
      continue;
    }
    // Same path first, then any parsed npm lockfile on the base side: a
    // package-lock.json replaced by an npm-shrinkwrap.json is the same
    // downgrade under a different name.
    const counterpart = beforeNpm.find((candidate) => candidate.path === lockfile.path) ?? beforeNpm[0];
    throw new DepGuardError(
      `${lockfile.path}: the base side of this scan has a "packages" map (${counterpart.path}) and this ` +
        'side has none, so the lockfile-backed checks would silently stop reading it while npm ' +
        'still installs from it; refusing to report a clean pass. ' +
        DOWNGRADE_REMEDY,
      'lockfile-downgrade'
    );
  }
}

function hasV1Diagnostic(lockfile: ParsedLockfile): boolean {
  return lockfile.diagnostics.some((diagnostic) => diagnostic.code === NPM_LOCKFILE_V1_CODE);
}

function lockfilesOf(state: RepoState): ParsedLockfile[] {
  return [...(state.lockfile === null ? [] : [state.lockfile]), ...(state.extraLockfiles ?? [])];
}

// Diffs two parsed sides into the set of added and changed dependencies.
// A before of null is audit mode: nothing to compare against, so every
// non-exempt dependency reads as added. Removals are deliberately absent
// -- dropping a dependency cannot introduce any of the risks this tool
// looks for.
//
// Two independent walks, and the second is not an optimisation of the
// first. The manifest walk answers "which declared dependencies moved",
// which is what the name-based and specifier-based rules need. The lockfile
// walk (diffLockEntries) answers "which resolutions moved", which is what
// the tamper and install-script rules need -- and those two questions have
// different answers, because a lockfile is mostly entries no manifest
// declares and can hold several entries under one name. Deriving the second
// answer from the first is the composition failure that let a tampered
// transitive entry, and a tampered entry hidden behind a same-version
// decoy, both scan clean.
export function computeDelta(before: RepoState | null, after: RepoState): DependencyDelta {
  refuseLockfileDowngrade(before, after);
  const beforeDeps = indexDeps(before);
  const deltaDiagnostics: Diagnostic[] = [];
  const changes: DepChange[] = [];

  for (const manifest of after.manifests) {
    for (const dep of manifest.deps) {
      if (EXEMPT_PROTOCOLS.has(dep.protocol)) {
        continue;
      }
      // Keyed by manifest path, section, and name together: the same name
      // legitimately appears in several sections and several workspace
      // manifests, and each of those is its own dependency.
      const previous = beforeDeps.get(depKey(manifest.path, dep.depType, dep.name));

      // Selection diagnostics are held aside until this dependency's fate is
      // known: every dependency is looked up in both lockfiles, and an
      // ambiguity under a package nobody touched is usually noise.
      //
      // The before lockfile resolved the before specifier, so the before
      // side selects with the dependency as it was, not as it now is --
      // otherwise a bumped range picks the wrong old entry and the tamper
      // check compares two unrelated resolutions.
      const beforeSelection =
        before === null
          ? { entry: undefined }
          : selectEntry(before.lockfile, previous ?? dep, 'before');
      const afterSelection = selectEntry(after.lockfile, dep, 'after');
      const selections = [beforeSelection, afterSelection];

      const specifierHeld = previous !== undefined && previous.specifier === dep.specifier;
      if (specifierHeld && !lockEntriesDiffer(beforeSelection.entry, afterSelection.entry)) {
        // T8-2: this dependency leaves no other trace in the scan, so an
        // ambiguity that could have decided whether the tampered entry or
        // the clean one was compared has to survive the skip. A merely
        // version-level ambiguity still does not.
        for (const selection of selections) {
          if (selection.ambiguity?.material === true) {
            deltaDiagnostics.push(selection.ambiguity.diagnostic);
          }
        }
        continue;
      }

      for (const selection of selections) {
        if (selection.ambiguity !== undefined) {
          deltaDiagnostics.push(selection.ambiguity.diagnostic);
        }
      }
      changes.push({
        name: dep.name,
        registryName: dep.registryName,
        specifier: dep.specifier,
        kind: previous === undefined ? 'added' : 'changed',
        depType: dep.depType,
        protocol: dep.protocol,
        manifestPath: manifest.path,
        before: beforeSelection.entry,
        after: afterSelection.entry,
      });
    }
  }

  const lockfileFormat: LockfileFormat = after.lockfile === null ? 'none' : after.lockfile.format;

  // The rule is that lockfile checks skip WITH a diagnostic. Without this,
  // a repository that has no lockfile at all would produce output
  // byte-identical to one whose lockfile checks ran and found nothing --
  // the two most different possible outcomes, spelled the same way.
  if (after.lockfile === null) {
    deltaDiagnostics.push({
      code: LOCKFILE_MISSING,
      message:
        'no lockfile was found, so the lockfile-tamper and install-script checks had nothing to read and were skipped; the manifest-level checks still ran',
    });
  } else if (before === null && (lockfileFormat === 'npm' || lockfileFormat === 'pnpm')) {
    // With no before side, every tamper signal that works by comparing
    // two resolutions is structurally unreachable -- and auditing an
    // adopted repository is exactly when a user has no other way to learn
    // that. Audit mode is the usual way to get here; a staged scan of a
    // repository with no commit yet is the other.
    deltaDiagnostics.push({
      code: AUDIT_NO_TAMPER_COMPARISON,
      message:
        `${after.lockfile.path}: this scan has no earlier revision to compare against, so the ` +
        `lockfile-tamper signals that work by comparison (${comparisonTamperSignalList()}) could ` +
        'not be evaluated for any entry in this lockfile; only the specifier-based git-source and ' +
        'url-source signals ran',
    });
  }

  const lockEntries = diffLockEntries(before?.lockfile ?? null, after.lockfile, after.manifests);

  // Every other npm or pnpm lockfile at the root is diffed the same way,
  // against the before-side lockfile it corresponds to (same path first,
  // then the same format). Which file an install honours is the package
  // manager's choice, not something this scan can see, so a clean one must
  // not stand in for a tampered one. Their entries join the same
  // lockEntryChanges list the checks already walk, each tagged with its own
  // path and format.
  const primaryChanges = [...lockEntries.changes];
  const beforeLockfiles = before === null ? [] : lockfilesOf(before);
  for (const extra of after.extraLockfiles ?? []) {
    const counterpart =
      beforeLockfiles.find((candidate) => candidate.path === extra.path) ??
      beforeLockfiles.find((candidate) => candidate.format === extra.format) ??
      // A lockfile that exists only on the head side (a new pnpm-lock.yaml
      // beside an existing package-lock.json) has no same-path or
      // same-format counterpart, and comparing it to nothing would wave it
      // through as all-added. The base's primary lockfile, whatever its
      // format, is the closest thing the base had to say about these names.
      before?.lockfile ??
      null;
    if (before === null) {
      deltaDiagnostics.push({
        code: AUDIT_NO_TAMPER_COMPARISON,
        message:
          `${extra.path}: this scan has no earlier revision to compare against, so the ` +
          `lockfile-tamper signals that work by comparison (${comparisonTamperSignalList()}) could ` +
          'not be evaluated for any entry in this lockfile; only the specifier-based git-source and ' +
          'url-source signals ran',
      });
    }
    const extraDiff = diffLockEntries(counterpart, extra, after.manifests);
    const uncomparable = extraDiff.changes.filter((entry) => entry.before === undefined).length;
    if (before !== null && uncomparable > 0) {
      deltaDiagnostics.push({
        code: NEW_LOCK_ENTRIES,
        message:
          `${extra.path}: ${uncomparable} lockfile entr${uncomparable === 1 ? 'y is' : 'ies are'} ` +
          'new in this change with no earlier resolution behind them, so the lockfile-tamper signals ' +
          `that work by comparison (${comparisonTamperSignalList()}) could not be evaluated for ` +
          `${uncomparable === 1 ? 'it' : 'them'}`,
      });
    }
    lockEntries.changes.push(...extraDiff.changes);
    lockEntries.diagnostics.push(...extraDiff.diagnostics);
  }

  // An entry with no before side has nothing for the comparison-based
  // signals to read, exactly as in audit mode -- and in a delta mode that
  // gap used to be silent, so a fresh install was indistinguishable from a
  // scan that had evaluated every entry. Audit mode already says this for
  // its whole lockfile (AUDIT_NO_TAMPER_COMPARISON above), so it is not
  // said twice there.
  //
  // One aggregate note, deliberately not one per entry: a fresh install
  // adds hundreds of entries, and a per-entry note would bury the
  // diagnostics that name a specific thing the engine could not judge.
  // Judging a new entry on its own merits, rather than by comparison, is a
  // separate rule and is not in this scan's scope.
  const uncomparableAdded = primaryChanges.filter((entry) => entry.before === undefined).length;
  if (before !== null && uncomparableAdded > 0 && after.lockfile !== null) {
    deltaDiagnostics.push({
      code: NEW_LOCK_ENTRIES,
      message:
        `${after.lockfile.path}: ${uncomparableAdded} lockfile entr${uncomparableAdded === 1 ? 'y is' : 'ies are'} ` +
        'new in this change with no earlier resolution behind them, so the lockfile-tamper signals ' +
        `that work by comparison (${comparisonTamperSignalList()}) could not be evaluated for ` +
        `${uncomparableAdded === 1 ? 'it' : 'them'}`,
    });
  }

  return {
    changes,
    lockEntryChanges: lockEntries.changes,
    onlyBuiltAdded: onlyBuiltDifference(before, after),
    lockfileFormat,
    hasComparisonBase: before !== null,
    workspaceLocalNames: after.workspaceLocalNames,
    lockfilePath: after.lockfile?.path,
    diagnostics: dedupeDiagnostics([
      ...(before?.lockfile?.diagnostics ?? []),
      ...(after.lockfile?.diagnostics ?? []),
      ...(before?.extraLockfiles ?? []).flatMap((extra) => extra.diagnostics),
      ...(after.extraLockfiles ?? []).flatMap((extra) => extra.diagnostics),
      ...deltaDiagnostics,
      ...lockEntries.diagnostics,
    ]),
  };
}
