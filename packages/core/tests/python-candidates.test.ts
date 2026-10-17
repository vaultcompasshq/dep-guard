import { nameEcosystemOf, newNames, newRegistryNames } from '../src/checks/candidates.js';
import type { CheckContext } from '../src/checks/types.js';
import { computeDelta } from '../src/delta.js';
import type { Protocol } from '../src/manifest.js';
import { parsePythonLockfile } from '../src/python-lockfiles.js';
import { parsePyproject, parseRequirements } from '../src/python-manifest.js';
import type { ParsedManifest } from '../src/manifest.js';
import type { RepoState } from '../src/state.js';
import type { PythonLockfile } from '../src/python-types.js';

function state(manifests: ParsedManifest[], pythonLockfiles: PythonLockfile[] = []): RepoState {
  return {
    manifests,
    lockfile: null,
    onlyBuilt: [],
    npmrcRegistryPins: new Map(),
    npmrcDefaultRegistry: null,
    workspaceLocalNames: new Set(),
    pythonLockfiles,
  };
}

function ctxFor(before: RepoState | null, after: RepoState): CheckContext {
  return {
    corpus: {} as CheckContext['corpus'],
    config: {
      failOn: 'medium',
      allow: [],
      internalScopes: [],
      internalPrefixes: [],
      extraAliases: {},
      ignorePaths: [],
      online: false,
      minAgeDays: 0,
      minAgeAllow: [],
    },
    delta: computeDelta(before, after),
    npmrcRegistryPins: new Map(),
    diagnostics: [],
    allowed: [],
  };
}

function uvLock(path: string, names: Array<[string, string]>): PythonLockfile {
  const body = ['version = 1'];
  for (const [name, version] of names) {
    body.push('[[package]]', `name = "${name}"`, `version = "${version}"`, 'source = { registry = "https://pypi.org/simple" }');
  }
  return parsePythonLockfile(path, `${body.join('\n')}\n`);
}

describe('every protocol is classified', () => {
  // Typed as a Record over Protocol, so a protocol added to manifest.ts
  // without a row here is a compile error in this test as well.
  const expected: Record<Protocol, 'npm' | 'pypi' | null> = {
    registry: 'npm',
    alias: 'npm',
    pypi: 'pypi',
    workspace: null,
    catalog: null,
    link: null,
    patch: null,
    file: null,
    git: null,
    url: null,
  };

  test.each(Object.entries(expected))('%s is classified as %s', (protocol, ecosystem) => {
    expect(nameEcosystemOf(protocol as Protocol)).toBe(ecosystem);
  });
});

describe('newNames', () => {
  test('a pypi dependency never appears in the npm list', () => {
    const after = state([parseRequirements('requirements.txt', 'reqeusts==2.31\n')]);
    const ctx = ctxFor(null, after);
    expect(newRegistryNames(ctx)).toEqual([]);
    expect(newNames(ctx).npm).toEqual([]);
    expect(newNames(ctx).pypi.map((candidate) => candidate.name)).toEqual(['reqeusts']);
  });

  test('every exclusion of the judged side is counted by class', () => {
    const after = state([
      parseRequirements(
        'requirements.txt',
        ['-e .', 'git+https://example.com/r.git#egg=r', './vendor/pkg', '--frobnicate', 'https://example.com/a.whl'].join(
          '\n'
        )
      ),
    ]);
    const excluded = newNames(ctxFor(null, after)).excluded;
    expect(excluded).toEqual(
      expect.objectContaining({ editable: 1, vcs: 1, path: 1, unrecognised: 1, url: 1, constraint: 0, self: 0 })
    );
    expect(newNames(ctxFor(null, after)).pypi).toEqual([]);
  });
});

describe('delta for Python names', () => {
  test('re-casing a name is not an added dependency', () => {
    const before = state([parseRequirements('requirements.txt', 'Flask==3.0\npython_dateutil==2.9\n')]);
    const after = state([parseRequirements('requirements.txt', 'flask==3.0\npython-dateutil==2.9\n')]);
    expect(newNames(ctxFor(before, after)).pypi).toEqual([]);
  });

  test('a version bump is not a candidate', () => {
    const before = state([parseRequirements('requirements.txt', 'flask==3.0\n')]);
    const after = state([parseRequirements('requirements.txt', 'flask==3.1\n')]);
    expect(newNames(ctxFor(before, after)).pypi).toEqual([]);
  });

  test('a new lockfile path contributes all its names, anchored to the lockfile', () => {
    const before = state([]);
    const after = state([], [uvLock('uv.lock', [['a', '1'], ['b', '2']])]);
    expect(newNames(ctxFor(before, after)).pypi.map((candidate) => [candidate.name, candidate.anchorPath, candidate.source])).toEqual([
      ['a', 'uv.lock', 'lockfile'],
      ['b', 'uv.lock', 'lockfile'],
    ]);
  });

  test('a lockfile version change is not a candidate, a new lockfile name is', () => {
    const before = state([], [uvLock('uv.lock', [['a', '1']])]);
    const after = state([], [uvLock('uv.lock', [['a', '2'], ['b', '1']])]);
    expect(newNames(ctxFor(before, after)).pypi.map((candidate) => candidate.name)).toEqual(['b']);
  });

  test('a lockfile name a manifest in the same directory declares is anchored to it: one candidate', () => {
    const after = state(
      [parsePyproject('pyproject.toml', '[project]\nname = "app"\ndependencies = ["Reqeusts"]\n')],
      [uvLock('uv.lock', [['reqeusts', '1'], ['other', '1']])]
    );
    expect(newNames(ctxFor(null, after)).pypi.map((candidate) => [candidate.name, candidate.anchorPath])).toEqual([
      ['reqeusts', 'pyproject.toml'],
      ['other', 'uv.lock'],
    ]);
  });
});
