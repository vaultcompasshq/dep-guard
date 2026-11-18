import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflate, inflate } from 'node:zlib';
import { loadStates } from '../src/git-source.js';
import {
  loadHeadOnlyRepository,
  prepareNoRepoControlsRepository,
} from '../src/no-repo-controls.js';
import {
  gitObjectId,
  hashAlgorithmForOid,
  readVerifiedBlobs,
} from '../src/utils/verified-objects.js';
import {
  classifyMode,
  ObjectStoreMismatch,
  readVerifiedHeadTree,
} from '../src/utils/verified-head-tree.js';
import { resolveGitBinary } from '../src/utils/git-binary.js';

const execFileAsync = promisify(execFile);
const inflateAsync = promisify(inflate);
const deflateAsync = promisify(deflate);
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

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dep-guard-object-read-'));
  tempDirs.push(dir);
  await git(dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'package.json'), '{"dependencies":{"example":"1.0.0"}}\n');
  await git(dir, 'add', 'package.json');
  await execFileAsync(resolveGitBinary(), ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture'], {
    cwd: dir,
    env: { ...GIT_ENV, ...IDENTITY },
  });
  return dir;
}

async function rewriteLooseObject(repoRoot: string, oid: string): Promise<void> {
  const objectPath = path.join(repoRoot, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  const raw = await inflateAsync(await readFile(objectPath));
  const changed = Buffer.from(raw);
  changed[changed.length - 1] ^= 1;
  await chmod(objectPath, 0o600);
  await writeFile(objectPath, await deflateAsync(changed));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('git object ids include the type and byte length', () => {
  expect(hashAlgorithmForOid('a'.repeat(40))).toBe('sha1');
  expect(hashAlgorithmForOid('a'.repeat(64))).toBe('sha256');
  expect(hashAlgorithmForOid('xyz')).toBeNull();
  expect(gitObjectId('sha1', 'blob', Buffer.from('test content\n'))).toBe(
    'd670460b4b4aece5915caf5c68d12f560a9fe3e4'
  );
});

test.each([
  ['100664', 'file'],
  ['100600', 'file'],
  ['0100644', 'file'],
  ['100744', 'file'],
  ['40755', 'tree'],
  ['040755', 'tree'],
  ['0040000', 'tree'],
  ['120000', 'symlink'],
  ['160000', 'gitlink'],
  ['abc', null],
  ['1', null],
  ['170000', null],
] as const)('classifies raw tree mode %s as %s', (mode, expected) => {
  expect(classifyMode(mode)).toBe(expected);
});

test('reads a verified HEAD commit, tree and blob', async () => {
  const root = await repo();
  const prepared = prepareNoRepoControlsRepository(root);

  const entries = readVerifiedHeadTree(prepared.repoRoot, prepared.head, prepared.git);
  const manifest = entries.find((entry) => entry.path === 'package.json');
  expect(manifest).toMatchObject({ type: 'blob', mode: '100644' });
  const blobs = readVerifiedBlobs(prepared.repoRoot, [manifest!.oid], prepared.git);
  expect(blobs.get(manifest!.oid)?.toString('utf8')).toContain('example');
});

test('loads dependency state only from verified HEAD blobs', async () => {
  const root = await repo();
  await writeFile(path.join(root, 'package.json'), '{"dependencies":{"hostile":"9.9.9"}}\n');
  await writeFile(path.join(root, '.npmrc'), '@example:registry=https://example.invalid\n');
  const repository = loadHeadOnlyRepository(root);

  const states = await loadStates(repository.repoRoot, { kind: 'audit' }, { headOnly: repository });

  expect(states.after.manifests[0].deps.map((dep) => dep.name)).toEqual(['example']);
  expect(states.after.npmrcContent).toBeNull();
  expect(states.after.npmrcRegistryPins).toEqual(new Map());
});

test('refuses a loose blob whose bytes no longer match its id', async () => {
  const root = await repo();
  const prepared = prepareNoRepoControlsRepository(root);
  const entry = readVerifiedHeadTree(prepared.repoRoot, prepared.head, prepared.git)[0];
  await rewriteLooseObject(root, entry.oid);

  expect(() => readVerifiedBlobs(prepared.repoRoot, [entry.oid], prepared.git)).toThrow(
    ObjectStoreMismatch
  );
});

test('refuses a loose commit whose bytes no longer match its id', async () => {
  const root = await repo();
  const prepared = prepareNoRepoControlsRepository(root);
  await rewriteLooseObject(root, prepared.head);

  expect(() => readVerifiedHeadTree(prepared.repoRoot, prepared.head, prepared.git)).toThrow(
    ObjectStoreMismatch
  );
});
