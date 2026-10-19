import { parse as parseToml } from 'smol-toml';
import type { DepType, ManifestDep, ParsedManifest } from './manifest.js';
import { normalizeIndexOrigin } from './python-index.js';
import { invalidNameFragment, isValidPythonName, normalizePypiName } from './python-names.js';
import { parseRequirementsOptions } from './python-options.js';
import { classifyRequirement, isPipUrl, urlDependencyName, urlProtocol } from './python-requirement.js';
import {
  emptyIndexDeclarations,
  isFullCommitId,
  type PythonExclusionClass,
  type PythonIndexDeclarations,
  type PythonManifestInfo,
  type PythonManifestKind,
  type UvSource,
} from './python-types.js';
import { withoutByteOrderMark } from './text.js';
import { DepGuardError } from './types.js';

// Python manifests this scan reads. A pyproject.toml that only holds
// [tool.*] config still parses: zero dependencies is a real result, and
// the file counts as a resolved manifest.
//
// Every Python requirement is either a dependency with protocol pypi (a
// name candidate for the PyPI check), a git or url dependency (a tamper
// subject), or counted under a named exclusion in the manifest's
// PythonManifestInfo. Nothing is dropped without a count.
const PYPROJECT = 'pyproject.toml';
const PIPFILE = 'Pipfile';
const UV_TOML = 'uv.toml';
const REQUIREMENTS_IN = 'requirements.in';
const REQUIREMENTS_DIR = 'requirements';

function baseName(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? filePath : filePath.slice(slash + 1);
}

function parentBaseName(filePath: string): string | null {
  const slash = filePath.lastIndexOf('/');
  if (slash === -1) {
    return null;
  }
  return baseName(filePath.slice(0, slash));
}

/**
 * True for a requirements file by name: a .txt basename starting with
 * "requirements" or ending in "requirements.txt", any .txt directly in a
 * directory named "requirements", and requirements.in. Files reached only
 * through -r are read by the loader without matching this.
 */
export function isRequirementsPath(filePath: string): boolean {
  const base = baseName(filePath);
  if (base === REQUIREMENTS_IN) {
    return true;
  }
  if (!base.endsWith('.txt')) {
    return false;
  }
  return base.startsWith('requirements') || base.endsWith('requirements.txt') || parentBaseName(filePath) === REQUIREMENTS_DIR;
}

export function pythonManifestKind(filePath: string): PythonManifestKind | null {
  const base = baseName(filePath);
  if (base === PYPROJECT) {
    return 'pyproject';
  }
  if (base === PIPFILE) {
    return 'pipfile';
  }
  if (base === UV_TOML) {
    return 'uv-toml';
  }
  return isRequirementsPath(filePath) ? 'requirements' : null;
}

export function isPythonManifestPath(filePath: string): boolean {
  return pythonManifestKind(filePath) !== null;
}

function emptyInfo(kind: PythonManifestKind): PythonManifestInfo {
  return {
    kind,
    exclusions: [],
    unread: [],
    invalidNames: [],
    includes: [],
    index: emptyIndexDeclarations(),
    uvSources: [],
  };
}

function pypiDep(name: string, specifier: string, depType: DepType): ManifestDep {
  return { name, registryName: normalizePypiName(name), specifier, depType, protocol: 'pypi' };
}

// git and url dependencies keep their written name as registryName: they
// already reach the tamper check keyed on it, and normalising would re-key
// baselined findings (design open point 6).
function writtenDep(name: string, specifier: string, protocol: ManifestDep['protocol'], depType: DepType): ManifestDep {
  return { name, registryName: name, specifier, depType, protocol };
}

// A git or url dependency whose specifier is a URL the user wrote, verbatim:
// pip's grammar (ManifestDep.pipGrammar). Every site that passes user text
// through as the specifier uses this; the poetry and Pipfile git tables,
// which build "<url>#<rev>" from their own rev key, use writtenDep.
function userUrlDep(name: string, url: string, depType: DepType): ManifestDep {
  return { ...writtenDep(name, url, urlProtocol(url), depType), pipGrammar: true };
}

