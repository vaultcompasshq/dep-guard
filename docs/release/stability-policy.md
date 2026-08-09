# Stability policy

This document says what a version number of dep-guard promises, what has
to be true before a 1.0.0 exists, and how the one genuinely hard break --
a fingerprint change after 1.0.0 -- would be handled if it ever became
necessary. It describes intent. Nothing has been published to npm, there
are no released versions, and there are no users yet; every promise below
is a promise about how releases will behave once they exist, written down
now because the cheapest time to decide a compatibility rule is before
anyone depends on the thing it governs.

The reason this file exists at all is that most of dep-guard's surface
becomes a compatibility contract the moment anyone relies on it, and most
of those contracts are not obvious from the outside. A finding's
fingerprint keys every baseline anyone will ever record; change how one is
computed and every baseline silently stops matching -- findings people
already accepted come back, or worse, a renamed input suppresses something
new. Rule ids and diagnostic codes get keyed on by whatever consumes the
JSON output. The exit codes are what CI actually reads. The config keys
`allow` and `ignorePaths` can each weaken the gate, so their semantics
quietly broadening is a security regression, not a feature. And the corpus
ships inside the package, so its format is part of the package's own
interface as well as the interface for anyone building a corpus of their
own. `docs/INVARIANTS.md` records the internal rules that keep these
consistent; this file records the external promises made about them.

## What holds even at 0.x

Some things are contracts already, before any release, because the tool is
not coherent without them. These do not break between 0.x versions:

The exit codes. 0 is clean, 1 is findings at or above the threshold, 2 is
an error, and a gate that cannot read its own inputs fails closed rather
than reporting clean. Diagnostics never touch the exit code. These are the
semantics of being a gate at all; a version that changed them would be a
different tool.

The fingerprint's shape. A fingerprint is a sha256 over exactly four
components -- rule id, canonical package name, manifest path,
`details.signal` -- and nothing else may enter it. The shape is fixed now;
what is not yet fixed in 0.x is the spelling of the inputs (see below).

The direction of surprise. When the engine cannot judge something, it says
so -- a diagnostic, or a failure, never silence that reads as clean. That
posture predates versioning and survives every version.

## What 0.x means

Everything else may change between 0.x minor versions, and some of it
will, because 0.x is precisely the period in which these surfaces earn the
right to be frozen. Concretely, any of the following may break between
0.x minors, each break named in the release notes: the JSON output shape;
rule ids, signal strings, and diagnostic codes; config keys and their
semantics; CLI flags; the corpus data format; and the spelling of
fingerprint inputs. A fingerprint-input change in 0.x means recorded
baselines must be regenerated, and the release notes will say so in those
words. This has already happened once before any release -- lockfile-walk
findings moved their path anchor from the root manifest to the lockfile --
and it was cheap precisely because nobody was depending on the old
spelling. That cheapness is what 0.x is for.

A 0.x patch release changes none of the above; it fixes a wrong verdict, a
wrong exit code, a crash, or a security defect in dep-guard itself.

If you adopt dep-guard during 0.x, the honest framing is: the verdicts are
worth having and the exit codes are safe to wire into CI, but treat your
baseline file and any JSON parsing as tied to the minor version you
installed, and read the release notes before moving.

## The bar for 1.0.0

1.0.0 is not a feature milestone. It is the statement that the contracts
above are now expensive to break and will be treated that way. Four things
have to be true first, and two things that might look required are not.

**The typosquat false-positive rate has to be measured against a real
corpus, and the number has to be one we would accept in our own repos.**
Today it is genuinely unmeasured. Against the fifty-name development
fixture, 44 of 56 plausible real package names fired -- a number that
condemns nothing, because in a corpus that small everything is an edit or
two from everything else, but proves nothing either. The requirement is:
build the real top-10k popularity corpus, replay a large sample of
genuine dependency additions drawn from real repositories against it, and
publish the measured rate in the README. The working ceiling is one false
block per hundred legitimate new-name additions at the default threshold,
and the target is well under that, because a gate that fires falsely more
often than that trains people to override it, and an overridden security
gate is worse than no gate -- it converts real findings into the noise
people have learned to click through. If the measured rate cannot be
brought under the ceiling by tuning the transform rules and the distance
thresholds, that is a design problem to solve in 0.x, not a number to
round down at release time.

