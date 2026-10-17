# Python name checks against PyPI

Status: approved design, implemented on the 0.13.0 branch; the four
final-approval notes are folded in below and marked. Target release 0.13.0 (minor). Two parts
ship together: (a) every run says which ecosystems had their names checked
and which were read but not checked, and (b) with `--online`, a PyPI
existence check for Python names from requirements files, `pyproject.toml`,
`Pipfile` and the poetry, uv, pdm and pipenv lockfiles, under the same
budget and degrade rule as the npm online checks. A shipped PyPI corpus
stays deferred.

## What is wrong today

Python manifests are read and every name check skips them without a word.

- `python-manifest.ts` gives every named requirement the protocol `pypi`
  (`requirementToDep`, `poetrySpecifier`, `poetryDeps`).
- `checks/candidates.ts` admits only `registry` and `alias`
  (`NAME_PROTOCOLS`), so `newRegistryNames` drops every `pypi` dependency
  before existence, typosquat, registered-squat or the online
  unknown-package resolution sees it. Nothing records the drop.
- `--online` therefore makes no lookup for a Python name:
  `run.online.lookupsAttempted` is 0.
- `delta.ts` excludes `pypi` dependencies from lockfile coverage
  (`declaredLockableDeps`), and no Python lockfile is in
  `LOCKFILE_FILE_NAMES`, so a Python-only repository has no lockfile in the
  inventory and gets `lockfile-missing` whether or not it carries a fully
  pinned requirements file or a uv or poetry lock.

Reproduced on a Flask service with range-specified requirements: two typo
names appended to its `requirements.txt`, then `dep-guard scan --online`,
printed "No findings" with `lookupsAttempted: 0`, while `dep-guard check`
on one of the same names printed a high unknown-package (that verdict is
the npm corpus judging the string as an npm name, which is a separate
problem; see open point 9).

The defect class is the one 0.12.0 closed three times: a filter deciding
coverage with no diagnostic. The fix below makes the filter exhaustive and
every exclusion counted, before it adds any new signal.

## 1. Name normalisation

### Rule

A Python project name is compared in its PEP 503 normalised form: lower
case, and every run of `-`, `_` and `.` collapsed to one `-`.
`Django_REST.framework` and `django-rest-framework` are one project.

The normalised form is computed once, in the parser, and stored as the
dependency's `registryName` for protocol `pypi`; `name` keeps the text as
written. It is then the only form used for:

- the lookup URL;
- any cache key (none in 0.13.0, see section 4);
- every distance or transform comparison (section 5);
- dedupe, inside a manifest (`newRegistryNames`' `[manifestPath,
  registryName]` key) and across manifests and lockfiles (one lookup per
  normalised name per run);
- the delta key: `depKey` uses `registryName` for a `pypi` dependency, so
  re-casing `Flask` to `flask`, or `python_dateutil` to `python-dateutil`,
  is not an added dependency;
- `allow` and `internalPrefixes` matching (section 7);
- the finding's `packageName`, which is the fingerprint's identity
  component, so a re-cased line keeps its baseline entry.

Normalise with a loop, not a regular expression, the way `typosquat.ts`
treats every name as attacker-controlled. The PEP 508 name pattern
(`REQUIREMENT_NAME`) admits only ASCII letters, digits, `.`, `_` and `-`,
so lower-casing is ASCII lower-casing, but today only the requirement-string
path applies it: poetry table keys (`poetryDeps`) are taken as written, and
so would the new `Pipfile` keys, `[tool.uv.sources]` keys and lockfile
names be. In 0.13.0 the same pattern is applied to every name source before
a name is stored; a name that fails it is not looked up, is counted under
`excluded.invalidName`, and is named in a `python-name-invalid` diagnostic.
The diagnostic prints only the string's leading run of name characters
(with "..." when anything was cut), never the rest: an invalid requirement
string such as `_x @ git+https://user:TOKEN@host/r.git` carries a token
after the name, and the text before an `@` is no safer (fix round 1, B2).
A TOML requirement list entry starting `-e` or `--editable` (PDM writes
local dev projects as `-e file:///${PROJECT_ROOT}/x#egg=x`) has the option
stripped and is counted under `excluded.editable`, a VCS or remote target
staying a git or url dependency (N5).
The URL path segment is percent-encoded (`encodeURIComponent`) even though
a valid normalised name never needs it, so a parser bug cannot become a
path or query injection.

`git` and `url` Python dependencies keep their written `registryName` in
0.13.0. They already reach `checks/tamper.ts` (git-source, url-source) and
`checks/install-script.ts` keyed on `registryName`, so normalising them
would re-key existing baselined findings. Normalising them is open point 6.

### What the user sees

The name as written. When the normalised form differs, it is added once:
`"Python_Dateutil" (PyPI project "python-dateutil")`. `details.writtenName`
carries the written text and `details.ecosystem` is `"pypi"`.

## 2. Candidates

### Files

| File | Read today | 0.13.0 |
|---|---|---|
| `requirements.txt` (exact basename, any depth) | yes | unchanged |
| other requirements files | no | read: a `.txt` basename starting with `requirements` or ending in `requirements.txt` (`requirements-dev.txt`, `dev-requirements.txt`), any `.txt` directly in a directory named `requirements`, and `requirements.in` |
| files named by `-r` / `--requirement`, in every spelling pip accepts (below) | no (`isRequirementsOption` skips the line) | followed, relative to the including file, inside the scan root, never through a symlink, at most 8 levels, each file read once |
| files named by `-c` / `--constraint`, every spelling | no | read, but their names are not candidates: a constraint never installs a name by itself. Counted under `excluded.constraint` |
| `pyproject.toml` `project.dependencies`, `project.optional-dependencies` | yes | unchanged |
| `pyproject.toml` poetry tables (`dependencies`, `dev-dependencies`, `group.*.dependencies`) | yes | unchanged, plus a `source` key naming a poetry source (section 7) |
| `pyproject.toml` `[dependency-groups]` (PEP 735) | no | read; an `{include-group = ...}` table is followed inside the same file, not read as a name (today `stringArray` would throw on it) |
| `pyproject.toml` `build-system.requires` | no | read; a build frontend fetches these from the index |
| `pyproject.toml` `[tool.uv]` `dev-dependencies`, `[tool.pdm.dev-dependencies]` | no | read |
| `pyproject.toml` `[tool.uv.sources]` | no | read, rewrites the protocol of the names it covers (below) |
| `Pipfile` `[packages]`, `[dev-packages]` | no | read as a manifest |
| `poetry.lock`, `uv.lock`, `pdm.lock`, `Pipfile.lock` | no | read for names only |

The new requirements file names become manifests exactly like
`requirements.txt`, with the same `ignorePaths`, skipped-directory and
symlink rules. That has a consequence beyond names: a git or url line in
one of them now reaches the tamper check's git-source and url-source
signals, which can newly block (CHANGELOG below). The same holds for every
other newly read table: a `name @ git+...` string in `build-system.requires`,
`[dependency-groups]` or the uv and pdm dev tables, a git or path entry in
a `Pipfile`, and a `[tool.uv.sources]` git or url rewrite all become tamper
subjects. Each new TOML table is read through `stringArray` or a table
reader that raises `manifest-parse` on a malformed value
(`python-manifest.ts`, `stringArray`), and a `Pipfile` that is not valid
TOML is a `manifest-parse` could-not-run like a bad `pyproject.toml`: these
are new exit 2 surfaces, cleared by fixing the file or by `ignorePaths` on
the comparison side, and the CHANGELOG lists them.

### Requirements lines: option spellings and the unread-line count

pip accepts an option with a space, with `=`, or (short forms) glued to its
value, and accepts a tab as the separator: `-r more.txt`, `-r\tmore.txt`,
`--requirement=more.txt`, `-rmore.txt`, and likewise `-c`, `-i`,
`--index-url=`, `--extra-index-url=`, `-f`, `--find-links=`. pip reads
these lines through optparse, which also accepts any unique abbreviation of
a long option (`--requ=x.txt`, `--extra-index https://...`), so the reader
recognises a unique prefix of every long option pip's requirements-file
parser knows, the same way; an ambiguous prefix is an unrecognised line.
pip also expands `${VAR}` references in requirements lines from the
environment, which dep-guard cannot see. A line containing an unexpanded
`${...}` reference is not guessed at: it is counted under
`excluded.unrecognised` and named in `requirements-line-unread` with its
own wording ("contains an environment variable reference, which pip expands
at install time; this line was not read"). Today `isRequirementsOption` matches only the space-separated long and short
forms, so `--requirement=more.txt` and `-rmore.txt` fall through to
`requirementToDep`, match no pattern and return null: no dependency, no
option, no count, and the included file is never read. A pull request could
put a typo name in a file no pattern matches and reach it that way. In
0.13.0 the option reader parses all of those spellings for every option
whose value matters (`-r`, `-c`, the four index options), and every
logical line that yields neither a dependency nor a recognised option is
counted under `excluded.unrecognised` and named, with its file and line
number, in a `requirements-line-unread` diagnostic. A URL line with no
`#egg=` is no longer dropped (today `requirementToDep` returns null for it,
which also hides it from tamper): it becomes a `url` or `git` dependency
whose name is the URL's host plus its last path segment (never the full
URL, which may carry a token), so the tamper url-source or git-source
signal sees it, and it is counted under `excluded.url` or `excluded.vcs`.

