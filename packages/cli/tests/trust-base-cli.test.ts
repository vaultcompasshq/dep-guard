import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
      npmrcChanged: false,
      configShapeChange: null,
      baselineShapeChange: null,
      npmrcShapeChange: null,
      projectPathsChanged: false,
      ignoredPathsMadeProjects: [],
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

describe('dep-guard scan: a lockfile downgrade is could-not-run at the CLI', () => {
  async function makeYarnSwitchPullRequest(): Promise<void> {
    await write('package.json', manifestJson({ lodash: '1.0.0' }));
    await write('package-lock.json', lockJson({ lodash: '1.0.0' }));
    await commitAll('base state');
    await git('checkout', '-q', '-b', 'feature');
    await rm(path.join(repo, 'package-lock.json'));
    await write('yarn.lock', '# yarn lockfile v1\n');
    await commitAll('switch to yarn');
  }

  test('--base with --trust-base exits 2 with lockfile-downgrade on stderr', async () => {
    await makeYarnSwitchPullRequest();

    const run = await runCli(['scan', '--base', 'main', '--trust-base', 'main', '--corpus-dir', FIXTURE_CORPUS]);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('(lockfile-downgrade)');
  }, CLI_TIMEOUT_MS);

  test('--trust-base alone compares the lockfile set against the trust base and exits 2', async () => {
    await makeYarnSwitchPullRequest();

    const run = await runCli(['scan', '--trust-base', 'main', '--corpus-dir', FIXTURE_CORPUS]);

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('(lockfile-downgrade)');
  }, CLI_TIMEOUT_MS);
});

// H1 at the CLI (docs/design/2026-10-18-head-defined-projects-and-ignore-paths.md,
// section 7, "the CLI case"): a pull request that wires a directory the base
// ignores into the install keeps its findings, in every output format.
describe('a change that wires an ignored path into the install, at the CLI (0.16.0)', () => {
  async function writeDeep(relPath: string, content: string): Promise<void> {
    await mkdir(path.dirname(path.join(repo, relPath)), { recursive: true });
    await write(relPath, content);
  }

  async function makeWiringPullRequest(): Promise<void> {
    await write('package.json', manifestJson({}));
    await write('package-lock.json', lockJson({}));
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['fixtures'] }));
    await commitAll('base state');
    await git('checkout', '-q', '-b', 'feature');
    await write('package.json', manifestJson({ helper: 'file:fixtures/helper' }));
    await writeDeep('fixtures/helper/package.json', manifestJson({ [UNKNOWN_NAME]: '1.0.0' }));
    await commitAll('wire fixtures/helper into the install');
  }

  const PROPOSAL =
    'ignorePaths: this change makes ignored path fixtures/helper/package.json a project ' +
    '(the target of a file:, link: or portal: dependency); its findings are kept';

  test('H1 CLI text: the finding is kept, the proposal printed, and the summary counts it', async () => {
    await makeWiringPullRequest();

    const run = await runCli(['scan', '--base', 'main', '--trust-base', 'main', '--corpus-dir', FIXTURE_CORPUS]);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain(UNKNOWN_NAME);
    expect(run.stdout).toContain(`  ${PROPOSAL}`);
    expect(run.stdout).not.toContain('no control input changed in this pull request');
    expect(run.stdout).toMatch(/0 ignored, [1-9]\d* kept over ignorePaths, /);
  }, CLI_TIMEOUT_MS);

  test('H1 CLI JSON: ignoreKept, the trustBase fields, and ignoreOverride on the finding', async () => {
    await makeWiringPullRequest();

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
    expect(result.ignored).toBe(0);
    expect(result.ignoreKept).toBe(result.findings.length);
    expect(result.trustBase?.proposals).toEqual([PROPOSAL]);
    expect(result.trustBase?.projectPathsChanged).toBe(true);
    expect(result.trustBase?.ignoredPathsMadeProjects).toEqual(['fixtures/helper/package.json']);
    expect(result.findings[0].ignoreOverride).toEqual({
      entries: ['fixtures'],
      position: 'the target of a file:, link: or portal: dependency',
    });
    expect(run.exitCode).toBe(1);
  }, CLI_TIMEOUT_MS);

  test('H1 CLI SARIF: the proposal is a notification and the kept result carries ignoreOverride', async () => {
    await makeWiringPullRequest();

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
        properties: Record<string, unknown>;
        results: { properties: Record<string, unknown> }[];
        invocations?: { toolExecutionNotifications: { message: { text: string } }[] }[];
      }[];
    };
    const sarifRun = sarif.runs[0];
    expect(sarifRun.properties.ignoreKept).toBe(sarifRun.results.length);
    expect(sarifRun.results[0].properties.ignoreOverride).toEqual({
      entries: ['fixtures'],
      position: 'the target of a file:, link: or portal: dependency',
    });
    const texts = (sarifRun.invocations?.[0]?.toolExecutionNotifications ?? []).map((note) => note.message.text);
    expect(texts).toEqual([`${PROPOSAL} (control inputs read from main)`]);
  }, CLI_TIMEOUT_MS);
});

