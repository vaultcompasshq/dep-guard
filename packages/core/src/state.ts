import type { ParsedLockfile } from './lockfiles/types.js';
import type { ParsedManifest } from './manifest.js';

// One fully parsed side of a scan (the "before" or the "after").
// git-source.ts builds these from git blobs or the working tree; the
// delta engine only ever sees the parsed result, which is what keeps it
// testable without a repository.
export interface RepoState {
  manifests: ParsedManifest[];
  lockfile: ParsedLockfile | null;
  onlyBuilt: string[];
  npmrcRegistryPins: Map<string, string>;
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
  for (const rawLine of content.split('\n')) {
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
