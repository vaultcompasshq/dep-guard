# Configuration

`.dep-guard.json` at the repo root, overlaid by an optional
`.dep-guard.local.json`:

```json
{
  "failOn": "medium",
  "online": false,
  "allow": ["some-package", "@acme/*", "pypi:some-python-project"],
  "internalScopes": ["@acme"],
  "internalPrefixes": ["acme-", "pypi:acme-"],
  "extraAliases": { "unused-imports": ["eslint-plugin-unused-imports"] },
  "ignorePaths": ["fixtures"],
  "minAgeDays": 7,
  "minAgeAllow": ["some-package@1.2.3"],
  "onlineBudgetMs": 20000,
  "onlineUnchecked": "fail",
  "acknowledgedLockfiles": ["yarn.lock:3b18e512dba79e4c8300dd08aeb37f8e728b8dad"]
}
```

Two things worth knowing before you use them. `allow` means "ignore this
package everywhere" -- it silences every rule except lockfile tampering,
which is a fact about where bytes come from rather than about the package.
And `ignorePaths` drops findings before the gate sees them, so a pattern
broad enough to match everything would switch the tool off; patterns made
only of wildcards are rejected for that reason.

`ignorePaths` drops findings only for paths nothing installs, or that the
base branch already installs the same way. A change that wires an ignored
path into the install -- a `file:`, `link:` or `portal:` dependency on it,
a `workspaces` glob widened over it, a lockfile added beside it, a
requirements file that includes it with `-r` or `-c` -- keeps its findings
there, says so in an `ignore-path-project-kept` note, and under
`--trust-base` is reported as a proposal, since the entry no longer covers
an installed path. The comparison is the base's own: the trust base on a
`--trust-base` run, otherwise the `--base` ref, or `HEAD` for `--staged`;
an audit has none and drops as before. `lockfile-tamper` is never dropped
on a path the base installs, including an entry that names a lockfile
itself. The residual: a directory the base branch already installs under
an ignored path keeps every other finding dropped, so any pull request can
add a malicious dependency there and pass, with only the
`ignore-path-dropped` note saying how many dropped findings were on
installed projects. Which manifests count as projects is the list under
[Lockfile support](lockfile-support.md). Known open: `overrides` and `resolutions`
`file:` targets, and Python path sources (`[tool.uv.sources]` path
entries, poetry path dependencies, pip local paths and `-e`), are not
project reasons, so a change that wires one in is not kept by this rule.

`onlineUnchecked` decides what a `--base` or `--trust-base` run does with
a candidate name no online step could check: `"fail"`, the default, exits
2 listing the names; `"note"` keeps a diagnostic. It has no command-line
flag, because an opt-out is a control, and under `--trust-base` it is read
from the trust base like every other key.

Python names take a `pypi:` prefix in `allow` and in `internalPrefixes`:
`"pypi:reqeusts"` clears a Python finding for that project and
`"pypi:acme-"` keeps every Python name starting `acme-` off the wire, both
compared in PEP 503 normalised form (`pypi:Acme_` and `pypi:acme-` are the
same prefix). A bare entry stays npm-only: existing lists were written and
reviewed about npm names, and extending what a reviewed entry means to a
second ecosystem would be a change nobody reviewed.

`minAgeDays` and `minAgeAllow` configure the minimum-publish-age online
check (see [Online checks](online-checks.md)); they have no
effect without `--online` or `"online": true`. `minAgeDays` defaults to 7
and accepts `0` (only future-dated publishes are refused). `minAgeAllow`
takes exact `name@version` strings, never a bare name -- allowing a bare
name would silence every future version of it too, the same much-bigger
door `allow` is for, not a one-release exception.

`onlineBudgetMs` sets the per-run online wall-clock budget (see
[Online checks](online-checks.md)); it too has no effect without `--online` or `"online":
true`. Unset, the budget defaults to 20000 for a plain run or 300000 for a
`--base`/`--trust-base` run -- setting this key picks one number for every
invocation regardless of shape, the same way `--online-budget-ms` picks one
for a single run.

`acknowledgedLockfiles` lets one reviewed lockfile change through the
lockfile downgrade rule (see [Lockfile support](lockfile-support.md)). Each entry is
`LOCKFILE:BLOBID`: a root lockfile name and the full lowercase git blob id
of the exact bytes being acknowledged, so an entry never covers any other
version of the file. The refusal message prints the entries to add. They
are read only from the comparison side (the trust base, else the `--base`
ref, else HEAD for `--staged`), so they land on the base branch first, in
their own reviewed pull request. An acknowledgement affects that rule only:
every finding and every check still applies, and a run that uses one says
so in the `lockfile-downgrade-acknowledged` diagnostic. On a staged scan
(the pre-commit hook) the entries are read from HEAD, so they are committed
first, in a commit of their own. A lockfile path that is a symlink has no
identity to acknowledge. dep-guard 0.10.0 and earlier refuse a config that
contains this key, so it needs 0.10.1 or later.

Every key here, the baseline file beside it, and the scope pins in
`.npmrc`, are **control inputs**: they decide what dep-guard reports rather
than what dep-guard is looking at. On a pull-request run they are read from
the base ref, not from the branch under judgment, so a pull request cannot
loosen the gate in the commit the gate is weighing. See
[Pull-request mode](pull-request-mode.md).
