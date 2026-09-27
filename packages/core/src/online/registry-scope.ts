// The name-level rule shared by all four online checks that must decide,
// before any request leaves the machine, whether a package NAME is
// resolved from the public npm registry or from something the project has
// declared private through its own .npmrc.
//
// Extracted out of online/publish-age.ts's own isNonPublicResolution
// (issue #70, from the review of #58): unknown-package and registered-squat
// used to send every manifest-declared name to registry.npmjs.org
// regardless of the project's own .npmrc scope pins or default registry --
// the exact leak publish-age was built to avoid, just reached through two
// checks that predate it. A later independent review found the FOURTH
// online check, applyTyposquatAsymmetry (online/asymmetry.ts), still
// outside this rule entirely -- it had no internalScopes/internalPrefixes
// filter of its own either -- so it is wired in too. All four checks have
// to agree on the answer, so it is written once here and every online
// check reads it from this one place rather than keeping its own copy.
//
// This is the NAME-level half of the decision only: it never reads a
// resolvedUrl, because unknown-package's, registered-squat's, and
// applyTyposquatAsymmetry's own candidates all come from a manifest-level
// walk (candidates.ts's newRegistryNames, or an existing typosquat
// finding's packageName), which carries no resolved lockfile URL at all.
// publish-age's own isNonPublicResolution (online/publish-age.ts) is the
// RESOLUTION-level check built on top of this one, and the two are not
// interchangeable: a PRIVATE pin decides on its own regardless of a
// resolvedUrl, but a PUBLIC (or absent) pin does NOT let this function
// short-circuit a resolvedUrl that is actually present -- publish-age
// consults the resolvedUrl's own origin first in that case, and only
// falls back to this function when there is no resolvedUrl to read at
// all. See the ordered list on isNonPublicResolution itself.
import { scopeOf } from '../checks/confusion.js';
import type { CheckContext } from '../checks/types.js';
import { originOf } from '../resolution.js';
import { DEFAULT_REGISTRY } from './registry-client.js';

// Computed once from registry-client.ts's own DEFAULT_REGISTRY rather than
// hardcoded a second time, so every online check names the same "public
// registry" if that constant ever changes.
export const PUBLIC_REGISTRY_ORIGIN = originOf(DEFAULT_REGISTRY);

/**
 * True when `name` is declared private by the project's own .npmrc alone --
 * the only two facts a bare package name (no resolution to read) can be
 * judged against:
 *
 * 1. The name's scope has a pin (`ctx.npmrcRegistryPins`), in which case
 *    the PIN'S OWN ORIGIN decides, unconditionally: a scope pinned to the
 *    public registry is public even under a private project default
 *    (issue #67 -- treating any pin as private cost publish-age coverage of
 *    exactly the scope a project pinned there on purpose), and a scope
 *    pinned away from the public registry is private even under a public
 *    project default. A pin always outranks the default registry, in
 *    either direction.
 * 2. Absent a pin for this scope (or the name is unscoped), the project
 *    `.npmrc`'s unscoped default registry (`ctx.npmrcDefaultRegistry`)
 *    decides: private when it is set and names a non-public origin, public
 *    otherwise (including when nothing is configured at all -- an absent
 *    default is neither public nor private evidence, so this does not
 *    guess).
 */
export function isNonPublicName(ctx: CheckContext, name: string): boolean {
  const scope = scopeOf(name);
  if (scope !== null) {
    const pin = ctx.npmrcRegistryPins.get(scope);
    if (pin !== undefined) {
      return originOf(pin) !== PUBLIC_REGISTRY_ORIGIN;
    }
  }
  return (
    ctx.npmrcDefaultRegistry !== undefined &&
    ctx.npmrcDefaultRegistry !== null &&
    originOf(ctx.npmrcDefaultRegistry) !== PUBLIC_REGISTRY_ORIGIN
  );
}
