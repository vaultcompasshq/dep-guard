import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  fetchJson,
  fetchPackument,
  fetchWeeklyDownloads,
  DOWNLOADS_BATCH_SIZE,
  DOWNLOAD_DISAMBIGUATION_SENTINEL,
} from '../src/online/registry-client.js';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (name: string) => init.headers?.[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function scriptedFetch(script: Array<ReturnType<typeof jsonResponse> | Error>) {
  const calls: Array<{ url: string; init: unknown }> = [];
  let index = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const impl: any = async (url: string | URL, init: unknown) => {
    calls.push({ url: String(url), init });
    const next = script[Math.min(index, script.length - 1)];
    index += 1;
    if (next instanceof Error) {
      throw next;
    }
    return next as Response;
  };
  return Object.assign(impl, { calls });
}

const noSleep = async () => {};

// Records every delay fetchJson asks it to wait, without actually waiting,
// so backoff/Retry-After behavior can be asserted on the recorded values.
function recordingSleep() {
  const delays: number[] = [];
  const impl = async (ms: number) => {
    delays.push(ms);
  };
  return { impl, delays };
}

// Removes the +/- jitter from backoffDelayMs's exponential branch so the
// recorded delays are exact, not a range.
const noJitter = () => 0;

describe('fetchJson', () => {
  test('returns the parsed body on a 200', async () => {
    const fetchImpl = scriptedFetch([jsonResponse({ ok: true })]);
    const result = await fetchJson('https://example.invalid/x', { fetchImpl, sleepImpl: noSleep });
    expect(result).toEqual({ ok: true });
  });

  test('retries a retryable status and succeeds on the second attempt', async () => {
    const fetchImpl = scriptedFetch([jsonResponse(null, { status: 503 }), jsonResponse({ ok: true })]);
    const result = await fetchJson('https://example.invalid/x', { fetchImpl, sleepImpl: noSleep });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl.calls).toHaveLength(2);
  });

  test('does not retry a non-retryable status', async () => {
    const fetchImpl = scriptedFetch([jsonResponse(null, { status: 404 })]);
    await expect(
      fetchJson('https://example.invalid/x', { fetchImpl, sleepImpl: noSleep })
    ).rejects.toThrow(/404/);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  test('gives up after the configured attempts', async () => {
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 503 }),
      jsonResponse(null, { status: 503 }),
    ]);
    await expect(
      fetchJson('https://example.invalid/x', { fetchImpl, sleepImpl: noSleep, attempts: 2 })
    ).rejects.toThrow(/giving up/);
    expect(fetchImpl.calls).toHaveLength(2);
  });

  test('defaults to a tight attempt count and timeout, appropriate for a live scan', async () => {
    // The corpus builder's own client (scripts/lib/registry.mjs) is patient
    // on purpose (5 attempts, 120s) because a batch rebuild can afford to
    // wait; a live scan cannot. This pins that the CORE client's defaults
    // are the tight ones, not the patient ones -- a caller that wants to be
    // patient (the corpus builder) has to ask for it explicitly.
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 503 }),
      jsonResponse(null, { status: 503 }),
      jsonResponse(null, { status: 503 }),
    ]);
    await expect(
      fetchJson('https://example.invalid/x', { fetchImpl, sleepImpl: noSleep })
    ).rejects.toThrow(/giving up/);
    expect(fetchImpl.calls.length).toBeLessThanOrEqual(2);
  });

  test('retries a 429 (rate limit)', async () => {
    const fetchImpl = scriptedFetch([jsonResponse(null, { status: 429 }), jsonResponse({ ok: true })]);
    const result = await fetchJson('https://example.invalid/x', {
      fetchImpl,
      sleepImpl: noSleep,
      attempts: 2,
    });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl.calls).toHaveLength(2);
  });

  test('retries a 408 (request timeout)', async () => {
    const fetchImpl = scriptedFetch([jsonResponse(null, { status: 408 }), jsonResponse({ ok: true })]);
    const result = await fetchJson('https://example.invalid/x', {
      fetchImpl,
      sleepImpl: noSleep,
      attempts: 2,
    });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl.calls).toHaveLength(2);
  });

  test('honours a Retry-After value as the delay', async () => {
    const { impl: sleepImpl, delays } = recordingSleep();
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 429, headers: { 'retry-after': '7' } }),
      jsonResponse({ ok: true }),
    ]);
    const result = await fetchJson('https://example.invalid/x', {
      fetchImpl,
      sleepImpl,
      attempts: 2,
    });
    expect(result).toEqual({ ok: true });
    expect(delays).toEqual([7000]);
  });

  test('caps a Retry-After value at 60 seconds, so a long outage does not park a run for an hour', async () => {
    const { impl: sleepImpl, delays } = recordingSleep();
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 429, headers: { 'retry-after': '3600' } }),
      jsonResponse({ ok: true }),
    ]);
    await fetchJson('https://example.invalid/x', { fetchImpl, sleepImpl, attempts: 2 });
    expect(delays).toEqual([60_000]);
  });

  test('honours a tighter backoffCapMs than the 60s default, for a latency-sensitive caller', async () => {
    const { impl: sleepImpl, delays } = recordingSleep();
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 429, headers: { 'retry-after': '3600' } }),
      jsonResponse({ ok: true }),
    ]);
    await fetchJson('https://example.invalid/x', {
      fetchImpl,
      sleepImpl,
      attempts: 2,
      backoffCapMs: 8_000,
    });
    expect(delays).toEqual([8_000]);
  });

  test('rejects a blank or zero Retry-After and falls back to exponential backoff', async () => {
    const { impl: sleepImpl, delays } = recordingSleep();
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 429, headers: { 'retry-after': '' } }),
      jsonResponse(null, { status: 429, headers: { 'retry-after': '0' } }),
      jsonResponse({ ok: true }),
    ]);
    await fetchJson('https://example.invalid/x', {
      fetchImpl,
      sleepImpl,
      attempts: 3,
      random: noJitter,
    });
    // Exponential (1000ms, then 2000ms), not the 0ms a blank or zero header
    // would produce if it were honoured as a real Retry-After delay.
    expect(delays).toEqual([1000, 2000]);
  });

  test('grows exponentially across attempts, capped at 60 seconds', async () => {
    const { impl: sleepImpl, delays } = recordingSleep();
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 503 }),
      jsonResponse(null, { status: 503 }),
      jsonResponse(null, { status: 503 }),
      jsonResponse(null, { status: 503 }),
      jsonResponse(null, { status: 503 }),
      jsonResponse(null, { status: 503 }),
      jsonResponse(null, { status: 503 }),
      jsonResponse({ ok: true }),
    ]);
    await fetchJson('https://example.invalid/x', {
      fetchImpl,
      sleepImpl,
      attempts: 8,
      random: noJitter,
    });
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60_000]);
  });

  test('fires onRetry with the attempt, delay and reason before waiting', async () => {
    const retries: Array<{ attempt: number; delayMs: number; reason: string }> = [];
    const fetchImpl = scriptedFetch([jsonResponse(null, { status: 503 }), jsonResponse({ ok: true })]);
    const result = await fetchJson('https://example.invalid/x', {
      fetchImpl,
      sleepImpl: noSleep,
      attempts: 2,
      random: noJitter,
      onRetry: (info) => retries.push(info),
    });
    expect(result).toEqual({ ok: true });
    expect(retries).toHaveLength(1);
    expect(retries[0].attempt).toBe(1);
    expect(retries[0].delayMs).toBe(1000);
    expect(retries[0].reason).toContain('503');
  });
});

