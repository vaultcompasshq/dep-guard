import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DenyEntry, ResolvedConfig } from './checks/types.js';
import { isValidPythonName, normalizePypiName } from './python-names.js';
import { hasControlCharacter, withoutByteOrderMark } from './text.js';
import { DepGuardError, type FailOn } from './types.js';

// This file owns the on-disk config format and its validation. The
// resolved shape checks read (ResolvedConfig) is declared once in
// checks/types.ts, since the checks were written against those six keys
// first -- re-exporting rather than redeclaring keeps the two from
// drifting apart.
export type { ResolvedConfig };

// Exported so trust-base.ts reads the SAME two paths out of the base ref
// that loadConfig reads off disk. A second spelling of either name would
// let pull-request mode read a file the ordinary load never looks at, or
// miss one it does.
export const CONFIG_FILE = '.dep-guard.json';
export const LOCAL_CONFIG_FILE = '.dep-guard.local.json';

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'failOn',
  'allow',
  'internalScopes',
  'internalPrefixes',
  'extraAliases',
  'ignorePaths',
  'online',
  'minAgeDays',
  'minAgeAllow',
  'onlineBudgetMs',
  'onlineUnchecked',
  'acknowledgedLockfiles',
  'deny',
  'denyUnreadLockfiles',
  'denyUnreadAcknowledged',
]);

// What a pull-request run with a non-empty deny list does when an install
// lockfile cannot be read: "fail", the default, is a could-not-run (exit 2);
// "note" keeps it a diagnostic. The same two values as onlineUnchecked, and
// for the same reason no CLI flag.
export const DENY_UNREAD_LOCKFILES_VALUES: ReadonlySet<string> = new Set(['fail', 'note']);

// What a --base or --trust-base run does with a candidate name no online
// step could check (online/unchecked.ts): "fail", the default, is a
// could-not-run (exit 2); "note" keeps it a diagnostic. A string, like
// failOn, so a later third value needs no second key. No CLI flag: the
// workflow file is head-controlled on a same-repository pull request, and
// an opt-out is a control, read from the trust base like every other.
export const ONLINE_UNCHECKED_VALUES: ReadonlySet<string> = new Set(['fail', 'note']);

// The lockfile names an acknowledgement may name: the root lockfiles this
// tool inventories, written out here rather than imported so the config
// format does not depend on the loader. A test pins the two lists equal.
export const ACKNOWLEDGEABLE_LOCKFILE_NAMES: readonly string[] = [
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];
const BLOB_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// "PATH:BLOBID", split on the LAST colon. PATH has to be one of the root
// lockfile names exactly, and BLOBID a full lowercase git object id (SHA-1
// or SHA-256). Anything else is refused as invalid config rather than
// read as an acknowledgement that matches nothing, or worse, something.
function isValidLockfileAcknowledgement(entry: string): boolean {
  const separator = entry.lastIndexOf(':');
  if (separator <= 0) {
    return false;
  }
  return (
    ACKNOWLEDGEABLE_LOCKFILE_NAMES.includes(entry.slice(0, separator)) &&
    BLOB_ID.test(entry.slice(separator + 1))
  );
}

// A "denyUnreadAcknowledged" entry: "PATH:BLOBID", split on the LAST colon,
// where PATH is a "/"-separated repository path with no empty, "." or ".."
// segment whose file name is one of the lockfile names above, and BLOBID a
// full lowercase git object id. It accepts one exact set of bytes of one
// lockfile the deny list cannot read, so changed bytes are a gap again.
function isValidDenyUnreadAcknowledgement(entry: string): boolean {
  const separator = entry.lastIndexOf(':');
  if (separator <= 0) {
    return false;
  }
  const filePath = entry.slice(0, separator);
  const segments = filePath.split('/');
  return (
    !filePath.includes('\\') &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
    ACKNOWLEDGEABLE_LOCKFILE_NAMES.includes(segments[segments.length - 1]) &&
    BLOB_ID.test(entry.slice(separator + 1))
  );
}

