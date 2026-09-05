import { parse as parseYaml, parseAllDocuments } from 'yaml';
import { DepGuardError, type Diagnostic } from '../types.js';
import type { LockEntry, ParsedLockfile } from './types.js';
import type { ParsedManifest } from '../manifest.js';

const WORKSPACE_YAML_LABEL = 'pnpm-workspace.yaml';

// npm package name grammar, loosely: an optional "@scope/" prefix followed
// by a name, each segment made of letter/digit/"-"/"."/"_"/"~". Used below
// to catch a packages key whose name/version split landed in the wrong
// place rather than to fully police registry publish rules. A leading "."
// or "_" is allowed in both the scope and name segments: npm's
// publish-time rule forbids a
// leading "." or "_" for NEW packages, but names like "_" and
// "__proto__" were published before that rule existed and remain
// resolvable today, and lockfile-npm.test.ts already asserts that the npm
// parser keeps a "__proto__"-named entry. Rejecting the same name here
// would mean one lockfile format kept a dependency the other silently
// dropped.
const PNPM_NAME_GRAMMAR = /^(@[a-z0-9-._~][a-z0-9-._~]*\/)?[a-z0-9-._~][a-z0-9-._~]*$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseYamlDocument(path: string, content: string): unknown {
  try {
    return parseYaml(content);
  } catch {
    throw new DepGuardError(`${path}: not valid YAML`, 'lockfile-parse');
  }
}

// A pnpm-lock.yaml is a YAML STREAM, not a single document. pnpm 12
// self-manages the pnpm binary and writes that as its own document,
// separated by a bare "---" line, alongside the project's real lockfile.
// `parse()` throws MULTIPLE_DOCS on such a file, which arrived here as
// lockfile-parse and made every scan of such a repository a
// could-not-run exit 2 with no way around it.
//
// parseAllDocuments does not throw for a malformed document the way
// parse() does: it collects the failures on each Document's own `errors`
// array and hands the stream back regardless. So the errors have to be
// read and rethrown, or a document that failed to compose would arrive
// here as an empty mapping and every lockfile-backed check would be
// silently satisfied against a tree that was never read -- the exact
// fail-open this parser's throw exists to prevent.
function parseYamlStream(path: string, content: string): unknown[] {
  let documents;
  try {
    documents = parseAllDocuments(content);
  } catch {
    throw new DepGuardError(`${path}: not valid YAML`, 'lockfile-parse');
  }
  const values: unknown[] = [];
  for (const document of documents) {
    if (document.errors.length > 0) {
      throw new DepGuardError(`${path}: not valid YAML`, 'lockfile-parse');
    }
    values.push(document.toJS());
  }
  // An empty stream (an empty or comment-only file) yields no documents at
  // all. parse() returns null for the same input, and the caller's
  // "not a YAML mapping" throw is what handled that before, so one null
  // document keeps that path exactly as it was.
  return values.length === 0 ? [null] : values;
}

// The importer sections that mean "a real project declared a dependency
// here". pnpm's self-management importer carries packageManagerDependencies
// and configDependencies and none of these.
const PROJECT_IMPORTER_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

function importersOf(document: Record<string, unknown>): Record<string, unknown> | undefined {
  return isPlainObject(document.importers) ? document.importers : undefined;
}

// pnpm's self-management document, recognised the way pnpm writes it: it
// has importers, every one of them records a packageManagerDependencies
// block, and none of them declares an ordinary dependency section. Both
// halves are required. "carries packageManagerDependencies" alone would
// misfile a project document that happens to record its own packageManager
// field, and "declares no dependencies" alone would misfile a genuinely
// empty project.
function isSelfManagementDocument(document: Record<string, unknown>): boolean {
  const importers = importersOf(document);
  if (importers === undefined) {
    return false;
  }
  const values = Object.values(importers).filter(isPlainObject);
  if (values.length === 0) {
    return false;
  }
  return values.every(
    (importer) =>
      importer.packageManagerDependencies !== undefined &&
      PROJECT_IMPORTER_SECTIONS.every((section) => importer[section] === undefined)
  );
}