**The corpus needs a named owner, a stated cadence, and a staleness
signal, because the corpus decays and the package ships it.** A corpus is
a snapshot of the registry, and every week after it is built, more
legitimate new packages read as unknown. Without a refresh discipline the
tool gets quietly worse by default -- not a bug anyone files, just a
rising false-positive rate that arrives as "dep-guard is noisy" months
later. So before 1.0.0: one named person owns the refresh, the cadence is
written in the README, refreshed corpora ride the ordinary minor releases,
and a scan against a corpus meaningfully older than the promised cadence
says so in a diagnostic rather than leaving the user to notice the decay
themselves. The corpus already records its build date; the requirement is
that the scan reads it and speaks up.

**The fingerprint contract needs soak time, because its stability can only
be demonstrated, not tested.** The whole point of a fingerprint is that it
survives version bumps and corpus refreshes; a test suite can assert the
four components but cannot assert that months of routine traffic never
find a fifth thing that should have been excluded. So: at least one full
0.x cycle published on npm, running in real repositories -- ours, and any
early adopters -- through at least two corpus refreshes and ordinary
dependency churn, with no baseline invalidated by anything except a
deliberate, release-noted input change. There is no user-count threshold
here on purpose. Inventing one would be theater; the evidence that matters
is fingerprints surviving the two forces they are designed to survive, in
repositories that were not constructed to exercise them.

**The package has to have actually shipped.** Obvious, but worth writing:
0.x releases on npm, the corpus bundled, `--corpus-dir` no longer
required. A 1.0.0 whose 0.x line never met the public is a 0.1.0 with a
confident name.

Two things are deliberately not required. The GitHub Action and the MCP
server do not have to exist before 1.0.0, because they are consumers of
the CLI's contracts, not parts of them -- holding the contracts hostage to
their own downstream tooling inverts the dependency, and the JSON output
and exit codes are exactly what those integrations will be built on. They
can arrive in minors. The pre-commit gate is not a separate deliverable at
all: it is the CLI run with `--staged`, which exists the moment the CLI
does; packaged hook configuration is a convenience that can ship any time.
And full lockfile coverage for yarn and bun is not required either --
coverage there is honest per format and announced per scan, and an honest
partial answer is a stable contract in a way a rushed full one is not.

## What freezes at 1.0.0, and what stays free

Frozen, meaning a change is a major version:

- The fingerprint: algorithm, the four components, and the spelling of
  every existing rule id and signal string, because all of them are hash
  inputs. Renaming or splitting a rule id invalidates every baseline that
  mentions it; INVARIANTS already says that waits for a major, and this
  file makes it policy.
- Exit codes and their meanings.
- The JSON output shape, additively: existing fields keep their names,
  types, and meanings; removing, renaming, or retyping one is a major. New
  fields may appear in any minor, which is the consumer's half of the
  contract -- parse what you know, tolerate what you don't.
- Config keys: existing keys keep their semantics, and `allow` and
  `ignorePaths` in particular never quietly broaden what they silence.
  New keys may be added in minors. A config written for a newer version
  fails loudly on an older one, because unknown keys are `config-invalid`
  by design -- that is fail-closed working as intended, not a break.
- Diagnostic codes: an existing code keeps its meaning forever and is
  never reused for something else. New codes may appear in any minor. A
  code may be retired when the gap it named is closed, and retirement is a
  minor, because nothing should ever gate on a diagnostic.
- The corpus format, versioned: a release reads the format of the corpus
  it bundles and at least the immediately previous format version, so an
  externally built corpus survives one format transition; dropping the
  ability to read a format is a major.

