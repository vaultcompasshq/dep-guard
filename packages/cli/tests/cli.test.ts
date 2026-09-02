import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ScanResult } from '@vaultcompass/dep-guard-core';

// Integration-style: this suite drives the actual built dist/cli.js as a
// child process in a temp git repository, the same temp-repo pattern
// core's git-source.test.ts and scan.test.ts use. A build has to happen
// first -- dist/cli.js has to reflect this file's own src/cli.ts, not
// whatever placeholder or stale build happened to be lying around -- so
// beforeAll runs the exact same "tsc -b packages/core packages/cli"
// command the root package.json's own "build" script runs, rather than
// inventing a second build mechanism.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', '..');
const FIXTURE_CORPUS = path.join(ROOT, 'packages', 'core', 'fixtures', 'corpus');
const CLI_ENTRY = path.join(ROOT, 'packages', 'cli', 'dist', 'cli.js');
const TSC_BIN = path.join(ROOT, 'node_modules', '.bin', 'tsc');
// Mirrors scan.ts's own DEFAULT_CORPUS_DIR computation (packages/core/src/
// scan.ts: path.join(dirname(scan.js), '..', 'data', 'corpus')), from this
// file's own vantage point in the repo rather than the built module's --
// both resolve to the same packages/core/data/corpus. See the
// "no corpus built yet" describe block below for why this has to be a
// known, checkable path rather than an assumption.
const DEFAULT_CORPUS_DIR = path.join(ROOT, 'packages', 'core', 'data', 'corpus');

const execFileAsync = promisify(execFile);

// The build in beforeAll and every CLI invocation below spawn a real
// child process (tsc, then node running the built CLI, which itself
// shells out to git); the default 5-second Jest timeout is too tight for
// that, especially for a cold, non-incremental "tsc -b".
const BUILD_TIMEOUT_MS = 120000;
const CLI_TIMEOUT_MS = 20000;

let tempDirs: string[] = [];
let repo = '';

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repo, encoding: 'utf8' });
  return stdout;
}

async function write(relPath: string, content: string): Promise<void> {
  const full = path.join(repo, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

async function commitAll(message: string): Promise<void> {
  await git('add', '-A');
  await git('commit', '-q', '-m', message);
}

function manifestJson(dependencies: Record<string, string>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'root', version: '1.0.0', dependencies, ...extra });
}

interface CliRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {}
): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI_ENTRY, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
    };
  }
}

// Reproduces a reader (head, less, a CI log collector) closing its end of
// the pipe before the CLI finishes writing. That only happens with a real
// OS pipe and a real early-exiting reader process -- there is no way to
// fake it with in-process Node streams -- so this shells out to bash and
// reads the CLI's own exit code back out of PIPESTATUS[0], since the
// pipeline's own exit code (what execFile would normally report) is
// head's, not the CLI's. The CLI's stderr is redirected to a file rather
// than left attached to the pipeline, so it can be inspected afterward
// without also racing head's stdin close.
async function runCliPipedToHead(
  args: string[],
  cwd: string,
  headBytesOrLines: { bytes: number } | { lines: number }
): Promise<{ pipelineExitCode: number; stderr: string }> {
  const quotedArgs = args.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');
  const headFlag = 'bytes' in headBytesOrLines ? `-c ${headBytesOrLines.bytes}` : `-n ${headBytesOrLines.lines}`;
  const stderrPath = path.join(cwd, 'cli-stderr.log');
  const script =
    `node '${CLI_ENTRY}' ${quotedArgs} 2>'${stderrPath}' | head ${headFlag} >/dev/null; ` +
    `echo "PIPESTATUS0=\${PIPESTATUS[0]}"`;
  const { stdout } = await execFileAsync('bash', ['-c', script], { cwd });
  const match = /PIPESTATUS0=(\d+)/.exec(stdout);
  const pipelineExitCode = match ? Number(match[1]) : -1;
  const stderr = await readFile(stderrPath, 'utf8').catch(() => '');
  return { pipelineExitCode, stderr };
}

