// A machine-global local cache for online-check lookups. Deliberately NOT
// a trust input the way config or the baseline are: a corrupt or unreadable
// cache file costs an extra network fetch at worst, never a false "safe",
// so it is silently discarded and rebuilt rather than failing closed the
// way config.ts and baseline.ts do for their own files.
//
// Global rather than repo-local, because a package's popularity is not a
// property of the repository asking about it -- checking whether "react"
// looks like a squat target should answer the same way from any repo on
// this machine.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface OnlineCache {
  get(key: string): unknown;
  set(key: string, value: unknown, ttlMs: number | null): void;
  save(): void;
}

interface StoredEntry {
  value: unknown;
  expiresAt: number | null; // epoch ms, null = never expires
}

function isStoredEntry(value: unknown): value is StoredEntry {
  return (
    value !== null &&
    typeof value === 'object' &&
    'value' in (value as Record<string, unknown>) &&
    'expiresAt' in (value as Record<string, unknown>)
  );
}

export function defaultCachePath(): string {
  const base = process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache');
  return path.join(base, 'dep-guard', 'online.json');
}

export function loadCache(cachePath: string, now: () => number = Date.now): OnlineCache {
  const entries = new Map<string, StoredEntry>();

  if (existsSync(cachePath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (isStoredEntry(value)) {
            entries.set(key, value);
          }
        }
      }
    } catch {
      // Corrupt or unreadable: treated as an empty cache, not an error.
      // See the module comment above.
    }
  }

  return {
    get(key: string): unknown {
      const entry = entries.get(key);
      if (entry === undefined) {
        return undefined;
      }
      if (entry.expiresAt !== null && entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: unknown, ttlMs: number | null): void {
      entries.set(key, { value, expiresAt: ttlMs === null ? null : now() + ttlMs });
    },
    save(): void {
      mkdirSync(path.dirname(cachePath), { recursive: true });
      const plain: Record<string, StoredEntry> = {};
      for (const [key, entry] of entries) {
        plain[key] = entry;
      }
      writeFileSync(cachePath, JSON.stringify(plain));
    },
  };
}
