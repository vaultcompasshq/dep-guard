#!/usr/bin/env node
// Release gate: refuses to publish unless the corpus actually ends up
// inside the packed core tarball -- not just present on disk (that is
// scripts/check-shippable-corpus.mjs's job) and not just listed in
// packages/core/package.json's "files" array (that is
// scripts/tests/core-package-files.test.mjs's job, and it cannot prove npm
// actually packs the directory -- only that the string "data" is in the
// array). This is the one check that packs the tarball the same way the
// publish step will and reads back what actually went in.
//
// Usage: node scripts/check-corpus-packed.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_PATHS = [
  'data/corpus/names.bloom',
  'data/corpus/top.json',
  'data/corpus/aliases.json',
  'data/corpus/meta.json',
];

function fail(message) {
  process.stderr.write(`check-corpus-packed: ${message}\n`);
  process.exitCode = 1;
}

function main() {
  // "pnpm --filter <name> exec <cmd>" resolves its working directory to
  // the matched package (packages/core here), so "npm pack --dry-run"
  // packs exactly the directory a real "pnpm --filter <name> publish"
  // would pack from -- verified by hand against a throwaway corpus and a
  // throwaway clone before this script was written, including the
  // negative case (dropping "data" from packages/core/package.json's
  // "files" array reproduces the original bug: the corpus files vanish
  // from this listing and this check fails).
  const result = spawnSync(
    'pnpm',
    ['--filter', '@vaultcompass/dep-guard-core', 'exec', 'npm', 'pack', '--dry-run', '--json'],
    { cwd: ROOT, encoding: 'utf8' }
  );

  if (result.error) {
    fail(`could not run npm pack: ${result.error.message}`);
    return;
  }
  if (result.status !== 0) {
    fail(`npm pack exited ${result.status}: ${result.stderr}`);
    return;
  }

  let packed;
  try {
    packed = JSON.parse(result.stdout);
  } catch (err) {
    fail(`npm pack --json did not produce parseable JSON: ${err.message}\n${result.stdout}`);
    return;
  }

  const entry = packed[0];
  if (!entry || !Array.isArray(entry.files)) {
    fail(`npm pack --json output did not have the expected shape: ${JSON.stringify(packed)}`);
    return;
  }

  const packedPaths = new Set(entry.files.map((f) => f.path));
  const missing = REQUIRED_PATHS.filter((p) => !packedPaths.has(p));
  if (missing.length > 0) {
    fail(
      `the packed tarball is missing ${missing.join(', ')}. ` +
        "packages/core/package.json's \"files\" array, or the corpus build step that " +
        'ran before this check, is not producing what a real publish would ship. ' +
        'scripts/tests/core-package-files.test.mjs only proves the string "data" is in ' +
        'that array -- not that npm actually packs the directory, which is what this ' +
        'check exists to prove.'
    );
    return;
  }

  console.log(
    `check-corpus-packed: all ${REQUIRED_PATHS.length} corpus files are present in the packed tarball.`
  );
}

main();
