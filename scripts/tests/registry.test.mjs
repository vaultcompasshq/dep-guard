import { describe, expect, it } from '@jest/globals';

import {
  backoffDelayMs,
  fetchAllDocsPage,
  fetchChangesPage,
  fetchJson,
  isRetryableStatus,
  parseRetryAfter,
  readDownloadCounts,
  splitDownloadBatches,
  USER_AGENT,
} from '../lib/registry.mjs';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

// Each call returns the next queued response, or throws the next queued
// error. Records the arguments so the user agent can be asserted.
function scriptedFetch(steps) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const step = steps.shift();
    if (step === undefined) {
      throw new Error('fetch called more times than the test scripted');
    }
    if (step instanceof Error) {
      throw step;
    }
    return step;
  };
  impl.calls = calls;
  return impl;
}

const noSleep = async () => {};

describe('isRetryableStatus', () => {
  it('retries rate limits, timeouts and server faults', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });

  it('does not retry a request the server has told us is wrong', () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially between attempts', () => {
    const noJitter = () => 1;
    expect(backoffDelayMs(1, null, noJitter)).toBe(1000);
    expect(backoffDelayMs(2, null, noJitter)).toBe(2000);
    expect(backoffDelayMs(3, null, noJitter)).toBe(4000);
  });

  it('jitters downward rather than upward, so a retry never waits longer than the schedule', () => {
    expect(backoffDelayMs(3, null, () => 0)).toBe(2000);
    expect(backoffDelayMs(3, null, () => 1)).toBe(4000);
  });

  it('caps the wait so a long outage does not park the build for an hour', () => {
    expect(backoffDelayMs(20, null, () => 1)).toBe(60_000);
  });

  it('believes a server that says how long to wait', () => {
    expect(backoffDelayMs(1, 30, () => 1)).toBe(30_000);
  });
});

describe('parseRetryAfter', () => {
  it('reads a delay in seconds', () => {
    expect(parseRetryAfter('12')).toBe(12);
  });

  it('reads an HTTP date', () => {
    const soon = new Date(Date.now() + 20_000).toUTCString();
    expect(parseRetryAfter(soon)).toBeGreaterThan(15);
  });

  it('returns null for an absent or unreadable header', () => {
    expect(parseRetryAfter(null)).toBe(null);
    expect(parseRetryAfter('')).toBe(null);
    expect(parseRetryAfter('soonish')).toBe(null);
  });
});

describe('fetchJson', () => {
  it('identifies itself so the replica operator can see who is walking it', async () => {
    const fetchImpl = scriptedFetch([jsonResponse({ ok: true })]);
    await fetchJson('https://example.invalid/x', { fetchImpl, sleepImpl: noSleep });
    expect(fetchImpl.calls[0].init.headers['user-agent']).toBe(USER_AGENT);
  });

  it('retries a server fault and returns the eventual success', async () => {
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 503 }),
      jsonResponse({ rows: [] }),
    ]);
    const result = await fetchJson('https://example.invalid/x', {
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(result).toEqual({ rows: [] });
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('retries a transport failure', async () => {
    const fetchImpl = scriptedFetch([new Error('socket hang up'), jsonResponse({ ok: 1 })]);
    await expect(
      fetchJson('https://example.invalid/x', { fetchImpl, sleepImpl: noSleep })
    ).resolves.toEqual({ ok: 1 });
  });

  it('gives up after the attempt budget and says what went wrong', async () => {
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 500 }),
      jsonResponse(null, { status: 500 }),
    ]);
    await expect(
      fetchJson('https://example.invalid/x', { fetchImpl, sleepImpl: noSleep, attempts: 2 })
    ).rejects.toThrow(/giving up .* after 2 attempt/);
  });

  it('does not retry a 404', async () => {
    const fetchImpl = scriptedFetch([jsonResponse(null, { status: 404 })]);
    await expect(
      fetchJson('https://example.invalid/x', { fetchImpl, sleepImpl: noSleep })
    ).rejects.toThrow(/404/);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('waits as long as a rate limit response asks it to', async () => {
    const waits = [];
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 429, headers: { 'retry-after': '7' } }),
      jsonResponse({ ok: 1 }),
    ]);
    await fetchJson('https://example.invalid/x', {
      fetchImpl,
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits).toEqual([7000]);
  });
});

