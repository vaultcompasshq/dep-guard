import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePnpmLockfile, parseOnlyBuilt } from '../src/lockfiles/pnpm.js';
import { DepGuardError } from '../src/types.js';
import type { ParsedManifest } from '../src/manifest.js';

const PATH = '/repo/pnpm-lock.yaml';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/pnpm-lock-v9.yaml', import.meta.url));
const FIXTURE_CONTENT = readFileSync(FIXTURE_PATH, 'utf8');

const WORKSPACE_FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/pnpm-workspace-onlybuilt.yaml', import.meta.url)
);
const WORKSPACE_FIXTURE_CONTENT = readFileSync(WORKSPACE_FIXTURE_PATH, 'utf8');

function expectLockfileParse(fn: () => void): void {
  try {
    fn();
    throw new Error('expected call to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(DepGuardError);
    expect((err as DepGuardError).code).toBe('lockfile-parse');
  }
}

function manifestWithOnlyBuilt(pnpmOnlyBuilt: string[]): ParsedManifest {
  return { path: '/repo/package.json', deps: [], pnpmOnlyBuilt };
}

// entries is Map<string, LockEntry[]> -- most fixture names resolve to
// exactly one version, so tests read the sole element through this helper
// rather than repeating the [0] index everywhere.
function only(result: ReturnType<typeof parsePnpmLockfile>, name: string) {
  const list = result.entries.get(name);
  expect(list).toHaveLength(1);
  return list?.[0];
}

describe('parsePnpmLockfile entry extraction from the v9 fixture', () => {
  test('extracts one entry per packages-section name, ignoring importers', () => {
    const result = parsePnpmLockfile(PATH, FIXTURE_CONTENT);
    expect(result.entries.size).toBe(5);
    expect([...result.entries.keys()].sort()).toEqual(
      ['lodash', '@scope/pkg', 'malicious-pkg', '@scope/withpeer', 'host-pkg'].sort()
    );
  });

  test('an entry with resolution.integrity carries the integrity field', () => {
    const result = parsePnpmLockfile(PATH, FIXTURE_CONTENT);
    expect(only(result, 'lodash')).toMatchObject({
      version: '4.17.21',
      integrity:
        'sha512-v2kDEe57lecTulaDIuNTPy3Ry4/GNQBALk5xz1CtLwjmpfKUZ0BX57iZfIuA1G+VuHrf1qJUkG5ycOHkQaqQdA==',
    });
  });

  test('an entry with resolution.tarball maps tarball to resolvedUrl', () => {
    const result = parsePnpmLockfile(PATH, FIXTURE_CONTENT);
    expect(only(result, 'malicious-pkg')).toMatchObject({
      version: '1.0.0',
      resolvedUrl: 'https://evil.example.com/x.tgz',
    });
    expect(only(result, 'malicious-pkg')?.integrity).toBeUndefined();
  });

  test('a scoped package key resolves to the full scoped name', () => {
    const result = parsePnpmLockfile(PATH, FIXTURE_CONTENT);
    expect(only(result, '@scope/pkg')).toMatchObject({ version: '1.0.0' });
  });

  test('a scoped package key with a peer-dependency suffix strips the suffix from the name and version', () => {
    const result = parsePnpmLockfile(PATH, FIXTURE_CONTENT);
    expect(only(result, '@scope/withpeer')).toMatchObject({ version: '2.0.0' });
  });

  test('hasInstallScript is never set on any entry, since pnpm v9 lockfiles do not record it', () => {
    const result = parsePnpmLockfile(PATH, FIXTURE_CONTENT);
    for (const list of result.entries.values()) {
      for (const entry of list) {
        expect(entry.hasInstallScript).toBeUndefined();
      }
    }
  });

  test('importers entries (workspace package directories) never produce lock entries', () => {
    const result = parsePnpmLockfile(PATH, FIXTURE_CONTENT);
    expect(result.entries.has('.')).toBe(false);
    expect(result.entries.has('packages/app')).toBe(false);
  });

  test('result carries through format and path', () => {
    const result = parsePnpmLockfile(PATH, FIXTURE_CONTENT);
    expect(result.format).toBe('pnpm');
    expect(result.path).toBe(PATH);
  });
});

describe('parsePnpmLockfile registry-name key extraction (scoped/unscoped, slash and no-slash, peer suffix)', () => {
  function keysFor(packagesYaml: string): string[] {
    const content = `lockfileVersion: '9.0'\npackages:\n${packagesYaml}`;
    const result = parsePnpmLockfile(PATH, content);
    return [...result.entries.keys()];
  }

  test('v9 no-slash unscoped key: name@version', () => {
    expect(keysFor("  lodash@4.17.21:\n    resolution: {integrity: sha512-abc==}\n")).toEqual([
      'lodash',
    ]);
  });

  test('v9 no-slash scoped key: @scope/name@version', () => {
    expect(
      keysFor("  '@scope/name@1.2.3':\n    resolution: {integrity: sha512-abc==}\n")
    ).toEqual(['@scope/name']);
  });

  test('legacy slash-prefixed unscoped key: /name@version', () => {
    expect(
      keysFor("  '/name@1.2.3':\n    resolution: {integrity: sha512-abc==}\n")
    ).toEqual(['name']);
  });

  test('legacy slash-prefixed scoped key: /@scope/name@version', () => {
    expect(
      keysFor("  '/@scope/name@1.2.3':\n    resolution: {integrity: sha512-abc==}\n")
    ).toEqual(['@scope/name']);
  });

  test('unscoped key with a peer-dependency suffix resolves to the bare name', () => {
    expect(
      keysFor("  'name@1.2.3(peer@1.0.0)':\n    resolution: {integrity: sha512-abc==}\n")
    ).toEqual(['name']);
  });

  test('scoped key with a peer-dependency suffix resolves to the scoped name', () => {
    expect(
      keysFor("  '@scope/name@1.2.3(peer@1.0.0)':\n    resolution: {integrity: sha512-abc==}\n")
    ).toEqual(['@scope/name']);
  });

  test('a key with multiple parenthetical peer groups still resolves to the bare name', () => {
    expect(
      keysFor(
        "  'name@1.2.3(peerA@1.0.0)(peerB@2.0.0)':\n    resolution: {integrity: sha512-abc==}\n"
      )
    ).toEqual(['name']);
  });
});

describe('parsePnpmLockfile standing install-script diagnostic', () => {
  test('the pnpm-no-install-script-flag diagnostic is always present', () => {
    const result = parsePnpmLockfile(PATH, FIXTURE_CONTENT);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'pnpm-no-install-script-flag' })
    );
  });

  test('the diagnostic is present even for a lockfile with no packages section at all', () => {
    const content = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\n";
    const result = parsePnpmLockfile(PATH, content);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'pnpm-no-install-script-flag' }),
    ]);
    expect(result.entries.size).toBe(0);
  });
});

