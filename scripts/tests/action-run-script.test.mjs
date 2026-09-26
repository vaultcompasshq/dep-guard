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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAction } from '../lib/action-steps.mjs';
import { readActionVersionDefault } from '../lib/release-kind.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Overridable so a mutation run can point the whole suite at a deliberately
// weakened copy and watch which assertions go red. Nothing in CI sets it, and
// the default is the real file. A test that cannot be made to fail on demand
// is a test nobody has checked.
const ACTION_PATH = process.env.DG_ACTION_FILE ?? path.join(ROOT, 'action.yml');

// The step parser lives in scripts/lib/action-steps.mjs because a second
// caller runs these same scripts against REAL npm: bench/action-install.mjs.
// Two copies of the parser would drift, and both callers would keep passing
// against their own idea of what action.yml says.
const action = loadAction(ACTION_PATH);
const actionYml = action.text;
const { extractRunScript, evaluateStepEnv, cwdForStep } = action;

const DEFAULT_INPUTS = {
  version: '0.7.0',
  path: '.',
  online: 'false',
  'fail-on': '',
  'sarif-output': 'dep-guard-results.sarif',
  'upload-sarif': 'true',
  'trust-base': '',
  base: '',
};

// A runner: a checkout, a runner temp, and the scanner installed where the
// install step would have put it.
//
// The planted files are the attack the install boundary exists to close, and
// the head's own node_modules/.bin goes FIRST on PATH, which is the ordering a
// workflow with an earlier install step actually produces. Without that
// ordering, "the planted copy never ran" would hold for the uninteresting
// reason that nothing could have reached it.
function makeRunner(inputs = {}, npmVersion = '10.9.2') {
  const dir = mkdtempSync(path.join(tmpdir(), 'depguard-action-'));
  const workspace = path.join(dir, 'workspace');
  const runnerTemp = path.join(dir, 'runner-temp');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });

  const ctx = { inputs: { ...DEFAULT_INPUTS, ...inputs }, runnerTemp, workspace };
  const env = evaluateStepEnv('Run dep-guard', ctx);

  const plantedRecord = path.join(dir, 'planted.txt');
  const npxRecord = path.join(dir, 'npx.txt');
  const npmRecord = path.join(dir, 'npm.txt');
  mkdirSync(path.join(workspace, 'node_modules/.bin'), { recursive: true });
  writeFileSync(
    path.join(workspace, 'node_modules/.bin/dep-guard'),
    `#!/bin/sh\necho PLANTED >> ${JSON.stringify(plantedRecord)}\necho 'PLANTED node_modules COPY RAN'\nexit 0\n`
  );
  chmodSync(path.join(workspace, 'node_modules/.bin/dep-guard'), 0o755);
  writeFileSync(path.join(workspace, '.npmrc'), 'registry=http://127.0.0.1:9/\n');

  const pathDir = path.join(dir, 'path-bin');
  mkdirSync(pathDir, { recursive: true });
  writeFileSync(
    path.join(pathDir, 'npx'),
    `#!/bin/sh\necho NPX >> ${JSON.stringify(npxRecord)}\nexit 0\n`
  );
  chmodSync(path.join(pathDir, 'npx'), 0o755);

  // npm records its argv AND the directory it was started in. The second one
  // is the point: npm started inside the checkout reads the head's .npmrc,
  // package.json and lockfile, and no assertion about the run step can see
  // that, because by then the install has already happened.
  writeFileSync(
    path.join(pathDir, 'npm'),
    `#!/bin/sh\nprintf 'cwd=%s\\n' "$(pwd -P)" >> ${JSON.stringify(npmRecord)}\n` +
      `printf 'argv=%s\\n' "$*" >> ${JSON.stringify(npmRecord)}\n` +
      `printf 'prefix=%s\\n' "\${npm_config_prefix:-unset}" >> ${JSON.stringify(npmRecord)}\n` +
      // Also creates <prefix>/lib on an install, because a real global install
      // does, and the step writes a manifest there and verifies from inside
      // it. A stub that only recorded argv would abort the step on a missing
      // directory, which is the harness failing rather than the action, and it
      // would hide whether the verification runs at all.
      // A real npm answers `--version`, and the step now reads it: below
      // 10.5.2 the verification calls a clean install tampered with. Written
      // with `%b` so a test can hand it MULTIPLE lines and reproduce a client
      // printing an upgrade notice above its version, the shape that defeated
      // two earlier versions of the floor in a sibling repository.
      `case "$1" in --version) printf '%b\\n' "${npmVersion}" ;; ` +
      'install) mkdir -p "${npm_config_prefix}/lib" ;; esac\n' +
      'exit 0\n'
  );
  chmodSync(path.join(pathDir, 'npm'), 0o755);

  return { dir, workspace, runnerTemp, ctx, env, plantedRecord, npxRecord, npmRecord, pathDir };
}

