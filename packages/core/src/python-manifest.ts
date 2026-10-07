import { parse as parseToml } from 'smol-toml';
import type { DepType, ManifestDep, ParsedManifest } from './manifest.js';
import { withoutByteOrderMark } from './text.js';
import { DepGuardError } from './types.js';

// Python manifests this scan reads. A pyproject.toml that only holds
// [tool.*] config still parses: zero dependencies is a real result, and
// the file counts as a resolved manifest.
const PYPROJECT = 'pyproject.toml';
const REQUIREMENTS = 'requirements.txt';

function dep(
  name: string,
  specifier: string,
  protocol: ManifestDep['protocol'],
  depType: DepType = 'dependencies'
): ManifestDep {
  return { name, registryName: name, specifier, depType, protocol };
}

function isGitSpecifier(specifier: string): boolean {
  const lower = specifier.toLowerCase();
  return (
    lower.startsWith('git+') ||
    lower.startsWith('git:') ||
    lower.startsWith('ssh://') ||
    lower.startsWith('hg+') ||
    lower.startsWith('svn+') ||
    lower.startsWith('bzr+')
  );
}

function protocolOfUrl(specifier: string): 'git' | 'url' {
  return isGitSpecifier(specifier) ? 'git' : 'url';
}

// PEP 503 name, then optional extras, then the rest of the requirement.
const REQUIREMENT_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?|\*)(\[[^\]]*\])?\s*([\s\S]*)$/;

function stripRequirementComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote !== null) {
      if (char === quote && line[i - 1] !== '\\') {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

// Flags that name an option rather than a package. Includes of other files
// (`-r`) are not followed: each requirements file is read on its own when
// its own name is requirements.txt.
function isRequirementsOption(line: string): boolean {
  return (
    line.startsWith('-r ') ||
    line.startsWith('--requirement ') ||
    line.startsWith('-c ') ||
    line.startsWith('--constraint ') ||
    line.startsWith('-i ') ||
    line.startsWith('--index-url ') ||
    line.startsWith('--extra-index-url ') ||
    line.startsWith('-f ') ||
    line.startsWith('--find-links ') ||
    line.startsWith('--trusted-host ') ||
    line.startsWith('--no-binary') ||
    line.startsWith('--only-binary') ||
    line.startsWith('--use-feature') ||
    line.startsWith('--no-index') ||
    line.startsWith('--hash') ||
    line === '-Z' ||
    line.startsWith('--always-unzip')
  );
}

function nameFromEgg(specifier: string): string | null {
  const egg = specifier.match(/[#&]egg=([^&#\s]+)/);
  if (egg === null || egg[1] === undefined || egg[1] === '') {
    return null;
  }
  return egg[1];
}

function requirementToDep(line: string): ManifestDep | null {
  let body = line.trim();
  if (body.startsWith('-e ')) {
    body = body.slice(3).trim();
  } else if (body.startsWith('--editable ')) {
    body = body.slice('--editable '.length).trim();
  }
  const marker = body.indexOf(';');
  if (marker !== -1) {
    body = body.slice(0, marker).trim();
  }
  if (body === '') {
    return null;
  }

  const direct = body.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*@\s*(\S+)$/);
  if (direct !== null && direct[1] !== undefined && direct[3] !== undefined) {
    return dep(direct[1], direct[3], protocolOfUrl(direct[3]));
  }

  if (/^(https?:|git\+|git:|ssh:|svn\+|hg\+|bzr\+)/i.test(body)) {
    const name = nameFromEgg(body);
    if (name === null) {
      return null;
    }
    return dep(name, body, protocolOfUrl(body));
  }

  const named = body.match(REQUIREMENT_NAME);
  if (named === null || named[1] === undefined || named[1] === '*') {
    return null;
  }
  const specifier = (named[3] ?? '').trim();
  return dep(named[1], specifier === '' ? '*' : specifier, 'pypi');
}

export function parseRequirements(filePath: string, content: string): ParsedManifest {
  const deps: ManifestDep[] = [];
  let pending = '';
  const logical: string[] = [];
  for (const raw of withoutByteOrderMark(content).split(/\r?\n/)) {
    const piece = raw.trim();
    if (piece.endsWith('\\')) {
      pending += piece.slice(0, -1);
      continue;
    }
    logical.push(pending + piece);
    pending = '';
  }
  if (pending !== '') {
    logical.push(pending);
  }
  for (const raw of logical) {
    const line = stripRequirementComment(raw).trim();
    if (line === '' || line.startsWith('#') || isRequirementsOption(line)) {
      continue;
    }
    const parsed = requirementToDep(line);
    if (parsed !== null) {
      deps.push(parsed);
    }
  }
  return { path: filePath, deps, pnpmOnlyBuilt: [] };
}

function unreadable(filePath: string): DepGuardError {
  return new DepGuardError(`${filePath}: could not be read as TOML`, 'manifest-parse');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
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
    throw new DepGuardError(`${filePath}: [${key}] could not be read`, 'manifest-parse');
  }
  return value.filter((item): item is string => item !== '');
}

function requirementDeps(specs: readonly string[], depType: DepType): ManifestDep[] {
  const deps: ManifestDep[] = [];
  for (const spec of specs) {
    const parsed = requirementToDep(spec);
    if (parsed !== null) {
      deps.push({ ...parsed, depType });
    }
  }
  return deps;
}

function poetrySpecifier(table: Record<string, unknown>): { specifier: string; protocol: ManifestDep['protocol'] } {
  if (typeof table.git === 'string') {
    const rev = [table.rev, table.tag, table.branch].find((item) => typeof item === 'string' && item !== '');
    return {
      specifier: typeof rev === 'string' ? `${table.git}#${rev}` : table.git,
      protocol: 'git',
    };
  }
  if (typeof table.url === 'string') {
    return { specifier: table.url, protocol: 'url' };
  }
  if (typeof table.path === 'string') {
    return { specifier: table.path, protocol: 'file' };
  }
  if (typeof table.version === 'string') {
    return { specifier: table.version, protocol: 'pypi' };
  }
  return { specifier: '*', protocol: 'pypi' };
}

function poetryDeps(filePath: string, table: Record<string, unknown>, depType: DepType): ManifestDep[] {
  const deps: ManifestDep[] = [];
  for (const [name, value] of Object.entries(table)) {
    if (name === 'python') {
      continue;
    }
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item === 'string') {
        deps.push(dep(name, item, 'pypi', depType));
        continue;
      }
      const record = asRecord(item);
      if (record === null) {
        throw new DepGuardError(`${filePath}: [tool.poetry] dependency "${name}" could not be read`, 'manifest-parse');
      }
      const parsed = poetrySpecifier(record);
      deps.push(dep(name, parsed.specifier, parsed.protocol, depType));
    }
  }
  return deps;
}

