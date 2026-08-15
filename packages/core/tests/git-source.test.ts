import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { classifyBlobFailure, loadStates } from '../src/git-source.js';
import type { RepoState } from '../src/state.js';
import { DepGuardError } from '../src/types.js';

// chmod-based permission tests are meaningless as root, which is how some
// container images run CI.
const asUnprivilegedUser = process.getuid?.() === 0 ? test.skip : test;

const execFileAsync = promisify(execFile);

// Every temp directory this suite creates, cleaned up wholesale in
// afterEach so a failing assertion cannot leak a repo into os.tmpdir().
let tempDirs: string[] = [];
let repo = '';

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repo, encoding: 'utf8' });
  return stdout;
}

async function write(relPath: string, content: string): Promise<void> {
  const full = path.join(repo, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

async function commitAll(message: string): Promise<void> {
  await git('add', '-A');
  await git('commit', '-q', '-m', message);
}

function manifestJson(
  dependencies: Record<string, string>,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({ name: 'root', version: '1.0.0', dependencies, ...extra });
}

function manifestOf(state: RepoState | null, manifestPath: string) {
  return state?.manifests.find((manifest) => manifest.path === manifestPath);
}

function specifierOf(
  state: RepoState | null,
  manifestPath: string,
  name: string
): string | undefined {
  return manifestOf(state, manifestPath)?.deps.find((dep) => dep.name === name)?.specifier;
}

function manifestPaths(state: RepoState | null): string[] {
  return (state?.manifests ?? []).map((manifest) => manifest.path).sort();
}

function diagnosticCodes(state: RepoState): string[] {
  return (state.lockfile?.diagnostics ?? []).map((diagnostic) => diagnostic.code);
}

async function expectDepGuardError(fn: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DepGuardError);
  expect((caught as DepGuardError).code).toBe(code);
}

beforeEach(async () => {
  repo = await makeTempDir('dep-guard-git-source-');
  await git('init', '-q', '-b', 'main');
  // A committer identity has to exist for `git commit` to work on a
  // machine (or CI image) with no global git config, and signing has to be
  // off in case the ambient global config turns it on.
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'dep guard test');
  await git('config', 'commit.gpgsign', 'false');
});

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  repo = '';
});

describe('staged mode', () => {
  test('after reads the index and before reads HEAD, ignoring the working tree', async () => {
    await write('package.json', manifestJson({ 'left-pad': '1.0.0' }));
    await commitAll('first');
    await write('package.json', manifestJson({ 'left-pad': '2.0.0' }));
    await git('add', '-A');
    // Written after staging, so this version exists only in the working
    // tree -- a staged scan must not see it.
    await write('package.json', manifestJson({ 'left-pad': '3.0.0' }));

    const { before, after, mode } = await loadStates(repo, { kind: 'staged' });

    expect(mode).toEqual({ kind: 'staged' });
    expect(specifierOf(after, 'package.json', 'left-pad')).toBe('2.0.0');
    expect(specifierOf(before, 'package.json', 'left-pad')).toBe('1.0.0');
  });

  test('an unborn HEAD gives a null before side', async () => {
    await write('package.json', manifestJson({ 'left-pad': '1.0.0' }));
    await git('add', '-A');

    const { before, after } = await loadStates(repo, { kind: 'staged' });

    expect(before).toBeNull();
    expect(specifierOf(after, 'package.json', 'left-pad')).toBe('1.0.0');
  });

  test('a file present on disk but not in the index counts as absent', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');
    // Never staged: git reports this as "exists on disk, but not in the
    // index", a different wording from an outright missing path, and both
    // have to read as absence rather than as a git failure.
    await write('pnpm-lock.yaml', 'lockfileVersion: "9.0"\n');
    await write('.npmrc', '@acme:registry=https://npm.example.invalid/\n');

    const { after } = await loadStates(repo, { kind: 'staged' });

    expect(after.lockfile).toBeNull();
    expect(after.npmrcRegistryPins.size).toBe(0);
  });

  test('a workspace manifest added in the index is absent from the before side', async () => {
    await write('package.json', manifestJson({}, { workspaces: ['packages/*'] }));
    await commitAll('first');
    await write('packages/added/package.json', JSON.stringify({ name: 'added' }));
    await git('add', '-A');

    const { before, after } = await loadStates(repo, { kind: 'staged' });

    expect(manifestPaths(before)).toEqual(['package.json']);
    expect(manifestPaths(after)).toEqual(['package.json', 'packages/added/package.json']);
  });

  test('a malformed lockfile on the before side aborts the scan', async () => {
    await write('package.json', manifestJson({}));
    await write('package-lock.json', '{ truncated');
    await commitAll('first');
    await write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {} }));
    await git('add', '-A');

    await expectDepGuardError(
      () => loadStates(repo, { kind: 'staged' }),
      'lockfile-parse'
    );
  });

  test('outside a git repository the scan fails with a git error', async () => {
    const plain = await makeTempDir('dep-guard-not-a-repo-');

    await expectDepGuardError(() => loadStates(plain, { kind: 'staged' }), 'git-error');
  });
});