// A poetry or Pipfile git table: the specifier is "<git>#<ref>" for display
// and identity, and the pin is judged from `rev` alone (ManifestDep.gitTable).
function gitTableDep(name: string, git: string, ref: string | undefined, rev: string | null, depType: DepType): ManifestDep {
  return { ...writtenDep(name, ref === undefined ? git : `${git}#${ref}`, 'git', depType), gitTable: { rev } };
}

// The table's own commit key, when it is a non-empty string.
function commitKey(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

// True when a table's `git` value already carries ref or fragment text of
// its own: a "#" anywhere, or an "@" in its path (after the netloc of a
// "scheme://" URL, or after the ":" of a scp-like "user@host:path"; an
// "@" in userinfo such as "git@host" is not in the path). The installer
// appends the table's ref to this value (pipenv builds "git+<git>@<ref>"),
// so with either present the ref pip reads is not the table's: "#" makes
// it fragment text, which pip ignores, and a path "@" moves where the ref
// split falls.
function gitValueCarriesRef(git: string): boolean {
  if (git.includes('#')) {
    return true;
  }
  const scheme = git.indexOf('://');
  let urlPath: string;
  if (scheme !== -1) {
    const rest = git.slice(scheme + 3);
    const slash = rest.indexOf('/');
    urlPath = slash === -1 ? '' : rest.slice(slash);
  } else {
    const colon = git.indexOf(':');
    urlPath = colon === -1 ? git : git.slice(colon + 1);
  }
  return urlPath.includes('@');
}

// The rev that can pin a git table (ManifestDep.gitTable): its own commit
// key, unless the git value carries ref text of its own
// (gitValueCarriesRef), in which case nothing pins it.
function pinningRev(git: string, value: unknown): string | null {
  return gitValueCarriesRef(git) ? null : commitKey(value);
}

// The same for a poetry or uv git table, which can also carry branch and
// tag keys. poetry resolves the reference as branch, then tag, then rev, so
// a rev beside either installs the branch or tag; uv rejects more than one
// ref key, and is refused the same way in case a reader does not.
function tableRev(record: Record<string, unknown>, git: string): string | null {
  if (commitKey(record.branch) !== null || commitKey(record.tag) !== null) {
    return null;
  }
  return pinningRev(git, record.rev);
}

function exclusionClassOf(protocol: 'git' | 'url'): PythonExclusionClass {
  return protocol === 'git' ? 'vcs' : 'url';
}

// ---------------------------------------------------------------------------
// Requirements files

// pip's COMMENT_RE, "(^|\s+)#.*$": a "#" starts a comment only at the start
// of the line or after whitespace, so a URL's "#egg=" fragment survives.
function stripComment(line: string): string {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '#') {
      continue;
    }
    const before = index === 0 ? ' ' : (line[index - 1] ?? '');
    if (before === ' ' || before === '\t') {
      return line.slice(0, index);
    }
  }
  return line;
}

function isCommentLine(line: string): boolean {
  return line.trimStart().startsWith('#');
}

// pip's join_lines: a line ending in a backslash continues onto the next,
// unless it is a comment line. The logical line keeps the number of its
// first physical line.
function logicalLines(content: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let pending: string[] = [];
  let pendingLine = 0;
  const physical = withoutByteOrderMark(content).split(/\r?\n/);
  for (let index = 0; index < physical.length; index += 1) {
    const raw = physical[index] ?? '';
    const number = index + 1;
    if (!raw.endsWith('\\') || isCommentLine(raw)) {
      const piece = isCommentLine(raw) ? ` ${raw}` : raw;
      if (pending.length > 0) {
        pending.push(piece);
        out.push({ line: pendingLine, text: pending.join('') });
        pending = [];
      } else {
        out.push({ line: number, text: raw });
      }
      continue;
    }
    if (pending.length === 0) {
      pendingLine = number;
    }
    pending.push(raw.slice(0, -1));
  }
  if (pending.length > 0) {
    out.push({ line: pendingLine, text: pending.join('') });
  }
  return out;
}

// pip's break_args_options: the requirement is every token before the first
// one that starts with "-"; the rest are options.
function splitArgsAndOptions(line: string): { args: string; options: string } {
  const tokens = line.split(/([ \t]+)/);
  let args = '';
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token.trim() !== '' && token.startsWith('-')) {
      return { args: args.trim(), options: tokens.slice(index).join('').trim() };
    }
    args += token;
  }
  return { args: args.trim(), options: '' };
}