// Exported so the CLI can validate --fail-on against the exact same set
// this file checks a config's "failOn" key against. Two independently
// maintained copies of this list is how a newly added severity level gets
// silently rejected by one side and not the other.
export const FAIL_ON_LEVELS: ReadonlySet<FailOn> = new Set([
  'critical',
  'high',
  'medium',
  'low',
  'none',
]);

const STRING_ARRAY_KEYS = ['allow', 'internalScopes', 'internalPrefixes', 'ignorePaths'] as const;

// allow refuses a bare star on the stated grounds that a security gate
// should not have a quiet off switch (see checks/allow.ts). ignorePaths has
// exactly that switch one key over, and a worse one: allow at least leaves
// a package name in the config for a reviewer to read, while a whole-tree
// ignore drops every finding in the repository before the gate ever sees
// its severity. Entries are normalized the same way scan.ts's matcher
// normalizes them ("./" and trailing "/" carry no meaning) so the refusal
// cannot be walked around by respelling it.
// Naming the two spellings "*" and "**" left the switch one keystroke
// away: "**/**", "**/*" and "*/**" each still match every manifest path
// in the repository. A pattern whose every character is a wildcard or a
// separator has no literal in it to narrow anything, so it can only mean
// "everything" however it is punctuated. A bare "package.json" is
// deliberately NOT refused -- ignoring the root manifest is legitimate in
// a monorepo that only cares about its workspace packages, and it names
// exactly one file.
function refusesEverything(rawEntry: string): boolean {
  let entry = rawEntry.trim();
  while (entry.startsWith('./')) {
    entry = entry.slice(2);
  }
  while (entry.endsWith('/')) {
    entry = entry.slice(0, -1);
  }
  if (!entry.includes('*')) {
    return false;
  }
  return [...entry].every((character) => character === '*' || character === '/');
}

// A JSON object can carry an own property literally named "__proto__",
// "constructor", or "prototype" -- these three are rejected wherever a
// config value becomes the keys of a plain object this code builds,
// because assigning into such a key by anything other than a fixed
// literal string risks writing through to Object.prototype instead of
// the intended object.
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

// A plain constant here would share its array/object fields by reference
// across every call -- loadConfig(a).allow.push('x') would silently
// mutate the defaults every later loadConfig(b) falls back to, since
// spreading `{...DEFAULT_CONFIG}` only copies the top-level object, not
// the arrays and the extraAliases object nested inside it. A factory
// returns a fresh set of empty collections on every call instead.
// The floor issue #58 asks for by default: aligned with a commonly used
// Dependabot minimum-release-age cooldown, and overridable per repository
// via "minAgeDays" for a project that runs a different one.
export const DEFAULT_MIN_AGE_DAYS = 7;

function defaultConfig(): ResolvedConfig {
  return {
    failOn: 'medium',
    allow: [],
    internalScopes: [],
    internalPrefixes: [],
    extraAliases: {},
    ignorePaths: [],
    online: false,
    minAgeDays: DEFAULT_MIN_AGE_DAYS,
    minAgeAllow: [],
    acknowledgedLockfiles: [],
    deny: [],
    denyUnreadAcknowledged: [],
  };
}

function validateDenyUnreadAcknowledged(value: unknown, label: string): string[] {
  if (!isStringArray(value)) {
    throw new DepGuardError(`${label}: "denyUnreadAcknowledged" must be an array of strings`, 'config-invalid');
  }
  for (const entry of value) {
    if (!isValidDenyUnreadAcknowledgement(entry)) {
      throw new DepGuardError(
        `${label}: "denyUnreadAcknowledged" entry "${entry}" must be "PATH:BLOBID", where PATH is a repository ` +
          `path to a lockfile (${ACKNOWLEDGEABLE_LOCKFILE_NAMES.join(', ')}) with no empty, "." or ".." part and ` +
          'BLOBID is a full lowercase git blob id',
        'config-invalid'
      );
    }
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

// JSON-parses one config file's CONTENT. Split out of readJsonFile so
// that a config read from a git ref (trust-base.ts, pull-request mode)
// and a config read off disk go through the identical parse and the
// identical two failure messages -- a base-ref config that is malformed
// has to be refused in exactly the same words as an on-disk one, or the
// two loaders are two policies.
function parseJsonConfig(content: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutByteOrderMark(content));
  } catch {
    throw new DepGuardError(`${label}: not valid JSON`, 'config-invalid');
  }
  if (!isPlainObject(parsed)) {
    throw new DepGuardError(`${label}: config is not a JSON object`, 'config-invalid');
  }
  return parsed;
}