// Builds a manifest carrying enough distinct unknown dependencies that
// the resulting JSON/text report exceeds a pipe's kernel buffer (64KB on
// Linux, smaller on macOS) -- otherwise the whole report fits in the
// buffer in one write() and a reader closing early never produces an
// EPIPE at all, since nothing was left unread. ~3000 entries mirrors the
// scale in the reported repro.
function manyUnknownDeps(count: number): Record<string, string> {
  const deps: Record<string, string> = {};
  for (let i = 0; i < count; i += 1) {
    deps[`zz-epipe-test-dep-${i}`] = '1.0.0';
  }
  return deps;
}

beforeAll(async () => {
  await execFileAsync(TSC_BIN, ['-b', 'packages/core', 'packages/cli'], { cwd: ROOT });
}, BUILD_TIMEOUT_MS);

beforeEach(async () => {
  repo = await makeTempDir('dep-guard-cli-');
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'dep guard test');
  await git('config', 'commit.gpgsign', 'false');
});

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  repo = '';
});

describe('dep-guard scan --format json', () => {
  test('emits a single parseable ScanResult on stdout whose exitCode matches the process exit code', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');
    await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
    await git('add', '-A');

    const run = await runCli(
      ['scan', '--staged', '--format', 'json', '--corpus-dir', FIXTURE_CORPUS],
      repo
    );

    const lines = run.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const result = JSON.parse(lines[0]) as ScanResult;

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ruleId: 'unknown-package',
      packageName: 'reeact-definitely-not-real',
    });
    expect(result.exitCode).toBe(1);
    expect(run.exitCode).toBe(result.exitCode);
  }, CLI_TIMEOUT_MS);

  test('stdout stays clean JSON while diagnostics go to stderr', async () => {
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['vendor/'] }));
    await write('package.json', manifestJson({}));
    await commitAll('first');
    await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
    await git('add', '-A');

    const run = await runCli(
      ['scan', '--staged', '--format', 'json', '--corpus-dir', FIXTURE_CORPUS],
      repo
    );

    // The whole of stdout must parse as one JSON object -- no diagnostic
    // text, no log lines, nothing else sharing the stream.
    const result = JSON.parse(run.stdout.trim()) as ScanResult;
    expect(result.findings).toHaveLength(1);

    // "vendor/" never matches "package.json", so the ignore-path-unmatched
    // diagnostic fires; it has to be visible to a human even though it
    // stays out of stdout.
    expect(run.stderr).toContain('ignore-path-unmatched');
    expect(run.stderr).toContain('vendor/');
  }, CLI_TIMEOUT_MS);
});

describe('exit codes', () => {
  test('an invalid config file exits 2 with a readable message, not a stack trace', async () => {
    await write('.dep-guard.json', '{ this is not valid json');
    await write('package.json', manifestJson({}));

    const run = await runCli(['scan', '--format', 'json', '--corpus-dir', FIXTURE_CORPUS], repo);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('config-invalid');
    expect(run.stderr).not.toContain('    at ');
  }, CLI_TIMEOUT_MS);

  test('an empty check name exits 2 with a readable message, not a stack trace', async () => {
    const run = await runCli(['check', '', '--format', 'json', '--corpus-dir', FIXTURE_CORPUS], repo);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('name-invalid');
    expect(run.stderr).not.toContain('    at ');
  }, CLI_TIMEOUT_MS);
});

describe('--fail-on override', () => {
  test('overriding the threshold changes the exit code', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');
    await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
    await git('add', '-A');

    const atDefault = await runCli(
      ['scan', '--staged', '--format', 'json', '--corpus-dir', FIXTURE_CORPUS],
      repo
    );
    const overridden = await runCli(
      [
        'scan',
        '--staged',
        '--format',
        'json',
        '--corpus-dir',
        FIXTURE_CORPUS,
        '--fail-on',
        'critical',
      ],
      repo
    );

    // unknown-package is "high" severity: the default "medium" floor
    // blocks it, but raising the floor to "critical" does not.
    expect(atDefault.exitCode).toBe(1);
    expect(overridden.exitCode).toBe(0);
  }, CLI_TIMEOUT_MS);

  test('an unrecognized --fail-on value is rejected at the CLI boundary, not passed through to core', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');

    const run = await runCli(
      ['scan', '--format', 'json', '--corpus-dir', FIXTURE_CORPUS, '--fail-on', 'catastrophic'],
      repo
    );

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('--fail-on');
  }, CLI_TIMEOUT_MS);
});

