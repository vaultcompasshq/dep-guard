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
//  - present in `noRecord`: npm answered successfully (a 200) and said,
//    explicitly, that it has no download record for this exact name -- a
//    null entry in a bulk response body. This is a confirmed fact, not a
//    gap: a consumer that wants "no data recorded" to mean zero downloads
//    reads this set, not merely a missing key in `counts`.
//  - absent from both: the name's status is unknown. The only way to land
//    here today is a swallowed single-name 404 (see fetchDownloadCounts),
//    which is ambiguous between "npm has genuinely never seen this name"
//    and a structural failure (a misconfigured downloadsApi, an endpoint
//    change) that a real "no record" 200 response could never produce. A
//    consumer must treat this the same as if the name had never been
//    asked about at all -- never as a confirmed zero -- or a broken
//    downloadsApi would silently mint a finding for every single-name
//    lookup instead of surfacing as online-check-unreachable.
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
  for (const [name, entry] of Object.entries(record)) {
    if (entry !== null && typeof entry === 'object' && typeof (entry as { downloads?: unknown }).downloads === 'number') {
      counts.set(name, (entry as { downloads: number }).downloads);
    } else if (entry === null) {
      noRecord.add(name);
    }
  }
  return { counts, noRecord };
}

// A 404 from a single-name (point-form) lookup is swallowed to "unknown"
// rather than propagated or trusted as a confirmed no-record answer,
// because it is genuinely ambiguous in a way a bulk response's explicit
// null entry is not: npm's real behaviour for a name it has never seen IS
// a 404 here, but so is a misconfigured downloadsApi, an endpoint path
// change, or (before the encodeURIComponent fix below) a URL-unsafe name
// reaching an unencoded path segment -- and unlike the multi-name bulk
// case just below, there is no cheap structural tell (like "a bulk
// endpoint never 404s") to separate them from inside this function. Prior
// to the zero-download-blindness fix, collapsing both into "omit this
// name" was safe either way, because an omitted name only ever meant
// "skip" to a caller. Now that an omitted name can mean "treat as zero
// downloads", conflating the two would let a broken downloadsApi silently
// mint a finding for every single-name candidate instead of surfacing as
// online-check-unreachable -- so a swallowed 404 deliberately lands in
// neither `counts` nor `noRecord`: unresolved, not a signal. See
// DownloadCountsResult.
//
// This is gated on requested.length === 1 on purpose: a real bulk request
// (more than one unscoped name) never answers 404 for an unknown name --
// the bulk endpoint returns those as null entries inside a 200 -- so a 404
// on a multi-name request means something else entirely and has to
// propagate rather than be swallowed as "omit every name in the batch".
// Silently returning an empty result for a whole bulk batch would trade a
// loud failure for a silent one and rob the caller's degrade-on-failure
// wrapper of the online-check-unreachable diagnostic it exists to raise.
async function fetchDownloadCounts(url: string, requested: string[], options: FetchOptions): Promise<DownloadCountsResult> {
  try {
    const payload = await fetchJson(url, options);
    return readDownloadCounts(payload, requested);
  } catch (err) {
    if (requested.length === 1 && (err as Error & { status?: number }).status === 404) {
      return { counts: new Map(), noRecord: new Set() };
    }
    throw err;
  }
}

// Returns which of the requested names npm reported a real download count
// for, and which it explicitly confirmed it has no record of (see
// DownloadCountsResult for what each of those, and the third case --
// absent from both -- means). A name missing from `counts` is NOT
// interchangeable with "zero downloads": only a name in `noRecord` is a
// confirmed zero; a name in neither is unresolved (typically a swallowed
// single-name 404) and must be treated as "we don't know", never promoted
// to a signal. Every current and future caller that wants "no data
// recorded" to escalate a finding has to make that check explicitly
// against `noRecord` -- this function deliberately does not decide it.
export async function fetchWeeklyDownloads(
  names: string[],
  options: FetchOptions = {}
): Promise<DownloadCountsResult> {
  const downloadsApi = options.downloadsApi ?? DEFAULT_DOWNLOADS_API;
  const counts = new Map<string, number>();
  const noRecord = new Set<string>();

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
    const result = await fetchDownloadCounts(url, batch, options);
    for (const [name, count] of result.counts) {
      counts.set(name, count);
    }
    for (const name of result.noRecord) {
      noRecord.add(name);
    }
  }

  for (const name of names.filter((n) => n.startsWith('@'))) {
    const url = `${downloadsApi}/downloads/point/last-week/${encodeURIComponent(name)}`;
    const result = await fetchDownloadCounts(url, [name], options);
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