describe('fetchWeeklyDownloads', () => {
  test('reads a single-name point response', async () => {
    const fetchImpl = scriptedFetch([jsonResponse({ downloads: 42, package: 'left-pad' })]);
    const result = await fetchWeeklyDownloads(['left-pad'], { fetchImpl, sleepImpl: noSleep });
    expect(result.counts.get('left-pad')).toBe(42);
  });

  test('reads a bulk name-keyed response and batches at DOWNLOADS_BATCH_SIZE', async () => {
    const names = Array.from({ length: DOWNLOADS_BATCH_SIZE + 1 }, (_, i) => `pkg-${i}`);
    const bulkBody: Record<string, { downloads: number } | null> = {};
    for (const name of names.slice(0, DOWNLOADS_BATCH_SIZE)) {
      bulkBody[name] = { downloads: 10 };
    }
    const lastBody = { downloads: 99, package: names[DOWNLOADS_BATCH_SIZE] };
    const fetchImpl = scriptedFetch([jsonResponse(bulkBody), jsonResponse(lastBody)]);
    const result = await fetchWeeklyDownloads(names, { fetchImpl, sleepImpl: noSleep });
    expect(result.counts.get(names[0])).toBe(10);
    expect(result.counts.get(names[DOWNLOADS_BATCH_SIZE])).toBe(99);
    expect(fetchImpl.calls).toHaveLength(2);
  });

  test('fetches a scoped name individually rather than in the bulk batch', async () => {
    const fetchImpl = scriptedFetch([
      jsonResponse({ downloads: 5, package: '@scope/pkg' }),
    ]);
    const result = await fetchWeeklyDownloads(['@scope/pkg'], { fetchImpl, sleepImpl: noSleep });
    expect(result.counts.get('@scope/pkg')).toBe(5);
    expect(fetchImpl.calls[0].url).toContain('%40scope%2Fpkg');
  });

  test('a name the API confirms it has no data for lands in noRecord, not counts', async () => {
    // A bulk-shaped 200 response (a name-keyed body, even for a single
    // requested name) with an explicit null is npm's confirmed "no
    // download record" answer, reaching noRecord directly rather than via
    // the sentinel probe (see the tests below, which reach the same
    // noRecord outcome starting from a single-name 404 instead).
    const fetchImpl = scriptedFetch([jsonResponse({ 'unknown-pkg': null })]);
    const result = await fetchWeeklyDownloads(['unknown-pkg'], { fetchImpl, sleepImpl: noSleep });
    expect(result.counts.has('unknown-pkg')).toBe(false);
    expect(result.noRecord.has('unknown-pkg')).toBe(true);
  });

  test('a scoped-name 404, when the sentinel probe confirms the downloads API is healthy, resolves to noRecord', async () => {
    // The headline case: every scoped name goes through the single-name
    // path (bulk lookups reject scoped names outright, verified live --
    // a 400, "scoped packages are not currently supported in bulk
    // lookups"), so this is the ONLY way a scoped name's no-record answer
    // can ever be confirmed. The bulk batch (an unscoped name) answers
    // first; the scoped name's individual point request 404s second,
    // triggering a sentinel probe (a single-name point lookup for
    // DOWNLOAD_DISAMBIGUATION_SENTINEL) third, which succeeds -- so the
    // 404 is trusted as a confirmed no-record answer. Regression
    // coverage: a 404 on any single-name lookup used to throw out of the
    // whole function, discarding the bulk batch's already-fetched
    // results too. That preservation holds here because the sentinel
    // probe succeeds -- if it did not (see the propagation tests below),
    // the whole call still throws and the bulk batch's results are
    // discarded along with it. That is the safe direction (an unhealthy
    // downloads API degrades the whole call rather than trusting a
    // partial answer), not a guarantee that a later failure can never
    // undo earlier work within the same call.
    const fetchImpl = scriptedFetch([
      jsonResponse({ 'left-pad': { downloads: 10 } }),
      jsonResponse(null, { status: 404 }),
      jsonResponse({ downloads: 100_000, package: 'react' }),
    ]);
    const result = await fetchWeeklyDownloads(['left-pad', '@scope/pkg'], {
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(result.counts.get('left-pad')).toBe(10);
    expect(fetchImpl.calls[2].url).toContain('/react');
    expect(result.counts.has('@scope/pkg')).toBe(false);
    expect(result.noRecord.has('@scope/pkg')).toBe(true);
  });

  test('a single-unscoped-name batch 404, when the sentinel probe confirms the downloads API is healthy, resolves to noRecord', async () => {
    // A batch of exactly one unscoped name answers in the same point form
    // as a scoped name, so it 404s for an unknown name the same way and
    // is disambiguated by the same sentinel probe, not a different
    // mechanism -- scoped and unscoped single-name 404s are handled
    // identically once past the initial 404.
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 404 }),
      jsonResponse({ downloads: 100_000, package: 'react' }),
    ]);
    const result = await fetchWeeklyDownloads(['hallucinated-pkg'], {
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(result.counts.size).toBe(0);
    expect(result.noRecord.has('hallucinated-pkg')).toBe(true);
  });

  test('the sentinel probe runs at most once per fetchWeeklyDownloads call, reused across multiple 404s', async () => {
    // Two scoped names, both 404ing -- the sentinel probe must fire only
    // once (three total calls: the first 404, the probe it triggers, then
    // the second 404 reusing the already-resolved probe), not once per
    // 404, and both names resolve identically off that single probe.
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 404 }), // @scope/one's lookup
      jsonResponse({ downloads: 100_000, package: 'react' }), // the one sentinel probe
      jsonResponse(null, { status: 404 }), // @scope/two's lookup
    ]);
    const result = await fetchWeeklyDownloads(['@scope/one', '@scope/two'], {
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(fetchImpl.calls).toHaveLength(3);
    expect(result.noRecord.has('@scope/one')).toBe(true);
    expect(result.noRecord.has('@scope/two')).toBe(true);
  });

  test('a single-name 404, when the sentinel probe itself 404s, propagates rather than being trusted', async () => {
    // The sentinel is a package certain to exist and certain to have
    // downloads, so the probe 404ing means the downloads API itself is
    // misbehaving (not the candidate name) -- this must not be read as a
    // confirmed no-record answer for every single-name candidate in the
    // batch. Not caught: it propagates through fetchWeeklyDownloads
    // exactly like any other unreachable downloads API.
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 404 }),
      jsonResponse(null, { status: 404 }),
    ]);
    await expect(
      fetchWeeklyDownloads(['hallucinated-pkg'], { fetchImpl, sleepImpl: noSleep, attempts: 1 })
    ).rejects.toThrow(/404/);
  });

  test('a single-name 404 whose sentinel probe fails outright propagates rather than resolving silently', async () => {
    // The original single-name 404 is ambiguous; the sentinel probe is a
    // genuine network failure (not a clean answer either way). This is
    // deliberately NOT swallowed into "unresolved" -- it propagates
    // through fetchWeeklyDownloads exactly like any other unreachable
    // downloads API, so the caller's degrade-on-failure wrapper diagnoses
    // it as online-check-unreachable rather than silently reading it as
    // either a confirmed zero or a quiet skip.
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 404 }),
      jsonResponse(null, { status: 500 }),
    ]);
    await expect(
      fetchWeeklyDownloads(['hallucinated-pkg'], { fetchImpl, sleepImpl: noSleep, attempts: 1 })
    ).rejects.toThrow(/500/);
  });

  test('a single-name 404 whose sentinel probe returns 200 with an unexpected body propagates rather than resolving to a confirmed no-record', async () => {
    // A downloads API can be reachable (a 200) and still not be answering
    // correctly -- an error object, an empty object, anything that is
    // not a real numeric count for the sentinel. Trusting a bare 2xx here
    // would let exactly that shape convert every single-name 404 in this
    // call into a confirmed zero, which for typosquat-asymmetry is a
    // blocking high at the default gate. The probe reuses
    // readDownloadCounts (the same parser every other response goes
    // through) to judge the body, not a second hand-rolled check.
    const fetchImpl = scriptedFetch([
      jsonResponse(null, { status: 404 }),
      jsonResponse({ error: 'internal server error' }),
    ]);
    await expect(
      fetchWeeklyDownloads(['hallucinated-pkg'], { fetchImpl, sleepImpl: noSleep, attempts: 1 })
    ).rejects.toThrow(/unexpected response shape/);
  });

  test('a candidate list that includes the sentinel itself still degrades safely on a dead downloads API', async () => {
    // If react itself somehow 404s (a fully dead downloads API), the
    // probe -- also asking about react -- 404s too, and the whole call
    // throws rather than reading react's own 404 as a confirmed
    // no-record answer for react.
    const fetchImpl = scriptedFetch([jsonResponse(null, { status: 404 })]);
    await expect(
      fetchWeeklyDownloads(['react'], { fetchImpl, sleepImpl: noSleep, attempts: 1 })
    ).rejects.toThrow(/404/);
  });

  test('noRecord is intersected with what was requested: a null entry for a name outside the batch is not injected', async () => {
    // A malformed or unexpected bulk response could carry a null entry
    // for a name that was never part of this request. Now that noRecord
    // is a signal strong enough to mint a finding, that must not inject
    // an unrelated name into it.
    const fetchImpl = scriptedFetch([
      jsonResponse({ 'left-pad': { downloads: 10 }, 'not-requested-at-all': null }),
    ]);
    const result = await fetchWeeklyDownloads(['left-pad'], { fetchImpl, sleepImpl: noSleep });
    expect(result.counts.get('left-pad')).toBe(10);
    expect(result.noRecord.has('not-requested-at-all')).toBe(false);
  });

  test('noRecord is intersected with what was requested: a bulk-shaped null for the literal key "downloads" is not injected', async () => {
    // readDownloadCounts's point-response branch is gated on
    // requested.length === 1, so a single-name request with a
    // bulk-shaped body ({"downloads": null, ...}, rather than a real
    // point body) falls through to the general bulk-parsing loop. That
    // loop must not read the literal object key "downloads" as a
    // package name just because it appears in the response.
    const fetchImpl = scriptedFetch([jsonResponse({ downloads: null })]);
    const result = await fetchWeeklyDownloads(['some-pkg'], { fetchImpl, sleepImpl: noSleep });
    expect(result.noRecord.has('downloads')).toBe(false);
    expect(result.noRecord.has('some-pkg')).toBe(false);
    expect(result.counts.size).toBe(0);
  });

  test('a non-404 failure still propagates', async () => {
    const fetchImpl = scriptedFetch([jsonResponse(null, { status: 500 })]);
    await expect(
      fetchWeeklyDownloads(['some-pkg'], { fetchImpl, sleepImpl: noSleep, attempts: 1 })
    ).rejects.toThrow(/500/);
  });

  test('a multi-name bulk 404 propagates rather than resolving to an empty result', async () => {
    // A real bulk request (more than one unscoped name) never 404s for an
    // unknown name -- the bulk endpoint answers those as null entries
    // inside a 200. A 404 here means something else (a misconfigured
    // downloadsApi, an endpoint path change, a URL-unsafe name reaching the
    // unencoded batch join), and swallowing it as "omit every name in the
    // batch" would silently discard the whole batch with no diagnostic
    // downstream. Only a single-name (point-form) request may treat a 404
    // as "name not found".
    const fetchImpl = scriptedFetch([jsonResponse(null, { status: 404 })]);
    await expect(
      fetchWeeklyDownloads(['pkg-a', 'pkg-b'], { fetchImpl, sleepImpl: noSleep, attempts: 1 })
    ).rejects.toThrow(/404/);
  });

  test('encodes each name in a bulk batch, so a URL-unsafe name cannot corrupt the query', async () => {
    const fetchImpl = scriptedFetch([
      jsonResponse({ 'left-pad': { downloads: 10 }, 'weird#name': { downloads: 3 } }),
    ]);
    const result = await fetchWeeklyDownloads(['left-pad', 'weird#name'], {
      fetchImpl,
      sleepImpl: noSleep,
    });
    expect(fetchImpl.calls[0].url).toContain('left-pad,weird%23name');
    expect(result.counts.get('weird#name')).toBe(3);
  });
});