function hasEnvReference(line: string): boolean {
  const open = line.indexOf('${');
  return open !== -1 && line.indexOf('}', open + 2) !== -1;
}

function addWide(index: PythonIndexDeclarations, raw: string, option: string, alsoPypi: boolean): void {
  index.wide.push({ origin: normalizeIndexOrigin(raw), option, alsoPypi });
}

function readEditable(target: string, line: number, deps: ManifestDep[], info: PythonManifestInfo): void {
  info.exclusions.push({ cls: 'editable', line });
  if (isPipUrl(target)) {
    deps.push(userUrlDep(urlDependencyName(target), target, 'dependencies'));
    return;
  }
  deps.push(writtenDep(target, target, 'file', 'dependencies'));
}

function readOptionLine(
  text: string,
  line: number,
  deps: ManifestDep[],
  info: PythonManifestInfo,
  constraint: boolean
): boolean {
  const options = parseRequirementsOptions(text);
  if (options === null) {
    return false;
  }
  for (const option of options) {
    const value = option.value ?? '';
    switch (option.name) {
      case '--requirement':
      case '--constraint':
        if (isPipUrl(value)) {
          info.unread.push({ line, reason: 'remote-include' });
          info.exclusions.push({ cls: 'unrecognised', line });
          break;
        }
        info.includes.push({ target: value, constraint: constraint || option.name === '--constraint', line });
        break;
      case '--index-url':
        addWide(info.index, value, '--index-url', false);
        break;
      case '--extra-index-url':
        addWide(info.index, value, '--extra-index-url', true);
        break;
      case '--find-links':
        addWide(info.index, value, '--find-links', true);
        break;
      case '--no-index':
        info.index.wide.push({ origin: 'no index', option: '--no-index', alsoPypi: false });
        break;
      case '--editable':
        if (constraint) {
          info.exclusions.push({ cls: 'constraint', line });
          break;
        }
        readEditable(value, line, deps, info);
        break;
      default:
        break;
    }
  }
  return true;
}

export function parseRequirements(
  filePath: string,
  content: string,
  options: { constraint?: boolean } = {}
): ParsedManifest {
  const constraint = options.constraint === true;
  const deps: ManifestDep[] = [];
  const info = emptyInfo('requirements');
  if (constraint) {
    info.constraint = true;
  }
  const unread = (line: number, reason: 'unrecognised' | 'env-var'): void => {
    info.unread.push({ line, reason });
    info.exclusions.push({ cls: 'unrecognised', line });
  };

  for (const { line, text } of logicalLines(content)) {
    const body = stripComment(text).trim();
    if (body === '') {
      continue;
    }
    // pip expands ${VAR} from an environment dep-guard cannot see. The line
    // is counted, never guessed at.
    if (hasEnvReference(body)) {
      unread(line, 'env-var');
      continue;
    }
    const { args, options: optionText } = splitArgsAndOptions(body);
    if (args === '') {
      if (!readOptionLine(optionText, line, deps, info, constraint)) {
        unread(line, 'unrecognised');
      }
      continue;
    }
    const classified = classifyRequirement(args);
    if (classified.kind === 'invalid') {
      unread(line, 'unrecognised');
      continue;
    }
    if (constraint) {
      // A constraint never installs a name by itself.
      info.exclusions.push({ cls: 'constraint', line, ...(classified.kind === 'name' ? { name: classified.name } : {}) });
      continue;
    }
    switch (classified.kind) {
      case 'url':
        deps.push(userUrlDep(classified.name, classified.specifier, 'dependencies'));
        info.exclusions.push({ cls: exclusionClassOf(classified.protocol), line, name: classified.name });
        break;
      case 'path':
        deps.push(writtenDep(classified.token, classified.token, 'file', 'dependencies'));
        info.exclusions.push({ cls: 'path', line });
        break;
      case 'name':
        deps.push(pypiDep(classified.name, classified.specifier, 'dependencies'));
        break;
    }
  }
  return { path: filePath, deps, pnpmOnlyBuilt: [], python: info };
}

// ---------------------------------------------------------------------------
// TOML manifests

function unreadable(filePath: string): DepGuardError {
  return new DepGuardError(`${filePath}: could not be read as TOML`, 'manifest-parse');
}

