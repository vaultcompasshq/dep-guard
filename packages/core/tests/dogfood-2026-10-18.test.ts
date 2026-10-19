// Adoption blockers found by running dep-guard against public repositories
// on 2026-10-18, each reproduced here end to end from the files that showed
// it: a Python git requirement pinned by full commit id read as unpinned
// and attributed to an unrelated npm lockfile, a pnpm v5.4 lockfile whose
// "packages:" key is empty, and lockfile-parse failures reported one per
// run instead of all at once.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadStates } from '../src/git-source.js';
import { scan } from '../src/scan.js';
import type { ScanResult } from '../src/scan.js';
import { DepGuardError } from '../src/types.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CORPUS = path.join(__dirname, '..', 'fixtures', 'corpus');

const SHA1 = '6c644106e03138abae01d8d60105d4a7ad4916a1';

let repo = '';

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'depguard-dogfood-1018-'));
  await execFileAsync('git', ['init', '-q'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const full = path.join(repo, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

async function audit(): Promise<ScanResult> {
  return scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
}

async function loadError(): Promise<DepGuardError> {
  try {
    await loadStates(repo, { kind: 'audit' });
  } catch (err) {
    expect(err).toBeInstanceOf(DepGuardError);
    return err as DepGuardError;
  }
  throw new Error('expected loadStates to throw');
}

const NPM_LOCK = JSON.stringify({ name: 'w', lockfileVersion: 3, packages: { '': { name: 'w' } } });

function sourceFinding(result: ScanResult, name: string) {
  const found = result.findings.filter((finding) => finding.ruleId === 'lockfile-tamper' && finding.packageName === name);
  expect(found).toHaveLength(1);
  return found[0];
}

describe('a PEP 508 git requirement pinned by full commit id (pydantic-ai)', () => {
  test('a pyproject direct reference "@<sha>" is a commit pin and names no npm lockfile', async () => {
    await write(
      'pyproject.toml',
      [
        '[project]',
        'name = "app"',
        'version = "0.1.0"',
        'dependencies = [',
        `  "strict-no-cover @ git+https://github.com/pydantic/strict-no-cover.git@${SHA1}",`,
        ']',
        '',
      ].join('\n')
    );
    await write('web-ui/package.json', JSON.stringify({ name: 'w', version: '1.0.0' }));
    await write('web-ui/package-lock.json', NPM_LOCK);

    const finding = sourceFinding(await audit(), 'strict-no-cover');

    expect(finding.details?.commitPinned).toBe(true);
    expect(finding.severity).toBe('low');
    expect(finding.lockfilePath).toBeUndefined();
    expect(finding.manifestPath).toBe('pyproject.toml');
  });

  test('a requirements line "@<sha>#egg=" is a commit pin', async () => {
    await write('requirements.txt', `git+https://github.com/o/strict-no-cover.git@${SHA1}#egg=strict-no-cover\n`);

    const finding = sourceFinding(await audit(), 'strict-no-cover');

    expect(finding.details?.commitPinned).toBe(true);
    expect(finding.severity).toBe('low');
  });

  test('a requirements line on a branch stays unpinned and blocking', async () => {
    await write('requirements.txt', 'git+https://github.com/o/strict-no-cover.git@main#egg=strict-no-cover\n');

    const finding = sourceFinding(await audit(), 'strict-no-cover');

    expect(finding.details?.commitPinned).toBe(false);
    expect(finding.severity).toBe('critical');
  });

  // pip ignores a fragment that is not egg= or subdirectory= and installs
  // the default branch, so a "#<sha>" the user wrote pins nothing.
  test('a pyproject direct reference "#<sha>" is not a commit pin', async () => {
    await write(
      'pyproject.toml',
      [
        '[project]',
        'name = "app"',
        'version = "0.1.0"',
        'dependencies = [',
        `  "strict-no-cover @ git+https://github.com/o/strict-no-cover.git#${SHA1}",`,
        ']',
        '',
      ].join('\n')
    );

    const finding = sourceFinding(await audit(), 'strict-no-cover');

    expect(finding.details?.commitPinned).toBe(false);
    expect(finding.severity).toBe('critical');
  });

  test('a requirements line "#<sha>" is not a commit pin', async () => {
    await write('requirements.txt', `strict-no-cover @ git+https://github.com/o/strict-no-cover.git#${SHA1}\n`);

    const finding = sourceFinding(await audit(), 'strict-no-cover');

    expect(finding.details?.commitPinned).toBe(false);
    expect(finding.severity).toBe('critical');
  });

  test('a poetry git dependency with a full rev is a commit pin', async () => {
    await write(
      'pyproject.toml',
      [
        '[tool.poetry]',
        'name = "app"',
        'version = "0.1.0"',
        '',
        '[tool.poetry.dependencies]',
        `strict-no-cover = { git = "https://github.com/o/strict-no-cover.git", rev = "${SHA1}" }`,
        '',
      ].join('\n')
    );

    const finding = sourceFinding(await audit(), 'strict-no-cover');

    expect(finding.details?.commitPinned).toBe(true);
    expect(finding.severity).toBe('low');
  });

  test('a Pipfile git dependency with a full ref is a commit pin', async () => {
    await write(
      'Pipfile',
      ['[packages]', `strict-no-cover = { git = "https://github.com/o/strict-no-cover.git", ref = "${SHA1}" }`, ''].join(
        '\n'
      )
    );

    const finding = sourceFinding(await audit(), 'strict-no-cover');

    expect(finding.details?.commitPinned).toBe(true);
    expect(finding.severity).toBe('low');
  });

  // [tool.uv.sources] records the ref in its own key; python-sources.ts
  // writes it as "<url>#<rev>", which the existing "#" reading covers.
  test('a [tool.uv.sources] git source with a full rev is a commit pin', async () => {
    await write(
      'pyproject.toml',
      [
        '[project]',
        'name = "app"',
        'version = "0.1.0"',
        'dependencies = ["strict-no-cover"]',
        '',
        '[tool.uv.sources]',
        `strict-no-cover = { git = "https://github.com/o/strict-no-cover.git", rev = "${SHA1}" }`,
        '',
      ].join('\n')
    );

    const finding = sourceFinding(await audit(), 'strict-no-cover');

    expect(finding.details?.commitPinned).toBe(true);
    expect(finding.severity).toBe('low');
  });
});

function onlyGitSourceFinding(result: ScanResult) {
  const found = result.findings.filter(
    (finding) => finding.ruleId === 'lockfile-tamper' && finding.details?.protocol === 'git'
  );
  expect(found).toHaveLength(1);
  return found[0];
}

function pdmDev(spec: string): string {
  return ['[project]', 'name = "app"', 'version = "0.1.0"', '', '[tool.pdm.dev-dependencies]', `dev = [${JSON.stringify(spec)}]`, ''].join('\n');
}

// PDM reads an editable target as the run of characters up to the first
// whitespace or ";" (its URL pattern is [^\s;]+), so anything after that is
// not part of the URL it installs, whatever it looks like.
describe('an editable URL in a TOML requirement list ends at whitespace or ";"', () => {
  test('text after a space cannot supply an "@<sha>" pin', async () => {
    await write('pyproject.toml', pdmDev(`-e git+https://github.com/acme/widget.git@main x@${SHA1}`));

    const finding = onlyGitSourceFinding(await audit());

    expect(finding.details?.commitPinned).toBe(false);
    expect(finding.severity).toBe('critical');
  });

  test('text after a ";" cannot supply an "@<sha>" pin', async () => {
    await write('pyproject.toml', pdmDev(`-e git+https://github.com/acme/widget.git@main;x@${SHA1}`));

    const finding = onlyGitSourceFinding(await audit());

    expect(finding.details?.commitPinned).toBe(false);
    expect(finding.severity).toBe('critical');
  });

  test('an editable URL pinned "@<sha>" with a trailing marker is still a pin', async () => {
    await write('pyproject.toml', pdmDev(`-e git+https://github.com/acme/widget.git@${SHA1}#egg=widget ; python_version >= "3.9"`));

    const finding = onlyGitSourceFinding(await audit());

    expect(finding.details?.commitPinned).toBe(true);
    expect(finding.severity).toBe('low');
  });
});

// A table-built git specifier pins only by the table's own rev key (ref for
// a Pipfile). A "#<sha>" or "@<sha>" already inside the table's git value is
// URL text the installer hands to pip, which ignores the fragment, and a
// tag or branch key names a ref that can move, however hex it looks.
describe('a poetry, uv or Pipfile git table pins only by its own rev key', () => {
  const poetry = (entry: string): string =>
    ['[tool.poetry]', 'name = "app"', 'version = "0.1.0"', '', '[tool.poetry.dependencies]', `widget = ${entry}`, ''].join('\n');
  const uv = (entry: string): string =>
    [
      '[project]',
      'name = "app"',
      'version = "0.1.0"',
      'dependencies = ["widget"]',
      '',
      '[tool.uv.sources]',
      `widget = ${entry}`,
      '',
    ].join('\n');
  const pipfile = (entry: string): string => ['[packages]', `widget = ${entry}`, ''].join('\n');

  test.each([
    ['poetry, "#<sha>" in the git value', 'pyproject.toml', poetry(`{ git = "https://github.com/acme/widget.git#${SHA1}" }`)],
    ['poetry, "@<sha>" in the git value', 'pyproject.toml', poetry(`{ git = "https://github.com/acme/widget.git@${SHA1}" }`)],
    ['poetry, a 40-hex branch', 'pyproject.toml', poetry(`{ git = "https://github.com/acme/widget.git", branch = "${SHA1}" }`)],
    ['poetry, a 40-hex tag', 'pyproject.toml', poetry(`{ git = "https://github.com/acme/widget.git", tag = "${SHA1}" }`)],
    ['uv, "#<sha>" in the git value', 'pyproject.toml', uv(`{ git = "https://github.com/acme/widget.git#${SHA1}" }`)],
    ['uv, a 40-hex branch', 'pyproject.toml', uv(`{ git = "https://github.com/acme/widget.git", branch = "${SHA1}" }`)],
    ['Pipfile, "#<sha>" in the git value', 'Pipfile', pipfile(`{ git = "https://github.com/acme/widget.git#${SHA1}" }`)],
    ['Pipfile, "@<sha>" in the git value', 'Pipfile', pipfile(`{ git = "https://github.com/acme/widget.git@${SHA1}" }`)],
  ])('%s is not a commit pin', async (_label, file, content) => {
    await write(file, content);

    const finding = sourceFinding(await audit(), 'widget');

    expect(finding.details?.commitPinned).toBe(false);
    expect(finding.severity).toBe('critical');
  });

  test.each([
    ['poetry rev', 'pyproject.toml', poetry(`{ git = "https://github.com/acme/widget.git", rev = "${SHA1}" }`)],
    ['uv rev', 'pyproject.toml', uv(`{ git = "https://github.com/acme/widget.git", rev = "${SHA1}" }`)],
    ['Pipfile ref', 'Pipfile', pipfile(`{ git = "https://github.com/acme/widget.git", ref = "${SHA1}" }`)],
    // A userinfo "git@" sits in the netloc, not the path, and is harmless.
    ['poetry rev over ssh://git@', 'pyproject.toml', poetry(`{ git = "ssh://git@github.com/acme/widget.git", rev = "${SHA1}" }`)],
    ['uv rev over ssh://git@', 'pyproject.toml', uv(`{ git = "ssh://git@github.com/acme/widget.git", rev = "${SHA1}" }`)],
    ['Pipfile ref over ssh://git@', 'Pipfile', pipfile(`{ git = "ssh://git@github.com/acme/widget.git", ref = "${SHA1}" }`)],
    ['poetry rev on an scp-like git@host:path', 'pyproject.toml', poetry(`{ git = "git@github.com:acme/widget.git", rev = "${SHA1}" }`)],
  ])('a full-sha %s is a commit pin', async (_label, file, content) => {
    await write(file, content);

    const finding = sourceFinding(await audit(), 'widget');

    expect(finding.details?.commitPinned).toBe(true);
    expect(finding.severity).toBe('low');
  });

  // The installer appends the table's ref to the git value (pipenv builds
  // "git+<git>@<ref>"), so a "#" anywhere in the git value turns the ref
  // into fragment text pip ignores, and an "@" in its path moves the ref
  // pip reads. Either way the default branch or another ref installs, so
  // the table's own full-sha rev does not pin it.
  test.each([
    ['poetry, "#junk" in the git value', 'pyproject.toml', poetry(`{ git = "https://github.com/acme/widget.git#junk", rev = "${SHA1}" }`)],
    ['poetry, "@x" in the git path', 'pyproject.toml', poetry(`{ git = "https://github.com/acme/widget.git@x", rev = "${SHA1}" }`)],
    ['poetry, "@x" in an scp-like git path', 'pyproject.toml', poetry(`{ git = "git@github.com:acme/widget.git@x", rev = "${SHA1}" }`)],
    ['uv, "#junk" in the git value', 'pyproject.toml', uv(`{ git = "https://github.com/acme/widget.git#junk", rev = "${SHA1}" }`)],
    ['uv, "@x" in the git path', 'pyproject.toml', uv(`{ git = "https://github.com/acme/widget.git@x", rev = "${SHA1}" }`)],
    ['Pipfile, "#junk" in the git value', 'Pipfile', pipfile(`{ git = "https://github.com/acme/widget.git#junk", ref = "${SHA1}" }`)],
    ['Pipfile, "@x" in the git path', 'Pipfile', pipfile(`{ git = "https://github.com/acme/widget.git@x", ref = "${SHA1}" }`)],
  ])('%s with a full-sha rev is not a commit pin', async (_label, file, content) => {
    await write(file, content);

    const finding = sourceFinding(await audit(), 'widget');

    expect(finding.details?.commitPinned).toBe(false);
    expect(finding.severity).toBe('critical');
  });

  // A Pipfile "file" value that is a URL is passed to pip as written, so it
  // is read in pip's grammar: "@<sha>" pins it. Built as a table specifier
  // instead, it would carry no rev and read as unpinned.
  test('a Pipfile "file" git URL pinned "@<sha>" is a commit pin', async () => {
    await write('Pipfile', pipfile(`{ file = "git+https://github.com/acme/widget.git@${SHA1}" }`));

    const finding = sourceFinding(await audit(), 'widget');

    expect(finding.details?.commitPinned).toBe(true);
    expect(finding.severity).toBe('low');
  });
});

const GIT = 'https://github.com/acme/widget.git';

function poetryWidget(entry: string): string {
  return ['[tool.poetry]', 'name = "app"', 'version = "0.1.0"', '', '[tool.poetry.dependencies]', `widget = ${entry}`, ''].join('\n');
}

function uvWidget(entry: string): string {
  return ['[project]', 'name = "app"', 'version = "0.1.0"', 'dependencies = ["widget"]', '', '[tool.uv.sources]', `widget = ${entry}`, ''].join(
    '\n'
  );
}

async function commitAll(message: string): Promise<void> {
  await execFileAsync('git', ['add', '-A'], { cwd: repo });
  await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', message], { cwd: repo });
}

async function againstBase(): Promise<ScanResult> {
  return scan({ repoRoot: repo, mode: { kind: 'base', ref: 'base' }, corpusDir: FIXTURE_CORPUS });
}

function widgetFindings(result: ScanResult) {
  return result.findings.filter((finding) => finding.ruleId === 'lockfile-tamper' && finding.packageName === 'widget');
}

// poetry resolves a git table's reference as branch, then tag, then rev, so
// a rev beside a branch or tag installs the branch or tag. uv rejects more
// than one ref key; it is refused there too, in case a reader does not.
describe('a git table with a rev beside a branch or tag is not pinned', () => {
  test.each([
    ['poetry rev and branch', poetryWidget(`{ git = "${GIT}", rev = "${SHA1}", branch = "main" }`)],
    ['poetry rev and tag', poetryWidget(`{ git = "${GIT}", rev = "${SHA1}", tag = "v1" }`)],
    ['uv rev and branch', uvWidget(`{ git = "${GIT}", rev = "${SHA1}", branch = "main" }`)],
    ['uv rev and tag', uvWidget(`{ git = "${GIT}", rev = "${SHA1}", tag = "v1" }`)],
    ['uv, a 40-hex tag', uvWidget(`{ git = "${GIT}", tag = "${SHA1}" }`)],
  ])('%s is not a commit pin', async (_label, content) => {
    await write('pyproject.toml', content);

    const finding = sourceFinding(await audit(), 'widget');

    expect(finding.details?.commitPinned).toBe(false);
    expect(finding.severity).toBe('critical');
  });
});

// A dependency that installs from several git tables, one per marker, is
// pinned only when every one of them is: whichever item comes first, the
// unpinned one is what some platform installs.
describe('a git dependency with several marker items is pinned only if every item is', () => {
  const pinned = `{ git = "${GIT}", rev = "${SHA1}", markers = "sys_platform == 'linux'" }`;
  const branch = `{ git = "${GIT}", branch = "main", markers = "sys_platform != 'linux'" }`;
  const uvPinned = `{ git = "${GIT}", rev = "${SHA1}", marker = "sys_platform == 'linux'" }`;
  const uvBranch = `{ git = "${GIT}", branch = "main", marker = "sys_platform != 'linux'" }`;
  const uvPinnedToo = `{ git = "${GIT}", rev = "${SHA1}", marker = "sys_platform != 'linux'" }`;
  const pinnedToo = `{ git = "${GIT}", rev = "${SHA1}", markers = "sys_platform != 'linux'" }`;

  test.each([
    ['poetry, pinned item first', poetryWidget(`[${pinned}, ${branch}]`)],
    ['poetry, branch item first', poetryWidget(`[${branch}, ${pinned}]`)],
    ['uv, pinned source first', uvWidget(`[${uvPinned}, ${uvBranch}]`)],
    ['uv, branch source first', uvWidget(`[${uvBranch}, ${uvPinned}]`)],
  ])('%s: reported unpinned', async (_label, content) => {
    await write('pyproject.toml', content);

    const findings = widgetFindings(await audit());

    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.details?.commitPinned).toBe(false);
      expect(finding.severity).toBe('critical');
    }
  });

  test.each([
    ['poetry', poetryWidget(`[${pinned}, ${pinnedToo}]`)],
    ['uv', uvWidget(`[${uvPinned}, ${uvPinnedToo}]`)],
  ])('%s with every item pinned is a commit pin', async (_label, content) => {
    await write('pyproject.toml', content);

    const findings = widgetFindings(await audit());

    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.details?.commitPinned).toBe(true);
      expect(finding.severity).toBe('low');
    }
  });
});