### Which text the path and archive test reads

`requirementToDep` receives the whole logical line, per-requirement options
included (`--hash`, `--config-settings`, `--global-option`), and
`isRequirementsOption` only filters lines that start with an option. A path
test run on that whole line would read `reqeusts==2.31
--config-settings=x=a/b` as a path because of the slash in the option
value, mark it `file`, and never look it up, while pip installs `reqeusts`
from PyPI. So the tests follow pip's own order (its requirement
constructor, with `_looks_like_path` and `is_archive_file`), each run on
the string pip itself tests:

1. strip a leading `-e` / `--editable`;
2. split off per-requirement options: the text from the first whitespace
   that is followed by `-` is not part of the requirement;
3. split off the environment marker at `;`;
4. **URL and direct-reference branches first.** A `name @ <url>` direct
   reference, and a string starting with a URL scheme pip's `is_url`
   accepts (`https:`, `http:`, `file:`, `ftp:`, and every VCS scheme pip
   knows: `git:`, `git+`, `svn:`, `svn+`, `hg+`, `bzr+`; plus `ssh:`), are
   classified here as `url` or `git`, before any path or archive test,
   compared case-insensitively. A bare https line therefore never becomes
   `file`, so it never drops out of the delta (`file` is an exempt
   protocol, `delta.ts` `EXEMPT_PROTOCOLS`) and never escapes tamper; nor
   does a bare `ftp://` or `svn://` line (final-approval note 2);
5. strip the extras bracket and KEEP the version specifier. The archive
   test reads this whole string: it is an archive only when the string ends
   in one of pip's archive extensions (`.whl`, `.zip`, `.tar.gz`, `.tgz`,
   `.tar`, `.tar.bz2`, `.tbz`, `.tar.xz`, `.txz`, `.tlz`, `.tar.lz`,
   `.tar.lzma`), compared case-insensitively, as pip's is: a bare
   `pkg.ZIP` is an archive, not the name `pkg-zip` (final-approval note
   1). PyPI names may contain dots, so `reqeusts.zip==1.0` is not
   an archive: pip installs the PyPI project `reqeusts-zip` for it, and
   dep-guard looks that up. A bare `reqeusts.zip` with no specifier is an
   archive to pip and to dep-guard alike;
6. the path test reads the requirement token, the string from step 5 up to
   its first whitespace or version operator (`=`, `<`, `>`, `!`, `~`): it is
   a path when it contains `/` or `\` or starts with `.`.

A string that is none of these is a name, and the name pattern then decides
whether it is a valid one.

The four Python lockfiles are a new kind of input, `PythonLockfile`, held
in `RepoState.pythonLockfiles`. They are deliberately NOT added to
`LOCKFILE_CANDIDATES`: that list feeds the primary-lockfile choice, the
lockfile downgrade rule, `lockfile-missing`, `lockfile-not-read` and
`lockfile-unread-sibling`, all of which are about npm and pnpm tamper
coverage, and a Python lock that only supplies names must not make a
removal of it an exit 2 downgrade before any Python tamper rule exists.
`lockfile-missing` keeps its current trigger in 0.13.0; its rewording is
the Phase 3 item. A Python lockfile that does not parse is a
`python-lockfile-unreadable` diagnostic naming the path, and its names
count under `notChecked.lockfileUnreadable`; it is not a could-not-run, because
nothing judged it before 0.13.0 and the package manager itself refuses a
corrupt lock (open point 4).

### Entries

| Entry | Candidate | Otherwise |
|---|---|---|
| a named requirement, whatever its pin (`==`, `===`, `~=`, `>=`, a range, none), extras and environment marker stripped, trailing `--hash` options ignored | yes | |
| `name @ <url>` (PEP 508 direct reference) | no | `excluded.url` or `excluded.vcs`; still a tamper subject as today |
| a bare URL with `#egg=` | no | `excluded.url` or `excluded.vcs` |
| `-e` / `--editable` anything | no | `excluded.editable` |
| a local path or archive, tested as pip tests it, after the URL branches (below): the requirement token contains `/` or `\` or starts with `.`, or the extras-stripped string with its version specifier kept ends in an archive extension | no | `excluded.path`; protocol becomes `file` |
| a line that is neither a dependency nor a recognised option | no | `excluded.unrecognised`, `requirements-line-unread` |
| a dependency whose normalised name equals the normalised `project.name`, or for a Poetry 1 project `tool.poetry.name`, of the same `pyproject.toml` (`mypkg[test]` inside `mypkg`'s own optional dependencies) | no | `excluded.self` |
| a name `[tool.uv.sources]` maps to `path`, `editable` or `workspace`, inside the source's scope (below) | no | `excluded.path` (workspace only when confirmed, below) |
| a name `[tool.uv.sources]` maps to `git` or `url`, inside the source's scope | no | protocol becomes `git` or `url`, so tamper sees it |
| a name `[tool.uv.sources]`, a poetry `source` key or a `Pipfile` `index` key maps to a named index | per section 7: these per-name mappings are index declarations | |
| poetry table with `git`, `url`, `path` (today's `poetrySpecifier`) | no | unchanged |
| `poetry.lock` package | yes, unless its source is one of the classes on the right | `git`, `directory`, `file`, `url`: excluded by class; a `legacy` source: section 7 |
| `uv.lock` package with a `registry` source | yes | `virtual`, `editable`, `path`, `directory`: `excluded.path`; `git`, `url`: excluded by class; a registry origin other than PyPI: section 7 |
| `Pipfile.lock` `default` or `develop` entry with a `version` | yes | `git`, `path`, `file`, `editable`: excluded by class; an `index` naming another origin: section 7 |
| `pdm.lock` package | yes, when it carries no `git`, `url`, `path` or `editable` key | the implementer confirms the shape against a real `pdm.lock` first; an unrecognised entry shape is `python-lockfile-unreadable`, never a silent skip |

The path rule fixes a parser bug the candidate filter exposes: today a
bare `vendor/mylib` or `mylib-1.0-py3-none-any.whl` line matches
`REQUIREMENT_NAME` and becomes a `pypi` dependency named `vendor` or
`mylib-1.0-py3-none-any.whl`, which a lookup would turn into a false
critical. Reclassifying it as `file` costs nothing: `pypi` dependencies
reach no check today.

### The scope of a `[tool.uv.sources]` entry

A source entry is not a global name set. It changes how one name installs
for the project that declares it and, when it sits in a uv workspace root,
for that workspace's members, because that is where uv reads it. It never
touches a requirements file, a `Pipfile`, another project's `pyproject.toml`
or a lockfile outside that workspace: pip installing `reqeusts` from a
requirements file does not consult any `pyproject.toml`'s sources. So every
source exemption or protocol rewrite (`path`, `editable`, `git`, `url`,
`workspace`, `index`) applies only to dependencies of manifests inside its
scope:

- the declaring `pyproject.toml` itself; and
- when the declaring file is a workspace root (it has
  `[tool.uv.workspace]`), each `pyproject.toml` whose directory, relative to
  the root, is matched by `members` and not by `exclude` (matched with the
  same exact-matching rule the npm workspace patterns use; a pattern that
  cannot be matched exactly covers nothing).

When more than one declaring file's scope covers a manifest, the NEAREST
one decides for each dependency, as uv decides: the manifest's own
`[tool.uv.sources]` first, then the deepest workspace root whose scope
covers it. This is applied on every side. (Fix round 1, B1: taking
whichever declaring file came first in the manifest list let a root that
sorts before `services/` hide a member's own git override, so a pull
request repointing `foo` at another host in `services/a/pyproject.toml`
raised no tamper finding.)

For the scope of EVERY source kind, not only `workspace`, `members` and
`exclude` are read from the trust base on a `--trust-base` run wherever the
base has that root `pyproject.toml`. A pull request that widens `members`
therefore cannot extend a root `path`, `editable`, `git`, `url` or `index`
source to a new member, and `python-workspace-unconfirmed` says when the
head's wider `members` was the reason a dependency fell outside a scope.

A repository `uv.toml` is uv's configuration file for the directory it sits
in: its index settings apply to the projects uv runs there, so its scope is
the `pyproject.toml` in the same directory and, when that file is a
workspace root, the same members as above. It does not reach a
requirements file or a `Pipfile`, and it carries no `sources` table, so it
contributes index declarations only (section 7).

A `path` or `editable` source exempts a name only when its target, resolved
against the declaring file's directory and kept inside the repository root,
is either a directory holding a `pyproject.toml` this side parsed whose
`project.name` (or `tool.poetry.name`) normalises to the dependency, or an
archive file (by the step 5 extension list) that exists on that side (fix
round 1, N4: a missing archive exempts nothing) and whose wheel or sdist file name
carries a distribution name that normalises to the dependency, mirroring
the pyproject-name test (final-approval note 4): `reqeusts = { path =
"wheels/other-1.0-py3-none-any.whl" }` exempts nothing. A target that is neither,
such as a head-side `reqeusts = { path = "docs" }`, exempts nothing and the
name is looked up. A `git` or `url` source exempts nothing either: it only
rewrites the protocol so tamper judges it.

A `workspace = true` source exempts a name only when three tests hold.
Tests 2 and 3 are the npm link rule's (2026-10-13, B1, and INVARIANTS "A
link entry is a claim until this side confirms it"), whose first version
stopped at the name check, which is the bug that section records; test 1 is
the sound analog of that rule's first test (there, the link must come from
the lockfile its directory installs from; here, the dependency must be in
the source's scope):

1. the dependency is inside the source's scope, as above;
2. a `pyproject.toml` this side parsed has a `project.name` that normalises
   to the name; and
3. that `pyproject.toml`'s directory is a member under the workspace root's
   `[tool.uv.workspace].members` and not under `exclude`, both read as
   above.

Anything that fails is looked up like any other name. The attack this
closes: a stray `tools/x/pyproject.toml` named `reqeusts`, a root
`reqeusts = { workspace = true }` source, and `reqeusts` in
`requirements.txt`. The requirements line is outside the source's scope, so
it is looked up; the root project's own `reqeusts` dependency is looked up
too, because `tools/x` is not a member. uv refuses to resolve a workspace
source with no member, so a false finding there is loud, not silent.

Even a confirmed exemption covers uv only. `tool.uv.sources` is ignored by
`pip install .`, by `uv build --no-sources`, by any other build frontend,
and by every downstream consumer of a published package, all of which
resolve the name from PyPI. That is recorded as a residual (section 7).

### The filter is exhaustive

`newRegistryNames` stays the npm-only list, so no Python name can reach
the npm corpus, the npm registry or the npm downloads API. It becomes one
view of a new `newNames(ctx)` that returns `{ npm, pypi, excluded }` and
classifies every `Protocol` value in a `switch` with a `never` default, so
a protocol added later is a compile error until someone decides where it
goes. Every dependency that is not a candidate is counted in `excluded`
under its class. This is the structural half of the F14 fix: the next
silent filter cannot be written.

### Delta mode

The same rule as npm: a manifest dependency is a candidate when it is
added (its normalised name is not in the same manifest and section on the
comparison side); a changed specifier is not re-checked. A lockfile name
is a candidate when it is not recorded under that normalised name in the
same lockfile path on the comparison side; a version change is not. A
lockfile path new on the judged side contributes every name in it. With no
comparison side (audit mode, or a staged scan with no commit yet) every
candidate is new.

A name in a lockfile that a Python manifest in the same directory declares
is anchored to that manifest, so the two walks give one finding; a name
only the lockfile records is anchored to the lockfile path, as an
undeclared npm lock entry is.

## 3. The registry lookup

### Request

`GET https://pypi.org/pypi/<normalised>/json`, through `registry-client.ts`'s
`fetchJson` with the scan defaults (`SCAN_ATTEMPTS` 2, `SCAN_TIMEOUT_MS`
5000, backoff capped at `SCAN_BACKOFF_CAP_MS` 8000) and one addition:
`redirect: 'manual'`. The base URL is a module constant (`PYPI_JSON_API`),
overridable only through `FetchOptions` in tests, the way `DEFAULT_REGISTRY`
is today.