describe('dep-guard scan --format text', () => {
  test('groups findings by severity and reports package name, severity, suppressed, and ignored counts', async () => {
    await write('package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    await write('packages/a/package.json', JSON.stringify({ name: 'a', dependencies: {} }));
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['packages/a'] }));
    await commitAll('first');
    await write(
      'package.json',
      JSON.stringify({
        name: 'root',
        workspaces: ['packages/*'],
        dependencies: { 'reeact-definitely-not-real': '1.0.0' },
      })
    );
    await write(
      'packages/a/package.json',
      JSON.stringify({ name: 'a', dependencies: { 'reeact-definitely-not-real': '1.0.0' } })
    );
    await git('add', '-A');

    const run = await runCli(
      ['scan', '--staged', '--format', 'text', '--corpus-dir', FIXTURE_CORPUS],
      repo
    );

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain('HIGH');
    expect(run.stdout).toContain('reeact-definitely-not-real');
    expect(run.stdout).toContain('[high]');
    // One finding at the root manifest blocks; the same package under
    // packages/a is dropped by ignorePaths, not the baseline.
    expect(run.stdout).toContain('0 suppressed');
    expect(run.stdout).toContain('1 ignored');
  }, CLI_TIMEOUT_MS);

  test('a hostile diagnostic string is sanitized before it reaches the terminal', async () => {
    const escape = String.fromCharCode(27);
    const hostile = `vendor/${escape}[31mFAKE${escape}[0m\ninjected-line`;
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: [hostile] }));
    await write('package.json', manifestJson({}));
    await commitAll('first');
    await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
    await git('add', '-A');

    const run = await runCli(
      ['scan', '--staged', '--format', 'text', '--corpus-dir', FIXTURE_CORPUS],
      repo
    );

    // The raw ESC byte that starts each ANSI sequence never survives into
    // the rendered report.
    expect(run.stdout).not.toContain(escape);
    // The embedded newline collapses to a space rather than surviving as
    // a real line break, so "injected-line" cannot masquerade as a
    // separate line of output.
    expect(run.stdout).not.toContain('\ninjected-line');
    expect(run.stdout).toContain('FAKE');
    expect(run.stdout).toContain('injected-line');
  }, CLI_TIMEOUT_MS);
});

describe('dep-guard check', () => {
  test('round-trips a known-good name to a clean result', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');

    const run = await runCli(
      ['check', 'react', '--format', 'json', '--corpus-dir', FIXTURE_CORPUS],
      repo
    );

    const result = JSON.parse(run.stdout.trim()) as ScanResult;
    expect(result.findings).toHaveLength(0);
    expect(result.exitCode).toBe(0);
    expect(run.exitCode).toBe(0);
  }, CLI_TIMEOUT_MS);

  test('round-trips a typosquat name to a blocking finding', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');

    const run = await runCli(
      ['check', 'raect', '--format', 'json', '--corpus-dir', FIXTURE_CORPUS],
      repo
    );

    const result = JSON.parse(run.stdout.trim()) as ScanResult;
    expect(result.findings.some((f) => f.ruleId === 'typosquat')).toBe(true);
    expect(run.exitCode).toBe(result.exitCode);
  }, CLI_TIMEOUT_MS);
});

describe('a reader that closes the pipe early (EPIPE)', () => {
  test('json mode piped to a truncating reader does not crash or override the gate exit code', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');
    await write('package.json', manifestJson(manyUnknownDeps(3000)));
    await git('add', '-A');

    // --fail-on none forces result.exitCode to 0 regardless of how many
    // findings there are, so if the CLI process's own exit code comes
    // back 1 instead, that can only be Node's default "uncaught error
    // event" behavior clobbering it, not a real gate decision.
    const { pipelineExitCode, stderr } = await runCliPipedToHead(
      [
        'scan',
        '--staged',
        '--format',
        'json',
        '--corpus-dir',
        FIXTURE_CORPUS,
        '--fail-on',
        'none',
      ],
      repo,
      { bytes: 5 }
    );

    expect(pipelineExitCode).toBe(0);
    // No stack trace, no "write EPIPE" noise -- the error is swallowed,
    // not reported. Scan diagnostics legitimately share this stream (this
    // fixture has no lockfile, which is itself a diagnostic), so the
    // assertion is about the crash noise specifically, not about silence.
    expect(stderr).not.toContain('EPIPE');
    expect(stderr).not.toContain('    at ');
  }, CLI_TIMEOUT_MS);

  test('text mode piped to a truncating reader does not crash or override the gate exit code', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');
    await write('package.json', manifestJson(manyUnknownDeps(3000)));
    await git('add', '-A');

    const { pipelineExitCode, stderr } = await runCliPipedToHead(
      [
        'scan',
        '--staged',
        '--format',
        'text',
        '--corpus-dir',
        FIXTURE_CORPUS,
        '--fail-on',
        'none',
      ],
      repo,
      { lines: 1 }
    );

    expect(pipelineExitCode).toBe(0);
    expect(stderr).toBe('');
  }, CLI_TIMEOUT_MS);
});

