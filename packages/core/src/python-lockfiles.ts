// The four Python lockfiles, read for names only.
//
// These are a kind of input of their own (RepoState.pythonLockfiles), and
// deliberately NOT part of the npm and pnpm lockfile set (git-source.ts,
// LOCKFILE_CANDIDATES): that set decides the primary lockfile, the
// lockfile downgrade rule and lockfile-missing, all of which are about npm
// and pnpm tamper coverage. A Python lockfile that only supplies names must
// not make its own removal an exit 2 downgrade before any Python tamper
// rule exists.
//
// A lockfile that does not parse, or whose entries have a shape this
// reader does not recognise, is unreadable: python-lockfile-unreadable
// names the path, and nothing is skipped in silence. It is not a
// could-not-run, because nothing judged these files before, and the
// package manager itself refuses a corrupt lock.
//
// A lockfile's recorded source never exempts an entry by itself: a
// registry origin other than PyPI is carried as { kind: 'index' } and is
// skipped later only when it equals an origin a manifest of the same
// project declares (python-index.ts). The head writes the lockfile.

import { parse as parseToml } from 'smol-toml';
import { isPypiOrigin, normalizeIndexOrigin } from './python-index.js';
import { invalidNameFragment, isValidPythonName, normalizePypiName } from './python-names.js';
import type {
  PythonLockEntry,
  PythonLockfile,
  PythonLockfileFormat,
  PythonLockSource,
} from './python-types.js';
import { withoutByteOrderMark } from './text.js';

const LOCKFILE_FORMATS: ReadonlyMap<string, PythonLockfileFormat> = new Map([
  ['poetry.lock', 'poetry'],
  ['uv.lock', 'uv'],
  ['pdm.lock', 'pdm'],
  ['Pipfile.lock', 'pipenv'],
]);

function baseName(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? filePath : filePath.slice(slash + 1);
}

export function pythonLockfileFormat(filePath: string): PythonLockfileFormat | null {
  return LOCKFILE_FORMATS.get(baseName(filePath)) ?? null;
}

export function isPythonLockfilePath(filePath: string): boolean {
  return pythonLockfileFormat(filePath) !== null;
}

class UnreadableLockfile extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function fail(reason: string): never {
  throw new UnreadableLockfile(reason);
}

function readTomlDoc(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseToml(withoutByteOrderMark(content));
  } catch {
    return fail('it is not valid TOML');
  }
  return asRecord(parsed) ?? fail('it is not a TOML table');
}

function packageTables(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  const packages = doc.package;
  if (packages === undefined) {
    return [];
  }
  if (!Array.isArray(packages)) {
    return fail('its [[package]] entries are not a list of tables');
  }
  return packages.map((entry) => asRecord(entry) ?? fail('a [[package]] entry is not a table'));
}

function nameAndVersion(entry: Record<string, unknown>): { written: string; version: string | null } {
  if (typeof entry.name !== 'string' || entry.name === '') {
    return fail('a package entry has no name');
  }
  if (entry.version !== undefined && typeof entry.version !== 'string') {
    return fail(`the entry for "${invalidNameFragment(entry.name)}" has a version that is not a string`);
  }
  return { written: entry.name, version: typeof entry.version === 'string' ? entry.version : null };
}

function registrySource(rawOrigin: string): PythonLockSource {
  const origin = normalizeIndexOrigin(rawOrigin);
  return isPypiOrigin(origin) ? { kind: 'pypi' } : { kind: 'index', origin };
}

function poetrySource(entry: Record<string, unknown>): PythonLockSource {
  if (entry.source === undefined) {
    return { kind: 'pypi' };
  }
  const source = asRecord(entry.source) ?? fail('a [package.source] is not a table');
  switch (source.type) {
    case 'git':
      return { kind: 'excluded', cls: 'vcs' };
    case 'directory':
    case 'file':
      return { kind: 'excluded', cls: entry.develop === true ? 'editable' : 'path' };
    case 'url':
      return { kind: 'excluded', cls: 'url' };
    case 'legacy':
      if (typeof source.url !== 'string') {
        return fail('a legacy [package.source] has no url');
      }
      return registrySource(source.url);
    default:
      return fail('a [package.source] has a type this reader does not know');
  }
}

function uvSource(entry: Record<string, unknown>): PythonLockSource {
  const source = asRecord(entry.source) ?? fail('a package entry has no source table');
  if (typeof source.registry === 'string') {
    return registrySource(source.registry);
  }
  if (
    typeof source.virtual === 'string' ||
    typeof source.editable === 'string' ||
    typeof source.path === 'string' ||
    typeof source.directory === 'string'
  ) {
    return { kind: 'excluded', cls: 'path' };
  }
  if (typeof source.git === 'string') {
    return { kind: 'excluded', cls: 'vcs' };
  }
  if (typeof source.url === 'string') {
    return { kind: 'excluded', cls: 'url' };
  }
  return fail('a package source has a shape this reader does not know');
}

