#!/usr/bin/env node
// Release gate: refuses a corpus that is not fit to publish. See
// scripts/lib/shippable-corpus.mjs for the actual checks and why this gate
// demands things loadCorpus() itself tolerates the absence of.
//
// Usage: node scripts/check-shippable-corpus.mjs <corpus-dir>
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertCorpusShippable } from './lib/shippable-corpus.mjs';

function main() {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('Usage: node scripts/check-shippable-corpus.mjs <corpus-dir>\n');
    process.exitCode = 1;
    return;
  }

  try {
    assertCorpusShippable(path.resolve(dir));
  } catch (err) {
    process.stderr.write(`check-shippable-corpus: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`check-shippable-corpus: ${dir} is fit to publish.`);
}

// realpath both sides before comparing: on macOS the OS temp dir (and other
// mount points) resolve through a symlink -- import.meta.url reports the
// resolved path, process.argv[1] reports whatever the caller typed -- so a
// naive string comparison can silently disagree and skip main() entirely.
function isMainModule() {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
