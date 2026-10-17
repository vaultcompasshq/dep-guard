import { parsePipfile, parsePyproject, parseUvToml } from '../src/python-manifest.js';
import type { ParsedManifest } from '../src/manifest.js';
import { DepGuardError } from '../src/types.js';

function toml(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

function pyproject(lines: string[]): ParsedManifest {
  return parsePyproject('pyproject.toml', toml(lines));
}

function python(parsed: ParsedManifest) {
  if (parsed.python === undefined) {
    throw new Error('no python info');
  }
  return parsed.python;
}

function parseError(run: () => unknown): DepGuardError {
  try {
    run();
  } catch (err) {
    if (err instanceof DepGuardError) {
      return err;
    }
    throw err;
  }
  throw new Error('expected a DepGuardError');
}

describe('pyproject.toml: newly read tables', () => {
  test('[dependency-groups] with an include-group table parses, and the table is not a name', () => {
    const parsed = pyproject([
      '[dependency-groups]',
      'test = ["pytest>=8", { include-group = "lint" }]',
      'lint = ["ruff"]',
    ]);
    expect(parsed.deps.map((dep) => [dep.name, dep.protocol])).toEqual([
      ['pytest', 'pypi'],
      ['ruff', 'pypi'],
    ]);
  });

  test('a malformed [dependency-groups] entry is manifest-parse', () => {
    const err = parseError(() => pyproject(['[dependency-groups]', 'test = [1]']));
    expect(err.code).toBe('manifest-parse');
  });

  test('build-system.requires, [tool.uv] dev-dependencies and [tool.pdm.dev-dependencies] are read', () => {
    const parsed = pyproject([
      '[build-system]',
      'requires = ["hatchling"]',
      '[tool.uv]',
      'dev-dependencies = ["mypy"]',
      '[tool.pdm.dev-dependencies]',
      'test = ["coverage"]',
    ]);
    expect(parsed.deps.map((dep) => dep.name)).toEqual(['hatchling', 'mypy', 'coverage']);
  });

  test('a git string in build-system.requires is a git dependency', () => {
    const parsed = pyproject(['[build-system]', 'requires = ["lib @ git+https://example.com/r.git"]']);
    expect(parsed.deps).toEqual([expect.objectContaining({ name: 'lib', protocol: 'git' })]);
    expect(python(parsed).exclusions.map((entry) => entry.cls)).toEqual(['vcs']);
  });

  test('a malformed build-system.requires is manifest-parse', () => {
    expect(parseError(() => pyproject(['[build-system]', 'requires = "hatchling"'])).code).toBe('manifest-parse');
  });

  const tokenKey = '"g@https://user:s3cr3tTOKEN@example.com"';
  test.each([
    ['an optional-dependencies group', ['[project.optional-dependencies]', `${tokenKey} = 3`]],
    ['a PDM dev group', ['[tool.pdm.dev-dependencies]', `${tokenKey} = 3`]],
    ['a [dependency-groups] group', ['[dependency-groups]', `${tokenKey} = 3`]],
    ['a [dependency-groups] entry', ['[dependency-groups]', `${tokenKey} = [3]`]],
  ])('the manifest-parse message for %s never echoes a token in its key', (_label, lines) => {
    const err = parseError(() => pyproject(lines));
    expect(err.code).toBe('manifest-parse');
    expect(err.message).not.toContain('s3cr3tTOKEN');
  });

  test('a pdm -e dev entry is excluded.editable, not an invalid name', () => {
    const parsed = pyproject([
      '[tool.pdm.dev-dependencies]',
      'dev = ["-e file:///${PROJECT_ROOT}/libs/x#egg=x", "--editable git+https://example.com/y.git#egg=y", "pytest"]',
    ]);
    expect(parsed.deps.filter((dep) => dep.protocol === 'pypi').map((dep) => dep.name)).toEqual(['pytest']);
    expect(parsed.deps.filter((dep) => dep.protocol === 'git').map((dep) => dep.name)).toEqual(['y']);
    expect(python(parsed).exclusions.map((entry) => entry.cls)).toEqual(['editable', 'editable']);
    expect(python(parsed).invalidNames).toEqual([]);
  });
});

describe('pyproject.toml: self reference', () => {
  test('mypkg[test] inside mypkg is excluded.self', () => {
    const parsed = pyproject([
      '[project]',
      'name = "MyPkg"',
      'dependencies = ["requests"]',
      '[project.optional-dependencies]',
      'all = ["mypkg[test]"]',
    ]);
    expect(parsed.deps.map((dep) => dep.name)).toEqual(['requests']);
    expect(python(parsed).exclusions).toEqual([{ cls: 'self', name: 'mypkg' }]);
  });

  test('tool.poetry.name drives the self-reference exclusion for a Poetry 1 project', () => {
    const parsed = pyproject([
      '[tool.poetry]',
      'name = "my_pkg"',
      '[tool.poetry.dependencies]',
      'python = "^3.11"',
      'My-Pkg = { version = "*", extras = ["x"] }',
      'click = "^8"',
    ]);
    expect(parsed.deps.map((dep) => dep.name)).toEqual(['click']);
    expect(python(parsed).exclusions.map((entry) => entry.cls)).toEqual(['self']);
  });
});

describe('non-ASCII table keys are invalid names', () => {
  test('a poetry key', () => {
    const parsed = pyproject(['[tool.poetry.dependencies]', '"café" = "*"']);
    expect(parsed.deps).toEqual([]);
    expect(python(parsed).exclusions.map((entry) => entry.cls)).toEqual(['invalidName']);
    // Only the leading name characters are kept for display (B2).
    expect(python(parsed).invalidNames).toEqual(['caf...']);
  });

  test('a Pipfile key', () => {
    const parsed = parsePipfile('Pipfile', toml(['[packages]', '"рequests" = "*"']));
    expect(parsed.deps).toEqual([]);
    expect(python(parsed).exclusions.map((entry) => entry.cls)).toEqual(['invalidName']);
  });

  test('a [tool.uv.sources] key', () => {
    const parsed = pyproject(['[tool.uv.sources]', '"café" = { path = "x" }']);
    expect(python(parsed).uvSources).toEqual([]);
    expect(python(parsed).exclusions.map((entry) => entry.cls)).toEqual(['invalidName']);
  });
});

describe('index declarations', () => {
  test('[[tool.uv.index]] with explicit = true is named, not wide', () => {
    const parsed = pyproject([
      '[[tool.uv.index]]',
      'name = "corp"',
      'url = "https://user:tok@private.example/simple/"',
      'explicit = true',
      '[tool.uv.sources]',
      'acme = { index = "corp" }',
    ]);
    const index = python(parsed).index;
    expect(index.wide).toEqual([]);
    expect(index.named).toEqual([{ name: 'corp', origin: 'https://private.example/simple', explicit: true }]);
    expect(index.perName).toEqual([{ dep: 'acme', index: 'corp' }]);
  });

  test('a non-explicit uv index, index-url and extra-index-url are wide', () => {
    const parsed = pyproject([
      '[tool.uv]',
      'index-url = "https://a.example/simple"',
      'extra-index-url = ["https://b.example/simple"]',
      '[[tool.uv.index]]',
      'url = "https://c.example/simple"',
    ]);
    expect(python(parsed).index.wide.map((entry) => [entry.origin, entry.alsoPypi])).toEqual([
      ['https://a.example/simple', false],
      ['https://b.example/simple', true],
      ['https://c.example/simple', true],
    ]);
  });

  test('a poetry source is wide unless explicit, and a dependency source key is a per-name mapping', () => {
    const parsed = pyproject([
      '[[tool.poetry.source]]',
      'name = "corp"',
      'url = "https://private.example/simple"',
      'priority = "supplemental"',
      '[[tool.poetry.source]]',
      'name = "pins"',
      'url = "https://pins.example/simple"',
      'priority = "explicit"',
      '[tool.poetry.dependencies]',
      'thing = { version = "^1", source = "pins" }',
    ]);
    const index = python(parsed).index;
    expect(index.wide.map((entry) => entry.origin)).toEqual(['https://private.example/simple']);
    expect(index.named.map((entry) => [entry.name, entry.explicit])).toEqual([
      ['corp', false],
      ['pins', true],
    ]);
    expect(index.perName).toEqual([{ dep: 'thing', index: 'pins' }]);
  });

  test('[[tool.pdm.source]] is wide', () => {
    const parsed = pyproject(['[[tool.pdm.source]]', 'name = "corp"', 'url = "https://private.example/simple"']);
    expect(python(parsed).index.wide.map((entry) => entry.origin)).toEqual(['https://private.example/simple']);
  });

  test('a repository uv.toml contributes index declarations and no dependencies', () => {
    const parsed = parseUvToml('uv.toml', toml(['index-url = "https://private.example/simple"']));
    expect(parsed.deps).toEqual([]);
    expect(python(parsed).index.wide.map((entry) => entry.origin)).toEqual(['https://private.example/simple']);
  });
});

describe('[tool.uv.sources] and [tool.uv.workspace]', () => {
  test('each source kind is read', () => {
    const parsed = pyproject([
      '[tool.uv.sources]',
      'a = { git = "https://example.com/a.git", rev = "abc" }',
      'b = { url = "https://example.com/b.whl" }',
      'c = { path = "libs/c" }',
      'd = { path = "libs/d", editable = true }',
      'e = { workspace = true }',
      'f = { index = "corp" }',
      '[tool.uv.workspace]',
      'members = ["packages/*"]',
      'exclude = ["packages/old"]',
    ]);
    expect(python(parsed).uvSources.map((entry) => [entry.dep, entry.sources[0]?.kind])).toEqual([
      ['a', 'git'],
      ['b', 'url'],
      ['c', 'path'],
      ['d', 'editable'],
      ['e', 'workspace'],
      ['f', 'index'],
    ]);
    expect(python(parsed).uvWorkspace).toEqual({ members: ['packages/*'], exclude: ['packages/old'] });
  });

  test('a source of no known kind is manifest-parse', () => {
    expect(parseError(() => pyproject(['[tool.uv.sources]', 'a = { frob = 1 }'])).code).toBe('manifest-parse');
  });
});

describe('Pipfile', () => {
  test('[packages] and [dev-packages] are read with their source kinds', () => {
    const parsed = parsePipfile(
      'Pipfile',
      toml([
        '[[source]]',
        'name = "pypi"',
        'url = "https://pypi.org/simple"',
        'verify_ssl = true',
        '[packages]',
        'requests = "*"',
        'flask = { version = "==3.0", index = "pypi" }',
        'lib = { git = "https://example.com/lib.git", ref = "abc" }',
        'local = { path = "./local", editable = true }',
        '[dev-packages]',
        'pytest = "*"',
      ])
    );
    expect(parsed.deps.map((dep) => [dep.name, dep.protocol, dep.depType])).toEqual([
      ['requests', 'pypi', 'dependencies'],
      ['flask', 'pypi', 'dependencies'],
      ['lib', 'git', 'dependencies'],
      ['local', 'file', 'dependencies'],
      ['pytest', 'pypi', 'devDependencies'],
    ]);
    expect(python(parsed).exclusions.map((entry) => entry.cls)).toEqual(['vcs', 'editable']);
    expect(python(parsed).index.perName).toEqual([{ dep: 'flask', index: 'pypi' }]);
  });

  test('a Pipfile that is not TOML is manifest-parse naming the path', () => {
    const err = parseError(() => parsePipfile('apps/x/Pipfile', '[packages\nrequests = "*"\n'));
    expect(err.code).toBe('manifest-parse');
    expect(err.message).toContain('apps/x/Pipfile');
  });
});