Redirects are not followed because, after normalisation, the canonical URL
should not redirect, and following one lets a response from somewhere else
answer the question.

The 5 s per-attempt timeout covers reading the body, not only the headers:
`fetchJson` passes `AbortSignal.timeout(timeoutMs)` to the request and then
awaits `response.json()` under the same signal. The JSON API returns every
release, so a large project's body is big (about 626 KB for Django and
about 3.3 MB for boto3 at the time of writing). On a slow link such a body
can exceed the timeout, and that name then degrades to unreachable: no
finding, a diagnostic, a not-checked count. That is a coverage cost, never
a false finding, and the validation baseline records body sizes and
latencies so open point 7 can be decided on numbers.

### What each answer vouches for

| Answer | Result | Severity / diagnostic |
|---|---|---|
| 404 | `unknown-package` finding, `details.ecosystem: "pypi"`, `details.onlineResolution: "registry-absent"` | critical, as an npm 404 is |
| 2xx, JSON object, `info.name` a string that normalises to the requested name, read within the per-attempt timeout | exists; no finding | none |
| 2xx, anything else (not JSON, no `info.name`, another project's name) | not checked | `online-check-unreachable`, reason `unexpected response` |
| 3xx | not checked | `online-check-unreachable`, reason names the status |
| 408, 429, 5xx, network error, timeout | retried once (Retry-After honoured up to the cap), then not checked | `online-check-unreachable` |
| any other 4xx, 410 included | not checked | `online-check-unreachable` |
| budget already spent when the name comes up | not looked up | `online-deadline-exceeded` |

A 404 says PyPI has no project by that name now: it was never registered,
or it was removed. Removal is the case worth catching in a lockfile: PyPI
deletes malicious projects, and a lock still pinning one is exactly the
name to stop. The severity matches the npm online path, where a 404 is
critical because it rules out the innocent reading. The message:

> "reqeusts" does not exist on PyPI: the PyPI JSON API was queried for the
> project "reqeusts" and answered 404. A name that is on no index this
> repository declares cannot be installed from it, so this is a
> hallucinated or mistyped dependency, or a project PyPI has removed.

A 2xx vouches only that a project with that name exists on PyPI. It says
nothing about whether it is the project the author meant, whether it is
safe, or whether any release is installable (a project whose every release
is yanked still answers 2xx; open point 3). No finding is written for it,
so nothing is downgraded and nothing needs `details` on a clean name.

Every degrade path leaves the name unchecked, writes no finding, and is
counted: a registry problem is never a non-clean result, and the coverage
line (section 6) says how many names were not checked and why. That is the
ruling, and it is also INVARIANTS' "Online checks degrade" rule applied to
a check with no offline result to fall back to: degrading contributes
nothing the run could not establish.

This step only appends findings. It never removes or lowers one, so the
"may never remove" invariant holds for it trivially, and it reads no cache,
so the existence-is-asked-live rule holds too.

### Budget and order

PyPI lookups share the one per-run deadline (`createOnlineDeadline`, 20 s
plain, 300 s on `--base` or `--trust-base`, overridable by `onlineBudgetMs`
and `--online-budget-ms`). There is no second budget.

The step runs second:

1. npm unknown-package resolution (unchanged; it is the only step that
   clears a blocking false positive, and it looks up only corpus misses, so
   it is usually a handful of names).
2. **PyPI existence** (new).
3. npm typosquat asymmetry, 4. npm registered-squat, 5. npm publish-age
   (unchanged order).

Why second, and what it costs. Steps 3 to 5 are not mere refinements:
asymmetry escalates a low typosquat to high, registered-squat adds a new
medium finding and publish-age a new high one, and none of those exists
offline. So the order is a trade between two online-only signals, not
between a signal and a refinement. It is decided this way because the PyPI
step is the only existence check Python has at all, offline or online,
while an npm name has already been judged offline by the corpus and the
popularity list before step 3 runs; a budget spent before step 2 leaves
every Python name with no existence answer, whereas a budget spent before
step 3 leaves npm names with their offline verdict and without the extra
online signals. The cost is real and is stated: on a tight budget an npm
registered-squat or publish-age finding can be lost to PyPI lookups, and
the `online-deadline-exceeded` diagnostics of those steps say so. Step 1
stays first because its absence leaves a user holding a blocking finding
they cannot clear. INVARIANTS' step-order paragraph (the four-steps
rationale in "The online subsystem has one wall clock") already describes
the npm steps as "only ever add or escalate"; it is rewritten for five
steps with this trade (section 11).

