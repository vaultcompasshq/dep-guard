import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { jest } from '@jest/globals';
import { scan } from '@vaultcompass/dep-guard-core';
import { renderSarif } from '../src/output-sarif.js';
import { renderText } from '../src/output-text.js';

// How a denied-package finding reads in each output: the reason, already
// validated at load, sanitised in text and carried as written in JSON and
// SARIF; a resolved URL never printed, only its host.
jest.setTimeout(60_000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CORPUS = path.join(__dirname, '..', '..', 'core', 'fixtures', 'corpus');
const execFileAsync = promisify(execFile);
const TARBALL = 'https://registry.npmjs.org/event-stream/-/event-stream-3.3.6.tgz';
const REASON = 'Compromised in 2018 (flatmap-stream); see the incident write-up';

let repo = '';

async function git(...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: repo, encoding: 'utf8' });
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-deny-output-'));
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'dep guard test');
  await git('config', 'commit.gpgsign', 'false');
  await writeFile(
    path.join(repo, '.dep-guard.json'),
    JSON.stringify({ deny: [{ name: 'event-stream', reason: REASON, versions: ['3.3.6'] }] })
  );
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { safe: '1.0.0' } }));
  await writeFile(
    path.join(repo, 'package-lock.json'),
    JSON.stringify({
      name: 'app',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'app', version: '1.0.0', dependencies: { safe: '1.0.0' } },
        'node_modules/safe': { version: '1.0.0', resolved: TARBALL, integrity: 'sha512-x' },
      },
    })
  );
  await git('add', '-A');
  await git('commit', '-q', '-m', 'tree');
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

test('65 reason sanitized in text; carried in JSON and SARIF; no resolved URL anywhere', async () => {
  const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
  const denied = result.findings.filter((finding) => finding.ruleId === 'denied-package');
  expect(denied).toHaveLength(1);
  expect(denied[0].details?.reason).toBe(REASON);
  expect(denied[0].details?.source).toEqual({ kind: 'registry', host: 'registry.npmjs.org' });

  const text = renderText(result);
  expect(text).toContain(REASON);
  expect(text).toContain('denied-package (1 deny entry)');

  const json = JSON.stringify(denied);
  expect(json).toContain(REASON);
  expect(json).not.toContain(TARBALL);
  expect(json).not.toContain('/-/event-stream-3.3.6.tgz');

  const sarif = JSON.parse(renderSarif(result, '0.0.0-test')) as {
    runs: Array<{ tool: { driver: { rules: Array<{ id: string }> } }; results: Array<{ ruleId: string; message: { text: string } }> }>;
  };
  const run = sarif.runs[0];
  expect(run.tool.driver.rules.map((rule) => rule.id)).toContain('dep-guard/denied-package');
  const sarifResult = run.results.find((entry) => entry.ruleId === 'dep-guard/denied-package');
  expect(sarifResult?.message.text).toContain(REASON);
  expect(JSON.stringify(sarif)).not.toContain(TARBALL);
});
