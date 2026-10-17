// Which ecosystems had their names checked on a run, how, and how many were
// read but not checked and why: the JSON run.ecosystems object, and the
// text "names:" line built from it (packages/cli/src/output-text.ts).
//
// It exists because Python names used to be read and then skipped by every
// name check without a word: a filter deciding coverage with no
// diagnostic. Every Python name a run read is now either checked, or
// counted under a not-checked reason, or counted under the exclusion class
// that kept it out of the name checks.

import { isInternalName } from './checks/allow.js';
import { newNames } from './checks/candidates.js';
import type { CheckContext } from './checks/types.js';
import { NPM_LOCKFILE_V1_CODE } from './lockfiles/npm.js';
import type { ParsedManifest } from './manifest.js';
import type { PypiExistenceStats } from './online/pypi-existence.js';
import { privatePinnedScope } from './online/registry-scope.js';
import { isPythonManifestPath } from './python-manifest.js';
import type { PythonExclusionClass } from './python-types.js';
import type { Diagnostic } from './types.js';

// Whether the npm lockfile checks (tamper, install-script) had a lockfile to
// read: 'read' for an npm or pnpm lockfile this tool parses, 'not-read' for
// one it finds and does not parse (yarn, bun, a v1 npm file), 'missing' for
// none, 'not-applicable' for a run with no repository behind it (checkSingle).
export type NpmLockfileState = 'read' | 'not-read' | 'missing' | 'not-applicable';

export interface NpmEcosystemSummary {
  manifests: number;
  candidates: number;
  checked: number;
  notChecked: { privateScope: number };
  lockfile: NpmLockfileState;
  // package.json files on the judged side that did not parse and were
  // dropped because ignorePaths covers them (manifest-unparsed).
  notParsed: number;
}

export interface PypiNotChecked {
  offline: number;
  budget: number;
  unreachable: number;
  privateIndex: number;
  internal: number;
  // Python lockfiles that could not be read for names. A count of files:
  // the names inside an unreadable file are unknown by definition.
  lockfileUnreadable: number;
}

export interface PypiEcosystemSummary {
  manifests: number;
  lockfiles: number;
  candidates: number;
  existenceChecked: number;
  resemblanceChecked: number;
  notChecked: PypiNotChecked;
  excluded: Record<PythonExclusionClass, number>;
  // Named requirements across the judged Python manifests, and how many of
  // them are pinned exactly (a single == or === clause). Every requirement
  // pinned is the nearest a Python manifest comes to a lockfile, and it is
  // not one dep-guard compares.
  requirements: number;
  pinned: number;
  // Python manifests on the judged side that did not parse and were
  // dropped because ignorePaths covers them (manifest-unparsed).
  notParsed: number;
}

// go.mod and go.sum seen on the judged side. dep-guard reads neither, so
// there is nothing else to count.
export interface GoEcosystemSummary {
  files: number;
}

export interface EcosystemsSummary {
  npm: NpmEcosystemSummary;
  pypi: PypiEcosystemSummary;
  go: GoEcosystemSummary;
}

// "==1.2.3" and "===1.2.3": one clause, an exact operator, no wildcard. Any
// other specifier (a range, a compound clause, none) is not an exact pin.
// Whitespace is removed first; the pattern has no nested quantifier, so a
// hostile specifier cannot make it backtrack.
function isExactPin(specifier: string): boolean {
  return /^===?[0-9A-Za-z.+!_-]+$/.test(specifier.split(/\s+/).join(''));
}

function npmLockfileState(ctx: CheckContext, judged: boolean): NpmLockfileState {
  if (!judged) {
    return 'not-applicable';
  }
  const { delta } = ctx;
  if (delta.diagnostics.some((diagnostic) => diagnostic.code === NPM_LOCKFILE_V1_CODE)) {
    return 'not-read';
  }
  if (delta.lockfileFormat === 'npm' || delta.lockfileFormat === 'pnpm') {
    return 'read';
  }
  if (delta.lockfileFormat === 'yarn' || delta.lockfileFormat === 'bun') {
    return 'not-read';
  }
  return delta.diagnostics.some((diagnostic) => diagnostic.code === 'lockfile-not-read') ? 'not-read' : 'missing';
}

