# Security policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.6.x   | :white_check_mark: |
| < 0.6   | :x:                |

dep-guard is pre-1.0. The latest published minor is supported; earlier
minors are not patched.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security reports.**

Send details to **security@vaultcompass.io** (or the contact listed on
[vaultcompass.io](https://vaultcompass.io) if that address changes). Include:

- A description of the issue and its impact
- Steps to reproduce (proof-of-concept if possible)
- Affected versions / components (`@vaultcompass/dep-guard` CLI,
  `@vaultcompass/dep-guard-core`, the composite GitHub Action, the
  pre-commit hook)

We aim to acknowledge receipt within **5 business days** and coordinate a
fix and disclosure timeline with you.

## Scope

In scope: a dependency change that should block and does not (a typosquat,
a tampered lockfile entry, a newly acquired install script, or a
hallucinated package name that passes); any way a pull request can change
the rules or baseline it is judged by on a pull-request run; shell or
argument injection through the Action's inputs; supply-chain issues in the
published packages.

Out of scope: a single false positive on a legitimate package (report it as
a normal issue unless it causes a security boundary failure); registry
outages; third-party dependencies (report to the upstream maintainer; we
still welcome coordinated notification).

## npm provenance

Published `@vaultcompass/*` packages are built from this repository's tagged
releases through the OIDC trusted-publisher path, with npm provenance
attestations, and never from a developer machine.