// The key path often ends in a head-written TOML key (an optional-dependency,
// PDM dev or dependency-groups group name), so only its leading run of name
// characters prints: the fixed dotted prefixes survive intact, and a token
// written into a key does not.
function malformed(filePath: string, key: string): DepGuardError {
  return new DepGuardError(`${filePath}: [${invalidNameFragment(key)}] could not be read`, 'manifest-parse');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * True when the text is a TOML table once a byte order mark is stripped,
 * the reading readToml gives it. Decides whether a TOML manifest that
 * failed to parse failed on syntax or on shape, for the exit 2 message.
 */
export function isReadableToml(content: string): boolean {
  try {
    return asRecord(parseToml(withoutByteOrderMark(content))) !== null;
  } catch {
    return false;
  }
}

function readToml(filePath: string, content: string): Record<string, unknown> {
  try {
    const parsed: unknown = parseToml(withoutByteOrderMark(content));
    const record = asRecord(parsed);
    if (record === null) {
      throw unreadable(filePath);
    }
    return record;
  } catch (err) {
    if (err instanceof DepGuardError) {
      throw err;
    }
    throw unreadable(filePath);
  }
}

function stringArray(filePath: string, key: string, value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw malformed(filePath, key);
  }
  return value.filter((item): item is string => item !== '');
}

function tableOf(filePath: string, key: string, value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value);
  if (record === null) {
    throw malformed(filePath, key);
  }
  return record;
}

function tableArray(filePath: string, key: string, value: unknown): Array<Record<string, unknown>> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw malformed(filePath, key);
  }
  return value.map((item) => {
    const record = asRecord(item);
    if (record === null) {
      throw malformed(filePath, key);
    }
    return record;
  });
}

function optionalString(filePath: string, key: string, value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw malformed(filePath, key);
  }
  return value;
}

// Only the leading name characters of an invalid string are kept: the
// rest can carry a URL with a token in it, and invalidNames reaches
// python-name-invalid, the JSON, SARIF and pull-request comments.
function noteInvalidName(info: PythonManifestInfo, written: string): void {
  const fragment = invalidNameFragment(written);
  info.exclusions.push({ cls: 'invalidName', name: fragment });
  info.invalidNames.push(fragment);
}

// "-e <target>" and "--editable <target>" inside a TOML requirement list
// (PDM's dev groups write local projects this way). The option is
// stripped and the line is excluded.editable; a VCS or remote URL target
// stays a git or url dependency so the tamper check still judges it.
//
// The target ends at the first whitespace or ";", as PDM reads it (its URL
// pattern is [^\s;]+) and as classifyRequirement cuts a URL: anything after
// that is not part of what installs, so it must not reach the specifier,
// where it could supply an "@<sha>" the installed URL does not have.
function editableString(spec: string): string | null {
  const trimmed = spec.trim();
  for (const option of ['-e ', '-e\t', '--editable ', '--editable\t', '--editable=']) {
    if (trimmed.startsWith(option)) {
      return trimmed.slice(option.length).trim().split(/[\s;]/)[0] ?? '';
    }
  }
  return null;
}

// One PEP 508 string from a TOML array (project.dependencies and the other
// requirement lists). The same classifier as a requirements line, minus the
// option split: a PEP 508 string carries no pip options.
function requirementStrings(
  specs: readonly string[],
  depType: DepType,
  deps: ManifestDep[],
  info: PythonManifestInfo
): void {
  for (const spec of specs) {
    const editable = editableString(spec);
    if (editable !== null) {
      info.exclusions.push({ cls: 'editable' });
      if (isPipUrl(editable) && !editable.toLowerCase().startsWith('file:')) {
        deps.push(userUrlDep(urlDependencyName(editable), editable, depType));
      }
      continue;
    }
    const classified = classifyRequirement(spec);
    switch (classified.kind) {
      case 'invalid':
        noteInvalidName(info, spec.trim());
        break;
      case 'url':
        deps.push(userUrlDep(classified.name, classified.specifier, depType));
        info.exclusions.push({ cls: exclusionClassOf(classified.protocol), name: classified.name });
        break;
      case 'path':
        deps.push(writtenDep(classified.token, classified.token, 'file', depType));
        info.exclusions.push({ cls: 'path' });
        break;
      case 'name':
        deps.push(pypiDep(classified.name, classified.specifier, depType));
        break;
    }
  }
}