// Reads and JSON-parses one config file. Missing is not an error (the
// caller treats it as "nothing to overlay"); anything else that goes
// wrong reading or parsing it is a config-invalid DepGuardError, since a
// present-but-broken config file should stop the scan rather than
// silently fall back to defaults.
function readJsonFile(filePath: string, label: string): Record<string, unknown> | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new DepGuardError(`${label}: could not be read (${(error as Error).message})`, 'config-invalid');
  }

  return parseJsonConfig(content, label);
}

// An exact release, never a range: digits only in each of the three core
// fields (no leading zeros are refused here -- that stricter rule belongs
// to whoever mints a version, not to whoever names one that already
// exists), an optional dot-separated prerelease, and an optional
// dot-separated build metadata tag, per semver's own grammar. No leading
// operator (`^`, `~`, `>=`), no `x`/`*` wildcard segment, and no space --
// which also refuses a hyphen RANGE ("1.0.0 - 2.0.0") for free, since a
// range's two endpoints are joined by whitespace around the hyphen and this
// pattern admits none. A bare hyphen inside a prerelease identifier
// ("1.0.0-beta-2") is untouched by that and stays valid, as it must: it
// still names one exact release.
const EXACT_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isExactVersion(version: string): boolean {
  return EXACT_VERSION_PATTERN.test(version.trim());
}

// Split the way delta.ts's versionRangeOf splits an alias target ("npm:" +
// name + "@" + range): the LAST "@" is the separator, and it has to sit
// past index 0 so a scoped name's own leading "@" ("@scope/pkg") is never
// mistaken for it. A "minAgeAllow" entry with no version half at all --
// just a bare package name -- is exactly the much bigger door the field
// comment on ResolvedConfig.minAgeAllow warns against (silencing every
// future version of a name, not one reviewed release), so it is rejected
// here rather than accepted and silently matching nothing at check time.
// The version half also has to be an EXACT version, not a semver range:
// "foo@^1.2.3" or "foo@1.x" would silence every future release matching
// that range too, the identical much-bigger-door problem a bare name has,
// just spelled with a version-shaped suffix instead of no suffix at all.
function isValidNameAtVersionEntry(entry: string): boolean {
  const separator = entry.lastIndexOf('@');
  if (separator <= 0) {
    return false;
  }
  const name = entry.slice(0, separator);
  const version = entry.slice(separator + 1);
  return name.trim().length > 0 && isExactVersion(version);
}

function validateExtraAliases(value: unknown, label: string): Record<string, string[]> {
  if (!isPlainObject(value)) {
    throw new DepGuardError(`${label}: "extraAliases" must be an object`, 'config-invalid');
  }
  const result: Record<string, string[]> = {};
  // Object.entries only ever yields own enumerable properties, so a key
  // literally named "__proto__" or "constructor" surfaces here as data to
  // check rather than silently resolving to an inherited member -- and it
  // is rejected explicitly below rather than ever being used to index
  // into `result`.
  for (const [key, targets] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new DepGuardError(`${label}: "extraAliases" has a disallowed key "${key}"`, 'config-invalid');
    }
    if (!isStringArray(targets)) {
      throw new DepGuardError(`${label}: "extraAliases.${key}" must be an array of strings`, 'config-invalid');
    }
    result[key] = targets;
  }
  return result;
}

