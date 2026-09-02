# @vaultcompass/dep-guard

The command-line gate for [dep-guard](https://github.com/vaultcompasshq/dep-guard):
blocks risky dependency changes -- typosquats, tampered lockfile entries,
newly acquired install scripts, and hallucinated package names -- before
install, before commit, before CI. This is the entry point most users want.

```
dep-guard scan
dep-guard check <package-name>
```

Built on [`@vaultcompass/dep-guard-core`](https://www.npmjs.com/package/@vaultcompass/dep-guard-core),
the underlying engine.

## Install

```
npm install -g @vaultcompass/dep-guard
```

See the [repository](https://github.com/vaultcompasshq/dep-guard) for full
usage and documentation.

## License

MIT. See [LICENSE](./LICENSE).