function poetryDeps(
  filePath: string,
  table: Record<string, unknown>,
  depType: DepType,
  deps: ManifestDep[],
  info: PythonManifestInfo
): void {
  for (const [name, value] of Object.entries(table)) {
    if (name === 'python') {
      continue;
    }
    if (!isValidPythonName(name)) {
      noteInvalidName(info, name);
      continue;
    }
    const items = Array.isArray(value) ? value : [value];
    const gitItems: ManifestDep[] = [];
    for (const item of items) {
      if (typeof item === 'string') {
        deps.push(pypiDep(name, item, depType));
        continue;
      }
      const record = asRecord(item);
      if (record === null) {
        throw new DepGuardError(`${filePath}: [tool.poetry] dependency "${name}" could not be read`, 'manifest-parse');
      }
      if (typeof record.git === 'string') {
        const ref = [record.rev, record.tag, record.branch].find((entry) => typeof entry === 'string' && entry !== '');
        const dep = gitTableDep(name, record.git, typeof ref === 'string' ? ref : undefined, tableRev(record, record.git), depType);
        deps.push(dep);
        gitItems.push(dep);
        info.exclusions.push({ cls: 'vcs', name });
        continue;
      }
      if (typeof record.url === 'string') {
        deps.push(writtenDep(name, record.url, 'url', depType));
        info.exclusions.push({ cls: 'url', name });
        continue;
      }
      if (typeof record.path === 'string') {
        deps.push(writtenDep(name, record.path, 'file', depType));
        info.exclusions.push({ cls: record.develop === true ? 'editable' : 'path', name });
        continue;
      }
      if (typeof record.source === 'string') {
        info.index.perName.push({ dep: normalizePypiName(name), index: record.source });
      }
      deps.push(pypiDep(name, typeof record.version === 'string' ? record.version : '*', depType));
    }
    unpinAllUnlessAllPinned(gitItems);
  }
}

// A dependency with several git items, one per marker, installs whichever
// one the platform selects, so it is pinned only when every item is. When
// they disagree every item reads unpinned: the tamper check reports one
// finding per dependency and source host, and it must be the worst one,
// whichever item came first.
function unpinAllUnlessAllPinned(gitItems: readonly ManifestDep[]): void {
  if (!gitItems.every((dep) => isFullCommitId(dep.gitTable?.rev))) {
    for (const dep of gitItems) {
      dep.gitTable = { rev: null };
    }
  }
}

function readPoetrySources(filePath: string, poetry: Record<string, unknown>, info: PythonManifestInfo): void {
  for (const source of tableArray(filePath, 'tool.poetry.source', poetry.source)) {
    const name = optionalString(filePath, 'tool.poetry.source', source.name) ?? '';
    const url = optionalString(filePath, 'tool.poetry.source', source.url);
    const priority = optionalString(filePath, 'tool.poetry.source', source.priority);
    if (url === undefined) {
      // A source with no url is PyPI itself (name = "PyPI").
      continue;
    }
    const origin = normalizeIndexOrigin(url);
    const explicit = priority === 'explicit';
    info.index.named.push({ name, origin, explicit });
    if (explicit) {
      continue;
    }
    const replaces = priority === 'primary' || priority === 'default' || source.default === true;
    info.index.wide.push({
      origin,
      option: '[[tool.poetry.source]]',
      alsoPypi: !replaces,
    });
  }
}

function readUvIndexTables(
  filePath: string,
  key: string,
  tables: Array<Record<string, unknown>>,
  info: PythonManifestInfo
): void {
  for (const table of tables) {
    const url = optionalString(filePath, key, table.url);
    if (url === undefined) {
      throw malformed(filePath, key);
    }
    const name = optionalString(filePath, key, table.name);
    const origin = normalizeIndexOrigin(url);
    const explicit = table.explicit === true;
    if (name !== undefined) {
      info.index.named.push({ name, origin, explicit });
    }
    if (!explicit) {
      info.index.wide.push({ origin, option: key === 'index' ? '[[index]]' : '[[tool.uv.index]]', alsoPypi: table.default !== true });
    }
  }
}