// Which document in the stream is the project's own lockfile.
//
// The rule, in order, because the order is what makes it work on a real
// pnpm 12 file:
//
//  1. A stream of one document is that document, whatever shape it has.
//     A repository whose only dependency is pnpm itself has exactly one
//     document and it is the self-management block; that IS its lockfile.
//  2. Otherwise, discard the self-management documents first. This step
//     has to come before the "." rule below, because in a real pnpm 12
//     lockfile BOTH documents claim a "." importer -- pnpm's self-managed
//     binary is recorded as a root-project dependency of its own -- so a
//     rule that reached for "." first would call every such file ambiguous
//     and keep failing exactly the scans this exists to fix.
//  3. Among what is left, the project lockfile is the document whose
//     importers carry the "." (root project) importer.
//  4. Absent any "." importer, it is the document with the most importers,
//     and only when that maximum is unique.
//  5. Anything else -- no candidate document at all, two candidates each
//     claiming ".", a tie on importer count, no document carrying
//     importers -- is a lockfile-parse failure whose message names the
//     ambiguity. Guessing here would mean scanning part of a dependency
//     tree and reporting the result as if it were the whole one.
//
// The self-management document's own packages are deliberately NOT
// scanned, and the caller says so in a diagnostic. They are real installed
// dependencies and reading them would be a coverage improvement, but it is
// a coverage improvement -- new findings on packages no previous release
// looked at -- and this fix ships in a patch, which fixes wrong verdicts
// and never adds coverage. The diagnostic is what keeps the omission from
// reading as a clean scan of the whole file.
function selectProjectDocument(
  path: string,
  documents: Record<string, unknown>[]
): { document: Record<string, unknown>; skipped: number } {
  if (documents.length === 1) {
    return { document: documents[0], skipped: 0 };
  }
  const candidates = documents.filter((document) => !isSelfManagementDocument(document));
  const rooted = candidates.filter((document) => {
    const importers = importersOf(document);
    return importers !== undefined && Object.hasOwn(importers, '.');
  });
  if (rooted.length === 1) {
    return { document: rooted[0], skipped: documents.length - 1 };
  }
  if (rooted.length > 1) {
    throw new DepGuardError(
      `${path}: this lockfile holds ${documents.length} YAML documents and ${rooted.length} of them ` +
        'declare a "." root importer, so dep-guard cannot tell which one the project installs from',
      'lockfile-parse'
    );
  }
  const importerCount = (document: Record<string, unknown>): number =>
    Object.keys(importersOf(document) ?? {}).length;
  const withImporters = candidates.filter((document) => importerCount(document) > 0);
  if (withImporters.length === 0) {
    throw new DepGuardError(
      `${path}: this lockfile holds ${documents.length} YAML documents and none of them declares ` +
        'the importers that identify a project lockfile, so dep-guard cannot tell which one the ' +
        'project installs from',
      'lockfile-parse'
    );
  }
  const most = Math.max(...withImporters.map(importerCount));
  const largest = withImporters.filter((document) => importerCount(document) === most);
  if (largest.length === 1) {
    return { document: largest[0], skipped: documents.length - 1 };
  }
  throw new DepGuardError(
    `${path}: this lockfile holds ${documents.length} YAML documents and ${largest.length} of them ` +
      'declare the same number of importers, so dep-guard cannot tell which one the project ' +
      'installs from',
    'lockfile-parse'
  );
}

// A packages-map key identifies a resolved package as name, version, and
// (v9 only) an optional trailing peer-dependency suffix in parentheses --
// e.g. "lodash@4.17.21", "@scope/pkg@1.0.0", or
// "@scope/pkg@1.0.0(peer@2.0.0)". Pre-v9 lockfiles additionally prefix the
// whole key with a leading "/", e.g. "/lodash@4.17.21".
//
// Keying note: entries below are stored by this REGISTRY name -- the name
// portion of the packages key -- not by an installed/aliased name the way
// npm.ts keys its entries. pnpm packages keys are already registry
// identity, so no further resolution is needed. delta.ts's delta step
// attaches lock entries to a ManifestDep by trying ManifestDep.name
// first, then registryName, precisely because npm and pnpm lockfiles key
// their entries differently.
//
// Splitting on the last "@" is unambiguous for
// ordinary semver versions, but a git/URL-resolved dependency's key can
// embed its own "@" -- e.g.
// "mypkg@git+ssh://git@gitlab.com/o/r.git#abc" -- and the last "@" there
// sits inside the embedded ssh URL, not at the real separator, producing
// a garbage name ("mypkg@git+ssh://git"). The caller validates the
// extracted name against PNPM_NAME_GRAMMAR and skips the entry (with a
// diagnostic) when that happens, rather than silently mis-keying it.
function parsePackageKey(key: string): { name: string; version: string } | undefined {
  let rest = key.startsWith('/') ? key.slice(1) : key;
  const parenIdx = rest.indexOf('(');
  if (parenIdx !== -1) {
    rest = rest.slice(0, parenIdx);
  }
  // The version separator is the last "@" in the remaining "name@version"
  // (or "@scope/name@version") string -- semver versions never contain
  // "@", so this is unambiguous. An "@" at index 0 is the scope marker,
  // not a separator, and is excluded via atIndex > 0 (mirrors
  // manifest.ts#parseAliasTarget's scope-aware split).
  const atIndex = rest.lastIndexOf('@');
  if (atIndex <= 0) {
    return undefined;
  }
  const name = rest.slice(0, atIndex);
  const version = rest.slice(atIndex + 1);
  if (name.length === 0 || version.length === 0) {
    return undefined;
  }
  return { name, version };
}

