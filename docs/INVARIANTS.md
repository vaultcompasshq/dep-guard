# dep-guard invariants

These are the cross-cutting rules the engine depends on. They are here
because every one of them was already true somewhere in the code and
written down nowhere both sides of a boundary could see it. This engine's
worst bugs have had the same shape, again and again: two pieces of code
each honouring a local invariant, neither aware of the other's. A
cohesion audit reads this file rather than re-deriving the list from
memory, and every new architectural decision appends to it.

Read this before changing the delta, the fingerprint, the path handling, or
anything that decides an exit code.

Derive, do not describe. This engine's defects keep landing in the same
place: a hand-maintained list of facts, kept alongside logic that lives in
another file, which has to stay in step with that logic and does not. `comparabilityKey`'s account of what the comparison rules read;
two diagnostics' copies of the tamper signal list; the pin-mismatch rule's
absence from the list of which walk feeds which rule; the claim below about
which values may enter a fingerprint. Every one of them was correct when it
was written and silently wrong afterwards, and every one failed in the
direction that lets an attacker through, because a stale description says
"nothing to see here" and a missing entry never announces itself. So when a
decision depends on what some other code does, compute it by running that
code and reading the result, or generate it from that code. If a parallel
list is genuinely unavoidable, make it the thing the logic is written
against, so an omission is a compile error rather than a silence.

This file records INTENT, and intent is not coverage. Every claim here
about what the engine already handles has to be checked against the code
before it is relied on: prose in this document has been wrong before, and
each time, the bug sat exactly where the prose waved a hand. A cohesion
audit that reads
this file as a statement of fact will confirm the gaps rather than find
them. Read it for what the engine is trying to do, then go and see.

## The fingerprint is a promise about facts, not about categories

A finding's fingerprint is a sha256 over exactly four things, in this
order: the rule id, the canonical package name, the manifest path, and
`details.signal`. Nothing else may enter it. Severity, the message, the
version, the corpus build date, and every other `details` key are excluded
on purpose, because all of them move under a review, a version bump, or a
corpus refresh without the underlying finding being a different fact, and a
fingerprint that shifted with them would silently invalidate every stored
baseline.

The signal is where the specificity lives, and it carries two distinct
duties. First, it separates findings one rule can raise about one
dependency at once: a tampered entry can lose its integrity hash, move
host, and downgrade its scheme simultaneously, and baselining one of those
must not silence the other two. Second, it must identify the *fact* and
not merely its category. Baselining a
benign migration to an internal registry used to accept every later repoint
of that package to any host, because both findings hashed the same
`host-changed`. So where a signal has a value-bearing subject, that value
belongs inside the signal string: `host-changed:https://artifactory.example`,
`pin-mismatch:registry.npmjs.org`. The four-component hash stays exactly as
specified; the fourth component just says something.

The test for whether a value may be folded into a signal is the stability
contract, not taste: it may go in only if it cannot move under a corpus
refresh or a version bump. A resolved host cannot, so it goes in.
Typosquat's matched target, matched rule, and target rank all can -- they
come from the shipped corpus -- so they stay out, and typosquat's slightly
coarse baselining is a deliberate consequence, not an oversight.

`local-source-changed` is the signal that rule caught out, and it is worth
naming because it looked like it obeyed the rule while breaking it. Its
subject is an origin, and an origin was already established as stable --
but a HOSTLESS origin is the path (see the tamper section below), and a
vendored tarball's path moves on every bump of it. Folding it in minted a
fresh fingerprint per bump that no baseline could ever absorb, which is
precisely what the stability contract exists to prevent. That signal is
therefore bare: `local-source-changed`, with both origins in `details`,
where nothing hashes them. The lesson generalises -- the question is never
"is this a value-bearing subject", it is "can this value move under a
version bump", and for a path the answer is always yes.

Renaming or splitting a rule id invalidates every baseline that mentions
it, so it waits for a major version.

## The delta has two walks, and neither is derivable from the other

`computeDelta` produces two independent lists, and the distinction is a
security property rather than an implementation detail.

