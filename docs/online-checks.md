# Online checks (`--online`)

Off by default, permanently -- this tool reads manifests and lockfiles
offline by design, and network calls do not belong in a hook or a
propose-time `dep-guard check` that has to answer fast. Turn `--online` on for CI or a
scheduled audit, where the latency cost is irrelevant. The flag turns them
on for one run; `"online": true` in `.dep-guard.json` turns them on for
every invocation, pre-commit hooks included, which is why a
latency-sensitive setup is usually better off passing `--online` in CI
alone.

Five checks: four backed by npm's public downloads and registry metadata
APIs, and one PyPI existence check against the PyPI JSON API. All of them
degrade to the offline result with a diagnostic on any network failure
rather than blocking, and all five share one per-run time budget. The four
npm checks share one rule for which names may
be put on the wire to the public registry at all: a name in your configured
`internalScopes` or `internalPrefixes` is never sent, and neither is a name
declared private by your own project `.npmrc` -- a scope pin, or the
unscoped default registry when no pin applies to that scope. A pin decides
by its **own origin**, not by merely existing, and always outranks the
default registry: a scope pinned to the public registry is checked even
under a private project default, and a scope pinned away from the public
registry is skipped even under a public project default. A `.npmrc`-derived
skip (a scope pin, or the default registry) is recorded as a diagnostic
naming the package; an `internalScopes`/`internalPrefixes` skip is silent
by design, not diagnosed -- a name your own committed config already lists
needs no reminder that it was excluded.