describe('parsePnpmLockfile defensive handling of unusual package entries', () => {
  test('a packages entry whose value is not a mapping is skipped with a diagnostic', () => {
    const content =
      "lockfileVersion: '9.0'\npackages:\n  broken@1.0.0: not-a-mapping\n  fine@1.0.0:\n    resolution: {integrity: sha512-abc==}\n";
    const result = parsePnpmLockfile(PATH, content);
    expect(result.entries.has('broken')).toBe(false);
    expect(only(result, 'fine')).toMatchObject({ version: '1.0.0' });
    expect(
      result.diagnostics.some((d) => d.code === 'pnpm-lockfile-invalid-entry')
    ).toBe(true);
  });

  test('a packages key that cannot be parsed into name and version is skipped with a diagnostic', () => {
    const content =
      "lockfileVersion: '9.0'\npackages:\n  'no-version-here':\n    resolution: {integrity: sha512-abc==}\n  fine@1.0.0:\n    resolution: {integrity: sha512-abc==}\n";
    const result = parsePnpmLockfile(PATH, content);
    expect(result.entries.has('no-version-here')).toBe(false);
    expect(only(result, 'fine')).toMatchObject({ version: '1.0.0' });
    expect(
      result.diagnostics.some((d) => d.code === 'pnpm-lockfile-invalid-entry')
    ).toBe(true);
  });
});

