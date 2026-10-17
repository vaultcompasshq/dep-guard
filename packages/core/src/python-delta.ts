// The Python half of the delta: which lockfile names are new, what every
// Python file on the judged side excluded, and which Python names each
// side declares (the typosquat comparison set).
//
// A manifest dependency is a candidate when it is added (computeDelta's
// manifest walk, keyed on the normalised name). A lockfile name is a
// candidate when it is not recorded under that normalised name in the same
// lockfile path on the comparison side; a version change is not. A
// lockfile path new on the judged side, or one the comparison side could
// not read, contributes every name in it. With no comparison side every
// name is new.
//
// A name in a lockfile that a Python manifest in the same directory
// declares is anchored to that manifest, so the manifest walk and the
// lockfile walk give one finding; a name only the lockfile records is
// anchored to the lockfile path, as an undeclared npm lock entry is.

import type { ParsedManifest } from './manifest.js';
import {
  PYTHON_EXCLUSION_CLASSES,
  type PythonExclusionClass,
  type PythonLockfile,
  type PythonUnreadLine,
} from './python-types.js';
import type { RepoState } from './state.js';
import type { Diagnostic } from './types.js';

export interface PythonLockName {
  name: string; // normalised
  written: string;
  version: string | null;
  lockfilePath: string;
  // The manifest the name is anchored to, or the lockfile path itself.
  anchorPath: string;
  // A registry origin other than PyPI the lockfile records, or null for
  // PyPI. Never exempts by itself (online/pypi-existence.ts).
  recordedOrigin: string | null;
}

export interface PythonDeltaFacts {
  lockNames: PythonLockName[];
  // Every normalised Python name the judged side declares, in a manifest
  // or a lockfile, and the same for every comparison side.
  judgedNames: ReadonlySet<string>;
  comparisonNames: ReadonlySet<string>;
  manifests: number;
  lockfiles: number;
  unreadableLockfiles: string[];
  exclusions: Record<PythonExclusionClass, number>;
}

export const REQUIREMENTS_LINE_UNREAD = 'requirements-line-unread';
export const PYTHON_NAME_INVALID = 'python-name-invalid';
export const PYTHON_LOCKFILE_UNREADABLE = 'python-lockfile-unreadable';

function parentDir(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? '' : filePath.slice(0, slash);
}

export function isPythonManifest(manifest: ParsedManifest): boolean {
  return manifest.python !== undefined;
}

// A uv.toml carries index settings only; it is not a manifest a reader
// would count.
function countsAsManifest(manifest: ParsedManifest): boolean {
  return manifest.python !== undefined && manifest.python.kind !== 'uv-toml';
}

function emptyExclusions(): Record<PythonExclusionClass, number> {
  const counts = {} as Record<PythonExclusionClass, number>;
  for (const cls of PYTHON_EXCLUSION_CLASSES) {
    counts[cls] = 0;
  }
  return counts;
}

function readableLockfiles(state: RepoState | null): PythonLockfile[] {
  return (state?.pythonLockfiles ?? []).filter((lockfile) => lockfile.unreadable === undefined);
}

function sideNames(state: RepoState): Set<string> {
  const names = new Set<string>();
  for (const manifest of state.manifests) {
    if (!isPythonManifest(manifest)) {
      continue;
    }
    for (const dep of manifest.deps) {
      if (dep.protocol === 'pypi') {
        names.add(dep.registryName);
      }
    }
  }
  for (const lockfile of readableLockfiles(state)) {
    for (const entry of lockfile.entries) {
      if (entry.source.kind !== 'excluded') {
        names.add(entry.name);
      }
    }
  }
  return names;
}

function unreadWording(entry: PythonUnreadLine): string {
  switch (entry.reason) {
    case 'env-var':
      return 'contains an environment variable reference, which pip expands at install time; this line was not read';
    case 'remote-include':
      return 'includes a file by URL, which this tool does not fetch; this line was not read';
    case 'include-unread':
      return `includes ${entry.detail ?? 'a file'}, so that file was not read`;
    case 'unrecognised':
      return 'is neither a dependency nor an option pip accepts in a requirements file; this line was not read';
  }
}

