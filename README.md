# dep-guard

Blocks risky dependencies at the moment they are added -- before install,
before commit, before CI.

```bash
npm install -g @vaultcompass/dep-guard
```

```bash
dep-guard check <name>        # is this one name safe to add
dep-guard scan --staged       # what this commit adds
dep-guard scan --base main    # what this branch adds
dep-guard init                # run the staged scan on every commit
```

[`@vaultcompass/dep-guard`](https://www.npmjs.com/package/@vaultcompass/dep-guard)
is on npm and works out of the box: the package name corpus ships inside
[`@vaultcompass/dep-guard-core`](https://www.npmjs.com/package/@vaultcompass/dep-guard-core),
so a scan needs no `--corpus-dir` and no setup. Building your own corpus
stays possible; see [Building a corpus](#building-a-corpus).

**Stability.** dep-guard is 0.x. The exit codes and the fail-closed posture
hold across 0.x; flags, config keys, rule ids and the JSON shape may change
in a minor release, and the release notes name each break. See the
[stability policy](docs/release/stability-policy.md).

## Why

Coding agents write dependency changes straight into `package.json` and
lockfiles. Nobody runs `npm install` and reads the output any more, which
removes the last human checkpoint that used to catch a bad name.

Attackers noticed. A model asked for a library will sometimes name one that
does not exist, and the same invented name can come back across prompts, so
an attacker can register it in advance and wait for it to be installed. The
attack is often called slopsquatting.

The tools that gate installs sit after the point where this lands. dep-guard
reads the dependency diff -- or answers a single proposed addition with
`dep-guard check <name>` -- and scores it before anything is fetched.
dep-guard ships no MCP server; an agent integration calls the CLI or the
core library's `checkSingle`.

Two open pull requests show it on a real repository: a dependency whose
name does not exist on npm
([conductor-proof#6](https://github.com/vaultcompasshq/conductor-proof/pull/6)),
and a pull request that turns off its own checks first
([#7](https://github.com/vaultcompasshq/conductor-proof/pull/7)).

Each release is also scanned against a pinned public bench corpus: 17
public repositories, each pinned to an exact commit
([bench/repos.public.json](bench/repos.public.json)), with the result
recorded in [bench/baseline.public.json](bench/baseline.public.json). Three
of the 17 baseline entries stop with exit 2 on purpose: each of those
repositories carries a fixture or template file the parsers cannot read (two
unparseable lockfiles, one unparseable `pyproject.toml`), and a gate that
cannot read its inputs is meant to fail closed rather than report clean. The
baseline records those stops instead of dropping the rows. The bench is a
regression check, not an accuracy score.

## What it checks

Six rules, all offline and deterministic (plus five optional online checks
-- see below):

- **Unknown package** -- for npm, a new name absent from a corpus of real
  npm package names. The hallucination signal. For Python, no PyPI corpus
  ships, so a Python name is checked for existence only with `--online`,
  against PyPI itself (see "Online checks").
- **Typosquat** -- for npm, edit distance against a popularity list, plus
  transform rules that catch what distance misses: separator swaps, scope
  flattening (`babel-core` against `@babel/core`), repeated and omitted
  characters, keyboard adjacency, and a curated list of known confusion
  pairs. For Python, typosquat compares a new name with the other Python
  names the same repository declares (and, on a comparison run, the names
  the base declared). No list of popular PyPI projects ships, so a typo of a
  project the repository does not already use is caught only by the online
  existence check, and only when the typo is not a registered project.
  A resemblance needs a target of at least three characters (`cn` is not
  reported against `co`); the curated confusion pairs are exempt.
- **Install script** -- a dependency that gains the ability to run install
  scripts. Acquisition only: a version bump of a package that already ran
  them is not a finding, or every `npm update` would be noise. A change that
  adds the npm lockfile, or replaces it with one sharing no entry, makes
  every scripted package in it read as acquired; those are reported as one
  high finding that names the count and the packages, with `allow` as the
  remedy for the ones you have reviewed. The severity and the exit are the
  same as for one package, and `ignorePaths` and the baseline apply to the
  per-package findings first.
- **Lockfile tamper** -- resolutions moving to another host, integrity
  hashes removed, forged, or downgraded to a weaker algorithm, and tarballs
  repointed within the same host. It also reads the declared specifier, so a
  dependency pointed at a git or url source instead of the registry is
  reported even in a repository whose lockfile format this tool cannot
  parse. Every spelling npm reads as git counts: `github:`, `gitlab:`,
  `bitbucket:`, `gist:`, `sourcehut:`, a bare `owner/repo` (with or without
  `#ref`), `git+...`, `git://`, `ssh://`, and scp-style `git@github.com:o/r`
  for the hosts npm knows. That covers only what a manifest declares: in a
  yarn or bun repository a transitive dependency that arrives from a git or
  url source is invisible, because no lockfile entry is read for it. In an
  npm or pnpm repository a lockfile entry that is newly added from a git or
  non-registry source is reported even when no manifest declares it. Any revision that MOVES a dependency to a git or url source blocks
  at `critical`, pinned to a commit or not: an attacker's fork pinned to a
  commit is still an attacker's fork. The one softened case is a scan with
  no earlier revision to compare against, where every dependency reads as
  newly added whether or not it is. There, a git source already pinned to a
  full commit SHA reports at `low`, because it cannot change under you and
  blocking it would refuse the first commit of every repository that has
  one. A mutable ref still blocks even in that mode, since what it installs
  can change without your manifest changing.
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
extremely popular target -- see [Online checks](docs/online-checks.md).

## Online checks (`--online`)

Online checks: see [docs/online-checks.md](docs/online-checks.md). Five
optional checks, off by default.

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

The action installs the scanner with `--ignore-scripts`, so nothing in the
resolved tree runs code on your runner at install time, and then runs
`npm audit signatures` over what it installed.

**What that verification proves, and what it does not.** It asks the registry
for each name and version in the tree, the scanner included, and checks the
signature served back, so an unpublished, replaced or unsigned package fails
the step. It does **not** read the installed files, so it will not detect a
tampered install. It does **not** defeat a compromised registry, which signs
what it serves. And a **missing** attestation is not a failure, so it does not
require provenance even though this package publishes it.

> **Two ways this step fails closed, both on purpose.**
>
> It needs **npm 10.5.2 or newer**. Below that, npm reports a clean install of
> these packages as tampered with, because its own bundled keys are stale
> rather than because anything is wrong. The action refuses up front and names
> the npm it found. `node-version: 22` is not on its own enough: Node
> **22.0.0 ships npm 10.5.1**, one patch below the floor. Node 20.13.0 and
> later, and 22.1.0 and later, carry a usable npm.
>
> **If you are on `@v0.6.2`, upgrade.** That release shipped this floor as
> 10.6.0, which was wrong by two patch versions and refuses Node 20.13.x with
> a message saying the client cannot verify signatures when it can.
>
> It also needs a registry that serves `/-/npm/v1/keys`. A runner pointed at a
> mirror or proxy that does not, via `actions/setup-node`'s `registry-url:`, a
> corporate `~/.npmrc`, or `npm_config_registry`, installs fine and then fails
> with `EMISSINGSIGNATUREKEY`. A sigstore outage has the same effect.
>
> If either blocks you, pin `vaultcompasshq/dep-guard@v0.6.1`, which does not
> verify.

```yaml
permissions:
  contents: read
  security-events: write

steps:
  - uses: actions/checkout@v7
    with:
      # Required on pull_request runs: pull-request mode reads the config
      # and the baseline from the base branch, which a shallow checkout
      # does not have.
      fetch-depth: 0
  - uses: vaultcompasshq/dep-guard@v0.16.1
    with:
      path: .
      online: 'true'
      fail-on: high
```

No `version` input in that example, because the default is the scanner version
this action tag shipped with. Leaving it out is the recommended shape: the
action tag then decides the scanner, and there is one pin to bump instead of
two that can disagree.

**The action tag and the scanner version are separate numbers, and they do not
have to match.** `vaultcompasshq/dep-guard@v0.6.4` installs
`@vaultcompass/dep-guard@0.6.0`, because that release changed the action and
nothing in the scanner, so there was no new scanner to publish. Read the action
tag as "which version of the workflow step", not as "which version of the
scanner". The `version` default is always the scanner that tag was tested
against, which is the other reason to leave the input out.

Inputs: `path` (default `.`), `online` (`true`/`false`, default `false`),
`fail-on` (`critical|high|medium|low|none`, unset means dep-guard's own
default), plus `version` (an EXACT version, default the one the action
shipped with), `trust-base` (see
[Pull-request mode](docs/pull-request-mode.md)), `sarif-output` (default
`dep-guard-results.sarif`), and `upload-sarif` (set `false` to write the
file without uploading it, for a repository that does not have code
scanning enabled).

The SARIF is uploaded *before* the run is failed, so a scan that found
something still gets its findings into code scanning. `security-events:
write` is required for the upload; `actions/checkout` must run first.

Publish age (like the other three `--online` checks) needs `online: 'true'`
set on the Action itself, not merely in `.dep-guard.json`: the Action's own
`online` input defaults to `false` and, in that case, always appends
`--no-online` to the scan command, which overrides a committed
`"online": true` rather than merely leaving it alone (see
[Online checks](docs/online-checks.md)).

### Where the scanner comes from

The action installs `@vaultcompass/dep-guard` from the registry into a prefix
under the runner temp and calls that copy by absolute path. It never runs the
checkout's own `node_modules`, and never starts npm with the checkout as its
working directory, so neither a committed `.npmrc` nor a package the head's
lockfile put in `node_modules` can decide which program does the scanning.

`version` no longer accepts a dist-tag, and no longer defaults to `latest`.
Two reasons. A tag means the scanner judging a pull request is whichever one
the registry served that morning rather than one decided in the workflow file.
And npm reads a value beginning with a dot, or ending in `.tgz`, as a PATH
rather than a version, which on a run that started inside the checkout was one
committed file away from the tree handing over its own scanner. **If you were
relying on the old `latest` default, pin an exact version now**; a dist-tag is
refused with a message saying so.

**On a pull request, `version` may not pin BACKWARD.** The shape check above
proves the value names a version and says nothing about which one, so every
published version clears it, and twenty-one are published below the tag scanner
(0.1.0 through 0.16.0).
What stops a backward pin today is not that check but a flag: `--trust-base`
arrived in the 0.6.0 scanner, the run step appends it on every pull-request run
with no opt-out, and a scanner at or below 0.5.0 answers `error: unknown option
'--trust-base'`. So such a pin already fails the job, at the scan, with a
message about an unknown option instead of about the pin. This rule moves the
failure up to the validate step and names the cause. On a same-repo
`pull_request` event GitHub runs the workflow file from the pull request HEAD,
so the `version:` input is written by the pull request being judged: the day a
newer scanner ships with new rules, a pull request pins the old one and is
judged by the rule set it chose for itself. That is the same hole `trust-base: off` was refused
for, except that deleting a security step reads as deleting a security step
while a version pin reads as version management.

**So on a pull-request event the Action refuses a `version` below the scanner
the tag ships, and accepts anything at or above it.** Pinning forward is still
allowed there, on an assumption the rule does not enforce: that a newer scanner
is at least as strict. That assumption has already failed once: 0.11.0 could
skip a workspace member or a lockfile under a directory named `build`,
`dist`, `vendor`, `vendored`, `venv` or `.venv`, and is deprecated on npm.
Use 0.16.1 or newer; do not pin 0.11.0. Nothing bounds a forward
pin. The comparison is against a constant in `action.yml`, which comes from the ref your workflow's `uses:`
names rather than from the pull request's tree. That holds when your workflow
names this action by owner and ref; if it names a LOCAL PATH instead, the
`./some/dir` form, `action.yml` is read out of the pull request's own tree, so
the constant is author-controlled there and this rule protects nothing.
Self-testing workflows inside this repository are the usual reason to
reference it that way.

The rule fires exactly where `GITHUB_BASE_REF` is set, which is `pull_request`
and `pull_request_target`. Push runs are out of scope. That is a statement of
scope, not a safety argument: a push to an unprotected branch runs that
branch's own workflow file, written by the same author, so it is as
author-controlled as a pull request and is not covered.

The refusal names both numbers and the fix, which is to **remove the `version`
input**. What it costs: twenty-one scanners are published below the tag scanner,
so a workflow pinning any of `0.1.0` through `0.16.0` passes the shape check on a pull request today and
is refused by this rule. A pin below `0.6.0` is already broken on that event,
since those scanners do not know `--trust-base`; the change there is that the
job fails at the validate step with a message saying why. A pin of `0.6.0`,
`0.7.0`, `0.8.0`, `0.9.0`, `0.10.0`, `0.10.1`, `0.11.0`, `0.11.1`, `0.12.0`, `0.13.0`, `0.14.0`, `0.15.0`, or `0.16.0` fails on version alone: it
knows `--trust-base` and would otherwise run cleanly. **Remove the `version` input,
or raise it to `0.16.1` or newer.**

**What it does not cover, and what it costs on forks.** A fork's
`pull_request` run uses the base repository's workflow file, so a fork author
never writes the `version:` that judges them and there is no hole there to
close. The rule still fires on that run: `GITHUB_BASE_REF` is set on a fork
pull request too, so the check runs and judges your own trusted workflow file.
A backward pin you deliberately wrote in the base workflow will fail every fork
pull request, which is a refusal on a pin nobody untrusted wrote. If you need
that pin, remove the `version:` input or raise it.

What this does not cover either is the workflow file itself, which a pull
request can edit like any other CI step: it does not stop a pull request
deleting the step, or moving the `uses:` pin to an older Action tag. Branch
protection on the base branch, with review required for `.github/workflows/**`,
is the control for that.

`bench/action-install.mjs` proves the install boundary above against real npm:
a committed `.npmrc` and a planted `node_modules` copy, run against two local
registries and the pre-fix `action.yml` from tag `v0.6.0` as a negative
control. `pnpm bench:action-install` runs it and exits non-zero on any drift
from the recorded baseline; `pnpm bench:action-install:update-baseline`
re-records it after a deliberate change.

**Linux and macOS runners.** The installed binary is called at
`<prefix>/bin/dep-guard`, which is where a global npm install puts its shims on
those two. Windows puts them in the prefix directory itself, so the path would
not exist and the job would fail as could-not-run.

## Pull-request mode (`--trust-base`)

Pull-request mode: see [docs/pull-request-mode.md](docs/pull-request-mode.md).
On a pull-request run dep-guard takes every control input from the base ref,
and the head tree is the thing being judged. The guide also covers the
Action's handling of it, protecting the workflow file, and requiring a human
approval.

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
| `properties.ignoreOverride` | on a finding an `ignorePaths` entry matched and did not drop (see [Configuration](docs/configuration.md)), the entries and how the change installs the path |
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
dep-guard scan --staged     # what this commit adds
dep-guard scan --base main  # what this branch adds
dep-guard scan              # audit the whole tree
dep-guard check <name>      # is this one safe to add
dep-guard init              # install the pre-commit hook

dep-guard scan --base origin/main --trust-base origin/main   # judging a pull request
```

`--corpus-dir <dir>` is optional on every command: it points at a corpus you
built yourself, and the shipped one is used by default.

`--trust-base <ref>` is pull-request mode, on both `scan` and `check`: the
config and the baseline come from `<ref>` rather than from the tree being
judged, and a head-side change to either is reported and ignored. The ref
is also a comparison side for the lockfile set rule, and when it is a
different tree from the `--base` ref its dependency state is read too. It
is a different question from `--base`, which decides what the change is
compared against. See [Pull-request mode](docs/pull-request-mode.md).

`--format json` prints a single result object on stdout with diagnostics on
stderr, so a consumer can parse stdout alone. `--format sarif` does the
same with a SARIF 2.1.0 log; `--format text` (the default) is the
human-readable report.

Exit codes are the contract: 0 clean, 1 findings at or above the threshold,
2 something went wrong. A gate that cannot read its own
inputs fails closed rather than reporting clean. Almost every exit 2 stops
before a report exists. One does not: a `--base` or `--trust-base` run that
left a candidate name unchecked online (see
[Online checks](docs/online-checks.md)) prints its
full report and still exits 2, with `run.couldNotRun` in the JSON and, in
SARIF, `executionSuccessful: false` and one error notification in the
single invocation.

Set the threshold with `--fail-on critical|high|medium|low|none`. Default is
`medium`.

## Configuration

Configuration: see [docs/configuration.md](docs/configuration.md). The
`.dep-guard.json` keys, how `ignorePaths` and `allow` behave, and why every
config key is read from the base ref on a pull request.

## Building a corpus

The corpus is a bloom filter over known npm package names, a popularity
list, and a list of confusion pairs. A freshly built one ships inside the
published core package, so nothing here is required for normal use --
this section is for building your own, either to point `--corpus-dir` at
something newer than the last release's walk or to work on the corpus
machinery itself. `packages/core/fixtures/corpus` holds a small
development corpus useful for tests and useless for real work -- it knows
fifty package names.

The bundled corpus has a cadence, because it decays: every name published
after its walk reads as unknown until the next one. The release workflow
rebuilds it from a live registry walk on every release, and a release
carrying a fresh corpus goes out at least once a month while development is
active, on a minor version as the
[stability policy](docs/release/stability-policy.md) describes. Every scan
records the walk's date as `corpusBuiltAt` in its JSON output, so a scan
against a corpus older than that promise is visible rather than silent.

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

dep-guard checks that a Python name exists on PyPI and does not resemble
another name your repository uses; it does not look up advisories, which is
what osv-scanner (the umbrella's vulnerabilities gate) does, and neither
result stands in for the other.

## Ecosystem coverage

Ecosystem coverage: see [docs/ecosystem-coverage.md](docs/ecosystem-coverage.md).
npm and Python (PyPI) manifests and lockfiles are read; Go files are not.

## Lockfile support

Lockfile support: see [docs/lockfile-support.md](docs/lockfile-support.md).
Coverage is stated per format, and where a format cannot answer a question
the scan says so in a diagnostic.

## Part of the Vault & Compass guardrails

<!-- guardrails-family: shared block, keep it identical in dep-guard, vault-guard, intent-guard and conductor -->
The Vault & Compass guardrails are three gates over an AI-assisted coding
session, plus an optional umbrella: [dep-guard](https://www.npmjs.com/package/@vaultcompass/dep-guard)
checks what comes in (hallucinated package names, typosquats, tampered
lockfile entries),
[vault-guard](https://www.npmjs.com/package/@vaultcompass/vault-guard) checks
what goes out (credentials about to be committed), and
[intent-guard](https://www.npmjs.com/package/@vaultcompass/intent-guard)
checks the change against what was approved (drift from a frozen intent
contract, and change budgets). Each one installs, configures and runs on its
own;
[conductor](https://www.npmjs.com/package/@vaultcompass/conductor) is the
optional umbrella that runs them from one policy file, one hook and one
report, beside two scanners you install yourself:
[gitleaks](https://github.com/gitleaks/gitleaks) for secrets anywhere in git
history and [osv-scanner](https://github.com/google/osv-scanner) for known
vulnerabilities. conductor scans nothing itself and installs nothing that
is not its own.
<!-- /guardrails-family -->

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

Adopter feedback is a row in [FINDINGS.md](FINDINGS.md). How to change this repository is in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. Built by [Vault & Compass](https://vaultcompass.io).
