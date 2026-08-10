#!/usr/bin/env node
// Public-repo hygiene guard: fail if tracked files contain tokens whose
// SHA-256 (lowercased) matches the blocklist below, an internal
// home-directory path, or a non-ASCII em/en dash. Plaintext product
// codenames are never stored in this repo -- only hashes. To add an entry
// locally:
//
//   node -e "const c=require('crypto');const t=process.argv[1];console.log(c.createHash('sha256').update(t.toLowerCase()).digest('hex'))" '<token>'
//
// Paste the hash into BANNED_HASHES. See CONTRIBUTING.md, public repository
// hygiene section.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// SHA-256(lowercase token) -- no plaintext codenames in the repository.
// Copied verbatim from vault-guard's scripts/check-private-names.cjs: same
// organisation, same blocklist, so the hashes travel without either repo
// ever writing down the plaintext they stand for.
const BANNED_HASHES = new Set([
  'bcbff8a223bdb66059e43ae951a28ed12598c9e782fb65c58dabcd347f65cabe',
  'ec4e8dbcdbe500197bb27e769cee7864c0a4b4876a604998a23c80bbcc979d4c',
  '8bb4b7a9e837acadf49af332f3211a29f98e2239aa985825f1fe62cdf780c068',
  'cd800cbc9cd106b8f8646762b9ba7c530812555958e019b97c0a9878b005c52f',
  '9f9f3ba21e38f52a4a40f521490c33c4a2da799b5235c53374ad159ea8d0000b',
  'd52aa800a6d18843a0369b60f374fefb59b2cb91318b83c040f9e9d561ee96c4',
  'e44dbe116f27c5aef9c3386906b82f94f8b557a48c4b036a248f3ba75ddaece1',
  '57cd823001a8558b03746dd1dac01fe13b4fc442728bed4b5840703a755b810e',
  '59f5eae64585bb2483b57c4618b144e92011ba0656565003a42db23f029f8bd5',
  'c227174107761c30f27338905527dc53032ac5daf6d225ce9561ba4110344d7d',
  'd792a2b651ecea40434f60efb0435efcef8eb60aaefaa85f0660e718d074de76',
]);

const ALLOWLIST = new Set(['CONTRIBUTING.md', 'scripts/check-public-hygiene.mjs']);

// Internal home-directory path shape. vault-guard's version pins the
// literal "Desktop/Projects" segment of its own author's machine; this repo
// lives at a different path (no Desktop segment), so this is generalised to
// any absolute /Users/<name>/... path that runs through a directory whose
// name is "projects" (any case, any depth), rather than one fixed layout.
const INTERNAL_PATH = /\/Users\/[^/\s]+\/(?:[^/\s]+\/)*[Pp]rojects\/[^/\s]+/;

// Em dash (code point 0x2014) and en dash (code point 0x2013), built from
// code points rather than typed as literal characters so this file itself
// never contains one -- the guard should not need an exemption from its own
// rule. This repo's prose and commit messages are plain ASCII; either
// character is the most common way a non-ASCII dash slips in from a pasted
// or generated sentence.
const DASH = new RegExp(`[${String.fromCodePoint(0x2014)}${String.fromCodePoint(0x2013)}]`);

const TOKEN = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*\b/gi;

export function hashToken(token) {
  return createHash('sha256').update(token.toLowerCase()).digest('hex');
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

// bannedHashes is injectable (default: the real, shipped blocklist) so
// tests can prove the hash-matching mechanism itself with a made-up token
// and a test-only hash, instead of needing a real banned plaintext.
export function scanFile(rel, text, { allowlisted, bannedHashes = BANNED_HASHES }) {
  const findings = [];

  for (const [lineNum, line] of text.split('\n').entries()) {
    if (DASH.test(line)) {
      findings.push(`${rel}:${lineNum + 1}: em/en dash (non-ASCII) in tracked file`);
    }
  }

  if (allowlisted) {
    return findings;
  }

  const pathMatch = text.match(INTERNAL_PATH);
  if (pathMatch) {
    findings.push(`${rel}:${lineNumberAt(text, pathMatch.index)}: internal workspace path`);
  }

  for (const match of text.matchAll(TOKEN)) {
    if (bannedHashes.has(hashToken(match[0]))) {
      findings.push(`${rel}:${lineNumberAt(text, match.index)}: blocked token (hash match)`);
    }
  }

  return findings;
}

function main() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);

  const allFindings = [];

  for (const rel of files) {
    if (rel.startsWith('node_modules/')) continue;

    const abs = path.join(ROOT, rel);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    allFindings.push(...scanFile(rel, text, { allowlisted: ALLOWLIST.has(rel) }));
  }

  if (allFindings.length > 0) {
    for (const finding of allFindings) {
      console.error(`x ${finding}`);
    }
    console.error('\ncheck-public-hygiene: remove the flagged content from tracked files.');
    console.error('See CONTRIBUTING.md, public repository hygiene section.');
    process.exit(1);
  }

  console.log('check-public-hygiene: no blocked tokens, internal paths, or non-ASCII dashes in tracked files.');
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
