import { execFile, execFileSync } from 'node:child_process';
import { access, chmod, copyFile, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  NoRepoControlsError,
  prepareNoRepoControlsRepository,
} from '../src/no-repo-controls.js';
import { resolveGitBinary } from '../src/utils/git-binary.js';
import { readVerifiedHeadTree } from '../src/utils/verified-head-tree.js';

const execFileAsync = promisify(execFile);
const POSIX = process.platform === 'win32' ? test.skip : test;
const WINDOWS = process.platform === 'win32' ? test : test.skip;
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(resolveGitBinary(), args, {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
  });
  return stdout;
}

async function cleanRepo(): Promise<string> {
  const repo = await tempDir('dep-guard-repo-check-');
  await git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'package.json'), '{"dependencies":{}}\n', 'utf8');
  await git(repo, 'add', 'package.json');
  await execFileAsync(
    resolveGitBinary(),
    ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture'],
    { cwd: repo, env: { ...GIT_ENV, ...IDENTITY }, encoding: 'utf8' }
  );
  return repo;
}

async function refusal(repo: string): Promise<NoRepoControlsError> {
  try {
    prepareNoRepoControlsRepository(repo);
  } catch (error) {
    expect(error).toBeInstanceOf(NoRepoControlsError);
    return error as NoRepoControlsError;
  }
  throw new Error('expected repository preparation to refuse');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('no-repo-controls repository preparation', () => {
  test('accepts a plain committed repository and returns its real root and full commit id', async () => {
    const repo = await cleanRepo();

    const prepared = prepareNoRepoControlsRepository(repo);

    expect(prepared.repoRoot).toBe(await realpath(repo));
    expect(prepared.git).toBe(resolveGitBinary());
    expect(prepared.head).toMatch(/^[0-9a-f]{40,64}$/);
    expect(prepared.head).toBe((await git(repo, 'rev-parse', 'HEAD')).trim());
  });

  test('refuses a subdirectory cwd and names both physical paths', async () => {
    const repo = await cleanRepo();
    const sub = path.join(repo, 'sub');
    await mkdir(sub);

    const error = await refusal(sub);

    expect(error.message).toContain('must run from the root');
    expect(error.message).toContain(sub);
    expect(error.message).toContain(repo);
  });

  test.each(['file', 'directory'] as const)('refuses an ancestor .git %s without running git there', async (kind) => {
    const holder = await tempDir('dep-guard-ancestor-');
    const repo = path.join(holder, 'inner');
    await mkdir(repo);
    await git(repo, 'init', '-q', '-b', 'main');
    await writeFile(path.join(repo, 'package.json'), '{}\n', 'utf8');
    await git(repo, 'add', 'package.json');
    await execFileAsync(resolveGitBinary(), ['commit', '-q', '-m', 'fixture'], {
      cwd: repo,
      env: { ...GIT_ENV, ...IDENTITY },
    });
    if (kind === 'file') await writeFile(path.join(holder, '.git'), 'gitdir: /not-used\n', 'utf8');
    else await mkdir(path.join(holder, '.git'));

    const error = await refusal(repo);

    expect(error.message).toContain('sits inside another git work tree');
    expect(error.message).toContain(holder);
    expect(error.message).toContain('Clone the repository fresh and assess the clone.');
  });

  test('refuses a .git pointer file', async () => {
    const repo = await cleanRepo();
    const moved = path.join(await tempDir('dep-guard-gitdir-'), 'store.git');
    await rename(path.join(repo, '.git'), moved);
    await writeFile(path.join(repo, '.git'), `gitdir: ${moved}\n`, 'utf8');

    const error = await refusal(repo);

    expect(error.message).toContain('.git at the repository root is a file or a link');
    expect(error.message).toContain('Clone the repository fresh and assess the clone.');
  });

  test('refuses commondir and alternate object stores', async () => {
    const commondirRepo = await cleanRepo();
    await writeFile(path.join(commondirRepo, '.git', 'commondir'), '.\n', 'utf8');
    expect((await refusal(commondirRepo)).message).toContain('.git/commondir exists');

    const alternateRepo = await cleanRepo();
    await writeFile(
      path.join(alternateRepo, '.git', 'objects', 'info', 'alternates'),
      '/not-used\n',
      'utf8'
    );
    expect((await refusal(alternateRepo)).message).toContain('.git/objects/info/alternates exists');

    const httpAlternateRepo = await cleanRepo();
    await writeFile(
      path.join(httpAlternateRepo, '.git', 'objects', 'info', 'http-alternates'),
      'https://example.invalid/objects\n',
      'utf8'
    );
    expect((await refusal(httpAlternateRepo)).message).toContain(
      '.git/objects/info/http-alternates exists'
    );
  });

  POSIX('refuses links anywhere in the object store', async () => {
    for (const relative of ['objects', 'objects/pack', 'objects/aa']) {
      const repo = await cleanRepo();
      const target = path.join(await tempDir('dep-guard-object-target-'), 'target');
      await mkdir(target);
      const linked = path.join(repo, '.git', relative);
      await rm(linked, { recursive: true, force: true });
      await symlink(target, linked);

      const error = await refusal(repo);

      expect(error.message).toContain(`.git/${relative}`);
      expect(error.message).toMatch(/not a real directory|is a link/);
    }
  });

  POSIX('refuses a special file in the object store', async () => {
    const repo = await cleanRepo();
    const fifo = path.join(repo, '.git', 'objects', 'special');
    await execFileAsync('mkfifo', [fifo]);

    const error = await refusal(repo);

    expect(error.message).toContain('.git/objects/special');
    expect(error.message).toContain('special file');
  });

  POSIX('refuses a git binary resolved from inside the assessed repository', async () => {
    const repo = await cleanRepo();
    const bin = path.join(repo, 'bin');
    await mkdir(bin);
    const fake = path.join(bin, 'git');
    await writeFile(fake, '#!/bin/sh\nexit 99\n', 'utf8');
    await chmod(fake, 0o755);
    const saved = process.env.PATH;
    process.env.PATH = bin;
    try {
      const error = await refusal(repo);
      expect(error.message).toContain('the git found on PATH');
      expect(error.message).toContain('is inside');
    } finally {
      process.env.PATH = saved;
    }
  });

  WINDOWS('does not run a tracked git.exe from the assessed root', async () => {
    const repo = await cleanRepo();
    const planted = path.join(repo, 'git.exe');
    await copyFile(process.execPath, planted);
    await git(repo, 'add', 'git.exe');
    await execFileAsync(resolveGitBinary(), ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'planted git'], {
      cwd: repo,
      env: { ...GIT_ENV, ...IDENTITY },
    });

    const prepared = prepareNoRepoControlsRepository(repo);

    expect(prepared.git.toLowerCase()).not.toBe(planted.toLowerCase());
    expect(prepared.head).toBe((await git(repo, 'rev-parse', 'HEAD')).trim());
  });

  POSIX('never invokes a configured clean filter while reading HEAD objects', async () => {
    const repo = await cleanRepo();
    const prepared = prepareNoRepoControlsRepository(repo);
    const marker = path.join(repo, 'filter-ran');
    const filter = path.join(repo, 'filter.sh');
    await writeFile(filter, `#!/bin/sh\n: > '${marker}'\ncat\n`, 'utf8');
    await chmod(filter, 0o755);
    await writeFile(path.join(repo, '.gitattributes'), 'package.json filter=owned\n', 'utf8');
    await git(repo, 'config', '--local', 'filter.owned.clean', filter);

    await git(repo, 'hash-object', 'package.json');
    await access(marker);
    await rm(marker);

    readVerifiedHeadTree(repo, prepared.head, prepared.git);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await refusal(repo)).message).toContain('filter.owned.clean');
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  POSIX('never invokes a configured fsmonitor while reading HEAD objects', async () => {
    const repo = await cleanRepo();
    const prepared = prepareNoRepoControlsRepository(repo);
    const marker = path.join(repo, 'fsmonitor-ran');
    const monitor = path.join(repo, 'fsmonitor.sh');
    await writeFile(monitor, `#!/bin/sh\n: > '${marker}'\nprintf 'token\\n'\n`, 'utf8');
    await chmod(monitor, 0o755);
    await git(repo, 'config', '--local', 'core.fsmonitor', monitor);

    await git(repo, 'ls-files');
    await access(marker);
    await rm(marker);

    readVerifiedHeadTree(repo, prepared.head, prepared.git);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await refusal(repo)).message).toContain('core.fsmonitor');
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('refuses an unborn HEAD and a HEAD that is not a commit', async () => {
    const unborn = await tempDir('dep-guard-unborn-');
    await git(unborn, 'init', '-q', '-b', 'main');
    expect((await refusal(unborn)).message).toContain('HEAD does not resolve to a commit');

    const blobHead = await cleanRepo();
    const blob = execFileSync(resolveGitBinary(), ['hash-object', '-w', '--stdin'], {
      cwd: blobHead,
      env: GIT_ENV,
      input: 'not a commit\n',
      encoding: 'utf8',
    }).trim();
    await writeFile(path.join(blobHead, '.git', 'HEAD'), `${blob}\n`, 'utf8');
    expect((await refusal(blobHead)).message).toContain('HEAD does not resolve to a commit');
  });
});
