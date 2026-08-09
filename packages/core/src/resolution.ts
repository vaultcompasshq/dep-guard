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

// The origin of a URL that may be absent or unparseable. null means "no
// origin could be established", which is never equal to anything -- two
// entries that both fail to parse are not thereby the same source.
export function originOf(url: string | undefined): string | null {
  if (url === undefined) {
    return null;
  }
  return resolutionOf(url)?.origin ?? null;
}
