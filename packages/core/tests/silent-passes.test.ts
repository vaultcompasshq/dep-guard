import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { scan } from '../src/scan.js';
import type { ScanResult } from '../src/scan.js';

// End-to-end pins for four ways a tampered or dangerous dependency change
// used to scan clean. Every test drives the real scan entry point against a
// real git repository, with fixtures shaped like what npm and pnpm write.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CORPUS = path.join(__dirname, '..', 'fixtures', 'corpus');
const execFileAsync = promisify(execFile);

let tempDirs: string[] = [];
let repo = '';

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

async function scanStaged(): Promise<ScanResult> {
  await git('add', '-A');
  return scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });
}

function manifestJson(dependencies: Record<string, string>): string {
  return JSON.stringify({ name: 'root', version: '1.0.0', dependencies });
}

function npmLock(
  packages: Record<string, Record<string, unknown>>,
  rootDependencies: Record<string, string>,
  ...versionArg: [] | [unknown]
): string {
  // An explicit undefined means "delete the field"; omitting the argument
  // means the lockfileVersion 3 npm writes today.
  const lockfileVersion = versionArg.length === 0 ? 3 : versionArg[0];
  const doc: Record<string, unknown> = {
    name: 'root',
    version: '1.0.0',
    lockfileVersion,
    requires: true,
    packages: {
      '': { name: 'root', version: '1.0.0', dependencies: rootDependencies },
      ...packages,
    },
  };
  if (lockfileVersion === undefined) {
    delete doc.lockfileVersion;
  }
  return JSON.stringify(doc);
}

const CLEAN_LODASH = {
  version: '4.17.21',
  resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
  integrity: 'sha512-cleanlodash',
};

const TAMPERED_LODASH = {
  version: '4.17.21',
  resolved: 'https://evil.example.com/lodash/-/lodash-4.17.21.tgz',
  integrity: 'sha512-evilevilevil',
};

function tamperSignals(result: ScanResult, name: string): string[] {
  return result.findings
    .filter((finding) => finding.ruleId === 'lockfile-tamper' && finding.packageName === name)
    .map((finding) => String(finding.details?.signal ?? ''));
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-silent-'));
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

describe('D1: lockfileVersion does not decide whether the packages map is read', () => {
  // npm reads the packages map whenever it is there, whatever the
  // lockfileVersion field says (verified with npm ls --package-lock-only),
  // so the scan has to as well.
  const variants: Array<[string, unknown]> = [
    ['the string "3"', '3'],
    ['the number 1', 1],
    ['null', null],
    ['deleted', undefined],
  ];

  for (const [label, version] of variants) {
    test(`a tampered node_modules/lodash is caught when lockfileVersion is ${label}`, async () => {
      await write('package.json', manifestJson({ lodash: '^4.17.21' }));
      await write('package-lock.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
      await commitAll('first');

      await write(
        'package-lock.json',
        npmLock({ 'node_modules/lodash': TAMPERED_LODASH }, { lodash: '^4.17.21' }, version)
      );
      const result = await scanStaged();

      const signals = tamperSignals(result, 'lodash');
      expect(signals.some((signal) => signal.startsWith('host-changed'))).toBe(true);
      expect(result.exitCode).toBe(1);
    });
  }

  test('a real v1 lockfile on both sides keeps only the v1 diagnostic', async () => {
    const v1 = JSON.stringify({
      name: 'root',
      version: '1.0.0',
      lockfileVersion: 1,
      requires: true,
      dependencies: { lodash: { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', integrity: 'sha512-cleanlodash' } },
    });
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('package-lock.json', v1);
    await commitAll('first');
    await write('package.json', manifestJson({ lodash: '^4.17.20' }));
    const result = await scanStaged();

    expect(result.run.diagnostics.map((d) => d.code)).toContain('npm-lockfile-v1');
    expect(result.exitCode).toBe(0);
  });

  test('a base with a packages map whose head loses it (v1 shape) is not a clean pass', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' }));
    await commitAll('first');

    // The head keeps the tampered entry only in the legacy dependencies
    // tree, with the packages map removed and the version set to 1.
    await write(
      'package-lock.json',
      JSON.stringify({
        name: 'root',
        version: '1.0.0',
        lockfileVersion: 1,
        requires: true,
        dependencies: { lodash: { version: '4.17.21', resolved: TAMPERED_LODASH.resolved, integrity: TAMPERED_LODASH.integrity } },
      })
    );

    await expect(scanStaged()).rejects.toMatchObject({ code: 'lockfile-downgrade' });
  });
});
