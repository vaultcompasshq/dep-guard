import { DepGuardError, type Diagnostic } from '../types.js';
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

function entryFromPackageValue(value: Record<string, unknown>): LockEntry {
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
  return entry;
}

export function parseNpmLockfile(path: string, content: string): ParsedLockfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new DepGuardError(`${path}: not valid JSON`, 'lockfile-parse');
  }
  if (!isPlainObject(parsed)) {
    throw new DepGuardError(`${path}: lockfile is not a JSON object`, 'lockfile-parse');
  }

  const diagnostics: Diagnostic[] = [];
  const entries = new Map<string, LockEntry[]>();

  const lockfileVersion = parsed.lockfileVersion;
  const versionNumber = typeof lockfileVersion === 'number' ? lockfileVersion : undefined;

  if (versionNumber === undefined || versionNumber <= 1) {
    // v1 lockfiles (and any lockfile with no numeric lockfileVersion field
    // at all) use a nested "dependencies" tree instead of a flat
    // "packages" map. npm still installs from them, but dep-guard treats
    // them as legacy and out of scope, reporting a diagnostic instead of
    // throwing or guessing at the nested v1 shape. This is the only
    // "no packages map" case that is a diagnostic rather than a throw.
    diagnostics.push({
      code: 'npm-lockfile-v1',
      message: `${path}: lockfileVersion ${versionNumber ?? '(absent)'} has no "packages" map; upgrade to lockfileVersion 2 or 3 for dep-guard to inspect it`,
    });
    return { format: 'npm', path, entries, diagnostics };
  }

  const packages = parsed.packages;
  if (!isPlainObject(packages)) {
    // A lockfile declaring lockfileVersion >= 2 promises a flat "packages"
    // map. If it is missing, null, or not an object -- e.g. a hand edit
    // deleted one key -- silently falling back to the benign v1 diagnostic
    // would fail open: entries would come back empty with no error, and
    // every lockfile-backed check downstream would silently stop firing.
    // Throw instead so a corrupt v2/v3 lockfile is loud, not silent.
    throw new DepGuardError(
      `${path}: lockfileVersion ${versionNumber} declared but "packages" is missing or not an object`,
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
      // it would make host-comparison checks false-positive on every
      // workspace package.
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
      existing.push(entryFromPackageValue(value));
    } else {
      entries.set(name, [entryFromPackageValue(value)]);
    }
  }

  return { format: 'npm', path, entries, diagnostics };
}
