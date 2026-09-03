# dep-guard

Blocks risky dependencies at the moment they are added -- before install,
before commit, before CI.

**Status: published.** [`@vaultcompass/dep-guard`](https://www.npmjs.com/package/@vaultcompass/dep-guard)
is on npm, covered by 1162 tests, and works out of the box: the package
name corpus ships inside
[`@vaultcompass/dep-guard-core`](https://www.npmjs.com/package/@vaultcompass/dep-guard-core),
so a scan needs no `--corpus-dir` and no setup. Building your own corpus
stays possible; see [Building a corpus](#building-a-corpus).

## Why

Coding agents write dependency changes straight into `package.json` and
lockfiles. Nobody runs `npm install` and reads the output any more, which
removes the last human checkpoint that used to catch a bad name.

Attackers noticed. Models hallucinate package names at a few percent, and
roughly two in five hallucinated names repeat across identical prompts, so
they are predictable enough to register in advance. In January 2026 a
registered hallucinated name reached 237 repositories through
agent-generated files, with automated fetches starting within days.

The tools that gate installs sit after the point where this lands. dep-guard
reads the dependency diff -- or answers a proposed addition over MCP -- and
scores it before anything is fetched.

## What it checks

Six rules, all offline and deterministic (plus three optional online checks
-- see below):

- **Unknown package** -- a new name absent from a corpus of real npm package
  names. The hallucination signal.
- **Typosquat** -- edit distance against a popularity list, plus transform
  rules that catch what distance misses: separator swaps, scope flattening
  (`babel-core` against `@babel/core`), repeated and omitted characters,
  keyboard adjacency, and a curated list of known confusion pairs.
- **Install script** -- a dependency that gains the ability to run install
  scripts. Acquisition only: a version bump of a package that already ran
  them is not a finding, or every `npm update` would be noise.
- **Lockfile tamper** -- resolutions moving to another host, integrity
  hashes removed, forged, or downgraded to a weaker algorithm, and tarballs
  repointed within the same host.
- **Version hygiene** -- wildcard and `latest` specifiers on new
  dependencies. Demoted rather than exempted on `@types/*` packages: a
  DefinitelyTyped package ships no runtime code, so an unpinned range on one
  cannot hand an attacker code that executes, but it stays visible and
  `install-script` still covers the residual risk of its own install
  scripts.
- **Dependency confusion** -- a scope pinned to a private registry that
  resolves from the public one, and internal names arriving from outside.

Findings carry a severity and a stable fingerprint. A fingerprint survives
version bumps and corpus refreshes, so a baseline you accept today keeps
working tomorrow.

**A known limitation in this release:** typosquat's curated confusion pairs
(the 48 documented registry incidents, plus anything you add via
`extraAliases`) block at the default threshold, as they always have.
Everything else the check reports -- separator swaps, scope flattening,
repeated or transposed characters, keyboard adjacency, and edit distance --
is resemblance rather than a known confusion, and measuring it against nine
well maintained public repositories found three findings, all of them false
positives, and zero true positives. So for now those matches report at
`low`: visible if you scan at `--fail-on low`, but out of the default gate.
Lowering your own threshold to `low` or below re-enables them as blocking.
This is exactly what `--online` now addresses: turned on, a non-alias-list
match escalates from `low` to `high` once the candidate's own weekly
downloads confirm it is genuinely unpopular, not merely smaller than an
extremely popular target -- see below.

## Online checks (`--online`)

Off by default, permanently -- this tool reads manifests and lockfiles
offline by design, and network calls do not belong in a hook or an MCP
propose-time check that has to answer fast. Turn `--online` on for CI or a
scheduled audit, where the latency cost is irrelevant. The flag turns them
on for one run; `"online": true` in `.dep-guard.json` turns them on for
every invocation, pre-commit hooks included, which is why a
latency-sensitive setup is usually better off passing `--online` in CI
alone.

Three checks, all backed by npm's public downloads and registry metadata
APIs, all degrading to the offline result with a diagnostic on any network
failure rather than blocking:

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
  never means fewer or quieter findings. Names in your configured
  `internalScopes` or `internalPrefixes` are never sent to the registry at
  all.
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

All three share one wall-clock budget of twenty seconds per run, not per
request. Once it is spent the remaining lookups are skipped, the affected
findings keep exactly the result the offline checks gave them, and an
`online-deadline-exceeded` diagnostic says how many were skipped. Without
it, a repository adding twenty new names could stall a commit for
half a minute while every individual request stayed comfortably inside
its own timeout.

`--no-online` forces the online checks off for one run, overriding
`"online": true` in `.dep-guard.json`. That is the flag to reach for in a
pre-commit hook or an air-gapped build in a repository whose committed
config turns them on.

## Installing the pre-commit hook (`dep-guard init`)

```
dep-guard init                        # .git/hooks/pre-commit
dep-guard init --manager husky        # .husky/pre-commit
dep-guard init --manager lefthook     # lefthook-local.yml
dep-guard init --manager precommit    # .pre-commit-config.yaml
dep-guard init --dry-run              # print what would be written
```

The hook runs `dep-guard scan --staged` on every commit. It is safe to
re-run: a second `init` reports the hook is already installed and changes
nothing. It never overwrites a hook it did not write -- if one is already
there, init stops and tells you what to merge in by hand.

A bare `dep-guard init` detects a husky-managed repository on its own: if
`core.hooksPath` points at husky 9's generated `.husky/_` directory, init
installs into the tracked `.husky/pre-commit` file instead, since anything
written under `.husky/_` is regenerated by husky's own install step and
would otherwise vanish on the next `pnpm install`. `--manager husky` is
never required for this.

The generated hook is deliberately **fail-closed**: if the `dep-guard`
binary is not on `PATH`, the commit is blocked with a one-line message
rather than waved through. A gate that switches itself off when the tool
is missing is a gate an attacker turns off by making the tool missing. It
also passes dep-guard's own exit code straight through, so exit 2 ("could
not run the checks") stays distinguishable from exit 1 ("blocking
findings"), which are different facts.

Under `lefthook` and the `pre-commit` framework, those managers own the
hook's exit code themselves. A non-zero dep-guard still blocks the commit,
but the difference between its 1 and its 2 does not survive into the exit
code the manager reports.

**To uninstall,** delete the file init wrote -- the path is printed when
it installs, and `--dry-run` will tell you again. For `lefthook` and
`pre-commit`, delete the file or just remove the `dep-guard` stanza if you
have added your own hooks to it. There is no `init --revert`; one file is
not worth a command that could delete the wrong thing.

## GitHub Action

`action.yml` at the root of this repository is a composite action that
runs dep-guard and uploads the result to GitHub code scanning as SARIF.

```yaml
permissions:
  contents: read
  security-events: write

steps:
  - uses: actions/checkout@v5
  - uses: vaultcompasshq/dep-guard@v0.2.1
    with:
      path: .
      online: 'true'
      fail-on: high
```

Inputs: `path` (default `.`), `online` (`true`/`false`, default `false`),
`fail-on` (`critical|high|medium|low|none`, unset means dep-guard's own
default), plus `version` (the npm dist-tag or version to run, default
`latest`), `sarif-output` (default `dep-guard-results.sarif`), and
`upload-sarif` (set `false` to write the file without uploading it, for a
repository that does not have code scanning enabled).

The SARIF is uploaded *before* the run is failed, so a scan that found
something still gets its findings into code scanning. `security-events:
write` is required for the upload; `actions/checkout` must run first.

## SARIF output (`--format sarif`)

```
dep-guard scan --staged --format sarif > dep-guard.sarif
```

Writes SARIF 2.1.0 to stdout and nothing else, so it can be redirected
straight into a file an uploader consumes. Diagnostics go to stderr, the
same split `--format json` uses.

The mapping, which is stable and shared across this family's gates:

| SARIF field | dep-guard value |
|---|---|
| `tool.driver.name` | `dep-guard` |
| `tool.driver.version` | the installed CLI version |
| `result.ruleId` | `dep-guard/<rule-id>` |
| `result.level` | `error` for critical and high, `warning` for medium, `note` for low |
| `properties.severity` | dep-guard's own severity word, unflattened |
| `properties.blocking` | whether this finding blocks at the run's threshold |
| `properties.details` | the finding's `details` bag, verbatim |
| `partialFingerprints["dep-guard/v1"]` | the finding's existing fingerprint, unchanged |
| `locations[].logicalLocations[]` | `kind: package`, `fullyQualifiedName` the package name |
| `locations[].physicalLocation` | the manifest path, relative, under `%SRCROOT%`; omitted for `dep-guard check`, which has no file behind it |

Two of those are worth calling out. `properties.blocking` is dep-guard's
own gate decision rather than something the consumer recomputes from the
level, because SARIF's four levels cannot express a four-severity scale
plus a configurable threshold. And `partialFingerprints` reuses the
fingerprint dep-guard already uses for baselining, so a GitHub alert and
a dep-guard baseline entry track the same finding across commits instead
of drifting apart. No region is emitted: dep-guard does not record which
line of a manifest a dependency sits on, and a guessed line number is
indistinguishable from a real one once uploaded.

## Usage

```
dep-guard scan --staged --corpus-dir <dir>     # what this commit adds
dep-guard scan --base main --corpus-dir <dir>  # what this branch adds
dep-guard scan --corpus-dir <dir>              # audit the whole tree
dep-guard check <name> --corpus-dir <dir>      # is this one safe to add
dep-guard init                                 # install the pre-commit hook
```

`--format json` prints a single result object on stdout with diagnostics on
stderr, so a consumer can parse stdout alone. `--format sarif` does the
same with a SARIF 2.1.0 log; `--format text` (the default) is the
human-readable report.

Exit codes are the contract: 0 clean, 1 findings at or above the threshold,
2 something went wrong. A gate that cannot read its own
inputs fails closed rather than reporting clean.

Set the threshold with `--fail-on critical|high|medium|low|none`. Default is
`medium`.

## Configuration

`.dep-guard.json` at the repo root, overlaid by an optional
`.dep-guard.local.json`:

```json
{
  "failOn": "medium",
  "online": false,
  "allow": ["some-package", "@acme/*"],
  "internalScopes": ["@acme"],
  "internalPrefixes": ["acme-"],
  "extraAliases": { "unused-imports": ["eslint-plugin-unused-imports"] },
  "ignorePaths": ["fixtures"]
}
```

Two things worth knowing before you use them. `allow` means "ignore this
package everywhere" -- it silences every rule except lockfile tampering,
which is a fact about where bytes come from rather than about the package.
And `ignorePaths` drops findings before the gate sees them, so a pattern
broad enough to match everything would switch the tool off; patterns made
only of wildcards are rejected for that reason.

## Building a corpus

The corpus is a bloom filter over known npm package names, a popularity
list, and a list of confusion pairs. A freshly built one ships inside the
published core package, so nothing here is required for normal use --
this section is for building your own, either to point `--corpus-dir` at
something newer than the last release's walk or to work on the corpus
machinery itself. `packages/core/fixtures/corpus` holds a small
development corpus useful for tests and useless for real work -- it knows
fifty package names.

`scripts/build-corpus.mjs` walks the public registry replica for the names
and reads the popularity list from `scripts/data/top-packages.txt`, which is
checked into this repository rather than fetched. That file is a trust
input: the typosquat rule exempts every name in it, so a name that got onto
it wrongly would have bought immunity. Every name in it exists in a registry
walk this project ran, and cleared a measured floor of ten thousand
downloads in the last week from npm's own downloads API, at the time the
file was built. Its header records both, and
`scripts/refresh-top-list.mjs` is what rebuilds it.

## How it compares

dep-guard is deliberately narrow. It reads manifests and lockfiles at the
moment they change; it does not analyse package contents, mine git history,
or check for known vulnerabilities. Those are other tools' jobs and they do
them well:

| | dep-guard | Socket | Snyk | npq | lockfile-lint |
|---|---|---|---|---|---|
| Agent-edit and staged-diff gate | yes | no | no | no | no |
| Hallucinated name detection | yes | partial | no | partial | no |
| Package content analysis | no | yes | no | no | no |
| Known vulnerabilities | no | partial | yes | no | no |
| Interactive install prompt | no | no | no | yes | no |
| Lockfile trust policy | yes | no | no | no | yes |
| Local only, no account | yes | no | no | yes | yes |

Run it alongside them, not instead of them.

## Lockfile support

Coverage is honest per format rather than uniform. Where a format cannot
answer a question, the scan says so in a diagnostic instead of staying
quiet:

- `package-lock.json` v2 and v3 -- full coverage.
- `pnpm-lock.yaml` v9+ -- full, except install scripts, which the format
  stopped recording. Additions to `onlyBuiltDependencies` are used instead.
- `yarn.lock`, `bun.lock` -- manifest-level checks only. Neither records
  install scripts, and yarn berry records no resolved URL.
- `bun.lockb` -- skipped. Undocumented binary format.

## Development

Node 22+, pnpm 9+.

```
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

`docs/INVARIANTS.md` records the rules the engine depends on across module
boundaries. Read it before changing the delta, the fingerprint, path
handling, or anything that decides an exit code.

## License

MIT
