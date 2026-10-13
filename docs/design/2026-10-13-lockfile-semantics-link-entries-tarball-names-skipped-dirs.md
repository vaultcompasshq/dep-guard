# Lockfile semantics: link entries, tarball names, skipped directories

Status: implemented on this branch. Three gate bypasses, each of which let a
known-malicious name or tarball through at exit 0, and each closed by making
one lockfile fact mean what the package manager means by it.

## B1. A "link": true entry is a claim, not a fact

### What was wrong

`lockfiles/npm.ts` added the name of every `node_modules/X` entry carrying
`"link": true` to `workspaceLocalNames`. `git-source.ts` unioned that set
across every lockfile it read, including a lockfile the package manager in
use never reads, and `checks/candidates.ts` skips every name in the set for
unknown-package and typosquat (`online/publish-age.ts` skips it too). So a
pnpm repository that adds `crossenv` to `package.json` and `pnpm-lock.yaml`,
plus a nine-line `package-lock.json` holding only
`"node_modules/crossenv": {"resolved": "packages/crossenv", "link": true}`,
scanned clean while `pnpm install` fetched `crossenv` from the registry.

### Rule

A name from a link entry is workspace-local on a side only when both hold
on that same side:

1. **The lockfile is the active npm lockfile for its directory.** In a
   directory D the npm lockfile is `npm-shrinkwrap.json` when it is read
   there, else `package-lock.json` (npm ignores `package-lock.json` when a
   shrinkwrap is present). It is active when:
   - D's own `package.json` has a `packageManager` field, and that field
     names npm; or
   - D's `package.json` has no `packageManager` field, and no other
     lockfile format (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock`,
     `bun.lockb`) is present in D.

   Any other case (another format beside it with no `packageManager`
   tiebreak, or a `packageManager` naming pnpm, yarn or bun) contributes no
   names at all. A shrinkwrap's sibling `package-lock.json` never
   contributes either.
2. **The link points at a real package of that name.** The entry's
   `resolved` value, joined to D and normalised, names a directory T inside
   the repository, and `T/package.json` is a manifest this side parsed
   whose own `name` field is exactly the link name. A link entry with no
   `resolved`, or one that leaves the repository root, confirms nothing.
3. **T is a workspace member of D.** T, relative to D, is covered by the
   npm `workspaces` field of `D/package.json` (matched, not walked; a
   pattern this module cannot match exactly covers nothing). Added after
   an independent review: without it, a `package.json` planted outside
   every glob confirmed the link, while `npm install` treats such an entry
   as a registry fetch. On a `--trust-base` run the field is read from the
   trust base wherever the base has `D/package.json`, so a pull request
   that widens it cannot confirm its own link; the diagnostic says when
   that is the reason.

Names that fail any test are dropped from the set, and a
`workspace-link-unconfirmed` diagnostic names the lockfile and the names, so
a reader can see why a sibling is being name-checked.

A confirmed name is scoped to its lockfile's directory D: it exempts a
manifest dependency only when that dependency's own lockfile (the one
`lockfileForManifest` picks, which is what installs it) sits in D. Without
this, a planted npm-only project in `tools/x/` with a real local package
named `lodahs` exempted `lodahs` in a root manifest that pnpm installs from
the registry; a test pins that case.

`ParsedLockfile.workspaceLocalNames` keeps its meaning as the names the file
claims; the parser now also records each link entry's `resolved` value
(`workspaceLinks`). `RepoState.workspaceLocalNamesByDir` is the confirmed
set keyed by directory, computed in `git-source.ts` after the side's
manifests are parsed, and `RepoState.workspaceLocalNames` is its union
(still read by `online/publish-age.ts`, which judges lock entries rather
than manifest lines). `delta.ts` still takes both from the judged side, and
`checks/candidates.ts` reads the per-directory map.

### Residual

A pull request can still add a real workspace member under a glob the base
already declares, with a link entry for it. npm links that member, and its
code is in the diff under review. A `--base` run without `--trust-base`, a
staged run, and an install root the pull request adds itself read the
`workspaces` field from the head. (The first version of this note claimed
npm links any planted local package; that was false, see rule 3.) The
`packageManager` field is also head-controlled; setting it to npm in a pnpm
repository makes pnpm 9 (and corepack) refuse to install, which is loud, not
silent. Reading the set from the base, or the union of both sides, is still
the open design question INVARIANTS records; this change does not pick it.

## B2. A registry tarball must be the package its entry names

### What was wrong

`checks/tamper.ts` judged a resolved URL on a trusted registry host as
benign whatever package its path named, and the tarball-repoint branches
only fire at a held version. So `node_modules/ws` bumped from 8.22.0 to
8.22.1 with `resolved` set to `flatmap-stream`'s tarball on
`registry.npmjs.org` scanned clean, and `npm ci` installs exactly what
`resolved` and `integrity` say.

### Rule

For every added or changed lockfile entry (npm or pnpm) whose resolved URL
is an http(s) URL on a trusted registry host (the two public registries
plus every host the project `.npmrc` names), the tarball's own path is read
into a package name and a file name:

- Registry base path: when the `.npmrc` registry for that host has a path
  (`https://host/api/npm/remote/`), that prefix is stripped first.
- npm shape: `/<name>/-/<file>` or `/@scope/<name>/-/<file>`. A `%2f` or
  `%40` in the name is decoded. The name must be a valid package name
  shape: one segment, or `@scope/name`. The name segment is the identity:
  a registry serves a tarball from the package document that segment
  names. The version is read only when the file is
  `<basename>-<version>.tgz`; a file name of another shape carries no
  version claim and is judged by its name segment alone.
- GitHub Packages shape: `/download/@scope/name/<version>/<hex>`.

The name is compared with the entry's expected names:

- the entry's registry identity (`packageName`: the manifest's registry
  name when a manifest declares it, alias targets included, else the
  lockfile key, which for pnpm already is the registry name);
