import { withoutByteOrderMark } from './text.js';
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
  | 'alias'
  // A Python package index dependency (requirements.txt or pyproject.toml).
  // Not an npm registry name, so the npm corpus checks do not see it.
  | 'pypi';

export interface ManifestDep {
  name: string; // the key in package.json
  registryName: string; // alias target if npm: alias, else same as name -- ALL name checks use this
  specifier: string;
  depType: DepType;
  protocol: Protocol;
}

export interface ParsedManifest {
  path: string;
  // The manifest's own "name" field, when it is a string. Read so a
  // dependency on a workspace package can be told apart from one a
  // lockfile would record, from the manifests actually discovered rather
  // than from anything the lockfile says.
  name?: string;
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

// The hosted-git-info shorthand schemes npm resolves to a git repository:
// "github:owner/repo", "gitlab:owner/repo", "bitbucket:owner/repo",
// "gist:id" and "sourcehut:~owner/repo" (hosted-git-info's own host table).
const HOSTED_GIT_SCHEMES = ['github:', 'gitlab:', 'bitbucket:', 'gist:', 'sourcehut:'];

// A path a package manager reads as a local file before it considers any
// git spelling (npm-package-arg's isFilespec): "./x", "../x", "/x", "~/x",
// and a Windows drive path. None of these is a git shorthand even though
// most contain a slash.
const LOCAL_PATH_SPEC = /^(?:[.]|~[/]|[/\\]|[a-zA-Z]:)/;

// The bare "owner/repo" shorthand, with an optional "#ref": npm treats a
// dependency specifier of this shape as github:owner/repo. This is
// hosted-git-info's isGitHubShorthand rule, kept as close to verbatim as
// its logic allows because the two have to agree on which strings are git:
// a slash that is not the first character and not at the end, no
// whitespace, "@" or ":" before any "#", and only one slash before any "#".
// Registry specifiers (a version, a range, a dist-tag) never contain a
// slash, so nothing an ordinary dependency is written as reaches this.
function isGitHubShorthand(spec: string): boolean {
  const firstHash = spec.indexOf('#');
  const firstSlash = spec.indexOf('/');
  const secondSlash = spec.indexOf('/', firstSlash + 1);
  const firstColon = spec.indexOf(':');
  const firstSpace = /\s/.exec(spec);
  const firstAt = spec.indexOf('@');

  const spaceOnlyAfterHash = firstSpace === null || (firstHash > -1 && firstSpace.index > firstHash);
  const atOnlyAfterHash = firstAt === -1 || (firstHash > -1 && firstAt > firstHash);
  const colonOnlyAfterHash = firstColon === -1 || (firstHash > -1 && firstColon > firstHash);
  const secondSlashOnlyAfterHash = secondSlash === -1 || (firstHash > -1 && secondSlash > firstHash);
  const hasSlash = firstSlash > 0;
  const doesNotEndWithSlash = firstHash > -1 ? spec[firstHash - 1] !== '/' : !spec.endsWith('/');
  const doesNotStartWithDot = !spec.startsWith('.');

  return (
    spaceOnlyAfterHash &&
    hasSlash &&
    doesNotEndWithSlash &&
    doesNotStartWithDot &&
    atOnlyAfterHash &&
    colonOnlyAfterHash &&
    secondSlashOnlyAfterHash
  );
}

// scp-style git: "git@github.com:owner/repo(.git)(#ref)". npm reads this
// shape as git only for the hosts hosted-git-info knows (github.com,
// gist.github.com, gitlab.com, bitbucket.org, git.sr.ht) and only with a
// path that does not start with a slash; for any other host it reads the
// same string as a local directory (checked against npm's bundled
// npm-package-arg), so an unknown host is deliberately not git here. A
// registry specifier never contains "@" followed later by ":", and the
// "npm:" alias prefix is handled before this is reached.
const SCP_STYLE_GIT = /^[^@\s/:]+@(?:github\.com|gist\.github\.com|gitlab\.com|bitbucket\.org|git\.sr\.ht):[^/\s][^\s]*$/;

function isGitSpecifier(specifier: string): boolean {
  const lower = specifier.toLowerCase();
  if (
    lower.startsWith('git+') ||
    lower.startsWith('git:') ||
    lower.startsWith('ssh://') ||
    HOSTED_GIT_SCHEMES.some((scheme) => lower.startsWith(scheme))
  ) {
    return true;
  }
  if (LOCAL_PATH_SPEC.test(specifier)) {
    return false;
  }
  return SCP_STYLE_GIT.test(specifier) || isGitHubShorthand(specifier);
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
  if (specifier.startsWith('http://') || specifier.startsWith('https://')) {
    return { protocol: 'url', registryName: name };
  }
  if (specifier.startsWith('npm:')) {
    return { protocol: 'alias', registryName: parseAliasTarget(specifier.slice(4)) };
  }
  if (isGitSpecifier(specifier)) {
    return { protocol: 'git', registryName: name };
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
    parsed = JSON.parse(withoutByteOrderMark(content));
  } catch {
    throw new DepGuardError(`${path}: not valid JSON`, 'manifest-parse');
  }
  if (!isPlainObject(parsed)) {
    throw new DepGuardError(`${path}: manifest is not a JSON object`, 'manifest-parse');
  }
  return {
    path,
    ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
    deps: extractDeps(path, parsed),
    pnpmOnlyBuilt: extractPnpmOnlyBuilt(path, parsed),
  };
}
