import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCache } from '../src/online/cache.js';

function tmpCachePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'depguard-online-cache-'));
  return path.join(dir, 'online.json');
}

describe('OnlineCache', () => {
  test('a fresh cache path starts empty', () => {
    const cache = loadCache(tmpCachePath());
    expect(cache.get('downloads:left-pad')).toBeUndefined();
  });

  test('set then get returns the value before the TTL elapses', () => {
    let now = 1_000_000;
    const cache = loadCache(tmpCachePath(), () => now);
    cache.set('downloads:left-pad', 42, 60_000);
    now += 30_000;
    expect(cache.get('downloads:left-pad')).toBe(42);
  });

  test('an entry expires after its TTL', () => {
    let now = 1_000_000;
    const cache = loadCache(tmpCachePath(), () => now);
    cache.set('downloads:left-pad', 42, 60_000);
    now += 60_001;
    expect(cache.get('downloads:left-pad')).toBeUndefined();
  });

  test('a null TTL never expires', () => {
    let now = 1_000_000;
    const cache = loadCache(tmpCachePath(), () => now);
    cache.set('created:left-pad', '2020-01-01', null);
    now += 1_000 * 60 * 60 * 24 * 365 * 10;
    expect(cache.get('created:left-pad')).toBe('2020-01-01');
  });

  test('save persists entries a fresh load can read back', () => {
    const cachePath = tmpCachePath();
    const first = loadCache(cachePath);
    first.set('downloads:left-pad', 42, 60_000);
    first.save();

    const second = loadCache(cachePath);
    expect(second.get('downloads:left-pad')).toBe(42);
  });

  test('a corrupt cache file is treated as empty, not as an error', () => {
    const cachePath = tmpCachePath();
    writeFileSync(cachePath, '{ not valid json');
    const cache = loadCache(cachePath);
    expect(cache.get('anything')).toBeUndefined();
    cache.set('downloads:left-pad', 1, 60_000);
    cache.save();
    expect(() => JSON.parse(readFileSync(cachePath, 'utf8'))).not.toThrow();
  });

  test('a cache file holding the wrong shape is treated as empty', () => {
    const cachePath = tmpCachePath();
    writeFileSync(cachePath, JSON.stringify([1, 2, 3]));
    const cache = loadCache(cachePath);
    expect(cache.get('anything')).toBeUndefined();
  });
});