function readUvSettings(filePath: string, prefix: string, uv: Record<string, unknown>, info: PythonManifestInfo): void {
  const indexUrl = optionalString(filePath, `${prefix}index-url`, uv['index-url']);
  if (indexUrl !== undefined) {
    addWide(info.index, indexUrl, `${prefix}index-url`, false);
  }
  for (const extra of stringArray(filePath, `${prefix}extra-index-url`, uv['extra-index-url']) ?? []) {
    addWide(info.index, extra, `${prefix}extra-index-url`, true);
  }
  for (const link of stringArray(filePath, `${prefix}find-links`, uv['find-links']) ?? []) {
    addWide(info.index, link, `${prefix}find-links`, true);
  }
  if (uv['no-index'] === true) {
    info.index.wide.push({ origin: 'no index', option: `${prefix}no-index`, alsoPypi: false });
  }
  readUvIndexTables(filePath, prefix === '' ? 'index' : 'tool.uv.index', tableArray(filePath, `${prefix}index`, uv.index), info);
}

function uvSourceOf(filePath: string, name: string, record: Record<string, unknown>): UvSource {
  const key = `tool.uv.sources.${name}`;
  if (typeof record.git === 'string') {
    const ref = [record.rev, record.tag, record.branch].find((entry) => typeof entry === 'string' && entry !== '');
    const rev = tableRev(record, record.git);
    return { kind: 'git', value: record.git, ...(typeof ref === 'string' ? { ref } : {}), ...(rev === null ? {} : { rev }) };
  }
  if (typeof record.url === 'string') {
    return { kind: 'url', value: record.url };
  }
  if (typeof record.path === 'string') {
    return { kind: record.editable === true ? 'editable' : 'path', value: record.path };
  }
  if (record.workspace === true) {
    return { kind: 'workspace', value: '' };
  }
  if (typeof record.index === 'string') {
    return { kind: 'index', value: record.index };
  }
  throw malformed(filePath, key);
}

function readUvSources(filePath: string, sources: Record<string, unknown>, info: PythonManifestInfo): void {
  for (const [written, value] of Object.entries(sources)) {
    if (!isValidPythonName(written)) {
      noteInvalidName(info, written);
      continue;
    }
    const items = Array.isArray(value) ? value : [value];
    const parsed: UvSource[] = [];
    for (const item of items) {
      const record = asRecord(item);
      if (record === null) {
        throw malformed(filePath, `tool.uv.sources.${written}`);
      }
      parsed.push(uvSourceOf(filePath, written, record));
    }
    const dep = normalizePypiName(written);
    info.uvSources.push({ dep, written, sources: parsed });
    for (const source of parsed) {
      if (source.kind === 'index') {
        info.index.perName.push({ dep, index: source.value });
      }
    }
  }
}

function excludeSelf(deps: ManifestDep[], info: PythonManifestInfo): ManifestDep[] {
  if (info.projectName === undefined) {
    return deps;
  }
  const kept: ManifestDep[] = [];
  for (const dep of deps) {
    // "mypkg[test]" inside mypkg's own optional dependencies is the project
    // asking for its own extras, not a name to look up.
    if (dep.protocol === 'pypi' && dep.registryName === info.projectName) {
      info.exclusions.push({ cls: 'self', name: dep.name });
      continue;
    }
    kept.push(dep);
  }
  return kept;
}

