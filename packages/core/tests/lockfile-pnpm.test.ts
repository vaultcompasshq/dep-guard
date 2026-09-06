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

// pnpm 12 self-manages the pnpm binary and records that as a SECOND YAML
// document in the same pnpm-lock.yaml. Both orderings exist as fixtures
// because nothing in the format promises which document comes first, and a
// selection rule that quietly means "the last one" would be a coin flip.
const MULTIDOC_FIXTURE_CONTENT = readFileSync(
  fileURLToPath(new URL('./fixtures/pnpm-lock-v9-multidoc.yaml', import.meta.url)),
  'utf8'
);
const MULTIDOC_REVERSED_FIXTURE_CONTENT = readFileSync(
  fileURLToPath(new URL('./fixtures/pnpm-lock-v9-multidoc-reversed.yaml', import.meta.url)),
  'utf8'
);

// A stream of more documents than the parser will read before it fails
// closed (five: one project document plus four self-management documents),
// and a stream at exactly the cap (four: one project plus three
// self-management). WITHOUT the cap both select cleanly -- the
// self-management documents are discarded and the single "." project
// document is chosen -- so the over-cap fixture's only reason to throw is
// the cap itself, which is what makes the cap observable at a small
// document count instead of by building millions.
const OVERCAP_FIXTURE_CONTENT = readFileSync(
  fileURLToPath(new URL('./fixtures/pnpm-lock-v9-overcap.yaml', import.meta.url)),
  'utf8'
);
const ATCAP_FIXTURE_CONTENT = readFileSync(
  fileURLToPath(new URL('./fixtures/pnpm-lock-v9-atcap.yaml', import.meta.url)),
  'utf8'
);

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

// A single-document lockfile with two importers, used as the "project
// lockfile" half of the hand-built multi-document cases below.
const PROJECT_DOC = [
  "lockfileVersion: '9.0'",
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  '      lodash:',
  "        specifier: ^4.17.21",
  '        version: 4.17.21',
  '',
  'packages:',
  '',
  '  lodash@4.17.21:',
  '    resolution: {integrity: sha512-projectdoc}',
  '',
].join('\n');

// The pnpm 12 self-management block: importers that carry only
// packageManagerDependencies, and packages that are only pnpm's own
// binaries.
const SELF_MANAGEMENT_DOC = [
  "lockfileVersion: '9.0'",
  '',
  'importers:',
  '',
  '  .:',
  '    configDependencies: {}',
  '    packageManagerDependencies:',
  '      pnpm:',
  '        specifier: 12.2.1',
  '        version: 12.2.1',
  '',
  'packages:',
  '',
  '  pnpm@12.2.1:',
  '    resolution: {integrity: sha512-selfmanagement}',
  '',
].join('\n');

// A pnpm-lock.yaml is a YAML STREAM, and an attacker who can write the
// lockfile can make it a stream of unboundedly many documents -- a file of
// nothing but "---" separators up to the 64 MB git-output ceiling composes
// one document per separator and then materialises each with toJS(), which
// is a denial-of-service surface. The parser caps the stream at four
// documents (a real pnpm 12 file carries two) and fails closed the moment a
// document past the cap appears, before composing or materialising anything
// beyond it.
describe('parsePnpmLockfile: multi-document cap (fail closed on an oversized stream)', () => {
  test('a stream past the cap fails closed with a lockfile-parse whose message names the cap', () => {
    // Removing the cap makes this fixture select cleanly (four
    // self-management documents discarded, one "." project document read),
    // so the throw asserted here can only come from the cap. That is the
    // mutation signal: drop the cap and this call returns a result instead
    // of throwing, and the test goes red.
    let thrown: unknown;
    try {
      parsePnpmLockfile(PATH, OVERCAP_FIXTURE_CONTENT);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DepGuardError);
    expect((thrown as DepGuardError).code).toBe('lockfile-parse');
    expect((thrown as DepGuardError).message).toContain('more than 4 YAML documents');
  });

  test('a stream at exactly the cap still parses', () => {
    const result = parsePnpmLockfile(PATH, ATCAP_FIXTURE_CONTENT);
    expect([...result.entries.keys()]).toEqual(['lodash']);
    expect(result.entries.has('pnpm')).toBe(false);
  });

  test('a normal two-document lockfile is well within the cap and still parses', () => {
    expect(() => parsePnpmLockfile(PATH, MULTIDOC_FIXTURE_CONTENT)).not.toThrow();
  });
});

