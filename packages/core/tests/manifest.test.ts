import { parseManifest } from '../src/manifest.js';
import { DepGuardError } from '../src/types.js';

const PATH = '/repo/package.json';

function manifestWith(deps: Record<string, string>): string {
  return JSON.stringify({ name: 'x', version: '1.0.0', dependencies: deps });
}

function expectManifestParse(fn: () => void): void {
  try {
    fn();
    throw new Error('expected parseManifest to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(DepGuardError);
    expect((err as DepGuardError).code).toBe('manifest-parse');
  }
}

describe('parseManifest classification', () => {
  test('workspace:* classifies as workspace', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'workspace:*' }));
    expect(result.deps[0]).toMatchObject({
      name: 'foo',
      registryName: 'foo',
      specifier: 'workspace:*',
      depType: 'dependencies',
      protocol: 'workspace',
    });
  });

  test('catalog: prefix classifies as catalog', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'catalog:' }));
    expect(result.deps[0].protocol).toBe('catalog');
  });

  test('named catalog specifier classifies as catalog', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'catalog:react18' }));
    expect(result.deps[0].protocol).toBe('catalog');
  });

  test('link: classifies as link', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'link:../foo' }));
    expect(result.deps[0].protocol).toBe('link');
  });

  test('portal: classifies as link', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'portal:../foo' }));
    expect(result.deps[0].protocol).toBe('link');
  });

  test('patch: classifies as patch', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'patch:foo@npm%3A1.0.0#./patches/foo.patch' }));
    expect(result.deps[0].protocol).toBe('patch');
  });

  test('file: classifies as file', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'file:../foo.tgz' }));
    expect(result.deps[0].protocol).toBe('file');
  });

  test('git+ classifies as git', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'git+https://example.com/foo.git' }));
    expect(result.deps[0].protocol).toBe('git');
  });

  test('github: classifies as git', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'github:user/repo' }));
    expect(result.deps[0].protocol).toBe('git');
  });

  test('git: classifies as git', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'git://example.com/foo.git' }));
    expect(result.deps[0].protocol).toBe('git');
  });

  test('http url classifies as url', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'http://example.com/foo.tgz' }));
    expect(result.deps[0].protocol).toBe('url');
  });

  test('https url classifies as url', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'https://example.com/foo.tgz' }));
    expect(result.deps[0].protocol).toBe('url');
  });

  test('npm alias with unscoped target sets registryName to the target', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'npm:lodash@4.17.21' }));
    expect(result.deps[0]).toMatchObject({
      name: 'foo',
      registryName: 'lodash',
      protocol: 'alias',
    });
  });

  test('npm alias with scoped target strips the leading scope correctly', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'npm:@scope/pkg@1.0.0' }));
    expect(result.deps[0]).toMatchObject({
      name: 'foo',
      registryName: '@scope/pkg',
      protocol: 'alias',
    });
  });

  test('npm alias with no version keeps the whole target as registryName', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'npm:lodash' }));
    expect(result.deps[0]).toMatchObject({
      registryName: 'lodash',
      protocol: 'alias',
    });
  });

  test('npm alias with scoped target and no version keeps the whole target', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'npm:@scope/pkg' }));
    expect(result.deps[0]).toMatchObject({
      registryName: '@scope/pkg',
      protocol: 'alias',
    });
  });

  test('plain semver range classifies as registry (the default)', () => {
    const result = parseManifest(PATH, manifestWith({ foo: '^1.2.3' }));
    expect(result.deps[0]).toMatchObject({
      name: 'foo',
      registryName: 'foo',
      protocol: 'registry',
    });
  });

  test('bare version classifies as registry', () => {
    const result = parseManifest(PATH, manifestWith({ foo: '1.2.3' }));
    expect(result.deps[0].protocol).toBe('registry');
  });

  test('dist-tag like "latest" classifies as registry', () => {
    const result = parseManifest(PATH, manifestWith({ foo: 'latest' }));
    expect(result.deps[0].protocol).toBe('registry');
  });
});

describe('parseManifest dep type collection', () => {
  test('collects deps from all four dependency sections', () => {
    const content = JSON.stringify({
      name: 'x',
      version: '1.0.0',
      dependencies: { a: '1.0.0' },
      devDependencies: { b: '1.0.0' },
      optionalDependencies: { c: '1.0.0' },
      peerDependencies: { d: '1.0.0' },
    });
    const result = parseManifest(PATH, content);
    const byType = new Map(result.deps.map((dep) => [dep.depType, dep.name]));
    expect(result.deps).toHaveLength(4);
    expect(byType.get('dependencies')).toBe('a');
    expect(byType.get('devDependencies')).toBe('b');
    expect(byType.get('optionalDependencies')).toBe('c');
    expect(byType.get('peerDependencies')).toBe('d');
  });

  test('missing dependency sections yield an empty deps array', () => {
    const result = parseManifest(PATH, JSON.stringify({ name: 'x', version: '1.0.0' }));
    expect(result.deps).toEqual([]);
  });
});