// Two declarations of one dependency in one manifest, one pinned and one on a
// branch, collapse to a single finding under the same key. The one kept is
// the worst of them, whichever line comes first.
describe('two declarations of one git dependency report the worse of the two', () => {
  const reqPinned = `widget @ git+${GIT}@${SHA1} ; sys_platform == "linux"`;
  const reqBranch = `widget @ git+${GIT}@main ; sys_platform != "linux"`;
  const reqPinnedToo = `widget @ git+${GIT}@${SHA1} ; sys_platform != "linux"`;
  const pep621 = (lines: string[]): string =>
    ['[project]', 'name = "app"', 'version = "0.1.0"', 'dependencies = [', ...lines.map((line) => `  '${line}',`), ']', ''].join('\n');

  test.each([
    ['requirements.txt, pinned line first', 'requirements.txt', `${reqPinned}\n${reqBranch}\n`],
    ['requirements.txt, branch line first', 'requirements.txt', `${reqBranch}\n${reqPinned}\n`],
    ['PEP 621 dependencies, pinned item first', 'pyproject.toml', pep621([reqPinned, reqBranch])],
    ['PEP 621 dependencies, branch item first', 'pyproject.toml', pep621([reqBranch, reqPinned])],
    [
      'PEP 621 dependency pinned, an optional extra on a branch',
      'pyproject.toml',
      [
        '[project]',
        'name = "app"',
        'version = "0.1.0"',
        `dependencies = ["widget @ git+${GIT}@${SHA1}"]`,
        '',
        '[project.optional-dependencies]',
        `extra = ["widget @ git+${GIT}@main"]`,
        '',
      ].join('\n'),
    ],
    [
      'poetry main dependency pinned, a dev group on a branch',
      'pyproject.toml',
      [
        '[tool.poetry]',
        'name = "app"',
        'version = "0.1.0"',
        '',
        '[tool.poetry.dependencies]',
        `widget = { git = "${GIT}", rev = "${SHA1}" }`,
        '',
        '[tool.poetry.group.dev.dependencies]',
        `widget = { git = "${GIT}", branch = "main" }`,
        '',
      ].join('\n'),
    ],
  ])('%s: reported unpinned', async (_label, file, content) => {
    await write(file, content);

    const findings = widgetFindings(await audit());

    expect(findings).toHaveLength(1);
    expect(findings[0].details?.commitPinned).toBe(false);
    expect(findings[0].severity).toBe('critical');
  });

  test('requirements.txt with both marker lines pinned is a commit pin', async () => {
    await write('requirements.txt', `${reqPinned}\n${reqPinnedToo}\n`);

    const findings = widgetFindings(await audit());

    expect(findings).toHaveLength(1);
    expect(findings[0].details?.commitPinned).toBe(true);
    expect(findings[0].severity).toBe('low');
  });
});

