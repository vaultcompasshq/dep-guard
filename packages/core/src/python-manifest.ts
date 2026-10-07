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

  const direct = body.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*@\s*(\S+)$/);
  if (direct !== null && direct[1] !== undefined && direct[2] !== undefined) {
    return dep(direct[1], direct[2], protocolOfUrl(direct[2]));
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

interface TomlSection {
  name: string;
  body: string;
}

function tomlSections(content: string): TomlSection[] {
  const sections: TomlSection[] = [];
  let name = '';
  let body: string[] = [];
  const flush = (): void => {
    sections.push({ name, body: body.join('\n') });
    body = [];
  };
  for (const raw of withoutByteOrderMark(content).split(/\r?\n/)) {
    const line = stripRequirementComment(raw).trim();
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header !== null && header[1] !== undefined) {
      flush();
      name = header[1].trim();
      continue;
    }
    body.push(line);
  }
  flush();
  return sections;
}

function stringLiterals(value: string): string[] {
  const found: string[] = [];
  for (const match of value.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'/g)) {
    const text = match[1] ?? match[2] ?? '';
    if (text !== '') {
      found.push(text);
    }
  }
  return found;
}

function bracketArray(body: string, key: string): string[] | null {
  const start = body.indexOf(key);
  if (start === -1) {
    return null;
  }
  const open = body.indexOf('[', start + key.length);
  if (open === -1) {
    return null;
  }
  let depth = 0;
  for (let i = open; i < body.length; i += 1) {
    const char = body[i];
    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return stringLiterals(body.slice(open + 1, i));
      }
    }
  }
  return null;
}

function poetryDeps(body: string, depType: DepType): ManifestDep[] {
  const deps: ManifestDep[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('[')) {
      continue;
    }
    const assigned = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(.+)$/);
    if (assigned === null || assigned[1] === undefined || assigned[2] === undefined) {
      continue;
    }
    if (assigned[1] === 'python') {
      continue;
    }
    const value = assigned[2].trim();
    if (value.startsWith('{')) {
      const version = value.match(/version\s*=\s*"([^"]*)"|version\s*=\s*'([^']*)'/);
      const specifier = version?.[1] ?? version?.[2] ?? '*';
      deps.push(dep(assigned[1], specifier, 'pypi', depType));
      continue;
    }
    const quoted = value.match(/^"([^"]*)"|^'([^']*)'/);
    if (quoted !== null) {
      deps.push(dep(assigned[1], quoted[1] ?? quoted[2] ?? '*', 'pypi', depType));
    }
  }
  return deps;
}

function requirementDeps(specs: readonly string[], depType: DepType): ManifestDep[] {
  const deps: ManifestDep[] = [];
  for (const spec of specs) {
    const parsed = requirementToDep(spec);
    if (parsed === null) {
      continue;
    }
    deps.push({ ...parsed, depType });
  }
  return deps;
}

export function parsePyproject(filePath: string, content: string): ParsedManifest {
  let name: string | undefined;
  const deps: ManifestDep[] = [];
  for (const section of tomlSections(content)) {
    if (section.name === 'project') {
      const declared = section.body.match(/name\s*=\s*"([^"]+)"|name\s*=\s*'([^']+)'/);
      const projectName = declared?.[1] ?? declared?.[2];
      if (projectName !== undefined && projectName !== '') {
        name = projectName;
      }
      const dependencies = bracketArray(section.body, 'dependencies');
      if (section.body.includes('dependencies') && dependencies === null && section.body.includes('[')) {
        throw new DepGuardError(
          `${filePath}: [project] dependencies could not be read`,
          'manifest-parse'
        );
      }
      if (dependencies !== null) {
        deps.push(...requirementDeps(dependencies, 'dependencies'));
      }
      continue;
    }
    if (section.name.startsWith('project.optional-dependencies')) {
      deps.push(...requirementDeps(stringLiterals(section.body), 'optionalDependencies'));
      continue;
    }
    if (
      section.name === 'tool.poetry.dependencies' ||
      /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section.name)
    ) {
      const depType: DepType = section.name.includes('.group.') ? 'devDependencies' : 'dependencies';
      deps.push(...poetryDeps(section.body, depType));
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
