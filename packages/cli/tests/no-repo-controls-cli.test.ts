import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ScanResult } from '@vaultcompass/dep-guard-core';
import { resolveGitBinary } from '../../core/src/utils/git-binary.js';

const execFileAsync = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI_ENTRY = path.join(ROOT, 'packages', 'cli', 'dist', 'cli.js');
const FIXTURE_CORPUS = path.join(ROOT, 'packages', 'core', 'fixtures', 'corpus');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const tempDirs: string[] = [];
const POSIX = process.platform === 'win32' ? test.skip : test;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  return stdout;
}

async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dep-guard-no-controls-cli-'));
  tempDirs.push(root);
  await git(root, 'init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'package.json'), '{"dependencies":{}}\n', 'utf8');
  await git(root, 'add', 'package.json');
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture'], {
    cwd: root,
    env: { ...GIT_ENV, ...IDENTITY },
  });
  return root;
}

async function runJson(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = GIT_ENV
): Promise<ScanResult> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [CLI_ENTRY, ...args, '--no-repo-controls', '--format', 'json', '--corpus-dir', FIXTURE_CORPUS],
    { cwd, env, encoding: 'utf8' }
  );
  return JSON.parse(stdout) as ScanResult;
}

function shellLiteral(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function loggingGit(): Promise<{ bin: string; log: string; marker: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dep-guard-git-shim-'));
  tempDirs.push(dir);
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'git.log');
  const marker = path.join(dir, 'git-ran');
  await mkdir(bin);
  await writeFile(
    path.join(bin, 'git'),
    '#!/bin/sh\n' +
      `printf '%s\\n' "$*" >> ${shellLiteral(log)}\n` +
      `: > ${shellLiteral(marker)}\n` +
      `exec ${shellLiteral(resolveGitBinary())} "$@"\n`,
    'utf8'
  );
  await chmod(path.join(bin, 'git'), 0o755);
  return { bin, log, marker };
}

async function runOutput(cwd: string, format: 'text' | 'sarif'): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      CLI_ENTRY,
      'scan',
      '--no-repo-controls',
      '--format',
      format,
      '--corpus-dir',
      FIXTURE_CORPUS,
    ],
    { cwd, env: GIT_ENV, encoding: 'utf8' }
  );
  return stdout;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test.each([
  ['scan', ['scan']],
  ['check', ['check', 'lodash']],
] as const)('the built %s command activates --no-repo-controls', async (_command, args) => {
  const root = await repo();

  const result = await runJson(root, [...args]);

  expect(result.repoControls).toEqual({ honoured: false, present: [] });
  expect(result.scannedCommit).toBe((await git(root, 'rev-parse', 'HEAD')).trim());
  expect(result.notScannedCount).toBe(result.notScanned?.length);
});

test('text and SARIF carry the same qualified no-repo-controls facts', async () => {
  const root = await repo();
  await writeFile(path.join(root, 'go.mod'), 'module example.invalid/test\n', 'utf8');
  await writeFile(path.join(root, '.dep-guard.json'), '{"ignorePaths":["package.json"]}\n', 'utf8');
  await git(root, 'add', 'go.mod', '.dep-guard.json');
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'report fixture'], {
    cwd: root,
    env: { ...GIT_ENV, ...IDENTITY },
  });

  const text = await runOutput(root, 'text');
  const sarif = JSON.parse(await runOutput(root, 'sarif')) as {
    runs: Array<{ properties: Record<string, unknown> }>;
  };

  expect(text).toContain('No findings in the dependencies judged; 1 item(s) were not judged or were declined.');
  expect(text).toContain('Repository controls: not honoured');
  expect(text).toContain('present: .dep-guard.json');
  expect(text).toContain('Not judged or declined: 1');
  expect(text).toContain('go.mod [unsupported]');
  expect(sarif.runs[0].properties).toMatchObject({
    repoControls: { honoured: false, present: ['.dep-guard.json'] },
    notScannedCount: 1,
    notScanned: [expect.objectContaining({ path: 'go.mod', kind: 'unsupported' })],
  });
});