describe('commander usage errors exit 2, not 1', () => {
  // Six shapes of "the command line itself was wrong", none of which
  // should read as "blocking findings found" (scan's own exit code 1) to
  // a CI wrapper that only checks the exit code.
  test('no arguments at all', async () => {
    const run = await runCli([], repo);
    expect(run.exitCode).toBe(2);
  }, CLI_TIMEOUT_MS);

  test('an unknown command', async () => {
    const run = await runCli(['bogus-command'], repo);
    expect(run.exitCode).toBe(2);
  }, CLI_TIMEOUT_MS);

  test('an unknown flag', async () => {
    const run = await runCli(['scan', '--bogus-flag'], repo);
    expect(run.exitCode).toBe(2);
  }, CLI_TIMEOUT_MS);

  test('a flag missing its value', async () => {
    const run = await runCli(['scan', '--format'], repo);
    expect(run.exitCode).toBe(2);
  }, CLI_TIMEOUT_MS);

  test('a missing required argument', async () => {
    const run = await runCli(['check'], repo);
    expect(run.exitCode).toBe(2);
  }, CLI_TIMEOUT_MS);

  test('an unusable combination of flags', async () => {
    const run = await runCli(['scan', '--staged', '--base', 'HEAD'], repo);
    expect(run.exitCode).toBe(2);
  }, CLI_TIMEOUT_MS);

  // --help and --version are not usage mistakes -- they still exit 0.
  test('--help exits 0', async () => {
    const run = await runCli(['--help'], repo);
    expect(run.exitCode).toBe(0);
  }, CLI_TIMEOUT_MS);

  test('--version exits 0', async () => {
    const run = await runCli(['--version'], repo);
    expect(run.exitCode).toBe(0);
  }, CLI_TIMEOUT_MS);
});

describe('bidi and zero-width characters are sanitized', () => {
  test('a bidi-spoofed package name renders without its reversed-text trick', async () => {
    // U+202E (RIGHT-TO-LEFT OVERRIDE) followed by reversed text and
    // U+202C (POP DIRECTIONAL FORMATTING) is the classic "trojan source"
    // spoof: a terminal honoring the override would render this dependency
    // name's tail reversed, disguising what package is actually being
    // flagged by this security tool's own report.
    const rlo = String.fromCharCode(0x202e);
    const pdf = String.fromCharCode(0x202c);
    const spoofedName = `evil-${rlo}gpj.ekcap${pdf}`;
    await write('package.json', manifestJson({}));
    await commitAll('first');
    await write('package.json', manifestJson({ [spoofedName]: '1.0.0' }));
    await git('add', '-A');

    const run = await runCli(
      ['scan', '--staged', '--format', 'text', '--corpus-dir', FIXTURE_CORPUS],
      repo
    );

    expect(run.stdout).not.toContain(rlo);
    expect(run.stdout).not.toContain(pdf);
    // The literal characters survive -- only the directional override
    // controls are stripped -- so the name still reads left-to-right in
    // the order it was actually written.
    expect(run.stdout).toContain('evil-gpj.ekcap');
  }, CLI_TIMEOUT_MS);
});

