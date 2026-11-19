// The environment every git process dep-guard starts runs with.
//
// GIT_NO_REPLACE_OBJECTS: a refs/replace ref makes git hand back a different
// object whenever the replaced one is read, for every command, without the
// ref ever appearing in what is read. A replace ref planted for the trust
// base's commit would make --trust-base read another tree's config, allow
// list and baseline while the base still names the real commit. dep-guard
// reads the objects the refs name, never a replacement. Replace refs are not
// fetched by a default clone, so this matters for a local repository.
export function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
}

/**
 * The environment used by every git process in a `--no-repo-controls` run.
 * Repository-location variables, alternate object stores, config injection
 * and a caller-supplied git exec path are removed. Windows names are compared
 * case-insensitively. The operator's ordinary environment remains available.
 */
export function cleanNoRepoControlsGitEnv(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const exact = new Set([
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_EXEC_PATH',
    'GIT_PREFIX',
    'GIT_IMPLICIT_WORK_TREE',
    'GIT_INTERNAL_SUPER_PREFIX',
    'GIT_GRAFT_FILE',
    'GIT_SHALLOW_FILE',
    'GIT_REPLACE_REF_BASE',
    'GIT_NO_REPLACE_OBJECTS',
    'GIT_OPTIONAL_LOCKS',
  ]);
  for (const name of Object.keys(env)) {
    const upper = platform === 'win32' ? name.toUpperCase() : name;
    if (exact.has(upper) || upper === 'GIT_CONFIG' || upper.startsWith('GIT_CONFIG_')) {
      delete env[name];
    }
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  return env;
}