POSIX.each([
  ['scan --base', ['scan', '--base', 'HEAD']],
  ['scan --staged', ['scan', '--staged']],
  ['scan --trust-base', ['scan', '--trust-base', 'HEAD']],
  ['check --trust-base', ['check', 'lodash', '--trust-base', 'HEAD']],
] as const)('%s is rejected before git starts', async (_label, args) => {
  const root = await repo();
  const shim = await loggingGit();
  const env = { ...GIT_ENV, PATH: shim.bin };

  await expect(
    execFileAsync(process.execPath, [CLI_ENTRY, ...args, '--no-repo-controls'], {
      cwd: root,
      env,
      encoding: 'utf8',
    })
  ).rejects.toMatchObject({ code: 2 });
  await expect(access(shim.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

POSIX('uses only the allowed git commands and reads config first', async () => {
  const root = await repo();
  const shim = await loggingGit();

  await runJson(root, ['scan'], { ...GIT_ENV, PATH: shim.bin });

  const calls = (await readFile(shim.log, 'utf8')).trim().split('\n');
  expect(calls[0]).toBe('config --local --list --name-only -z');
  expect(calls.length).toBeGreaterThan(1);
  for (const call of calls) {
    expect(call).toMatch(/^(?:config\b|-c core\.quotePath=false (?:rev-parse|cat-file)\b|cat-file\b)/);
  }
});

POSIX('produces the same JSON after the entire working tree is replaced', async () => {
  const root = await repo();
  await writeFile(
    path.join(root, 'package.json'),
    '{"dependencies":{"reeact-definitely-not-real":"1.0.0"}}\n',
    'utf8'
  );
  await git(root, 'add', 'package.json');
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'dependency'], {
    cwd: root,
    env: { ...GIT_ENV, ...IDENTITY },
  });
  const before = await runJson(root, ['scan', '--fail-on', 'none']);

  for (const name of await readdir(root)) {
    if (name !== '.git') await rm(path.join(root, name), { recursive: true, force: true });
  }
  await writeFile(path.join(root, '.dep-guard.json'), '{not json\n', 'utf8');
  await mkdir(path.join(root, 'package.json'));
  await symlink(path.join(root, '.git', 'HEAD'), path.join(root, 'hostile-link'));

  const after = await runJson(root, ['scan', '--fail-on', 'none']);
  before.run.durationMs = 0;
  after.run.durationMs = 0;
  expect(after).toEqual(before);
});

POSIX('does not use filesystem APIs on judged working-tree paths', async () => {
  const root = await repo();
  const hookDir = await mkdtemp(path.join(tmpdir(), 'dep-guard-fs-guard-'));
  tempDirs.push(hookDir);
  const hook = path.join(hookDir, 'guard.mjs');
  await writeFile(
    hook,
    `import fs from 'node:fs';\n` +
      `import fsp from 'node:fs/promises';\n` +
      `import path from 'node:path';\n` +
      `import { fileURLToPath } from 'node:url';\n` +
      `const root = ${JSON.stringify(root)};\n` +
      `const dotGit = path.join(root, '.git');\n` +
      `function guard(value) {\n` +
      `  const shown = value instanceof URL ? fileURLToPath(value) : String(value);\n` +
      `  const absolute = path.resolve(shown);\n` +
      `  if (absolute !== root && absolute.startsWith(root + path.sep) && absolute !== dotGit && !absolute.startsWith(dotGit + path.sep)) {\n` +
      `    throw new Error('forbidden working-tree filesystem read: ' + absolute);\n` +
      `  }\n` +
      `}\n` +
      `for (const name of ['readFileSync', 'statSync', 'lstatSync', 'readdirSync', 'existsSync', 'accessSync']) {\n` +
      `  const original = fs[name].bind(fs);\n` +
      `  fs[name] = (value, ...args) => { guard(value); return original(value, ...args); };\n` +
      `}\n` +
      `const realpath = fs.realpathSync.bind(fs);\n` +
      `const nativeRealpath = fs.realpathSync.native.bind(fs.realpathSync);\n` +
      `fs.realpathSync = Object.assign((value, ...args) => { guard(value); return realpath(value, ...args); }, { native: (value, ...args) => { guard(value); return nativeRealpath(value, ...args); } });\n` +
      `for (const name of ['readFile', 'stat', 'lstat', 'readdir', 'realpath', 'access']) {\n` +
      `  const original = fsp[name].bind(fsp);\n` +
      `  fsp[name] = async (value, ...args) => { guard(value); return await original(value, ...args); };\n` +
      `}\n`,
    'utf8'
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--import',
      hook,
      CLI_ENTRY,
      'scan',
      '--no-repo-controls',
      '--format',
      'json',
      '--corpus-dir',
      FIXTURE_CORPUS,
    ],
    { cwd: root, env: GIT_ENV, encoding: 'utf8' }
  );

  expect((JSON.parse(stdout) as ScanResult).repoControls?.honoured).toBe(false);
});
