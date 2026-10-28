# Ecosystem coverage

| Ecosystem | Files read | Name checks | Lockfile checks |
|---|---|---|---|
| npm | `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml` (`yarn.lock`, `bun.lock` noted, not parsed) | unknown-package against the shipped corpus, and the registry with `--online`; typosquat against the shipped popularity list; registered-squat and asymmetry with `--online`. Judged: every added manifest dependency, and (0.17.0) every added npm or pnpm lockfile entry no manifest declares that installs from a registry, anchored on its lockfile; registered-squat does not send a lockfile-only name from a lockfile wholly new in the change, or on a run with no comparison side | tamper, install-script, publish-age (`--online`) |
| Python (PyPI) | requirements files, `pyproject.toml`, `Pipfile`, `poetry.lock`, `uv.lock`, `pdm.lock`, `Pipfile.lock` | unknown-package with `--online` only (PyPI existence; no corpus ships); typosquat against the repository's own Python names only | none: Python lockfiles are read for names; their hashes and sources are not judged. A git or url requirement is a tamper git-source or url-source finding, as for npm. Requirements pinned exactly are not a lockfile dep-guard compares |
| Go | none: `go.mod` and `go.sum` are not read by dep-guard | none | none |

Every run that saw an ecosystem prints a `coverage:` block under the summary
(and under the `names:` line when there is one): per ecosystem, read or not
read, which checks ran, and which did not and why.

    coverage:
      npm: read, with a lockfile. Ran: unknown-package, typosquat, version-hygiene, dependency-confusion, lockfile-tamper, install-script. Did not run: registered-squat and publish-age (they need --online).
      pypi: read (2 manifests, 0 lockfiles). Ran: typosquat against this repository's own Python names, tamper for git and url requirements. Did not run: unknown-package (it needs --online; no PyPI corpus ships), lockfile-tamper comparison and install-script (dep-guard reads npm and pnpm lockfiles only; Python lockfiles are read for names). All 9 requirements are pinned exactly; pinned requirements are not a lockfile dep-guard compares.
      go: not read. go.mod and go.sum are not read by dep-guard (2 files seen).

`lockfile-missing` is a note printed only for a `package.json` with no npm or
pnpm lockfile; a Python or Go repository is described by the block above
instead.

Every run that read a Python file prints a `names:` line under its summary,
and the JSON result carries the same counts under `run.ecosystems`:

    names: npm 3 checked (corpus, registry); pypi 5 of 7 checked for existence (PyPI); 2 not checked: 1 online budget spent, 1 PyPI unreachable; resemblance checked against this repository's own Python names; 1 url, path or vcs requirement excluded

An offline run with Python names also raises `pypi-names-not-checked`.

Which Python files are read: `requirements.txt` and any `.txt` whose name
starts with `requirements` or ends in `requirements.txt`
(`requirements-dev.txt`, `dev-requirements.txt`), any `.txt` directly in a
directory named `requirements`, `requirements.in`, every file a `-r` or
`--requirement` line names (relative to the including file and resolved as
the operating system opens it: each symlinked directory on the path is
followed, and a `..` after one climbs out of the link's target; the result
must stay inside the repository; a file that is itself a symlink is noted and
not read, although pip would read it; at most eight includes deep, each file
once), `pyproject.toml` (`project.dependencies` and optional dependencies,
`build-system.requires`, `[dependency-groups]`, the poetry tables, the uv
and pdm dev tables, `[tool.uv.sources]`), `Pipfile`, a repository `uv.toml`
(index settings only), and the four Python lockfiles, read for names only.
A file named by `-c` is read, and its names are counted as constraints,
never checked: a constraint never installs a name by itself.

How a requirements line is read follows pip: a `name @ url` reference or a
line starting with a URL scheme pip accepts (`https:`, `http:`, `ftp:`,
`file:`, `git+`, `svn`, `hg+`, `bzr+`, `ssh:`) is a url or git dependency,
which the tamper check judges and the name checks exclude; then an archive
(`.whl`, `.zip`, `.tar.gz` and the rest of pip's list, case-insensitively)
or a path is excluded as `file`; `reqeusts.zip==1.0` is the PyPI project
`reqeusts-zip`, because a version specifier makes it a name. Every option
spelling pip accepts is read (`-r x`, `-rx`, `--requirement=x`, any unique
abbreviation of a long option), and a line that is neither a dependency nor
a recognised option, including one with an unexpanded `${VAR}`, is counted
and named in `requirements-line-unread` rather than dropped. A requirements
file that no pattern matches and no `-r` line reaches (one a workflow runs
as `pip install -r deps.txt`) is not read.

A `[tool.uv.sources]` entry applies only to the project that declares it
and, from a uv workspace root, to that root's `members`, read from the
trust base on a `--trust-base` run. As in uv, a project's own entry for a
name takes precedence over its workspace root's. A `path` or `editable`
source exempts a name only when its target is a project of that name this
run parsed, or an archive that exists in the tree and whose file name
carries that distribution name; a `workspace` source only when a member of
that name exists. A `git` or `url` source
makes the dependency a tamper subject. Even a confirmed exemption covers uv
only: `pip install .`, `uv build --no-sources` and every consumer of a
published package resolve the name from PyPI.
