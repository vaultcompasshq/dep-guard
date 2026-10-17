// One PEP 508 requirement string, or one requirements-file requirement,
// classified the way pip classifies it.
//
// The order is pip's own (its requirement constructor, with
// _looks_like_path and is_archive_file), and each test reads the string pip
// itself tests. Running a path test on a whole logical line would read
// "reqeusts==2.31 --config-settings=x=a/b" as a path because of the slash
// in the option value, mark it file, and never look it up, while pip
// installs reqeusts from PyPI. So the caller splits per-requirement options
// off first, and then:
//
//   1. the environment marker is split off at ";" ("; " for a URL);
//   2. URL and direct-reference branches run FIRST: "name @ <url>", and a
//      string starting with a scheme pip's is_url accepts, are url or git
//      here, before any path or archive test, so a bare https line never
//      becomes file (an exempt protocol) and never escapes tamper;
//   3. the extras bracket is stripped and the version specifier KEPT, and
//      the archive test reads that whole string, case-insensitively, as
//      pip's does: "reqeusts.zip==1.0" is the PyPI project reqeusts-zip,
//      while a bare "reqeusts.zip" (or "pkg.ZIP") is an archive;
//   4. the path test reads the requirement token, the string from step 3
//      up to its first whitespace or version operator: a path when it
//      contains "/" or "\" or starts with ".".
//
// A string that is none of these is a name, and the PEP 508 name pattern
// then decides whether it is a valid one. Everything is loop-based or a
// regular expression with no nested quantifier: the text comes from a file
// the change under review wrote.

import { isValidPythonName } from './python-names.js';

// pip's is_url: http, https, file and ftp, plus every VCS scheme pip knows
// (vcs.all_schemes), plus ssh, which a git requirement is also written as.
// Compared lower-cased, on the text before the first colon.
const VCS_SCHEMES: ReadonlySet<string> = new Set([
  'git',
  'git+http',
  'git+https',
  'git+ssh',
  'git+git',
  'git+file',
  'hg+file',
  'hg+http',
  'hg+https',
  'hg+ssh',
  'hg+static-http',
  'svn',
  'svn+ssh',
  'svn+http',
  'svn+https',
  'svn+svn',
  'svn+file',
  'bzr+http',
  'bzr+https',
  'bzr+ssh',
  'bzr+sftp',
  'bzr+ftp',
  'bzr+lp',
  'bzr+file',
  'ssh',
]);
const PLAIN_URL_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'file', 'ftp']);

function schemeOf(text: string): string | null {
  const colon = text.indexOf(':');
  if (colon <= 0) {
    return null;
  }
  return text.slice(0, colon).toLowerCase();
}

/** True when pip's is_url would accept `text`. */
export function isPipUrl(text: string): boolean {
  const scheme = schemeOf(text);
  if (scheme === null) {
    return false;
  }
  // A scheme starting with any VCS prefix is a VCS URL even when this list
  // lacks that exact spelling: reading it as VCS keeps it a tamper subject.
  return PLAIN_URL_SCHEMES.has(scheme) || VCS_SCHEMES.has(scheme) || isVcsPrefixed(scheme);
}

function isVcsPrefixed(scheme: string): boolean {
  return (
    scheme.startsWith('git+') || scheme.startsWith('hg+') || scheme.startsWith('svn+') || scheme.startsWith('bzr+')
  );
}

/** git for a VCS scheme, url for every other URL. */
export function urlProtocol(text: string): 'git' | 'url' {
  const scheme = schemeOf(text);
  if (scheme !== null && (VCS_SCHEMES.has(scheme) || isVcsPrefixed(scheme))) {
    return 'git';
  }
  return 'url';
}

// pip's ARCHIVE_EXTENSIONS, compared lower-cased.
export const ARCHIVE_EXTENSIONS: readonly string[] = [
  '.whl',
  '.zip',
  '.tar.gz',
  '.tgz',
  '.tar',
  '.tar.bz2',
  '.tbz',
  '.tar.xz',
  '.txz',
  '.tlz',
  '.tar.lz',
  '.tar.lzma',
];