export function parsePyproject(filePath: string, content: string): ParsedManifest {
  const doc = readToml(filePath, content);
  const info = emptyInfo('pyproject');
  const deps: ManifestDep[] = [];
  let name: string | undefined;

  const project = asRecord(doc.project);
  if (project !== null) {
    if (typeof project.name === 'string' && project.name !== '') {
      name = project.name;
    }
    const dependencies = stringArray(filePath, 'project.dependencies', project.dependencies);
    if (dependencies !== undefined) {
      requirementStrings(dependencies, 'dependencies', deps, info);
    }
    const optional = asRecord(project['optional-dependencies']);
    if (optional !== null) {
      for (const [group, value] of Object.entries(optional)) {
        const specs = stringArray(filePath, `project.optional-dependencies.${group}`, value);
        if (specs !== undefined) {
          requirementStrings(specs, 'optionalDependencies', deps, info);
        }
      }
    }
  }

  // A build frontend fetches these from the index like any other name.
  const buildSystem = tableOf(filePath, 'build-system', doc['build-system']);
  if (buildSystem !== undefined) {
    const requires = stringArray(filePath, 'build-system.requires', buildSystem.requires);
    if (requires !== undefined) {
      requirementStrings(requires, 'devDependencies', deps, info);
    }
  }

  // PEP 735. An {include-group = "..."} table names another group of the
  // same file, which is read anyway, so it adds no name of its own.
  const groups = tableOf(filePath, 'dependency-groups', doc['dependency-groups']);
  if (groups !== undefined) {
    for (const [group, value] of Object.entries(groups)) {
      if (!Array.isArray(value)) {
        throw malformed(filePath, `dependency-groups.${group}`);
      }
      const specs: string[] = [];
      for (const item of value) {
        if (typeof item === 'string') {
          if (item !== '') {
            specs.push(item);
          }
          continue;
        }
        const record = asRecord(item);
        if (record === null || typeof record['include-group'] !== 'string') {
          throw malformed(filePath, `dependency-groups.${group}`);
        }
      }
      requirementStrings(specs, 'devDependencies', deps, info);
    }
  }

  const tool = asRecord(doc.tool);
  const uv = tableOf(filePath, 'tool.uv', tool?.uv);
  if (uv !== undefined) {
    const devDependencies = stringArray(filePath, 'tool.uv.dev-dependencies', uv['dev-dependencies']);
    if (devDependencies !== undefined) {
      requirementStrings(devDependencies, 'devDependencies', deps, info);
    }
    readUvSettings(filePath, 'tool.uv.', uv, info);
    const sources = tableOf(filePath, 'tool.uv.sources', uv.sources);
    if (sources !== undefined) {
      readUvSources(filePath, sources, info);
    }
    const workspace = tableOf(filePath, 'tool.uv.workspace', uv.workspace);
    if (workspace !== undefined) {
      info.uvWorkspace = {
        members: stringArray(filePath, 'tool.uv.workspace.members', workspace.members) ?? [],
        exclude: stringArray(filePath, 'tool.uv.workspace.exclude', workspace.exclude) ?? [],
      };
    }
  }

  const pdm = tableOf(filePath, 'tool.pdm', tool?.pdm);
  if (pdm !== undefined) {
    const dev = tableOf(filePath, 'tool.pdm.dev-dependencies', pdm['dev-dependencies']);
    if (dev !== undefined) {
      for (const [group, value] of Object.entries(dev)) {
        const specs = stringArray(filePath, `tool.pdm.dev-dependencies.${group}`, value);
        if (specs !== undefined) {
          requirementStrings(specs, 'devDependencies', deps, info);
        }
      }
    }
    for (const source of tableArray(filePath, 'tool.pdm.source', pdm.source)) {
      const url = optionalString(filePath, 'tool.pdm.source', source.url);
      if (url === undefined) {
        throw malformed(filePath, 'tool.pdm.source');
      }
      const sourceName = optionalString(filePath, 'tool.pdm.source', source.name) ?? '';
      const origin = normalizeIndexOrigin(url);
      info.index.named.push({ name: sourceName, origin, explicit: false });
      info.index.wide.push({ origin, option: '[[tool.pdm.source]]', alsoPypi: sourceName.toLowerCase() !== 'pypi' });
    }
  }

  const poetry = asRecord(tool?.poetry);
  if (poetry !== null) {
    if (name === undefined && typeof poetry.name === 'string' && poetry.name !== '') {
      // A Poetry 1 project names itself here rather than in [project].
      name = poetry.name;
    }
    const top = asRecord(poetry.dependencies);
    if (top !== null) {
      poetryDeps(filePath, top, 'dependencies', deps, info);
    }
    // Poetry 1.1 and earlier kept development dependencies in their own
    // table; a url or git source there is as installable as any other.
    const legacyDev = asRecord(poetry['dev-dependencies']);
    if (legacyDev !== null) {
      poetryDeps(filePath, legacyDev, 'devDependencies', deps, info);
    }
    const poetryGroups = asRecord(poetry.group);
    if (poetryGroups !== null) {
      for (const group of Object.values(poetryGroups)) {
        const table = asRecord(asRecord(group)?.dependencies);
        if (table !== null) {
          poetryDeps(filePath, table, 'devDependencies', deps, info);
        }
      }
    }
    readPoetrySources(filePath, poetry, info);
  }

  if (name !== undefined && isValidPythonName(name)) {
    info.projectName = normalizePypiName(name);
  }
  return {
    path: filePath,
    ...(name === undefined ? {} : { name }),
    deps: excludeSelf(deps, info),
    pnpmOnlyBuilt: [],
    python: info,
  };
}

