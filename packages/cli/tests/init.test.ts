import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  HOOK_MANAGERS,
  MANAGED_HOOK_MARKER,
  hookArtifactFor,
  planInit,
  applyInit,
} from '../src/init.js';
import type { HookManager } from '../src/init.js';

// Two kinds of test live here and they prove different things.
//
// The planning and writing tests drive planInit/applyInit directly, in
// real temp git repositories, and assert what lands on disk.
//
// The shell tests at the bottom actually RUN the generated hook under
// /bin/sh against a stub binary. They are the ones that matter most: the
// two bugs this hook is designed against (a missing binary waved through,
// and dep-guard's exit code masked by the hook's own) are both invisible
// to any amount of string-matching on the hook's text, and both were
// shipped by a sibling tool in this family precisely because its tests
// only ever read the script rather than executing it.

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'depguard-init-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function nativeHookPath(dir: string): string {
  return path.join(dir, '.git', 'hooks', 'pre-commit');
}

function install(dir: string, manager: HookManager = 'native') {
  return applyInit(planInit({ cwd: dir, manager }), { cwd: dir, manager });
}

// Builds husky 9's generated hooks directory by hand: core.hooksPath
// points git at .husky/_, which husky's own "prepare" script populates
// with a two-line dispatcher per hook (source "./h") plus the "h" shim
// that actually execs the TRACKED hook of the same name at the
// repository root, and a .gitignore of "*" so none of it is ever
// committed. node_modules does not carry husky in this repository, so
// "h" is written here as a functional stand-in rather than copied from
// the real package: it walks up from its own location to the repo root
// and execs the tracked hook, exactly what husky 9's own "h" does.
function writeHuskyGeneratedDir(dir: string): void {
  const genDir = path.join(dir, '.husky', '_');
  mkdirSync(genDir, { recursive: true });

  writeFileSync(path.join(genDir, '.gitignore'), '*\n');

  const dispatcher = '#!/usr/bin/env sh\n. "$(dirname -- "$0")/h"\n';
  writeFileSync(path.join(genDir, 'pre-commit'), dispatcher);
  chmodSync(path.join(genDir, 'pre-commit'), 0o755);

  const h = [
    '#!/usr/bin/env sh',
    'hookName=$(basename -- "$0")',
    'scriptDir=$(dirname -- "$0")',
    'huskyDir=$(dirname -- "$scriptDir")',
    'rootDir=$(dirname -- "$huskyDir")',
    'exec "$rootDir/.husky/$hookName" "$@"',
    '',
  ].join('\n');
  writeFileSync(path.join(genDir, 'h'), h);
  chmodSync(path.join(genDir, 'h'), 0o755);
}

function huskyRepo(): string {
  const dir = initRepo();
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: dir });
  writeHuskyGeneratedDir(dir);
  return dir;
}

function trackedHuskyHookPath(dir: string): string {
  // git resolves symlinks in "rev-parse --show-toplevel" (on macOS,
  // /var/folders/... vs /private/var/folders/...), and hookPath is built
  // from that resolved root, so this compares like for like.
  return path.join(realpathSync(dir), '.husky', 'pre-commit');
}

