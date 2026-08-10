import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  appendNames,
  countNames,
  isStorableName,
  readNames,
  repairTrailingLine,
  rewriteNames,
} from '../lib/name-store.mjs';

let dir;
let store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dep-guard-name-store-'));
  store = path.join(dir, 'names.txt');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isStorableName', () => {
  it('refuses a name carrying a newline, which would split into two on read', () => {
    expect(isStorableName('react')).toBe(true);
    expect(isStorableName('re\nact')).toBe(false);
    expect(isStorableName('')).toBe(false);
  });
});

describe('appendNames and readNames', () => {
  it('round-trips names a page at a time', () => {
    appendNames(store, ['react', 'lodash']);
    appendNames(store, ['@babel/core']);
    expect([...readNames(store)]).toEqual(['react', 'lodash', '@babel/core']);
  });

  it('preserves names outside the Basic Latin range across the chunked read', () => {
    const names = ['café-loader', '日本語-utils', 'emoji-🎉-pkg'];
    appendNames(store, names);
    expect([...readNames(store)]).toEqual(names);
  });

  it('reports how many names it refused rather than writing them', () => {
    const result = appendNames(store, ['react', 'bad\nname', '']);
    expect(result).toEqual({ written: 1, refused: 2 });
  });

  it('counts what it stored', () => {
    appendNames(store, ['a', 'b', 'c']);
    expect(countNames(store)).toBe(3);
  });
});

describe('repairTrailingLine', () => {
  it('leaves a cleanly terminated file alone', () => {
    appendNames(store, ['react', 'lodash']);
    expect(repairTrailingLine(store).truncatedBytes).toBe(0);
    expect([...readNames(store)]).toEqual(['react', 'lodash']);
  });

  it('trims a half-written name left by a killed run', () => {
    writeFileSync(store, 'react\nlodash\nexpr');
    const result = repairTrailingLine(store);
    expect(result.truncatedBytes).toBe(4);
    expect([...readNames(store)]).toEqual(['react', 'lodash']);
  });

  it('empties a file that is one unterminated fragment', () => {
    writeFileSync(store, 'reac');
    repairTrailingLine(store);
    expect([...readNames(store)]).toEqual([]);
  });

  it('does nothing for a store that does not exist yet', () => {
    expect(repairTrailingLine(path.join(dir, 'absent.txt')).truncatedBytes).toBe(0);
  });
});

describe('rewriteNames', () => {
  it('drops names the changes feed reported and appends the live ones back', () => {
    appendNames(store, ['react', 'lodash', 'stale-package']);
    const result = rewriteNames(store, {
      drop: new Set(['lodash', 'stale-package']),
      add: ['lodash', 'brand-new'],
    });
    expect(result).toEqual({ kept: 3, removed: 2, added: 2 });
    expect([...readNames(store)].sort()).toEqual(['brand-new', 'lodash', 'react']);
  });

  it('forgets a name deleted upstream instead of vouching for it forever', () => {
    appendNames(store, ['react', 'unpublished-squat']);
    rewriteNames(store, { drop: new Set(['unpublished-squat']), add: [] });
    expect([...readNames(store)]).toEqual(['react']);
  });

  it('leaves the store readable after the swap', () => {
    appendNames(store, ['react']);
    rewriteNames(store, { drop: new Set(), add: ['vue'] });
    expect(readFileSync(store, 'utf8')).toBe('react\nvue\n');
  });
});
