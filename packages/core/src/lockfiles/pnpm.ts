import { parse as parseYaml, Composer, Parser, type Document } from 'yaml';
import { withoutByteOrderMark } from '../text.js';
import { DepGuardError, type Diagnostic } from '../types.js';
import type { LockEntry, ParsedLockfile, PnpmSkippedEntry } from './types.js';
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
    return parseYaml(withoutByteOrderMark(content));
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
// The stream is composed lazily and capped. A real pnpm 12 lockfile has
// exactly two documents (the project lockfile and pnpm's self-management
// block); anyone who can write the lockfile can instead make it a stream of
// arbitrarily many documents -- a file of nothing but bare "---" separators,
// up to the 64 MB ceiling the git-diff path already imposes, composes one
// Document per separator and then materialises each with toJS(), turning a
// few tens of megabytes into millions of Documents and array entries before
// a single one is validated. So the stream is read with the streaming
// Parser/Composer rather than parseAllDocuments (which is eager: it builds
// the whole array before returning) and fails closed the instant a document
// past MAX_LOCKFILE_DOCUMENTS appears -- nothing beyond the cap is ever
// composed, and nothing is materialised with toJS() until the whole stream
// is known to be within the cap. Four is generous for a format whose real
// files carry two.
//
// The alias-bomb variant -- a single document whose anchors expand
// combinatorially when materialised -- is bounded separately by the yaml
// library's maxAliasCount, which defaults to 100 in yaml 2.9 (confirmed in
// yaml 2.9.0: nodes/Node.js#toJS uses 100 when none is passed, and
// nodes/Alias.js throws once count * aliasCount exceeds it). toJS() below is
// called with no options, so that default applies and the cap on document
// count above does not need to also reason about intra-document expansion.
//
// Composing lazily also preserves the fail-closed reading of per-document
// errors: the composer, like parseAllDocuments, does not throw for a
// malformed document -- it hands the document back with the failures on its
// own `errors` array -- so a document that failed to compose would otherwise
// arrive here as an empty mapping and satisfy every lockfile-backed check
// against a tree that was never read. Every document's errors are read and
// rethrown.
const MAX_LOCKFILE_DOCUMENTS = 4;