// pnpm writes a real "version" field on the packages
// entry itself for git/URL-resolved dependencies, where the key-derived
// version (whatever followed the last "@") is actually a URL fragment,
// not a version. A string-typed value.version is authoritative when
// present; the key-derived version remains the fallback for entries that
// don't carry one (the normal case).
function entryFromPackageValue(value: Record<string, unknown>, keyVersion: string): LockEntry {
  const version = typeof value.version === 'string' ? value.version : keyVersion;
  const entry: LockEntry = { version };
  const resolution = value.resolution;
  if (isPlainObject(resolution)) {
    if (typeof resolution.tarball === 'string') {
      entry.resolvedUrl = resolution.tarball;
    }
    if (typeof resolution.integrity === 'string') {
      entry.integrity = resolution.integrity;
    }
  }
  // hasInstallScript is intentionally never set here: pnpm v9 dropped that
  // flag from the lockfile, so there is no field to read it from. See the
  // standing pnpm-no-install-script-flag diagnostic below.
  return entry;
}

// A bare packages key and a pre-v9-shaped peer-suffixed key for the same
// name can both resolve to the exact same version/integrity/resolvedUrl.
// Appending both unconditionally would leave two indistinguishable list
// elements for one real dependency, which would make the delta step
// raise a spurious delta-ambiguous-lock-entry diagnostic over a collision
// that isn't actually ambiguous. Two entries are only genuinely different
// resolved versions -- worth keeping both for -- when at least one of
// these fields differs.
function lockEntriesEqual(a: LockEntry, b: LockEntry): boolean {
  return (
    a.version === b.version &&
    a.resolvedUrl === b.resolvedUrl &&
    a.integrity === b.integrity &&
    a.hasInstallScript === b.hasInstallScript
  );
}

