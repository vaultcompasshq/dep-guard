# Lockfile support

Coverage is honest per format rather than uniform. Where a format cannot
answer a question, the scan says so in a diagnostic instead of staying
quiet:

- `package-lock.json` and `npm-shrinkwrap.json` v2 and v3 -- full coverage.
  The `packages` map is read whenever it exists, whatever `lockfileVersion`
  says (npm installs from it either way). A file with no `packages` map at
  all is a real v1 lockfile: it gets a diagnostic and no entries; a
  `lockfileVersion` of 2 or 3, written as a number or as a string of digits,
  with no `packages` map is a parse error (exit 2, `lockfile-parse`; clear it
  by regenerating the lockfile with npm). That error is raised for the side
  being judged; on a comparison side (HEAD for `--staged`, the `--base` ref,
  the trust base) such a file is treated as a lockfile dep-guard does not
  read, named in `lockfile-unread-comparison-side`, so the pull request that
  regenerates it is judged as adding a new lockfile. Every finding's identity
  (its package name) always comes from the lockfile key itself, or from a
  manifest declaration -- never from a packages entry's own `name` field,
  which is written by whoever committed the lockfile and is not something
  dep-guard verifies at parse time. For a purely transitive `npm:` alias (one
  only some other package's own dependency introduces, which no manifest
  declares), the minimum-publish-age check still asks the registry about the
  real package installed rather than the alias name, but only when the
  entry's own resolved tarball URL vouches for that name; an unvouched name
  is ignored for that lookup and reported in a diagnostic rather than
  trusted or silently dropped. A registry that serves tarballs under a path
  prefix, or that percent-encodes a scope as `%2f` in the name, will raise
  that diagnostic for a perfectly genuine alias too -- expected noise for
  such a registry, never a wrong finding, since the affected entry simply
  falls back to being looked up under its lockfile key like any other.
- `pnpm-lock.yaml` -- host, integrity, tarball and git-source checks for
  every `lockfileVersion` from 5.x on (the slash-separated 5.x keys, the
  6.x keys and the v9 keys). Install scripts are read from `requiresBuild`
  in lockfiles older than v9; v9 stopped recording them, so for v9
  additions to `onlyBuiltDependencies` are used instead. A file holding more
  than one YAML document is read whole: the project document is what the
  manifest walk reads, and every other document shaped like a pnpm lockfile
  (pnpm writes one for its own managed version) is read and checked as a
  lockfile of its own, named `pnpm-lock.yaml#package-manager` or
  `pnpm-lock.yaml#document-N` in findings. A document that is not shaped
  like a pnpm lockfile is not read: the file's bytes outside the documents
  that are read are compared byte for byte, in order, with the base side,
  and a change to them is the same exit 2 as a changed lockfile dep-guard
  does not read (see below). pnpm records an ordinary
  registry resolution as an integrity hash alone and writes a tarball URL
  only when it is not the registry's standard one, so an entry with no URL
  is compared as the default registry's tarball for its name and version
  (the scope pin or default registry in `.npmrc` if there is one): an entry
  that gains a URL on another host, or on another package's tarball, is a
  finding. pnpm does not record which registry served a resolution, so a
  registry configured somewhere dep-guard cannot see (a user-level
  `~/.npmrc`, an environment variable) is not known to it. A transitive
  `npm:` alias needs no special handling: pnpm's `packages` map is already
  keyed by registry identity, not by whatever name a dependent's own alias
  used to reach it.
- A registry tarball that is not the package its entry names. For every
  added or changed npm or pnpm entry resolved from a trusted registry host
  (the public registries and every host the project `.npmrc` names), the
  package the tarball path names has to be the package the entry is for,
  whether or not the version moved: `ws` bumped to a new version and
  resolved to another package's tarball on `registry.npmjs.org` is
  `tarball-name-mismatch:<package>`, critical. A manifest-declared `npm:`
  alias, an alias the entry already had before a bump, and a newly added
  transitive alias npm records with both a matching `name` field and an
  `npm:` alias edge in a dependent's entry are not mismatches; that alias
  target is then name-checked. The
  same package at another version in the tarball file name is
  `tarball-version-mismatch` (high), and a URL on a trusted host whose path
  has no tarball shape is `unparseable-tarball:<host>` (medium). A registry
  mounted below a path is read past that path when `.npmrc` names it.
- More than one lockfile in one directory -- every npm and pnpm lockfile
  present is checked (`npm-shrinkwrap.json`, `package-lock.json`,
  `pnpm-lock.yaml`), at the root and below it, and a `multiple-lockfiles`
  diagnostic names them. Which one an install
  honours depends on the package manager in use, so a clean file never
  stands in for a tampered one. The run summary names the first lockfile
  dep-guard reads. A `yarn.lock` or `bun.lock` beside them is not parsed;
  on a run that is not refused for it (unchanged, acknowledged, or with no
  comparison side) the `lockfile-unread-sibling` diagnostic names it.