export function computePythonDelta(
  before: RepoState | null,
  after: RepoState,
  comparisonSides: readonly RepoState[]
): { facts: PythonDeltaFacts; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const exclusions = emptyExclusions();
  const pythonManifests = after.manifests.filter(isPythonManifest);

  for (const manifest of pythonManifests) {
    const info = manifest.python;
    if (info === undefined) {
      continue;
    }
    for (const exclusion of info.exclusions) {
      exclusions[exclusion.cls] += 1;
    }
    for (const entry of info.unread) {
      diagnostics.push({
        code: REQUIREMENTS_LINE_UNREAD,
        message: `${manifest.path}:${entry.line}: ${unreadWording(entry)}`,
      });
    }
    for (const name of info.invalidNames) {
      diagnostics.push({
        code: PYTHON_NAME_INVALID,
        message: `${manifest.path}: "${name}" is not a valid Python project name, so it was not looked up`,
      });
    }
  }

  // Which Python manifest in a directory declares a name, for anchoring.
  const declaredIn = new Map<string, Map<string, string>>();
  for (const manifest of [...pythonManifests].sort((left, right) => (left.path < right.path ? -1 : 1))) {
    const dir = parentDir(manifest.path);
    const names = declaredIn.get(dir) ?? new Map<string, string>();
    for (const dep of manifest.deps) {
      if (dep.protocol === 'pypi' && !names.has(dep.registryName)) {
        names.set(dep.registryName, manifest.path);
      }
    }
    declaredIn.set(dir, names);
  }

  const beforeLockfiles = new Map((before?.pythonLockfiles ?? []).map((lockfile) => [lockfile.path, lockfile]));
  const lockNames: PythonLockName[] = [];
  const unreadableLockfiles: string[] = [];
  for (const lockfile of after.pythonLockfiles ?? []) {
    if (lockfile.unreadable !== undefined) {
      unreadableLockfiles.push(lockfile.path);
      diagnostics.push({
        code: PYTHON_LOCKFILE_UNREADABLE,
        message:
          `${lockfile.path}: could not be read for names (${lockfile.unreadable}), so the Python names it ` +
          'records were not checked',
      });
      continue;
    }
    for (const name of lockfile.invalidNames) {
      exclusions.invalidName += 1;
      diagnostics.push({
        code: PYTHON_NAME_INVALID,
        message: `${lockfile.path}: "${name}" is not a valid Python project name, so it was not looked up`,
      });
    }
    const counterpart = before === null ? undefined : beforeLockfiles.get(lockfile.path);
    const recorded =
      counterpart === undefined || counterpart.unreadable !== undefined
        ? null
        : new Set(counterpart.entries.map((entry) => entry.name));
    const anchors = declaredIn.get(parentDir(lockfile.path));
    for (const entry of lockfile.entries) {
      if (entry.source.kind === 'excluded') {
        exclusions[entry.source.cls] += 1;
        continue;
      }
      if (recorded !== null && recorded.has(entry.name)) {
        continue;
      }
      lockNames.push({
        name: entry.name,
        written: entry.written,
        version: entry.version,
        lockfilePath: lockfile.path,
        anchorPath: anchors?.get(entry.name) ?? lockfile.path,
        recordedOrigin: entry.source.kind === 'index' ? entry.source.origin : null,
      });
    }
  }

  const comparisonNames = new Set<string>();
  for (const side of comparisonSides) {
    for (const name of sideNames(side)) {
      comparisonNames.add(name);
    }
  }

  return {
    facts: {
      lockNames,
      judgedNames: sideNames(after),
      comparisonNames,
      manifests: pythonManifests.filter(countsAsManifest).length,
      lockfiles: (after.pythonLockfiles ?? []).length,
      unreadableLockfiles,
      exclusions,
    },
    diagnostics,
  };
}