- **Unknown package resolution.** The offline unknown-package rule answers
  from a corpus built on one dated registry walk, so every package
  published after that walk reads as unknown to that release, forever.
  `--online` asks the registry directly. If the name really exists, the
  unknown-package finding is **downgraded to `low`** rather than removed:
  `low` is below the default gate, so it stops blocking, but it stays in
  the report so you can still see that dep-guard looked at the name and
  what it concluded. That matters for one case in particular: a name
  registered after the corpus walk but more than thirty days ago falls
  outside registered-squat's age window, so this `low` finding is the only
  thing dep-guard says about it. The downgrade asserts only that the name
  exists; typosquat and registered-squat still judge whether it is
  *suspicious*, which is the question that actually matters. If the
  registry answers 404, the finding escalates from `high` to `critical`,
  because the innocent explanation the offline message offers ("published
  after that date") has just been ruled out. A 200 is not automatically
  taken as existence: a name whose versions have all been unpublished, or
  one npm has seized and replaced with a `0.0.1-security` placeholder,
  keeps its `high` finding, since npm taking a name over is not evidence
  the name is safe. Anything else -- a timeout, a server error, a spent
  budget -- leaves the finding exactly as the offline scan made it, still
  blocking, with the reason recorded in its `details`. A network failure
  never means fewer or quieter findings. On a `--base` or `--trust-base`
  run such a name is also unchecked, which exits 2 (see "A spent budget"
  below), since a `high` finding alone passes `failOn: "critical"`.
- **PyPI existence.** Every new Python name, from requirements files,
  `pyproject.toml`, `Pipfile` and the poetry, uv, pdm and pipenv lockfiles,
  is looked up once per run in its PEP 503 normalised form
  (`Python_Dateutil` is the PyPI project `python-dateutil`). A 404 is a
  `critical` unknown-package finding, the same severity an npm 404 earns:
  the name is on no index the repository declares, so it is a hallucinated
  or mistyped dependency, or a project PyPI has removed. A 2xx whose
  project name matches is the only answer read as "exists", and it vouches
  for nothing more than that a project of that name exists. Every other
  answer -- a 3xx (never followed), a 5xx after one retry, a timeout, a
  2xx describing another project or none, any other 4xx -- and a spent
  budget leave the name unchecked, with a diagnostic and a count, and never
  a finding; on a `--base` or `--trust-base` run an unchecked name exits 2
  instead, unless `onlineUnchecked` is `"note"`. The lookup runs second,
  after npm unknown-package resolution and before the three npm steps that
  add or escalate; on a tight budget an
  npm registered-squat or publish-age signal can be lost to PyPI lookups,
  and that step's `online-deadline-exceeded` diagnostic says so. PyPI
  existence is asked live and never cached. Which Python names are never
  sent: a name a `pypi:` entry in `internalPrefixes` covers
  (`"pypi:acme-"`); and every name in a manifest that declares a package
  index other than PyPI (`--index-url`, `--extra-index-url`,
  `--find-links`, `--no-index` in any spelling pip accepts, a non-explicit
  poetry, uv or pdm source, a `Pipfile` source, a repository `uv.toml`),
  or, for an explicit index, the names pinned to it. Those index
  declarations are control inputs: on a `--trust-base` run they are read
  from the trust base, and a head-side change is reported as a proposal
  and does not take effect. A lockfile's own recorded source never skips an
  entry by itself; it skips only when it equals an origin a manifest in the
  same directory declares. The skip is a coverage gap, not a safety
  property: `pypi-private-index-skipped` names each one, and for an index
  pip or uv consults beside PyPI it says that a name not on PyPI is exposed
  to dependency confusion and was not checked. A user-level `pip.conf`,
  `PIP_INDEX_URL`, `UV_INDEX_URL` or a CI-level index setting is invisible
  to this check; list such private names under `internalPrefixes` with the
  `pypi:` prefix.
- **Typosquat popularity asymmetry.** Escalates a non-alias-list typosquat
  match from `low` to `high` when the candidate's own weekly downloads sit
  below a measured floor of two thousand downloads in the last week --
  confirming the match is not just a name that resembles something popular,
  but a package genuinely nobody uses.
- **Registered squat.** A new, `medium`-severity finding for a dependency
  published within the last thirty days with fewer than fifty downloads in
  the last week. This exists because the offline existence check reads a
  corpus snapshot: a name registered by an attacker, then absorbed by a
  later corpus refresh, reads as "known" forever afterward. This check has
  no resemblance filter to narrow its candidates the way typosquat's does,
  so it is deliberately conservative (both signals required, not either
  alone) and reports below `high` -- it carries the same false-positive
  risk the offline existence check has: a legitimately brand-new package
  looks identical to a squat by age and downloads alone.

- **Minimum publish age.** A `high`-severity finding for a resolved
  dependency version published more recently than `minAgeDays` (default 7)
  days ago, or with a future-dated publish timestamp at any floor including
  `0`. Lets a repository align dep-guard's "too new to trust" judgment with
  its own Dependabot minimum-release-age cooldown, rather than only ever
  answering that question through registered-squat's hardcoded thirty-day
  window, which exists to catch a squatted *name* rather than to express a
  general age-acceptance policy. Reads the LOCKFILE's resolved versions,
  not manifest ranges: in `--base` mode, every dependency whose resolved
  version was added or changed in the diff; with no `--base`, every
  resolved dependency in the lockfile, exactly as every other check reads
  "added" with no earlier revision to compare against. A package the
  registry does not know, or a version still missing from its publish-time
  record after a live lookup, is left unflagged rather than guessed at --
  the unknown-package check above is what says a name itself looks wrong --
  but each case is recorded as a diagnostic rather than passed over in
  silence, since this check's own candidates come from the lockfile, which
  is mostly transitive entries no manifest ever names and unknown-package
  never sees. `minAgeAllow` (an array of exact `name@version` strings) is a
  reviewed exception for one specific release, never a standing exemption
  for the name, and a config entry may not itself be a semver range. This
  check applies the shared `.npmrc` rule above to the RESOLUTION as well as
  the name, and the order matters: a scope pinned to a *private* registry
  skips the entry unconditionally, whatever its resolvedUrl says (a
  resolvedUrl that disagrees with a private pin is a pin *mismatch*, which
  dependency confusion's own rule is what raises, not evidence this check
  may proceed). Otherwise -- no pin, or a pin naming the public registry --
  a resolvedUrl, when the lockfile entry has one, decides by its own origin
  before anything else does; a public (or absent) pin never overrides a
  resolvedUrl actually in hand. Only when the entry has no resolvedUrl at
  all does the default registry decide, the same way a privately-pinned
  scope is skipped. pnpm does not record which registry served an ordinary
  resolution at all, so this is the ordinary shape of a pnpm lockfile entry:
  when the project's default is private it is skipped; when none is set (or
  it names the public registry), the entry is checked as public, since
  nothing in the project's own configuration says otherwise -- a private
  dependency's name is not put on the wire to a public service just to
  price this heuristic.
  A *user*-level `~/.npmrc` default registry, or an `npm_config_registry`
  environment variable, is invisible to this check and to the rest of the
  scan -- a repository relying on either of those instead of a project
  `.npmrc` must list the private names under `internalScopes` or
  `internalPrefixes`. The same gap applies to an npm lockfile written with
  its own registry-resolved URLs omitted.

