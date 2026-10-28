import { acceptedTransitiveAliasTarget, type DepChange } from '../delta.js';
import type { DepType, Protocol } from '../manifest.js';
import { resolutionKindOf, resolutionOf } from '../resolution.js';
import { PYTHON_EXCLUSION_CLASSES, type PythonExclusionClass } from '../python-types.js';
import type { CheckContext } from './types.js';

// The dependencies the two name-based checks (existence, typosquat) judge,
// selected once so both agree on what counts as a new name.
//
// Three filters, each for its own reason:
//
// - kind 'added', plus every alias dependency whatever its kind. A changed
//   registry dependency was already in the base manifest under the same
//   key, so its name was accepted before this delta and re-reporting it on
//   every version bump is noise the user cannot act on. An alias is the
//   exception: the installed package is the alias target, not the key, so
//   '"react": "^18.0.0"' retargeted to '"react": "npm:evil-pkg@1.0.0"'
//   arrives as a changed dependency whose target nobody has ever judged.
//   The delta carries no previous alias target to compare against, so
//   every changed alias is re-checked rather than guessing. Aliases are
//   rare and the checks are cheap; a target that did not actually move is
//   re-reported identically, which the fingerprint and baseline absorb.
// - registry and alias protocols only. workspace/catalog/link/patch/file
//   never reach the delta at all, and git/url dependencies are not
//   registry names, so asking a registry corpus about them is meaningless.
// - not a workspace-local package name (ctx.delta.workspaceLocalNames).
//   npm gives a workspace sibling no distinguishing protocol -- unlike
//   pnpm and yarn's "workspace:" specifier, which is already exempt via
//   the protocol filter above -- so an npm sibling reaches this function
//   looking exactly like an ordinary registry dependency. It is not one:
//   nobody installs it from a registry, so it cannot be an unpublished or
//   hallucinated name and it cannot be a typosquat of anything either.
//   Checked here, once, for both name-based checks, rather than in each,
//   because two checks each deciding for themselves what counts as
//   workspace-local is how one of them ends up disagreeing.
// - not on the allow list, matched against the registry name. Allowing the
//   manifest key would make '"react": "npm:evil"' silent by writing
//   'react', which is the alias attack rather than a defence against it.

export interface NewName {
  change: DepChange;
  registryName: string;
  // 'lockfile' for a name only a lockfile entry records
  // (undeclaredLockEntryNames). Every check judges it like any other name.
  source?: 'lockfile';
  // Set on a lockfile-only name whose lockfile is wholly new in this change
  // (DependencyDelta.whollyNewLockfiles), or on a run with no comparison
  // base. The online registered-squat step does not send it: a fresh
  // lockfile adds hundreds of transitive names, and putting every one on
  // the wire would spend the online budget, which a pull-request run turns
  // into online-names-unchecked. A name a change adds to an existing
  // lockfile is sent (fix round 1: a young, unpopular name reached only
  // through a lockfile edge passed registered-squat with exit 0).
  freshLockfile?: true;
}

// One new Python name, from a manifest line or a lockfile entry. `name` is
// the PEP 503 normalised form, the only form any check compares;
// `written` is for display.
export interface PypiCandidate {
  name: string;
  written: string;
  anchorPath: string;
  source: 'manifest' | 'lockfile';
  lockfilePath?: string;
  specifier: string;
  depType: DepType;
  // A non-PyPI registry origin the lockfile itself records, or null.
  recordedOrigin: string | null;
}

export interface NameCandidates {
  npm: NewName[];
  pypi: PypiCandidate[];
  // What every Python file on the judged side excluded from the name
  // checks, by class. Counted where the parser decided (python-delta.ts),
  // so a line that never became a dependency is counted too.
  excluded: Record<PythonExclusionClass, number>;
}

/**
 * Which ecosystem's name checks a protocol feeds, or null for one that is
 * not a registry name at all. Every Protocol value has a case and the
 * default is `never`, so a protocol added later is a compile error until
 * someone decides where it goes: the next silent filter cannot be written.
 */
export function nameEcosystemOf(protocol: Protocol): 'npm' | 'pypi' | null {
  switch (protocol) {
    case 'registry':
    case 'alias':
      return 'npm';
    case 'pypi':
      return 'pypi';
    // Local wiring: never installed from a registry, and never in the
    // delta at all (delta.ts EXEMPT_PROTOCOLS).
    case 'workspace':
    case 'catalog':
    case 'link':
    case 'patch':
    case 'file':
      return null;
    // Not registry names: the tamper check's git-source and url-source
    // signals judge these instead.
    case 'git':
    case 'url':
      return null;
    default: {
      const unclassified: never = protocol;
      return unclassified;
    }
  }
}

function noteEmptyAlias(ctx: CheckContext, change: DepChange): void {
  const diagnostic = {
    code: 'manifest-alias-empty',
    message:
      `${change.manifestPath}: dependency "${change.name}" has specifier ` +
      `"${change.specifier}" with no package name after "npm:", so name checks were skipped`,
  };
  // Both name checks walk the same delta, and a malformed alias is one
  // fact about the manifest rather than one fact per check.
  for (const existing of ctx.diagnostics) {
    if (existing.code === diagnostic.code && existing.message === diagnostic.message) {
      return;
    }
  }
  ctx.diagnostics.push(diagnostic);
}