// ---------------------------------------------------------------------------
// The deny list (issue 137, checks/deny.ts)

const DENY_ENTRY_FIELDS: ReadonlySet<string> = new Set(['name', 'reason', 'versions', 'reviewBy']);
const DENY_ENTRY_SHAPE = '{ "name": "<package>", "reason": "<why>" }';
const MAX_DENY_REASON_LENGTH = 300;
const MAX_NPM_NAME_LENGTH = 214;
// One npm name segment: the characters npm names are written in. Case is
// allowed (names from before the lowercase rule still install) and compared
// case-insensitively at match time.
const NPM_NAME_SEGMENT = '[A-Za-z0-9._~-]+';
const DENY_NPM_NAME = new RegExp(`^(?:@${NPM_NAME_SEGMENT}/)?${NPM_NAME_SEGMENT}$`);
// "@scope/*", the only wildcard, the same form an allow entry takes.
const DENY_SCOPE_WILDCARD = new RegExp(`^@${NPM_NAME_SEGMENT}/\\*$`);
export const DENY_PYPI_PREFIX = 'pypi:';
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// A YYYY-MM-DD string that names a real calendar date: 2027-02-30 and
// 2027-02-29 are refused, 2028-02-29 is not.
function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (match === null) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// The deny entry name, checked as written: an exact npm name of at most 214
// characters, "@scope/*", or "pypi:" and a valid Python project name.
function isValidDenyName(name: string): boolean {
  if (name.startsWith(DENY_PYPI_PREFIX)) {
    const project = name.slice(DENY_PYPI_PREFIX.length);
    return project.length > 0 && project.trim() === project && isValidPythonName(project);
  }
  if (DENY_SCOPE_WILDCARD.test(name)) {
    return true;
  }
  return name.length <= MAX_NPM_NAME_LENGTH && DENY_NPM_NAME.test(name);
}

/**
 * The identity of a deny entry: its name in the form names are compared in
 * (lowercase for npm, "pypi:" plus the PEP 503 form for Python) and its
 * sorted versions. Two entries with the same key are duplicates, and are
 * refused, so every entry has its own signal and fingerprint. The same key
 * is what the comparison-side union and the lift proposals pair entries by.
 */
export function denyEntryKey(entry: Pick<DenyEntry, 'name' | 'versions'>): string {
  return JSON.stringify([normalizedDenyName(entry.name), denyVersionsKey(entry.versions)]);
}

// A deny entry's name in the form it is compared in.
export function normalizedDenyName(name: string): string {
  return name.startsWith(DENY_PYPI_PREFIX)
    ? `${DENY_PYPI_PREFIX}${normalizePypiName(name.slice(DENY_PYPI_PREFIX.length))}`
    : name.toLowerCase();
}

function denyVersionsKey(versions: readonly string[] | undefined): string[] {
  return versions === undefined ? [] : [...new Set(versions.map((version) => version.trim()))].sort();
}

/**
 * The checks a reviewed list entry shares with any other list of the same
 * kind: a reason a reader can print, and an optional review date. Kept apart
 * from the deny-specific checks so that issue 87's allow entries, when they
 * land, use the same field names and the same refusals.
 */
function validateReviewedEntry(entry: Record<string, unknown>, where: string): { reason: string; reviewBy?: string } {
  const { reason, reviewBy } = entry;
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new DepGuardError(`${where}: "reason" is required and must be a non-empty string`, 'config-invalid');
  }
  const trimmed = reason.trim();
  if (trimmed.length > MAX_DENY_REASON_LENGTH) {
    throw new DepGuardError(
      `${where}: "reason" is ${trimmed.length} characters; at most ${MAX_DENY_REASON_LENGTH} are allowed`,
      'config-invalid'
    );
  }
  if (hasControlCharacter(trimmed)) {
    throw new DepGuardError(
      `${where}: "reason" carries a control, bidi or zero-width character, which a report cannot print safely`,
      'config-invalid'
    );
  }
  if (reviewBy === undefined) {
    return { reason: trimmed };
  }
  if (typeof reviewBy !== 'string' || !isCalendarDate(reviewBy)) {
    throw new DepGuardError(`${where}: "reviewBy" must be a real calendar date written YYYY-MM-DD`, 'config-invalid');
  }
  return { reason: trimmed, reviewBy };
}