// In delta mode an unchanged specifier string is skipped. The specifier of
// a git table is display text built from whichever ref key is present, so a
// rev rewritten as a branch of the same text, or a table rewritten as a
// pip-grammar URL of the same text, changed what installs while the string
// did not. Where the pin comes from is part of what has to hold.
describe('delta mode: a change of pin provenance is a change', () => {
  test.each([
    ['poetry rev to branch', poetryWidget(`{ git = "${GIT}", rev = "${SHA1}" }`), poetryWidget(`{ git = "${GIT}", branch = "${SHA1}" }`)],
    ['uv rev to branch', uvWidget(`{ git = "${GIT}", rev = "${SHA1}" }`), uvWidget(`{ git = "${GIT}", branch = "${SHA1}" }`)],
    [
      'poetry table to a pip-grammar direct reference',
      poetryWidget(`{ git = "git+${GIT}", rev = "${SHA1}" }`),
      ['[project]', 'name = "app"', 'version = "0.1.0"', `dependencies = ["widget @ git+${GIT}#${SHA1}"]`, ''].join('\n'),
    ],
  ])('%s is reported, unpinned and blocking', async (_label, before, after) => {
    await write('pyproject.toml', before);
    await commitAll('base');
    await execFileAsync('git', ['tag', 'base'], { cwd: repo });
    await write('pyproject.toml', after);
    await commitAll('head');

    const findings = widgetFindings(await againstBase());

    expect(findings).toHaveLength(1);
    expect(findings[0].details?.commitPinned).toBe(false);
    expect(findings[0].severity).toBe('critical');
  });

  test('an unchanged pinned poetry table is still skipped', async () => {
    await write('pyproject.toml', poetryWidget(`{ git = "${GIT}", rev = "${SHA1}" }`));
    await commitAll('base');
    await execFileAsync('git', ['tag', 'base'], { cwd: repo });
    await commitAll('head');

    expect(widgetFindings(await againstBase())).toEqual([]);
  });
});