function parentDir(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? '' : filePath.slice(0, slash);
}

// A name is workspace-local only for the manifests the lockfile that
// confirmed it actually installs: the change's own lockfile has to sit in
// the directory whose npm lockfile confirmed the link (git-source.ts,
// confirmWorkspaceLocalNames). A change no read lockfile covers is never
// exempt. A delta built without the per-directory map (a hand-built one in
// a unit test) falls back to the flat set.
function isWorkspaceLocal(ctx: CheckContext, change: DepChange, registryName: string): boolean {
  const byDir = ctx.delta.workspaceLocalNamesByDir;
  if (byDir === undefined) {
    return ctx.delta.workspaceLocalNames.has(registryName);
  }
  if (change.lockfilePath === undefined) {
    return false;
  }
  return byDir.get(parentDir(change.lockfilePath))?.has(registryName) ?? false;
}

// The target of every added transitive npm alias the tarball-identity rule
// accepted (acceptedTransitiveAliasTarget), as an added alias dependency
// anchored where the lock entry is. Accepting the alias is what lets that
// entry's tarball name another package without a tamper finding, so the
// package it names is judged as a name instead: a lockfile cannot route a
// typosquat or a hallucinated name in through an alias edge it wrote
// itself.
function acceptedAliasTargets(ctx: CheckContext): DepChange[] {
  const changes: DepChange[] = [];
  for (const entryChange of ctx.delta.lockEntryChanges) {
    const target = acceptedTransitiveAliasTarget(entryChange);
    if (target === null) {
      continue;
    }
    changes.push({
      name: entryChange.name,
      registryName: target,
      specifier: `npm:${target}`,
      kind: 'added',
      depType: 'dependencies',
      protocol: 'alias',
      manifestPath: entryChange.manifestPath,
      lockfilePath: entryChange.lockfilePath,
      ...(entryChange.lockfileFormat === undefined ? {} : { lockfileFormat: entryChange.lockfileFormat }),
    });
  }
  return changes;
}

// Every ADDED npm or pnpm lockfile entry no manifest declares that installs
// from a registry, as an added registry dependency anchored on its
// lockfile. A lockfile is mostly entries nobody declares, and the package
// manager installs every one of them: a new node_modules/<name> entry for
// a known-malicious name used to scan clean because the name checks read
// manifest lines only (audit 2026-10-27, N5). Python lockfile names were
// already checked this way (pypiCandidates below).
//
// The name is the lockfile key (npm's installed name, pnpm's registry
// name), never the entry's own "name" field: identity never comes from a
// field the lockfile author writes (delta.ts, LockEntryChange). Left out,
// each for a reason:
//
// - a changed entry: the base had the name already, as for a manifest
//   dependency whose version moved;
// - a declared entry: the manifest walk judges it at its manifest;
// - an accepted transitive alias: acceptedAliasTargets judges the target,
//   which is what installs, and the key is only the folder name;
// - a git, file or other non-registry resolution, and a pnpm entry whose
//   version is a "file:", "link:", "portal:" or "workspace:" directory with
//   no registry tarball: not registry names, as git,
//   url and file dependencies are not on the manifest side (the tamper
//   check judges the source). An entry with no resolved URL at all is a
//   registry install by name and version, and is checked.
const PNPM_LOCAL_VERSION = /^(?:file|link|portal|workspace):/;

function undeclaredLockEntryNames(ctx: CheckContext): DepChange[] {
  const changes: DepChange[] = [];
  for (const entryChange of ctx.delta.lockEntryChanges) {
    if (entryChange.kind !== 'added' || entryChange.declared === true) {
      continue;
    }
    const format = entryChange.lockfileFormat ?? ctx.delta.lockfileFormat;
    if (format !== 'npm' && format !== 'pnpm') {
      continue;
    }
    if (acceptedTransitiveAliasTarget(entryChange) !== null) {
      continue;
    }
    // pnpm writes a local directory dependency's version as "file:<dir>" or
    // "link:<dir>" with no tarball: a directory, not a name. Only that is
    // skipped by its version text. Any other version holding a ":" is
    // judged by its resolution below: npm records a dependency asked for
    // by tarball URL with the URL as its version, and installs it from
    // that URL (fix round B1: a registry tarball URL as the version passed
    // with exit 0).
    const version = entryChange.after.version;
    if (
      format === 'pnpm' &&
      version !== undefined &&
      PNPM_LOCAL_VERSION.test(version) &&
      entryChange.after.resolvedUrl === undefined
    ) {
      continue;
    }
    const url = entryChange.after.resolvedUrl;
    const resolution = url === undefined ? null : resolutionOf(url);
    if (resolution !== null && resolutionKindOf(resolution) !== 'registry') {
      continue;
    }
    changes.push({
      name: entryChange.name,
      registryName: entryChange.packageName,
      specifier: version ?? '*',
      kind: 'added',
      depType: 'dependencies',
      protocol: 'registry',
      manifestPath: entryChange.manifestPath,
      lockfilePath: entryChange.lockfilePath,
      lockfileFormat: format,
      ...(entryChange.after.inBundle === true ? { bundled: true as const } : {}),
    });
  }
  return changes;
}