// A refused commit (non-zero git exit) is not by itself evidence that
// dep-guard blocked it: a broken dispatcher chain, a non-executable
// hook, or any other crash before dep-guard ever runs also refuses the
// commit, and scores as a "successful block" if only the exit status is
// checked. stubRan distinguishes the two by looking for the stub
// binary's own announce line (see makeStubBin) in whatever the commit
// printed, so a caller can tell "dep-guard blocked this" from "something
// upstream of dep-guard broke and the commit failed anyway".
function runCommit(dir: string, binDir: string): { committed: boolean; stubRan: boolean } {
  writeFileSync(path.join(dir, 'a.txt'), 'hello');
  execFileSync('git', ['add', '-A'], { cwd: dir });

  let committed = true;
  let output = '';
  try {
    output = execFileSync('git', ['commit', '-q', '-m', 'should be blocked'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    committed = false;
    const failure = err as { stdout?: string; stderr?: string };
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
  }

  return { committed, stubRan: output.includes('stub dep-guard ran') };
}

describe('dep-guard init: the native hook', () => {
  test('writes an executable pre-commit hook into .git/hooks', () => {
    const dir = initRepo();
    const result = install(dir);

    expect(result.ok).toBe(true);
    expect(existsSync(nativeHookPath(dir))).toBe(true);
    const content = readFileSync(nativeHookPath(dir), 'utf8');
    expect(content).toContain(MANAGED_HOOK_MARKER);
    expect(content).toContain('dep-guard scan --staged');
    // Git will not run a hook it cannot execute, and a hook that silently
    // never runs is the same as no gate at all.
    expect(statSync(nativeHookPath(dir)).mode & 0o111).not.toBe(0);
  });

  test('is idempotent: a second run changes nothing and duplicates nothing', () => {
    const dir = initRepo();
    install(dir);
    const first = readFileSync(nativeHookPath(dir), 'utf8');

    const second = install(dir);

    expect(second.ok).toBe(true);
    expect(second.alreadyInstalled).toBe(true);
    const after = readFileSync(nativeHookPath(dir), 'utf8');
    expect(after).toBe(first);
    // The specific failure an append-based installer produces: the body
    // present twice in one file.
    expect(after.split('dep-guard scan --staged')).toHaveLength(2);
  });

  test('refuses to overwrite a hook it did not write, and leaves it byte for byte', () => {
    const dir = initRepo();
    const foreign = '#!/bin/sh\necho "somebody else was here"\nexit 0\n';
    mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(nativeHookPath(dir), foreign);

    const result = install(dir);

    expect(result.ok).toBe(false);
    expect(result.conflicts.map((c) => c.reason)).toContain('foreign-hook');
    expect(readFileSync(nativeHookPath(dir), 'utf8')).toBe(foreign);
  });

  test('an empty existing hook file is not treated as foreign', () => {
    // git ships .sample hooks, and some tooling leaves a zero-byte
    // pre-commit behind. Refusing on one of those would make init fail for
    // a repository with nothing to lose.
    const dir = initRepo();
    mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(nativeHookPath(dir), '   \n');

    const result = install(dir);

    expect(result.ok).toBe(true);
    expect(readFileSync(nativeHookPath(dir), 'utf8')).toContain(MANAGED_HOOK_MARKER);
  });

  test('refuses outside a git repository rather than writing somewhere useless', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'depguard-init-nogit-'));

    const result = install(dir);

    expect(result.ok).toBe(false);
    expect(result.conflicts.map((c) => c.reason)).toContain('not-a-git-repository');
  });

  test('honours core.hooksPath rather than assuming .git/hooks', () => {
    // A repository that has moved its hooks directory is exactly the
    // repository where writing to .git/hooks produces a file git never
    // reads, so the gate is installed, reported as installed, and never
    // runs.
    //
    // git resolves a RELATIVE core.hooksPath against the working-tree
    // root, not against the .git directory. This test asserted the .git
    // location until a review caught it, which meant the test and the
    // code were wrong together and agreed with each other.
    const dir = initRepo();
    execFileSync('git', ['config', 'core.hooksPath', 'my-hooks'], { cwd: dir });

    const result = install(dir);

    expect(result.ok).toBe(true);
    expect(existsSync(path.join(dir, 'my-hooks', 'pre-commit'))).toBe(true);
    expect(existsSync(path.join(dir, '.git', 'my-hooks', 'pre-commit'))).toBe(false);
    expect(existsSync(nativeHookPath(dir))).toBe(false);
  });

  test('an absolute core.hooksPath is used as given', () => {
    const dir = initRepo();
    const hooksDir = mkdtempSync(path.join(tmpdir(), 'depguard-abs-hooks-'));
    execFileSync('git', ['config', 'core.hooksPath', hooksDir], { cwd: dir });

    const result = install(dir);

    expect(result.ok).toBe(true);
    expect(existsSync(path.join(hooksDir, 'pre-commit'))).toBe(true);
  });

  // core.hooksPath=.husky/_ is exactly the husky 9 shape, and it now gets
  // its own describe block below rather than being covered here: .husky/_
  // is a generated, gitignored directory husky's own "prepare" script
  // rewrites on every install, so a hook written there (which is what
  // this suite used to assert) works until the next install and then
  // silently stops existing. See "dep-guard init: husky 9's generated
  // hooks directory".

  test('works when run from a subdirectory of the repository', () => {
    // N3. A user running "dep-guard init" from packages/app would
    // otherwise be told this is not a git repository, because only the
    // repository root has a .git entry.
    const dir = initRepo();
    const sub = path.join(dir, 'packages', 'app');
    mkdirSync(sub, { recursive: true });

    const result = install(sub);

    expect(result.ok).toBe(true);
    expect(existsSync(nativeHookPath(dir))).toBe(true);
  });
});

