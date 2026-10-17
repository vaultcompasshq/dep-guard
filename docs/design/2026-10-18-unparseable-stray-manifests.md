# Project manifests that do not parse

Status: approved after two review rounds; implemented on
feat/protected-manifests-and-bench-config (see "Implementation notes"
below). Target release 0.15.0 (minor). Nothing in this design loosens a verdict: the default for
a manifest that does not parse stays exit 2, and every change below either
keeps an exit 2 or adds one. A new exit 2 can turn a currently green
adopter red (a Python repository with a deliberately broken
`pyproject.toml` beside its `uv.lock` and an `ignorePaths` entry for it),
which is why this is a minor and not a patch.

Fix round 1 changed direction. The first version proposed a default note
for a stray `package.json` that is not JSON. The independent review
measured bun installing from such files (section 1), the coordinator ruled
the loosening dropped, and this version keeps only the fail-closed parts.

## Context

Since 0.11.0 every tracked `package.json` outside the skipped directory
names is read. A deliberately malformed fixture under a test directory
stops every run with exit 2 (`manifest-parse`):

- npm/cli, `workspaces/arborist/test/fixtures/bad/package.json`, which
  holds `{` and `NOPE`;
- eslint, `tests/fixtures/config-file/broken-package-json/package.json`,
  which is missing its closing brace.

0.14.0 (PR #99, commit 548cb25) let `ignorePaths`, read from the trust base
on a pull request, drop such a file with a `manifest-unparsed` note
(`loadState`, `git-source.ts`, the catch around `parseProjectManifest`).
Four positions stay fatal whatever `ignorePaths` says, on a scan of the
repository root: the root `package.json`; a root workspace member (parsed by
the workspace walk, before the catch); a `package.json` beside its own
lockfile; and one a nested install root's workspace patterns name (both
through `vouchedFor = isPackageJsonPath(relPath) &&
readDespiteSkippedName(relPath)`).

The independent review of PR #99 established, in that commit's message:

1. npm and pnpm refuse invalid JSON;
2. `parseManifest` (`manifest.ts`) also rejects some VALID JSON that npm
   installs from (a non-object `pnpm` field beside a real `dependencies`
   entry);
3. a well-formed manifest under an ignored path already had every finding
   anchored to it filtered by `ignorePaths`, so dropping it under the same
   entry hides nothing the entry did not already hide.

Fact 1 is true of npm and pnpm and false of bun (section 1). Fact 3 is what
the `ignorePaths` escape rests on, and it does not depend on fact 1.

What this design fixes:

- **The fatal set is narrower than what installers read.** Python
  manifests are never vouched: `vouchedFor` requires `isPackageJsonPath`,
  and `installRootSet` is built from `isLockfileName`, which knows only
  `LOCKFILE_CANDIDATES` (npm, pnpm, yarn, bun). So an ignored unparseable
  `pyproject.toml` beside `uv.lock` is dropped while a `package.json` beside
  `package-lock.json` stays fatal. A `file:` or `link:` target and an npm
  lockfile link target are not vouched either.
- **A subdirectory scan has a different fatal set.** On `dep-guard scan
  SUBDIR` the root manifest is read only when in scope (`rootInScope`),
  `pnpm-workspace.yaml` only when the prefix is empty, and install roots
  come from `filesInPrefix`. A root workspace member inside the prefix
  therefore reaches the catch and is dropped when ignored.
- **One error at a time.** `loadState` throws on the first manifest that
  fails, and `loadStates` loads the comparison side before the judged side,
  so a repository with several broken fixtures learns about them one exit 2
  at a time, and the bench sees only the first.
- **A content echo.** `manifest.ts` line 209 puts a raw dependency key into
  an exit 2 message.
- **The bench cannot measure two public repositories** (npm/cli and
  eslint, `expectSkip` rows), because it applies no configuration.

## 1. The adversarial question

For each position: what does an installer read, and what could an author
hide by making a manifest unparseable to dep-guard but readable to an
installer? The attack has one shape everywhere: if the run turns the parse
failure into a note, the manifest's dependency lines never reach the name
checks or the tamper specifier signals, and the run is green.

### What installers accept, measured

The review measured, with `bun install --cwd DIR --no-save` on synthetic
manifests carrying a `file:` dependency:

| Input | bun 1.3.10 | npm 10.9.8 | pnpm 9.15.9 |
|---|---|---|---|
| `//` line comment, `/* */` block comment | installs | refuses | refuses |
| trailing comma | installs | refuses | refuses |
| single-quoted keys and strings | installs | refuses | refuses |
| hex and leading-dot numbers | installs | refuses | refuses |
| arbitrary trailing junk after the first complete value (`{...} NOPE`, or `{...}` then a line of garbage) | installs | refuses | refuses |
| the npm/cli fixture (`{` then `NOPE`), the eslint fixture (missing closing brace) | refuses | refuses | refuses |
| unquoted keys, backticks, a `#` line, `Infinity`, `+1`, a missing comma | refuses | refuses | refuses |
| empty file | no dependencies | not recorded | not recorded |

The trailing-junk row decides the question. `{"dependencies":
{"reqeusts": "1.0.0"}} x` fails `JSON.parse` and fails any JSONC reader, so
no syntax test dep-guard could reasonably hold separates it from the npm/cli
fixture; yet bun installs `reqeusts` from it. An author who adds that file
as `tools/x/package.json`, with a workflow that runs `bun install` there,
gets a green run under any rule that drops "not JSON" by default. Telling
the two apart would mean tracking bun's lexer (its prefix parse, its
literal forms) release by release, and a security scanner should not hold
a line defined by one installer's leniency.