describe('parseManifest pnpmOnlyBuilt', () => {
  test('reads pnpm.onlyBuiltDependencies when present', () => {
    const content = JSON.stringify({
      name: 'x',
      version: '1.0.0',
      pnpm: { onlyBuiltDependencies: ['esbuild', 'sharp'] },
    });
    const result = parseManifest(PATH, content);
    expect(result.pnpmOnlyBuilt).toEqual(['esbuild', 'sharp']);
  });

  test('defaults to an empty array when pnpm field is absent', () => {
    const result = parseManifest(PATH, JSON.stringify({ name: 'x', version: '1.0.0' }));
    expect(result.pnpmOnlyBuilt).toEqual([]);
  });

  test('defaults to an empty array when onlyBuiltDependencies is absent', () => {
    const content = JSON.stringify({ name: 'x', version: '1.0.0', pnpm: {} });
    const result = parseManifest(PATH, content);
    expect(result.pnpmOnlyBuilt).toEqual([]);
  });

  test('non-array onlyBuiltDependencies throws manifest-parse', () => {
    const content = JSON.stringify({
      name: 'x',
      version: '1.0.0',
      pnpm: { onlyBuiltDependencies: 'esbuild' },
    });
    expectManifestParse(() => parseManifest(PATH, content));
  });
});

describe('parseManifest error handling', () => {
  test('malformed JSON throws manifest-parse', () => {
    expectManifestParse(() => parseManifest(PATH, '{not valid json'));
  });

  test('a JSON array as the manifest root throws manifest-parse', () => {
    expectManifestParse(() => parseManifest(PATH, '[]'));
  });

  test('a dependencies section that is not an object throws manifest-parse', () => {
    const content = JSON.stringify({ name: 'x', version: '1.0.0', dependencies: ['not-an-object'] });
    expectManifestParse(() => parseManifest(PATH, content));
  });

  test('a dependency value that is a number throws manifest-parse instead of crashing', () => {
    const content = JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { foo: 1 } });
    expectManifestParse(() => parseManifest(PATH, content));
  });

  test('a dependency value that is null throws manifest-parse instead of crashing', () => {
    const content = JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { foo: null } });
    expectManifestParse(() => parseManifest(PATH, content));
  });

  test('a dependency value that is an object throws manifest-parse instead of crashing', () => {
    const content = JSON.stringify({
      name: 'x',
      version: '1.0.0',
      dependencies: { foo: { version: '1.0.0' } },
    });
    expectManifestParse(() => parseManifest(PATH, content));
  });
});

describe('parseManifest prototype pollution trap', () => {
  // "constructor" and "__proto__" are legal npm package names. JSON.parse
  // creates them as real own data properties (it uses CreateDataProperty
  // internally, unlike an object literal), so Object.entries sees them
  // like any other dependency -- but only if the implementation iterates
  // with Object.entries rather than bracket-indexing a fixed key list.
  test('a dependency literally named "constructor" is parsed like any other', () => {
    const content = JSON.stringify({
      name: 'x',
      version: '1.0.0',
      dependencies: { constructor: '1.0.0', 'normal-pkg': '2.0.0' },
    });
    const result = parseManifest(PATH, content);
    const names = result.deps.map((dep) => dep.name).sort();
    expect(names).toEqual(['constructor', 'normal-pkg']);
    const ctorDep = result.deps.find((dep) => dep.name === 'constructor');
    expect(ctorDep).toMatchObject({ registryName: 'constructor', specifier: '1.0.0', protocol: 'registry' });
  });

  test('a dependency literally named "__proto__" is parsed like any other', () => {
    // Built as a raw JSON string rather than a JS object literal on
    // purpose: `{ '__proto__': v }` in source is special-cased by the
    // object literal grammar to set the prototype (and silently no-ops
    // since v isn't an object), so JSON.stringify-ing a JS literal would
    // never actually produce a "__proto__" key to test against.
    // JSON.parse has no such special case -- it uses CreateDataProperty --
    // so parsing this raw string does yield a genuine own property.
    const content = '{"name":"x","version":"1.0.0","dependencies":{"__proto__":"1.0.0"}}';
    const result = parseManifest(PATH, content);
    expect(result.deps).toHaveLength(1);
    expect(result.deps[0]).toMatchObject({
      name: '__proto__',
      registryName: '__proto__',
      specifier: '1.0.0',
      protocol: 'registry',
    });
  });
});

describe('parseManifest path field', () => {
  test('result carries through the given path', () => {
    const result = parseManifest(PATH, manifestWith({ foo: '1.0.0' }));
    expect(result.path).toBe(PATH);
  });
});
