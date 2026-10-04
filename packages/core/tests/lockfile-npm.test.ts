import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseNpmLockfile } from '../src/lockfiles/npm.js';
import { DepGuardError } from '../src/types.js';

const PATH = '/repo/package-lock.json';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/package-lock-v3.json', import.meta.url)
);
const FIXTURE_CONTENT = readFileSync(FIXTURE_PATH, 'utf8');

function expectLockfileParse(fn: () => void): void {
  try {
    fn();
    throw new Error('expected parseNpmLockfile to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(DepGuardError);
    expect((err as DepGuardError).code).toBe('lockfile-parse');
  }
}

// entries is Map<string, LockEntry[]> -- most fixture names resolve to
// exactly one version, so tests read the sole element through this helper
// rather than repeating the [0] index everywhere.
function only(result: ReturnType<typeof parseNpmLockfile>, name: string) {
  const list = result.entries.get(name);
  expect(list).toHaveLength(1);
  return list?.[0];
}

describe('parseNpmLockfile entry extraction', () => {
  test('extracts one entry per installed package, excluding workspace dirs, root, and link entries', () => {
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    expect(result.entries.size).toBe(8);
    expect([...result.entries.keys()].sort()).toEqual(
      [
        'fsevents',
        'git-pkg',
        'lodash',
        'malicious-pkg',
        'nested-dep',
        '@scope/pkg',
        'host-pkg',
        '@scope/b',
      ].sort()
    );
  });

  test('a normal registry dep carries version, resolvedUrl and integrity', () => {
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    expect(only(result, 'lodash')).toEqual({
      version: '4.17.21',
      resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
      integrity:
        'sha512-v2kDEe57lecTulaDIuNTPy3Ry4/GNQBALk5xz1CtLwjmpfKUZ0BX57iZfIuA1G+VuHrf1qJUkG5ycOHkQaqQdA==',
    });
  });

  test('hasInstallScript: true is surfaced on the entry', () => {
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    expect(only(result, 'fsevents')).toMatchObject({ hasInstallScript: true });
  });

  test('an entry with no hasInstallScript field omits it rather than defaulting to false', () => {
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    expect(only(result, 'lodash')?.hasInstallScript).toBeUndefined();
  });

  test('an entry resolved to a non-registry host still round-trips resolvedUrl as-is', () => {
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    expect(only(result, 'malicious-pkg')).toMatchObject({
      resolvedUrl: 'https://evil.example.com/x.tgz',
    });
  });

  test('a git dependency has resolvedUrl but no integrity field', () => {
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    const gitEntry = only(result, 'git-pkg');
    expect(gitEntry?.resolvedUrl).toBe(
      'git+https://github.com/user/git-pkg.git#abcdef1234567890abcdef1234567890abcdef12'
    );
    expect(gitEntry?.integrity).toBeUndefined();
  });

  test('nested node_modules/a/node_modules/b resolves to the whole remainder after the final node_modules/', () => {
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    expect(only(result, 'nested-dep')).toMatchObject({ version: '2.0.0' });
  });

  test('a scoped package name (node_modules/@scope/pkg) resolves to the full scoped name', () => {
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    expect(only(result, '@scope/pkg')).toMatchObject({ version: '1.0.0' });
  });

  test('a nested scoped package name (node_modules/host-pkg/node_modules/@scope/b) resolves to the full scoped name', () => {
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    expect(only(result, '@scope/b')).toMatchObject({ version: '1.0.0' });
    expect(only(result, 'host-pkg')).toMatchObject({ version: '1.0.0' });
  });

  test('workspace-local package.json entry (packages/app) is not in entries', () => {
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    expect(result.entries.has('app')).toBe(false);
    expect(result.entries.has('@test/app')).toBe(false);
  });

  test('the node_modules/<name> link entry for a workspace package is not in entries', () => {
    // npm workspaces record two halves per local package: the workspace
    // directory itself (packages/app, already excluded above) and a
    // node_modules/@test/app symlink entry with "link": true whose
    // "resolved" is a relative workspace path, not a registry or tarball
    // URL. Keeping it would make host-comparison checks false-positive on
    // every workspace package.
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    expect(result.entries.has('@test/app')).toBe(false);
  });

  test('the link entry name is not simply dropped -- it is surfaced in workspaceLocalNames', () => {
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    expect(result.workspaceLocalNames).toEqual(new Set(['@test/app']));
  });

  test('an ordinary registry dependency never appears in workspaceLocalNames', () => {
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    expect(result.workspaceLocalNames.has('lodash')).toBe(false);
  });

  test('the root "" entry is not in entries', () => {
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    expect(result.entries.size).toBe(8);
  });

  test('result carries through format and path', () => {
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    expect(result.format).toBe('npm');
    expect(result.path).toBe(PATH);
  });

  test('the fixture parses with no diagnostics', () => {
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    expect(result.diagnostics).toEqual([]);
  });
});

// Issue #69, round 2 (independent review finding): an npm: alias entry is
// keyed by the installed/alias name (see installedNameFromKey), and npm
// writes the resolved package's own "name" field on such an entry -- but
// that field is written by whoever committed the lockfile and is round-
// tripped by npm verbatim, whatever it says, so it must never be trusted on
// its own. It is trusted only when the entry's OWN resolvedUrl vouches for
// it: a registry tarball URL whose path encodes exactly that name
// (resolution.ts's registryTarballPackageName). LockEntry.lookupName is
// where a vouched name lands -- a LOOKUP hint only, never identity (see
// delta.ts and lockfiles/types.ts for why).
describe('parseNpmLockfile alias lookup-name recovery, vouched by the resolved URL (issue #69)', () => {
  function packages(entry: Record<string, unknown>): string {
    return JSON.stringify({
      name: 'test-app',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'test-app', version: '1.0.0', dependencies: { 'host-pkg': '^1.0.0' } },
        'node_modules/host-pkg': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/host-pkg/-/host-pkg-1.0.0.tgz',
          integrity: 'sha512-host',
        },
        'node_modules/host-pkg/node_modules/ui-alias': entry,
      },
    });
  }

  // Modelled on package-lock-v3.json's shape: host-pkg is an ordinary
  // dependency, and its own transitive dependency on "npm:lodash@^4.17.0"
  // installs under the name "ui-alias", nested under host-pkg's own
  // node_modules -- no manifest anywhere declares "ui-alias".
  //
  // Mutation that turns this red: dropping the vouching check in
  // entryFromPackageValue (npm.ts) and setting lookupName from value.name
  // unconditionally -- this test alone would not catch that (the name and
  // the resolved path agree here), which is exactly why the forged-name
  // test below exists.
  test('a transitively aliased entry whose resolved URL matches the "name" field carries a lookupName', () => {
    const result = parseNpmLockfile(
      PATH,
      packages({
        name: 'lodash',
        version: '4.17.21',
        resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
        integrity: 'sha512-transitive-alias',
      })
    );
    expect(only(result, 'ui-alias')).toMatchObject({ version: '4.17.21', lookupName: 'lodash' });
    expect(result.diagnostics).toEqual([]);
  });

  // A scoped real name round-trips through the vouching check too --
  // "/@scope/name/-/name-version.tgz" is npm's registry tarball shape for a
  // scoped package, and registryTarballPackageName has to read the "/"
  // inside the name without mistaking it for the tarball-marker separator.
  test('a scoped real name is recovered the same way', () => {
    const result = parseNpmLockfile(
      PATH,
      packages({
        name: '@scope/real',
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/@scope/real/-/real-1.0.0.tgz',
        integrity: 'sha512-scoped',
      })
    );
    expect(only(result, 'ui-alias')?.lookupName).toBe('@scope/real');
  });

  // The independent review's own experiment: a forged "name" field whose
  // resolved URL names a COMPLETELY DIFFERENT package. Before this fix, a
  // forged name here would have flowed straight into packageName (delta.ts)
  // and cleared this entry's own dependency-confusion and install-script
  // findings by relabelling it (see delta.test.ts and the check-level tests
  // for that proof). At the parser level, the fix is that the resolved
  // path -- "/@corp/secret/-/secret-9.9.9.tgz" -- names "@corp/secret", not
  // "left-pad", so the forged name is never vouched.
  //
  // Mutation that turns this red: removing the
  // `vouched === value.name` comparison (trusting any parseable registry
  // tarball URL regardless of what name it actually names) -- lookupName
  // would then read 'left-pad' and no diagnostic would fire.
  test('a forged "name" field that the resolved URL does not match is never trusted, and is diagnosed', () => {
    const result = parseNpmLockfile(
      PATH,
      packages({
        name: 'left-pad',
        version: '9.9.9',
        resolved: 'https://registry.npmjs.org/@corp/secret/-/secret-9.9.9.tgz',
        integrity: 'sha512-forged',
      })
    );
    expect(only(result, 'ui-alias')?.lookupName).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe('npm-lockfile-unverifiable-name');
    expect(result.diagnostics[0].message).toContain('ui-alias');
    expect(result.diagnostics[0].message).toContain('left-pad');
  });

  // npm also stamps a "name" field onto a transitive git, remote-tarball or
  // file: entry whenever the installed folder differs from the target's own
  // package.json name (arborist's shrinkwrap.js) -- none of those
  // resolutions is a registry tarball, so none can ever vouch, by design,
  // not as a gap. Diagnosed the same way an unvouched registry name is,
  // since the fact ("this name could not be verified") is identical either
  // way.
  test('a "name" field on a git-sourced entry never yields a lookupName', () => {
    const result = parseNpmLockfile(
      PATH,
      packages({
        name: 'upstream-lib',
        version: '1.0.0',
        resolved: 'git+https://github.com/user/upstream-lib.git#abcdef1234567890abcdef1234567890abcdef12',
      })
    );
    expect(only(result, 'ui-alias')?.lookupName).toBeUndefined();
    expect(result.diagnostics.some((d) => d.code === 'npm-lockfile-unverifiable-name')).toBe(true);
  });

  // An ordinary (non-aliased) entry has no "name" field npm needs to write
  // -- the key-derived name already is the real one -- so lookupName must
  // stay absent, with no diagnostic: there is nothing unverifiable about an
  // entry that never claimed a different name in the first place.
  test('an ordinary entry with no "name" field leaves lookupName undefined and raises no diagnostic', () => {
    // host-pkg itself (fixed in the `packages` helper above) never carries a
    // "name" field -- the `entry` argument here is irrelevant to this
    // assertion and kept minimal on purpose.
    const result = parseNpmLockfile(
      PATH,
      packages({ version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' })
    );
    expect(only(result, 'host-pkg')?.lookupName).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });
});