describe('--online flag', () => {
  test('is accepted as a valid flag, not rejected as unknown', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');
    const cacheDir = await makeTempDir('dep-guard-cli-cache-');

    const run = await runCli(
      ['scan', '--online', '--format', 'json', '--corpus-dir', FIXTURE_CORPUS],
      repo,
      { XDG_CACHE_HOME: cacheDir }
    );

    // exitCode 0 (clean) or 1 (findings) are both fine here; 2 means the
    // CLI itself rejected something, which --online must never do once it
    // is a recognized flag. An empty-dependencies manifest produces zero
    // registered-squat/asymmetry candidates, so this run makes no network
    // request at all -- genuinely network-free, not just tolerant of a
    // failed one. XDG_CACHE_HOME is redirected to a throwaway temp dir
    // regardless, so no future drift in this test can touch the real
    // developer cache.
    expect(run.exitCode).not.toBe(2);
    expect(run.stderr).not.toContain('unknown option');
  }, CLI_TIMEOUT_MS);

  test('is accepted on check as well', async () => {
    await write('package.json', manifestJson({}));
    // Without this, "react" itself becomes a registered-squat candidate --
    // the check runs over every added registry name, react included, with
    // no built-in exemption for well-known packages -- and reaching that
    // candidate makes checkSingle call fetchWeeklyDownloads, a real HTTPS
    // request to api.npmjs.org. Allow-listing "react" empties the
    // candidate set before any fetch happens, so this test proves --online
    // parses on check and reaches checkSingle without ever making a live
    // request (the degrade-on-failure path would otherwise make this test
    // pass offline too, concealing the leak on a networked machine).
    await write('.dep-guard.json', JSON.stringify({ allow: ['react'] }));
    await commitAll('first');
    const cacheDir = await makeTempDir('dep-guard-cli-cache-');

    const run = await runCli(
      ['check', 'react', '--online', '--format', 'json', '--corpus-dir', FIXTURE_CORPUS],
      repo,
      { XDG_CACHE_HOME: cacheDir }
    );

    expect(run.exitCode).not.toBe(2);
    expect(run.stderr).not.toContain('unknown option');
  }, CLI_TIMEOUT_MS);
});

// A name no registry will ever carry. Every assertion below is written so
// that it holds identically on a machine with a live network connection
// and on one without: an offline run leaves an unknown-package finding at
// 'high' with no onlineResolution detail, whereas EVERY online outcome for
// this name differs from that (stood down, escalated to critical, or
// marked unreachable). That is what makes these tests a real proof that
// nothing online ran, rather than a test that merely passes because the
// network happened to be absent.
const NEVER_PUBLISHED = 'dep-guard-cli-test-name-that-will-never-exist-9f3a2b';

describe('--no-online flag', () => {
  test('overrides an online:true config, leaving the scan fully offline', async () => {
    await write('.dep-guard.json', JSON.stringify({ online: true }));
    await write('package.json', manifestJson({ [NEVER_PUBLISHED]: '^1.0.0' }));
    await commitAll('first');
    const cacheDir = await makeTempDir('dep-guard-cli-cache-');

    const run = await runCli(
      ['scan', '--no-online', '--format', 'json', '--corpus-dir', FIXTURE_CORPUS],
      repo,
      { XDG_CACHE_HOME: cacheDir }
    );

    expect(run.exitCode).not.toBe(2);
    expect(run.stderr).not.toContain('unknown option');
    const result = JSON.parse(run.stdout) as ScanResult;
    const finding = result.findings.find((f) => f.ruleId === 'unknown-package');
    expect(finding?.severity).toBe('high');
    expect(finding?.details ?? {}).not.toHaveProperty('onlineResolution');
    expect(result.run.diagnostics.some((d) => d.code === 'online-check-unreachable')).toBe(false);
  }, CLI_TIMEOUT_MS);

  test('declaring it does not silently turn online on by default', async () => {
    // Commander makes a `--no-x` option default its value to true when
    // `--x` is not also declared first. If that trap were live here, a
    // plain `dep-guard scan` with no flags at all would start making
    // network requests -- the exact opposite of the flag's purpose, and
    // invisible until someone watched the traffic.
    await write('package.json', manifestJson({ [NEVER_PUBLISHED]: '^1.0.0' }));
    await commitAll('first');
    const cacheDir = await makeTempDir('dep-guard-cli-cache-');

    const run = await runCli(
      ['scan', '--format', 'json', '--corpus-dir', FIXTURE_CORPUS],
      repo,
      { XDG_CACHE_HOME: cacheDir }
    );

    const result = JSON.parse(run.stdout) as ScanResult;
    const finding = result.findings.find((f) => f.ruleId === 'unknown-package');
    expect(finding?.severity).toBe('high');
    expect(finding?.details ?? {}).not.toHaveProperty('onlineResolution');
  }, CLI_TIMEOUT_MS);

  test('is accepted on check as well', async () => {
    await write('.dep-guard.json', JSON.stringify({ online: true }));
    await write('package.json', manifestJson({}));
    await commitAll('first');
    const cacheDir = await makeTempDir('dep-guard-cli-cache-');

    const run = await runCli(
      ['check', NEVER_PUBLISHED, '--no-online', '--format', 'json', '--corpus-dir', FIXTURE_CORPUS],
      repo,
      { XDG_CACHE_HOME: cacheDir }
    );

    expect(run.exitCode).not.toBe(2);
    const result = JSON.parse(run.stdout) as ScanResult;
    const finding = result.findings.find((f) => f.ruleId === 'unknown-package');
    expect(finding?.severity).toBe('high');
    expect(finding?.details ?? {}).not.toHaveProperty('onlineResolution');
  }, CLI_TIMEOUT_MS);
});

