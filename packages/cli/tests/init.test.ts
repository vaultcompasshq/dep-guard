import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

  test('installs where git actually runs it: the hook fires on a real commit', () => {
    // The reviewer's proof, reproduced. With core.hooksPath set the way
    // husky 9 sets it, init reported success while writing to a path git
    // never consults, so the gate silently did not exist. No amount of
    // path assertion is as convincing as making git run the thing, so
    // this drives a real commit and reads back what executed.
    const dir = initRepo();
    execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });

    const result = install(dir);
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(dir, '.husky', '_', 'pre-commit'))).toBe(true);
    expect(existsSync(path.join(dir, '.git', '.husky', '_', 'pre-commit'))).toBe(false);

    // A stub dep-guard that exits non-zero. If the installed hook is the
    // one git runs, the commit is refused; if init wrote somewhere git
    // does not look, the commit succeeds and the gate was never there.
    const binDir = makeStubBin(1);
    writeFileSync(path.join(dir, 'a.txt'), 'hello');
    execFileSync('git', ['add', '-A'], { cwd: dir });

    let committed = true;
    try {
      execFileSync('git', ['commit', '-q', '-m', 'should be blocked'], {
        cwd: dir,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      committed = false;
    }

    expect(committed).toBe(false);
  });

  test('refuses an existing husky-style hook at a relative core.hooksPath', () => {
    // The other half of resolving to the wrong place: a foreign hook that
    // really is where git looks was invisible, so init would have happily
    // reported success beside somebody else's working setup.
    const dir = initRepo();
    execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: dir });
    const foreign = '#!/bin/sh\n. "$(dirname "$0")/husky.sh"\necho existing husky hook\n';
    mkdirSync(path.join(dir, '.husky', '_'), { recursive: true });
    writeFileSync(path.join(dir, '.husky', '_', 'pre-commit'), foreign);

    const result = install(dir);

    expect(result.ok).toBe(false);
    expect(result.conflicts.map((c) => c.reason)).toContain('foreign-hook');
    expect(readFileSync(path.join(dir, '.husky', '_', 'pre-commit'), 'utf8')).toBe(foreign);
  });

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
