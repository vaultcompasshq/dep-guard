// Regression guard on the packaging itself. packages/core/package.json's
// "files" array is what decides whether the corpus scripts/build-corpus.mjs
// writes to packages/core/data actually ends up inside the published npm
// tarball -- npm's own "files" field beats .gitignore, so a gitignored
// data/ directory packs fine when it is explicitly listed here, but only
// if it stays listed. Dropping "data" from this array is exactly the
// omission that made the corpus fail to ship in the first place, and
// nothing else in this suite would catch its removal: every other test
// exercises the corpus's CONTENTS, never whether npm actually includes the
// directory holding them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE_PACKAGE_JSON_PATH = path.join(ROOT, 'packages', 'core', 'package.json');

describe('packages/core/package.json packaging', () => {
  it('lists "data" in "files", so the shipped corpus is included in the published tarball', () => {
    const pkg = JSON.parse(readFileSync(CORE_PACKAGE_JSON_PATH, 'utf8'));
    expect(pkg.files).toContain('data');
  });

  it('still lists "dist", so the compiled code itself keeps shipping', () => {
    const pkg = JSON.parse(readFileSync(CORE_PACKAGE_JSON_PATH, 'utf8'));
    expect(pkg.files).toContain('dist');
  });
});