describe('parsePnpmLockfile: multi-document lockfiles (pnpm 12 self-management)', () => {
  test('a two-document lockfile parses instead of throwing lockfile-parse', () => {
    expect(() => parsePnpmLockfile(PATH, MULTIDOC_FIXTURE_CONTENT)).not.toThrow();
  });

  test('the project document supplies the entries and the self-management document does not', () => {
    const result = parsePnpmLockfile(PATH, MULTIDOC_FIXTURE_CONTENT);
    expect([...result.entries.keys()].sort()).toEqual(['lodash', 'malicious-pkg']);
    expect(result.entries.has('pnpm')).toBe(false);
    expect(result.entries.has('@pnpm/exe.darwin-arm64')).toBe(false);
  });

  test('the root importer dependencies of the project document are the ones read', () => {
    const result = parsePnpmLockfile(PATH, MULTIDOC_FIXTURE_CONTENT);
    expect(only(result, 'lodash')).toMatchObject({
      version: '4.17.21',
      integrity:
        'sha512-v2kDEe57lecTulaDIuNTPy3Ry4/GNQBALk5xz1CtLwjmpfKUZ0BX57iZfIuA1G+VuHrf1qJUkG5ycOHkQaqQdA==',
    });
  });

  // Nothing in the format promises the self-management document comes
  // first. Taking the first or the last document would pass one of these
  // two orderings and silently read pnpm's own binaries as the whole
  // dependency tree in the other.
  test('the same entries are found when the two documents are in the other order', () => {
    const result = parsePnpmLockfile(PATH, MULTIDOC_REVERSED_FIXTURE_CONTENT);
    expect([...result.entries.keys()].sort()).toEqual(['lodash', 'malicious-pkg']);
    expect(result.entries.has('pnpm')).toBe(false);
  });

  // Silence about a document that was present and not read is
  // indistinguishable from a clean read of the whole file.
  test('the document that was not read is named in a diagnostic', () => {
    const result = parsePnpmLockfile(PATH, MULTIDOC_FIXTURE_CONTENT);
    const notes = result.diagnostics.filter((d) => d.code === 'pnpm-multi-document-lockfile');
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toContain('2 YAML documents');
    expect(notes[0].message).toContain('not scanned');
  });

  // The count is every UNSELECTED document, and step 4 of the selection
  // rule can discard a document that was never classified as
  // self-management at all. Calling the count "self-management
  // document(s)" asserts a cause the number does not carry.
  test('the diagnostic counts unselected documents without claiming what they were', () => {
    const note = parsePnpmLockfile(PATH, MULTIDOC_FIXTURE_CONTENT).diagnostics.find(
      (d) => d.code === 'pnpm-multi-document-lockfile'
    );
    expect(note?.message).toContain('1 document(s) other than the project lockfile');
    expect(note?.message).not.toContain('self-management');
  });

  test('an ordinary single-document lockfile raises no multi-document diagnostic', () => {
    const result = parsePnpmLockfile(PATH, FIXTURE_CONTENT);
    expect(result.diagnostics.filter((d) => d.code === 'pnpm-multi-document-lockfile')).toEqual([]);
  });

  // A single-document parse failure throws today, because parse() throws
  // when the document it composed carries errors. parseAllDocuments does
  // not throw -- it hands the broken document back with its errors on the
  // side -- so an unread errors array would let a document that failed to
  // compose arrive as an ordinary mapping.
  //
  // The broken document here is deliberately the one that would NOT be
  // selected: a project document sits beside it and parses cleanly, so
  // this can only fail closed by reading the errors of a document the
  // selection rule was going to discard anyway. A broken document in the
  // selected position would fail closed for an unrelated reason and prove
  // nothing.
  test('a YAML error in a document the selection rule discards still fails closed', () => {
    expectLockfileParse(() =>
      parsePnpmLockfile(PATH, `lockfileVersion: '9.0'\nsettings:\n  a: 1\n  a: 2\n---\n${PROJECT_DOC}`)
    );
  });

  test('a document in the stream that is not a mapping fails closed', () => {
    expectLockfileParse(() => parsePnpmLockfile(PATH, `${PROJECT_DOC}---\n- a\n- b\n`));
  });

  // Two project-shaped documents is a file shape dep-guard has no rule
  // for, and guessing between them would mean scanning half a tree.
  test('two documents that both look like the project lockfile fail closed', () => {
    expectLockfileParse(() => parsePnpmLockfile(PATH, `${PROJECT_DOC}---\n${PROJECT_DOC}`));
  });

  test('the ambiguity failure names how many documents claimed to be the project lockfile', () => {
    try {
      parsePnpmLockfile(PATH, `${PROJECT_DOC}---\n${PROJECT_DOC}`);
      throw new Error('expected call to throw');
    } catch (err) {
      expect((err as DepGuardError).message).toContain('2 of them');
      expect((err as DepGuardError).message).toContain('cannot tell');
    }
  });

  test('a stream in which no document carries importers fails closed', () => {
    expectLockfileParse(() =>
      parsePnpmLockfile(PATH, "packages:\n  a@1.0.0:\n    resolution: {integrity: x}\n---\npackages:\n  b@1.0.0:\n    resolution: {integrity: y}\n")
    );
  });

  test('a lockfile that is only the self-management document is read as the project lockfile', () => {
    const result = parsePnpmLockfile(PATH, SELF_MANAGEMENT_DOC);
    expect([...result.entries.keys()]).toEqual(['pnpm']);
    expect(result.diagnostics.filter((d) => d.code === 'pnpm-multi-document-lockfile')).toEqual([]);
  });
});
