# Deny list (`deny`)

A deny list names packages this repository refuses: by exact name, by whole
scope, or by exact version, each with a reason. Every manifest line and every
entry of every npm and pnpm lockfile in the tree is judged against it on every
run, not only what a change adds, so a ban added on the base branch fails
every pull request until the package is gone. A match is a critical
`denied-package` finding that prints the reason.

```json
{
  "deny": [
    { "name": "event-stream", "reason": "compromised in 2018 (flatmap-stream)" },
    { "name": "ua-parser-js", "versions": ["0.7.29", "0.8.0", "1.0.0"],
      "reason": "hijacked releases", "reviewBy": "2027-06-30" },
    { "name": "@abandoned-scope/*", "reason": "unmaintained, migrate to X" },
    { "name": "pypi:ctx", "reason": "account takeover, May 2022" }
  ],
  "denyUnreadLockfiles": "fail"
}
```

Run `dep-guard scan` (an audit) before adopting a ban, to find the
packages it already covers. A deny gate is a root scan: `dep-guard scan
<path>` does not apply a lockfile above that path, and says so in the
`lockfile-outside-prefix` note.

## Entries

An entry has these fields and no others; an unknown field (`expires`, say)
is `config-invalid`, so a typo fails loudly instead of widening or narrowing
the ban.

- `name` (required): an exact npm name, compared case-insensitively;
  `@scope/*`, the only wildcard, which covers `@scope/anything` and not
  `@scope-other/x`; or `pypi:<name>`, compared in PEP 503 normalised form. A
  bare entry never matches a Python name, and a `pypi:` entry never matches
  an npm one. `*`, `foo*`, `@*/x` and an empty scope are refused.
- `reason` (required): 1 to 300 characters, with no control, bidi or
  zero-width character. Every finding prints it.
- `versions` (optional, npm entries only): exact versions, never a range,
  never an empty list. Absent means every version.
- `reviewBy` (optional): a real `YYYY-MM-DD` date. It asks for a review on
  that date and never lifts the ban: once it has passed, the entry keeps
  blocking, the message says the review date has passed, and a
  `deny-review-overdue` note names the entry on every run, matched or not.
  A ban is lifted by a reviewed edit to the list, never by the calendar.
  Note the direction: an expiry date on an exception ends the exception, so
  the finding comes back; `reviewBy` on a ban keeps the ban.

Also refused: a plain string entry (the message shows the object shape), a
`deny` value that is not an array, and an exact duplicate (the same
normalised name and the same versions). Two entries for one name with
different versions are allowed and are separate findings.

`denyUnreadLockfiles` is `"fail"` (the default) or `"note"`, and
`denyUnreadAcknowledged` is a list of `PATH:BLOBID` entries, each accepting
one unread lockfile's exact bytes; see below. A `denyUnreadAcknowledged`
entry whose path is not a lockfile name, or that has an empty, `.` or `..`
part, is `config-invalid`.

## What is matched

An entry matches a package when any name the files dep-guard reads give for
it matches:

- npm lockfiles (`package-lock.json`, `npm-shrinkwrap.json`, and nested
  ones): the key at any depth, the entry's `name` field, the package the
  tarball URL names (read as written and fully percent-decoded), and `link`
  entries by their folder name.
- pnpm lockfiles (every `lockfileVersion` dep-guard reads, every YAML
  document of a multi-document file): the key's name, the entry's own `name`
  field, the tarball name, and the name-shaped parts of a key no parser
  splits (a pre-v9 git or tarball key), including an entry the parser
  otherwise skips. A tarball written as a path is resolved against the
  registry first, as pnpm resolves it.
- `package.json`: every dependency under its key and under its alias target
  (`npm:` specifiers), and a URL specifier under the package its tarball
  names.
- Python manifests and lockfiles (`requirements*.txt`, `pyproject.toml`,
  `Pipfile`, `poetry.lock`, `uv.lock`, `pdm.lock`, `Pipfile.lock`): each name
  in PEP 503 form, and the distribution name a wheel or sdist file name
  carries.

A dependency alias edge on its own is not a match: npm records it by
dependency name across the whole lockfile, so it would land on every
same-named entry.

A versioned entry matches when any of these versions is listed: the version
the entry records, the version in the tarball file name, and for pnpm the
version in the key. Build metadata is ignored; a prerelease matches only
when listed exactly. When no version backs what installs (no readable
version, a git, file or url source, a host the project does not name, a
tarball file name with no version), the versioned entry matches by name
alone and the message says so. A manifest range under a lockfile dep-guard
reads is left to the lockfile; with no such lockfile, it matches by name.
`dep-guard check <name>` has no version, so a versioned entry always matches
there, and says no version was given.