describe('parsePnpmLockfile multi-version entries', () => {
  test('two packages keys resolving to the same registry name both survive, in insertion order', () => {
    const content =
      "lockfileVersion: '9.0'\npackages:\n  dup-pkg@1.0.0:\n    resolution: {integrity: sha512-old==}\n  dup-pkg@2.0.0:\n    resolution: {integrity: sha512-new==}\n";
    const result = parsePnpmLockfile(PATH, content);
    // One name, two retained versions -- neither silently overwrites the
    // other, and no pnpm-lockfile-duplicate-name diagnostic is emitted
    // since nothing is lost.
    expect(result.entries.size).toBe(1);
    expect(result.entries.get('dup-pkg')).toEqual([
      { version: '1.0.0', integrity: 'sha512-old==' },
      { version: '2.0.0', integrity: 'sha512-new==' },
    ]);
    expect(result.diagnostics.some((d) => d.code === 'pnpm-lockfile-duplicate-name')).toBe(false);
  });

  test('a name with only one resolved version still yields a one-element array', () => {
    const result = parsePnpmLockfile(PATH, FIXTURE_CONTENT);
    expect(result.entries.get('lodash')).toHaveLength(1);
  });
});

describe('parsePnpmLockfile invalid name grammar after version split', () => {
  test('a git+ssh key whose embedded "@" mis-splits the name is skipped with a diagnostic naming the key', () => {
    // Splitting on the last "@" in "mypkg@git+ssh://git@gitlab.com/o/r.git#abc"
    // lands on the "@" inside the embedded ssh URL, not the real
    // name/version separator, yielding the garbage name
    // "mypkg@git+ssh://git" -- validating the extracted name against npm's
    // name grammar catches this instead of silently mis-keying the entry.
    const content =
      "lockfileVersion: '9.0'\npackages:\n  'mypkg@git+ssh://git@gitlab.com/o/r.git#abc':\n    resolution: {integrity: sha512-abc==}\n  fine@1.0.0:\n    resolution: {integrity: sha512-abc==}\n";
    const result = parsePnpmLockfile(PATH, content);
    expect(result.entries.has('mypkg')).toBe(false);
    expect(
      [...result.entries.keys()].some((name) => name.includes('git') || name.includes('://'))
    ).toBe(false);
    expect(only(result, 'fine')).toMatchObject({ version: '1.0.0' });
    const invalidDiagnostics = result.diagnostics.filter(
      (d) => d.code === 'pnpm-lockfile-invalid-entry'
    );
    expect(invalidDiagnostics).toHaveLength(1);
    expect(invalidDiagnostics[0].message).toContain(
      'mypkg@git+ssh://git@gitlab.com/o/r.git#abc'
    );
  });

  test('ordinary scoped and unscoped names pass the grammar check and are kept', () => {
    const result = parsePnpmLockfile(PATH, FIXTURE_CONTENT);
    expect(result.entries.has('lodash')).toBe(true);
    expect(result.entries.has('@scope/pkg')).toBe(true);
  });
});

describe('parsePnpmLockfile allows npm legacy leading underscore/dot names', () => {
  // "_" and "__proto__" are real, already-published npm packages (npm's
  // own registry rules only forbid a leading "." or "_" for NEW
  // publishes, not for names published before that rule existed), and
  // lockfile-npm.test.ts's defensive-handling suite already asserts that
  // parseNpmLockfile keeps a "__proto__"-named entry. A stricter grammar
  // in the pnpm parser that rejected the same name would mean the same
  // dependency is kept by one lockfile format and silently dropped by the
  // other, which is worse than not validating the name at all.
  function keysFor(packagesYaml: string): string[] {
    const content = `lockfileVersion: '9.0'\npackages:\n${packagesYaml}`;
    const result = parsePnpmLockfile(PATH, content);
    return [...result.entries.keys()];
  }

  test('a bare single-underscore package name is kept', () => {
    expect(keysFor('  _@1.0.0:\n    resolution: {integrity: sha512-abc==}\n')).toEqual(['_']);
  });

  test('the __proto__ legacy package name is kept', () => {
    expect(
      keysFor('  __proto__@1.0.0:\n    resolution: {integrity: sha512-abc==}\n')
    ).toEqual(['__proto__']);
  });

  test('a leading-dot legacy package name is kept', () => {
    expect(
      keysFor("  '.foo@1.0.0':\n    resolution: {integrity: sha512-abc==}\n")
    ).toEqual(['.foo']);
  });

  test('the git+ssh URL key with a mis-split name is still rejected', () => {
    const content =
      "lockfileVersion: '9.0'\npackages:\n  'mypkg@git+ssh://git@gitlab.com/o/r.git#abc':\n    resolution: {integrity: sha512-abc==}\n";
    const result = parsePnpmLockfile(PATH, content);
    expect(result.entries.size).toBe(0);
    expect(result.diagnostics.some((d) => d.code === 'pnpm-lockfile-invalid-entry')).toBe(true);
  });
});