Free to move in minors, deliberately:

Verdicts. A minor may flag something the previous minor passed -- a new
rule, a new signal, a refreshed corpus, a tuned transform, a severity
corrected upward. That can turn a green CI red, and it is not a break; it
is the product. A security gate whose findings were frozen would be
frozen at its current blind spots. The mechanism is the contract --
fingerprints, codes, shapes -- never the verdict. New findings arrive
under new fingerprints, so they are visible and triageable rather than
silently absorbed; if you need verdict stability for a release window,
pin the version. Severity moves in either direction are minors, called
out in release notes, since severity is excluded from the fingerprint on
purpose and baselines survive them. Messages, diagnostic wording,
performance, and everything in `details` that is not the signal also move
freely.

## Cadence, and what a patch is

While development is active: a minor every few weeks, each carrying the
refreshed corpus, so the corpus cadence and the release cadence are the
same promise and neither can silently lapse without the other.

Patches are for security defects in dep-guard itself and for correctness
regressions -- a verdict the previous release got right and this one gets
wrong, in either direction, a wrong exit code, a crash, or a corpus entry
error that is falsely blocking a legitimate package. Never features, never
new rules or signals or flags, never a routine corpus refresh. The reason
to hold that line is that it makes patches safe to auto-adopt: a consumer
who takes every patch should never need to re-read the release notes, and
the moment a feature rides a patch, that stops being true.

## Breaking the fingerprint after 1.0.0

This is the hardest case, so it gets thought through here rather than
discovered under pressure. Suppose a signal turns out to need a
value-bearing subject it does not have -- the exact shape of the
`host-changed` lesson INVARIANTS records, arriving again after 1.0.0 --
so the fingerprint inputs must change and every stored baseline hash
stops matching.

First, the failure direction, because it decides how bad this is. A
stored fingerprint is a hash; when the inputs change, old entries match
nothing, so every previously accepted finding comes back. Nothing new
gets suppressed -- a stale sha256 colliding with a new one is not a
realistic event. So an unmanaged fingerprint change fails noisy, not
silent, which is the survivable direction. The real cost is that a wall
of re-raised accepted findings is exactly the place a genuinely new
finding goes unread. Noisy failure is survivable; it is not acceptable.

The managed path is a major version that ships both algorithms. Old
fingerprints cannot be rewritten in place -- a hash is one-way, so there
is no mapping from a stored value to its successor. But the inputs can be
re-derived: during a scan, the new major computes each current finding's
fingerprint under the old derivation as well as the new one, and any
baseline entry the old derivation matches is rewritten to the new hash on
contact. The baseline file gains a version marker so a file says which
derivation wrote it. Every accepted finding that still occurs migrates
itself the first time a scan sees it, with no re-triage. Entries the old
derivation no longer matches -- the finding is not currently firing --
stay in the file under the old hash for the whole major, so a finding
that recurs later still migrates when it does. The old derivation is
carried for one full major cycle and dropped at the next one, at which
point any still-unmigrated entry is dead weight and is reported as such
rather than silently kept.

The honest residue: an accepted finding that never fires during the
entire migration window loses its acceptance and reappears as new when it
finally recurs. That is re-triage noise for a small set, in the direction
that surfaces things rather than hides them, and it is the floor -- no
scheme that stores hashes can do better without storing the inputs, and
storing the inputs would put package names and paths into a file the
fingerprint design deliberately keeps them out of.

One case has no good answer, and it is better named than waved at: a
change where the old derivation can no longer be computed at scan time
because the fact it hashed is no longer collected at all. Then there is
nothing to match against, migration is impossible, and the truthful
release note is that baselines must be regenerated and their findings
re-triaged. The policy for that case is simply to treat it as the cost it
is -- weigh it against living with the old fingerprint, and expect the
old fingerprint to win almost every time. The four-component design was
chosen so that this day should never come; this section exists so that if
it does, the handling is a decision already made instead of an
improvisation.