// Validates the "deny" value. Every refusal is config-invalid with its own
// message, so a typo fails loudly instead of quietly widening or narrowing
// a ban.
function validateDeny(value: unknown, label: string): DenyEntry[] {
  if (!Array.isArray(value)) {
    throw new DepGuardError(`${label}: "deny" must be an array of entries shaped ${DENY_ENTRY_SHAPE}`, 'config-invalid');
  }
  const result: DenyEntry[] = [];
  const seen = new Map<string, number>();
  value.forEach((raw: unknown, index) => {
    const where = `${label}: "deny" entry ${index + 1}`;
    if (typeof raw === 'string') {
      throw new DepGuardError(
        `${where} is the string "${raw.slice(0, MAX_NPM_NAME_LENGTH)}"; an entry is an object shaped ${DENY_ENTRY_SHAPE}`,
        'config-invalid'
      );
    }
    if (!isPlainObject(raw)) {
      throw new DepGuardError(`${where} must be an object shaped ${DENY_ENTRY_SHAPE}`, 'config-invalid');
    }
    for (const field of Object.keys(raw)) {
      if (!DENY_ENTRY_FIELDS.has(field)) {
        throw new DepGuardError(
          `${where}: unknown field "${field}"; an entry has name, reason, versions and reviewBy only`,
          'config-invalid'
        );
      }
    }
    if (typeof raw.name !== 'string' || !isValidDenyName(raw.name)) {
      throw new DepGuardError(
        `${where}: "name" must be an exact npm name, "@scope/*", or "pypi:" and a Python project name`,
        'config-invalid'
      );
    }
    const name = raw.name;
    const reviewed = validateReviewedEntry(raw, where);
    const entry: DenyEntry = { name, reason: reviewed.reason };
    if (raw.versions !== undefined) {
      if (name.startsWith(DENY_PYPI_PREFIX)) {
        throw new DepGuardError(`${where}: "versions" is for npm entries only; a "pypi:" entry bans every version`, 'config-invalid');
      }
      if (
        !Array.isArray(raw.versions) ||
        raw.versions.length === 0 ||
        !raw.versions.every((version) => typeof version === 'string' && isExactVersion(version))
      ) {
        throw new DepGuardError(
          `${where}: "versions" must be a non-empty array of exact versions, never a range`,
          'config-invalid'
        );
      }
      entry.versions = (raw.versions as string[]).map((version) => version.trim());
    }
    if (reviewed.reviewBy !== undefined) {
      entry.reviewBy = reviewed.reviewBy;
    }
    const key = denyEntryKey(entry);
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      throw new DepGuardError(
        `${where} is a duplicate of entry ${earlier} (the same name and the same versions); keep one`,
        'config-invalid'
      );
    }
    seen.set(key, index + 1);
    result.push(entry);
  });
  return result;
}

