import { isPypiOrigin, normalizeIndexOrigin } from '../src/python-index.js';

describe('normalizeIndexOrigin', () => {
  test.each([
    ['https://PyPI.org/simple/', 'https://pypi.org/simple'],
    ['HTTPS://Private.Example:443/simple/', 'https://private.example/simple'],
    ['http://private.example:80/simple', 'http://private.example/simple'],
    ['https://private.example:8443/simple//', 'https://private.example:8443/simple'],
    ['https://user:secret@private.example/simple', 'https://private.example/simple'],
    ['https://token@private.example/simple?x=1#frag', 'https://private.example/simple'],
    ['./wheels/', './wheels'],
  ])('%s becomes %s', (raw, normalised) => {
    expect(normalizeIndexOrigin(raw)).toBe(normalised);
  });

  test('userinfo in text that does not parse as a URL is still removed', () => {
    expect(normalizeIndexOrigin('user:secret@not a url/simple')).not.toContain('secret');
  });
});

describe('isPypiOrigin', () => {
  test.each([
    'https://pypi.org/simple',
    'https://pypi.org/pypi',
    'http://pypi.org/simple',
    'https://pypi.python.org/simple',
    'https://files.pythonhosted.org',
    'https://pypi.org',
  ])('%s is PyPI', (origin) => {
    expect(isPypiOrigin(normalizeIndexOrigin(origin))).toBe(true);
  });

  test.each([
    'https://private.example/simple',
    'https://pypi.org.evil.example/simple',
    'https://test.pypi.org/simple',
    './wheels',
    'no index',
  ])('%s is not PyPI', (origin) => {
    expect(isPypiOrigin(normalizeIndexOrigin(origin))).toBe(false);
  });
});
