import { jest } from '@jest/globals';
import type { PypiCandidate } from '../src/checks/candidates.js';
import type { CheckContext } from '../src/checks/types.js';
import { createOnlineDeadline, sumDeadlineSkipped } from '../src/online/deadline.js';
import { fetchPypiProject } from '../src/online/pypi-client.js';
import { checkPypiExistence, pypiLookupOrder } from '../src/online/pypi-existence.js';
import type { Diagnostic } from '../src/types.js';

type FetchImpl = typeof fetch;

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fetchSequence(...answers: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let index = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (next === undefined) {
      throw new Error('no answer');
    }
    return next();
  }) as FetchImpl;
  return { impl, calls };
}

const NO_SLEEP = { sleepImpl: async () => {}, random: () => 0 };

describe('fetchPypiProject', () => {
  test('asks the JSON API for the normalised name, with redirect: manual', async () => {
    const fake = fetchSequence(() => response(200, { info: { name: 'python-dateutil' } }));
    await expect(fetchPypiProject('python-dateutil', { fetchImpl: fake.impl, ...NO_SLEEP })).resolves.toBe('exists');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe('https://pypi.org/pypi/python-dateutil/json');
    expect(fake.calls[0]?.init?.redirect).toBe('manual');
  });

  test('a 2xx whose info.name normalises to the request is exists', async () => {
    const fake = fetchSequence(() => response(200, { info: { name: 'Python_Dateutil' } }));
    await expect(fetchPypiProject('python-dateutil', { fetchImpl: fake.impl, ...NO_SLEEP })).resolves.toBe('exists');
  });

  test('a 404 is absent', async () => {
    const fake = fetchSequence(() => response(404, { message: 'Not Found' }));
    await expect(fetchPypiProject('reqeusts', { fetchImpl: fake.impl, ...NO_SLEEP })).resolves.toBe('absent');
  });

  test('a 2xx naming another project throws, never counted as exists', async () => {
    const fake = fetchSequence(() => response(200, { info: { name: 'requests' } }));
    await expect(fetchPypiProject('reqeusts', { fetchImpl: fake.impl, ...NO_SLEEP })).rejects.toThrow(
      'unexpected response'
    );
  });

  test.each([
    ['no info.name', { info: {} }],
    ['not an object', [1, 2]],
  ])('a 2xx with %s throws', async (_label, body) => {
    const fake = fetchSequence(() => response(200, body));
    await expect(fetchPypiProject('x', { fetchImpl: fake.impl, ...NO_SLEEP })).rejects.toThrow('unexpected response');
  });

  test('a 2xx that is not JSON throws unexpected response', async () => {
    const fake = fetchSequence(() => response(200, '<html>'));
    await expect(fetchPypiProject('x', { fetchImpl: fake.impl, ...NO_SLEEP })).rejects.toThrow('unexpected response');
  });

  test('a 3xx is not followed: one request, and it throws naming the status', async () => {
    const fake = fetchSequence(() =>
      response(301, '', { location: 'https://elsewhere.example/pypi/python-dateutil/json' })
    );
    await expect(fetchPypiProject('python-dateutil', { fetchImpl: fake.impl, ...NO_SLEEP })).rejects.toThrow('301');
    expect(fake.calls.map((call) => call.url)).toEqual(['https://pypi.org/pypi/python-dateutil/json']);
    // The platform fetch follows a redirect unless told not to, so the
    // one-request property rests on this option being passed.
    expect(fake.calls[0]?.init?.redirect).toBe('manual');
  });

  test('two 503s: one retry, then it throws', async () => {
    const fake = fetchSequence(
      () => response(503, 'down'),
      () => response(503, 'down')
    );
    await expect(fetchPypiProject('x', { fetchImpl: fake.impl, ...NO_SLEEP })).rejects.toThrow('503');
    expect(fake.calls).toHaveLength(2);
  });

  test.each([410, 403, 400])('a %i is not absent: it throws', async (status) => {
    const fake = fetchSequence(() => response(status, 'no'));
    await expect(fetchPypiProject('x', { fetchImpl: fake.impl, ...NO_SLEEP })).rejects.toThrow(String(status));
  });
});

function candidate(name: string, anchorPath = 'requirements.txt', source: 'manifest' | 'lockfile' = 'manifest'): PypiCandidate {
  return { name, written: name, anchorPath, source, specifier: '*', depType: 'dependencies', recordedOrigin: null };
}

function ctx(overrides: Partial<CheckContext['config']> = {}): CheckContext {
  return {
    corpus: {} as CheckContext['corpus'],
    config: {
      failOn: 'medium',
      allow: [],
      internalScopes: [],
      internalPrefixes: [],
      extraAliases: {},
      ignorePaths: [],
      online: true,
      minAgeDays: 0,
      minAgeAllow: [],
      ...overrides,
    },
    delta: {
      changes: [],
      lockEntryChanges: [],
      onlyBuiltAdded: [],
      lockfileFormat: 'none',
      diagnostics: [],
      hasComparisonBase: false,
      workspaceLocalNames: new Set(),
    },
    npmrcRegistryPins: new Map(),
    diagnostics: [],
    allowed: [],
  };
}

