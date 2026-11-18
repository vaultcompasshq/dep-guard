import path from 'node:path';
import {
  hashAlgorithmForOid,
  objectStoreMismatch,
  objectTypes,
  ObjectStoreMismatch,
  readVerifiedObjects,
} from './verified-objects.js';

export { ObjectStoreMismatch } from './verified-objects.js';

export interface VerifiedEntry {
  mode: string;
  type: 'blob' | 'symlink' | 'commit';
  oid: string;
  path: string;
}

export const MAX_TREE_ROWS_WALKED = 2_000_000;
export const MAX_TREE_PATH_BYTES = 512 * 1024 * 1024;
export const MAX_TREE_DEPTH = 1000;
const MAX_TREE_OBJECT_BYTES = 512 * 1024 * 1024;

type RowKind = 'tree' | 'file' | 'symlink' | 'gitlink';
interface Row {
  mode: string;
  kind: RowKind;
  name: string;
  oid: string;
}

export interface RowBudget {
  left: number;
}

function tooLarge(detail: string): ObjectStoreMismatch {
  return new ObjectStoreMismatch(
    `dep-guard: the HEAD tree is too large to list: ${detail} (limits: ${MAX_TREE_ROWS_WALKED} tree rows, ` +
      `${MAX_TREE_PATH_BYTES} path bytes, depth ${MAX_TREE_DEPTH}). Nothing was scanned.`
  );
}

export function classifyMode(mode: string): RowKind | null {
  if (!/^[0-7]{1,16}$/.test(mode)) return null;
  switch (Number.parseInt(mode, 8) & 0o170000) {
    case 0o040000:
      return 'tree';
    case 0o100000:
      return 'file';
    case 0o120000:
      return 'symlink';
    case 0o160000:
      return 'gitlink';
    default:
      return null;
  }
}

export function parseTree(
  bytes: Buffer,
  rawOidBytes: number,
  treeOid: string,
  budget: RowBudget
): Row[] {
  const rows: Row[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (--budget.left < 0) throw tooLarge(`over ${MAX_TREE_ROWS_WALKED} tree rows`);
    const space = bytes.indexOf(0x20, offset);
    const nul = space === -1 ? -1 : bytes.indexOf(0, space + 1);
    if (space === -1 || nul === -1 || bytes.length < nul + 1 + rawOidBytes) {
      throw objectStoreMismatch(`tree ${treeOid} is malformed`);
    }
    const mode = bytes.toString('latin1', offset, space);
    const nameBytes = bytes.subarray(space + 1, nul);
    const name = nameBytes.toString('utf8');
    const kind = classifyMode(mode);
    if (kind === null) {
      throw new ObjectStoreMismatch(
        `dep-guard: the HEAD tree entry ${JSON.stringify(name)} has unsupported mode ${JSON.stringify(
          mode
        )} in tree ${treeOid}. Nothing was scanned.`
      );
    }
    if (nameBytes.length === 0 || name.includes('/') || name === '.' || name === '..' || name.includes('\0')) {
      throw new ObjectStoreMismatch(
        `dep-guard: the HEAD tree has an unsafe path segment ${JSON.stringify(name)} in tree ${treeOid}. ` +
          'Nothing was scanned.'
      );
    }
    rows.push({
      mode,
      kind,
      name,
      oid: bytes.subarray(nul + 1, nul + 1 + rawOidBytes).toString('hex'),
    });
    offset = nul + 1 + rawOidBytes;
  }
  return rows;
}

export function lexicalEntryPath(root: string, relative: string, platformPath: path.PlatformPath = path): string {
  const segments = relative.split('/');
  if (
    relative === '' ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    platformPath.isAbsolute(relative) ||
    platformPath.resolve(root, relative).startsWith(`${platformPath.resolve(root)}${platformPath.sep}`) === false
  ) {
    throw new ObjectStoreMismatch(
      `dep-guard: the HEAD tree path ${JSON.stringify(relative)} resolves outside the repository. Nothing was scanned.`
    );
  }
  return platformPath.resolve(root, relative);
}

