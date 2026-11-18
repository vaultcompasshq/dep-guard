import type { CheckContext, ResolvedConfig } from '../src/checks/types.js';
import type { Corpus } from '../src/corpus.js';
import type { LockEntryChange } from '../src/delta.js';
import { existenceCheck } from '../src/checks/existence.js';

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

function context(noRepoControls: boolean): CheckContext {
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
    diagnostics: [],
    allowed: [],
  };
}

// The per-check private-name filters these tests covered were removed: under
// --no-repo-controls --online is refused before any repository work, so no
// online check runs at all (no-repo-controls-scan.test.ts, refuses online).

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
