import { NPM_LOCKFILE_V1_CODE } from './lockfiles/npm.js';
import type { ParsedLockfile } from './lockfiles/types.js';
import type { ParsedManifest } from './manifest.js';
import { withoutByteOrderMark } from './text.js';

// A root lockfile whose entries this tool parses: npm with a "packages"
// map, or pnpm. Everything else (a v1 npm file, yarn, bun) is present but
// unread.
export function isReadLockfile(lockfile: ParsedLockfile): boolean {
  if (lockfile.format === 'pnpm') {
    return true;
  }
  return (
    lockfile.format === 'npm' &&
    !lockfile.diagnostics.some((diagnostic) => diagnostic.code === NPM_LOCKFILE_V1_CODE)
  );
}

// One file carrying a known lockfile name, anywhere in the tree, on one
// side of a scan. The inventory lists every such file whether or not this
// tool reads it, because a lockfile the scan does not read is still one a
// package manager may install from: what the scan cannot judge has to be
// visible, and a change to it has to be noticed.
export interface LockfileInventoryEntry {
  // Repository path, "/"-separated. A root lockfile has no "/" in it.
  path: string;
  // True only for a root lockfile whose entries this tool parses: an npm
  // lockfile with a "packages" map, or a pnpm lockfile.
  read: boolean;
  // The git blob id of the file's bytes on this side, or null when it
  // could not be computed (a directory or other non-file under a lockfile
  // name, a failed git call). Null never compares equal to anything, so a
  // file whose identity is unknown always counts as changed.
  blobId: string | null;
}

// One fully parsed side of a scan (the "before" or the "after").
// git-source.ts builds these from git blobs or the working tree; the
// delta engine only ever sees the parsed result, which is what keeps it
// testable without a repository.
export interface RepoState {
  manifests: ParsedManifest[];
  lockfile: ParsedLockfile | null;
  // Every OTHER npm or pnpm lockfile present at the same root, in
  // precedence order after `lockfile`. A repository can hold several
  // (package-lock.json beside pnpm-lock.yaml, or an npm-shrinkwrap.json
  // beside a package-lock.json) and which one an install honours depends on
  // the package manager and the developer's machine, not on anything the
  // scanner can see, so a clean file must never stand in for a tampered
  // one: computeDelta diffs each of these too. Absent on a state built by
  // hand with one lockfile.
  extraLockfiles?: ParsedLockfile[];
  // Every file with a known lockfile name on this side, at any depth, read
  // or not (see LockfileInventoryEntry). Absent on a state built by hand,
  // which then reads as an empty inventory.
  lockfileInventory?: LockfileInventoryEntry[];
  onlyBuilt: string[];
  // The raw project .npmrc on this side, or null when there is none. Only
  // compared for equality between sides, never parsed from here. Absent on
  // a state built by hand.
  npmrcContent?: string | null;
  npmrcRegistryPins: Map<string, string>;
  // The project .npmrc's unscoped default registry ("registry=..."), or
  // null when the file has none or does not exist. pnpm does not record
  // which registry served an ordinary (non-tarball-URL) resolution -- see
  // lockfiles/pnpm.ts's resolvedUrl handling -- so a resolved lockfile
  // entry with no resolvedUrl at all could come from ANY configured
  // registry, and online/publish-age.ts's isNonPublicResolution needs this
  // value to tell a pnpm repository whose default registry is private from
  // one that never set one at all, the only two cases that reach it with
  // no resolvedUrl to judge an origin from.
  npmrcDefaultRegistry: string | null;
  // Every name this side's lockfile records as workspace-local (see
  // ParsedLockfile.workspaceLocalNames). A straight carry of the
  // lockfile's own field to the level checks actually read -- RepoState is
  // the object the delta step consumes, so this is where the fact has to
  // surface for computeDelta to pass it on, not a place that re-derives it
  // by walking lockfile entries a second time.
  workspaceLocalNames: ReadonlySet<string>;
}

const SCOPE_PIN_SUFFIX = ':registry';