describe('parsePnpmLockfile de-dups identical entries on name collision', () => {
  test('a bare key and a pre-v9 peer-suffixed key for the same name+version collapse to one element', () => {
    // A v9 lockfile can carry both a plain packages entry for a name and a
    // pre-v9-shaped peer-suffixed variant that resolves to the identical
    // version/integrity/resolvedUrl. Appending both unconditionally would
    // hold two indistinguishable list elements, which would make the
    // delta step raise a spurious delta-ambiguous-lock-entry diagnostic
    // even though there is nothing actually ambiguous here.
    const content =
      "lockfileVersion: '9.0'\npackages:\n  '@scope/pkg@1.0.0':\n    resolution: {integrity: sha512-abc==}\n  '@scope/pkg@1.0.0(peer@2.0.0)':\n    resolution: {integrity: sha512-abc==}\n";
    const result = parsePnpmLockfile(PATH, content);
    expect(result.entries.get('@scope/pkg')).toEqual([
      { version: '1.0.0', integrity: 'sha512-abc==' },
    ]);
  });

  test('genuinely different versions for the same name still yield two elements', () => {
    const content =
      "lockfileVersion: '9.0'\npackages:\n  dup-pkg@1.0.0:\n    resolution: {integrity: sha512-old==}\n  dup-pkg@2.0.0:\n    resolution: {integrity: sha512-new==}\n";
    const result = parsePnpmLockfile(PATH, content);
    expect(result.entries.get('dup-pkg')).toHaveLength(2);
  });

  test('the same version but a different integrity still yields two elements (not a duplicate)', () => {
    const content =
      "lockfileVersion: '9.0'\npackages:\n  dup-pkg@1.0.0:\n    resolution: {integrity: sha512-old==}\n  'dup-pkg@1.0.0(peer@2.0.0)':\n    resolution: {integrity: sha512-different==}\n";
    const result = parsePnpmLockfile(PATH, content);
    expect(result.entries.get('dup-pkg')).toHaveLength(2);
  });
});

describe('parsePnpmLockfile prefers an explicit value.version over the key-derived version', () => {
  test('a tarball/URL-keyed entry with a real version field uses that version, not the URL-ish key remainder', () => {
    const content =
      "lockfileVersion: '9.0'\npackages:\n  'mypkg@https://github.com/owner/repo/tar.gz':\n    resolution: {tarball: https://github.com/owner/repo/tar.gz}\n    version: 4.5.6\n";
    const result = parsePnpmLockfile(PATH, content);
    expect(only(result, 'mypkg')).toMatchObject({
      version: '4.5.6',
      resolvedUrl: 'https://github.com/owner/repo/tar.gz',
    });
  });

  test('a normal entry with no explicit value.version still falls back to the key-derived version', () => {
    const result = parsePnpmLockfile(PATH, FIXTURE_CONTENT);
    expect(only(result, 'lodash')).toMatchObject({ version: '4.17.21' });
  });
});

describe('parsePnpmLockfile error handling', () => {
  test('malformed YAML throws lockfile-parse', () => {
    expectLockfileParse(() => parsePnpmLockfile(PATH, "foo: 'bar\n"));
  });

  test('a YAML scalar as the lockfile root throws lockfile-parse', () => {
    expectLockfileParse(() => parsePnpmLockfile(PATH, 'just-a-string'));
  });

  test('lockfileVersion 9.0 with "packages" present but not a mapping throws lockfile-parse', () => {
    expectLockfileParse(() =>
      parsePnpmLockfile(PATH, "lockfileVersion: '9.0'\npackages: 'not-a-mapping'\n")
    );
  });

  test('a well-formed v9 lockfile does not throw', () => {
    expect(() => parsePnpmLockfile(PATH, FIXTURE_CONTENT)).not.toThrow();
  });
});

