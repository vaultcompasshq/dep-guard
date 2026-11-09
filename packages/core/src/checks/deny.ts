// The deny list (issue 137): packages this repository refuses by name, by
// scope, or by exact version, each with a reason.
//
// Unlike every other check this one judges the whole judged side, not the
// change. A list that only saw new entries could not retire a package
// already installed, and a ban added on the base branch has to fail every
// pull request until the package is gone, which is what the scripts this
// replaces do. ctx.delta is read only to say whether a match is new.
//
// An entry matches when ANY name in a package's identity set matches. Every
// name in the set is something the files dep-guard reads say installs: the
// folder written, the name field, the tarball the URL names. A forged name
// can only add a name to the set, never remove one, so matching the union
// fails closed. Alias edges and LockEntry.lookupName are not in the set:
// recordAliasEdges keys edges by dependency name across the whole lockfile,
// so an edge's target would land on every same-named entry, and an alias
// that really installs its target already carries the target as its name
// field or tarball name (docs/INVARIANTS.md).
//
// Nothing clears a deny finding except a reviewed edit to the list: allow
// never does (this file never calls allowClears), the baseline never does
// (scan.ts, applyPathFilters), and ignorePaths does only on a path nothing
// installs on either side.

import { denyEntryKey, normalizedDenyName, DENY_PYPI_PREFIX } from '../config.js';
import { lockfileForManifest, versionRangeOf } from '../delta.js';
import type { LockEntry, ParsedLockfile, PnpmSkippedEntry } from '../lockfiles/types.js';
import type { ManifestDep, ParsedManifest } from '../manifest.js';
import { normalizePypiName } from '../python-names.js';
import {
  registryTarballIdentity,
  resolutionKindOf,
  resolutionOf,
} from '../resolution.js';
import { isReadLockfile, type ProjectClassification } from '../state.js';
import { projectManifestForLockfile } from '../git-source.js';
import type { Diagnostic, Finding } from '../types.js';
import { isAllowed, isPypiAllowed } from './allow.js';
import { registryBasePathsOf, registryHostsOf } from './tamper.js';
import type { Check, CheckContext, DenyEntry, JudgedSide } from './types.js';

export const DENY_RULE = 'denied-package';
export const DENY_REVIEW_OVERDUE = 'deny-review-overdue';
export const DENY_OVERRIDES_ALLOW = 'deny-overrides-allow';
export const DENY_KEPT_OVER_BASELINE = 'deny-kept-over-baseline';
export const DENY_ENTRY_KEPT_FROM_COMPARISON_SIDE = 'deny-entry-kept-from-comparison-side';
export const DENY_ENTRIES_UNREAD = 'deny-entries-unread';
export const DENY_NOTHING_TO_JUDGE = 'deny-nothing-to-judge';
export const DENY_LOCKFILE_UNREAD = 'deny-lockfile-unread';
export const DENY_HEAD_CONFIG_INVALID = 'deny-head-config-invalid';
export const DENY_LOCKFILE_ACKNOWLEDGED = 'deny-lockfile-acknowledged';

/**
 * The list a run with a comparison side and no trust base applies: every
 * entry of the comparison side's list, then each judged-side entry the
 * comparison side does not have. An entry both sides have (same normalised
 * name and versions) is the comparison side's, reason and reviewBy
 * included, so a change can neither lift a ban nor reword it. `kept` names
 * the comparison-side entries the judged side dropped.
 */
export function unionDenyLists(
  comparison: readonly DenyEntry[],
  judged: readonly DenyEntry[]
): { deny: DenyEntry[]; kept: DenyEntry[] } {
  const comparisonKeys = new Set(comparison.map(denyEntryKey));
  const judgedKeys = new Set(judged.map(denyEntryKey));
  return {
    deny: [...comparison, ...judged.filter((entry) => !comparisonKeys.has(denyEntryKey(entry)))],
    kept: comparison.filter((entry) => !judgedKeys.has(denyEntryKey(entry))),
  };
}

/**
 * The stricter of two denyUnreadLockfiles settings, absent reading as the
 * default "fail": "note" only when both sides say "note". Undefined when
 * neither side sets it.
 */
export function stricterDenyUnread(
  comparison: 'fail' | 'note' | undefined,
  judged: 'fail' | 'note' | undefined
): 'fail' | 'note' | undefined {
  if (comparison === undefined && judged === undefined) {
    return undefined;
  }
  return (comparison ?? 'fail') === 'note' && (judged ?? 'fail') === 'note' ? 'note' : 'fail';
}

export function keptFromComparisonDiagnostic(kept: readonly DenyEntry[], side: string): Diagnostic | null {
  if (kept.length === 0) {
    return null;
  }
  const names = kept.map((entry) => `"${entry.name}"${entry.versions === undefined ? '' : ` (versions ${entry.versions.join(', ')})`}`);
  return {
    code: DENY_ENTRY_KEPT_FROM_COMPARISON_SIDE,
    message:
      `the tree being judged drops deny entr${kept.length === 1 ? 'y' : 'ies'} ${names.join(', ')} that ${side} has; ` +
      'a change cannot lift its own ban, so the entries still apply',
  };
}

const MAX_LOCATIONS = 20;

// ---------------------------------------------------------------------------
// Entries, compiled once per run