Inside step 2, names are looked up in a fixed order so the not-looked-up
set is reproducible: manifest-declared names first (what an agent writes),
then lockfile-only names (what a resolver wrote), each sorted by anchor
path then normalised name. The deadline is asked before every name, as in
`resolveUnknownPackages`. Lookups are sequential, as every online step is
today (open point 7).

No ecosystem may starve the other silently. When the budget runs out
during or before step 2, the step raises `online-deadline-exceeded` with
the check label `pypi existence` and lists the names not looked up (up to
ten, then a count). The message keeps the `before N lookup(s)` phrase
`sumDeadlineSkipped` parses, so `lookupsSkippedByDeadline` includes them;
`deadlineDiagnosticMessage` gains an optional tail so the PyPI message can
end "those names were not checked for existence on PyPI" instead of
"those findings kept their offline result", which would be false here.

## 4. Cache

The npm cache keys are `downloads:<name>`, `created:<name>` and
`version-times:<name>` in one machine-global file (`online/cache.ts`,
written by `scan.ts`). They carry no ecosystem, so a PyPI entry under the
same scheme would collide with an npm package of the same name.

Decision for 0.13.0: PyPI existence is not cached, read or written. It is
asked live, like `liveFetchPackument`, and counts in `lookupsAttempted`,
never in `cacheHits`. Reasons:

- INVARIANTS already rules that existence is asked live, because a stale
  "it exists" is most harmful for exactly the names a registry has since
  removed for security reasons. PyPI removals are the lockfile case this
  check most wants to catch.
- A cached 404 would keep a finding alive after the name is legitimately
  published, which is the cheaper error but still an error.
- A delta-mode run has few new names, so the cost is small; audit mode on a
  large lockfile is what the 300 s CI budget and the deadline diagnostic
  are for.

Any later PyPI cache entry uses a `pypi:<kind>:<normalised>` key. The
existing unprefixed npm keys stay as they are (renaming them only forces a
cold cache) and are documented as npm keys. A test pins that no PyPI step
calls the cache.

## 5. Typosquat without a corpus

Three options were weighed.

**(i) Distance against the repository's own Python names.** The new name
is compared, with the same transform rules and banded distance
`typosquat.ts` uses, against every other normalised Python name the judged
side declares (all Python manifests and lockfiles) and, on a comparison
run, every Python name the comparison side declared. Needs no corpus.
Catches the edit an agent actually makes: `requests` rewritten to
`reqeusts` in one file (the base side still has `requests`), or
`werkzueg` added to one service while another declares `werkzeug`. Misses
a typo of any project the repository does not already name, which is most
typos in a small repository, and is only as good as the repository's own
names. A false-positive source: real neighbouring pairs (`boto` and
`boto3`, `attr` and `attrs`, `jinja2` and `jinja`) when a repository
declares one and adds the other.

**(ii) Distance against a short shipped list of the most-depended-on PyPI
projects.** This is a popularity list, and INVARIANTS ("The popularity list
is a trust input") holds such a list to two independent verifications per
name, a usage floor, no build-time third-party fetch, and a size sized for
the rule. The section exists because a five-hundred-name npm list produced
confident false positives. A short PyPI list is option (c) in disguise,
without (c)'s safeguards. Rejected for 0.13.0.

**(iii) Normalisation collision only.** Two declared names that normalise to
the same project are the same project: PyPI refuses to register a name that
normalises to an existing one, and pip installs the one project either way.
There is nothing malicious to detect, so this is dedupe (section 1), not a
check.

**Recommendation: (i), at `low`, offline.** It is the npm resemblance
severity (non-alias-list matches report at `low`, outside the default gate,
because measurement found only false positives at higher severities), and
it has no online escalation, because the npm asymmetry step's download
counts have no first-party PyPI equivalent. An exact normalised match is
never a typosquat. Signals reuse npm's (`separator-swap` cannot fire, since
separators are normalised away; the rest apply). `details.comparedAgainst`
says `repository` so a reader knows no popularity list was involved. It runs
offline, so a plain run does give Python names a resemblance check, and the
coverage line says exactly that and no more.

The README claims only this: "For Python, typosquat compares a new name
with the other Python names the same repository declares (and, on a
comparison run, the names the base declared). No list of popular PyPI
projects ships, so a typo of a project the repository does not already use
is caught only by the online existence check, and only when the typo is
not a registered project."

## 6. The ecosystems line

### Text summary

One line under the run summary, printed whenever at least one Python
manifest or lockfile was read; the npm part always prints when an npm
manifest was read. Counts are candidate names after dedupe.

Plain run, no `--online`:

    names: npm 3 checked (corpus); pypi 7 not checked for existence (no PyPI corpus ships; pass --online), resemblance checked against this repository's own Python names; 1 url, path or vcs requirement excluded

`--online`, everything answered:

    names: npm 3 checked (corpus, registry); pypi 7 of 7 checked for existence (PyPI), resemblance checked against this repository's own Python names; 1 url, path or vcs requirement excluded

`--online`, degraded:

    names: npm 3 checked (corpus, registry); pypi 5 of 7 checked for existence (PyPI); 2 not checked: 1 online budget spent, 1 PyPI unreachable; resemblance checked against this repository's own Python names; 1 url, path or vcs requirement excluded

A not-checked reason prints only when its count is above zero; the
not-checked total prints even at zero on an online run (`7 of 7`).
Reasons: `online budget spent`, `PyPI unreachable`, `private index`,
`internal name`, `lockfile unreadable`.

### Diagnostic

An offline run with at least one Python candidate raises
`pypi-names-not-checked`:

> 7 Python dependency names in requirements.txt and pyproject.toml were
> read and not checked for existence: dep-guard ships no PyPI name list,
> and the PyPI existence check runs only with --online. Typosquat compared
> them with this repository's own Python names only.

The online degrade paths use the existing `online-check-unreachable` and
`online-deadline-exceeded` codes with the label `pypi existence`, and the
new skips use `pypi-private-index-skipped` (section 7). Diagnostics never
change the exit code.

### JSON

An additive `run.ecosystems` object (minor-safe under the stability
policy), always present:

    "ecosystems": {
      "npm":  { "manifests": 2, "candidates": 3, "checked": 3,
                "notChecked": { "privateScope": 0 } },
      "pypi": { "manifests": 2, "lockfiles": 1, "candidates": 7,
                "existenceChecked": 5, "resemblanceChecked": 7,
                "notChecked": { "offline": 0, "budget": 1, "unreachable": 1,
                                "privateIndex": 0, "internal": 0,
                                "lockfileUnreadable": 0 },
                "excluded": { "url": 0, "vcs": 1, "path": 0, "editable": 0,
                              "constraint": 0, "self": 0, "invalidName": 0,
                              "unrecognised": 0 } }
    }

The `run.online` totals keep their meaning and now include PyPI lookups.
Phase 3 extends `ecosystems` (Go, the reworded `lockfile-missing`); this
design fixes only the `pypi` member and the minimum `npm` member the line
needs.

### README coverage table

A new "Ecosystem coverage" section, replacing the "Python package names are
read but not yet checked" sentence in "Lockfile support":

| Ecosystem | Files read | Name checks | Lockfile checks |
|---|---|---|---|
| npm | `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml` (`yarn.lock`, `bun.lock` noted, not parsed) | unknown-package against the shipped corpus, and the registry with `--online`; typosquat against the shipped popularity list; registered-squat and asymmetry with `--online` | tamper, install-script, publish-age (`--online`) |
| Python (PyPI) | requirements files, `pyproject.toml`, `Pipfile`, `poetry.lock`, `uv.lock`, `pdm.lock`, `Pipfile.lock` | unknown-package with `--online` only (PyPI existence; no corpus ships); typosquat against the repository's own Python names only | none: Python lockfiles are read for names; their hashes and sources are not judged. A git or url requirement is a tamper git-source or url-source finding, as for npm |

## 7. Trust boundary

Candidate names come from the judged tree. That is correct: they are the
subject. Nothing about how they are looked up comes from it.

- **The endpoint is a constant.** `PYPI_JSON_API` has no config key and no
  flag, as `DEFAULT_REGISTRY` has none today (`registry-client.ts`).