describe('base mode', () => {
  test('before reads the named ref and after reads the working tree', async () => {
    await write('package.json', manifestJson({ 'left-pad': '1.0.0' }));
    await commitAll('first');
    const firstCommit = (await git('rev-parse', 'HEAD')).trim();
    await write('package.json', manifestJson({ 'left-pad': '2.0.0' }));
    await commitAll('second');
    // Uncommitted and unstaged: base mode compares the ref against the
    // working tree, so this is what the after side must see.
    await write('package.json', manifestJson({ 'left-pad': '3.0.0' }));

    const { before, after, mode } = await loadStates(repo, {
      kind: 'base',
      ref: firstCommit,
    });

    expect(mode).toEqual({ kind: 'base', ref: firstCommit });
    expect(specifierOf(before, 'package.json', 'left-pad')).toBe('1.0.0');
    expect(specifierOf(after, 'package.json', 'left-pad')).toBe('3.0.0');
  });

  test('an unknown ref is a git error, not an empty before side', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');

    await expectDepGuardError(
      () => loadStates(repo, { kind: 'base', ref: 'no-such-ref' }),
      'git-error'
    );
  });

  test('a ref whose name also names a file is still read as a ref', async () => {
    await write('package.json', manifestJson({ 'left-pad': '1.0.0' }));
    await write('release.txt', 'a file that shares its name with a branch\n');
    await commitAll('first');
    await git('branch', 'release.txt');
    await write('package.json', manifestJson({ 'left-pad': '2.0.0' }));

    const { before, after } = await loadStates(repo, { kind: 'base', ref: 'release.txt' });

    expect(specifierOf(before, 'package.json', 'left-pad')).toBe('1.0.0');
    expect(specifierOf(after, 'package.json', 'left-pad')).toBe('2.0.0');
  });

  test('a ref that could be read as a command-line option is rejected', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');

    await expectDepGuardError(
      () => loadStates(repo, { kind: 'base', ref: '--output=/tmp/pwned' }),
      'git-error'
    );
  });
});

describe('audit mode', () => {
  test('before is null and after reads the working tree', async () => {
    await write('package.json', manifestJson({ 'left-pad': '1.0.0' }));
    await commitAll('first');
    await write('package.json', manifestJson({ 'left-pad': '9.9.9' }));

    const { before, after, mode } = await loadStates(repo, { kind: 'audit' });

    expect(before).toBeNull();
    expect(mode).toEqual({ kind: 'audit' });
    expect(specifierOf(after, 'package.json', 'left-pad')).toBe('9.9.9');
  });

  test('a directory that is not a git repository can still be audited', async () => {
    const plain = await makeTempDir('dep-guard-plain-dir-');
    await writeFile(path.join(plain, 'package.json'), manifestJson({ 'left-pad': '1.0.0' }), 'utf8');

    const { after } = await loadStates(plain, { kind: 'audit' });

    expect(specifierOf(after, 'package.json', 'left-pad')).toBe('1.0.0');
  });

  test('a missing root manifest yields an empty state rather than an error', async () => {
    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(after.manifests).toEqual([]);
    expect(after.lockfile).toBeNull();
    expect(after.onlyBuilt).toEqual([]);
    expect(after.npmrcRegistryPins.size).toBe(0);
  });
});