describe('checkPypiExistence: lookup outcomes', () => {
  test('a 404 gives one critical with the stated message and details', async () => {
    const diagnostics: Diagnostic[] = [];
    const result = await checkPypiExistence(
      [candidate('reqeusts')],
      ctx(),
      null,
      { fetchPypiProject: async () => 'absent' },
      diagnostics,
      createOnlineDeadline(20_000)
    );
    expect(result.findings).toEqual([
      {
        ruleId: 'unknown-package',
        severity: 'critical',
        packageName: 'reqeusts',
        manifestPath: 'requirements.txt',
        message:
          '"reqeusts" does not exist on PyPI: the PyPI JSON API was queried for the project "reqeusts" and ' +
          'answered 404. A name that is on no index this repository declares cannot be installed from it, so ' +
          'this is a hallucinated or mistyped dependency, or a project PyPI has removed.',
        details: {
          ecosystem: 'pypi',
          writtenName: 'reqeusts',
          onlineResolution: 'registry-absent',
          specifier: '*',
          depType: 'dependencies',
          source: 'manifest',
        },
      },
    ]);
    expect(result.stats.existenceChecked).toBe(1);
  });

  test('a 2xx gives nothing', async () => {
    const result = await checkPypiExistence(
      [candidate('flask')],
      ctx(),
      null,
      { fetchPypiProject: async () => 'exists' },
      [],
      createOnlineDeadline(20_000)
    );
    expect(result.findings).toEqual([]);
    expect(result.stats.existenceChecked).toBe(1);
  });

  test('a thrown fetch is unreachable: no finding, one diagnostic, never a 404', async () => {
    const diagnostics: Diagnostic[] = [];
    const result = await checkPypiExistence(
      [candidate('flask')],
      ctx(),
      null,
      {
        fetchPypiProject: async () => {
          throw new Error('request failed: 503');
        },
      },
      diagnostics,
      createOnlineDeadline(20_000)
    );
    expect(result.findings).toEqual([]);
    expect(result.stats.unreachable).toBe(1);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'online-check-unreachable', message: expect.stringContaining('pypi existence') }),
    ]);
  });

  test('a written name that differs is shown once with its PyPI project', async () => {
    const result = await checkPypiExistence(
      [{ ...candidate('python-dateutil-x'), written: 'Python_Dateutil_X' }],
      ctx(),
      null,
      { fetchPypiProject: async () => 'absent' },
      [],
      createOnlineDeadline(20_000)
    );
    expect(result.findings[0]?.message.startsWith('"Python_Dateutil_X" (PyPI project "python-dateutil-x") does not exist')).toBe(true);
  });

  test('one lookup per normalised name, one finding per anchor', async () => {
    const fetch = jest.fn(async (_name: string) => 'absent' as const);
    const result = await checkPypiExistence(
      [candidate('absent-x', 'a/requirements.txt'), candidate('absent-x', 'b/requirements.txt')],
      ctx(),
      null,
      { fetchPypiProject: fetch },
      [],
      createOnlineDeadline(20_000)
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.findings.map((finding) => finding.manifestPath)).toEqual(['a/requirements.txt', 'b/requirements.txt']);
  });
});

describe('checkPypiExistence: budget exhausted mid-ecosystem', () => {
  test('the deadline expires after two lookups: two fetches, the other three named in lookup order', async () => {
    let now = 0;
    const deadline = createOnlineDeadline(1_000, () => now);
    const fetched: string[] = [];
    const diagnostics: Diagnostic[] = [];
    const result = await checkPypiExistence(
      ['e-name', 'd-name', 'c-name', 'b-name', 'a-name'].map((name) => candidate(name)),
      ctx(),
      null,
      {
        fetchPypiProject: async (name) => {
          fetched.push(name);
          now += 600;
          return 'absent';
        },
      },
      diagnostics,
      deadline
    );
    expect(fetched).toEqual(['a-name', 'b-name']);
    expect(result.findings.map((finding) => finding.packageName)).toEqual(['a-name', 'b-name']);
    expect(result.stats).toEqual(expect.objectContaining({ existenceChecked: 2, budget: 3 }));
    const deadlineNote = diagnostics.find((entry) => entry.code === 'online-deadline-exceeded');
    expect(deadlineNote?.message).toContain('pypi existence');
    expect(deadlineNote?.message).toContain(
      'those names were not checked for existence on PyPI: c-name, d-name, e-name'
    );
    expect(sumDeadlineSkipped(diagnostics)).toBe(3);
  });
});

describe('pypiLookupOrder', () => {
  test('manifest names first, then lockfile-only names, each by anchor path then name', () => {
    const ordered = pypiLookupOrder([
      candidate('z', 'uv.lock', 'lockfile'),
      candidate('b', 'b/requirements.txt'),
      candidate('a', 'uv.lock', 'lockfile'),
      candidate('c', 'a/requirements.txt'),
      candidate('a', 'b/requirements.txt'),
    ]);
    expect(ordered.map((entry) => `${entry.anchorPath}:${entry.name}`)).toEqual([
      'a/requirements.txt:c',
      'b/requirements.txt:a',
      'b/requirements.txt:b',
      'uv.lock:a',
      'uv.lock:z',
    ]);
  });
});