// Validates one parsed config file against the known shape and returns
// only the keys it actually set, so the caller can shallow-merge the
// result over whatever came before.
function validateSection(raw: Record<string, unknown>, label: string): Partial<ResolvedConfig> {
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new DepGuardError(`${label}: unknown config key "${key}"`, 'config-invalid');
    }
  }

  const result: Partial<ResolvedConfig> = {};

  if (raw.failOn !== undefined) {
    // failOn gates whether the whole scan fails, so an unrecognized value
    // here is the one validation failure that would otherwise fail the
    // gate open (silently treating "catastrophic" as "never fails")
    // rather than loud -- this check is what keeps that from happening.
    if (typeof raw.failOn !== 'string' || !FAIL_ON_LEVELS.has(raw.failOn as FailOn)) {
      throw new DepGuardError(
        `${label}: "failOn" must be one of ${[...FAIL_ON_LEVELS].join(', ')}`,
        'config-invalid'
      );
    }
    result.failOn = raw.failOn as FailOn;
  }

  if (raw.online !== undefined) {
    if (typeof raw.online !== 'boolean') {
      throw new DepGuardError(`${label}: "online" must be a boolean`, 'config-invalid');
    }
    result.online = raw.online;
  }

  for (const key of STRING_ARRAY_KEYS) {
    if (raw[key] !== undefined) {
      if (!isStringArray(raw[key])) {
        throw new DepGuardError(`${label}: "${key}" must be an array of strings`, 'config-invalid');
      }
      result[key] = raw[key] as string[];
    }
  }

  if (result.ignorePaths !== undefined) {
    for (const entry of result.ignorePaths) {
      if (refusesEverything(entry)) {
        throw new DepGuardError(
          `${label}: "ignorePaths" entry "${entry}" matches every path, which would drop every finding before the gate could weigh it; ignore a directory or a file instead`,
          'config-invalid'
        );
      }
    }
  }

  if (raw.extraAliases !== undefined) {
    result.extraAliases = validateExtraAliases(raw.extraAliases, label);
  }

  if (raw.minAgeDays !== undefined) {
    // An integer floor, and non-negative: 0 is meaningful (issue #58 --
    // "only future-dated publishes are refused"), but a negative number
    // would flag nothing yet still read as configured, silently
    // disagreeing with a repository's own Dependabot cooldown rather than
    // failing loudly the way a garbage value should.
    if (
      typeof raw.minAgeDays !== 'number' ||
      !Number.isInteger(raw.minAgeDays) ||
      raw.minAgeDays < 0
    ) {
      throw new DepGuardError(`${label}: "minAgeDays" must be a non-negative integer`, 'config-invalid');
    }
    result.minAgeDays = raw.minAgeDays;
  }

  // The per-run online wall-clock budget (issue #75), in milliseconds.
  // Unset (rather than defaulted here) so scan.ts can tell "this repository
  // has no opinion" apart from an explicit override of any value, including
  // one that happens to match a default -- resolveOnlineBudgetMs is what
  // picks between the hook default and the much larger pull-request default
  // when this is absent. Validated the same way minAgeDays is: a
  // non-negative integer, with 0 meaning "no online time at all" (the same
  // meaning createOnlineDeadline already gives a zero budget), not a
  // silently-ignored garbage value.
  if (raw.onlineBudgetMs !== undefined) {
    if (
      typeof raw.onlineBudgetMs !== 'number' ||
      !Number.isInteger(raw.onlineBudgetMs) ||
      raw.onlineBudgetMs < 0
    ) {
      throw new DepGuardError(`${label}: "onlineBudgetMs" must be a non-negative integer`, 'config-invalid');
    }
    result.onlineBudgetMs = raw.onlineBudgetMs;
  }

  if (raw.onlineUnchecked !== undefined) {
    if (typeof raw.onlineUnchecked !== 'string' || !ONLINE_UNCHECKED_VALUES.has(raw.onlineUnchecked)) {
      throw new DepGuardError(
        `${label}: "onlineUnchecked" must be one of ${[...ONLINE_UNCHECKED_VALUES].join(', ')}`,
        'config-invalid'
      );
    }
    result.onlineUnchecked = raw.onlineUnchecked as 'fail' | 'note';
  }

  if (raw.minAgeAllow !== undefined) {
    if (!isStringArray(raw.minAgeAllow)) {
      throw new DepGuardError(`${label}: "minAgeAllow" must be an array of strings`, 'config-invalid');
    }
    for (const entry of raw.minAgeAllow) {
      if (!isValidNameAtVersionEntry(entry)) {
        throw new DepGuardError(
          `${label}: "minAgeAllow" entry "${entry}" must be an exact "name@version" string, with a concrete version rather than a semver range`,
          'config-invalid'
        );
      }
    }
    result.minAgeAllow = raw.minAgeAllow;
  }

  if (raw.acknowledgedLockfiles !== undefined) {
    if (!isStringArray(raw.acknowledgedLockfiles)) {
      throw new DepGuardError(`${label}: "acknowledgedLockfiles" must be an array of strings`, 'config-invalid');
    }
    for (const entry of raw.acknowledgedLockfiles) {
      if (!isValidLockfileAcknowledgement(entry)) {
        throw new DepGuardError(
          `${label}: "acknowledgedLockfiles" entry "${entry}" must be "LOCKFILE:BLOBID", where LOCKFILE is a ` +
            `root lockfile name (${ACKNOWLEDGEABLE_LOCKFILE_NAMES.join(', ')}) and BLOBID is a full lowercase ` +
            'git blob id',
          'config-invalid'
        );
      }
    }
    result.acknowledgedLockfiles = raw.acknowledgedLockfiles;
  }

  if (raw.deny !== undefined) {
    result.deny = validateDeny(raw.deny, label);
  }

  if (raw.denyUnreadLockfiles !== undefined) {
    if (typeof raw.denyUnreadLockfiles !== 'string' || !DENY_UNREAD_LOCKFILES_VALUES.has(raw.denyUnreadLockfiles)) {
      throw new DepGuardError(
        `${label}: "denyUnreadLockfiles" must be one of ${[...DENY_UNREAD_LOCKFILES_VALUES].join(', ')}`,
        'config-invalid'
      );
    }
    result.denyUnreadLockfiles = raw.denyUnreadLockfiles as 'fail' | 'note';
  }

  if (raw.denyUnreadAcknowledged !== undefined) {
    result.denyUnreadAcknowledged = validateDenyUnreadAcknowledged(raw.denyUnreadAcknowledged, label);
  }

  return result;
}