describe('fetchAllDocsPage', () => {
  it('drops the inclusive-start duplicate so a resumed walk does not re-emit a name', async () => {
    const fetchImpl = scriptedFetch([
      jsonResponse({ rows: [{ id: 'lodash' }, { id: 'lodash.get' }, { id: 'lodash.set' }] }),
    ]);
    const page = await fetchAllDocsPage(
      'https://example.invalid',
      { startKey: 'lodash', limit: 3 },
      { fetchImpl, sleepImpl: noSleep }
    );
    expect(page.ids).toEqual(['lodash.get', 'lodash.set']);
    expect(page.lastKey).toBe('lodash.set');
    expect(page.rowCount).toBe(3);
  });

  it('skips design documents, which are CouchDB machinery and not package names', async () => {
    const fetchImpl = scriptedFetch([
      jsonResponse({ rows: [{ id: '_design/app' }, { id: 'react' }] }),
    ]);
    const page = await fetchAllDocsPage(
      'https://example.invalid',
      { startKey: null, limit: 2 },
      { fetchImpl, sleepImpl: noSleep }
    );
    expect(page.ids).toEqual(['react']);
  });

  it('sends the start key as a JSON string, the way CouchDB expects it', async () => {
    const fetchImpl = scriptedFetch([jsonResponse({ rows: [] })]);
    await fetchAllDocsPage(
      'https://example.invalid',
      { startKey: '@scope/name', limit: 10 },
      { fetchImpl, sleepImpl: noSleep }
    );
    expect(fetchImpl.calls[0].url).toContain(encodeURIComponent('"@scope/name"'));
  });

  it('reports an empty page so the walk can recognise the end', async () => {
    const fetchImpl = scriptedFetch([jsonResponse({ rows: [] })]);
    const page = await fetchAllDocsPage(
      'https://example.invalid',
      { startKey: 'zzz', limit: 10 },
      { fetchImpl, sleepImpl: noSleep }
    );
    expect(page.rowCount).toBe(0);
    expect(page.lastKey).toBe(null);
  });
});

describe('fetchChangesPage', () => {
  it('separates deletions from updates and carries the sequence forward', async () => {
    const fetchImpl = scriptedFetch([
      jsonResponse({
        results: [
          { seq: 2, id: 'react' },
          { seq: 3, id: 'gone-package', deleted: true },
          { seq: 4, id: '_design/app' },
        ],
        last_seq: 4,
      }),
    ]);
    const page = await fetchChangesPage(
      'https://example.invalid',
      { since: 1, limit: 10 },
      { fetchImpl, sleepImpl: noSleep }
    );
    expect(page.changed).toEqual(['react']);
    expect(page.deleted).toEqual(['gone-package']);
    expect(page.lastSeq).toBe(4);
    expect(page.resultCount).toBe(3);
  });
});

describe('splitDownloadBatches', () => {
  it('chunks to the size the bulk endpoint accepts', () => {
    const names = Array.from({ length: 300 }, (_, index) => `pkg-${index}`);
    const batches = splitDownloadBatches(names);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(128);
    expect(batches[2]).toHaveLength(44);
  });

  it('leaves scoped names out, because the bulk endpoint cannot take them', () => {
    expect(splitDownloadBatches(['react', '@babel/core', 'vue'])).toEqual([['react', 'vue']]);
  });
});

describe('readDownloadCounts', () => {
  it('reads a bulk response', () => {
    const counts = readDownloadCounts(
      { react: { downloads: 10 }, vue: { downloads: 4 }, unheard: null },
      ['react', 'vue', 'unheard']
    );
    expect([...counts.entries()]).toEqual([
      ['react', 10],
      ['vue', 4],
    ]);
  });

  it('reads the single-name response shape, which is the record itself', () => {
    const counts = readDownloadCounts({ downloads: 99, package: '@babel/core' }, ['@babel/core']);
    expect(counts.get('@babel/core')).toBe(99);
  });
});
