#!/usr/bin/env node
// Runs dep-guard against real repositories and reports what it found.
//
//   pnpm build
//   node bench/dogfood.mjs --corpus-dir .corpus-work/corpus
//   node bench/dogfood.mjs --corpus-dir .corpus-work/corpus --compare
//   node bench/dogfood.mjs --tier local --corpus-dir .corpus-work/corpus
//
// Two tiers, one code path
// ------------------------
// The public tier clones the repositories in bench/repos.public.json at
// their pinned commits, scans them, and deletes the clones. It is
// reproducible by anyone, which is what makes bench/baseline.public.json
// meaningful: a change to this tool that alters what it finds on real code
// shows up as a diff against a recorded run rather than as a feeling.
//
// The private tier scans repositories listed in bench/repos.local.json,
// which is gitignored and never leaves the machine it is on. That tier is
// where the interesting material is -- private repositories are the ones
// with internal scopes, vendored tarballs and odd registries in them -- and
// it is only safe to run at all because of what it is allowed to emit.
//
// Why the private tier emits counts and nothing else
// --------------------------------------------------
// Findings per rule and per severity, diagnostics per code, totals. No
// package name, no repository name, no path, no message, no fingerprint.
// The reason is not modesty: it is that the output of this harness gets
// pasted into issues, commit messages and chat, and a dependency graph is
// itself sensitive -- it names a company's vendors, its internal service
// boundaries, and often its unreleased work.
//
// "Remember not to paste the wrong thing" is not a control. So the
// constraint lives in code: lib/counts.mjs builds every bucket from a
// vocabulary this harness declares and files anything else under a fixed
// "other" key, so nothing read out of a repository can become a key, and
// assertPrivateEntry then rechecks the finished record before it is
// printed. The private tier also never learns its own repositories' names
// past the point where it spawns the scan -- entries are identified by
// their position in the local list.
//
// No dependencies are ever installed. dep-guard reads manifests and
// lockfiles; node_modules would add minutes per repository and change
// nothing about the answer.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareToBaseline, formatComparison } from './lib/baseline.mjs';
import { assertCountsOnly, assertPrivateEntry, summarize } from './lib/counts.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli.js');
const PUBLIC_REPOS = path.join(REPO_ROOT, 'bench', 'repos.public.json');
const LOCAL_REPOS = path.join(REPO_ROOT, 'bench', 'repos.local.json');
const PUBLIC_BASELINE = path.join(REPO_ROOT, 'bench', 'baseline.public.json');
const LOCAL_BASELINE = path.join(REPO_ROOT, 'bench', 'baseline.local.json');
const FIXTURE_CORPUS = path.join(REPO_ROOT, 'packages', 'core', 'fixtures', 'corpus');

const CLONE_TIMEOUT_MS = 600_000;
const SCAN_TIMEOUT_MS = 300_000;

const USAGE = `Usage: node bench/dogfood.mjs [options]

  --tier public|local   which repository list to run (default public)
  --corpus-dir <dir>    corpus to scan against (default the fifty-name dev fixture)
  --repos <file>        repository list, overriding the tier's default
  --compare             compare the run against the recorded baseline, exit 1 on drift
  --write-baseline      record this run as the baseline for its tier
  --json                write the run to stdout as JSON
  --online              turn on the registry-backed checks (network required)
  -h, --help            print this
`;

function log(message) {
  process.stderr.write(`${message}\n`);
}