A registry error in any of the five checks degrades to a diagnostic
rather than a block, the design every check above already follows for its
own network failure: it never turns an otherwise-clean scan's exit 0 into
an exit 1 by itself. On a `--base` or `--trust-base` run the name it left
unchecked is an exit 2 instead, as the next paragraph says.

All four share one wall-clock budget per run, not per request. Once it is
spent the remaining lookups are skipped, the affected findings keep exactly
the result the offline checks gave them, and an `online-deadline-exceeded`
diagnostic says how many were skipped. On a plain run (no `--base`, no
`--trust-base`) a spent budget or an unreachable registry stays a
diagnostic. On a run with `--base` or `--trust-base`, a candidate name left
unchecked for either reason exits 2, listing the names with their step and
reason in the report, on stderr and in `run.online.unchecked`, unless
`onlineUnchecked` is `"note"` on the governing config (the trust base's on
a `--trust-base` run). Only "it exists" or a 404 is a checked name. A name
the `allow` list clears, a confirmed workspace sibling, an internal name,
and a name sent to a private registry or index are never counted. The run
still scans and the full report is printed; the exit is 2 because a
pull-request run does not pass a name it could not check. Remedies: raise
`onlineBudgetMs` on the base branch, set `"onlineUnchecked": "note"` there,
or split the change. The umbrella (conductor) reads any gate's exit 2 as
could-not-run, so its run is red too. Known open: publish-age skips a name
whose resolved URL is not the public registry, and that URL is
head-written; a foreign-host entry is a `high` lockfile-tamper finding, so
it is not silent, but under `failOn: "critical"` that name passes with
publish-age unchecked.

The budget defaults to **20000ms (twenty seconds)** for a plain run: no
`--base` and no `--trust-base` on the command line, whatever else is
running it. That is the pre-commit hook shape, where a developer is
waiting on the command to finish, and a repository adding twenty new names
should not stall a commit for half a minute while every individual request
stays comfortably inside its own timeout. It defaults to **300000ms (five
minutes)** only when the command line actually carries `--base` or
`--trust-base` -- not "in CI" more broadly. The GitHub Action (see
[the README](../README.md#github-action) and "In the Action" in
[pull-request-mode.md](pull-request-mode.md)) only ever adds either flag on a `pull_request` event: on
a `push` or `schedule` run it passes neither, per its own `ARGS` assembly,
so those runs get 20000ms too, the same as a bare `dep-guard check` in any
job that never passes `--trust-base`. Where `--base`/`--trust-base` land is
the pull-request-triggered run specifically, because that is the shape
with minutes to spend and a large dependency change as the expensive
failure mode, once its remaining lookups quietly keep their offline result
after the hook-sized budget runs out. Either
default can be overridden: the `onlineBudgetMs` key in `.dep-guard.json`
sets it for every invocation (like `"online"` itself, only meaningful
alongside it), and `--online-budget-ms <ms>` overrides both the key and the
default for one run. An explicit config key or flag always wins over
whichever default would otherwise apply.

`--online-budget-ms` is a workflow-file decision, the same as `--online`
and `--base` themselves: whatever value a job's own `dep-guard scan`
invocation carries is what runs. On a **same-repository** pull request that
value is only as trustworthy as the workflow file is, since that event runs
the pull request's own copy of it -- see "Protecting the workflow file
itself" in [pull-request-mode.md](pull-request-mode.md) for what closes that gap (branch protection, not
`--trust-base`), and why a fork pull request does not have the same
exposure.