describe('parsePnpmLockfile "packages: null" handling', () => {
  test('a dangling "packages:" key with no value (parses as null) throws lockfile-parse', () => {
    // This is the same truncated-hand-edit shape the non-plain-object
    // throw already exists for -- "packages:" with nothing after it
    // parses to null, not to an empty mapping, and must not be confused
    // with the genuinely absent-key valid-empty case.
    expectLockfileParse(() => parsePnpmLockfile(PATH, "lockfileVersion: '9.0'\npackages:\n"));
  });

  test('an absent "packages" key entirely is still valid-empty, not a throw', () => {
    const content = "lockfileVersion: '9.0'\n";
    expect(() => parsePnpmLockfile(PATH, content)).not.toThrow();
    const result = parsePnpmLockfile(PATH, content);
    expect(result.entries.size).toBe(0);
  });
});

describe('parseOnlyBuilt', () => {
  test('merges pnpm-workspace.yaml onlyBuiltDependencies with every manifest pnpm block', () => {
    const manifests = [
      manifestWithOnlyBuilt(['esbuild', 'sharp']),
      manifestWithOnlyBuilt(['sharp', 'bcrypt']),
    ];
    const result = parseOnlyBuilt(WORKSPACE_FIXTURE_CONTENT, manifests);
    expect(result.sort()).toEqual(
      ['esbuild', '@scope/native-pkg', 'sharp', 'bcrypt'].sort()
    );
  });

  test('dedupes a name that appears in both the workspace yaml and a manifest', () => {
    const manifests = [manifestWithOnlyBuilt(['esbuild'])];
    const result = parseOnlyBuilt(WORKSPACE_FIXTURE_CONTENT, manifests);
    expect(result.filter((name) => name === 'esbuild')).toHaveLength(1);
  });

  test('null workspace content with manifests only returns the manifests union', () => {
    const manifests = [manifestWithOnlyBuilt(['a']), manifestWithOnlyBuilt(['b', 'a'])];
    const result = parseOnlyBuilt(null, manifests);
    expect(result.sort()).toEqual(['a', 'b']);
  });

  test('workspace content with no manifests returns just the workspace list', () => {
    const result = parseOnlyBuilt(WORKSPACE_FIXTURE_CONTENT, []);
    expect(result.sort()).toEqual(['esbuild', '@scope/native-pkg'].sort());
  });

  test('null workspace content and no manifests returns an empty array', () => {
    expect(parseOnlyBuilt(null, [])).toEqual([]);
  });

  test('a workspace yaml with no onlyBuiltDependencies key contributes nothing', () => {
    const result = parseOnlyBuilt("packages:\n  - 'packages/*'\n", [manifestWithOnlyBuilt(['x'])]);
    expect(result).toEqual(['x']);
  });

  test('malformed workspace YAML throws lockfile-parse', () => {
    expectLockfileParse(() => parseOnlyBuilt("foo: 'bar\n", []));
  });

  test('onlyBuiltDependencies that is not an array of strings throws lockfile-parse', () => {
    expectLockfileParse(() => parseOnlyBuilt('onlyBuiltDependencies: not-an-array\n', []));
  });

  test('onlyBuiltDependencies set to a mapping (not an array) still throws lockfile-parse', () => {
    expectLockfileParse(() => parseOnlyBuilt('onlyBuiltDependencies:\n  foo: bar\n', []));
  });

  describe('benign empty-document handling', () => {
    test('an empty workspace yaml content string does not throw and contributes nothing', () => {
      expect(() => parseOnlyBuilt('', [])).not.toThrow();
      expect(parseOnlyBuilt('', [manifestWithOnlyBuilt(['x'])])).toEqual(['x']);
    });

    test('a comment-only workspace yaml (parses to a null document) does not throw', () => {
      const result = parseOnlyBuilt('# just a comment, no content\n', [
        manifestWithOnlyBuilt(['x']),
      ]);
      expect(result).toEqual(['x']);
    });

    test('an "onlyBuiltDependencies:" key with no value (null) is treated as an empty list, not a throw', () => {
      const result = parseOnlyBuilt("packages:\n  - 'packages/*'\nonlyBuiltDependencies:\n", [
        manifestWithOnlyBuilt(['x']),
      ]);
      expect(result).toEqual(['x']);
    });
  });
});
