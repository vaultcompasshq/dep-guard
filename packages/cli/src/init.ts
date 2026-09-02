// `dep-guard init`: installs the pre-commit hook.
//
// Every gate in this family installs itself, because a gate a user has to
// wire up by hand is a gate most users do not have. This one does exactly
// one thing -- write a pre-commit hook -- and deliberately does not
// scaffold a config file, a CI workflow, or editor rules alongside it: a
// scan with no config already behaves correctly (config.ts's defaults),
// and a generated file that only restates the defaults is a file someone
// has to maintain for no benefit.
//
// Two properties are the whole point of the generated hook, and both are
// bugs a sibling tool in this family shipped:
//
//  1. FAIL CLOSED. A missing dep-guard binary blocks the commit. The
//     tempting alternative -- warn and let the commit through, so a
//     teammate without the tool installed is not stuck -- means the gate
//     is silently absent exactly where it is most likely to be absent,
//     and a supply-chain gate that is off when the tool is missing is a
//     gate an attacker turns off by making the tool missing.
//
//  2. PRESERVE THE EXIT CODE. dep-guard exits 0 (clean), 1 (blocking
//     findings), or 2 (could not run the checks at all: a corrupt
//     lockfile, an unreadable config, a missing corpus). A hook written
//     the natural way -- `if dep-guard scan --staged; then exit 0; fi;
//     exit 1` -- collapses 2 into 1 and tells the user "blocking
//     findings" when the truth is "the gate did not run". Those are
//     different facts and the hook must not conflate them.
//
// tests/init.test.ts executes the generated hook against a stub binary
// for both of these, rather than string-matching the script, because
// neither bug is visible in the text.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export type HookManager = 'native' | 'husky' | 'lefthook' | 'precommit';

// The same four managers vault-guard's init supports. Exported as a list
// so tests can derive their coverage from it: a manager added here
// without an install path fails a test rather than going unnoticed.
export const HOOK_MANAGERS: readonly HookManager[] = ['native', 'husky', 'lefthook', 'precommit'];

// The one string that says "dep-guard init wrote this". Idempotence and
// the refusal to clobber a foreign file are both decided by looking for
// it, so it has to appear in every artifact this file writes, and it
// carries a version so a future format change can be recognised rather
// than guessed at.
export const MANAGED_HOOK_MARKER = 'dep-guard-managed-hook: v1';

// The shell body shared by the native and husky hooks.
//
// No `set -e`. That is deliberate and not an oversight: under `set -e`
// the shell would exit at the failing `dep-guard scan` line before the
// status could be captured, which happens to preserve the exit code but
// loses the explanatory line entirely, so a blocked commit would print
// nothing about why. Capturing `$?` explicitly gets both.
//
// `command -v` rather than `which`: `which` is not in POSIX, is absent
// from some minimal images, and reports success in some shells for a
// shell builtin that is not an executable.
const HOOK_BODY = `if ! command -v dep-guard >/dev/null 2>&1; then
  echo "dep-guard: command not found, so staged dependency changes were NOT scanned; install @vaultcompass/dep-guard or remove this pre-commit hook" >&2
  exit 1
fi

dep-guard scan --staged
dep_guard_status=$?

if [ "$dep_guard_status" -ne 0 ]; then
  echo "dep-guard: commit blocked (dep-guard exit $dep_guard_status). Review the report above; 'git commit --no-verify' bypasses this hook at your own risk." >&2
fi

# dep-guard's own exit code, passed straight through. 1 means blocking
# findings; 2 means dep-guard could not run its checks at all. Collapsing
# 2 into 1 would report findings that were never actually looked for.
exit "$dep_guard_status"
`;

const NATIVE_HOOK = `#!/bin/sh
# dep-guard pre-commit hook. ${MANAGED_HOOK_MARKER}
# Installed by "dep-guard init". Remove this file to uninstall.

${HOOK_BODY}`;

// Husky 9 runs .husky/pre-commit directly and no longer needs the
// _/husky.sh preamble, but a repository still on husky 8 does, and
// sourcing it when it exists is harmless on both.
const HUSKY_HOOK = `#!/usr/bin/env sh
# dep-guard pre-commit hook. ${MANAGED_HOOK_MARKER}
# Installed by "dep-guard init". Remove this file to uninstall.
if [ -f "$(dirname "$0")/_/husky.sh" ]; then
  . "$(dirname "$0")/_/husky.sh"
fi

${HOOK_BODY}`;

// lefthook and the pre-commit framework both own process control
// themselves: they run the command and decide the hook's exit code from
// whether it succeeded. So these two get the command and not the shell
// guard above. That is a real difference in what init can promise, and it
// is documented in the README rather than papered over here -- a
// non-zero dep-guard still blocks the commit under both (fail-closed
// holds, including for a missing binary, which both managers report as a
// failed command), but the commit's exit code is the manager's, so the
// distinction between dep-guard's 1 and its 2 does not survive.
const LEFTHOOK_LOCAL = `# ${MANAGED_HOOK_MARKER}
# Written by "dep-guard init". Lefthook merges this with lefthook.yml.
# Remove this file, or just this stanza, to uninstall.
pre-commit:
  commands:
    dep-guard:
      run: dep-guard scan --staged
`;