describe('lockfile detection', () => {
  test('an absent lockfile is null', async () => {
    await write('package.json', manifestJson({}));

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(after.lockfile).toBeNull();
  });

  test('package-lock.json parses as npm and wins over the other formats', async () => {
    await write('package.json', manifestJson({ 'left-pad': '1.0.0' }));
    await write(
      'package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/left-pad': { version: '1.0.0' } },
      })
    );
    await write('pnpm-lock.yaml', 'lockfileVersion: "9.0"\n');
    await write('yarn.lock', '# yarn lockfile v1\n');

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(after.lockfile?.format).toBe('npm');
    expect(after.lockfile?.path).toBe('package-lock.json');
    expect(after.lockfile?.entries.get('left-pad')).toEqual([{ version: '1.0.0' }]);
  });

  test('pnpm-lock.yaml parses as pnpm', async () => {
    await write('package.json', manifestJson({ lodash: '4.17.21' }));
    await write(
      'pnpm-lock.yaml',
      ['lockfileVersion: "9.0"', 'packages:', "  lodash@4.17.21:", '    resolution: {}', ''].join(
        '\n'
      )
    );

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(after.lockfile?.format).toBe('pnpm');
    expect(after.lockfile?.entries.get('lodash')).toEqual([{ version: '4.17.21' }]);
  });

  test('yarn.lock reports the manifest-only diagnostic with no entries', async () => {
    await write('package.json', manifestJson({}));
    await write('yarn.lock', '# yarn lockfile v1\n');

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(after.lockfile?.format).toBe('yarn');
    expect(after.lockfile?.path).toBe('yarn.lock');
    expect(after.lockfile?.entries.size).toBe(0);
    expect(diagnosticCodes(after)).toContain('lockfile-format-manifest-only');
  });

  test('bun.lock reports the manifest-only diagnostic with no entries', async () => {
    await write('package.json', manifestJson({}));
    await write('bun.lock', '{}\n');

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(after.lockfile?.format).toBe('bun');
    expect(after.lockfile?.path).toBe('bun.lock');
    expect(after.lockfile?.entries.size).toBe(0);
    expect(diagnosticCodes(after)).toContain('lockfile-format-manifest-only');
  });

  test('bun.lockb reports the binary-skipped diagnostic', async () => {
    await write('package.json', manifestJson({}));
    await write('bun.lockb', 'not really binary, but never parsed either');

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(after.lockfile?.format).toBe('bun');
    expect(after.lockfile?.path).toBe('bun.lockb');
    expect(after.lockfile?.entries.size).toBe(0);
    expect(diagnosticCodes(after)).toContain('lockfile-binary-skipped');
  });

  test('a malformed lockfile in the working tree aborts an audit', async () => {
    await write('package.json', manifestJson({}));
    await write('package-lock.json', '{ truncated');

    await expectDepGuardError(() => loadStates(repo, { kind: 'audit' }), 'lockfile-parse');
  });
});

