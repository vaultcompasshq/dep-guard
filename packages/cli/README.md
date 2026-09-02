# @vaultcompass/dep-guard

dep-guard reads a dependency change and decides whether it should land. It
runs at the moment a name enters `package.json` or a lockfile -- before
`npm install` fetches anything, before the commit, before CI -- and answers
with an exit code.

The reason it exists: coding agents write dependency changes straight into
manifests and lockfiles, and nobody reads install output any more, so the
last human checkpoint that used to catch a wrong name is gone. Models
hallucinate package names at a few percent, and the same hallucinated name
recurs often enough across identical prompts to be worth registering in
advance. The tools that gate installs run after the point where that lands.
dep-guard reads the diff and scores it before anything is fetched.

This package is the command line. The engine it wraps is
[`@vaultcompass/dep-guard-core`](https://www.npmjs.com/package/@vaultcompass/dep-guard-core),
published in lockstep with it. Node 22 or newer.

## Install and first run

```
npm install -g @vaultcompass/dep-guard
dep-guard check some-package-name
```

There is no setup step and no account. The package name corpus ships inside
the core package, so a scan resolves it at a default path with no
configuration; `--corpus-dir` exists only to point at a corpus you built
yourself.

The four things it does:

```
dep-guard scan --staged     # what this commit adds
dep-guard scan --base main  # what this branch adds
dep-guard scan              # audit the whole working tree
dep-guard check <name>      # is this one name safe to add
```

`scan` takes an optional path argument and defaults to the current
directory. `--staged` and `--base` cannot be combined. As a pre-commit hook,
`dep-guard scan --staged` is the whole configuration.

## What it catches

Six rules, all offline and deterministic. The engine runs the same six
against a real diff and against the single name you hand `check`.

- Unknown package: a new name that is absent from a corpus of real npm
  package names. This is the hallucination signal.
- Typosquat: edit distance against a popularity list, plus transform rules
  that catch what distance alone misses -- separator swaps, scope
  flattening (`babel-core` standing in for `@babel/core`), repeated and
  omitted characters, keyboard adjacency, and a curated list of known
  confusion pairs drawn from documented registry incidents.
- Install script: a dependency that gains the ability to run install
  scripts. Acquisition only, so bumping the version of a package that
  already ran them is not a finding; otherwise every `npm update` would be
  noise.
- Lockfile tamper: resolutions moving to another host, integrity hashes
  removed, forged, or downgraded to a weaker algorithm, and tarballs
  repointed within the same host.
- Version hygiene: wildcard and `latest` specifiers on new dependencies,
  demoted rather than exempted on `@types/*`, which ship no runtime code.
- Dependency confusion: a scope pinned to a private registry that resolves
  from the public one, and internal names arriving from outside.

Two examples of what that looks like in practice. An agent writes a
dependency whose name no npm package has ever carried: nothing in the
corpus matches it, so the scan reports `unknown-package` and exits 1 with
the install not yet run. Separately, a lockfile edit moves a package's
resolution to a different host than it resolved from before; that is
`lockfile-tamper`, reported whether or not the package itself is fine,
because the finding is about where the bytes come from.

One limit worth knowing before you wire this into CI. Typosquat matches
against the curated confusion pairs block at the default threshold, as they
always have, but everything else the rule reports -- separator swaps, scope
flattening, transposed characters, keyboard adjacency, plain edit distance
-- is resemblance rather than a known confusion, and measuring it against
nine well maintained public repositories produced three findings, all false
positives, and no true positives. Those matches report at `low` for now:
visible at `--fail-on low`, out of the default gate. Turning `--online` on
escalates one back to `high` when the candidate's own download numbers
confirm nobody uses it.

Findings carry a severity and a stable fingerprint. A fingerprint is a hash
over the rule id, the package name, the manifest path, and the finding's
signal, so it survives version bumps and corpus refreshes: a finding you
accept today stays accepted tomorrow. Accepted fingerprints go in
`.dep-guard.baseline.json` at the repo root, as
`{"version": 1, "fingerprints": [...]}`.

## Exit codes and JSON output

The exit codes are the contract, and they do not change between 0.x
versions:

- `0` -- clean, or nothing at or above the threshold.
- `1` -- findings at or above the threshold.
- `2` -- something went wrong: an unreadable corpus, an invalid config, a
  bad flag. A gate that cannot read its own inputs fails closed rather than
  reporting clean.

Set the threshold with `--fail-on critical|high|medium|low|none`. The
default is `medium`. Diagnostics never move the exit code.

`--format json` prints exactly one result object on stdout and sends every
diagnostic to stderr, so stdout can be piped straight into a parser with no
scraping. The object carries `findings`, `suppressed`, `ignored`, `exitCode`,
and a `run` block with the mode, the effective `failOn`, the number of
blocking matches, the lockfile format that was read, the diagnostics, and
`corpusBuiltAt`. The JSON shape may change between 0.x minors; the exit
codes will not.

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

Both of the keys that can weaken the gate are worth reading twice. `allow`
silences every rule for a package except lockfile tampering, which is a fact
about where bytes come from rather than about the package. `ignorePaths`
drops findings before the gate ever weighs them, so a pattern broad enough
to match everything would switch the tool off; patterns made only of
wildcards are rejected for that reason. An unknown config key is an error,
not a warning.

## The corpus, and what it cannot know

The existence check reads a corpus that ships inside the core package: a
bloom filter over package names collected by a walk of the public registry
replica, a popularity list of about 25,000 names checked into the
repository rather than fetched at build time, and the confusion-pair list.
The corpus is rebuilt during each release, and its build date travels with
it -- `corpusBuiltAt` in the JSON output is that date.

Which means a real package published after the corpus was built reads as
unknown until a later release refreshes it. That is the honest cost of an
offline existence check, and it lands as a `low` or blocking finding you
have to look at rather than as silence. The scan does not yet warn you when
its corpus is old; reading `corpusBuiltAt` is on you until it does.

## Online checks

Two checks are off by default and stay that way: this tool reads manifests
and lockfiles offline by design, and network latency does not belong in a
pre-commit hook. Turn them on with `--online`, or with `"online": true` in
the config file if every invocation should pay the cost. Both are backed by
npm's public downloads and registry metadata APIs, and both degrade to the
offline result with a diagnostic when the network fails rather than
blocking.

The first escalates a typosquat match from `low` to `high` once the
candidate's own weekly downloads confirm it is a package nobody uses, not
merely a smaller one with a similar name. The second reports a package
published in the last thirty days with almost no downloads, which is the
case a corpus snapshot structurally cannot catch: a name an attacker
registers today is absorbed by a later corpus refresh and reads as known
forever after. It has no resemblance filter to narrow its candidates, so it
is deliberately conservative and reports below `high` -- a legitimately new
package looks the same by age and downloads alone.

## What it does not do

dep-guard is narrow on purpose. It reads manifests and lockfiles at the
moment they change. It does not analyse package contents, mine git history,
sandbox an install, or check anything against a vulnerability database, so
it is not a replacement for `npm audit`, Snyk, or Socket -- it sits beside
them and answers a question they answer late or not at all. Run it alongside
them.

Lockfile coverage is honest per format rather than uniform, and a scan says
in a diagnostic where a format cannot answer: `package-lock.json` v2 and v3
are fully covered; `pnpm-lock.yaml` v9+ is covered except install scripts,
which the format stopped recording, so additions to `onlyBuiltDependencies`
are read instead; `yarn.lock` and `bun.lock` get manifest-level checks only;
`bun.lockb` is skipped as an undocumented binary format.

`dep-guard check` is a name-only question, so it exercises the three
name-based rules (existence, typosquat, and the internal-name half of
dependency confusion) and says so in a note on every run. The other three
need a real lockfile or a real specifier.

## Stability

0.1.0 is the first published version. Exit codes, the fail-closed posture,
and the fingerprint's shape hold across 0.x; the JSON shape, rule ids,
signal strings, diagnostic codes, config keys, CLI flags, and the corpus
format may each change in a 0.x minor, and any break is named in the release
notes. If you adopt during 0.x, the verdicts are worth having and the exit
codes are safe to wire into CI, but treat a baseline file and any JSON
parsing as tied to the minor you installed. The full policy, including what
has to be true before 1.0.0, is in
[docs/release/stability-policy.md](https://github.com/vaultcompasshq/dep-guard/blob/main/docs/release/stability-policy.md).

Source, issues, and the longer documentation live at
[github.com/vaultcompasshq/dep-guard](https://github.com/vaultcompasshq/dep-guard).

## License

MIT. See [LICENSE](./LICENSE).
