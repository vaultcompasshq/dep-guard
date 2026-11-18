import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { scan } from '../src/scan.js';
import { resolveGitBinary } from '../src/utils/git-binary.js';

const execFileAsync = promisify(execFile);
const FIXTURE_CORPUS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'corpus'
);
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const tempDirs: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(resolveGitBinary(), args, {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
  });
  return stdout;
}

async function write(root: string, relative: string, text: string): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
}

async function committedRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dep-guard-no-controls-scan-'));
  tempDirs.push(root);
  await git(root, 'init', '-q', '-b', 'main');
  await write(
    root,
    'package.json',
    JSON.stringify({ dependencies: { 'reeact-definitely-not-real': '1.0.0' } })
  );
  await write(root, '.dep-guard.json', JSON.stringify({ failOn: 'critical' }));
  await write(root, '.dep-guard.local.json', JSON.stringify({ ignorePaths: ['package.json'] }));
  await write(root, 'nested/.dep-guard.local.json', '{}\n');
  await write(root, '.dep-guard.baseline.json', '{"version":1,"fingerprints":[]}\n');
  await write(root, '.npmrc', '@private:registry=https://example.invalid\n');
  await git(root, 'add', '-A');
  await execFileAsync(resolveGitBinary(), ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture'], {
    cwd: root,
    env: { ...GIT_ENV, ...IDENTITY },
  });
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('judges every HEAD dependency with defaults and reports ignored repository controls', async () => {
  const root = await committedRepo();
  const ordinary = await scan({ repoRoot: root, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
  expect(ordinary.findings).toHaveLength(0);
  await write(root, 'package.json', JSON.stringify({ dependencies: {} }));

  const result = await scan({
    repoRoot: root,
    mode: { kind: 'audit' },
    corpusDir: FIXTURE_CORPUS,
    noRepoControls: true,
  });

  expect(result.findings).toEqual([
    expect.objectContaining({
      ruleId: 'unknown-package',
      packageName: 'reeact-definitely-not-real',
      manifestPath: 'package.json',
    }),
  ]);
  expect(result.run.failOn).toBe('medium');
  expect(result.exitCode).toBe(1);
  expect(result.repoControls).toEqual({
    honoured: false,
    present: [
      '.dep-guard.baseline.json',
      '.dep-guard.json',
      '.dep-guard.local.json',
      '.npmrc',
      'nested/.dep-guard.local.json',
    ],
  });
  expect(result.scannedCommit).toBe((await git(root, 'rev-parse', 'HEAD')).trim());
  expect(result.scannedRoot).toBe(await import('node:fs/promises').then(({ realpath }) => realpath(root)));
  expect(result.notScanned).toEqual([]);
});

test('rejects comparison controls before repository preparation', async () => {
  await expect(
    scan({
      repoRoot: '/path/that/must/not/be-read',
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      noRepoControls: true,
    })
  ).rejects.toThrow('--no-repo-controls cannot be combined');
});
