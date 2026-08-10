# dep-guard

Blocks risky dependencies at the moment they are added -- before install,
before commit, before CI.

**Status: pre-release.** The engine and CLI work and are covered by 738
tests, but the package name corpus is not built yet, so `--corpus-dir` is
required and nothing is published to npm. See [Building a corpus](#building-a-corpus).

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

Six rules, all offline and deterministic:

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
  dependencies.
- **Dependency confusion** -- a scope pinned to a private registry that
  resolves from the public one, and internal names arriving from outside.

Findings carry a severity and a stable fingerprint. A fingerprint survives
version bumps and corpus refreshes, so a baseline you accept today keeps
working tomorrow.

## Usage

```
dep-guard scan --staged --corpus-dir <dir>     # what this commit adds
dep-guard scan --base main --corpus-dir <dir>  # what this branch adds
dep-guard scan --corpus-dir <dir>              # audit the whole tree
dep-guard check <name> --corpus-dir <dir>      # is this one safe to add
```

`--format json` prints a single result object on stdout with diagnostics on
stderr, so a consumer can parse stdout alone.

Exit codes are the contract: **0** clean, **1** findings at or above the
threshold, **2** something went wrong. A gate that cannot read its own
inputs fails closed rather than reporting clean.

Set the threshold with `--fail-on critical|high|medium|low|none`. Default is
`medium`.

## Configuration

`.dep-guard.json` at the repo root, overlaid by an optional
`.dep-guard.local.json`:

```json
{
  "failOn": "medium",
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
list, and a list of confusion pairs. It is not bundled yet. Until it is,
`packages/core/fixtures/corpus` holds a small development corpus that is
useful for trying the CLI out and useless for real work -- it knows fifty
package names.

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