describe('manifest discovery', () => {
  test('expands the npm workspaces field one level', async () => {
    await write('package.json', manifestJson({}, { workspaces: ['packages/*', 'tools/build'] }));
    await write('packages/a/package.json', JSON.stringify({ name: 'a' }));
    await write('packages/b/package.json', JSON.stringify({ name: 'b' }));
    // A directory under the glob with no manifest of its own, and a
    // regular file sitting beside the package directories: neither is a
    // workspace package.
    await write('packages/fixtures/data.txt', 'not a package\n');
    await write('packages/README.md', 'not a package\n');
    await write('tools/build/package.json', JSON.stringify({ name: 'build' }));

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(manifestPaths(after)).toEqual([
      'package.json',
      'packages/a/package.json',
      'packages/b/package.json',
      'tools/build/package.json',
    ]);
  });

  test('expands the object form of the npm workspaces field', async () => {
    await write('package.json', manifestJson({}, { workspaces: { packages: ['apps/*'] } }));
    await write('apps/site/package.json', JSON.stringify({ name: 'site' }));

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(manifestPaths(after)).toEqual(['package.json', 'apps/site/package.json'].sort());
  });

  test('expands the pnpm-workspace.yaml packages list and honours exclusions', async () => {
    await write('package.json', manifestJson({}));
    await write(
      'pnpm-workspace.yaml',
      ['packages:', '  - "packages/*"', '  - "!packages/ignored"', ''].join('\n')
    );
    await write('packages/a/package.json', JSON.stringify({ name: 'a' }));
    await write('packages/ignored/package.json', JSON.stringify({ name: 'ignored' }));

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(manifestPaths(after)).toEqual(['package.json', 'packages/a/package.json']);
  });

  test('a package listed by both workspace sources is discovered once', async () => {
    await write('package.json', manifestJson({}, { workspaces: ['packages/*'] }));
    await write('pnpm-workspace.yaml', ['packages:', '  - "packages/*"', ''].join('\n'));
    await write('packages/a/package.json', JSON.stringify({ name: 'a' }));

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(manifestPaths(after)).toEqual(['package.json', 'packages/a/package.json']);
  });

  test('a workspace glob that escapes the repository root is ignored and reported', async () => {
    await write('package.json', manifestJson({}, { workspaces: ['../*', '/etc/*'] }));

    const { after, diagnostics } = await loadStates(repo, { kind: 'audit' });

    expect(manifestPaths(after)).toEqual(['package.json']);
    expect(diagnostics.filter((d) => d.code === 'workspace-glob-unsupported')).toHaveLength(2);
  });

  test('a workspace glob containing a backslash is ignored and reported', async () => {
    // path.join treats a backslash as a separator on win32, so a pattern
    // this shape would escape a containment check that only splits on "/".
    await write('package.json', manifestJson({}, { workspaces: ['..\\evil'] }));

    const { after, diagnostics } = await loadStates(repo, { kind: 'audit' });

    expect(manifestPaths(after)).toEqual(['package.json']);
    expect(diagnostics.map((d) => d.code)).toContain('workspace-glob-unsupported');
  });

  test('a wildcard outside the final segment discovers nothing and says so', async () => {
    await write('package.json', manifestJson({}, { workspaces: ['packages/*/inner'] }));
    await write('packages/a/inner/package.json', JSON.stringify({ name: 'inner' }));

    const { after, diagnostics } = await loadStates(repo, { kind: 'audit' });

    expect(manifestPaths(after)).toEqual(['package.json']);
    expect(diagnostics.map((d) => d.code)).toContain('workspace-glob-unsupported');
  });

  test('a trailing double star expands one level and reports the deeper miss', async () => {
    await write('package.json', manifestJson({}, { workspaces: ['packages/**'] }));
    await write('packages/a/package.json', JSON.stringify({ name: 'a' }));
    await write('packages/deep/nested/package.json', JSON.stringify({ name: 'nested' }));

    const { after, diagnostics } = await loadStates(repo, { kind: 'audit' });

    expect(manifestPaths(after)).toEqual(['package.json', 'packages/a/package.json']);
    expect(diagnostics.map((d) => d.code)).toContain('workspace-glob-unsupported');
  });

  test('node_modules is never expanded into a workspace package', async () => {
    await write('package.json', manifestJson({}, { workspaces: ['*'] }));
    await write('pkg/package.json', JSON.stringify({ name: 'pkg' }));
    await write('node_modules/package.json', JSON.stringify({ name: 'installed' }));

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(manifestPaths(after)).toEqual(['package.json', 'pkg/package.json']);
  });

  test('a clean scan reports no diagnostics', async () => {
    await write('package.json', manifestJson({}, { workspaces: ['packages/*'] }));
    await write('packages/a/package.json', JSON.stringify({ name: 'a' }));

    const { diagnostics } = await loadStates(repo, { kind: 'audit' });

    expect(diagnostics).toEqual([]);
  });

  test('a path that is a directory rather than a manifest is skipped', async () => {
    await write('package.json', manifestJson({}, { workspaces: ['packages/*'] }));
    await mkdir(path.join(repo, 'packages', 'a', 'package.json'), { recursive: true });

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(manifestPaths(after)).toEqual(['package.json']);
  });

  asUnprivilegedUser('an unlistable workspace directory is reported', async () => {
    await write('package.json', manifestJson({}, { workspaces: ['packages/*'] }));
    await write('packages/a/package.json', JSON.stringify({ name: 'a' }));
    const packages = path.join(repo, 'packages');
    await chmod(packages, 0o000);
    try {
      const { after, diagnostics } = await loadStates(repo, { kind: 'audit' });

      expect(manifestPaths(after)).toEqual(['package.json']);
      expect(diagnostics.map((d) => d.code)).toContain('workspace-dir-unreadable');
    } finally {
      await chmod(packages, 0o755);
    }
  });

  asUnprivilegedUser('an unreadable manifest fails the scan instead of vanishing', async () => {
    await write('package.json', manifestJson({}, { workspaces: ['packages/*'] }));
    await write('packages/a/package.json', JSON.stringify({ name: 'a' }));
    const manifest = path.join(repo, 'packages', 'a', 'package.json');
    await chmod(manifest, 0o000);
    try {
      await expectDepGuardError(() => loadStates(repo, { kind: 'audit' }), 'read-error');
    } finally {
      await chmod(manifest, 0o644);
    }
  });

  test('staged mode discovers workspace manifests from the index', async () => {
    await write('package.json', manifestJson({}, { workspaces: ['packages/*'] }));
    await write('packages/a/package.json', JSON.stringify({ name: 'a', dependencies: { dep: '1.0.0' } }));
    await commitAll('first');
    await write(
      'packages/a/package.json',
      JSON.stringify({ name: 'a', dependencies: { dep: '2.0.0' } })
    );
    await git('add', '-A');

    const { before, after } = await loadStates(repo, { kind: 'staged' });

    expect(specifierOf(after, 'packages/a/package.json', 'dep')).toBe('2.0.0');
    expect(specifierOf(before, 'packages/a/package.json', 'dep')).toBe('1.0.0');
  });

  test('a malformed workspace manifest aborts the scan', async () => {
    await write('package.json', manifestJson({}, { workspaces: ['packages/*'] }));
    await write('packages/a/package.json', '{ truncated');

    await expectDepGuardError(() => loadStates(repo, { kind: 'audit' }), 'manifest-parse');
  });
});