// The scanner the install step would have left behind, at the absolute path
// action.yml says to call, writing a SARIF body and recording its own cwd.
function installStubScanner(runner, { exitCode = 0, body = '{"version":"2.1.0","runs":[]}', echoArgs = false } = {}) {
  const target = runner.env.DG_BIN;
  if (!target || !target.startsWith('/')) {
    throw new Error(`action.yml did not give the run step an absolute DG_BIN (got ${target})`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const cwdRecord = path.join(runner.dir, 'scanner-cwd.txt');
  writeFileSync(
    target,
    `#!/bin/sh\npwd -P >> ${JSON.stringify(cwdRecord)}\n` +
      (echoArgs ? 'echo "$@"\n' : `echo '${body}'\n`) +
      `exit ${exitCode}\n`
  );
  chmodSync(target, 0o755);
  runner.cwdRecord = cwdRecord;
  return runner;
}

// The argument vector the step actually builds, read back from the file the
// stub scanner writes. Proven as executed rather than by matching the YAML.
function argvFor(inputs = {}, extraEnv = {}) {
  const script = extractRunScript('Run dep-guard');
  const runner = makeRunner(inputs);
  installStubScanner(runner, { echoArgs: true });

  const outputFile = path.join(runner.dir, 'github-output');
  writeFileSync(outputFile, '');
  const scriptFile = path.join(runner.dir, 'step.sh');
  writeFileSync(scriptFile, script);

  execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: cwdForStep('Run dep-guard', runner.ctx),
    env: {
      PATH: `${path.join(runner.workspace, 'node_modules/.bin')}:${runner.pathDir}:${process.env.PATH ?? ''}`,
      GITHUB_WORKSPACE: runner.workspace,
      GITHUB_OUTPUT: outputFile,
      ...runner.env,
      ...extraEnv,
    },
  });

  const target = runner.ctx.inputs['sarif-output'];
  return readFileSync(path.join(runner.workspace, target), 'utf8');
}

function runStep(exitCode, extraEnv = {}, inputs = {}) {
  const script = extractRunScript('Run dep-guard');
  const runner = makeRunner(inputs);
  installStubScanner(runner, { exitCode });

  const outputFile = path.join(runner.dir, 'github-output');
  writeFileSync(outputFile, '');
  const scriptFile = path.join(runner.dir, 'step.sh');
  writeFileSync(scriptFile, script);

  let status = 0;
  let stderr = '';
  try {
    execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: cwdForStep('Run dep-guard', runner.ctx),
      env: {
        PATH: `${path.join(runner.workspace, 'node_modules/.bin')}:${runner.pathDir}:${process.env.PATH ?? ''}`,
        GITHUB_WORKSPACE: runner.workspace,
        GITHUB_OUTPUT: outputFile,
        ...runner.env,
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
    runner,
    outputs: readFileSync(outputFile, 'utf8'),
    sarifPath: path.join(runner.workspace, 'dep-guard-results.sarif'),
    plantedRan: existsSync(runner.plantedRecord),
    npxRan: existsSync(runner.npxRecord),
    scannerCwd: existsSync(runner.cwdRecord)
      ? readFileSync(runner.cwdRecord, 'utf8').trim()
      : '',
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
    const invoke = (online) => argvFor({ online, 'sarif-output': 'args.txt' });
    expect(invoke('false')).toContain('--no-online');
    expect(invoke('true')).toContain('--online');
    expect(invoke('true')).not.toContain('--no-online');
  });

  test('passes --trust-base on a pull_request event and nowhere else', () => {
    // Same shape as the online test above, and for the same reason: the
    // argument assembly is proven as executed rather than by reading
    // action.yml. GITHUB_BASE_REF is set by GitHub on, and only on, a
    // pull_request event, so it is what decides the default here.
    const invoke = (env, inputs = {}) =>
      argvFor({ 'sarif-output': 'args.txt', ...inputs }, env);

    // A push or schedule run: no base ref, no flag, behaviour unchanged.
    expect(invoke({})).not.toContain('--trust-base');

    // A pull_request run: the base branch's remote-tracking ref. Bare
    // "main" would not resolve after a detached-HEAD checkout, so the
    // origin/ prefix is part of what this asserts.
    expect(invoke({ GITHUB_BASE_REF: 'main' })).toContain('--trust-base origin/main');

    // An explicit input REDIRECTS pull-request mode; it never disables it.
    // There is no value that disables it, which the validate step enforces
    // and the describe block below pins.
    expect(
      invoke({ GITHUB_BASE_REF: 'main' }, { 'trust-base': 'origin/release' })
    ).toContain('--trust-base origin/release');
  });

  test('passes --base by default on a pull_request event, and redirects only off it', () => {
    // Unlike --trust-base, an explicit `base` input cannot redirect a
    // pull_request run: the validate step refuses that combination before
    // this step is ever reached (see "Validate inputs, base" below), because
    // a pull request could otherwise point comparison at its own head or
    // branch and empty the delta. This step only proves the argv shape for
    // the combinations validate would actually let through.
    const invoke = (env, inputs = {}) =>
      argvFor({ 'sarif-output': 'args.txt', ...inputs }, env);

    // A push or schedule run: no base ref, no flag, behaviour unchanged.
    expect(invoke({})).not.toContain('--base');

    // A pull_request run with no explicit `base`: the base branch's
    // remote-tracking ref, same origin/ prefix reasoning as --trust-base
    // (a bare "main" would not resolve after a detached-HEAD checkout).
    expect(invoke({ GITHUB_BASE_REF: 'main' })).toContain('--base origin/main');

    // An explicit `base` input redirects comparison off a pull_request
    // event, same as `trust-base` does off that event. On a pull_request
    // event this combination is refused at validate instead of reaching
    // this step at all; see the describe block below.
    expect(invoke({}, { base: 'origin/release' })).toContain('--base origin/release');
  });
});

