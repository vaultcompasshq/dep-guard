// Where a Python name installs from, as far as the name checks care: the
// [tool.uv.sources] exemptions and rewrites, the uv workspace that scopes
// them, and the package-index declarations that decide whether a name may
// be put on the wire to pypi.org at all.
//
// Two kinds of input, kept apart on purpose:
//
// - Control inputs: index declarations (every option spelling, every
//   per-name mapping onto a named index) and a workspace root's `members`
//   and `exclude`. A rule reads them to decide whether it fires, so on a
//   --trust-base run they come from the trust base copy of the same path
//   (trust-base.ts, loadPythonControls), never from the tree being judged.
//
// - Subject content: the source entries themselves (a path, a git URL) and
//   the pyproject.toml files a path or workspace source points at. These
//   are the change under review; a head-added target inside the declaring
//   project earns the exemption (the same class as the npm link rule's
//   residual for a member added under a glob the base already declares).
//
// A [tool.uv.sources] entry is never a global name set. It changes how one
// name installs for the project that declares it and, from a uv workspace
// root, for that root's members; pip installing the same name from a
// requirements file never reads it.

import path from 'node:path';
import { uvWorkspaceCovers } from './git-source.js';
import type { ManifestDep, ParsedManifest } from './manifest.js';
import { isPypiOrigin } from './python-index.js';
import { invalidNameFragment, normalizePypiName } from './python-names.js';
import { archiveDistributionName, isArchiveFile } from './python-requirement.js';
import { emptyIndexDeclarations, type PythonIndexDeclarations, type UvSource } from './python-types.js';
import type { Diagnostic } from './types.js';

export interface UvWorkspaceSpec {
  members: string[];
  exclude: string[];
}

/**
 * The control inputs one run judges Python names by. `declarations` and
 * `workspace` are what the rules obey; `judgedWorkspace` is the tree's own
 * copy, read only to say why a dependency fell outside a scope.
 */
export interface PythonControls {
  label: string | null; // the trust base label, or null outside pull-request mode
  declarations(manifestPath: string): PythonIndexDeclarations;
  workspace(rootPath: string): UvWorkspaceSpec | undefined;
  judgedWorkspace(rootPath: string): UvWorkspaceSpec | undefined;
}

/** Controls read from the judged side itself (outside pull-request mode). */
export function judgedPythonControls(manifests: readonly ParsedManifest[]): PythonControls {
  const byPath = new Map(manifests.map((manifest) => [manifest.path, manifest]));
  return {
    label: null,
    declarations: (manifestPath) => byPath.get(manifestPath)?.python?.index ?? emptyIndexDeclarations(),
    workspace: (rootPath) => byPath.get(rootPath)?.python?.uvWorkspace,
    judgedWorkspace: (rootPath) => byPath.get(rootPath)?.python?.uvWorkspace,
  };
}

export const PYTHON_WORKSPACE_UNCONFIRMED = 'python-workspace-unconfirmed';

function dirOf(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? '' : filePath.slice(0, slash);
}

function relativeTo(rootDir: string, dir: string): string | null {
  if (rootDir === '') {
    return dir;
  }
  if (dir === rootDir) {
    return '';
  }
  return dir.startsWith(`${rootDir}/`) ? dir.slice(rootDir.length + 1) : null;
}

function pyprojects(manifests: readonly ParsedManifest[]): ParsedManifest[] {
  return manifests.filter((manifest) => manifest.python?.kind === 'pyproject');
}

function covers(spec: UvWorkspaceSpec | undefined, rootPath: string, memberPath: string): boolean {
  if (spec === undefined) {
    return false;
  }
  const rel = relativeTo(dirOf(rootPath), dirOf(memberPath));
  return rel !== null && rel !== '' && uvWorkspaceCovers(spec.members, spec.exclude, rel);
}

/**
 * The pyproject.toml paths a source entry declared in `declaringPath`
 * applies to: the declaring file, and, when it is a workspace root, each
 * member under its `members` and not its `exclude`, as the controls give
 * them. `widenedBy` lists the members only the judged side's own, wider
 * `members` would have added.
 */
