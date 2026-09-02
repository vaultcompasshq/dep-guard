#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Bootstrap first publish for @vaultcompass/dep-guard-*"
echo "Requires: npm login with publish access to @vaultcompass"
echo ""

if ! npm whoami >/dev/null 2>&1; then
  echo "Not logged in. Run: npm login"
  exit 1
fi

# A bootstrap publish must ship exactly what main holds, so refuse to run
# from a dirty tree or any branch other than main.
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash before running this."
  exit 1
fi

CURRENT_BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Not on main (on ${CURRENT_BRANCH}). Check out main before running this."
  exit 1
fi

# A previous interrupted run can leave the corpus it built behind -- the
# corpus build further down recreates it in a couple of minutes anyway
# because the registry walk resumes from .corpus-work, but leaving the
# stale directory in place trips this same script's own pnpm test twelve
# minutes in, since that suite's precondition requires this path absent.
if [[ -d "$ROOT/packages/core/data/corpus" ]]; then
  echo "packages/core/data/corpus exists already. A previous run left it there, and the test suite requires this path to be absent."
  echo "Fix: rm -rf ${ROOT}/packages/core/data/corpus"
  echo "Then re-run this script."
  exit 1
fi

echo "Logged in as: $(npm whoami)"
cd "$ROOT"

pnpm build
pnpm typecheck
pnpm lint

# The corpus must not exist yet at this point -- the suite enforces that
# itself (a CLI test asserts a corpus-missing exit with nothing at the
# default path), and the corpus build further down is what creates it.
pnpm test

# Builds the four files corpus.ts loads, at core's built-in default path.
# This is a real walk against replicate.npmjs.com: about 430 requests and
# roughly ten to fifteen minutes on a home connection. It is resumable via
# .corpus-work if interrupted -- re-running the same command picks up where
# it left off rather than starting the walk over.
node scripts/build-corpus.mjs --out packages/core/data/corpus

# Refuses a corpus that is not actually fit to ship (all four files
# present, formatVersion and walkComplete both present and correct, a
# name-count floor, a real load through loadCorpus).
node scripts/check-shippable-corpus.mjs packages/core/data/corpus

# Packs packages/core the same way the publish step below will, then reads
# the pack listing back and confirms the corpus files are actually in it.
node scripts/check-corpus-packed.mjs

# Installs the packed tarballs into a fresh temp directory and runs the
# shipped binary, mirroring the "Install the packed tarballs and run the
# shipped binary" step in .github/workflows/release.yml. This is the only
# gate that exercises the shipped artifact in the shipped layout rather
# than checking the corpus on disk or the tarball's file listing.
echo ""
echo "Installing packed tarballs and running the shipped binary..."
PACK_DIR="$(mktemp -d)"
pnpm --dir packages/core pack --pack-destination "$PACK_DIR"
pnpm --dir packages/cli pack --pack-destination "$PACK_DIR"

CORE_VERSION="$(node -p "require('./packages/core/package.json').version")"
CLI_VERSION="$(node -p "require('./packages/cli/package.json').version")"
CORE_TARBALL="${PACK_DIR}/vaultcompass-dep-guard-core-${CORE_VERSION}.tgz"
CLI_TARBALL="${PACK_DIR}/vaultcompass-dep-guard-${CLI_VERSION}.tgz"

INSTALL_DIR="$(mktemp -d)"
npm install --prefix "$INSTALL_DIR" "$CORE_TARBALL" "$CLI_TARBALL"

BIN="${INSTALL_DIR}/node_modules/.bin/dep-guard"

set +e
"$BIN" check react --format json > "${INSTALL_DIR}/known.json"
KNOWN_EC=$?
"$BIN" check totally-made-up-hallucinated-xyz123 --format json > "${INSTALL_DIR}/unknown.json"
UNKNOWN_EC=$?
VERSION_OUT="$("$BIN" --version)"
VERSION_EC=$?
set -e

if [[ "$KNOWN_EC" -ne 0 ]]; then
  echo "Expected 'dep-guard check react' to exit 0 from the packed tarball install. Got exit ${KNOWN_EC}."
  cat "${INSTALL_DIR}/known.json" || true
  exit 1
fi

node -e "
  const fs = require('fs');
  if (${UNKNOWN_EC} === 0) {
    console.error('Expected dep-guard check <hallucinated-name> to exit non-zero from the packed tarball install.');
    process.exit(1);
  }
  const j = JSON.parse(fs.readFileSync('${INSTALL_DIR}/unknown.json', 'utf8'));
  const hasUnknown = (j.findings || []).some((f) => f.ruleId === 'unknown-package');
  if (!hasUnknown) {
    console.error('dep-guard check <hallucinated-name> exited non-zero but carried no unknown-package finding.');
    console.error(fs.readFileSync('${INSTALL_DIR}/unknown.json', 'utf8'));
    process.exit(1);
  }
"

if [[ "$VERSION_EC" -ne 0 || "$VERSION_OUT" != "$CLI_VERSION" ]]; then
  echo "Expected 'dep-guard --version' to print ${CLI_VERSION}, got '${VERSION_OUT}' (exit ${VERSION_EC})."
  exit 1
fi

echo "Install-and-run gate passed: react known, a hallucinated name unknown, --version prints ${CLI_VERSION}."

# Publish core first, then cli, in dependency order. pnpm's git checks stay
# on (no --no-git-checks) -- packages/core/data/corpus is gitignored, so
# the tree is still clean even with the corpus built above. --publish-branch
# main is required alongside that: pnpm's git checks default to expecting
# the publish branch to be named "master", and this repo has no .npmrc
# overriding it, so a plain "pnpm publish" would fail the branch check here
# even on a clean, up-to-date main -- after the full gate sequence including
# the 10-to-15-minute corpus walk above. (Conductor's own bootstrap script
# never needed this flag only because conductor's .npmrc sets
# git-checks=false; that is a config dependency worth stating here rather
# than inheriting invisibly.)
for pkg in "packages/core" "packages/cli"; do
  name="$(node -p "require('./${pkg}/package.json').name")"
  ver="$(node -p "require('./${pkg}/package.json').version")"
  # The 0.1.0 bootstrap was interrupted after core published, and the retry
  # 403d on core ("cannot publish over previously published versions")
  # instead of skipping ahead to cli -- check the registry before publishing.
  if [[ "$(npm view "${name}@${ver}" version 2>/dev/null || true)" == "${ver}" ]]; then
    echo "Skip ${name}@${ver} (already on registry)"
    continue
  fi
  echo ""
  echo "Publishing ${pkg}..."
  (cd "$ROOT/$pkg" && pnpm publish --access public --tag latest --publish-branch main)
done

cat <<'EOF'

Next on npmjs.com (each package -> Settings -> Trusted Publisher):
  Publisher: GitHub Actions
  Organization or user: vaultcompasshq
  Repository: dep-guard
  Workflow filename: release.yml
  Environment: (leave blank)

Then tag the release:
  git tag v0.1.1 && git push origin v0.1.1

Unlike conductor's bootstrap, there is no delete-and-repush dance here:
release.yml's publish step skips any version already on the registry, so
the tag run performs the GitHub Release and the registry smoke test
without re-publishing anything.

Finally, delete the corpus this script built -- the test suite requires
packages/core/data/corpus to be absent:
  rm -rf packages/core/data/corpus
EOF
