// The one JSON fetch every online check shares, with tight, scan-appropriate
// defaults: a live scan (a pre-commit hook, a CI step, an MCP propose-time
// call) has to fail fast and degrade rather than hang, per
// docs/INVARIANTS.md's rule that online checks are the one deliberate
// exception to failing closed -- a network problem degrades to the offline
// result with a diagnostic, never blocks.
//
// Kept in its own module, and re-exported from registry-client.ts, so the
// PyPI client (pypi-client.ts) and the npm client share it without one
// importing the other: a test that substitutes the npm client module does
// not take the PyPI client's transport away with it.

export const USER_AGENT = 'dep-guard (+https://github.com/vaultcompasshq/dep-guard)';

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
  // The PyPI JSON API base (pypi-client.ts). Overridable here for tests
  // only, the way `registry` is; no config key and no flag reach it.
  pypiApi?: string;
  userAgent?: string;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  // Overrides BACKOFF_CAP_MS for both the exponential ladder and a
  // server-supplied Retry-After. The corpus builder's patient batch jobs
  // want the full 60s (and pass nothing, keeping the default); a live scan
  // (a pre-commit hook, a CI step, an MCP propose-time call) reaches
  // latency-sensitive callers and needs a much tighter ceiling so a single
  // slow or rate-limited name cannot stall it for minutes.
  backoffCapMs?: number;
  // Passed to fetch as-is. The PyPI client sets 'manual': after
  // normalisation the canonical URL should not redirect, and following one
  // lets a response from somewhere else answer the question. A 3xx then
  // arrives here as a non-retryable status and throws with that status.
  redirect?: RequestRedirect;
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

// The per-attempt timeout covers reading the body, not only the headers:
// the same AbortSignal is passed to the request and is still live while
// response.json() reads the stream, so a slow multi-megabyte body times out
// like a slow connect does.
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
    redirect,
  } = options;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response | null = null;
    try {
      response = (await fetchImpl(url, {
        headers: { 'user-agent': userAgent, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        ...(redirect === undefined ? {} : { redirect }),
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

  // The last status rides along, so a caller can say which answer it gave
  // up on (a 503, a 429). Never a 404: that status is not retried.
  const status = (lastError as { status?: unknown } | null)?.status;
  throw Object.assign(
    new Error(`giving up on ${url} after ${attempts} attempt(s): ${lastError?.message ?? 'unknown error'}`),
    typeof status === 'number' ? { status } : {}
  );
}