export function isArchiveFile(text: string): boolean {
  const lower = text.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

// The distribution name a wheel or sdist file name carries, as written:
// the part before the first "-" for a wheel ({name}-{version}-...whl), the
// part before the last "-" that precedes a digit for an sdist
// ({name}-{version}.tar.gz). Null when the file name has neither shape.
export function archiveDistributionName(filePath: string): string | null {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const base = filePath.slice(slash + 1);
  const lower = base.toLowerCase();
  const extension = ARCHIVE_EXTENSIONS.filter((candidate) => lower.endsWith(candidate)).sort(
    (left, right) => right.length - left.length
  )[0];
  if (extension === undefined) {
    return null;
  }
  const stem = base.slice(0, base.length - extension.length);
  if (extension === '.whl') {
    const dash = stem.indexOf('-');
    return dash <= 0 ? null : stem.slice(0, dash);
  }
  for (let index = stem.length - 2; index > 0; index -= 1) {
    const next = stem.charCodeAt(index + 1);
    if (stem[index] === '-' && next >= 0x30 && next <= 0x39) {
      return stem.slice(0, index);
    }
  }
  return null;
}

function eggName(url: string): string | null {
  const match = /[#&]egg=([^&#\s]+)/.exec(url);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const name = match[1].split('[')[0] ?? '';
  return isValidPythonName(name) ? name : null;
}

// A bare URL with no #egg= is named by its host and its last path segment,
// never by the full URL, which may carry a token in its userinfo or query.
export function urlDependencyName(url: string): string {
  const fromEgg = eggName(url);
  if (fromEgg !== null) {
    return fromEgg;
  }
  const scheme = schemeOf(url) ?? '';
  const plus = scheme.indexOf('+');
  const parseable = plus === -1 ? url : url.slice(plus + 1);
  try {
    const parsed = new URL(parseable);
    const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
    const last = segments[segments.length - 1] ?? '';
    const host = parsed.hostname.toLowerCase();
    if (host === '') {
      return last === '' ? scheme : last;
    }
    return last === '' ? host : `${host}/${last}`;
  } catch {
    return scheme === '' ? 'url' : scheme;
  }
}

export type RequirementClass =
  | { kind: 'url'; name: string; specifier: string; protocol: 'git' | 'url'; direct: boolean }
  | { kind: 'path'; token: string }
  | { kind: 'name'; name: string; specifier: string }
  | { kind: 'invalid' };

const NAME_CHARS = /[A-Za-z0-9._-]/;
const VERSION_START = /[=<>!~(]/;

function stripTrailingExtras(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(']')) {
    return text;
  }
  const open = trimmed.lastIndexOf('[');
  return open <= 0 ? text : trimmed.slice(0, open);
}

function requirementToken(text: string): string {
  let end = 0;
  while (end < text.length) {
    const char = text[end] ?? '';
    if (char === ' ' || char === '\t' || VERSION_START.test(char) || char === ';') {
      break;
    }
    end += 1;
  }
  return text.slice(0, end);
}

// "name [extras] @ <url>", with whitespace allowed around the extras and
// the "@" (PEP 508). Parsed with a loop so no regular expression has to
// backtrack over a long line.
function directReference(text: string): { name: string; url: string } | null {
  let index = 0;
  while (index < text.length && NAME_CHARS.test(text[index] ?? '')) {
    index += 1;
  }
  const name = text.slice(0, index);
  if (name === '') {
    return null;
  }
  while (text[index] === ' ' || text[index] === '\t') {
    index += 1;
  }
  if (text[index] === '[') {
    const close = text.indexOf(']', index);
    if (close === -1) {
      return null;
    }
    index = close + 1;
    while (text[index] === ' ' || text[index] === '\t') {
      index += 1;
    }
  }
  if (text[index] !== '@') {
    return null;
  }
  const url = text.slice(index + 1).trim().split(/\s/)[0] ?? '';
  return url === '' ? null : { name, url };
}

/**
 * Classifies one requirement, with per-requirement options already split
 * off by the caller, in pip's order (see the comment at the top).
 */
export function classifyRequirement(requirement: string): RequirementClass {
  let body = requirement.trim();
  const markerSeparator = isPipUrl(body) ? '; ' : ';';
  const marker = body.indexOf(markerSeparator);
  if (marker !== -1) {
    body = body.slice(0, marker).trim();
  }
  if (body === '') {
    return { kind: 'invalid' };
  }

  // Step 2: URL and direct-reference branches, before anything else.
  const direct = directReference(body);
  if (direct !== null) {
    if (!isValidPythonName(direct.name)) {
      return { kind: 'invalid' };
    }
    return { kind: 'url', name: direct.name, specifier: direct.url, protocol: urlProtocol(direct.url), direct: true };
  }
  if (isPipUrl(body)) {
    const url = body.split(/\s/)[0] ?? body;
    return { kind: 'url', name: urlDependencyName(url), specifier: url, protocol: urlProtocol(url), direct: false };
  }

  // Step 3: the archive test reads the extras-stripped string with its
  // version specifier kept.
  const withoutExtras = stripTrailingExtras(body);
  if (isArchiveFile(withoutExtras.trim())) {
    return { kind: 'path', token: withoutExtras.trim() };
  }

  // Step 4: the path test reads the requirement token.
  const token = requirementToken(withoutExtras);
  if (token.includes('/') || token.includes('\\') || token.startsWith('.')) {
    return { kind: 'path', token };
  }

  let index = 0;
  while (index < body.length && NAME_CHARS.test(body[index] ?? '')) {
    index += 1;
  }
  const name = body.slice(0, index);
  if (!isValidPythonName(name)) {
    return { kind: 'invalid' };
  }
  let rest = body.slice(index).trim();
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close === -1) {
      return { kind: 'invalid' };
    }
    rest = rest.slice(close + 1).trim();
  }
  if (rest !== '' && !VERSION_START.test(rest[0] ?? '')) {
    return { kind: 'invalid' };
  }
  return { kind: 'name', name, specifier: rest === '' ? '*' : rest };
}
