import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { scan } from '../src/scan.js';

// A wildcard whose text does not move still blocks when the lockfile
// resolution does. The sentence has to say which of those two things happened.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CORPUS = path.join(__dirname, '..', 'fixtures', 'corpus');
const execFileAsync = promisify(execFile);

let tempDirs: string[] = [];
let repo = '';

async function git(...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: repo });
}

function manifest(specifier: string): string {
  return JSON.stringify({ name: 'root', version: '1.0.0', dependencies: { lodash: specifier } });
}

function lock(version: string, specifier: string): string {
  return JSON.stringify({
    name: 'root',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'root', version: '1.0.0', dependencies: { lodash: specifier } },
      'node_modules/lodash': {
        version,
        resolved: `https://registry.npmjs.org/lodash/-/lodash-${version}.tgz`,
        integrity: `sha512-${version}`,
      },
    },
  });
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-hygiene-spec-'));
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

async function commit(relPath: string, content: string, message: string): Promise<void> {
  await writeFile(path.join(repo, relPath), content, 'utf8');
  await git('add', '-A');
  await git('commit', '-q', '-m', message);
}

test('an unchanged wildcard names the lockfile resolution that moved', async () => {
  await commit('package.json', manifest('*'), 'base');
  await commit('package-lock.json', lock('1.0.0', '*'), 'lock base');
  await commit('package-lock.json', lock('1.0.1', '*'), 'lock head');

  const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'HEAD~1' }, corpusDir: FIXTURE_CORPUS });
  const finding = result.findings.find((item) => item.ruleId === 'version-hygiene' && item.packageName === 'lodash');

  expect(result.exitCode).toBe(1);
  expect(finding?.message).toBe(
    '"lodash" is specified as "*", which pins no version at all. ' +
      'The spec in package.json did not change; package-lock.json resolved it from 1.0.0 to 1.0.1.'
  );
});

test('a spec rewritten to a wildcard keeps the original sentence through a real scan', async () => {
  await writeFile(path.join(repo, 'package.json'), manifest('1.0.0'), 'utf8');
  await writeFile(path.join(repo, 'package-lock.json'), lock('1.0.0', '1.0.0'), 'utf8');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'base');
  await writeFile(path.join(repo, 'package.json'), manifest('*'), 'utf8');
  await writeFile(path.join(repo, 'package-lock.json'), lock('1.0.1', '*'), 'utf8');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'head');

  const result = await scan({ repoRoot: repo, mode: { kind: 'base', ref: 'HEAD~1' }, corpusDir: FIXTURE_CORPUS });
  const finding = result.findings.find((item) => item.ruleId === 'version-hygiene' && item.packageName === 'lodash');

  expect(finding?.message).toBe('"lodash" is specified as "*", which pins no version at all.');
});
