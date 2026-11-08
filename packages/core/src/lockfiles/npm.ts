import { DepGuardError, type Diagnostic } from '../types.js';
import { registryTarballPackageName, resolutionOf } from '../resolution.js';
import { withoutByteOrderMark } from '../text.js';
import type { LockEntry, ParsedLockfile, UnreadLocation, UnreadLocationField } from './types.js';

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
export function installedNameFromKey(key: string): string | undefined {
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
// tarball path shape, read past a path PREFIX (a proxied or namespaced
// registry mounted below some base path) by taking the last segment, or the
// last two for a scope. A registry that percent-encodes a scope's "/" as
// "%2f" in the name segment still writes a path this parser cannot match
// against a scoped name the ordinary way, so a perfectly genuine alias on
// such a registry raises this diagnostic too. That is expected noise for
// those registries, not evidence of anything wrong with the lockfile; it
// costs the lookupName, and with it the alias excuse the tarball-identity
// rule in checks/tamper.ts gives an added transitive entry, which then
// reports a mismatch: a false positive, never a pass.
export const UNVERIFIABLE_NAME_CODE = 'npm-lockfile-unverifiable-name';

// Every "npm:<target>@<range>" (or bare "npm:<target>") a packages entry's
// own dependency maps declare, keyed by the dependency name it installs
// under. This is how npm records that a dependent ASKED for an alias, as
// opposed to an entry merely carrying a "name" field: the tarball-identity
// rule in checks/tamper.ts accepts an added transitive entry's name field
// only when such an edge names it (see ParsedLockfile.aliasEdges).
const ALIAS_DEP_MAPS = ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies'];
const NPM_ALIAS_SPEC = /^npm:((?:@[^/@\s]+\/)?[^/@\s]+)(?:@.*)?$/;

function recordAliasEdges(value: unknown, aliasEdges: Map<string, Set<string>>): void {
  if (!isPlainObject(value)) {
    return;
  }
  for (const field of ALIAS_DEP_MAPS) {
    const map = value[field];
    if (!isPlainObject(map)) {
      continue;
    }
    for (const [dependency, spec] of Object.entries(map)) {
      const target = typeof spec === 'string' ? NPM_ALIAS_SPEC.exec(spec.trim())?.[1] : undefined;
      if (target === undefined) {
        continue;
      }
      const targets = aliasEdges.get(dependency) ?? new Set<string>();
      targets.add(target);
      aliasEdges.set(dependency, targets);
    }
  }
}

// The diagnostic code for a lockfile with no "packages" map at all (a real
// v1 lockfile). delta.ts reads it to tell "the base side was parsed and
// this side was not" apart from "neither side ever had a packages map".
export const NPM_LOCKFILE_V1_CODE = 'npm-lockfile-v1';

const PLAIN_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// npm-package-arg's own test for a git+ssh value it hands to git as an scp-style
// address instead of parsing it as a URL: a colon before any "#", unless what
// follows the colon reads as a port. A URL parser can read a different host from
// the same text, so this decides what such a value means, not new URL.
const NPM_SCP_SPEC = /^git\+ssh:\/\/([^:#]+):([^#]+)(#.*)?$/;
const NPM_PORT_NUMBER = /:[0-9]+(\/|$)/;
const USER_AT_HOST = /^[^@\s/]+@([^@\s/]+)$/;
const PLAIN_SCP_PATH = /^[^@:\s]+$/;

function npmScpSpec(resolved: string): RegExpExecArray | null {
  const scp = NPM_SCP_SPEC.exec(resolved);
  return scp !== null && !NPM_PORT_NUMBER.test(`${scp[1]}:${scp[2]}`) ? scp : null;
}

// The location a string "resolved" states, in the form every check parses: a
// plain scp-style user@host:path becomes the same address with a slash, so the
// checks read the host git would connect to. Anything else stays as written.
// An "@" or ":" in the path is reported. The host is compared after the
// rewrite, so a URL parser's reading of the text can never stand in for the
// scp host.
function readableResolved(resolved: string): string {
  const scp = npmScpSpec(resolved);
  const scpHost = scp === null ? undefined : USER_AT_HOST.exec(scp[1])?.[1];
  if (scp === null || scpHost === undefined || !PLAIN_SCP_PATH.test(scp[2])) {
    return resolved;
  }
  const rewritten = `git+ssh://${scp[1]}/${scp[2]}${scp[3] ?? ''}`;
  return resolutionOf(rewritten)?.host.toLowerCase() === scpHost.toLowerCase() ? rewritten : resolved;
}

// A string "resolved" the checks cannot hold to the place it names: it does not
// parse, or it is scp-style in a shape that has no host to rewrite to.
function isUnreadResolved(resolved: string): boolean {
  const readable = readableResolved(resolved);
  return resolutionOf(readable) === null || (readable === resolved && npmScpSpec(resolved) !== null);
}

// The fields of a packages entry that state where it installs from in a form
// the location checks cannot read: they read a "resolved" that parses as a URL
// and a plain version. An empty result is the ordinary case. A false or null
// "resolved" is no location at all, and so is a null or absent version. A link
// entry's "resolved" is a path by design, but only a string one.
function unreadLocationFields(key: string, value: Record<string, unknown>): UnreadLocationField[] {
  const fields: UnreadLocationField[] = [];
  if (Object.hasOwn(value, '_resolved')) {
    fields.push('_resolved');
  }
  if (
    value.resolved &&
    (typeof value.resolved !== 'string' || (value.link !== true && isUnreadResolved(value.resolved)))
  ) {
    fields.push('resolved');
  }
  const { version } = value;
  if (
    installedNameFromKey(key) !== undefined &&
    !value.resolved &&
    version !== undefined &&
    version !== null &&
    (typeof version !== 'string' || !PLAIN_SEMVER.test(version))
  ) {
    fields.push('version');
  }
  return fields;
}

// Whether an entry's hasInstallScript field counts as set. npm reads the field
// by truthiness (arborist's rebuild.js), so a truthy value of any type counts:
// the string "true", the string "false", the number 1. A falsy value that is
// not a boolean (0, null, the empty string) runs nothing in npm and is not read
// as set here either. npm itself only ever writes true or leaves the field
// out, so every value that is not a boolean, truthy or falsy, is also reported
// as lockfile tampering (ParsedLockfile.installFlagShapes).
export function installFlagSet(value: Record<string, unknown>): boolean {
  return Boolean(value.hasInstallScript);
}

function entryFromPackageValue(
  path: string,
  key: string,
  value: Record<string, unknown>,
  diagnostics: Diagnostic[]
): LockEntry {
  // The packages-map key itself, so the delta can pair an entry with the
  // one at the same path on the other side (LockEntry.lockPath).
  const entry: LockEntry = { lockPath: key };
  if (typeof value.version === 'string') {
    entry.version = value.version;
  }
  if (typeof value.resolved === 'string') {
    entry.resolvedUrl = readableResolved(value.resolved);
  }
  if (typeof value.integrity === 'string') {
    entry.integrity = value.integrity;
  }
  if (unreadLocationFields(key, value).length > 0) {
    entry.unreadLocation = true;
  }
  if (installFlagSet(value)) {
    entry.hasInstallScript = true;
  }
  if (value.inBundle === true) {
    entry.inBundle = true;
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
    entry.nameField = value.name;
    const vouched = entry.resolvedUrl === undefined ? null : registryTarballPackageName(entry.resolvedUrl);
    if (vouched !== null && vouched === value.name) {
      entry.lookupName = value.name;
    } else {
      // Not "ignored": the name checks judge it (LockEntry.nameField). What
      // an unvouched name never becomes is identity or a lookup hint.
      diagnostics.push({
        code: UNVERIFIABLE_NAME_CODE,
        message:
          `${path}: packages["${key}"] declares "name": "${value.name}", but its resolved location ` +
          'does not vouch for that name (no registry tarball URL naming it exactly); that name is ' +
          'name-checked but never used as the entry\'s identity or for registry lookups',
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
  const workspaceLinks: Array<{ name: string; resolved?: string }> = [];
  const aliasEdges = new Map<string, Set<string>>();

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
  const scriptKeys = new Map<string, string>();
  const installFlagShapes = new Map<string, string>();
  const unreadLocations = new Map<string, UnreadLocation>();
  for (const [key, value] of Object.entries(packages)) {
    recordAliasEdges(value, aliasEdges);
    // Read before any entry is skipped, so a workspace directory or a link
    // entry is not a place to put one. The root entry is the project itself.
    if (key !== '' && isPlainObject(value)) {
      if (Object.hasOwn(value, 'scripts')) {
        scriptKeys.set(key, JSON.stringify(value.scripts));
      }
      if (Object.hasOwn(value, 'hasInstallScript') && typeof value.hasInstallScript !== 'boolean') {
        installFlagShapes.set(key, JSON.stringify(value.hasInstallScript));
      }
      const fields = unreadLocationFields(key, value);
      if (fields.length > 0) {
        // Which fields, and whether a "resolved" sits beside them, count as
        // well as the values: the same text moved to another field, or an
        // unchanged "_resolved" left alone by a dropped "resolved", is a change.
        unreadLocations.set(key, {
          fields,
          value: JSON.stringify([fields, fields.map((field) => value[field]), Boolean(value.resolved)]),
        });
      }
    }
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
      //
      // Recorded as a claim only, with the directory it points at: whether
      // the claim holds is decided against the scanned side's manifests in
      // git-source.ts, never here (see ParsedLockfile.workspaceLocalNames).
      workspaceLocalNames.add(name);
      workspaceLinks.push(typeof value.resolved === 'string' ? { name, resolved: value.resolved } : { name });
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

  // The map is read whatever the version says (above), but the version still
  // decides what the hasInstallScript flags mean. npm treats a lockfile as old
  // metadata unless its version compares at 2 or above, and for old metadata
  // it reads each package's own scripts at install whatever the flag says
  // (arborist's rebuild.js, #oldMeta). npm only writes a packages map at 2 or
  // above, so the two together mean an edited file whose flags are no account
  // of what runs. A string of digits compares as its number there, as it is
  // read here.
  const packagesVersionMismatch = versionNumber === undefined || versionNumber < 2;

  return {
    format: 'npm',
    path,
    entries,
    diagnostics,
    workspaceLocalNames,
    workspaceLinks,
    aliasEdges,
    ...(scriptKeys.size > 0 ? { scriptKeys } : {}),
    ...(installFlagShapes.size > 0 ? { installFlagShapes } : {}),
    ...(unreadLocations.size > 0 ? { unreadLocations } : {}),
    ...(packagesVersionMismatch ? { packagesVersionMismatch: versionLabel } : {}),
  };
}