One finding per entry, package and install root: a manifest line and the
lockfile entry it installs fold into one, and two roots give two. The
fingerprint is the rule, the package, the anchor and the entry, so a version
bump or a hoisting move keeps it.

## Where the list comes from

| Run | List applied |
|---|---|
| `--trust-base <ref>` (the Action, conductor) | the trust base's only |
| `--base <ref>`, no trust base | the union of the `--base` ref's list and the working tree's |
| `--staged` | the union of HEAD's list and the working tree's |
| audit, `check` | the working tree's |

On a `--trust-base` run a head change to the list never takes effect: a ban
the head removes still applies and is named in the proposals ("proposed:
lift deny event-stream", or `name@version` for a dropped version), and a ban
the head adds is counted ("1 deny entry added") and applies once merged. A
head `.dep-guard.local.json` with `"deny": []` is a lift like any other.

Without a trust base, a change cannot lift its own ban either: the union
keeps every entry the comparison side has, with the comparison side's
reason and review date when both sides hold the same entry, and a
`deny-entry-kept-from-comparison-side` note names what the change dropped. A
ban the change adds applies at once. A `--base` run reads the `--base` ref's
config on every run, so a base config that does not validate is
`config-invalid`. A `--staged` run reads HEAD's config entry by entry, so a
broken HEAD config cannot block the commit that fixes it; what it could not
read is named in a `deny-head-config-invalid` note. `denyUnreadLockfiles`
takes the stricter of the two sides.

## What clears a deny finding

Only a reviewed edit to the list.

- `allow` never clears it. A package on both lists is named in a
  `deny-overrides-allow` note.
- The baseline never clears it, from either side. A baseline entry that
  would have matched is counted in a `deny-kept-over-baseline` note.
- `ignorePaths` clears it only on a path nothing installs on the judged side
  or the comparison side, such as a fixture lockfile with no manifest beside
  it. On an installed path it is kept, with `ignoreOverride.position` "a
  denied package on an installed path". A lockfile entry counts as installed
  when the project beside its lockfile is a project on either side, and it
  is anchored only on a declaring manifest that is a project, so a nested
  fixture package.json under an ignored directory that declares a name the
  root project installs cannot hide that entry.
- `failOn` applies as for every rule: at `none` the finding is reported and
  does not block.
- The online checks leave it untouched.

## Lockfiles the deny list cannot read

yarn.lock, bun.lock, bun.lockb, npm lockfileVersion 1, and an unread nested
lockfile are not read. With a non-empty list:

- An unread lockfile nothing installs from gets `lockfile-not-read`, which
  then says the deny list judged manifest names only for it.
- An install lockfile it cannot read (one with a project manifest beside it,
  or the one a project on either side resolves from), or a project with
  declared dependencies and no lockfile dep-guard reads, means the list
  cannot say what that project installs. A `--base` or `--trust-base` run
  then exits 2 with `run.couldNotRun` `deny-lockfile-unread`, naming the
  files, unless `denyUnreadLockfiles` is `"note"` or `denyUnreadAcknowledged`
  accepts that lockfile's bytes (both read from the trust base; a change to
  either is a proposal). Audit and `--staged` runs say so in a
  diagnostic. A gap counts for npm-family files only when the list has an
  npm entry, and for Python files only when it has a `pypi:` entry.
- A tree with nothing that can install (no manifest, no lockfile) passes
  with a `deny-nothing-to-judge` note.
- Lockfile entries a parser skipped, and unread pnpm documents, are counted
  in `deny-entries-unread`.
- A nested `package.json` that no rule makes a project (a test fixture, say)
  counts as covered by the nearest lockfile at or above it, so it is never a
  gap of its own. A versioned ban on a range it declares is left to that
  lockfile, which may not hold the package at all: such a manifest is not
  judged as an install, because nothing installs from it.

### Which repositories exit 2 on every pull request

Once the list is non-empty, every `--base` or `--trust-base` run of a
repository in one of these shapes exits 2 (`deny-lockfile-unread`), on
every pull request, a docs-only one included, until one of the two ways out
below is on the base branch:

- a project that installs from a `yarn.lock`;
- a project that installs from a `bun.lock` or `bun.lockb`, including a
  smoke-test or example directory with its own `package.json` beside one;
- a project whose `package-lock.json` or `npm-shrinkwrap.json` is
  lockfileVersion 1;
- a library or any other project with declared dependencies and no lockfile
  at all;