**Ruling: no default drop.** A manifest that does not parse is exit 2 unless
it is a stray that `ignorePaths` from the comparison side covers. Fact 3 is
why that escape is safe whatever bun accepts: the comparison side chose to
ignore the path, and every finding a well-formed file there would have
produced is filtered by the same entry.

### Position by position

| Position | What reads it | Why it must stay fatal under `ignorePaths` |
|---|---|---|
| root `package.json` | every install at the root | the repository's own install reads it |
| root workspace member | the root install, through the root lockfile | the root lockfile records what it installs, and dropping it repeats the 0.11.0 class (lockfile read, manifest beside it not) |
| manifest beside a lockfile dep-guard recognises (npm, pnpm, yarn, bun, `uv.lock`, `poetry.lock`, `pdm.lock`, `Pipfile.lock`) | `npm ci`, `pnpm install`, `uv sync`, `poetry install`, `pdm install`, `pipenv install --deploy` all read the manifest beside the lock | same 0.11.0 class; for Python, `[tool.uv.sources]` git and url rewrites are the only place a Python git source becomes a tamper subject (0.13.0 design, section 2) |
| `uv.toml` beside `uv.lock` | uv, for the project in that directory | it carries the index settings the 0.13.0 design treats as control input for that project |
| member named by a nested install root's patterns (`workspaces`, a `pnpm-workspace.yaml` beside the lockfile, `[tool.uv.workspace].members` and not `exclude` of a `pyproject.toml` beside `uv.lock`) | that root's install | that root's lockfile records it |
| target of a `file:`, `link:` or `portal:` specifier in a parsed `package.json`, or the `resolved` directory of a `"link": true` entry in a parsed npm lockfile (`workspaceLinks`) | npm reads the target's `package.json` and installs its dependencies | an installer reads it on the referencing project's behalf |
| any other manifest (a stray) | only a command run in that directory, which dep-guard cannot see | not vouched; droppable under a comparison-side `ignorePaths` entry, fatal without one |

Not classification inputs, by decision: pnpm lockfile `importers` keys and
`yarn.lock` workspace entries. Both name directories that a workspace
pattern dep-guard already reads (`pnpm-workspace.yaml`, `workspaces`)
names, `yarn.lock` is not parsed beyond manifest-level checks, and adding
them would only duplicate the pattern rule. A pull request that edits
either file without the pattern is a lockfile change judged by the existing
rules.

### Shape and syntax in messages

The two classes no longer decide anything, but the exit 2 message names the
class so a reader knows whether a package manager could read the file:

| Class | Rejections |
|---|---|
| syntax | `not valid JSON` (`JSON.parse` after the byte order mark is stripped); `could not be read as TOML` |
| shape | `manifest is not a JSON object`; a non-object dependency section; a non-string specifier; a non-object `pnpm` field; `pnpm.onlyBuiltDependencies` not an array of strings; a Python `[key] could not be read` |

A syntax message adds "some package managers accept JSON with comments,
trailing commas or text after the value, so this file may still install";
a shape message adds "it is valid JSON, so a package manager may install
from it". The message does not name bun, so it does not age; INVARIANTS
records the measured versions. No exit 2 message echoes `JSON.parse` or
TOML parser text: `parseManifest` throws its own fixed string, and
`readToml` likewise.

## 2. The vouched set

### Rule

A manifest path P is vouched on a side when, on that side's listing, P is:

1. the root `package.json`;
2. a member named by the root `package.json` `workspaces` or the root
   `pnpm-workspace.yaml`;
3. in a directory that also holds a lockfile dep-guard recognises, of any
   ecosystem (the eight names in the position table). The kind of lockfile
   does not have to match the kind of manifest: a wrong pairing can only
   make a file fatal;
4. a `package.json` named by the workspace patterns of an install root
   under rule 3, or a `pyproject.toml` named by `[tool.uv.workspace].members`
   and not `exclude` of a `pyproject.toml` beside `uv.lock`, matched as
   `python-sources.ts` matches source scope;