const PRE_COMMIT_CONFIG = `# ${MANAGED_HOOK_MARKER}
# Written by "dep-guard init". See https://pre-commit.com
# Remove this file, or just this hook entry, to uninstall.
repos:
  - repo: local
    hooks:
      - id: dep-guard
        name: dep-guard (staged dependency changes)
        entry: dep-guard scan --staged
        language: system
        pass_filenames: false
`;

export interface InitOptions {
  cwd?: string;
  manager?: HookManager;
  dryRun?: boolean;
  json?: boolean;
}

export interface InitConflict {
  path: string;
  reason: 'not-a-git-repository' | 'foreign-hook' | 'write-failed';
  guidance: string;
}

export interface InitAction {
  kind: 'write' | 'skip';
  path: string;
  detail: string;
}

export interface InitResult {
  ok: boolean;
  dryRun: boolean;
  manager: HookManager;
  alreadyInstalled: boolean;
  actions: InitAction[];
  conflicts: InitConflict[];
  /** Absolute path of the artifact this manager owns. */
  hookPath: string;
}

function isGitRepo(cwd: string): boolean {
  return existsSync(path.join(cwd, '.git'));
}

// Resolves where git will actually look for hooks, honouring
// core.hooksPath. A repository that has moved its hooks directory (husky
// 9 does exactly this, and so do several monorepo setups) is precisely
// the repository where writing to .git/hooks produces a file git never
// reads: the gate reports itself installed and never runs. A relative
// core.hooksPath resolves against the .git directory, per git's own
// documentation, not against the working directory.
function effectiveHooksDir(cwd: string): string {
  let gitDir: string;
  try {
    gitDir = path.resolve(
      cwd,
      execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    );
  } catch {
    return path.join(cwd, '.git', 'hooks');
  }

  let hooksPath = '';
  try {
    hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    hooksPath = '';
  }

  if (hooksPath.length === 0) {
    return path.join(gitDir, 'hooks');
  }
  return path.isAbsolute(hooksPath) ? hooksPath : path.join(gitDir, hooksPath);
}

/** Absolute path of the file the given manager's hook lives in. */
export function hookArtifactFor(cwd: string, manager: HookManager): string {
  switch (manager) {
    case 'husky':
      return path.join(cwd, '.husky', 'pre-commit');
    case 'lefthook':
      return path.join(cwd, 'lefthook-local.yml');
    case 'precommit':
      return path.join(cwd, '.pre-commit-config.yaml');
    case 'native':
    default:
      return path.join(effectiveHooksDir(cwd), 'pre-commit');
  }
}

function contentFor(manager: HookManager): string {
  switch (manager) {
    case 'husky':
      return HUSKY_HOOK;
    case 'lefthook':
      return LEFTHOOK_LOCAL;
    case 'precommit':
      return PRE_COMMIT_CONFIG;
    case 'native':
    default:
      return NATIVE_HOOK;
  }
}

// Only the shell hooks are made executable. lefthook-local.yml and
// .pre-commit-config.yaml are configuration their managers read, and
// marking a config file executable is noise in a diff at best.
function isExecutableHook(manager: HookManager): boolean {
  return manager === 'native' || manager === 'husky';
}

