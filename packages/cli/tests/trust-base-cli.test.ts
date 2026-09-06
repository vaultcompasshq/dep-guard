import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ScanResult } from '@vaultcompass/dep-guard-core';
import { SARIF_TRUST_BASE_NOTIFICATION_ID } from '../src/output-sarif.js';

// The CLI half of pull-request mode: the flag reaches core, the text
// report prints the proposals, SARIF carries them as notifications rather
// than results, an unusable ref exits 2 with one line on stderr, and a run
// without the flag is byte-identical to what it was before the flag
// existed.
//
// Drives the real built dist/cli.js as a child process in a temp git
// repository, the same pattern cli.test.ts uses, and builds first for the
// same reason: dist has to reflect src.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..', '..');
const FIXTURE_CORPUS = path.join(ROOT, 'packages', 'core', 'fixtures', 'corpus');
const CLI_ENTRY = path.join(ROOT, 'packages', 'cli', 'dist', 'cli.js');
const TSC_BIN = path.join(ROOT, 'node_modules', '.bin', 'tsc');

const execFileAsync = promisify(execFile);

const BUILD_TIMEOUT_MS = 120000;
const CLI_TIMEOUT_MS = 20000;

const UNKNOWN_NAME = 'reeact-definitely-not-real';

let tempDirs: string[] = [];
let repo = '';

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repo, encoding: 'utf8' });
  return stdout;
}

async function write(relPath: string, content: string): Promise<void> {
  await writeFile(path.join(repo, relPath), content, 'utf8');
}

async function commitAll(message: string): Promise<void> {
  await git('add', '-A');
  await git('commit', '-q', '-m', message);
}