`changes` is the manifest walk: which declared dependencies were added or
changed. It carries the specifier, the dependency section, the protocol,
and the manifest path, and it is what the name-based rules (existence,
typosquat, confusion's internal-name rule) and the specifier-based rules
(hygiene, tamper's git-source and url-source signals) need.

`lockEntryChanges` is the lockfile walk: which resolved entries differ from
the before lockfile, entry by entry, whether or not a manifest declares
them, and however many entries share one name. This is what the
resolution-based rules need -- tamper's integrity, host, scheme, tarball
and local source signals, install-script's flag acquisition, AND
confusion's pin-mismatch rule -- because in a real lockfile the
overwhelming majority of entries are transitive and no manifest names
them, and because one name can carry several entries, of which a single
"which version does this specifier resolve to" answer selects exactly one.

pin-mismatch was missing from that list for a while, in this file and in
the code both. It asks whether a RESOLUTION came from the host its scope
was pinned to, which is a resolution question wearing a name-shaped rule
id, and reading it off the manifest walk alone left it blind to exactly
the case it exists for: a transitive package under a scope pinned to a
private registry, quietly resolving from the public one. It reads both
walks now. Its sibling, the internal-name rule, stays on the manifest walk
and belongs there: it judges a name somebody declared, not a resolution.

Rules that judge a resolution must consume the second list. Rules that
judge a name or a specifier must consume the first. A rule that consumes
the first when it means the second is blind to transitive entries and to
any entry a decoy can hide behind, which is exactly how a repointed
transitive tarball and a same-version decoy both used to scan clean. A fact
reached by both walks is deduplicated on (manifest path, package name,
signal), so a tampered direct dependency is still one finding.

`kind` is `added` or `changed`, and never `removed`: dropping a dependency
cannot introduce any of the risks this tool looks for. Which checks gate on
`kind` is deliberate and worth stating, because getting it wrong is silent
in both directions. Existence and typosquat consider added dependencies and
aliases at any kind, since a retargeted alias has never been judged before.
Confusion's internal-name rule does the same; its pin-mismatch rule ignores
`kind` entirely, because a resolution that stopped matching its pin is
exactly as serious when no manifest line moved. Install-script treats
`added` and `flag-acquired` as different signals but reports both, and
never reports a bump that leaves an already-true flag true. Tamper ignores
`kind` for every signal: the git-source swap in particular almost always
arrives as a changed specifier, never as a new dependency.

## Pairing two lockfiles is a chain of guesses, and each guess owes a diagnostic

`selectEntry` picks which of a name's entries a specifier resolves to, and
has always said so when it could not tell. `pickCounterpart` answers the
other half of the same question -- which earlier entry a changed one
should be compared against -- and for a long time said nothing at all: it
fell through to whichever entry the lockfile happened to list first and
then let the checks assert a change against it. Two entries under one name
are ordinary (a mirrored older copy nested under another package, a second
version for a different peer set), so that positional pick turned routine
bumps into criticals whose message was backwards and which vanished if the
two lockfile keys were swapped.

Both selectors are therefore guesses under the same rule. A counterpart is
narrowed from the strongest evidence down: an identical resolved URL, then
a shared origin, then a matching install-script flag, and each step only
applies when it leaves a candidate standing. A pairing that survives all of
that with more than one candidate is a guess, and a guess may not
manufacture a fact.

What a guess costs, though, is narrower than it looks, and getting that
wrong made the suppression attacker-constructible. Suppressing every
comparison signal for a guessed pairing was a defensible-sounding rule with
a hole in it: any name carrying two before entries -- which nested
duplicates make ubiquitous in a real lockfile -- could be repointed to any
host in one move by giving the evil entry a version no candidate shares.
Every narrowing step then fails, every signal goes quiet, and the scan
exits 0 with a note. The mistake was treating the VERDICT as the guess. It
usually is not: an entry resolving from a host none of the candidates ever
resolved from has moved whichever one it succeeds. What the guess really
costs is the before-value a message would print.

So the rule is: compare against every surviving candidate, and report a
signal every one of them produces, worded in terms of what is certain --
"not where any of the N earlier entries resolved from", never one
candidate's origin, and `details.counterpartCandidates` in place of ANY
before-side value. That means `details.beforeOrigin`, and it means
`tarball-repointed`'s `details.beforePath` too, which carried the first
candidate's tarball path for a while: no credential is in a pathname, but a
value read off one candidate is a fact about which candidate the delta
guessed at, and printing it as though the lockfile said so is the same
defect wearing a smaller consequence. Suppress only a signal that some candidates produce
and others do not, because that one really would be a fact about which
candidate was picked. Install-script follows the same rule: an acquisition
when no candidate ran scripts, silence when one of them did.

`delta-ambiguous-lock-entry` follows the suppression rather than the guess.
It is raised when a comparison actually dropped something, and not
otherwise -- which is what makes it mean something. Firing on every guess
made it simultaneously the only honesty channel covering this hole and the
noisiest note in the set, since a nested duplicate of any bumped package
produces an undecidable pairing on nearly every routine refresh.

How that is decided is the part worth stating carefully, because the first
answer to it was wrong in the way this file is most concerned with. The
delta used to predict it: `comparabilityKey` listed the FACTS the
comparison rules read -- origin, hash presence, hash equality, version,
URL, install-script flag -- and two candidates sharing that key were
declared indistinguishable, so no note was raised. The list was not a copy
of the rules, only a description of them, and a description drifts the
moment a rule reads something it does not mention. Its failure mode is
silent and one-directional. A partially migrated lockfile holding a package
at `sha512-clean` beside a nested duplicate at the same version and the same
URL still carrying `sha1-old` gave both candidates the same key -- same
origin, same version, same URL, both "not the new hash" -- while the
algorithm ladder read a rewritten `sha512` as a forgery against one and as a
routine `sha1`-to-`sha512` rehash against the other. The critical was
dropped for disagreement, the key saw nothing to disagree about, and the
scan exited 0 with no findings and no diagnostics: attacker-benefiting
silence inside the mechanism built to end it.

So the decision is DERIVED, not described. The delta hands over every
surviving candidate (`beforeCandidates`) and says nothing about what a
comparison will make of them. Each check runs its real comparison once per
candidate, intersects the RESULTS, and raises `delta-ambiguous-lock-entry`
itself for anything the intersection dropped -- `certainFindings` in
`checks/tamper.ts`, and the acquisition suppression in
`checks/install-script.ts`. The drop and the announcement are one event, so
they cannot drift apart, and a rule that starts reading a new fact needs no
bookkeeping anywhere: the new fact changes the results, and the results are
what is compared. The invariant is therefore structural rather than
maintained -- a finding any candidate produces is either reported, when they
all agree, or announced as ambiguous. Neither silence nor a note about a
guess that cost nothing is reachable.

Do not reintroduce a key that describes these rules from outside them.
This engine's defects keep landing in a hand-maintained parallel list that
has to stay in step with logic living somewhere else, and this was
another one. If a derived key is ever wanted for speed, it has to be
generated from the comparison functions, not written alongside them.

The intersection has ONE implementation, in `checks/agreement.ts`, and both
checks that need it call it. That is not tidiness either. install-script
carried a hand-written approximation of it for a while --
`candidates.some(flagged)` plus a candidate count -- and the approximation
got a cell of the truth table wrong that the real intersection gets right
for free: when EVERY candidate already ran install scripts they all reach
the same verdict, so nothing is dropped and the scan can say plainly that
running one is not new. `some()` fires on "at least one", which is also true
when they all agree, so a bump of a scripted package beside a flagged nested
duplicate -- routine, and common -- announced an ambiguity with a false
message on every refresh. An imitation of a derived mechanism is a described
mechanism wearing the right words.

## What a dropped verdict costs, and what it must not cost

A dropped verdict is announced twice over, and the two channels do different
jobs. `delta-ambiguous-lock-entry` explains; it never touches the exit code,
because diagnostics never do. That left a real hole: a consumer reading only
the exit code saw a clean scan while some candidate had produced a CRITICAL.
So a drop whose set contains a critical ALSO produces a finding --
`lockfile-tamper`, signal `ambiguous-critical`, severity high, which blocks
at the default medium gate -- worded to say the engine could not determine
which earlier entry applies and the entry should be treated as suspect.

High rather than critical is the honest severity: a critical asserts the
tampering happened, and this cannot assert that. One escalation per
undecidable entry, however many verdicts went undecided, because they are
one admission. Drops carrying nothing above high stay diagnostic-only --
install-script's suppressed acquisition is the case, and making an
unattributable high block would put a note on every lockfile with a nested
duplicate back into the gate. The blocking decision stays in findings, where
it belongs; the diagnostic keeps its standing promise not to reach the exit
code.

## The narrowing ladder is the list that is still a description

`pickCounterpart`'s ladder -- version, then resolved URL, then origin, then
the install-script flag -- is the remaining described-not-derived list in
the engine. It decides which candidates
survive to be compared at all, and it is a hand-written account of what
distinguishes two entries rather than anything derived from the comparison
rules. It has not gone wrong yet. It is written down here because the
mechanism above only holds for the candidates the ladder hands it.

The bound below is recorded so the next maintainer re-tests it rather
than rediscovers it: a pairing the ladder narrows to a
SINGLE candidate is not a guess, so it announces nothing and escalates
nothing. That is reachable on purpose. It also means a before side holding
one hashed entry at one version and one hashless entry at another lets an
attacker's entry be steered to the hashless candidate -- match its version
and the first rung decides the pairing -- so `integrity-removed` never
arises, nothing is dropped, and there is nothing to announce.

That behaviour is deliberate and buys an attacker nothing they could not
get by editing the steered-to entry directly, which is why it is not
treated as a finding. It is nonetheless a real edge of the guarantee, and it
is load-bearing on the ladder staying as it is. ANY future change to the
comparison rules, or to the ladder itself, has to re-check this case
explicitly. Do not assume the derive-and-intersect mechanism above covers
it: that mechanism protects the comparison of surviving candidates, and this
is about which candidates survive.

The older half of this trade still stands where it applies: a critical
nobody can reproduce by reading the lockfile is how a gate loses its
reader.

Both selectors judge "same origin" through `resolution.ts`, which is also
what the tamper rules judge a move by. That is not tidiness: a second copy
of "same origin" would let the delta pair two entries the check then calls
different.

An added entry -- no before side at all -- is a third case, and it is not
judged. There is nothing to compare, so the comparison signals do not run,
and the entry is not held to an absolute standard either; an absolute rule
that would judge a new entry on its own merits is deferred. What is owed is
the admission, and in the delta modes it used to be missing entirely: a
fresh install scanned exactly like a scan that had evaluated every entry.
One aggregate `delta-new-lock-entries` diagnostic per scan names the count.
One, not one per entry -- a fresh install adds hundreds, and a per-entry
note would bury the diagnostics that name something specific. Audit mode
does not raise it, because `audit-no-tamper-comparison` already says the
same thing about the whole lockfile.

## A scan with no comparison base may report facts, never events

With no earlier revision behind the scan -- audit mode, or a staged scan of
a repository with no commit yet -- every dependency reads as added and
every install-script flag reads as newly acquired. Both are true of the
scan and false of the repository, and a check that spells them as events
files a blocking finding per flagged package on the first sweep of a real
repository, which is the sweep a new adopter runs first and abandons
fastest.

The delta carries `hasComparisonBase` so a check can tell the two
situations apart. install-script is the rule this bites: with a comparison
base it keeps its acquisition semantics, its `added` and `flag-acquired`
signals, and its blocking high. Without one, the same fact is reported as a
fact -- signal `present`, severity low, wording that says the package runs
an install script and that this scan cannot tell whether that is new. Low
sits under the default medium gate on purpose: knowing which dependencies
execute code at install time is most of why someone audits, so the finding
stays, and it stays out of the exit code. Any future rule that wants to say
"this is new" must consult the same flag rather than reading `kind`, which
in these modes says `added` about everything.

This is a rule about every reporting path, not about one of them, and it
holds however small the affected list is. pnpm's `onlyBuiltDependencies`
findings are the sibling case: `onlyBuiltDifference` reads the entire
allowlist as added when there is no before state, so `only-built-added` at
high said "newly added" about a list nobody had touched. It reports
`present` at low in that mode too, on the same wording pattern, and keeps
its acquisition signal and severity in the delta modes. That allowlist is
short enough that the false sentence could never have wrecked a sweep the
way the per-entry flag did; it was fixed anyway, because two paths
answering the same question differently is precisely the drift this file
exists to catch.

## What the tamper signals cover, and what the manifest walk cannot reach

The comparison-derived tamper signals are `integrity-removed`,
`integrity-changed`, `integrity-downgraded`, `tarball-repointed`,
`host-changed`, `scheme-downgrade`, `local-source-changed`, and
`resolution-unreadable`, and they are declared once, in
`tamper-signals.ts`.

A diagnostic that describes coverage lost across the board -- audit mode's
`audit-no-tamper-comparison`, the delta's `delta-new-lock-entries` -- names
them all, because naming a subset under-reports the engine's own blind spot,
which is the failure mode the whole diagnostic exists to prevent. This file
used to state that as a fact about every such diagnostic, and it was false:
both of those messages carried their own copy of the list, both copies were
written when there were six signals, and neither learned about
`tarball-repointed` or `resolution-unreadable` when those were added to the
check. Both messages are now built from the one declaration, and every
`details.signal` is produced through a helper typed against it, so a signal
absent from the list does not compile and cannot go unnamed.

A diagnostic about ONE entry says which comparisons did not run for that
entry, which is a different and narrower sentence:
`tamper-resolution-unreadable` names the host, scheme and local-source
comparisons because those are the three that were skipped, while the
integrity branches still ran for it. Naming all eight there would be the
same misreport in the other direction.

`integrity-changed` closes what was a known gap: a hash removed was
critical, a hash rewritten in place was silent, and forging is strictly
worse than stripping. Registry tarballs are immutable, so one version
fetched from one URL has one hash forever; a different one is tampering or
a corrupt lockfile. It requires the version to be unchanged, which is what
keeps an ordinary bump out of it (version, URL and hash all move together
there), and it sits in an else-if with `integrity-removed` so a deleted
hash is reported once.

It used to require the resolved URL to be unchanged as well, and this file
defended that with the claim that a repoint "is already the more specific
`host-changed`". That claim was false, and the composition it hid is the
worst bug this engine has had. A repoint is only host-changed when the
ORIGIN changes. Within one origin -- lodash's resolution rewritten to
`https://registry.npmjs.org/evil/-/evil-1.0.0.tgz`, carrying evil's own
genuine hash, version untouched -- the integrity branch declined it for the
moved URL and the resolution comparison below dismissed it as a version's
tarball moving, so npm installed the attacker's bytes from the trusted host
and the scan emitted nothing at all. Not a finding, not a diagnostic.

`tarball-repointed` is that case: the version held, the origin held, the
URL and the hash moved together. One version has one tarball and one hash,
so this is a different artifact under the same name, and it is critical.
The algorithm ladder below deliberately does not run for it -- the ladder
forgives a rehash of the SAME bytes at the same URL, which this is not. The
one shape it must stay silent for is the ordinary bump, and the VERSION is
what tells them apart: when the version moved too, the URL and hash were
expected to move with it. An identical hash across the move also settles
it, in the other direction: same bytes, so the path change is a detail.

`resolution-unreadable` is the fail-closed case. A resolved URL the engine
cannot parse used to end the comparison with a bare return, and npm
genuinely writes such values (a bare relative path like
`vendor/payload.tgz`), so repointing an entry at one of them with the hash
rewritten to match was silent too. That broke two rules this file states
outright -- every guess owes a diagnostic, and a URL or hash the engine
cannot read must never be treated as one it approved. The package is now
named in a `tamper-resolution-unreadable` diagnostic whichever way it ends,
because the host, scheme and local-source comparisons genuinely did not run
for it; and when the resolution moved to or from something unreadable with
nothing vouching for the bytes, it is a critical. An identical hash on both
sides vouches for them, the same settlement `local-source-changed` makes.
The unreadable value itself never reaches the message or the details: a
string that failed URL parsing is exactly where a malformed credential
would survive the parsing that strips one everywhere else.

An integrity value is not an opaque string, though, and comparing two of
them without reading the algorithm prefix conflates three different events.
So a rewritten hash goes through a ladder, and the ladder -- not the branch
that reaches it -- decides which signal it is, or whether it is one:

- Same algorithm, different digest: `integrity-changed`, critical. This is
  the case with no innocent explanation.
- A stronger algorithm than before (sha1 to sha512, sha1 to sha384): a
  benign rehash, which is what migrating a lockfile off an older npm does
  to every entry it touches. No finding. Without this, a routine migration
  files a critical per dependency.
- A weaker algorithm than before (sha512 to sha1): `integrity-downgraded`,
  critical. This is the "removed or downgraded" half of the spec's rule
  said out loud -- an attacker who cannot forge a sha512 digest can try to
  get the lockfile to accept a weaker one instead.
- An algorithm either side does not recognize: reported as
  `integrity-changed`. Unknown is not weak and it is not benign; the
  comparison fails closed, because a hash the engine cannot read must never
  be treated as a hash it approved.

The strengths are an explicit ordered list, never a string comparison:
"sha1" sorts after "sha384" and before "sha512" lexically, which is two
wrong answers out of two. A value carrying several space-separated hashes
is worth its strongest one.

`local-source-changed` is the hostless counterpart of `host-changed`:
every `file:` URL has an empty host, so scheme-and-host comparison alone
left a vendored tarball swapped for a planted one completely silent, and
for such a resolution the path is the only thing that says which bytes.
That makes it fire on path moves, and two of those are ordinary work --
renaming a vendored tarball, moving the vendor directory -- so it now
requires that the integrity hash be absent, removed, or rewritten. An
identical hash on both sides proves the bytes did not move, which makes the
path change a reorg.

Its relationship to the `file:` protocol exemption is the part worth
writing down, because the two look like they contradict each other. The
manifest walk exempts `file:` (with workspace, catalog, link, and patch)
as internal wiring, so a dependency DECLARED as `file:../x.tgz` never
reaches this or any other registry-oriented rule. The exemption is about
declared specifiers; `local-source-changed` is about resolutions, and an
ordinary registry specifier can resolve to a hostless URL -- which is
exactly the swap being looked for. So the rule lives entirely on the
resolution side, and the lockfile walk is what carries it: for a
file-resolved entry the manifest walk either exempted the dependency or
never declared it in the first place.

The other two tamper signals, `git-source` and `url-source`, are the
mirror image and must be kept out of every lockfile gate. They read a
manifest specifier and nothing else. The whole check nonetheless sat behind
a "npm or pnpm only" early return, so a specifier rewritten to
`git+https://evil/...` reported nothing in a yarn, a bun, or a
lockfile-less repository -- against what the audit-mode diagnostic says in
as many words ("only the specifier-based git-source and url-source signals
ran") and what the yarn and bun loaders promise users ("lockfile-backed
checks fall back to manifest evidence"). The format gate belongs where the
resolution comparison begins, and nowhere above it.

## Path spellings have one source

Every path in a finding, a diagnostic, or a config match is anchored to the
git repository root and spelled the way `git-source.ts` produced it. It
resolves workspace directories by identity rather than by the spelling that
reached them, so a symlinked package directory is reported once, under its
real path, on both sides of a scan.

This matters far beyond tidiness, because three separate consumers key off
that spelling and none of them can tell a different spelling from a
different file. `ignorePaths` matches against it. The baseline matches
against it through the fingerprint, which hashes the manifest path. And the
two sides of a delta are paired by it -- if the git side and the working
tree side spell one package differently, every dependency of it reads as
removed from one path and added at the other. Anything that invents a path
of its own has to justify it against those three.

A finding the lockfile walk discovered is located IN THE LOCKFILE, and is
anchored there. It used to borrow the root manifest -- a file that has
nothing to do with a transitive entry -- on the reasoning that the root
manifest always exists. That reasoning ignored the three consumers above:
`ignorePaths: ["package.json"]`, a spelling `config-invalid` deliberately
allows so a monorepo can say it only cares about its workspace packages,
silently deleted every transitive tamper, install-script and pin-mismatch
finding in the repository. Anchoring them to the lockfile makes ignoring
them an explicit, comprehensible choice instead of a side effect, at the
cost of changing those fingerprints once -- cheap now, expensive after a
release. An entry a manifest DOES declare keeps that manifest, which is
also what lets a fact reached by both walks deduplicate into one finding.

Two fabricated anchors remain, both deliberate. `checkSingle` uses a
synthetic `package.json` for a question that has no file behind it, and
therefore skips both path-based filters, so that a repository's config for
an unrelated location cannot launder "is this name safe" into "clean". And
pnpm's workspace-wide `onlyBuiltDependencies` findings are anchored to the
root manifest, because the setting really is a property of the workspace
root and can live in that very file.

## Diagnostics never change the exit code

The exit code comes from findings and the `fail_on` threshold, and from
nothing else. A diagnostic is how the engine says "I looked at this and
could not judge it" or "this coverage did not run", and it is deliberately
not a finding, because inventing a finding for a package the engine cannot
name is how a gate becomes noise people learn to skip.

The obligation this creates runs the other way: any coverage the engine
cannot provide must produce a diagnostic rather than silence, because
silence is indistinguishable from a clean result. That is why a missing
lockfile, an unparsed lockfile format, a binary lockfile, pnpm's absent
install-script flag, audit mode's unreachable tamper comparisons,
`checkSingle`'s reduced coverage, an unparseable npmrc pin, an unreadable
resolved URL, an ambiguous lock entry selection, an unmatched ignore entry
and findings dropped by a matched one all have codes. Adding a code is the cheapest possible fix for
a gap, and a gap with no code is a bug even when the code that has the gap
is correct.

Current diagnostic codes: `audit-anchor-differs`,
`audit-no-tamper-comparison`, `check-single-name-only`,
`delta-ambiguous-lock-entry`, `delta-new-lock-entries`,
`ignore-path-dropped`,
`ignore-path-unmatched`, `lockfile-binary-skipped`,
`lockfile-format-manifest-only`, `lockfile-missing`,
`manifest-alias-empty`, `npm-lockfile-invalid-entry`, `npm-lockfile-v1`,
`npmrc-pin-unparseable`, `online-check-unreachable`,
`pnpm-lockfile-invalid-entry`,
`pnpm-no-install-script-flag`, `tamper-resolution-unreadable`,
`workspace-duplicate-directory`, `workspace-glob-unsupported`.

## Failing closed, and the error codes that do it

Anything the engine cannot parse or trust stops the scan with a
`DepGuardError` carrying a code, because a security gate that passes on a
parse failure is how tampering hides. A malformed lockfile is not an empty
lockfile; a config file that is present but broken is not an absent one.

The codes, and what each one means:

- `config-invalid` -- a config file is present but unreadable, not JSON,
  not an object, carries an unknown key, or holds a value the gate cannot
  honour. Includes an `ignorePaths` entry that would match everything: a
  security gate does not get a quiet off switch, and dropping findings
  before the gate weighs them is one. "Everything" is any entry with no
  literal in it at all -- every character a wildcard or a separator, so
  `**`, `**/*` and `*/**` are all the same switch differently punctuated.
  A bare `package.json` is deliberately allowed: ignoring the root manifest
  names one file, and is how a monorepo says it only cares about its
  workspace packages.
- `baseline-invalid` -- the baseline file is present but not the shape a
  baseline has. Accepting a broken baseline would accept everything in it.
- `manifest-parse` -- a manifest is present and unparseable.
- `lockfile-parse` -- a lockfile is present and unparseable, including a
  lockfile that declares a format version whose required structure is
  missing. This case is a throw and not a diagnostic on purpose: falling
  back would leave the entries map empty and every lockfile-backed check
  silently satisfied.
- `corpus-missing`, `corpus-unreadable`, `corpus-corrupt` -- the shipped
  corpus is absent, damaged, or -- for `corpus-corrupt` specifically --
  valid but written in a shape this build refuses to trust: a
  `formatVersion` this build does not understand, or a
  `walkComplete: false` (or anything other than the literal boolean
  `true`) from a walk that was stopped early or never finished. Neither of
  those is damage -- the file parses and the fields are the right types --
  but this build cannot tell what it does not know, or must not serve a
  partial result as if it were a complete one, so both are refused the
  same way a corrupt file would be. A corpus that reads as empty would
  bless every hallucinated name. See "The corpus format is versioned" and
  "A partial corpus refuses itself" below for the two checks this covers.
- `path-missing` -- the path to scan does not exist, or is not a directory.
  A path nobody looked at must not report a clean result.
- `read-error` -- a path exists but cannot be read.
- `git-error` -- git could not resolve what a delta mode needs, including a
  base ref that is not a usable ref.
- `name-invalid` -- `checkSingle` was asked about an empty name, which has
  no meaningful answer and must not be answered "safe".
- `severity-invalid` -- a finding or threshold carried a severity outside
  the known order. Unreachable today; it exists so that the day it becomes
  reachable, the scan stops instead of scoring the finding below every
  threshold and passing it.

Online checks are the one deliberate exception to failing closed: a network
problem degrades to the offline result with a diagnostic, and never blocks.

## Online checks degrade, and degrading has a precise meaning

The rule above is a sentence; this is what it obligates, now that it governs
a whole subsystem rather than one code path.

Degrading means the affected check contributes nothing it could not
establish offline, and nothing it did establish is taken away. The
typosquat popularity-asymmetry check either escalates a low-severity
resemblance match to high, when the network confirmed the candidate is
genuinely unpopular, or leaves it at the severity typosquatCheck already
gave it offline; a network failure means it leaves every candidate exactly
as it found them. The registered-squat check either adds a medium finding
for a recently-published, near-zero-download name, or adds nothing; a
network failure means it adds nothing, the same outcome as a scan that
turned up no candidates for it at all.

"Near-zero-download" includes a name the downloads API has no record for
at all, and that case is not an edge case for registered-squat: a
freshly-registered attacker name is exactly the name npm has no download
history for yet, so treating an absent count as "skip" made the check
structurally unable to fire on its own defining example. For
typosquat-asymmetry, the same absent-count case is a stronger version of
the low-download signal it already escalates on -- it is not specific to
a freshly-registered name the way registered-squat's purpose is; it
applies to any resemblance match the offline pass could not price.
`registry-client.ts`'s `fetchWeeklyDownloads` answers this with three
states, not two, and both checks read the distinction rather than
collapsing it: a name npm reports a real count for; a name npm's
response confirms it has no record for -- either a null entry in a
successful bulk response, or (a scoped name always, or an unscoped name
whenever it is alone in its 128-name batch of unscoped names) a
single-name 404 that a sentinel probe confirmed was genuine rather than
a symptom of a broken downloads API, by asking the same downloads
endpoint about a name certain to exist and certain to have downloads
(`react`, verified against the corpus's own popularity list) before
trusting the original 404 -- both checks treat this, and only this, as a
confirmed zero; and a name that is unresolved, which in practice a
single-name 404 no longer produces (it resolves via the sentinel probe,
or the whole fetch call throws and is diagnosed instead), so reaching
this state now means the fetch returned a malformed or unrecognized
response shape -- both checks
leave this one exactly as they would have before the distinction
existed, at the candidate's offline severity, never promoted to a
signal. Deliberately probing the downloads API rather than the registry
(fetchPackument) to confirm a single-name 404: those are two different
services with independent failure modes, and a downloads API that 404s
on everything while the registry is perfectly healthy would make every
existing scoped package read as a confirmed zero if the registry were
asked instead -- the same fabricated-block failure this whole
distinction exists to prevent, just moved to a different service.
Collapsing "confirmed no record" and "unresolved" into one absent-key
case, the way both checks did before this distinction was added, would
have let a broken downloadsApi silently mint a finding for every
single-name lookup instead of surfacing as online-check-unreachable --
the same failure mode a real network outage is supposed to produce, not
a wave of new findings.

Neither check downgrades a finding, removes one, or turns a network
problem into a reason to trust a name more than the offline checks
already do. Whatever a check could not establish is named, not implied:
a diagnostic with code `online-check-unreachable` says which check was
asking, how many findings or candidates were affected, and why the
request failed, so a consumer can tell three things apart, not two --
"the network was down" (a diagnostic fired), "the API answered and
confirmed nothing was on record" (now a signal, per above), and "the API
answered but this one name's status is unresolved" (silence, the same as
if the name had never been asked about) -- instead of reading any
silence as interchangeable with any other.

`enrichOnline` -- the function `scan()` and `checkSingle()` both call to run
the online checks -- must never itself throw. Each check it calls
(`applyTyposquatAsymmetry`, `findRegisteredSquats`) owns its own
try/catch around every network call it makes and turns a failure into a
diagnostic before returning, precisely so that `enrichOnline` never has
to. A network problem is routine, not exceptional, for this subsystem; if
it ever reached `scan()` as a thrown error, `--online` would turn a
pre-commit hook into something a flaky connection can block, which is the
one failure mode this whole feature exists to avoid.

The online cache (`online/cache.ts`) is deliberately not a trust input, and
that is a different property from failing closed rather than a relaxation
of it. `config.ts` and `baseline.ts` fail closed on a broken file because
trusting a corrupt one would accept whatever it happened to contain. A
stale or fabricated download count can swing a check in either direction
-- a forged high count can suppress an escalation the online checks would
otherwise have added, and (since the zero-download-blindness fix) a
forged low count, or a machine-global cache entry poisoned to a literal
0, can cause a check to fire, or escalate, for a package that is
genuinely fine; the cached 0 this fix writes for a confirmed no-record
answer persists for the same 24 hours as any other cached count and is
exactly as forgeable. What the online cache can never do, either
direction, is remove or downgrade a finding the six OFFLINE checks
already established: `applyTyposquatAsymmetry` only ever escalates a
low to high or leaves it alone, `findRegisteredSquats` only ever adds a
new finding or adds nothing, and neither touches an existing offline
finding's severity or presence. So a corrupt or forged online cache can
cost an extra fetch, a missed online-only escalation, or a spurious
online-only finding -- never a name that the offline checks flagged
reading as clean. It is loaded permissively on purpose: a cache file
that fails to parse is discarded and rebuilt from an empty state, not a
`DepGuardError`.

## The popularity list is a trust input, and it is sized for its own rule

`scripts/data/top-packages.txt` is the list typosquat reads, and it is the
only corpus artifact that grants something rather than describing it. A
name in it is permanently exempt from being reported as a squat of
anything, so getting a name onto it buys immunity from the rule. Four
constraints follow, and none of them are conveniences.

- **Every name is verified twice, independently, before it is listed.** It
  has to exist in a walk of the registry this project performed itself, and
  npm's downloads API has to report it above the usage floor, measured at
  the time the list is built rather than claimed by whatever proposed it.
  Nothing is listed because a ranking said it was popular.
- **The floor is ten thousand downloads in the last week.** It is orders of
  magnitude above what a package with no adopters receives and cannot be
  reached by publishing alone, so clearing it means real installs. It is a
  bar and not a proof: counts can be bought, which is why the other three
  constraints exist.
- **No third-party fetch at build time.** The list is checked in, reviewed
  and diffed like source. A public ranking may nominate candidates, but it
  is vendored into the repository with its version and integrity recorded
  in the file header, read with a scanner rather than executed, and never
  pulled from someone's server while a corpus is being built. A
  supply-chain tool that fetches its own trust data from an unvetted source
  on every build is arguing against itself.
- **The list is sized for the rule that reads it.** Ten thousand names
  minimum. A short list does not fail loudly; it produces confident false
  positives, because a popular package that is absent is not exempt and so
  gets reported as a squat of whichever popular neighbour it resembles.
  This is not hypothetical: a five-hundred-name list reported micromatch as
  a squat of picomatch, npm-run-all2 of npm-run-all, and `@types/jsesc` of
  `@types/jest`.

Scoped names are the case that goes wrong quietly. npm's bulk downloads
endpoint refuses them, so they cost one request each where an unscoped name
costs a hundred and twenty eighth of one, and a list assembled without
noticing that ends up with no scoped names in it and no sign that anything
is missing. They are measured one at a time instead. The residual gap, that
a scoped package can only be listed if something nominated it, is written
into the candidates file header rather than left to be discovered.

The alias list is checked before this exemption, and `assertAliasKeysNotPopular`
is what keeps the two from contradicting each other. That guard now runs
against twenty thousand names rather than five hundred, so it is enforced in
the test suite as well as in the corpus build.

## The corpus format is versioned, and absence of the version is not the same as a wrong one

meta.json carries an optional `formatVersion` field, emitted as `1` by
`buildMeta` (scripts/lib/corpus-guards.mjs) from the first published corpus
onward and never before -- a format version cannot be assigned
retroactively once corpora exist in the wild, so nothing shipped before
this field existed can be given one after the fact. `assertMetaShape` in
packages/core/src/corpus.ts refuses to load a corpus whose `formatVersion`
is present and not one of `SUPPORTED_CORPUS_FORMAT_VERSIONS` (today, only
`1`), throwing `corpus-corrupt`: the corpus is not damaged, but its
declared format is not one this build knows how to read, and that is
exactly what `corpus-corrupt` covers (see "Failing closed" above).
docs/release/stability-policy.md promises a release reads its bundled
format and at least the immediately previous format version, so the day a
version 2 exists, `SUPPORTED_CORPUS_FORMAT_VERSIONS` has to grow to admit
both, not just move the comparison -- that promise is why the constant is
a list and not a single literal. The refusal message names the supported
versions by reading this same list (`.join(', ')`), rather than restating
them as a literal in the message text, so the two cannot drift apart the
day a second version is added.

`formatVersion` is ABSENT-tolerant on purpose: a corpus missing the field
entirely is accepted, not refused. That is the same "refuse only what is
explicitly wrong, tolerate absence" rule `walkComplete` follows (next
section) and for the same reason -- nothing has ever shipped, so a
meta.json written by a builder that predates this field (the committed
fixture corpus, and any corpus already built with a pre-versioning
dep-guard) is a legitimate local artifact missing the field, not a corpus
in the wild claiming an unsupported version. That is narrower than "every
meta.json anywhere": the current builder writes the field on every corpus
it produces now, and this suite's own tests build metas that carry it too
-- the tolerance is for what a pre-versioning builder could have already
produced, not a claim that nothing ever carries the field.

The reader's tolerance-of-absence is now safe to rely on, and the gate that
makes it safe is described in the next section. Before that gate existed, a
hand-built or otherwise malformed corpus with genuinely missing fields
would have loaded exactly as if it were a legitimate pre-versioning
artifact; the gate is what makes that scenario unreachable for anything
this project actually publishes.

## A published corpus is built in the release job, never committed, and a release gate demands what the reader tolerates

`packages/core/data/corpus` (the path `DEFAULT_CORPUS_DIR` in scan.ts
resolves to when nothing overrides it) is gitignored on purpose: a built
corpus is about ten megabytes of generated data whose provenance is a dated
registry walk, and it belongs to a release, not a commit. Nothing is ever
checked in there.
Instead, `.github/workflows/release.yml`'s `release` job runs `node
scripts/build-corpus.mjs --out packages/core/data/corpus` as one of its own
steps, so every release builds its own corpus fresh from
`replicate.npmjs.com` and ships it inside the published tarball --
`packages/core/package.json`'s `files` array lists `data` alongside `dist`
for exactly this reason, and `scripts/tests/core-package-files.test.mjs`
guards against that entry ever being dropped again, since nothing else in
the suite would catch its removal.

That step has to run after `pnpm test`, never before, in the same job.
`packages/cli/tests/cli.test.ts`'s "a first run with no corpus built yet"
case asserts that a scan with no `--corpus-dir` and nothing at the default
corpus path fails with an actionable `corpus-missing` message -- the whole
test depends on that default path being empty when it runs. Building the
corpus first, at that same default path, would make the test's premise
false in CI the same way a local `corpus:build --out
packages/core/data/corpus` makes it false on a developer's machine. The
test now diagnoses that precondition itself (an explicit failure naming the
path, rather than the opaque `Expected: 2, Received: 0` it used to produce)
and release.yml's corpus-build step carries a comment pointing at this same
constraint, so reordering the steps for tidiness has to go through that
explanation first.

A corpus that is about to be published cannot lean on the same
pre-versioning-artifact excuse `assertMetaShape` extends to `formatVersion`
and `walkComplete` above -- nothing has shipped before this gate existed,
so there is no legitimate "written by an older builder" case for a corpus
this build is about to publish. `scripts/lib/shippable-corpus.mjs`
(`assertCorpusShippable`, run by `scripts/check-shippable-corpus.mjs` and
wired into release.yml right after the corpus-build step) is the release
gate that closes that gap: it refuses to publish unless all four corpus
files exist, `meta.formatVersion` is PRESENT and is one of
`SUPPORTED_CORPUS_FORMAT_VERSIONS` (imported from the built core, not
restated -- see "derive, do not describe" at the top of this file),
`meta.walkComplete` is PRESENT and is exactly the boolean `true`,
`meta.nameCount` clears a floor high enough that a `--max-names` slice
could never pass it by accident (`DEFAULT_MIN_NAME_COUNT`, one million,
against a real walk's several million names), and the directory loads
through the real `loadCorpus` with a known-popular name (`react`)
resolving as present in the bloom filter. That last check makes the gate
additive to the reader's own checks rather than a replacement for them: a
corpus this gate accepts still has to load the way a real scan would load
it. `scripts/tests/shippable-corpus.test.mjs` exercises both directions of
every rule, including the two cases the reader tolerates and this gate does
not (formatVersion absent, walkComplete absent) -- verified adversarially
by weakening the gate to match the reader's tolerance and confirming those
specific tests, and no others, go red -- and also covers `readMeta`'s two
failure branches directly: meta.json present but unreadable as a file, and
present and readable but not valid JSON.

The release smoke job (`smoke-published`) passes no `--corpus-dir` to any
of its four `dep-guard check` invocations, on purpose: the point of that
job is to prove the corpus that actually shipped inside the published
package resolves correctly at its default path, not to re-prove something
about the repository's own fixture corpus (which the job no longer checks
out at all). It asserts `react` resolves as known and that ALL THREE
distinct hallucinated names resolve as `unknown-package` findings --
three names, and requiring every one of them, because the corpus is
rebuilt on every release now, so a single name's non-collision against the
bloom filter's 0.0001 false-positive rate is a fresh draw each time
instead of a fact fixed against a committed fixture. Requiring all three
is the stronger check: a bloom filter that wrongly answered "present" for
roughly half of all inputs -- a plausible shape for a deserialization
regression -- would still pass a weaker "at least one" check 87.5% of the
time (it only fails when all three collide, which is down near 1e-12 at
the real rate), where requiring all three fails in that same scenario
87.5% of the time. What that costs is a higher spurious-failure rate
against a genuinely healthy corpus, roughly 3e-4 per release, from the
union of three independent ~0.0001 chances that any one collides -- well
within tolerance for a gate that runs once per release.

## A partial corpus refuses itself, and the builder has to verify around that refusal

`buildMeta` writes `walkComplete: false` when a build is stopped early
(`--max-names`, which `pnpm corpus:slice` uses) -- see
scripts/build-corpus.mjs. `assertMetaShape` refuses to load any corpus
whose `walkComplete` is present and not exactly the boolean `true`,
fail-closed on any other value (a stray string, number, or `null`, not
only an explicit `false`), throwing `corpus-corrupt`: a partial corpus
reports every name the walk never reached as unknown, which is dangerous
in production and useful only for testing the build pipeline itself, so
it must never serve a real scan. `buildMeta` itself now requires
`walkComplete` to be a real boolean before it will write one, for the same
reason -- the value entering a load-bearing field has to already be the
type the reader trusts, not something that merely compares loosely equal
to it.

That refusal is deliberately in the reader every scan goes through, which
means the builder's own post-write verification cannot route a partial
build through that same path -- `loadCorpus` would refuse the exact
artifact the builder just wrote on purpose, on every `--max-names` run,
including `corpus:slice`, and the artifacts would already be on disk with
the build's own resume hint unreachable. (This was exactly the shape of
the bug this section exists to prevent a repeat of: the first version of
these checks routed every build's own verification through the newly
strict loader with no exception, so `corpus:slice` broke itself the day
the loader got stricter.) The builder verifies a partial build's artifacts
directly instead (bloom membership and top-rank order, read straight off
the files just written), and only routes a complete build through
`loadCorpus` itself, which is the stronger check -- it proves the artifact
is what the scanner will actually accept, not just that the raw files are
well-formed. See `verifyBuiltCorpus` in scripts/lib/corpus-guards.mjs, and
its tests in scripts/tests/corpus-guards.test.mjs, which exercise both
branches against real on-disk artifacts and assert that `loadCorpus`
genuinely does refuse the partial one `verifyBuiltCorpus` accepts -- proof
the two paths are different, not just that neither happens to throw.
