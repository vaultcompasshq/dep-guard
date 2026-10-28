# Pull-request mode (`--trust-base`)

**On a pull-request run dep-guard takes every control input from the base
ref, and the head tree is the thing being judged.**

Two discovery inputs are still read from the head, because reading them
from the base would hide the very packages a pull request adds: the
workspace patterns (which manifests are scanned) and the npm workspace
siblings that are exempt from the name checks. A sibling is exempt only
when the npm lockfile its directory installs from links it to a
`package.json` of exactly that name in the head tree, in a directory the
install root's `workspaces` field covers, and only for the manifests that
lockfile covers. That `workspaces` field is read from the trust base
wherever the base has it, so a pull request cannot widen it to cover a
package it plants. A decoy lockfile, a link to nothing, or a link to a
directory outside the workspaces exempts nothing
(`workspace-link-unconfirmed` names each claim that failed and why). The
same holds for which manifests the head installs: that cannot widen what
the base's `ignorePaths` drops, so a pull request that wires an ignored
directory into the install keeps its findings there (see
[Configuration](configuration.md)).

Without that rule a pull request can turn the gate off in the same commit
that carries what the gate exists to catch. `.dep-guard.json`,
`.dep-guard.local.json`, `.dep-guard.baseline.json` and `.npmrc` all live
in the tree under judgment, so one commit could add a hallucinated
dependency and, in the same diff, add its name to `allow`, add its manifest
to `ignorePaths`, raise `failOn` above the finding's severity, or write the
finding's own fingerprint into the baseline. Every one of those exits 0
today.

`.npmrc` belongs on that list for a reason worth spelling out, because it
is the one people miss: its scope-to-registry pins are the entire
precondition of the dependency-confusion pin-mismatch rule, which fires
only for a scope that *has* a pin. So a pull request that adds
`@scope/package` resolving from the public registry **and deletes
`.npmrc`** removes the rule rather than passing it.

```
dep-guard scan --base origin/main --trust-base origin/main
```

On a pull request, pass `--base` and `--trust-base` together. With both,
the lockfile downgrade rule (see [Lockfile support](lockfile-support.md))
has to hold
against the `--base` side and against the trust base. The entry-level
checks (tamper, install script, the name checks) compare against the
`--base` side. `--trust-base` on its own still judges the lockfile set
against the trust base, but reports findings as an audit; with `--staged`,
the lockfile set is compared with HEAD only.

The config, the baseline and the `.npmrc` pins are read from `<ref>` with
`git ls-tree` and `git show`. Nothing is checked out, nothing is written
into the repository. A head-side change to any of them never takes effect
for the run and is reported instead:

```
Pull-request mode: control inputs from origin/main
  config changed in this pull request (proposed: allow some-package)
  baseline changed in this pull request (1 baseline entries added)
  npmrc changed in this pull request (proposed: unpin @scope)
```

The scope pins and the unscoped default registry (`registry=...`) are what
is compared in `.npmrc`, not the file text, so a rotated auth token is not
reported as an attempt to loosen the gate, but a changed default registry
is: it is the one other line online checks read (see
[Online checks](online-checks.md)), and a pull request editing only that line is reported as `npmrc
changed in this pull request (proposed: default registry changed)`.

Python package-index declarations (every index option in a requirements
file, the poetry, uv and pdm sources, `Pipfile` sources, a repository
`uv.toml`, and per-name mappings onto a named index) and a uv workspace
root's `members` and `exclude` are control inputs too: each is read from the
trust base copy of the same path, and a base copy that is a gitlink or does
not parse stops the run (exit 2, `python-index-invalid`). A head-side change
to the index declarations is reported as `python index changed in this pull
request (requirements.txt)`. A head-side change to `members` or `exclude`
has no proposal line of its own: the base copy's members decide the scope of
every `[tool.uv.sources]` entry, and a name that only the head's wider
`members` would bring into that scope is checked like any other, with a
`python-workspace-unconfirmed` diagnostic saying so. A base copy that is a symlink does not stop a pull
request that replaces the link with a regular file: the base then
contributes no declarations for that file, so every name in it is looked up,
and `python-index-unread-comparison-side` says so.

A control input the head carries and the base does not reads `config added
in this pull request`, and the run uses the defaults rather than the head's
proposal. The allow counter keeps reporting what the *base* allow list
cleared, so the two lines answer two different questions: what the approved
config did, and what this change wanted instead.