export function parsePyproject(filePath: string, content: string): ParsedManifest {
  const doc = readToml(filePath, content);
  const project = asRecord(doc.project);
  let name: string | undefined;
  const deps: ManifestDep[] = [];
  if (project !== null) {
    if (typeof project.name === 'string' && project.name !== '') {
      name = project.name;
    }
    const dependencies = stringArray(filePath, 'project.dependencies', project.dependencies);
    if (dependencies !== undefined) {
      deps.push(...requirementDeps(dependencies, 'dependencies'));
    }
    const optional = asRecord(project['optional-dependencies']);
    if (optional !== null) {
      for (const [group, value] of Object.entries(optional)) {
        const specs = stringArray(filePath, `project.optional-dependencies.${group}`, value);
        if (specs !== undefined) {
          deps.push(...requirementDeps(specs, 'optionalDependencies'));
        }
      }
    }
  }
  const poetry = asRecord(asRecord(doc.tool)?.poetry);
  if (poetry !== null) {
    const top = asRecord(poetry.dependencies);
    if (top !== null) {
      deps.push(...poetryDeps(filePath, top, 'dependencies'));
    }
    const groups = asRecord(poetry.group);
    if (groups !== null) {
      for (const group of Object.values(groups)) {
        const table = asRecord(asRecord(group)?.dependencies);
        if (table !== null) {
          deps.push(...poetryDeps(filePath, table, 'devDependencies'));
        }
      }
    }
  }
  return {
    path: filePath,
    ...(name === undefined ? {} : { name }),
    deps,
    pnpmOnlyBuilt: [],
  };
}

export function isPythonManifestPath(filePath: string): boolean {
  const slash = filePath.lastIndexOf('/');
  const base = slash === -1 ? filePath : filePath.slice(slash + 1);
  return base === PYPROJECT || base === REQUIREMENTS;
}
