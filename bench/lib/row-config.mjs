// Per-repository configuration for a public bench row.
//
// A row in bench/repos.public.json may carry `config`, an object whose only
// allowed key is `ignorePaths`, with a required `configNote` saying that the
// upstream repository does not carry this configuration and why the bench
// applies it. The harness writes it into the throwaway clone as
// .dep-guard.json before the scan (the CLI has no config flag, and an audit
// reads config from the git root), and the baseline row records it as
// `configApplied`, so a reader of the baseline sees the override without
// opening the repository list.
//
// This is a harness input for measurement, never a dep-guard control: it
// lives in a clone that is deleted after the scan and is never read by a
// user's run. It never overwrites an upstream configuration: a clone that
// already carries .dep-guard.json or .dep-guard.local.json (which config.ts
// overlays on top of it) at the pinned commit is refused.

import { lstatSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ROW_CONFIG_KEYS = Object.freeze(['ignorePaths']);
export const UPSTREAM_CONFIG_FILES = Object.freeze(['.dep-guard.json', '.dep-guard.local.json']);
export const CONFIG_REFUSED = 'config-refused';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Throws when a row's config is not one the harness accepts. Run over the
 * whole list before anything is cloned.
 */
export function validateRowConfig(target) {
  const label = typeof target?.repo === 'string' ? target.repo : 'a repository row';
  if (target?.config === undefined) {
    if (target?.configNote !== undefined) {
      throw new Error(`${label}: configNote is set but the row has no config`);
    }
    return;
  }
  if (!isPlainObject(target.config)) {
    throw new Error(`${label}: config must be an object`);
  }
  const extra = Object.keys(target.config).filter((key) => !ROW_CONFIG_KEYS.includes(key));
  if (extra.length > 0) {
    throw new Error(`${label}: config may only carry ${ROW_CONFIG_KEYS.join(', ')}; found ${extra.join(', ')}`);
  }
  const ignorePaths = target.config.ignorePaths;
  if (!Array.isArray(ignorePaths) || ignorePaths.length === 0 || ignorePaths.some((entry) => typeof entry !== 'string' || entry === '')) {
    throw new Error(`${label}: config.ignorePaths must be a non-empty array of non-empty strings`);
  }
  if (typeof target.configNote !== 'string' || target.configNote.trim() === '') {
    throw new Error(
      `${label}: a row with config needs a configNote saying the upstream repository does not carry it and why the bench applies it`
    );
  }
}

export function validateRepoList(list) {
  for (const target of list?.repos ?? []) {
    validateRowConfig(target);
  }
}

function pathExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/**
 * Writes the row's config into the clone and returns it verbatim, or
 * returns null when the row has none. Refuses (an error whose skipReason is
 * config-refused) when the clone already carries a configuration file of
 * its own, a dangling symlink included; the file is created exclusively, so
 * a link planted between the check and the write is never followed.
 */
export function applyRowConfig(clonePath, target) {
  if (target?.config === undefined) {
    return null;
  }
  const present = UPSTREAM_CONFIG_FILES.filter((name) => pathExists(path.join(clonePath, name)));
  if (present.length > 0) {
    const error = new Error(
      `the clone already carries ${present.join(' and ')} at the pinned commit; the bench never overwrites or ` +
        'overlays an upstream configuration, so this row cannot be measured with its config'
    );
    error.skipReason = CONFIG_REFUSED;
    throw error;
  }
  writeFileSync(path.join(clonePath, UPSTREAM_CONFIG_FILES[0]), `${JSON.stringify(target.config, null, 2)}\n`, {
    flag: 'wx',
  });
  return target.config;
}

/** The baseline row for a scanned repository. */
export function baselineEntry(target, configApplied, counts) {
  return {
    repo: target.repo,
    sha: target.sha,
    ...(configApplied === null ? {} : { configApplied, configNote: target.configNote }),
    counts,
  };
}

// Key order does not matter to what a config means.
export function canonicalConfig(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalConfig).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalConfig(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