// The install step, run for real with npm stubbed.
//
// This describe block exists because a review deleted the whole install step
// from a copy of action.yml and every test still passed. The run-step tests
// below are the WEAKER half of the boundary: they prove the scanner is called
// by absolute path, but the harness plants the stub at that path itself, so
// they hold whether or not anything ever installed it there. Where npm is
// started, and with what prefix, is the half that keeps the head's .npmrc out
// of the decision, and nothing was checking it.
describe('action.yml "Install dep-guard outside the workspace"', () => {
  function runInstall(inputs = {}, npmVersion = '10.9.2') {
    const runner = makeRunner(inputs, npmVersion);
    const scriptFile = path.join(runner.dir, 'install.sh');
    writeFileSync(scriptFile, extractRunScript('Install dep-guard outside the workspace'));
    let status = 0;
    try {
      execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: cwdForStep('Install dep-guard outside the workspace', runner.ctx),
        env: {
          PATH: `${path.join(runner.workspace, 'node_modules/.bin')}:${runner.pathDir}:${process.env.PATH ?? ''}`,
          GITHUB_WORKSPACE: runner.workspace,
          ...evaluateStepEnv('Install dep-guard outside the workspace', runner.ctx),
        },
      });
    } catch (err) {
      status = typeof err.status === 'number' ? err.status : -1;
    }
    const record = existsSync(runner.npmRecord) ? readFileSync(runner.npmRecord, 'utf8') : '';
    return { runner, status, record };
  }

  test('installs the pinned version globally, and nothing else', () => {
    const run = runInstall();
    expect(run.status).toBe(0);
    expect(run.record).toContain('argv=install -g --ignore-scripts @vaultcompass/dep-guard@0.7.0');
  });

  test('installs the version the input asked for, not a hardcoded one', () => {
    expect(runInstall({ version: '0.5.0' }).record).toContain(
      'argv=install -g --ignore-scripts @vaultcompass/dep-guard@0.5.0'
    );
  });

  test('refuses an npm too old to verify, rather than calling a clean install tampered with', () => {
    // `npm audit signatures` is not version-stable. Below 10.5.2 it fails on a
    // CLEAN install of these very packages: on 10.5.0 it says "Someone might
    // have tampered with these packages", naming ours; on 10.2.4 it is
    // EEXPIREDSIGNATUREKEY. Both false and both alarming.
    //
    // THE SETUP-NODE STEP DOES NOT COVER THIS, which is why the check exists.
    // `node-version: '22'` is a major-only spec and Node 22.0.0 ships npm
    // 10.5.1, inside the failing band; setup-node satisfies a major from the
    // runner's tool cache when it can.
    for (const old of ['8.19.4', '9.9.4', '10.2.4', '10.5.0', '10.5.1']) {
      const run = runInstall({}, old);
      expect([old, run.status]).not.toEqual([old, 0]);
      // It must not have installed anything with a client it cannot use.
      expect([old, run.record.includes('argv=install')]).toEqual([old, false]);
    }
  });

  test('accepts the first npm that actually verifies, and newer', () => {
    // 10.5.2 is the FIRST version measured to pass, on a cold cache with a
    // fresh HOME so no newer client could have primed the key set. It leads
    // the list deliberately: v0.6.2 shipped a floor of 10.6.0, which refused
    // Node 20.13.0 and 20.13.1 because they ship 10.5.2. A floor that is too
    // high is a false accusation of a different kind, so both edges are
    // pinned here and 10.5.1 sits on the refused side above.
    for (const ok of ['10.5.2', '10.6.0', '10.9.2', '11.0.0', '12.0.0']) {
      expect([ok, runInstall({}, ok).status]).toEqual([ok, 0]);
    }
  });

  test('still reads the version when npm prints a notice above it', () => {
    // The shape that defeated two earlier versions of this floor in a sibling
    // repository: a per-line shape check passed, the arithmetic then read the
    // WHOLE string, errored, the `if` read false, and the floor was skipped on
    // a client it exists to refuse.
    const old = runInstall({}, 'npm notice a new version is available\\n10.5.0');
    expect(old.status).not.toBe(0);
    expect(old.record.includes('argv=install')).toBe(false);

    // And the same shape must not refuse a client that is fine.
    expect(runInstall({}, 'npm notice a new version is available\\n10.9.2').status).toBe(0);
  });

  test('refuses rather than assumes when it cannot read a version at all', () => {
    // A guard that fails open when it cannot see is not a guard.
    for (const unreadable of ['', 'not a version']) {
      const run = runInstall({}, unreadable);
      expect([unreadable, run.status]).not.toEqual([unreadable, 0]);
      expect([unreadable, run.record.includes('argv=install')]).toEqual([unreadable, false]);
    }
  });

  test('never lets an installed package run its own install scripts', () => {
    // This step runs on a runner holding the job's token, and what it installs
    // is a CONTROL INPUT: it decides whether a pull request may merge. Without
    // --ignore-scripts every package in the resolved tree gets arbitrary code
    // execution here on every run.
    const argvLine = runInstall()
      .record.split('\n')
      .find((l) => l.startsWith('argv=install'));
    expect(argvLine).toBeDefined();
    expect(argvLine).toContain('--ignore-scripts');
  });

  test('declares the scanner as a dependency, or the audit silently skips it', () => {
    // npm audit signatures audits the tree's EDGES OUT. A global install
    // leaves <prefix>/lib with a node_modules and no manifest, so the root
    // declares nothing, the package just installed is on the far end of no
    // edge, and the audit covers its dependencies while skipping the scanner
    // itself. Measured in the sibling repositories: vault-guard 13 installed
    // and 12 audited without this file, conductor 36 and 32. The gap is always
    // exactly the packages the check exists for. vault-guard shipped that bug
    // once; this repository has the manifest from the start.
    const run = runInstall();
    const manifestPath = path.join(run.runner.runnerTemp, 'dep-guard-action', 'lib', 'package.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // The declared version has to be the one being installed, or the audit
    // checks a different package than the one that landed.
    expect(manifest.dependencies['@vaultcompass/dep-guard']).toBe(run.runner.ctx.inputs.version);
  });

  test('checks the registry still serves the name and version it installed', () => {
    // Deliberately not "verifies what it installed": the command refetches
    // manifests from the registry and hashes nothing on disk, so a tampered
    // install passes it. Bounded, and the action comments say so.
    expect(runInstall().record).toContain('argv=audit signatures');
  });

  test('starts npm outside the checkout, so a committed .npmrc is never its cwd', () => {
    // The head's .npmrc sits in the workspace. npm started there reads it and
    // fetches from whatever registry it names. This is the assertion that
    // makes the whole boundary real; everything else follows from it.
    const run = runInstall();
    const cwdLine = run.record.split('\n').find((l) => l.startsWith('cwd='));
    expect(cwdLine).toBeDefined();
    expect(cwdLine).toContain(path.basename(run.runner.runnerTemp));
    expect(cwdLine).not.toContain(`${path.sep}workspace`);
  });

  test('installs under a prefix in the runner temp, not into the checkout', () => {
    const run = runInstall();
    const prefixLine = run.record.split('\n').find((l) => l.startsWith('prefix='));
    expect(prefixLine).toBeDefined();
    expect(prefixLine).not.toBe('prefix=unset');
    expect(prefixLine).toContain(path.basename(run.runner.runnerTemp));
    expect(prefixLine).not.toContain(`${path.sep}workspace`);
  });

  test('the binary the run step calls is the one this step installs', () => {
    // The two steps agree by construction rather than by coincidence: the
    // prefix here and DG_BIN there both derive from runner.temp, and a change
    // to one that forgot the other would leave the run step calling a path
    // nothing wrote.
    const run = runInstall();
    const prefix = (run.record.split('\n').find((l) => l.startsWith('prefix=')) ?? '').slice(
      'prefix='.length
    );
    expect(run.runner.env.DG_BIN).toBe(path.join(prefix, 'bin', 'dep-guard'));
  });
});

