---
'@vaultcompass/dep-guard': minor
'@vaultcompass/dep-guard-core': minor
---

Resolve unknown-package against the live registry, install a pre-commit
hook, and emit SARIF.

The unknown-package rule is the one that blocks, and it was the one
decaying fastest. It answers from a bloom filter built by a single dated
walk of the registry, so every package published after that walk reads as
unknown to that release for as long as the release exists. The only remedy
a user had was an `allow` entry per package, which is a permanent
rule-wide exemption bought to clear a finding that was wrong about one
narrow fact.

`--online` now asks the registry. A name that exists stands the finding
down, because the finding claimed the name was not on the registry and the
registry says otherwise. That is not a clean bill of health and does not
touch anything else: typosquat and registered-squat still judge whether
the name is suspicious, which is the question that actually matters. A 404
escalates to critical instead, since the innocent explanation the offline
message offers has just been ruled out. A timeout, a server error, or a
spent budget leaves the finding exactly as the offline scan made it. A
network failure never means fewer findings.

Alongside it, the three online debts that had been carried since the
online checks landed. There is now one wall-clock budget for a whole run
rather than only a timeout per request, so a repository adding twenty new
names cannot stall a commit for half a minute with every individual
request comfortably inside its own limit. `--no-online` forces the checks
off for one run, overriding `"online": true` in a committed config, which
is what a pre-commit hook or an air-gapped build wants. And
registered-squat now honours `internalScopes` and `internalPrefixes`, the
way the offline existence check always has: an internal package is absent
from the public registry by design, so npm's answer about one always
looked exactly like a fresh squat, and a private package name should not
have been going to a public service in the first place.

`dep-guard init` installs the pre-commit hook, for plain `.git/hooks`,
husky, lefthook, or the pre-commit framework. It is idempotent, has a
`--dry-run`, and never overwrites a hook it did not write. The generated
hook fails closed when the binary is missing, rather than warning and
letting the commit through, and it passes dep-guard's own exit code
through unchanged so exit 2 stays distinguishable from exit 1. Both of
those are tested by running the hook against a stub binary, because
neither is visible in the text of the script.

`--format sarif` writes SARIF 2.1.0, and `action.yml` is a composite
GitHub Action that runs a scan and uploads it to code scanning. The SARIF
reuses each finding's existing fingerprint as its `partialFingerprints`
entry, so a GitHub alert and a dep-guard baseline track the same finding
instead of drifting apart, and it carries dep-guard's own blocking
decision in `properties.blocking`, because four SARIF levels cannot
express a four-severity scale plus a configurable threshold.

Offline behaviour is unchanged. The dogfood harness produces output
identical to the recorded baseline across all nine public repositories.
