import { DepGuardError, type Diagnostic } from '../types.js';
import { registryTarballPackageName } from '../resolution.js';
import { withoutByteOrderMark } from '../text.js';
import type { LockEntry, ParsedLockfile } from './types.js';

const NODE_MODULES_SEGMENT = 'node_modules/';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Resolve a packages-map key to the installed dependency name: everything
// after the final "node_modules/" occurrence, kept whole rather than split
// into path segments -- a scoped name like "@scope/pkg" contains a "/" and
// must not be truncated to its last segment, e.g.
// "node_modules/host/node_modules/@scope/pkg" resolves to "@scope/pkg".
// Keys with no "node_modules/" segment at all -- workspace package
// directories like "packages/app", or the root "" entry describing the
// project itself -- are not installed dependencies and return undefined so
// the caller skips them.
function installedNameFromKey(key: string): string | undefined {
  const idx = key.lastIndexOf(NODE_MODULES_SEGMENT);
  if (idx === -1) {
    return undefined;
  }
  const name = key.slice(idx + NODE_MODULES_SEGMENT.length);
  return name.length > 0 ? name : undefined;
}

// The diagnostic code raised when a packages entry's own "name" field
// cannot be trusted -- either because nothing on the entry vouches for it
// (no resolvedUrl, or a resolution that is not a registry tarball at all:
// git, file, and remote-tarball entries can all carry this field too, per
// arborist's shrinkwrap.js, whenever the installed folder differs from the
// target's own package.json name) or because the resolved tarball's own
// path names something else entirely. Exported so tests can assert by
// value rather than by a string literal that could drift from the message.
//
// registryTarballPackageName (resolution.ts) only recognises npm's own
// tarball path shape. A registry that serves tarballs under a path PREFIX
// (a proxied or namespaced registry mounted below some base path) or that
// percent-encodes a scope's "/" as "%2f" in the name segment writes a path
// this parser cannot match against a scoped or unscoped name the ordinary
// way, so a perfectly genuine alias on such a registry raises this
// diagnostic too. That is expected noise for those registries -- a lost
// lookupName, never a wrong finding -- not evidence of anything wrong with
// the lockfile.
export const UNVERIFIABLE_NAME_CODE = 'npm-lockfile-unverifiable-name';

// The diagnostic code for a lockfile with no "packages" map at all (a real
// v1 lockfile). delta.ts reads it to tell "the base side was parsed and
// this side was not" apart from "neither side ever had a packages map".
export const NPM_LOCKFILE_V1_CODE = 'npm-lockfile-v1';

function entryFromPackageValue(
  path: string,
  key: string,
  value: Record<string, unknown>,
  diagnostics: Diagnostic[]
): LockEntry {
  const entry: LockEntry = {};
  if (typeof value.version === 'string') {
    entry.version = value.version;
  }
  if (typeof value.resolved === 'string') {
    entry.resolvedUrl = value.resolved;
  }
  if (typeof value.integrity === 'string') {
    entry.integrity = value.integrity;
  }
  if (value.hasInstallScript === true) {
    entry.hasInstallScript = true;
  }
  // npm writes this entry's OWN "name" field whenever the resolved
  // package's real name differs from the installed/alias name the key
  // resolves to (installedNameFromKey above) -- an npm: alias entry, most
  // often. That field is written by whoever committed the lockfile and
  // round-tripped verbatim by npm whatever it says, so it must NEVER be
  // trusted as identity on its own (see delta.ts's LockEntryChange doc
  // comment: an independent review proved that trusting it let a forged
  // name clear a tampered entry's own findings, issue #69).
  //
  // It is trusted only as a LOOKUP hint (LockEntry.lookupName), and only
  // when the entry's own resolvedUrl vouches for it -- a registry tarball
  // URL whose path encodes exactly that name. A name field present without
  // that vouching is not silently used and not silently dropped either: a
  // name this parser cannot verify has to be visible as unverified.
  if (typeof value.name === 'string') {
    const vouched = entry.resolvedUrl === undefined ? null : registryTarballPackageName(entry.resolvedUrl);
    if (vouched !== null && vouched === value.name) {
      entry.lookupName = value.name;
    } else {
      diagnostics.push({
        code: UNVERIFIABLE_NAME_CODE,
        message:
          `${path}: packages["${key}"] declares "name": "${value.name}", but its resolved location ` +
          'does not vouch for that name (no registry tarball URL naming it exactly); the lockfile-' +
          'declared name is ignored for registry lookups',
      });
    }
  }
  return entry;
}

// The refusal for a lockfile whose lockfileVersion promises a packages map
// that is not there. Its own class so a caller reading a comparison side
// can tell it apart and treat that side's file as unread instead (see
// git-source.ts, loadLockfiles); the code stays lockfile-parse.
export class MissingPackagesMapError extends DepGuardError {
  constructor(message: string) {
    super(message, 'lockfile-parse');
  }
}

