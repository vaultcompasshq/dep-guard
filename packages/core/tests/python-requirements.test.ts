import { parseRequirements } from '../src/python-manifest.js';
import type { ParsedManifest } from '../src/manifest.js';

function parse(text: string, constraint = false): ParsedManifest {
  return parseRequirements('requirements.txt', text, constraint ? { constraint: true } : {});
}

function info(parsed: ParsedManifest) {
  if (parsed.python === undefined) {
    throw new Error('no python info');
  }
  return parsed.python;
}

function classes(parsed: ParsedManifest): string[] {
  return info(parsed).exclusions.map((exclusion) => exclusion.cls);
}

describe('requirements: named requirements', () => {
  test.each([
    ['requests==2.31.0', 'requests', '==2.31.0'],
    ['requests===2.31.0', 'requests', '===2.31.0'],
    ['requests~=2.31', 'requests', '~=2.31'],
    ['requests>=2,<3', 'requests', '>=2,<3'],
    ['requests', 'requests', '*'],
    ['requests[socks]>=2 ; python_version >= "3.8"', 'requests', '>=2'],
    ['requests==2.31.0 --hash=sha256:abc --hash=sha256:def', 'requests', '==2.31.0'],
    ['Python_Dateutil==2.9', 'Python_Dateutil', '==2.9'],
  ])('%s is a pypi dependency', (line, written, specifier) => {
    const parsed = parse(`${line}\n`);
    expect(parsed.deps).toEqual([
      expect.objectContaining({ name: written, protocol: 'pypi', specifier }),
    ]);
    expect(parsed.deps[0]?.registryName).toBe(written.toLowerCase().split('_').join('-'));
    expect(classes(parsed)).toEqual([]);
  });

  test('a backslash continuation joins the next line', () => {
    const parsed = parse('requests==2.31.0 \\\n    --hash=sha256:abc\n');
    expect(parsed.deps).toEqual([expect.objectContaining({ name: 'requests', specifier: '==2.31.0' })]);
  });

  test('a comment needs whitespace before the hash, as pip reads it', () => {
    const parsed = parse('requests==2.31.0  # pinned for now\n# whole line\n');
    expect(parsed.deps.map((dep) => dep.name)).toEqual(['requests']);
  });
});

describe('requirements: the path-shaped option value does not make a path', () => {
  test.each(['reqeusts==2.31 --config-settings=x=a/b', 'reqeusts --global-option=./x'])('%s', (line) => {
    const parsed = parse(`${line}\n`);
    expect(parsed.deps).toEqual([expect.objectContaining({ name: 'reqeusts', protocol: 'pypi' })]);
    expect(classes(parsed)).toEqual([]);
  });
});

describe('requirements: URL and direct-reference branches run first', () => {
  test('name @ url is a url dependency excluded as url', () => {
    const parsed = parse('evil @ https://evil.example/p.whl\n');
    expect(parsed.deps).toEqual([expect.objectContaining({ name: 'evil', protocol: 'url' })]);
    expect(classes(parsed)).toEqual(['url']);
  });

  test('name @ git+ is a git dependency excluded as vcs', () => {
    const parsed = parse('lib @ git+https://example.com/r.git@abc\n');
    expect(parsed.deps).toEqual([expect.objectContaining({ name: 'lib', protocol: 'git' })]);
    expect(classes(parsed)).toEqual(['vcs']);
  });

  test('a bare URL with #egg= takes the egg name', () => {
    const parsed = parse('git+https://example.com/org/r.git@v1#egg=foo\n');
    expect(parsed.deps).toEqual([expect.objectContaining({ name: 'foo', protocol: 'git' })]);
    expect(classes(parsed)).toEqual(['vcs']);
  });

  test('a bare https URL with no #egg= is a url dependency named by host and last segment, never file', () => {
    const parsed = parse('https://example.com/pkg/pkg-1.0.tar.gz\n');
    expect(parsed.deps).toEqual([
      expect.objectContaining({ name: 'example.com/pkg-1.0.tar.gz', protocol: 'url' }),
    ]);
    expect(classes(parsed)).toEqual(['url']);
  });

  test('a token in a bare URL never becomes the dependency name', () => {
    const parsed = parse('https://user:secret@example.com/pkg/pkg-1.0.tar.gz\n');
    expect(parsed.deps[0]?.name).toBe('example.com/pkg-1.0.tar.gz');
  });

  test.each([
    ['ftp://example.com/pkg-1.0.tar.gz', 'url', 'url'],
    ['FTP://example.com/pkg-1.0.zip', 'url', 'url'],
    ['svn://example.com/repo/trunk', 'git', 'vcs'],
    ['svn+https://example.com/repo/trunk#egg=thing', 'git', 'vcs'],
    ['hg+https://example.com/repo#egg=thing', 'git', 'vcs'],
    ['bzr+lp:project#egg=thing', 'git', 'vcs'],
    ['file:///opt/wheels/pkg-1.0-py3-none-any.whl', 'url', 'url'],
  ])('pip is_url scheme %s is %s, never file', (line, protocol, cls) => {
    const parsed = parse(`${line}\n`);
    expect(parsed.deps).toEqual([expect.objectContaining({ protocol })]);
    expect(classes(parsed)).toEqual([cls]);
  });
});

