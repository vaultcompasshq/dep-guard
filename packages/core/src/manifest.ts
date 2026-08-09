import { DepGuardError } from './types.js';

export type DepType = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';

export type Protocol =
  | 'registry'
  | 'workspace'
  | 'catalog'
  | 'link'
  | 'patch'
  | 'file'
  | 'git'
  | 'url'
  | 'alias';

export interface ManifestDep {
  name: string; // the key in package.json
  registryName: string; // alias target if npm: alias, else same as name -- ALL name checks use this
  specifier: string;
  depType: DepType;
  protocol: Protocol;
}

export interface ParsedManifest {
  path: string;
  deps: ManifestDep[];
  pnpmOnlyBuilt: string[];
}

const DEP_TYPES: DepType[] = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

// npm: aliases carry their target after the last "@" that isn't the scope
// marker at position 0, e.g. "lodash@4.17.21" -> "lodash",
// "@scope/pkg@1.0.0" -> "@scope/pkg". A target with no version specifier
// (or a bare/scoped name with none) has no such "@" and is returned whole.
function parseAliasTarget(rest: string): string {
  const atIndex = rest.lastIndexOf('@');
  return atIndex > 0 ? rest.slice(0, atIndex) : rest;
}

function classifySpecifier(name: string, specifier: string): { protocol: Protocol; registryName: string } {
  if (specifier.startsWith('workspace:')) {
    return { protocol: 'workspace', registryName: name };
  }
  if (specifier.startsWith('catalog:')) {
    return { protocol: 'catalog', registryName: name };
  }
  if (specifier.startsWith('link:') || specifier.startsWith('portal:')) {
    return { protocol: 'link', registryName: name };
  }
  if (specifier.startsWith('patch:')) {
    return { protocol: 'patch', registryName: name };
  }
  if (specifier.startsWith('file:')) {
    return { protocol: 'file', registryName: name };
  }
  if (
    specifier.startsWith('git+') ||
    specifier.startsWith('github:') ||
    specifier.startsWith('git:')
  ) {
    return { protocol: 'git', registryName: name };
  }
  if (specifier.startsWith('http://') || specifier.startsWith('https://')) {
    return { protocol: 'url', registryName: name };
  }
  if (specifier.startsWith('npm:')) {
    return { protocol: 'alias', registryName: parseAliasTarget(specifier.slice(4)) };
  }
  return { protocol: 'registry', registryName: name };
}

function extractDeps(path: string, manifestObj: Record<string, unknown>): ManifestDep[] {
  const deps: ManifestDep[] = [];
  for (const depType of DEP_TYPES) {
    const section = manifestObj[depType];
    if (section === undefined) {
      continue;
    }
    if (!isPlainObject(section)) {
      throw new DepGuardError(`${path}: "${depType}" is not an object`, 'manifest-parse');
    }
    // Object.entries only ever returns the object's own enumerable
    // properties, so keys like "constructor" or "__proto__" (both legal
    // npm package names) are handled like any other dependency instead of
    // resolving to inherited Object.prototype members.
    for (const [name, value] of Object.entries(section)) {
      if (typeof value !== 'string') {
        throw new DepGuardError(
          `${path}: dependency "${name}" in "${depType}" has a non-string specifier`,
          'manifest-parse'
        );
      }
      const { protocol, registryName } = classifySpecifier(name, value);
      deps.push({ name, registryName, specifier: value, depType, protocol });
    }
  }
  return deps;
}

function extractPnpmOnlyBuilt(path: string, manifestObj: Record<string, unknown>): string[] {
  const pnpmValue = manifestObj.pnpm;
  if (pnpmValue === undefined) {
    return [];
  }
  if (!isPlainObject(pnpmValue)) {
    throw new DepGuardError(`${path}: "pnpm" field is not an object`, 'manifest-parse');
  }
  const onlyBuilt = pnpmValue.onlyBuiltDependencies;
  if (onlyBuilt === undefined) {
    return [];
  }
  if (!isStringArray(onlyBuilt)) {
    throw new DepGuardError(
      `${path}: "pnpm.onlyBuiltDependencies" is not an array of strings`,
      'manifest-parse'
    );
  }
  return onlyBuilt;
}

export function parseManifest(path: string, content: string): ParsedManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new DepGuardError(`${path}: not valid JSON`, 'manifest-parse');
  }
  if (!isPlainObject(parsed)) {
    throw new DepGuardError(`${path}: manifest is not a JSON object`, 'manifest-parse');
  }
  return {
    path,
    deps: extractDeps(path, parsed),
    pnpmOnlyBuilt: extractPnpmOnlyBuilt(path, parsed),
  };
}