describe('fetchPackument', () => {
  test('reads creation date, latest version, its publish date, and deprecation', async () => {
    const fetchImpl = scriptedFetch([
      jsonResponse({
        time: { created: '2026-08-01T00:00:00.000Z', '1.0.0': '2026-08-01T00:00:00.000Z' },
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { deprecated: undefined } },
      }),
    ]);
    const packument = await fetchPackument('some-pkg', { fetchImpl, sleepImpl: noSleep });
    expect(packument).toEqual({
      createdAt: '2026-08-01T00:00:00.000Z',
      latestVersion: '1.0.0',
      latestPublishedAt: '2026-08-01T00:00:00.000Z',
      deprecated: false,
      unpublished: false,
      securityHolder: false,
    });
  });

  // A 200 does not mean a usable package exists. npm keeps answering 200
  // for a name after every version has been unpublished, and for a name
  // it has taken over for security reasons, and both bodies are shaped
  // quite unlike an ordinary packument. Whoever consumes this has to be
  // able to tell them apart, so the discrimination happens here, once,
  // against the raw body, rather than being re-derived by each caller.
  test('flags a fully unpublished package (npm tombstone shape)', async () => {
    // The real shape npm serves after `npm unpublish --force`: a time
    // object carrying only an "unpublished" record, no versions map and
    // no dist-tags at all.
    const fetchImpl = scriptedFetch([
      jsonResponse({
        name: 'gone-pkg',
        time: {
          unpublished: {
            name: 'gone-pkg',
            time: '2026-05-04T00:00:00.000Z',
            versions: ['1.0.0', '1.0.1'],
          },
        },
      }),
    ]);
    const packument = await fetchPackument('gone-pkg', { fetchImpl, sleepImpl: noSleep });
    expect(packument?.unpublished).toBe(true);
    expect(packument?.latestVersion).toBeNull();
    expect(packument?.securityHolder).toBe(false);
  });

  test('flags an npm security-holding placeholder by its version', async () => {
    const fetchImpl = scriptedFetch([
      jsonResponse({
        name: 'held-pkg',
        time: { created: '2019-01-01T00:00:00.000Z', '0.0.1-security': '2019-02-02T00:00:00.000Z' },
        'dist-tags': { latest: '0.0.1-security' },
        versions: { '0.0.1-security': { description: 'security holding package' } },
      }),
    ]);
    const packument = await fetchPackument('held-pkg', { fetchImpl, sleepImpl: noSleep });
    expect(packument?.securityHolder).toBe(true);
    expect(packument?.unpublished).toBe(false);
  });

  test('flags a security-holding placeholder by its description marker alone', async () => {
    // Not every holder carries the 0.0.1-security version string, so the
    // description marker npm writes is checked independently rather than
    // as a confirmation of the version pattern.
    const fetchImpl = scriptedFetch([
      jsonResponse({
        name: 'held-two',
        description: 'security holding package',
        time: { created: '2019-01-01T00:00:00.000Z', '1.0.2': '2019-02-02T00:00:00.000Z' },
        'dist-tags': { latest: '1.0.2' },
        versions: { '1.0.2': {} },
      }),
    ]);
    const packument = await fetchPackument('held-two', { fetchImpl, sleepImpl: noSleep });
    expect(packument?.securityHolder).toBe(true);
  });

  test('does not mistake an ordinary package for a holder or a tombstone', async () => {
    // The falsifiable half. A prerelease that merely mentions security in
    // an unrelated way, at an ordinary version, is a normal package.
    const fetchImpl = scriptedFetch([
      jsonResponse({
        name: 'real-pkg',
        description: 'helpers for security headers',
        time: { created: '2024-01-01T00:00:00.000Z', '3.1.0': '2026-02-02T00:00:00.000Z' },
        'dist-tags': { latest: '3.1.0' },
        versions: { '3.1.0': {} },
      }),
    ]);
    const packument = await fetchPackument('real-pkg', { fetchImpl, sleepImpl: noSleep });
    expect(packument?.securityHolder).toBe(false);
    expect(packument?.unpublished).toBe(false);
    expect(packument?.latestVersion).toBe('3.1.0');
  });

  test('reports deprecated true when the latest version carries a deprecation notice', async () => {
    const fetchImpl = scriptedFetch([
      jsonResponse({
        time: { created: '2020-01-01T00:00:00.000Z', '2.0.0': '2020-06-01T00:00:00.000Z' },
        'dist-tags': { latest: '2.0.0' },
        versions: { '2.0.0': { deprecated: 'use something else' } },
      }),
    ]);
    const packument = await fetchPackument('old-pkg', { fetchImpl, sleepImpl: noSleep });
    expect(packument?.deprecated).toBe(true);
  });

  test('returns null on a 404 rather than throwing', async () => {
    const fetchImpl = scriptedFetch([jsonResponse(null, { status: 404 })]);
    const packument = await fetchPackument('nonexistent-pkg', { fetchImpl, sleepImpl: noSleep });
    expect(packument).toBeNull();
  });

  test('a genuine network failure still throws, distinct from a 404', async () => {
    const fetchImpl = scriptedFetch([new Error('socket hang up')]);
    await expect(
      fetchPackument('some-pkg', { fetchImpl, sleepImpl: noSleep, attempts: 1 })
    ).rejects.toThrow(/socket hang up/);
  });

  test('a package name containing "404" with a server error is not misclassified as absent', async () => {
    // Regression test for 404 detection via message.includes() rather than
    // status code. A package literally named "some-404-package" that gets a
    // genuine 500 error should throw, not return null.
    const fetchImpl = scriptedFetch([jsonResponse(null, { status: 500 })]);
    await expect(
      fetchPackument('some-404-package', { fetchImpl, sleepImpl: noSleep, attempts: 1 })
    ).rejects.toThrow(/request failed: 500/);
  });
});

describe('DOWNLOAD_DISAMBIGUATION_SENTINEL', () => {
  test('appears in the corpus\'s own reviewed popularity list', () => {
    // The client never reads scripts/data/top-packages.txt at runtime --
    // that would be a new coupling for no benefit (see the comment on
    // DOWNLOAD_DISAMBIGUATION_SENTINEL) -- but the guarantee the sentinel
    // relies on (certainly registered, certainly downloaded) should not
    // rest on this comment's say-so alone. This anchors it to the
    // corpus's own twice-verified list without the client depending on
    // that list existing or being readable at scan time.
    const topPackagesPath = fileURLToPath(
      new URL('../../../scripts/data/top-packages.txt', import.meta.url)
    );
    const names = readFileSync(topPackagesPath, 'utf8').split('\n').map((line) => line.trim());
    expect(names).toContain(DOWNLOAD_DISAMBIGUATION_SENTINEL);
  });
});
