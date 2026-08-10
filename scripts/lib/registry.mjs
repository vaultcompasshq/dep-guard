// The HTTP half of the corpus builder: a small, deliberately polite client
// for the public npm registry replica.
//
// This talks to infrastructure somebody else pays for, and a full walk is
// four hundred and some requests in a row. So: one request in flight at a
// time (the walk is a chain -- each page's start key comes out of the
// previous page, so there is nothing to parallelise anyway), a descriptive
// user agent with a link to the project, a pause between pages, backoff
// that honours Retry-After when the server sends one, and a state file that
// makes a failed run resumable rather than restartable.

export const USER_AGENT =
  'dep-guard-corpus-builder/0.1 (+https://github.com/vaultcompasshq/dep-guard)';

export const DEFAULT_REPLICA = 'https://replicate.npmjs.com';
export const DEFAULT_DOWNLOADS_API = 'https://api.npmjs.org';

// Retried: a transport failure, a rate limit, and anything the server calls
// its own fault. Not retried: a 4xx that is not 429, because asking again
// for something we were told is wrong is how a polite client becomes an
// impolite one.
export function isRetryableStatus(status) {
  return status === 429 || status === 408 || status >= 500;
}

// Exponential, capped, with jitter -- the jitter matters less here than in
// a fleet (there is one client) but it costs nothing and keeps a retry from
// landing on a whole-second boundary alongside every other tool doing the
// same thing. A server that tells us how long to wait is believed, up to
// the cap, because it knows and we do not.
export function backoffDelayMs(attempt, retryAfterSeconds, random = Math.random) {
  const CAP_MS = 60_000;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(CAP_MS, Math.ceil(retryAfterSeconds * 1000));
  }
  const base = Math.min(CAP_MS, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.5 + random() * 0.5));
}

export function parseRetryAfter(headerValue) {
  if (typeof headerValue !== 'string' || headerValue.trim().length === 0) {
    return null;
  }
  const seconds = Number(headerValue.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }
  const at = Date.parse(headerValue);
  if (Number.isNaN(at)) {
    return null;
  }
  return Math.max(0, (at - Date.now()) / 1000);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchJson(url, options = {}) {
  const {
    attempts = 5,
    timeoutMs = 120_000,
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    random = Math.random,
    onRetry = () => {},
  } = options;

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response = null;
    try {
      response = await fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError = err;
    }

    if (response !== null) {
      if (response.ok) {
        return await response.json();
      }
      if (!isRetryableStatus(response.status)) {
        throw new Error(`request failed: ${response.status} ${response.statusText} for ${url}`);
      }
      lastError = new Error(`request failed: ${response.status} ${response.statusText}`);
    }

    if (attempt === attempts) {
      break;
    }
    const retryAfter =
      response === null ? null : parseRetryAfter(response.headers?.get?.('retry-after'));
    const delayMs = backoffDelayMs(attempt, retryAfter, random);
    onRetry({ attempt, delayMs, reason: lastError?.message ?? 'unknown' });
    await sleepImpl(delayMs);
  }

  throw new Error(
    `giving up on ${url} after ${attempts} attempt(s): ${lastError?.message ?? 'unknown error'}`
  );
}

export async function fetchReplicaInfo(base, options) {
  return await fetchJson(`${base}/`, options);
}

// CouchDB's _all_docs is inclusive of startkey, so a page fetched from the
// previous page's last key repeats that key. Dropping it here rather than
// using skip=1 keeps the request to parameters every replica supports.
export async function fetchAllDocsPage(base, { startKey, limit }, options) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (startKey !== null && startKey !== undefined) {
    params.set('startkey', JSON.stringify(startKey));
  }
  const page = await fetchJson(`${base}/_all_docs?${params.toString()}`, options);
  const rows = Array.isArray(page.rows) ? page.rows : [];
  const ids = [];
  for (const row of rows) {
    const id = row?.id;
    if (typeof id !== 'string' || id.length === 0) {
      continue;
    }
    if (id === startKey) {
      continue; // the inclusive-start duplicate
    }
    // Design documents are CouchDB's own machinery, not package names.
    if (id.startsWith('_design/')) {
      continue;
    }
    ids.push(id);
  }
  const lastRowId = rows.length > 0 ? rows[rows.length - 1]?.id : null;
  return { ids, lastKey: typeof lastRowId === 'string' ? lastRowId : null, rowCount: rows.length };
}

export async function fetchChangesPage(base, { since, limit }, options) {
  const params = new URLSearchParams({ since: String(since), limit: String(limit) });
  const page = await fetchJson(`${base}/_changes?${params.toString()}`, options);
  const results = Array.isArray(page.results) ? page.results : [];
  const changed = [];
  const deleted = [];
  for (const entry of results) {
    const id = entry?.id;
    if (typeof id !== 'string' || id.length === 0 || id.startsWith('_design/')) {
      continue;
    }
    if (entry.deleted === true) {
      deleted.push(id);
    } else {
      changed.push(id);
    }
  }
  return { changed, deleted, lastSeq: page.last_seq ?? since, resultCount: results.length };
}

// The downloads API takes up to 128 comma-separated names per request and
// answers with a per-name object. Scoped names have to go one at a time --
// the bulk endpoint does not accept a slash -- which is why they are
// filtered out here rather than silently returning zero for each.
export const DOWNLOADS_BATCH_SIZE = 128;

export function splitDownloadBatches(names, batchSize = DOWNLOADS_BATCH_SIZE) {
  const batches = [];
  const bulkable = names.filter((name) => !name.startsWith('@'));
  for (let index = 0; index < bulkable.length; index += batchSize) {
    batches.push(bulkable.slice(index, index + batchSize));
  }
  return batches;
}

export function readDownloadCounts(payload, requested) {
  const counts = new Map();
  if (payload === null || typeof payload !== 'object') {
    return counts;
  }
  // A single-name request answers with the record itself; a bulk request
  // answers with a name-keyed map whose values may be null for a name the
  // API has no data for.
  if (typeof payload.downloads === 'number' && requested.length === 1) {
    counts.set(requested[0], payload.downloads);
    return counts;
  }
  for (const [name, record] of Object.entries(payload)) {
    if (record !== null && typeof record?.downloads === 'number') {
      counts.set(name, record.downloads);
    }
  }
  return counts;
}