function emptyExcluded(): Record<PythonExclusionClass, number> {
  const counts = {} as Record<PythonExclusionClass, number>;
  for (const cls of PYTHON_EXCLUSION_CLASSES) {
    counts[cls] = 0;
  }
  return counts;
}

// The Python name candidates: added pypi manifest dependencies, then new
// lockfile names, one per anchor and normalised name. The anchor of a
// lockfile name a manifest in its directory declares is that manifest
// (python-delta.ts), so the two walks give one candidate there.
function pypiCandidates(ctx: CheckContext, manifestChanges: readonly DepChange[]): PypiCandidate[] {
  const seen = new Set<string>();
  const candidates: PypiCandidate[] = [];
  const push = (candidate: PypiCandidate): void => {
    const key = JSON.stringify([candidate.anchorPath, candidate.name]);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };
  for (const change of manifestChanges) {
    if (change.kind !== 'added') {
      // A changed specifier is not re-checked, as for npm.
      continue;
    }
    push({
      name: change.registryName,
      written: change.name,
      anchorPath: change.manifestPath,
      source: 'manifest',
      specifier: change.specifier,
      depType: change.depType,
      recordedOrigin: null,
    });
  }
  for (const lockName of ctx.delta.python?.lockNames ?? []) {
    push({
      name: lockName.name,
      written: lockName.written,
      anchorPath: lockName.anchorPath,
      source: lockName.anchorPath === lockName.lockfilePath ? 'lockfile' : 'manifest',
      lockfilePath: lockName.lockfilePath,
      specifier: lockName.version === null ? '*' : `==${lockName.version}`,
      depType: 'dependencies',
      recordedOrigin: lockName.recordedOrigin,
    });
  }
  return candidates;
}

/**
 * Every name candidate of the run, per ecosystem, and every Python
 * exclusion counted. newRegistryNames below is the npm view of it, so no
 * Python name can reach the npm corpus, the npm registry or the npm
 * downloads API.
 */
export function newNames(ctx: CheckContext): NameCandidates {
  const pypiChanges: DepChange[] = [];
  for (const change of ctx.delta.changes) {
    if (nameEcosystemOf(change.protocol) === 'pypi') {
      pypiChanges.push(change);
    }
  }
  return {
    npm: npmNames(ctx),
    pypi: pypiCandidates(ctx, pypiChanges),
    excluded: ctx.delta.python?.exclusions ?? emptyExcluded(),
  };
}

export function newRegistryNames(ctx: CheckContext): NewName[] {
  return npmNames(ctx);
}

function npmNames(ctx: CheckContext): NewName[] {
  const seen = new Set<string>();
  const names: NewName[] = [];

  const fromLockfile = new Set(undeclaredLockEntryNames(ctx));
  for (const change of [...ctx.delta.changes, ...acceptedAliasTargets(ctx), ...fromLockfile]) {
    if (nameEcosystemOf(change.protocol) !== 'npm') {
      continue;
    }
    if (change.kind !== 'added' && change.protocol !== 'alias') {
      continue;
    }

    const registryName = change.registryName.trim();
    if (registryName.length === 0) {
      // A finding needs a package to name. Reporting one with an empty
      // packageName would produce an unactionable row and a fingerprint
      // that collides with every other malformed alias.
      noteEmptyAlias(ctx, change);
      continue;
    }

    if (isWorkspaceLocal(ctx, change, registryName)) {
      continue;
    }

    // An allow entry is NOT applied here. This builder feeds existence and
    // typosquat, and neither has judged the name yet; dropping an allowed
    // name at the candidate stage would silence it before either check
    // decided whether it was a finding at all, so an allowed but perfectly
    // clean name (corpus-known, no resemblance) would be recorded as a
    // clearance that never happened. Each consuming check applies allow at
    // its own finding point instead (existence.ts, typosquat.ts), the same
    // place hygiene and install-script already do, so a name is recorded as
    // cleared only where a finding would otherwise have been reported.

    // The same package added to both dependencies and devDependencies of
    // one manifest is one decision to review, not two. Keyed by
    // JSON-encoded parts because a package name may contain any character
    // a joiner might use.
    const key = JSON.stringify([change.manifestPath, registryName]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (!fromLockfile.has(change)) {
      names.push({ change, registryName });
      continue;
    }
    const fresh =
      !ctx.delta.hasComparisonBase ||
      (change.lockfilePath !== undefined && (ctx.delta.whollyNewLockfiles ?? []).includes(change.lockfilePath));
    names.push(
      fresh ? { change, registryName, source: 'lockfile', freshLockfile: true } : { change, registryName, source: 'lockfile' }
    );
  }

  return names;
}
