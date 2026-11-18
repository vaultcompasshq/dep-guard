import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanNoRepoControlsGitEnv } from '../src/git-env.js';
import {
  isInsideDir,
  resolveGitBinary,
  type GitResolveEnv,
} from '../src/utils/git-binary.js';
import {
  LOCAL_GIT_CONFIG_ALLOWED_KEYS,
  checkLocalGitConfig,
  isAllowedLocalGitConfigKey,
  localGitConfigRefusal,
} from '../src/utils/local-git-config.js';

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('local git config allowlist', () => {
  test('accepts only fresh-clone keys and the named remote and branch fields', () => {
    expect(LOCAL_GIT_CONFIG_ALLOWED_KEYS).toEqual([
      'core.repositoryformatversion',
      'core.filemode',
      'core.bare',
      'core.logallrefupdates',
      'core.ignorecase',
      'core.precomposeunicode',
      'core.symlinks',
      'extensions.objectformat',
    ]);
    expect(isAllowedLocalGitConfigKey('remote.origin.url')).toBe(true);
    expect(isAllowedLocalGitConfigKey('remote.a.name.fetch')).toBe(true);
    expect(isAllowedLocalGitConfigKey('branch.main.rebase')).toBe(true);
    expect(isAllowedLocalGitConfigKey('remote.origin.promisor')).toBe(false);
    expect(isAllowedLocalGitConfigKey('remote.origin.partialclonefilter')).toBe(false);
    expect(isAllowedLocalGitConfigKey('extensions.worktreeConfig')).toBe(false);
    expect(isAllowedLocalGitConfigKey('core.fsmonitor')).toBe(false);
    expect(isAllowedLocalGitConfigKey('include.path')).toBe(false);
  });

  test('checks a real repository and names the first refused local key', async () => {
    const repo = await tempDir('dep-guard-config-');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
    const git = resolveGitBinary();
    const { execFileSync } = await import('node:child_process');
    execFileSync(git, ['init', '-q'], { cwd: repo, env });
    expect(checkLocalGitConfig(repo, cleanNoRepoControlsGitEnv(env), git).ok).toBe(true);
    execFileSync(git, ['config', '--local', 'core.fsmonitor', 'marker-command'], { cwd: repo, env });

    const verdict = checkLocalGitConfig(repo, cleanNoRepoControlsGitEnv(env), git);

    expect(verdict).toEqual({ ok: false, reason: 'key', key: 'core.fsmonitor' });
    if (verdict.ok) throw new Error('expected a refused config');
    expect(localGitConfigRefusal(verdict, 'dep-guard')).toContain(
      "dep-guard: refusing to run: the repository's local git config sets core.fsmonitor"
    );
    expect(localGitConfigRefusal(verdict, 'dep-guard')).toContain(
      'Clone the repository fresh and assess the clone.'
    );
  });

  test('a failed local config read also carries the clone-fresh remedy', () => {
    expect(
      localGitConfigRefusal(
        { ok: false, reason: 'git', detail: 'config could not be read' },
        'dep-guard'
      )
    ).toContain('Clone the repository fresh and assess the clone.');
  });
});

describe('absolute git binary resolution', () => {
  test('refuses when no executable git exists on an absolute PATH entry', () => {
    expect(() =>
      resolveGitBinary({
        env: { PATH: '/missing' },
        platform: 'linux',
        isFile: () => false,
      })
    ).toThrow('could not find git on PATH');
  });

  test('skips empty and relative PATH entries and returns the first absolute regular file', () => {
    const world: GitResolveEnv = {
      env: { PATH: ':relative:/safe/one:/safe/two' },
      platform: 'linux',
      isFile: (candidate) => candidate === 'relative/git' || candidate === '/safe/two/git',
    };

    expect(resolveGitBinary(world)).toBe('/safe/two/git');
  });

  test('on POSIX skips a regular file without execute permission', () => {
    const world: GitResolveEnv = {
      env: { PATH: '/not-executable:/safe' },
      platform: 'linux',
      isFile: () => true,
      isExecutable: (candidate) => candidate === '/safe/git',
    };

    expect(resolveGitBinary(world)).toBe('/safe/git');
  });

  test('on Windows considers exe and com only, even when PATHEXT names scripts first', () => {
    const seen: string[] = [];
    const world: GitResolveEnv = {
      env: { Path: 'C:\\repo;C:\\safe', PATHEXT: '.CMD;.EXE;.BAT;.COM' },
      platform: 'win32',
      isFile: (candidate) => {
        seen.push(candidate);
        return candidate === 'C:\\safe\\git.com';
      },
    };

    expect(resolveGitBinary(world)).toBe('C:\\safe\\git.com');
    expect(seen).toEqual([
      'C:\\repo\\git.exe',
      'C:\\repo\\git.com',
      'C:\\safe\\git.exe',
      'C:\\safe\\git.com',
    ]);
  });

  test('on Windows skips rooted and drive-relative PATH entries', () => {
    const seen: string[] = [];
    const world: GitResolveEnv = {
      env: { Path: '\\rooted;C:relative;C:\\safe', PATHEXT: '.EXE' },
      platform: 'win32',
      isFile: (candidate) => {
        seen.push(candidate);
        return true;
      },
    };

    expect(resolveGitBinary(world)).toBe('C:\\safe\\git.exe');
    expect(seen).toEqual(['C:\\safe\\git.exe']);
  });

  test('detects a resolved binary at or below the assessed directory', () => {
    expect(isInsideDir('/repo/bin/git', '/repo', path.posix)).toBe(true);
    expect(isInsideDir('/repo', '/repo', path.posix)).toBe(true);
    expect(isInsideDir('/outside/git', '/repo', path.posix)).toBe(false);
  });
});

describe('no-repo-controls git environment', () => {
  test('drops repository and config influence case-insensitively and disables replacement objects', () => {
    const cleaned = cleanNoRepoControlsGitEnv(
      {
        PATH: '/safe/bin',
        GIT_DIR: '/attacker/git',
        Git_Work_Tree: '/attacker/tree',
        GIT_COMMON_DIR: '/attacker/common',
        GIT_OBJECT_DIRECTORY: '/attacker/objects',
        GIT_ALTERNATE_OBJECT_DIRECTORIES: '/attacker/alternate',
        GIT_CONFIG_GLOBAL: '/attacker/global',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.fsmonitor',
        GIT_CONFIG_VALUE_0: 'marker-command',
        GIT_EXEC_PATH: '/attacker/exec',
        GIT_NO_REPLACE_OBJECTS: '0',
      },
      'win32'
    );

    expect(cleaned).toEqual({
      PATH: '/safe/bin',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
    });
  });
});