function readIfExists(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function foreignGuidance(manager: HookManager, relPath: string): string {
  switch (manager) {
    case 'husky':
      return `${relPath} already exists and was not written by dep-guard. Add "dep-guard scan --staged" to it yourself, or move it aside and re-run init.`;
    case 'lefthook':
      return `${relPath} already exists. Add this under pre-commit.commands: "dep-guard:" with "run: dep-guard scan --staged".`;
    case 'precommit':
      return `${relPath} already exists. Add a local hook entry running "dep-guard scan --staged" to its repos: list.`;
    case 'native':
    default:
      return `${relPath} already exists and was not written by dep-guard. Merge "dep-guard scan --staged" into it yourself, or move it aside and re-run init. Consider "--manager husky" or "--manager lefthook" if another tool owns your hooks.`;
  }
}

/**
 * Works out what init would do, touching nothing.
 *
 * Three outcomes: nothing to do (the hook is already ours), one file to
 * write, or a conflict. A conflict is never resolved by overwriting -- a
 * pre-commit hook is somebody else's working setup, and a tool that
 * silently replaces one has broken their repository to install itself.
 */
export function planInit(options: InitOptions = {}): InitResult {
  const cwd = options.cwd ?? process.cwd();
  const manager = options.manager ?? 'native';
  const dryRun = Boolean(options.dryRun);
  const conflicts: InitConflict[] = [];
  const actions: InitAction[] = [];

  const base: Omit<InitResult, 'ok' | 'alreadyInstalled'> = {
    dryRun,
    manager,
    actions,
    conflicts,
    hookPath: '',
  };

  if (!isGitRepo(cwd)) {
    conflicts.push({
      path: '.git',
      reason: 'not-a-git-repository',
      guidance: 'Run "git init" first: a pre-commit hook has nothing to attach to otherwise.',
    });
    return { ...base, hookPath: '', ok: false, alreadyInstalled: false };
  }

  const hookPath = hookArtifactFor(cwd, manager);
  const relPath = path.relative(cwd, hookPath).split(path.sep).join('/');
  const existing = readIfExists(hookPath);

  if (existing !== undefined && existing.includes(MANAGED_HOOK_MARKER)) {
    actions.push({ kind: 'skip', path: relPath, detail: 'already installed by dep-guard init' });
    return { ...base, hookPath, ok: true, alreadyInstalled: true };
  }

  // A whitespace-only file is not a foreign hook. git ships .sample hooks
  // and some tooling leaves a zero-byte pre-commit behind; refusing on one
  // of those would fail init for a repository with nothing to lose.
  if (existing !== undefined && existing.trim().length > 0) {
    conflicts.push({
      path: relPath,
      reason: 'foreign-hook',
      guidance: foreignGuidance(manager, relPath),
    });
    return { ...base, hookPath, ok: false, alreadyInstalled: false };
  }

  actions.push({
    kind: 'write',
    path: relPath,
    detail: existing === undefined ? 'create' : 'replace an empty file',
  });
  return { ...base, hookPath, ok: true, alreadyInstalled: false };
}

/**
 * Carries out a plan. A plan that is not ok, is a dry run, or has nothing
 * to do is returned untouched, so this is safe to call unconditionally.
 */
export function applyInit(plan: InitResult, options: InitOptions = {}): InitResult {
  if (!plan.ok || plan.dryRun || plan.alreadyInstalled) {
    return plan;
  }

  const manager = options.manager ?? plan.manager;
  try {
    mkdirSync(path.dirname(plan.hookPath), { recursive: true });
    writeFileSync(plan.hookPath, contentFor(manager), 'utf8');
    if (isExecutableHook(manager)) {
      // Set after the write rather than via the write's mode option: an
      // existing (empty) file keeps its own mode when written through,
      // and git will not run a hook it cannot execute. A hook that
      // silently never runs is indistinguishable from no gate at all,
      // which is the failure mode worth the extra syscall.
      chmodSync(plan.hookPath, (statSync(plan.hookPath).mode & 0o777) | 0o755);
    }
  } catch (err) {
    return {
      ...plan,
      ok: false,
      conflicts: [
        ...plan.conflicts,
        {
          path: plan.hookPath,
          reason: 'write-failed',
          guidance: `Could not write the hook: ${(err as Error).message}`,
        },
      ],
    };
  }

  return plan;
}

function renderHuman(result: InitResult): string {
  const lines: string[] = [];

  if (result.conflicts.length > 0) {
    lines.push('dep-guard init: nothing was written.');
    for (const conflict of result.conflicts) {
      lines.push(`  ${conflict.path} (${conflict.reason})`);
      lines.push(`    ${conflict.guidance}`);
    }
    return lines.join('\n');
  }

  if (result.alreadyInstalled) {
    lines.push(`dep-guard init: the ${result.manager} pre-commit hook is already installed.`);
    return lines.join('\n');
  }

  lines.push(
    result.dryRun
      ? `dep-guard init (dry run): would install the ${result.manager} pre-commit hook.`
      : `dep-guard init: installed the ${result.manager} pre-commit hook.`
  );
  for (const action of result.actions) {
    lines.push(`  ${result.dryRun ? 'would write' : 'wrote'} ${action.path} (${action.detail})`);
  }
  if (result.manager === 'lefthook') {
    lines.push('  Run "lefthook install" to activate it.');
  }
  if (result.manager === 'precommit') {
    lines.push('  Run "pre-commit install" to activate it.');
  }
  lines.push(`  Uninstall by deleting ${result.actions[0]?.path ?? 'the hook file'}.`);
  return lines.join('\n');
}

/**
 * The command entry point. Returns the process exit code: 0 when the hook
 * is installed (or already was), 2 when nothing could be done, which is
 * the same exit-2 vocabulary the rest of this CLI uses for "dep-guard
 * could not carry out what it was asked".
 */
export function initCommand(options: InitOptions = {}): number {
  const plan = planInit(options);
  const result = applyInit(plan, options);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.ok) {
    process.stdout.write(`${renderHuman(result)}\n`);
  } else {
    process.stderr.write(`${renderHuman(result)}\n`);
  }

  return result.ok ? 0 : 2;
}