describe('dep-guard init: --dry-run', () => {
  test('reports what it would write and writes nothing at all', () => {
    const dir = initRepo();

    const plan = planInit({ cwd: dir, manager: 'native', dryRun: true });
    const result = applyInit(plan, { cwd: dir, manager: 'native', dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.actions.some((a) => a.kind === 'write')).toBe(true);
    expect(result.actions[0].path).toContain('pre-commit');
    expect(existsSync(nativeHookPath(dir))).toBe(false);
  });

  test('a dry run over an already-installed hook reports nothing to do', () => {
    const dir = initRepo();
    install(dir);

    const plan = planInit({ cwd: dir, manager: 'native', dryRun: true });

    expect(plan.alreadyInstalled).toBe(true);
    expect(plan.actions.some((a) => a.kind === 'write')).toBe(false);
  });

  test('a dry run over a foreign hook reports the conflict without touching it', () => {
    const dir = initRepo();
    const foreign = '#!/bin/sh\necho other\n';
    mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(nativeHookPath(dir), foreign);

    const plan = planInit({ cwd: dir, manager: 'native', dryRun: true });

    expect(plan.ok).toBe(false);
    expect(readFileSync(nativeHookPath(dir), 'utf8')).toBe(foreign);
  });
});

describe('dep-guard init: hook managers', () => {
  test('every declared manager has an artifact and installs into a fresh repo', () => {
    // Derived from the manager list rather than one test per manager, so a
    // manager added to HOOK_MANAGERS without an install path is a failure
    // here rather than a silent gap.
    for (const manager of HOOK_MANAGERS) {
      const dir = initRepo();
      const result = install(dir, manager);
      expect([manager, result.ok]).toEqual([manager, true]);
      const artifact = hookArtifactFor(dir, manager);
      expect([manager, existsSync(artifact)]).toEqual([manager, true]);
      expect(readFileSync(artifact, 'utf8')).toContain('dep-guard scan --staged');
    }
  });

  test('every manager is idempotent', () => {
    for (const manager of HOOK_MANAGERS) {
      const dir = initRepo();
      install(dir, manager);
      const first = readFileSync(hookArtifactFor(dir, manager), 'utf8');
      const second = install(dir, manager);
      expect([manager, second.ok]).toEqual([manager, true]);
      expect([manager, second.alreadyInstalled]).toEqual([manager, true]);
      expect([manager, readFileSync(hookArtifactFor(dir, manager), 'utf8')]).toEqual([
        manager,
        first,
      ]);
    }
  });

  test('every manager refuses a foreign file rather than overwriting it', () => {
    for (const manager of HOOK_MANAGERS) {
      const dir = initRepo();
      const artifact = hookArtifactFor(dir, manager);
      mkdirSync(path.dirname(artifact), { recursive: true });
      const foreign = '# somebody else owns this file\n';
      writeFileSync(artifact, foreign);

      const result = install(dir, manager);

      expect([manager, result.ok]).toEqual([manager, false]);
      expect([manager, readFileSync(artifact, 'utf8')]).toEqual([manager, foreign]);
    }
  });

  test('husky and native both produce a runnable shell hook', () => {
    for (const manager of ['native', 'husky'] as const) {
      const dir = initRepo();
      install(dir, manager);
      const content = readFileSync(hookArtifactFor(dir, manager), 'utf8');
      expect([manager, content.startsWith('#!')]).toEqual([manager, true]);
    }
  });
});

describe("dep-guard init: husky 9's generated hooks directory", () => {
  // husky 9 sets core.hooksPath to .husky/_, a directory husky's own
  // "prepare" script generates and .gitignores, rewriting it on every
  // install. The file git actually runs there, .husky/_/pre-commit, is a
  // two-line dispatcher that sources "./h", and "h" execs the TRACKED
  // .husky/<hookname> at the repository root. A bare "dep-guard init"
  // (manager: native, the default) must resolve to that tracked file, not
  // to anything under .husky/_: a hook written into .husky/_ is gone the
  // next time husky's prepare script runs.

  test('a bare init installs into the tracked hook, not the generated directory', () => {
    const dir = huskyRepo();
    const before = {
      dispatcher: readFileSync(path.join(dir, '.husky', '_', 'pre-commit'), 'utf8'),
      h: readFileSync(path.join(dir, '.husky', '_', 'h'), 'utf8'),
      gitignore: readFileSync(path.join(dir, '.husky', '_', '.gitignore'), 'utf8'),
      entries: readdirSync(path.join(dir, '.husky', '_')).sort(),
    };

    const result = install(dir);

    expect(result.ok).toBe(true);
    expect(result.hookPath).toBe(trackedHuskyHookPath(dir));
    expect(existsSync(trackedHuskyHookPath(dir))).toBe(true);
    expect(readFileSync(trackedHuskyHookPath(dir), 'utf8')).toContain(MANAGED_HOOK_MARKER);

    // Nothing under the generated directory moved.
    expect(readFileSync(path.join(dir, '.husky', '_', 'pre-commit'), 'utf8')).toBe(
      before.dispatcher
    );
    expect(readFileSync(path.join(dir, '.husky', '_', 'h'), 'utf8')).toBe(before.h);
    expect(readFileSync(path.join(dir, '.husky', '_', '.gitignore'), 'utf8')).toBe(
      before.gitignore
    );
    expect(readdirSync(path.join(dir, '.husky', '_')).sort()).toEqual(before.entries);
  });

  test('hookArtifactFor agrees: it names the tracked hook for the native manager', () => {
    const dir = huskyRepo();
    expect(hookArtifactFor(dir, 'native')).toBe(trackedHuskyHookPath(dir));
  });

  test('the installed hook survives husky regenerating .husky/_ on the next install, and still fires', () => {
    const dir = huskyRepo();
    const result = install(dir);
    expect(result.ok).toBe(true);
    expect(existsSync(trackedHuskyHookPath(dir))).toBe(true);

    // Simulate husky's own "prepare" script running again on the next
    // "pnpm install": it wipes .husky/_ and regenerates it from scratch.
    // This must not touch the tracked hook, which lives outside .husky/_.
    rmSync(path.join(dir, '.husky', '_'), { recursive: true, force: true });
    writeHuskyGeneratedDir(dir);

    expect(existsSync(trackedHuskyHookPath(dir))).toBe(true);
    expect(readFileSync(trackedHuskyHookPath(dir), 'utf8')).toContain(MANAGED_HOOK_MARKER);

    // A stub dep-guard that exits non-zero. If the tracked hook is still
    // the one git ends up running (dispatched to via .husky/_/pre-commit
    // -> h -> .husky/pre-commit), the commit is refused, and the stub
    // actually ran -- proving the refusal came from dep-guard, not from
    // the dispatcher chain breaking some other way.
    const commitResult = runCommit(dir, makeStubBin(1));
    expect(commitResult.stubRan).toBe(true);
    expect(commitResult.committed).toBe(false);
  });

  test('a refused commit only counts as dep-guard blocking it when the stub actually ran', () => {
    // No install() call here: the tracked hook does not exist, so
    // husky's own "h" shim fails to exec it. Git still refuses the
    // commit, but that refusal has nothing to do with dep-guard -- the
    // stub never ran -- and a harness that only checks "was the commit
    // refused" cannot tell the difference from a real block.
    const dir = huskyRepo();

    const result = runCommit(dir, makeStubBin(0));

    expect(result.stubRan).toBe(false);
  });

  test('an already-installed tracked hook is reported as already installed', () => {
    const dir = huskyRepo();
    mkdirSync(path.dirname(trackedHuskyHookPath(dir)), { recursive: true });
    writeFileSync(
      trackedHuskyHookPath(dir),
      `#!/bin/sh\n# ${MANAGED_HOOK_MARKER}\ndep-guard scan --staged\n`
    );

    const result = install(dir);

    expect(result.ok).toBe(true);
    expect(result.alreadyInstalled).toBe(true);
    expect(result.hookPath).toBe(trackedHuskyHookPath(dir));
  });

  test('a foreign tracked hook is refused by its tracked path, not .husky/_', () => {
    const dir = huskyRepo();
    const foreign = '#!/bin/sh\necho existing husky hook\n';
    mkdirSync(path.dirname(trackedHuskyHookPath(dir)), { recursive: true });
    writeFileSync(trackedHuskyHookPath(dir), foreign);

    const result = install(dir);

    expect(result.ok).toBe(false);
    expect(result.conflicts.map((c) => c.reason)).toContain('foreign-hook');
    expect(result.conflicts.map((c) => c.path)).toEqual(['.husky/pre-commit']);
    expect(readFileSync(trackedHuskyHookPath(dir), 'utf8')).toBe(foreign);
  });

  test('--dry-run reports the tracked path and writes nothing', () => {
    const dir = huskyRepo();

    const plan = planInit({ cwd: dir, manager: 'native', dryRun: true });
    const result = applyInit(plan, { cwd: dir, manager: 'native', dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.hookPath).toBe(trackedHuskyHookPath(dir));
    expect(result.actions[0]?.path).toBe('.husky/pre-commit');
    expect(existsSync(trackedHuskyHookPath(dir))).toBe(false);
  });
});

describe('dep-guard init: husky-shape detection is anchored to the directory, not to file names', () => {
  // The redirect must fire on the resolved hooks directory's own shape
  // (basename "_" under a directory named ".husky") and nothing else.
  // Two real false positives motivate this: a helper file that happens
  // to be named "h" in an unrelated hooks directory, and a default
  // .git/hooks/pre-commit that happens to be shaped like husky's
  // two-line dispatcher. Either one redirecting on its own means the
  // hook actually sitting where git reads it is never foreign-checked,
  // and a real commit can go through ungated.

  test('a core.hooksPath directory that merely contains a file named "h" is not treated as husky', () => {
    const dir = initRepo();
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: dir });
    mkdirSync(path.join(dir, '.githooks'), { recursive: true });
    // An unrelated helper file that happens to share husky's shim's name.
    writeFileSync(path.join(dir, '.githooks', 'h'), '#!/bin/sh\necho unrelated helper\n');

    const result = install(dir);

    expect(result.ok).toBe(true);
    expect(result.huskyManaged).toBe(false);
    expect(result.hookPath).toBe(path.join(realpathSync(dir), '.githooks', 'pre-commit'));
    expect(existsSync(path.join(dir, '.githooks', 'pre-commit'))).toBe(true);
    expect(existsSync(path.join(dir, '.husky'))).toBe(false);
  });

  test('a default hooks directory whose pre-commit happens to look like a husky dispatcher is still foreign-checked at its real location', () => {
    // Resolved up front (macOS symlinks /var into /private/var) so the
    // relative conflict path this asserts on isn't thrown off by cwd and
    // git's own resolved root disagreeing about spelling the same
    // directory -- a cosmetic quirk of this test's tmpdir, unrelated to
    // husky detection.
    const dir = realpathSync(initRepo());
    const dispatcherShaped = '#!/bin/sh\n. "$(dirname -- "$0")/h"\n';
    mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(nativeHookPath(dir), dispatcherShaped);

    const result = install(dir);

    expect(result.ok).toBe(false);
    expect(result.huskyManaged).toBe(false);
    expect(result.conflicts.map((c) => c.reason)).toContain('foreign-hook');
    expect(result.conflicts.map((c) => c.path)).toEqual(['.git/hooks/pre-commit']);
    expect(existsSync(path.join(dir, '.husky'))).toBe(false);
    expect(readFileSync(nativeHookPath(dir), 'utf8')).toBe(dispatcherShaped);
  });

  test('a husky 8 layout resolves .husky/pre-commit via the native path, not the redirect', () => {
    const dir = initRepo();
    execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: dir });
    mkdirSync(path.join(dir, '.husky', '_'), { recursive: true });
    writeFileSync(path.join(dir, '.husky', '_', 'husky.sh'), '#!/bin/sh\n# husky 8 preamble\n');
    const husky8Hook = '#!/bin/sh\n. "$(dirname "$0")/_/husky.sh"\necho existing husky 8 hook\n';
    mkdirSync(path.dirname(path.join(dir, '.husky', 'pre-commit')), { recursive: true });
    writeFileSync(path.join(dir, '.husky', 'pre-commit'), husky8Hook);

    const result = install(dir);

    expect(result.huskyManaged).toBe(false);
    expect(result.hookPath).toBe(path.join(realpathSync(dir), '.husky', 'pre-commit'));
    // The file that is already there is foreign (not written by
    // dep-guard), so this still refuses rather than overwriting it --
    // that part of the behaviour is unchanged by any of this.
    expect(result.ok).toBe(false);
    expect(result.conflicts.map((c) => c.reason)).toContain('foreign-hook');
  });
});

