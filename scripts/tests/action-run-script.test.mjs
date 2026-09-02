// Executes action.yml's "Run dep-guard" step for real, under the exact
// bash invocation GitHub Actions uses for a composite `shell: bash` step:
//
//   bash --noprofile --norc -eo pipefail {0}
//
// That `-e` is the whole point of this file. A review found the step
// opening with `set -uo pipefail`, which ADDS -u and pipefail but does
// nothing to clear the errexit GitHub already turned on. So the moment
// dep-guard exited non-zero -- which is the entire interesting case, a
// scan that found something -- the shell aborted at the npx line and
// never reached `SCAN_STATUS=$?`. GITHUB_OUTPUT was never written, so
// steps.run.outputs.results_file was empty, so the Upload SARIF step had
// nothing to upload and the report step had no exit code to re-raise.
// Findings were silently never uploaded.
//
// No amount of reading action.yml catches that; it needs the script run
// under the right shell flags with a failing stub. Hence this file rather
// than another text guard in action-path-validation.test.mjs.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACTION_PATH = path.join(ROOT, 'action.yml');
const actionYml = readFileSync(ACTION_PATH, 'utf8');

// Pulls one step's `run:` block out of action.yml by step name, keeping
// the real file the single source of truth. A copy of the script pasted
// into this test would pass forever after action.yml drifted away from
// it, which is the exact failure mode the sibling test file's textual
// guards exist to prevent.
function extractRunScript(stepName) {
  const lines = actionYml.split('\n');
  const stepAt = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (stepAt === -1) {
    throw new Error(`no step named ${stepName} in action.yml`);
  }
  const runAt = lines.findIndex((l, i) => i > stepAt && l.trim() === 'run: |');
  if (runAt === -1) {
    throw new Error(`step ${stepName} has no "run: |" block`);
  }
  const indent = lines[runAt].length - lines[runAt].trimStart().length + 2;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) {
      body.push('');
      continue;
    }
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < indent) {
      break;
    }
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

// A stub `npx` that writes a plausible SARIF body to stdout and exits
// with whatever code the test asked for.
function makeStubNpx(exitCode) {
  const binDir = mkdtempSync(path.join(tmpdir(), 'depguard-action-bin-'));
  const stub = path.join(binDir, 'npx');
  writeFileSync(
    stub,
    `#!/bin/sh\necho '{"version":"2.1.0","runs":[]}'\nexit ${exitCode}\n`
  );
  chmodSync(stub, 0o755);
  return binDir;
}

function runStep(exitCode, extraEnv = {}) {
  const script = extractRunScript('Run dep-guard');
  const workspace = mkdtempSync(path.join(tmpdir(), 'depguard-action-ws-'));
  const outputFile = path.join(workspace, 'github-output');
  writeFileSync(outputFile, '');
  const scriptFile = path.join(workspace, 'step.sh');
  writeFileSync(scriptFile, script);
  const binDir = makeStubNpx(exitCode);

  let status = 0;
  let stderr = '';
  try {
    execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        GITHUB_WORKSPACE: workspace,
        GITHUB_OUTPUT: outputFile,
        DG_VERSION: 'latest',
        DG_PATH: '.',
        DG_ONLINE: 'false',
        DG_FAIL_ON: '',
        DG_SARIF_OUTPUT: 'dep-guard-results.sarif',
        ...extraEnv,
      },
    });
  } catch (err) {
    status = typeof err.status === 'number' ? err.status : -1;
    stderr = err.stderr ?? '';
  }

  return {
    status,
    stderr,
    outputs: readFileSync(outputFile, 'utf8'),
    sarifPath: path.join(workspace, 'dep-guard-results.sarif'),
  };
}