function pdmSource(entry: Record<string, unknown>): PythonLockSource {
  if (typeof entry.git === 'string') {
    return { kind: 'excluded', cls: 'vcs' };
  }
  if (entry.editable === true) {
    return { kind: 'excluded', cls: 'editable' };
  }
  if (typeof entry.path === 'string') {
    return { kind: 'excluded', cls: 'path' };
  }
  if (typeof entry.url === 'string') {
    return { kind: 'excluded', cls: 'url' };
  }
  for (const key of ['git', 'editable', 'path', 'url']) {
    if (entry[key] !== undefined) {
      return fail(`the "${key}" key of a package entry has a shape this reader does not know`);
    }
  }
  return { kind: 'pypi' };
}

function tomlEntries(
  content: string,
  source: (entry: Record<string, unknown>) => PythonLockSource
): Array<{ written: string; version: string | null; source: PythonLockSource }> {
  return packageTables(readTomlDoc(content)).map((entry) => ({ ...nameAndVersion(entry), source: source(entry) }));
}

function pipenvEntries(content: string): Array<{ written: string; version: string | null; source: PythonLockSource }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutByteOrderMark(content));
  } catch {
    return fail('it is not valid JSON');
  }
  const doc = asRecord(parsed) ?? fail('it is not a JSON object');
  const meta = asRecord(doc._meta);
  const sources = new Map<string, string>();
  let defaultSource: string | null = null;
  if (meta !== null && meta.sources !== undefined) {
    if (!Array.isArray(meta.sources)) {
      return fail('_meta.sources is not a list');
    }
    for (const item of meta.sources) {
      const record = asRecord(item);
      if (record === null || typeof record.name !== 'string' || typeof record.url !== 'string') {
        return fail('a _meta.sources entry has no name or url');
      }
      sources.set(record.name, record.url);
      defaultSource ??= record.url;
    }
  }
  const out: Array<{ written: string; version: string | null; source: PythonLockSource }> = [];
  for (const section of ['default', 'develop']) {
    const table = doc[section];
    if (table === undefined) {
      continue;
    }
    const record = asRecord(table) ?? fail(`"${section}" is not an object`);
    for (const [written, value] of Object.entries(record)) {
      // Every name a failure reason quotes is fragmented: the head writes
      // these keys, and one can carry a URL with a token in it.
      const entry = asRecord(value) ?? fail(`the entry for "${invalidNameFragment(written)}" is not an object`);
      if (typeof entry.git === 'string') {
        out.push({ written, version: null, source: { kind: 'excluded', cls: entry.editable === true ? 'editable' : 'vcs' } });
        continue;
      }
      if (entry.editable === true) {
        out.push({ written, version: null, source: { kind: 'excluded', cls: 'editable' } });
        continue;
      }
      if (typeof entry.path === 'string' || typeof entry.file === 'string') {
        out.push({ written, version: null, source: { kind: 'excluded', cls: 'path' } });
        continue;
      }
      if (typeof entry.version !== 'string') {
        return fail(
          `the entry for "${invalidNameFragment(written)}" has neither a version nor a git, path or file source`
        );
      }
      const version = entry.version.startsWith('==') ? entry.version.slice(2) : entry.version;
      let origin: string | null;
      if (entry.index === undefined) {
        origin = defaultSource;
      } else if (typeof entry.index === 'string') {
        origin = sources.get(entry.index) ?? null;
        if (origin === null) {
          // An index name _meta.sources does not define: no origin this run
          // can compare, so it is never skipped.
          out.push({ written, version, source: { kind: 'index', origin: `index "${entry.index}"` } });
          continue;
        }
      } else {
        return fail(`the entry for "${invalidNameFragment(written)}" has an index that is not a string`);
      }
      out.push({ written, version, source: origin === null ? { kind: 'pypi' } : registrySource(origin) });
    }
  }
  return out;
}

/** Reads one Python lockfile for names. Never throws. */
export function parsePythonLockfile(filePath: string, content: string): PythonLockfile {
  const format = pythonLockfileFormat(filePath) ?? 'uv';
  let raw: Array<{ written: string; version: string | null; source: PythonLockSource }>;
  try {
    switch (format) {
      case 'poetry':
        raw = tomlEntries(content, poetrySource);
        break;
      case 'uv':
        raw = tomlEntries(content, uvSource);
        break;
      case 'pdm':
        raw = tomlEntries(content, pdmSource);
        break;
      case 'pipenv':
        raw = pipenvEntries(content);
        break;
    }
  } catch (err) {
    if (err instanceof UnreadableLockfile) {
      return { path: filePath, format, entries: [], unreadable: err.message, invalidNames: [] };
    }
    throw err;
  }
  const entries: PythonLockEntry[] = [];
  const invalidNames: string[] = [];
  for (const entry of raw) {
    if (!isValidPythonName(entry.written)) {
      // Only the leading name characters: a head-written name field can
      // carry a URL with a token in it.
      invalidNames.push(invalidNameFragment(entry.written));
      continue;
    }
    entries.push({ ...entry, name: normalizePypiName(entry.written) });
  }
  return { path: filePath, format, entries, invalidNames };
}