// Reproduces the real npm/cli shape: a workspace sibling declared with an
// ordinary version range (npm gives it no "workspace:" specifier the way
// pnpm and yarn do) and a "link": true entry in the lockfile that is the
// only place recording that the name is local rather than a registry
// install.
describe('parseNpmLockfile workspaceLocalNames', () => {
  const content = JSON.stringify({
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'npm',
        version: '1.0.0',
        dependencies: {
          '@npmcli/mock-registry': '^1.0.0',
          '@npmcli/mock-globals': '^1.0.0',
          lodash: '^4.17.21',
        },
        workspaces: ['workspaces/mock-registry', 'workspaces/mock-globals'],
      },
      'workspaces/mock-registry': { name: '@npmcli/mock-registry', version: '1.0.0' },
      'workspaces/mock-globals': { name: '@npmcli/mock-globals', version: '1.0.0' },
      'node_modules/@npmcli/mock-registry': { resolved: 'workspaces/mock-registry', link: true },
      'node_modules/@npmcli/mock-globals': { resolved: 'workspaces/mock-globals', link: true },
      'node_modules/lodash': {
        version: '4.17.21',
        resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
        integrity: 'sha512-abc==',
      },
    },
  });

  test('every linked workspace member is in workspaceLocalNames', () => {
    const result = parseNpmLockfile(PATH, content);
    expect(result.workspaceLocalNames).toEqual(
      new Set(['@npmcli/mock-registry', '@npmcli/mock-globals'])
    );
  });

  test('linked entries stay out of entries, and a real registry dep is unaffected', () => {
    const result = parseNpmLockfile(PATH, content);
    expect(result.entries.has('@npmcli/mock-registry')).toBe(false);
    expect(result.entries.has('@npmcli/mock-globals')).toBe(false);
    expect(result.entries.get('lodash')).toEqual([
      {
        version: '4.17.21',
        resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
        integrity: 'sha512-abc==',
      },
    ]);
  });
});