// Audit B2 at the CLI (design note section 8, U10 and U11). An online
// budget of 0 is spent before the first step, so no request is made.
describe('an unchecked name on a pull request is exit 2 with the full report, at the CLI (0.16.0)', () => {
  async function makeP1(headConfig: Record<string, unknown> | null = null): Promise<void> {
    await write('requirements.txt', 'requests==2.31.0\n');
    await write('.dep-guard.json', '{}');
    await commitAll('base state');
    await git('checkout', '-q', '-b', 'feature');
    await write('requirements.txt', 'requests==2.31.0\nzz-dg-audit-nonexist-1018==1.0.0\nreqeusts==1.0.0\n');
    if (headConfig !== null) {
      await write('.dep-guard.json', JSON.stringify(headConfig));
    }
    await commitAll('add two names');
  }

  const ARGS = ['--base', 'main', '--trust-base', 'main', '--online', '--online-budget-ms', '0', '--corpus-dir', FIXTURE_CORPUS];

  type SarifInvocations = {
    runs: {
      properties: Record<string, unknown>;
      invocations?: {
        executionSuccessful: boolean;
        toolExecutionNotifications: { descriptor: { id: string }; level: string; message: { text: string } }[];
      }[];
    }[];
  };

  test('U11 SARIF with a proposal: one invocation holding the proposal note and the error', async () => {
    await makeP1({ failOn: 'critical' });

    const run = await runCli(['scan', ...ARGS, '--format', 'sarif']);

    expect(run.exitCode).toBe(2);
    const sarifRun = (JSON.parse(run.stdout) as SarifInvocations).runs[0];
    expect(sarifRun.invocations).toHaveLength(1);
    const invocation = sarifRun.invocations?.[0];
    expect(invocation?.executionSuccessful).toBe(false);
    expect(invocation?.toolExecutionNotifications.map((note) => [note.descriptor.id, note.level])).toEqual([
      [SARIF_TRUST_BASE_NOTIFICATION_ID, 'note'],
      ['dep-guard/could-not-run', 'error'],
    ]);
    expect(invocation?.toolExecutionNotifications[1].message.text).toContain('(online-names-unchecked)');
    expect(sarifRun.properties.onlineUnchecked).toBe(2);
    expect(run.stderr).toContain('(online-names-unchecked)');
  }, CLI_TIMEOUT_MS);

  test('U11 SARIF without a proposal: an invocation with the error alone', async () => {
    await makeP1();

    const run = await runCli(['scan', ...ARGS, '--format', 'sarif']);

    expect(run.exitCode).toBe(2);
    const invocations = (JSON.parse(run.stdout) as SarifInvocations).runs[0].invocations ?? [];
    expect(invocations).toHaveLength(1);
    expect(invocations[0].executionSuccessful).toBe(false);
    expect(invocations[0].toolExecutionNotifications.map((note) => note.level)).toEqual(['error']);
  }, CLI_TIMEOUT_MS);

  test('U11 JSON: run.online.unchecked and run.couldNotRun, exit 2', async () => {
    await makeP1({ failOn: 'critical' });

    const run = await runCli(['scan', ...ARGS, '--format', 'json']);

    expect(run.exitCode).toBe(2);
    const result = JSON.parse(run.stdout.trim()) as ScanResult;
    expect(result.exitCode).toBe(2);
    expect(result.run.online.unchecked?.count).toBe(2);
    expect(result.run.couldNotRun?.code).toBe('online-names-unchecked');
    expect(result.trustBase?.proposals.length).toBeGreaterThan(0);
  }, CLI_TIMEOUT_MS);

  test('U10 text and stderr list ten names and a count', async () => {
    await write('requirements.txt', 'requests==2.31.0\n');
    await commitAll('base state');
    await git('checkout', '-q', '-b', 'feature');
    const names = Array.from({ length: 12 }, (_unused, index) => `name-${String(index + 1).padStart(2, '0')}`);
    await write('requirements.txt', `requests==2.31.0\n${names.map((name) => `${name}==1`).join('\n')}\n`);
    await commitAll('add twelve names');

    const run = await runCli(['scan', ...ARGS]);

    expect(run.exitCode).toBe(2);
    for (const stream of [run.stdout, run.stderr]) {
      expect(stream).toContain('could not run: 12 candidate name(s) were not checked online (name-01:');
      expect(stream).toContain('name-10: online budget spent (pypi-existence), and 2 more)');
      expect(stream).not.toContain('name-11:');
    }
    expect(run.stderr).toContain('(online-names-unchecked)');
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
