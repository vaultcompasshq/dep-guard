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
