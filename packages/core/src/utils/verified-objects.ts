import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cleanNoRepoControlsGitEnv } from '../git-env.js';

const MAX_BATCH_BYTES = 512 * 1024 * 1024;
const REMEDY = 'Clone the repository fresh and assess the clone.';

export class ObjectStoreMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectStoreMismatch';
  }
}

export function objectStoreMismatch(detail: string): ObjectStoreMismatch {
  return new ObjectStoreMismatch(
    `dep-guard: the object store does not hold what its ids claim: ${detail}. ${REMEDY} Nothing was scanned.`
  );
}

export function hashAlgorithmForOid(oid: string): 'sha1' | 'sha256' | null {
  if (/^[0-9a-f]{40}$/.test(oid)) return 'sha1';
  if (/^[0-9a-f]{64}$/.test(oid)) return 'sha256';
  return null;
}

export function gitObjectId(algorithm: 'sha1' | 'sha256', type: string, bytes: Buffer): string {
  return createHash(algorithm).update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
}

export interface VerifiedObject {
  type: string;
  bytes: Buffer;
}

export interface ObjectInfo {
  type: string;
  size: number;
}

export function readVerifiedObjects(
  repoRoot: string,
  oids: readonly string[],
  expectedAlgorithm: 'sha1' | 'sha256',
  git: string
): Map<string, VerifiedObject> {
  const unique = [...new Set(oids)];
  const objects = new Map<string, VerifiedObject>();
  if (unique.length === 0) return objects;
  const result = spawnSync(git, ['-c', 'core.quotePath=false', 'cat-file', '--batch'], {
    cwd: repoRoot,
    env: cleanNoRepoControlsGitEnv(),
    input: unique.map((oid) => `${oid}\n`).join(''),
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: MAX_BATCH_BYTES,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS') {
    throw new ObjectStoreMismatch(
      `dep-guard: committed content exceeded the ${MAX_BATCH_BYTES} byte object-read limit. Nothing was scanned.`
    );
  }
  if (result.error !== undefined || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : '';
    throw new ObjectStoreMismatch(
      `dep-guard: could not read committed content with git cat-file --batch: ${
        stderr || String(result.error ?? `git exited with status ${String(result.status)}`)
      }. Nothing was scanned.`
    );
  }
  let offset = 0;
  for (const oid of unique) {
    const newline = result.stdout.indexOf(0x0a, offset);
    if (newline === -1) throw objectStoreMismatch(`git answered too few objects at ${oid}`);
    const fields = result.stdout.toString('utf8', offset, newline).split(' ');
    if (fields.length !== 3 || fields[0] !== oid) {
      const detail = fields.slice(1).join(' ') || 'unparseable answer';
      throw new ObjectStoreMismatch(
        `dep-guard: the object store has no usable object ${oid} (${detail}). ${REMEDY} Nothing was scanned.`
      );
    }
    const size = Number.parseInt(fields[2], 10);
    const start = newline + 1;
    if (!Number.isSafeInteger(size) || size < 0 || result.stdout.length < start + size + 1) {
      throw objectStoreMismatch(`object ${oid} has an unreadable body`);
    }
    const bytes = result.stdout.subarray(start, start + size);
    if (gitObjectId(expectedAlgorithm, fields[1], bytes) !== oid) {
      throw objectStoreMismatch(`${fields[1]} ${oid} does not hash to its own id`);
    }
    objects.set(oid, { type: fields[1], bytes });
    offset = start + size + 1;
  }
  if (offset !== result.stdout.length) {
    throw objectStoreMismatch('git answered unexpected bytes after the requested objects');
  }
  return objects;
}

export function readVerifiedBlobs(
  repoRoot: string,
  oids: readonly string[],
  git: string
): Map<string, Buffer> {
  const unique = [...new Set(oids)];
  const algorithm = unique.length === 0 ? 'sha1' : hashAlgorithmForOid(unique[0]);
  if (algorithm === null || unique.some((oid) => hashAlgorithmForOid(oid) !== algorithm)) {
    throw objectStoreMismatch('a blob id is neither a consistent sha1 nor sha256 id');
  }
  const blobs = new Map<string, Buffer>();
  for (const [oid, object] of readVerifiedObjects(repoRoot, unique, algorithm, git)) {
    if (object.type !== 'blob') {
      throw objectStoreMismatch(`${oid} is a ${object.type}, where a blob is named`);
    }
    blobs.set(oid, object.bytes);
  }
  return blobs;
}

export function objectInfo(
  repoRoot: string,
  oids: readonly string[],
  git: string
): Map<string, ObjectInfo> {
  const unique = [...new Set(oids)];
  const info = new Map<string, ObjectInfo>();
  if (unique.length === 0) return info;
  const result = spawnSync(git, ['-c', 'core.quotePath=false', 'cat-file', '--batch-check'], {
    cwd: repoRoot,
    env: cleanNoRepoControlsGitEnv(),
    input: unique.map((oid) => `${oid}\n`).join(''),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: MAX_BATCH_BYTES,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new ObjectStoreMismatch(
      `dep-guard: could not check committed object types with git cat-file --batch-check: ${String(
        result.error ?? result.stderr
      ).trim()}. Nothing was scanned.`
    );
  }
  const lines = result.stdout.split('\n').filter(Boolean);
  if (lines.length !== unique.length) {
    throw objectStoreMismatch(
      `git answered ${lines.length} type rows for ${unique.length} requested objects`
    );
  }
  for (let index = 0; index < unique.length; index += 1) {
    const fields = lines[index].split(' ');
    if (fields[0] !== unique[index] || fields.length !== 3) continue;
    const size = Number.parseInt(fields[2], 10);
    if (Number.isSafeInteger(size) && size >= 0) {
      info.set(fields[0], { type: fields[1], size });
    }
  }
  return info;
}

export function objectTypes(
  repoRoot: string,
  oids: readonly string[],
  git: string
): Map<string, string> {
  return new Map(
    [...objectInfo(repoRoot, oids, git)].map(([oid, info]) => [oid, info.type])
  );
}

export interface BoundedBlobRead {
  blobs: Map<string, Buffer>;
  oversized: Map<string, number>;
}

export async function readVerifiedBlobsBounded(
  repoRoot: string,
  oids: readonly string[],
  git: string,
  keepAtMost: number,
  discardAtMost: number
): Promise<BoundedBlobRead> {
  const unique = [...new Set(oids)];
  const blobs = new Map<string, Buffer>();
  const oversized = new Map<string, number>();
  if (unique.length === 0) return { blobs, oversized };
  const algorithm = hashAlgorithmForOid(unique[0]);
  if (algorithm === null || unique.some((oid) => hashAlgorithmForOid(oid) !== algorithm)) {
    throw objectStoreMismatch('a blob id is neither a consistent sha1 nor sha256 id');
  }

  const child = spawn(git, ['-c', 'core.quotePath=false', 'cat-file', '--batch'], {
    cwd: repoRoot,
    env: cleanNoRepoControlsGitEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 16_384) stderr += chunk.toString('utf8');
  });
  const exited = new Promise<{ code: number | null; error: Error | null }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code, error: null }));
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(`${unique.join('\n')}\n`);

  let index = 0;
  let header = Buffer.alloc(0);
  let remaining = -1;
  let terminator = false;
  let hash: ReturnType<typeof createHash> | null = null;
  let kept: Buffer[] = [];
  let currentSize = 0;
  let discarded = 0;

  const finish = (): void => {
    const oid = unique[index];
    if (hash === null || hash.digest('hex') !== oid) {
      throw objectStoreMismatch(`blob ${oid} does not hash to its own id`);
    }
    if (currentSize <= keepAtMost) blobs.set(oid, Buffer.concat(kept, currentSize));
    else oversized.set(oid, currentSize);
    index += 1;
    remaining = -1;
    terminator = false;
    hash = null;
    kept = [];
    currentSize = 0;
  };

  try {
    for await (const value of child.stdout) {
      const chunk = value as Buffer;
      let offset = 0;
      while (offset < chunk.length) {
        if (remaining === -1) {
          const newline = chunk.indexOf(0x0a, offset);
          if (newline === -1) {
            header = Buffer.concat([header, chunk.subarray(offset)]);
            if (header.length > 1024) throw objectStoreMismatch('git returned an overlong object header');
            break;
          }
          header = Buffer.concat([header, chunk.subarray(offset, newline)]);
          const fields = header.toString('utf8').split(' ');
          const oid = unique[index];
          if (fields.length !== 3 || fields[0] !== oid || fields[1] !== 'blob') {
            throw objectStoreMismatch(`git returned no usable blob for ${oid}`);
          }
          const size = Number.parseInt(fields[2], 10);
          if (!Number.isSafeInteger(size) || size < 0) {
            throw objectStoreMismatch(`git returned an invalid blob size for ${oid}`);
          }
          currentSize = size;
          if (size > keepAtMost) {
            discarded += size;
            if (discarded > discardAtMost) {
              throw new ObjectStoreMismatch(
                `dep-guard: committed dependency inputs exceed the ${discardAtMost} byte oversized-blob ` +
                  'verification budget. Nothing was scanned.'
              );
            }
          }
          hash = createHash(algorithm).update(`blob ${size}\0`);
          remaining = size;
          terminator = size === 0;
          header = Buffer.alloc(0);
          offset = newline + 1;
          continue;
        }
        if (remaining > 0) {
          const length = Math.min(remaining, chunk.length - offset);
          const part = chunk.subarray(offset, offset + length);
          hash?.update(part);
          if (currentSize <= keepAtMost) kept.push(part);
          remaining -= length;
          offset += length;
          if (remaining === 0) terminator = true;
          continue;
        }
        if (terminator) {
          if (chunk[offset] !== 0x0a) throw objectStoreMismatch(`blob ${unique[index]} has no terminator`);
          offset += 1;
          finish();
        }
      }
    }
  } catch (error) {
    child.kill();
    await exited;
    throw error;
  }
  const status = await exited;
  if (status.error !== null || status.code !== 0) {
    throw new ObjectStoreMismatch(
      `dep-guard: could not read committed blobs with git cat-file --batch: ${
        stderr.trim() || String(status.error ?? `git exited with status ${String(status.code)}`)
      }. Nothing was scanned.`
    );
  }
  if (index !== unique.length || remaining !== -1 || header.length !== 0) {
    throw objectStoreMismatch(`git answered ${index} complete blobs for ${unique.length} requests`);
  }
  return { blobs, oversized };
}
