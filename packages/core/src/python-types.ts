// Shapes the Python readers produce beside a manifest's dependency list.
// Kept in their own file so manifest.ts can carry them on ParsedManifest
// without importing the parsers.

// Why a dependency is not a PyPI name candidate. Every Python requirement
// that is not a candidate is counted under exactly one of these (the
// ecosystems line and run.ecosystems.pypi.excluded).
export type PythonExclusionClass =
  | 'url'
  | 'vcs'
  | 'path'
  | 'editable'
  | 'constraint'
  | 'self'
  | 'invalidName'
  | 'unrecognised';

export const PYTHON_EXCLUSION_CLASSES: readonly PythonExclusionClass[] = [
  'url',
  'vcs',
  'path',
  'editable',
  'constraint',
  'self',
  'invalidName',
  'unrecognised',
];

export interface PythonExclusion {
  cls: PythonExclusionClass;
  // The written name, when the excluded line had one.
  name?: string;
  // 1-based line number in a requirements file.
  line?: number;
}

// A requirements line, or a TOML value, that was not read. Each one is
// named in a requirements-line-unread or python-name-invalid diagnostic.
export interface PythonUnreadLine {
  line: number;
  reason: 'unrecognised' | 'env-var' | 'remote-include' | 'include-unread';
  detail?: string;
}

// One package index a manifest declares. `origin` is already normalised
// and has had any userinfo removed (python-index.ts), so it is safe to
// print. `alsoPypi` is true for an index pip or uv consults beside PyPI
// (--extra-index-url, --find-links, a supplemental source), which is what
// the dependency-confusion sentence of pypi-private-index-skipped reads.
export interface PythonIndexOrigin {
  origin: string;
  option: string;
  alsoPypi: boolean;
}

export interface PythonNamedIndex {
  name: string;
  origin: string;
  explicit: boolean;
}

// Everything a manifest says about where its names come from. These are
// control inputs: on a --trust-base run they are read from the trust base
// copy of the same path, never from the tree being judged.
export interface PythonIndexDeclarations {
  // Indexes that can serve any name in the manifest (a non-explicit
  // index, --index-url, --extra-index-url, --find-links, --no-index).
  wide: PythonIndexOrigin[];
  // Named indexes a per-name mapping can point at.
  named: PythonNamedIndex[];
  // Per-name mappings onto a named index ([tool.uv.sources] x = { index },
  // a poetry dependency's source key, a Pipfile entry's index key). `dep`
  // is the normalised dependency name.
  perName: Array<{ dep: string; index: string }>;
}

export type UvSourceKind = 'git' | 'url' | 'path' | 'editable' | 'workspace' | 'index';

export interface UvSource {
  kind: UvSourceKind;
  // The git or url location, the path, or the index name. Empty for a
  // workspace source.
  value: string;
  // A git source's ref (its rev, tag or branch key), when it names one.
  ref?: string;
  // A git source's own `rev` key alone, when it has one and its git value
  // carries no ref text of its own: the only value that can make it a
  // commit pin (ManifestDep.gitTable).
  rev?: string;
}

export interface PythonIncludeRef {
  target: string;
  constraint: boolean;
  line: number;
}

export type PythonManifestKind = 'requirements' | 'pyproject' | 'pipfile' | 'uv-toml';

export interface PythonManifestInfo {
  kind: PythonManifestKind;
  // The normalised project.name, or tool.poetry.name for a Poetry 1
  // project with no [project] table.
  projectName?: string;
  exclusions: PythonExclusion[];
  unread: PythonUnreadLine[];
  invalidNames: string[];
  // -r and -c targets as written, resolved against the file's directory by
  // the loader (git-source.ts), which is the only place that can read them.
  includes: PythonIncludeRef[];
  index: PythonIndexDeclarations;
  // [tool.uv.sources], keyed by normalised dependency name.
  uvSources: Array<{ dep: string; written: string; sources: UvSource[] }>;
  // [tool.uv.workspace], when the file is a workspace root.
  uvWorkspace?: { members: string[]; exclude: string[] };
  // True for a file reached only through -c: its names never install.
  constraint?: boolean;
}

export function emptyIndexDeclarations(): PythonIndexDeclarations {
  return { wide: [], named: [], perName: [] };
}

// A full git commit object id (sha1 or sha256), the same test the tamper
// check applies to a git table's rev (IMMUTABLE_GIT_REF in
// checks/tamper.ts). Used where several git items of one dependency are
// reconciled into one pin verdict before the tamper check sees them.
export function isFullCommitId(rev: string | null | undefined): boolean {
  return typeof rev === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(rev);
}

export type PythonLockfileFormat = 'poetry' | 'uv' | 'pdm' | 'pipenv';

export type PythonLockSource =
  | { kind: 'pypi' }
  // A registry origin other than PyPI, recorded by the lockfile itself.
  // Never exempts on its own (python-index.ts, lockfileSkip).
  | { kind: 'index'; origin: string }
  | { kind: 'excluded'; cls: PythonExclusionClass };

export interface PythonLockEntry {
  written: string;
  name: string; // normalised
  version: string | null;
  source: PythonLockSource;
}

export interface PythonLockfile {
  path: string;
  format: PythonLockfileFormat;
  entries: PythonLockEntry[];
  // Set when the file could not be read for names; entries is then empty
  // and python-lockfile-unreadable names the path.
  unreadable?: string;
  invalidNames: string[];
}