// The real npm/cli shape: a workspace sibling is declared with an ordinary
// version range (npm gives it no "workspace:" specifier the way pnpm and
// yarn do), and only the lockfile's "link": true entry says it is local.
describe('npm workspace-local names reach RepoState', () => {
  test('a workspace sibling declared with a plain version range is in workspaceLocalNames', async () => {
    await write(
      'package.json',
      manifestJson(
        { '@npmcli/mock-registry': '^1.0.0' },
        { name: 'npm', workspaces: ['workspaces/mock-registry'] }
      )
    );
    await write(
      'workspaces/mock-registry/package.json',
      JSON.stringify({ name: '@npmcli/mock-registry', version: '1.0.0' })
    );
    await write(
      'package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': {
            name: 'npm',
            dependencies: { '@npmcli/mock-registry': '^1.0.0' },
            workspaces: ['workspaces/mock-registry'],
          },
          'workspaces/mock-registry': { name: '@npmcli/mock-registry', version: '1.0.0' },
          'node_modules/@npmcli/mock-registry': {
            resolved: 'workspaces/mock-registry',
            link: true,
          },
        },
      })
    );

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(after.workspaceLocalNames.has('@npmcli/mock-registry')).toBe(true);
  });

  test('with no lockfile at all, workspaceLocalNames is empty', async () => {
    await write('package.json', manifestJson({}, { workspaces: ['packages/*'] }));
    await write('packages/a/package.json', JSON.stringify({ name: '@test/a', version: '1.0.0' }));

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(after.workspaceLocalNames.size).toBe(0);
  });
});

describe('onlyBuilt aggregation', () => {
  test('merges pnpm-workspace.yaml with every manifest pnpm block', async () => {
    await write('package.json', manifestJson({}, { pnpm: { onlyBuiltDependencies: ['fsevents'] } }));
    await write(
      'pnpm-workspace.yaml',
      ['packages:', '  - "packages/*"', 'onlyBuiltDependencies:', '  - esbuild', ''].join('\n')
    );
    await write(
      'packages/a/package.json',
      JSON.stringify({ name: 'a', pnpm: { onlyBuiltDependencies: ['sharp'] } })
    );

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect([...after.onlyBuilt].sort()).toEqual(['esbuild', 'fsevents', 'sharp']);
  });

  test('a repository with no pnpm configuration has an empty allowlist', async () => {
    await write('package.json', manifestJson({ 'left-pad': '1.0.0' }));

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(after.onlyBuilt).toEqual([]);
  });

  test('a malformed pnpm-workspace.yaml aborts the scan', async () => {
    await write('package.json', manifestJson({}));
    await write('pnpm-workspace.yaml', 'onlyBuiltDependencies: "not an array"\n');

    await expectDepGuardError(() => loadStates(repo, { kind: 'audit' }), 'lockfile-parse');
  });
});

