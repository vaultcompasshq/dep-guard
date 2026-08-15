import { computeDelta } from '../src/delta.js';
import { COMPARISON_TAMPER_SIGNALS } from '../src/tamper-signals.js';
import { parseNpmrcPins, type RepoState } from '../src/state.js';
import type { ManifestDep, ParsedManifest } from '../src/manifest.js';
import type { LockEntry, LockfileFormat, ParsedLockfile } from '../src/lockfiles/types.js';
import { parseNpmLockfile } from '../src/lockfiles/npm.js';
import type { Diagnostic } from '../src/types.js';

const ROOT = 'package.json';

function dep(name: string, specifier: string, overrides: Partial<ManifestDep> = {}): ManifestDep {
  return {
    name,
    registryName: name,
    specifier,
    depType: 'dependencies',
    protocol: 'registry',
    ...overrides,
  };
}

function manifest(path: string, deps: ManifestDep[]): ParsedManifest {
  return { path, deps, pnpmOnlyBuilt: [] };
}

function lockfile(
  entries: Array<[string, LockEntry[]]>,
  overrides: Partial<Omit<ParsedLockfile, 'entries'>> = {}
): ParsedLockfile {
  return {
    format: 'npm' as LockfileFormat,
    path: 'package-lock.json',
    diagnostics: [],
    workspaceLocalNames: new Set(),
    ...overrides,
    entries: new Map(entries),
  };
}

function state(manifests: ParsedManifest[], overrides: Partial<RepoState> = {}): RepoState {
  return {
    manifests,
    lockfile: null,
    onlyBuilt: [],
    npmrcRegistryPins: new Map<string, string>(),
    workspaceLocalNames: new Set(),
    ...overrides,
  };
}

describe('computeDelta manifest diffing', () => {
  test('a dep only present in after is added', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [])]),
      state([manifest(ROOT, [dep('left-pad', '^1.0.0')])])
    );
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatchObject({
      name: 'left-pad',
      registryName: 'left-pad',
      specifier: '^1.0.0',
      kind: 'added',
      depType: 'dependencies',
      protocol: 'registry',
      manifestPath: ROOT,
    });
  });

  test('same name with a different specifier is changed and carries the after specifier', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [dep('left-pad', '^1.0.0')])]),
      state([manifest(ROOT, [dep('left-pad', '^2.0.0')])])
    );
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatchObject({ kind: 'changed', specifier: '^2.0.0' });
  });

  test('an untouched dep produces no change', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [dep('left-pad', '^1.0.0')])]),
      state([manifest(ROOT, [dep('left-pad', '^1.0.0')])])
    );
    expect(delta.changes).toEqual([]);
  });

  test('an untouched dep with identical lock entries is not in the delta', () => {
    const entry: LockEntry = {
      version: '4.17.21',
      integrity: 'sha512-same',
      resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
    };
    const delta = computeDelta(
      state([manifest(ROOT, [dep('lodash', '^4.17.0')])], {
        lockfile: lockfile([['lodash', [{ ...entry }]]]),
      }),
      state([manifest(ROOT, [dep('lodash', '^4.17.0')])], {
        lockfile: lockfile([['lodash', [{ ...entry }]]]),
      })
    );
    expect(delta.changes).toEqual([]);
  });

  test('a removed dep is not in the delta', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [dep('left-pad', '^1.0.0'), dep('lodash', '^4.0.0')])]),
      state([manifest(ROOT, [dep('lodash', '^4.0.0')])])
    );
    expect(delta.changes).toEqual([]);
  });

  test('the same name in two sections is tracked independently', () => {
    const before = state([
      manifest(ROOT, [
        dep('typescript', '^5.0.0'),
        dep('typescript', '^5.0.0', { depType: 'devDependencies' }),
      ]),
    ]);
    const after = state([
      manifest(ROOT, [
        dep('typescript', '^5.9.0'),
        dep('typescript', '^5.0.0', { depType: 'devDependencies' }),
      ]),
    ]);
    const delta = computeDelta(before, after);
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatchObject({ depType: 'dependencies', specifier: '^5.9.0' });
  });

  test('a name added to a second section is added even when unchanged in the first', () => {
    const before = state([manifest(ROOT, [dep('typescript', '^5.0.0')])]);
    const after = state([
      manifest(ROOT, [
        dep('typescript', '^5.0.0'),
        dep('typescript', '^5.0.0', { depType: 'devDependencies' }),
      ]),
    ]);
    const delta = computeDelta(before, after);
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatchObject({ kind: 'added', depType: 'devDependencies' });
  });

  test('the same name in two manifests is tracked independently', () => {
    const before = state([
      manifest('packages/a/package.json', [dep('lodash', '^4.0.0')]),
      manifest('packages/b/package.json', [dep('lodash', '^4.0.0')]),
    ]);
    const after = state([
      manifest('packages/a/package.json', [dep('lodash', '^4.0.0')]),
      manifest('packages/b/package.json', [dep('lodash', '^5.0.0')]),
    ]);
    const delta = computeDelta(before, after);
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatchObject({
      manifestPath: 'packages/b/package.json',
      kind: 'changed',
    });
  });

  test('manifests are matched by path, so a renamed manifest reads as all added', () => {
    const before = state([manifest('packages/old/package.json', [dep('lodash', '^4.0.0')])]);
    const after = state([manifest('packages/new/package.json', [dep('lodash', '^4.0.0')])]);
    const delta = computeDelta(before, after);
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatchObject({
      kind: 'added',
      manifestPath: 'packages/new/package.json',
    });
  });

  test('audit mode marks every registry and alias dep as added', () => {
    const after = state([
      manifest(ROOT, [
        dep('lodash', '^4.0.0'),
        dep('react', 'npm:preact@^10.0.0', { registryName: 'preact', protocol: 'alias' }),
      ]),
    ]);
    const delta = computeDelta(null, after);
    expect(delta.changes.map((change) => [change.name, change.kind])).toEqual([
      ['lodash', 'added'],
      ['react', 'added'],
    ]);
  });

  test('audit mode still exempts internal-wiring protocols', () => {
    const after = state([
      manifest(ROOT, [
        dep('app-core', 'workspace:*', { protocol: 'workspace' }),
        dep('lodash', '^4.0.0'),
      ]),
    ]);
    const delta = computeDelta(null, after);
    expect(delta.changes.map((change) => change.name)).toEqual(['lodash']);
  });
});

describe('computeDelta protocol filtering', () => {
  test('internal-wiring protocols never produce changes', () => {
    const after = state([
      manifest(ROOT, [
        dep('a', 'workspace:*', { protocol: 'workspace' }),
        dep('b', 'catalog:', { protocol: 'catalog' }),
        dep('c', 'link:../c', { protocol: 'link' }),
        dep('d', 'patch:d@1.0.0#p.patch', { protocol: 'patch' }),
        dep('e', 'file:../e.tgz', { protocol: 'file' }),
      ]),
    ]);
    const delta = computeDelta(state([manifest(ROOT, [])]), after);
    expect(delta.changes).toEqual([]);
  });

  test('git and url protocol deps pass through as changes for the tamper check', () => {
    const after = state([
      manifest(ROOT, [
        dep('gitdep', 'github:evil/pkg', { protocol: 'git' }),
        dep('urldep', 'https://evil.example.com/pkg.tgz', { protocol: 'url' }),
      ]),
    ]);
    const delta = computeDelta(state([manifest(ROOT, [])]), after);
    expect(delta.changes.map((change) => [change.name, change.protocol])).toEqual([
      ['gitdep', 'git'],
      ['urldep', 'url'],
    ]);
  });

  test('alias deps produce changes', () => {
    const after = state([
      manifest(ROOT, [
        dep('react', 'npm:preact@^10.0.0', { registryName: 'preact', protocol: 'alias' }),
      ]),
    ]);
    const delta = computeDelta(state([manifest(ROOT, [])]), after);
    expect(delta.changes[0]).toMatchObject({
      name: 'react',
      registryName: 'preact',
      protocol: 'alias',
    });
  });
});