- No symlinked lockfile or manifest is parsed. On every side of a scan (the
  index, a ref, the trust base, the working tree), a root lockfile dep-guard
  parses, the root `package.json`, or a workspace member's `package.json`
  that is a symlink is not read. A git side decides from the file mode, the
  working tree with `lstat`; the link is never followed. On the side being
  judged (the index under `--staged`, the working tree otherwise) the run is
  exit 2 (`symlinked-input`) with a message naming the path: replace the
  link with a regular file. On a comparison side (HEAD, the `--base` ref,
  the trust base) the file is treated as absent there and the
  `symlinked-input-comparison-side` diagnostic names it, so the pull request
  that replaces the link is judged as adding a new file and passes when
  that file is clean. In that pull request the checks that compare a lockfile
  entry with its earlier resolution have no earlier resolution to compare
  against for that file, so the note is printed and the lockfile in that pull
  request should be reviewed by a person.
- The lockfile downgrade rule. When the base side has a lockfile dep-guard
  reads with at least one entry, the head side may not (a) carry a root
  lockfile dep-guard does not read (a v1 npm file, yarn, bun, a binary
  lockfile, or a lockfile name that is not a regular file, such as a
  symlinked `yarn.lock`, which always counts as changed) whose bytes differ from the base, a new file
  included, nor (b) lose every read lockfile with
  entries while a manifest still declares a dependency a lockfile would
  record, deleting the only lockfile included. An npm lockfile dep-guard
  read on the base side may also never become one it does not read. A
  violation is exit 2 (`lockfile-downgrade`), never a finding. Identity is
  the git blob id, so a binary file changed in one byte still differs. For a
  genuine migration: add the entries the error message prints to
  `acknowledgedLockfiles` on the base branch first (see
  [Configuration](configuration.md));
  or review the new lockfile by hand and merge with an admin override of
  the failing check; or relax the gate on the base branch in a separate,
  reviewed pull request (under conductor, `enforce: false` on the
  dependencies gate in `.guardrails.yaml`; for the standalone action,
  `continue-on-error` on the workflow step) and restore it afterwards. The
  migration pull request cannot clear the rule for itself, and an advisory
  mode does not help, because this is a could-not-run, not a finding.
