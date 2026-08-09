import { execFile } from 'node:child_process';
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

async function runCli(args: string[], cwd: string): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI_ENTRY, ...args], {
      cwd,
      encoding: 'utf8',
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

describe('a first run with no corpus built yet', () => {
  test('omitting --corpus-dir produces an actionable message, not a bare internal path', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');

    const run = await runCli(['scan', '--format', 'json'], repo);

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('corpus-missing');
    expect(run.stderr).toContain('--corpus-dir');
  }, CLI_TIMEOUT_MS);
});
