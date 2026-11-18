/**
 * Resolve `git` to an absolute path for `scan --no-repo-controls`.
 *
 * Every other mode spawns a bare `git`. On Windows libuv looks in the child's
 * working directory before PATH for a bare name, and this mode runs git with
 * the untrusted repository as its working directory, so a tracked `git.exe` at
 * the root would run as dep-guard's git. Here PATH is walked once, by this
 * code: empty and relative entries are skipped (they mean "here"), on Windows
 * only `.exe` and `.com` from PATHEXT count (a `.cmd` or `.bat` is a script),
 * and the first regular file found is returned as an absolute path that is
 * spawned everywhere in the run. The caller refuses a binary that sits inside
 * the repository or the working directory.
 */

import fs from 'node:fs';
import path from 'node:path';

/** What the resolver needs from the world; injectable so every platform is tested on any host. */
export interface GitResolveEnv {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  isFile: (candidate: string) => boolean;
}

export class GitBinaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitBinaryError';
  }
}

const realWorld = (): GitResolveEnv => ({
  env: process.env,
  platform: process.platform,
  isFile: (candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  },
});

/** The absolute path of the first `git` on PATH, or throws {@link GitBinaryError}. */
export function resolveGitBinary(world: GitResolveEnv = realWorld()): string {
  const win = world.platform === 'win32';
  const impl = win ? path.win32 : path.posix;
  const pathKey = win ? (Object.keys(world.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH') : 'PATH';
  const raw = world.env[pathKey] ?? '';
  const names = win
    ? (world.env.PATHEXT ?? world.env.Pathext ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((extension) => extension.trim().toLowerCase())
        .filter((extension) => extension === '.exe' || extension === '.com')
    : [''];
  if (win && names.length === 0) names.push('.exe', '.com');
  for (const entry of raw.split(win ? ';' : ':')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (dir === '' || !impl.isAbsolute(dir)) continue;
    for (const extension of names) {
      const candidate = impl.join(dir, `git${extension}`);
      if (world.isFile(candidate)) return candidate;
    }
  }
  throw new GitBinaryError(
    'dep-guard: --no-repo-controls could not find git on PATH (absolute, non-empty entries only). ' +
      'It runs git by absolute path and never from the directory being assessed. Nothing was scanned.'
  );
}

/** True when `file` is `dir` or lies inside it (lexically, on the given path implementation). */
export function isInsideDir(file: string, dir: string, impl: typeof path = path): boolean {
  const rel = impl.relative(impl.resolve(dir), impl.resolve(file));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${impl.sep}`) && !impl.isAbsolute(rel));
}