describe('computeDelta lock entry attachment', () => {
  test('entries attach by the manifest key name (npm style)', () => {
    const after = state(
      [manifest(ROOT, [dep('react', 'npm:preact@^10.0.0', { registryName: 'preact', protocol: 'alias' })])],
      { lockfile: lockfile([['react', [{ version: '10.1.0', integrity: 'sha512-aaa' }]]]) }
    );
    const delta = computeDelta(state([manifest(ROOT, [])]), after);
    expect(delta.changes[0].after).toEqual({ version: '10.1.0', integrity: 'sha512-aaa' });
  });

  test('entries fall back to the registry name (pnpm style)', () => {
    const after = state(
      [manifest(ROOT, [dep('react', 'npm:preact@^10.0.0', { registryName: 'preact', protocol: 'alias' })])],
      { lockfile: lockfile([['preact', [{ version: '10.1.0' }]]], { format: 'pnpm', path: 'pnpm-lock.yaml' }) }
    );
    const delta = computeDelta(state([manifest(ROOT, [])]), after);
    expect(delta.changes[0].after).toEqual({ version: '10.1.0' });
  });

  test('the manifest key name wins when both keys exist', () => {
    const after = state(
      [manifest(ROOT, [dep('react', 'npm:preact@^10.0.0', { registryName: 'preact', protocol: 'alias' })])],
      {
        lockfile: lockfile([
          ['react', [{ version: '10.1.0' }]],
          ['preact', [{ version: '9.0.0' }]],
        ]),
      }
    );
    const delta = computeDelta(state([manifest(ROOT, [])]), after);
    expect(delta.changes[0].after).toEqual({ version: '10.1.0' });
  });

  test('a changed dep carries both the before and after lock entries', () => {
    const before = state([manifest(ROOT, [dep('lodash', '^4.0.0')])], {
      lockfile: lockfile([['lodash', [{ version: '4.17.21', integrity: 'sha512-old' }]]]),
    });
    const after = state([manifest(ROOT, [dep('lodash', '^4.17.0')])], {
      lockfile: lockfile([['lodash', [{ version: '4.17.21' }]]]),
    });
    const delta = computeDelta(before, after);
    expect(delta.changes[0].before).toEqual({ version: '4.17.21', integrity: 'sha512-old' });
    expect(delta.changes[0].after).toEqual({ version: '4.17.21' });
  });

  test('a missing lockfile leaves both sides undefined and reports format none', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [])]),
      state([manifest(ROOT, [dep('lodash', '^4.0.0')])])
    );
    expect(delta.changes[0].before).toBeUndefined();
    expect(delta.changes[0].after).toBeUndefined();
    expect(delta.lockfileFormat).toBe('none');
  });

  test('a name absent from the lockfile attaches nothing and stays silent', () => {
    const after = state([manifest(ROOT, [dep('lodash', '^4.0.0')])], {
      lockfile: lockfile([['other', [{ version: '1.0.0' }]]]),
    });
    const delta = computeDelta(state([manifest(ROOT, [])]), after);
    expect(delta.changes[0].after).toBeUndefined();
    // The unrelated "other" entry is new and uncomparable, which the delta
    // reports in aggregate; nothing is said about the dep that resolved to
    // nothing.
    expect(delta.diagnostics.map((d) => d.code)).toEqual(['delta-new-lock-entries']);
  });

  test('lockfileFormat comes from the after side', () => {
    const after = state([manifest(ROOT, [])], {
      lockfile: lockfile([], { format: 'pnpm', path: 'pnpm-lock.yaml' }),
    });
    expect(computeDelta(state([manifest(ROOT, [])]), after).lockfileFormat).toBe('pnpm');
  });
});