function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  return quoted ? value.slice(1, -1) : value;
}

// Matches a URL scheme prefix ("https:", but also "user:" -- any label-colon).
const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

// A maximal run of non-slash, non-whitespace characters sitting immediately
// before an "@": the textual shape of userinfo. "/@acme/" does not match
// (the character before the "@" is a slash), so registry paths that carry a
// scope segment are untouched. No colon group: ":" is already inside the
// class, so "user:tok@" is one run, and the earlier optional "(:...)?"
// spelling of the same language backtracked cubically on colon-dense input
// with no "@" at all -- a measurable stall on a value an attacker writes.
const CREDENTIAL_RUN = /[^/\s@]+@/g;

// Nothing legitimate is anywhere near this long; anything longer is capped
// before any parsing or redaction so attacker-sized input cannot buy work.
const MAX_PIN_LENGTH = 4096;

// The parser only "succeeds" for this function's purposes when it found a
// real authority; "user:token@host/path" parses fine as a "user:" scheme
// with everything after the colon as an opaque path, and treating that as
// success would store the token.
function tryParseWithHost(input: string): URL | null {
  try {
    const url = new URL(input);
    return url.host === '' ? null : url;
  } catch {
    return null;
  }
}

function withoutUserinfo(url: URL): string {
  return url.protocol + '//' + url.host + url.pathname + url.search + url.hash;
}

function hostAndPath(url: URL): string {
  return url.host + url.pathname + url.search + url.hash;
}

