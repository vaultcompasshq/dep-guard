import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig } from './checks/types.js';
import { DepGuardError, type FailOn } from './types.js';

// This file owns the on-disk config format and its validation. The
// resolved shape checks read (ResolvedConfig) is declared once in
// checks/types.ts, since the checks were written against those six keys
// first -- re-exporting rather than redeclaring keeps the two from
// drifting apart.
export type { ResolvedConfig };

const CONFIG_FILE = '.dep-guard.json';
const LOCAL_CONFIG_FILE = '.dep-guard.local.json';

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'failOn',
  'allow',
  'internalScopes',
  'internalPrefixes',
  'extraAliases',
  'ignorePaths',
]);

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
function defaultConfig(): ResolvedConfig {
  return {
    failOn: 'medium',
    allow: [],
    internalScopes: [],
    internalPrefixes: [],
    extraAliases: {},
    ignorePaths: [],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new DepGuardError(`${label}: not valid JSON`, 'config-invalid');
  }
  if (!isPlainObject(parsed)) {
    throw new DepGuardError(`${label}: config is not a JSON object`, 'config-invalid');
  }
  return parsed;
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

  return result;
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

  let config: ResolvedConfig = defaultConfig();
  if (base !== null) {
    config = { ...config, ...validateSection(base, CONFIG_FILE) };
  }
  if (local !== null) {
    config = { ...config, ...validateSection(local, LOCAL_CONFIG_FILE) };
  }
  return config;
}