interface Matcher {
  entry: DenyEntry;
  key: string;
  signal: string;
  ecosystem: 'npm' | 'pypi';
  // The normalised exact name, or for a scope wildcard "@scope/".
  target: string;
  scope: boolean;
  // Listed versions with build metadata stripped; null for a name-only ban.
  versions: ReadonlySet<string> | null;
  overdue: boolean;
}

function stripBuild(version: string): string {
  const plus = version.indexOf('+');
  return (plus === -1 ? version : version.slice(0, plus)).trim();
}

// Plain semver, as npm and pnpm write a registry version: a prerelease is
// allowed, a range or a URL is not.
const PLAIN_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isPlainSemver(version: string): boolean {
  return PLAIN_SEMVER.test(version.trim());
}

// The UTC calendar date of a moment, YYYY-MM-DD.
function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function denySignal(entry: DenyEntry): string {
  const name = normalizedDenyName(entry.name);
  if (entry.versions === undefined) {
    return `denied:${name}`;
  }
  return `denied:${name}@${[...new Set(entry.versions.map((version) => version.trim()))].sort().join('|')}`;
}

function compile(entries: readonly DenyEntry[], today: string): Matcher[] {
  return entries.map((entry) => {
    const normalised = normalizedDenyName(entry.name);
    const pypi = entry.name.startsWith(DENY_PYPI_PREFIX);
    const scope = !pypi && normalised.endsWith('/*');
    return {
      entry,
      key: denyEntryKey(entry),
      signal: denySignal(entry),
      ecosystem: pypi ? 'pypi' : 'npm',
      target: pypi ? normalised.slice(DENY_PYPI_PREFIX.length) : scope ? normalised.slice(0, -1) : normalised,
      scope,
      versions: entry.versions === undefined ? null : new Set(entry.versions.map(stripBuild)),
      overdue: entry.reviewBy !== undefined && entry.reviewBy < today,
    };
  });
}

function nameMatches(matcher: Matcher, ecosystem: 'npm' | 'pypi', name: string): boolean {
  if (matcher.ecosystem !== ecosystem) {
    return false;
  }
  if (ecosystem === 'pypi') {
    return normalizePypiName(name) === matcher.target;
  }
  const lower = name.toLowerCase();
  // "@scope/*" covers "@scope/anything" and nothing else: the prefix carries
  // the slash, so "@scope-other/x" is a different scope.
  return matcher.scope ? lower.length > matcher.target.length && lower.startsWith(matcher.target) : lower === matcher.target;
}

// ---------------------------------------------------------------------------
// Tarball URLs

// One URL path segment fully percent-decoded, or as written when it does not
// decode. Decoding can only add a name to the set.
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const NPM_TARBALL_NAME = /^(?:@[^/@]+\/)?[^/@][^/]*$/;
const GITHUB_PACKAGES_DOWNLOAD = /^\/download\/(@[^/]+\/[^/]+)\/([^/]+)\/[0-9a-f]+$/;

// The names and the version a decoded tarball path carries, read both ways
// the two tarball parsers read a raw one: the whole segment before "/-/"
// after the longest registry base path, and its last segment (or last two
// for a scope).
function namesFromDecodedPath(pathname: string, basePaths: readonly string[]): { names: string[]; version?: string } {
  let path = pathname;
  const base = basePaths
    .filter((candidate) => candidate.length > 1 && path.startsWith(candidate))
    .sort((left, right) => right.length - left.length)[0];
  if (base !== undefined) {
    path = path.slice(base.length - 1);
  }
  const github = GITHUB_PACKAGES_DOWNLOAD.exec(path);
  if (github !== null) {
    return { names: [github[1]], version: github[2] };
  }
  const marker = path.indexOf('/-/');
  if (marker <= 0) {
    return { names: [] };
  }
  const segment = path.slice(1, marker);
  const names: string[] = [];
  if (NPM_TARBALL_NAME.test(segment)) {
    names.push(segment);
  }
  const parts = segment.split('/');
  const scope = parts[parts.length - 2];
  names.push(scope !== undefined && scope.startsWith('@') ? parts.slice(-2).join('/') : parts[parts.length - 1]);
  const file = path.slice(marker + 3);
  const name = names[0] ?? names[names.length - 1];
  const basename = name.slice(name.lastIndexOf('/') + 1);
  if (file.includes('/') || !file.startsWith(`${basename}-`) || !file.endsWith('.tgz')) {
    return { names };
  }
  const version = file.slice(basename.length + 1, file.length - '.tgz'.length);
  return version.length === 0 ? { names } : { names, version };
}

interface TarballFacts {
  kind: 'registry' | 'git' | 'file' | 'url' | 'unreadable';
  host?: string;
  names: string[];
  versions: string[];
}