- **Every switch is a control input already.** `online`, `onlineBudgetMs`,
  `allow`, `ignorePaths` and `internalPrefixes` come from `controls.config`
  on a `--trust-base` run (`scan.ts`, `runChecks` call, and
  `resolveOnlineBudgetMs`), so a pull request cannot turn the check off,
  shrink its budget, allow its own name or ignore its own file.
- **Index declarations are control inputs, read from the trust base.** A
  Python manifest that names a non-PyPI index skips its names, because a
  private name must not be put on the wire to pypi.org and a 404 for it
  would be a fabricated critical. That skip decides whether a rule fires,
  so by INVARIANTS' test ("does a rule read it to decide whether to fire")
  the index lines are control input even though they sit inside a subject
  file. On a `--trust-base` run they are read from the trust base copy of
  the same path, exactly as `.npmrc` pins are (`scan.ts` passes
  `controls.npmrcPins` instead of `statePair.after.npmrcRegistryPins`;
  `trust-base.ts` builds them from the base file). A head-side change to
  them is reported as a proposal, `python index changed in this pull
  request`, and does not take effect for that run. Outside pull-request
  mode they come from the judged side, as `.npmrc` does, because a
  developer's own checkout is already inside the boundary.

  Index declarations read, every option spelling of section 2 included:
  requirements `-i`, `--index-url`, `--extra-index-url`, `-f`,
  `--find-links`, `--no-index`; `pyproject.toml` `[[tool.poetry.source]]`,
  `[[tool.uv.index]]`, `tool.uv.index-url` and `extra-index-url`,
  `[[tool.pdm.source]]`; `Pipfile` `[[source]]`; a repository `uv.toml`;
  and the per-name mappings onto a named index (`[tool.uv.sources]`
  `x = { index = ... }`, a poetry dependency's `source` key, a `Pipfile`
  entry's `index` key), which are index declarations for one name.

  What a declaration skips depends on how the tool uses it:
  - a non-explicit index that adds to or replaces PyPI (`--index-url`,
    `--extra-index-url`, `--find-links`, `--no-index`, a poetry source that
    is not `priority = "explicit"`, a uv index without `explicit = true`, a
    `Pipfile` source, `tool.uv.index-url` and `extra-index-url`) can serve
    any name in that manifest, so every name in the manifest is skipped;
  - an explicit index (poetry `priority = "explicit"`, uv
    `explicit = true`) serves only the names pinned to it, so only those
    names are skipped;
  - a per-name mapping skips that name.

  Each skip is named in `pypi-private-index-skipped` with the manifest, the
  origin and the count. The skip is a coverage gap, not a safety property,
  and the diagnostic says so where it matters: for `--extra-index-url` and
  any other index pip or uv consults beside PyPI, it adds "pip still
  resolves these names from PyPI as well, so a name that is not on PyPI is
  exposed to dependency confusion; this run did not check it".

  Origins are compared normalised: scheme and host lower-cased, a default
  port dropped, the path with its trailing slash removed. `pypi.org` and
  `pypi.python.org` under `/simple` or `/pypi`, and `files.pythonhosted.org`
  for `--find-links`, are PyPI; a declaration naming one of them skips
  nothing. Userinfo (`https://user:token@host/...`) is removed before the
  comparison and never printed, so a token in an index URL cannot reach a
  diagnostic. Scheme is part of the origin, so `http://pypi.org/simple` is
  not equal to a declared `https://` origin; and it is still treated as
  PyPI, so it skips nothing. Both edge cases fail closed in the same
  direction: the name is looked up, never skipped.

  Includes: pip applies an index option from any file in a `-r` chain to
  the whole install, so a private index declared in an included file also
  covers the including file's names. This design reads index declarations
  per file and does not carry them along the include graph, so those
  including-file names are looked up and a private one gives a false
  critical. That fails loud and is accepted: on a pull request the include
  graph is head content, and propagating declarations along it would let
  the head decide what is skipped. The fix for a repository that hits it is
  to repeat the index line in the including file on the base, or to list
  the names under `internalPrefixes`.

  On a `--trust-base` run, a base-side copy of a file that carries index
  declarations and is a gitlink or another non-file, or does not parse, is
  an unreadable control input and stops the run (exit 2,
  `python-index-invalid`), as an unreadable base `.npmrc` does
  (INVARIANTS, "A control input is not read from the tree being judged"):
  no declarations is the loosest setting, not the safest. A base copy that
  is simply absent means no declarations for that path.

  A base copy that is a symlink is ruled differently (fix round 1, N3),
  following the `screenSymlinkedInputs` rule that a comparison side still
  holding a link does not block the pull request that replaces it: when the
  judged copy is a regular file, the base contributes no index declarations
  and no workspace members for that path, so every name in it is looked up
  and no root source reaches a member (both fail closed), and
  `python-index-unread-comparison-side` names the file. When the judged copy
  is a symlink as well, the run stops as before, as `symlinked-input` on the
  judged side.

  A name skipped at one anchor and looked up at another was checked, so
  `pypi-private-index-skipped` does not count it, and a note whose names
  were all looked up elsewhere is not printed (fix round 1, N7). A PyPI
  outage gives one `online-check-unreachable` for the PyPI step, carrying
  the count, the first names and the first reason, rather than one per name
  (N6).

- **A lockfile's recorded source never exempts an entry by itself.** The
  head controls the lockfile, so a `uv.lock` entry claiming
  `source = { registry = "https://anything/simple" }`, a `Pipfile.lock`
  whose `_meta.sources` remaps an index name, or a poetry `legacy` source
  would otherwise skip any name it likes, which is exactly the "a rule
  reads it to decide whether to fire" case. A lockfile entry whose recorded
  origin is not PyPI is skipped only when that normalised origin equals an
  origin declared under the rule above for a manifest in the same project
  (read from the trust base on a `--trust-base` run). Otherwise the name is
  looked up; a genuinely private name then gives a critical, the cost
  residual 3 already accepts. An entry naming PyPI under any variant
  spelling is looked up as PyPI.
- **Names in `internalPrefixes`** are never sent, silently, as for npm, but
  only through entries with a `pypi:` prefix (`pypi:acme-`), matched on the
  normalised name against the normalised prefix. A bare entry is an npm
  prefix and does not widen to a second ecosystem, for the same reason as
  `allow` below.
- **`allow` for Python takes a `pypi:` prefix.** `pypi:reqeusts` clears a
  Python finding for that normalised name; a bare entry does not. Existing
  allow lists were written and reviewed about npm names, and silently
  extending what a reviewed entry means to a second ecosystem is a change
  of meaning nobody reviewed. `describeConfigChange` already lists `allow`
  entries, so a head-side `pypi:` entry is a proposal like any other.
- **A pull request cannot disable the check through a file it adds.** A new
  requirements file's index lines are not read on a `--trust-base` run, so
  its names are looked up. Turning a name into a URL, git or editable line
  removes it from name checks and makes it a tamper git-source or
  url-source finding instead, which is how npm treats the same move. A
  `[tool.uv.sources]` entry applies only inside its scope, and a workspace
  claim needs a parsed member under base-read `members` (section 2). An
  option spelling the parser does not recognise is counted and named, not
  dropped.

### Residual

- A requirements file under a name none of the patterns match, installed
  by a workflow command (`pip install -r deps.txt`) and not reached by any
  `-r` line, is not read. File names stand in for "what pip is told to
  read", and the workflow file is outside the tree dep-guard judges. This
  is the same class as the 0.11.0 directory filter; the coverage line at
  least names every file that was read. Open point 5.
- A user-level `pip.conf`, `PIP_INDEX_URL`, `UV_INDEX_URL` or a CI-level
  index setting is invisible. A repository that relies on one for private
  names must list them under `internalPrefixes`, as the README already
  says for a user-level `.npmrc`.
- A new Python project added in a pull request together with its private
  index line gets its private names looked up on PyPI on that run, and
  each that 404s is a critical. That is the npm behaviour for a scope pin
  added only on the head; the fix is to land the index declaration, or an
  `internalPrefixes` entry, on the base first.
- A head-written lockfile entry that claims a private source the base
  already declares is skipped. The package manager would fetch it from that
  index, which the maintainers chose; whether the entry should have moved
  there is a source change only a Python lockfile tamper rule can judge.
  Until then the skip is visible in the diagnostic and the count.
- A `[tool.uv.sources]` exemption, even a confirmed one, holds for uv only.
  `pip install .`, `uv build --no-sources`, other build frontends and every
  downstream consumer of a published package ignore `tool.uv.sources` and
  resolve the name from PyPI. A project that publishes to PyPI with a
  uv-sourced dependency whose name is not on PyPI ships a dependency
  confusion exposure this check does not report.
- A uv workspace root that the pull request adds itself has no base copy,
  so its `members` and `exclude` are read from the head. This is the same
  residual the npm link rule records for an install root a pull request adds
  (INVARIANTS, "A link entry is a claim until this side confirms it"): the
  member and its code are in the diff under review.
- A head-added or head-renamed path or editable target inside the declaring
  project earns the exemption: the target is subject content, read from the
  judged side. Same class as the npm residual in INVARIANTS "A control input
  is not read from the tree being judged" (a real workspace member added
  under a glob the base already declares). A target under a skipped
  directory name (`vendor`, `build` and the rest) is never parsed, so a
  vendored path dependency gets a false critical, which fails closed
  (final-approval note 3).

