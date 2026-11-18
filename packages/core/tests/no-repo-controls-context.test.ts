import type { CheckContext, ResolvedConfig } from '../src/checks/types.js';
import type { Corpus } from '../src/corpus.js';
import type { LockEntryChange } from '../src/delta.js';
import { createOnlineDeadline } from '../src/online/deadline.js';
import { existenceCheck } from '../src/checks/existence.js';
import { findPublishAgeFindings } from '../src/online/publish-age.js';
import { findRegisteredSquats } from '../src/online/registered-squat.js';
import { checkPypiExistence } from '../src/online/pypi-existence.js';

const CORPUS: Corpus = {
  hasName: () => true,
  topRank: () => null,
  aliasTargets: () => [],
  topNames: [],
  builtAt: 'test',
};

const CONFIG: ResolvedConfig = {
  failOn: 'medium',
  allow: [],
  internalScopes: [],
  internalPrefixes: [],
  extraAliases: {},
  ignorePaths: [],
  online: true,
  minAgeDays: 7,
  minAgeAllow: [],
};

function context(
  noRepoControls: boolean,
  declined: Array<{ path: string; reason: string; line?: number }> = []
): CheckContext {
  const entry: LockEntryChange = {
    name: 'example',
    packageName: 'example',
    kind: 'added',
    manifestPath: 'package.json',
    lockfilePath: 'package-lock.json',
    after: {
      version: '1.0.0',
      resolvedUrl: 'https://repository.invalid/example-1.0.0.tgz',
      lookupName: 'decoy-name',
    },
  };
  return {
    corpus: CORPUS,
    config: CONFIG,
    delta: {
      changes: [],
      lockEntryChanges: [entry],
      onlyBuiltAdded: [],
      lockfileFormat: 'npm',
      hasComparisonBase: false,
      workspaceLocalNames: new Set(),
      diagnostics: [],
    },
    npmrcRegistryPins: new Map(),
    npmrcDefaultRegistry: null,
    ...(noRepoControls ? { noRepoControls: true } : {}),
    ...(noRepoControls ? { recordNotScanned: (entry) => declined.push(entry) } : {}),
    diagnostics: [],
    allowed: [],
  };
}

test('a non-public lockfile host is never sent for publish age under no-repo-controls', async () => {
  const ordinary = context(false);
  const ordinaryCalls: string[] = [];
  const ordinaryFindings = await findPublishAgeFindings(
    ordinary,
    { fetchPackument: async (name) => (ordinaryCalls.push(name), { versionTimes: {} }) },
    ordinary.diagnostics,
    createOnlineDeadline(Number.POSITIVE_INFINITY, () => 0)
  );
  expect(ordinaryFindings).toEqual([]);
  expect(ordinaryCalls).toEqual([]);

  const declined: Array<{ path: string; reason: string; line?: number }> = [];
  const guarded = context(true, declined);
  const guardedCalls: string[] = [];
  const findings = await findPublishAgeFindings(
    guarded,
    {
      fetchPackument: async (name) => {
        guardedCalls.push(name);
        return { versionTimes: { '1.0.0': '2026-11-17T00:00:00.000Z' } };
      },
    },
    guarded.diagnostics,
    createOnlineDeadline(Number.POSITIVE_INFINITY, () => 0),
    () => Date.parse('2026-11-18T00:00:00.000Z')
  );

  expect(guardedCalls).toEqual([]);
  expect(findings).toEqual([]);
  expect(declined).toEqual([
    expect.objectContaining({
      path: 'package-lock.json',
      reason: expect.stringContaining('example'),
    }),
  ]);
});

test('a whole-HEAD name from a non-public resolution is not sent for registered-squat', async () => {
  const ordinary = context(false);
  const ordinaryCalls: string[] = [];
  expect(
    await findRegisteredSquats(
      ordinary,
      {
        fetchWeeklyDownloads: async (names) => {
          ordinaryCalls.push(...names);
          return { counts: new Map([['example', 0]]), noRecord: new Set() };
        },
        fetchPackument: async () => ({ createdAt: '2026-11-17T00:00:00.000Z' }),
      },
      ordinary.diagnostics,
      createOnlineDeadline(Number.POSITIVE_INFINITY, () => 0)
    )
  ).toEqual([]);
  expect(ordinaryCalls).toEqual([]);

  const declined: Array<{ path: string; reason: string; line?: number }> = [];
  const guarded = context(true, declined);
  const guardedCalls: string[] = [];
  const findings = await findRegisteredSquats(
    guarded,
    {
      fetchWeeklyDownloads: async (names) => {
        guardedCalls.push(...names);
        return { counts: new Map([['example', 0]]), noRecord: new Set() };
      },
      fetchPackument: async () => ({ createdAt: '2026-11-17T00:00:00.000Z' }),
    },
    guarded.diagnostics,
    createOnlineDeadline(Number.POSITIVE_INFINITY, () => 0),
    () => Date.parse('2026-11-18T00:00:00.000Z')
  );

  expect(guardedCalls).toEqual([]);
  expect(findings).toEqual([]);
  expect(declined).toEqual([
    expect.objectContaining({
      path: 'package-lock.json',
      reason: expect.stringContaining('example'),
    }),
  ]);
});

test('a non-public Python lock source is not sent to PyPI under no-repo-controls', async () => {
  const declined: Array<{ path: string; reason: string; line?: number }> = [];
  const guarded = context(true, declined);
  const calls: string[] = [];
  const result = await checkPypiExistence(
    [
      {
        name: 'internal-python-package',
        written: 'internal-python-package',
        anchorPath: 'uv.lock',
        lockfilePath: 'uv.lock',
        source: 'lockfile',
        specifier: '==1.0.0',
        depType: 'dependencies',
        recordedOrigin: 'https://python.invalid/simple',
      },
      {
        name: 'internal-python-package',
        written: 'internal-python-package',
        anchorPath: 'requirements.txt',
        source: 'manifest',
        specifier: '==1.0.0',
        depType: 'dependencies',
        recordedOrigin: null,
      },
    ],
    guarded,
    null,
    { fetchPypiProject: async (name) => (calls.push(name), 'exists') },
    guarded.diagnostics,
    createOnlineDeadline(Number.POSITIVE_INFINITY, () => 0)
  );

  expect(calls).toEqual([]);
  expect(result.findings).toEqual([]);
  expect(declined).toEqual([
    expect.objectContaining({
      path: 'uv.lock',
      reason: expect.stringContaining('internal-python-package'),
    }),
  ]);
});

test('an alias edge and neighboring name field cannot remove the lockfile key', () => {
  const ordinary = context(false);
  ordinary.corpus = { ...CORPUS, hasName: (name) => name === 'lodash' };
  ordinary.delta.lockEntryChanges = [
    {
      name: 'reeact-definitely-not-real',
      packageName: 'lodash',
      kind: 'added',
      manifestPath: 'package-lock.json',
      lockfilePath: 'package-lock.json',
      lockfileFormat: 'npm',
      aliasTargets: ['lodash'],
      after: {
        version: '1.0.0',
        nameField: 'lodash',
        lookupName: 'lodash',
        resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-1.0.0.tgz',
      },
    },
  ];
  expect(existenceCheck(ordinary)).toEqual([]);

  const guarded = { ...ordinary, noRepoControls: true, diagnostics: [], allowed: [] };
  expect(existenceCheck(guarded)).toEqual([
    expect.objectContaining({
      packageName: 'reeact-definitely-not-real',
      details: expect.objectContaining({ repositoryContext: expect.any(Object) }),
    }),
  ]);
});