describe('npmrc pins', () => {
  test('reads the project .npmrc when present', async () => {
    await write('package.json', manifestJson({}));
    await write(
      '.npmrc',
      [
        '@acme:registry=https://npm.example.invalid/',
        '//npm.example.invalid/:_authToken=redacted-not-a-pin',
        '',
      ].join('\n')
    );

    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(after.npmrcRegistryPins.get('@acme')).toBe('https://npm.example.invalid/');
    expect(after.npmrcRegistryPins.size).toBe(1);
  });

  test('reads the .npmrc from the ref on the before side', async () => {
    await write('package.json', manifestJson({}));
    await write('.npmrc', '@acme:registry=https://npm.example.invalid/\n');
    await commitAll('first');
    await write('.npmrc', '@acme:registry=https://evil.example.invalid/\n');
    await git('add', '-A');

    const { before, after } = await loadStates(repo, { kind: 'staged' });

    expect(before?.npmrcRegistryPins.get('@acme')).toBe('https://npm.example.invalid/');
    expect(after.npmrcRegistryPins.get('@acme')).toBe('https://evil.example.invalid/');
  });
});

describe('symlink containment on the working-tree side', () => {
  test('a workspace directory symlinked outside the root is skipped and reported', async () => {
    const outside = await makeTempDir('dep-guard-outside-');
    await writeFile(
      path.join(outside, 'package.json'),
      JSON.stringify({ name: 'outside', dependencies: { smuggled: '1.0.0' } }),
      'utf8'
    );
    await write('package.json', manifestJson({}, { workspaces: ['packages/*'] }));
    await mkdir(path.join(repo, 'packages'), { recursive: true });
    await symlink(outside, path.join(repo, 'packages', 'linked'), 'dir');

    const { after, diagnostics } = await loadStates(repo, { kind: 'audit' });

    expect(manifestPaths(after)).toEqual(['package.json']);
    expect(diagnostics.map((d) => d.code)).toContain('path-outside-root');
  });

  test('a root manifest that is a symlink out of the root is skipped', async () => {
    const outside = await makeTempDir('dep-guard-outside-root-');
    await writeFile(
      path.join(outside, 'package.json'),
      JSON.stringify({ name: 'outside', dependencies: { smuggled: '1.0.0' } }),
      'utf8'
    );
    await symlink(path.join(outside, 'package.json'), path.join(repo, 'package.json'), 'file');

    const { after, diagnostics } = await loadStates(repo, { kind: 'audit' });

    expect(after.manifests).toEqual([]);
    expect(diagnostics.map((d) => d.code)).toContain('path-outside-root');
  });

  test('a workspace directory symlinked inside the root is still discovered', async () => {
    // Discovered, but reported under the real path rather than the link's
    // spelling -- see the base-scan agreement test below for why.
    await write('package.json', manifestJson({}, { workspaces: ['packages/*'] }));
    await write(
      'real/pkg/package.json',
      JSON.stringify({ name: 'real', dependencies: { dep: '1.0.0' } })
    );
    await mkdir(path.join(repo, 'packages'), { recursive: true });
    await symlink(path.join(repo, 'real', 'pkg'), path.join(repo, 'packages', 'linked'), 'dir');

    const { after, diagnostics } = await loadStates(repo, { kind: 'audit' });

    expect(specifierOf(after, 'real/pkg/package.json', 'dep')).toBe('1.0.0');
    expect(diagnostics).toEqual([]);
  });

  test('a symlink cycle is skipped instead of aborting the scan', async () => {
    await write('package.json', manifestJson({ 'left-pad': '1.0.0' }, { workspaces: ['packages/*'] }));
    await write('packages/real/package.json', JSON.stringify({ name: 'real' }));
    // Points at itself, so resolving it fails with ELOOP. Cycles like this
    // occur in real fixture trees, and the content is repo-writable, so an
    // aborted scan here would be an attacker-triggerable denial of service.
    await symlink('loop', path.join(repo, 'packages', 'loop'), 'dir');

    const { after, diagnostics } = await loadStates(repo, { kind: 'audit' });

    expect(manifestPaths(after)).toEqual(['package.json', 'packages/real/package.json']);
    expect(diagnostics.map((d) => d.code)).toContain('symlink-cycle');
  });

  test('a workspace directory aliasing the root is scanned once', async () => {
    // "packages/self" resolving back to the repository root would otherwise
    // yield the root manifest twice under two different paths -- and in base
    // mode the git side does not follow the link while the working-tree side
    // does, so a single symlink commit would make every root dependency look
    // newly added.
    await write('package.json', manifestJson({ 'left-pad': '1.0.0' }, { workspaces: ['packages/*'] }));
    await mkdir(path.join(repo, 'packages'), { recursive: true });
    await symlink('..', path.join(repo, 'packages', 'self'), 'dir');

    const { after, diagnostics } = await loadStates(repo, { kind: 'audit' });

    expect(manifestPaths(after)).toEqual(['package.json']);
    expect(diagnostics.map((d) => d.code)).toContain('workspace-duplicate-directory');
  });

  test('an aliasing symlink does not make the two sides of a base scan disagree', async () => {
    // This is the harm behind the rule above: the git side never follows a
    // symlink, so before this was fixed the working-tree side alone picked
    // up the aliased copy and every root dependency read as newly added.
    await write('package.json', manifestJson({ 'left-pad': '1.0.0' }, { workspaces: ['packages/*'] }));
    await mkdir(path.join(repo, 'packages'), { recursive: true });
    await symlink('..', path.join(repo, 'packages', 'self'), 'dir');
    await commitAll('first');

    const { before, after } = await loadStates(repo, { kind: 'base', ref: 'HEAD' });

    expect(manifestPaths(before)).toEqual(['package.json']);
    expect(manifestPaths(after)).toEqual(['package.json']);
  });

  test('a manifest reached through a symlink is reported under its real path', async () => {
    // The git side of a base scan finds this package only as "real/pkg",
    // because it never follows the link. If the working-tree side reported
    // whichever spelling its globs happened to reach first, the two sides
    // would name the same package differently and every one of its
    // dependencies would read as removed from one path and added at the
    // other.
    await write('package.json', manifestJson({}, { workspaces: ['packages/*', 'real/*'] }));
    await write(
      'real/pkg/package.json',
      JSON.stringify({ name: 'pkg', dependencies: { dep: '1.0.0' } })
    );
    await mkdir(path.join(repo, 'packages'), { recursive: true });
    await symlink(path.join(repo, 'real', 'pkg'), path.join(repo, 'packages', 'linked'), 'dir');
    await commitAll('first');

    const { before, after } = await loadStates(repo, { kind: 'base', ref: 'HEAD' });

    expect(manifestPaths(before)).toEqual(['package.json', 'real/pkg/package.json']);
    expect(manifestPaths(after)).toEqual(['package.json', 'real/pkg/package.json']);
    expect(specifierOf(before, 'real/pkg/package.json', 'dep')).toBe('1.0.0');
    expect(specifierOf(after, 'real/pkg/package.json', 'dep')).toBe('1.0.0');
  });

  test('staged mode is unaffected by an aliasing symlink', async () => {
    await write('package.json', manifestJson({}, { workspaces: ['packages/*', 'real/*'] }));
    await write(
      'real/pkg/package.json',
      JSON.stringify({ name: 'pkg', dependencies: { dep: '1.0.0' } })
    );
    await mkdir(path.join(repo, 'packages'), { recursive: true });
    await symlink(path.join(repo, 'real', 'pkg'), path.join(repo, 'packages', 'linked'), 'dir');
    await git('add', '-A');

    const { after } = await loadStates(repo, { kind: 'staged' });

    expect(manifestPaths(after)).toEqual(['package.json', 'real/pkg/package.json']);
  });

  test('two distinct real workspace directories are both scanned', async () => {
    await write('package.json', manifestJson({}, { workspaces: ['packages/*'] }));
    await write('packages/a/package.json', JSON.stringify({ name: 'a' }));
    await write('packages/b/package.json', JSON.stringify({ name: 'b' }));

    const { after, diagnostics } = await loadStates(repo, { kind: 'audit' });

    expect(manifestPaths(after)).toEqual([
      'package.json',
      'packages/a/package.json',
      'packages/b/package.json',
    ]);
    expect(diagnostics).toEqual([]);
  });
});