- with a `pypi:` entry on the list, a Python project with a
  `requirements.txt` and no Python lockfile dep-guard reads (`poetry.lock`,
  `uv.lock`, `pdm.lock`, `Pipfile.lock`), even when every line is pinned
  with hashes, as `pip-compile --generate-hashes` writes it: the file names
  what is installed but is not read as a lockfile.

The two ways out, both read from the base branch only (the trust base,
else the `--base` ref, else HEAD for `--staged`), so a pull request cannot
accept its own gap:

- Acknowledge one unread lockfile: `"denyUnreadAcknowledged":
  ["tests/smoke/bun/bun.lock:BLOBID"]`, the lockfile's repository path and
  the full git blob id of its exact bytes. The `deny-lockfile-unread`
  message prints the entry to add for each unread lockfile. An acknowledged
  lockfile is named in a `deny-lockfile-acknowledged` note on every run. The
  acknowledgement holds only while the lockfile's bytes are the ones named
  AND every package.json project that installs from it (the one beside it
  and every project whose nearest lockfile directory is that one) is the
  same path with the same bytes as on the side the acknowledgement was read
  from. A changed lockfile, a changed installing manifest, or an installing
  project added or removed makes it a gap again, and the
  `deny-lockfile-unread` message names which manifest changed. A pull
  request that changes what installs from an acknowledged lockfile therefore
  exits 2; once it is merged, the base holds the new manifests and the
  acknowledgement holds again for the next pull request. Every other unread
  lockfile still exits 2. A project with no lockfile at all,
  and a Python gap, cannot be acknowledged this way.
- Accept every gap: `"denyUnreadLockfiles": "note"`. The gaps are then
  said in a diagnostic and never exit 2, for any lockfile or project.

On a `--trust-base` run a head that adds an acknowledgement is named in the
proposals ("proposed: accept unread lockfile ...") and takes effect only
once merged.

## What the deny list cannot see

The deny list matches names and versions that the files dep-guard reads
write. Every one of them is text the change's author writes. What backs that
text differs by format:

- npm lockfiles (v2 and v3). The tarball-identity rule reports a tarball that
  names a different package than the key or an accepted alias, or a
  different version than the entry records (`tarball-version-mismatch`,
  high). The source rules report a git, url or unnamed host, and the location
  rules a location the scan cannot read. A banned package from a local file,
  a git commit, or a host the project names that serves other bytes is
  matched only by the names the lockfile writes. A bundled package ships
  inside its parent's tarball: deleting its record hides it from the deny
  list while npm still installs it. lockfileVersion 1 is not read.
- pnpm lockfiles with a tarball URL: as for npm, through the same
  tarball-identity rule.
- pnpm entries with no tarball URL (the common case). pnpm builds the URL
  from the key, and from the snapshot version on pnpm 10. No tamper rule
  checks these entries. The deny list matches the key, the entry's `name`
  field and both versions, so what pnpm fetches is in the set; nothing
  confirms the bytes beyond the integrity hash, which the same author writes.
- pnpm pre-v9 git and tarball keys the parser cannot split and has no
  location for: matched by the name-shaped parts of the key only.
- Python manifests and lockfiles. Lockfiles are read for names only, with no
  tarball-identity or source rule beside them. The deny list sees only the
  name the file writes, plus a name derived from a wheel or sdist file name.
  Python versions are not matched: a `pypi:` entry takes no `versions`.
- yarn and bun. The lockfile is not read; only manifest lines and URL
  specifiers are matched, and a pull-request run exits 2 as above.

dep-guard reads files. It does not run at install time, so nothing here
stops an install run outside CI, a package manager pointed at another
registry, or a lockfile dep-guard never saw. The deny list narrows what can
install unnoticed; it is not a guarantee that a banned package is absent.

## Diagnostics

| Code | Meaning |
|---|---|
| `deny-review-overdue` | an entry's `reviewBy` has passed; the ban still applies |
| `deny-overrides-allow` | a package is on both lists; allow does not clear it |
| `deny-kept-over-baseline` | baseline entries that would have matched; the findings are kept |
| `deny-entry-kept-from-comparison-side` | the change dropped entries the comparison side has; they still apply |
| `deny-head-config-invalid` | `--staged`: HEAD's config could not be read in full |
| `deny-entries-unread` | lockfile entries a parser skipped and unread pnpm documents |
| `deny-nothing-to-judge` | a non-empty list and nothing in the tree that can install |
| `deny-lockfile-unread` | an install the list cannot read; `run.couldNotRun` on a pull-request run |
| `deny-lockfile-acknowledged` | unread lockfiles the base's `denyUnreadAcknowledged` accepts, with their bytes and every installing package.json unchanged |

The JSON result's `run.deny` is `{ "entries": N }` when the run applied a
non-empty list, and absent otherwise.
