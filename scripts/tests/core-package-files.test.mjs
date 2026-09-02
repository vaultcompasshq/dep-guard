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
//
// The license/repository checks below guard a different silent failure:
// npm Trusted Publishing (OIDC) validates a publish's "repository" field
// against the repository the workflow is actually building in, so an
// absent or wrong "repository" fails a trusted-publish outright, not just
// a cosmetic npmjs.com page. "license" has no such enforcement mechanism,
// but an unlicensed tarball is as much a release-metadata defect as a
// missing corpus, and belongs in the same regression guard for the same
// reason: nothing else in this suite would catch either field silently
// vanishing.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE_PACKAGE_JSON_PATH = path.join(ROOT, 'packages', 'core', 'package.json');
const CLI_PACKAGE_JSON_PATH = path.join(ROOT, 'packages', 'cli', 'package.json');

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

describe('published-package metadata (core and cli)', () => {
  for (const [label, pkgPath] of [
    ['core', CORE_PACKAGE_JSON_PATH],
    ['cli', CLI_PACKAGE_JSON_PATH],
  ]) {
    it(`${label}: declares "license": "MIT"`, () => {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      expect(pkg.license).toBe('MIT');
    });

    it(`${label}: declares a "repository" pointing at github.com/vaultcompasshq/dep-guard, with its own "directory"`, () => {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      expect(pkg.repository).toBeDefined();
      expect(pkg.repository.type).toBe('git');
      expect(pkg.repository.url).toBe('git+https://github.com/vaultcompasshq/dep-guard.git');
      expect(pkg.repository.directory).toBe(`packages/${label}`);
    });
  }
});