// Everything a resolved URL says about what it serves, for any host: the
// two tarball parsers on the URL as written, and the same path fully
// percent-decoded and lower-cased segment by segment.
export function tarballFacts(url: string, basePathsByHost: ReadonlyMap<string, string[]>): TarballFacts {
  const resolution = resolutionOf(url);
  if (resolution === null) {
    return { kind: 'unreadable', names: [], versions: [] };
  }
  const kind = resolutionKindOf(resolution);
  const facts: TarballFacts = { kind, ...(resolution.host === '' ? {} : { host: resolution.host }), names: [], versions: [] };
  if (resolution.protocol !== 'http:' && resolution.protocol !== 'https:') {
    return facts;
  }
  const basePaths = basePathsByHost.get(resolution.host) ?? [];
  const identity = registryTarballIdentity(url, basePaths);
  if (identity !== null) {
    facts.names.push(identity.name);
    if (identity.version !== undefined) {
      facts.versions.push(identity.version);
    }
  }
  // registryTarballPackageName (resolution.ts) is not read here: on the raw
  // path it gives the segment before "/-/" or its last one or two parts,
  // which the decoded reader below also gives whenever the raw text has no
  // percent escape, and a raw name with an escape left in it is no npm name
  // a deny entry can match.
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return facts;
  }
  const decoded = pathname
    .split('/')
    .map(decodeSegment)
    .join('/')
    .toLowerCase();
  const fromDecoded = namesFromDecodedPath(decoded, basePaths.map((base) => base.toLowerCase()));
  facts.names.push(...fromDecoded.names);
  if (fromDecoded.version !== undefined) {
    facts.versions.push(fromDecoded.version);
  }
  facts.names = [...new Set(facts.names)];
  facts.versions = [...new Set(facts.versions)];
  return facts;
}

// ---------------------------------------------------------------------------
// What is judged: one item per lockfile entry and per manifest line

interface Identity {
  name: string;
  by: string;
}

interface VersionFacts {
  versions: Array<{ version: string; from: string }>;
  // No version backs what installs here: none was readable, or the source is
  // one where a written version has nothing behind it (git, file, a URL on a
  // host the project does not name, a tarball file name with no version).
  unread: boolean;
  // A manifest range under a read lockfile: the lockfile judges the version.
  deferred?: boolean;
}

interface Item {
  ecosystem: 'npm' | 'pypi';
  identities: Identity[];
  versions: VersionFacts;
  origin: 'manifest' | 'lockfile';
  // Where the finding is anchored and which lockfile it is about.
  manifestPath?: string;
  lockfilePath?: string;
  // For anchoring a lockfile entry on the manifest that declares it.
  entryKey?: string;
  location: string;
  added: boolean;
  source: { kind: string; host?: string };
}

const NPM_NAME_SHAPE = /^[a-z0-9._~-]+$/i;

// The name-shaped parts of a pnpm key no parser could split: each segment
// shaped like an unscoped name, and each "@x/y" pair.
function keySegmentNames(key: string): string[] {
  const parts = key.replace(/^\/+/, '').split('/');
  const names: string[] = [];
  parts.forEach((part, index) => {
    const bare = part.includes('@', 1) ? part.slice(0, part.indexOf('@', 1)) : part;
    if (NPM_NAME_SHAPE.test(bare)) {
      names.push(bare);
    }
    const next = parts[index + 1];
    if (part.startsWith('@') && next !== undefined) {
      const nextBare = next.includes('@', 1) ? next.slice(0, next.indexOf('@', 1)) : next;
      names.push(`${part}/${nextBare}`);
    }
  });
  return [...new Set(names)];
}

function lockEntryVersions(
  entry: LockEntry,
  facts: TarballFacts | null,
  registryHosts: ReadonlySet<string>
): VersionFacts {
  const versions: Array<{ version: string; from: string }> = [];
  if (entry.version !== undefined && isPlainSemver(entry.version)) {
    versions.push({ version: entry.version, from: 'recorded' });
  }
  if (entry.keyVersion !== undefined && isPlainSemver(entry.keyVersion)) {
    versions.push({ version: entry.keyVersion, from: 'key' });
  }
  let unread = entry.unreadLocation === true;
  if (facts !== null) {
    for (const version of facts.versions) {
      if (isPlainSemver(version)) {
        versions.push({ version, from: 'tarball' });
      }
    }
    if (facts.kind !== 'registry' || facts.host === undefined || !registryHosts.has(facts.host) || facts.versions.length === 0) {
      unread = true;
    }
  }
  return { versions, unread: unread || versions.length === 0 };
}

function sourceOf(facts: TarballFacts | null): { kind: string; host?: string } {
  if (facts === null) {
    return { kind: 'none' };
  }
  return facts.host === undefined ? { kind: facts.kind } : { kind: facts.kind, host: facts.host };
}

function lockfileItems(
  lockfile: ParsedLockfile,
  registryHosts: ReadonlySet<string>,
  basePaths: ReadonlyMap<string, string[]>,
  added: ReadonlySet<LockEntry>
): Item[] {
  const items: Item[] = [];
  for (const [name, list] of lockfile.entries) {
    for (const entry of list) {
      const identities: Identity[] = [{ name, by: 'key' }];
      if (entry.nameField !== undefined && entry.nameField !== name) {
        identities.push({ name: entry.nameField, by: 'name-field' });
      }
      if (entry.pnpmNameField !== undefined && entry.pnpmNameField !== name) {
        identities.push({ name: entry.pnpmNameField, by: 'snapshot-name' });
      }
      if (entry.pnpmRawKey !== undefined) {
        for (const segment of keySegmentNames(entry.pnpmRawKey)) {
          identities.push({ name: segment, by: 'key-segment' });
        }
      }
      const facts = entry.resolvedUrl === undefined ? null : tarballFacts(entry.resolvedUrl, basePaths);
      for (const tarballName of facts?.names ?? []) {
        identities.push({ name: tarballName, by: 'tarball' });
      }
      items.push({
        ecosystem: 'npm',
        identities,
        versions: lockEntryVersions(entry, facts, registryHosts),
        origin: 'lockfile',
        lockfilePath: lockfile.path,
        entryKey: name,
        location: `${lockfile.path} at ${entry.lockPath ?? entry.pnpmRawKey ?? name}${entry.version === undefined ? '' : `, version ${entry.version}`}`,
        added: added.has(entry),
        source: sourceOf(facts),
      });
    }
  }
  // npm "link": true entries: dropped from entries by the parser, but the
  // folder name is still what installs there.
  for (const link of lockfile.workspaceLinks ?? []) {
    items.push({
      ecosystem: 'npm',
      identities: [{ name: link.name, by: 'link' }],
      versions: { versions: [], unread: true },
      origin: 'lockfile',
      lockfilePath: lockfile.path,
      entryKey: link.name,
      location: `${lockfile.path} at node_modules/${link.name} (a link entry)`,
      added: false,
      source: { kind: 'link' },
    });
  }
  for (const skipped of lockfile.skippedEntries ?? []) {
    items.push(skippedItem(lockfile, skipped));
  }
  return items;
}