interface CliRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[]): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI_ENTRY, ...args], {
      cwd: repo,
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

function manifestJson(dependencies: Record<string, string>): string {
  return JSON.stringify({ name: 'root', version: '1.0.0', dependencies }, null, 2);
}

function lockJson(dependencies: Record<string, string>): string {
  const packages: Record<string, unknown> = {
    '': { name: 'root', version: '1.0.0', dependencies },
  };
  for (const name of Object.keys(dependencies)) {
    packages[`node_modules/${name}`] = {
      version: '1.0.0',
      resolved: `https://registry.npmjs.org/${name}/-/pkg-1.0.0.tgz`,
      integrity: 'sha512-notreal',
    };
  }
  return JSON.stringify(
    { name: 'root', version: '1.0.0', lockfileVersion: 3, requires: true, packages },
    null,
    2
  );
}

/** Base branch with an approved config, then a feature branch that adds a
 *  dependency the corpus does not know and allows it in the same commit. */
async function makeMutingPullRequest(): Promise<void> {
  await write('package.json', manifestJson({}));
  await write('package-lock.json', lockJson({}));
  await write('.dep-guard.json', JSON.stringify({ failOn: 'medium' }));
  await commitAll('base state');
  await git('checkout', '-q', '-b', 'feature');
  await write('package.json', manifestJson({ [UNKNOWN_NAME]: '1.0.0' }));
  await write('package-lock.json', lockJson({ [UNKNOWN_NAME]: '1.0.0' }));
  await write('.dep-guard.json', JSON.stringify({ failOn: 'medium', allow: [UNKNOWN_NAME] }));
  await commitAll('add the dependency and allow it');
}

beforeAll(async () => {
  await execFileAsync(TSC_BIN, ['-b', 'packages/core', 'packages/cli'], { cwd: ROOT });
}, BUILD_TIMEOUT_MS);

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-trust-cli-'));
  tempDirs.push(repo);
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

describe('dep-guard scan --trust-base', () => {
  test('the muting allow entry does not take, and the text report names it', async () => {
    await makeMutingPullRequest();

    const run = await runCli([
      'scan',
      '--base',
      'main',
      '--trust-base',
      'main',
      '--corpus-dir',
      FIXTURE_CORPUS,
    ]);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain(UNKNOWN_NAME);
    expect(run.stdout).toContain('Pull-request mode: control inputs from main');
    expect(run.stdout).toContain(
      `config changed in this pull request (proposed: allow ${UNKNOWN_NAME})`
    );
    // The allow counter reports the BASE list, which cleared nothing.
    expect(run.stdout).toContain('0 allowed');
  }, CLI_TIMEOUT_MS);

  test('a run in pull-request mode with nothing proposed still says so', async () => {
    await write('package.json', manifestJson({}));
    await write('package-lock.json', lockJson({}));
    await write('.dep-guard.json', JSON.stringify({ failOn: 'medium' }));
    await commitAll('base state');
    await git('checkout', '-q', '-b', 'feature');
    await write('package.json', manifestJson({ [UNKNOWN_NAME]: '1.0.0' }));
    await write('package-lock.json', lockJson({ [UNKNOWN_NAME]: '1.0.0' }));
    await commitAll('add the dependency and nothing else');

    const run = await runCli([
      'scan',
      '--base',
      'main',
      '--trust-base',
      'main',
      '--corpus-dir',
      FIXTURE_CORPUS,
    ]);

    expect(run.stdout).toContain('Pull-request mode: control inputs from main');
    expect(run.stdout).toContain('no control input changed in this pull request');
  }, CLI_TIMEOUT_MS);

  test('the JSON carries the trustBase block in the documented shape', async () => {
    await makeMutingPullRequest();

    const run = await runCli([
      'scan',
      '--base',
      'main',
      '--trust-base',
      'main',
      '--format',
      'json',
      '--corpus-dir',
      FIXTURE_CORPUS,
    ]);

    const result = JSON.parse(run.stdout.trim()) as ScanResult;
    expect(result.trustBase).toEqual({
      ref: 'main',
      proposals: [`config changed in this pull request (proposed: allow ${UNKNOWN_NAME})`],
      configChanged: true,
      baselineChanged: false,
      configShapeChange: null,
      baselineShapeChange: null,
    });
    expect(result.exitCode).toBe(1);
    expect(run.exitCode).toBe(1);
  }, CLI_TIMEOUT_MS);

  test('SARIF carries each proposal as a notification, never as a result', async () => {
    await makeMutingPullRequest();

    const run = await runCli([
      'scan',
      '--base',
      'main',
      '--trust-base',
      'main',
      '--format',
      'sarif',
      '--corpus-dir',
      FIXTURE_CORPUS,
    ]);

    const sarif = JSON.parse(run.stdout) as {
      runs: {
        results: { ruleId: string }[];
        invocations?: {
          executionSuccessful: boolean;
          toolExecutionNotifications: {
            descriptor: { id: string };
            level: string;
            message: { text: string };
          }[];
        }[];
      }[];
    };
    const sarifRun = sarif.runs[0];

    // The finding is a result. The proposal is not.
    expect(sarifRun.results).toHaveLength(1);
    expect(sarifRun.results[0].ruleId).toBe('dep-guard/unknown-package');

    const notifications = sarifRun.invocations?.[0]?.toolExecutionNotifications ?? [];
    expect(notifications).toHaveLength(1);
    expect(notifications[0].descriptor.id).toBe(SARIF_TRUST_BASE_NOTIFICATION_ID);
    expect(notifications[0].level).toBe('note');
    expect(notifications[0].message.text).toContain('config changed in this pull request');
    expect(notifications[0].message.text).toContain('control inputs read from main');
    expect(sarifRun.invocations?.[0]?.executionSuccessful).toBe(true);
  }, CLI_TIMEOUT_MS);

  test('an unresolvable ref exits 2 with one line on stderr and nothing on stdout', async () => {
    await makeMutingPullRequest();

    const run = await runCli([
      'scan',
      '--base',
      'main',
      '--trust-base',
      'origin/nope',
      '--corpus-dir',
      FIXTURE_CORPUS,
    ]);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr.trim().split('\n')).toHaveLength(1);
    expect(run.stderr).toContain('origin/nope');
    expect(run.stderr).toContain('fetch-depth: 0');
    expect(run.stderr).toContain('(trust-base-unresolvable)');
  }, CLI_TIMEOUT_MS);

  test('a ref resolving to HEAD exits 2 rather than reporting pull-request mode as on', async () => {
    await makeMutingPullRequest();

    const run = await runCli([
      'scan',
      '--base',
      'main',
      '--trust-base',
      'HEAD',
      '--corpus-dir',
      FIXTURE_CORPUS,
    ]);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('(trust-base-is-head)');
  }, CLI_TIMEOUT_MS);

  test('check takes the flag too, and a head-side allow entry does not clear a name', async () => {
    await makeMutingPullRequest();

    const run = await runCli([
      'check',
      UNKNOWN_NAME,
      '--trust-base',
      'main',
      '--format',
      'json',
      '--corpus-dir',
      FIXTURE_CORPUS,
    ]);

    const result = JSON.parse(run.stdout.trim()) as ScanResult;
    expect(result.allowed).toBe(0);
    expect(result.findings.some((finding) => finding.ruleId === 'unknown-package')).toBe(true);
    expect(result.trustBase?.ref).toBe('main');
    expect(run.exitCode).toBe(1);
  }, CLI_TIMEOUT_MS);
});

describe('no-flag parity at the CLI', () => {
  test('the text report without the flag has no pull-request block at all', async () => {
    await makeMutingPullRequest();

    const run = await runCli(['scan', '--base', 'main', '--corpus-dir', FIXTURE_CORPUS]);

    // The head-side allow entry still applies outside pull-request mode:
    // a local checkout is inside the trust boundary, deliberately.
    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toContain('Pull-request mode');
    expect(run.stdout).toContain('1 allowed');
  }, CLI_TIMEOUT_MS);

  test('the JSON without the flag carries no trustBase key', async () => {
    await makeMutingPullRequest();

    const run = await runCli([
      'scan',
      '--base',
      'main',
      '--format',
      'json',
      '--corpus-dir',
      FIXTURE_CORPUS,
    ]);

    const parsed = JSON.parse(run.stdout.trim()) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, 'trustBase')).toBe(false);
  }, CLI_TIMEOUT_MS);

  test('the SARIF without the flag carries no invocations block', async () => {
    await makeMutingPullRequest();

    const run = await runCli([
      'scan',
      '--base',
      'main',
      '--format',
      'sarif',
      '--corpus-dir',
      FIXTURE_CORPUS,
    ]);

    const sarif = JSON.parse(run.stdout) as { runs: Record<string, unknown>[] };
    expect(Object.prototype.hasOwnProperty.call(sarif.runs[0], 'invocations')).toBe(false);
  }, CLI_TIMEOUT_MS);
});
