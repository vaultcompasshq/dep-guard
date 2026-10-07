import type { LockEntry, LockfileFormat, ParsedLockfile } from './lockfiles/types.js';
import type { DepType, ManifestDep, Protocol } from './manifest.js';
import { originOf } from './resolution.js';
import { isReadLockfile, type LockfileInventoryEntry, type RepoState } from './state.js';
import { comparisonTamperSignalList } from './tamper-signals.js';
import { DepGuardError, type Diagnostic } from './types.js';

export interface DepChange {
  name: string;
  registryName: string;
  specifier: string;
  kind: 'added' | 'changed';
  depType: DepType;
  protocol: Protocol;
  manifestPath: string;
  // The lockfile the before and after entries were selected from: the one
  // that records this manifest (lockfileForManifest). Absent when no read
  // lockfile covers the manifest. A finding about this change names this
  // file, not the delta's primary lockfile, which can be a different one
  // when lockfiles sit in several directories.
  lockfilePath?: string;
  lockfileFormat?: LockfileFormat;
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
function parentDirOf(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? '' : filePath.slice(0, slash);
}

function isPackageJson(filePath: string): boolean {
  return filePath === 'package.json' || filePath.endsWith('/package.json');
}

// The lockfile that records this package.json: the one in the same
// directory, else the nearest ancestor. A Python manifest is not covered
// by an npm lockfile. A manifest that has its own lockfile is not covered
// by an ancestor's.
function lockfileForManifest(
  manifestPath: string,
  lockfiles: readonly ParsedLockfile[]
): ParsedLockfile | null {
  if (!isPackageJson(manifestPath)) {
    return null;
  }
  const readable = lockfiles.filter(isReadLockfile);
  let dir = parentDirOf(manifestPath);
  for (;;) {
    const match = readable.find((lockfile) => parentDirOf(lockfile.path) === dir);
    if (match !== undefined) {
      return match;
    }
    if (dir === '') {
      return null;
    }
    dir = parentDirOf(dir);
  }
}

function manifestsWithOwnLockfile(
  manifests: RepoState['manifests'],
  lockfiles: readonly ParsedLockfile[]
): Set<string> {
  const dirs = new Set(lockfiles.filter(isReadLockfile).map((lockfile) => parentDirOf(lockfile.path)));
  const owned = new Set<string>();
  for (const manifest of manifests) {
    if (dirs.has(parentDirOf(manifest.path))) {
      owned.add(manifest.path);
    }
  }
  return owned;
}

function attributeLockNames(
  manifests: RepoState['manifests'],
  lockfilePath: string,
  owned: ReadonlySet<string>
): Map<string, ManifestDep & { manifestPath: string }> {
  const dir = parentDirOf(lockfilePath);
  // Same directory first, then manifests that do not have a lockfile of
  // their own (workspace members recorded in the root lockfile). A
  // manifest that sits beside a different lockfile is not a declaration
  // of this file's entries.
  const ordered = [
    ...manifests.filter((manifest) => parentDirOf(manifest.path) === dir),
    ...manifests.filter((manifest) => parentDirOf(manifest.path) !== dir && !owned.has(manifest.path)),
  ];
  const attribution = new Map<string, ManifestDep & { manifestPath: string }>();
  for (const manifest of ordered) {
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
  manifests: RepoState['manifests'],
  lockfiles: readonly ParsedLockfile[]
): { changes: LockEntryChange[]; diagnostics: Diagnostic[] } {
  if (after === null) {
    return { changes: [], diagnostics: [] };
  }
  const attribution = attributeLockNames(manifests, after.path, manifestsWithOwnLockfile(manifests, lockfiles));
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

// The lockfile downgrade rule. A lockfile is READ when this tool parses its
// entries (npm with a "packages" map, or pnpm) and UNREAD otherwise (a v1
// npm file, yarn, bun, a binary one, or a lockfile name that is not a
// readable file). A side has COVERAGE when a read lockfile on it has at
// least one entry.
//
// When the comparison side has coverage, the side being judged must:
//
//   (unread bytes) not carry an unread lockfile at the repository root
//   whose bytes differ from the same path on the comparison side, a path
//   that is new counting as different; and
//
//   (coverage) keep coverage, unless no manifest on it declares a
//   dependency a lockfile would record.
//
// Independently of coverage, an npm lockfile that this tool read on the
// comparison side may not turn into an unread npm lockfile, under its own
// name or another npm name. Any violation stops the scan (exit 2), because
// the run could not judge what the package manager will install. It is
// never a finding: a finding could be baselined, and baselining a format
// switch would switch the lockfile checks off for every later change.
//
// Identity is the git blob id from the lockfile inventory, never decoded
// text, so a binary lockfile changed in an invalid byte still differs.
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

// Coverage comes from lockfile files. A further document of a pnpm
// lockfile (the one pnpm writes for its own version) is read and checked,
// but its entries do not stand in for the project's.
function coveringLockfiles(state: RepoState): ParsedLockfile[] {
  return lockfilesOf(state).filter(
    (lockfile) => lockfile.documentOf === undefined && isReadLockfile(lockfile) && lockfile.entries.size > 0
  );
}

// Dependencies a lockfile would record: every non-exempt dependency of
// every manifest on this side, in any section (peerDependencies included:
// npm 7 and later installs and locks them), minus names of workspace
// packages this side actually discovered as manifests. The workspace
// exemption comes from the manifests, never from the lockfile's own
// "link" entries, which the lockfile author controls.
function declaredLockableDeps(
  state: RepoState,
  include: (manifestPath: string) => boolean = () => true
): { manifests: string[]; count: number } {
  const workspaceNames = new Set(
    state.manifests.map((manifest) => manifest.name).filter((name): name is string => name !== undefined)
  );
  const manifestPaths = new Set<string>();
  let count = 0;
  for (const manifest of state.manifests) {
    if (!include(manifest.path)) {
      continue;
    }
    for (const dep of manifest.deps) {
      // pypi dependencies are not recorded in an npm or pnpm lockfile, so
      // they do not count as coverage the lockfile downgrade rule can lose.
      if (EXEMPT_PROTOCOLS.has(dep.protocol) || dep.protocol === 'pypi' || workspaceNames.has(dep.registryName)) {
        continue;
      }
      count += 1;
      manifestPaths.add(manifest.path);
    }
  }
  return { manifests: [...manifestPaths], count };
}

// The nearest directory in `dirs` that is the manifest's own directory or
// an ancestor of it, or null when none is. `dirs` holds directories that
// have a read lockfile with entries; the result is the directory whose
// lockfile records this manifest's dependencies, if any does.
function nearestCoveringDir(manifestPath: string, dirs: ReadonlySet<string>): string | null {
  let dir = parentDirOf(manifestPath);
  for (;;) {
    if (dirs.has(dir)) {
      return dir;
    }
    if (dir === '') {
      return null;
    }
    dir = parentDirOf(dir);
  }
}

function coveringDirs(state: RepoState): Set<string> {
  return new Set(coveringLockfiles(state).map((lockfile) => parentDirOf(lockfile.path)));
}

// Root lockfiles that are unread on `after` and whose bytes differ from the
// same path on `before`. A path new on `after`, a path read on `before`,
// and an unknown identity on either side all count as different.
function changedUnreadRootLockfiles(before: RepoState, after: RepoState): string[] {
  const beforeRoot = new Map(
    inventoryOf(before)
      .filter((entry) => !isBelowRoot(entry))
      .map((entry) => [entry.path, entry])
  );
  return inventoryOf(after)
    .filter((entry) => !isBelowRoot(entry) && !entry.read)
    .filter((entry) => {
      const previous = beforeRoot.get(entry.path);
      return (
        previous === undefined ||
        previous.read ||
        previous.blobId === null ||
        entry.blobId === null ||
        previous.blobId !== entry.blobId
      );
    })
    .map((entry) => entry.path);
}

// A read lockfile can still carry content this tool does not read: in a
// multi-document pnpm lockfile, everything outside the project document.
// Those bytes count as unread bytes of the file, compared in order with
// the same path on `before` (absent there counts as different), so any
// change to them is the same violation as a changed unread file. Returns
// plain lockfile paths.
function changedSkippedDocuments(before: RepoState, after: RepoState): string[] {
  const beforeByPath = new Map(lockfilesOf(before).map((lockfile) => [lockfile.path, lockfile]));
  const changed: string[] = [];
  for (const lockfile of lockfilesOf(after)) {
    // Either side holding several documents is enough to compare: a file
    // that drops its other documents changes them too.
    const previous = beforeByPath.get(lockfile.path)?.unreadText;
    if (lockfile.unreadText === undefined && previous === undefined) {
      continue;
    }
    if (previous !== lockfile.unreadText) {
      changed.push(lockfile.path);
    }
  }
  return changed;
}

// One acknowledgement entry, "PATH:BLOBID", or null when the bytes have no
// known identity and so cannot be acknowledged at all.
function acknowledgementFor(entryPath: string, blobId: string | null | undefined): string | null {
  return blobId === null || blobId === undefined ? null : `${entryPath}:${blobId}`;
}

function rootBlobId(state: RepoState, entryPath: string): string | null {
  return inventoryOf(state).find((entry) => entry.path === entryPath)?.blobId ?? null;
}

// `acknowledged` holds the acknowledgedLockfiles entries read from the
// comparison side's config (never the judged side's). An acknowledgement
// clears this rule for exactly the bytes it names and for nothing else: it
// is not a finding filter, and every check still runs on the lockfiles
// this tool reads. Each use is announced in `notes`.
function refuseLockfileDowngrade(
  before: RepoState | null,
  after: RepoState,
  acknowledged: ReadonlySet<string>,
  notes: Diagnostic[],
  source: AcknowledgementSource
): void {
  if (before === null) {
    return;
  }
  const baseCovering = coveringLockfiles(before);
  // Coverage is judged per directory: a read lockfile in apps/web says
  // nothing about what the root installs, so it neither makes a root
  // yarn.lock edit a downgrade nor stands in for a root lockfile that is
  // gone. The root directory is the empty path.
  const baseDirs = coveringDirs(before);
  const afterDirs = coveringDirs(after);
  // file path -> how the message names it
  const unreadChanged = new Map<string, string>();

  // An npm lockfile read on the comparison side that is now an unread npm
  // lockfile, at the same path or under the other npm name.
  const beforeReadNpm = lockfilesOf(before).filter(
    (lockfile) => lockfile.format === 'npm' && isReadLockfile(lockfile)
  );
  if (beforeReadNpm.length > 0) {
    for (const lockfile of lockfilesOf(after)) {
      if (lockfile.format === 'npm' && !isReadLockfile(lockfile)) {
        unreadChanged.set(lockfile.path, lockfile.path);
      }
    }
  }

  let coverageLost = false;
  let declared = { manifests: [] as string[], count: 0 };
  // Directories whose read lockfile on the comparison side is gone on the
  // judged side while a manifest it recorded still declares dependencies.
  const lostDirs = new Set<string>();
  if (baseCovering.length > 0) {
    if (baseDirs.has('')) {
      for (const entryPath of changedUnreadRootLockfiles(before, after)) {
        unreadChanged.set(entryPath, entryPath);
      }
    }
    for (const entryPath of changedSkippedDocuments(before, after)) {
      if (baseDirs.has(parentDirOf(entryPath))) {
        unreadChanged.set(entryPath, `${entryPath} (a YAML document in it other than the project lockfile)`);
      }
    }
    // A manifest whose nearest read lockfile on the comparison side sits in
    // a directory that has no read lockfile with entries on the judged
    // side. A lockfile higher up does not stand in for it: this tool
    // cannot see whether that file records this directory, and a deleted
    // nested lockfile beside an untouched root one is how a directory
    // stops being judged. A genuine hoist acknowledges the removed bytes.
    declared = declaredLockableDeps(after, (manifestPath) => {
      const baseDir = nearestCoveringDir(manifestPath, baseDirs);
      if (baseDir === null || afterDirs.has(baseDir)) {
        return false;
      }
      lostDirs.add(baseDir);
      return true;
    });
    coverageLost = declared.count > 0;
  }

  if (unreadChanged.size === 0 && !coverageLost) {
    return;
  }

  // The unread-bytes half: each changed file is cleared by an entry naming
  // its path and the blob id it has on the judged side.
  const usedAcknowledgements: string[] = [];
  const neededAcknowledgements: Array<string | null> = [];
  const blockingPaths: string[] = [];
  for (const [entryPath, label] of unreadChanged) {
    const entry = acknowledgementFor(entryPath, rootBlobId(after, entryPath));
    if (entry !== null && acknowledged.has(entry)) {
      usedAcknowledgements.push(entry);
    } else {
      blockingPaths.push(label);
      neededAcknowledgements.push(entry);
    }
  }

  // The coverage half: cleared when every root lockfile on the judged side
  // is acknowledged with its blob id there, or, when the judged side has no
  // root lockfile at all, when every lockfile that gave the comparison side
  // its coverage is acknowledged with the blob id it had there (a removal
  // of exactly those bytes). A partial set clears nothing.
  let coverageBlocks = false;
  if (coverageLost) {
    const required: Array<string | null> = [];
    for (const dir of lostDirs) {
      const headInDir = inventoryOf(after).filter((entry) => parentDirOf(entry.path) === dir);
      required.push(
        ...(headInDir.length > 0
          ? headInDir.map((entry) => acknowledgementFor(entry.path, entry.blobId))
          : baseCovering
              .filter((lockfile) => parentDirOf(lockfile.path) === dir)
              .map((lockfile) => acknowledgementFor(lockfile.path, rootBlobId(before, lockfile.path))))
      );
    }
    const cleared =
      required.length > 0 && required.every((entry) => entry !== null && acknowledged.has(entry));
    if (cleared) {
      usedAcknowledgements.push(...(required as string[]));
    } else {
      coverageBlocks = true;
      neededAcknowledgements.push(...required.filter((entry) => entry === null || !acknowledged.has(entry)));
    }
  }

  if (blockingPaths.length === 0 && !coverageBlocks) {
    const unique = [...new Set(usedAcknowledgements)].sort();
    notes.push({
      code: DOWNGRADE_ACKNOWLEDGED,
      message:
        `${listPaths(unique)}: acknowledged in acknowledgedLockfiles on the comparison side, so these exact ` +
        'lockfile bytes were let through the lockfile downgrade rule; this tool still did not read what ' +
        'they install',
    });
    return;
  }

  const basePaths = (baseCovering.length > 0 ? baseCovering : beforeReadNpm).map((lockfile) => lockfile.path);
  const reasons: string[] = [];
  if (blockingPaths.length > 0) {
    const paths = [...blockingPaths].sort();
    reasons.push(
      `${listPaths(paths)}: ${
        paths.length === 1
          ? 'a lockfile at the repository root that this tool does not read is'
          : 'lockfiles at the repository root that this tool does not read are'
      } new or changed in this change, while the base side has a lockfile this tool reads ` +
        `(${listPaths(basePaths)})`
    );
  }
  if (coverageBlocks) {
    for (const dir of [...lostDirs].sort()) {
      const headLockfiles = inventoryOf(after)
        .filter((entry) => parentDirOf(entry.path) === dir)
        .map((entry) => entry.path);
      const baseInDir = baseCovering
        .filter((lockfile) => parentDirOf(lockfile.path) === dir)
        .map((lockfile) => lockfile.path);
      const manifestsInDir = declared.manifests.filter(
        (manifestPath) => nearestCoveringDir(manifestPath, baseDirs) === dir
      );
      const where = dir === '' ? '' : ` under ${dir}/`;
      const none = dir === '' ? 'no lockfile at the repository root' : `no lockfile in ${dir}/`;
      reasons.push(
        `no lockfile this tool reads has an entry${where} on this side (the base side had ${listPaths(baseInDir)}; ` +
          `this side has ${headLockfiles.length === 0 ? none : listPaths(headLockfiles)}), ` +
          `while ${listPaths(manifestsInDir)} still declare${manifestsInDir.length === 1 ? 's' : ''} ` +
          'dependencies a lockfile would record'
      );
    }
  }
  const entries = [...new Set(neededAcknowledgements.filter((entry): entry is string => entry !== null))].sort();
  const unidentifiable = neededAcknowledgements.some((entry) => entry === null);
  const listed = entries.map((entry) => JSON.stringify(entry)).join(', ');
  const where =
    source === 'head-commit'
      ? `commit these entries to "acknowledgedLockfiles" in .dep-guard.json first, in a commit of their own: ${listed}. ` +
        'A staged scan reads them from HEAD, so staging them together with this change does not clear it.'
      : source === 'base-ref'
        ? `add these entries to "acknowledgedLockfiles" in .dep-guard.json on the --base ref first: ${listed}. ` +
          'They are read from that ref, not from the working tree, so this change cannot add them for itself.'
        : `add these entries to "acknowledgedLockfiles" in .dep-guard.json on the base branch first, in their own ` +
          `reviewed pull request: ${listed}. They are read from the trust base only, so this pull request ` +
          'cannot add them for itself.';
  const acknowledgeHint =
    (entries.length > 0
      ? ` The narrowest way to land a reviewed migration: ${where} Each entry covers exactly those bytes ` +
        'and nothing else.'
      : '') +
    (unidentifiable
      ? ' A lockfile name that is a symlink or is not a regular file has no identity to acknowledge; ' +
        'replace it with the regular file it stands for.'
      : '');
  throw new DepGuardError(
    `${reasons.join('; and ')}. The lockfile-backed checks would silently stop while the package ` +
      'manager keeps installing; refusing to report a clean pass. ' +
      DOWNGRADE_REMEDY +
      acknowledgeHint,
    'lockfile-downgrade'
  );
}

// A root lockfile this tool does not read, sitting beside one it does. Not
// a refusal when it is unchanged, but the reader has to know the checks
// judged only the other file.
function unreadSiblingNote(after: RepoState): Diagnostic[] {
  if (after.lockfile === null || !isReadLockfile(after.lockfile)) {
    return [];
  }
  const unread = inventoryOf(after)
    .filter((entry) => !isBelowRoot(entry) && !entry.read)
    .map((entry) => entry.path);
  if (unread.length === 0) {
    return [];
  }
  const readPaths = lockfilesOf(after)
    .filter(isReadLockfile)
    .map((lockfile) => lockfile.path);
  return [
    {
      code: UNREAD_SIBLING,
      message:
        `${listPaths(unread)}: present at the repository root beside ${listPaths(readPaths)} and not read ` +
        `by this tool; the lockfile checks judged ${listPaths(readPaths)} only`,
    },
  ];
}

// What computeDelta needs from the effective configuration. Read from the
// comparison side's config on a --trust-base run, exactly as the findings
// filter reads it, so the tree being judged cannot clear its own refusal.
export interface DeltaOptions {
  // True when a repository path is covered by an ignorePaths entry.
  isIgnoredPath?: (repoPath: string) => boolean;
  // Overrides NESTED_LOCKFILE_CHANGE_REFUSES. For the test that keeps the
  // refusing branch of that switch working; scan() never sets it.
  nestedLockfileChangeRefuses?: boolean;
  // Further sides the lockfile set is judged against, beside `before`: the
  // trust base on a --trust-base run that is not --staged. The downgrade
  // rule must hold against every one of them, so a run cannot pick the
  // weaker side. They never change what the delta itself compares.
  extraComparisonSides?: RepoState[];
  // The acknowledgedLockfiles entries from the comparison side's config:
  // the trust base's when there is one, else the --base ref's, else HEAD's
  // for a staged scan. Never the judged side's.
  acknowledgedLockfiles?: readonly string[];
  // Where those entries are read from on this run, so a refusal tells the
  // reader the one place an entry would actually be read.
  acknowledgementSource?: AcknowledgementSource;
}

export type AcknowledgementSource = 'trust-base' | 'base-ref' | 'head-commit';

// Whether a changed lockfile below the repository root stops the scan
// (exit 2) or is reported as the lockfile-nested-changed diagnostic while
// the run continues. One switch, so the severity of this rule is a
// one-line decision.
const NESTED_LOCKFILE_CHANGE_REFUSES = false;

const NESTED_LOCKFILE_CHANGED = 'lockfile-nested-changed';
const NESTED_LOCKFILE_IGNORED = 'lockfile-nested-ignored';
const NESTED_LOCKFILE_REMOVED = 'lockfile-nested-removed';
const LOCKFILE_NOT_READ = 'lockfile-not-read';
const UNREAD_SIBLING = 'lockfile-unread-sibling';
const DOWNGRADE_ACKNOWLEDGED = 'lockfile-downgrade-acknowledged';
const MAX_LISTED_PATHS = 10;

function listPaths(paths: string[]): string {
  if (paths.length <= MAX_LISTED_PATHS) {
    return paths.join(', ');
  }
  return `${paths.slice(0, MAX_LISTED_PATHS).join(', ')} and ${paths.length - MAX_LISTED_PATHS} more`;
}

function inventoryOf(state: RepoState): LockfileInventoryEntry[] {
  return state.lockfileInventory ?? [];
}

function isBelowRoot(entry: LockfileInventoryEntry): boolean {
  return entry.path.includes('/');
}

// A lockfile below the repository root that this tool does not read (yarn,
// bun, a v1 npm file, a name that is not a regular file). npm and pnpm
// lockfiles below the root are read and judged, so a change to those is a
// finding rather than this note. An unknown identity on either side counts
// as a change. The way out for a file nothing installs from (a test
// fixture, an example) is ignorePaths, read from the comparison side.
function checkNestedLockfiles(
  before: RepoState,
  after: RepoState,
  options: DeltaOptions
): Diagnostic[] {
  const beforeIds = new Map(inventoryOf(before).map((entry) => [entry.path, entry.blobId]));
  const changed = inventoryOf(after)
    .filter(isBelowRoot)
    .filter((entry) => !entry.read)
    .filter((entry) => {
      const beforeId = beforeIds.get(entry.path);
      return entry.blobId === null || beforeId === undefined || beforeId === null || beforeId !== entry.blobId;
    })
    .map((entry) => entry.path);
  const isIgnored = options.isIgnoredPath ?? (() => false);
  const ignored = changed.filter((entryPath) => isIgnored(entryPath));
  const blocking = changed.filter((entryPath) => !isIgnored(entryPath));

  const diagnostics: Diagnostic[] = [];
  // A lockfile below the root that the comparison side had and this side
  // does not. Removing the file is how its directory stops being judged,
  // so the removal is said even when nothing in that directory still
  // declares a dependency (when something does, refuseLockfileDowngrade
  // has already stopped the scan).
  const afterPaths = new Set(inventoryOf(after).map((entry) => entry.path));
  const removed = inventoryOf(before)
    .filter(isBelowRoot)
    .filter((entry) => !afterPaths.has(entry.path))
    .map((entry) => entry.path);
  if (removed.length > 0) {
    diagnostics.push({
      code: NESTED_LOCKFILE_REMOVED,
      message:
        `${listPaths(removed)}: ${removed.length === 1 ? 'a lockfile' : 'lockfiles'} below the repository ` +
        `root present on the comparison side and absent on this side; the lockfile checks no longer ` +
        `judge ${removed.length === 1 ? 'that directory' : 'those directories'}. Review the removal by hand`,
    });
  }
  if (ignored.length > 0) {
    diagnostics.push({
      code: NESTED_LOCKFILE_IGNORED,
      message:
        `${listPaths(ignored)}: changed below the repository root and covered by ignorePaths, so ` +
        'it was not judged',
    });
  }
  if (blocking.length === 0) {
    return diagnostics;
  }
  const one = blocking.length === 1;
  const refuses = options.nestedLockfileChangeRefuses ?? NESTED_LOCKFILE_CHANGE_REFUSES;
  const ignoreHint =
    `If nothing this repository ships installs from ${one ? 'it' : 'them'} (a test fixture or an ` +
    'example), add the path or its directory to ignorePaths in .dep-guard.json on the base branch; ' +
    'on a --trust-base run that entry is read from the trust base, so a pull request cannot add it ' +
    'for itself.';
  const message = refuses
    ? `${listPaths(blocking)}: ${one ? 'a lockfile' : 'lockfiles'} below the repository root changed. ` +
      `This tool did not read ${one ? 'it' : 'them'} (it reads npm and pnpm lockfiles, and ` +
      `${one ? 'this file is not one of those' : 'these files are not'}), so it cannot judge what a package ` +
      `manager would install from ${one ? 'it' : 'them'}; refusing to report a clean pass. ` +
      ignoreHint +
      ' Otherwise review the file by hand and merge with an admin override of the failing check. ' +
      'This is a could-not-run (exit 2), not a finding.'
    : `${listPaths(blocking)}: ${one ? 'this lockfile' : 'these lockfiles'} below the repository root ` +
      `changed. This tool did not read ${one ? 'it' : 'them'}, so this run says nothing about what a ` +
      `package manager would install from ${one ? 'it' : 'them'}; review the change by hand. ` +
      ignoreHint;
  if (refuses) {
    throw new DepGuardError(message, 'lockfile-downgrade');
  }
  diagnostics.push({ code: NESTED_LOCKFILE_CHANGED, message });
  return diagnostics;
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
export function computeDelta(
  before: RepoState | null,
  after: RepoState,
  options: DeltaOptions = {}
): DependencyDelta {
  const comparisonSides = [
    ...(before === null ? [] : [before]),
    ...(options.extraComparisonSides ?? []),
  ];
  const acknowledged = new Set(options.acknowledgedLockfiles ?? []);
  const acknowledgementNotes: Diagnostic[] = [];
  for (const side of comparisonSides) {
    refuseLockfileDowngrade(
      side,
      after,
      acknowledged,
      acknowledgementNotes,
      options.acknowledgementSource ?? 'trust-base'
    );
  }
  const deltaDiagnostics: Diagnostic[] = [
    ...acknowledgementNotes,
    ...comparisonSides.flatMap((side) => checkNestedLockfiles(side, after, options)),
    ...unreadSiblingNote(after),
  ];
  const beforeDeps = indexDeps(before);
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
      const beforeLockfiles = before === null ? [] : lockfilesOf(before);
      const afterLockfiles = lockfilesOf(after);
      const beforeSelection =
        before === null
          ? { entry: undefined }
          : selectEntry(lockfileForManifest(manifest.path, beforeLockfiles), previous ?? dep, 'before');
      const afterLockfile = lockfileForManifest(manifest.path, afterLockfiles);
      const afterSelection = selectEntry(afterLockfile, dep, 'after');
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
        ...(afterLockfile === null ? {} : { lockfilePath: afterLockfile.path, lockfileFormat: afterLockfile.format }),
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
  //
  // A lockfile that IS present but is not read (one below the root, or a
  // root lockfile name that is not a readable file) is a different
  // situation from having none, and is said as such.
  const unreadPresent = inventoryOf(after)
    .filter((entry) => !entry.read && (isBelowRoot(entry) || after.lockfile === null))
    .map((entry) => entry.path);
  if (unreadPresent.length > 0) {
    deltaDiagnostics.push({
      code: LOCKFILE_NOT_READ,
      message:
        `${listPaths(unreadPresent)}: present but not read; this tool reads npm and pnpm lockfiles, ` +
        'and this file is not one of those' +
        (after.lockfile === null
          ? ', so the lockfile-tamper and install-script checks had nothing to read and were skipped; the manifest-level checks still ran'
          : ''),
    });
  }
  if (after.lockfile === null) {
    if (unreadPresent.length === 0) {
      deltaDiagnostics.push({
        code: LOCKFILE_MISSING,
        message:
          'no lockfile was found, so the lockfile-tamper and install-script checks had nothing to read and were skipped; the manifest-level checks still ran',
      });
    }
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

  const comparedLockfiles = lockfilesOf(after);
  const beforeLockfiles = before === null ? [] : lockfilesOf(before);
  // Same path first. A lockfile below the root is compared only with that
  // path: falling through to another file of the same format would judge
  // apps/web/package-lock.json against the root lockfile. At the root, a
  // file with no same-path counterpart still falls back to the same format
  // and then the primary, which is how two root lockfiles are judged.
  const counterpartOf = (file: ParsedLockfile): ParsedLockfile | null => {
    if (before === null) {
      return null;
    }
    const samePath = beforeLockfiles.find((candidate) => candidate.path === file.path);
    if (samePath !== undefined) {
      return samePath;
    }
    if (file.path.includes('/')) {
      return null;
    }
    return (
      beforeLockfiles.find((candidate) => candidate.format === file.format) ?? before?.lockfile ?? null
    );
  };
  const lockEntries = diffLockEntries(
    after.lockfile === null ? null : counterpartOf(after.lockfile),
    after.lockfile,
    after.manifests,
    comparedLockfiles
  );

  // Every other npm or pnpm lockfile is diffed the same way. Which file an
  // install honours is the package manager's choice, not something this
  // scan can see, so a clean one must not stand in for a tampered one.
  // Their entries join the same lockEntryChanges list the checks already
  // walk, each tagged with its own path and format.
  const primaryChanges = [...lockEntries.changes];
  for (const extra of after.extraLockfiles ?? []) {
    const counterpart = counterpartOf(extra);
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
    const extraDiff = diffLockEntries(counterpart, extra, after.manifests, comparedLockfiles);
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
