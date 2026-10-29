# Changelog

Notable changes to dep-guard. Format based on
[Keep a Changelog](https://keepachangelog.com/). What a version number
promises is in `docs/release/stability-policy.md`; this file records what
each release actually changed.

This file starts at 0.6.0. Releases before it are described by their
GitHub release notes, which are generated from the commit history.

## [Unreleased]

Fixes from the 2026-10-28 cohesion audit. Each one can turn a green audit,
commit or pull request red; none loosens a verdict except the same-scope
typosquat change, which drops a low.

### Fixed

- **0.17.0 overstated what it closed.** Its entry above says every added
  lockfile entry "no manifest declares" is judged, and that a "declared"
  one is left out because the manifest walk judges it. "Declared" meant
  that some manifest line anywhere carried the entry's name, whatever its
  protocol and whether ignorePaths dropped that manifest's findings. Two
  reproduced bypasses installed a known-malicious package with real
  `npm ci` and exited 0, through conductor's `--trust-base` run too:
  - a `file:` (or `link:`, `workspace:`, git) dependency named after the
    package, beside a registry entry of that name nested under another
    package (`node_modules/ms/node_modules/<name>`). No name check reads a
    `file:` line, so nothing judged the registry entry. An npm workspace
    package of the same name exempted it the same way;
  - a stray manifest covered by ignorePaths declaring the name, whether
    added in the change or already on the base. That line exempted the
    entry, and the only finding left was the manifest's own, which
    ignorePaths dropped (or none, when the line was already on the base).
  An independent review of a narrower fix found three more shapes of the
  same hole: an ignored fixture already on the base made a project by one
  `file:` line, a local `file:` package switched to a registry spec of the
  same name, and a base line in a stray npm never installs from. The rule
  is now simple: **no manifest line exempts a lockfile entry.** Every added
  npm or pnpm lockfile entry that installs from a registry is name-checked
  by the name it installs, anchored on its lockfile, whatever any manifest
  declares. A changed entry is checked for a name it did not install
  before (its `name` field moved); its key, which npm installed there on
  the base already, is not re-checked. Where a manifest finding and a
  lockfile finding name the same package under the same rule, they are
  reported as one finding with both anchors, after ignorePaths and after
  the baseline, so a manifest finding either one drops never takes the
  lockfile's with it. The merged finding names the lockfile finding's
  fingerprint as `details.lockfileFingerprint`: to baseline such a name,
  baseline both fingerprints. Behaviour change: the lock entries an ignored
  project installs are now judged on their own, anchored on the lockfile;
  the project's own manifest findings stay the adopter's standing choice.
  Also on the manifest side: a line whose protocol moves into registry or
  alias (from `file:`, `link:`, `workspace:`, git or url) is judged as a
  new registry line, and every line of a manifest this change makes a
  project, that was read but was not a project on the base, is judged as
  new.
- **An npm entry's `name` field is now name-checked.** An entry with a
  `name` field and no `resolved` installs the package that field names, by
  name and version, and only the key was checked: `node_modules/supports-color`
  with `"name": "crossenv"` installed crossenv and scanned clean. The field
  is checked in addition to the key (instead of it when an `npm:` alias
  edge or an alias declaration asks for it), on an added entry and on a
  changed one whose field moved. It is still never the entry's identity.
  An unresolved entry (no `resolved`, an empty one, or one this scan
  cannot parse; npm treats an empty one as absent) whose field differs
  from its key with no alias edge or declaration asking for it is also a
  medium lockfile-tamper finding (`name-field-unvouched:<name>`). pnpm
  takes the installed name from the key, not from a `name` field (checked
  with real pnpm by the review), so this applies to npm only; that pnpm
  did take the version from the entry's `version` field over the key's. The `npm-lockfile-unverifiable-name`
  note no longer says the field is ignored. A resolved URL that names
  another package was already a critical tarball-identity finding,
  declared or not; that is now pinned by a test.
- `workspace-link-unconfirmed` said an unconfirmed name "is name-checked
  like any registry dependency", which was false for a `file:` line of
  that name. It now says the name is not treated as a workspace package,
  so a registry dependency or registry lock entry of it is name-checked.
- A lockfile-anchored finding printed its path twice in text output
  ("(package-lock.json, package-lock.json)"). It prints it once.
- A typosquat low on a published name under the same npm scope as the
  name it resembles is dropped: only the scope's owner can publish there,
  so `@unocss/preset-wind4` beside `@unocss/preset-wind3` is a sibling. An
  unpublished same-scope name is still reported.

### Changed

- Development dependency fast-uri 3.1.9 (transitive, dev only), closing
  four Dependabot alerts.
- Documentation: the Action input list names `base`; publish age is one of
  five online checks (four others, not three); the npm page says which
  exit 2 still prints a report; action.yml points at
  docs/pull-request-mode.md; docs/ecosystem-coverage.md records typosquat
  lows on real transitive packages (`flru`, `markdown-title`, `millify` on
  vitest) as a known false-positive class.

## [0.17.0] - 2026-10-28

Fixes from the 2026-10-27 cohesion audit. Each one can turn a green audit,
commit or pull request red; none loosens a verdict.

### Fixed

- A local dependency whose target sits under a `node_modules` directory was
  never read: `"helper": "file:tools/node_modules/helper"`, whose
  `package.json` declares a known-malicious name, scanned clean in every
  mode (`--base --trust-base` included) while npm 11 installs that name at
  the root. The same held for `link:` and `portal:` targets, an npm
  lockfile `"link": true` entry, and a `file:` target reached through a
  symlinked directory. A target that a `file:`, `link:` or `portal:`
  specifier or an npm lockfile link names explicitly is now read, and is a
  project, wherever it sits: one that does not parse stops the scan, as
  for any local target. Its own local dependencies are followed in turn.
  A target that cannot be placed inside the repository stands in for
  every `package.json`, now including those under `node_modules`; so does
  a target that matches no listed manifest. A target spelled in another
  case (`file:tools/NODE_MODULES/helper`, `file:Build/helper`), which npm
  installs on a case-insensitive file system, is matched to its listed
  path without regard to case. A repository that commits `node_modules`
  may see new low findings: a fail-closed stand-in reads every committed
  `node_modules` manifest (one review tree of 95 such manifests gave 12
  lows). A committed `node_modules` package nothing names is still not
  read; with no lockfile at all, npm installs the dependencies such a
  package declares and dep-guard does not read them, which is recorded as
  an open limit. The ruling this rested on, that nothing is installed from
  inside `node_modules`, was false and is withdrawn (`docs/INVARIANTS.md`).
- `workspace-link-unconfirmed` said `no package.json named "x" was found
  at <dir>` for a target that was in the tree and simply not read. It now
  says `this scan read no package.json named "x" at <dir>`.
- `--staged` disagreed with `--base` for a workspace member that is a
  symlink into a `node_modules` directory (`packages/a -> ../node_modules/evil`):
  the pull-request scan caught the member's names and the commit hook
  passed it. Both now read it, so the hook's verdict predicts the gate's.
- An added npm or pnpm lockfile entry that no manifest declares was never
  name-checked: a new `node_modules/<known-malicious name>` entry passed
  with only `delta-new-lock-entries`. Every added entry no manifest
  declares that installs from a registry is now judged by unknown-package
  and typosquat, anchored on its lockfile, as Python lockfile names
  already were. A changed entry, a declared one, an accepted transitive
  alias (its target is judged instead), and a git, file or directory
  resolution are not. An npm or pnpm entry whose version is a registry
  tarball URL is judged like any other. With `--online`, registered-squat
  judges these names too, except from a lockfile that is wholly new in the
  change (or on a run with no comparison side), so a fresh lockfile does
  not spend the online budget. An unknown entry npm marks `inBundle` is
  worded as shipped inside its parent's tarball, not as possibly
  hallucinated. Offline, a transitive name published after the corpus was
  built is now an unknown-package high, as a declared one always was. On the public bench with the shipped corpus this added
  five low typosquat findings (four in vitejs/vite, one in sveltejs/kit),
  all on transitive names that resemble a popular one, and no
  unknown-package finding. An audit run scans every entry as added, so
  expect more low typosquat findings there than on a pull request.

## [0.16.1] - 2026-10-19

Fixes found by running dep-guard against public repositories. No verdict
is loosened beyond what each entry states.

### Fixed

- A Python git requirement pinned by a full commit id in pip's and uv's own
  form, `name @ git+https://host/o/r.git@<40 or 64 hex>` (or a requirements
  line `git+https://host/o/r.git@<sha>#egg=name`), was read as unpinned and
  reported `critical` with `commitPinned: false` even with no earlier
  revision to compare against. The ref after the last `@` of the URL path
  now counts, under the same full-object-id rule as the `#<sha>` form. An
  `@` in userinfo, a short SHA, a branch, a tag, any other length, an hg,
  svn or bzr URL, and the scp-like form are still unpinned. The `@` form is
  read for Python dependencies only.
- A Python git URL the user wrote with the commit id in the fragment,
  `name @ git+https://host/o/r.git#<sha>` (in a requirements file or a
  `pyproject.toml` requirement list), was credited as a commit pin and
  reported at `low`. pip ignores a fragment that is not `egg=` or
  `subdirectory=` and installs the default branch, so it is now unpinned
  and `critical`. Which reading applies follows where the specifier came
  from, not its shape: a URL the user wrote is read in pip's `@<ref>` form
  only, and a poetry, `[tool.uv.sources]` or `Pipfile` git table pins by
  its own commit key alone (`rev`, or `ref` in a `Pipfile`) when that is a
  full commit id. A `#<sha>` or `@<sha>` written inside the table's `git`
  value, which was credited as a pin before, and a `tag` or `branch` key,
  however hex it looks, no longer pin. Nor does a full-sha `rev` or `ref`
  when the table's `git` value contains a `#` anywhere or an `@` in its
  path (a `git@host` userinfo is fine): the installer appends the ref to
  that value, so pip would read fragment text or a different ref and
  install something else. A poetry or uv `rev` beside a `branch` or `tag`
  key does not pin either (poetry installs the branch or tag). A dependency
  with several git items or `[tool.uv.sources]` entries, one per marker, is
  pinned only when every one of them is; otherwise it is reported unpinned,
  whichever item comes first. With `--base` or `--trust-base`, a Python git
  dependency whose specifier text held but whose pin provenance changed (a
  `rev` rewritten as a `branch` of the same text, or a table rewritten as a
  pip-grammar URL of the same text) was skipped as unchanged; it is now
  judged as a change. This can turn a green audit or pull request red.
- One git dependency declared twice in the same manifest, one declaration
  pinned and one on a branch (two requirements lines with different
  markers, a `[project].dependencies` item and an optional extra, a poetry
  main dependency and a dev group), was reported by whichever came first:
  pinned first read `low` with `commitPinned: true`, the same file with the
  lines swapped read `critical`. The worse of the two is now kept whatever
  the order: the higher severity, and at equal severity the one not
  credited as a commit pin. Both declarations pinned still read `low`.
- An editable URL in a `pyproject.toml` requirement list (`"-e
  git+https://..."`, as PDM dev groups write) kept everything after it as
  part of the URL, so trailing text such as ` x@<sha>` could make a URL
  that installs a branch read as pinned. The URL now ends at the first
  whitespace or `;`, as PDM and the requirement classifier read it.
- The same Python finding named an unrelated npm lockfile as its
  `lockfilePath` (whichever npm or pnpm lockfile the scan read first). A
  Python dependency's git-source and url-source findings now carry no
  `lockfilePath`.
- A `pnpm-lock.yaml` with a bare `packages:` (null) was a `lockfile-parse`
  exit 2 even when every dependency it records is a `link:`, which has no
  packages entry. That lockfile now reads as empty. A null `packages` with
  any other dependency recorded is still refused.
- Only the first lockfile that did not parse was reported; fixing it
  revealed the next. Every one on the scanned side is now listed in one
  `lockfile-parse` error, up to ten, the way the manifest-parse error lists
  manifests. A single failure keeps its message unchanged. The exit code is
  still 2.
- The `trust-base-same-tree` refusal said a pull request's merge ref "looks
  exactly like this when the base has not moved", which reads as though
  every pull request does. It now names the two cases: the head commit
  against its own merge when the base has not moved, and the base branch
  against a pull request with no net change.
- The `names:` line printed `pypi 0 not checked for existence` (or `pypi 0
  of 0 checked`) when a Python manifest had no names to look up. It now
  reads `pypi 0 checked (no PyPI names to check)`.
- The README said a head-side change to a uv workspace root's `members` is
  reported as `python index changed`. It is not: the base copy's members
  decide the scope of each `[tool.uv.sources]` entry, and a name that only
  the head's wider members bring into that scope is checked like any other,
  with `python-workspace-unconfirmed`. The README now says so.

## [0.16.0] - 2026-10-19

Targets 0.16.0, a minor: both changes below can turn a green run red,
which the stability policy files under verdicts that may move in a minor.
Design: `docs/design/2026-10-18-head-defined-projects-and-ignore-paths.md`.

### Security

- **A pull request could wire a directory the base ignores into the
  install, and the base's `ignorePaths` dropped every finding there, exit
  0.** The wiring could be a `file:`, `link:` or `portal:` dependency or a
  bare local path (`"./fixtures/helper"`), a dependency on a directory
  reached through a committed symlink (including a link whose text climbs
  out of another symlinked directory with `..`, which is resolved the way
  the operating system resolves it), a workspace member reached through a
  symlinked directory (a link a pattern names, or one a pattern passes
  through, as in `packages/*` where `packages` is itself a link, including
  links nested under it), a reference from a stray manifest
  that the change itself wires in (references are transitive: a stray's
  reference the base already had does not excuse the manifest it reaches
  once the change installs the stray), a widened `workspaces` glob, a
  lockfile added beside the manifest, a requirements include (`-r` or
  `-c`), or a stray manifest that re-anchored a root-lockfile finding by
  declaring the same name. The run even said "no control input changed in
  this pull request". A target this tool cannot place inside the
  repository (an absolute or home path, a relative path that leaves the
  root, a symlink that does either) now fails closed: every ignored
  manifest of that kind keeps its findings unless the base has the same
  specifier in the same file, through symlinks with the same target text.
  Now `ignorePaths` drops a
  finding only when its path is not a project on the changed tree, or when
  every reason it is a project is also a reason on the reference side (the
  trust base on a `--trust-base` run, else the `--base` ref, else `HEAD`
  for `--staged`). Everything else is kept, counted in the new `ignoreKept`,
  marked `ignoreOverride` on the finding, reported as an
  `ignore-path-project-kept` note and, under `--trust-base`, proposed as a
  change to `ignorePaths` (`trustBase.projectPathsChanged`,
  `trustBase.ignoredPathsMadeProjects`). A changed yarn, bun or v1 npm
  lockfile below the root is excused by `ignorePaths` on the same terms, not
  counting the reason that lockfile itself gives.

  Consumer costs, stated plainly:
  - A green pull request, `--base` run or staged commit that wires an
    ignored path into the install and has findings there now exits 1.
  - `lockfile-tamper` findings on a project the reference side installs
    under an ignored path are no longer dropped, as `allow` never covers
    that rule. This includes an `ignorePaths` entry naming a lockfile
    itself (`"package-lock.json"`), and a fixture directory holding a
    `package.json` beside its own lockfile.

  Remedy: move the directory out of the ignored path, or out of the
  install; or accept the finding with `allow` or the baseline. Either
  control has to land on the base branch in a separate change first,
  since a pull request's own control edits are proposals.

  Residual, named: a project the base branch already installs under an
  ignored path, the same way, keeps every finding other than
  `lockfile-tamper` dropped. Both the wiring and the entry are base-written,
  so this is the adopter's standing choice; any pull request can add a
  malicious dependency inside such a directory and exit 0, with only the
  `ignore-path-dropped` note, which now says how many dropped findings were
  on installed projects.

  Known open: a target that differs from the directory only in case
  (`file:Fixtures/helper` on a case-insensitive macOS or Windows runner) is
  not matched to it; a yarn `patch:` specifier wrapping a `file:` target is
  not a reason; and `ignoreKept` counts a kept finding the baseline then
  suppresses.

  Symlinked workspace directories, stated plainly: a symlink a workspace
  pattern names or passes through is followed inside the repository, and
  each manifest under the directory it reaches is a member exactly when the
  pattern covers its path through the link, the way npm, pnpm and uv expand
  it. The reason carries that path, the pattern and every link text on the
  way, so a widened pattern, a retargeted link or a nested link pointed
  elsewhere keeps the findings, and a repository whose links and patterns
  did not change is excused as before. A link to a file, or to a path with
  nothing listed under it, is not a member directory and says nothing. A
  link that cannot be placed (it leaves the repository, is absolute, cannot
  be read, runs past 40 hops, or loops back to a directory already on its
  own chain) fails closed: every ignored manifest of that kind keeps its
  findings unless the base has the same link texts and the same workspace
  patterns. The note says the symlink could not be followed, or for a loop
  that following it loops back into a directory already on its path. A
  symlink whose text cannot be read is never excused. The links under one
  workspace input are walked at most 10,000 times; an input whose links fan
  out past that limit fails closed in a way no base can excuse, so every
  ignored manifest of that kind keeps its findings, and the note says the
  symlinks under that input's link fan out past the limit. Only a
  pathological link graph reaches it. The walks of every input on one side
  together stop at 100,000 visits the same way, so a tree with many fanning
  install roots cannot make the scan run without bound; the note then says
  the symlink walks on that side ran past the limit in all.

  Every one of those fail-closed cases, and an unplaceable `file:` target,
  npm lockfile link entry or requirements include, also reads every
  manifest of that kind past the skipped-directory-name filter (a uv
  workspace member, which is never read for names, excepted): a member
  under `build/` or `vendor/` the tool could not place is read for names
  instead of being skipped with a `manifest-skipped-dirname` note.
  Consumer cost: on a side with such a link or target, a manifest under a
  skipped directory name that does not parse now stops the scan (exit 2)
  unless ignorePaths covers it; before, it was not read.

- **A scan of a subdirectory dropped a manifest under `build/` while saying
  every manifest there was treated as a project, exit 0.** Present since
  0.15.0. When a file outside the scanned directory that decides which
  manifests are projects could not be read (a broken root
  `pnpm-workspace.yaml` or `package-lock.json`, for example), the
  `classification-input-unread` note said every manifest under the scanned
  directory was treated as a project, but a manifest there under a skipped
  directory name (`app/build/a/package.json` on a scan of `app`) was still
  skipped with a `manifest-skipped-dirname` note, so a malicious name in it
  passed, in staged, audit and `--base` runs alike. A scan of the root
  stops on the same tree. Now, while that note is raised, every manifest
  under the scanned directory outside `node_modules` is read for names.
  Consumer cost: on such a scan, a manifest under a skipped directory name
  that does not parse stops the scan (exit 2) whatever ignorePaths says,
  as any other manifest under the scanned directory already did; before,
  it was not read.

- **A pull request whose names outran the online budget, or met a registry
  outage, passed with only a diagnostic.** For a Python name the PyPI
  lookup is the only existence check, so this was a silent pass. Now, on a
  run with `--base` or `--trust-base` and online lookups on, a candidate
  name an online step left unchecked (the budget was spent, or the npm or
  PyPI client counted the answer as unreachable: a network error, a timeout,
  a 5xx after the retry, a 429, any other 4xx except 404, and on PyPI a 3xx
  or a 2xx naming another project) makes the run exit 2 with the full
  report: `run.online.unchecked` lists every name with its step, reason and
  status, `run.couldNotRun` carries `online-names-unchecked`, the text
  report and stderr print the names, and SARIF marks the invocation
  `executionSuccessful: false` with one error notification. A name the
  `allow` list clears, a confirmed workspace sibling, an internal name, and
  a name from a private registry or index are never counted. When the base
  config says `"online": true` and the command line turns online off
  (`--no-online`, which the Action passes unless its `online` input is
  true), every candidate counts as unchecked with the reason
  `online-disabled`. Plain and audit runs are unchanged: diagnostics only.
  The new `onlineUnchecked` config key (`"fail"`, the default, or `"note"`)
  restores the diagnostic in pull-request mode; under `--trust-base` it is
  read from the trust base, and a head change to it is a proposal.

  Consumer costs, stated plainly:
  - A pull request with more new names than the online budget covers, or
    run during a registry outage, now exits 2.
  - A run with online disabled on the command line, including the Action's
    default, exits 2 when the base config says `"online": true`. Set the
    Action's `online` input to true, or set `"onlineUnchecked": "note"`.

  Remedies: raise `onlineBudgetMs` on the base branch, set
  `"onlineUnchecked": "note"` on the base branch (each in a separate change
  first), or split the change. Conductor reads any family gate's exit 2 as
  could-not-run and composes it to its own exit 2, so the umbrella run is
  red too whether or not the findings are read.

  Known open: a name declared only in an ignored stray fixture still counts
  as unchecked; and the `online-disabled` reason text says "the base
  config" on a `--base` run without `--trust-base`, where the config in
  effect governs.

### Fixed

- **Python: a requirements `-r` or `-c` include through a symlinked
  directory was not read for names.** Present since 0.13.0. The scan read
  the include by normalizing its text, so `-r sub/../deps.list` where `sub`
  is a symlink was looked for at the root, not beside the link's target,
  and on a git side (the index in a staged scan, a `--base` or
  `--trust-base` ref) `-r sub/deps.list` was not found at all, since a git
  side lists the file only at its real path. The include was reported
  unread (`requirements-line-unread`) and its names were never checked, so
  online a PyPI 404 there was never raised. The include is now placed the
  way the operating system opens it, through the side's own symlinks, and
  read at its real path. A file that is itself a symlink is still never
  read, although pip would read it (known open since 0.13.0).
- The `symlinked-input` message names the kind of file it refused (a
  lockfile, a `package.json`, a `pyproject.toml`, a `Pipfile` or a
  requirements file); it said "a lockfile or a package.json" for all of
  them.

### Added

- `ScanResult.ignoreKept`, `ScanResult.ignoreRuleApplied`, `trustBase.projectPathsChanged`,
  `trustBase.ignoredPathsMadeProjects`, `Finding.ignoreOverride`,
  `run.online.unchecked`, `run.couldNotRun`, and the SARIF
  `run.properties.ignoreKept` and `run.properties.onlineUnchecked`. All
  additive. `ScanResult.exitCode` widens to `0 | 1 | 2` for the one
  could-not-run that is reported with a result. The text summary line gains
  `N kept over ignorePaths` on every run that had a side to compare
  against (`ignoreRuleApplied`).

## [0.15.0] - 2026-10-17

No verdict is loosened. A manifest that does not parse still stops the scan
by default; `ignorePaths` on the base branch remains the way to clear a
broken test fixture. The default stays fatal because bun installs from
`package.json` files that are not JSON (comments, trailing commas, text
after the value), so "not JSON" does not mean "not installable". The
changes below can only add an exit 2, which can turn a green run red.

### What can newly stop a scan (exit 2), and how to clear each

- A `pyproject.toml`, `Pipfile` or `uv.toml` that does not parse, beside
  `uv.lock`, `poetry.lock`, `pdm.lock`, `Pipfile.lock` or an npm-family
  lockfile, or named by a uv workspace's `members`, now stops the scan
  whatever `ignorePaths` says, as a `package.json` beside its lockfile
  already did. 0.14.0 dropped it when `ignorePaths` covered it. Fix the
  file.
- A `pyproject.toml` (or `Pipfile`, `uv.toml`) under a skipped directory
  name beside a Python lockfile, such as `vendor/x/pyproject.toml` beside
  `vendor/x/uv.lock`, was never parsed before: only an npm-family lockfile
  promoted the manifest beside it past the skipped-directory filter. It is
  now parsed, and stops the scan when it does not parse, with no
  `ignorePaths` entry involved. Its dependencies are still not read. Fix
  the file.
- A `package.json` that is the target of a `file:`, `link:` or `portal:`
  dependency, or of a link entry in an npm lockfile, now stops the scan
  when it does not parse, whatever `ignorePaths` says. Fix the file.
- On `dep-guard scan <path>`, a manifest under the path that does not parse
  is fatal or dropped exactly as on a scan of the repository root: a root
  workspace member, a member of an install root above the path, or a
  reference target under the path that `ignorePaths` covers now stops the
  scan. When a file outside the path that decides this cannot be read,
  every manifest under the path that does not parse stops the scan, and
  `classification-input-unread` names the file. Fix the file it names.
- A pull request that removes a manifest from the base's workspaces,
  lockfile directory or references and breaks it in the same change stops
  the scan. Fix the file.

### Changed

- Every manifest that stops the scan, on every side, is listed in one
  error (ten at most, then a count), with the side and the reason, instead
  of the first one only. The exit code is unchanged. A manifest that does
  not parse no longer hides a later one, and a broken file on the base no
  longer hides one on the pull request.
- A `manifest-parse` message no longer prints a dependency key in full; it
  prints the key's leading name characters.
- An `ignorePaths` entry whose only effect is skipping a manifest that does
  not parse is no longer reported as `ignore-path-unmatched`.
- A manifest under a skipped directory name that is a project only through
  a Python lockfile beside it, or as a uv workspace member, now gets a
  `manifest-skipped-dirname` note saying it was parsed only to decide
  whether it stops the scan, instead of one saying no lockfile sits beside
  it.
- `dep-guard scan <path>` now reads a root workspace member under the path
  whose path has a skipped directory name (`build`, `vendor` and the rest),
  as a scan of the repository root does. This can add findings.
- The target of a `file:`, `link:` or `portal:` dependency, and of an npm
  lockfile link entry, is read whatever directory names are on its path,
  like a workspace member. This can add findings.

### Added

- `run.ecosystems.npm.notParsed` and `run.ecosystems.pypi.notParsed` count
  manifests dropped because `ignorePaths` covers them. Both are always
  present in the JSON output and are required fields of the exported
  `NpmEcosystemSummary` and `PypiEcosystemSummary` interfaces, so code that
  builds those objects by hand must now include them.
- `classification-input-unread`, a note on a subdirectory scan only.
- Dogfood bench: a row may carry a `config` object (`ignorePaths` only)
  with a required `configNote` saying the upstream repository does not
  carry it; the baseline records it as `configApplied`. A clone that
  already carries `.dep-guard.json` or `.dep-guard.local.json` is refused,
  and a `--compare` run reports drift when the row's config and the
  baseline's `configApplied` differ.
- Dogfood bench: eslint is measured through such a row (its two broken
  fixture directories) and is no longer skipped. npm/cli stays skipped, now
  as `lockfile-parse`: it also carries a deliberately broken fixture
  `package-lock.json`, which the first broken manifest used to hide and
  which no `ignorePaths` entry clears. The public baseline is re-recorded;
  no other row's counts moved.

## [0.14.0] - 2026-10-17

Reporting and wording. Nothing here changes an exit code or a severity, with
named exceptions. The install-script collapse under Changed keeps the
severity and the exit and changes only the finding count. The typosquat
length floor under Changed can change an exit in one case: with `failOn` set
to `low`, a resemblance finding against a target shorter than three
characters (every resemblance finding is low) is no longer raised. The fix
under Fixed turns an exit 2 into a completed scan only where `ignorePaths`
already covers the file.

### Fixed

- A stray `package.json` that does not parse, such as a deliberately broken
  test fixture, stopped the scan with exit 2 (`manifest-parse`) even when
  `ignorePaths` covered it. Present since 0.11.0, which began reading
  manifests in subdirectories; until now only a Python manifest could be
  cleared this way, although the README named `ignorePaths` as the way to
  drop any fixture manifest. An `ignorePaths` entry now clears it for every
  ecosystem: the file is skipped with a `manifest-unparsed` note and the
  scan goes on. The entry is read from the base on a `--trust-base` run, so
  a pull request cannot clear its own parse error by adding it. With no
  entry the default is unchanged: exit 2 naming the path. On a scan of the
  repository root, the root `package.json`, a workspace member and a
  `package.json` with a lockfile beside it still stop the scan when they do
  not parse, whatever `ignorePaths` says. Found by the public dogfood bench, where npm/cli and
  eslint both carry such a fixture.

### Added

- A `coverage:` block under the run summary: for each ecosystem the run saw
  (npm, Python, and Go when `go.mod` or `go.sum` is present), whether it was
  read, which checks ran, and which did not and why. Go is stated as not
  read ("go.mod and go.sum are not read by dep-guard"). The `names:` line is
  unchanged. `run.ecosystems` gains `npm.lockfile` (`read`, `not-read`,
  `missing` or `not-applicable`), `pypi.requirements` and `pypi.pinned`
  (named requirements, and how many are pinned exactly), and `go.files`.

### Changed

- `install-script`: when a change adds the npm lockfile, or replaces it with
  one sharing no entry with the comparison side, the packages that run an
  install script are reported as one high finding that names the count and
  the packages and points at `allow` as the remedy, instead of one high
  finding per package. The exit is 1 either way. The collapse happens after
  `ignorePaths` and the baseline have filtered the per-package findings, so
  both behave as they did before and an existing per-package baseline entry
  still clears its package; the collapsed finding's own fingerprint is
  derived from the sorted package set, so baselining it covers only the
  packages it listed. A package an `allow` entry clears is left out, a
  platform-restricted optional dependency such as `fsevents` stays in the
  list, and a single package keeps its own finding. Audit mode and pnpm
  lockfiles are unchanged. Clearing it: add the packages you reviewed to
  `allow`.
- The `coverage:` line qualifies what it claims: an audit scan lists
  `lockfile-tamper` as git-source and url-source signals only, and a pnpm
  lockfile lists `install-script` as `onlyBuiltDependencies` only.
- `lockfile-missing` (a note, never a finding) is printed only when the
  judged side has a `package.json` and no npm or pnpm lockfile. A Go
  repository with `go.sum`, and a Python manifest with every requirement
  pinned exactly, no longer get it; the coverage block says what is true of
  them instead. Its text now says "no npm or pnpm lockfile".
- In the text report of an audit scan, two or more of the repeated limits
  (`audit-no-tamper-comparison`, `pnpm-no-install-script-flag`,
  `pypi-names-not-checked`) print as one `audit-limits` note carrying every
  message. The JSON diagnostics are unchanged.
- Typosquat: a resemblance rule (every rule except the curated alias list),
  for npm and for Python, no longer matches a target shorter than three
  characters, so `cn` is not reported against `co`. A two-letter name absent
  from the corpus is still an unknown-package finding. This is the one exit
  change the floor can make: only under `failOn: low`, where a name such as
  `wss` is no longer reported against `ws`.
- The could-not-run message for a manifest on disk that resolved none now
  also says the installed dep-guard, with its version, may be out of date
  when a newer dep-guard reads the file's format.
- Dogfood bench: the counts vocabulary names every diagnostic code core and
  the CLI emit, and the `publish-age` rule, so new behaviour no longer
  collapses into `other`; a bench test fails when the source emits a code
  the vocabulary does not name.
- Dogfood bench: pallets/flask, pinned at a commit, is added so the Python
  surface has a baseline.
- Dogfood bench: the public baseline is re-recorded. It dated from
  2026-08-17 and matched 0.10.0; the rows for axios, vite, vuejs/core,
  prettier and jest move with 0.10.1's workspace resolver and 0.11.0's
  nested manifests. npm/cli and eslint are recorded as skipped
  (`manifest-parse`): the bench passes no per-repository config and each
  carries an unparseable fixture `package.json` that needs an `ignorePaths`
  entry the upstream repository does not have.
- Dogfood bench: a repository that cannot be scanned is recorded in the run
  and the baseline as skipped, with dep-guard's could-not-run code, instead
  of being left out, and `expectSkip` in `bench/repos.public.json` names a
  known skip. A `--compare` run reports drift when a repository without
  `expectSkip` fails to scan, when one with it scans or fails for another
  reason, and when a repository's skip state differs from the baseline's.

## [0.13.0] - 2026-10-17

Python dependency names are now checked. What can
newly block, and how to clear each:

- Findings (exit 1) from unknown-package, critical, for a Python name PyPI
  answers 404 for, on a run with `--online`. Names come from requirements
  files, `pyproject.toml`, `Pipfile`, `poetry.lock`, `uv.lock`, `pdm.lock`
  and `Pipfile.lock`, compared in PEP 503 normalised form. A name that only
  resolves from a private index is skipped when the manifest declares that
  index (on a `--trust-base` run, when the base declares it); a lockfile's
  own recorded source skips an entry only when it matches such a
  declaration. Otherwise list the name under `internalPrefixes` with an
  entry of the form `pypi:<prefix>`, or clear one finding with an `allow`
  entry of the form `pypi:<name>`. Bare `allow` and `internalPrefixes`
  entries stay npm-only.
- Findings (exit 1) from lockfile-tamper git-source and url-source for
  Python sources dep-guard did not read before: a git or url line in a
  requirements file it did not read (a `.txt` basename starting with
  `requirements` or ending in `requirements.txt`, a `.txt` file directly in
  a directory named `requirements`, `requirements.in`, and files reached by
  `-r` in any spelling pip accepts); a URL line with no `#egg=`; a git or
  path entry in a `Pipfile`; a `[tool.uv.sources]` git or url rewrite; and
  a `name @ git+` string in `build-system.requires`, `[dependency-groups]`,
  or the uv and pdm dev tables.
- Could-not-run (exit 2, `manifest-parse`) for a `Pipfile` that is not
  valid TOML, or that is valid TOML with a malformed `[[source]]` or a
  package entry that is neither a string nor a table; for a repository
  `uv.toml` that is not valid TOML or has a malformed index setting; and
  for a malformed `build-system.requires`, `[dependency-groups]`, uv or pdm
  dev table, `[tool.uv.sources]` entry, `[tool.uv.workspace]` table or
  package-index table in a `pyproject.toml`. Fix the file, or cover it with
  `ignorePaths` on the base branch.
- Could-not-run (exit 2, `symlinked-input`) for a newly read requirements
  file name (`requirements-dev.txt` and the rest above), a `Pipfile` or a
  `uv.toml` that is a symlink on the side being judged, as
  `requirements.txt` and `pyproject.toml` already were. Replace the link
  with a regular file; a comparison side or trust base that still holds the
  link does not block that pull request.
- Could-not-run (exit 2, `python-index-invalid`) on a `--trust-base` run
  when the base copy of a Python file the run reads (and so of its index
  declarations) is a gitlink or another non-file, or does not parse. A base
  copy that is a symlink does not stop the run: it contributes no index
  declarations, so every name in that file is looked up, and
  `python-index-unread-comparison-side` names it.

### Added

- Every run that reads a Python file prints a `names:` line saying, per
  ecosystem, how many new names were checked and how, and how many were
  read but not checked and why; the JSON result carries the same counts
  under `run.ecosystems`, always present. An offline run with Python names
  raises `pypi-names-not-checked`.
- Python typosquat at low, against the other Python names the same
  repository declares. No PyPI popularity list ships.
- New diagnostics: `pypi-names-not-checked`, `pypi-private-index-skipped`,
  `python-index-unread-comparison-side`, `python-lockfile-unreadable`,
  `python-name-invalid`, `python-workspace-unconfirmed`,
  `requirements-line-unread`. A PyPI outage gives one
  `online-check-unreachable` for the PyPI step, with the count and the first
  names, not one per name.

### Changed

- PyPI lookups share the one online budget and run second, after npm
  unknown-package resolution; names the budget did not reach are listed in
  `online-deadline-exceeded`. A PyPI outage or a spent budget never fails a
  run. `run.online` totals now include PyPI lookups.
- A bare path or archive file name in a requirements file is no longer read
  as a package name. A requirements line that is neither a dependency nor a
  recognised option is counted and named in `requirements-line-unread`
  instead of being dropped.
- A Python dependency re-cased or re-separated (`Flask` to `flask`,
  `python_dateutil` to `python-dateutil`) is the same dependency, not an
  added one.

### Security

- The release workflow now installs, builds, tests and packs in a job that
  has no npm publish token, then publishes the packed tarballs from a
  separate job that holds the token and does not install this repository's
  dependencies. The scope is the token only: the tarballs are still built
  where dependency install scripts run, so the split keeps those scripts
  away from the token and does not by itself guarantee the integrity of
  what was built.

## [0.12.0] - 2026-10-14

Fixes three gate bypasses an independent audit reproduced against 0.11.1.
What can newly block, and how to clear each:

- Findings (exit 1) from unknown-package and typosquat for a name that an
  npm `"link": true` lockfile entry used to exempt without proof. A link
  entry now makes a name workspace-local only when its lockfile is the npm
  lockfile its directory installs from (no other lockfile format beside it,
  or a `packageManager` field naming npm; a `package-lock.json` beside an
  `npm-shrinkwrap.json` never counts), its `resolved` path holds a
  `package.json` with exactly that name on the same side, and that path is a
  workspace member under the `workspaces` field of the `package.json` beside
  the lockfile. On a `--trust-base` run that field is read from the trust
  base wherever the base has that `package.json`, so a pull request cannot
  widen it to confirm its own link. The exemption applies only to manifests
  that lockfile covers. Before, a decoy
  `package-lock.json` holding one link line beside the `pnpm-lock.yaml` an
  install actually reads switched the name checks off for that name. A
  claim that is not confirmed is named in `workspace-link-unconfirmed`. A
  real npm workspace sibling is still exempt; if one is now reported, the
  note says which test it failed.
- Findings (exit 1) from lockfile-tamper when an added or changed npm or
  pnpm entry resolves to a tarball on a trusted registry host that is not
  the package the entry names: `tarball-name-mismatch:<package>` at
  critical, whether or not the version changed. Before, `ws` bumped to a
  new version and resolved to another package's tarball on
  `registry.npmjs.org` scanned clean. A manifest-declared npm alias, an
  alias that was already there before a bump, and a newly added transitive
  alias npm records with a matching `name` field and an `npm:` alias edge in
  a dependent's entry are not mismatches; the target of such an alias is
  name-checked like a declared dependency. A `name` field alone excuses
  nothing. Residual: a lockfile that writes both the field and the edge for
  a real, published package name is accepted, as a manifest `npm:` alias to
  that name would be. A `%2f`-encoded scope in a tarball path is decoded.
  Two related
  signals: `tarball-version-mismatch` (high) when the tarball file is the
  same package at another version, and `unparseable-tarball:<host>`
  (medium) when a URL on a trusted registry host has no tarball shape this
  tool can read. A registry mounted below a path is read past that path
  when the project `.npmrc` names it. Clear a true finding by regenerating
  the lockfile with the package manager.
- Findings (exit 1) from a manifest under a directory named `build`,
  `dist`, `vendor`, `vendored`, `venv` or `.venv` that has a lockfile in the
  same directory, and from every `package.json` that install root's own
  workspace patterns name (its `workspaces` field, or a
  `pnpm-workspace.yaml` beside the lockfile). That directory is an install
  root, so its manifest and its members are now read like any other.
  Before, its lockfile was read and its manifests dropped, so a
  `build/package.json` declaring a known-malicious name beside its own
  `build/package-lock.json`, or a `build/app` member of it, scanned clean
  with one note. `node_modules` is not promoted this way: nothing installs
  from inside it. A manifest with no lockfile beside it and no install root
  naming it is still not read, and
  `manifest-skipped-dirname` no longer claims a lockfile on its path would
  cover it. Clear a finding as any other, or list the directory in
  `ignorePaths` on the base.

Documentation: the README no longer says dep-guard answers over MCP. No MCP
server ships; `dep-guard check <name>` and the core library's `checkSingle`
are the propose-time surface. The README and the CLI README now say that
Python package names are read but not checked against any registry or
corpus. Two `docs/INVARIANTS.md` claims about which lockfile and which
manifest a finding names in a repository with several lockfiles were false
and are corrected; an install-script finding still names the primary
lockfile, which is recorded there as known open.

## [0.11.1] - 2026-10-07

Patch on both published packages. `@vaultcompass/dep-guard` and
`@vaultcompass/dep-guard-core` move from 0.11.0 to 0.11.1. The action's
`version` input default and the `DG_TAG_SCANNER` constant move with them, so
`vaultcompasshq/dep-guard@v0.11.1` installs `@vaultcompass/dep-guard@0.11.1`.
0.11.0 is deprecated on npm. What can newly block, and how to clear
each:

- Findings (exit 1) from a `package.json` a workspace pattern resolves
  whose path contains a directory named `build`, `dist`, `vendor`,
  `vendored`, `venv` or `.venv`, and from an npm or pnpm lockfile on such
  a path. 0.11.0 skipped both, so a dependency added there or a lockfile
  edited there scanned clean. 0.11.1 reads them. Clear a finding as any
  other; a stray manifest that no workspace pattern names is still not
  read, and the scan now says so in `manifest-skipped-dirname`.
- Findings (exit 1) from `pyproject.toml`. 0.11.0 read the first array
  after the text `dependencies` anywhere in `[project]`, so `dynamic` or a
  description could make it read `classifiers` or `keywords` as the
  dependency list and miss the real one. 0.11.1 parses the file as TOML
  and reads `project.dependencies`, `project.optional-dependencies` and
  the poetry tables. A poetry `git` or `url` table, and a `name[extra] @`
  URL requirement, are now judged as git or url sources.
- `lockfile-downgrade` (exit 2) when a lockfile below the root is deleted
  while a manifest it recorded still declares dependencies, even when a
  root lockfile remains. Clear it by acknowledging the removed bytes in
  `acknowledgedLockfiles` on the base, as the message prints.
- `manifest-parse` (exit 2) for a `pyproject.toml` that does not parse
  now names the path. Clear it by fixing the file, or
  by covering a file nothing installs from with `ignorePaths` on the base,
  which skips it with a note instead.

### Fixed

- A workspace member or a lockfile under a directory named `build`,
  `dist`, `vendor`, `vendored`, `venv` or `.venv` is read. Only a stray
  manifest no workspace pattern names is skipped there, and the skip is
  reported.
- `pyproject.toml` is parsed as TOML. A document that does not parse no
  longer stops the scan when `ignorePaths` on the comparison side covers
  it.
- Lockfile coverage is judged per directory. A root `yarn.lock` edit is no
  longer refused because a nested npm lockfile is read, and a root
  `package-lock.json` beside a changed root `yarn.lock` is still refused.
- A finding from a lockfile below the root names that lockfile, once, not
  the root lockfile beside it.
- An unread lockfile (yarn, bun, a v1 npm file) that changes beside a read
  lockfile in the same directory below the root is refused as a downgrade,
  the way a root one is.
- A poetry `[tool.poetry.dev-dependencies]` table is read, and a
  `name [extra] @ <url>` requirement with a space before the extras is a
  git or url source.
- A `pyproject.toml` or `requirements.txt` under `ignorePaths` that parses
  is still read; only one that does not parse is skipped with a note.

### Changed

- `dep-guard scan <path>` reads that directory and nothing above it, so a
  lockfile in an ancestor directory is not applied; the scan names it in
  `lockfile-outside-prefix`. On 0.10.1 a scan of a subdirectory still read
  the root lockfile. A full gate is a scan of the repository root, and the
  Action's `path` input should stay `.` unless the directory is the whole
  project.

### Added

- `lockfile-nested-removed`: a lockfile below the root present on the
  comparison side and absent on the judged side.
- `lockfile-outside-prefix`: `dep-guard scan <path>` names a lockfile in
  an ancestor directory that this scan did not read.
- `manifest-skipped-dirname`: a stray manifest skipped for its directory
  name.

## [0.11.0] - 2026-10-06

Minor on both published packages. `@vaultcompass/dep-guard` and
`@vaultcompass/dep-guard-core` move from 0.10.1 to 0.11.0. The action's
`version` input default and the `DG_TAG_SCANNER` constant move with them, so
`vaultcompasshq/dep-guard@v0.11.0` installs `@vaultcompass/dep-guard@0.11.0`.

### Added

- Manifests and lockfiles below the repository root are resolved.
  `package.json`, `package-lock.json`, `npm-shrinkwrap.json`,
  `pnpm-lock.yaml`, `requirements.txt` and `pyproject.toml` are read in
  subdirectories. A finding names the manifest or lockfile it came from.
  `dep-guard scan <path>` reads that directory. Paths in the output stay
  relative to the git root. `.gitignore` is honoured. `node_modules`,
  `.venv`, `venv`, `dist`, `build`, `vendor` and `vendored` are skipped.
- `--staged`, `--base` and `--trust-base` compare each manifest with the
  same path on the other side.

### Changed

- A `pyproject.toml` that only holds `[tool.*]` config, or any other
  manifest with no dependencies, does not by itself make the scan a
  could-not-run when another manifest or a read lockfile resolved.
- A scan that resolves nothing, while a manifest-shaped file it does not
  read is still on disk (a `yarn.lock` with no manifest, for example),
  stays a could-not-run (`manifests-unresolved`).
- npm and pnpm lockfiles below the root are judged. `lockfile-nested-changed`
  remains for a lockfile below the root that this tool does not read.

## [0.10.1] - 2026-10-04

Patch on both published packages. `@vaultcompass/dep-guard` and
`@vaultcompass/dep-guard-core` move from 0.10.0 to 0.10.1. The action's
`version` input default and the `DG_TAG_SCANNER` constant move with them, so
`vaultcompasshq/dep-guard@v0.10.1` installs `@vaultcompass/dep-guard@0.10.1`.
Scans that exited 0 can now exit 2 or 1. What can newly block, and how to
clear each:

- `lockfile-downgrade` (exit 2): the head loses lockfile coverage or gains
  root lockfile bytes dep-guard does not read, against any comparison side.
  Clear it by adding the entries the message prints to
  `acknowledgedLockfiles` on the base branch first, by deleting the stale
  lockfile in the pull request, or by an admin override after review.
- `workspace-glob-unexpandable` (exit 2): a workspace pattern on the side
  being judged that dep-guard cannot expand. Clear it by rewriting the
  pattern in the pull request; a base that still has the old pattern does
  not block that pull request.
- `lockfile-parse` (exit 2): an npm lockfile on the side being judged whose
  `lockfileVersion` (a number or a string of digits, 2 or more) promises a
  `packages` map it does not have. Clear it by regenerating the lockfile
  with npm in the pull request; a base that still has the old file does not
  block that pull request.
- `symlinked-input` (exit 2): a root lockfile dep-guard parses, the root
  `package.json` or a workspace member's `package.json` that is a symlink on
  the side being judged. Clear it by replacing the link with a regular file;
  a base that still has the link does not block that pull request.
- `config-invalid` (exit 2): a malformed `acknowledgedLockfiles` entry. Clear
  it by correcting the entry.
- New findings (exit 1): from pnpm lockfile documents now read, from
  `requiresBuild` in pnpm lockfiles older than v9, from the keys of pnpm
  lockfile versions 5.x and 6.x now read, from wider workspace expansion,
  and from the comparison changes listed under Changed. Clear them as any
  finding: an `allow` entry for the rules it covers, `ignorePaths`, or the
  baseline, each on the base branch for a pull-request run.

With `--base` and a trust base that is a different tree, the trust base's
dependency state is now also read, as a comparison side for the lockfile set
rule. What a comparison side cannot read (a symlinked input, a workspace
pattern dep-guard cannot expand, an npm lockfile missing its `packages` map)
is treated as absent there and named in a diagnostic, and the judged side is
compared against what remains.

### Added

- `acknowledgedLockfiles` in `.dep-guard.json`: `LOCKFILE:BLOBID` entries
  that let exactly those lockfile bytes through the lockfile downgrade rule.
  Read only from the comparison side (the trust base, else the `--base` ref,
  else HEAD for `--staged`). It clears that rule and nothing else; a run
  that uses an entry says so in the new `lockfile-downgrade-acknowledged`
  diagnostic. A malformed entry is invalid config (exit 2). On a staged scan
  the entries are read from HEAD, so they are committed in a commit of their
  own first; the refusal says where they are read for the kind of run it is
  on. A lockfile path that is a symlink has no identity to acknowledge.
  dep-guard 0.10.0 and earlier refuse a config containing this key, so it
  needs 0.10.1 or later. On a `--trust-base` run, additions are named in the
  config proposal and removals counted.
- Every YAML document of a `pnpm-lock.yaml` that is shaped like a pnpm
  lockfile is read, including the document pnpm writes for its own managed
  version, each as a lockfile of its own (`pnpm-lock.yaml#package-manager`,
  `pnpm-lock.yaml#document-N`) whose entries go through every check. This
  can add findings; clear them as any finding.
- A leading UTF-8 byte order mark is accepted in every JSON and YAML file
  the scan reads, and in the project `.npmrc`, whose first line after the
  mark is honoured as npm honours it.
- Every file with a lockfile name is inventoried at any depth with its git
  blob id. New diagnostics: `lockfile-nested-changed` names a lockfile below
  the repository root whose bytes differ from the base (dep-guard does not
  read it, so the run says nothing about what would be installed from it),
  `lockfile-nested-ignored` the same for a path covered by `ignorePaths`,
  `lockfile-not-read` the lockfiles present that dep-guard does not read,
  and `lockfile-unread-sibling` an unread root lockfile beside a read one on
  a run that is not refused for it. The `lockfile-missing` note is printed
  only when no lockfile is present at all.
- `symlinked-input-comparison-side`, `workspace-pattern-unread-comparison-side`
  and `lockfile-unread-comparison-side`: what a comparison side could not
  read and treated as absent there, naming the path or pattern and the side.
- `unknown-package-private-scope-skipped`: a new dependency whose scope the
  project `.npmrc` pins to a non-public registry is not checked against the
  public corpus, and this diagnostic names the scope. On a `--trust-base`
  run the pins come from the trust base. An unscoped name under a private
  default registry is still checked.
- pnpm lockfiles from `lockfileVersion` 5.x on are read, and `requiresBuild`
  is read as an install script in lockfiles older than v9. Both can add
  findings; clear them with an `allow` entry for the rules it covers or the
  baseline.
- On a `--trust-base` run, a changed `minAgeDays` and added `minAgeAllow`
  entries are named in the config proposal, and removed `minAgeAllow`
  entries are counted.

### Changed

- The lockfile downgrade rule now covers every way the lockfile set can
  lose what dep-guard reads. When the base side has a read lockfile with
  entries, the head may not carry a root lockfile dep-guard does not read
  whose blob differs from the base (a new `yarn.lock` beside a
  `package-lock.json`, a changed one, a v1 npm file, a binary lockfile, or a
  lockfile name that is a symlink or not a regular file), and may not lose
  every read lockfile with entries while a manifest declares a dependency a
  lockfile would record (peerDependencies count; workspace packages
  discovered as manifests do not). Deleting the only lockfile while
  dependencies are declared is now exit 2. In a `pnpm-lock.yaml`, the bytes
  outside the documents that are read count as unread bytes of that file.
  Clearing path:
  add the entries the error message prints to `acknowledgedLockfiles` on the
  base branch first, or delete the stale lockfile, or merge with an admin
  override after reviewing the lockfile by hand.
- A root lockfile dep-guard parses, the root `package.json`, or a workspace
  member's `package.json` that is a symlink is not parsed on any side of a
  scan. A git side decides from the file mode, the working tree with
  `lstat`. On the side being judged it is exit 2 (`symlinked-input`); on a
  comparison side it is treated as absent there and named in the new
  `symlinked-input-comparison-side` diagnostic. Clearing path: replace the
  link with a regular file; that pull request passes when the new file is
  clean. In that pull request the checks that compare a lockfile entry with
  its earlier resolution have no earlier resolution to compare against for
  that file, so the note is printed and the lockfile in that pull request
  should be reviewed by a person.
- With `--base` and `--trust-base` together the downgrade rule must hold
  against both sides; with `--trust-base` alone it is evaluated against the
  trust base; with `--staged` against HEAD only. Pass `--base` and
  `--trust-base` together on pull requests. Clearing path: as above.
- Workspace patterns are resolved as npm's workspace mapper resolves them
  (order, negation, a stripped leading `./` or `/`, backslashes, `*` in any
  segment, `**` at any depth, names starting with `.`, and, on a git side of
  a repository whose `core.ignorecase` is true, names in any case), so more
  workspace manifests are checked. Wider workspace expansion can surface findings in
  fixture and example workspaces; clearing path: `ignorePaths` on the base
  branch. On the side being judged, a pattern with a `..` segment or a drive
  letter, or using glob syntax beyond `*` and `**`, is exit 2
  (`workspace-glob-unexpandable`), and so is a `**` walk deeper than 32
  directories. Clearing path: rewrite the pattern inside the repository,
  without `..`, with `*` or `**`, or list the directories; the pull request
  that does so passes when it is clean. In that pull request the checks that
  compare a lockfile entry with its earlier resolution have no earlier
  resolution to compare against for that file, so the note is printed and the
  lockfile in that pull request should be reviewed by a person.
  An exclusion that cannot be applied exactly is not applied and noted,
  which only widens the scan.
- The primary lockfile (the one the run summary names and the manifest walk
  reads) is the first one dep-guard reads, so a legacy v1 npm file beside a
  pnpm lockfile no longer takes that place. This can add findings in a
  repository carrying both; clear them as any finding.
- An npm `lockfileVersion` written as a string of digits is read as that
  number, so `"2"` or `"3"` with no `packages` map on the side being judged
  is `lockfile-parse` (exit 2). Clearing path: regenerate the lockfile; the
  pull request that does so passes when it is clean. In that pull request the
  checks that compare a lockfile entry with its earlier resolution have no
  earlier resolution to compare against for that file, so the note is printed
  and the lockfile in that pull request should be reviewed by a person.
- Two unreadable resolutions at a held version, with no integrity hash on
  either side and a moved location, are a high `resolution-unreadable`
  finding. Clearing path: record an integrity hash for the entry, or the
  baseline.
- Where only one side of an entry records a resolved URL, an integrity
  rewrite to a weaker algorithm is reported as `integrity-downgraded`; every
  other rewrite there stays `integrity-changed`. A baselined finding of the
  first kind changes fingerprint and is reported once more. Clearing path:
  re-baseline after review.
- When the project `.npmrc` differs between the head and a comparison side,
  an integrity rewrite at the same URL is reported as `integrity-changed`
  even when it moves to a stronger algorithm. Clearing path: land the
  `.npmrc` change in its own pull request first.

## [0.10.0] - 2026-09-30

Minor on both published packages, per the stability policy: 0.x minors may
change scanner behavior, and this one does. `@vaultcompass/dep-guard` and
`@vaultcompass/dep-guard-core` move from 0.9.0 to 0.10.0. The action's
`version` input default and the `DG_TAG_SCANNER` constant move with them, so
`vaultcompasshq/dep-guard@v0.10.0` installs `@vaultcompass/dep-guard@0.10.0`.
Scans that used to exit 0 can now exit 1 (new findings) or 2 (a
`lockfile-downgrade` error), and a repository with more than one lockfile is
now checked against all of them.

What a consumer will see:

- A private registry host has to be named in the project `.npmrc` (as the
  default registry or a scope registry). A new dependency resolved from an
  http(s) host that is neither the public registry nor named there is now a
  `url-source` finding.
- A pull request that switches lockfile format, for example from
  `package-lock.json` or `pnpm-lock.yaml` to `yarn.lock` or `bun.lock`, is
  refused with exit 2 (`lockfile-downgrade`), and the error message names the
  remedy for a genuine migration.
- The online summary gains `cacheHits` beside `lookupsAttempted`, and the text
  output's `online:` line prints it.

### Fixed

Four ways a tampered or dangerous dependency change scanned clean, found by
an independent audit:

- An npm lockfile was judged "v1, skip everything" from `lockfileVersion`
  alone. Tampering an entry and setting `lockfileVersion` to the string
  `"3"`, to `1`, to `null`, or deleting it gave exit 0 with only an
  `npm-lockfile-v1` diagnostic, while npm still installs the tampered entry.
  The `packages` map is now read whenever it exists, whatever the version
  field says; the diagnostic is kept for a lockfile with no `packages` map
  at all. A base side that had a `packages` map against a head side that has
  none is now a `lockfile-downgrade` error (exit 2) rather than a
  diagnostic.
- A pnpm registry entry records only an integrity hash and no tarball URL,
  and the tamper check returned early whenever one side had no URL. An entry
  going from `{integrity: A}` to `{integrity: B, tarball: <another host>}`
  at the same version scanned clean, as did a repoint to another package's
  registry tarball. A missing pnpm tarball is now compared as the registry's
  implied tarball for that name and version (honouring `.npmrc` scope pins
  and the default registry), so gaining a URL reads as `host-changed` or
  `tarball-repointed`. Separately, a rewritten hash at a held version where
  only one side records a location is now `integrity-changed`, which also
  covers an npm entry that drops `resolved`.
- Only the first lockfile found was read, `npm-shrinkwrap.json` never was,
  and `package-lock.json` came first. A clean `package-lock.json` beside a
  tampered `pnpm-lock.yaml`, or a tampered `npm-shrinkwrap.json` (which npm
  prefers) beside a clean `package-lock.json`, exited 0. Every npm and pnpm
  lockfile at the root is now parsed and checked, `npm-shrinkwrap.json`
  included, and a `multiple-lockfiles` diagnostic names them.
- The specifier classifier read only `git+`, `github:` and `git:` as git.
  Bare `owner/repo` (with or without `#ref`), `gitlab:`, `bitbucket:`,
  `gist:`, `sourcehut:`, `ssh://` and scp-style `git@github.com:o/r`
  classified as registry, so the git-source signal never ran. They now
  follow npm-package-arg's rules. Also, a lockfile entry newly ADDED from a
  git or non-registry source (a transitive dependency no manifest declares)
  was skipped by the lockfile walk; it now raises the git-source or
  url-source signal in npm and pnpm repositories. A pnpm `type: git`
  resolution is now recorded, in URL and scp-style spellings, and a pnpm key
  with an embedded `@` (`name@git+ssh://git@host/...`) is parsed instead of
  skipped. An added entry is judged by host first: an http(s) host that is
  not the public registry or named by the project `.npmrc` (default or scope
  registry) is a url-source finding whatever its path looks like, `high` for
  a registry-shaped path and `critical` otherwise, so a private registry
  host has to be declared in `.npmrc` to stay quiet. A declared git
  dependency no longer hides a different source resolved under the same name.
- The downgrade error also covers a base with a parsed lockfile against a
  head whose lockfiles are all unparsed (v1 npm, yarn, bun, binary); a
  lockfile deleted with nothing in its place is not covered by it, so a
  two-step bypass (delete the lockfile in one pull request, add `yarn.lock`
  in the next) is a known gap, scheduled separately. The error now says why
  it stops (a format switch is how a tampered lockfile escapes inspection)
  and what a maintainer does for a genuine migration to yarn or bun: review
  the new lockfile by hand and merge with an admin override of the failing
  check, or first land a separate, reviewed pull request that relaxes the
  gate on the base branch (conductor: `enforce: false` on the dependencies
  gate; standalone action: `continue-on-error` on the workflow step), then
  the migration, then restore the setting in a third pull request. An
  advisory mode does not help: the error is exit 2, not a finding. A
  lockfile that exists only on the head side is compared against the base's
  primary lockfile, and the same signal in two lockfiles is reported for
  each.

### Added

- The run-level `online` summary carries a new `cacheHits` count beside
  `lookupsAttempted`. Both count the name lookups the online steps made;
  `lookupsAttempted` counts those sent to the registry, `cacheHits` those
  answered from the on-disk cache. A name is counted once per lookup, so one
  step can count a name twice (registered-squat looks up downloads and then
  the creation date) and several steps each count it again. Before this, a
  run answered entirely from a warm cache and a run with nothing to look up
  both reported `lookupsAttempted: 0`; `cacheHits` tells them apart (0 and 5
  is a warm cache, 0 and 0 is nothing to look up). The text output's
  `online:` line prints it. Every existing field is unchanged, and a
  disabled run reports `cacheHits: 0` (issue #80).

## [0.9.0] - 2026-09-27

Minor on both published packages, per the stability policy: 0.x minors may
change scanner behavior. `@vaultcompass/dep-guard` and
`@vaultcompass/dep-guard-core` move from 0.8.0 to 0.9.0. The action's
`version` input default and the `DG_TAG_SCANNER` constant move with them, so
`vaultcompasshq/dep-guard@v0.9.0` installs `@vaultcompass/dep-guard@0.9.0`.
All four `--online` checks now share one name-visibility rule,
`isNonPublicName`, closing a gap where the typosquat popularity-asymmetry
check sent every low-severity typosquat name to the downloads API with no
scope or internal-name filter of its own, and unknown-package and
registered-squat ignored `.npmrc` pins and the default registry; a scope pinned to the public registry is
now checked even under a private default registry, and a pull request that
changes only the default registry line is reported as a proposal rather
than as no change. The online checks' wall-clock budget is now
configurable: a new `onlineBudgetMs` key and `--online-budget-ms` flag
override the default, which stays 20000ms with neither `--base` nor
`--trust-base` on the command line and rises to 300000ms when either is
present, and the JSON output gains a `run.online` summary of whether online
checks ran, the budget used, and how many lookups were attempted or
skipped. `publish-age` also now resolves a purely transitive npm alias
under the name its own resolved tarball vouches for, rather than the
installed alias name, with identity unchanged: fingerprints, baselines,
allow and pin behavior all still key off the lockfile entry itself.

- Fixed a publish-age coverage loss: a scope pinned to the PUBLIC registry
  in `.npmrc` used to be treated as private just because it had a pin at
  all, so a dependency under that scope never reached the publish-age
  check. A pin now decides by its own origin, and still outranks the
  project's default registry either way: a scope pinned to the public
  registry is checked even under a private default, and a scope pinned
  away from the public registry is skipped even under a public default.
  Independent review then found a regression the first version of this fix
  introduced: a public pin was letting a lockfile entry's own `resolvedUrl`
  get ignored, so an entry that actually resolved from a *private* host
  under a publicly-pinned scope was fetched anyway. Only a *private* pin
  now decides unconditionally; otherwise a present `resolvedUrl` decides
  by its own origin before the pin or the default registry ever get a say.
  README and `docs/INVARIANTS.md` updated (fixes #67).

- Fixed a privacy gap, found across all three of the online checks that
  predate publish-age: `unknown-package` and `registered-squat` used to
  send every manifest-declared name to the public registry regardless of
  `.npmrc` scope pins or the project's default registry, and a later
  independent review found the same gap in the typosquat
  popularity-asymmetry escalation (`applyTyposquatAsymmetry`), which also
  had no `internalScopes`/`internalPrefixes` filter of its own -- the
  identical leak shape publish-age was built to close, reached through the
  three checks that predate it or were never re-audited against it. The
  name-level decision is now shared across all four checks
  (`online/registry-scope.ts`'s `isNonPublicName`), and a `.npmrc`-derived
  skip is never silently dropped: `unknown-package` raises
  `unknown-package-private-origin-skipped`, `registered-squat` raises
  `registered-squat-private-origin-skipped`, and the asymmetry check raises
  `typosquat-asymmetry-private-origin-skipped`, each naming the package. An
  `internalScopes`/`internalPrefixes` skip stays silent by design, in all
  four checks alike: an adopter's own committed list needs no diagnostic
  reminder. README and `docs/INVARIANTS.md` updated (fixes #70).

- Fixed a pull-request misreport: `trust-base.ts`'s `npmrcChanged` only
  compared the `.npmrc` scope pins and the file's shape, so a pull request
  that edited nothing but the unscoped `registry=` line was reported as an
  unchanged `.npmrc` even though that line is a control input the run
  already judges from the base ref. `npmrcChanged` now also ORs in a
  difference between the base and head default registry, and
  `describeNpmrcChange` names it ("proposed: default registry changed").
  README and `docs/INVARIANTS.md` updated (fixes #66).

- Made the online checks' wall-clock budget configurable and CI-aware
  (issue #75). The four online checks used to share a single hardcoded
  twenty-second budget, sized for a pre-commit hook; on a `--base` or
  `--trust-base` run that traded the wrong way, since a large dependency
  change could exhaust it and leave the remaining lookups quietly at their
  offline result with only an `online-deadline-exceeded` diagnostic to show
  for it. The budget now defaults to twenty seconds with no `--base` and no
  `--trust-base` on the command line, and to five minutes
  (`CI_ONLINE_BUDGET_MS`) only when one of those two flags is actually
  given -- not "in CI" more broadly: a push-triggered job or a bare
  `dep-guard check` with neither flag still gets twenty seconds. A new
  `onlineBudgetMs` key in `.dep-guard.json` and a matching
  `--online-budget-ms` CLI flag override either default for one run, in that
  order of precedence; both are meaningless without `online: true` or
  `--online`. `onlineBudgetMs` is a control input like every other
  `.dep-guard.json` key, so a pull request cannot raise or lower it for the
  run judging it; `--online-budget-ms` itself is a workflow-file decision,
  protected the same way every other flag baked into a job is (see
  "Protecting the workflow file itself" in the README). An exhausted budget
  still never fails the run by itself -- it stays a diagnostic, exactly as
  before. The JSON output gained a `run.online` object (a sibling of
  `run.corpusBuiltAt`), always present, reporting whether online checks
  ran, the budget actually used, how many name lookups were actually
  issued (counted once per check that looked a name up, except that two
  checks sharing one cache count it once; a downloads lookup can batch many
  names into one request, so this
  counts names, not requests), how many lookups were
  skipped once the budget was spent, and whether the deadline was exceeded
  at all -- so the conductor umbrella (vaultcompasshq/conductor#72) and any
  other JSON consumer can tell a genuine clean run apart from one that quietly
  ran out of time. README, `docs/INVARIANTS.md`, and the CLI help text
  updated.

- Fixed a minimum-publish-age miss on a purely transitive npm alias (one
  only some other package's own dependency introduces, which no manifest
  declares): `publish-age` asked the registry about the installed alias
  name instead of the package actually resolved, a silent miss at best and
  a wrong finding against an unrelated same-named package at worst.
  `lockfiles/npm.ts` now recovers the real name from the packages entry's
  own `name` field, but only when the entry's own resolved tarball URL
  vouches for it (`resolution.ts`'s `registryTarballPackageName`); an
  unvouched name is ignored and reported via a new
  `npm-lockfile-unverifiable-name` diagnostic rather than trusted or
  silently dropped. `publish-age` uses the recovered name for its registry
  query only -- its finding still reports under the lockfile key, with the
  looked-up name carried in `details` when the two differ.

  An earlier version of this fix read the entry-recorded name into
  `packageName` (identity) directly whenever no manifest declared the key.
  Independent review proved that let a forged `name` field on an otherwise-
  tampered nested entry silently clear its own dependency-confusion and
  install-script findings, and land it on an already-baselined fingerprint,
  because both checks key their allow/pin logic off `packageName`. Identity
  is now sourced only from a manifest declaration or the lockfile key,
  exactly as before this issue existed; the recovered name lives in a
  separate `LockEntry.lookupName` field that only `publish-age`'s registry
  query reads. pnpm needed no fix either way: its `packages` map is already
  keyed by registry identity, not by an alias name some dependent used to
  reach it. Yarn and bun lockfiles are unaffected for the same reason they
  carry no other lockfile-backed finding: neither format's entries are
  parsed at all.

  A third review pass found the fetch grouping itself was still wrong:
  `publish-age` grouped candidates by identity (the lockfile key) and asked
  the registry about only the first candidate's lookup name for the whole
  group, on the premise that every candidate sharing one key shares one
  lookup target. npm stores several entries under one key at different
  nesting paths, so a nested decoy sharing a real entry's key, version, and
  manifest path -- while genuinely vouching for an unrelated package's name
  -- collided with the real entry in the dedupe key (which did not account
  for the lookup name either) and erased it before the grouping step ever
  ran: the registry was asked only about the decoy's target, and the real,
  fresh dependency produced no finding and no diagnostic at all. The dedupe
  key now includes the lookup name, and the fetch groups by lookup name
  rather than identity, so two entries that report under the same name but
  resolve to different real packages are always looked up separately.
  README and `docs/INVARIANTS.md` updated (fixes #69).

## [0.8.0] - 2026-09-26

Minor on both published packages, per the stability policy: 0.x minors may
change scanner behavior. `@vaultcompass/dep-guard` and
`@vaultcompass/dep-guard-core` move from 0.7.0 to 0.8.0. The action's
`version` input default and the `DG_TAG_SCANNER` constant move with them, so
`vaultcompasshq/dep-guard@v0.8.0` installs `@vaultcompass/dep-guard@0.8.0`.
The new publish-age check is on whenever `--online` is set, reports at
severity high, and blocks at the default `failOn` of medium, so an adopter
running `online: 'true'` can go red on any dependency under seven days old,
and on a push run that covers the whole lockfile; raise `minAgeDays` or use
`minAgeAllow` to tune it.

- New `--online` check: minimum publish age. Only runs under `--online`
  (gated the same way as the other three registry-backed checks), and
  flags a resolved dependency version published less than `minAgeDays` (a
  new `.dep-guard.json` key, default 7) days ago, or with a future-dated
  publish timestamp at any floor including `0`. Lets a repository align
  dep-guard's judgment with its own Dependabot minimum-release-age
  cooldown, rather than only ever answering that question through
  registered-squat's hardcoded thirty-day window. Reads the lockfile's
  resolved versions, not manifest ranges: in `--base` mode, every
  dependency whose resolved version was added or changed in the diff; with
  no `--base`, every resolved dependency in the lockfile. A package the
  registry does not know, and a resolved version still missing from its
  publish-time record after a live lookup, each raise no finding of their
  own but are never silent: `publish-age-package-unknown` and
  `publish-age-version-unknown` diagnostics say so, because this check's
  own candidates come from the lockfile walk -- overwhelmingly transitive
  entries no manifest names, which unknown-package's own online resolution
  never sees. A new `minAgeAllow` key takes exact `name@version` strings
  for a reviewed one-release exception, never a semver range, and a
  cleared entry is reported with its own `publish-age-allowed` diagnostic
  rather than passed over in silence. A lockfile entry that did not
  resolve from the public npm registry, or whose scope is pinned to a
  different registry in `.npmrc`, is excluded before it is ever sent to
  the registry, with a `publish-age-private-origin-skipped` diagnostic
  naming it; a pnpm entry with no recorded resolution URL (pnpm never
  records which registry served an ordinary resolution) is judged instead
  against the project `.npmrc`'s own unscoped default registry, and on a
  pull request that default registry is read from the trust-base ref
  alongside the config, the baseline and the scope pins, so a pull request cannot
  add or change it to silence the check for a package it introduces.
  README, CHANGELOG, and `docs/INVARIANTS.md` updated (fixes #58).

- The CLI refuses an explicit `--base` that resolves to HEAD's own commit
  or tree when `--trust-base` is also present, exiting 2 with a message
  naming the comparison base as the tree being judged. Closes a quieter
  companion to the case the Action's `base` input refusal already closes:
  on an event that sets no `GITHUB_BASE_REF` (`push`, `merge_group`), an
  explicit `--base` of HEAD was not previously caught, and it degrades
  silently rather than failing, since HEAD compared against itself is
  simply an empty delta with every comparison-based signal going quiet. A
  bare `--base` with no `--trust-base` is unaffected: comparing a dirty
  working tree against HEAD locally is legitimate (fixes #64).

- The Action gained a `base` input, wired to the scanner's `--base` flag the
  same way `trust-base` is wired to `--trust-base`: on a pull_request event
  it defaults to `origin/$GITHUB_BASE_REF` and cannot be redirected there,
  and on any other event it passes nothing by default, an explicit ref
  redirects it, and `off` is refused with an error on every event. Before
  this the Action never passed `--base` at all, so every scan ran with no
  earlier revision to compare dependencies against and the lockfile-tamper
  comparison signals could not run in pull-request mode. README documents
  which checks still run without a base ref (fixes #62).

- Review fix: an explicit `base` input on a pull_request event is now
  refused rather than honoured. `trust-base` is safe to redirect there
  because whatever ref it names, that ref's own config and baseline gate
  the run, but `base` only decides what counts as changed, so a pull
  request could otherwise set it to its own head or its own branch and
  make every dependency change read as unchanged, emptying the delta the
  gate exists to see.

- Pinned the Action's npm floor (10.5.2), version-shape regex and its
  occurrence count, `--ignore-scripts` install line, and the exact
  `npm audit signatures` subshell in a drift check. The hygiene blocklist
  comment now names all four family repositories. The one-command install
  is on the first screen of the README, and adopter feedback is linked
  from there next to CONTRIBUTING.

- The release-kind classifier now takes a packages[] list, the same shape
  vault-guard 1.8.0 uses on main (scripts/lib/release-kind.mjs as of
  c166862). The CHANGELOG heading check is a literal "## [X.Y.Z]" prefix
  match, not a regex built from the tag, so CodeQL no longer flags it and
  "## [0.6.10]" cannot satisfy a search for 0.6.1. The heading match is
  now exactly "## [" with one space (stricter) and tolerates leading
  whitespace on the line (looser), both matching vault-guard. No change
  to how the current two-package layout is classified.

## [0.7.1] - 2026-09-20

- The Validate inputs step now declares GITHUB_BASE_REF from the event
  payload in its env mapping, so the pull-request test cannot come from the
  workflow file even if the platform no-overwrite guarantee failed.

- Corrected a quote in docs/INVARIANTS.md: the GITHUB_*/RUNNER_* no-overwrite
  rule is documented flatly by GitHub; the "not guaranteed" hedge on the same
  page qualifies the separate CI variable exception, not this rule. Docs only.

- Widened the release-smoke job's npm registry wait window from about 2
  minutes to about 5 minutes, so ordinary registry propagation lag does not
  false-fail an otherwise-successful publish. CI-internal, no package version
  bump.

- Pinned the transitive js-yaml dev dependency to 3.15.2+ via
  pnpm.overrides to clear a high-severity advisory (CPU DoS on empty merge
  sources). The dependency comes in through jest, babel-plugin-istanbul, and
  @istanbuljs/load-nyc-config for test-coverage tooling only; it is not in
  the published package. No package version bump.

## [0.7.0] - 2026-09-19

Minor on both published packages, per the stability policy: 0.x minors may
change scanner behavior. `@vaultcompass/dep-guard` and
`@vaultcompass/dep-guard-core` move from 0.6.0 to 0.7.0. The action's
`version` input default and the `DG_TAG_SCANNER` constant move with them, so
`vaultcompasshq/dep-guard@v0.7.0` installs `@vaultcompass/dep-guard@0.7.0` --
tag and scanner are the same number again after the v0.6.1 through v0.6.4
action-only releases moved the tag alone.

### Security

- **A scan that resolves zero manifests while a manifest sits on disk now
  fails closed (could-not-run) instead of reporting a clean pass.** Ported
  from a whole-tree-scan invariant in a sibling scanner, adapted to
  dep-guard's own unit of work: a manifest, not a file. `scan()` resolves
  package.json (root and every discovered workspace member) plus a
  recognized lockfile into the state it judges; when that resolution comes
  back empty, a cheap, resolver-independent filesystem probe now checks
  whether a manifest-shaped file (package.json, package-lock.json,
  pnpm-lock.yaml, yarn.lock, bun.lock, or bun.lockb) exists anywhere under
  the scan root at all. If one does, the run refuses with a
  `manifests-unresolved` error (exit 2) rather than reporting "no risky
  dependencies found" over a tree it never actually looked at. A genuinely
  dependency-free repository, where the probe agrees with the resolver that
  nothing is there, is unaffected and stays a clean exit 0, same as before:
  a repo with no dependencies legitimately has nothing to check.

  This scopes honestly to the case it actually catches: a manifest present
  on disk that the resolver's own rules (an undeclared workspace, a
  symlink that resolves outside the scan root) never reached. A wrong scan
  root that still resolves at least one real manifest is not caught here --
  running at the repository root remains the primary protection.

  **Staged mode (`--staged`, the mode the init pre-commit hook runs) is
  excluded from this check.** In staged mode the state under judgment is
  the git index, not the working tree, so a package.json a developer
  created but has not yet run `git add` on is a legitimate, imposed-empty
  staged scope, not a discovered-empty misroot -- the empty scope was
  imposed by the index itself, the same way it is for an empty PR delta.
  Running the on-disk probe there compared the index against the
  filesystem and would misfire on every ordinary not-yet-staged file,
  turning a routine commit into a could-not-run with a misleading "scan
  root may be wrong" message. The sibling scanner makes this same
  exclusion for the same reason; the check still runs unchanged for
  whole-repo, base, and audit scans, where a discovered-empty result is
  never an imposed scope.

## [0.6.4] - 2026-09-18

**An action-only release.** The npm packages stay at 0.6.0.
`vaultcompasshq/dep-guard@v0.6.4` installs `@vaultcompass/dep-guard@0.6.0`.

### Security

- **On a pull request, the `version` input may no longer ask for a scanner
  older than the one this action tag ships.** On a same-repo `pull_request`
  event GitHub runs the workflow file from the pull request HEAD, so the
  `version:` input is written by the pull request being judged. The only check
  on it was a SHAPE check: it proves the value names a version and says nothing
  about which one, so every published version cleared it.

  Nine scanners are published, 0.1.0 through 0.6.0. What stops a backward pin
  today is not that check but a FLAG: `--trust-base` arrived in the 0.6.0
  scanner, the Action's run step appends it on every pull-request run with no
  opt-out, and a scanner at or below 0.5.0 answers `error: unknown option
  '--trust-base'`. A backward pin therefore already fails the job, at the scan,
  with a message about an unknown option rather than about what the pin was
  doing. This rule moves that failure up to the validate step and names the
  cause. The day a 0.7.0 scanner ships with new rules, a pull request pins
  `version: 0.6.0`, which knows `--trust-base` and runs cleanly, and is judged
  by the older rule set it chose for itself. It is the same class of hole as
  `trust-base: off`, which this action already refuses by name. The difference
  is what a reviewer sees: deleting a security step reads as deleting a
  security step, while `version: 0.6.0` reads as ordinary version management.

  On pull-request events the validate step now refuses a `version` below the
  scanner this Action tag ships, naming both numbers and pointing at the fix,
  which is to remove the input. Pinning **forward** is still accepted there, on
  an assumption the rule does not enforce: that a newer scanner is at least as
  strict. Forward pins are not bounded.

  **Where it fires** is exactly where `GITHUB_BASE_REF` is set, which is
  `pull_request` and `pull_request_target`. Push runs are out of scope. That is
  a scope statement, not a safety argument: a push run on an unprotected
  feature branch runs that branch's own workflow file, written by the same
  author, and is as author-controlled as a pull request. It is not covered.

  **What this costs, and the migration.** Nine scanners are published, so a
  workflow pinning any of `0.1.0` through `0.5.0` passes the shape check on a
  pull request today and is refused by v0.6.4 at the validate step. Such a pin
  is already broken on that event, because those scanners do not know
  `--trust-base` and the run step always passes it; what changes is that the
  job now fails earlier with a message saying why. **If you pin `version` below
  `0.6.0`: remove the `version` input, which is the pin you want because the
  default is the scanner this Action tag ships, or raise it to `0.6.0` or
  newer.** A pin at or above `0.6.0` is unaffected, and so is every push run.

  **The comparison is against a constant of its own,** `DG_TAG_SCANNER` in
  `action.yml`, not against anything derived from an input: `inputs.version`
  looks identical whether the consumer pinned it or the default supplied it, so
  the step cannot tell a pin from a default. It is not the npm floor in the
  install step either, which is a property of the npm CLIENT and has nothing to
  say about the scanner. A test ties `DG_TAG_SCANNER`, the `version` input's
  default and both published package versions to one number, because a constant
  left BEHIND a published scanner would go on admitting the pin it exists to
  refuse, and would do it quietly.

  **What this does not cover:** forks, where the base repository's workflow
  file runs, so a fork author never writes the `version:` that judges them (the
  rule still fires on a fork pull request and judges the base workflow's own
  pin, so a deliberate backward pin there refuses every fork run); and a pull
  request that deletes the step or moves the `uses:` pin, for which branch
  protection with required review on `.github/workflows/**` remains the
  control.

## [0.6.3] - 2026-09-18

**An action-only release, and a correction to v0.6.2.** The npm packages stay
at 0.6.0. `vaultcompasshq/dep-guard@v0.6.3` installs
`@vaultcompass/dep-guard@0.6.0`.

**Upgrade from `@v0.6.2` if you pin it.** That release refuses working npm
clients.

### Fixed

- **The npm floor was wrong by two patch versions, and refused clients that
  work.** v0.6.2 required npm 10.6.0. The real boundary is **10.5.2**: it
  verifies signatures correctly, with the same package and attestation counts
  as current npm rather than a reduced set. Re-bisected with a cold cache and
  a fresh `HOME`, so no newer client could have primed the TUF root or the key
  set: 8.19.4, 9.9.4, 10.2.4, 10.5.0 and 10.5.1 fail; **10.5.2** and every
  later version pass.

  This reached real consumers rather than being a rounding error. **Node
  20.13.0 and 20.13.1 ship npm 10.5.2**, so anyone pinning those got a hard
  refusal from v0.6.2 whose message told them their client could not do
  something it demonstrably can.

  The wrong number came from a bisection that tested 10.5.0 and then 10.6.0
  and never tested what lay between them, and it was then written into the
  action, this changelog, the README and the test fixtures as a measured fact.

- **The comparison is restructured so an arithmetic error cannot read as
  permission.** It now accepts only if the client is provably at or above the
  floor, rather than refusing if it is below. `[` returns 2 on a malformed
  comparison and an `if` reads 2 as false, so the previous shape turned any
  such error into a pass. That is how the first two versions of this guard
  failed open, and the third had the same latent shape even though no real npm
  output could reach it.

## [0.6.2] - 2026-09-18

**An action-only release. The tag moves; the npm packages do not.** Nothing in
the scanner changed, so `@vaultcompass/dep-guard` stays at 0.6.0 on npm and the
action's `version` default stays `0.6.0`.
`vaultcompasshq/dep-guard@v0.6.2` installs `@vaultcompass/dep-guard@0.6.0`.

### Security

- **The action no longer runs install scripts, and verifies what it installed.**
  The install step ran `npm install -g` with no `--ignore-scripts` on a runner
  holding the job's token, so every package in the resolved tree had arbitrary
  code execution there on every run. What it installs is a control input: it
  decides whether a pull request may merge.

  It now also runs `npm audit signatures` over the installed tree. That needs a
  root manifest to work at all: the audit walks the tree's edges out, and a
  global install leaves `<prefix>/lib` with no manifest, so without one the
  audit covers the dependencies and silently skips the scanner itself.

  **What the verification proves, stated narrowly:** it asks the registry for
  each name and version in the tree, the scanner included, and checks the
  signature served back. It does **not** read the installed files, so a tampered
  install is invisible to it; it does **not** defeat a compromised registry,
  which signs what it serves; and a **missing** attestation is not a failure.

### Fixed

- **A floor on the npm client, so the action cannot call a clean install
  tampered with.** `npm audit signatures` is not version-stable: below npm
  10.6.0 it fails on an untampered install of these very packages, because the
  client's bundled keys are stale. On 10.5.0 it reports *"Someone might have
  tampered with these packages"*, naming ours. The action now refuses up front
  and names the npm it found.

  Note `node-version: 22` is not on its own sufficient: **Node 22.0.0 ships npm
  10.5.1**, inside the failing band. Pin 22.1.0 or later.

### Changed

- The README now documents both ways this step fails closed, what the
  verification does and does not prove, and `@v0.6.1` as the pin that does not
  verify. Previously that trade was recorded only in an internal maintainer
  file.

## [0.6.1] - 2026-09-12

**An action-only release. The tag moves; the npm packages do not.** Nothing in
the scanner changed, so `@vaultcompass/dep-guard` stays at 0.6.0 on npm and the
action's `version` default stays `0.6.0`, which is the scanner this action tag
installs and was tested against.

That makes the action tag and the scanner version two different numbers for the
first time, and it is deliberate rather than an oversight:
`vaultcompasshq/dep-guard@v0.6.1` installs `@vaultcompass/dep-guard@0.6.0`.
Publishing an identical scanner as 0.7.0 so the two strings matched would burn a
version number on a change that touches no scanning code, through a
trusted-publisher path that is a one-way door.

**Pinning `vaultcompasshq/dep-guard@v0.6.0` gets the OLD action**, the one that
installs the scanner from inside the checkout. Move to `@v0.6.1`.

### Security

- **The Action installs the scanner from outside the tree it scans.** It ran
  `npx` from inside the checkout, which put the choice of program inside the
  tree under judgment by two routes. An `.npmrc` committed by the head
  repoints the registry npx fetches from. A copy of the package already in the
  head's `node_modules`, from the workflow's own earlier install step, is what
  npx runs, with the version pin acting only as a satisfaction check on a
  package the head wrote. Either one lets a pull request choose the program
  that scans it, and the second needs no registry at all. The package is now
  installed globally into a prefix under the runner temp, with npm started
  from the runner temp rather than from the workspace, and called by absolute
  path.

  The scan path passed to that binary is now absolute, and the two halves are
  not separable: run from the runner temp with a relative `.`, dep-guard
  resolves the runner temp as the repository, fails to resolve the trust base,
  and exits 2 on every run, blaming a `fetch-depth` the caller already set.

### Changed

- **`version` takes an exact version only, and defaults to the version the
  action shipped with.** It accepted dist-tags and defaulted to `latest`. A
  tag hands the choice of scanner to the registry on the morning of the run.
  The old charset also accepted values npm reads as a PATH rather than a
  version, `.`, `..` and `payload.tgz` among them. **A workflow relying on the
  old `latest` default must pin an exact version.**
- **Only 0 and 1 are verdicts.** Any other exit code from the run step,
  including the 126 and 127 the shell produces when the binary is missing or
  not executable, is reported as could-not-run and re-raised as 2 rather than
  as blocking findings. An empty code, which is what a rejected input looks
  like from the report step, is now also 2 rather than 1.
- **`results-file` is published only when the SARIF is non-empty.** dep-guard
  exits before writing anything when it could not run, and the redirect had
  already created the target, so `upload-sarif` was handed a zero-byte file
  and failed the job with a parse error that buried the real cause.
- **Input validation.** No value may begin with a dash, rather than only the
  ref. `trust-base: off` is refused in any capitalisation. A version with a
  leading zero such as `01.2.3` is refused, because npm does not read it as a
  version at all and falls back to treating the spec as a dist-tag.
- **`sarif-output` may not resolve under `.github/`**, which holds the workflow
  file and the CODEOWNERS entry that decide how this gate runs. Compared after
  normalising `./` segments, doubled slashes and case to a fixed point, so
  `./.github/x` and `.GitHub/x` are refused too. A `./` prefix is still
  perfectly legal on any input; an earlier draft of this release refused it
  outright and would have broken `path: ./src`.
- **`sarif-output` may not resolve through a symlink**, at the file or at any
  directory on the way to it, checked before the containing directories are
  created rather than after. The head controls those, and a symlink there
  sends the write outside the workspace.

## [0.6.0] - 2026-09-06

Minor on all three packages, per the stability policy: 0.x minors may
change CLI flags and the JSON output shape, and this adds a flag, a JSON
block, three new error codes and a new SARIF element. Nothing outside
pull-request mode changed, so no baseline needs regenerating.

**The rule: on a pull-request run, every control input comes from the base
ref and the head tree is the thing judged.**

### Added

- **`--trust-base <ref>` on `scan` and `check`.** Pull-request mode.
  `.dep-guard.json`, `.dep-guard.local.json`, `.dep-guard.baseline.json`
  and `.npmrc` are read from `<ref>` with `git ls-tree` and `git show`, and
  the head tree is judged against them. A control input the head changed
  never takes effect for the run and is reported on one line: `config
  changed in this pull request`, `baseline changed in this pull request`,
  or `npmrc changed in this pull request`, with a short parenthetical
  naming what it proposed (`proposed: allow foo`, `failOn loosened to
  critical`, `2 baseline entries added`, `proposed: unpin @scope`). A
  control input the head carries and the base does not reads `config added
  in this pull request`, and the run uses the defaults. Reads only: no
  checkout switch, no worktree, and nothing written into the repository.
  Fails closed, exit 2, when the ref will not resolve; a missing base is
  never a reason to fall back to trusting the head. Pass it alongside
  `--base`, which continues to decide only what the change is compared
  against.
- **A `trustBase` block in the JSON** from `scan` and `check` (`ref`,
  `proposals`, `configChanged`, `baselineChanged`, `npmrcChanged`,
  `configShapeChange`, `baselineShapeChange`, `npmrcShapeChange`), and one
  SARIF `toolExecutionNotification` per proposal. A proposal is never a
  SARIF result: it is a fact about the run, not a finding about the code,
  and promoting it would invent an alert with no code behind it.
- **A `trust-base` input on the composite Action**, which passes
  `origin/$GITHUB_BASE_REF` by itself on a `pull_request` event and on no
  other event. Set it to a ref to point pull-request mode at a different
  base. A pull-request run needs `actions/checkout` with `fetch-depth: 0`.
  There is deliberately no value that turns pull-request mode off, and
  `off` is refused with an error naming the alternative: an opt-out input
  would be settable by the pull request itself, because on a
  same-repository `pull_request` event the workflow file runs from the
  pull request's own head. A repository that needs pre-0.6.0 behaviour
  while it arranges `fetch-depth: 0` should stay pinned to `@v0.5.0`.

### Security

- **A pull request could turn the gate off in the same commit that carried
  what the gate exists to catch.** Every control input was read from the
  tree under judgment, so one commit could add a hallucinated or
  typosquatted dependency and, in the same diff, add its name to `allow`,
  add its manifest path to `ignorePaths`, raise `failOn` above the
  finding's severity, add its scope to `internalScopes`, or write the
  finding's own fingerprint into the baseline. Four of those five returned
  exit 0 in `--base` mode, which is the mode CI runs; the fifth
  (`internalScopes`) did not silence the finding but did change which rule
  reported it, its message and its fingerprint. All of them are closed by
  `--trust-base`, which is how CI should now invoke the gate on a pull
  request. Local and pre-commit behaviour is unchanged and is pinned by a
  parity test in both packages.
- **Deleting `.npmrc` deleted a rule.** The scope-to-registry pins in
  `.npmrc` are the entire precondition of the dependency-confusion
  pin-mismatch rule, which fires only for a scope that HAS a pin, and they
  were read from the tree under judgment. So a pull request that added
  `@scope/package` resolving from the public registry while deleting the
  `.npmrc` that pinned `@scope` to a private one exited 0, and the report
  said "no control input changed in this pull request" while a control
  input had just been removed. `.npmrc` is now read from the base ref like
  the config and the baseline, and a head-side change to its pins is
  reported as `npmrc changed in this pull request` with the same four shape
  variants. Only the scope pins are compared, not the file text, so a
  rotated auth token or a changed default registry is not reported as an
  attempt to loosen the gate.
- **A trust base that resolves to the commit being judged is refused**,
  exit 2, even though it names a real commit. It would put the boundary
  back exactly where it started while the report said pull-request mode was
  on. The realistic way in is `--trust-base ${{ github.sha }}`, because on
  a `pull_request` event with the default `actions/checkout` that SHA is
  the merge commit, which is HEAD. The comparison is on resolved commits,
  so an alias, a tag or a raw SHA naming the head commit is refused alike.
- **A trust base whose TREE equals the head's is refused too**, exit 2,
  even when it is a different commit. What GitHub publishes as
  `refs/pull/N/merge` is a merge commit whose tree, when the base has not
  moved since the fork, *is* the head branch's tree, so
  `--trust-base ${{ github.event.pull_request.head.sha }}` named a
  different commit carrying an identical tree and every control input still
  came from the tree under judgment. Merging the base into the branch
  changes the head's tree, so a pull request that does that is judged
  normally.
- **A control input whose SHAPE the head changed is reported, and a
  base-side one that is not a regular file is refused.** Replacing
  `.dep-guard.json` with a symlink whose target holds the base config's
  exact bytes changes nothing a content comparison can see, and it is the
  first half of a two-step: land the link, then widen the link target in a
  later pull request where `.dep-guard.json` never appears in the diff at
  all. Both sides of the comparison are read through git for the same
  reason, so a link is compared as its target text rather than as the
  linked file's contents. The four variants reported are symlink, not a
  regular file, removed, and a changed file mode.
- **A base-side control input that is not a regular file is refused**, exit
  2, and that includes `.npmrc`. Reading a linked `.npmrc` leniently looked
  safe because `parseNpmrcPins` cannot fail, but not throwing is not the
  same as failing safe: the pin-mismatch rule fires only for a scope that
  HAS a pin, so an empty pin set turns the rule off for every scope at
  once. The same head that exited 1 against a readable base `.npmrc` exited
  0 against a linked one, and the report blamed the head for a pin the base
  was still holding through the link. The message names it as a
  misconfiguration on the base branch rather than something the pull
  request did, because that is where the fix goes.
- **A base config or baseline that does not validate is could-not-run**,
  exit 2, never a fall back to the defaults. The defaults may be looser
  than what the project committed, and a gate that silently loosens itself
  when a file is malformed is a gate anyone can loosen. A head-side one
  that does not validate is reported as a change and otherwise ignored,
  because the run was never going to use it and letting it abort the scan
  would be a muting attack of a different shape.

### Changed

- `.dep-guard.local.json` is read from the base ref alongside
  `.dep-guard.json` in pull-request mode. On a pull-request run a committed
  local overlay is just as much a control input the head can rewrite, and
  reading one from base while trusting the other from head would leave the
  hole open one file over. Outside pull-request mode it is read off disk
  exactly as before.

### Documentation

- A pull-request section in the README stating the rule in one sentence,
  the Action usage with `fetch-depth: 0`, and two things the gate cannot do
  for you: on a same-repository `pull_request` event the workflow file runs
  from the pull request's head, so the job has to be a required status
  check or a reusable workflow on a protected ref; and a human-approval
  requirement belongs in branch protection plus a CODEOWNERS entry for the
  control-input paths, never in an in-repo setting, because a mode selector
  living in the file a pull request controls is a knob a pull request flips
  to whichever mode is weaker.