/**
 * The deny list and its unread-lockfile setting out of one side's two config
 * texts, read leniently: for a --staged run, whose comparison side is HEAD.
 * A HEAD config that does not validate must not stop a commit hook (the
 * commit that fixes the config would be blocked too), so each file's "deny"
 * array is read entry by entry, every entry that validates is kept, and
 * whatever could not be read is returned as a problem for a diagnostic.
 * The overlay is the same shallow one: a local file that sets "deny"
 * replaces the committed file's list.
 */
export function readDenyLeniently(
  baseText: string | null,
  localText: string | null,
  label: string
): { deny: DenyEntry[]; denyUnreadLockfiles?: 'fail' | 'note'; denyUnreadAcknowledged: string[]; problems: string[] } {
  const problems: string[] = [];
  let deny: DenyEntry[] = [];
  let unread: 'fail' | 'note' | undefined;
  // Shallow like every key: a local file that sets it replaces the list.
  let acknowledged: string[] = [];
  for (const [text, file] of [
    [baseText, CONFIG_FILE],
    [localText, LOCAL_CONFIG_FILE],
  ] as const) {
    if (text === null) {
      continue;
    }
    const where = `${label}:${file}`;
    let parsed: Record<string, unknown>;
    try {
      parsed = parseJsonConfig(text, where);
    } catch (error) {
      problems.push((error as Error).message);
      continue;
    }
    if (parsed.deny !== undefined) {
      if (!Array.isArray(parsed.deny)) {
        problems.push(`${where}: "deny" is not an array`);
      } else {
        const kept: DenyEntry[] = [];
        const keys = new Set<string>();
        for (const raw of parsed.deny as unknown[]) {
          try {
            const [entry] = validateDeny([raw], where);
            const key = denyEntryKey(entry);
            if (!keys.has(key)) {
              keys.add(key);
              kept.push(entry);
            }
          } catch (error) {
            problems.push((error as Error).message);
          }
        }
        deny = kept;
      }
    }
    if (parsed.denyUnreadLockfiles !== undefined) {
      if (typeof parsed.denyUnreadLockfiles === 'string' && DENY_UNREAD_LOCKFILES_VALUES.has(parsed.denyUnreadLockfiles)) {
        unread = parsed.denyUnreadLockfiles as 'fail' | 'note';
      } else {
        problems.push(`${where}: "denyUnreadLockfiles" is not one of ${[...DENY_UNREAD_LOCKFILES_VALUES].join(', ')}`);
      }
    }
    if (parsed.denyUnreadAcknowledged !== undefined) {
      if (!isStringArray(parsed.denyUnreadAcknowledged)) {
        problems.push(`${where}: "denyUnreadAcknowledged" is not an array of strings`);
        acknowledged = [];
      } else {
        acknowledged = parsed.denyUnreadAcknowledged.filter((entry) => {
          const valid = isValidDenyUnreadAcknowledgement(entry);
          if (!valid) {
            problems.push(`${where}: "denyUnreadAcknowledged" entry "${entry}" is not "PATH:BLOBID" on a lockfile path`);
          }
          return valid;
        });
      }
    }
  }
  return {
    deny,
    ...(unread === undefined ? {} : { denyUnreadLockfiles: unread }),
    denyUnreadAcknowledged: acknowledged,
    problems,
  };
}