- Lockfiles below the repository root. npm and pnpm lockfiles are read
  at any depth. A lockfile-tamper finding's `lockfilePath` is the file
  whose entry changed; an install-script finding's is the scan's primary
  lockfile, which in a repository with lockfiles in several directories can
  be a different file. A finding for a declared dependency names a
  manifest that declares it, which can be a manifest in another directory
  that has no lockfile of its own. `package.json` and the Python files
  listed under [Ecosystem coverage](ecosystem-coverage.md) are read at any depth too; what
  is checked for a Python name is in that table. A
  `pyproject.toml` that only holds `[tool.*]` config has no dependencies;
  that file alone does not make the scan a could-not-run when another
  manifest or lockfile resolved. `pyproject.toml` is parsed as TOML, and
  dependencies come from `project.dependencies`,
  `project.optional-dependencies`, `[tool.poetry.dependencies]` and the
  poetry group tables; a poetry `git` or `url` table is judged as a git or
  url source. A file that does not parse stops the scan and names the
  path, unless it is a stray that `ignorePaths` on the base covers (see
  below for which manifests are projects), in which case it is skipped
  with a note. Paths git ignores are not scanned. A directory
  named `node_modules`, `.venv`, `venv`, `dist`, `build`, `vendor` or
  `vendored` drops a manifest under it from the scan, and says so in
  `manifest-skipped-dirname`, unless it is a workspace member, a manifest
  with an npm-family lockfile (npm, pnpm, yarn, bun) in the same
  directory, a member that install root's own workspace patterns name, or
  the target of a `file:`, `link:` or `portal:` dependency or an npm
  lockfile link; those, and any npm-family lockfile on such a path, are
  scanned (their dependencies are read). A Python lockfile under such a
  name is not read. A manifest under such a name that is a project
  only through a Python lockfile beside it (`build/x/pyproject.toml` beside
  `build/x/uv.lock`), or as a uv workspace member, is not scanned: it is
  parsed only to decide whether it stops the scan, its dependencies are
  not read, and the `manifest-skipped-dirname` note says so. Under
  `node_modules` only lockfiles are read. Every other `package.json` git tracks
  is read, test fixtures and templates included, so a fixture cannot hide
  a dependency; an `ignorePaths` entry on the base branch is how one is
  dropped. A manifest that does not parse stops the scan and names the
  path. The one way to clear a broken fixture is an `ignorePaths` entry on
  the base branch, which skips it with a `manifest-unparsed` note, and that
  works only for a stray. The root `package.json`, a workspace member, a
  manifest with a lockfile beside it (npm, pnpm, yarn, bun, `uv.lock`,
  `poetry.lock`, `pdm.lock`, `Pipfile.lock`), one named by such a
  directory's workspace patterns or by a uv workspace's `members`, and the
  target of a `file:`, `link:` or `portal:` dependency or of an npm
  lockfile link are projects, and stop the scan whatever `ignorePaths`
  says. There is no default skip for a file that is not JSON, because bun
  installs from some files that are not. A broken manifest on the base
  branch with no entry stops every pull request against it until the base
  is fixed. Every manifest that stops the scan is listed in one error, ten
  at most, with its side and the reason, for example:

      dep-guard: 2 manifests do not parse and stop the scan: packages/broken/package.json (judged side): not valid JSON; some package managers accept JSON with comments, trailing commas or text after the value, so this file may still install; a root workspace member is a project and stops the scan whatever ignorePaths says. | test/old/package.json (the --base ref "base"): not valid JSON; some package managers accept JSON with comments, trailing commas or text after the value, so this file may still install; fix the file on the base branch, or cover it with ignorePaths there. (manifest-parse)

  `dep-guard scan <path>` reads dependencies and lockfile entries under
  that directory and nothing above it. To decide which manifests under it
  are projects, it also reads the root `package.json` and
  `pnpm-workspace.yaml`, the manifests and workspace files beside every
  lockfile, every `package.json` and every npm lockfile in the repository,
  and reports nothing about them unless one cannot be read
  (`classification-input-unread`); a lockfile in an ancestor directory is named in
  `lockfile-outside-prefix` and not applied, so a full gate is a scan of
  the repository root. Reported paths stay relative to the git root, and
  config and the baseline are still read from the git root. Lockfile
  coverage is judged per directory: a nested npm lockfile does not make a
  root `yarn.lock` edit a downgrade, and deleting a nested lockfile whose
  manifest still declares dependencies is one even when a root lockfile
  remains; a nested lockfile present on the base and gone in the change
  is named in `lockfile-nested-removed`. A lockfile this tool does not
  read (yarn, bun, a v1 npm file) below the root is still not judged: one
  whose bytes differ from the base is named in `lockfile-nested-changed`.
  A path covered by `ignorePaths` (read from the base on a pull-request
  run) drops findings under that path, and an unread lockfile there is
  noted as `lockfile-nested-ignored` instead. `lockfile-not-read` names
  every lockfile this tool does not read. Requirements files and the
  `-r` and `-c` lines in them are read as
  [Ecosystem coverage](ecosystem-coverage.md)
  describes. `--staged`, `--base` and `--trust-base` compare each manifest
  with the same path on the other side.
- Workspace patterns -- a `workspaces` list in `package.json` is resolved
  the way npm's own workspace mapper resolves it, checked against npm
  10.9.8: patterns in order, a run of leading `!` negating when odd, one
  leading `./` or `/` stripped, a later pattern cancelling an earlier
  exclusion it matches, `*` in any segment and `**` at any depth, a
  wildcard not matching a name that starts with `.`, and a backslash read
  as a separator. The patterns in `pnpm-workspace.yaml` are resolved with
  the same rules. When the repository's `core.ignorecase` is true, a
  staged scan and the `--base` and trust-base refs match pattern segments
  against directory names without regard to case, as npm does on a
  case-insensitive file system. A pattern with a `..` segment or a drive
  letter, or one that uses other glob syntax (`?`, `[...]`, `{...}`,
  extglob groups) is exit 2 (`workspace-glob-unexpandable`), with a message
  saying how to rewrite it; so is a `**` walk deeper than 32 directories,
  cleared by listing the directories. That refusal is for the side being
  judged; on a comparison side such a pattern names no workspace packages
  there and is named in `workspace-pattern-unread-comparison-side`, so the
  pull request that rewrites it is judged in full and passes when it is
  clean. In that pull request the checks that compare a lockfile
  entry with its earlier resolution have no earlier resolution to compare
  against for that file, so the note is printed and the lockfile in that pull
  request should be reviewed by a person. An exclusion that cannot be applied
  exactly is not applied, which only ever widens the scan. Patterns reach
  test fixtures and examples that are workspace members, and their findings
  are reported like any other; an `ignorePaths` entry on the base branch
  clears them.
- `yarn.lock`, `bun.lock` -- manifest-level checks only. Neither records
  install scripts, and yarn berry records no resolved URL. A transitive
  alias in either format is therefore invisible the same way every other
  transitive fact is: no lockfile entry is read at all for it, so nothing
  is ever sent to an online check under the wrong name.
- `bun.lockb` -- skipped. Undocumented binary format.