// The boundary the install step exists to draw, proven by what ran rather
// than by reading the script.
describe('action.yml runs the installed scanner and nothing else', () => {
  test('the head\'s copy is somewhere a bare-name resolution would reach it', () => {
    // Negative control. If this fails, "the planted copy never ran" below
    // stops being evidence and starts passing for the uninteresting reason
    // that nothing could have run it.
    const runner = makeRunner();
    const probe = execFileSync('dep-guard', [], {
      encoding: 'utf8',
      cwd: runner.runnerTemp,
      env: {
        PATH: `${path.join(runner.workspace, 'node_modules/.bin')}:${process.env.PATH ?? ''}`,
      },
    });
    expect(probe).toContain('PLANTED');
    expect(existsSync(runner.plantedRecord)).toBe(true);
  });

  test('ignores a node_modules copy and an .npmrc the head committed', () => {
    // The two redirects this boundary closes. The head controls both:
    // node_modules content comes from its package.json and lockfile, and a
    // committed .npmrc repoints the registry npm fetches from.
    const run = runStep(0);
    // The planted copy first, so a step that took the wrong binary fails with
    // a message naming the attack rather than one about a stub not being run.
    expect(run.plantedRan).toBe(false);
    expect(run.npxRan).toBe(false);
    expect(run.status).toBe(0);
    expect(run.outputs).toContain('exit_code=0');
  });

  test('runs the scanner from outside the checkout', () => {
    // Not from the workspace: npm and the scanner alike would otherwise start
    // with the head's .npmrc, package.json and lockfile under their cwd.
    const run = runStep(0);
    expect(run.scannerCwd).not.toBe('');
    expect(run.scannerCwd).not.toContain(path.basename(run.runner.workspace));
  });

  test('scans the path the input asked for, not just the workspace root', () => {
    // Without this, removing DG_PATH from the step's env block changed
    // nothing any test could see: every case used the default `.`, and
    // "${ROOT}/" still contains the workspace either way, so the input could
    // silently stop working while the suite stayed green.
    const argv = argvFor({ path: 'packages/cli', 'sarif-output': 'args.txt' });
    expect(argv).toContain('/workspace/packages/cli');
  });

  test('scans an absolute path, so the scan root survives the move', () => {
    // The half of this fix that is easy to leave out. Run from the runner temp
    // with a relative `.`, dep-guard resolves the runner temp as the
    // repository, fails to resolve the trust base, and exits 2 on every run,
    // blaming a fetch-depth the caller already set.
    const argv = argvFor({ 'sarif-output': 'args.txt' });
    expect(argv).toContain('/workspace');
    expect(argv.split(/\s+/).some((a) => a.startsWith('/'))).toBe(true);
  });

  test('refuses a sarif target that resolves through a symlink at any depth', () => {
    // The head controls the filename and every directory on the way to it. The
    // first version of this guard checked the leaf and its immediate parent,
    // and a review walked past it with one more level of nesting: a `reports`
    // symlink plus `reports/sub/out.sarif` wrote outside the workspace with
    // the step exiting 0.
    for (const [target, linkAt] of [
      ['out.sarif', 'out.sarif'],
      ['reports/out.sarif', 'reports'],
      ['reports/sub/out.sarif', 'reports'],
      ['a/b/c/out.sarif', 'a'],
    ]) {
      const runner = makeRunner({ 'sarif-output': target });
      installStubScanner(runner, {});
      const outside = path.join(runner.dir, 'outside-the-workspace');
      mkdirSync(outside, { recursive: true });
      const linkPath = path.join(runner.workspace, linkAt);
      mkdirSync(path.dirname(linkPath), { recursive: true });
      symlinkSync(outside, linkPath);

      const outputFile = path.join(runner.dir, 'github-output');
      writeFileSync(outputFile, '');
      const scriptFile = path.join(runner.dir, 'step.sh');
      writeFileSync(scriptFile, extractRunScript('Run dep-guard'));
      let status = 0;
      try {
        execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: cwdForStep('Run dep-guard', runner.ctx),
          env: {
            PATH: `${runner.pathDir}:${process.env.PATH ?? ''}`,
            GITHUB_WORKSPACE: runner.workspace,
            GITHUB_OUTPUT: outputFile,
            ...runner.env,
          },
        });
      } catch (err) {
        status = typeof err.status === 'number' ? err.status : -1;
      }
      expect([target, status]).not.toEqual([target, 0]);
      // And nothing was written through the link, including by mkdir -p,
      // which used to run before the check.
      expect([target, readdirSync(outside)]).toEqual([target, []]);
    }
  });

  test('publishes no results file when the scan wrote nothing', () => {
    // dep-guard exits before writing SARIF when it could not run, and the
    // redirect has already created the target, so the file exists and is
    // empty. Handing that to upload-sarif fails the job with a parse error
    // that buries the real cause.
    const run = runStep(2, {}, {});
    const body = readFileSync(run.sarifPath, 'utf8');
    if (body.length === 0) {
      expect(run.outputs).toContain('results_file=\n');
    } else {
      expect(run.outputs).toMatch(/results_file=.+/);
    }
  });
});