export const PYPI_NAMES_NOT_CHECKED = 'pypi-names-not-checked';
const MAX_LISTED_FILES = 10;

function fileList(paths: readonly string[]): string {
  if (paths.length === 1) {
    return paths[0] ?? '';
  }
  const shown = paths.slice(0, MAX_LISTED_FILES);
  const rest = paths.length - shown.length;
  if (rest > 0) {
    return `${shown.join(', ')} and ${rest} more`;
  }
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1] ?? ''}`;
}

/**
 * Builds run.ecosystems. `judgedManifests` is null for checkSingle, which
 * has no repository behind it. `pypiStats` is null on an offline run.
 * `notParsed` lists the judged side's manifests dropped under ignorePaths.
 */
export function summarizeEcosystems(
  ctx: CheckContext,
  judgedManifests: readonly ParsedManifest[] | null,
  pypiStats: PypiExistenceStats | null,
  notParsed: readonly string[] = []
): EcosystemsSummary {
  const pythonNotParsed = notParsed.filter(isPythonManifestPath).length;
  const names = newNames(ctx);
  const npmNames = [...new Set(names.npm.map((entry) => entry.registryName))];
  const privateScope = npmNames.filter(
    (name) =>
      isInternalName(name, ctx.config.internalScopes, ctx.config.internalPrefixes) ||
      privatePinnedScope(ctx, name) !== null
  ).length;
  const npmManifests =
    judgedManifests === null ? 1 : judgedManifests.filter((manifest) => manifest.python === undefined).length;

  const pythonDeps = (judgedManifests ?? [])
    .filter((manifest) => manifest.python !== undefined)
    .flatMap((manifest) => manifest.deps.filter((dep) => dep.protocol === 'pypi'));

  const pypiNames = new Set(names.pypi.map((candidate) => candidate.name)).size;
  const python = ctx.delta.python;
  const stats = pypiStats ?? { existenceChecked: 0, budget: 0, unreachable: 0, privateIndex: 0, internal: 0 };
  return {
    npm: {
      manifests: npmManifests,
      candidates: npmNames.length,
      checked: npmNames.length - privateScope,
      notChecked: { privateScope },
      lockfile: npmLockfileState(ctx, judgedManifests !== null),
      notParsed: notParsed.length - pythonNotParsed,
    },
    pypi: {
      manifests: python?.manifests ?? 0,
      lockfiles: python?.lockfiles ?? 0,
      candidates: pypiNames,
      existenceChecked: stats.existenceChecked,
      resemblanceChecked: pypiNames,
      notChecked: {
        offline: pypiStats === null ? pypiNames : 0,
        budget: stats.budget,
        unreachable: stats.unreachable,
        privateIndex: stats.privateIndex,
        internal: stats.internal,
        lockfileUnreadable: python?.unreadableLockfiles.length ?? 0,
      },
      excluded: { ...names.excluded },
      requirements: pythonDeps.length,
      pinned: pythonDeps.filter((dep) => isExactPin(dep.specifier)).length,
      notParsed: pythonNotParsed,
    },
    go: { files: ctx.delta.go?.files ?? 0 },
  };
}

/**
 * The offline run's statement that Python names were read and not checked
 * for existence, or null when there were none to state.
 */
export function pypiNamesNotChecked(ctx: CheckContext): Diagnostic | null {
  const candidates = newNames(ctx).pypi;
  if (candidates.length === 0) {
    return null;
  }
  const count = new Set(candidates.map((candidate) => candidate.name)).size;
  const files = [...new Set(candidates.map((candidate) => candidate.anchorPath))].sort();
  return {
    code: PYPI_NAMES_NOT_CHECKED,
    message:
      `${count} Python dependency name${count === 1 ? '' : 's'} in ${fileList(files)} ` +
      `${count === 1 ? 'was' : 'were'} read and not checked for existence: dep-guard ships no PyPI name list, ` +
      'and the PyPI existence check runs only with --online. Typosquat compared them with this ' +
      "repository's own Python names only.",
  };
}
