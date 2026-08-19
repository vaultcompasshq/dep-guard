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
    // Fail closed, not the ordinary main-module-guard default: this guard
    // exists only to decide whether main() runs, and main() is what
    // refuses to publish an unfit corpus. An ordinary main-module guard
    // can safely default to "not main" on an unexpected error, because
    // skipping some incidental behavior is the safe direction for it. Here
    // the safe direction is inverted -- returning false on an error means
    // main() never runs, nothing throws, and the process exits 0, which the
    // release workflow reads as "the corpus is fit to publish." Returning
    // true instead means an unexpected realpath failure surfaces as a
    // thrown error inside main() (or an unhandled exception) rather than a
    // silent, successful no-op.
    return true;
  }
}

if (isMainModule()) {
  main();
}