export function parsePnpmLockfile(path: string, content: string): ParsedLockfile {
  const documents = parseYamlStream(path, content);
  // Every document in the stream has to be a mapping, not only the one
  // that gets selected: a stream carrying a scalar or a sequence document
  // is a file this parser does not understand, and understanding half of
  // it is how a partial read gets reported as a whole one.
  for (const document of documents) {
    if (!isPlainObject(document)) {
      throw new DepGuardError(`${path}: lockfile is not a YAML mapping`, 'lockfile-parse');
    }
  }
  const { document: parsed, skipped } = selectProjectDocument(
    path,
    documents as Record<string, unknown>[]
  );

  const diagnostics: Diagnostic[] = [
    // pnpm v9 removed the per-package hasInstallScript flag from the
    // lockfile entirely, so the install-script check has no lockfile
    // signal to read for this format. Emitted unconditionally (not only
    // when an install-script finding would otherwise fire) so the check
    // can report itself skipped instead of silently going quiet and
    // looking like a clean scan.
    {
      code: 'pnpm-no-install-script-flag',
      message: `${path}: pnpm lockfiles do not record install-script metadata; the install-script check is skipped for this lockfile`,
    },
  ];
  if (skipped > 0) {
    // Coverage the engine did not provide has to say so. The packages in
    // the documents this parser passed over are really installed, and
    // nothing else in the scan will mention them.
    diagnostics.push({
      code: 'pnpm-multi-document-lockfile',
      message:
        `${path}: this lockfile holds ${skipped + 1} YAML documents; the project lockfile document ` +
        `was read and ${skipped} pnpm self-management document(s) were not scanned, so the pnpm ` +
        'binaries they install are not covered by this scan',
    });
  }
  const entries = new Map<string, LockEntry[]>();

  const packages = parsed.packages;
  if (packages === undefined) {
    // Unlike npm's flat "packages" map (always present from
    // lockfileVersion 2 on), pnpm omits the "packages" key entirely when a
    // workspace has no external dependencies at all. That is valid-empty,
    // not corrupt.
    return { format: 'pnpm', path, entries, diagnostics, workspaceLocalNames: new Set() };
  }
  if (!isPlainObject(packages)) {
    // A lockfile with a "packages" key that is present but not a mapping
    // -- including a dangling "packages:" line with no value, which YAML
    // parses to null, the same truncated-hand-edit shape as any other
    // non-mapping value -- must not be treated as the
    // valid-empty case above; that would fail open, silently disabling
    // every lockfile-backed check. Throw instead.
    throw new DepGuardError(`${path}: "packages" is present but not a mapping`, 'lockfile-parse');
  }

  // Object.entries only returns own enumerable properties, so packages
  // keys named "constructor" or "__proto__" -- legal npm/pnpm package
  // names -- are handled like any other entry instead of colliding with
  // inherited Object.prototype members.
  for (const [key, value] of Object.entries(packages)) {
    const parsedKey = parsePackageKey(key);
    if (parsedKey === undefined) {
      diagnostics.push({
        code: 'pnpm-lockfile-invalid-entry',
        message: `${path}: packages key "${key}" could not be parsed into a name and version; skipped`,
      });
      continue;
    }
    if (!PNPM_NAME_GRAMMAR.test(parsedKey.name)) {
      diagnostics.push({
        code: 'pnpm-lockfile-invalid-entry',
        message: `${path}: packages key "${key}" did not split into a valid package name ("${parsedKey.name}"); skipped`,
      });
      continue;
    }
    if (!isPlainObject(value)) {
      diagnostics.push({
        code: 'pnpm-lockfile-invalid-entry',
        message: `${path}: packages["${key}"] is not a mapping; skipped`,
      });
      continue;
    }
    const { name, version } = parsedKey;
    // Multiple packages keys can resolve to the same registry name, most
    // commonly two different versions of the same package installed for
    // different peer-dependency sets. Real lockfiles hit this often
    // enough that collapsing to a single entry would silently discard one
    // and let an arbitrary version win, so every distinct resolved
    // version for a name is retained, in insertion order -- but a
    // collision that resolves to an identical entry (see
    // lockEntriesEqual above) is a duplicate, not a second version, and
    // is not appended again.
    const entry = entryFromPackageValue(value, version);
    const existing = entries.get(name);
    if (!existing) {
      entries.set(name, [entry]);
    } else if (!existing.some((e) => lockEntriesEqual(e, entry))) {
      existing.push(entry);
    }
  }

  return { format: 'pnpm', path, entries, diagnostics, workspaceLocalNames: new Set() };
}

// Merges the onlyBuiltDependencies allowlist from pnpm-workspace.yaml (the
// workspace-wide setting) with every workspace manifest's own
// pnpm.onlyBuiltDependencies block (a package can extend the allowlist
// locally). pnpm honors both sources together, so dep-guard's allowBuilt
// check needs their union, deduplicated, to match what pnpm actually
// permits to run install scripts.
export function parseOnlyBuilt(
  workspaceYamlContent: string | null,
  manifests: ParsedManifest[]
): string[] {
  const merged = new Set<string>();

  if (workspaceYamlContent !== null) {
    const parsed = parseYamlDocument(WORKSPACE_YAML_LABEL, workspaceYamlContent);
    // An empty or comment-only pnpm-workspace.yaml parses to null/undefined
    // rather than an empty mapping -- that is a benign
    // "nothing configured here" document, not a corrupt one, so it is
    // treated as contributing no names rather than throwing. A document
    // that parses to some other non-mapping shape (a scalar, an array) is
    // still a throw: that is a genuinely malformed workspace file.
    if (parsed !== null && parsed !== undefined) {
      if (!isPlainObject(parsed)) {
        throw new DepGuardError(`${WORKSPACE_YAML_LABEL}: not a YAML mapping`, 'lockfile-parse');
      }
      const onlyBuilt = parsed.onlyBuiltDependencies;
      // "onlyBuiltDependencies:" with nothing after it parses to null,
      // same benign-empty reasoning as the document-level case above; an
      // absent key and an explicit null both contribute nothing. Any other
      // non-array shape (a string, a mapping) is still a throw.
      if (onlyBuilt !== undefined && onlyBuilt !== null) {
        if (!isStringArray(onlyBuilt)) {
          throw new DepGuardError(
            `${WORKSPACE_YAML_LABEL}: "onlyBuiltDependencies" is not an array of strings`,
            'lockfile-parse'
          );
        }
        for (const name of onlyBuilt) {
          merged.add(name);
        }
      }
    }
  }

  for (const manifest of manifests) {
    for (const name of manifest.pnpmOnlyBuilt) {
      merged.add(name);
    }
  }

  return [...merged];
}
