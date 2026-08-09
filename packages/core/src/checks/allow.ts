// Matching of a package name against the configured name lists, shared by
// every check so that no two checks disagree about what a config entry
// covers.
//
// An allowed package is silent almost everywhere: the user has said "I know
// about this one", and a gate that keeps reporting it under a different
// rule id teaches people to ignore the gate. Two forms are supported, and
// only two: an exact package name, and a whole scope written '@scope/*'.
// There is no general globbing -- a bare '*' or a 'foo*' prefix would let
// one careless line disable the tool, and a security gate should not have a
// quiet off switch. config.ts refuses the same shape in ignorePaths, one
// key over, for the same reason.
//
// The one rule allow does NOT cover is lockfile-tamper.
// What an allow entry expresses is knowledge of a PACKAGE: that this name
// is one the project means to depend on. Where its bytes are fetched from
// is not a property of the package -- it is a property of the resolution,
// which an attacker rewrites without touching the name at all. Letting an
// allow entry carry over to that turns "I trust this dependency" into "I
// accept any future source for it", which is the exact attack the tamper
// rule exists to catch. Every other check reads this function.
//
// Patterns are compared as plain strings against a name that came out of a
// package.json key or an npm: alias target, so nothing here indexes an
// object with that name.

const SCOPE_SUFFIX = '/*';

/**
 * True when `name` is covered by one of the configured allow entries.
 */
export function isAllowed(name: string, allow: readonly string[]): boolean {
  if (name.length === 0) {
    return false;
  }
  for (const pattern of allow) {
    if (pattern === name) {
      return true;
    }
    if (!pattern.startsWith('@') || !pattern.endsWith(SCOPE_SUFFIX)) {
      continue;
    }
    // '@acme/*' covers '@acme/anything' and nothing else: the prefix
    // includes the slash, so '@acme-corp/x' is a different scope.
    const prefix = pattern.slice(0, pattern.length - 1);
    if (name.length > prefix.length && name.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * True when `name` belongs to one of the configured internal scopes or
 * carries one of the configured internal prefixes.
 *
 * Internal packages are absent from the public registry by design, so the
 * existence check has nothing useful to say about them; the
 * dependency-confusion check is the one that does. Both read this function
 * rather than each interpreting the config in its own way, because two
 * checks disagreeing about what '@acme' covers is how a package ends up
 * either double-reported or silently exempt from both.
 *
 * A scope entry is written '@acme' and covers '@acme/anything'. A trailing
 * '/' or '/*' is tolerated so that a user who writes the scope the way the
 * allow list wants it still gets what they meant. A prefix entry is a
 * literal leading string, 'acme-' covering 'acme-widgets'.
 */
export function isInternalName(
  name: string,
  internalScopes: readonly string[],
  internalPrefixes: readonly string[]
): boolean {
  if (name.length === 0) {
    return false;
  }

  for (const rawScope of internalScopes) {
    let scope = rawScope;
    if (scope.endsWith(SCOPE_SUFFIX)) {
      scope = scope.slice(0, scope.length - SCOPE_SUFFIX.length);
    } else if (scope.endsWith('/')) {
      scope = scope.slice(0, scope.length - 1);
    }
    if (scope.length === 0) {
      continue;
    }
    const prefix = `${scope}/`;
    if (name.length > prefix.length && name.startsWith(prefix)) {
      return true;
    }
  }

  for (const prefix of internalPrefixes) {
    // An empty prefix would match every package name and silence the
    // existence check wholesale, which is never what a user meant to
    // write.
    if (prefix.length > 0 && name.length > prefix.length && name.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}