function pipfileSection(
  filePath: string,
  key: string,
  table: Record<string, unknown>,
  depType: DepType,
  deps: ManifestDep[],
  info: PythonManifestInfo
): void {
  for (const [name, value] of Object.entries(table)) {
    if (!isValidPythonName(name)) {
      noteInvalidName(info, name);
      continue;
    }
    if (typeof value === 'string') {
      deps.push(pypiDep(name, value, depType));
      continue;
    }
    const record = asRecord(value);
    if (record === null) {
      throw malformed(filePath, `${key}.${name}`);
    }
    if (typeof record.git === 'string') {
      const ref = commitKey(record.ref);
      deps.push(gitTableDep(name, record.git, ref ?? undefined, pinningRev(record.git, record.ref), depType));
      info.exclusions.push({ cls: record.editable === true ? 'editable' : 'vcs', name });
      continue;
    }
    const location = typeof record.file === 'string' ? record.file : typeof record.path === 'string' ? record.path : null;
    if (location !== null) {
      if (isPipUrl(location)) {
        deps.push(userUrlDep(name, location, depType));
        info.exclusions.push({ cls: record.editable === true ? 'editable' : exclusionClassOf(urlProtocol(location)), name });
      } else {
        deps.push(writtenDep(name, location, 'file', depType));
        info.exclusions.push({ cls: record.editable === true ? 'editable' : 'path', name });
      }
      continue;
    }
    if (typeof record.index === 'string') {
      info.index.perName.push({ dep: normalizePypiName(name), index: record.index });
    }
    deps.push(pypiDep(name, typeof record.version === 'string' ? record.version : '*', depType));
  }
}

export function parsePipfile(filePath: string, content: string): ParsedManifest {
  const doc = readToml(filePath, content);
  const info = emptyInfo('pipfile');
  const deps: ManifestDep[] = [];
  const sources = tableArray(filePath, 'source', doc.source);
  const origins = sources.map((source) => {
    const url = optionalString(filePath, 'source', source.url);
    if (url === undefined) {
      throw malformed(filePath, 'source');
    }
    return { name: optionalString(filePath, 'source', source.name) ?? '', origin: normalizeIndexOrigin(url) };
  });
  // pipenv consults every declared source, so each one can serve any name.
  for (const { name, origin } of origins) {
    info.index.named.push({ name, origin, explicit: false });
    info.index.wide.push({ origin, option: '[[source]]', alsoPypi: origins.length > 1 });
  }
  const packages = tableOf(filePath, 'packages', doc.packages);
  if (packages !== undefined) {
    pipfileSection(filePath, 'packages', packages, 'dependencies', deps, info);
  }
  const devPackages = tableOf(filePath, 'dev-packages', doc['dev-packages']);
  if (devPackages !== undefined) {
    pipfileSection(filePath, 'dev-packages', devPackages, 'devDependencies', deps, info);
  }
  return { path: filePath, deps, pnpmOnlyBuilt: [], python: info };
}

/**
 * A repository uv.toml: uv's configuration for its own directory. It
 * carries index settings only, never dependencies, so it contributes index
 * declarations to the pyproject.toml beside it and nothing else.
 */
export function parseUvToml(filePath: string, content: string): ParsedManifest {
  const doc = readToml(filePath, content);
  const info = emptyInfo('uv-toml');
  readUvSettings(filePath, '', doc, info);
  return { path: filePath, deps: [], pnpmOnlyBuilt: [], python: info };
}

export function parsePythonManifest(
  filePath: string,
  content: string,
  options: { constraint?: boolean } = {}
): ParsedManifest {
  switch (pythonManifestKind(filePath)) {
    case 'pyproject':
      return parsePyproject(filePath, content);
    case 'pipfile':
      return parsePipfile(filePath, content);
    case 'uv-toml':
      return parseUvToml(filePath, content);
    case 'requirements':
    case null:
      // A file reached only through -r has whatever name it has.
      return parseRequirements(filePath, content, options);
  }
}
