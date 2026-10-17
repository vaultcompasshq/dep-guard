// Package index origins, compared in one normalised form.
//
// An index declaration decides whether a Python name is put on the wire to
// pypi.org at all, so it is a control input (docs/INVARIANTS.md), and two
// spellings of the same origin have to compare equal: scheme and host
// lower-cased, a default port dropped, the path with its trailing slashes
// removed. Userinfo ("https://user:token@host/...") is removed before any
// comparison and is never printed, so a token in an index URL cannot reach
// a diagnostic, a log or a SARIF file.
//
// Both edge cases fail closed in the same direction: an origin on a PyPI
// host is treated as PyPI whatever its scheme or path, so it skips nothing
// and the name is looked up. Mistaking a private index for PyPI costs a
// loud false critical; mistaking PyPI for a private index would cost a
// silent skip.

// The textual shape of userinfo, for text that does not parse as a URL at
// all. A character class with no nested quantifier, so it stays linear on
// attacker-written input (the same pattern state.ts uses for .npmrc pins).
const CREDENTIAL_RUN = /[^/\s@]+@/g;

// Long enough for any real index URL; anything longer is capped before it
// is parsed, so attacker-sized input cannot buy work.
const MAX_ORIGIN_LENGTH = 4096;

function withoutTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '/') {
    end -= 1;
  }
  return text.slice(0, end);
}

/** The normalised, userinfo-free form of an index URL or find-links path. */
export function normalizeIndexOrigin(raw: string): string {
  const text = raw.trim().slice(0, MAX_ORIGIN_LENGTH);
  let url: URL | null = null;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }
  if (url !== null && url.hostname !== '') {
    // WHATWG URL already lower-cases the scheme and a special-scheme host
    // and drops the default port for http, https and ftp; the pathname
    // never carries userinfo, query or fragment.
    const port = url.port === '' ? '' : `:${url.port}`;
    return `${url.protocol}//${url.hostname.toLowerCase()}${port}${withoutTrailingSlashes(url.pathname)}`;
  }
  return withoutTrailingSlashes(text.replace(CREDENTIAL_RUN, ''));
}

const PYPI_INDEX_HOSTS: ReadonlySet<string> = new Set(['pypi.org', 'pypi.python.org']);
const PYPI_FILES_HOST = 'files.pythonhosted.org';

/** True when a normalised origin is PyPI, under any variant spelling. */
export function isPypiOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return PYPI_INDEX_HOSTS.has(host) || host === PYPI_FILES_HOST;
}
