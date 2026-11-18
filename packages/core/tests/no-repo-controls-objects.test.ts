import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
  readVerifiedBlobsBounded,
} from '../src/utils/verified-objects.js';
import {
  classifyMode,
  lexicalEntryPath,
  ObjectStoreMismatch,
  parseTree,
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

async function repo(objectFormat: 'sha1' | 'sha256' = 'sha1'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dep-guard-object-read-'));
  tempDirs.push(dir);
  await git(dir, 'init', '-q', '-b', 'main', `--object-format=${objectFormat}`);
  await writeFile(path.join(dir, 'package.json'), '{"dependencies":{"example":"1.0.0"}}\n');
  await git(dir, 'add', 'package.json');
  await execFileAsync(resolveGitBinary(), ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture'], {
    cwd: dir,
    env: { ...GIT_ENV, ...IDENTITY },
  });
  return dir;
}

async function movePackedObjectOffset(repoRoot: string, oid: string): Promise<void> {
  const packDir = path.join(repoRoot, '.git', 'objects', 'pack');
  const indexName = (await readdir(packDir)).find((name) => name.endsWith('.idx'));
  if (indexName === undefined) throw new Error('fixture has no pack index');
  const indexPath = path.join(packDir, indexName);
  const bytes = Buffer.from(await readFile(indexPath));
  const count = bytes.readUInt32BE(8 + 255 * 4);
  const oidTable = 8 + 256 * 4;
  let objectIndex = -1;
  for (let index = 0; index < count; index += 1) {
    if (bytes.subarray(oidTable + index * 20, oidTable + (index + 1) * 20).toString('hex') === oid) {
      objectIndex = index;
      break;
    }
  }
  if (objectIndex === -1) throw new Error('fixture object is absent from pack index');
  const offsets = oidTable + count * 20 + count * 4;
  const position = offsets + objectIndex * 4;
  bytes.writeUInt32BE((bytes.readUInt32BE(position) + 1) >>> 0, position);
  createHash('sha1').update(bytes.subarray(0, bytes.length - 20)).digest().copy(bytes, bytes.length - 20);
  await chmod(indexPath, 0o600);
  await writeFile(indexPath, bytes);
}

function writeObject(repoRoot: string, type: 'blob' | 'tree', bytes: Buffer): string {
  return execFileSync(
    resolveGitBinary(),
    ['hash-object', '-t', type, '--literally', '-w', '--stdin'],
    { cwd: repoRoot, env: GIT_ENV, input: bytes, encoding: 'utf8' }
  ).trim();
}

function treeRow(mode: string, name: string, oid: string): Buffer {
  return Buffer.concat([
    Buffer.from(`${mode} ${name}\0`, 'utf8'),
    Buffer.from(oid, 'hex'),
  ]);
}

