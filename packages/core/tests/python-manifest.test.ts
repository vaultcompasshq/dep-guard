import { parsePyproject, parseRequirements } from '../src/python-manifest.js';
import { DepGuardError } from '../src/types.js';

const REV = '0123456789abcdef0123456789abcdef01234567';

describe('parsePyproject', () => {
  test('a dynamic dependencies marker does not steal the classifiers array', () => {
    const parsed = parsePyproject(
      'pyproject.toml',
      [
        '[project]',
        'name = "demo"',
        'dynamic = ["version", "dependencies"]',
        'classifiers = ["Typing :: Typed"]',
        'dependencies = ["requests==2.31.0"]',
        '',
      ].join('\n')
    );

    expect(parsed.deps.map((dep) => dep.name)).toEqual(['requests']);
    expect(parsed.deps.map((dep) => dep.protocol)).toEqual(['pypi']);
  });

  test('a description that mentions dependencies does not read keywords', () => {
    const parsed = parsePyproject(
      'pyproject.toml',
      [
        '[project]',
        'name = "demo"',
        'description = "Lists the dependencies for this app"',
        'keywords = ["alpha", "beta"]',
        'dependencies = ["evil @ https://evil.example/p.whl"]',
        '',
      ].join('\n')
    );

    expect(parsed.deps).toEqual([
      expect.objectContaining({
        name: 'evil',
        protocol: 'url',
        specifier: 'https://evil.example/p.whl',
      }),
    ]);
  });

  test('a direct URL with extras keeps the name and the git protocol', () => {
    const parsed = parsePyproject(
      'pyproject.toml',
      [
        '[project]',
        'dependencies = ["name[extra] @ git+https://example.com/r.git@abc"]',
        '',
      ].join('\n')
    );

    expect(parsed.deps).toEqual([
      expect.objectContaining({
        name: 'name',
        protocol: 'git',
        specifier: 'git+https://example.com/r.git@abc',
      }),
    ]);
  });

  test('a poetry git table is a git dependency pinned at the rev', () => {
    const parsed = parsePyproject(
      'pyproject.toml',
      [
        '[tool.poetry.dependencies]',
        'python = "^3.11"',
        `foo = { git = "https://example.com/r.git", rev = "${REV}" }`,
        '',
      ].join('\n')
    );

    expect(parsed.deps).toEqual([
      expect.objectContaining({
        name: 'foo',
        protocol: 'git',
        specifier: `https://example.com/r.git#${REV}`,
      }),
    ]);
  });

  test('a poetry url table is a url dependency', () => {
    const parsed = parsePyproject(
      'pyproject.toml',
      ['[tool.poetry.dependencies]', 'foo = { url = "https://example.com/p.whl" }', ''].join('\n')
    );

    expect(parsed.deps).toEqual([
      expect.objectContaining({
        name: 'foo',
        protocol: 'url',
        specifier: 'https://example.com/p.whl',
      }),
    ]);
  });

  test('a poetry path table is a file dependency', () => {
    const parsed = parsePyproject(
      'pyproject.toml',
      ['[tool.poetry.dependencies]', 'foo = { path = "../foo" }', ''].join('\n')
    );

    expect(parsed.deps).toEqual([expect.objectContaining({ name: 'foo', protocol: 'file' })]);
  });

  test('a tool-only pyproject has no dependencies', () => {
    const parsed = parsePyproject('pyproject.toml', '[tool.ruff]\nline-length = 100\n');

    expect(parsed.deps).toEqual([]);
  });

  test('text that is not TOML is manifest-parse and names the path', () => {
    let caught: unknown;
    try {
      parsePyproject('apps/bad/pyproject.toml', '[project\nname = "demo"\n');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DepGuardError);
    expect((caught as DepGuardError).code).toBe('manifest-parse');
    expect((caught as DepGuardError).message).toContain('apps/bad/pyproject.toml');
  });
});

describe('review follow-ups', () => {
  test('a space before the extras bracket still makes a URL requirement a git source', () => {
    const parsed = parsePyproject(
      'pyproject.toml',
      ['[project]', 'name = "x"', 'dependencies = ["name [extra] @ git+https://example.com/r.git@abc"]', ''].join('\n')
    );
    expect(parsed.deps).toContainEqual(expect.objectContaining({ name: 'name', protocol: 'git' }));
    const reqs = parseRequirements('requirements.txt', 'name [extra] @ https://example.com/p.whl\n');
    expect(reqs.deps).toContainEqual(expect.objectContaining({ name: 'name', protocol: 'url' }));
  });

  test('a legacy poetry dev-dependencies table is read as devDependencies', () => {
    const parsed = parsePyproject(
      'pyproject.toml',
      ['[tool.poetry.dev-dependencies]', 'foo = { url = "https://example.com/p.whl" }', ''].join('\n')
    );
    expect(parsed.deps).toContainEqual(
      expect.objectContaining({ name: 'foo', protocol: 'url', depType: 'devDependencies' })
    );
  });
});
