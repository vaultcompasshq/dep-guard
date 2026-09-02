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

export const DEFAULT_REPLICA = 'https://replicate.npmjs.com';
export const DEFAULT_DOWNLOADS_API = 'https://api.npmjs.org';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

// Passed as fetchJson's userAgent option (core's FetchOptions.userAgent,
// which defaults to core's own generic USER_AGENT otherwise) so a walk
// still identifies itself as this specific tool rather than as core's
// generic online-check client.
export const USER_AGENT =
  'dep-guard-corpus-builder/0.1 (+https://github.com/vaultcompasshq/dep-guard)';

// fetchJson, DOWNLOADS_BATCH_SIZE and readDownloadCounts now live in
// packages/core/src/online/registry-client.ts, imported from the built
// output here rather than duplicated -- the same shape as the corpus
// builder already imports BloomFilter from the built core instead of
// reimplementing it. This script calls fetchJson with its own patient
// options (more attempts, a much longer timeout) explicitly, since core's
// own defaults are now tuned tight for a live scan, not a batch job.
//
// readDownloadCounts used to be a second copy here with an old,
// un-intersected loop: it read every key Object.entries(payload) offered,
// where core's version (which this file now imports instead) intersects
// the response against the requested batch, so a response key the caller
// never asked about can never be reported. Recorded as not-exploitable
// for this file's own consumer (scripts/lib/top-list.mjs looks up results
// by requested name), but a drift trap regardless, and now there is only
// one implementation to keep correct. Its return shape is
// { counts, noRecord } rather than a bare Map -- see DownloadCountsResult
// in registry-client.ts -- so top-list.mjs reads the `.counts` Map out of
// it; it has never needed `noRecord`, which exists for fetchWeeklyDownloads'
// live-scan callers to tell "no data" apart from "not yet answered".
//
// Imported (not just re-exported) because fetchReplicaInfo, fetchAllDocsPage,
// fetchChangesPage and fetchSearchPage below call fetchJson themselves --
// an `export { fetchJson } from '...'` re-export alone creates no local
// binding, which the functions in this file need.
import {
  fetchJson,
  DOWNLOADS_BATCH_SIZE,
  readDownloadCounts,
} from '../../packages/core/dist/online/registry-client.js';

export { fetchJson, DOWNLOADS_BATCH_SIZE, readDownloadCounts };

// splitDownloadBatches stays a local duplicate rather than an import: core
// keeps its own copy private (an internal helper of fetchWeeklyDownloads,
// not exported from registry-client.ts), and duplicating six lines of pure
// list-splitting here is cheaper than widening core's public surface for
// this one caller. Unlike fetchJson's retry and backoff policy, there is
// no decision logic here that can drift silently.
export function splitDownloadBatches(names, batchSize = DOWNLOADS_BATCH_SIZE) {
  const batches = [];
  // The bulk downloads endpoint refuses a slash, so a scoped name has no
  // bulk form at all -- it is filtered out here and measured one at a time
  // by the caller, rather than silently returning zero for each.
  const bulkable = names.filter((name) => !name.startsWith('@'));
  for (let index = 0; index < bulkable.length; index += batchSize) {
    batches.push(bulkable.slice(index, index + batchSize));
  }
  return batches;
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

// The registry's own search endpoint, asked for a popularity-ordered page.
// Two things make it worth talking to at all, given that it is rate limited
// far harder than the replica: it answers with two hundred and fifty
// packages per request where the downloads API answers with one for a
// scoped name, and it reports npm's own weekly download figure inline. That
// figure is used to decide which names are worth spending a verification
// request on. It is never used as the verification: what earns a name its
// place is the downloads API answering for it directly.
//
// popularity=1.0 with quality and maintenance at zero asks the ranker to
// order purely by how much a package is used, which is the axis this list
// cares about. A package that is unmaintained but universally installed is
// still a name people type.
export const SEARCH_PAGE_SIZE = 250;

export function readSearchPage(payload) {
  const objects = Array.isArray(payload?.objects) ? payload.objects : [];
  const rows = [];
  for (const entry of objects) {
    const name = entry?.package?.name;
    if (typeof name !== 'string' || name.length === 0) {
      continue;
    }
    const weekly = entry?.downloads?.weekly;
    rows.push({ name, weekly: typeof weekly === 'number' ? weekly : null });
  }
  return rows;
}

export async function fetchSearchPage(base, { text, from, size = SEARCH_PAGE_SIZE }, options) {
  const params = new URLSearchParams({
    text,
    size: String(size),
    from: String(from),
    popularity: '1.0',
    quality: '0.0',
    maintenance: '0.0',
  });
  const payload = await fetchJson(`${base}/-/v1/search?${params.toString()}`, options);
  return readSearchPage(payload);
}