describe('the init command, through the real binary', () => {
  // init's behaviour is covered in depth in init.test.ts, against the
  // module directly. These two prove the command is actually reachable
  // from the built binary and reports the exit codes it promises, which
  // is the one thing a module-level test cannot show.
  test('installs the hook and exits 0, and a re-run exits 0 without duplicating it', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');

    const first = await runCli(['init'], repo);
    expect(first.exitCode).toBe(0);
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    expect(existsSync(hook)).toBe(true);
    const content = await readFile(hook, 'utf8');
    expect(content).toContain('dep-guard scan --staged');

    const second = await runCli(['init'], repo);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('already installed');
    expect(await readFile(hook, 'utf8')).toBe(content);
  }, CLI_TIMEOUT_MS);

  test('--dry-run writes nothing, and a bad --manager exits 2', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');

    const dry = await runCli(['init', '--dry-run'], repo);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain('dry run');
    expect(existsSync(path.join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false);

    const bad = await runCli(['init', '--manager', 'nonsense'], repo);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain('--manager must be one of');
  }, CLI_TIMEOUT_MS);
});

describe('a first run with no corpus built yet', () => {
  test('omitting --corpus-dir produces an actionable message, not a bare internal path', async () => {
    // This test's whole premise is that core's default corpus path
    // (packages/core/data/corpus) is EMPTY in this checkout. That is true
    // in a clean clone (the directory is gitignored, see the top of
    // scan.ts) but not always true locally: `pnpm corpus:build --out
    // packages/core/data/corpus` or a manual packaging experiment leaves a
    // real corpus sitting exactly there, and against that state this test
    // fails opaquely ("Expected: 2, Received: 0") with no hint of why.
    // Diagnose the precondition explicitly instead of letting the
    // assertions below fail blind. Never skip: a silent skip loses the
    // coverage this test exists for, and the release workflow itself
    // depends on this test's premise -- see the corpus-build step's
    // comment in .github/workflows/release.yml, which is why the build
    // step runs only after `pnpm test`.
    if (existsSync(DEFAULT_CORPUS_DIR)) {
      throw new Error(
        `This test requires no corpus at the default path (${DEFAULT_CORPUS_DIR}), but one ` +
          'exists there. It is probably left over from a local ' +
          '"corpus:build --out packages/core/data/corpus" (or a packaging experiment that ' +
          'wrote there directly) -- packages/core/data/ is gitignored, so this is a local ' +
          'artifact, not something a clean clone would have. Remove that directory and rerun. ' +
          'The release workflow avoids this exact collision by running the corpus build only ' +
          'after `pnpm test`, never before -- see the "Build the shipped corpus" step in ' +
          '.github/workflows/release.yml.'
      );
    }

    await write('package.json', manifestJson({}));
    await commitAll('first');

    const run = await runCli(['scan', '--format', 'json'], repo);

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('corpus-missing');
    expect(run.stderr).toContain('--corpus-dir');
  }, CLI_TIMEOUT_MS);
});
