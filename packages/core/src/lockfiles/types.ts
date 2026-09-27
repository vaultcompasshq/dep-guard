import type { Diagnostic } from '../types.js';

export interface LockEntry {
  version?: string;
  resolvedUrl?: string;
  integrity?: string;
  hasInstallScript?: boolean;
  // A LOOKUP hint only -- never identity. This is the registry name an
  // online check should ask about for this entry, when it differs from the
  // lockfile key; it must NEVER be read by anything that decides what a
  // finding IS (packageName, an allow match, a pin, a dedupe key, a
  // fingerprint). See delta.ts's LockEntryChange doc comment for why: an
  // npm packages entry's own "name" field is written by whoever committed
  // the lockfile, on a pull request the author of it, and npm installs the
  // same bytes whatever it says -- treating it as identity let a forged
  // "name" on a tampered nested entry silently clear its own
  // dependency-confusion and install-script findings (issue #69, review
  // finding).
  //
  // Populated ONLY when the entry's own resolvedUrl VOUCHES for the name --
  // the resolved value is a registry tarball URL whose path encodes exactly
  // that name (registryTarballPackageName in resolution.ts, reused from the
  // same URL-parsing tamper.ts already relies on). A name field present but
  // unvouched -- no resolvedUrl, a non-registry resolution (git, file, a
  // remote tarball -- all of which npm can also stamp a "name" field onto,
  // per arborist's shrinkwrap.js, whenever the installed folder differs
  // from the target's own package.json name), or a resolvedUrl whose path
  // names something else entirely -- is never trusted: lookupName stays
  // undefined and lockfiles/npm.ts raises a diagnostic instead, because a
  // name this parser cannot verify must be visible as unverified, not
  // silently used or silently dropped.
  //
  // Only online/publish-age.ts reads this field (as `lookupName ??
  // packageName`, for the registry query alone -- its finding still
  // reports under packageName, with the looked-up name carried in
  // `details` when the two differ). No other consumer may read it; grep to
  // confirm before adding one.
  //
  // Never set by lockfiles/pnpm.ts: a pnpm alias mapping lives entirely in
  // the DEPENDENT's own "dependencies" block, never on the target's own
  // packages-map entry, so pnpm's `name` key (parsePackageKey) already IS
  // the registry name and needs no separate lookup hint. Never set for
  // yarn or bun either -- neither format's entries are parsed at all (see
  // README.md's Lockfile support section), so there is no entry to carry
  // one.
  lookupName?: string;
}

export type LockfileFormat = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'none';

export interface ParsedLockfile {
  format: LockfileFormat;
  path: string;
  // Keyed by the INSTALLED name: everything after the final "node_modules/"
  // occurrence in a packages-map key, kept whole rather than split into
  // path segments (a scoped name like "@scope/pkg" contains a "/" and must
  // not be truncated), e.g. "node_modules/a/node_modules/@scope/b"
  // resolves to "@scope/b". Built with Object.entries/own-property
  // iteration into a Map rather than plain-object bracket assignment,
  // since npm allows package names like "constructor" and "__proto__"
  // that collide with Object.prototype members.
  //
  // For an npm alias dependency ("foo": "npm:lodash@1.0.0"), the packages
  // map key is "node_modules/foo" and the entry's own "name" field inside
  // that object is "lodash" -- but this map is keyed by "foo" (the
  // installed/manifest key), never by the alias target. The parser does
  // not resolve the inner "name" field into the key. Consequently, the
  // delta step must attach lock entries to a ManifestDep by its "name"
  // field, not its "registryName" -- looking up by registryName would
  // miss every aliased dependency.
  //
  // The delta step attaches lock entries by trying ManifestDep.name
  // first, then falling back to registryName, because the two lockfile
  // formats key their entries differently -- npm keys by installed name
  // (this file), while pnpm keys by registry name.
  //
  // The value is a LIST, not a single entry. Real lockfiles hold several
  // versions under one name -- nested npm dependency trees resolving a
  // shared name to different versions, and pnpm's per-peer-set version
  // splits -- and collapsing those to one entry would make an arbitrary
  // (frequently the older, string-sort-losing) version win, producing
  // false tamper positives downstream. Both parsers append on a name
  // collision instead of overwriting; a name with only one resolved
  // version still yields a one-element array. The delta step selects
  // among an entry list by specifier match and flags ambiguity when it
  // can't decide.
  entries: Map<string, LockEntry[]>;
  diagnostics: Diagnostic[];
  // Names this lockfile itself says are workspace-local rather than a
  // registry install. npm records a "link": true entry for every workspace
  // member alongside its ordinary entries, and that is the ONLY place this
  // fact is recorded for npm: an npm workspace sibling is declared with a
  // plain version range, indistinguishable from a registry dependency by
  // the manifest alone (unlike pnpm and yarn, which mark it with a
  // "workspace:" specifier the manifest walk already exempts). Populated
  // by the npm parser from those link entries; every other format leaves
  // it empty because its workspace members are already exempt earlier, at
  // the manifest/specifier level. This is discovered once, here, at parse
  // time, and carried forward rather than re-derived by a check.
  workspaceLocalNames: Set<string>;
}
