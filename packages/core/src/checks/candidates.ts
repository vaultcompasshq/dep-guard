import type { DepChange } from '../delta.js';
import type { Protocol } from '../manifest.js';
import { isAllowed } from './allow.js';
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
}

const NAME_PROTOCOLS: ReadonlySet<Protocol> = new Set<Protocol>(['registry', 'alias']);

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

export function newRegistryNames(ctx: CheckContext): NewName[] {
  const seen = new Set<string>();
  const names: NewName[] = [];

  for (const change of ctx.delta.changes) {
    if (!NAME_PROTOCOLS.has(change.protocol)) {
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

    if (ctx.delta.workspaceLocalNames.has(registryName)) {
      continue;
    }

    if (isAllowed(registryName, ctx.config.allow)) {
      continue;
    }

    // The same package added to both dependencies and devDependencies of
    // one manifest is one decision to review, not two. Keyed by
    // JSON-encoded parts because a package name may contain any character
    // a joiner might use.
    const key = JSON.stringify([change.manifestPath, registryName]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    names.push({ change, registryName });
  }

  return names;
}