export function readVerifiedHeadTree(repoRoot: string, headOid: string, git: string): VerifiedEntry[] {
  const algorithm = hashAlgorithmForOid(headOid);
  if (algorithm === null) throw objectStoreMismatch(`HEAD ${headOid} is not a sha1 or sha256 id`);
  const rawOidBytes = algorithm === 'sha1' ? 20 : 32;
  const commit = readVerifiedObjects(repoRoot, [headOid], algorithm, git).get(headOid);
  if (commit === undefined || commit.type !== 'commit') {
    throw objectStoreMismatch(`HEAD ${headOid} is not a commit`);
  }
  const firstLine = commit.bytes.toString('utf8').split('\n')[0] ?? '';
  const treeLine = /^tree ([0-9a-f]+)$/.exec(firstLine);
  if (treeLine === null || treeLine[1].length !== rawOidBytes * 2) {
    throw objectStoreMismatch(`commit ${headOid} has no valid tree line`);
  }

  const rowsByTree = new Map<string, Row[]>();
  const parseBudget: RowBudget = { left: MAX_TREE_ROWS_WALKED };
  const wanted = (ids: readonly string[]): string[] =>
    [...new Set(ids)].filter((oid) => !rowsByTree.has(oid));
  let next = wanted([treeLine[1]]);
  let rounds = 0;
  let rawTreeBytes = 0;
  while (next.length > 0) {
    if (++rounds > MAX_TREE_DEPTH) throw tooLarge(`deeper than ${MAX_TREE_DEPTH} directories`);
    const children: string[] = [];
    for (const [oid, object] of readVerifiedObjects(repoRoot, next, algorithm, git)) {
      if (object.type !== 'tree') throw objectStoreMismatch(`${object.type} ${oid} is where a tree is named`);
      rawTreeBytes += object.bytes.length;
      if (rawTreeBytes > MAX_TREE_OBJECT_BYTES) {
        throw tooLarge(`tree objects exceed ${MAX_TREE_OBJECT_BYTES} bytes`);
      }
      const rows = parseTree(object.bytes, rawOidBytes, oid, parseBudget);
      rowsByTree.set(oid, rows);
      for (const row of rows) if (row.kind === 'tree') children.push(row.oid);
    }
    next = wanted(children);
  }

  const rootTree = treeLine[1];
  const rootRows = rowsByTree.get(rootTree);
  if (rootRows === undefined) throw objectStoreMismatch(`root tree ${rootTree} was not read`);
  const entries: VerifiedEntry[] = [];
  const seenPaths = new Set<string>();
  const stack = [{ rows: rootRows, index: 0, prefix: '' }];
  let walked = 0;
  let pathBytes = 0;
  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    if (current.index >= current.rows.length) {
      stack.pop();
      continue;
    }
    const row = current.rows[current.index++];
    if (++walked > MAX_TREE_ROWS_WALKED) throw tooLarge(`over ${MAX_TREE_ROWS_WALKED} tree rows`);
    const relative = `${current.prefix}${row.name}`;
    lexicalEntryPath(repoRoot, relative);
    pathBytes += Buffer.byteLength(relative);
    if (pathBytes > MAX_TREE_PATH_BYTES) throw tooLarge(`over ${MAX_TREE_PATH_BYTES} path bytes`);
    if (seenPaths.has(relative)) {
      throw new ObjectStoreMismatch(
        `dep-guard: the HEAD tree resolves more than one entry to ${JSON.stringify(relative)}. Nothing was scanned.`
      );
    }
    seenPaths.add(relative);
    if (row.kind === 'tree') {
      if (stack.length >= MAX_TREE_DEPTH) throw tooLarge(`deeper than ${MAX_TREE_DEPTH} directories`);
      const rows = rowsByTree.get(row.oid);
      if (rows === undefined) throw objectStoreMismatch(`tree ${row.oid} was not read`);
      stack.push({ rows, index: 0, prefix: `${relative}/` });
    } else {
      entries.push({
        mode: row.kind === 'gitlink' ? '160000' : row.mode,
        type: row.kind === 'gitlink' ? 'commit' : row.kind === 'symlink' ? 'symlink' : 'blob',
        oid: row.oid,
        path: relative,
      });
    }
  }

  const nonGitlinks = entries.filter((entry) => entry.type !== 'commit');
  const types = objectTypes(
    repoRoot,
    nonGitlinks.map((entry) => entry.oid),
    git
  );
  for (const entry of nonGitlinks) {
    const type = types.get(entry.oid);
    if (type === undefined) {
      throw new ObjectStoreMismatch(
        `dep-guard: the HEAD tree names a missing object at ${JSON.stringify(entry.path)} (${entry.oid}). ` +
          'Clone the repository fresh and assess the clone. Nothing was scanned.'
      );
    }
    if (type !== 'blob') {
      throw new ObjectStoreMismatch(
        `dep-guard: the HEAD tree entry ${JSON.stringify(entry.path)} has mode ${entry.mode} but names a ${type}. ` +
          'Nothing was scanned.'
      );
    }
  }
  return entries;
}