export function sourceScope(
  declaringPath: string,
  manifests: readonly ParsedManifest[],
  controls: PythonControls
): { scope: Set<string>; widenedBy: Set<string> } {
  const scope = new Set<string>([declaringPath]);
  const widenedBy = new Set<string>();
  const inForce = controls.workspace(declaringPath);
  const judged = controls.judgedWorkspace(declaringPath);
  for (const candidate of pyprojects(manifests)) {
    if (candidate.path === declaringPath) {
      continue;
    }
    if (covers(inForce, declaringPath, candidate.path)) {
      scope.add(candidate.path);
    } else if (covers(judged, declaringPath, candidate.path)) {
      widenedBy.add(candidate.path);
    }
  }
  return { scope, widenedBy };
}

// The workspace root a member's own `workspace = true` source refers to:
// the declaring file when it is a root, otherwise the nearest root whose
// members cover it.
function workspaceRootFor(
  declaringPath: string,
  manifests: readonly ParsedManifest[],
  controls: PythonControls
): string | null {
  if (controls.workspace(declaringPath) !== undefined || controls.judgedWorkspace(declaringPath) !== undefined) {
    return declaringPath;
  }
  const roots = pyprojects(manifests)
    .filter((manifest) => manifest.path !== declaringPath && covers(controls.workspace(manifest.path), manifest.path, declaringPath))
    .sort((left, right) => right.path.length - left.path.length);
  return roots[0]?.path ?? null;
}

function parsedProjectAt(manifests: readonly ParsedManifest[], dir: string, name: string): boolean {
  const target = dir === '' ? 'pyproject.toml' : `${dir}/pyproject.toml`;
  return manifests.some((manifest) => manifest.path === target && manifest.python?.projectName === name);
}

// A path or editable source exempts only when its target, resolved against
// the declaring file's directory and kept inside the repository, is a
// directory holding a pyproject.toml this side parsed whose project name
// normalises to the dependency, or an archive file whose wheel or sdist
// distribution name normalises to it. Anything else exempts nothing.
function pathTargetConfirms(
  declaringPath: string,
  source: UvSource,
  dep: string,
  manifests: readonly ParsedManifest[],
  archiveFiles: ReadonlySet<string>
): boolean {
  const base = dirOf(declaringPath);
  const joined = path.posix.normalize(base === '' ? source.value : `${base}/${source.value}`);
  if (path.posix.isAbsolute(joined) || joined === '..' || joined.startsWith('../')) {
    return false;
  }
  const target = joined === '.' ? '' : joined.replace(/\/+$/, '');
  if (isArchiveFile(target)) {
    // The archive has to be on this side: a missing file installs nothing
    // uv could vouch for, so it exempts nothing.
    if (!archiveFiles.has(target)) {
      return false;
    }
    const distribution = archiveDistributionName(target);
    return distribution !== null && normalizePypiName(distribution) === dep;
  }
  return parsedProjectAt(manifests, target, dep);
}

function workspaceConfirms(
  declaringPath: string,
  dep: string,
  manifests: readonly ParsedManifest[],
  controls: PythonControls
): { confirmed: boolean; widened: boolean } {
  const root = workspaceRootFor(declaringPath, manifests, controls);
  if (root === null) {
    return { confirmed: false, widened: false };
  }
  const named = pyprojects(manifests).filter((manifest) => manifest.python?.projectName === dep);
  const confirmed = named.some(
    (manifest) => manifest.path === root || covers(controls.workspace(root), root, manifest.path)
  );
  const widened =
    !confirmed && named.some((manifest) => covers(controls.judgedWorkspace(root), root, manifest.path));
  return { confirmed, widened };
}

function rewriteTo(dep: ManifestDep, source: UvSource): void {
  dep.protocol = source.kind === 'git' ? 'git' : 'url';
  dep.specifier = source.ref === undefined ? source.value : `${source.value}#${source.ref}`;
  // git and url Python names keep their written form (open point 6).
  dep.registryName = dep.name;
}

/**
 * Applies every [tool.uv.sources] entry of the judged side to the
 * dependencies inside its scope, in place: a git or url source rewrites the
 * dependency's protocol so the tamper check judges it; a confirmed path,
 * editable or workspace source makes it a file dependency, excluded.path.
 * Each one is counted in the declaring manifest's exclusions. Anything
 * unconfirmed stays a pypi dependency and is looked up.
 */
