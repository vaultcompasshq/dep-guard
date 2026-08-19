import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BloomFilter } from './bloom.js';
import { DepGuardError } from './types.js';

interface CorpusMeta {
  builtAt: string;
  nameCount: number;
  fpRate: number;
  // Both optional: a corpus built before these fields existed is a local
  // development artifact (nothing has ever been published), and the
  // release pipeline independently requires both to be present and correct
  // in any corpus that actually ships. See assertMetaShape below for the
  // tolerance rule this reflects.
  formatVersion?: number;
  walkComplete?: boolean;
}

export interface Corpus {
  hasName(name: string): boolean;
  topRank(name: string): number | null; // 1-based rank in top list, null if absent
  aliasTargets(name: string): string[]; // known-confusion targets for this name
  // The popularity list in rank order. Exposed because the typosquat
  // check's distance scan has to compare a candidate name against every
  // popular name; generating the distance-2 neighbourhood of a name and
  // probing topRank instead would mean millions of probes per dependency.
  topNames: readonly string[];
  builtAt: string; // ISO date from meta.json
}

// Missing/unreadable files mean the corpus was never installed correctly;
// malformed contents mean it was installed but damaged. Callers need to
// tell those apart (e.g. "reinstall" vs "the file is corrupt"), so they get
// distinct DepGuardError codes. Missing and unreadable are themselves
// told apart below: a file that is present but denied by permissions
// (EACCES) is not fixed by reinstalling the corpus, and telling a caller
// "missing" sends them to fix the wrong thing.
function readRequiredFile(filePath: string): Buffer {
  try {
    return readFileSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DepGuardError(`corpus file missing: ${filePath}`, 'corpus-missing');
    }
    const reason = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new DepGuardError(
      `corpus file could not be read: ${filePath} (${reason})`,
      'corpus-unreadable'
    );
  }
}

