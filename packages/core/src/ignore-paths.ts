import { matchGlobPath } from './git-source.js';

// The ignorePaths matcher scan.ts's path filter uses, in a module of its
// own so any other step that asks whether a finding anchored on a path
// would be dropped asks it the same way.

export function normalizeIgnorePattern(pattern: string): string {
  let normalized = pattern.trim();
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

// config.ignorePaths was validated by config.ts from the day it landed but
// consumed nowhere until this filter. Three ways an entry can cover a
// finding's manifestPath: an exact match, a directory prefix (a plain
// "vendor/" entry covers every manifest underneath it, gitignore-style), or
// -- for an entry that actually contains a wildcard -- the same
// greedy-star, no-RegExp matcher git-source.ts uses for workspace globs.
// ignorePaths is attacker-writable content exactly like a workspaces
// array, and two ReDoS bugs already came from a regex built out of pattern
// text shaped like this; reusing the hardened matcher rather than writing
// a second one is the point.
//
// Returns every normalized entry that matches manifestPath, in
// configuration order -- not just the first one found. Callers use the
// full list (not a boolean, and not a single winner) to track, across a
// whole scan, which configured entries ever matched anything at all --
// see the ignore-path-unmatched diagnostic in scan.ts's applyPathFilters():
// the matcher's whole-path, segment-for-segment semantics are
// exactly right for safety, but they also mean a natural-looking entry
// like "packages/*" silently matches nothing against a manifest one
// segment deeper ("packages/app/package.json"), and a user has no other
// way to notice.
//
// Returning on the FIRST match and stopping would mean ignorePaths
// ["package.json", "**"] reports "**" unmatched for a finding at
// "package.json" -- "**" genuinely covers it too, it would just never be
// reached because the exact entry ahead of it in the array matched first.
// Every matching entry is credited instead, not only whichever one
// happened to be checked first.
export function matchingIgnoreEntries(manifestPath: string, ignorePaths: readonly string[]): string[] {
  const matches: string[] = [];
  for (const raw of ignorePaths) {
    const pattern = normalizeIgnorePattern(raw);
    if (pattern.length === 0) {
      continue;
    }
    if (
      pattern === manifestPath ||
      manifestPath.startsWith(`${pattern}/`) ||
      (pattern.includes('*') && matchGlobPath(pattern, manifestPath))
    ) {
      matches.push(pattern);
    }
  }
  return matches;
}