`--trust-base` is not `--base`, and neither implies the other. `--base`
decides what the change is compared against; `--trust-base` decides by
whose rules it is judged. They usually name the same ref in CI, because the
base branch is both the state you diverged from and the state whose rules
were approved, but either can be passed without the other. When
`--trust-base` is present, an explicit `--base` that resolves to HEAD's own
commit or tree is refused with exit 2 rather than silently comparing HEAD
against itself and going quiet on every comparison-based signal; a bare
`--base` with no `--trust-base` is unaffected, since comparing a dirty
working tree against HEAD locally is legitimate.

**Without a `--base`, every dependency reads as newly added**, because the
scan has no earlier revision to compare against. That is not a special
case of pull-request mode; it is the state of every scan that never passes
`--base`, `--trust-base` included. The table below says which checks still
run in that state, derived from what each check reads rather than guessed:

| Check | No `--base` (every dependency reads as newly added) | With `--base` (real comparison) |
| --- | --- | --- |
| Unknown package | runs | runs |
| Typosquat | runs | runs |
| Install script | runs for every entry, reported at low, which does not block at the default fail-on | runs |
| Lockfile tamper | does not run for comparison signals* | runs |
| Version hygiene | runs | runs |
| Dependency confusion | runs | runs |
| Publish age (`--online` only)** | runs, over every resolved dependency in the lockfile | runs, over only the dependencies whose resolved version was added or changed |

\* Lockfile tamper's resolved-URL, integrity, and source-host comparison
signals need a lockfile entry on both sides of the change, so they are
skipped with no earlier revision (`packages/core/src/delta.ts`, the
`AUDIT_NO_TAMPER_COMPARISON` diagnostic around line 620). Its specifier-based
git-source and url-source signals read the current manifest specifier only,
not a comparison, and iterate `delta.changes`
(`packages/core/src/checks/tamper.ts`, around line 911): with no earlier
revision every dependency reads as a change, so they run over every
dependency; with a `--base`, `computeDelta` skips a dependency whose
specifier held and whose lock entry did not differ
(`packages/core/src/delta.ts`, around lines 567-578), so they run only over
added or changed dependencies there. A git source pinned to a full commit
is reported at `low` rather than `critical` when there is no earlier
revision, since the pin cannot be told apart from one that was already
present (`sourceSwapReport`, around line 225).

Install script is downgraded rather than skipped: with no earlier
revision, `hasComparisonBase` is false, so a dependency that already runs
install scripts cannot be told apart from one that just gained the
ability. `present` is a *signal*, not a severity: the finding's severity
drops from `high` to `low`, and the signal reported is `present` instead
of `added` or `flag-acquired` (`packages/core/src/checks/install-script.ts`,
`presenceReport` around line 109 and its callers around lines 200 and 267).
The pnpm `onlyBuiltDependencies` branch (around line 300) makes the same
severity drop on its own allowlist entries, reporting signal
`only-built-added` as `present` instead. This is separate from pnpm's own
install-script gap: `pnpm-lock.yaml` records no per-entry install-script
flag at all, with or without `--base`, so its coverage is limited to
`onlyBuiltDependencies` additions regardless (see
[Lockfile support](lockfile-support.md)). That limitation stays as
documented; this table is about the comparison-based signals only.

\*\* Publish age is one of the five `--online` checks (see
[Online checks](online-checks.md)) and does not run at all without `--online` or `"online": true`,
regardless of `--base`. When it does run, it reads `delta.lockEntryChanges`
directly rather than `delta.changes`: with no earlier revision every
resolved lockfile entry reads as added (the same rule every other row in
this table follows), so every dependency in the lockfile is a candidate;
with a `--base`, only a resolved version that was added or changed in the
diff is (`packages/core/src/online/publish-age.ts`).

The gate fails closed, exit 2, with nothing scanned, when the ref does not
resolve, when it resolves to HEAD's own commit, and when it is a different
commit carrying HEAD's tree. That last one is not a hypothetical: what
GitHub publishes as `refs/pull/N/merge` is a merge commit whose tree, when
the base has not moved since the fork, *is* the head branch's tree, so
`--trust-base` pointed at the merge or head SHA would read every control
input straight back out of the tree under judgment. Pass the base *branch*.