describe('computeDelta multi-entry selection', () => {
  function deltaFor(specifier: string, versions: LockEntry[], depOverrides: Partial<ManifestDep> = {}) {
    const after = state([manifest(ROOT, [dep('pkg', specifier, depOverrides)])], {
      lockfile: lockfile([['pkg', versions]]),
    });
    return computeDelta(state([manifest(ROOT, [])]), after);
  }

  // These fixtures have no before lockfile at all, so every entry in them
  // is also new and uncomparable, which the delta now reports in aggregate.
  // What this describe is about is the selector's own guesses.
  function ambiguities(delta: { diagnostics: Diagnostic[] }): Diagnostic[] {
    return delta.diagnostics.filter((d) => d.code === 'delta-ambiguous-lock-entry');
  }

  test('a single entry is taken as is even when the specifier does not match', () => {
    const delta = deltaFor('^2.0.0', [{ version: '1.0.0' }]);
    expect(delta.changes[0].after).toEqual({ version: '1.0.0' });
    expect(ambiguities(delta)).toEqual([]);
  });

  test('an exact version match wins over other entries', () => {
    const delta = deltaFor('1.2.0', [{ version: '1.9.0' }, { version: '1.2.0' }, { version: '2.0.0' }]);
    expect(delta.changes[0].after).toEqual({ version: '1.2.0' });
    expect(ambiguities(delta)).toEqual([]);
  });

  test('a wildcard specifier prefix-matches one entry', () => {
    const delta = deltaFor('1.2.x', [{ version: '1.2.7' }, { version: '2.0.0' }]);
    expect(delta.changes[0].after).toEqual({ version: '1.2.7' });
    expect(ambiguities(delta)).toEqual([]);
  });

  test('a caret specifier prefix-matches on the major', () => {
    const delta = deltaFor('^1.2.0', [{ version: '1.2.7' }, { version: '2.0.0' }]);
    expect(delta.changes[0].after).toEqual({ version: '1.2.7' });
    expect(ambiguities(delta)).toEqual([]);
  });

  test('an exact match breaks a tie between several prefix matches', () => {
    const delta = deltaFor('^1.2.0', [{ version: '1.7.0' }, { version: '1.2.0' }]);
    expect(delta.changes[0].after).toEqual({ version: '1.2.0' });
    expect(ambiguities(delta)).toEqual([]);
  });

  test('several plausible entries fall back to the last one with a diagnostic', () => {
    const delta = deltaFor('^1.0.0', [{ version: '1.2.0' }, { version: '1.9.0' }]);
    expect(delta.changes[0].after).toEqual({ version: '1.9.0' });
    expect(ambiguities(delta)).toHaveLength(1);
    expect(ambiguities(delta)[0].code).toBe('delta-ambiguous-lock-entry');
    expect(ambiguities(delta)[0].message).toContain('pkg');
  });

  test('no plausible entry falls back to the last one with a diagnostic', () => {
    const delta = deltaFor('^3.0.0', [{ version: '1.2.0' }, { version: '1.9.0' }]);
    expect(delta.changes[0].after).toEqual({ version: '1.9.0' });
    expect(ambiguities(delta)).toHaveLength(1);
    expect(ambiguities(delta)[0].code).toBe('delta-ambiguous-lock-entry');
    expect(ambiguities(delta)[0].message).toContain('pkg');
  });

  test('entries without a version are never plausible', () => {
    const delta = deltaFor('^1.0.0', [{ integrity: 'sha512-a' }, { integrity: 'sha512-b' }]);
    expect(delta.changes[0].after).toEqual({ integrity: 'sha512-b' });
    expect(ambiguities(delta)[0].code).toBe('delta-ambiguous-lock-entry');
  });

  test('a non-numeric specifier cannot disambiguate', () => {
    const delta = deltaFor('latest', [{ version: '1.2.0' }, { version: '2.0.0' }]);
    expect(delta.changes[0].after).toEqual({ version: '2.0.0' });
    expect(ambiguities(delta)[0].code).toBe('delta-ambiguous-lock-entry');
  });

  test('a star specifier cannot disambiguate', () => {
    const delta = deltaFor('*', [{ version: '1.2.0' }, { version: '2.0.0' }]);
    expect(delta.changes[0].after).toEqual({ version: '2.0.0' });
    expect(ambiguities(delta)[0].code).toBe('delta-ambiguous-lock-entry');
  });

  test('an alias specifier selects on its target version range', () => {
    const delta = deltaFor('npm:lodash@^4.17.0', [{ version: '3.10.1' }, { version: '4.17.21' }], {
      registryName: 'lodash',
      protocol: 'alias',
    });
    expect(delta.changes[0].after).toEqual({ version: '4.17.21' });
    expect(ambiguities(delta)).toEqual([]);
  });

  test('a scoped alias specifier selects on its target version range', () => {
    const delta = deltaFor('npm:@scope/pkg@~2.3.0', [{ version: '2.3.9' }, { version: '3.0.0' }], {
      registryName: '@scope/pkg',
      protocol: 'alias',
    });
    expect(delta.changes[0].after).toEqual({ version: '2.3.9' });
    expect(ambiguities(delta)).toEqual([]);
  });

  test('the before side reports its own ambiguity', () => {
    const before = state([manifest(ROOT, [dep('pkg', '^1.0.0')])], {
      lockfile: lockfile([['pkg', [{ version: '1.2.0' }, { version: '1.9.0' }]]]),
    });
    const after = state([manifest(ROOT, [dep('pkg', '^2.0.0')])], {
      lockfile: lockfile([['pkg', [{ version: '2.1.0' }]]]),
    });
    const delta = computeDelta(before, after);
    expect(delta.changes[0].before).toEqual({ version: '1.9.0' });
    expect(delta.changes[0].after).toEqual({ version: '2.1.0' });
    // One guess worth reporting, not two: the manifest walk could not
    // choose between the two before entries for the specifier, and says so.
    // The lockfile walk could not identify either as the counterpart of the
    // new entry either -- but the two candidates differ in nothing any
    // comparison reads, so its guess could not have changed an answer and
    // announcing it would be noise.
    expect(delta.diagnostics.map((d) => d.code)).toEqual(['delta-ambiguous-lock-entry']);
    expect(delta.diagnostics.some((d) => d.message.includes('before'))).toBe(true);
    expect(delta.lockEntryChanges[0].counterpartAmbiguous).toBe(true);
  });

  test('the before side selects with the specifier it had, not the new one', () => {
    const before = state([manifest(ROOT, [dep('pkg', '^1.0.0')])], {
      lockfile: lockfile([['pkg', [{ version: '1.0.0' }, { version: '2.0.0' }]]]),
    });
    const after = state([manifest(ROOT, [dep('pkg', '^2.0.0')])], {
      lockfile: lockfile([['pkg', [{ version: '1.0.0' }, { version: '2.0.0' }]]]),
    });
    const delta = computeDelta(before, after);
    expect(delta.changes[0].before).toEqual({ version: '1.0.0' });
    expect(delta.changes[0].after).toEqual({ version: '2.0.0' });
    expect(ambiguities(delta)).toEqual([]);
  });

  test('the before side follows a retargeted alias to its old lock key', () => {
    const before = state(
      [manifest(ROOT, [dep('react', 'npm:preact@^10.0.0', { registryName: 'preact', protocol: 'alias' })])],
      { lockfile: lockfile([['preact', [{ version: '10.1.0' }]]], { format: 'pnpm' }) }
    );
    const after = state(
      [manifest(ROOT, [dep('react', 'npm:evil-pkg@^1.0.0', { registryName: 'evil-pkg', protocol: 'alias' })])],
      { lockfile: lockfile([['evil-pkg', [{ version: '1.0.0' }]]], { format: 'pnpm' }) }
    );
    const delta = computeDelta(before, after);
    expect(delta.changes[0]).toMatchObject({ kind: 'changed', registryName: 'evil-pkg' });
    expect(delta.changes[0].before).toEqual({ version: '10.1.0' });
    expect(delta.changes[0].after).toEqual({ version: '1.0.0' });
  });
});

describe('computeDelta lockfile-only changes', () => {
  const SPECIFIER = '^4.17.0';
  const RESOLVED = 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz';

  function lockOnlyDelta(beforeEntry: LockEntry, afterEntry: LockEntry) {
    return computeDelta(
      state([manifest(ROOT, [dep('lodash', SPECIFIER)])], {
        lockfile: lockfile([['lodash', [beforeEntry]]]),
      }),
      state([manifest(ROOT, [dep('lodash', SPECIFIER)])], {
        lockfile: lockfile([['lodash', [afterEntry]]]),
      })
    );
  }

  test('integrity removed with an untouched manifest is a change', () => {
    const delta = lockOnlyDelta(
      { version: '4.17.21', integrity: 'sha512-real', resolvedUrl: RESOLVED },
      { version: '4.17.21', resolvedUrl: RESOLVED }
    );
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatchObject({ kind: 'changed', name: 'lodash', specifier: SPECIFIER });
    expect(delta.changes[0].before).toMatchObject({ integrity: 'sha512-real' });
    expect(delta.changes[0].after?.integrity).toBeUndefined();
  });

  test('a swapped resolved host with an untouched manifest is a change', () => {
    const delta = lockOnlyDelta(
      { version: '4.17.21', integrity: 'sha512-real', resolvedUrl: RESOLVED },
      {
        version: '4.17.21',
        integrity: 'sha512-real',
        resolvedUrl: 'https://evil.example.com/lodash-4.17.21.tgz',
      }
    );
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatchObject({ kind: 'changed' });
    expect(delta.changes[0].after?.resolvedUrl).toBe('https://evil.example.com/lodash-4.17.21.tgz');
  });

  test('a swapped version with an untouched manifest is a change', () => {
    const delta = lockOnlyDelta({ version: '4.17.21' }, { version: '4.17.20' });
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatchObject({ kind: 'changed' });
  });

  test('identical lock entries and an identical specifier are not a change', () => {
    const delta = lockOnlyDelta(
      { version: '4.17.21', integrity: 'sha512-real', resolvedUrl: RESOLVED },
      { version: '4.17.21', integrity: 'sha512-real', resolvedUrl: RESOLVED }
    );
    expect(delta.changes).toEqual([]);
  });

  test('an install script flag turned on is a change', () => {
    const delta = lockOnlyDelta(
      { version: '4.17.21' },
      { version: '4.17.21', hasInstallScript: true }
    );
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatchObject({ kind: 'changed' });
    expect(delta.changes[0].after?.hasInstallScript).toBe(true);
  });

  test('an install script flag turned off is not a change', () => {
    const delta = lockOnlyDelta(
      { version: '4.17.21', hasInstallScript: true },
      { version: '4.17.21' }
    );
    expect(delta.changes).toEqual([]);
  });

  test('an install script flag that stays on is not a change', () => {
    const delta = lockOnlyDelta(
      { version: '4.17.21', hasInstallScript: true },
      { version: '4.17.21', hasInstallScript: true }
    );
    expect(delta.changes).toEqual([]);
  });

  test('a dep that only the after lockfile resolves is a change', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [dep('lodash', SPECIFIER)])], { lockfile: lockfile([]) }),
      state([manifest(ROOT, [dep('lodash', SPECIFIER)])], {
        lockfile: lockfile([['lodash', [{ version: '4.17.21' }]]]),
      })
    );
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]).toMatchObject({ kind: 'changed' });
    expect(delta.changes[0].before).toBeUndefined();
  });

  test('a manifest-only side with no lockfiles is still not a change', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [dep('lodash', SPECIFIER)])]),
      state([manifest(ROOT, [dep('lodash', SPECIFIER)])])
    );
    expect(delta.changes).toEqual([]);
  });

  test('an unchanged dep does not report an ambiguity diagnostic', () => {
    const entries: LockEntry[] = [{ version: '4.1.0' }, { version: '4.9.0' }];
    const delta = computeDelta(
      state([manifest(ROOT, [dep('lodash', '^4.0.0')])], {
        lockfile: lockfile([['lodash', entries.map((entry) => ({ ...entry }))]]),
      }),
      state([manifest(ROOT, [dep('lodash', '^4.0.0')])], {
        lockfile: lockfile([['lodash', entries.map((entry) => ({ ...entry }))]]),
      })
    );
    expect(delta.changes).toEqual([]);
    expect(delta.diagnostics).toEqual([]);
  });

  test('a changed dep still reports its ambiguity diagnostic', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [dep('lodash', '^4.0.0')])], {
        lockfile: lockfile([['lodash', [{ version: '4.1.0' }, { version: '4.9.0' }]]]),
      }),
      state([manifest(ROOT, [dep('lodash', '^4.0.0')])], {
        lockfile: lockfile([['lodash', [{ version: '4.1.0' }, { version: '4.9.1' }]]]),
      })
    );
    expect(delta.changes).toHaveLength(1);
    // Both sides of the manifest walk guessed, and each says so. The
    // counterpart pairing of the one entry that moved guessed too, between
    // two candidates nothing in the comparison rules can tell apart, so it
    // does not add a third note.
    expect(delta.diagnostics).toHaveLength(2);
    expect(new Set(delta.diagnostics.map((d) => d.code))).toEqual(
      new Set(['delta-ambiguous-lock-entry'])
    );
  });
});

