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
