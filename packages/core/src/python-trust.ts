// Python index declarations and uv workspace members, read from the trust
// base on a --trust-base run.
//
// A Python manifest that names a non-PyPI index skips its names: a private
// name must not be put on the wire to pypi.org, and a 404 for it would be a
// fabricated critical. That skip decides whether a rule fires, so by
// docs/INVARIANTS.md's test ("does a rule read it to decide whether to
// fire") the index lines are a control input even though they sit inside a
// subject file. On a pull-request run they are read from the trust base
// copy of the same path, exactly as the .npmrc pins are, and a head-side
// change to them is reported as a proposal that does not take effect.
//
// The same holds for a uv workspace root's `members` and `exclude`: they
// decide the scope of every [tool.uv.sources] entry, so a pull request that
// widens `members` cannot extend a root source to a new member.
//
// A base copy that is a symlink, a gitlink or anything else that is not a
// regular file, or that does not parse, is an unreadable control input and
// stops the run (exit 2), as an unreadable base .npmrc does: no
// declarations is the loosest setting, not the safest. A base copy that is
// simply absent means no declarations for that path (a file the pull
// request adds has its index lines ignored, so its names are looked up).

import type { ParsedManifest } from './manifest.js';
import { parsePythonManifest } from './python-manifest.js';
import type { PythonControls, UvWorkspaceSpec } from './python-sources.js';
import { emptyIndexDeclarations, type PythonIndexDeclarations } from './python-types.js';
import { isRegularFileMode, readControlFileAtRef } from './trust-base.js';
import { DepGuardError, type Diagnostic } from './types.js';

export const PYTHON_INDEX_PROPOSAL_LINE = 'python index changed in this pull request';
export const PYTHON_INDEX_INVALID = 'python-index-invalid';
export const PYTHON_INDEX_UNREAD_COMPARISON_SIDE = 'python-index-unread-comparison-side';

const MAX_NAMED_PATHS = 10;

function unreadableBase(ref: string, filePath: string, why: string): DepGuardError {
  return new DepGuardError(
    `${ref}:${filePath} ${why} at the trust base; its Python index declarations are a control input, and ` +
      'dep-guard cannot judge a pull request against one it cannot read. This is a misconfiguration on the ' +
      `base branch rather than something the pull request did: fix ${filePath} on the base branch. Nothing ` +
      'was checked.',
    PYTHON_INDEX_INVALID
  );
}

function canonical(declarations: PythonIndexDeclarations): string {
  return JSON.stringify({
    wide: declarations.wide,
    named: declarations.named,
    perName: declarations.perName,
  });
}

function pathList(paths: readonly string[]): string {
  if (paths.length <= MAX_NAMED_PATHS) {
    return paths.join(', ');
  }
  return `${paths.slice(0, MAX_NAMED_PATHS).join(', ')} and ${paths.length - MAX_NAMED_PATHS} more`;
}

/**
 * The Python controls of a --trust-base run: for every Python file the
 * judged side read, the declarations and workspace members of the trust
 * base copy of that path. Returns the proposal line to report when the
 * judged side's declarations differ, or null.
 */
export async function loadPythonControls(
  root: string,
  ref: string,
  label: string,
  judged: readonly ParsedManifest[]
): Promise<{ controls: PythonControls; proposal: string | null; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const declarations = new Map<string, PythonIndexDeclarations>();
  const workspaces = new Map<string, UvWorkspaceSpec | undefined>();
  const baseHas = new Set<string>();
  const changed: string[] = [];
  const judgedByPath = new Map(judged.map((manifest) => [manifest.path, manifest]));

  for (const manifest of judged) {
    const info = manifest.python;
    if (info === undefined) {
      continue;
    }
    const file = await readControlFileAtRef(root, ref, manifest.path);
    let base: PythonIndexDeclarations = emptyIndexDeclarations();
    if (file !== null && file.mode === '120000') {
      // Ruled: a base copy that is a symlink does not stop a pull request
      // that replaces the link with a regular file (the judged side is a
      // regular file here: a judged-side link already stopped the run as
      // symlinked-input). The base contributes no index declarations and
      // no workspace members for that path, so every name in it is looked
      // up and no root source reaches a member: both fail closed.
      baseHas.add(manifest.path);
      workspaces.set(manifest.path, undefined);
      diagnostics.push({
        code: PYTHON_INDEX_UNREAD_COMPARISON_SIDE,
        message:
          `${manifest.path}: is a symlink on ${label}, so its Python index declarations and workspace members ` +
          'were not read there; every name in it is checked against PyPI, and the head copy\'s declarations ' +
          'are not obeyed on this run',
      });
    } else if (file !== null) {
      if (file.mode === '160000') {
        throw unreadableBase(ref, manifest.path, 'is a gitlink (a submodule)');
      }
      if (!isRegularFileMode(file.mode)) {
        throw unreadableBase(ref, manifest.path, `is not a regular file (git mode ${file.mode})`);
      }
      let parsed: ParsedManifest;
      try {
        parsed = parsePythonManifest(manifest.path, file.text, info.constraint === true ? { constraint: true } : {});
      } catch {
        throw unreadableBase(ref, manifest.path, 'does not parse');
      }
      base = parsed.python?.index ?? emptyIndexDeclarations();
      baseHas.add(manifest.path);
      workspaces.set(manifest.path, parsed.python?.uvWorkspace);
    }
    declarations.set(manifest.path, base);
    if (canonical(base) !== canonical(info.index)) {
      changed.push(manifest.path);
    }
  }

  const controls: PythonControls = {
    label,
    declarations: (manifestPath) => declarations.get(manifestPath) ?? emptyIndexDeclarations(),
    // Read from the trust base wherever the base has that root; a root the
    // pull request adds itself has no base copy, so its own members stand
    // (the same residual the npm link rule records for an added install
    // root).
    workspace: (rootPath) =>
      baseHas.has(rootPath) ? workspaces.get(rootPath) : judgedByPath.get(rootPath)?.python?.uvWorkspace,
    judgedWorkspace: (rootPath) => judgedByPath.get(rootPath)?.python?.uvWorkspace,
  };
  return {
    controls,
    proposal: changed.length === 0 ? null : `${PYTHON_INDEX_PROPOSAL_LINE} (${pathList(changed.sort())})`,
    diagnostics,
  };
}