describe('computeDelta onlyBuilt', () => {
  test('onlyBuiltAdded is the set difference of after minus before', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [])], { onlyBuilt: ['esbuild', 'sharp'] }),
      state([manifest(ROOT, [])], { onlyBuilt: ['esbuild', 'evil-postinstall'] })
    );
    expect(delta.onlyBuiltAdded).toEqual(['evil-postinstall']);
  });

  test('an unchanged allowlist adds nothing', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [])], { onlyBuilt: ['esbuild'] }),
      state([manifest(ROOT, [])], { onlyBuilt: ['esbuild'] })
    );
    expect(delta.onlyBuiltAdded).toEqual([]);
  });

  test('audit mode treats the whole allowlist as added', () => {
    const delta = computeDelta(null, state([manifest(ROOT, [])], { onlyBuilt: ['esbuild', 'sharp'] }));
    expect(delta.onlyBuiltAdded).toEqual(['esbuild', 'sharp']);
  });

  test('duplicate names in the after allowlist are reported once', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [])], { onlyBuilt: [] }),
      state([manifest(ROOT, [])], { onlyBuilt: ['sharp', 'sharp'] })
    );
    expect(delta.onlyBuiltAdded).toEqual(['sharp']);
  });

  test('a name removed from the allowlist is not reported', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [])], { onlyBuilt: ['esbuild', 'sharp'] }),
      state([manifest(ROOT, [])], { onlyBuilt: ['esbuild'] })
    );
    expect(delta.onlyBuiltAdded).toEqual([]);
  });
});

// workspaceLocalNames is a straight carry of the AFTER side's
// RepoState.workspaceLocalNames (itself a carry of the lockfile parser's
// own field -- see lockfile-npm.test.ts) into the delta, so both name-based
// checks read one fact instead of each re-deriving it from raw lockfile
// entries.
describe('computeDelta workspace-local names passthrough', () => {
  test('the after side workspaceLocalNames set reaches the delta unchanged', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [])]),
      state([manifest(ROOT, [])], { workspaceLocalNames: new Set(['@npmcli/mock-registry']) })
    );
    expect(delta.workspaceLocalNames).toEqual(new Set(['@npmcli/mock-registry']));
  });

  test('an empty after side yields an empty set, not the before side\'s', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [])], { workspaceLocalNames: new Set(['stale-sibling']) }),
      state([manifest(ROOT, [])])
    );
    expect(delta.workspaceLocalNames).toEqual(new Set());
  });

  test('an npm workspace sibling declared with a plain version range reaches the delta as a change, and its name is in workspaceLocalNames', () => {
    // Mirrors the real npm/cli shape: a sibling package is declared like
    // any registry dependency (no "workspace:" specifier -- npm does not
    // use one) and the lockfile is the only place that says it is local,
    // via a "link": true entry.
    const npmLockfile = parseNpmLockfile('package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'npm',
          version: '1.0.0',
          dependencies: { '@npmcli/mock-registry': '^1.0.0' },
          workspaces: ['workspaces/mock-registry'],
        },
        'workspaces/mock-registry': { name: '@npmcli/mock-registry', version: '1.0.0' },
        'node_modules/@npmcli/mock-registry': { resolved: 'workspaces/mock-registry', link: true },
      },
    }));
    const delta = computeDelta(
      null,
      state(
        [
          manifest(ROOT, [
            dep('@npmcli/mock-registry', '^1.0.0'),
          ]),
        ],
        { lockfile: npmLockfile, workspaceLocalNames: npmLockfile.workspaceLocalNames }
      )
    );
    expect(delta.changes.map((c) => c.registryName)).toContain('@npmcli/mock-registry');
    expect(delta.workspaceLocalNames.has('@npmcli/mock-registry')).toBe(true);
  });
});

describe('computeDelta diagnostics passthrough', () => {
  const beforeDiag: Diagnostic = { code: 'npm-lockfile-v1', message: 'before side is v1' };
  const afterDiag: Diagnostic = { code: 'pnpm-no-install-script-flag', message: 'no flag in v9' };

  test('diagnostics from both parsers pass through', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [])], { lockfile: lockfile([], { diagnostics: [beforeDiag] }) }),
      state([manifest(ROOT, [])], { lockfile: lockfile([], { diagnostics: [afterDiag] }) })
    );
    expect(delta.diagnostics).toEqual([beforeDiag, afterDiag]);
  });

  test('the same diagnostic on both sides is reported once', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [])], { lockfile: lockfile([], { diagnostics: [afterDiag] }) }),
      state([manifest(ROOT, [])], { lockfile: lockfile([], { diagnostics: [afterDiag] }) })
    );
    expect(delta.diagnostics).toEqual([afterDiag]);
  });

  test('audit mode passes through the after diagnostics', () => {
    const delta = computeDelta(
      null,
      state([manifest(ROOT, [])], { lockfile: lockfile([], { diagnostics: [afterDiag] }) })
    );
    expect(delta.diagnostics).toContainEqual(afterDiag);
  });
});