describe('runtime guards', () => {
  test('a wildcard-dense workspace pattern does not blow up on a long name', async () => {
    // The regex this matcher replaced backtracked exponentially: ten
    // wildcards against a 60-character directory name ran for minutes.
    // Both halves are repository content, and both reach this code in
    // staged mode, so the matcher has to be linear.
    const pattern = `packages/${'a*'.repeat(10)}b`;
    await write('package.json', manifestJson({}, { workspaces: [pattern] }));
    await write(`packages/${'a'.repeat(60)}/keep.txt`, 'a directory that never matches\n');

    const start = Date.now();
    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(manifestPaths(after)).toEqual(['package.json']);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test('a wildcard-dense exclusion pattern does not blow up either', async () => {
    await write('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
    await write(
      'package.json',
      manifestJson({}, { workspaces: ['packages/*', `!packages/${'a*'.repeat(10)}b`] })
    );
    await write(`packages/${'a'.repeat(60)}/package.json`, JSON.stringify({ name: 'long' }));

    const start = Date.now();
    const { after } = await loadStates(repo, { kind: 'audit' });

    expect(manifestPaths(after)).toEqual([
      'package.json',
      `packages/${'a'.repeat(60)}/package.json`,
    ]);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('the scanned path itself', () => {
  test('audit of a path that does not exist is an error, not an empty scan', async () => {
    await expectDepGuardError(
      () => loadStates(path.join(repo, 'no-such-directory'), { kind: 'audit' }),
      'path-missing'
    );
  });

  test('staged mode on a path that does not exist reports the path, not git', async () => {
    await expectDepGuardError(
      () => loadStates(path.join(repo, 'no-such-directory'), { kind: 'staged' }),
      'path-missing'
    );
  });

  test('a file passed where a directory belongs is an error', async () => {
    await write('package.json', manifestJson({}));

    await expectDepGuardError(
      () => loadStates(path.join(repo, 'package.json'), { kind: 'audit' }),
      'path-missing'
    );
  });

  test('auditing a directory inside an unrelated repository says so', async () => {
    // The enclosing repository becomes the anchor, so the directory the
    // user actually named is never read on its own terms. That is a
    // surprising enough outcome to be worth stating out loud.
    await write('package.json', manifestJson({ 'left-pad': '1.0.0' }));
    await write('nested/plain/keep.txt', 'not a repository of its own\n');
    await commitAll('first');

    const named = path.join(repo, 'nested', 'plain');
    const { diagnostics } = await loadStates(named, { kind: 'audit' });

    const notice = diagnostics.find((d) => d.code === 'audit-anchor-differs');
    // Both paths in the message have to be resolved ones. Quoting the raw
    // argument next to a resolved anchor makes /var/... and /private/var/...
    // read as two unrelated directories.
    expect(notice?.message).toContain(await realpath(named));
    expect(notice?.message).toContain(await realpath(repo));
  });

  test('staged mode also reports scanning a repository above the named path', async () => {
    await write('package.json', manifestJson({ 'left-pad': '1.0.0' }));
    await write('nested/plain/keep.txt', 'a subdirectory to scan from\n');
    await commitAll('first');

    const { diagnostics } = await loadStates(path.join(repo, 'nested', 'plain'), {
      kind: 'staged',
    });

    expect(diagnostics.map((d) => d.code)).toContain('audit-anchor-differs');
  });

  test('scanning the repository root itself reports no anchor notice', async () => {
    await write('package.json', manifestJson({ 'left-pad': '1.0.0' }));
    await commitAll('first');

    const { diagnostics } = await loadStates(repo, { kind: 'staged' });

    expect(diagnostics).toEqual([]);
  });

  test('every mode anchors manifest paths to the same repository root', async () => {
    // manifestPath feeds finding fingerprints, so the same file has to
    // carry the same path whichever mode and whichever working directory
    // produced it -- otherwise a stored baseline stops matching.
    await write('package.json', manifestJson({ 'left-pad': '1.0.0' }));
    await write('packages/a/keep.txt', 'a subdirectory to scan from\n');
    await commitAll('first');
    const subdirectory = path.join(repo, 'packages', 'a');

    const staged = await loadStates(subdirectory, { kind: 'staged' });
    const audited = await loadStates(subdirectory, { kind: 'audit' });

    expect(manifestPaths(staged.after)).toEqual(['package.json']);
    expect(manifestPaths(audited.after)).toEqual(['package.json']);
  });
});

describe('git failure classification', () => {
  test('a missing-path message survives being longer than the message cap', async () => {
    // The absence wording sits at the END of git's message, so a path long
    // enough to push it past the truncation cap used to convert a plainly
    // absent file into a hard git error. Classification therefore has to
    // run on the full text and truncation only on the way out.
    const longPath = `${'nested/'.repeat(100)}package.json`;
    const failure = `fatal: path '${longPath}' does not exist in 'HEAD'`;
    expect(failure.length).toBeGreaterThan(500);

    const classified = classifyBlobFailure(failure);

    expect(classified.absent).toBe(true);
    expect(classified.message.length).toBeLessThanOrEqual(500);
  });

  test('an unrelated git failure is not absence', async () => {
    const classified = classifyBlobFailure("fatal: invalid object name 'nosuchref'.");

    expect(classified.absent).toBe(false);
  });
});