function skippedItem(lockfile: ParsedLockfile, skipped: PnpmSkippedEntry): Item {
  const identities: Identity[] = [];
  if (skipped.name !== undefined) {
    identities.push({ name: skipped.name, by: 'snapshot-name' });
  }
  for (const segment of keySegmentNames(skipped.key)) {
    identities.push({ name: segment, by: 'key-segment' });
  }
  const versions =
    skipped.version !== undefined && isPlainSemver(skipped.version)
      ? [{ version: skipped.version, from: 'recorded' }]
      : [];
  return {
    ecosystem: 'npm',
    identities,
    // Nothing reads where this entry installs from, so its version has
    // nothing behind it.
    versions: { versions, unread: true },
    origin: 'lockfile',
    lockfilePath: lockfile.path,
    entryKey: skipped.name ?? skipped.key,
    location: `${lockfile.path} at ${skipped.key} (an entry the parser skipped)`,
    added: false,
    source: { kind: 'unreadable' },
  };
}

// An exact version a manifest specifier names, or null for a range or a
// non-registry specifier. npm reads "=1.0.0" and "v1.0.0" as exact too.
function exactSpecifierVersion(specifier: string): string | null {
  const trimmed = specifier.trim().replace(/^=\s*/, '').replace(/^v(?=\d)/, '');
  return isPlainSemver(trimmed) ? trimmed : null;
}

function manifestItems(
  manifest: ParsedManifest,
  covered: boolean,
  basePaths: ReadonlyMap<string, string[]>,
  registryHosts: ReadonlySet<string>,
  added: (dep: ManifestDep) => boolean
): Item[] {
  return manifest.deps.map((dep) => {
    const identities: Identity[] = [{ name: dep.name, by: 'manifest-key' }];
    if (dep.registryName !== dep.name) {
      identities.push({ name: dep.registryName, by: 'alias-target' });
    }
    let facts: TarballFacts | null = null;
    if (dep.protocol === 'url') {
      facts = tarballFacts(dep.specifier, basePaths);
      for (const tarballName of facts.names) {
        identities.push({ name: tarballName, by: 'url-tarball' });
      }
    }
    let versions: VersionFacts;
    const exact =
      dep.protocol === 'registry' || dep.protocol === 'alias'
        ? exactSpecifierVersion(versionRangeOf(dep))
        : facts !== null && facts.kind === 'registry' && facts.host !== undefined && registryHosts.has(facts.host)
          ? (facts.versions[0] ?? null)
          : null;
    if (exact !== null) {
      versions = { versions: [{ version: exact, from: 'specifier' }], unread: false };
    } else if (covered) {
      versions = { versions: [], unread: false, deferred: true };
    } else {
      versions = { versions: [], unread: true };
    }
    return {
      ecosystem: 'npm' as const,
      identities,
      versions,
      origin: 'manifest' as const,
      manifestPath: manifest.path,
      location: `declared in ${manifest.path}`,
      added: added(dep),
      source: dep.protocol === 'url' ? sourceOf(facts) : { kind: 'manifest' },
    };
  });
}

const ARCHIVE_SUFFIXES = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tgz', '.tar', '.zip'];

