# Changelog

Notable changes to dep-guard. Format based on
[Keep a Changelog](https://keepachangelog.com/). What a version number
promises is in `docs/release/stability-policy.md`; this file records what
each release actually changed.

This file starts at 0.6.0. Releases before it are described by their
GitHub release notes, which are generated from the commit history.

## [Unreleased]

## [0.6.0] - 2026-09-06

Minor on all three packages, per the stability policy: 0.x minors may
change CLI flags and the JSON output shape, and this adds a flag, a JSON
block, three new error codes and a new SARIF element. Nothing outside
pull-request mode changed, so no baseline needs regenerating.

**The rule: on a pull-request run, every control input comes from the base
ref and the head tree is the thing judged.**

### Added

- **`--trust-base <ref>` on `scan` and `check`.** Pull-request mode.
  `.dep-guard.json`, `.dep-guard.local.json`, `.dep-guard.baseline.json`
  and `.npmrc` are read from `<ref>` with `git ls-tree` and `git show`, and
  the head tree is judged against them. A control input the head changed
  never takes effect for the run and is reported on one line: `config
  changed in this pull request`, `baseline changed in this pull request`,
  or `npmrc changed in this pull request`, with a short parenthetical
  naming what it proposed (`proposed: allow foo`, `failOn loosened to
  critical`, `2 baseline entries added`, `proposed: unpin @scope`). A
  control input the head carries and the base does not reads `config added
  in this pull request`, and the run uses the defaults. Reads only: no
  checkout switch, no worktree, and nothing written into the repository.
  Fails closed, exit 2, when the ref will not resolve; a missing base is
  never a reason to fall back to trusting the head. Pass it alongside
  `--base`, which continues to decide only what the change is compared
  against.
- **A `trustBase` block in the JSON** from `scan` and `check` (`ref`,
  `proposals`, `configChanged`, `baselineChanged`, `npmrcChanged`,
  `configShapeChange`, `baselineShapeChange`, `npmrcShapeChange`), and one
  SARIF `toolExecutionNotification` per proposal. A proposal is never a
  SARIF result: it is a fact about the run, not a finding about the code,
  and promoting it would invent an alert with no code behind it.
- **A `trust-base` input on the composite Action**, which passes
  `origin/$GITHUB_BASE_REF` by itself on a `pull_request` event and on no
  other event. Set it to a ref to point pull-request mode at a different
  base. A pull-request run needs `actions/checkout` with `fetch-depth: 0`.
  There is deliberately no value that turns pull-request mode off, and
  `off` is refused with an error naming the alternative: an opt-out input
  would be settable by the pull request itself, because on a
  same-repository `pull_request` event the workflow file runs from the
  pull request's own head. A repository that needs pre-0.6.0 behaviour
  while it arranges `fetch-depth: 0` should stay pinned to `@v0.5.0`.

### Security

- **A pull request could turn the gate off in the same commit that carried
  what the gate exists to catch.** Every control input was read from the
  tree under judgment, so one commit could add a hallucinated or
  typosquatted dependency and, in the same diff, add its name to `allow`,
  add its manifest path to `ignorePaths`, raise `failOn` above the
  finding's severity, add its scope to `internalScopes`, or write the
  finding's own fingerprint into the baseline. Four of those five returned
  exit 0 in `--base` mode, which is the mode CI runs; the fifth
  (`internalScopes`) did not silence the finding but did change which rule
  reported it, its message and its fingerprint. All of them are closed by
  `--trust-base`, which is how CI should now invoke the gate on a pull
  request. Local and pre-commit behaviour is unchanged and is pinned by a
  parity test in both packages.
- **Deleting `.npmrc` deleted a rule.** The scope-to-registry pins in
  `.npmrc` are the entire precondition of the dependency-confusion
  pin-mismatch rule, which fires only for a scope that HAS a pin, and they
  were read from the tree under judgment. So a pull request that added
  `@scope/package` resolving from the public registry while deleting the
  `.npmrc` that pinned `@scope` to a private one exited 0, and the report
  said "no control input changed in this pull request" while a control
  input had just been removed. `.npmrc` is now read from the base ref like
  the config and the baseline, and a head-side change to its pins is
  reported as `npmrc changed in this pull request` with the same four shape
  variants. Only the scope pins are compared, not the file text, so a
  rotated auth token or a changed default registry is not reported as an
  attempt to loosen the gate.
- **A trust base that resolves to the commit being judged is refused**,
  exit 2, even though it names a real commit. It would put the boundary
  back exactly where it started while the report said pull-request mode was
  on. The realistic way in is `--trust-base ${{ github.sha }}`, because on
  a `pull_request` event with the default `actions/checkout` that SHA is
  the merge commit, which is HEAD. The comparison is on resolved commits,
  so an alias, a tag or a raw SHA naming the head commit is refused alike.
- **A trust base whose TREE equals the head's is refused too**, exit 2,
  even when it is a different commit. What GitHub publishes as
  `refs/pull/N/merge` is a merge commit whose tree, when the base has not
  moved since the fork, *is* the head branch's tree, so
  `--trust-base ${{ github.event.pull_request.head.sha }}` named a
  different commit carrying an identical tree and every control input still
  came from the tree under judgment. Merging the base into the branch
  changes the head's tree, so a pull request that does that is judged
  normally.
- **A control input whose SHAPE the head changed is reported, and a
  base-side one that is not a regular file is refused.** Replacing
  `.dep-guard.json` with a symlink whose target holds the base config's
  exact bytes changes nothing a content comparison can see, and it is the
  first half of a two-step: land the link, then widen the link target in a
  later pull request where `.dep-guard.json` never appears in the diff at
  all. Both sides of the comparison are read through git for the same
  reason, so a link is compared as its target text rather than as the
  linked file's contents. The four variants reported are symlink, not a
  regular file, removed, and a changed file mode.
- **A base-side control input that is not a regular file is refused**, exit
  2, and that includes `.npmrc`. Reading a linked `.npmrc` leniently looked
  safe because `parseNpmrcPins` cannot fail, but not throwing is not the
  same as failing safe: the pin-mismatch rule fires only for a scope that
  HAS a pin, so an empty pin set turns the rule off for every scope at
  once. The same head that exited 1 against a readable base `.npmrc` exited
  0 against a linked one, and the report blamed the head for a pin the base
  was still holding through the link. The message names it as a
  misconfiguration on the base branch rather than something the pull
  request did, because that is where the fix goes.
- **A base config or baseline that does not validate is could-not-run**,
  exit 2, never a fall back to the defaults. The defaults may be looser
  than what the project committed, and a gate that silently loosens itself
  when a file is malformed is a gate anyone can loosen. A head-side one
  that does not validate is reported as a change and otherwise ignored,
  because the run was never going to use it and letting it abort the scan
  would be a muting attack of a different shape.

### Changed

- `.dep-guard.local.json` is read from the base ref alongside
  `.dep-guard.json` in pull-request mode. On a pull-request run a committed
  local overlay is just as much a control input the head can rewrite, and
  reading one from base while trusting the other from head would leave the
  hole open one file over. Outside pull-request mode it is read off disk
  exactly as before.

### Documentation

- A pull-request section in the README stating the rule in one sentence,
  the Action usage with `fetch-depth: 0`, and two things the gate cannot do
  for you: on a same-repository `pull_request` event the workflow file runs
  from the pull request's head, so the job has to be a required status
  check or a reusable workflow on a protected ref; and a human-approval
  requirement belongs in branch protection plus a CODEOWNERS entry for the
  control-input paths, never in an in-repo setting, because a mode selector
  living in the file a pull request controls is a knob a pull request flips
  to whichever mode is weaker.