// Reads .dep-guard.json, then overlays .dep-guard.local.json on top of it.
// The overlay is shallow: a key the local file sets replaces the base
// file's value for that key outright (an overridden extraAliases is not
// merged entry-by-entry with the base file's), which is what "local wins"
// means here. Absent files contribute nothing and are not an error --
// only a present-but-malformed or unrecognized-shape file is.
export function loadConfig(repoRoot: string): ResolvedConfig {
  const base = readJsonFile(path.join(repoRoot, CONFIG_FILE), CONFIG_FILE);
  const local = readJsonFile(path.join(repoRoot, LOCAL_CONFIG_FILE), LOCAL_CONFIG_FILE);
  return resolveConfig(base, CONFIG_FILE, local, LOCAL_CONFIG_FILE);
}

// The overlay itself, once both sides have been parsed. loadConfig and
// loadConfigFromTexts share it so pull-request mode cannot end up with a
// different precedence rule than the on-disk load: "local wins, shallow"
// is one decision, written once.
function resolveConfig(
  base: Record<string, unknown> | null,
  baseLabel: string,
  local: Record<string, unknown> | null,
  localLabel: string
): ResolvedConfig {
  let config: ResolvedConfig = defaultConfig();
  if (base !== null) {
    config = { ...config, ...validateSection(base, baseLabel) };
  }
  if (local !== null) {
    config = { ...config, ...validateSection(local, localLabel) };
  }
  return config;
}

/**
 * The same config, built from two blobs rather than two files.
 *
 * Pull-request mode reads .dep-guard.json and .dep-guard.local.json out of
 * the base ref through git, so it has text where loadConfig has paths. It
 * still gets the same validation, the same overlay order, and the same
 * config-invalid failures -- only the source of the bytes differs. The
 * local overlay is read from the base ref too: on a pull-request run a
 * committed .dep-guard.local.json is just as much a control input the
 * head could rewrite as .dep-guard.json is, and reading one from base
 * while trusting the other from head would leave the hole open one file
 * over.
 *
 * `label` is the ref, so a malformed base config names where it came from
 * ("origin/main:.dep-guard.json: not valid JSON") rather than reading as
 * a complaint about the file in the user's working tree.
 */
export function loadConfigFromTexts(
  baseText: string | null,
  localText: string | null,
  label: string
): ResolvedConfig {
  const baseLabel = `${label}:${CONFIG_FILE}`;
  const localLabel = `${label}:${LOCAL_CONFIG_FILE}`;
  return resolveConfig(
    baseText === null ? null : parseJsonConfig(baseText, baseLabel),
    baseLabel,
    localText === null ? null : parseJsonConfig(localText, localLabel),
    localLabel
  );
}
