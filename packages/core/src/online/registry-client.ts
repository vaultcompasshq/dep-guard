//
// The registry client every online check shares, ported from
// scripts/lib/registry.mjs's fetchJson but with tight, scan-appropriate
// defaults rather than that script's patient batch-job defaults: a live
// scan (a pre-commit hook, a CI step, an MCP propose-time call) has to fail
// fast and degrade rather than hang, per docs/INVARIANTS.md's rule that
// online checks are the one deliberate exception to failing closed -- a
// network problem degrades to the offline result with a diagnostic, never
// blocks. scripts/lib/registry.mjs is refactored in a later task to import
// this instead of maintaining a second implementation, the same shape as
// the corpus builder already imports BloomFilter from the built core
// rather than reimplementing it.

export const USER_AGENT = 'dep-guard (+https://github.com/vaultcompasshq/dep-guard)';
export const DEFAULT_DOWNLOADS_API = 'https://api.npmjs.org';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

// A live scan gets two tries and a five second budget per request, not the
// corpus builder's five tries and two minutes -- a batch rebuild can wait
// out a flaky connection; a pre-commit hook cannot.
export const SCAN_ATTEMPTS = 2;
export const SCAN_TIMEOUT_MS = 5_000;

export interface FetchOptions {
  attempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  random?: () => number;
  downloadsApi?: string;
  registry?: string;
  userAgent?: string;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  // Overrides BACKOFF_CAP_MS for both the exponential ladder and a
  // server-supplied Retry-After. The corpus builder's patient batch jobs
  // want the full 60s (and pass nothing, keeping the default); a live scan
  // (a pre-commit hook, a CI step, an MCP propose-time call) reaches
  // latency-sensitive callers and needs a much tighter ceiling so a single
  // slow or rate-limited name cannot stall it for minutes.
  backoffCapMs?: number;
}

// Retried: a transport failure, a rate limit, a request timeout, and
// anything the server calls its own fault. A 408 is retried because it is
// transient by definition -- the server is telling us it gave up waiting,
// not that the request itself is wrong.
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