// ---------------------------------------------------------------------------
// The generated hook, actually executed.
// ---------------------------------------------------------------------------

function makeStubBin(exitCode: number): string {
  const binDir = mkdtempSync(path.join(tmpdir(), 'depguard-stub-bin-'));
  const stub = path.join(binDir, 'dep-guard');
  writeFileSync(stub, `#!/bin/sh\necho "stub dep-guard ran: $*"\nexit ${exitCode}\n`);
  chmodSync(stub, 0o755);
  return binDir;
}

function runHook(
  hookPath: string,
  pathValue: string
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('/bin/sh', [hookPath], {
      encoding: 'utf8',
      env: { PATH: pathValue },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof failure.status === 'number' ? failure.status : -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

// husky's own "h" shim runs the tracked hook under "sh -e", not plain
// "sh": errexit is on for the whole invocation regardless of anything
// the hook's own text does or does not say. This runs the generated hook
// the same way, rather than through plain /bin/sh, because a capture
// pattern that only works without an externally imposed -e is exactly
// what a husky-managed repository has.
function runHookUnderErrexit(
  hookPath: string,
  pathValue: string
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('/bin/sh', ['-e', hookPath], {
      encoding: 'utf8',
      env: { PATH: pathValue },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: typeof failure.status === 'number' ? failure.status : -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe('the generated hook, run under /bin/sh', () => {
  test('fails closed when the dep-guard binary is missing', () => {
    const dir = initRepo();
    install(dir);

    // An empty PATH is the strongest form of "the binary is missing": not
    // a different version, not a broken install, simply not there.
    const run = runHook(nativeHookPath(dir), '');

    expect(run.status).not.toBe(0);
    const message = `${run.stdout}${run.stderr}`.trim();
    expect(message).toContain('dep-guard');
    expect(message.toLowerCase()).toContain('not found');
    // One line, so a pre-commit failure reads as a sentence rather than a
    // wall of text in whatever GUI client the user is committing from.
    expect(message.split('\n').filter((l) => l.trim().length > 0)).toHaveLength(1);
  });

  test('passes a clean scan through as exit 0', () => {
    const dir = initRepo();
    install(dir);

    const run = runHook(nativeHookPath(dir), makeStubBin(0));

    expect(run.status).toBe(0);
  });

  test('under sh -e, the shell husky itself invokes hooks with, the explanation still prints and the exit code still passes through', () => {
    // husky's own "h" shim runs the tracked hook with "sh -e", not plain
    // sh. A capture pattern that relies on nothing outside the hook ever
    // enabling errexit breaks exactly there: the shell aborts at the
    // failing "dep-guard scan" line before the status is ever captured,
    // silently keeping the right exit code (errexit propagates the
    // failing command's own status) while losing the explanatory line
    // entirely -- the one thing this hook exists to still print.
    const dir = initRepo();
    install(dir);

    const blocked = runHookUnderErrexit(nativeHookPath(dir), makeStubBin(1));
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('commit blocked');

    const notRun = runHookUnderErrexit(nativeHookPath(dir), makeStubBin(2));
    expect(notRun.status).toBe(2);
    expect(notRun.stderr).toContain('commit blocked');
  });

  test('passes exit 1 (blocking findings) through unchanged', () => {
    const dir = initRepo();
    install(dir);

    const run = runHook(nativeHookPath(dir), makeStubBin(1));

    expect(run.status).toBe(1);
  });

  test('passes exit 2 through unchanged rather than masking it as 1', () => {
    // This is the bug class the hook exists to avoid. dep-guard exits 2
    // when it could not run its checks at all -- a corrupt lockfile, a
    // missing corpus, a broken config -- and a hook that collapses that to
    // 1 tells the user "blocking findings" when the truth is "the gate did
    // not run". A hook written as `if dep-guard scan; then exit 0; fi;
    // exit 1` passes every other test in this file and fails this one.
    const dir = initRepo();
    install(dir);

    const run = runHook(nativeHookPath(dir), makeStubBin(2));

    expect(run.status).toBe(2);
  });

  test('runs the staged-only scan, not a whole-repository audit', () => {
    const dir = initRepo();
    install(dir);

    const run = runHook(nativeHookPath(dir), makeStubBin(0));

    expect(run.stdout).toContain('scan --staged');
  });

  // The two tests above assert that the real hook behaves correctly. These
  // two assert that those assertions can actually FAIL -- by running the
  // buggy shapes, as fixtures, through the exact same harness and watching
  // the same expectations reject them. Without this, a harness bug (a
  // swallowed status, a runHook that always reports 0) would make the
  // whole section pass vacuously and prove nothing at all.
  //
  // The buggy shapes live here, as test data. They are never written into
  // a repository and are not what init installs.
  const NAIVE_EXIT_CODE_HOOK = [
    '#!/bin/sh',
    'if dep-guard scan --staged; then',
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n');

  const WARN_ONLY_MISSING_BINARY_HOOK = [
    '#!/bin/sh',
    'if ! command -v dep-guard >/dev/null 2>&1; then',
    '  echo "dep-guard not installed, skipping" >&2',
    '  exit 0',
    'fi',
    'dep-guard scan --staged',
    '',
  ].join('\n');

  function writeFixtureHook(content: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'depguard-bad-hook-'));
    const hookPath = path.join(dir, 'pre-commit');
    writeFileSync(hookPath, content);
    chmodSync(hookPath, 0o755);
    return hookPath;
  }

  test('the exit-code assertion rejects a hook that masks exit 2 as exit 1', () => {
    const run = runHook(writeFixtureHook(NAIVE_EXIT_CODE_HOOK), makeStubBin(2));

    // The shape dep-guard must not ship: dep-guard said 2, the hook says 1.
    expect(run.status).toBe(1);
    expect(run.status).not.toBe(2);
  });

  test('the fail-closed assertion rejects a hook that waves a missing binary through', () => {
    const run = runHook(writeFixtureHook(WARN_ONLY_MISSING_BINARY_HOOK), '');

    // The shape dep-guard must not ship: no binary, no scan, commit allowed.
    expect(run.status).toBe(0);
  });
});