## 8. The osv vulnerabilities gate

No overlap is claimed. Under the umbrella, the vulnerabilities gate hands
pinned requirements and Python lockfiles to osv-scanner, which looks up
published advisories for exact versions. dep-guard checks names: does the
project exist, and does it resemble another name the repository uses. The
README gets one sentence: "dep-guard checks that a Python name exists on
PyPI and does not resemble another name your repository uses; it does not
look up advisories, which is what osv-scanner (the umbrella's
vulnerabilities gate) does, and neither result stands in for the other."

## 9. Real-registry validation

Run against public Python repositories at a pinned commit, before the
feature is called done, covering: several requirements files with `-r`
includes; a `uv.lock` with `[dependency-groups]`; a `poetry.lock`; and, if
cheap, a `Pipfile.lock` or `pdm.lock`. The set, as reviewed:

- `pallets/flask`: `uv.lock` and `[dependency-groups]`; no requirements
  files.
- `pydantic/pydantic`: `uv.lock`.
- `python-poetry/poetry`: `poetry.lock`.
- `pypi/warehouse`: a `requirements` directory of `.in` and `.txt` files;
  the implementer confirms at the pinned commit that its files use `-r`,
  since none of the other three exercises includes.

None of the first three has several requirements files, which is why the
fourth is in the set.

For each, run `dep-guard scan --online --format json` in audit mode, then a
`--base` run over one real dependency-bump commit, and record in the
checked-in dogfood baseline (location: open point 10):

- repository URL and commit SHA, dep-guard version, date;
- every Python file read, by kind;
- candidates, `existenceChecked`, every `excluded` and `notChecked` count;
- `lookupsAttempted`, wall time, budget used, and the largest JSON response
  size seen (large projects return multi-megabyte bodies; this is the
  number that decides open point 7), and every name that degraded to
  unreachable on a body timeout;
- whether the JSON API answers 404 or 2xx for a registered project with
  zero releases (find one and record its name and the answer), since a 404
  there would be a critical for a name that is registered;
- every finding. The expected count of `unknown-package` is zero; each one
  is a false positive to explain before release. Each `low` typosquat is
  judged true or false and the judgement recorded;
- the text `names:` line verbatim.

Then plant, in a commit on top, and run `--base` against the parent:

- a name that does not exist (for example `depguard-planted-absent-7f3a9c`,
  confirmed 404 at run time): must be one critical `unknown-package`;
- a typo of a name the repository declares (for example `werkzueg` where
  `werkzeug` is declared), confirmed 404 at run time: must be one critical
  `unknown-package` and one `low` typosquat naming the declared project;
- the same absent name added as a lockfile-only `[[package]]` entry in the
  `uv.lock` or `poetry.lock`: one critical, anchored to the lockfile;
- the absent name written as `Depguard_Planted.Absent-7F3A9C` in a second
  file: the same project, one lookup, one finding per anchor;
- a `-e git+https://...#egg=` line and a `./vendor/pkg` line: no lookup,
  counted under `excluded`;
- the absent name with a path-shaped option value,
  `depguard-planted-absent-7f3a9c==1.0 --config-settings=x=a/b`: still one
  critical;
- a `--requirement=extra.txt` line naming a file no pattern matches, which
  holds the absent name: the file is read and the name is one critical.

The planted runs are repeated with the network blocked: exit 0, no Python
finding, `online-check-unreachable` naming `pypi existence`, and a `names:`
line saying how many were not checked.

## 10. Tests

### Unit, with the assertion each makes

- `normalizePypiName`: `Django_REST.framework`, `a--b`, `A.B_C`, `x`
  normalise to `django-rest-framework`, `a-b`, `a-b-c`, `x`; the function
  never sees a non-ASCII name because the parser rejects it first.
- parser: every row of the section 2 entries table yields the stated
  protocol and exclusion class; `mylib-1.0-py3-none-any.whl` and
  `vendor/mylib` are `file`, not `pypi`; `mypkg[test]` inside `mypkg` is
  `excluded.self`; `[dependency-groups]` with `{include-group}` parses;
  `-r` follows a relative file once, refuses a path leaving the root and a
  symlink, and stops a cycle; `-c` names are `excluded.constraint`; each
  of `-r x`, `-r\tx`, `--requirement=x`, `-rx`, and the same four for `-c`,
  `-i`, `--index-url` and `--extra-index-url`, is recognised; a URL line
  with no `#egg=` becomes a `url` dependency named by host and last path
  segment; a non-ASCII poetry, `Pipfile` or `[tool.uv.sources]` key is
  `excluded.invalidName`; `tool.poetry.name` drives the self-reference
  exclusion for a Poetry 1 project.
- each Python lockfile reader: names, versions and source classes from a
  real-shaped fixture; a malformed file is `python-lockfile-unreadable`.
- `newNames`: a `pypi` dependency never appears in the npm list; every
  `Protocol` is classified (a type-level test plus a runtime table test).
- delta: re-casing a name is not an added dependency; a version bump is
  not a candidate; a new lockfile path contributes all its names.
- lookup outcomes: 404 gives one critical with the stated message and
  `details`; 2xx with a matching `info.name` gives nothing; each degrade
  answer gives no finding and one diagnostic; `fetchJson` is called with
  `redirect: 'manual'`.
- ecosystems line and JSON: each of the three sample lines above, byte for
  byte, from constructed results.

### Adversarial, one per fail-closed or degrade path

- **Budget exhausted mid-ecosystem.** Injected clock; five Python names;
  the deadline expires after two lookups. Assert two fetches, no finding
  for the other three, `online-deadline-exceeded` naming exactly those
  three in lookup order, `lookupsSkippedByDeadline` 3, exit code from
  findings only, and the `names:` line saying `2 of 5`.
- **npm step 1 spends the whole budget.** Assert the PyPI step issues no
  fetch and its diagnostic names every Python name: no silent starvation.
- **Step order.** Assert step 2 runs after npm unknown-package resolution
  and before asymmetry, by recording fetch order across both registries.
- **PyPI 5xx.** Two 503s: no finding, `online-check-unreachable`, one
  retry, exit 0 on an otherwise clean tree.
- **3xx.** A 301 to the canonical name: no finding, diagnostic, no second
  request to the `Location` target.
- **Wrong body.** A 2xx whose `info.name` is another project: no finding,
  diagnostic, never counted as exists.
- **Normalised exists, written does not.** `Python_Dateutil`; the mock
  answers 200 only for the normalised URL and 404 for every other spelling.
  Assert one fetch, to the normalised URL, and no finding.
- **Editable, URL, VCS and path lines are never looked up.** Assert the
  fetch mock is never called with their names and each is counted.
- **Private index, plain run.** A requirements file with `--index-url` to
  another host: no fetch for any of its names, `pypi-private-index-skipped`.
- **Private index added on the head, `--trust-base`.** The base file has
  no index line; the head adds one plus an absent name. Assert the name is
  looked up, the critical is reported, and the proposal line is printed.
- **Allow.** A bare `reqeusts` allow entry does not clear the Python
  finding; `pypi:Reqeusts` does, and is counted in `allowed`.
- **Cache.** Two scans in one process both fetch the same Python name: no
  PyPI existence answer is served from the cache.
- **A Python name never leaves for npm.** A requirements typo with
  `--online`: no request to the npm registry or downloads API for it.
- **A path-shaped option value does not make a path.**
  `reqeusts==2.31 --config-settings=x=a/b` and
  `reqeusts --global-option=./x`: both are `pypi` dependencies named
  `reqeusts` and both are looked up.