// Requires a positive, non-empty numeric value: an empty string coerces to
// 0 under Number(''), and a bare "0" is a value a server could genuinely
// send, but honouring either as a zero-delay retry turns a rate limit into
// a tight retry loop against the thing that just asked us to back off.
function parseRetryAfter(headerValue: string | null): number | null {
  if (headerValue === null || headerValue.trim().length === 0) {
    return null;
  }
  const seconds = Number(headerValue);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

// Capped at 60s, including a server-supplied Retry-After: a server can ask
// for an arbitrarily long wait, and honouring that without a cap parks a
// batch job for as long as the server says rather than as long as this
// client is willing to wait.
const BACKOFF_CAP_MS = 60_000;

function backoffDelayMs(
  attempt: number,
  retryAfterSeconds: number | null,
  random: () => number,
  capMs: number = BACKOFF_CAP_MS
): number {
  if (retryAfterSeconds !== null) {
    return Math.min(capMs, Math.ceil(retryAfterSeconds * 1000));
  }
  const base = Math.min(capMs, 1000 * 2 ** (attempt - 1));
  return base + Math.floor(random() * 250);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchJson(url: string, options: FetchOptions = {}): Promise<unknown> {
  const {
    attempts = SCAN_ATTEMPTS,
    timeoutMs = SCAN_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    random = Math.random,
    userAgent = USER_AGENT,
    onRetry,
    backoffCapMs = BACKOFF_CAP_MS,
  } = options;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response | null = null;
    try {
      response = (await fetchImpl(url, {
        headers: { 'user-agent': userAgent, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })) as Response;
    } catch (err) {
      lastError = err as Error;
    }

    if (response !== null) {
      if (response.ok) {
        return await response.json();
      }
      if (!isRetryableStatus(response.status)) {
        const err = new Error(`request failed: ${response.status} ${response.statusText} for ${url}`);
        Object.assign(err, { status: response.status });
        throw err;
      }
      lastError = new Error(`request failed: ${response.status} ${response.statusText}`);
      Object.assign(lastError, { status: response.status });
    }

    if (attempt === attempts) {
      break;
    }
    const retryAfter =
      response === null ? null : parseRetryAfter(response.headers.get('retry-after'));
    const delayMs = backoffDelayMs(attempt, retryAfter, random, backoffCapMs);
    onRetry?.({ attempt, delayMs, reason: lastError?.message ?? 'unknown' });
    await sleepImpl(delayMs);
  }

  throw new Error(`giving up on ${url} after ${attempts} attempt(s): ${lastError?.message ?? 'unknown error'}`);
}

// The downloads API takes up to 128 comma-separated names per request and
// has no bulk form for scoped names at all -- the bulk endpoint does not
// accept a slash -- so a scoped name always goes one at a time.
export const DOWNLOADS_BATCH_SIZE = 128;

function splitDownloadBatches(names: string[], batchSize = DOWNLOADS_BATCH_SIZE): string[][] {
  const batches: string[][] = [];
  const bulkable = names.filter((name) => !name.startsWith('@'));
  for (let index = 0; index < bulkable.length; index += batchSize) {
    batches.push(bulkable.slice(index, index + batchSize));
  }
  return batches;
}

// The result of a downloads lookup, split into three states rather than
// two, because the fix for zero-download blindness (treating "no record"
// as a signal worth escalating on) makes the difference between them
// load-bearing rather than cosmetic:
//
//  - present in `counts`: npm answered with a real, numeric weekly count.
//  - present in `noRecord`: npm confirmed, one way or another, that it has
//    no download record for this exact name -- either a null entry in a
//    bulk response body, or (for a name whose single-name lookup 404d) a
//    sentinel probe that positively confirmed the downloads API's
//    single-name path is working right now, so the 404 means "no
//    record" rather than something else. This is a confirmed fact, not a
//    gap: a consumer that wants "no data recorded" to mean zero downloads
//    reads this set, not merely a missing key in `counts`.
//  - absent from both: a defensive case, not the common path -- a bulk
//    response entry in some shape neither a real count nor an explicit
//    null. A single-name 404 no longer lands here: it either resolves to
//    `noRecord` (the sentinel probe confirmed the endpoint is healthy) or
//    makes the whole fetchWeeklyDownloads call throw (the sentinel probe
//    itself failed, see probeDownloadsApiHealth), never a silent gap. A
//    consumer must still treat an absence from both sets the same as if
//    the name had never been asked about at all -- never as a confirmed
//    zero.
export interface DownloadCountsResult {
  counts: Map<string, number>;
  noRecord: Set<string>;
}

function readDownloadCounts(payload: unknown, requested: string[]): DownloadCountsResult {
  const counts = new Map<string, number>();
  const noRecord = new Set<string>();
  if (payload === null || typeof payload !== 'object') {
    return { counts, noRecord };
  }
  const record = payload as Record<string, unknown>;
  // A single-name request answers with the record itself; a bulk request
  // answers with a name-keyed map whose values may be null for a name the
  // API has no data for.
  if (typeof record.downloads === 'number' && requested.length === 1) {
    counts.set(requested[0], record.downloads);
    return { counts, noRecord };
  }
  // requestedSet gates every entry read from the response body, not just
  // the numeric ones: a bulk response is keyed by whatever the SERVER
  // chose to put in it, and this loop must not trust that blindly. A
  // point-shaped body ({"downloads": null, ...}) read by this branch
  // (never actually reached today, since the requested.length === 1
  // check above already handles the real point shape, but readDownloadCounts
  // has no way to know a future caller will not exercise it some other
  // way) would otherwise inject the literal string "downloads" into
  // noRecord; a bulk body carrying a null entry for a name that was never
  // requested would inject that name too. Now that noRecord is a signal
  // strong enough to mint a finding, an injected name is a false positive
  // manufactured from a response shape npm never actually sends, not a
  // theoretical concern -- the fetch layer has to be as suspicious of the
  // server's OWN keys as it already is of a swallowed 404.
  const requestedSet = new Set(requested);
  for (const [name, entry] of Object.entries(record)) {
    if (!requestedSet.has(name)) {
      continue;
    }
    if (entry !== null && typeof entry === 'object' && typeof (entry as { downloads?: unknown }).downloads === 'number') {
      counts.set(name, (entry as { downloads: number }).downloads);
    } else if (entry === null) {
      noRecord.add(name);
    }
  }
  return { counts, noRecord };
}

// A module-level literal, not read from anywhere at runtime -- this
// client has no other dependency on corpus data, and importing the
// popularity list just to pick a sentinel would be a new coupling for no
// real benefit. It must name a package that certainly exists and
// certainly has a nonzero weekly download count for as long as npm
// itself does, so it can never legitimately 404 on the downloads API
// (see probeDownloadsApiHealth). react qualifies and is already this
// codebase's own online-check test fixture name. The claim that it
// belongs on that footing is anchored by a test asserting it appears in
// scripts/data/top-packages.txt -- the corpus's own reviewed,
// twice-verified popularity list (docs/INVARIANTS.md's "The popularity
// list is a trust input" section) -- rather than left as an unverified
// assertion in this comment.
export const DOWNLOAD_DISAMBIGUATION_SENTINEL = 'react';

// Confirms the downloads API's single-name path is healthy right now, by
// asking it about a name that cannot legitimately 404: a package this
// codebase already trusts to be popular and permanently registered (see
// DOWNLOAD_DISAMBIGUATION_SENTINEL). Used by fetchDownloadCounts to tell
// apart npm's real behaviour for a name it has never seen (a 404 here
// too) from a downloads API that 404s on everything -- a misconfigured
// downloadsApi, an endpoint path change, an outage -- which would
// otherwise let a broken endpoint masquerade as a confirmed no-record
// answer for every single-name candidate in a scan.
//
// Deliberately probes the downloads endpoint, not the registry: whether
// a name EXISTS (fetchPackument's question) and whether the DOWNLOADS
// API is currently answering single-name requests correctly are two
// different services with independent failure modes. A downloads API
// that 404s on everything while the registry is fine would make every
// scoped package in a scan look like a confirmed no-record zero if this
// probe asked the registry instead -- exactly the fabricated-block this
// whole disambiguation exists to prevent, just moved one service over.
//
// A failure here (the sentinel itself 404s, the request fails outright,
// or the response is a 2xx that is not actually a real download count --
// a downloads API can be reachable and still answer with an error body
// or something non-JSON-shaped under a 200) is deliberately NOT caught:
// it propagates out of fetchWeeklyDownloads to the caller's own
// try/catch, identical to today's behavior for a dead downloads API, so
// it is diagnosed as online-check-unreachable rather than silently read
// as a confirmed no-record answer for every single-name candidate in the
// batch.
async function probeDownloadsApiHealth(options: FetchOptions): Promise<void> {
  const downloadsApi = options.downloadsApi ?? DEFAULT_DOWNLOADS_API;
  const payload = await fetchJson(
    `${downloadsApi}/downloads/point/last-week/${encodeURIComponent(DOWNLOAD_DISAMBIGUATION_SENTINEL)}`,
    options
  );
  // fetchJson only throws for a non-2xx status or a transport failure --
  // a 2xx with an unexpected body (an error object, an empty object, a
  // non-JSON-shaped payload) returns normally, and this check is what
  // turns that into a failure too. Deliberately reused rather than
  // hand-rolled: readDownloadCounts is already this file's one definition
  // of "a well-formed downloads answer", and the sentinel's response has
  // to be held to that exact same standard, not a second, looser one that
  // could drift from it. A healthy downloads API's answer for the
  // sentinel is never anything but a real numeric count, so anything
  // readDownloadCounts cannot read as one is treated exactly like the
  // sentinel 404ing.
  if (!readDownloadCounts(payload, [DOWNLOAD_DISAMBIGUATION_SENTINEL]).counts.has(DOWNLOAD_DISAMBIGUATION_SENTINEL)) {
    throw new Error(
      `downloads API health probe for "${DOWNLOAD_DISAMBIGUATION_SENTINEL}" returned an unexpected response shape`
    );
  }
}

// This is gated on requested.length === 1 on purpose: a real bulk request
// (more than one unscoped name) never answers 404 for an unknown name --
// the bulk endpoint returns those as null entries inside a 200 -- so a 404
// on a multi-name request means something else entirely and has to
// propagate rather than be swallowed as "omit every name in the batch".
// Silently returning an empty result for a whole bulk batch would trade a
// loud failure for a silent one and rob the caller's degrade-on-failure
// wrapper of the online-check-unreachable diagnostic it exists to raise.
//
// A single-name 404 (scoped or unscoped -- both shapes reach this same
// branch) is not trusted on its own: confirmDownloadsApiHealthy (a
// per-fetchWeeklyDownloads-call memoized probe, supplied by the caller so
// the sentinel is asked at most once per call rather than once per 404)
// must resolve first. If it throws, this function does not catch it --
// see probeDownloadsApiHealth.
async function fetchDownloadCounts(
  url: string,
  requested: string[],
  options: FetchOptions,
  confirmDownloadsApiHealthy: () => Promise<void>
): Promise<DownloadCountsResult> {
  try {
    const payload = await fetchJson(url, options);
    return readDownloadCounts(payload, requested);
  } catch (err) {
    if (requested.length === 1 && (err as Error & { status?: number }).status === 404) {
      await confirmDownloadsApiHealthy();
      return { counts: new Map(), noRecord: new Set(requested) };
    }
    throw err;
  }
}

// Returns which of the requested names npm reported a real download count
// for, and which it explicitly confirmed it has no record of (see
// DownloadCountsResult for what each of those, and the third, defensive
// case -- absent from both -- means). A name missing from `counts` is NOT
// interchangeable with "zero downloads": only a name in `noRecord` is a
// confirmed zero, and a single-name 404 (scoped or unscoped) is actively
// confirmed via probeDownloadsApiHealth before it is ever allowed to mean
// that -- it either resolves to `noRecord` or makes this whole call throw,
// never a silent per-name gap. Every current and future caller that wants
// "no data recorded" to escalate a finding has to make that check
// explicitly against `noRecord` -- this function deliberately does not
// decide it.
export async function fetchWeeklyDownloads(
  names: string[],
  options: FetchOptions = {}
): Promise<DownloadCountsResult> {
  const downloadsApi = options.downloadsApi ?? DEFAULT_DOWNLOADS_API;
  const counts = new Map<string, number>();
  const noRecord = new Set<string>();

  // Memoized for the lifetime of this one fetchWeeklyDownloads call: the
  // question probeDownloadsApiHealth answers ("is the downloads API's
  // single-name path working right now?") does not change between one
  // single-name 404 and the next within the same call, so it is asked at
  // most once here and reused, rather than once per 404 -- see
  // fetchDownloadCounts.
  let sentinelProbe: Promise<void> | null = null;
  function confirmDownloadsApiHealthy(): Promise<void> {
    if (sentinelProbe === null) {
      sentinelProbe = probeDownloadsApiHealth(options);
    }
    return sentinelProbe;
  }

  for (const batch of splitDownloadBatches(names)) {
    // Each name is encoded individually, then joined with a literal comma
    // -- encoding the joined string as a whole would also encode the
    // separator itself. A manifest-supplied registryName is only trimmed
    // and checked for emptiness upstream (checks/candidates.ts), so a
    // name containing '#', '?', or a space must not reach this URL
    // unencoded: an unencoded special character can truncate the path,
    // start a query string, or otherwise corrupt the batch, 404, and --
    // now that a no-record 404 is a signal, not just a skip -- read as a
    // false "zero downloads" for a name that was never actually looked up.
    const url = `${downloadsApi}/downloads/point/last-week/${batch.map((name) => encodeURIComponent(name)).join(',')}`;
    const result = await fetchDownloadCounts(url, batch, options, confirmDownloadsApiHealthy);
    for (const [name, count] of result.counts) {
      counts.set(name, count);
    }
    for (const name of result.noRecord) {
      noRecord.add(name);
    }
  }

  for (const name of names.filter((n) => n.startsWith('@'))) {
    const url = `${downloadsApi}/downloads/point/last-week/${encodeURIComponent(name)}`;
    const result = await fetchDownloadCounts(url, [name], options, confirmDownloadsApiHealthy);
    for (const [key, count] of result.counts) {
      counts.set(key, count);
    }
    for (const key of result.noRecord) {
      noRecord.add(key);
    }
  }

  return { counts, noRecord };
}

export interface Packument {
  createdAt: string | null;
  latestVersion: string | null;
  latestPublishedAt: string | null;
  deprecated: boolean;
}

interface RawPackument {
  time?: Record<string, string>;
  'dist-tags'?: { latest?: string };
  versions?: Record<string, { deprecated?: string }>;
}

function readPackument(payload: unknown): Packument {
  const raw = (payload ?? {}) as RawPackument;
  const latestVersion = raw['dist-tags']?.latest ?? null;
  return {
    createdAt: raw.time?.created ?? null,
    latestVersion,
    latestPublishedAt: latestVersion !== null ? (raw.time?.[latestVersion] ?? null) : null,
    deprecated: latestVersion !== null ? Boolean(raw.versions?.[latestVersion]?.deprecated) : false,
  };
}

// Returns null on a 404 -- the package genuinely does not exist, or was
// unpublished, which is a fact worth telling apart from "the network is
// unreachable." Any other failure (a timeout, a 5xx after retries, a
// malformed response) throws, so the caller's degrade-on-failure wrapper
// can tell "confirmed absent" from "could not check."
export async function fetchPackument(name: string, options: FetchOptions = {}): Promise<Packument | null> {
  const registry = options.registry ?? DEFAULT_REGISTRY;
  try {
    const payload = await fetchJson(`${registry}/${encodeURIComponent(name)}`, options);
    return readPackument(payload);
  } catch (err) {
    if ((err as Error & { status?: number }).status === 404) {
      return null;
    }
    throw err;
  }
}