export function parseNpmLockfile(path: string, content: string): ParsedLockfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutByteOrderMark(content));
  } catch {
    throw new DepGuardError(`${path}: not valid JSON`, 'lockfile-parse');
  }
  if (!isPlainObject(parsed)) {
    throw new DepGuardError(`${path}: lockfile is not a JSON object`, 'lockfile-parse');
  }

  const diagnostics: Diagnostic[] = [];
  const entries = new Map<string, LockEntry[]>();
  const workspaceLocalNames = new Set<string>();

  const lockfileVersion = parsed.lockfileVersion;
  // A string of digits ("3") is read as that number, so a version that
  // promises a packages map cannot dodge the missing-map refusal below by
  // being quoted.
  const versionNumber =
    typeof lockfileVersion === 'number'
      ? lockfileVersion
      : typeof lockfileVersion === 'string' && /^[0-9]+$/.test(lockfileVersion)
        ? Number(lockfileVersion)
        : undefined;
  const versionLabel = lockfileVersion === undefined ? '(absent)' : JSON.stringify(lockfileVersion);

  // The packages map decides what is parsed, never the lockfileVersion
  // field. npm reads a "packages" map whenever one is there, whatever the
  // version field says -- a string "3", the number 1, null, and a deleted
  // field all install the map's entries (verified with npm ls
  // --package-lock-only) -- so deciding "v1, skip everything" from the
  // version alone let a pull request tamper an entry, rewrite one field,
  // and scan clean with only a diagnostic.
  const hasPackagesKey = Object.hasOwn(parsed, 'packages');
  const packages = parsed.packages;

  if (!hasPackagesKey) {
    if (versionNumber !== undefined && versionNumber >= 2) {
      // A lockfile declaring lockfileVersion >= 2 promises a flat
      // "packages" map. If it is missing -- e.g. a hand edit deleted one
      // key -- silently falling back to the benign v1 diagnostic would
      // fail open: entries would come back empty with no error, and every
      // lockfile-backed check downstream would silently stop firing.
      // Throw instead so a corrupt v2/v3 lockfile is loud, not silent.
      throw new MissingPackagesMapError(
        `${path}: lockfileVersion ${versionNumber} declared but "packages" is missing or not an object; ` +
          'regenerate the lockfile with npm'
      );
    }
    // A genuine v1 lockfile (or one with no usable version field and no
    // packages map): a nested "dependencies" tree instead of a flat
    // "packages" map. npm still installs from it, but dep-guard treats it
    // as legacy and out of scope, reporting a diagnostic instead of
    // guessing at the nested v1 shape. computeDelta turns "the base side
    // had a packages map and this side does not" into a hard failure, so
    // this diagnostic is only ever the whole story when neither side ever
    // had one.
    diagnostics.push({
      code: NPM_LOCKFILE_V1_CODE,
      message: `${path}: lockfileVersion ${versionLabel} has no "packages" map; upgrade to lockfileVersion 2 or 3 for dep-guard to inspect it`,
    });
    return { format: 'npm', path, entries, diagnostics, workspaceLocalNames: new Set() };
  }

  if (!isPlainObject(packages)) {
    // A "packages" key that is null, an array, or a scalar is not a v1
    // lockfile (that has no such key at all); it is a corrupt one, and
    // failing open on it would silently stop every lockfile-backed check.
    throw new DepGuardError(
      `${path}: lockfileVersion ${versionLabel} declared but "packages" is missing or not an object`,
      'lockfile-parse'
    );
  }

  // Object.entries only returns own enumerable properties, so packages
  // map keys like "node_modules/constructor" or "node_modules/__proto__"
  // (both legal npm package names) are handled like any other entry
  // instead of colliding with inherited Object.prototype members.
  for (const [key, value] of Object.entries(packages)) {
    const name = installedNameFromKey(key);
    if (name === undefined) {
      continue; // workspace-local package directory, or the root "" entry
    }
    if (!isPlainObject(value)) {
      diagnostics.push({
        code: 'npm-lockfile-invalid-entry',
        message: `${path}: packages["${key}"] is not an object; skipped`,
      });
      continue;
    }
    if (value.link === true) {
      // npm workspaces record two halves per local package: the
      // workspace directory itself (already skipped above, it has no
      // node_modules segment) and a node_modules/<name> entry whose
      // "resolved" is the relative workspace path with "link": true.
      // That resolved value is not a registry or tarball URL, so keeping
      // it in `entries` would make host-comparison checks false-positive
      // on every workspace package. The name is not thrown away, though:
      // it is exactly the fact that this package is workspace-local
      // rather than a registry install, and it is recorded in
      // workspaceLocalNames for the name-based checks to read instead of
      // treating this dependency's plain version-range specifier as an
      // ordinary registry name.
      workspaceLocalNames.add(name);
      continue;
    }
    // Two different packages-map keys can resolve to the same installed
    // name -- e.g. a top-level entry and a nested, possibly different,
    // entry. Real lockfiles hold several versions under one name often
    // enough (nested npm dependency trees resolving a shared name to
    // different versions) that collapsing to a single entry silently
    // discards one and lets an arbitrary version win; the value is a list
    // so every resolved version for a name is retained, in insertion
    // order.
    const existing = entries.get(name);
    if (existing) {
      existing.push(entryFromPackageValue(path, key, value, diagnostics));
    } else {
      entries.set(name, [entryFromPackageValue(path, key, value, diagnostics)]);
    }
  }

  return { format: 'npm', path, entries, diagnostics, workspaceLocalNames };
}