- **An unrecognised option spelling is counted.** A line `--frobnicate=a`
  and a line the name pattern rejects each give `excluded.unrecognised` and
  a `requirements-line-unread` diagnostic naming the file and line; a
  `--requirement=more.txt` line reads `more.txt`.
- **Source scope.** The B3 attack: a stray `tools/x/pyproject.toml` named
  `reqeusts`, a root `reqeusts = { workspace = true }` source, `reqeusts` in
  the root `requirements.txt` and in the root `project.dependencies`. Assert
  both are looked up. Controls: with `tools/x` under the base's
  `[tool.uv.workspace].members`, the root project's dependency is exempt
  and the requirements line is still looked up; with `members` widened only
  on the head under `--trust-base`, both are looked up and
  `python-workspace-unconfirmed` names the reason. A `path` source in
  project A does not exempt the same name in project B.
- **Lockfile source skip.** A head `uv.lock` entry with
  `source = { registry = "https://anything.example/simple" }` that no
  manifest declares: looked up. The same origin declared by the project's
  `[[tool.uv.index]]` on the base: skipped with
  `pypi-private-index-skipped`. An entry naming `https://pypi.org/simple/`
  (trailing slash): looked up as PyPI. A `Pipfile.lock` whose `_meta.sources`
  remaps the `pypi` index name to another host: looked up.
- **Explicit index.** A uv index with `explicit = true` and one name pinned
  to it: only that name is skipped; the manifest's other names are looked
  up.
- **internalPrefixes for Python.** `pypi:acme-` skips `Acme_Utils` with no
  request; a bare `acme-` entry does not, and still covers the npm name
  `acme-ui`.
- **A Python resemblance needs a different project.** `Flask` in one file
  and `flask` in another: one project, no typosquat finding; `flask` and
  `flaks`: one `low` typosquat naming `flask`.
- **Base copy unreadable.** On `--trust-base`, a base `requirements.txt`
  that is a gitlink: exit 2 naming the path. (Fix round 1, N3: a base copy
  that is a symlink, with a regular file on the head, passes; the base
  contributes no declarations, the head's private-index line is not obeyed,
  every name is looked up, and `python-index-unread-comparison-side` names
  the file. With a symlink on the head as well, `symlinked-input`, exit 2.)
- **Fix round 1 additions.** A member under `services/` overriding a root
  git source, and the same over a confirmed root path source, are tamper
  findings (the nearest declaring file decides); an invalid PEP 508 string
  carrying a token never prints it in JSON, text or SARIF; a `--base` plus
  separate `--trust-base` run with an unchanged git source raises nothing;
  a missing archive target exempts nothing; a PDM `-e` dev entry is
  `excluded.editable`; a PyPI outage is one diagnostic; a name looked up at
  another anchor is not counted as skipped.
- **A dotted name with a specifier is not an archive.**
  `reqeusts.zip==1.0`, `reqeusts.tar==1.0` and `reqeusts.whl>=1`: each is a
  `pypi` dependency normalised to `reqeusts-zip`, `reqeusts-tar`,
  `reqeusts-whl` and looked up. Controls: a bare `pkg-1.0.tar.xz`,
  `pkg-1.0.tbz` and `pkg-1.0.tar.lzma` are each `excluded.path`, one row
  per extension in the step 5 list.
- **URL branches run before the path test.** A bare
  `https://example.com/pkg/pkg-1.0.tar.gz` line (no `#egg=`) is a `url`
  dependency that reaches the delta and the tamper url-source signal; it is
  never `file`.
- **A path source needs a real target.** Under `--trust-base`, a head-only
  `reqeusts = { path = "docs" }` where `docs/` holds no `pyproject.toml`
  named `reqeusts`: the dependency is looked up. Controls: a target holding
  a parsed `pyproject.toml` named `reqeusts` exempts it; a target that is an
  archive file whose distribution name is `reqeusts` exempts it, one naming
  another project does not; a target outside the repository root exempts
  nothing.
- **Root sources do not follow a head-widened `members`.** A root
  `x = { path = "libs/x" }` source, `members` on the base not covering
  `apps/new`, and the head adding `apps/new` to `members` with `x` in its
  dependencies: under `--trust-base`, `apps/new`'s `x` is outside the scope
  and is looked up.
- **Abbreviations and variables.** `--requirem=more.txt` reads `more.txt`;
  `--extra-index https://private.example/simple` is an index declaration; an
  ambiguous prefix such as `--requ` (it matches both `--requirement` and
  `--require-hashes` in pip's requirements-file parser) or `--no` is
  `requirements-line-unread`. (Corrected during implementation: the first
  version of this line used `--requ` as the readable abbreviation and
  `--ext` as the ambiguous one; against pip's own option set `--requ` is
  ambiguous and `--ext` is unique to `--extra-index-url`.); `${PRIVATE_PKG}==1.0` and
  `-r ${CI_DIR}/x.txt` are each `requirements-line-unread` with the
  environment-variable wording, and nothing is looked up for them.
- **Userinfo never prints.** An index declared as
  `https://user:secret@private.example/simple`: the skip diagnostic names
  `https://private.example/simple` and the text `secret` appears nowhere in
  the output.

### Mutations that must turn a test red

| Mutation | Red test |
|---|---|
| look up the written name instead of the normalised one | normalised exists, written does not |
| add `pypi` to `NAME_PROTOCOLS` | a Python name never leaves for npm |
| treat a thrown fetch as a 404 | PyPI 5xx |
| follow redirects | 3xx |
| drop the PyPI `online-deadline-exceeded` diagnostic | npm step 1 spends the whole budget |
| run step 2 last | step order |
| drop the editable, URL or path exclusion | never looked up |
| read index lines from the head on `--trust-base` | private index added on the head |
| serve PyPI existence from the cache | cache |
| drop the `info.name` comparison | wrong body |
| remove the self-reference exclusion | parser self-reference row |
| let an exact normalised match count as a typosquat | a Python resemblance needs a different project |
| add a `default` branch that drops a protocol in `newNames` | every protocol is classified |
| run the path test on the whole logical line | a path-shaped option value does not make a path |
| make `[tool.uv.sources]` exemptions a global name set | source scope |
| drop the `members` test, or read `members` from the head on `--trust-base` | source scope (controls) |
| let a lockfile's recorded origin skip without a matching declaration | lockfile source skip |
| compare origins without normalising | lockfile source skip (trailing slash) |
| skip the whole manifest for an explicit index | explicit index |
| match bare `internalPrefixes` entries against Python names | internalPrefixes for Python |
| return null for an unrecognised line without counting it | an unrecognised option spelling is counted |
| fall back to no declarations when the base copy is a gitlink | base copy unreadable (gitlink) |
| stop the run, or obey the head's declarations, when the base copy is a symlink | a PR that replaces a symlinked base requirements.txt passes |
| apply the first declaring file in list order instead of the nearest | uv source precedence (services/, git and path roots) |
| echo an invalid name string in full | a token after the name never reaches any output surface |
| skip the trust-base side's source rewrite | unchanged git source with a separate trust base |
| confirm an archive target without checking it exists | an archive target not on the judged side exempts nothing |
| drop the `-e` strip in TOML requirement lists | a pdm -e dev entry is excluded.editable |
| one unreachable diagnostic per name | a PyPI outage gives one online-check-unreachable |
| count a name looked up elsewhere in a skip note | a name looked up at another anchor is not counted as skipped |
| ask the deadline once per step instead of per name | budget exhausted mid-ecosystem |
| ignore index lines on a plain run | private index, plain run |
| match a bare allow entry against Python names | allow |
| recognise only space-separated option spellings | an unrecognised option spelling is counted (the `--requirement=more.txt` read) |
| run the archive test on the token cut at the version operator | a dotted name with a specifier is not an archive |
| drop any one extension from pip's archive list | a dotted name with a specifier is not an archive (that extension's control row) |
| run the path and archive tests before the URL branches | URL branches run before the path test |
| let a `path` or `editable` source exempt without checking its target | a path source needs a real target |
| read `members` from the base only for `workspace` sources | root sources do not follow a head-widened `members` |
| recognise only full option names, not unique prefixes | abbreviations and variables |
| expand or strip `${VAR}` instead of counting the line | abbreviations and variables |
| print an index origin with its userinfo | userinfo never prints |

## 11. INVARIANTS, CHANGELOG, README

### INVARIANTS sentences to append

- A Python project name is compared only in its PEP 503 normalised form,
  for lookup, delta keys, dedupe, distance, allow and identity; the written
  form is display only.