// A v5.4 lockfile for a workspace whose every dependency is a link: writes
// "packages:" with nothing under it (vercel/turborepo,
// turborepo-tests/integration/fixtures/monorepo_with_shared_file_deps).
const PNPM_V5_LINKS_ONLY = [
  'lockfileVersion: 5.4',
  '',
  'importers:',
  '',
  '  .:',
  '    specifiers: {}',
  '',
  '  apps/docs:',
  '    specifiers:',
  '      vendor-sdk: file:../../vendored/sdk',
  '    dependencies:',
  '      vendor-sdk: link:../../vendored/sdk',
  '',
  'packages:',
  '',
].join('\n');

describe('a pnpm lockfile whose "packages:" is empty', () => {
  test('a links-only v5.4 workspace lockfile with "packages:" null loads as empty', async () => {
    await write('package.json', JSON.stringify({ name: 'root', version: '1.0.0' }));
    await write('pnpm-lock.yaml', PNPM_V5_LINKS_ONLY);

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(after.lockfile?.path).toBe('pnpm-lock.yaml');
    expect(after.lockfile?.entries.size).toBe(0);
  });
});

describe('every lockfile-parse failure in one error', () => {
  test('two unparseable lockfiles are both named, in one lockfile-parse error', async () => {
    await write('package.json', JSON.stringify({ name: 'root', version: '1.0.0' }));
    await write('a/package.json', JSON.stringify({ name: 'a', version: '1.0.0' }));
    await write('a/package-lock.json', '{ truncated');
    await write('b/package.json', JSON.stringify({ name: 'b', version: '1.0.0' }));
    await write('b/package-lock.json', JSON.stringify({ name: 'b', lockfileVersion: 3 }));

    const error = await loadError();

    expect(error.code).toBe('lockfile-parse');
    expect(error.message.startsWith('2 lockfiles do not parse and stop the scan: ')).toBe(true);
    expect(error.message).toContain('a/package-lock.json: not valid JSON');
    expect(error.message).toContain('b/package-lock.json');
    expect(error.message.indexOf('a/package-lock.json')).toBeLessThan(error.message.indexOf('b/package-lock.json'));
  });

  test('two unparseable lockfiles in one directory are both named', async () => {
    await write('package.json', JSON.stringify({ name: 'root', version: '1.0.0' }));
    await write('package-lock.json', '{ truncated');
    await write('pnpm-lock.yaml', "foo: 'bar\n");

    const error = await loadError();

    expect(error.code).toBe('lockfile-parse');
    expect(error.message.startsWith('2 lockfiles do not parse and stop the scan: ')).toBe(true);
    expect(error.message).toContain('package-lock.json: not valid JSON');
    expect(error.message).toContain('pnpm-lock.yaml: not valid YAML');
  });

  test('eleven unparseable lockfiles list ten and count the rest', async () => {
    await write('package.json', JSON.stringify({ name: 'root', version: '1.0.0' }));
    for (let index = 1; index <= 11; index += 1) {
      const dir = `s${String(index).padStart(2, '0')}`;
      await write(`${dir}/package.json`, JSON.stringify({ name: dir, version: '1.0.0' }));
      await write(`${dir}/package-lock.json`, '{ truncated');
    }

    const error = await loadError();

    expect(error.code).toBe('lockfile-parse');
    expect(error.message.startsWith('11 lockfiles do not parse and stop the scan: ')).toBe(true);
    expect(error.message).toContain('s10/package-lock.json');
    expect(error.message).not.toContain('s11/package-lock.json');
    expect(error.message.endsWith(' | and 1 more')).toBe(true);
  });

  // One failure keeps the message it always had, so a consumer matching on
  // it sees no change.
  test('a single unparseable lockfile keeps its own message', async () => {
    await write('package.json', JSON.stringify({ name: 'root', version: '1.0.0' }));
    await write('package-lock.json', '{ truncated');

    const error = await loadError();

    expect(error.code).toBe('lockfile-parse');
    expect(error.message).toBe('package-lock.json: not valid JSON');
  });
});