describe('requirements: archives and paths', () => {
  test.each([
    ['reqeusts.zip==1.0', 'reqeusts-zip'],
    ['reqeusts.tar==1.0', 'reqeusts-tar'],
    ['reqeusts.whl>=1', 'reqeusts-whl'],
  ])('%s is a pypi dependency normalised to %s', (line, normalised) => {
    const parsed = parse(`${line}\n`);
    expect(parsed.deps).toEqual([expect.objectContaining({ protocol: 'pypi', registryName: normalised })]);
  });

  test.each([
    'pkg-1.0.whl',
    'pkg-1.0.zip',
    'pkg-1.0.tar.gz',
    'pkg-1.0.tgz',
    'pkg-1.0.tar',
    'pkg-1.0.tar.bz2',
    'pkg-1.0.tbz',
    'pkg-1.0.tar.xz',
    'pkg-1.0.txz',
    'pkg-1.0.tlz',
    'pkg-1.0.tar.lz',
    'pkg-1.0.tar.lzma',
  ])('a bare %s is excluded.path', (line) => {
    const parsed = parse(`${line}\n`);
    expect(parsed.deps.filter((dep) => dep.protocol === 'pypi')).toEqual([]);
    expect(classes(parsed)).toEqual(['path']);
  });

  test('the archive test is case-insensitive, as pip is: pkg.ZIP is an archive, not pkg-zip', () => {
    const parsed = parse('pkg.ZIP\nPKG-1.0-py3-none-any.WHL\n');
    expect(parsed.deps.filter((dep) => dep.protocol === 'pypi')).toEqual([]);
    expect(classes(parsed)).toEqual(['path', 'path']);
  });

  test('mylib-1.0-py3-none-any.whl and vendor/mylib are file, not pypi', () => {
    const parsed = parse('mylib-1.0-py3-none-any.whl\nvendor/mylib\n./local\nC:\\wheels\\x\n');
    expect(parsed.deps.map((dep) => dep.protocol)).toEqual(['file', 'file', 'file', 'file']);
    expect(classes(parsed)).toEqual(['path', 'path', 'path', 'path']);
  });
});

describe('requirements: editable lines', () => {
  test('-e with a path is excluded.editable', () => {
    const parsed = parse('-e .\n--editable ./libs/x\n');
    expect(parsed.deps.filter((dep) => dep.protocol === 'pypi')).toEqual([]);
    expect(classes(parsed)).toEqual(['editable', 'editable']);
  });

  test('-e with a git URL stays a git dependency for the tamper check', () => {
    const parsed = parse('-e git+https://example.com/r.git#egg=thing\n');
    expect(parsed.deps).toEqual([expect.objectContaining({ name: 'thing', protocol: 'git' })]);
    expect(classes(parsed)).toEqual(['editable']);
  });
});