function parseYamlStream(
  path: string,
  content: string
): { values: unknown[]; ranges: Array<[number, number] | null> } {
  const documents: Document[] = [];
  try {
    const composer = new Composer();
    const parser = new Parser();
    for (const document of composer.compose(parser.parse(content))) {
      documents.push(document);
      if (documents.length > MAX_LOCKFILE_DOCUMENTS) {
        throw new DepGuardError(
          `${path}: this lockfile holds more than ${MAX_LOCKFILE_DOCUMENTS} YAML documents, which ` +
            'dep-guard refuses to read; a pnpm lockfile has at most a project document and a ' +
            'self-management document',
          'lockfile-parse'
        );
      }
    }
  } catch (err) {
    // The cap throw is a deliberate DepGuardError and is re-raised as-is;
    // anything else out of the streaming parser is a malformed stream and
    // becomes the same "not valid YAML" lockfile-parse a single-document
    // failure has always been.
    if (err instanceof DepGuardError) {
      throw err;
    }
    throw new DepGuardError(`${path}: not valid YAML`, 'lockfile-parse');
  }
  const values: unknown[] = [];
  // Where each document sits in the file, so everything outside the one
  // that is read can be compared byte for byte with the other side.
  const ranges: Array<[number, number] | null> = [];
  for (const document of documents) {
    if (document.errors.length > 0) {
      throw new DepGuardError(`${path}: not valid YAML`, 'lockfile-parse');
    }
    values.push(document.toJS());
    const range = document.range;
    ranges.push(range === undefined ? null : [range[0], range[2]]);
  }
  // An empty stream (an empty or comment-only file) yields no documents at
  // all. parse() returns null for the same input, and the caller's
  // "not a YAML mapping" throw is what handled that before, so one null
  // document keeps that path exactly as it was.
  return values.length === 0 ? { values: [null], ranges: [null] } : { values, ranges };
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
// The selected document is the project lockfile the manifest walk reads.
// The self-management document, and any other document shaped like a
// lockfile, is read as well, into a lockfile of its own (see
// parsePnpmLockfile).
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
// their entries differently. The one exception is a key that names no
// package at all (a pre-v9 git or tarball key, see readPackages), which is
// stored under the name its entry records.
//
// Splitting on the last "@" is unambiguous for
// ordinary semver versions, but a git/URL-resolved dependency's key can
// embed its own "@" -- e.g.
// "mypkg@git+ssh://git@gitlab.com/o/r.git#abc" -- and the last "@" there
// sits inside the embedded ssh URL, not at the real separator, producing
// a garbage name ("mypkg@git+ssh://git"). The caller validates the
// extracted name against PNPM_NAME_GRAMMAR and skips the entry (with a
// diagnostic) when that happens, rather than silently mis-keying it.
// lockfileVersion 5.x writes "/name/version" and "/@scope/name/version",
// with any peer set appended to the version after an underscore
// ("/react-dom/17.0.2_react@17.0.2"). The version segment has to start with
// a digit, which keeps a v6 key ("/name@1.0.0", "/@scope/name@1.0.0") from
// ever reading this way.
const V5_PACKAGE_KEY = /^\/(@[^/@]+\/[^/@]+|[^/@][^/@]*)\/([0-9][^/]*)$/;

function parsePackageKey(key: string): { name: string; version: string } | undefined {
  if (!key.includes('(')) {
    const v5 = V5_PACKAGE_KEY.exec(key);
    if (v5 !== null) {
      const version = v5[2].split('_')[0];
      return version === '' ? undefined : { name: v5[1], version };
    }
  }
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
  //
  // A URL-shaped version ("name@git+ssh://git@host/o/r.git#sha") is the
  // exception, and it is recognised first: the version is everything after
  // the FIRST "@" that is followed by a "scheme://", because the URL's own
  // userinfo "@" would otherwise be taken for the separator. Skipping such a
  // key with a diagnostic, as this once did, left a newly added git
  // dependency in a pnpm lockfile unread.
  const urlVersion = /^(@?[^@]+)@([a-zA-Z][a-zA-Z0-9+.-]*:\/\/.+)$/.exec(rest);
  if (urlVersion !== null) {
    return { name: urlVersion[1], version: urlVersion[2] };
  }
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

// semver's strict "valid" grammar (the FULL pattern), which pnpm 8's
// dependency-path parse uses to decide whether a key carries a version.
const SEMVER_VALID =
  /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// pnpm 8 dependency-path indexOfPeersSuffix: where a trailing "(...)" peer
// suffix starts, or -1.
function indexOfPeersSuffix(depPath: string): number {
  if (!depPath.endsWith(')')) {
    return -1;
  }
  let open = 1;
  for (let i = depPath.length - 2; i >= 0; i -= 1) {
    if (depPath[i] === '(') {
      open -= 1;
    } else if (depPath[i] === ')') {
      open += 1;
    } else if (open === 0) {
      return i + 1;
    }
  }
  return -1;
}

// A key below lockfile v9 that does not start with "/", read the way pnpm 8
// reads it. pnpm 8 keeps the registry host in front of a package that came
// from a registry other than the configured one ("registry.npmjs.org/
// is-positive/3.1.0" in v5, "registry.npmjs.org/is-positive@3.1.0" in v6).
// On reading a v6 lockfile it first turns "host/name@version" back into
// "host/name/version" (lockfile/lockfile-file/src/experiments/
// inlineSpecifiersLockfileConverters.ts, convertLockfileV6DepPathToV5DepPath),
// then dependency-path parse drops the first segment as the host and takes
// the name (one segment, or two for a scope) and a version that semver calls
// valid, after a "(...)" or "_..." peer suffix (packages/dependency-path/
// src/index.ts, parse; both at pnpm 8.15.9). Such an entry is a registry
// install of that name and version: with no tarball, pnpm fetches it from
// the configured registry by that name (pkgSnapshotToResolution, getTarball).
// A git or tarball key ("github.com/<owner>/<repo>/<commit>") has no valid
// version there and is undefined here too.
function parseHostPrefixedKey(key: string, major: number): { name: string; version: string } | undefined {
  if (key.startsWith('/') || key.startsWith('file:')) {
    return undefined;
  }
  let depPath = key;
  if (major === 6 && depPath.includes('@', 2)) {
    const index = depPath.indexOf('@', depPath.indexOf('/@') + 2);
    if (index === -1) {
      return undefined;
    }
    if (!(depPath.includes('(') && index > indexOfPeersSuffix(depPath))) {
      depPath = `${depPath.slice(0, index)}/${depPath.slice(index + 1)}`;
    }
  }
  const parts = depPath.split('/');
  parts.shift();
  if (parts.length === 0 || parts[0] === '') {
    return undefined;
  }
  const name = parts[0].startsWith('@') ? (parts.length > 1 ? `${parts.shift()}/${parts.shift()}` : undefined) : parts.shift();
  let version = parts.join('/');
  if (name === undefined || version === '') {
    return undefined;
  }
  if (version.includes('(') && version.endsWith(')')) {
    version = version.slice(0, version.indexOf('('));
  } else if (version.includes('_')) {
    version = version.slice(0, version.indexOf('_'));
  }
  return SEMVER_VALID.test(version) ? { name, version } : undefined;
}

// pnpm writes a real "version" field on the packages
// entry itself for git/URL-resolved dependencies, where the key-derived
// version (whatever followed the last "@") is actually a URL fragment,
// not a version. A string-typed value.version is authoritative when
// present; the key-derived version remains the fallback for entries that
// don't carry one (the normal case).
function entryFromPackageValue(value: Record<string, unknown>, keyVersion: string | undefined): LockEntry {
  const version = typeof value.version === 'string' ? value.version : keyVersion;
  const entry: LockEntry = version === undefined ? {} : { version };
  // The key's own version, when the entry records a different one. pnpm 8
  // and 9 build the tarball URL of an entry with no tarball from the key, so
  // that is the version they fetch (pkgSnapshotToResolution, getTarball);
  // pnpm 10 fetches the recorded one. The deny list judges both.
  if (keyVersion !== undefined && version !== keyVersion) {
    entry.keyVersion = keyVersion;
  }
  // The entry's own "name" field, verbatim, at every lockfile version. Read
  // by the deny list only, as one more name to match: it never decides what
  // pnpm fetches, which is the key's name (pnpmSnapshotName below is the
  // separate, narrower field that picks a registry before v9).
  if (typeof value.name === 'string' && value.name !== '') {
    entry.pnpmNameField = value.name;
  }
  const resolution = value.resolution;
  if (isPlainObject(resolution)) {
    if (typeof resolution.tarball === 'string') {
      entry.resolvedUrl = resolution.tarball;
    }
    if (typeof resolution.integrity === 'string') {
      entry.integrity = resolution.integrity;
    }
    // A git resolution carries no tarball and no hash:
    // {type: git, repo: <url>, commit: <sha>}. Left unread, a git-sourced
    // package was indistinguishable from a bare one and no source signal
    // could ever fire on it. It is recorded in the spelling npm writes for
    // the same source (git+<url>#<commit>), so the one resolution parser
    // classifies it as git. An scp-style repo ("git@host:o/r.git") has no
    // scheme and is the same ssh source, spelled git+ssh://git@host/o/r.git.
    // A repo that is neither is left unrecorded rather than invented into a
    // URL nothing could parse.
    if (entry.resolvedUrl === undefined && resolution.type === 'git' && typeof resolution.repo === 'string') {
      const scp = /^([^@\s/:]+)@([^:\s/]+):(?!\/)(.+)$/.exec(resolution.repo);
      const repo = resolution.repo.includes('://')
        ? /^(?:git\+|git:|ssh:)/.test(resolution.repo)
          ? resolution.repo
          : `git+${resolution.repo}`
        : scp !== null
          ? `git+ssh://${scp[1]}@${scp[2]}/${scp[3]}`
          : null;
      if (repo !== null) {
        entry.resolvedUrl = typeof resolution.commit === 'string' ? `${repo}#${resolution.commit}` : repo;
      }
    }
  }
  // Lockfile versions before 9 record "requiresBuild: true" on a package
  // that runs a build or install script; v9 dropped the field, which is
  // what the standing pnpm-no-install-script-flag diagnostic below is for.
  if (value.requiresBuild === true) {
    entry.hasInstallScript = true;
  }
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
    a.hasInstallScript === b.hasInstallScript &&
    // Before v9 the name field picks the registry a tarball path is read
    // against, so two entries that differ there are not one entry.
    a.pnpmSnapshotName === b.pnpmSnapshotName &&
    // Every name and version the deny list reads stays: dropping one of two
    // entries that differ only there would drop a name or a version pnpm
    // fetches.
    a.pnpmNameField === b.pnpmNameField &&
    a.keyVersion === b.keyVersion &&
    a.pnpmRawKey === b.pnpmRawKey
  );
}

export function parsePnpmLockfile(path: string, rawContent: string): ParsedLockfile {
  const content = withoutByteOrderMark(rawContent);
  const { values: documents, ranges } = parseYamlStream(path, content);
  // Every document in the stream has to be a mapping, not only the one
  // that gets selected: a stream carrying a scalar or a sequence document
  // is a file this parser does not understand, and understanding half of
  // it is how a partial read gets reported as a whole one.
  for (const document of documents) {
    if (!isPlainObject(document)) {
      throw new DepGuardError(`${path}: lockfile is not a YAML mapping`, 'lockfile-parse');
    }
  }
  const { document: parsed } = selectProjectDocument(path, documents as Record<string, unknown>[]);

  // Every other document that is shaped like a pnpm lockfile (pnpm writes
  // one for its own managed version) is read too, into a lockfile of its
  // own under a labelled path, so its entries go through every check.
  // computeDelta compares it with the same labelled path on the other side
  // when there is one, else with the first lockfile of the same format there
  // (normally the project document). Within one side, entries of different
  // documents are never merged. A document that is not shaped like a
  // pnpm lockfile stays unread, and its text is kept for the downgrade rule.
  const additionalDocuments: ParsedLockfile[] = [];
  const readIndexes = new Set<number>([documents.indexOf(parsed)]);
  let selfManagementCount = 0;
  let otherCount = 0;
  documents.forEach((document, index) => {
    if (document === parsed || !isLockfileShaped(document as Record<string, unknown>)) {
      return;
    }
    const record = document as Record<string, unknown>;
    let label: string;
    if (isSelfManagementDocument(record)) {
      selfManagementCount += 1;
      label = selfManagementCount === 1 ? 'package-manager' : `package-manager-${selfManagementCount}`;
    } else {
      otherCount += 1;
      label = `document-${otherCount}`;
    }
    const documentPath = `${path}#${label}`;
    const documentDiagnostics: Diagnostic[] = [];
    const documentSkipped: PnpmSkippedEntry[] = [];
    const documentEntries = readPackages(documentPath, record, documentDiagnostics, documentSkipped);
    if (documentEntries === null) {
      return;
    }
    readIndexes.add(index);
    additionalDocuments.push({
      format: 'pnpm',
      path: documentPath,
      entries: documentEntries,
      diagnostics: documentDiagnostics,
      workspaceLocalNames: new Set(),
      documentOf: path,
      ...(documentSkipped.length > 0 ? { skippedEntries: documentSkipped } : {}),
    });
  });
  const unreadCount = documents.length - readIndexes.size;

  // The bytes of the file outside every document that was read: the
  // unread documents, in order, with the directives and separators around
  // them. Part of what the package manager installs from, so the downgrade
  // rule compares them with the same path on the other side (delta.ts).
  // Recorded only when some document is unread; a read document with no
  // recorded position makes the whole file count, which can only refuse
  // more.
  let unreadText: string | undefined;
  if (unreadCount > 0) {
    const readRanges = [...readIndexes].map((index) => ranges[index] ?? null);
    if (readRanges.some((range) => range === null)) {
      unreadText = content;
    } else {
      const sorted = (readRanges as Array<[number, number]>).sort((a, b) => a[0] - b[0]);
      let cursor = 0;
      unreadText = '';
      for (const [start, end] of sorted) {
        unreadText += `${content.slice(cursor, start)}\u0000`;
        cursor = end;
      }
      unreadText += content.slice(cursor);
    }
  }
  const skippedField = {
    ...(unreadText === undefined ? {} : { unreadText }),
    ...(additionalDocuments.length > 0 ? { additionalDocuments } : {}),
  };
  const skipped = unreadCount;

  // pnpm v9 removed the per-package requiresBuild flag from the lockfile
  // entirely, so the install-script check has no lockfile signal to read
  // for that format. Emitted for every lockfile that is not provably older
  // than v9 (not only when an install-script finding would otherwise
  // fire) so the check can report itself skipped instead of silently going
  // quiet and looking like a clean scan. An unreadable version gets the
  // note too.
  const major = Number.parseInt(String(parsed.lockfileVersion ?? ''), 10);
  const recordsRequiresBuild = Number.isInteger(major) && major < 9;
  const diagnostics: Diagnostic[] = recordsRequiresBuild
    ? []
    : [
        {
          code: 'pnpm-no-install-script-flag',
          message: `${path}: pnpm lockfiles do not record install-script metadata; the install-script check is skipped for this lockfile`,
        },
      ];
  if (skipped > 0) {
    // Coverage the engine did not provide has to say so. The packages in
    // the documents this parser passed over are really installed, and
    // nothing else in the scan will mention them.
    //
    // The count is every document that is not shaped like a pnpm lockfile
    // and so was not read. Every lockfile-shaped document, the selected one
    // and the others alike, is read and is not counted here.
    diagnostics.push({
      code: 'pnpm-multi-document-lockfile',
      message:
        `${path}: this lockfile holds ${documents.length} YAML documents; ${skipped} document(s) that ` +
        'are not shaped like a pnpm lockfile were not scanned, so any packages they install are not ' +
        'covered by this scan',
    });
  }
  const skippedEntries: PnpmSkippedEntry[] = [];
  const entries = readPackages(path, parsed, diagnostics, skippedEntries);
  if (entries === null) {
    // A lockfile with a "packages" key that is present but not a mapping
    // -- including a dangling "packages:" line with no value, which YAML
    // parses to null, the same truncated-hand-edit shape as any other
    // non-mapping value -- must not be treated as valid-empty; that would
    // fail open, silently disabling every lockfile-backed check. Throw
    // instead.
    throw new DepGuardError(`${path}: "packages" is present but not a mapping`, 'lockfile-parse');
  }
  return {
    format: 'pnpm',
    path,
    entries,
    diagnostics,
    workspaceLocalNames: new Set(),
    ...skippedField,
    ...(skippedEntries.length > 0 ? { skippedEntries } : {}),
  };
}

// A document pnpm could have written as a lockfile: a lockfile version,
// and importers and packages that are mappings when present.
function isLockfileShaped(document: Record<string, unknown>): boolean {
  const version = document.lockfileVersion;
  return (
    (typeof version === 'string' || typeof version === 'number') &&
    (document.importers === undefined || isPlainObject(document.importers)) &&
    (document.packages === undefined || isPlainObject(document.packages))
  );
}

const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

// True when every dependency the document records, in every importer and at
// the top level (a single-project lockfile keeps its dependencies there),
// resolves to a link: (a workspace directory, which has no packages entry).
// Anything this cannot read as that -- a section or importer that is not a
// mapping, a version that is not a string, any other version at all -- is
// false, so the null-packages refusal stands for it.
function recordsOnlyLinks(document: Record<string, unknown>): boolean {
  const projects: unknown[] = [document];
  if (document.importers !== undefined) {
    if (!isPlainObject(document.importers)) {
      return false;
    }
    projects.push(...Object.values(document.importers));
  }
  for (const project of projects) {
    if (!isPlainObject(project)) {
      return false;
    }
    for (const section of DEPENDENCY_SECTIONS) {
      const deps = project[section];
      if (deps === undefined) {
        continue;
      }
      if (!isPlainObject(deps)) {
        return false;
      }
      for (const value of Object.values(deps)) {
        // v5 records a version string; v6 and later {specifier, version}.
        const version = isPlainObject(value) ? value.version : value;
        if (typeof version !== 'string' || !version.startsWith('link:')) {
          return false;
        }
      }
    }
  }
  return true;
}

// The entries of one document's "packages" map, or null when "packages"
// is present but not a mapping. A missing "packages" is valid-empty:
// unlike npm's flat map, pnpm omits the key when there are no external
// dependencies at all.
// A packages entry readPackages could not read, as written: the key, and the
// entry's own name and version when it is a mapping that has them.
function skippedEntryOf(key: string, value: unknown): PnpmSkippedEntry {
  const skipped: PnpmSkippedEntry = { key };
  if (isPlainObject(value)) {
    if (typeof value.name === 'string' && value.name !== '') {
      skipped.name = value.name;
    }
    if (typeof value.version === 'string') {
      skipped.version = value.version;
    }
  }
  return skipped;
}

function readPackages(
  path: string,
  document: Record<string, unknown>,
  diagnostics: Diagnostic[],
  skipped: PnpmSkippedEntry[] = []
): Map<string, LockEntry[]> | null {
  const entries = new Map<string, LockEntry[]>();
  const packages = document.packages;
  if (packages === undefined) {
    return entries;
  }
  if (packages === null && recordsOnlyLinks(document)) {
    // A bare "packages:" (null) in a lockfile whose every recorded
    // dependency is a link: is found in real repositories (a lockfileVersion
    // 5.4 workspace of links only). Such a lockfile has no packages to
    // record, so empty is the truth about it rather than a fail-open
    // reading. With any other dependency recorded, a null map is still the
    // truncated shape refused below.
    return entries;
  }
  if (!isPlainObject(packages)) {
    return null;
  }

  // Object.entries only returns own enumerable properties, so packages
  // keys named "constructor" or "__proto__" -- legal npm/pnpm package
  // names -- are handled like any other entry instead of colliding with
  // inherited Object.prototype members.
  const append = (name: string, entry: LockEntry): void => {
    const existing = entries.get(name);
    if (!existing) {
      entries.set(name, [entry]);
    } else if (!existing.some((e) => lockEntriesEqual(e, entry))) {
      existing.push(entry);
    }
  };
  const major = Number.parseInt(String(document.lockfileVersion ?? ''), 10);
  const preV9 = Number.isInteger(major) && major < 9;
  // Below v9 pnpm 8 picks the registry it fetches from by the entry's own
  // name field when it has one (lockfile/lockfile-utils/src/
  // nameVerFromPkgSnapshot.ts and pkgSnapshotToResolution.ts at 8.15.9),
  // so that field is kept for resolvePnpmRelativeTarballs and for nothing
  // else. A resolution with a "type" (git, directory) is returned unchanged
  // there and picks no registry, so it keeps no such field.
  const withSnapshotName = (entry: LockEntry, value: Record<string, unknown>): LockEntry =>
    preV9 &&
    typeof value.name === 'string' &&
    value.name !== '' &&
    !(isPlainObject(value.resolution) && value.resolution.type !== undefined)
      ? { ...entry, pnpmSnapshotName: value.name }
      : entry;
  for (const [key, value] of Object.entries(packages)) {
    let parsedKey = parsePackageKey(key);
    if (preV9 && (parsedKey === undefined || !PNPM_NAME_GRAMMAR.test(parsedKey.name))) {
      const hosted = parseHostPrefixedKey(key, major);
      if (hosted !== undefined && PNPM_NAME_GRAMMAR.test(hosted.name)) {
        parsedKey = hosted;
      }
    }
    const unsplit =
      parsedKey === undefined
        ? `${path}: packages key "${key}" could not be parsed into a name and version; skipped`
        : !PNPM_NAME_GRAMMAR.test(parsedKey.name)
          ? `${path}: packages key "${key}" did not split into a valid package name ("${parsedKey.name}"); skipped`
          : null;
    if (unsplit !== null) {
      // Lockfile versions before 9 key a git or remote-tarball dependency by
      // where it comes from, not by name and version:
      // "github.com/<owner>/<repo>/<commit>" for a hosted git repository,
      // "@<host>/<path>" for a tarball URL, and the repository URL with its
      // scheme cut off for any other git source (pnpm 8,
      // resolving/git-resolver and resolving/tarball-resolver, the "id" each
      // returns). pnpm installs such an entry from its resolution, and
      // records the package's own name and version beside it. Such an entry
      // is read from its resolution, under the name it records (the key when
      // it records none); the skip note is for an entry nothing can be read
      // from.
      const carried = isPlainObject(value) ? unsplitEntry(key, value) : null;
      if (carried === null) {
        diagnostics.push({ code: 'pnpm-lockfile-invalid-entry', message: unsplit });
        // Kept for the deny list, which matches what the raw entry says
        // (its name field and the name-shaped parts of its key) even though
        // no other rule can read it.
        skipped.push(skippedEntryOf(key, value));
        continue;
      }
      append(carried.name, { ...withSnapshotName(carried.entry, value as Record<string, unknown>), pnpmRawKey: key });
      continue;
    }
    if (!isPlainObject(value)) {
      diagnostics.push({
        code: 'pnpm-lockfile-invalid-entry',
        message: `${path}: packages["${key}"] is not a mapping; skipped`,
      });
      skipped.push({ key });
      continue;
    }
    const { name, version } = parsedKey as { name: string; version: string };
    // Multiple packages keys can resolve to the same registry name, most
    // commonly two different versions of the same package installed for
    // different peer-dependency sets. Real lockfiles hit this often
    // enough that collapsing to a single entry would silently discard one
    // and let an arbitrary version win, so every distinct resolved
    // version for a name is retained, in insertion order -- but a
    // collision that resolves to an identical entry (see
    // lockEntriesEqual above) is a duplicate, not a second version, and
    // is not appended again.
    append(name, withSnapshotName(entryFromPackageValue(value, version), value));
  }
  return entries;
}

// The entry for a packages key that does not split into a name and version
// (see readPackages), or null when its value says nothing about where it
// installs from. A resolution with a tarball or a git repository is what
// pnpm fetches, so it is read; the name is the entry's own "name" field
// when that is a package name, else the key itself, so the entry is judged
// under some name rather than dropped. Neither name selects the bytes: the
// resolution does, and every source rule reads it.
function unsplitEntry(key: string, value: Record<string, unknown>): { name: string; entry: LockEntry } | null {
  const entry = entryFromPackageValue(value, undefined);
  if (entry.resolvedUrl === undefined) {
    return null;
  }
  const field = value.name;
  const name = typeof field === 'string' && PNPM_NAME_GRAMMAR.test(field) ? field : key;
  return { name, entry };
}

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

// pnpm reads a resolution.tarball that is not a full URL against the
// registry that serves the package: the scope's registry from .npmrc when
// the name is scoped and has one, else the default registry, with a "/"
// appended (lockfile/lockfile-utils/src/pkgSnapshotToResolution.ts at pnpm
// 8.15.9, lockfile/utils/src/pkgSnapshotToResolution.ts at 9.15.9 and
// 10.29.3: `new url.URL(tarball, registry)`). The name whose scope counts is
// the entry's own name field below v9 (pnpm 8 nameVerFromPkgSnapshot) and
// the key's name from v9 on; the scope is everything before the first "/"
// of a name that starts with "@", as pnpm splits it. Each entry is resolved
// that way here, against the .npmrc of the side it was read from, which is
// what that side's install would use, so every rule reads the URL that side
// fetches and the source rules judge its host against the registries the
// project names. A full URL is unchanged, as it is for pnpm, and a value
// that does not resolve is left as written.
export function resolvePnpmRelativeTarballs(
  lockfile: ParsedLockfile,
  pins: Map<string, string>,
  defaultRegistry: string | null
): void {
  if (lockfile.format !== 'pnpm') {
    return;
  }
  // The registry pnpm picks for a name, with a "/" appended.
  const registryFor = (scopeName: string): string => {
    const scope = scopeName.startsWith('@') ? scopeName.split('/')[0] : null;
    const registry = (scope === null ? undefined : pins.get(scope)) ?? defaultRegistry ?? DEFAULT_REGISTRY;
    const full = registry.includes('://') ? registry : `https://${registry.replace(/^\/+/, '')}`;
    return full.endsWith('/') ? full : `${full}/`;
  };
  for (const [name, list] of lockfile.entries) {
    list.forEach((entry, index) => {
      const tarball = entry.resolvedUrl;
      if (tarball === undefined || tarball === '') {
        // No tarball: pnpm builds the URL from the key's name and version at
        // the registry it picked (getTarball in pkgSnapshotToResolution,
        // which calls get-npm-tarball-url 2.1.0: registry + name + "/-/" +
        // the name without its scope + "-" + the version without build
        // metadata + ".tgz"). With the key's own name picking the registry,
        // that is the registry install every rule already judges by name,
        // and the entry is left as it is. Below v9 the name field picks it,
        // and where that is another registry the URL pnpm fetches is
        // recorded, so the source rules judge its host.
        const snapshotName = entry.pnpmSnapshotName;
        if (snapshotName === undefined || entry.version === undefined) {
          return;
        }
        const registry = registryFor(snapshotName);
        if (registry === registryFor(name)) {
          return;
        }
        const scopeless = name.startsWith('@') ? (name.split('/')[1] ?? name) : name;
        const version = entry.version.includes('+') ? entry.version.slice(0, entry.version.indexOf('+')) : entry.version;
        list[index] = { ...entry, resolvedUrl: `${registry}${name}/-/${scopeless}-${version}.tgz` };
        return;
      }
      if (isAbsoluteUrl(tarball)) {
        return;
      }
      try {
        const resolved = new URL(tarball, registryFor(entry.pnpmSnapshotName ?? name)).toString();
        list[index] = { ...entry, resolvedUrl: resolved };
      } catch {
        // Not resolvable against this registry: left as written, which the
        // rules read as no location.
      }
    });
  }
}

function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
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
