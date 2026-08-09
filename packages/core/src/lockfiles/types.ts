import type { Diagnostic } from '../types.js';

export interface LockEntry {
  version?: string;
  resolvedUrl?: string;
  integrity?: string;
  hasInstallScript?: boolean;
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
}
