#!/usr/bin/env node
// Docs that cite code by symbol (a function or constant name plus its file)
// rather than by line number. A line number goes stale the first time the
// file above it changes, and nothing tells the reader: every line citation in
// docs/pull-request-mode.md had drifted off its code by the 2026-11-08 audit.
// This check fails a listed doc that cites a line again. It does not check
// that a cited symbol exists or says what the prose claims.
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SYMBOL_CITATION_DOCS = ['docs/pull-request-mode.md'];

// "file.ts:620", "delta.ts:1514-1529", "around line 620", "around lines 567-578".
const LINE_CITATION = /\.(?:ts|mts|js|mjs|cjs|ya?ml|json):\d+|\baround lines? \d+/i;

export function lineCitations(text) {
  const found = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (LINE_CITATION.test(line)) {
      found.push(index + 1);
    }
  }
  return found;
}

function main() {
  const failures = [];
  for (const rel of SYMBOL_CITATION_DOCS) {
    for (const line of lineCitations(readFileSync(path.join(ROOT, rel), 'utf8'))) {
      failures.push(`${rel}:${line}: cites code by line number; cite the function or constant and its file instead`);
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`x ${failure}`);
    }
    process.exit(1);
  }
  console.log(`check-doc-citations: no line-number citations in ${SYMBOL_CITATION_DOCS.length} symbol-cited doc(s).`);
}

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
