# Findings on a head-defined project are not dropped by the base's ignorePaths

Status: design, for review. No code in this change. Sections 1 to 7 are
audit B1; section 8 is audit B2, ruled into the same release. Revised after
the first review round (findings 1 to 13, all ruled accepted 2026-10-18).
Target release: 0.16.0 (minor; see "Release").
Citations are against main at be53742 (0.15.0).

## The problem

0.15.0 settled which manifests are projects (`classifySide`,
`packages/core/src/git-source.ts:2131-2340`, rules 1 to 5 at :2246-2333,
summarised at :1886-1913) and made a project's parse failure fatal
"whatever ignorePaths says", because a project is installed
(`settleParseFailures`, git-source.ts:2366-2463; INVARIANTS "Manifests that
do not parse", docs/INVARIANTS.md:1283-1360). The findings filter never got
the same rule. `applyPathFilters` (packages/core/src/scan.ts:772-843) drops
every finding whose `manifestPath` an ignorePaths entry matches
(scan.ts:786-795), with no regard to whether that manifest is installed.

On a `--trust-base` run the ignorePaths list is the base's (scan.ts:980),
but every input that decides what is a project is head content. So the head
chooses what is installed, and the base's filter, written for "fixtures we
never install", hides it. The trust-base report counts no such change as a
control change, so the run says "no control input changed in this pull
request" (packages/cli/src/output-text.ts:296).

Reproduction (adv/c1, shipped 0.15.0 corpus):

- Base: `package.json` depends on `ms`, a valid `package-lock.json`, and
  `.dep-guard.json` = `{"ignorePaths":["fixtures"]}`, the README's own
  example value (README.md:939).
- Head: adds `"helper": "file:fixtures/helper"` to the root dependencies,
  `fixtures/helper/package.json` declaring `"crossenv": "^1.0.0"`, and the
  matching lock entries (`fixtures/helper`, `node_modules/helper` with
  `"link": true`, `node_modules/crossenv` from the registry).
- `dep-guard scan --base main --trust-base main`: "No findings.", note
  `ignore-path-dropped` (one critical), "no control input changed in this
  pull request", exit 0. `npm ci` installs crossenv.
- Variant X1: base `workspaces: ["packages/*"]`, ignorePaths `examples/**`;
  head widens workspaces with `examples/*` and adds `examples/demo`
  declaring a typosquat. Findings 0, 2 ignored, proposals empty, exit 0,
  while the `workspace-link-unconfirmed` note on the same run says "a pull
  request cannot widen it for its own link" (git-source.ts:1820).
- Variant (review): the head adds a stray `fixtures/stray/package.json`
  declaring a name a root-lockfile entry carries. `attributeLockNames`
  (packages/core/src/delta.ts:546-560) anchors a lock entry to the first
  manifest declaring its name, strays included, so a root-lockfile tamper
  or install-script finding moves into the ignored path. Exit 0.
- Variant (review): the head adds `-r fixtures/extra.txt` to the root
  `requirements.txt`. pip installs the included file; its findings are
  anchored there and dropped. Exit 0.

This is a cross-wave contradiction and the same laundering class as the
2026-10-12 F1: a head-written input clearing a head-introduced finding. The
input here is not a control file but the project set, which acts as a
control over ignorePaths.

## 1. The rule

**Reasons.** For every path, each side records every reason that makes it
a project, not just the first. A reason is the tuple (rule, install root
directory, input path, pattern text when the match was inexact). Examples:
(reference-target, "", package.json) for the `file:` specifier in the root
manifest; (beside-lockfile, fixtures/helper, fixtures/helper/package-lock.json);
(root-member, "", package.json `workspaces`, "examples/*" when inexact).
The rules are classifySide's (git-source.ts:1921-1938) plus one new one:

- **requirements-include**: a requirements file reached by an `-r` or `-c`
  line of another requirements file on this side. The reason's input path
  is the including file. It is computed in `classifySide` over the whole
  listing, like every other classification input, and not taken from
  `followRequirementIncludes` (git-source.ts:235-287), which starts from
  the manifests under the scan prefix (:243-245, via `filesInPrefix`); so
  `scan <repo>/fixtures` still sees the root `-r fixtures/extra.txt`. The
  same pip resolution rules apply (relative to the including file, depth
  limit, each file once).

**R1.** On a run that has a reference side (defined below), ignorePaths
drops a raw finding only when its anchor is not a project on the judged
side, or when every reason the judged side records for the anchor is also
recorded on the reference side. Otherwise the finding is kept, goes on to
the baseline and the gate like any other, and the path is reported.

- **The anchor.** The anchor is `manifestPath`. When `manifestPath` names a
  lockfile, the anchor is the project manifest in that lockfile's
  directory. When the finding carries `lockfilePath` and its `manifestPath`
  is not a project on the judged side, ignorePaths is matched against
  `lockfilePath`, not `manifestPath`: a stray cannot pull a root-lockfile
  finding into an ignored directory by declaring the same name. The
  fingerprint is unchanged (it still hashes `manifestPath`).
- **Why reasons, not paths.** Comparing paths excused the attack again:
  rule 3 marks any manifest beside any recognised lockfile, so a base whose
  `fixtures/helper` carries its own lockfile already "has the path as a
  project", and the head's new `file:` wiring would be excused. With
  reasons, the head's (reference-target, "", package.json) is not on the
  base, so the finding stays. The same comparison removes a false
  positive: an inexact pattern identical on both sides is the same reason
  on both sides and excuses, instead of keeping findings and printing a
  proposal on every pull request.
- **Per-input negations.** `workspacePatternsCover` evaluates the
  `workspaces` field and `pnpm-workspace.yaml` patterns in one call and
  returns false on any matching negation (git-source.ts:1341-1361, called
  with both at :2251-2256), so a yaml holding only `!examples/demo` un-marks
  a member of a yarn or bun root, which never reads that yaml. Each input
  is evaluated with only its own negations and yields its own reason. The
  comment at git-source.ts:1906-1908 ("a claim in one can only add a path
  ... none can remove one")
  is corrected: a negation inside one input can remove a path that input
  alone would add, never one another input adds.
- **The reference side.** The trust base on a `--trust-base` run, with or
  without `--base`, and only the trust base: it is the side the controls
  come from, so on `--base X --trust-base Y` Y decides even where X counts
  the path. `--trust-base` without `--base` (the README's audit-reporting
  shape on push and dispatch) applies R1 with the trust base as reference.
  Without `--trust-base` it is the comparison side the run already has:
  the `--base` ref, or HEAD for `--staged`. An audit run, and a staged run
  with no committed HEAD and no trust base, have no reference side and R1
  does not apply.
- **Tamper on a base-installed project.** On a path the reference side
  already installs (section 2), `lockfile-tamper` findings are never
  dropped by ignorePaths, matching `allow`, which never covers that rule
  (packages/core/src/checks/allow.ts:14-20).

**R2.** For every path under an ignorePaths entry that is a project on the
judged side with at least one reason the reference side lacks, the run
reports "this change makes ignored path X a project". On a `--trust-base`
run it is a trust-base proposal; elsewhere it is a diagnostic. It is
reported whether or not a finding was kept there, because the effect on the
control (ignorePaths stops covering an installed path) is the change.

Why R1 applies without `--trust-base` too. There, the controls are the
working tree's own, so R1 is not a security property: the same author can
add an `allow` entry, a baseline fingerprint or a higher `failOn`. It is
applied anyway for verdict parity, so a local `scan --base main` and the
pre-commit `--staged` hook predict the pull-request verdict.

Why audit is excluded. An audit has no change to judge, and every
installed project under an ignorePaths entry would read as head-defined.

**The alternative, rejected.** Treat only head-side control edits as
proposals: a root `workspaces` change, a `pnpm-workspace.yaml` change, an
added `file:`/`link:`/`portal:` specifier whose target is under an ignored
path. Rejected because it misses positions that are not field edits (a new
lockfile beside a manifest, rule 3, git-source.ts:2257-2263; an npm link
entry, :2305-2333; a uv member; a requirements include), and because it is
a second enumeration of what makes a project beside `classifySide`, which
would drift. The reason diff is complete over the rules classifySide
implements and no further: a gap in classifySide is a gap in R1. Known open
for that reason (ruled out of this change, 2026-10-18): `overrides` and
`resolutions` `file:` targets (audit N4), and Python path sources
(`[tool.uv.sources]` path entries, poetry path dependencies, pip local
paths and `-e`) are not project reasons, so R1 does not keep their
findings.

## 2. What ignorePaths still does

- A manifest under an ignored path that no side classifies as a project
  (a well-formed fixture nothing installs) is dropped exactly as today.
- A project the reference side already installs under an ignored path, with
  the same reasons, keeps every finding other than `lockfile-tamper`
  dropped. **Decision: this is the adopter's standing choice, not a
  bypass.** The base's reviewers wrote both the wiring and the ignorePaths
  entry that covers it; the F1 class is a head-written input clearing a
  head finding, and here both inputs are base-written. Forcing these
  findings back would turn red every adopter that deliberately ignores an
  example app it installs.
- **The residual, named plainly** (in INVARIANTS and README too): on such a
  base, any pull request can add a malicious dependency inside that
  directory and exit 0, with only the note below. Tamper findings there are
  kept (R1), and that is a consumer cost to disclose.
- The standing choice is made visible: when ignorePaths drops a finding
  whose anchor is a project on the reference side (or, on an audit, on the
  judged side), the `ignore-path-dropped` note (scan.ts:836-840) adds "N of
  them on installed projects (P1, P2)". A diagnostic, so no exit change
  (docs/INVARIANTS.md:1670).

## 3. Fail-closed edges

- **Reference inputs unreadable.** Every way the reference side fails to
  read an input removes reasons from it, which keeps more findings:
  - A comparison-side manifest that does not parse and is a stray under
    ignorePaths is dropped with `manifest-unparsed`; its specifiers are
    never read, so it excuses nothing. A comparison-side project that does
    not parse is already exit 2 (git-source.ts:2366-2463, :3019-3022).
  - An out-of-prefix input on the reference side that cannot be read
    (`classification-input-unread`, git-source.ts:1915, :2378-2395) makes
    every manifest under the prefix a project for parse purposes. That
    expansion is never a reason for R1: the reference side then excuses
    nothing under the prefix.
  - The trust base itself being unusable is exit 2 before anything is
    scanned (`loadTrustedControls`, scan.ts:969).
- **A project on the base that the head removes.** The judged side has no
  reason for it, so R1 keeps nothing there; no proposal, since narrowing
  the install set is not a control widening.
- **A manifest that does not parse on either side.** No interaction:
  `settleParseFailures` decides it before any check runs, and R1 reads only
  reasons. The existing rule ("the trust base contributes ignorePaths
  only, never project paths", docs/INVARIANTS.md:1322-1326) gains one
  clause: the trust base's reasons excuse an ignorePaths drop, never make a
  failure fatal.
- **Subdirectory scans.** R1 uses exactly the inputs 0.15.0 reads: the
  whole listing whatever the prefix, out-of-prefix files read quietly
  (git-source.ts:2100-2129, :2175-2185). Only paths under the prefix are
  reported in R2.
- **`--staged --trust-base`** (ruled 2026-10-18). `trustState` is null in
  staged mode (scan.ts:1058-1068) for the lockfile downgrade rule. The
  reference is still the trust base, whose side is loaded for R1 only, kept
  apart from `trustState`. That classification-only load never throws: a
  base manifest that does not parse contributes no reasons and so excuses
  nothing, and the pre-commit hook gains no new exit 2.
- **A missing `projects` field.** When a reference side exists and the
  judged state reaching `applyPathFilters` has no `projects`, that is an
  internal error and the run throws; it is never read as "nothing is
  kept". Absent on the reference side means nothing is excused.

### Implementation review rulings (2026-10-18, F1 to F3)

The independent review of the first implementation found three ways past
R1, each exit 0 with a critical dropped. Rulings:

- **F1, bare local paths.** npm reads a specifier starting `./`, `../`,
  `/`, `~/` or a drive letter as a local directory (npm-package-arg's
  isFilespec; manifest.ts already keeps it as `LOCAL_PATH_SPEC`). Rule 5
  now treats such a specifier as a reference target, the whole specifier
  being the target, exactly as it treats `file:`, `link:` and `portal:`.
- **F1, targets that cannot be placed.** A target this tool cannot place
  inside the repository (absolute, `~`, a drive path, or a relative path
  that leaves the root, which can come back in through the checkout
  directory's own predictable name) is not ignored as "outside the repo".
  It fails closed the way an inexact workspace pattern does: the reason,
  with the target text as its pattern, is recorded on every `package.json`
  on that side. The same specifier in the same file on the reference side
  is the same reason and excuses; a new one keeps the findings of every
  ignored `package.json` and proposes each. A reason only: whether a file
  stops the scan on a parse error is unchanged. The same applies to npm
  lockfile link entries and to requirements `-r`/`-c` targets (covering
  every requirements file).
- **F2, symlinked directories.** A reference or link target whose
  directory, or any ancestor of it, is a symlink entry on that side is
  followed inside the repository (the git side reads the link text from
  the blob, the working tree with readlink), relative to the link's own
  directory, up to 40 hops (Linux MAXSYMLINKS). The reason is recorded on
  the manifest at the resolved path, which is the one the scan reads. A
  link that leaves the repository, is absolute, cannot be read, or exceeds
  the hop limit makes the target unplaceable, which is the F1 fail-closed
  cover above, not a could-not-run: a run on such a tree still reports.
- **F3, reasons are transitive.** Rule 5 reads every parsed manifest,
  strays included, so a base stray `fixtures/a` that references
  `fixtures/b` already records b's reason on the base, and a head that
  only wires `fixtures/a` into the install excused b. A judged reason now
  counts as present on the reference side only when its source manifest is
  itself excused: the input for reference-target and requirements-include
  and uv-member; the `package.json` of the install root for root-member,
  install-root-member and link-target; none for root and beside-lockfile,
  whose source is the path itself. A source that is not a project on the
  judged side installs nothing and does not block. Excused is the greatest
  fixed point: start from every judged project whose reasons all appear on
  the reference side and remove any whose reason's source was removed,
  until nothing changes. Each pass removes at least one path or stops, so
  the bound is one pass per judged project path; a run that did not settle
  within it (which cannot happen) excuses nothing. A cycle of base-standing
  references stays excused; a new wiring anywhere upstream propagates down
  it.
- **Text summary.** `N kept over ignorePaths` prints only when R1 applied
  on the run, read from `ScanResult.ignoreRuleApplied`, not from the mode
  (a staged run with no HEAD and no trust base has no reference side).
- **Unchecked message.** The could-not-run line counts distinct names; the
  per-step entries stay in `run.online.unchecked.names` and in the line's
  own per-name detail.

Known open after this round (ruled out of this change): a target path that
differs only in case from the listed directory (`file:Fixtures/helper` on a
case-insensitive macOS or Windows runner) is not matched to it; a yarn
`patch:` specifier wrapping a `file:` target is not a reason; `ignoreKept`
counts a kept finding the baseline then suppresses; the online-disabled
reason text says "the base config" on a `--base`-only run where the config
in effect is the head's; and an ignored stray's names still count as
unchecked under B2. (A workspace member reached only through a symlinked
directory was open here; the re-check below closes it.)

Re-check rulings (2026-10-18, after F1 to F3):

- **R-1, link and include text are walked physically.** Link text and a
  requirements include are opened by the operating system, so a `..` after
  a symlinked segment climbs out of the link's target. Both are resolved
  with the realpath walk over the side's FileSource (`walkPhysicalPath`),
  never on disk, from an already-real directory, sharing the 40-hop budget.
  A package.json specifier and an npm lockfile link entry stay
  string-normalized first, as npm's path.resolve does; only the result is
  walked.
- **R-2, a symlinked workspace member is a member.** A listed symlink
  outside node_modules whose own path a workspace pattern covers (the root
  field, the root pnpm-workspace.yaml, every rule-4 install root, and uv
  members) is followed and its real manifest marked as a listed member
  would be; one that cannot be followed fails closed with the symlink's
  path as the reason's pattern. A pattern that would pass through a
  symlinked directory to reach a member is not expanded and fails closed
  the same way, so no new FileSource method is needed. (Superseded for
  every placeable link by R-4 and R-5 in fix round 4 below.)

Second re-check rulings (2026-10-18, after R-1 and R-2):

- **B-1, a fail-closed reason carries the link text.** Keyed on the
  symlink's path alone, the R-2 fail-closed reason let a head that
  retargets a link the base already has excuse itself (a pass-through
  `packages` pointed from `fixtures/pkgs` to `fixtures/evil`; an
  unplaceable member link pointed at the repository by absolute path, or
  out and back in through the checkout directory's name). The pattern is
  now the link's path together with its link closure: its own text, every
  link its text runs through, and every listed symlink under the real
  directory it reaches, each as path and text. The same mechanism applies
  to the F1 fallbacks (rule 5 and requirements includes): the written text
  plus every link the walk read on the way, so the same specifier through
  a retargeted link is a new reason. A link whose text cannot be read
  carries the side's own serial number and is never excused, since its
  target is not known to be the same on the reference side. Conservative
  cost: an unrelated symlink added or retargeted under a pass-through
  directory's target keeps that side's ignored findings too. (For
  workspace links, the closure is replaced in fix round 4 by the links read
  on the way to each mapped member, R-4, and on the way to an unplaceable
  link, R-5.)
- **B-2, the scan reads includes the way the classifier places them.**
  The include reader that loads names (`followRequirementIncludes`,
  textual since 0.13.0) now places a `-r`/`-c` target with
  `walkPhysicalPath` and reads the resolved path through the FileSource,
  so a `..` after a symlinked directory and a git side's symlinked
  directory both read the right file. An include whose last segment is a
  symlink is still not read (TB5, known open, pre-existing since 0.13.0).
- **B-3, the second propagation pass is pinned by a four-level chain.**
  The three-level H32r stays green with `settled = false` dropped, since
  the final check against the partial set catches one level; H32r4 does
  not.

Fix round 4 rulings (2026-10-18, after an adversarial re-check and a
public-repository dogfood run). These replace the R-2 pass-through
fail-closed and the B-1 link closure for every link that can be placed.

- **B-4 and FK-1 had one root cause.** The pass-through fail-closed reason
  was keyed on the link and its closure but not on the patterns, and it
  was sprayed onto every manifest of that kind on the side. So a head that
  widened `packages/*` to `packages/*/*` through a `packages` link the base
  already had excused the newly covered member (B-4, an under-keep at exit
  0), while any committed symlink under a `**` pattern made every new
  ignored manifest anywhere in the repository kept, since a manifest new on
  the head has no base reason (FK-1, an over-keep that broke `ignorePaths`
  on vite-shaped repositories, including a file symlink under `**`, the
  known-open N-2).
- **R-4, placeable links are mapped.** A link a pattern covers or passes
  through is followed. When it reaches a listed file, or a path with
  nothing listed under it, it is not a member directory and gives no
  reason. When it reaches a directory R, each listed manifest R/sub/name is
  a member exactly when the patterns cover link/sub, the path a package
  manager sees, with the same coverage a listed member gets (exact and
  inexact; for uv, `uvWorkspaceCovers`), and that member's position and
  promotion. The reason's pattern holds link/sub, the covering pattern
  (null when exact) and every link read on the way, so a widened pattern
  gives a reason the base does not have, a changed inexact text is a new
  reason (as H8), and a retargeted outer or nested link is a new reason (B-1
  preserved). Every listed symlink under R is a further candidate at its
  path through the link, sharing the 40-hop budget.
- **R-5, only an unplaceable link fails closed.** A link that leaves the
  repository, is absolute, cannot be read, runs out of hops, reaches a
  directory already on its own chain, or is reached after 10,000 visits in
  one walk keeps the blanket reason on every manifest of that kind, now
  keyed on the link's path through the links, the input's canonical
  patterns (positives and negations, sorted; for uv members and exclude)
  and every link read. A widened pattern is then a new reason there too.
  An unreadable link still carries the side's serial.
- **R-6, the note says what happened.** A mapped member's reason reads "a
  root workspace member reached through the symlink packages" (every link
  on the way is named); a fail-closed reason reads "possibly a root
  workspace member: the symlink X could not be followed", and when every
  missing reason is of that kind the note and the proposal say the path
  "counts as a project here", never that the change made it one.

Fix round 5 rulings (2026-10-18, after the round 4 re-check).

- **RC-1, the visit limit's reason excuses nothing.** Past the visit limit
  the link was never walked, so the fail-closed key carried the links read
  above it but not that link's own text. A base that already fanned out
  past the limit then excused a head that retargeted a link the walk never
  reached (33 links fanning out 2^15 ways under `packages/**`, then
  `packages/z` retargeted from `../fixtures/a` to `../fixtures/evil`: exit
  0; the same retarget without the fan-out: exit 1). Ruling: the limit's
  key is `["symlink-fan-out", the input's canonical patterns, the side's
  serial]`, the treatment of an unreadable link, so a repository past the
  limit keeps every ignored manifest of that kind on every run. Only a
  pathological link graph reaches the limit.
- **RC-2, one budget per side, one walk per link.** The limit now counts
  every visit on one side over every workspace input together, and the
  walk that stops at it records the reason once for its input; later
  inputs that still have a link to visit record theirs the same way. The
  physical walk of each listed link is done once per side and reused: it
  reads only that side's source from the link's own directory, so its
  result cannot depend on the chain that led to it. The 2^15 fan-out ran
  in about 70 s and now runs in under 2 s.
- **RC-3, the note says which way the walk failed.** A loop reads
  "following the symlink X loops back into a directory already on its
  path"; the limit reads "the symlinks under X fan out past the limit of
  10000", X being the top-level link whose walk ran out of visits; "could
  not be followed" stays for a link that cannot be read or placed or runs
  out of hops. The key does not change with the wording.
- **Accepted, N-2.** A self-link under a `**` pattern (`packages/a/self ->
  .`) loops, so it fails closed, and a new ignored manifest anywhere on the
  side, outside the patterns too, is kept. This over-keep is accepted as
  rare and pinned by RC2 so the loop branch cannot quietly become a skip.

Fix round 6 rulings (2026-10-19, after the round 5 re-check).

- **B-1, a fail-closed reason stands in for promotion.** A fail-closed
  reason only added a reason, never a promotion, so a member the walk
  could not place, sitting under a skipped directory name (`build/`,
  `vendor/`, ...), was dropped by the read gate with a
  `manifest-skipped-dirname` note: exit 0 with the finding dropped, the
  0.11.0 build/vendor family. Two staged-mode repros: TMPX7, a fan-out
  under the `packages/**` input spending the shared budget so the
  `apps/*` input never walked `apps/z -> ../build/a`; TMPX6, the fan-out
  and the member under one `packages/**` input (present since round 4).
  The working-tree forms already exited 1, since the workspace walk there
  follows the link. Ruling: every fail-closed reason of an input that
  promotes adds each manifest it lands on to `promoted`, with no
  position: the symlinked member walk's unplaceable link, loop and visit
  limit, rule 5's unplaceable `file:` target or lockfile link entry, and
  the requirements include fallback, which had the same gap (TMPX9,
  TMPX9r). The uv member walk does not promote, so neither do its
  fail-closed reasons.
- **The stand-in and parse failures.** With no position, a stand-in never
  makes a parse failure fatal whatever ignorePaths says. It is judged as
  a manifest outside any skipped name is: covered by ignorePaths, dropped
  with `manifest-unparsed`; not covered, it stops the scan with the
  ordinary advice (TMPX10). Before this round such a file was not read at
  all, so the uncovered case is a new exit 2 on a side with a fail-closed
  link. Dropping it instead would let a member the walk could not place,
  written to fail this parser while a package manager still installs it,
  pass with exit 0.
- **B-2, the visit budget is per input again.** Round 5's shared budget
  is what let one input's fan-out cut another input's walk short
  (TMPX7). The budget counts each input's visits on its own; the link
  walk memo stays per side. TMPX7p pins it: past the other input's
  fan-out, the member keeps its root-member position, so a broken one
  stops the scan even under ignorePaths. A side's walks therefore make at
  most 10,000 visits per workspace input; RC1 still runs in under 2 s.
- **N-1, each input's note names its own link.** The top-level link named
  in the fan-out note is the one under which that input's own budget ran
  out (N1).

Fix round 7 rulings (2026-10-19, after the round 6 re-check).

- **B-1, the subdirectory diagnostic is made true (pre-existing since
  0.15.0).** A scan of `app` on a tree whose root `pnpm-workspace.yaml`
  or `package-lock.json` does not parse raised
  `classification-input-unread`, "every manifest under app was treated as
  a project", while the read gate consulted `promoted` alone, so
  `app/build/a/package.json` declaring `lodahs` was skipped with
  `manifest-skipped-dirname`: exit 0 in staged and audit mode (and on the
  working tree under `--base`), where a root scan exits 2. Ruling: when a
  side has an unread input that a root scan would have stopped on, the
  condition the "every manifest under the prefix" protection already used,
  every project manifest under the prefix outside `node_modules` passes
  the read gate on that side, a stand-in with no position. The decision is
  one function, `stoppingUnreadInputs`, made once when the side is loaded,
  against the comparison sides already loaded; `settleParseFailures`
  raises the diagnostic from the same list and refuses (internal error) a
  side settled against other comparison sides than it was loaded with.
  The stand-in is side-local, like `standIn`. Tests: SD1 (two inputs by
  staged and audit, plus a `--base` variant each; all six red before the
  change), SD1n (node_modules under the prefix is still not read), SD1c
  (every input readable: build/ is skipped as before).
- **N-1, a side-wide visit limit.** The per-input budget alone scales with
  the number of inputs (50 install roots each reaching one 2^15 fan-out,
  measured at 9.2 s staged and 4.1 s audit on the round 6 code on the
  implementer's machine; the re-check measured 24.6 s). Ruling: one more
  limit, 100,000 visits per side over every input together. When it is
  reached the next visit of any input fails closed with the per-input
  limit's key, `["symlink-fan-out", patterns, side serial]`, never
  excusable, plus the stand-in; the reason's cause is `side-fan-out` and
  its note says the walks on the side ran past the limit in all. Ten
  inputs can each spend their own 10,000 first. After: 50 roots 2.2 s
  staged, 0.9 s audit; 200 roots 3.6 s staged. Cost, accepted: past the
  side limit a member the remaining inputs would have placed has no
  position, so a broken one under ignorePaths is dropped with
  `manifest-unparsed` (the TMPX7p guarantee holds up to nine fanning
  inputs). Test: SC1.

## 4. One classification, two consumers

R1 and the `workspace-link-unconfirmed` rule are the same principle: under
`--trust-base`, what the head says is installed does not widen what the
base's controls exempt. Today they are computed twice:

- Link exemption: `confirmWorkspaceLocalNames` evaluates the base root
  manifest's `workspaces` patterns itself (git-source.ts:1791-1797 picks
  the base's field, :1814 matches with `'excludes'`), through
  `reconfirmWorkspaceLocalNames` (git-source.ts:1858-1884, scan.ts:
  1069-1081).
- Path filter: `applyPathFilters` (scan.ts:772-843, called at :1216) has
  no classification at all.

Both read one value produced once per side by `classifySide`, carried out
of `loadState` (git-source.ts:2469-2798, which returns `classification` on
`LoadedSide` at :2798 and then drops it) as `RepoState.projects`: the
reasons per path, the `workspaces` field patterns of every parsed
`package.json` (each with its own negations, lockfile or not), and the
out-of-prefix inputs that could not be read.

The link exemption keeps today's semantics exactly. Its fallback keys on
"the base has a `package.json` at the root manifest path", whether or not
the base has a lockfile there, and for every such directory it evaluates
that file's field-only patterns with `'excludes'`; it never reads
`pnpm-workspace.yaml`; an install root whose `package.json` is new in the
pull request is judged by its own field, as disclosed at
docs/INVARIANTS.md:3179-3183. So a pull request that adds
`sub/package-lock.json` and widens `sub/package.json` `workspaces` over a
base that had `sub/package.json` is still blocked. A mutation that reads
either consumer's answer from the head must turn tests in both families
red.

### The nested-lockfile exemption follows R1 (ruled 2026-10-18)

`checkNestedLockfiles` splits changed lockfiles below the root that this
tool does not read (yarn, bun, a v1 npm file) into `ignored` and `blocking`
by ignorePaths alone (packages/core/src/delta.ts:1152-1168); the ignored
ones get `lockfile-nested-ignored` ("not judged", :1190-1196; codes at
:1123-1124).

Rule: a changed nested lockfile is excused by ignorePaths only when R1
would drop a finding anchored to the manifest in its directory, computed
without the rule-3 reasons sourced from that lockfile itself. Otherwise
the change is judged. Without that exclusion the rule is circular: a new
`fixtures/x/yarn.lock` makes `fixtures/x/package.json` a project through
rule 3 by way of the very lockfile being judged, the base lacked it, and
every fixture lockfile change would be judged. Only another wiring (a
reference target, a workspace membership, a link entry, a requirements
include) counts. The call site is the `isIgnoredPath` closure scan.ts
passes to `computeDelta` (scan.ts:1124-1130).

While `NESTED_LOCKFILE_CHANGE_REFUSES` is false (delta.ts:1121), judging
produces `lockfile-nested-changed` (delta.ts:1202, :1218-1222) in place of
`lockfile-nested-ignored`, with no exit change. `refuseLockfileDowngrade`
(delta.ts:876-1000) never reads `isIgnoredPath`; its throw on unread
nested lockfiles fires regardless of ignorePaths, before and after this
change, so this rule adds no exit 2. The hint
(delta.ts:1203-1207) currently tells the reader to add an ignorePaths
entry; when the entry is already there and R1 is why it did not apply, the
hint instead says that the change wires this directory into the install
(naming the reason), so the entry no longer covers it, and that the remedy
is to remove the wiring or review the lockfile. An entry whose only match
was such a lockfile still counts as matched for `ignore-path-unmatched`
(the `lockfileIgnoreMatches` set, scan.ts:1039).

## 5. Reporting

- **Diagnostic, on every run R1 applies to:** `ignore-path-project-kept`,
  one per path: `fixtures/helper/package.json: covered by ignorePaths entry
  "fixtures", but this change makes it a project (the target of a file:,
  link: or portal: dependency) and <reference> does not install it that
  way; N finding(s) kept`. Position text from `POSITION_TEXT`
  (git-source.ts:1930-1938). Sanitised like every diagnostic.
- **Proposal, on `--trust-base` only:** pushed onto `controls.proposals`
  as the Python index proposal is (scan.ts:1097): `ignorePaths: this change
  makes ignored path fixtures/helper/package.json a project (...); its
  findings are kept`. One line per path, at most 10, then one "and N more"
  line, so the umbrella's summed count stays bounded.
- **JSON.** Additive, minor-safe (docs/release/stability-policy.md:149),
  and it only narrows what ignorePaths silences (:150-152):
  - `ignoreKept: number` on `ScanResult` beside `ignored` (scan.ts:
    124-126), present at zero on every run; `ignored` keeps its meaning.
  - `trustBase.projectPathsChanged: boolean` (present, false at zero) and
    `trustBase.ignoredPathsMadeProjects: string[]` (sorted, uncapped).
  - On each kept finding, optional `ignoreOverride: { entries: string[],
    position: string }`. `fingerprintFinding` hashes only `ruleId`,
    `packageName`, `manifestPath` and `details.signal`
    (packages/core/src/fingerprint.ts:33-37), so `ignoreOverride` stays
    out of the fingerprint as long as it is never placed in
    `details.signal`; a test pins that.
- **SARIF.** The proposal reaches `toolExecutionNotifications` through the
  existing path (packages/cli/src/output-sarif.ts:243-256);
  `run.properties.ignoreKept` beside `ignored` (:230); a kept result
  carries `properties.ignoreOverride`.
- **Text.** The summary line (output-text.ts:307) gains `N kept over
  ignorePaths` on every run R1 applies to, printed at zero.
- **`ignore-path-unmatched`.** An entry whose only matches were kept
  findings counts as matched (same reasoning as scan.ts:1039-1043).
- **README**, the ignorePaths paragraph (README.md:948-952): ignorePaths
  drops findings only for paths nothing installs, or that the base branch
  already installs the same way; a change that wires an ignored path into
  the install keeps its findings and is reported; `lockfile-tamper` is
  never dropped on an installed path; and the residual of section 2 in
  one sentence. Cross-link README.md:1269-1280.
- **CHANGELOG**, `## [0.16.0]`, `### Security`: a pull request could wire
  a directory the base ignores into the install (a `file:` dependency, a
  widened workspace glob, a lockfile beside it, a requirements include,
  or a stray that re-anchors a root-lockfile finding) and the base's
  ignorePaths dropped every finding there, exit 0. Now kept and reported.
  Consumer costs, stated plainly: (a) a green pull request, `--base` run
  or staged commit that wires an ignored path into the install and has
  findings there now exits 1; (b) `lockfile-tamper` findings on a project the base installs under an
  ignored path are no longer dropped. Remedy: move the directory out of
  the ignored path or out of the install, or accept the finding with
  `allow` or the baseline, which has to land on the base branch in a
  separate change first, since a pull request's own control edits are
  proposals.
- **INVARIANTS**, new section "ignorePaths cannot cover a path the change
  wires into the install (0.16.0)": reasons, R1, R2, the anchor rule, the
  reference side per mode, the tamper exception, section 2 with its
  residual, and the edges, citing the section 7 tests by title. Plus the
  clause at docs/INVARIANTS.md:1322-1326.

## 6. Release

0.16.0, a minor, carrying both this rule and B2 (section 8). A new kept
finding, or a new exit 2, can turn a green adopter red, which the stability
policy files under verdicts that may move in a minor
(docs/release/stability-policy.md:167). The Action tag and every
self-referential pin move with it, per the release checklist.

## 7. Test plan

Core tests through `scan()` with `mode: { kind: 'base', ref: 'main' }` and
`trustBase: 'main'` (the `scanPullRequest` shape,
packages/core/tests/audit-2026-10-12.test.ts:43-51), in a new describe
`a change that wires an ignored path into the install (0.16.0)` in
packages/core/tests/nested-manifests.test.ts. The fixture corpus has no
malicious list, so the jest cases use `lodahs`. One CLI case in
packages/cli/tests/trust-base-cli.test.ts via `runCli` covers text, JSON
and SARIF. (`scanCommand` does not exist at be53742; these are the
equivalents.)

| Id | Case | Expect |
|---|---|---|
| H1 | The reproduction: base ignorePaths `fixtures`, head adds `file:fixtures/helper`, the manifest declaring `lodahs`, npm lock entries with the link entry | kept, exit 1, `ignoreKept` 1, `ignored` 0, one proposal, `projectPathsChanged` true |
| H1n | H1 with no link entry: pnpm-lock.yaml in place of package-lock.json, and again with no lockfile | kept both ways (the `file:` reason alone) |
| H1b | H1 where the base already has `fixtures/helper/package.json` and `fixtures/helper/package-lock.json` (rule 3 on both sides) | kept: the reference-target reason is not on the base |
| H1c | H1 with the shipped corpus and `crossenv`, CLI | critical kept, exit 1; the acceptance run |
| H2 | X1: workspaces widened to `examples/*` | kept, proposal; `workspace-link-unconfirmed` unchanged |
| H3 | Base already has the `file:` wiring and the manifest; head adds `lodahs` there | dropped, note "1 of them on installed projects", no proposal, exit 0 |
| H3t | H3 where the head repoints that project's lock entry (a `lockfile-tamper`) | tamper kept, exit 1 |
| H4 | A manifest under `fixtures` nothing installs, with `lodahs` | dropped, no proposal |
| H5 | Head adds `fixtures/helper/package-lock.json` beside an ignored manifest | kept, position "a manifest beside a lockfile" |
| H6 | Subdirectory scan of `fixtures` for H1 | kept, same proposal |
| H7 | H6 with the base's out-of-prefix input unreadable and H3's base wiring | kept, `classification-input-unread` |
| H8 | Base has `packages/x/package.json` under ignorePaths, reached by the inexact pattern `packages/{a,x}`; head changes the pattern to `packages/{b,x}` | kept (pattern text differs) |
| H8b | Base and head both have `packages/{a,x}` and the manifest | dropped, no proposal (no false positive) |
| H9 | H1 as `--base main` without `--trust-base` | kept, diagnostic, no `trustBase` key |
| H10 | Branch: an earlier commit on HEAD adds H1's wiring, trust base main lacks it; a staged commit adds `lodahs` there | dropped without `--trust-base` (HEAD has the reason); kept with `--trust-base main` |
| H11 | H1 as an audit | dropped |
| H12 | Head removes H3's `file:` specifier, manifest stays | dropped, no proposal |
| H13 | `ignore-path-unmatched` for an entry whose only match was kept | not reported |
| H14 | The judged and reference states `applyPathFilters` receives, after `reconfirmWorkspaceLocalNames` and `applyUvSources`, carry `projects`; deleting it on the judged side throws | both present; throw |
| H15 | Head adds `fixtures/stray/package.json` declaring a name a root-lockfile entry carries, and tampers that entry | tamper kept (matched on `lockfilePath`), fingerprint equal to the unmoved finding's |
| H16 | Head adds `-r fixtures/extra.txt` to root `requirements.txt`; extra.txt declares `reqeusts` | kept, position requirements-include |
| H16s | H16 as `scan <repo>/fixtures` (the including file outside the prefix) | kept, same reason |
| H17 | yarn root, `pnpm-workspace.yaml` holding only `!examples/demo`, head widens `workspaces` to `examples/*` | kept (the yaml's negation does not cancel the field) |
| H18 | Ruling 3, excused: head adds `fixtures/x/yarn.lock` beside an ignored `fixtures/x/package.json`, nothing else wires it | diagnostic code `lockfile-nested-ignored`, no `lockfile-nested-changed`, exit unchanged |
| H19 | Ruling 3, judged: H18 plus a root `file:fixtures/x` | exactly `lockfile-nested-changed` (no `lockfile-nested-ignored`), exit unchanged, hint names the wiring |
| H20 | `--staged --trust-base main` where HEAD carries the wiring and main does not | kept (same as H10's second half; pins ruling 1) |
| H21 | `--base X --trust-base Y`, X has the wiring, Y does not | kept: Y decides |
| H22 | `--trust-base main` without `--base`, H1 | kept |
| H23 | H1 where the helper manifest has no findings | proposal present, `ignoreKept` 0 |
| H24 | Twelve wired paths | ten proposal lines and "and 2 more"; JSON lists twelve |
| H25 | Audit of H3's tree | note says "1 of them on installed projects" |
| H26 | A clean pull request under `--trust-base` | `ignoreKept` 0 and `projectPathsChanged` false both present |
| H27 | Link exemption: base has `sub/package.json`; head adds `sub/package-lock.json` with a link and widens `sub/package.json` `workspaces` | still `workspace-link-unconfirmed`, the name is checked |
| H28 | A kept finding's fingerprint equals the same finding's fingerprint with no ignorePaths | equal |
| H29 | F1: head adds `"helper": "./fixtures/helper"`, no lockfile and again with pnpm | kept, exit 1, proposal |
| H29c | H29 where the base already has the bare-path wiring | dropped, exit 0 |
| H30 | F1: head adds an absolute-path dependency | every ignored package.json kept and proposed; the same absolute specifier on both sides drops |
| H31 | F2: head adds symlink `vendor` to `fixtures/helper` and `file:vendor`, with and without an npm lockfile | kept on `fixtures/helper/package.json`, exit 1 |
| H31c | H31 where the base already has the symlink and the wiring | dropped, exit 0 |
| H31o | F2: the symlink points outside the repository | fail closed: every ignored package.json kept |
| H32 | F3: base strays `fixtures/a` to `fixtures/b`; head adds root `file:fixtures/a` and `lodahs` in b, no lockfile and pnpm | b kept, both proposed |
| H32c | H32 where the base already wires `fixtures/a` from the root | dropped, exit 0 |
| H33 | Requirements: head adds an absolute `-r` include | every ignored requirements file kept |
| H34 | A staged run with no HEAD and no trust base | `ignoreRuleApplied` false, text has no "kept over ignorePaths" |

Mutation table. Each mutation is applied, the named tests run, and each
must go red; the implementer records the result in the pull request.

| Mutation | Must go red |
|---|---|
| Apply the ignorePaths drop before consulting reasons (today's order) | H1, H1n, H2, H5, H6, H9 |
| Read the reference reasons from the judged side | H1, H1n, H2, H5, H6, H22; and the existing `under --trust-base a workspaces glob the pull request adds does not confirm its own link` |
| Excuse by path instead of by reasons | H1b, H8 |
| Drop reasons' pattern text (inexact matches never excuse) | H8b |
| Skip the proposal line | H1, H23, H24, the CLI case |
| Treat only the workspaces field as a project input, not `file:` specifiers | H1n |
| Use the `classification-input-unread` expansion as a reference reason | H7 |
| Apply R1 in audit mode | H11 |
| Drop tamper findings on a base-installed project | H3t |
| Keep non-tamper findings on a base-installed project | H3 |
| Match ignorePaths on `manifestPath` when it is not a judged project | H15 |
| Leave requirements includes out of the reasons | H16, H16s |
| Compute requirements includes from the scan prefix only | H16s |
| Evaluate field and yaml negations together | H17 |
| Count the judged lockfile's own rule-3 reason in the nested exemption | H18 |
| Leave the nested-lockfile `isIgnoredPath` on ignorePaths alone | H19 |
| Use HEAD as the reference for `--staged --trust-base` | H10, H20 |
| Use the `--base` side as reference when `--trust-base` is given | H21 |
| Read missing judged `projects` as "nothing kept" | H14 |
| Let the link check read classifySide install-root positions (lockfile required) | H27 |
| Put `ignoreOverride` into `details.signal` | H28 |
| Leave bare local paths out of rule 5 | H29 |
| Drop an unplaceable target instead of covering every manifest | H30, H31o |
| Do not follow symlinked target directories | H31 |
| Count a reference reason whose source is not excused | H32 |
| Drive the text summary's kept count from the mode | H34 |

## 8. Audit B2: an unchecked name does not pass a pull request

Ruled by the operator 2026-10-18 (and earlier, 2026-09-29, as F8). Same
release, separate rule.

**The problem.** `enrichOnline` (scan.ts:654-751) records only
`deadlineExceeded` (:748); nothing maps an unchecked name to an exit.
README.md:289 says "A spent budget never fails the run". A PyPI name that
is never answered is "unchecked, with a diagnostic and a count, and never
a finding" (README.md:194-197; pypi-existence.ts:158-170;
docs/INVARIANTS.md:3802). Offline, a Python name gets no existence check,
so in pull-request mode the lookup is its only one. Reproductions: adv/p1,
head adds `zz-dg-audit-nonexist-1018==1.0.0` and `reqeusts==1.0.0`;
`scan --base main --trust-base main --online` is 2 critical, exit 1, and
the same with `--online-budget-ms 1` is "pypi 0 of 2 checked ... 2 online
budget spent", exit 0. The otel npm case: `--base 9c9d632 --online
--online-budget-ms 300` is "No findings", `deadlineExceeded` true, exit 0.

**Rule B2.** On a run with `--base` or `--trust-base` (the existing
`isPullRequestRun`, scan.ts:1195; and `check --trust-base`, scan.ts:1377)
with online lookups on, the run exits 2 when any candidate name was left
unchecked by an online step. Only a definitive "exists" or a 404 is a
checked name (confirmed 2026-10-18). Unchecked means:

- `budget`: the online budget was spent before the name came up;
- `unreachable`: every answer the npm or PyPI client already counts as
  unreachable: network error, timeout, a 5xx after the retry, a 429, any
  other 4xx except 404, and on PyPI only a 3xx or a 2xx naming another
  project; with the status where known. The 3xx and wrong-name boundaries
  are PyPI's alone (pypi-client.ts:42-66, redirects set to manual). npm's
  `fetchPackument` follows redirects and does not check the packument's
  name (registry-client.ts:403-413); that stays as policy, so neither is an
  npm reason;
- `online-disabled`: see "Online turned off on the command line" below.

A 404 stays the critical unknown-package finding. Every online step
counts: npm unknown-package resolution (an unresolved name keeps its high
finding, which `failOn: "critical"` would pass), PyPI existence, the
typosquat asymmetry step, registered-squat and publish-age. Each step
returns its unchecked names with the reason instead of only a count
(today the count is read back from diagnostics, deadline.ts:123).

**Not candidates, never counted:** a name the `allow` list clears; a name
exempted as workspace-local (`workspaceLocalNamesByDir`); a name
`internalPrefixes` or an internal scope keeps off the wire; a name skipped
because its origin is a private registry or index (the
`*-private-origin-skipped` and `pypi-private-index-skipped` paths). PyPI
looks a name up before asking `allow` (pypi-existence.ts:164-176); that
order is kept so `allowed` keeps its meaning, and allowed names are
filtered out of the unchecked set afterwards. Known open: publish-age's
private-origin skip keys on the head-written resolved URL
(publish-age.ts:124-134). A foreign-host entry is a high `lockfile-tamper`
finding, so it is not a silent route, but under `failOn: "critical"` that
name passes with publish-age unchecked.

**Online turned off on the command line** (ruled 2026-10-18). `--no-online`
overrides config `"online": true` (cli.ts:301, scan.ts:299-300), and the
Action passes `--no-online` unless its `online` input is true, so B2 as
written would never apply there. Rule: on a `--base` or `--trust-base` run
whose trust base config (or, without a trust base, the config in effect)
says `"online": true` while the run has online disabled by the CLI flag or
the Action input, every candidate name counts as unchecked with the reason
"online lookups disabled on the command line while the base config requires
them", and the run exits 2 under the same `onlineUnchecked` key (`"fail"`
or `"note"`). A base config with `online` false or absent is unchanged.
Consumer cost, stated plainly: an Action adopter whose base config says
`"online": true` must set the Action's `online` input to true, or set
`"onlineUnchecked": "note"` on the base. The README says so beside the
workflow-trust paragraph (README.md:316-320).

**Exit 2 with a report.** Unlike the existing could-not-run cases, which
throw before a result exists (output-sarif.ts:239-242), this run did scan.
The result is built and rendered in full, and the exit is 2:
`ScanResult.exitCode` widens to `0 | 1 | 2` (scan.ts:166) for this one
cause; `evaluateGate` stays 0 or 1. Conductor treats any family gate's
exit 2 as could-not-run and composes it to its own exit 2 whatever the
gate printed, so the run is red there whether or not the findings are
read. The printed report is for humans; the JSON is for direct consumers.

- Text: one line after the findings, `could not run: N candidate name(s)
  were not checked online (name: reason, ...)`, ten names at most, then
  `and N more`. Stderr carries the same line with code
  `online-names-unchecked`, as other exit 2 messages do (cli.ts:246-257).
- JSON: `run.online.unchecked`: `{ count, names: [{ name, ecosystem,
  step, reason, status? }] }` (names uncapped, sorted), present at count
  zero whenever online is on; `run.couldNotRun`: `{ code:
  "online-names-unchecked", message }` or absent. Both additive.
- SARIF: `invocations[0].executionSuccessful` false, with one
  `toolExecutionNotifications` entry of level `error`;
  `run.properties.onlineUnchecked` the count. Today `invocations` exists
  only when there are proposals (output-sarif.ts:243); the error
  notification merges into that single invocation beside the proposal
  notes, and creates it when there are none. The comment at
  output-sarif.ts:236-242 changes, since one exit 2 now reaches it.
- Action: the exit-2 `::error::` text in action.yml's case 2 branch adds
  "candidate names not checked online" to its list of causes.
- Plain and audit runs keep today's diagnostic-only behaviour, and the
  diagnostics (`online-deadline-exceeded`, `online-check-unreachable`)
  stay on every run.

**Opt-out key.** `"onlineUnchecked": "note"` in `.dep-guard.json`, values
`"fail"` (the default) and `"note"`, which restores diagnostic-only in
pull-request mode. Named with the `online` prefix like `online` and
`onlineBudgetMs` (config.ts:20-32, :322-339), and a string like `failOn`,
so a later third value needs no second key. No CLI flag: the workflow file
is head-controlled on a same-repository pull request (README.md:316-320),
and an opt-out is a control. Under `--trust-base` the key is read from the
trust base like every other control (scan.ts:969), and a head change to it
is a config proposal, added to `describeConfigChange` (trust-base.ts:568).

**README.** README.md:286-292: "A spent budget never fails the run by
itself" becomes: on a plain run a spent budget or an unreachable registry
stays a diagnostic; on a run with `--base` or `--trust-base` a name left
unchecked for either reason exits 2, listing the names, unless
`onlineUnchecked` is `"note"`. The same at README.md:181-184 and :194-197,
and the config example (README.md:931-944).

**CHANGELOG**, the same `### Security` heading: a pull request whose names
outran the online budget, or met a registry outage, passed with only a
diagnostic. Now exit 2. Consumer costs: a pull request with more new names
than the budget covers, or run during a registry outage, now exits 2; and
a run with online disabled on the command line, including the Action's
default, exits 2 when the base config says `"online": true` (set the
Action's `online` input to true, or `"onlineUnchecked": "note"`). Remedies: raise `onlineBudgetMs` on the base branch, set
`"onlineUnchecked": "note"` on the base branch (each in a separate change
first), or split the change.

**INVARIANTS.** Amend docs/INVARIANTS.md:3802 ("never a finding" stays
true; add "and in pull-request mode a could-not-run, exit 2") and "Online
checks degrade" (docs/INVARIANTS.md:1890): diagnostic-only on plain runs,
exit 2 on pull-request runs.

**Tests** (scan-pypi.test.ts and scan-online.test.ts, which substitute both
clients with `jest.unstable_mockModule`):

| Id | Case | Expect |
|---|---|---|
| U1 | adv/p1 shape, `--base` + `--trust-base`, budget 1 ms | exit 2, both names with reason `budget`, `run.couldNotRun` set |
| U2 | otel shape: npm names queued for registered-squat and publish-age, budget spent | exit 2, step names in the list |
| U3 | PyPI 404 for one name, budget spent for the other | 1 critical finding and 1 unchecked name, exit 2 |
| U4 | Every name answered, one 404 | exit 1, `unchecked.count` 0 |
| U5 | PyPI 503 after retry, a 302, a 403, a 2xx naming another project (the last two PyPI only); npm 429 | exit 2, each `unreachable` with status |
| U6 | Unchecked names that are allowed, a confirmed workspace sibling, internal-prefixed | exit 0, count 0 |
| U7 | U1 as a plain run and as an audit | exit 0, diagnostics only |
| U8 | U1 with base `"onlineUnchecked": "note"` | exit 0, count still reported |
| U9 | U1 where only the head sets `"onlineUnchecked": "note"` | exit 2, config proposal names the key |
| U10 | Twelve unchecked names | text and stderr list ten and "and 2 more"; JSON twelve |
| U11 | U1 plus a head config change (so a proposal exists), as SARIF and JSON through `runCli`; and U1 alone | one invocation holding both the proposal note and the error notification, `executionSuccessful` false; without the proposal, an invocation with the error alone; JSON fields present |
| U12 | `check <name> --trust-base main --online`, budget spent | exit 2 |
| U13 | Base config `"online": true`, run with `--no-online`, `--base` + `--trust-base` | exit 2, every candidate with reason `online-disabled` |
| U14 | Base config `online` false or absent, `--no-online` | unchanged from today |
| U15 | Budget spent before the typosquat asymmetry step (scan.ts:691-697), with a low typosquat queued | exit 2, the name listed with step asymmetry (that step emits no names today) |

| Mutation | Must go red |
|---|---|
| Turn an unchecked name into a finding instead of exit 2 | U1, U3 (finding count), U6, U11 |
| Apply B2 on plain and audit runs | U7 |
| Ignore the `onlineUnchecked` key | U8 |
| Read the key from the head instead of the trust base | U9 |
| Count a 404 as unchecked | U3, U4 |
| Count only 5xx and 429 as unreachable | U5 |
| Count allowed or workspace-local names | U6 |
| Collect only the PyPI step | U2, U5 (npm half), U15 |
| Ignore a CLI `--no-online` when the base config says online true | U13 |
| Apply the online-disabled rule when the base config does not require online | U14 |
| Render the error in a second invocation, or drop the proposal notes | U11 |

## Open questions

None outstanding. Both questions from the first draft were answered on
2026-10-18 and are folded into section 8.
