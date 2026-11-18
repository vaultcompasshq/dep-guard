import { spawnSync } from 'node:child_process';
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

export function objectTypes(
  repoRoot: string,
  oids: readonly string[],
  git: string
): Map<string, string> {
  const unique = [...new Set(oids)];
  const types = new Map<string, string>();
  if (unique.length === 0) return types;
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
    types.set(fields[0], fields[1]);
  }
  return types;
}