describe('parseNpmLockfile v1 lockfile handling', () => {
  test('a v1 shape (no packages map) yields the npm-lockfile-v1 diagnostic and empty entries', () => {
    const v1Content = JSON.stringify({
      name: 'legacy-app',
      version: '1.0.0',
      lockfileVersion: 1,
      requires: true,
      dependencies: {
        lodash: {
          version: '4.17.21',
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
          integrity: 'sha512-abc==',
        },
      },
    });
    const result = parseNpmLockfile(PATH, v1Content);
    expect(result.entries.size).toBe(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe('npm-lockfile-v1');
  });

  test('does not throw for a v1 lockfile', () => {
    const v1Content = JSON.stringify({ name: 'legacy-app', version: '1.0.0', lockfileVersion: 1 });
    expect(() => parseNpmLockfile(PATH, v1Content)).not.toThrow();
  });

  test('a string lockfileVersion of digits is read as that number, so "3" or "2" with no packages map is a parse error', () => {
    expectLockfileParse(() => parseNpmLockfile(PATH, JSON.stringify({ lockfileVersion: '3' })));
    expectLockfileParse(() => parseNpmLockfile(PATH, JSON.stringify({ lockfileVersion: '2' })));
  });

  test('a string lockfileVersion "1", or one that is not digits, still gives the v1 diagnostic', () => {
    for (const version of ['1', 'x', ' 3', '3.0']) {
      const result = parseNpmLockfile(PATH, JSON.stringify({ lockfileVersion: version }));
      expect(result.diagnostics.map((d) => d.code)).toEqual(['npm-lockfile-v1']);
    }
  });

  test('a lockfile with no lockfileVersion field at all is treated as v1, not thrown', () => {
    const content = JSON.stringify({ name: 'legacy-app', version: '1.0.0' });
    const result = parseNpmLockfile(PATH, content);
    expect(result.entries.size).toBe(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe('npm-lockfile-v1');
  });
});

describe('parseNpmLockfile error handling', () => {
  test('invalid JSON throws lockfile-parse', () => {
    expectLockfileParse(() => parseNpmLockfile(PATH, '{not valid json'));
  });

  test('a JSON array as the lockfile root throws lockfile-parse', () => {
    expectLockfileParse(() => parseNpmLockfile(PATH, '[]'));
  });
});

describe('parseNpmLockfile corrupt v2/v3 handling (fail closed, not open)', () => {
  // A lockfile that declares lockfileVersion >= 2 promises a flat
  // "packages" map. If that map has been deleted, truncated, or corrupted
  // by a hand edit, silently falling back to the benign v1 diagnostic
  // (empty entries, no error) would disable every lockfile-backed check
  // without any signal -- so these must throw instead.
  test('lockfileVersion 3 with packages: null throws lockfile-parse', () => {
    const content = JSON.stringify({ lockfileVersion: 3, packages: null });
    expectLockfileParse(() => parseNpmLockfile(PATH, content));
  });

  test('lockfileVersion 3 with packages as a string throws lockfile-parse', () => {
    const content = JSON.stringify({ lockfileVersion: 3, packages: 'x' });
    expectLockfileParse(() => parseNpmLockfile(PATH, content));
  });

  test('lockfileVersion 3 with packages as an array throws lockfile-parse', () => {
    const content = JSON.stringify({ lockfileVersion: 3, packages: [] });
    expectLockfileParse(() => parseNpmLockfile(PATH, content));
  });

  test('lockfileVersion 3 with packages missing entirely throws lockfile-parse', () => {
    const content = JSON.stringify({ lockfileVersion: 3, requires: true });
    expectLockfileParse(() => parseNpmLockfile(PATH, content));
  });

  test('lockfileVersion 2 with packages missing also throws lockfile-parse', () => {
    const content = JSON.stringify({ lockfileVersion: 2 });
    expectLockfileParse(() => parseNpmLockfile(PATH, content));
  });

  test('a well-formed lockfileVersion 3 lockfile with a valid packages map does not throw', () => {
    expect(() => parseNpmLockfile(PATH, FIXTURE_CONTENT)).not.toThrow();
  });
});

describe('parseNpmLockfile multi-version entries', () => {
  test('a top-level entry and a nested entry resolving to the same installed name both survive, in insertion order', () => {
    const content = JSON.stringify({
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'x', version: '1.0.0' },
        'node_modules/dup-pkg': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/dup-pkg/-/dup-pkg-1.0.0.tgz',
        },
        'node_modules/host/node_modules/dup-pkg': {
          version: '9.9.9',
          resolved: 'https://evil.example.com/dup-pkg-9.9.9.tgz',
        },
      },
    });
    const result = parseNpmLockfile(PATH, content);
    // One name, two retained versions -- neither silently overwrites the
    // other, and no npm-lockfile-duplicate-name diagnostic is emitted
    // since nothing is lost.
    expect(result.entries.size).toBe(1);
    expect(result.entries.get('dup-pkg')).toEqual([
      {
        version: '1.0.0',
        resolvedUrl: 'https://registry.npmjs.org/dup-pkg/-/dup-pkg-1.0.0.tgz',
      },
      {
        version: '9.9.9',
        resolvedUrl: 'https://evil.example.com/dup-pkg-9.9.9.tgz',
      },
    ]);
    expect(result.diagnostics.some((d) => d.code === 'npm-lockfile-duplicate-name')).toBe(false);
  });

  test('a name with only one resolved version still yields a one-element array', () => {
    const result = parseNpmLockfile(PATH, FIXTURE_CONTENT);
    expect(result.entries.get('lodash')).toHaveLength(1);
  });
});