// Runs the REAL "Validate inputs" step rather than a copy of its logic,
// for the same reason the run-step tests above do: a private copy would
// keep passing long after action.yml had drifted away from it.
const VALIDATE_STEP = 'Validate inputs';

// Same rule as the run-step harness above: the variables come from the
// step's own env: mapping in action.yml, never from a table written here.
// `extraEnv` is for the variables the RUNNER sets rather than the action,
// which today means GITHUB_BASE_REF.
function runValidateScript(script, inputs, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'depguard-action-validate-'));
  const scriptFile = path.join(dir, 'validate.sh');
  writeFileSync(scriptFile, script);
  const ctx = { inputs: { ...DEFAULT_INPUTS, ...inputs }, runnerTemp: dir };
  try {
    execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        ...evaluateStepEnv(VALIDATE_STEP, ctx),
        ...extraEnv,
      },
    });
    return { status: 0, stdout: '' };
  } catch (err) {
    return { status: typeof err.status === 'number' ? err.status : -1, stdout: err.stdout ?? '' };
  }
}

function runValidateWith(inputs, extraEnv = {}) {
  return runValidateScript(extractRunScript(VALIDATE_STEP), inputs, extraEnv);
}

describe('action.yml "Validate inputs", env mapping', () => {
  test('reads the validate step from the environment rather than expanding expressions into a script', () => {
    // An expression expanded inside a run block is pasted in as source text
    // before the shell sees it. The expressions live only in the env: mapping.
    expect(extractRunScript(VALIDATE_STEP)).not.toMatch(/\$\{\{/);
  });

  test('declares the pull-request test from the event payload', () => {
    expect(action.extractStepEnv(VALIDATE_STEP).GITHUB_BASE_REF).toBe('${{ github.base_ref }}');
  });
});

describe('action.yml "Validate inputs", trust-base', () => {
  const runValidate = (trustBase) => runValidateWith({ 'trust-base': trustBase });

  test('refuses `off`, naming what to do instead', () => {
    // Pull-request mode is the floor, not a knob. On a same-repository
    // pull_request event the workflow file runs from the pull request's
    // own head, so an opt-out input would be settable by the very pull
    // request whose control inputs it governs. An earlier draft of this
    // action accepted `off`; this test is what stops it coming back.
    const run = runValidate('off');
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('`trust-base: off` is not supported');
    // A refusal with no alternative in it is a wall, so the message has to
    // carry both halves of the answer.
    expect(run.stdout).toContain('@v0.5.0');
    expect(run.stdout).toContain('fetch-depth: 0');
  });

  test('accepts an empty value and a real ref', () => {
    expect(runValidate('').status).toBe(0);
    expect(runValidate('origin/main').status).toBe(0);
  });

  test('refuses a ref that could be read as a git option', () => {
    expect(runValidate('--upload-pack=touch').status).not.toBe(0);
  });

  test('refuses `off` however it is capitalised', () => {
    // A value refused as `off` and accepted as `Off` is an opt-out with a
    // shift key in front of it.
    for (const spelling of ['off', 'Off', 'OFF', 'oFf']) {
      expect(runValidate(spelling).stdout).toContain('is not supported');
    }
  });

  test('takes an exact version and refuses a dist-tag or a path', () => {
    // `latest` used to be the DEFAULT here. It is refused now: a tag hands the
    // choice of scanner to the registry on the morning of the run.
    expect(runValidateWith({ version: '0.6.0' }).status).toBe(0);
    for (const bad of ['latest', 'next', 'beta', '0.6', '^0.6.0', '.', '..', 'payload.tgz', '-0.6.0']) {
      const run = runValidateWith({ version: bad });
      expect([bad, run.status]).not.toEqual([bad, 0]);
      expect(run.stdout).toContain('must be an exact version');
    }
  });

  test('refuses a path or a sarif target that begins with a dash', () => {
    expect(runValidateWith({ path: '-rf' }).stdout).toContain('must not begin with a dash');
    expect(runValidateWith({ 'sarif-output': '-rf' }).stdout).toContain('must not begin with a dash');
  });

  test('refuses a sarif target under .github/', () => {
    const run = runValidateWith({ 'sarif-output': '.github/workflows/out.sarif' });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('must not write under .github/');
  });

  test('accepts a `./` prefix on a path, which is ordinary Actions style', () => {
    // The first attempt at closing the `./.github/` bypass refused any value
    // containing `./`, which broke `path: ./src`: accepted by every earlier
    // release, and a security upgrade that turns a green check red is one
    // people back out of. The guards normalise now instead of refusing.
    expect(runValidateWith({ path: './src' }).status).toBe(0);
    expect(runValidateWith({ path: './' }).status).toBe(0);
    expect(runValidateWith({ 'sarif-output': './out.sarif' }).status).toBe(0);
  });

  test('refuses every spelling of .github/ that reaches the same directory', () => {
    // The guard compares strings, so every second name for that directory has
    // to be normalised away before the comparison: a `./` prefix, an interior
    // `/./`, a doubled slash, and -- because a macOS runner's filesystem is
    // case-insensitive -- a different case.
    for (const spelling of [
      '.github/workflows/out.sarif',
      './.github/workflows/out.sarif',
      './/.github/out.sarif',
      '.github/./out.sarif',
      '.GitHub/workflows/out.sarif',
      '.GITHUB/out.sarif',
      './.GitHub/out.sarif',
    ]) {
      const run = runValidateWith({ 'sarif-output': spelling });
      expect([spelling, run.status]).not.toEqual([spelling, 0]);
      expect(run.stdout).toContain('must not write under .github/');
    }
    // And a path that merely starts with the same letters is not caught.
    expect(runValidateWith({ 'sarif-output': '.githubbed/out.sarif' }).status).toBe(0);
    expect(runValidateWith({ 'sarif-output': 'out.sarif' }).status).toBe(0);
    expect(runValidateWith({ path: '.' }).status).toBe(0);
  });

  test('refuses a version with a leading zero, which npm reads as a tag', () => {
    // `01.2.3` is not semver, so npm falls back to treating the spec as a
    // dist-tag: the exact family this input claims to refuse.
    for (const bad of ['01.2.3', '00.0.0', '0.6.00', '0.06.0']) {
      const run = runValidateWith({ version: bad });
      expect([bad, run.status]).not.toEqual([bad, 0]);
    }
    expect(runValidateWith({ version: '0.6.0' }).status).toBe(0);
    expect(runValidateWith({ version: '10.20.30' }).status).toBe(0);
  });

  test('tells someone pinned to `latest` what to do instead', () => {
    // A refusal with no alternative in it is a wall. This is the migration
    // the breaking change forces, so the message has to carry the answer.
    const run = runValidateWith({ version: 'latest' });
    expect(run.stdout).toContain('REMOVE the input');
  });
});

describe('action.yml "Validate inputs", base', () => {
  // Deliberately parallel to the trust-base describe block above: `base`
  // is validated the same way (same charset, same refusal of `off`) even
  // though it answers a different question (what changed, not whose
  // config is trusted).
  const runValidate = (base) => runValidateWith({ base });

  test('refuses `off`, naming what to do instead', () => {
    const run = runValidate('off');
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('`base: off` is not supported');
  });

  test('refuses `off` however it is capitalised', () => {
    for (const spelling of ['off', 'Off', 'OFF', 'oFf']) {
      expect(runValidate(spelling).stdout).toContain('is not supported');
    }
  });

  test('accepts an empty value and a real ref', () => {
    expect(runValidate('').status).toBe(0);
    expect(runValidate('origin/main').status).toBe(0);
  });

  test('refuses a ref that could be read as a git option', () => {
    expect(runValidate('--upload-pack=touch').status).not.toBe(0);
  });

  test('refuses an explicit base on a pull_request event, naming the event default', () => {
    // Unlike trust-base, base cannot be redirected on a pull_request event:
    // a pull request could otherwise point the comparison at its own head or
    // branch and empty the delta. GITHUB_BASE_REF non-empty is the same
    // pull-request test the run step uses under auto, and this refusal uses
    // the same ::error:: mechanism as the `off` refusal above.
    const run = runValidateWith({ base: 'origin/release' }, { GITHUB_BASE_REF: 'main' });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('base');
    expect(run.stdout).toContain('origin/$GITHUB_BASE_REF');
    expect(run.stdout).toContain('pull_request');
    expect(run.stdout).toContain('cannot be redirected');
  });

  test('still accepts an explicit base off a pull_request event', () => {
    expect(runValidateWith({ base: 'origin/release' }, {}).status).toBe(0);
  });

  test('still accepts an unset base on a pull_request event', () => {
    expect(runValidateWith({ base: '' }, { GITHUB_BASE_REF: 'main' }).status).toBe(0);
  });
});

// The three numbers DG_TAG_SCANNER is built from, read out of action.yml
// rather than written down here: a copy in this file would go on agreeing with
// itself after the action moved.
function tagScannerPart(part) {
  const found = new RegExp(`DG_TAG_SCANNER_${part}=([0-9]+)`).exec(actionYml);
  expect([part, found === null]).toEqual([part, false]);
  return found[1];
}

// The same step, with the tag's scanner constant advanced by one minor
// version: the action as it will be the day a 0.8.0 scanner ships and this tag
// starts shipping it.
//
// This is NOT here because the rule is invisible on the shipped file. It is
// visible: nine scanners are published below the tag scanner (0.1.0 through
// 0.6.0), and the first case in the block below drives the unmodified step with
// `version: 0.5.9` and watches it refuse. The future constant exists to exercise the comparison
// at a boundary the published set cannot reach today, one where the refused
// version is itself in the 0.7.x family and so the minor and patch legs of the
// comparison do the work. It is not a weakened program: every line of the check
// is the shipped one. The replacement is asserted to have MATCHED, so deleting
// or renaming the constant turns this red rather than silently testing the
// unmodified script.
function scriptWithFutureTagScanner() {
  const script = extractRunScript(VALIDATE_STEP);
  const future = script.replace(
    /DG_TAG_SCANNER_MINOR=([0-9]+)/,
    (_all, digits) => `DG_TAG_SCANNER_MINOR=${Number(digits) + 1}`
  );
  expect(future).not.toBe(script);
  return future;
}

describe('action.yml "Validate inputs", pinning the scanner backward on a pull request', () => {
  test('refuses a below-tag pin on a pull request, on the SHIPPED file', () => {
    // The rule is observable on the unmodified action, so this case proves it
    // there rather than on a future-constant copy. Ten scanners are published,
    // 0.1.0 through 0.7.0, so nine of them sit below the tag scanner and every
    // one clears the shape check. `0.5.9` stands in for that whole family: a
    // well-formed version, below the constant, refused.
    //
    // Such a pin is ALREADY broken on a pull request, because `--trust-base`
    // arrived in the 0.6.0 scanner and the run step passes it on every
    // pull-request run with no opt-out, so an older scanner answers with an
    // unknown-option error at the scan. What this rule changes is WHERE and
    // WHY it fails: at validate, naming the pin.
    const refused = runValidateWith({ version: '0.5.9' }, { GITHUB_BASE_REF: 'main' });
    expect(refused.status).not.toBe(0);
    // Both numbers, for the same reason the npm floor names both.
    expect(refused.stdout).toContain('0.5.9');
    expect(refused.stdout).toContain('0.7.0');
    expect(refused.stdout).toContain('pull request');
    expect(refused.stdout).toContain('REMOVE the `version` input');

    // And the same input off the pull-request event is accepted, which is what
    // makes the refusal above a property of the EVENT and not of the value.
    expect(runValidateWith({ version: '0.5.9' }, {}).status).toBe(0);
  });

  test('refuses a pull request that asks for an older scanner than the tag ships', () => {
    // THE HOLE THIS CLOSES. On a same-repo `pull_request` event GitHub runs the
    // workflow file from the HEAD, so the `version:` input is written by the
    // pull request being judged. The shape check above it proves the input
    // names a version and says nothing about WHICH one, so once a newer scanner
    // exists a pull request can pin back to an older one and be judged by the
    // rule set it chose for itself. `trust-base: off` was refused by name for
    // exactly this reason; the difference is that deleting a security step
    // reads as deleting a security step, while `version: 0.7.0` reads as
    // ordinary version management.
    const future = scriptWithFutureTagScanner();
    const run = runValidateScript(future, { version: '0.7.0' }, { GITHUB_BASE_REF: 'main' });
    expect(run.status).not.toBe(0);
    // BOTH numbers, for the same reason the npm floor names both: a refusal
    // that does not say which two values disagree sends the reader away to work
    // it out.
    expect(run.stdout).toContain('0.7.0');
    expect(run.stdout).toContain('0.8.0');
    expect(run.stdout).toContain('pull request');
    // And the remedy, which is to stop pinning at all.
    expect(run.stdout).toContain('REMOVE the `version` input');
  });

  test('leaves push events alone, where GITHUB_BASE_REF is not set', () => {
    // The event test is GITHUB_BASE_REF being non-empty, which is exactly how
    // the run step decides to pass `--trust-base` under `auto`. With it unset
    // the same low pin is accepted: push runs are out of this rule's scope.
    // That is scope, not safety -- a push to an unprotected branch runs that
    // branch's own workflow file and is as author-controlled as a pull request.
    const future = scriptWithFutureTagScanner();
    expect(runValidateScript(future, { version: '0.6.0' }, {}).status).toBe(0);
    expect(runValidateScript(future, { version: '0.6.1' }, {}).status).toBe(0);
  });

  test('allows pinning forward on a pull request, and orders numerically', () => {
    // Pinning FORWARD stays allowed, on the rule's unenforced assumption that a
    // newer scanner is at least as strict; forward pins are not bounded.
    // `0.10.0` is the case a lexicographic comparison gets wrong: it sorts
    // below `0.8.0` as text and above it as a version, and refusing it would
    // refuse the very direction this rule exists to leave open.
    const future = scriptWithFutureTagScanner();
    for (const ok of ['0.8.0', '0.8.1', '0.9.0', '0.10.0', '1.0.0', '10.0.0']) {
      expect([
        ok,
        runValidateScript(future, { version: ok }, { GITHUB_BASE_REF: 'main' }).status,
      ]).toEqual([ok, 0]);
    }
  });

  test('accepts the scanner this tag actually ships, on every event', () => {
    // Against the REAL file, not the future one: the shipped default and the
    // shipped tag scanner have to pass on a pull-request run, or every
    // consumer's pull request goes red the day this lands.
    const shipped = `${tagScannerPart('MAJOR')}.${tagScannerPart('MINOR')}.${tagScannerPart('PATCH')}`;
    expect(runValidateWith({ version: shipped }, { GITHUB_BASE_REF: 'main' }).status).toBe(0);
    expect(runValidateWith({}, { GITHUB_BASE_REF: 'main' }).status).toBe(0);
    for (const ok of ['0.7.0', '0.7.1', '0.10.0', '1.0.0']) {
      expect([ok, runValidateWith({ version: ok }, { GITHUB_BASE_REF: 'main' }).status]).toEqual([
        ok,
        0,
      ]);
    }
  });

  test('lets the shape check answer first for a version that is not a version', () => {
    // Two separate checks, deliberately, and the order decides which message a
    // reader gets. `latest` is not a version at all, and the useful answer says
    // so: that pin does not merely choose weaker rules, it is the dist-tag
    // family this input refuses outright. Reversing the order would answer a
    // malformed pin with a lecture about pull requests, and would also hand the
    // comparison a value it cannot parse.
    const run = runValidateWith({ version: 'latest' }, { GITHUB_BASE_REF: 'main' });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('must be an exact version');
    expect(run.stdout).not.toContain('judged by');
  });

  test('keeps the tag scanner, the input default and the published packages one number', () => {
    // THE DRIFT GUARD, and the most important case here. Four numbers in four
    // places have to say the same thing: the scanner this repository publishes
    // from each package, the `version` input's default, and the constant the
    // pull-request rule compares against. Let them drift and the rule silently
    // measures against a scanner nobody ships -- a constant left BEHIND a
    // published scanner would go on admitting the pin it exists to refuse, and
    // would do it quietly.
    const tagScanner = `${tagScannerPart('MAJOR')}.${tagScannerPart('MINOR')}.${tagScannerPart('PATCH')}`;
    for (const pkg of ['core', 'cli']) {
      const version = JSON.parse(
        readFileSync(path.join(ROOT, 'packages', pkg, 'package.json'), 'utf8')
      ).version;
      expect([pkg, tagScanner]).toEqual([pkg, version]);
    }
    // Read with the release gate's own reader, which is scoped to the `inputs:`
    // block and keyed on the `version:` input. An earlier version of this line
    // matched whichever `default:` happened to sit directly above `path:`,
    // which is a POSITIONAL claim, not a claim about the version input:
    // inserting a new input between the two with its own `default: 0.6.0` left
    // this case green while the real default had drifted to 0.9.9.
    expect(readActionVersionDefault(actionYml)).toBe(tagScanner);
  });

  test('keeps the shape check and the re-match byte-identical', () => {
    // The re-match inside the pull-request gate exists so a reader repairing
    // the shape check cannot silently empty BASH_REMATCH out from under this
    // block. Its "internal error" branch is UNREACHABLE, and the reason is
    // precisely that the two patterns are the same program run on the same
    // unchanged variable. Nothing but this assertion enforces "the same".
    // Change one character of either and the branch becomes reachable, which
    // means a value the shape check admitted would be refused as an internal
    // error, or -- the direction that matters -- a value the shape check
    // refused could be parsed differently here.
    const script = extractRunScript(VALIDATE_STEP);
    const patterns = script.match(/=~ (\^\(0\|\[1-9\]\[0-9\]\*\)[^\s]*\$)/g) ?? [];
    // Two and exactly two: the shape check and the re-match. A third would be
    // a third idea of what a version is, and a first-only match would mean one
    // of them had been rewritten past recognition.
    expect(patterns.length).toBe(2);
    expect(patterns[0]).toBe(patterns[1]);
  });

  test('writes the pull-request check accept-only-if, after the version shape check', () => {
    // Stated as text because behaviour cannot see a check that is not there,
    // and because the FAILURE DIRECTION is the point. `[` returns 2 on a
    // malformed comparison and an `if` reads 2 as false, so a refuse-if shape
    // turns an arithmetic error into permission. The flag must therefore start
    // at 0 and only be raised by a comparison that succeeded.
    const code = extractRunScript(VALIDATE_STEP)
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    const shapeAt = code.indexOf('must be an exact version');
    const initAt = code.indexOf('DG_PR_SCANNER_OK=0');
    const refuseAt = code.indexOf('"${DG_PR_SCANNER_OK}" -ne 1');
    expect([shapeAt, initAt, refuseAt].every((i) => i !== -1)).toBe(true);
    expect(initAt).toBeGreaterThan(shapeAt);
    expect(refuseAt).toBeGreaterThan(initAt);
    // The event test is the one the run step already uses for `--trust-base`
    // under `auto`, not a second detector invented here, and it wraps the new
    // check rather than sitting somewhere else in the step. Bounded at BOTH
    // ends, for two different reasons. The LOWER bound is what the assertion
    // needs today: a search of the whole file would find the run step's own
    // copy of the same idiom, which lives in a different step entirely and
    // would satisfy a gate that had been deleted from this one. The UPPER bound
    // is insurance rather than a live need -- the validate step uses
    // GITHUB_BASE_REF exactly once, and it is this gate -- but a second use
    // added below the flag initialisation later would otherwise stand in for a
    // deleted gate. As written, deleting the gate turns this case red.
    const gateAt = code.indexOf('-n "${GITHUB_BASE_REF:-}"', shapeAt);
    expect(gateAt).toBeGreaterThan(shapeAt);
    expect(gateAt).toBeLessThan(initAt);
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
    //
    // It re-raises 2, not 1. Nothing scanned the change, which is the same
    // fact as every other could-not-run and a different fact from "there are
    // blocking findings". Exit 1 here would tell a caller the scan reached a
    // verdict it never reached.
    const run = runReport('');
    expect(run.status).toBe(2);
    expect(run.stdout).toContain('did not run to completion');
  });

  test('treats any other code as could not run, never as findings', () => {
    // 126 and 127 are what the SHELL produces when a binary is missing or not
    // executable, which is exactly what a failed install looks like from
    // here. Reporting those as findings would invent a verdict.
    for (const code of ['3', '126', '127']) {
      const run = runReport(code);
      expect([code, run.status]).toEqual([code, 2]);
      expect(run.stdout).toContain('did not produce a result');
      expect(run.stdout).not.toContain('blocking findings');
    }
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