export function applyUvSources(
  manifests: ParsedManifest[],
  controls: PythonControls,
  diagnostics: Diagnostic[],
  // Every archive file path this side has (RepoState.pythonArchiveFiles):
  // an archive target exempts only when the file is really there.
  archiveFiles: ReadonlySet<string> = new Set()
): void {
  const declaringFiles = pyprojects(manifests).filter((manifest) => (manifest.python?.uvSources.length ?? 0) > 0);
  const scopes = new Map(declaringFiles.map((declaring) => [declaring.path, sourceScope(declaring.path, manifests, controls)]));
  for (const manifest of manifests) {
    // uv gives a project's own [tool.uv.sources] precedence over its
    // workspace root's, so for each dependency the NEAREST declaring file
    // whose scope covers this manifest decides: the manifest itself first,
    // then the deepest root. Taking whichever file the manifest list put
    // first let a root entry hide a member's own git override.
    const applicable = declaringFiles
      .filter((declaring) => scopes.get(declaring.path)?.scope.has(manifest.path) ?? false)
      .sort((left, right) =>
        left.path === manifest.path ? -1 : right.path === manifest.path ? 1 : right.path.length - left.path.length
      );
    for (const dep of manifest.deps) {
      if (dep.protocol !== 'pypi') {
        continue;
      }
      let declaring: ParsedManifest | undefined;
      let entry: { dep: string; written: string; sources: UvSource[] } | undefined;
      for (const candidate of applicable) {
        entry = candidate.python?.uvSources.find((source) => source.dep === dep.registryName);
        if (entry !== undefined) {
          declaring = candidate;
          break;
        }
      }
      if (declaring === undefined || entry === undefined) {
        for (const outside of declaringFiles) {
          const outsideEntry = outside.python?.uvSources.find((source) => source.dep === dep.registryName);
          if (
            outsideEntry !== undefined &&
            (scopes.get(outside.path)?.widenedBy.has(manifest.path) ?? false) &&
            outsideEntry.sources.some((source) => source.kind !== 'index')
          ) {
            diagnostics.push({
              code: PYTHON_WORKSPACE_UNCONFIRMED,
              message:
                `${manifest.path}: "${dep.name}" is outside the scope of the [tool.uv.sources] entry in ` +
                `${outside.path}: this change widens [tool.uv.workspace].members there to cover it, and ` +
                `${controls.label === null ? 'that' : `on a pull request the members of ${controls.label}`} ` +
                'decide the scope, so the name is checked like any other',
            });
          }
        }
        continue;
      }
      const declaringPath = declaring.path;
      {
        const info = manifest.python;
        const rewrite = entry.sources.find((source) => source.kind === 'git' || source.kind === 'url');
        if (rewrite !== undefined) {
          rewriteTo(dep, rewrite);
          info?.exclusions.push({ cls: rewrite.kind === 'git' ? 'vcs' : 'url', name: dep.name });
          continue;
        }
        const exempting = entry.sources.filter((source) => source.kind !== 'index');
        if (exempting.length === 0) {
          continue; // an index mapping only: the skip rule handles it
        }
        let widened = false;
        const allConfirm = exempting.every((source) => {
          if (source.kind === 'workspace') {
            const result = workspaceConfirms(declaringPath, dep.registryName, manifests, controls);
            widened ||= result.widened;
            return result.confirmed;
          }
          return pathTargetConfirms(declaringPath, source, dep.registryName, manifests, archiveFiles);
        });
        if (allConfirm) {
          dep.protocol = 'file';
          info?.exclusions.push({ cls: 'path', name: dep.name });
        } else if (widened) {
          diagnostics.push({
            code: PYTHON_WORKSPACE_UNCONFIRMED,
            message:
              `${manifest.path}: "${dep.name}" is declared a uv workspace source, and the member named ` +
              `"${dep.registryName}" is covered only by this change's own, wider [tool.uv.workspace].members, ` +
              'so the name is checked like any other',
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The index skip rule

export interface IndexSkip {
  origin: string;
  option: string;
  alsoPypi: boolean;
  // The file whose declaration decided it.
  declaredIn: string;
}

function lower(text: string): string {
  return text.toLowerCase();
}

/**
 * Decides, per manifest and name, whether a Python name is skipped because
 * the manifest declares a package index other than PyPI.
 *
 * - A non-explicit index that adds to or replaces PyPI can serve any name
 *   in the manifest, so every name there is skipped.
 * - An explicit index serves only the names mapped to it, so only those
 *   are skipped.
 * - A per-name mapping onto a named index whose origin is not PyPI skips
 *   that name.
 *
 * A pyproject.toml also obeys the uv.toml beside it and, as a workspace
 * member, its root's uv settings and [tool.uv.sources] index mappings.
 */
export class PythonIndexRule {
  private readonly manifests: readonly ParsedManifest[];
  private readonly controls: PythonControls;
  private readonly scopes = new Map<string, Set<string>>();

  constructor(manifests: readonly ParsedManifest[], controls: PythonControls) {
    this.manifests = manifests;
    this.controls = controls;
  }

  private scopeOf(rootPath: string): Set<string> {
    let scope = this.scopes.get(rootPath);
    if (scope === undefined) {
      scope = sourceScope(rootPath, this.manifests, this.controls).scope;
      this.scopes.set(rootPath, scope);
    }
    return scope;
  }

  // Every file whose declarations apply to this manifest, itself first.
  private declaringFiles(manifestPath: string): string[] {
    const files = [manifestPath];
    if (!manifestPath.endsWith('pyproject.toml')) {
      return files;
    }
    const uvToml = (dir: string): string => (dir === '' ? 'uv.toml' : `${dir}/uv.toml`);
    files.push(uvToml(dirOf(manifestPath)));
    for (const root of pyprojects(this.manifests)) {
      if (root.path !== manifestPath && this.scopeOf(root.path).has(manifestPath)) {
        files.push(root.path, uvToml(dirOf(root.path)));
      }
    }
    return files;
  }

  /** The skip for one name declared in (or anchored to) one manifest. */
  skipFor(manifestPath: string, name: string): IndexSkip | null {
    const files = this.declaringFiles(manifestPath);
    for (const file of files) {
      for (const wide of this.controls.declarations(file).wide) {
        if (!isPypiOrigin(wide.origin)) {
          return { origin: wide.origin, option: wide.option, alsoPypi: wide.alsoPypi, declaredIn: file };
        }
      }
    }
    for (const file of files) {
      const declarations = this.controls.declarations(file);
      const mapping = declarations.perName.find((entry) => entry.dep === name);
      if (mapping === undefined) {
        continue;
      }
      const named = files
        .flatMap((candidate) => this.controls.declarations(candidate).named)
        .find((index) => lower(index.name) === lower(mapping.index));
      if (named !== undefined && !isPypiOrigin(named.origin)) {
        // Index names are head-written labels and reach a diagnostic, so
        // only their leading name characters print.
        return {
          origin: named.origin,
          option: `index "${invalidNameFragment(mapping.index)}"`,
          alsoPypi: !named.explicit,
          declaredIn: file,
        };
      }
      return null;
    }
    return null;
  }

  /**
   * A lockfile entry whose recorded origin is not PyPI is skipped only
   * when that normalised origin equals one declared, under the rule above,
   * by a Python manifest in the lockfile's own directory. The head writes
   * the lockfile, so its recorded source never exempts by itself.
   */
  lockfileSkip(lockfilePath: string, recordedOrigin: string): IndexSkip | null {
    const dir = dirOf(lockfilePath);
    for (const manifest of this.manifests) {
      if (manifest.python === undefined || dirOf(manifest.path) !== dir) {
        continue;
      }
      for (const file of this.declaringFiles(manifest.path)) {
        const declarations = this.controls.declarations(file);
        const declared = [
          ...declarations.wide.map((entry) => ({ origin: entry.origin, option: entry.option, alsoPypi: entry.alsoPypi })),
          ...declarations.named.map((entry) => ({
            origin: entry.origin,
            option: `index "${invalidNameFragment(entry.name)}"`,
            alsoPypi: !entry.explicit,
          })),
        ];
        const match = declared.find((entry) => entry.origin === recordedOrigin);
        if (match !== undefined) {
          return { ...match, declaredIn: file };
        }
      }
    }
    return null;
  }
}