describe('action.yml "Run dep-guard", under GitHub bash flags', () => {
  test('records the outputs when dep-guard exits 0', () => {
    const run = runStep(0);
    expect(run.outputs).toContain('exit_code=0');
    expect(run.outputs).toMatch(/results_file=.*dep-guard-results\.sarif/);
    expect(existsSync(run.sarifPath)).toBe(true);
  });

  test('records the outputs when dep-guard exits 1, the case that was broken', () => {
    // Under the old `set -uo pipefail`, errexit was still live from
    // GitHub's own invocation and the script died right here, so none of
    // these three assertions could hold.
    const run = runStep(1);
    expect(run.outputs).toContain('exit_code=1');
    expect(run.outputs).toMatch(/results_file=.*dep-guard-results\.sarif/);
    expect(existsSync(run.sarifPath)).toBe(true);
  });

  test('records the outputs when dep-guard exits 2', () => {
    const run = runStep(2);
    expect(run.outputs).toContain('exit_code=2');
    expect(existsSync(run.sarifPath)).toBe(true);
  });

  test('the step itself always succeeds, so later steps are reachable', () => {
    // The step deliberately exits 0 whatever dep-guard said: the upload
    // has to happen before the run is failed, and the real code is
    // re-raised by the report step afterwards. A non-zero here would skip
    // the upload for exactly the scans whose SARIF matters.
    for (const code of [0, 1, 2]) {
      expect([code, runStep(code).status]).toEqual([code, 0]);
    }
  });

  test('the SARIF file holds only the scanner stdout, with no shell noise', () => {
    const run = runStep(1);
    const body = readFileSync(run.sarifPath, 'utf8');
    expect(() => JSON.parse(body)).not.toThrow();
  });

  test('passes --no-online unless the online input asked for it', () => {
    // Proven through the file the stub writes rather than by reading
    // action.yml, so it covers the argument assembly as executed.
    const binDir = mkdtempSync(path.join(tmpdir(), 'depguard-action-bin-'));
    const stub = path.join(binDir, 'npx');
    writeFileSync(stub, `#!/bin/sh\necho "$@"\nexit 0\n`);
    chmodSync(stub, 0o755);

    const script = extractRunScript('Run dep-guard');
    const workspace = mkdtempSync(path.join(tmpdir(), 'depguard-action-ws-'));
    const outputFile = path.join(workspace, 'github-output');
    writeFileSync(outputFile, '');
    const scriptFile = path.join(workspace, 'step.sh');
    writeFileSync(scriptFile, script);

    const invoke = (online) => {
      execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          GITHUB_WORKSPACE: workspace,
          GITHUB_OUTPUT: outputFile,
          DG_VERSION: 'latest',
          DG_PATH: '.',
          DG_ONLINE: online,
          DG_FAIL_ON: '',
          DG_SARIF_OUTPUT: 'args.txt',
        },
      });
      return readFileSync(path.join(workspace, 'args.txt'), 'utf8');
    };

    expect(invoke('false')).toContain('--no-online');
    expect(invoke('true')).toContain('--online');
    expect(invoke('true')).not.toContain('--no-online');
  });
});

describe('action.yml "Report dep-guard result", under GitHub bash flags', () => {
  function runReport(exitCode) {
    const workspace = mkdtempSync(path.join(tmpdir(), 'depguard-action-report-'));
    const scriptFile = path.join(workspace, 'report.sh');
    writeFileSync(scriptFile, extractRunScript('Report dep-guard result'));
    try {
      const stdout = execFileSync(
        'bash',
        ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH ?? '', DG_EXIT_CODE: exitCode },
        }
      );
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      return {
        status: typeof err.status === 'number' ? err.status : -1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
      };
    }
  }

  test('re-raises dep-guard exit codes unchanged', () => {
    expect(runReport('0').status).toBe(0);
    expect(runReport('1').status).toBe(1);
    // The one that must not become 1.
    expect(runReport('2').status).toBe(2);
  });

  test('says exit 2 is not a clean scan, in different words from findings', () => {
    expect(runReport('2').stdout).toContain('could not complete');
    expect(runReport('1').stdout).toContain('blocking findings');
  });

  test('fails rather than passing when no exit code was recorded at all', () => {
    // Reachable now that this step runs under always(): an input that
    // failed validation means the run step never wrote an exit code. A
    // bare `exit ""` is a bash usage error, so the step would have failed
    // for a reason unrelated to the scan, with a confusing message.
    const run = runReport('');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('did not run to completion');
  });
});

describe('action.yml step wiring', () => {
  test('the upload and report steps run even when an earlier step failed', () => {
    // if: always() is what keeps the upload reachable if anything above
    // it goes wrong. Without it, a failure anywhere earlier skips the
    // upload silently.
    const uploadAt = actionYml.indexOf('- name: Upload SARIF');
    const reportAt = actionYml.indexOf('- name: Report dep-guard result');
    expect(uploadAt).toBeGreaterThan(-1);
    expect(reportAt).toBeGreaterThan(uploadAt);
    const uploadBlock = actionYml.slice(uploadAt, reportAt);
    const reportBlock = actionYml.slice(reportAt);
    expect(uploadBlock).toContain('always()');
    expect(reportBlock).toContain('always()');
  });

  test('does not reintroduce a set line that leaves errexit live', () => {
    // `set -uo pipefail` reads like it configures the shell but leaves
    // GitHub's own -e in place, which is what made the status line
    // unreachable.
    const script = extractRunScript('Run dep-guard');
    expect(script).not.toMatch(/^\s*set -uo pipefail\s*$/m);
    expect(script).toMatch(/set \+e|\|\| SCAN_STATUS=\$\?/);
  });
});
