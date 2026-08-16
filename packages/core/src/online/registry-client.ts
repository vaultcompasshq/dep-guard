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
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function parseRetryAfter(headerValue: string | null): number | null {
  if (headerValue === null) {
    return null;
  }
  const seconds = Number(headerValue);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function backoffDelayMs(attempt: number, retryAfterSeconds: number | null, random: () => number): number {
  if (retryAfterSeconds !== null) {
    return retryAfterSeconds * 1000;
  }
  const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
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
  } = options;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response | null = null;
    try {
      response = (await fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
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
    await sleepImpl(backoffDelayMs(attempt, retryAfter, random));
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

function readDownloadCounts(payload: unknown, requested: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (payload === null || typeof payload !== 'object') {
    return counts;
  }
  const record = payload as Record<string, unknown>;
  // A single-name request answers with the record itself; a bulk request
  // answers with a name-keyed map whose values may be null for a name the
  // API has no data for.
  if (typeof record.downloads === 'number' && requested.length === 1) {
    counts.set(requested[0], record.downloads);
    return counts;
  }
  for (const [name, entry] of Object.entries(record)) {
    if (entry !== null && typeof entry === 'object' && typeof (entry as { downloads?: unknown }).downloads === 'number') {
      counts.set(name, (entry as { downloads: number }).downloads);
    }
  }
  return counts;
}

export async function fetchWeeklyDownloads(
  names: string[],
  options: FetchOptions = {}
): Promise<Map<string, number>> {
  const downloadsApi = options.downloadsApi ?? DEFAULT_DOWNLOADS_API;
  const counts = new Map<string, number>();

  for (const batch of splitDownloadBatches(names)) {
    const url = `${downloadsApi}/downloads/point/last-week/${batch.join(',')}`;
    const payload = await fetchJson(url, options);
    for (const [name, count] of readDownloadCounts(payload, batch)) {
      counts.set(name, count);
    }
  }

  for (const name of names.filter((n) => n.startsWith('@'))) {
    const url = `${downloadsApi}/downloads/point/last-week/${encodeURIComponent(name)}`;
    const payload = await fetchJson(url, options);
    for (const [key, count] of readDownloadCounts(payload, [name])) {
      counts.set(key, count);
    }
  }

  return counts;
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
