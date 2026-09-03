---
'@vaultcompass/dep-guard': patch
---

Fixed `dep-guard init` writing the pre-commit hook somewhere husky throws
away.

Husky 9 points `core.hooksPath` at `.husky/_`, a directory husky's own
install step generates and gitignores, rewriting it from scratch on every
`pnpm install`. The file git actually keeps running long-term is the
tracked `.husky/<hookname>`, which a two-line dispatcher in `.husky/_`
sources into. A bare `dep-guard init` was resolving `core.hooksPath`
literally and writing straight into `.husky/_/pre-commit`: it reported
success, the hook worked until the next install, and then it was gone
without a trace, because nothing about husky's next install step touches
a file it does not itself generate.

`dep-guard init` now recognizes a husky-generated hooks directory --
either from the `.husky/_` shape of `core.hooksPath` itself, from the
generated `h` shim it contains, or from the two-line dispatcher husky
writes as `pre-commit` there -- and installs into the tracked
`.husky/pre-commit` file instead, printing that it did so. This applies
to the default native manager; `--manager husky` was already correct and
is unaffected. The same detection also fixes a second, quieter bug:
`init`'s idempotence and foreign-hook checks were reading the generated
dispatcher rather than the tracked file, so a bare `init` run against an
already-husky-managed repository could refuse with "already exists and
was not written by dep-guard" while pointing at a file that was never the
one holding dep-guard's hook in the first place. Nothing is ever written
under `.husky/_` in any mode, including `--dry-run`.