function parseJson(filePath: string, buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new DepGuardError(`corpus file is not valid JSON: ${filePath}`, 'corpus-corrupt');
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertTopShape(filePath: string, value: unknown): asserts value is string[] {
  if (!isStringArray(value)) {
    throw new DepGuardError(
      `corpus top list is not an array of strings: ${filePath}`,
      'corpus-corrupt'
    );
  }
}

function assertAliasesShape(
  filePath: string,
  value: unknown
): asserts value is Record<string, string[]> {
  if (!isPlainObject(value)) {
    throw new DepGuardError(`corpus aliases is not an object: ${filePath}`, 'corpus-corrupt');
  }
  for (const key of Object.keys(value)) {
    if (!isStringArray(value[key])) {
      throw new DepGuardError(
        `corpus alias entry "${key}" is not an array of strings: ${filePath}`,
        'corpus-corrupt'
      );
    }
  }
}

function assertMetaShape(filePath: string, value: unknown): asserts value is CorpusMeta {
  if (!isPlainObject(value) || typeof value.builtAt !== 'string') {
    throw new DepGuardError(
      `corpus meta is not an object with a string builtAt: ${filePath}`,
      'corpus-corrupt'
    );
  }

  // formatVersion and walkComplete are both ABSENT-tolerant: a corpus built
  // before these fields existed is a local development artifact (nothing
  // has ever been published), and the release pipeline independently
  // requires both fields to be present and correct in any corpus that
  // actually ships. So tolerating their absence here costs nothing, and it
  // keeps the committed fixture corpus and the rest of the test suite --
  // which construct minimal metas without either field -- working. Each
  // check below only refuses a value that is present and explicitly wrong.

  if ('formatVersion' in value && value.formatVersion !== 1) {
    throw new DepGuardError(
      `corpus meta.formatVersion is ${JSON.stringify(value.formatVersion)}, which this ` +
        `dep-guard does not understand (it understands format version 1): ${filePath}. ` +
        'Upgrade dep-guard, or rebuild the corpus in a format version this dep-guard supports.',
      'corpus-corrupt'
    );
  }

  if ('walkComplete' in value && value.walkComplete === false) {
    throw new DepGuardError(
      `corpus meta.walkComplete is false: ${filePath}. This corpus was built from a walk ` +
        'that was stopped early, so it would report every name it never reached as unknown. ' +
        'It must not be used for a real scan -- rebuild the corpus without --max-names.',
      'corpus-corrupt'
    );
  }
}

export function loadCorpus(dir: string): Corpus {
  const bloomPath = path.join(dir, 'names.bloom');
  const topPath = path.join(dir, 'top.json');
  const aliasesPath = path.join(dir, 'aliases.json');
  const metaPath = path.join(dir, 'meta.json');

  // names.bloom is the one corpus artifact whose size scales with the
  // corpus itself -- megabytes for a real 10k+ name list, versus a few
  // kilobytes for top.json/aliases.json/meta.json combined -- so it is
  // the only one loaded lazily (spec's lazy-corpus-load requirement).
  // Reading and deserializing it eagerly here cost measurable time on
  // every scan, including ones that touch no manifest and so never call
  // hasName() at all. The other three files stay eager: every one of
  // their fields is needed immediately regardless of what a scan finds
  // (builtAt alone always reaches run.corpusBuiltAt), and they are cheap.
  const topBuf = readRequiredFile(topPath);
  const aliasesBuf = readRequiredFile(aliasesPath);
  const metaBuf = readRequiredFile(metaPath);

  const topValue = parseJson(topPath, topBuf);
  assertTopShape(topPath, topValue);
  const top = topValue;

  const aliasesValue = parseJson(aliasesPath, aliasesBuf);
  assertAliasesShape(aliasesPath, aliasesValue);
  const aliases = aliasesValue;

  const metaValue = parseJson(metaPath, metaBuf);
  assertMetaShape(metaPath, metaValue);
  const meta = metaValue;

  const rankByName = new Map<string, number>();
  top.forEach((name, index) => {
    rankByName.set(name, index + 1);
  });

  // Loaded and deserialized only the first time hasName() is actually
  // called, and cached after that -- a scan that adds or retargets no
  // dependency at all never calls hasName() and so never pays for this.
  let bloom: BloomFilter | null = null;
  function loadBloom(): BloomFilter {
    if (bloom !== null) {
      return bloom;
    }
    const bloomBuf = readRequiredFile(bloomPath);
    // Buffer instances from readFileSync can alias Node's shared memory
    // pool. BloomFilter.deserialize already copies its input (see
    // bloom.ts), so this copy is defence in depth rather than a
    // workaround for current behavior -- it keeps this call site correct
    // even if that changes.
    const bloomBytes = new Uint8Array(
      bloomBuf.buffer.slice(bloomBuf.byteOffset, bloomBuf.byteOffset + bloomBuf.byteLength)
    );
    try {
      bloom = BloomFilter.deserialize(bloomBytes);
    } catch (err) {
      if (err instanceof DepGuardError) {
        throw err;
      }
      throw new DepGuardError(`corpus bloom filter is corrupt: ${bloomPath}`, 'corpus-corrupt');
    }
    return bloom;
  }

  return {
    hasName(name: string): boolean {
      return loadBloom().has(name);
    },
    topRank(name: string): number | null {
      return rankByName.get(name) ?? null;
    },
    aliasTargets(name: string): string[] {
      // Plain `aliases[name]` would return inherited Object.prototype
      // members (e.g. name === 'constructor' or '__proto__', both legal
      // npm package names) instead of undefined. hasOwn keeps the lookup
      // scoped to the corpus's own data.
      return Object.hasOwn(aliases, name) ? aliases[name] : [];
    },
    // Frozen so a caller cannot reorder the ranks out from under everyone
    // else holding the same Corpus.
    topNames: Object.freeze(top.slice()),
    builtAt: meta.builtAt,
  };
}
