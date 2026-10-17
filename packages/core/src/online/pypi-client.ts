// The PyPI JSON API client: does a project exist on PyPI, yes or no, and
// otherwise throw so the caller degrades.
//
// GET https://pypi.org/pypi/<normalised>/json through the shared fetchJson
// with the scan defaults (two attempts, five seconds each, the caller's
// backoff cap) and redirect: 'manual'. The base URL is a module constant;
// FetchOptions.pypiApi overrides it for tests only, the way `registry` does
// for the npm client, and no config key or flag reaches it.
//
// What each answer vouches for:
//
//   404                                   the project does not exist
//   2xx, a JSON object whose info.name    the project exists
//     normalises to the requested name
//   anything else                         throws: not checked
//
// A 2xx vouches only that a project of that name exists. It says nothing
// about whether it is the project the author meant, whether it is safe, or
// whether any release is installable (a project whose every release is
// yanked still answers 2xx). A 2xx naming another project, or no project at
// all, is never read as "exists": it is a response this client did not ask
// for. A 3xx is not followed, since the canonical URL of a normalised name
// should not redirect and following one lets somewhere else answer.

import { normalizePypiName } from '../python-names.js';
import { fetchJson, type FetchOptions } from './http.js';

export const PYPI_JSON_API = 'https://pypi.org/pypi';

export type PypiAnswer = 'exists' | 'absent';

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

export async function fetchPypiProject(name: string, options: FetchOptions = {}): Promise<PypiAnswer> {
  const base = options.pypiApi ?? PYPI_JSON_API;
  const url = `${base}/${encodeURIComponent(name)}/json`;
  let payload: unknown;
  try {
    payload = await fetchJson(url, { ...options, redirect: 'manual' });
  } catch (err) {
    const status = statusOf(err);
    if (status === 404) {
      return 'absent';
    }
    if (status !== undefined && status >= 300 && status < 400) {
      throw new Error(`PyPI answered ${status}, a redirect, which is not followed`);
    }
    // By name, not instanceof: the body parser can raise a SyntaxError
    // from another realm than this module's.
    if ((err as Error | null)?.name === 'SyntaxError') {
      throw new Error('unexpected response: the body is not JSON');
    }
    throw err;
  }
  const info =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { info?: unknown }).info
      : undefined;
  const answered =
    info !== null && typeof info === 'object' ? (info as { name?: unknown }).name : undefined;
  if (typeof answered !== 'string' || normalizePypiName(answered) !== name) {
    throw new Error('unexpected response: the body does not describe the project that was asked for');
  }
  return 'exists';
}