`--format json` gains a `trustBase` block (`ref`, `proposals`,
`configChanged`, `baselineChanged`, `npmrcChanged`, `configShapeChange`,
`baselineShapeChange`, `npmrcShapeChange`, `projectPathsChanged`,
`ignoredPathsMadeProjects`), and SARIF carries each proposal as a
`toolExecutionNotification` rather than as a result, because a proposal is
a fact about the run and not a finding about the code.

Outside pull-request mode nothing changes. A pre-commit hook and a direct
CLI run on your own checkout are already inside the trust boundary, so they
never pass the flag and their output is byte for byte what it was. Two
0.16.0 rules are the exception, applied to every `--base` and `--staged`
run too so that a local run predicts the pull-request verdict: the
`ignorePaths` rule in [Configuration](configuration.md) (which adds `N kept over
ignorePaths` to the text summary of those runs), and, on a `--base` run
only, the exit 2 for names left unchecked online.

## In the Action

The composite action passes the flag for you on a `pull_request` event, and
on no other event, using `origin/$GITHUB_BASE_REF`. The only thing your
workflow has to do is give `actions/checkout` `fetch-depth: 0`, because the
base branch has to be present to be read. Set `trust-base` to a ref to
point pull-request mode at a different base.

There is deliberately **no value that turns pull-request mode off**, and
`trust-base: off` is refused with an error rather than quietly ignored. An
opt-out input would be settable by the pull request itself, for exactly the
reason in the next section: on a same-repository `pull_request` event the
workflow file runs from the pull request's own head. A knob the untrusted
side can turn is not a boundary, so base-ref judging is the floor rather
than a setting. If you need the old behaviour while you arrange
`fetch-depth: 0`, stay pinned to `@v0.5.0` until you have arranged it.

The action passes `--base` the same way, and separately from `trust-base`:
on a `pull_request` event it appends `--base origin/$GITHUB_BASE_REF` by
default, and on any other event it appends nothing by default, so a push
run stays exactly what it was before this input existed. Set `base` to a
ref to redirect comparison at a different base on a push, schedule, or
workflow_dispatch run; the same `fetch-depth: 0` requirement, the same
refusal of `off`, and the same charset rules apply as they do to
`trust-base`. Unlike `trust-base`, `base` cannot be redirected on a
`pull_request` event at all: an explicit value there is refused with an
error, because a pull request could otherwise point comparison at its own
head or branch and empty the delta the gate exists to see, so every
`pull_request` run gets the default. An unresolvable ref exits 2 on any
event. Without a `--base` -- a push, schedule, or workflow_dispatch run
that has not set one -- the scan runs with no earlier revision to compare
dependencies against and stays in audit mode; see the table above for
exactly what that costs. A `pull_request` run always has one, since
`GITHUB_BASE_REF` is always set on that event.

## Protecting the workflow file itself

One thing pull-request mode cannot do for you. On a **same-repository**
`pull_request` event the workflow file runs from the pull request's own
head, so a pull request can edit the workflow that runs the gate: delete
the step, pin the action back to a version that had no pull-request mode,
or drop `fetch-depth: 0`. Reading the control inputs from the base ref does
not help against any of those, because by then the gate was either never
invoked or never reached its own inputs.

This is also the reason `trust-base` has no opt-out value. A workflow-level
switch is reachable by a pull request on this event, so shipping one would
have handed the attack a supported spelling instead of making it edit the
workflow in ways a reviewer and a required check will notice.

Close that in branch protection, not in this repository's files: make the
dep-guard job a **required status check** on the protected branch, so a
pull request that deletes it cannot merge, or call it through a **reusable
workflow pinned to a ref on a protected branch**, so the pull request's own
copy is not what runs. Pull requests from forks do not have this problem in
the same way, since their workflow changes need approval to run at all.

## Requiring a human approval

Some teams want more than "the base ref decided": they want a person to
have approved a config or baseline change before it takes effect. That is
an add-on, and it belongs in **GitHub branch protection plus a CODEOWNERS
entry** for `.dep-guard.json`, `.dep-guard.local.json` and
`.dep-guard.baseline.json`, so a change to any of them needs a review from
the named owners before it can land on the base branch.

It is deliberately not a setting in `.dep-guard.json`. A mode selector that
lives in the file a pull request controls is a knob a pull request flips to
whichever mode is weaker; base-ref loading is the floor precisely because
it is the one thing a pull request cannot write. An add-on that can only
make the gate stricter is safe to offer, and this one lives where the pull
request cannot reach it.