- for a changed entry, the tarball name of every earlier candidate under
  the same key (an alias that was already there survives a version bump);
- for an added entry that no manifest declares, the entry's vouched
  `lookupName`, which is how npm records a transitive alias
  (`string-width-cjs` installed from `string-width`), but only when some
  entry in the same lockfile also records an `npm:<lookupName>@` alias edge
  for that key. A manifest-declared entry never gets this: there the
  manifest says what installs. The accepted alias target is then
  name-checked like a declared dependency.

Outcomes, all `lockfile-tamper`, none dependent on whether the version
changed:

| Case | Severity | Signal |
|---|---|---|
| tarball name is none of the expected names | critical | `tarball-name-mismatch:<tarball name>` |
| npm-shape file name is not `<basename>-<version>.tgz` for the entry's version | high | `tarball-version-mismatch` |
| trusted registry host, path matches neither shape | medium | `unparseable-tarball:<host>` |

The name in the signal cannot move under a version bump, so it satisfies
the fingerprint-stability contract. Paths go into details, never URLs. An
entry with no URL (a pnpm registry entry) is the implied registry tarball
for its own name and is not checked. `allow` is not consulted, as for every
other tamper signal.

### Residual

An added transitive entry with both a matching `name` field and an alias
edge is accepted as an npm alias, and its target is name-checked. A real,
published, malicious target with a corpus-known name gets through, as a
manifest `npm:` alias to that name would. `registryTarballPackageName`, which vouches the
`name` field into `lookupName`, now reads past a registry path prefix
(last segment, or two for a scope), so such an alias on a proxied registry
is not a false positive; a registry that percent-encodes the scope there
still is.

## B3. A manifest beside a lockfile is a project, whatever its directory is called

### What was wrong

`loadState` dropped every manifest under `node_modules`, `.venv`, `venv`,
`dist`, `build`, `vendor` or `vendored` that no workspace pattern named,
while still reading lockfiles there. Name checks run over manifest changes
only, so `build/package.json` plus `build/package-lock.json` declaring
`crossenv` and a typosquat scanned clean with one note. This is the same
class as the withdrawn 0.11.0: a directory name filter deciding coverage.

### Rule

A project manifest under a skipped directory name is read like any other
manifest when a recognised lockfile (any name in `LOCKFILE_FILE_NAMES`)
sits in the same directory, and so is every `package.json` that install
root's own workspace patterns name (the `workspaces` field of its
`package.json`, or a `pnpm-workspace.yaml` beside the lockfile; matched
against listed paths, and a pattern this module cannot match exactly reads
more). The member half was added after an independent review showed
`build/app` dropped while `build/package-lock.json` was read. `node_modules`
is excluded from both, by ruling: nothing installs from inside it. A
manifest that is neither keeps the `manifest-skipped-dirname` note, whose
wording no longer promises lockfile coverage it does not give. The rule is
the same on both sides of a comparison.

## Fixtures and tests

Every attack from the audit becomes an end-to-end scan test against a real
git repository and the fixture corpus. The fixture corpus has no curated
malicious list, so the tests use `lodahs`, which it flags as a typosquat of
`lodash` at a blocking severity, where the audit used `crossenv`. Each test
has a control that shows it fails for the right reason:

- B1: pnpm base; head adds the dependency and a decoy `package-lock.json`
  link entry. Was exit 0, now a blocking name finding. Controls: a real npm
  workspace sibling stays exempt; a pnpm-plus-npm directory with
  `packageManager: npm@...` honours the link.
- B2: npm `ws` bumped and repointed to another package's tarball; pnpm
  `debug` gains another package's tarball URL; a version-mismatched file
  name; an unparseable path on a trusted host; a scoped package; a
  manifest-declared alias; a transitive alias with a vouched name. Control:
  an ordinary bump stays clean.
- B3: `build/package.json` plus `build/package-lock.json`. Was exit 0, now a
  blocking typosquat. Control: `build/package.json` alone keeps the note.

Each fix is mutation-tested: removing the manifest check (B1), dropping the
name comparison (B2) and restoring the drop (B3) each turn the attack test
red.

## INVARIANTS sentences

- A `"link": true` lockfile entry makes a name workspace-local only when its
  lockfile is the active npm lockfile for its directory, its `resolved`
  path holds a parsed manifest with exactly that name on the same side, and
  that path is a workspace member under the install root's `workspaces`
  field, read from the trust base where it has one.
- Every added or changed lockfile entry resolved from a trusted registry
  host has a tarball path naming its own package, or an earlier or
  npm-recorded alias of it; anything else is `lockfile-tamper`, whatever the
  version did, and a path that cannot be read is a medium finding, never a
  pass.
- Outside `node_modules`, a manifest is never dropped for its directory
  name when a lockfile sits beside it or that install root's workspace
  patterns name it.