- Every dependency is either a name candidate for exactly one ecosystem or
  counted under a named exclusion; no protocol is dropped without a count,
  and a Python name never reaches the npm corpus, registry or downloads
  API.
- A PyPI 404 is a critical `unknown-package`; a 2xx vouches only that the
  project exists; every other answer, and a spent budget, leaves the name
  unchecked with a diagnostic and a count, never a finding.
- PyPI existence is asked live and never read from or written to the
  online cache.
- Python index declarations, per-name index mappings included, are control
  inputs: on a `--trust-base` run they are read from the trust base, a
  head-side change is a proposal, and an unreadable base copy is exit 2. A
  lockfile's recorded source skips an entry only when it equals a declared
  origin.
- A `[tool.uv.sources]` entry of any kind applies only to its declaring
  project and, from a workspace root, to members under that root's
  `members` and `exclude`, read from the trust base where the base has the
  root. A `path` or `editable` source exempts only when its target is a
  parsed project of that name or an archive file; a workspace claim needs a
  parsed member of that name under those `members`.
- A requirements line is classified in pip's order: URL and direct
  reference first, then the archive test on the extras-stripped string with
  its version specifier kept, then the path test on the requirement token.
  Every requirements line is a dependency, a recognised option (any
  spelling or unique abbreviation pip accepts), or counted under
  `excluded.unrecognised`.
- Python `allow` and `internalPrefixes` entries carry a `pypi:` prefix; a
  bare entry is npm-only.
- Python typosquat compares only against Python names the repository
  itself declares, on either side; no popularity list is consulted.
Amendments to existing INVARIANTS text, so the new sentences do not
contradict it:

- "Online resolution may downgrade a finding, and may never remove one":
  the sentence "the network only ever adjusts how loudly" becomes "the
  network never removes a finding and never lowers one except through
  `resolveUnknownPackages`". It was already contradicted by registered-squat
  and publish-age, which add findings, and the PyPI step adds a third.
- "Online checks degrade, and degrading has a precise meaning": the sentence
  that speaks of "the one online step that removes a finding" is stale,
  since nothing in the online subsystem removes a finding (`enrichOnline`
  returns every resolved finding plus the added ones). It is rewritten to
  say the one online step that lowers a severity, which agrees with the
  sentence above.
- "The online subsystem has one wall clock": the step-order paragraph, which
  says the three npm steps after unknown-package resolution "only ever add
  or escalate" and so cost only a signal that would not exist offline, is
  rewritten for five steps: the PyPI step is second, and the stated trade
  is the one in section 3 (an online-only npm signal can be lost to PyPI
  lookups on a tight budget, because Python has no other existence check).

New diagnostic codes for the hand-maintained list: `pypi-names-not-checked`,
`pypi-private-index-skipped`, `python-lockfile-unreadable`,
`python-name-invalid`, `python-workspace-unconfirmed`,
`requirements-line-unread`.

### CHANGELOG for 0.13.0

    ## [0.13.0] - YYYY-MM-DD

    Python dependency names are now checked. What can newly block, and how
    to clear each:

    - Findings (exit 1) from unknown-package, critical, for a Python name
      PyPI answers 404 for, on a run with --online. Names come from
      requirements files, pyproject.toml, Pipfile, poetry.lock, uv.lock,
      pdm.lock and Pipfile.lock, compared in PEP 503 normalised form. A
      name that only resolves from a private index is skipped when the
      manifest declares that index (on a --trust-base run, when the base
      declares it); a lockfile's own recorded source skips an entry only
      when it matches such a declaration. Otherwise list the name under
      internalPrefixes with an entry of the form pypi:<prefix>, or clear one
      finding with an allow entry of the form pypi:<name>. Bare allow and
      internalPrefixes entries stay npm-only.
    - Findings (exit 1) from lockfile-tamper git-source and url-source for
      Python sources dep-guard did not read before: a git or url line in a
      requirements file it did not read (a .txt basename starting with
      requirements or ending in requirements.txt, a .txt file directly in a
      directory named requirements, requirements.in, and files reached by
      -r in any spelling pip accepts); a URL line with no #egg=; a git or
      path entry in a Pipfile; a [tool.uv.sources] git or url rewrite; and
      a name @ git+ string in build-system.requires, [dependency-groups],
      or the uv and pdm dev tables.
    - Could-not-run (exit 2, manifest-parse) for a Pipfile that is not
      valid TOML, and for a malformed build-system.requires,
      [dependency-groups] or uv or pdm dev table in a pyproject.toml. Fix
      the file, or cover it with ignorePaths on the base branch.
    - Could-not-run (exit 2) on a --trust-base run when the base copy of a
      file carrying Python index declarations is a gitlink or does not
      parse (a symlinked base copy contributes no declarations instead; see
      the checked-in CHANGELOG for the full exit 2 list after fix round 1).

    Added

    - Every run prints a names: line saying, per ecosystem, how many new
      names were checked and how, and how many were read but not checked
      and why; the JSON result carries the same counts under
      run.ecosystems. An offline run with Python names raises
      pypi-names-not-checked.
    - Python typosquat at low, against the other Python names the same
      repository declares. No PyPI popularity list ships.

    Changed

    - PyPI lookups share the one online budget and run second, after npm
      unknown-package resolution; names the budget did not reach are listed
      in online-deadline-exceeded. A PyPI outage or a spent budget never
      fails a run.
    - A bare path or archive file name in a requirements file is no longer
      read as a package name. A requirements line that is neither a
      dependency nor a recognised option is counted and named in
      requirements-line-unread instead of being dropped.

### README changes

- "What it checks": the unknown-package and typosquat bullets say npm and,
  for Python, what section 5's claim says.
- "Online checks": five checks, not four; a PyPI existence bullet with the
  outcome table of section 3 in prose; the private-name rule extended to
  Python index declarations and `internalPrefixes`.
- The new "Ecosystem coverage" table (section 6) and the osv sentence
  (section 8).
- "Lockfile support": the "Python package names are read but not yet
  checked" sentence and the "`-r` lines are not followed" sentence replaced
  by a pointer to the coverage table and the new file list.
- "Configuration": the `pypi:` form for `allow` and `internalPrefixes`.
- The JSON example gains `run.ecosystems`.

## Open points

1. **Severity of a PyPI 404.** Critical, matching the npm online 404.
   Alternative: high, matching the npm offline finding, on the grounds that
   PyPI has no offline corroboration. Recommended default: critical; the
   registry answer is the stronger evidence in both ecosystems.
2. **`--extra-index-url` to a public index** (a PyTorch wheel index, for
   example) skips every name in that file, which costs coverage on many
   machine-learning repositories. The same ruling applies to a lockfile
   entry whose recorded origin matches a declared index. Recommended
   default: skip in 0.13.0; add
   a trust-base config key listing index origins known to be public in a
   later minor, rather than guessing which hosts are public.
3. **A project whose every release is yanked** answers 2xx. Recommended
   default: exists, no finding, in 0.13.0; record how often it occurs in
   the validation baseline before deciding whether it deserves the npm
   tombstone treatment.
4. **An unreadable Python lockfile** is a diagnostic, not exit 2.
   Recommended default: diagnostic, because nothing judged these files
   before and the package manager refuses a corrupt lock; revisit when a
   Python tamper rule makes the lockfile a subject in its own right.
5. **Requirements file names.** The pattern set in section 2 plus `-r`
   following. Recommended default: ship it; a trust-base config key naming
   extra requirements files is the follow-up if dogfood finds misses.
6. **Normalising git and url Python names.** Leaving them written avoids
   re-keying baselined tamper findings. Recommended default: leave them in
   0.13.0 and note it; normalise in a release that announces the re-key.
7. **Sequential lookups and large JSON bodies.** Recommended default:
   sequential, like every other online step; if the validation baseline
   shows audit runs on real lockfiles spending most of the 300 s budget, add
   bounded concurrency (four in flight, deadline asked before each
   dispatch) in a patch release.
8. **`build-system.requires` and `[dependency-groups]`** widen what is read.
   Recommended default: read both; both are names a frontend fetches from
   the index.
9. **`dep-guard check <name>` stays npm-only**, which is why it judged a
   Python typo against the npm corpus. Recommended default: out of scope
   for 0.13.0; a later `check --ecosystem pypi` uses this lookup.
10. **Where the dogfood baseline lives.** Recommended default: a checked-in
    `docs/dogfood/` file per run, diffable by the next run.
11. **`lockfile-missing` in a Python-only repository** stays as it is until
    the Phase 3 rewording. Recommended default: no interim change, because
    the `names:` line already tells the reader which Python files were read.