describe('parseNpmLockfile defensive handling of unusual package entries', () => {
  test('packages map keys that are legal npm names shadowing Object.prototype are read correctly', () => {
    // "constructor" and "__proto__" are legal npm package names. JSON.parse
    // creates them as genuine own data properties, so an implementation
    // that iterates with Object.entries (rather than bracket-indexing a
    // fixed key list, or trusting `in`/prototype lookups) must see them
    // like any other entry.
    const content = JSON.stringify({
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'x', version: '1.0.0' },
        'node_modules/constructor': { version: '1.0.0', resolved: 'https://registry.npmjs.org/constructor/-/constructor-1.0.0.tgz' },
        'node_modules/__proto__': { version: '2.0.0', resolved: 'https://registry.npmjs.org/__proto__/-/__proto__-2.0.0.tgz' },
        'node_modules/normal-pkg': { version: '3.0.0' },
      },
    });
    const result = parseNpmLockfile(PATH, content);
    expect(result.entries.size).toBe(3);
    expect(only(result, 'constructor')).toMatchObject({ version: '1.0.0' });
    expect(only(result, '__proto__')).toMatchObject({ version: '2.0.0' });
    expect(only(result, 'normal-pkg')).toMatchObject({ version: '3.0.0' });
  });

  test('a packages entry whose value is null is skipped with a diagnostic rather than crashing', () => {
    const content = JSON.stringify({
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'x', version: '1.0.0' },
        'node_modules/broken': null,
        'node_modules/fine': { version: '1.0.0' },
      },
    });
    const result = parseNpmLockfile(PATH, content);
    expect(result.entries.has('broken')).toBe(false);
    expect(only(result, 'fine')).toMatchObject({ version: '1.0.0' });
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
  });

  test('a packages entry whose value is not an object (e.g. a string) is skipped with a diagnostic', () => {
    const content = JSON.stringify({
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'x', version: '1.0.0' },
        'node_modules/broken': 'not-an-object',
        'node_modules/fine': { version: '1.0.0' },
      },
    });
    const result = parseNpmLockfile(PATH, content);
    expect(result.entries.has('broken')).toBe(false);
    expect(only(result, 'fine')).toMatchObject({ version: '1.0.0' });
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
  });
});
