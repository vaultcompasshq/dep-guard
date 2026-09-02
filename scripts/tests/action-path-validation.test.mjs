// Self-test for action.yml's input validation, modelled on vault-guard's
// scripts/test-action-path-validation.sh and folded into `pnpm test`
// rather than left as a standalone script, because this repo's rule is
// that `pnpm test` is the single answer to "did I break anything".
//
// The regression it exists for: a bash `=~` pattern written `{1,256}`
// fails to COMPILE on macOS, where the BSD regex engine sets RE_DUP_MAX
// to 255. A pattern that fails to compile does not match, so every path
// input -- including the default `.` -- was rejected as invalid, and the
// action was unusable for anyone on macOS while passing perfectly on the
// ubuntu runners CI actually used. That asymmetry is why a grep guard
// below is worth as much as the behavioural checks: on Linux the broken
// pattern "works", so only reading the file catches it.
//
// Two kinds of assertion live here, and the second is what keeps the
// first honest:
//
//   1. Behavioural: the validate_path logic accepts and rejects the right
//      values, exercised by running it under the real bash.
//   2. Textual: action.yml actually contains the idiom that behaviour was
//      written against, and does not contain the two shapes known to
//      break it. Without these, the behavioural half would keep passing
//      against its own private copy of the function long after action.yml
//      had drifted away from it.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACTION_PATH = path.join(ROOT, 'action.yml');
const actionYml = readFileSync(ACTION_PATH, 'utf8');

// The same shape action.yml uses. Kept in step with it by the textual
// assertions below rather than by anyone remembering to.
const VALIDATE_PATH_FN = `
validate_path() {
  local value="$1"
  if [[ ! "\${value}" =~ ^[A-Za-z0-9._/-]+$ ]] || (( \${#value} > 256 )); then
    return 1
  fi
  if [[ "\${value}" == *".."* ]]; then
    return 1
  fi
  if [[ "\${value}" == /* ]]; then
    return 1
  fi
  return 0
}
`;

function validatePath(value) {
  const script = `${VALIDATE_PATH_FN}\nif validate_path "$1"; then echo OK; else echo BAD; fi`;
  const out = execFileSync('bash', ['-c', script, 'bash', value], { encoding: 'utf8' });
  return out.trim() === 'OK';
}

describe('action.yml path validation', () => {
  test('accepts the paths a consumer actually passes', () => {
    // "." is the default and is the value the RE_DUP_MAX bug rejected, so
    // it is the single most load-bearing case in this file.
    for (const value of ['.', './src', 'packages/cli', 'dep-guard-results.sarif', 'a'.repeat(256)]) {
      expect([value, validatePath(value)]).toEqual([value, true]);
    }
  });

  test('rejects traversal, absolute paths, and shell-hostile characters', () => {
    const bad = [
      '',
      '..',
      '../etc',
      'a/../../b',
      '/etc/passwd',
      'has space',
      'semi;colon',
      'back`tick',
      '$(subshell)',
      'quote"mark',
      'a'.repeat(257),
    ];
    for (const value of bad) {
      expect([value, validatePath(value)]).toEqual([value, false]);
    }
  });
});

describe('action.yml text guards', () => {
  test('does not reintroduce the {1,256} path regex', () => {
    // On Linux this pattern "works", which is exactly why a behavioural
    // test on an ubuntu runner would never notice it coming back.
    expect(actionYml).not.toMatch(/\[A-Za-z0-9\._\/-\]\{1,256\}/);
    expect(actionYml).not.toMatch(/=~[^\n]*\{1,\s*256\}/);
  });

  test('uses the portable charset-plus-length idiom the tests above exercise', () => {
    expect(actionYml).toContain('=~ ^[A-Za-z0-9._/-]+$');
    expect(actionYml).toContain('> 256');
  });

  test('validates both path-shaped inputs, not just one', () => {
    expect(actionYml).toContain('validate_path "path"');
    expect(actionYml).toContain('validate_path "sarif-output"');
  });

  test('does not pass a bare -- between the npx package spec and the command', () => {
    // npx forwards that separator into dep-guard's argv; commander then
    // treats it as end-of-options and ignores --format, so the file the
    // uploader reads is a text report rather than SARIF.
    expect(actionYml).not.toMatch(/npx[^\n]*--\s+scan/);
  });

  test('redirects SARIF to the output file rather than teeing a mixed stream into it', () => {
    expect(actionYml).not.toMatch(/\|\s*tee\s+"\$\{OUT\}"/);
    expect(actionYml).toContain('> "${OUT}"');
  });

  test('every input reaching a shell is passed through env, never interpolated into the script', () => {
    // The whole reason validation is possible at all: `${{ inputs.x }}`
    // is substituted into the script text before bash parses it, so a
    // hostile value interpolated directly cannot be quoted out of. Every
    // occurrence has to be on an `env:` line.
    const interpolations = actionYml.match(/\$\{\{\s*inputs\.[^}]*\}\}/g) ?? [];
    expect(interpolations.length).toBeGreaterThan(0);
    for (const line of actionYml.split('\n')) {
      if (!/\$\{\{\s*inputs\./.test(line)) {
        continue;
      }
      // A comment explaining the rule is not a violation of it. This one
      // matters: the comment in action.yml that documents WHY inputs go
      // through env necessarily quotes the interpolation syntax.
      if (line.trim().startsWith('#')) {
        continue;
      }
      // Either an env: assignment (NAME: ${{ inputs.x }}), a `with:`
      // input handed to another action, or a step-level `if:` condition.
      expect([line.trim(), /^([A-Za-z0-9_-]+:|if:)\s/.test(line.trim())]).toEqual([
        line.trim(),
        true,
      ]);
    }
  });

  test('pins every third-party action to a full commit sha', () => {
    // A tag is mutable, and this action runs inside other people's
    // repositories with their permissions.
    const uses = actionYml.match(/uses:\s*([^\s]+)/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const entry of uses) {
      expect([entry, /@[0-9a-f]{40}$/.test(entry.replace(/^uses:\s*/, ''))]).toEqual([entry, true]);
    }
  });

  test('re-raises dep-guard exit code 2 rather than collapsing it into 1', () => {
    // Same bug class the generated pre-commit hook is built against: 2
    // means the checks did not run, which is not "there are findings".
    expect(actionYml).toContain('exit "${DG_EXIT_CODE}"');
  });

  test('uploads the SARIF before the run is failed', () => {
    // A scan that found something is the scan whose SARIF matters most.
    // If the gate step came first, the upload would be skipped exactly
    // when it was needed.
    const uploadAt = actionYml.indexOf('upload-sarif@');
    const gateAt = actionYml.indexOf('Report dep-guard result');
    expect(uploadAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(uploadAt);
  });
});
