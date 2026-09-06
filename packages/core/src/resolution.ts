// Where a resolved lockfile entry says its bytes come from.
//
// This lives on its own rather than inside checks/tamper.ts because two
// callers now need the same answer and disagreeing about it is exactly the
// class of bug this engine keeps producing: tamper.ts decides whether a
// resolution moved, and delta.ts decides which earlier entry a changed one
// should be compared against in the first place. A second copy of "same
// origin" would let the delta pair two entries the check then calls
// different.
//
// `host` and `protocol` are kept apart (rather than folded into one opaque
// identity) so a caller can tell a host change from a scheme-only change
// and react to each differently; `origin` is what a message or a details
// field prints -- the host when there is one, the scheme and path when
// there is not, since a file: URL's empty host would otherwise print as a
// bare, confusing "".
//
// `origin` is "where the bytes come from", and for a hostless URL
// that has to include the path -- every file: URL has an empty host, so a
// file-to-file repoint (a vendored tarball swapped for a planted one) has
// an identical scheme and an identical empty host and would otherwise be
// silent. A path carries no meaning for a network URL (a version bump
// moves it every time) and carries all of it for a local one, so the path
// is part of the origin exactly when there is no host to identify the
// source instead.
export interface Resolution {
  protocol: string;
  host: string;
  origin: string;
}

export function resolutionOf(url: string): Resolution | null {
  try {
    const parsed = new URL(url);
    return {
      protocol: parsed.protocol,
      host: parsed.host,
      origin:
        parsed.host !== ''
          ? `${parsed.protocol}//${parsed.host}`
          : `${parsed.protocol}//${parsed.pathname}`,
    };
  } catch {
    return null;
  }
}

// What KIND of source a resolution names, as opposed to where it points.
// `Protocol` in manifest.ts answers this for a DECLARED specifier; this
// answers it for a RESOLVED url, which is the only thing the lockfile walk
// has -- a transitive entry has no manifest line to read a protocol off.
// The two are deliberately separate types: a manifest `registry` specifier
// can resolve to a git archive (a github dependency), and a rule that
// judges resolutions has to see what the lockfile actually points at.
export type ResolutionKind = 'registry' | 'git' | 'file' | 'url';

// The schemes npm and pnpm write for a git-sourced resolution. npm records
// a git dependency as `git+ssh://git@host/o/r.git#<sha>`; the sha rides in
// the FRAGMENT, so the path never moves under a commit bump.
const GIT_SCHEMES: ReadonlySet<string> = new Set([
  'git:',
  'git+ssh:',
  'git+https:',
  'git+http:',
  'git+file:',
  'ssh:',
]);

// Hosts that serve a git forge's SOURCE ARCHIVE over ordinary https, where
// the scheme alone cannot tell a git source from a registry tarball. pnpm
// records a github dependency as a codeload tarball --
// `https://codeload.github.com/o/r/tar.gz/<sha>` -- and there the sha rides
// in the PATH, so a commit bump moves the pathname exactly the way a repoint
// does. That one shape is the whole reason this set exists.
//
// It holds exactly one host, and adding another needs more care than it
// looks, because the two directions of error are NOT symmetric:
//
//   - A host MISSING from this set is classified `registry`. The worst that
//     costs is a false positive on a commit bump.
//   - A host wrongly IN this set is classified `git`, which silently removes
//     a real registry from the repoint signal's scope. That is lost
//     coverage, and it is silent.
//
// So an over-broad entry is the expensive mistake, and this set had three of
// them: bare `github.com`, `gitlab.com` and `bitbucket.org`. They bought no
// coverage for either supported lockfile format -- pnpm's github shape is
// codeload, and npm writes a `git+` scheme for all of these, which
// GIT_SCHEMES already catches -- while `gitlab.com` actively cost some,
// because `https://gitlab.com/api/v4/projects/<id>/packages/npm/<pkg>/-/...`
// is GitLab's real npm package REGISTRY. A hashless held-version repoint
// from one project id to another on that host produced no finding at all.
//
// The earlier version of this comment claimed "none of these hosts is ever
// an npm registry" (false for gitlab.com) and that an omission "can only
// cost a false positive, never a missed repoint" (true of hosts missing
// FROM the list, false of over-broad entries IN it). Both are recorded here
// as mistakes rather than quietly deleted, because a forge domain looks like
// an obvious thing to add and the reasoning that makes it wrong is not.
// Match the archive SHAPE npm and pnpm actually write, never the domain of
// whoever happens to own the forge.
const GIT_FORGE_ARCHIVE_HOSTS: ReadonlySet<string> = new Set(['codeload.github.com']);

export function resolutionKindOf(resolution: Resolution): ResolutionKind {
  if (GIT_SCHEMES.has(resolution.protocol)) {
    return 'git';
  }
  if (resolution.protocol === 'file:') {
    return 'file';
  }
  if (resolution.protocol === 'http:' || resolution.protocol === 'https:') {
    return GIT_FORGE_ARCHIVE_HOSTS.has(resolution.host) ? 'git' : 'registry';
  }
  return 'url';
}

// The origin of a URL that may be absent or unparseable. null means "no
// origin could be established", which is never equal to anything -- two
// entries that both fail to parse are not thereby the same source.
export function originOf(url: string | undefined): string | null {
  if (url === undefined) {
    return null;
  }
  return resolutionOf(url)?.origin ?? null;
}