// The distribution name an archive file name carries: the segment before the
// first "-" of a wheel (PEP 427), or the part before the final "-<version>"
// of an sdist. Null when the last path segment is neither.
export function archiveDistributionName(specifier: string): string | null {
  const withoutQuery = specifier.split(/[?#]/)[0] ?? '';
  const segment = decodeSegment(withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1)).toLowerCase();
  if (segment.endsWith('.whl')) {
    const name = segment.split('-')[0] ?? '';
    return name.length > 0 ? name : null;
  }
  const suffix = ARCHIVE_SUFFIXES.find((candidate) => segment.endsWith(candidate));
  if (suffix === undefined) {
    return null;
  }
  const base = segment.slice(0, segment.length - suffix.length);
  const dash = base.lastIndexOf('-');
  const name = dash > 0 ? base.slice(0, dash) : base;
  return name.length > 0 ? name : null;
}

function pythonManifestItems(manifest: ParsedManifest, added: (dep: ManifestDep) => boolean): Item[] {
  return manifest.deps.map((dep) => {
    const identities: Identity[] = [{ name: dep.registryName, by: 'requirement' }];
    if (dep.name !== dep.registryName) {
      identities.push({ name: dep.name, by: 'requirement' });
    }
    for (const text of [dep.specifier, dep.name]) {
      const archive = archiveDistributionName(text);
      if (archive !== null) {
        identities.push({ name: archive, by: 'archive-name' });
      }
    }
    return {
      ecosystem: 'pypi' as const,
      identities,
      versions: { versions: [], unread: false },
      origin: 'manifest' as const,
      manifestPath: manifest.path,
      location: `declared in ${manifest.path}`,
      added: added(dep),
      source: { kind: 'manifest' },
    };
  });
}

// ---------------------------------------------------------------------------
// Matching and findings

interface Hit {
  matcher: Matcher;
  item: Item;
  name: string;
  matchedBy: string[];
  matchedVersions: Array<{ version: string; from: string }>;
  versionUnread: boolean;
}

function hitOf(matcher: Matcher, item: Item, versionGiven: boolean): Hit | null {
  const matched = item.identities.filter((identity) => nameMatches(matcher, item.ecosystem, identity.name));
  if (matched.length === 0) {
    return null;
  }
  let matchedVersions: Array<{ version: string; from: string }> = [];
  let versionUnread = false;
  if (matcher.versions !== null) {
    if (!versionGiven) {
      versionUnread = true;
    } else {
      const listed = matcher.versions;
      matchedVersions = item.versions.versions.filter((candidate) => listed.has(stripBuild(candidate.version)));
      if (matchedVersions.length === 0) {
        if (item.versions.deferred === true || !item.versions.unread) {
          return null;
        }
        versionUnread = true;
      }
    }
  }
  return {
    matcher,
    item,
    name: matched[0].name,
    matchedBy: [...new Set(matched.map((identity) => identity.by))],
    matchedVersions,
    versionUnread,
  };
}

function lower(name: string, ecosystem: 'npm' | 'pypi'): string {
  return ecosystem === 'pypi' ? normalizePypiName(name) : name.toLowerCase();
}

function endSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function messageOf(matcher: Matcher, name: string, locations: readonly string[], versionUnread: boolean, noVersionGiven: boolean): string {
  const { entry } = matcher;
  const versions = entry.versions === undefined ? '' : `, versions ${entry.versions.join(', ')}`;
  let message = `"${name}" is on this repository's deny list (entry "${entry.name}"${versions}): ${endSentence(entry.reason)}`;
  if (locations.length > 0) {
    message += ` Found ${locations[0]}.`;
  }
  if (locations.length > 1) {
    message += ` And ${locations.length - 1} more location${locations.length === 2 ? '' : 's'}.`;
  }
  if (matcher.overdue && entry.reviewBy !== undefined) {
    message += ` This ban's review date, ${entry.reviewBy}, has passed; the ban stays until the entry is edited.`;
  }
  if (noVersionGiven) {
    message += ' No version was given to check, so this versioned ban matches by name alone.';
  } else if (versionUnread) {
    message += ' No version could be read for what installs here, so this versioned ban matches by name alone.';
  }
  return message;
}

function overdueDiagnostics(matchers: readonly Matcher[]): Diagnostic[] {
  return matchers
    .filter((matcher) => matcher.overdue)
    .map((matcher) => ({
      code: DENY_REVIEW_OVERDUE,
      message:
        `deny entry "${matcher.entry.name}": its review date, ${matcher.entry.reviewBy}, has passed. The ban still ` +
        'applies; review it and edit the entry to keep, change or lift it',
    }));
}

// Where a hit's finding is anchored: the declaring manifest, else the
// lockfile file itself (a further pnpm document's "#label" dropped, so the
// path is a real file that ignorePaths and the project rules can read).
function anchorOfHit(hit: Hit): string {
  return hit.item.manifestPath ?? (hit.item.lockfilePath ?? '').split('#')[0];
}

function findingsOf(hits: readonly Hit[], hasComparisonBase: boolean, noVersionGiven: boolean): Omit<Finding, 'fingerprint'>[] {
  const groups = new Map<string, Hit[]>();
  for (const hit of hits) {
    const anchor = anchorOfHit(hit);
    const key = JSON.stringify([hit.matcher.key, lower(hit.name, hit.item.ecosystem), anchor]);
    const group = groups.get(key) ?? [];
    group.push(hit);
    groups.set(key, group);
  }
  const findings: Omit<Finding, 'fingerprint'>[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    const { matcher } = first;
    const anchor = anchorOfHit(first);
    const lockfilePath = group.find((hit) => hit.item.lockfilePath !== undefined)?.item.lockfilePath;
    const locations = group.map((hit) => hit.item.location);
    const versionUnread = group.some((hit) => hit.versionUnread);
    const sources = group.map((hit) => hit.item.source);
    const source = sources.find((candidate) => candidate.kind !== 'manifest') ?? sources[0];
    findings.push({
      ruleId: DENY_RULE,
      severity: 'critical',
      packageName: first.name,
      message: messageOf(matcher, first.name, locations, versionUnread, noVersionGiven),
      manifestPath: anchor,
      ...(lockfilePath === undefined ? {} : { lockfilePath }),
      details: {
        signal: matcher.signal,
        denyEntry: matcher.entry.name,
        versions: matcher.entry.versions ?? null,
        reason: matcher.entry.reason,
        reviewBy: matcher.entry.reviewBy ?? null,
        reviewOverdue: matcher.overdue,
        matchedBy: [...new Set(group.flatMap((hit) => hit.matchedBy))],
        matchedVersions: group.flatMap((hit) => hit.matchedVersions),
        kind: hasComparisonBase && group.some((hit) => hit.item.added) ? 'added' : 'present',
        locations: locations.slice(0, MAX_LOCATIONS),
        moreLocations: Math.max(0, locations.length - MAX_LOCATIONS),
        versionUnread,
        source,
      },
    });
  }
  return findings;
}

function allowDiagnostics(findings: readonly Omit<Finding, 'fingerprint'>[], allow: readonly string[]): Diagnostic[] {
  const names = new Set<string>();
  for (const finding of findings) {
    const pypi = String(finding.details?.denyEntry ?? '').startsWith(DENY_PYPI_PREFIX);
    const covered = pypi
      ? isPypiAllowed(normalizePypiName(finding.packageName), allow)
      : isAllowed(finding.packageName, allow);
    if (covered) {
      names.add(finding.packageName);
    }
  }
  return [...names].sort().map((name) => ({
    code: DENY_OVERRIDES_ALLOW,
    message: `"${name}" is on both the deny list and the allow list; allow never clears a denied-package finding, so the ban stands`,
  }));
}

// The npm manifests each read lockfile records, by lockfile path, the way the
// delta pairs them (delta.ts, lockfileForManifest), kept only when the
// judged side makes the manifest a project. The pairing is path-only, so a
// nested package.json no rule makes a project (a test fixture, say) would
// otherwise take a lockfile entry its lockfile's project installs, and an
// ignorePaths entry over that fixture would read the entry as uninstalled.
function manifestsByLockfile(judged: JudgedSide): Map<string, ParsedManifest[]> {
  const byLockfile = new Map<string, ParsedManifest[]>();
  for (const manifest of judged.manifests) {
    if (manifest.python !== undefined || (judged.projects?.reasons.get(manifest.path) ?? []).length === 0) {
      continue;
    }
    const lockfile = lockfileForManifest(manifest.path, judged.lockfiles);
    if (lockfile !== null) {
      byLockfile.set(lockfile.path, [...(byLockfile.get(lockfile.path) ?? []), manifest]);
    }
  }
  return byLockfile;
}

function parentDir(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? '' : filePath.slice(0, slash);
}

// A lockfile entry that a manifest the lockfile records declares (by its key
// or alias target, under either the matched name or the entry's key) is
// anchored on that manifest, so the manifest line and the entry fold into one
// finding. Anything else stays anchored on its lockfile.
function anchorLockfileHit(hit: Hit, recordedBy: ReadonlyMap<string, ParsedManifest[]>, pythonManifests: readonly ParsedManifest[]): void {
  const item = hit.item;
  if (item.origin !== 'lockfile' || item.lockfilePath === undefined) {
    return;
  }
  const wanted = new Set([lower(hit.name, item.ecosystem), lower(item.entryKey ?? hit.name, item.ecosystem)]);
  const candidates =
    item.ecosystem === 'pypi'
      ? pythonManifests.filter((manifest) => parentDir(manifest.path) === parentDir(item.lockfilePath ?? ''))
      : (recordedBy.get(item.lockfilePath) ?? []);
  const declaring = candidates
    .filter((manifest) =>
      manifest.deps.some(
        (dep) => wanted.has(lower(dep.name, item.ecosystem)) || wanted.has(lower(dep.registryName, item.ecosystem))
      )
    )
    .map((manifest) => manifest.path)
    .sort();
  if (declaring.length > 0) {
    hit.item = { ...item, manifestPath: declaring[0] };
  }
}

// How many entries no deny match can see: npm packages values that are not
// objects, and pnpm documents that are not shaped like a lockfile.
function unreadEntriesDiagnostic(judged: JudgedSide): Diagnostic | null {
  let entries = 0;
  let documents = 0;
  for (const lockfile of judged.lockfiles) {
    entries += lockfile.diagnostics.filter((diagnostic) => diagnostic.code === 'npm-lockfile-invalid-entry').length;
    if (lockfile.diagnostics.some((diagnostic) => diagnostic.code === 'pnpm-multi-document-lockfile')) {
      documents += 1;
    }
  }
  if (entries === 0 && documents === 0) {
    return null;
  }
  return {
    code: DENY_ENTRIES_UNREAD,
    message:
      `the deny list could not judge ${entries} lockfile entr${entries === 1 ? 'y' : 'ies'} a parser skipped ` +
      `(npm-lockfile-invalid-entry) and the unread YAML documents of ${documents} pnpm lockfile${documents === 1 ? '' : 's'}`,
  };
}

export interface DenyRunOptions {
  // The date reviewBy is compared with; today in UTC when absent.
  now?: Date;
}

export function denyFindings(ctx: CheckContext, options: DenyRunOptions = {}): Omit<Finding, 'fingerprint'>[] {
  const entries = ctx.config.deny ?? [];
  const judged = ctx.judged;
  if (entries.length === 0 || judged === undefined) {
    return [];
  }
  const matchers = compile(entries, isoDate(options.now ?? new Date()));
  ctx.diagnostics.push(...overdueDiagnostics(matchers));
  const registryHosts = registryHostsOf(ctx.npmrcRegistryPins, ctx.npmrcDefaultRegistry);
  const basePaths = registryBasePathsOf(ctx.npmrcRegistryPins, ctx.npmrcDefaultRegistry);
  const addedEntries = new Set(ctx.delta.lockEntryChanges.map((change) => change.after));
  const addedLine = (manifest: ParsedManifest) => (dep: ManifestDep): boolean =>
    ctx.delta.changes.some(
      (change) => change.manifestPath === manifest.path && change.name === dep.name && change.depType === dep.depType
    );

  const items: Item[] = [];
  for (const lockfile of judged.lockfiles) {
    if (isReadLockfile(lockfile)) {
      items.push(...lockfileItems(lockfile, registryHosts, basePaths, addedEntries));
    }
  }
  const pythonManifests = judged.manifests.filter((manifest) => manifest.python !== undefined);
  for (const manifest of judged.manifests) {
    if (manifest.python !== undefined) {
      items.push(...pythonManifestItems(manifest, addedLine(manifest)));
      continue;
    }
    const covered = lockfileForManifest(manifest.path, judged.lockfiles) !== null;
    items.push(...manifestItems(manifest, covered, basePaths, registryHosts, addedLine(manifest)));
  }
  const pythonAdded = new Set((ctx.delta.python?.lockNames ?? []).map((lockName) => lockName.name));
  for (const lockfile of judged.pythonLockfiles) {
    for (const entry of lockfile.entries) {
      items.push({
        ecosystem: 'pypi',
        identities: [{ name: entry.name, by: 'lockfile-name' }],
        versions: { versions: [], unread: false },
        origin: 'lockfile',
        lockfilePath: lockfile.path,
        entryKey: entry.name,
        location: `${lockfile.path}${entry.version === null ? '' : `, version ${entry.version}`}`,
        added: pythonAdded.has(normalizePypiName(entry.name)),
        source: { kind: 'lockfile' },
      });
    }
  }

  const recordedBy = manifestsByLockfile(judged);
  const hits: Hit[] = [];
  for (const matcher of matchers) {
    for (const item of items) {
      const hit = hitOf(matcher, item, true);
      if (hit !== null) {
        anchorLockfileHit(hit, recordedBy, pythonManifests);
        hits.push(hit);
      }
    }
  }
  const findings = findingsOf(hits, ctx.delta.hasComparisonBase, false);
  ctx.diagnostics.push(...allowDiagnostics(findings, ctx.config.allow));
  const unread = unreadEntriesDiagnostic(judged);
  if (unread !== null) {
    ctx.diagnostics.push(unread);
  }
  return findings;
}

export const denyCheck: Check = (ctx) => denyFindings(ctx);

/**
 * `dep-guard check <name>`: the one name asked about, against the list. No
 * version is given there, so a versioned ban always matches and says so.
 */
export function denyCheckSingle(name: string, ctx: CheckContext, options: DenyRunOptions = {}): Omit<Finding, 'fingerprint'>[] {
  const entries = ctx.config.deny ?? [];
  if (entries.length === 0) {
    return [];
  }
  const matchers = compile(entries, isoDate(options.now ?? new Date()));
  ctx.diagnostics.push(...overdueDiagnostics(matchers));
  const item: Item = {
    ecosystem: 'npm',
    identities: [{ name, by: 'checked-name' }],
    versions: { versions: [], unread: true },
    origin: 'manifest',
    manifestPath: 'package.json',
    location: 'asked about by name',
    added: false,
    source: { kind: 'none' },
  };
  const hits = matchers.map((matcher) => hitOf(matcher, item, false)).filter((hit): hit is Hit => hit !== null);
  const findings = findingsOf(hits, false, true);
  ctx.diagnostics.push(...allowDiagnostics(findings, ctx.config.allow));
  return findings;
}

// ---------------------------------------------------------------------------
// What the deny list cannot read (section 6 of the design note)

export interface DenyCoverage {
  // Install lockfiles the deny list cannot read: an unread lockfile with a
  // project beside it, or the one a project resolves to.
  unreadInstall: string[];
  // Projects with declared dependencies and no lockfile at all: the package
  // manager resolves what they install at install time.
  noLockfile: string[];
  // Nothing on the judged side can install.
  nothingToJudge: boolean;
  // Unread install lockfiles whose exact bytes a denyUnreadAcknowledged
  // entry accepts, each with the package.json projects that install from
  // it on the judged side and on the reference side. Left out of
  // unreadInstall: scan.ts holds each acknowledgement only while those
  // manifests are the same paths with the same bytes on both sides
  // (settleDenyCoverage), and puts a broken one back as a gap.
  acknowledged: Array<{ lockfile: string; judgedInstallers: string[]; referenceInstallers: string[] }>;
  // The entry that would accept each unread install lockfile as it is now,
  // for the message; a lockfile with no blob id has none.
  acknowledgements: string[];
}

const EXEMPT_PROTOCOLS = new Set(['workspace', 'catalog', 'link', 'patch', 'file']);
const NPM_LOCKFILE_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']);

function baseName(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1);
}