`--no-online` overrides `"online": true` in the config, and the Action
passes `--no-online` unless its `online` input is true. So on a `--base` or
`--trust-base` run whose governing config (the trust base's, under
`--trust-base`) says `"online": true` while the command line turns online
off, every candidate name counts as unchecked with the reason
`online-disabled`, and the run exits 2 under the same `onlineUnchecked`
key. A base config with `online` false or absent is unchanged. An Action
adopter whose base config says `"online": true` must set the Action's
`online` input to true, or set `"onlineUnchecked": "note"` on the base
branch.

The run's JSON output always carries an `online` object under `run`,
whether or not online checks ran, so a CI consumer (the conductor umbrella
in particular) can read it unconditionally: `enabled`, the `budgetMs`
actually used, `lookupsAttempted` and `cacheHits`, `lookupsSkippedByDeadline`
(skipped lookups once the budget was spent, matching what the
`online-deadline-exceeded` diagnostics already say -- the same name can be
counted here more than once if two different online checks both had it
queued when the budget ran out), and `deadlineExceeded`. Disabled online
checks report `enabled: false` and every number at zero, never an absent
field. Since 0.16.0 it also carries `unchecked`, `{ count, names: [{ name,
ecosystem, step, reason, status? }] }` (sorted, uncapped), whenever online
checks ran or the online-disabled rule above applied, at count zero too;
`reason` is `budget`, `unreachable` or `online-disabled`.

`lookupsAttempted` and `cacheHits` count the name lookups the online steps
made: `lookupsAttempted` counts those sent to the registry, `cacheHits`
those answered from the on-disk cache. A name is counted once per lookup,
so one step can count a name twice (registered-squat looks up downloads and
then the creation date) and several steps each count it again. A downloads
lookup may batch many names into one request; these count the names, not
the requests. `lookupsAttempted: 0` with `cacheHits: 5` is a warm cache;
`0` and `0` is a run with nothing to look up. The text output prints both
on its `online:` line.

```json
"online": {
  "enabled": true,
  "budgetMs": 300000,
  "lookupsAttempted": 42,
  "cacheHits": 8,
  "lookupsSkippedByDeadline": 0,
  "deadlineExceeded": false
}
```

PyPI lookups count in the same totals. Beside `online`, `run.ecosystems`
is always present and says, per ecosystem, how many new names were checked
and how many were read but not checked and why (see
[Ecosystem coverage](ecosystem-coverage.md)):

```json
"ecosystems": {
  "npm":  { "manifests": 2, "candidates": 3, "checked": 3,
            "notChecked": { "privateScope": 0 }, "lockfile": "read",
            "notParsed": 0 },
  "pypi": { "manifests": 2, "lockfiles": 1, "candidates": 7,
            "requirements": 9, "pinned": 9, "notParsed": 0,
            "existenceChecked": 5, "resemblanceChecked": 7,
            "notChecked": { "offline": 0, "budget": 1, "unreachable": 1,
                            "privateIndex": 0, "internal": 0,
                            "lockfileUnreadable": 0 },
            "excluded": { "url": 0, "vcs": 1, "path": 0, "editable": 0,
                          "constraint": 0, "self": 0, "invalidName": 0,
                          "unrecognised": 0 } },
  "go":   { "files": 0 }
}
```

`excluded` counts every Python requirement on the judged side that is not a
name candidate, by why; `candidates` and the not-checked counts are new
names after dedupe, one per normalised project name. `lockfileUnreadable`
counts Python lockfiles that could not be read for names. `npm.lockfile` is
`read`, `not-read` (a lockfile in a format dep-guard does not parse),
`missing`, or `not-applicable` (the `check` command); `pypi.requirements`
and `pypi.pinned` count named Python requirements and those pinned exactly;
`npm.notParsed` and `pypi.notParsed` count manifests that did not parse and
were skipped because `ignorePaths` covers them (`manifest-unparsed`);
`go.files` counts `go.mod` and `go.sum` files.

`--no-online` forces the online checks off for one run, overriding
`"online": true` in `.dep-guard.json`. That is the flag to reach for in a
pre-commit hook or an air-gapped build in a repository whose committed
config turns them on.
