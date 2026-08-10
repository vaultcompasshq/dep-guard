import { afterEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashToken, scanFile } from '../check-public-hygiene.mjs';

const GUARD_SOURCE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../check-public-hygiene.mjs');
const GUARD_SOURCE = readFileSync(GUARD_SOURCE_PATH, 'utf8');

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

// A made-up token that is not, and has never been, a real product codename.
// Its hash is added to a TEST-ONLY copy of the blocklist -- the shipped
// BANNED_HASHES in the real script is never touched, and no real banned
// plaintext is ever written anywhere in this file.
const MADE_UP_TOKEN = 'zzz-fixture-codename-not-real';
const MADE_UP_TOKEN_HASH = hashToken(MADE_UP_TOKEN);

// Built from parts (never a contiguous literal in this source file) so the
// guard does not flag this very test file when it scans the repository.
const FIXTURE_INTERNAL_PATH = ['/Users/someone', 'Projects/some-app/notes'].join('/');

// Builds a throwaway git repo under the OS temp dir (never inside this
// repository) containing a copy of the real guard script -- patched with
// one extra test-only banned hash -- plus whatever fixture files the test
// supplies. Running the copy proves the actual CLI mechanism (git ls-files,
// the allowlist, exit codes) rather than only the pure functions it is
// built from.
function buildFixtureRepo(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dep-guard-hygiene-'));
  tempDirs.push(dir);

  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

  const patchedSource = GUARD_SOURCE.replace(
    'const BANNED_HASHES = new Set([',
    `const BANNED_HASHES = new Set([\n  '${MADE_UP_TOKEN_HASH}',`
  );
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  writeFileSync(path.join(dir, 'scripts', 'check-public-hygiene.mjs'), patchedSource);

  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  execFileSync('git', ['add', '-A'], { cwd: dir });

  return dir;
}

function runGuard(dir) {
  try {
    const stdout = execFileSync('node', [path.join(dir, 'scripts', 'check-public-hygiene.mjs')], {
      cwd: dir,
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

describe('check-public-hygiene (temp-directory fixtures)', () => {
  it('fails when a tracked file contains a token whose hash is blocklisted', () => {
    const dir = buildFixtureRepo({
      'notes.md': `Some notes that mention ${MADE_UP_TOKEN} in passing.\n`,
    });

    const result = runGuard(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/notes\.md:1: blocked token \(hash match\)/);
  });

  it('fails when a tracked file contains an em dash', () => {
    const emDash = String.fromCodePoint(0x2014);
    const dir = buildFixtureRepo({
      'prose.md': `This sentence has an em dash ${emDash} in it.\n`,
    });

    const result = runGuard(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/prose\.md:1: em\/en dash \(non-ASCII\) in tracked file/);
  });

  it('fails when a tracked file contains an internal home-directory projects path', () => {
    // Split across two literals so this test file's own source never
    // contains the contiguous path shape the guard looks for -- otherwise
    // the guard would flag this very test when scanning the repository.
    const home = '/Users/testuser';
    const rest = 'Projects/widget-app/dist/index.js';
    const dir = buildFixtureRepo({
      'log.txt': `built from ${home}/${rest}\n`,
    });

    const result = runGuard(dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/log\.txt:1: internal workspace path/);
  });

  it('passes silently on a clean tree', () => {
    const dir = buildFixtureRepo({
      'readme.txt': 'A perfectly ordinary sentence with nothing to flag.\n',
    });

    const result = runGuard(dir);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/no blocked tokens, internal paths, or non-ASCII dashes/);
  });
});

describe('scanFile (unit)', () => {
  it('flags a token whose hash is in the injected blocklist', () => {
    const bannedHashes = new Set([MADE_UP_TOKEN_HASH]);
    const findings = scanFile('fixture.md', `contains ${MADE_UP_TOKEN} here`, {
      allowlisted: false,
      bannedHashes,
    });
    expect(findings).toEqual(['fixture.md:1: blocked token (hash match)']);
  });

  it('does not flag an unrelated token against the injected blocklist', () => {
    const bannedHashes = new Set([MADE_UP_TOKEN_HASH]);
    const findings = scanFile('fixture.md', 'nothing interesting here', {
      allowlisted: false,
      bannedHashes,
    });
    expect(findings).toEqual([]);
  });

  it('flags an internal home-directory projects path even without Desktop in it', () => {
    const findings = scanFile('fixture.md', `${FIXTURE_INTERNAL_PATH}\n`, {
      allowlisted: false,
      bannedHashes: new Set(),
    });
    expect(findings).toEqual(['fixture.md:1: internal workspace path']);
  });

  it('skips token and path rules, but not the dash rule, for allowlisted files', () => {
    const emDash = String.fromCodePoint(0x2014);
    const text = `${MADE_UP_TOKEN} and ${FIXTURE_INTERNAL_PATH} and an ${emDash} dash`;
    const findings = scanFile('CONTRIBUTING.md', text, {
      allowlisted: true,
      bannedHashes: new Set([MADE_UP_TOKEN_HASH]),
    });
    expect(findings).toEqual(['CONTRIBUTING.md:1: em/en dash (non-ASCII) in tracked file']);
  });

  it('reports the correct line number for a finding past line 1', () => {
    const emDash = String.fromCodePoint(0x2014);
    const text = `line one\nline two\nline three has an ${emDash} dash\n`;
    const findings = scanFile('fixture.md', text, { allowlisted: false, bannedHashes: new Set() });
    expect(findings).toEqual(['fixture.md:3: em/en dash (non-ASCII) in tracked file']);
  });
});
