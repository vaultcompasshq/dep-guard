# @vaultcompass/dep-guard-core

The engine behind [dep-guard](https://github.com/vaultcompasshq/dep-guard).
It reads a dependency change -- a staged diff, a branch against a base ref,
or the whole working tree -- and scores it against six offline,
deterministic checks: unknown or hallucinated package names, typosquats,
newly acquired install scripts, lockfile tampering, version hygiene, and
dependency confusion. Two further checks are available over the network when
a caller opts into them.

Most people who want dep-guard want the command line, not this package:
[`@vaultcompass/dep-guard`](https://www.npmjs.com/package/@vaultcompass/dep-guard)
wraps this engine, holds no gate logic of its own, and is one install away
from working. Reach for this package only when you are embedding the scan or
the propose-time name check in another tool -- an editor plugin, a bot, an
MCP server. Node 22 or newer.

```
npm install @vaultcompass/dep-guard-core
```

## The API

Two functions do the work, and they answer the only two questions this
engine has: whether a repository's dependency change is clean, and whether a
single proposed name is safe to add.

```js
import { scan, checkSingle } from '@vaultcompass/dep-guard-core';

const result = await scan({ repoRoot: process.cwd(), mode: { kind: 'staged' } });
// result.exitCode is 0 or 1; result.findings carries the rest.

const answer = await checkSingle({ repoRoot: process.cwd(), name: 'some-package' });
```

Both take an optional `failOn` threshold, an optional `online` flag, and an
optional `corpusDir` that overrides the corpus shipped inside this package.
`scan` takes a `mode` of `{ kind: 'staged' }`, `{ kind: 'base', ref }`, or
`{ kind: 'audit' }`. Both return the same `ScanResult` shape, so a caller can
treat the two answers identically: `findings`, the `suppressed` and `ignored`
counts, a `run` block carrying the mode, the effective threshold, the
blocking-match count, the lockfile format that was read, any diagnostics, and
the corpus build date, and an `exitCode` of 0 or 1. A `checkSingle` result
always carries a note saying that only the three name-based rules were
meaningfully run, since there is no lockfile or real specifier behind a bare
name.

Alongside those, the package exports `loadConfig` and its `ResolvedConfig`
type for reading `.dep-guard.json` the way a scan does, `FAIL_ON_LEVELS` for
validating a threshold before passing it in, `DepGuardError` (every failure
this engine raises deliberately, each carrying a `code`), and the
`Diagnostic`, `FailOn`, `Finding`, `RuleId`, `ScanMode`, `ScanResult`, and
`Severity` types.

That is the entire public surface. The package's `exports` map resolves only
the index and `package.json`, so a deep import into `dist/` is unsupported
and will not resolve. Widening the surface later is easy; narrowing it after
someone depends on an internal path is not, which is why it starts here.

## Errors and exit codes

`DepGuardError` is the deliberate failure path: an unreadable or corrupt
corpus, an invalid config or baseline file, a path that is not scannable.
The engine never answers "clean" when it could not read what it needed --
the CLI turns these into exit code 2, and an embedder should treat them the
same way rather than falling through to a pass. `exitCode` on a returned
result is only ever 0 or 1, and diagnostics never move it.

## The corpus

The existence check reads a corpus that ships inside this package: a bloom
filter over package names collected from a walk of the public registry
replica, a popularity list of about 25,000 names, and the confusion-pair
list. It resolves from a default path inside the installed package, so
nothing has to be configured, and `corpusDir` is there for a corpus you
built yourself.

It is a snapshot with a build date, carried through to `run.corpusBuiltAt`
on every result. A package published after that date reads as unknown until a
release refreshes the corpus, which is the standing cost of answering the
existence question without a network call. Releases carry a freshly built
corpus for that reason.

## Stability

0.1.0 is the first published version, and this package moves in lockstep
with the CLI: they always carry the same version, because the CLI pins an
exact core version at publish time. Across 0.x, the exit codes, the
fail-closed posture, and the fingerprint's four-component shape hold. The
`ScanResult` shape, rule ids, signal strings, diagnostic codes, config keys,
and the corpus format may each change in a minor, with the break named in
the release notes. The full policy is in
[docs/release/stability-policy.md](https://github.com/vaultcompasshq/dep-guard/blob/main/docs/release/stability-policy.md).

## License

MIT. See [LICENSE](./LICENSE).