function parseArgs(argv) {
  const options = {
    tier: 'public',
    corpusDir: FIXTURE_CORPUS,
    reposFile: null,
    compare: false,
    writeBaseline: false,
    json: false,
    online: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }
    if (arg === '--compare') {
      options.compare = true;
      continue;
    }
    if (arg === '--write-baseline') {
      options.writeBaseline = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--online') {
      options.online = true;
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.startsWith('-')) {
      throw new Error(`${arg} needs a value`);
    }
    index += 1;
    if (arg === '--tier') {
      if (value !== 'public' && value !== 'local') {
        throw new Error('--tier must be public or local');
      }
      options.tier = value;
    } else if (arg === '--corpus-dir') {
      options.corpusDir = path.resolve(value);
    } else if (arg === '--repos') {
      options.reposFile = path.resolve(value);
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  if (options.online && options.writeBaseline) {
    throw new Error(
      '--online and --write-baseline cannot be combined: the baseline records offline counts ' +
        'only, and a network-dependent run would silently rebase it onto counts nobody else can ' +
        'reproduce'
    );
  }
  return options;
}

function run(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Inherited git configuration can turn an ordinary clone into
      // something that runs local code (hooks, filters, a template
      // directory). The clone below disables what it can; this keeps a
      // machine-level template out of the picture in the first place.
      env: { ...process.env, GIT_TEMPLATE_DIR: '', GIT_CONFIG_NOSYSTEM: '1' },
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => resolve({ code: null, stdout, stderr: String(err) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Fetching one commit into an empty repository, rather than cloning a
// branch and hoping the pin is on it. A shallow clone of a branch would
// drift the moment upstream pushes; a pinned fetch either produces exactly
// the recorded tree or fails.
//
// Hooks are disabled twice over -- once in the repository's own config and
// once on every git invocation -- because a hook is the one thing a
// repository can carry that runs on this machine, and this harness exists
// to scan code nobody has vetted.
const HOOKLESS = ['-c', 'core.hooksPath=', '-c', 'advice.detachedHead=false'];

async function cloneAt(url, sha, into) {
  const init = await run('git', [...HOOKLESS, 'init', '-q', into], {
    cwd: REPO_ROOT,
    timeoutMs: CLONE_TIMEOUT_MS,
  });
  if (init.code !== 0) {
    throw new Error(`git init failed: ${init.stderr.trim()}`);
  }

  const steps = [
    ['config', 'core.hooksPath', 'hooks-disabled-by-dep-guard-bench'],
    ['remote', 'add', 'origin', url],
    ['fetch', '--depth', '1', '--no-tags', 'origin', sha],
    ['checkout', '-q', '--detach', 'FETCH_HEAD'],
  ];
  for (const step of steps) {
    const result = await run('git', [...HOOKLESS, ...step], {
      cwd: into,
      timeoutMs: CLONE_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new Error(`git ${step[0]} failed: ${result.stderr.trim().split('\n').slice(-3).join(' ')}`);
    }
  }

  // The pin is the whole basis for comparing two runs, so it is verified
  // rather than assumed: a server that answered a fetch with something else
  // would otherwise silently rebase the baseline.
  const head = await run('git', [...HOOKLESS, 'rev-parse', 'HEAD'], {
    cwd: into,
    timeoutMs: CLONE_TIMEOUT_MS,
  });
  const actual = head.stdout.trim();
  if (actual !== sha) {
    throw new Error(`pinned commit ${sha} was requested but ${actual} was checked out`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A fetch of nine repositories over the public internet will occasionally
// have one connection reset, and losing a sixty-second run to that is
// annoying enough that somebody stops running it. Retried a couple of
// times; a repository that still will not clone is reported and skipped,
// which a --compare run then surfaces as a repository the baseline knows
// and this run did not cover.
async function cloneWithRetries(url, sha, into, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await cloneAt(url, sha, into);
      return;
    } catch (err) {
      if (attempt >= attempts) {
        throw err;
      }
      log(`  attempt ${attempt} failed (${err.message}); retrying`);
      rmSync(into, { recursive: true, force: true });
      await sleep(2000 * attempt);
    }
  }
}

async function scan(targetPath, corpusDir, online) {
  const args = [
    CLI_PATH,
    'scan',
    targetPath,
    '--format',
    'json',
    '--corpus-dir',
    corpusDir,
    // The harness measures what the engine finds, not whether a
    // threshold was crossed, so the gate is taken out of the picture and
    // a non-zero exit means the scan itself failed.
    '--fail-on',
    'none',
  ];
  if (online) {
    args.push('--online');
  }
  const result = await run(process.execPath, args, { cwd: REPO_ROOT, timeoutMs: SCAN_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new Error(`scan exited ${result.code}: ${result.stderr.trim().split('\n').slice(-2).join(' ')}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('scan did not produce a JSON result on stdout');
  }
}

function readJson(filePath, what) {
  if (!existsSync(filePath)) {
    throw new Error(`${what} not found at ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readCorpusMeta(corpusDir) {
  try {
    const meta = readJson(path.join(corpusDir, 'meta.json'), 'corpus meta');
    return { builtAt: meta.builtAt ?? null, nameCount: meta.nameCount ?? null };
  } catch {
    return { builtAt: null, nameCount: null };
  }
}

async function runPublicTier(options) {
  const config = readJson(options.reposFile ?? PUBLIC_REPOS, 'public repository list');
  const entries = [];
  const failed = [];

  for (const target of config.repos) {
    const workDir = mkdtempSync(path.join(tmpdir(), 'dep-guard-bench-'));
    const clonePath = path.join(workDir, 'repo');
    const startedAt = Date.now();
    try {
      log(`${target.repo} at ${target.sha.slice(0, 12)}`);
      await cloneWithRetries(target.url, target.sha, clonePath);
      const result = await scan(clonePath, options.corpusDir, options.online);
      const counts = assertCountsOnly(summarize(result));
      entries.push({ repo: target.repo, sha: target.sha, counts });

      const observed = Object.entries(counts.lockfile).find(([, value]) => value === 1)?.[0];
      if (target.expectLockfile !== undefined && observed !== target.expectLockfile) {
        log(
          `  the pin was recorded as a ${target.expectLockfile} repository but the scan read ` +
            `${observed}; the pin or the note is wrong`
        );
      }
      log(
        `  ${counts.findings.total} finding(s), ${counts.diagnostics.total} diagnostic(s), ` +
          `${observed} lockfile, ${Math.round((Date.now() - startedAt) / 1000)}s`
      );
    } catch (err) {
      log(`  skipped: ${err.message}`);
      failed.push(target.repo);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  if (failed.length > 0) {
    log(`\n${failed.length} repository(s) could not be scanned: ${failed.join(', ')}`);
  }
  if (entries.length === 0) {
    throw new Error('no repository could be scanned');
  }
  return entries;
}

// The private tier deliberately learns as little as it can. The path goes
// into the scan and nowhere else: it is not held on the entry, not logged,
// and not available to the reporting below even by accident, because the
// only thing that leaves this function is a positional identifier and a
// bag of numbers.
async function runLocalTier(options) {
  const config = readJson(
    options.reposFile ?? LOCAL_REPOS,
    'local repository list (create bench/repos.local.json; it is gitignored)'
  );
  const entries = [];

  for (let index = 0; index < config.repos.length; index += 1) {
    const target = config.repos[index];
    const targetPath = path.resolve(String(target.path ?? target));
    const position = index + 1;
    log(`repository ${position} of ${config.repos.length}`);
    const result = await scan(targetPath, options.corpusDir, options.online);
    const counts = summarize(result);
    const entry = assertPrivateEntry({ repo: `local-${position}`, sha: null, counts });
    entries.push(entry);
    log(`  ${counts.findings.total} finding(s), ${counts.diagnostics.total} diagnostic(s)`);
  }

  return entries;
}

function renderTable(entries) {
  const lines = [];
  const width = Math.max(...entries.map((entry) => entry.repo.length), 12);
  lines.push(
    `${'repository'.padEnd(width)}  total  crit  high   med   low  diags  lockfile`
  );
  for (const entry of entries) {
    const { counts } = entry;
    const lockfile = Object.entries(counts.lockfile).find(([, value]) => value === 1)?.[0] ?? '?';
    lines.push(
      `${entry.repo.padEnd(width)}  ${String(counts.findings.total).padStart(5)}  ` +
        `${String(counts.findings.bySeverity.critical).padStart(4)}  ` +
        `${String(counts.findings.bySeverity.high).padStart(4)}  ` +
        `${String(counts.findings.bySeverity.medium).padStart(4)}  ` +
        `${String(counts.findings.bySeverity.low).padStart(4)}  ` +
        `${String(counts.diagnostics.total).padStart(5)}  ${lockfile}`
    );
  }

  const byRule = {};
  for (const entry of entries) {
    for (const [rule, value] of Object.entries(entry.counts.findings.byRule)) {
      byRule[rule] = (byRule[rule] ?? 0) + value;
    }
  }
  lines.push('');
  lines.push('findings by rule across all repositories:');
  for (const [rule, value] of Object.entries(byRule)) {
    lines.push(`  ${rule.padEnd(22)} ${value}`);
  }
  return lines.join('\n');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`dogfood: ${err.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (!existsSync(CLI_PATH)) {
    process.stderr.write(`dogfood: no built CLI at ${CLI_PATH}. Run pnpm build first.\n`);
    process.exitCode = 2;
    return;
  }

  const corpus = readCorpusMeta(options.corpusDir);
  if (options.corpusDir === FIXTURE_CORPUS) {
    log(
      'Scanning against the fifty-name development fixture. Every real dependency will ' +
        'read as unknown, so the existence counts below measure nothing about precision. ' +
        'Point --corpus-dir at a built corpus for numbers that mean anything.'
    );
  }

  const startedAt = Date.now();
  const entries =
    options.tier === 'public' ? await runPublicTier(options) : await runLocalTier(options);
  const runRecord = {
    version: 1,
    tier: options.tier,
    corpus,
    repos: entries,
  };

  log('');
  process.stdout.write(`${renderTable(entries)}\n`);
  log(`\n${entries.length} repository(s) in ${Math.round((Date.now() - startedAt) / 1000)}s`);

  const baselinePath = options.tier === 'public' ? PUBLIC_BASELINE : LOCAL_BASELINE;

  if (options.writeBaseline) {
    writeFileSync(baselinePath, `${JSON.stringify(runRecord, null, 2)}\n`);
    log(`Recorded this run as the baseline at ${path.relative(REPO_ROOT, baselinePath)}`);
  }

  if (options.compare) {
    const baseline = readJson(baselinePath, `${options.tier} baseline`);
    const comparison = compareToBaseline(runRecord, baseline);
    log('');
    log(formatComparison(comparison));
    if (comparison.changed) {
      process.exitCode = 1;
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(runRecord, null, 2)}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`dogfood: ${err?.stack ?? String(err)}\n`);
  process.exitCode = 2;
});