async function pointHeadAtTree(repoRoot: string, tree: string): Promise<string> {
  const commit = (
    await execFileAsync(resolveGitBinary(), ['commit-tree', tree, '-m', 'raw tree'], {
      cwd: repoRoot,
      env: { ...GIT_ENV, ...IDENTITY },
      encoding: 'utf8',
    })
  ).stdout.trim();
  await writeFile(path.join(repoRoot, '.git', 'HEAD'), `${commit}\n`, 'utf8');
  return commit;
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

test('hashes oversized blobs without retaining them and enforces the discard budget', async () => {
  const root = await repo();
  const small = writeObject(root, 'blob', Buffer.from('small'));
  const large = writeObject(root, 'blob', Buffer.alloc(32, 0x61));

  const read = await readVerifiedBlobsBounded(root, [small, large], resolveGitBinary(), 8, 64);

  expect(read.blobs.get(small)?.toString('utf8')).toBe('small');
  expect(read.blobs.has(large)).toBe(false);
  expect(read.oversized.get(large)).toBe(32);
  await expect(
    readVerifiedBlobsBounded(root, [large], resolveGitBinary(), 8, 16)
  ).rejects.toThrow('verification budget');
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

test.each(['..\\outside', 'C:drive-relative', 'D:\\outside', '\\rooted'])(
  'refuses the Windows path %s outside a repository root',
  (relative) => {
    expect(() => lexicalEntryPath('C:\\repo', relative, path.win32)).toThrow(ObjectStoreMismatch);
  }
);

test('spends the tree row budget while parsing', () => {
  const oid = '0'.repeat(40);
  const bytes = Buffer.concat([treeRow('100644', 'a', oid), treeRow('100644', 'b', oid)]);
  expect(() => parseTree(bytes, 20, 'tree', { left: 1 })).toThrow('too large to list');
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
  const repository = await loadHeadOnlyRepository(root);

  const states = await loadStates(repository.repoRoot, { kind: 'audit' }, { headOnly: repository });

  expect(states.after.manifests[0].deps.map((dep) => dep.name)).toEqual(['example']);
  expect(states.after.npmrcContent).toBeNull();
  expect(states.after.npmrcRegistryPins).toEqual(new Map());
});

test('hashes an oversized dependency input, reports it and does not parse it', async () => {
  const root = await repo();

  const repository = await loadHeadOnlyRepository(root, { inputBytes: 8, oversizedBytes: 1024 });
  const states = await loadStates(repository.repoRoot, { kind: 'audit' }, { headOnly: repository });

  expect(repository.notScanned).toEqual([
    expect.objectContaining({ path: 'package.json', kind: 'too-large' }),
  ]);
  expect(states.after.manifests).toEqual([]);

  const oid = (await git(root, 'rev-parse', 'HEAD:package.json')).trim();
  await rewriteLooseObject(root, oid);
  await expect(
    loadHeadOnlyRepository(root, { inputBytes: 8, oversizedBytes: 1024 })
  ).rejects.toThrow(ObjectStoreMismatch);
});

(process.platform === 'win32' ? test.skip : test)(
  'refuses a manifest stored as a symlink in HEAD',
  async () => {
    const root = await repo();
    await mkdir(path.join(root, 'nested'));
    await symlink('../package.json', path.join(root, 'nested', 'package.json'));
    await git(root, 'add', 'nested/package.json');
    await execFileAsync(resolveGitBinary(), ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'symlink'], {
      cwd: root,
      env: { ...GIT_ENV, ...IDENTITY },
    });

    await expect(loadHeadOnlyRepository(root)).rejects.toThrow('stored as a symlink in HEAD');
  }
);

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

test('refuses a loose tree whose bytes no longer match its id', async () => {
  const root = await repo();
  const prepared = prepareNoRepoControlsRepository(root);
  const tree = (await git(root, 'rev-parse', 'HEAD^{tree}')).trim();
  await rewriteLooseObject(root, tree);

  expect(() => readVerifiedHeadTree(prepared.repoRoot, prepared.head, prepared.git)).toThrow(
    ObjectStoreMismatch
  );
});

test('reads a repository after git gc packs its objects', async () => {
  const root = await repo();
  await git(root, 'gc', '--prune=now', '--quiet');

  const prepared = prepareNoRepoControlsRepository(root);

  expect(readVerifiedHeadTree(prepared.repoRoot, prepared.head, prepared.git)).toEqual([
    expect.objectContaining({ path: 'package.json', type: 'blob' }),
  ]);
});

test('refuses a moved pack-index offset', async () => {
  const root = await repo();
  const head = (await git(root, 'rev-parse', 'HEAD')).trim();
  await git(root, 'gc', '--prune=now', '--quiet');
  await movePackedObjectOffset(root, head);

  expect(() => readVerifiedHeadTree(root, head, resolveGitBinary())).toThrow(ObjectStoreMismatch);
});

test('reads sha256 objects and refuses a rewritten sha256 blob', async () => {
  const root = await repo('sha256');
  const prepared = prepareNoRepoControlsRepository(root);
  const entry = readVerifiedHeadTree(prepared.repoRoot, prepared.head, prepared.git)[0];
  expect(prepared.head).toMatch(/^[0-9a-f]{64}$/);
  expect(readVerifiedBlobs(prepared.repoRoot, [entry.oid], prepared.git).get(entry.oid)).toBeDefined();
  await rewriteLooseObject(root, entry.oid);

  expect(() => readVerifiedBlobs(prepared.repoRoot, [entry.oid], prepared.git)).toThrow(
    ObjectStoreMismatch
  );
});

test('ignores replacement refs while reading HEAD objects', async () => {
  const root = await repo();
  const original = (await git(root, 'rev-parse', 'HEAD')).trim();
  await writeFile(path.join(root, 'package.json'), '{"dependencies":{"replacement":"1.0.0"}}\n');
  await git(root, 'add', 'package.json');
  await execFileAsync(resolveGitBinary(), ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'replacement'], {
    cwd: root,
    env: { ...GIT_ENV, ...IDENTITY },
  });
  const replacement = (await git(root, 'rev-parse', 'HEAD')).trim();
  await git(root, 'replace', original, replacement);
  await git(root, 'reset', '--hard', '--quiet', original);

  const prepared = prepareNoRepoControlsRepository(root);
  const entries = readVerifiedHeadTree(prepared.repoRoot, prepared.head, prepared.git);
  const manifest = entries.find((entry) => entry.path === 'package.json');
  const text = readVerifiedBlobs(prepared.repoRoot, [manifest!.oid], prepared.git)
    .get(manifest!.oid)!
    .toString('utf8');
  expect(text).toContain('example');
  expect(text).not.toContain('replacement');
});

test('reads regular-file and tree modes by their type bits', async () => {
  const root = await repo();
  const blob = writeObject(root, 'blob', Buffer.from('content\n'));
  const emptyTree = writeObject(root, 'tree', Buffer.alloc(0));
  const rows = Buffer.concat([
    ...['100664', '100600', '0100644', '100744'].map((mode, index) =>
      treeRow(mode, `file-${index}`, blob)
    ),
    ...['40755', '040755', '0040000'].map((mode, index) =>
      treeRow(mode, `dir-${index}`, emptyTree)
    ),
  ]);
  const tree = writeObject(root, 'tree', rows);
  const head = await pointHeadAtTree(root, tree);

  const entries = readVerifiedHeadTree(root, head, resolveGitBinary());

  expect(entries.map((entry) => entry.mode)).toEqual(['100664', '100600', '0100644', '100744']);
});

test('lists gitlinks as submodules without descending into them', async () => {
  const root = await repo();
  const submoduleCommit = (await git(root, 'rev-parse', 'HEAD')).trim();
  const blob = writeObject(root, 'blob', Buffer.from('{"dependencies":{}}\n'));
  const tree = writeObject(
    root,
    'tree',
    Buffer.concat([
      treeRow('100644', 'package.json', blob),
      treeRow('160000', 'vendor-module', submoduleCommit),
    ])
  );
  await pointHeadAtTree(root, tree);

  const repository = await loadHeadOnlyRepository(root);

  expect(repository.notScanned).toEqual([
    expect.objectContaining({ path: 'vendor-module', kind: 'submodule' }),
  ]);
  expect(repository.entries.find((entry) => entry.path === 'vendor-module')).toMatchObject({
    type: 'commit',
  });
});

test.each(['abc', '1', '170000', '010000'])(
  'refuses unsupported raw mode %s',
  async (mode) => {
    const root = await repo();
    const blob = writeObject(root, 'blob', Buffer.from('content\n'));
    const tree = writeObject(root, 'tree', treeRow(mode, 'package.json', blob));
    const head = await pointHeadAtTree(root, tree);

    expect(() => readVerifiedHeadTree(root, head, resolveGitBinary())).toThrow(ObjectStoreMismatch);
  }
);

test.each([
  ['100644', 'tree'],
  ['040000', 'blob'],
] as const)('refuses mode %s naming a %s object', async (mode, namedType) => {
  const root = await repo();
  const oid =
    namedType === 'tree'
      ? writeObject(root, 'tree', Buffer.alloc(0))
      : writeObject(root, 'blob', Buffer.from('content\n'));
  const tree = writeObject(root, 'tree', treeRow(mode, 'mismatch', oid));
  const head = await pointHeadAtTree(root, tree);

  expect(() => readVerifiedHeadTree(root, head, resolveGitBinary())).toThrow(ObjectStoreMismatch);
});

test('refuses duplicate decoded paths and accepts odd unambiguous names', async () => {
  const duplicateRoot = await repo();
  const blob = writeObject(duplicateRoot, 'blob', Buffer.from('content\n'));
  const duplicateTree = writeObject(
    duplicateRoot,
    'tree',
    Buffer.concat([treeRow('100644', 'same', blob), treeRow('100644', 'same', blob)])
  );
  const duplicateHead = await pointHeadAtTree(duplicateRoot, duplicateTree);
  expect(() => readVerifiedHeadTree(duplicateRoot, duplicateHead, resolveGitBinary())).toThrow(
    ObjectStoreMismatch
  );

  const oddRoot = await repo();
  const oddBlob = writeObject(oddRoot, 'blob', Buffer.from('content\n'));
  const oddTree = writeObject(
    oddRoot,
    'tree',
    Buffer.concat([
      treeRow('100644', 'line\nbreak', oddBlob),
      treeRow('100644', 'quote"name', oddBlob),
    ])
  );
  const oddHead = await pointHeadAtTree(oddRoot, oddTree);
  expect(readVerifiedHeadTree(oddRoot, oddHead, resolveGitBinary()).map((entry) => entry.path)).toEqual([
    'line\nbreak',
    'quote"name',
  ]);
});

test('bounds wide, deep and repeatedly shared trees while walking', async () => {
  const wideRoot = await repo();
  const wideBlob = writeObject(wideRoot, 'blob', Buffer.from('content\n'));
  const wideTree = writeObject(
    wideRoot,
    'tree',
    Buffer.concat(
      Array.from({ length: 5 }, (_, index) => treeRow('100644', `file-${index}`, wideBlob))
    )
  );
  const wideHead = await pointHeadAtTree(wideRoot, wideTree);
  expect(() =>
    readVerifiedHeadTree(wideRoot, wideHead, resolveGitBinary(), {
      rows: 3,
      pathBytes: 1024,
      depth: 20,
      treeObjectBytes: 1024,
    })
  ).toThrow('too large to list');

  const deepRoot = await repo();
  let deepTree = writeObject(deepRoot, 'tree', Buffer.alloc(0));
  for (let depth = 0; depth < 5; depth += 1) {
    deepTree = writeObject(deepRoot, 'tree', treeRow('040000', `dir-${depth}`, deepTree));
  }
  const deepHead = await pointHeadAtTree(deepRoot, deepTree);
  expect(() =>
    readVerifiedHeadTree(deepRoot, deepHead, resolveGitBinary(), {
      rows: 100,
      pathBytes: 4096,
      depth: 3,
      treeObjectBytes: 4096,
    })
  ).toThrow('too large to list');

  const bombRoot = await repo();
  const bombBlob = writeObject(bombRoot, 'blob', Buffer.from('content\n'));
  let sharedTree = writeObject(bombRoot, 'tree', treeRow('100644', 'leaf', bombBlob));
  for (let depth = 0; depth < 5; depth += 1) {
    sharedTree = writeObject(
      bombRoot,
      'tree',
      Buffer.concat(
        Array.from({ length: 4 }, (_, index) => treeRow('040000', `branch-${depth}-${index}`, sharedTree))
      )
    );
  }
  const bombHead = await pointHeadAtTree(bombRoot, sharedTree);
  expect(() =>
    readVerifiedHeadTree(bombRoot, bombHead, resolveGitBinary(), {
      rows: 100,
      pathBytes: 1024 * 1024,
      depth: 20,
      treeObjectBytes: 1024 * 1024,
    })
  ).toThrow('too large to list');
});
