# Changelog

Notable changes to dep-guard. Format based on
[Keep a Changelog](https://keepachangelog.com/). What a version number
promises is in `docs/release/stability-policy.md`; this file records what
each release actually changed.

This file starts at 0.6.0. Releases before it are described by their
GitHub release notes, which are generated from the commit history.

## [Unreleased]

- The Action gained a `base` input, wired to the scanner's `--base` flag the
  same way `trust-base` is wired to `--trust-base`: on a pull_request event
  it defaults to `origin/$GITHUB_BASE_REF`, on any other event it passes
  nothing, an explicit ref redirects it, and `off` is refused with an error.
  Before this the Action never passed `--base` at all, so every scan ran
  with no earlier revision to compare dependencies against and the
  lockfile-tamper comparison signals could not run in pull-request mode.
  README documents which checks still run without a base ref (fixes #62).

- Pinned the Action's npm floor (10.5.2), version-shape regex and its
  occurrence count, `--ignore-scripts` install line, and the exact
  `npm audit signatures` subshell in a drift check. The hygiene blocklist
  comment now names all four family repositories. The one-command install
  is on the first screen of the README, and adopter feedback is linked
  from there next to CONTRIBUTING.

- The release-kind classifier now takes a packages[] list, the same shape
  vault-guard 1.8.0 uses on main (scripts/lib/release-kind.mjs as of
  c166862). The CHANGELOG heading check is a literal "## [X.Y.Z]" prefix
  match, not a regex built from the tag, so CodeQL no longer flags it and
  "## [0.6.10]" cannot satisfy a search for 0.6.1. The heading match is
  now exactly "## [" with one space (stricter) and tolerates leading
  whitespace on the line (looser), both matching vault-guard. No change
  to how the current two-package layout is classified.

## [0.7.1] - 2026-09-20

- The Validate inputs step now declares GITHUB_BASE_REF from the event
  payload in its env mapping, so the pull-request test cannot come from the
  workflow file even if the platform no-overwrite guarantee failed.

- Corrected a quote in docs/INVARIANTS.md: the GITHUB_*/RUNNER_* no-overwrite
  rule is documented flatly by GitHub; the "not guaranteed" hedge on the same
  page qualifies the separate CI variable exception, not this rule. Docs only.

- Widened the release-smoke job's npm registry wait window from about 2
  minutes to about 5 minutes, so ordinary registry propagation lag does not
  false-fail an otherwise-successful publish. CI-internal, no package version
  bump.

- Pinned the transitive js-yaml dev dependency to 3.15.2+ via
  pnpm.overrides to clear a high-severity advisory (CPU DoS on empty merge
  sources). The dependency comes in through jest, babel-plugin-istanbul, and
  @istanbuljs/load-nyc-config for test-coverage tooling only; it is not in
  the published package. No package version bump.

## [0.7.0] - 2026-09-19

Minor on both published packages, per the stability policy: 0.x minors may
change scanner behavior. `@vaultcompass/dep-guard` and
`@vaultcompass/dep-guard-core` move from 0.6.0 to 0.7.0. The action's
`version` input default and the `DG_TAG_SCANNER` constant move with them, so
`vaultcompasshq/dep-guard@v0.7.0` installs `@vaultcompass/dep-guard@0.7.0` --
tag and scanner are the same number again after the v0.6.1 through v0.6.4
action-only releases moved the tag alone.

### Security

- **A scan that resolves zero manifests while a manifest sits on disk now
  fails closed (could-not-run) instead of reporting a clean pass.** Ported
  from a whole-tree-scan invariant in a sibling scanner, adapted to
  dep-guard's own unit of work: a manifest, not a file. `scan()` resolves
  package.json (root and every discovered workspace member) plus a
  recognized lockfile into the state it judges; when that resolution comes
  back empty, a cheap, resolver-independent filesystem probe now checks
  whether a manifest-shaped file (package.json, package-lock.json,
  pnpm-lock.yaml, yarn.lock, bun.lock, or bun.lockb) exists anywhere under
  the scan root at all. If one does, the run refuses with a
  `manifests-unresolved` error (exit 2) rather than reporting "no risky
  dependencies found" over a tree it never actually looked at. A genuinely
  dependency-free repository, where the probe agrees with the resolver that
  nothing is there, is unaffected and stays a clean exit 0, same as before:
  a repo with no dependencies legitimately has nothing to check.

  This scopes honestly to the case it actually catches: a manifest present
  on disk that the resolver's own rules (an undeclared workspace, a
  symlink that resolves outside the scan root) never reached. A wrong scan
  root that still resolves at least one real manifest is not caught here --
  running at the repository root remains the primary protection.

  **Staged mode (`--staged`, the mode the init pre-commit hook runs) is
  excluded from this check.** In staged mode the state under judgment is
  the git index, not the working tree, so a package.json a developer
  created but has not yet run `git add` on is a legitimate, imposed-empty
  staged scope, not a discovered-empty misroot -- the empty scope was
  imposed by the index itself, the same way it is for an empty PR delta.
  Running the on-disk probe there compared the index against the
  filesystem and would misfire on every ordinary not-yet-staged file,
  turning a routine commit into a could-not-run with a misleading "scan
  root may be wrong" message. The sibling scanner makes this same
  exclusion for the same reason; the check still runs unchanged for
  whole-repo, base, and audit scans, where a discovered-empty result is
  never an imposed scope.

## [0.6.4] - 2026-09-18

**An action-only release.** The npm packages stay at 0.6.0.
`vaultcompasshq/dep-guard@v0.6.4` installs `@vaultcompass/dep-guard@0.6.0`.

### Security

- **On a pull request, the `version` input may no longer ask for a scanner
  older than the one this action tag ships.** On a same-repo `pull_request`
  event GitHub runs the workflow file from the pull request HEAD, so the
  `version:` input is written by the pull request being judged. The only check
  on it was a SHAPE check: it proves the value names a version and says nothing
  about which one, so every published version cleared it.

  Nine scanners are published, 0.1.0 through 0.6.0. What stops a backward pin
  today is not that check but a FLAG: `--trust-base` arrived in the 0.6.0
  scanner, the Action's run step appends it on every pull-request run with no
  opt-out, and a scanner at or below 0.5.0 answers `error: unknown option
  '--trust-base'`. A backward pin therefore already fails the job, at the scan,
  with a message about an unknown option rather than about what the pin was
  doing. This rule moves that failure up to the validate step and names the
  cause. The day a 0.7.0 scanner ships with new rules, a pull request pins
  `version: 0.6.0`, which knows `--trust-base` and runs cleanly, and is judged
  by the older rule set it chose for itself. It is the same class of hole as
  `trust-base: off`, which this action already refuses by name. The difference
  is what a reviewer sees: deleting a security step reads as deleting a
  security step, while `version: 0.6.0` reads as ordinary version management.

  On pull-request events the validate step now refuses a `version` below the
  scanner this Action tag ships, naming both numbers and pointing at the fix,
  which is to remove the input. Pinning **forward** is still accepted there, on
  an assumption the rule does not enforce: that a newer scanner is at least as
  strict. Forward pins are not bounded.

  **Where it fires** is exactly where `GITHUB_BASE_REF` is set, which is
  `pull_request` and `pull_request_target`. Push runs are out of scope. That is
  a scope statement, not a safety argument: a push run on an unprotected
  feature branch runs that branch's own workflow file, written by the same
  author, and is as author-controlled as a pull request. It is not covered.

  **What this costs, and the migration.** Nine scanners are published, so a
  workflow pinning any of `0.1.0` through `0.5.0` passes the shape check on a
  pull request today and is refused by v0.6.4 at the validate step. Such a pin
  is already broken on that event, because those scanners do not know
  `--trust-base` and the run step always passes it; what changes is that the
  job now fails earlier with a message saying why. **If you pin `version` below
  `0.6.0`: remove the `version` input, which is the pin you want because the
  default is the scanner this Action tag ships, or raise it to `0.6.0` or
  newer.** A pin at or above `0.6.0` is unaffected, and so is every push run.

  **The comparison is against a constant of its own,** `DG_TAG_SCANNER` in
  `action.yml`, not against anything derived from an input: `inputs.version`
  looks identical whether the consumer pinned it or the default supplied it, so
  the step cannot tell a pin from a default. It is not the npm floor in the
  install step either, which is a property of the npm CLIENT and has nothing to
  say about the scanner. A test ties `DG_TAG_SCANNER`, the `version` input's
  default and both published package versions to one number, because a constant
  left BEHIND a published scanner would go on admitting the pin it exists to
  refuse, and would do it quietly.

  **What this does not cover:** forks, where the base repository's workflow
  file runs, so a fork author never writes the `version:` that judges them (the
  rule still fires on a fork pull request and judges the base workflow's own
  pin, so a deliberate backward pin there refuses every fork run); and a pull
  request that deletes the step or moves the `uses:` pin, for which branch
  protection with required review on `.github/workflows/**` remains the
  control.

## [0.6.3] - 2026-09-18

**An action-only release, and a correction to v0.6.2.** The npm packages stay
at 0.6.0. `vaultcompasshq/dep-guard@v0.6.3` installs
`@vaultcompass/dep-guard@0.6.0`.

**Upgrade from `@v0.6.2` if you pin it.** That release refuses working npm
clients.

### Fixed

- **The npm floor was wrong by two patch versions, and refused clients that
  work.** v0.6.2 required npm 10.6.0. The real boundary is **10.5.2**: it
  verifies signatures correctly, with the same package and attestation counts
  as current npm rather than a reduced set. Re-bisected with a cold cache and
  a fresh `HOME`, so no newer client could have primed the TUF root or the key
  set: 8.19.4, 9.9.4, 10.2.4, 10.5.0 and 10.5.1 fail; **10.5.2** and every
  later version pass.

  This reached real consumers rather than being a rounding error. **Node
  20.13.0 and 20.13.1 ship npm 10.5.2**, so anyone pinning those got a hard
  refusal from v0.6.2 whose message told them their client could not do
  something it demonstrably can.

  The wrong number came from a bisection that tested 10.5.0 and then 10.6.0
  and never tested what lay between them, and it was then written into the
  action, this changelog, the README and the test fixtures as a measured fact.

- **The comparison is restructured so an arithmetic error cannot read as
  permission.** It now accepts only if the client is provably at or above the
  floor, rather than refusing if it is below. `[` returns 2 on a malformed
  comparison and an `if` reads 2 as false, so the previous shape turned any
  such error into a pass. That is how the first two versions of this guard
  failed open, and the third had the same latent shape even though no real npm
  output could reach it.

## [0.6.2] - 2026-09-18

**An action-only release. The tag moves; the npm packages do not.** Nothing in
the scanner changed, so `@vaultcompass/dep-guard` stays at 0.6.0 on npm and the
action's `version` default stays `0.6.0`.
`vaultcompasshq/dep-guard@v0.6.2` installs `@vaultcompass/dep-guard@0.6.0`.

### Security

- **The action no longer runs install scripts, and verifies what it installed.**
  The install step ran `npm install -g` with no `--ignore-scripts` on a runner
  holding the job's token, so every package in the resolved tree had arbitrary
  code execution there on every run. What it installs is a control input: it
  decides whether a pull request may merge.

  It now also runs `npm audit signatures` over the installed tree. That needs a
  root manifest to work at all: the audit walks the tree's edges out, and a
  global install leaves `<prefix>/lib` with no manifest, so without one the
  audit covers the dependencies and silently skips the scanner itself.

  **What the verification proves, stated narrowly:** it asks the registry for
  each name and version in the tree, the scanner included, and checks the
  signature served back. It does **not** read the installed files, so a tampered
  install is invisible to it; it does **not** defeat a compromised registry,
  which signs what it serves; and a **missing** attestation is not a failure.

### Fixed

- **A floor on the npm client, so the action cannot call a clean install
  tampered with.** `npm audit signatures` is not version-stable: below npm
  10.6.0 it fails on an untampered install of these very packages, because the
  client's bundled keys are stale. On 10.5.0 it reports *"Someone might have
  tampered with these packages"*, naming ours. The action now refuses up front
  and names the npm it found.

  Note `node-version: 22` is not on its own sufficient: **Node 22.0.0 ships npm
  10.5.1**, inside the failing band. Pin 22.1.0 or later.

### Changed

- The README now documents both ways this step fails closed, what the
  verification does and does not prove, and `@v0.6.1` as the pin that does not
  verify. Previously that trade was recorded only in an internal maintainer
  file.

## [0.6.1] - 2026-09-12

**An action-only release. The tag moves; the npm packages do not.** Nothing in
the scanner changed, so `@vaultcompass/dep-guard` stays at 0.6.0 on npm and the
action's `version` default stays `0.6.0`, which is the scanner this action tag
installs and was tested against.

That makes the action tag and the scanner version two different numbers for the
first time, and it is deliberate rather than an oversight:
`vaultcompasshq/dep-guard@v0.6.1` installs `@vaultcompass/dep-guard@0.6.0`.
Publishing an identical scanner as 0.7.0 so the two strings matched would burn a
version number on a change that touches no scanning code, through a
trusted-publisher path that is a one-way door.

**Pinning `vaultcompasshq/dep-guard@v0.6.0` gets the OLD action**, the one that
installs the scanner from inside the checkout. Move to `@v0.6.1`.

### Security

- **The Action installs the scanner from outside the tree it scans.** It ran
  `npx` from inside the checkout, which put the choice of program inside the
  tree under judgment by two routes. An `.npmrc` committed by the head
  repoints the registry npx fetches from. A copy of the package already in the
  head's `node_modules`, from the workflow's own earlier install step, is what
  npx runs, with the version pin acting only as a satisfaction check on a
  package the head wrote. Either one lets a pull request choose the program
  that scans it, and the second needs no registry at all. The package is now
  installed globally into a prefix under the runner temp, with npm started
  from the runner temp rather than from the workspace, and called by absolute
  path.

  The scan path passed to that binary is now absolute, and the two halves are
  not separable: run from the runner temp with a relative `.`, dep-guard
  resolves the runner temp as the repository, fails to resolve the trust base,
  and exits 2 on every run, blaming a `fetch-depth` the caller already set.

### Changed

- **`version` takes an exact version only, and defaults to the version the
  action shipped with.** It accepted dist-tags and defaulted to `latest`. A
  tag hands the choice of scanner to the registry on the morning of the run.
  The old charset also accepted values npm reads as a PATH rather than a
  version, `.`, `..` and `payload.tgz` among them. **A workflow relying on the
  old `latest` default must pin an exact version.**
- **Only 0 and 1 are verdicts.** Any other exit code from the run step,
  including the 126 and 127 the shell produces when the binary is missing or
  not executable, is reported as could-not-run and re-raised as 2 rather than
  as blocking findings. An empty code, which is what a rejected input looks
  like from the report step, is now also 2 rather than 1.
- **`results-file` is published only when the SARIF is non-empty.** dep-guard
  exits before writing anything when it could not run, and the redirect had
  already created the target, so `upload-sarif` was handed a zero-byte file
  and failed the job with a parse error that buried the real cause.
- **Input validation.** No value may begin with a dash, rather than only the
  ref. `trust-base: off` is refused in any capitalisation. A version with a
  leading zero such as `01.2.3` is refused, because npm does not read it as a
  version at all and falls back to treating the spec as a dist-tag.
- **`sarif-output` may not resolve under `.github/`**, which holds the workflow
  file and the CODEOWNERS entry that decide how this gate runs. Compared after
  normalising `./` segments, doubled slashes and case to a fixed point, so
  `./.github/x` and `.GitHub/x` are refused too. A `./` prefix is still
  perfectly legal on any input; an earlier draft of this release refused it
  outright and would have broken `path: ./src`.
- **`sarif-output` may not resolve through a symlink**, at the file or at any
  directory on the way to it, checked before the containing directories are
  created rather than after. The head controls those, and a symlink there
  sends the write outside the workspace.

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