// C1/C3: the lockfile is diffed as a whole, independently of the manifest
// walk, because the manifest walk can only ever see the small minority of
// entries some package.json declares.
describe('computeDelta lockfile entry diffing', () => {
  const CLEAN: LockEntry = {
    version: '5.0.1',
    resolvedUrl: 'https://registry.npmjs.org/ansi-regex/-/ansi-regex-5.0.1.tgz',
    integrity: 'sha512-clean',
  };

  function entryDelta(before: Array<[string, LockEntry[]]>, after: Array<[string, LockEntry[]]>) {
    return computeDelta(
      state([manifest(ROOT, [])], { lockfile: lockfile(before) }),
      state([manifest(ROOT, [])], { lockfile: lockfile(after) })
    );
  }

  test('a transitive entry nothing declares still reaches the delta', () => {
    const tampered: LockEntry = { version: '5.0.1', resolvedUrl: 'https://evil.example.test/a.tgz' };
    const delta = entryDelta([['ansi-regex', [CLEAN]]], [['ansi-regex', [tampered]]]);

    expect(delta.changes).toEqual([]);
    expect(delta.lockEntryChanges).toHaveLength(1);
    expect(delta.lockEntryChanges[0]).toMatchObject({
      name: 'ansi-regex',
      kind: 'changed',
      before: CLEAN,
      after: tampered,
    });
  });

  test('an unchanged entry produces no lock entry change', () => {
    const delta = entryDelta([['ansi-regex', [CLEAN]]], [['ansi-regex', [{ ...CLEAN }]]]);
    expect(delta.lockEntryChanges).toEqual([]);
  });

  test('a brand new entry is added, with no before side', () => {
    const delta = entryDelta([], [['ansi-regex', [CLEAN]]]);
    expect(delta.lockEntryChanges).toHaveLength(1);
    expect(delta.lockEntryChanges[0]).toMatchObject({ kind: 'added', before: undefined });
  });

  test('a removed entry produces nothing', () => {
    const delta = entryDelta([['ansi-regex', [CLEAN]]], []);
    expect(delta.lockEntryChanges).toEqual([]);
  });

  // C3's shape at the delta level: an unchanged decoy entry sitting beside
  // a tampered one must not consume the clean before entry and leave the
  // tampered one looking like a fresh, uncomparable addition.
  test('a same-version decoy entry does not absorb the before side of a tampered one', () => {
    const tampered: LockEntry = { version: '5.0.1', resolvedUrl: 'https://evil.example.test/a.tgz' };
    const delta = entryDelta([['ansi-regex', [CLEAN]]], [['ansi-regex', [tampered, { ...CLEAN }]]]);

    expect(delta.lockEntryChanges).toHaveLength(1);
    expect(delta.lockEntryChanges[0]).toMatchObject({ after: tampered, before: CLEAN });
  });

  test('the lockfile path travels with the delta', () => {
    const delta = entryDelta([], [['ansi-regex', [CLEAN]]]);
    expect(delta.lockfilePath).toBe('package-lock.json');
    expect(delta.lockEntryChanges[0].lockfilePath).toBe('package-lock.json');
  });

  test('an entry a manifest declares is attributed to that manifest', () => {
    const declared = state([manifest(ROOT, [dep('ansi-regex', '^5.0.0')])], {
      lockfile: lockfile([['ansi-regex', [{ version: '5.0.1', integrity: 'sha512-b' }]]]),
    });
    const previous = state([manifest(ROOT, [dep('ansi-regex', '^5.0.0')])], {
      lockfile: lockfile([['ansi-regex', [{ version: '5.0.1', integrity: 'sha512-a' }]]]),
    });
    const delta = computeDelta(previous, declared);
    expect(delta.lockEntryChanges[0].manifestPath).toBe(ROOT);
  });

  // If an entry no manifest declares were anchored to the root
  // package.json, that is a file that has nothing to do with it. Since
  // ignorePaths, the baseline fingerprint, and the delta's own pairing
  // all key off that path, "ignorePaths: [package.json]" -- a spelling
  // config.ts deliberately allows, so a monorepo can say it only cares
  // about its workspace packages -- would silently delete the entire
  // lockfile walk. A finding the lockfile walk discovered is located in
  // the lockfile, so that is what it is anchored to, and ignoring it is
  // an explicit choice rather than a side effect of ignoring a manifest.
  test('an entry no manifest declares is anchored to the lockfile it was found in', () => {
    const delta = entryDelta([], [['ansi-regex', [CLEAN]]]);
    expect(delta.lockEntryChanges[0].manifestPath).toBe('package-lock.json');
    expect(delta.lockEntryChanges[0].lockfilePath).toBe('package-lock.json');
  });

  test('an aliased entry reports the registry name the alias installs', () => {
    const aliased = dep('ui', 'npm:lodash@^4.17.0', { registryName: 'lodash', protocol: 'alias' });
    const previous = state([manifest(ROOT, [aliased])], {
      lockfile: lockfile([['ui', [{ version: '4.17.21', integrity: 'sha512-a' }]]]),
    });
    const current = state([manifest(ROOT, [aliased])], {
      lockfile: lockfile([['ui', [{ version: '4.17.21', integrity: 'sha512-b' }]]]),
    });
    const delta = computeDelta(previous, current);
    expect(delta.lockEntryChanges[0]).toMatchObject({ name: 'ui', packageName: 'lodash' });
  });
});

