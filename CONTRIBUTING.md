# Contributing to dep-guard

## Public repository hygiene

This repo is **public**. Never commit names, paths, or context from other
Vault & Compass products, private monorepos, or internal portfolio work.

**Do not put in committed files** (including tests, fixtures, docs, and
comments):

- Other product or venture names, or internal-only names for this one
- Absolute paths like `/Users/<name>/Projects/<other-app>/...`
- Session handoffs, planning notes, or other working-session artefacts
- Em dashes or en dashes. Prose and commit messages here are plain ASCII;
  write "note -- like this" with two hyphens instead.

**Use instead:** generic placeholders (`example-app`, `my-service`,
`acme-corp`) and describe the pattern, not the source.

Working notes stay in gitignored paths: `TODO.local.md`, `.local/`, and
anything else already listed in `.gitignore`. If a note needs a new local
home, add the pattern to `.gitignore` before writing the file, not after.

`scripts/check-public-hygiene.mjs` runs as part of `pnpm lint` and enforces
the token, path, and dash rules above automatically. Before opening a PR,
also read your own diff once for anything the guard cannot see (below).

### Adding a blocklist entry without writing the plaintext

The guard's blocklist stores SHA-256 hashes of lowercased tokens, never the
plaintext, so a name can be blocked without the repository ever containing
it. To add one:

```
node -e "const c=require('crypto');const t=process.argv[1];console.log(c.createHash('sha256').update(t.toLowerCase()).digest('hex'))" '<token>'
```

Paste the resulting hash into `BANNED_HASHES` in
`scripts/check-public-hygiene.mjs`, on its own line, alongside a comment
saying only that it is a hash and why -- never the token that produced it,
not even in the commit message.

### What the guard cannot check

Two things stay a human's job:

- **Whether prose reads as written by a person.** The guard checks
  characters and hashes, not voice. Read what you are about to commit.
- **Whether the repository narrates future product plans.** README,
  ARCHITECTURE, and code comments describe what dep-guard does today, not
  what it might become. Roadmap and planning material belongs in the
  gitignored local files above, not in tracked docs.

## Branches and merging

`main` is protected and requires a pull request; there is no direct push.
Work on a feature branch, open a PR, and let CI and review gate the merge.

## Local gates (the merge bar)

Run these before every commit, and all of them before opening a PR:

```
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

`pnpm lint` runs the public-repo hygiene guard above; it fails on the first
blocked token, internal path, or non-ASCII dash it finds, naming the file
and line.