// Removes any userinfo from a registry pin value. A pinned registry may
// legally carry credentials ("https://user:token@host/"), and stored values
// reach finding messages, CI logs, and SARIF, so the secret is dropped at
// the point of parsing rather than trusted to every consumer downstream.
// Never throws.
//
// Three rounds of review each found a pseudo-URL shape a hand-rolled
// authority scan missed ("//user:tok@h/", "///user:tok@h/",
// "///https://user:tok@h/"), so this no longer tries to locate the one true
// authority itself. Instead it asks the platform parser, generously: the
// value as written, then -- because npm accepts protocol-relative and the
// reviewers kept hiding URLs behind slash runs -- the value with its leading
// slash run peeled off, both bare and behind an "https://" placeholder. Any
// interpretation that yields a userinfo wins, and the value is rebuilt from
// parsed components without it, keeping the original prefix style (a
// scheme'd value keeps its scheme, a slash run is put back verbatim, a bare
// value stays bare).
//
// Whatever survives parsing -- the rebuilt value or one that parsed clean --
// then passes a textual floor: a credential-like run may still hide before
// the query (WHATWG reads "https:///https://user:tok@h/" as host "https"
// with the token in the PATH), so the pre-query part is redacted while
// query and fragment survive -- a credential inside the query of a parseable
// value is the documented consumer-side residual. If nothing parses at all,
// the whole value gets the redaction. Either can mangle a legitimately
// weird path, and that is the accepted trade: a value that strange cannot
// serve as a working registry, so mangling is the safe direction and
// leaking is the unsafe one.
function stripCredentials(rawValue: string): string {
  // A truncated value cannot be a working registry, so capping oversized
  // input is safe-direction mangling like everything else here.
  const value =
    rawValue.length > MAX_PIN_LENGTH ? rawValue.slice(0, MAX_PIN_LENGTH) : rawValue;
  const slashRun = /^\/+/.exec(value)?.[0] ?? '';
  const remainder = value.slice(slashRun.length);
  const attempts: Array<[string, (url: URL) => string]> = [];
  if (slashRun === '') {
    attempts.push([value, withoutUserinfo]);
    attempts.push(['https://' + value, hostAndPath]);
  } else {
    if (SCHEME_PREFIX.test(remainder)) {
      attempts.push([remainder, (url) => slashRun + withoutUserinfo(url)]);
    }
    attempts.push(['https://' + remainder, (url) => slashRun + hostAndPath(url)]);
  }
  let parsed = false;
  let candidate: string | null = null;
  for (const [input, rebuild] of attempts) {
    const url = tryParseWithHost(input);
    if (url === null) {
      continue;
    }
    if (url.username !== '' || url.password !== '') {
      candidate = rebuild(url);
      break;
    }
    parsed = true;
  }
  if (candidate === null) {
    if (!parsed) {
      return value.replace(CREDENTIAL_RUN, '');
    }
    candidate = value;
  }
  // The textual floor runs over the REBUILT value as well, not only over a
  // value that parsed clean: returning a rebuild directly would let a
  // throwaway userinfo in front ("https://a:b@x/user:tok@h/") shield a
  // second token in the path from redaction. Path runs of the shape
  // "name@rest" are redacted by design (safe-direction mangling, pinned by
  // a test); slash-preceded "@" segments and everything after the first
  // "?" or "#" survive.
  const boundary = candidate.search(/[?#]/);
  const head = boundary === -1 ? candidate : candidate.slice(0, boundary);
  const tail = boundary === -1 ? '' : candidate.slice(boundary);
  const redactedHead = head.replace(CREDENTIAL_RUN, '');
  return redactedHead === head ? candidate : redactedHead + tail;
}

// Reads the scope-to-registry pins out of a project .npmrc, e.g.
// "@acme:registry=https://npm.acme.example.com/". Only keys that start
// with "@" and end with ":registry" are kept, which excludes the unscoped
// default registry (not a pin, so it cannot signal confusion) and every
// other setting, including the credential lines ("//host/:_authToken=...")
// that sit alongside the pins in a real .npmrc. Credentials embedded in a
// pin's own URL are stripped from the stored value. A Map rather than an
// object because scope names come from a file an attacker may have
// written.
export function parseNpmrcPins(content: string | null): Map<string, string> {
  const pins = new Map<string, string>();
  if (content === null) {
    return pins;
  }
  // npm's ini parser honours the first line after a byte order mark, so
  // the mark is dropped and that line read like any other.
  for (const rawLine of withoutByteOrderMark(content).split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!key.startsWith('@') || !key.endsWith(SCOPE_PIN_SUFFIX)) {
      continue;
    }
    const scope = key.slice(0, key.length - SCOPE_PIN_SUFFIX.length);
    if (scope.length < 2) {
      continue;
    }
    const value = unquote(line.slice(separator + 1).trim());
    if (value === '') {
      continue;
    }
    pins.set(scope, stripCredentials(value));
  }
  return pins;
}

// Reads the project .npmrc's unscoped default registry, e.g.
// "registry=https://npm.corp.example/". Unlike parseNpmrcPins, this key has
// no "@scope:" prefix and no ":registry" suffix -- it is the bare key
// "registry" -- so it needs its own scan rather than a branch inside the
// pin loop above, and it is deliberately kept a *sibling* function so the
// existing scoped map's shape and callers are untouched.
//
// A repeated "registry=" line follows the same last-write-wins rule real
// npmrc parsing uses for any duplicate key, which is why this returns the
// LAST non-empty value seen rather than the first. Credentials are
// stripped from the stored value for the same reason parseNpmrcPins strips
// them from a pin: this value can reach a diagnostic message, and a
// project .npmrc may legally carry credentials in the registry URL itself.
//
// This only tells the caller what the PROJECT declares. A user-level
// ~/.npmrc default registry, or an npm_config_registry environment
// variable, is invisible here (and to the rest of the scan) -- see the
// docs note on online/publish-age.ts and README.md for what a repository
// relying on either of those has to configure instead.
export function parseNpmrcDefaultRegistry(content: string | null): string | null {
  if (content === null) {
    return null;
  }
  let registry: string | null = null;
  for (const rawLine of withoutByteOrderMark(content).split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (key !== 'registry') {
      continue;
    }
    const value = unquote(line.slice(separator + 1).trim());
    if (value === '') {
      continue;
    }
    registry = stripCredentials(value);
  }
  return registry;
}