function isProjectOn(sides: ReadonlyArray<ProjectClassification | null | undefined>, relPath: string | null): boolean {
  return relPath !== null && sides.some((side) => (side?.reasons.get(relPath) ?? []).length > 0);
}

/**
 * The lockfiles and projects whose installs the deny list cannot judge, for
 * scan.ts to turn into a could-not-run on a pull-request run (or a note). An
 * npm-family gap counts only when the list has an npm entry, and a Python gap
 * only when it has a "pypi:" entry: a list with nothing for an ecosystem has
 * nothing that ecosystem's unread lockfile could hide.
 */
export function denyCoverage(
  deny: readonly DenyEntry[],
  judged: JudgedSide,
  reference: ProjectClassification | null,
  acknowledgedEntries: readonly string[] = []
): DenyCoverage {
  const npm = deny.some((entry) => !entry.name.startsWith(DENY_PYPI_PREFIX));
  const pypi = deny.some((entry) => entry.name.startsWith(DENY_PYPI_PREFIX));
  const sides = [judged.projects, reference];
  const inventory = judged.lockfileInventory;
  const lockfileDirs = new Set(inventory.filter((entry) => NPM_LOCKFILE_NAMES.has(baseName(entry.path))).map((entry) => parentDir(entry.path)));
  // The nearest directory at or above a manifest that holds an npm-family
  // lockfile, read or not: where its install resolves from.
  const nearestLockDir = (manifestPath: string): string | null => {
    let dir = parentDir(manifestPath);
    for (;;) {
      if (lockfileDirs.has(dir)) {
        return dir;
      }
      if (dir === '') {
        return null;
      }
      dir = parentDir(dir);
    }
  };
  const projectPackageJsons = new Set<string>();
  for (const side of sides) {
    for (const [relPath, reasons] of side?.reasons ?? []) {
      if (reasons.length > 0 && baseName(relPath) === 'package.json') {
        projectPackageJsons.add(relPath);
      }
    }
  }
  const resolvedDirs = new Set([...projectPackageJsons].map(nearestLockDir).filter((dir): dir is string => dir !== null));
  // The package.json projects on one side whose install resolves from the
  // lockfile directory `dir`: the manifest beside the lockfile and every
  // project whose nearest lockfile directory it is.
  const installersOn = (side: ProjectClassification | null | undefined, dir: string): string[] =>
    [...(side?.reasons ?? [])]
      .filter(([relPath, reasons]) => reasons.length > 0 && baseName(relPath) === 'package.json' && nearestLockDir(relPath) === dir)
      .map(([relPath]) => relPath)
      .sort();

  const unreadInstall: string[] = [];
  const acknowledged: DenyCoverage['acknowledged'] = [];
  const acknowledgements: string[] = [];
  const accepted = new Set(acknowledgedEntries);
  if (npm) {
    for (const entry of inventory) {
      if (entry.read || !NPM_LOCKFILE_NAMES.has(baseName(entry.path))) {
        continue;
      }
      if (isProjectOn(sides, projectManifestForLockfile(entry.path)) || resolvedDirs.has(parentDir(entry.path))) {
        // Only these bytes: a null blob id (no identity) is never accepted.
        const acknowledgement = entry.blobId === null ? null : `${entry.path}:${entry.blobId}`;
        if (acknowledgement !== null && accepted.has(acknowledgement)) {
          const dir = parentDir(entry.path);
          acknowledged.push({
            lockfile: entry.path,
            judgedInstallers: installersOn(judged.projects, dir),
            referenceInstallers: installersOn(reference, dir),
          });
          continue;
        }
        unreadInstall.push(entry.path);
        if (acknowledgement !== null) {
          acknowledgements.push(acknowledgement);
        }
      }
    }
  }
  if (pypi) {
    for (const lockfile of judged.pythonLockfiles) {
      if (lockfile.unreadable !== undefined && isProjectOn(sides, projectManifestForLockfile(lockfile.path))) {
        unreadInstall.push(lockfile.path);
      }
    }
  }

  const noLockfile: string[] = [];
  const workspaceNames = new Set(judged.manifests.map((manifest) => manifest.name).filter((name): name is string => name !== undefined));
  const pythonLockDirs = new Set(judged.pythonLockfiles.filter((lockfile) => lockfile.unreadable === undefined).map((lockfile) => parentDir(lockfile.path)));
  for (const manifest of judged.manifests) {
    if (manifest.python === undefined) {
      if (!npm || !isProjectOn(sides, manifest.path) || nearestLockDir(manifest.path) !== null) {
        continue;
      }
      const lockable = manifest.deps.some((dep) => !EXEMPT_PROTOCOLS.has(dep.protocol) && !workspaceNames.has(dep.registryName));
      if (lockable) {
        noLockfile.push(manifest.path);
      }
      continue;
    }
    if (!pypi || manifest.deps.length === 0) {
      continue;
    }
    // A Python manifest installs when it is a project on either side or sits
    // at the repository root (a root requirements file is installed without
    // any rule naming it a project).
    if (!isProjectOn(sides, manifest.path) && parentDir(manifest.path) !== '') {
      continue;
    }
    let dir = parentDir(manifest.path);
    let covered = false;
    for (;;) {
      if (pythonLockDirs.has(dir)) {
        covered = true;
        break;
      }
      if (dir === '') {
        break;
      }
      dir = parentDir(dir);
    }
    if (!covered) {
      noLockfile.push(manifest.path);
    }
  }

  const nothingToJudge =
    judged.manifests.length === 0 &&
    !judged.lockfiles.some(isReadLockfile) &&
    judged.pythonLockfiles.length === 0;
  return {
    unreadInstall: [...new Set(unreadInstall)].sort(),
    noLockfile: noLockfile.sort(),
    nothingToJudge,
    acknowledged: acknowledged.sort((left, right) => (left.lockfile < right.lockfile ? -1 : 1)),
    acknowledgements: [...new Set(acknowledgements)].sort(),
  };
}