5. the `package.json` in the directory a `file:`, `link:` or `portal:`
   specifier of a parsed `package.json` resolves to (relative to the
   declaring manifest, kept inside the repository), or in the `resolved`
   directory of a `"link": true` entry of a parsed npm lockfile (relative to
   the lockfile's directory).

`node_modules` keeps its 0.14.0 exception: nothing under it is vouched.

"Beside a lockfile of any ecosystem" is the one wording, used here, in
section 3, in INVARIANTS and in the README. It is the wider of the two safe
choices and has the simplest test.

### Which side decides (review B2)

The union is over vouched PATHS, not over rules. Each side applies rules 1
to 5 to its own listing and its own parsed files, giving `vouched(side)`.
Then:

- a parse error on the JUDGED side is fatal when P is in `vouched(judged)`
  or in `vouched(comparison)` for the `--base` or `HEAD` comparison side,
  or when `ignorePaths` does not cover P. The trust base, when it is a
  separate side, contributes `ignorePaths` only, never vouched paths;
- a parse error on a COMPARISON side is fatal when P is in that side's own
  `vouched` set, or when `ignorePaths` does not cover P. The judged side
  never makes a comparison-side error fatal.

Why the asymmetry. A pull request that removes `packages/a` from the root
`workspaces` and breaks `packages/a/package.json` in the same change must
still exit 2: the comparison side's vouching reaches the judged side's
error. But a pull request that FIXES a base-side broken stray and vouches it
(adds a lockfile beside it) must not exit 2 for the base's copy: the base
dropped it under its own `ignorePaths` entry, and the head's new vouching is
a statement about the head. Test T11b pins it.

The sides are the ones `loadStates` loads: the comparison side (`--base`
ref, or `HEAD` for `--staged`) and the judged side. The trust base
contributes control input only (`ignorePaths`), as today; it does not
contribute vouched paths. In audit mode there is one side.

### Rule 5 needs no confirmation

Every input above is subject content, written by whoever opened the pull
request. A claim in any of them can only add a path to the vouched set,
which makes a parse error fatal; none can remove one. That is why a
head-written link entry is taken as written here, unlike the
workspace-local exemption (INVARIANTS, "A link entry is a claim until this
side confirms it"), which removes findings.

### Inputs that are themselves dropped

A manifest that is itself dropped under `ignorePaths` contributes nothing
to rules 2, 4 and 5. That loses nothing: its own path is ignored, and a
path it would have vouched for is either vouched by something else or is a
stray whose own drop needs its own `ignorePaths` entry, whose findings
fact 3 says were filtered anyway.

## 3. Python beside a lockfile

uv compares `pyproject.toml` with `uv.lock` before it installs; poetry
checks the lock's content hash against `pyproject.toml`; pdm does the same;
pipenv's `--deploy` checks the `Pipfile` hash against `Pipfile.lock`. A
pip-tools lock is a requirements file, which never fails to parse. So the
npm and Python cases are alike in what installers read, and rule 3 treats
them alike: a `pyproject.toml`, `Pipfile` or `uv.toml` beside a lockfile of
any ecosystem dep-guard recognises, Python or npm-family, is vouched.

This is a tightening. An ignored unparseable Python manifest beside a lock,
dropped by 0.14.0 with `manifest-unparsed`, now exits 2. So is a
`pyproject.toml` beside a `package-lock.json` (rule 3 does not pair kinds),
which 0.14.0 also let `ignorePaths` drop.

Scope: vouching only. Python lockfiles do not join `LOCKFILE_CANDIDATES`;
the 0.13.0 design keeps them out of every npm lockfile-coverage rule, and
that stands. A separate recognised-lockfile set feeds rule 3.

### Python lockfiles under skipped directory names

`loadPythonLockfiles` reads from `files`, which drops every path under a
skipped directory name unless `isLockfileName` accepts it, and it does not
accept a Python lockfile. So a `uv.lock` under `vendor/` or `build/` is not
read and nothing says so, and the INVARIANTS sentence "a lockfile at any
depth [is] read whatever directory names are on [its] path" is true only of
npm-family lockfiles. This release corrects the sentence (section 11).
Rule 3 is applied to the full listing before the directory-name filter, so
a `vendor/x/pyproject.toml` beside `vendor/x/uv.lock` that does not parse
is fatal even though neither file is read for names; whether such a
project should be read is open point 2.

## 4. Subdirectory scans (review B3)

Today, on `dep-guard scan SUBDIR`, the fatal set is computed from files
under `SUBDIR` only. This design takes the first of the reviewer's two
options: read every classification input in the listing, for
classification only, and promise parity.

### Classification inputs

On a subdirectory scan, dep-guard reads, from the whole listing of each
side, the files rules 1 to 5 need and nothing else:

- the root `package.json` and the root `pnpm-workspace.yaml`;
- every `package.json`, `pnpm-workspace.yaml` and `pyproject.toml` beside a
  recognised lockfile (nested install roots and uv workspace roots);
- every `package.json` in the listing, for its `file:`, `link:` and
  `portal:` specifiers;
- every npm lockfile in the listing, for its `"link": true` entries.

Files outside `SUBDIR` read this way contribute vouched paths and nothing
else: no dependency, no lockfile entry, no finding, and none of the
diagnostics a scanned file raises (`manifest-unparsed`,
`manifest-skipped-dirname`, `symlinked-input`, the lockfile notes). Paths
under `SUBDIR` are scanned exactly as today.

### Fail closed on an unreadable input

An out-of-prefix classification input can fail to be read (it does not
parse, is a symlink, is a gitlink, or for an npm lockfile throws in
`parseNpmLockfile`). Two cases:

- the input would be dropped on a root scan too (a stray `package.json`
  under the comparison side's `ignorePaths`, not vouched): it contributes
  nothing, as on a root scan (section 2, last paragraph);
- the input would stop a root scan (any other case): its contribution is
  unknown, so every manifest under `SUBDIR` is treated as vouched on that
  side for this run, every parse error under `SUBDIR` is exit 2, and one
  `classification-input-unread` note names the file and says the
  subdirectory scan treated every manifest under it as a project because
  of it. The input's own error does not stop the subdirectory scan; a root
  scan reports it.

This covers every input kind in the list: the root manifest, a nested
install root's manifest or `pnpm-workspace.yaml`, a uv workspace root, any
`package.json` read for references, and any npm lockfile read for links.

### The promise

> On `dep-guard scan <path>`, a manifest under the path that does not parse
> is fatal or dropped exactly as on a scan of the repository root. To
> decide which manifests are projects, dep-guard also reads, from outside
> the path, the root `package.json` and `pnpm-workspace.yaml`, every
> manifest and workspace file beside a lockfile, every `package.json` (for
> `file:`, `link:` and `portal:` dependencies) and every npm lockfile (for
> link entries). It reads no dependency and no lockfile entry from them,
> and reports nothing about them except when one cannot be read, in which
> case every manifest under the path is treated as a project.

The same vouched set feeds `readDespiteSkippedName`, so a subdirectory
scan now reads a root workspace member under a skipped directory name
(`packages/build/x`) that it dropped before, as a root scan does. More is
read, so this can add findings; the CHANGELOG lists it.

Cost: a subdirectory scan of a large monorepo now reads every
`package.json` and npm lockfile once, which is what a root scan reads.
Measured on the bench before release; if it matters, open point 3.

## 5. The bench

npm/cli and eslint become measurable through a per-repository bench
override of `ignorePaths`, stated in the row. The ruling keeps exit 2 as
the default, so without an override these two rows stay skips for good and
the bench loses its two largest npm workspace shapes.

### Row fields

In `bench/repos.public.json`, a row may carry:

- `config`: an object whose only allowed key is `ignorePaths` (an array of
  strings). Any other key makes the bench exit non-zero before cloning.
- `configNote`: a required string when `config` is present, which must say
  that the upstream repository does not carry this configuration and why
  the bench applies it.

The harness writes `config` into the clone as `.dep-guard.json` before the
scan (the CLI has no config flag; audit mode reads config from the git
root). If the clone already has a `.dep-guard.json` or a
`.dep-guard.local.json` (which `config.ts` overlays on top of it) at the
pinned SHA, the bench refuses the row: it never overwrites or overlays an
upstream configuration. The baseline row records `configApplied` (the
object, verbatim) and `configNote`, so a reader of
`bench/baseline.public.json` sees the override without opening the
repository list, and a `--compare` run reports drift when `configApplied`
differs from the row's `config`, a missing one on either side included (a
row with config against a baseline row without `configApplied`, and the
reverse).

### The two rows

The entries are the narrowest paths that clear each repository, taken from
the one-exit-2 error list of section 6 at the pinned SHA, never a whole
`test` directory: `ignorePaths` also filters findings under those paths,
so a wide entry would drop real measurement. The implementer records the
list. If npm/cli's arborist fixtures hold several broken manifests, each
gets its own fixture directory entry. If one of them is vouched (beside a
lockfile, say), no entry can clear it and the row keeps `expectSkip` with a
`skipNote` naming that path. Otherwise both rows drop `expectSkip` and
`skipNote` and are re-recorded.

Example (path to be confirmed by the run at the pinned SHA):

    "config": { "ignorePaths": ["tests/fixtures/config-file/broken-package-json"] },
    "configNote": "eslint does not carry this ignorePaths entry upstream. The bench applies it so the repository can be measured: the fixture is deliberately missing its closing brace, and dep-guard stops on an unparseable stray manifest unless ignorePaths covers it. Findings under this path are filtered as a result."

## 6. Every fatal parse error in one exit 2

`loadState` today throws from three sites: the root manifest parse, the
root workspace member parse (both outside the catch), and the catch around
the remaining manifests; and `loadStates` loads the comparison side before
the judged side, so a comparison-side error hides every judged-side one.

New behaviour: each `loadState` collects every manifest parse failure from
all three sites into a list, with the path, the class, the position (from
section 2's rules) and the side, and continues loading. Lockfiles and the
rest of the state still load, but nothing is judged. `loadStates` loads
every side, then, when any side's list holds a fatal entry, throws one
`DepGuardError` with code `manifest-parse` whose message lists up to ten
entries in a fixed order (judged side first, then comparison; root, then
members, then the rest; then path) and a count of the rest. A failure that
is not a manifest parse failure (a lockfile parse error, a symlinked input,
an unexpandable workspace glob) keeps its current throw and code.

The real CLI output (`reportError`, `cli.ts`, prints `dep-guard: <message>
(<code>)` to stderr and sets exit 2):

    dep-guard: 3 manifests do not parse and stop the scan: packages/broken/package.json (judged side): not valid JSON; some package managers accept JSON with comments, trailing commas or text after the value, so this file may still install; a root workspace member is a project and stops the scan whatever ignorePaths says. | tools/x/package.json (judged side): "pnpm" field is not an object; it is valid JSON, so a package manager may install from it; fix the file, or cover it with ignorePaths on the base branch. | test/old/package.json (the --base ref "base"): not valid JSON; some package managers accept JSON with comments, trailing commas or text after the value, so this file may still install; fix the file on the base branch, or cover it with ignorePaths there. (manifest-parse)

Each entry is `path (side): reason; class clause; position or fix
clause.` (as implemented; the class clause always comes second). A
judged-side entry protected only by the comparison side names it ("a root
workspace member on the --base ref "base" is a project ..."). On an audit,
with no comparison side, the fix clause is "fix the file, or cover it with
ignorePaths". A TOML syntax failure has no class clause; a TOML shape
failure says "it is valid TOML, so a package manager may install from it".
On a subdirectory scan with an unread classification input the position
clause is "every manifest under PATH, because FILE outside it could not be
read, is a project and stops the scan whatever ignorePaths says".

The comparison-side wording matters. A comparison-side error that stops
the run stops every pull request against that base until the base is
fixed, which is already true today: a broken stray on `main` with no
`ignorePaths` entry makes every pull request red until a pull request to
`main` fixes the file or adds the entry, and that pull request is judged
against the same broken base. The message says "on the base branch" so the
reader knows the pull request in hand cannot fix it.

## 7. The content echo

`manifest.ts` line 209 builds `dependency "${name}" in "${depType}" has a
non-string specifier`, where `name` is a key from the file. A fixture or a
hostile manifest can make that key anything, including a token, and the
message is printed on every surface an exit 2 reaches (stderr, the
umbrella's `conductor/gate-failed` text). `sanitizeText` in the CLI strips
control characters; it does not shorten a secret.

Fix: print only the key's leading run of npm-name characters (ASCII
letters, digits, `.`, `_`, `~`, `-`, `@`, `/`), at most 214 characters
(npm's name limit), with `...` when anything was cut: the rule
`invalidNameFragment` (`python-names.ts`) applies to Python names, widened
to the npm character set. `depType` is from the fixed `DEP_TYPES` list and
needs nothing. The other `manifest-parse` messages in `manifest.ts` and
`python-manifest.ts` already print only fixed text or a fragment.

## 8. Trust boundary

- **The ignore list comes from the comparison side.** Unchanged:
  `ignorePaths` is read from `controls.config`, the trust base's on a
  `--trust-base` run, so a head that adds an entry for its own broken file
  still exits 2.
- **No new config key.** Nothing in this design is switchable.
- **Head content can only make a file more fatal.** Every vouching input is
  subject content; a claim can only add a path (section 2).
- **Un-vouching on the head does not help.** The comparison side's vouched
  paths reach the judged side's errors.
- **Vouching on the head does not reach back.** The judged side's vouched
  paths never make a comparison-side error fatal.
- **Messages carry no file content.** Path, class, position and side only;
  dependency keys as fragments (section 7).
- **The bench override is not a dep-guard control.** It is a harness input
  for measurement, written into a throwaway clone, recorded in the row and
  the baseline, and never read by a user's run.

### Residual

- A stray manifest that a workflow installs from (bun reading text
  dep-guard cannot parse, or any installer run in a directory dep-guard
  does not see as a project) is dropped only when the comparison side's
  `ignorePaths` covers it, and then its findings were filtered anyway.
  Without the entry the run stops. This is the 0.14.0 residual, stated
  rather than widened.

## 9. Every output surface

### Text

The exit 2 message of section 6 on stderr. No new note on a successful
root scan. The one new note, `classification-input-unread`, appears only on
a subdirectory scan:

    note classification-input-unread: package.json: outside the scanned directory tools and could not be read to decide which manifests are projects, so every manifest under tools was treated as a project for this scan

`manifest-unparsed` keeps its 0.14.0 text.

### JSON

- A run that stops has no JSON result, as today; the CLI exit 2 path is
  unchanged in shape.
- `run.diagnostics` may carry `classification-input-unread`, a new
  additive code.
- `run.ecosystems.npm` and `run.ecosystems.pypi` gain `notParsed`, the
  count of manifests dropped under `ignorePaths`, always present, additive.

### SARIF

No change. Diagnostics never become SARIF results (`output-sarif.ts`, the
comment above `SARIF_TRUST_BASE_NOTIFICATION_ID`), and a stopped run
produces no SARIF log, as today.

### The umbrella

- A stopped run reaches the umbrella's could-not-run path,
  `conductor/gate-failed`, carrying dep-guard's message; the longer
  message is still one gate failure.
- `classification-input-unread` prints as a `note <code>: <message>` line
  (conductor `output-text.ts`) and never becomes a finding or a blocking
  count.
- No verdict moves except through the new exit 2s, which arrive as
  `conductor/gate-failed`.

## 10. Test plan

Tests live in `packages/core/tests/nested-manifests.test.ts` beside the
0.14.0 ones, which all keep passing unchanged (none places a Python
manifest beside a Python lock, and each has one broken file, so the
one-exit-2 list changes none of their assertions). Each test runs a real
git repository through `scan`, as the existing ones do, and asserts the
exit code or thrown code, the paths named, and the absence of the
fixture's bytes from the message.

### Vouched positions

- **T1** an ignored `build/package.json` that does not parse beside
  `build/package-lock.json`: exit 2 (0.14.0, unchanged).
- **T2** an ignored root workspace member that does not parse: exit 2
  (0.14.0, unchanged).
- **T3** an ignored member named by a nested install root's patterns:
  exit 2 (0.14.0, unchanged).
- **T4** an ignored `tools/x/package.json` that does not parse, named by
  `"x": "file:./tools/x"` in the root manifest: exit 2; the same named by
  `link:` and by `portal:`.
- **T5** an ignored `tools/x/package.json` that does not parse, recorded as
  the `resolved` directory of a `"link": true` entry in the root
  `package-lock.json`, with no specifier naming it: exit 2.
- **T6** control: an ignored stray that does not parse and that nothing
  names: dropped with `manifest-unparsed` (0.14.0, unchanged).
- **T7** the measured bun shape, `{"dependencies": {"reqeusts": "1.0.0"}}
  x`, as an unignored stray: exit 2 (pins the ruling: no default drop for
  anything that fails to parse).

### Python

- **P1** an ignored `pyproject.toml` that is not TOML beside `uv.lock`:
  exit 2. One row each for `poetry.lock` and `pdm.lock`; a `Pipfile`
  beside `Pipfile.lock`; a `uv.toml` beside `uv.lock`; a `pyproject.toml`
  beside `package-lock.json`.
- **P2** a `pyproject.toml` beside `uv.lock` with `members = ["libs/*"]`;
  `libs/a/pyproject.toml` not TOML and ignored: exit 2. Control: an ignored
  `tools/b/pyproject.toml`, not a member: dropped.
- **P3** an ignored shape-broken `pyproject.toml` beside `uv.lock` (a
  non-array `[dependency-groups]` entry): exit 2, message names the shape
  class.
- **P4** an ignored `vendor/x/pyproject.toml` that is not TOML beside
  `vendor/x/uv.lock`: exit 2 (rule 3 runs before the directory-name
  filter).

### Sides (review B2)

- **T11** base has `packages/a` in the root `workspaces` and a valid
  `packages/a/package.json`, and `ignorePaths` covering `packages/a`; head
  removes it from `workspaces` and breaks it. Under `--base` and under
  `--trust-base`: exit 2. Audit of the head alone: dropped.
- **T11b** base has an ignored broken stray `tools/x/package.json`; head
  fixes it and adds `tools/x/package-lock.json`. Under `--base`: no exit 2;
  the base copy is dropped with `manifest-unparsed` on the comparison side,
  and the head's dependencies in `tools/x` are all added.
- **T12** base has an ignored broken stray; head fixes it with a `reqeusts`
  dependency: the dependency is a candidate and reaches the name checks.

### Subdirectory scans (review B3)

- **S1** root `workspaces: ["packages/*"]`; `packages/a/package.json`
  broken and ignored; `scan packages`: exit 2.
- **S2** root lockfile and root `workspaces` naming `packages/a`; `scan
  packages/a`, `packages/a/package.json` broken and ignored: exit 2.
- **S3** root `package.json` not JSON; `scan tools`, an ignored broken
  stray under `tools`: exit 2 and `classification-input-unread` naming
  `package.json`. Control: `scan tools` with every file under `tools` valid
  and the root broken: exit 0, the same note, and no `manifest-parse` for
  the root.
- **S4** an out-of-prefix `file:` reference: `apps/web/package.json` has
  `"x": "file:../../tools/x"`; `scan tools` with `tools/x/package.json`
  broken and ignored: exit 2.
- **S5** an out-of-prefix link entry: the root `package-lock.json` has a
  `"link": true` entry resolving to `tools/x`; `scan tools`, same file:
  exit 2.
- **S6** an out-of-prefix nested install root whose `pnpm-workspace.yaml`
  does not parse; `scan tools`, an ignored broken stray under `tools`:
  exit 2 and the note naming the YAML file. The same for a
  `pyproject.toml` beside `uv.lock` outside the prefix that is not TOML,
  and for an out-of-prefix npm lockfile that throws.
- **S7** an out-of-prefix ignored broken stray `package.json` (droppable on
  a root scan): `scan tools` with an ignored broken stray under `tools`:
  dropped, no note (the first case of section 4).
- **S8** `scan packages` with a root workspace member under
  `packages/build/x` declaring `reqeusts`: the dependency is read.
- **S9** out-of-prefix files raise no scanned-file diagnostics: a `scan
  tools` run over a tree whose `build/` holds a stray manifest emits no
  `manifest-skipped-dirname` for it.

### One exit 2

- **E1** under `--base`: a shape-broken root `package.json` (so its
  workspaces still name members), a broken root workspace member and a
  broken unignored stray on the judged side, and a broken unignored stray
  on the base: one `manifest-parse` error whose message names all four
  paths, each with its side, in the section 6 order. The root entry is
  what turns the "skip collecting site 1" mutation red.
- **E2** eleven broken strays: the message lists ten and says "and 1
  more".
- **E3** a lockfile parse error beside a broken stray: the lockfile's own
  error and code win, as today.

### Messages

- **M1** a BOM-prefixed shape-broken file (a byte order mark, then
  `{"pnpm": "x"}`) beside a lockfile under an ignore entry: exit 2, and the
  message names the shape class (the BOM is stripped before the class is
  decided, as `parseManifest` strips it).
- **M2** a dependency key `tok_SECRET-123 abc` followed by a control
  character, with a numeric specifier, in an unignored stray: exit 2; the
  text after the fragment (` abc`) and the control character appear
  nowhere in the message.
- **M3** no message contains text from the fixture body: the npm/cli shape
  under every vouched position, asserting `NOPE` is absent.

### Bench

- **B1** a row with `config` and no `configNote`: the bench exits non-zero
  before cloning.
- **B2** a row whose `config` has a key other than `ignorePaths`: same.
- **B3** a clone that already carries `.dep-guard.json`, or
  `.dep-guard.local.json`, with a row that has `config`: the row is
  refused.
- **B4** the baseline row carries `configApplied` and `configNote`, and a
  `--compare` against a baseline whose `configApplied` differs reports
  drift, in both directions: a row with config against a baseline row
  without `configApplied`, and a row without config against one with it.
- The existing vocabulary test covers `classification-input-unread`.

### Mutations that must turn a test red

| Mutation | Red test |
|---|---|
| any default drop for a file that fails to parse | T7 |
| keep `vouchedFor` limited to `package.json` | P1, P2 |
| pair rule 3 by ecosystem (Python manifests only beside Python locks) | P1 (`package-lock.json` row) |
| build rule 3 from `isLockfileName` only | P1 (Python lock rows) |
| apply rule 3 after the directory-name filter | P4 |
| drop rule 4's uv members | P2 |
| drop rule 5's specifiers | T4 |
| drop rule 5's link entries | T5 |
| judged side's vouching only | T11 |
| apply the union to comparison-side errors too | T11b |
| compute vouching from `filesInPrefix` | S1, S2, S4, S5 |
| treat an unreadable out-of-prefix input as contributing nothing | S3, S6 |
| fail closed on an out-of-prefix input a root scan would drop | S7 |
| emit scanned-file diagnostics for classification reads | S9 |
| throw on the first parse error | E1 |
| stop loading sides after a comparison-side error | E1 |
| fold a lockfile error into the manifest list | E3 |
| decide the class before stripping the BOM | M1 |
| print the raw dependency key | M2 |
| echo parser text | M3 |
| skip collecting site 1 (the root manifest) | E1 |
| accept a bench `config` without `configNote` | B1 |
| check only `.dep-guard.json` in the clone | B3 (`.dep-guard.local.json` row) |
| treat a missing `configApplied` as no drift | B4 (both directions) |
| read `ignorePaths` from disk instead of the trust base | the 0.14.0 `--trust-base` test |

Each mutation is applied and shown red before the branch is called done,
and the INVARIANTS entry lists them.

## 11. INVARIANTS, CHANGELOG, README

### INVARIANTS

Rewrite the 0.14.0 sentences in the nested-manifests paragraph (from "A
stray manifest of any ecosystem that does not parse" to the end of its
test list) as:

- A manifest that does not parse is exit 2 unless it is a stray that
  `ignorePaths` from the comparison side covers, in which case it is
  dropped with `manifest-unparsed`. There is no default drop. Reason, as
  measured in review: bun 1.3.10 installs from a `package.json` with
  comments, trailing commas, single quotes, hex or leading-dot numbers, and
  arbitrary text after the first complete value, all of which fail
  `JSON.parse` and the last of which fails any JSONC reader; npm 10.9.8
  and pnpm 9.15.9 refuse all of them. "Not JSON" is therefore not "not
  installable", and no syntax test separates a broken fixture from a file
  bun installs from.
- A manifest is vouched, and stops the scan when it does not parse whatever
  `ignorePaths` says, when it is the root `package.json`; a root workspace
  member; in a directory with a lockfile dep-guard recognises, of any
  ecosystem (npm, pnpm, yarn, bun, `uv.lock`, `poetry.lock`, `pdm.lock`,
  `Pipfile.lock`); named by the workspace patterns of such an install root,
  or by `[tool.uv.workspace].members` of a `pyproject.toml` beside
  `uv.lock`; or the target of a `file:`, `link:` or `portal:` specifier or
  of a `"link": true` npm lockfile entry. pnpm `importers` and `yarn.lock`
  workspace entries are not inputs.
- Each side computes its own vouched paths. A judged-side error is fatal
  when the judged side or the `--base` or `HEAD` comparison side vouches
  for the path; a comparison-side error only when that side does. The
  trust base contributes `ignorePaths` only.
- The vouched set is computed from the whole listing whatever the scan
  prefix; out-of-prefix files are read for classification only and raise
  no diagnostics except `classification-input-unread`, and an unreadable
  input that would stop a root scan makes every manifest under the prefix
  vouched.
- Every fatal manifest parse error of every side is reported in one exit 2,
  ten paths at most. No exit 2 message carries parser text or a raw key
  from the file.

Correction: the sentence "a lockfile at any depth [is] read whatever
directory names are on [its] path" becomes "an npm-family lockfile at any
depth is read whatever directory names are on its path; a Python lockfile
under a skipped directory name is not read, though it still vouches for the
manifest beside it."

New diagnostic code: `classification-input-unread`.

### CHANGELOG for 0.15.0

    ## [0.15.0] - YYYY-MM-DD

    No verdict is loosened. A manifest that does not parse still stops the
    scan by default; ignorePaths on the base branch remains the way to
    clear a broken test fixture. The default stays fatal because bun
    installs from package.json files that are not JSON (comments,
    trailing commas, text after the value), so "not JSON" does not mean
    "not installable". The changes below can only add an exit 2, which
    can turn a green run red.

    What can newly stop a scan (exit 2), and how to clear each

    - A pyproject.toml, Pipfile or uv.toml that does not parse, beside
      uv.lock, poetry.lock, pdm.lock, Pipfile.lock or an npm-family
      lockfile, or named by a uv workspace's members, now stops the scan
      whatever ignorePaths says, as a package.json beside its lockfile
      already did. 0.14.0 dropped it when ignorePaths covered it. Fix the
      file.
    - A pyproject.toml under a skipped directory name beside a Python
      lockfile, such as vendor/x/pyproject.toml beside vendor/x/uv.lock,
      was never parsed before (readDespiteSkippedName promoted past the
      skipped-directory filter only for npm-family install roots). Under
      rule 3 it is now parsed and stops the scan when it does not parse,
      with no ignorePaths entry involved. Its dependencies are still not
      read. Fix the file.
    - A package.json that is the target of a file:, link: or portal:
      dependency, or of a link entry in an npm lockfile, now stops the scan
      when it does not parse, whatever ignorePaths says. Fix the file.
    - On dep-guard scan <path>, a manifest under the path that does not
      parse is fatal or dropped exactly as on a scan of the repository
      root: a root workspace member, a member of an install root above the
      path, or a reference target under the path that ignorePaths covers
      now stops the scan. When a file outside the path that decides this
      cannot be read, every manifest under the path that does not parse
      stops the scan, and classification-input-unread names the file.
    - A pull request that removes a manifest from the base's workspaces,
      lockfile directory or references and breaks it in the same change
      stops the scan.

    Changed

    - Every manifest that stops the scan, on every side, is listed in one
      error (ten at most, then a count), with the side and the reason,
      instead of the first one only. The exit code is unchanged.
    - A manifest-parse message no longer prints a dependency key in full;
      it prints the key's leading name characters.
    - dep-guard scan <path> now reads a root workspace member under the
      path whose path has a skipped directory name (build, vendor and the
      rest), as a scan of the repository root does. This can add findings.

    Added

    - run.ecosystems.npm.notParsed and run.ecosystems.pypi.notParsed count
      manifests dropped because ignorePaths covers them.
    - Dogfood bench: a row may carry a config object (ignorePaths only)
      with a required configNote saying the upstream repository does not
      carry it; the baseline records it as configApplied. eslint is
      measured this way and is no longer skipped; npm/cli stays skipped
      on a broken fixture lockfile (see "Implementation notes").

### README

Replace the 0.14.0 sentences in the nested-manifests paragraph, from "That
includes a fixture `package.json` that does not parse" to "whatever
`ignorePaths` says.", with:

> A manifest that does not parse stops the scan and names the path. The
> one way to clear a broken fixture is an `ignorePaths` entry on the base
> branch, which skips it with a `manifest-unparsed` note, and that works
> only for a stray. The root `package.json`, a workspace member, a manifest
> with a lockfile beside it (npm, pnpm, yarn, bun, `uv.lock`,
> `poetry.lock`, `pdm.lock`, `Pipfile.lock`), one named by such a
> directory's workspace patterns or by a uv workspace's `members`, and the
> target of a `file:`, `link:` or `portal:` dependency or of an npm
> lockfile link are projects, and stop the scan whatever `ignorePaths`
> says. There is no default skip for a file that is not JSON, because bun
> installs from some files that are not. A broken manifest on the base
> branch with no entry stops every pull request against it until the base
> is fixed.

And replace "`dep-guard scan <path>` reads manifests under that directory
and nothing above it" with:

> `dep-guard scan <path>` reads dependencies and lockfile entries under
> that directory and nothing above it. To decide which manifests under it
> are projects, it also reads the root `package.json` and
> `pnpm-workspace.yaml`, the manifests and workspace files beside every
> lockfile, every `package.json` and every npm lockfile in the repository,
> and reports nothing about them unless one cannot be read
> (`classification-input-unread`).

## Implementation notes (2026-10-18)

Recorded by the implementer where the code departs from, or makes
precise, the text above.

- **Bench, npm/cli.** At the pinned commit the scan now stops on
  `workspaces/arborist/test/fixtures/conflict-package-lock/package-lock.json`
  (`lockfile-parse`, a deliberately broken npm lockfile). 0.14.0 threw on
  the first broken manifest before lockfiles were read and hid it; with
  every manifest failure collected, the lockfile error keeps its own code
  (E3). No `ignorePaths` entry clears a lockfile parse error, so the row
  keeps `expectSkip` (now `lockfile-parse`) with a `skipNote` naming that
  path, and gets no `config`: its manifest listing is not observable while
  the lockfile error stops the scan first. Whether a broken fixture
  lockfile should be clearable is its own change.
- **Bench, eslint.** The listing names two strays,
  `tests/fixtures/config-file/broken-package-json/package.json` and
  `tests/fixtures/ignored-paths/broken-package-json/package.json`; the row
  carries both directories and is measured.
- **Promotion.** The project set feeds the skipped-directory-name filter
  except for a manifest that is a project only through a Python lockfile
  beside it, or as a uv workspace member (open point 2): those are parsed
  for fatality only. A `file:`, `link:` or `portal:` target and a lockfile
  link target are promoted, so they are now read under a skipped name on a
  root scan too; the CHANGELOG lists it.
- **Classification inputs on a root scan.** The same inputs are read on a
  root scan, so every `package.json` outside `node_modules` is parsed for
  references, including strays under skipped directory names (which are
  still not read for names). Each path is read and parsed once per side.
- **Out-of-prefix symlinks.** A symlinked out-of-prefix input is unread on
  the judged side (a root scan refuses it) and contributes nothing on a
  comparison side (a root scan treats it as absent). Both paths, and the
  quiet suppression of diagnostics from out-of-prefix reads, are tested
  (S9 `path-outside-root`, S10).
- **Root workspace members by parse site (fix round, review blocker).**
  Rule 2 matches patterns against the listing, but the workspace walk can
  reach a member the listing shows under no pattern: a symlinked member
  directory resolves to its real path on the working tree, a gitignored
  directory present on disk is listed by readdir and not by git, and
  case-insensitive expansion under `core.ignorecase` matches spellings the
  listing does not. Such a member got no position and an `ignorePaths`
  entry dropped it, a loosening against 0.14.0 (reproduced with a symlink
  `packages/evil` to `../fixtures/evil` holding the bun shape, under
  `--base` plus `--trust-base`). Ruled: every failure collected by the
  walk is a root workspace member, and the root manifest the root, whatever
  the classification says.
- **Trust base and project paths.** T13 pins that a separate trust base
  which alone counts a path as a project does not make it fatal, with a
  control where the `--base` side does.
- **M3.** On Node 22 the npm/cli body (`{` then `NOPE`) gives a `JSON.parse`
  error that does not quote the input, so M3 also runs every position with
  `{"dependencies": NOPE}`, which V8 does quote; only that body turns the
  echo mutation red.
- **The trust base's own failures.** When the trust base is a separate
  side, its own parse failures are decided by its own project set and
  thrown as a `manifest-parse` listing of their own, after the `--base`
  and judged sides have settled.
- **`ignore-path-unmatched` (fix round, ruled).** An `ignorePaths` entry
  whose only effect is to drop an unparsed manifest, on the judged or the
  comparison side, counts as a match and is no longer reported as
  unmatched. eslint's bench row moved from 2 such notes to 0.
- **Skipped-name note (fix round).** A manifest under a skipped directory
  name that is parsed for fatality only gets a `manifest-skipped-dirname`
  note saying so, instead of the text saying no lockfile sits beside it.

## Open points

1. **The bench entries.** Recommended default: the narrowest fixture
   directories the one-exit-2 list names at the pinned SHA, one entry per
   directory, re-recorded with the new rows; a vouched broken fixture keeps
   its row as `expectSkip` with the path named.
2. **Reading Python lockfiles under skipped directory names.** Recommended
   default: out of scope; this release corrects INVARIANTS and makes such
   a lockfile vouch its manifest. Whether its names are checked, and
   whether its manifest is promoted past the directory-name filter as an
   npm one is, is its own change.
3. **Cost of classification reads on a subdirectory scan.** Recommended
   default: ship as designed; if the bench shows a subdirectory scan of a
   large monorepo costing noticeably more than before, cache the
   classification per side within a run rather than narrowing the inputs.
4. **Union over a separate trust base.** Recommended default: the trust
   base contributes control input only, as today; the comparison side
   already carries the vouching that matters for the un-vouch-then-break
   case.
