import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SYMBOL_CITATION_DOCS, lineCitations } from '../check-doc-citations.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('docs that cite code by symbol carry no line-number citation', () => {
  it.each([
    ['a file and line', 'see `packages/core/src/delta.ts:620` for it'],
    ['a file and a line range', 'the skip (delta.ts:1514-1529) holds'],
    ['an around-line phrase', 'the diagnostic around line 620'],
    ['an around-lines phrase', '(around lines 567-578)'],
    ['callers around lines', 'its callers around lines 200 and 267'],
  ])('%s is reported', (_label, text) => {
    expect(lineCitations(text)).toEqual([1]);
  });

  it('reports the line the citation is on', () => {
    expect(lineCitations('first\nsecond (tamper.ts:225)\nthird')).toEqual([2]);
  });

  it.each([
    ['a symbol citation', '`sourceSwapReport` in `packages/core/src/checks/tamper.ts`'],
    ['a time of day', 'runs at 10:30 each day'],
    ['a URL with a port', 'http://localhost:8080/path'],
  ])('control: %s is not a line citation', (_label, text) => {
    expect(lineCitations(text)).toEqual([]);
  });

  it('every listed doc is clean at head', () => {
    expect(SYMBOL_CITATION_DOCS).toContain('docs/pull-request-mode.md');
    for (const rel of SYMBOL_CITATION_DOCS) {
      expect({ rel, lines: lineCitations(readFileSync(path.join(ROOT, rel), 'utf8')) }).toEqual({ rel, lines: [] });
    }
  });
});