describe('requirements: option spellings', () => {
  const spellings = (short: string, long: string): string[] => [
    `${short} x.txt`,
    `${short}\tx.txt`,
    `${long}=x.txt`,
    `${short}x.txt`,
  ];

  test.each(spellings('-r', '--requirement'))('%j is an include', (line) => {
    const parsed = parse(`${line}\n`);
    expect(info(parsed).includes).toEqual([{ target: 'x.txt', constraint: false, line: 1 }]);
    expect(info(parsed).unread).toEqual([]);
  });

  test.each(spellings('-c', '--constraint'))('%j is a constraint include', (line) => {
    const parsed = parse(`${line}\n`);
    expect(info(parsed).includes).toEqual([{ target: 'x.txt', constraint: true, line: 1 }]);
  });

  test.each([
    '-i https://private.example/simple',
    '-i\thttps://private.example/simple',
    '-ihttps://private.example/simple',
    '--index-url https://private.example/simple',
    '--index-url\thttps://private.example/simple',
    '--index-url=https://private.example/simple',
  ])('%j is an index declaration that replaces PyPI', (line) => {
    const parsed = parse(`${line}\n`);
    expect(info(parsed).index.wide).toEqual([
      { origin: 'https://private.example/simple', option: '--index-url', alsoPypi: false },
    ]);
  });

  test.each([
    '--extra-index-url https://private.example/simple',
    '--extra-index-url\thttps://private.example/simple',
    '--extra-index-url=https://private.example/simple',
    '--extra-index https://private.example/simple',
  ])('%j is an extra index declaration', (line) => {
    const parsed = parse(`${line}\n`);
    expect(info(parsed).index.wide).toEqual([
      { origin: 'https://private.example/simple', option: '--extra-index-url', alsoPypi: true },
    ]);
  });

  test('-f, --find-links= and --no-index are index declarations', () => {
    const parsed = parse('-f ./wheels\n--find-links=https://h.example/w/\n--no-index\n');
    expect(info(parsed).index.wide.map((entry) => entry.option)).toEqual([
      '--find-links',
      '--find-links',
      '--no-index',
    ]);
  });

  test('a unique abbreviation of a long option is read, as optparse reads it', () => {
    const parsed = parse('--requirem=more.txt\n');
    expect(info(parsed).includes).toEqual([{ target: 'more.txt', constraint: false, line: 1 }]);
  });

  test('an ambiguous prefix is an unread line', () => {
    // --requ matches both --requirement and --require-hashes.
    const parsed = parse('--requ=more.txt\n--no\n');
    expect(info(parsed).includes).toEqual([]);
    expect(info(parsed).unread.map((entry) => [entry.line, entry.reason])).toEqual([
      [1, 'unrecognised'],
      [2, 'unrecognised'],
    ]);
    expect(classes(parsed)).toEqual(['unrecognised', 'unrecognised']);
  });

  test('flags pip knows are recognised options, not unread lines', () => {
    const parsed = parse('--pre\n--prefer-binary\n--require-hashes\n--trusted-host h.example\n--only-binary=:all:\n');
    expect(info(parsed).unread).toEqual([]);
    expect(classes(parsed)).toEqual([]);
  });
});

describe('requirements: every unread line is counted', () => {
  test('an unknown option is named with its line number', () => {
    const parsed = parse('requests\n--frobnicate=a\n');
    expect(parsed.deps.map((dep) => dep.name)).toEqual(['requests']);
    expect(info(parsed).unread).toEqual([{ line: 2, reason: 'unrecognised' }]);
    expect(classes(parsed)).toEqual(['unrecognised']);
  });

  test('a line the name pattern rejects is unread', () => {
    const parsed = parse('café==1.0\n');
    expect(parsed.deps).toEqual([]);
    expect(info(parsed).unread).toEqual([{ line: 1, reason: 'unrecognised' }]);
  });

  test.each(['${PRIVATE_PKG}==1.0', '-r ${CI_DIR}/x.txt'])('%s is unread with the environment wording', (line) => {
    const parsed = parse(`${line}\n`);
    expect(parsed.deps).toEqual([]);
    expect(info(parsed).includes).toEqual([]);
    expect(info(parsed).unread).toEqual([{ line: 1, reason: 'env-var' }]);
    expect(classes(parsed)).toEqual(['unrecognised']);
  });

  test('a remote -r target is counted, not followed', () => {
    const parsed = parse('-r https://example.com/reqs.txt\n');
    expect(info(parsed).includes).toEqual([]);
    expect(info(parsed).unread).toEqual([{ line: 1, reason: 'remote-include' }]);
  });
});

describe('requirements: constraint files', () => {
  test('names in a constraint file are counted, never candidates', () => {
    const parsed = parse('requests==2.31\nurllib3<2\n', true);
    expect(parsed.deps).toEqual([]);
    expect(classes(parsed)).toEqual(['constraint', 'constraint']);
    expect(info(parsed).constraint).toBe(true);
  });
});
