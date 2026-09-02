# @vaultcompass/dep-guard-core

The offline dependency-risk engine behind [dep-guard](https://github.com/vaultcompasshq/dep-guard).
It reads a manifest/lockfile change (or a single proposed package name) and
scores it against six deterministic, offline checks -- typosquatting,
lockfile tampering, install-script acquisition, dependency confusion,
version hygiene, and unknown/hallucinated package names -- plus two optional
online checks.

Most people who want dep-guard want the CLI, not this package directly: see
[`@vaultcompass/dep-guard`](https://www.npmjs.com/package/@vaultcompass/dep-guard),
the command-line entry point that wraps this engine. Reach for this package
only if you are embedding the scan or the single-name check in your own
tool.

Nothing is published to npm at the time of writing. See the
[repository](https://github.com/vaultcompasshq/dep-guard) for status and
documentation.

## License

MIT. See [LICENSE](./LICENSE).