// A lockfile entry with no before side cannot be comparison-checked at
// all. Audit mode announces that gap; the delta modes used to keep it to
// themselves, so a fresh install looked exactly like a scan that had
// evaluated every entry. One aggregate note, never one per entry: a fresh
// install adds hundreds of entries and per-entry notes would be noise.
describe('computeDelta announces lock entries it could not compare', () => {
  const NEW_A: LockEntry = { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/a-1.0.0.tgz', integrity: 'sha512-a' };
  const NEW_B: LockEntry = { version: '2.0.0', resolvedUrl: 'https://registry.npmjs.org/b-2.0.0.tgz', integrity: 'sha512-b' };
  const KNOWN: LockEntry = { version: '5.0.1', resolvedUrl: 'https://registry.npmjs.org/c-5.0.1.tgz', integrity: 'sha512-c' };

  function entryDelta(before: Array<[string, LockEntry[]]>, after: Array<[string, LockEntry[]]>) {
    return computeDelta(
      state([manifest(ROOT, [])], { lockfile: lockfile(before) }),
      state([manifest(ROOT, [])], { lockfile: lockfile(after) })
    );
  }

  test('several new entries produce exactly one diagnostic, naming the count', () => {
    const delta = entryDelta([['c', [KNOWN]]], [['c', [KNOWN]], ['a', [NEW_A]], ['b', [NEW_B]]]);
    const notices = delta.diagnostics.filter((d) => d.code === 'delta-new-lock-entries');
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain('2');
    expect(notices[0].message).toContain('package-lock.json');
    // Same obligation as the audit notice: a statement of lost coverage
    // names every signal that was lost, not a subset of them.
    expect(notices[0].message).toContain('integrity-downgraded');
    expect(notices[0].message).toContain('local-source-changed');
    expect(notices[0].message).toContain('tarball-repointed');
    expect(notices[0].message).toContain('resolution-unreadable');
  });

  // Both coverage notices are built from one list, so a signal added to the
  // check reaches both messages or neither compiles. This asserts the
  // relationship rather than a snapshot of today's names.
  test('the notice names every comparison-derived signal there is', () => {
    const delta = entryDelta([['c', [KNOWN]]], [['c', [KNOWN]], ['a', [NEW_A]]]);
    const notice = delta.diagnostics.find((d) => d.code === 'delta-new-lock-entries');
    for (const signal of COMPARISON_TAMPER_SIGNALS) {
      expect(notice?.message).toContain(signal);
    }
  });

  test('a delta with no new entries says nothing', () => {
    const delta = entryDelta(
      [['c', [KNOWN]]],
      [['c', [{ ...KNOWN, integrity: 'sha512-forged' }]]]
    );
    expect(delta.diagnostics.map((d) => d.code)).not.toContain('delta-new-lock-entries');
  });

  test('audit mode says nothing here: its own no-comparison notice already covers every entry', () => {
    const delta = computeDelta(
      null,
      state([manifest(ROOT, [])], { lockfile: lockfile([['a', [NEW_A]]]) })
    );
    expect(delta.diagnostics.map((d) => d.code)).not.toContain('delta-new-lock-entries');
    expect(delta.diagnostics.map((d) => d.code)).toContain('audit-no-tamper-comparison');
  });
});

// The counterpart pairing is a guess whenever a name carries several before
// entries and none of them is the same resolution as the changed one. It
// used to fall through to whichever entry the lockfile happened to list
// first and then assert a change against it, which manufactured criticals
// out of ordinary bumps.
describe('computeDelta counterpart pairing', () => {
  function entryDelta(before: Array<[string, LockEntry[]]>, after: Array<[string, LockEntry[]]>) {
    return computeDelta(
      state([manifest(ROOT, [])], { lockfile: lockfile(before) }),
      state([manifest(ROOT, [])], { lockfile: lockfile(after) })
    );
  }

  const MIRRORED: LockEntry = {
    version: '3.10.1',
    resolvedUrl: 'https://artifactory.example.test/lodash/-/lodash-3.10.1.tgz',
    integrity: 'sha512-mirror',
  };
  const NPMJS_OLD: LockEntry = {
    version: '4.17.21',
    resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
    integrity: 'sha512-old',
  };
  const NPMJS_NEW: LockEntry = {
    version: '4.17.22',
    resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.22.tgz',
    integrity: 'sha512-new',
  };

  test('a candidate resolving from the same origin wins over the first one listed', () => {
    const delta = entryDelta(
      [['lodash', [MIRRORED, NPMJS_OLD]]],
      [['lodash', [MIRRORED, NPMJS_NEW]]]
    );
    expect(delta.lockEntryChanges).toHaveLength(1);
    expect(delta.lockEntryChanges[0].before).toEqual(NPMJS_OLD);
    expect(delta.lockEntryChanges[0].counterpartAmbiguous).not.toBe(true);
  });

  test('with origins tied, the candidate whose install-script flag matches wins', () => {
    const unflagged: LockEntry = { version: '0.20.0', resolvedUrl: 'https://registry.npmjs.org/e-0.20.0.tgz', integrity: 'sha512-a' };
    const flagged: LockEntry = { version: '0.21.0', resolvedUrl: 'https://registry.npmjs.org/e-0.21.0.tgz', integrity: 'sha512-b', hasInstallScript: true };
    const bumped: LockEntry = { version: '0.21.1', resolvedUrl: 'https://registry.npmjs.org/e-0.21.1.tgz', integrity: 'sha512-c', hasInstallScript: true };

    const delta = entryDelta([['esbuild', [unflagged, flagged]]], [['esbuild', [unflagged, bumped]]]);
    expect(delta.lockEntryChanges).toHaveLength(1);
    expect(delta.lockEntryChanges[0].before).toEqual(flagged);
  });

  test('an unresolvable pairing is marked as a guess and carries every candidate', () => {
    const first: LockEntry = { version: '1.0.0', resolvedUrl: 'https://a.example.test/p-1.0.0.tgz', integrity: 'sha512-a' };
    const second: LockEntry = { version: '2.0.0', resolvedUrl: 'https://b.example.test/p-2.0.0.tgz', integrity: 'sha512-b' };
    const now: LockEntry = { version: '3.0.0', resolvedUrl: 'https://c.example.test/p-3.0.0.tgz', integrity: 'sha512-c' };

    const delta = entryDelta([['p', [first, second]]], [['p', [now]]]);

    expect(delta.lockEntryChanges).toHaveLength(1);
    expect(delta.lockEntryChanges[0].counterpartAmbiguous).toBe(true);
    // Marking the guess is the delta's whole job here. Whether the guess
    // cost anything is a question only a comparison can answer, and this
    // one costs nothing: both candidates agree the entry moved to an origin
    // neither of them resolved from, so the check reports that outright.
    expect(delta.lockEntryChanges[0].beforeCandidates).toEqual([first, second]);
  });

  test('a single before entry is never a guess', () => {
    const delta = entryDelta([['p', [NPMJS_OLD]]], [['p', [NPMJS_NEW]]]);
    expect(delta.lockEntryChanges[0].counterpartAmbiguous).not.toBe(true);
    expect(delta.diagnostics.map((d) => d.code)).not.toContain('delta-ambiguous-lock-entry');
  });

  // The checks do not throw away a guessed pairing whole -- they compare
  // against every surviving candidate and report a verdict all of them
  // agree on -- so every survivor has to travel with the change, not
  // just the one that happened to sort first.
  test('every surviving candidate travels with the change', () => {
    const first: LockEntry = { version: '1.0.0', resolvedUrl: 'https://a.example.test/p-1.0.0.tgz', integrity: 'sha512-a' };
    const second: LockEntry = { version: '2.0.0', resolvedUrl: 'https://b.example.test/p-2.0.0.tgz', integrity: 'sha512-b' };
    const now: LockEntry = { version: '3.0.0', resolvedUrl: 'https://c.example.test/p-3.0.0.tgz', integrity: 'sha512-c' };

    const delta = entryDelta([['p', [first, second]]], [['p', [now]]]);

    expect(delta.lockEntryChanges[0].counterpartAmbiguous).toBe(true);
    expect(delta.lockEntryChanges[0].beforeCandidates).toEqual([first, second]);
  });

  test('an unambiguous pairing carries no candidate list to weigh', () => {
    const delta = entryDelta([['p', [NPMJS_OLD]]], [['p', [NPMJS_NEW]]]);
    expect(delta.lockEntryChanges[0].beforeCandidates).toBeUndefined();
  });

  // The other half of C2 used to live here, as a hand-written list of the
  // facts the comparison rules read: the delta predicted whether the guess
  // could have changed an answer and raised the note itself. That prediction
  // is what drifted -- twice silently in the attacker's favour -- so it is
  // gone. The delta now hands over every survivor and says nothing about
  // what a comparison will make of them; the check that actually drops a
  // verdict is the one that announces it (see checks/tamper.ts and
  // checks/install-script.ts, and their tests).
  test('candidates no comparison could tell apart do not raise the diagnostic', () => {
    const nested: LockEntry = { version: '4.17.20', resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz', integrity: 'sha512-nested' };
    const delta = entryDelta(
      [['lodash', [nested, NPMJS_OLD]]],
      [['lodash', [nested, { version: '4.18.0', resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.18.0.tgz', integrity: 'sha512-newer' }]]]
    );
    expect(delta.lockEntryChanges).toHaveLength(1);
    expect(delta.lockEntryChanges[0].counterpartAmbiguous).toBe(true);
    expect(delta.diagnostics.map((d) => d.code)).not.toContain('delta-ambiguous-lock-entry');
  });

  test('candidates resolving from different origins are handed over, not judged here', () => {
    const evil: LockEntry = { version: '9.9.9', resolvedUrl: 'https://evil.example.test/lodash-9.9.9.tgz', integrity: 'sha512-evil' };
    const delta = entryDelta(
      [['lodash', [MIRRORED, NPMJS_OLD]]],
      [['lodash', [MIRRORED, evil]]]
    );
    expect(delta.lockEntryChanges[0].counterpartAmbiguous).toBe(true);
    expect(delta.lockEntryChanges[0].beforeCandidates).toEqual([MIRRORED, NPMJS_OLD]);
    expect(delta.diagnostics.map((d) => d.code)).not.toContain('delta-ambiguous-lock-entry');
  });

  test('candidates disagreeing about whether there was a hash at all are handed over too', () => {
    const hashed: LockEntry = { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/p-1.0.0.tgz', integrity: 'sha512-a' };
    const hashless: LockEntry = { version: '2.0.0', resolvedUrl: 'https://registry.npmjs.org/p-2.0.0.tgz' };
    const delta = entryDelta(
      [['p', [hashed, hashless]]],
      [['p', [{ version: '3.0.0', resolvedUrl: 'https://registry.npmjs.org/p-3.0.0.tgz' }]]]
    );
    expect(delta.lockEntryChanges[0].counterpartAmbiguous).toBe(true);
    expect(delta.lockEntryChanges[0].beforeCandidates).toEqual([hashed, hashless]);
    expect(delta.diagnostics.map((d) => d.code)).not.toContain('delta-ambiguous-lock-entry');
  });
});

// T8-2: the ambiguity diagnostic is the only trace that a selector had to
// guess. Dropping it whenever the dependency did not enter the delta threw
// away that trace in exactly the case where the entries it could not choose
// between disagreed about where the bytes come from.
describe('computeDelta ambiguity that hid a real disagreement', () => {
  const SPECIFIER = '^4.0.0';

  function ambiguousBoth(entries: LockEntry[]) {
    return computeDelta(
      state([manifest(ROOT, [dep('lodash', SPECIFIER)])], {
        lockfile: lockfile([['lodash', entries.map((entry) => ({ ...entry }))]]),
      }),
      state([manifest(ROOT, [dep('lodash', SPECIFIER)])], {
        lockfile: lockfile([['lodash', entries.map((entry) => ({ ...entry }))]]),
      })
    );
  }

  test('candidates differing in integrity are still reported when the dep stays out of the delta', () => {
    const delta = ambiguousBoth([
      { version: '4.1.0', integrity: 'sha512-a' },
      { version: '4.9.0', integrity: 'sha512-b' },
    ]);
    expect(delta.changes).toEqual([]);
    expect(delta.diagnostics.map((d) => d.code)).toContain('delta-ambiguous-lock-entry');
  });

  test('candidates differing in resolved URL are reported too', () => {
    const delta = ambiguousBoth([
      { version: '4.1.0', resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.1.0.tgz' },
      { version: '4.9.0', resolvedUrl: 'https://evil.example.test/lodash/-/lodash-4.9.0.tgz' },
    ]);
    expect(delta.diagnostics.map((d) => d.code)).toContain('delta-ambiguous-lock-entry');
  });

  test('candidates agreeing on integrity and URL stay quiet, as before', () => {
    const delta = ambiguousBoth([
      { version: '4.1.0', integrity: 'sha512-same', resolvedUrl: 'https://registry.npmjs.org/l.tgz' },
      { version: '4.9.0', integrity: 'sha512-same', resolvedUrl: 'https://registry.npmjs.org/l.tgz' },
    ]);
    expect(delta.changes).toEqual([]);
    expect(delta.diagnostics).toEqual([]);
  });
});

describe('computeDelta name safety', () => {
  test('prototype-member names flow through as ordinary deps', () => {
    const after = state(
      [
        manifest(ROOT, [
          dep('constructor', '^1.0.0'),
          dep('__proto__', '^2.0.0'),
          dep('toString', '^3.0.0'),
        ]),
      ],
      {
        lockfile: lockfile([
          ['constructor', [{ version: '1.0.1' }]],
          ['__proto__', [{ version: '2.0.1' }]],
        ]),
      }
    );
    const delta = computeDelta(state([manifest(ROOT, [])]), after);
    expect(delta.changes.map((change) => [change.name, change.after?.version])).toEqual([
      ['constructor', '1.0.1'],
      ['__proto__', '2.0.1'],
      ['toString', undefined],
    ]);
  });

  test('prototype-member names do not resolve against a lockfile that lacks them', () => {
    const after = state([manifest(ROOT, [dep('valueOf', '^1.0.0')])], {
      lockfile: lockfile([['lodash', [{ version: '4.17.21' }]]]),
    });
    const delta = computeDelta(state([manifest(ROOT, [])]), after);
    expect(delta.changes[0].after).toBeUndefined();
  });

  test('a prototype-member name in the before manifest still compares by identity', () => {
    const delta = computeDelta(
      state([manifest(ROOT, [dep('__proto__', '^1.0.0')])]),
      state([manifest(ROOT, [dep('__proto__', '^1.0.0')])])
    );
    expect(delta.changes).toEqual([]);
  });
});

describe('parseNpmrcPins', () => {
  test('null content yields no pins', () => {
    expect(parseNpmrcPins(null).size).toBe(0);
  });

  test('a scoped registry line becomes a pin', () => {
    const pins = parseNpmrcPins('@acme:registry=https://npm.acme.example.com/');
    expect(pins.get('@acme')).toBe('https://npm.acme.example.com/');
    expect(pins.size).toBe(1);
  });

  test('several scopes are all captured', () => {
    const pins = parseNpmrcPins(
      '@acme:registry=https://npm.acme.example.com/\n@other:registry=https://npm.other.example.com/'
    );
    expect(pins.size).toBe(2);
    expect(pins.get('@other')).toBe('https://npm.other.example.com/');
  });

  test('comments and blank lines are skipped', () => {
    const pins = parseNpmrcPins(
      '# a comment\n\n; another comment\n@acme:registry=https://npm.acme.example.com/\n'
    );
    expect(pins.size).toBe(1);
    expect(pins.get('@acme')).toBe('https://npm.acme.example.com/');
  });

  test('surrounding whitespace is trimmed', () => {
    const pins = parseNpmrcPins('  @acme:registry =  https://npm.acme.example.com/  ');
    expect(pins.get('@acme')).toBe('https://npm.acme.example.com/');
  });

  test('quoted values are unquoted', () => {
    const pins = parseNpmrcPins('@acme:registry="https://npm.acme.example.com/"');
    expect(pins.get('@acme')).toBe('https://npm.acme.example.com/');
  });

  test('the unscoped default registry is not a scope pin', () => {
    expect(parseNpmrcPins('registry=https://registry.npmjs.org/').size).toBe(0);
  });

  test('auth and other settings are ignored', () => {
    const pins = parseNpmrcPins(
      '//npm.acme.example.com/:_authToken=redacted\nalways-auth=true\n@acme:always-auth=true'
    );
    expect(pins.size).toBe(0);
  });

  test('a later line overrides an earlier one for the same scope', () => {
    const pins = parseNpmrcPins(
      '@acme:registry=https://first.example.com/\n@acme:registry=https://second.example.com/'
    );
    expect(pins.get('@acme')).toBe('https://second.example.com/');
  });

  test('lines without a value are ignored', () => {
    expect(parseNpmrcPins('@acme:registry\n@acme:registry=\n@:registry=https://x.example.com/').size).toBe(0);
  });

  test('carriage returns are tolerated', () => {
    const pins = parseNpmrcPins('@acme:registry=https://npm.acme.example.com/\r\n');
    expect(pins.get('@acme')).toBe('https://npm.acme.example.com/');
  });

  test('a user and password in a pinned URL are not stored', () => {
    const pins = parseNpmrcPins(
      '@acme:registry=https://user:supersecrettoken@npm.acme.example.com/'
    );
    expect(pins.get('@acme')).toBe('https://npm.acme.example.com/');
  });

  test('a bare user in a pinned URL is not stored', () => {
    const pins = parseNpmrcPins('@acme:registry=https://user@npm.acme.example.com/');
    expect(pins.get('@acme')).toBe('https://npm.acme.example.com/');
  });

  test('a credential in an unparseable value is stripped without dropping the pin', () => {
    const pins = parseNpmrcPins('@acme:registry=user:supersecrettoken@npm.acme.example.com/path');
    expect(pins.get('@acme')).toBe('npm.acme.example.com/path');
  });

  test('a credential in a protocol-relative value is stripped', () => {
    const pins = parseNpmrcPins('@acme:registry=//user:supersecrettoken@npm.acme.example.com/');
    expect(pins.get('@acme')).toBe('//npm.acme.example.com/');
  });

  test('a protocol-relative value with no credential is kept verbatim', () => {
    const pins = parseNpmrcPins('@acme:registry=//npm.acme.example.com/');
    expect(pins.get('@acme')).toBe('//npm.acme.example.com/');
  });

  test('a protocol-relative value keeps its path after stripping', () => {
    const pins = parseNpmrcPins('@acme:registry=//user@npm.acme.example.com/api/npm/');
    expect(pins.get('@acme')).toBe('//npm.acme.example.com/api/npm/');
  });

  test('a protocol-relative credential is stripped even when the path holds a url', () => {
    const pins = parseNpmrcPins(
      '@acme:registry=//user:supersecrettoken@npm.acme.example.com/api?to=https://other.example.com/'
    );
    expect(pins.get('@acme')).toBe(
      '//npm.acme.example.com/api?to=https://other.example.com/'
    );
  });

  test('a scheme-less value whose path holds a url is kept verbatim', () => {
    const pins = parseNpmrcPins('@acme:registry=npm.acme.example.com/api?to=https://other.example.com/');
    expect(pins.get('@acme')).toBe('npm.acme.example.com/api?to=https://other.example.com/');
  });

  test('a credential after three leading slashes is stripped', () => {
    const pins = parseNpmrcPins('@acme:registry=///user:supersecrettoken@npm.acme.example.com/');
    expect(pins.get('@acme')).toBe('///npm.acme.example.com/');
  });

  test('a credential after four leading slashes is stripped', () => {
    const pins = parseNpmrcPins('@acme:registry=////user:supersecrettoken@npm.acme.example.com/');
    expect(pins.get('@acme')).toBe('////npm.acme.example.com/');
  });

  test('a slash run with no credential is not mangled', () => {
    const pins = parseNpmrcPins('@acme:registry=///npm.acme.example.com/');
    expect(pins.get('@acme')).toBe('///npm.acme.example.com/');
  });

  // One data-driven sweep so every credential-bearing shape found in review
  // lives in a single list: add new shapes here rather than as new tests.
  test('no credential-bearing shape survives in a stored pin', () => {
    const SECRET = 'supersecrettoken';
    const shapes = [
      `https://user:${SECRET}@npm.acme.example.com/`,
      `//user:${SECRET}@npm.acme.example.com/`,
      `///user:${SECRET}@npm.acme.example.com/`,
      `////user:${SECRET}@npm.acme.example.com/`,
      `user:${SECRET}@npm.acme.example.com/path`,
      `//${SECRET}@npm.acme.example.com/api?next=https://a:b@other.example.com/`,
      `///https://user:${SECRET}@npm.acme.example.com/`,
      `//https://user:${SECRET}@npm.acme.example.com/`,
      `/https://user:${SECRET}@npm.acme.example.com/`,
      `///http://user:${SECRET}@npm.acme.example.com/`,
      `https:////user:${SECRET}@npm.acme.example.com/`,
      `https:///https://user:${SECRET}@npm.acme.example.com/`,
      `//user:${SECRET}@npm.acme.example.com:8080/`,
      `https://a:b@npm.acme.example.com/user:${SECRET}@evil.example.com/`,
    ];
    for (const shape of shapes) {
      const stored = parseNpmrcPins(`@acme:registry=${shape}`).get('@acme');
      expect(stored).toBeDefined();
      expect(stored).not.toContain(SECRET);
      expect(stored).toContain('npm.acme.example.com');
    }
  });

  test('an unparseable value with no credential is kept verbatim', () => {
    const pins = parseNpmrcPins('@acme:registry=npm.acme.example.com/path');
    expect(pins.get('@acme')).toBe('npm.acme.example.com/path');
  });

  // The mirror image of the paranoia sweep: values with no credential in any
  // authority position must come back byte-identical, never reformatted or
  // redacted. Add new clean shapes here rather than as new tests.
  test('no-credential control values are stored verbatim', () => {
    const controls = [
      'https://npm.acme.example.com/',
      '//npm.acme.example.com/',
      '///npm.acme.example.com/',
      'npm.acme.example.com/path',
      'https://npm.acme.example.com/api?u=x:y@z',
    ];
    for (const control of controls) {
      expect(parseNpmrcPins(`@acme:registry=${control}`).get('@acme')).toBe(control);
    }
  });

  test('a decoy credential does not shield a token later in the path', () => {
    // The textual floor must run over the rebuilt value too: a throwaway
    // userinfo in front must not short-circuit past the redaction and keep
    // a second token alive in the stored path.
    const pins = parseNpmrcPins('@acme:registry=https://a:b@x/user:tok@h/');
    expect(pins.get('@acme')).toBe('https://x/h/');
  });

  test('an at sign run in the path of a parseable value is redacted by design', () => {
    // Deliberate safe-direction widening: "name@version" path segments are
    // indistinguishable from credentials textually, so they are mangled
    // rather than risked. Slash-preceded "@" segments stay untouched.
    const pins = parseNpmrcPins('@acme:registry=https://h/pkg/lodash@4.17.21');
    expect(pins.get('@acme')).toBe('https://h/pkg/4.17.21');
  });

  test('a port survives credential stripping', () => {
    const pins = parseNpmrcPins(
      '@acme:registry=//user:supersecrettoken@npm.acme.example.com:8080/'
    );
    expect(pins.get('@acme')).toBe('//npm.acme.example.com:8080/');
  });

  test('an ipv6 host survives credential stripping', () => {
    const pins = parseNpmrcPins('@acme:registry=//user:supersecrettoken@[::1]/');
    expect(pins.get('@acme')).toBe('//[::1]/');
  });

  test('a colon-dense value cannot stall the redaction', () => {
    // Regression guard for the round-5 ReDoS finding: the old pattern
    // backtracked cubically on colon-dense input with no at sign at all.
    const start = Date.now();
    const pins = parseNpmrcPins(`@acme:registry=${'a:'.repeat(3000)}`);
    expect(pins.size).toBe(1);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test('query content of a parseable value survives userinfo stripping', () => {
    // Documented residual: a credential inside a URL that sits in the query of
    // a PARSEABLE pin is the consumer's problem, not this function's. Only the
    // pin's own userinfo is removed.
    const pins = parseNpmrcPins(
      '@acme:registry=//u@npm.acme.example.com/api?next=https://a:b@other.example.com/'
    );
    expect(pins.get('@acme')).toBe(
      '//npm.acme.example.com/api?next=https://a:b@other.example.com/'
    );
  });

  test('a path segment containing an at sign is left alone', () => {
    const pins = parseNpmrcPins('@acme:registry=https://npm.acme.example.com/api/@acme/');
    expect(pins.get('@acme')).toBe('https://npm.acme.example.com/api/@acme/');
  });

  test('a prototype-member scope name is stored safely', () => {
    const pins = parseNpmrcPins('@__proto__:registry=https://npm.acme.example.com/');
    expect(pins.get('@__proto__')).toBe('https://npm.acme.example.com/');
    expect(pins.size).toBe(1);
  });
});
