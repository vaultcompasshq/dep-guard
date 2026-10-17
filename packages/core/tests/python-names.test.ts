import { isValidPythonName, normalizePypiName, pypiDisplayName } from '../src/python-names.js';

describe('normalizePypiName', () => {
  test.each([
    ['Django_REST.framework', 'django-rest-framework'],
    ['a--b', 'a-b'],
    ['A.B_C', 'a-b-c'],
    ['x', 'x'],
    ['Python_Dateutil', 'python-dateutil'],
    ['a._-b', 'a-b'],
  ])('%s normalises to %s', (written, normalised) => {
    expect(normalizePypiName(written)).toBe(normalised);
  });
});

describe('isValidPythonName', () => {
  test.each(['requests', 'Django_REST.framework', 'x', 'a1', 'zope.interface', 'A-b'])('%s is a valid name', (name) => {
    expect(isValidPythonName(name)).toBe(true);
  });

  test.each(['', '-x', 'x-', '.x', 'x.', 'café', 'a b', 'a/b', '${VAR}', 'a@b', 'рequests'])(
    '%j is not a valid name',
    (name) => {
      expect(isValidPythonName(name)).toBe(false);
    }
  );
});

describe('pypiDisplayName', () => {
  test('a written name equal to its normalised form is printed once', () => {
    expect(pypiDisplayName('flask', 'flask')).toBe('"flask"');
  });

  test('a written name that differs adds the PyPI project name once', () => {
    expect(pypiDisplayName('Python_Dateutil', 'python-dateutil')).toBe(
      '"Python_Dateutil" (PyPI project "python-dateutil")'
    );
  });
});
