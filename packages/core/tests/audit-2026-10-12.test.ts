import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { scan } from '../src/scan.js';
import type { ScanResult } from '../src/scan.js';

// End-to-end pins for the three lockfile-semantics bypasses an independent
// audit reproduced against 0.11.1: a decoy "link": true entry switching
// off the name checks (B1), a registry tarball that is another package's
// (B2), and a manifest under a skipped directory name with its own
// lockfile beside it (B3). Each drives the real scan entry point against a
// real git repository. The fixture corpus flags "lodahs" as a typosquat of
// "lodash"; it stands in for the curated malicious names the audit used.

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

// A pull-request run: the working tree, committed on a branch, judged
// against main, with every control input read from main.
async function scanPullRequest(): Promise<ScanResult> {
  await git('checkout', '-q', '-b', 'pr');
  await commitAll('head');
  return scan({
    repoRoot: repo,
    mode: { kind: 'base', ref: 'main' },
    corpusDir: FIXTURE_CORPUS,
    trustBase: 'main',
  });
}

function manifest(dependencies: Record<string, string>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'root', version: '1.0.0', dependencies, ...extra });
}

function npmLock(
  packages: Record<string, Record<string, unknown>>,
  rootDependencies: Record<string, string>,
  rootExtra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    name: 'root',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'root', version: '1.0.0', dependencies: rootDependencies, ...rootExtra },
      ...packages,
    },
  });
}

// A pnpm v9 lockfile for the root importer. Each package is
// [name, version, resolution-body].
function pnpmLock(packages: Array<[string, string, string]>): string {
  const lines = ["lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:'];
  for (const [name, version] of packages) {
    lines.push(`      ${name}:`, `        specifier: ^${version}`, `        version: ${version}`);
  }
  lines.push('', 'packages:', '');
  for (const [name, version, resolution] of packages) {
    lines.push(`  ${name}@${version}:`, `    resolution: {${resolution}}`, '');
  }
  lines.push('snapshots:', '');
  for (const [name, version] of packages) {
    lines.push(`  ${name}@${version}: {}`, '');
  }
  return lines.join('\n');
}

function findingsFor(result: ScanResult, ruleId: string, packageName: string) {
  return result.findings.filter((finding) => finding.ruleId === ruleId && finding.packageName === packageName);
}

function signalsFor(result: ScanResult, packageName: string): string[] {
  return findingsFor(result, 'lockfile-tamper', packageName).map((finding) => String(finding.details?.signal ?? ''));
}

const LODASH_PNPM: [string, string, string] = ['lodash', '4.17.21', 'integrity: sha512-cleanlodash'];
const LODAHS_PNPM: [string, string, string] = ['lodahs', '1.0.0', 'integrity: sha512-lodahs'];

const LODASH_NPM = {
  version: '4.17.21',
  resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
  integrity: 'sha512-cleanlodash',
};

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-audit-'));
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

describe('B1: a link entry makes a name workspace-local only when the package is really there', () => {
  async function commitPnpmBase(): Promise<void> {
    await write('package.json', manifest({ lodash: '^4.17.21' }));
    await write('pnpm-lock.yaml', pnpmLock([LODASH_PNPM]));
    await commitAll('base');
  }

  test('a decoy package-lock.json link entry in a pnpm repository does not hide a typosquat', async () => {
    await commitPnpmBase();
    await write('package.json', manifest({ lodash: '^4.17.21', lodahs: '^1.0.0' }));
    await write('pnpm-lock.yaml', pnpmLock([LODASH_PNPM, LODAHS_PNPM]));
    await write(
      'package-lock.json',
      JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodahs': { resolved: 'packages/lodahs', link: true } } })
    );

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).not.toHaveLength(0);
    expect(result.exitCode).toBe(1);
    expect(result.run.diagnostics.map((d) => d.code)).toContain('workspace-link-unconfirmed');
  });

  test('a decoy link entry backed by a planted package.json of that name still does not exempt it under pnpm', async () => {
    await commitPnpmBase();
    await write('package.json', manifest({ lodash: '^4.17.21', lodahs: '^1.0.0' }));
    await write('pnpm-lock.yaml', pnpmLock([LODASH_PNPM, LODAHS_PNPM]));
    await write('packages/lodahs/package.json', JSON.stringify({ name: 'lodahs', version: '1.0.0' }));
    await write(
      'package-lock.json',
      JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodahs': { resolved: 'packages/lodahs', link: true } } })
    );

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).not.toHaveLength(0);
    expect(result.exitCode).toBe(1);
  });

  test('a real npm sibling in another directory does not exempt the name for a manifest its lockfile does not cover', async () => {
    await commitPnpmBase();
    await write('package.json', manifest({ lodash: '^4.17.21', lodahs: '^1.0.0' }));
    await write('pnpm-lock.yaml', pnpmLock([LODASH_PNPM, LODAHS_PNPM]));
    // A planted npm-only project whose own workspace really does hold a
    // package named lodahs, so its link entry is confirmed there.
    await write('tools/planted/package.json', manifest({ lodahs: '^1.0.0' }, { workspaces: ['packages/*'] }));
    await write('tools/planted/packages/lodahs/package.json', JSON.stringify({ name: 'lodahs', version: '1.0.0' }));
    await write(
      'tools/planted/package-lock.json',
      npmLock({ 'node_modules/lodahs': { resolved: 'packages/lodahs', link: true } }, { lodahs: '^1.0.0' })
    );

    const result = await scanPullRequest();

    const rootFindings = findingsFor(result, 'typosquat', 'lodahs').filter(
      (finding) => finding.manifestPath === 'package.json'
    );
    expect(rootFindings).not.toHaveLength(0);
    expect(result.exitCode).toBe(1);
  });

  test('control: the same change without the decoy is the same finding', async () => {
    await commitPnpmBase();
    await write('package.json', manifest({ lodash: '^4.17.21', lodahs: '^1.0.0' }));
    await write('pnpm-lock.yaml', pnpmLock([LODASH_PNPM, LODAHS_PNPM]));

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).not.toHaveLength(0);
    expect(result.exitCode).toBe(1);
  });

  test('a decoy link entry beside a yarn.lock does not hide a typosquat', async () => {
    await write('package.json', manifest({ lodash: '^4.17.21' }));
    await write('yarn.lock', '# yarn lockfile v1\n');
    await commitAll('base');
    await write('package.json', manifest({ lodash: '^4.17.21', lodahs: '^1.0.0' }));
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/lodahs': { resolved: 'packages/lodahs', link: true } }, { lodahs: '^1.0.0' })
    );

    // Judged in audit mode so the lockfile-set rules for a new lockfile
    // beside a yarn.lock play no part: what is pinned is the name check.
    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(findingsFor(result, 'typosquat', 'lodahs')).not.toHaveLength(0);
  });

  test('a link entry pointing at a directory with no manifest is not honoured, even in an npm-only repository', async () => {
    await write('package.json', manifest({ lodash: '^4.17.21' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': LODASH_NPM }, { lodash: '^4.17.21' }));
    await commitAll('base');
    await write('package.json', manifest({ lodash: '^4.17.21', lodahs: '^1.0.0' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodash': LODASH_NPM,
          'node_modules/lodahs': { resolved: 'packages/lodahs', link: true },
        },
        { lodash: '^4.17.21', lodahs: '^1.0.0' }
      )
    );

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).not.toHaveLength(0);
    expect(result.exitCode).toBe(1);
  });

  test('a link entry pointing at a manifest with a different name is not honoured', async () => {
    await write('package.json', manifest({ lodash: '^4.17.21' }, { workspaces: ['packages/*'] }));
    await write('packages/real/package.json', JSON.stringify({ name: 'real', version: '1.0.0' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': LODASH_NPM }, { lodash: '^4.17.21' }));
    await commitAll('base');
    await write('package.json', manifest({ lodash: '^4.17.21', lodahs: '^1.0.0' }, { workspaces: ['packages/*'] }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodash': LODASH_NPM,
          'node_modules/lodahs': { resolved: 'packages/real', link: true },
        },
        { lodash: '^4.17.21', lodahs: '^1.0.0' }
      )
    );

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).not.toHaveLength(0);
  });

  test('control: a real npm workspace sibling with that name stays exempt', async () => {
    await write('package.json', manifest({ lodash: '^4.17.21' }, { workspaces: ['packages/*'] }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': LODASH_NPM }, { lodash: '^4.17.21' }));
    await commitAll('base');
    await write('package.json', manifest({ lodash: '^4.17.21', lodahs: '^1.0.0' }, { workspaces: ['packages/*'] }));
    await write('packages/lodahs/package.json', JSON.stringify({ name: 'lodahs', version: '1.0.0' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodash': LODASH_NPM,
          'packages/lodahs': { name: 'lodahs', version: '1.0.0' },
          'node_modules/lodahs': { resolved: 'packages/lodahs', link: true },
        },
        { lodash: '^4.17.21', lodahs: '^1.0.0' }
      )
    );

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).toHaveLength(0);
    expect(result.run.diagnostics.map((d) => d.code)).not.toContain('workspace-link-unconfirmed');
  });

  test('a packageManager field naming pnpm keeps a lone package-lock.json from exempting a name', async () => {
    await write('package.json', manifest({ lodash: '^4.17.21' }, { workspaces: ['packages/*'], packageManager: 'pnpm@9.15.9' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': LODASH_NPM }, { lodash: '^4.17.21' }));
    await commitAll('base');
    await write(
      'package.json',
      manifest({ lodash: '^4.17.21', lodahs: '^1.0.0' }, { workspaces: ['packages/*'], packageManager: 'pnpm@9.15.9' })
    );
    await write('packages/lodahs/package.json', JSON.stringify({ name: 'lodahs', version: '1.0.0' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodash': LODASH_NPM,
          'node_modules/lodahs': { resolved: 'packages/lodahs', link: true },
        },
        { lodash: '^4.17.21', lodahs: '^1.0.0' }
      )
    );

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).not.toHaveLength(0);
  });

  test('control: a packageManager field naming npm settles a directory with two lockfile formats', async () => {
    const pm = { workspaces: ['packages/*'], packageManager: 'npm@10.9.0' };
    await write('package.json', manifest({ lodash: '^4.17.21' }, pm));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': LODASH_NPM }, { lodash: '^4.17.21' }));
    await write('pnpm-lock.yaml', pnpmLock([LODASH_PNPM]));
    await commitAll('base');
    await write('package.json', manifest({ lodash: '^4.17.21', lodahs: '^1.0.0' }, pm));
    await write('packages/lodahs/package.json', JSON.stringify({ name: 'lodahs', version: '1.0.0' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodash': LODASH_NPM,
          'node_modules/lodahs': { resolved: 'packages/lodahs', link: true },
        },
        { lodash: '^4.17.21', lodahs: '^1.0.0' }
      )
    );

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).toHaveLength(0);
  });

  test('a package-lock.json shadowed by an npm-shrinkwrap.json contributes no names', async () => {
    await write('package.json', manifest({ lodash: '^4.17.21' }, { workspaces: ['packages/*'] }));
    await write('npm-shrinkwrap.json', npmLock({ 'node_modules/lodash': LODASH_NPM }, { lodash: '^4.17.21' }));
    await commitAll('base');
    await write('package.json', manifest({ lodash: '^4.17.21', lodahs: '^1.0.0' }, { workspaces: ['packages/*'] }));
    await write('packages/lodahs/package.json', JSON.stringify({ name: 'lodahs', version: '1.0.0' }));
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/lodahs': { resolved: 'packages/lodahs', link: true } }, { lodahs: '^1.0.0' })
    );

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).not.toHaveLength(0);
  });
});

function registryEntry(name: string, version: string, tarballName = name, tarballVersion = version) {
  const basename = tarballName.includes('/') ? tarballName.slice(tarballName.lastIndexOf('/') + 1) : tarballName;
  return {
    version,
    resolved: `https://registry.npmjs.org/${tarballName}/-/${basename}-${tarballVersion}.tgz`,
    integrity: `sha512-${tarballName.replace(/[^a-z]/g, '')}${tarballVersion.replace(/\./g, '')}`,
  };
}

function severityOf(result: ScanResult, packageName: string, signalPrefix: string): string | undefined {
  return findingsFor(result, 'lockfile-tamper', packageName).find((finding) =>
    String(finding.details?.signal ?? '').startsWith(signalPrefix)
  )?.severity;
}

describe('B2: a registry tarball must be the package its lockfile entry names', () => {
  async function commitNpmBase(
    packages: Record<string, Record<string, unknown>> = { 'node_modules/ws': registryEntry('ws', '8.22.0') },
    deps: Record<string, string> = { ws: '^8.22.0' }
  ): Promise<void> {
    await write('package.json', manifest(deps));
    await write('package-lock.json', npmLock(packages, deps));
    await commitAll('base');
  }

  test('a version bump repointed at another package tarball on the public registry is critical', async () => {
    await commitNpmBase();
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ws': registryEntry('ws', '8.22.1', 'flatmap-stream', '0.1.1') }, { ws: '^8.22.0' })
    );

    const result = await scanPullRequest();

    expect(signalsFor(result, 'ws')).toContain('tarball-name-mismatch:flatmap-stream');
    expect(severityOf(result, 'ws', 'tarball-name-mismatch')).toBe('critical');
    expect(result.exitCode).toBe(1);
  });

  test('a new transitive entry resolving to another package tarball is critical', async () => {
    await commitNpmBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/ws': registryEntry('ws', '8.22.0'),
          'node_modules/left-pad': registryEntry('left-pad', '1.3.0', 'event-stream', '3.3.6'),
        },
        { ws: '^8.22.0' }
      )
    );

    const result = await scanPullRequest();

    expect(signalsFor(result, 'left-pad')).toContain('tarball-name-mismatch:event-stream');
    expect(result.exitCode).toBe(1);
  });

  test('a name field naming the other package does not excuse a changed entry', async () => {
    await commitNpmBase();
    await write(
      'package-lock.json',
      npmLock(
        { 'node_modules/ws': { ...registryEntry('ws', '8.22.1', 'flatmap-stream', '0.1.1'), name: 'flatmap-stream' } },
        { ws: '^8.22.0' }
      )
    );

    const result = await scanPullRequest();

    expect(signalsFor(result, 'ws')).toContain('tarball-name-mismatch:flatmap-stream');
    expect(result.exitCode).toBe(1);
  });

  test('a name field does not excuse an entry a manifest declares under its own name', async () => {
    await commitNpmBase({}, {});
    await write('package.json', manifest({ ws: '^8.22.0' }));
    await write(
      'package-lock.json',
      npmLock(
        { 'node_modules/ws': { ...registryEntry('ws', '8.22.1', 'flatmap-stream', '0.1.1'), name: 'flatmap-stream' } },
        { ws: '^8.22.0' }
      )
    );

    const result = await scanPullRequest();

    expect(signalsFor(result, 'ws')).toContain('tarball-name-mismatch:flatmap-stream');
    expect(result.exitCode).toBe(1);
  });

  test('pnpm: an entry bumped to another package tarball URL on the registry is critical', async () => {
    await write('package.json', manifest({ debug: '^4.3.4' }));
    await write('pnpm-lock.yaml', pnpmLock([['debug', '4.3.4', 'integrity: sha512-debug']]));
    await commitAll('base');
    await write('package.json', manifest({ debug: '^4.3.5' }));
    await write(
      'pnpm-lock.yaml',
      pnpmLock([
        [
          'debug',
          '4.3.5',
          'integrity: sha512-evil, tarball: https://registry.npmjs.org/flatmap-stream/-/flatmap-stream-0.1.1.tgz',
        ],
      ])
    );

    const result = await scanPullRequest();

    expect(signalsFor(result, 'debug')).toContain('tarball-name-mismatch:flatmap-stream');
    expect(result.exitCode).toBe(1);
  });

  test('a tarball of the same package at another version is high', async () => {
    await commitNpmBase();
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ws': registryEntry('ws', '8.22.1', 'ws', '8.17.0') }, { ws: '^8.22.0' })
    );

    const result = await scanPullRequest();

    expect(signalsFor(result, 'ws')).toContain('tarball-version-mismatch');
    expect(severityOf(result, 'ws', 'tarball-version-mismatch')).toBe('high');
    expect(result.exitCode).toBe(1);
  });

  test('a registry URL whose path names no package is medium, never a pass', async () => {
    await commitNpmBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/ws': {
            ...registryEntry('ws', '8.22.1'),
            resolved: 'https://registry.npmjs.org/payloads/ws-8.22.1.tgz',
          },
        },
        { ws: '^8.22.0' }
      )
    );

    const result = await scanPullRequest();

    expect(signalsFor(result, 'ws')).toContain('unparseable-tarball:registry.npmjs.org');
    expect(severityOf(result, 'ws', 'unparseable-tarball')).toBe('medium');
    expect(result.exitCode).toBe(1);
  });

  test('a scoped package is compared whole, scope included', async () => {
    await commitNpmBase({ 'node_modules/@types/node': registryEntry('@types/node', '22.0.0') }, { '@types/node': '^22.0.0' });
    await write(
      'package-lock.json',
      npmLock(
        { 'node_modules/@types/node': registryEntry('@types/node', '22.0.1', '@evil/node', '22.0.1') },
        { '@types/node': '^22.0.0' }
      )
    );

    const result = await scanPullRequest();

    expect(signalsFor(result, '@types/node')).toContain('tarball-name-mismatch:@evil/node');
  });

  test('control: an ordinary bump, scoped and unscoped, raises no tarball signal', async () => {
    await commitNpmBase(
      {
        'node_modules/ws': registryEntry('ws', '8.22.0'),
        'node_modules/@types/node': registryEntry('@types/node', '22.0.0'),
      },
      { ws: '^8.22.0', '@types/node': '^22.0.0' }
    );
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/ws': registryEntry('ws', '8.22.1'),
          'node_modules/@types/node': registryEntry('@types/node', '22.0.1'),
        },
        { ws: '^8.22.0', '@types/node': '^22.0.0' }
      )
    );

    const result = await scanPullRequest();

    expect(result.findings.filter((finding) => finding.ruleId === 'lockfile-tamper')).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  test('control: a manifest-declared npm alias resolving to its target is not a mismatch', async () => {
    await commitNpmBase();
    await write('package.json', manifest({ ws: '^8.22.0', foo: 'npm:lodash@^4.17.21' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/ws': registryEntry('ws', '8.22.0'),
          'node_modules/foo': { ...registryEntry('lodash', '4.17.21'), name: 'lodash' },
        },
        { ws: '^8.22.0', foo: 'npm:lodash@^4.17.21' }
      )
    );

    const result = await scanPullRequest();

    expect(result.findings.filter((finding) => finding.ruleId === 'lockfile-tamper')).toHaveLength(0);
  });

  test('control: a transitive alias npm records with a matching name field is not a mismatch', async () => {
    await commitNpmBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          // The dependent's own alias edge, as npm writes it for
          // @isaacs/cliui's string-width-cjs.
          'node_modules/ws': { ...registryEntry('ws', '8.22.0'), dependencies: { 'string-width-cjs': 'npm:string-width@^4.2.0' } },
          'node_modules/string-width-cjs': { ...registryEntry('string-width', '4.2.3'), name: 'string-width' },
        },
        { ws: '^8.22.0' }
      )
    );

    const result = await scanPullRequest();

    expect(result.findings.filter((finding) => finding.ruleId === 'lockfile-tamper')).toHaveLength(0);
  });

  test('control: an alias that was already there survives a version bump', async () => {
    await commitNpmBase({
      'node_modules/ws': registryEntry('ws', '8.22.0'),
      'node_modules/string-width-cjs': { ...registryEntry('string-width', '4.2.2'), name: 'string-width' },
    });
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/ws': registryEntry('ws', '8.22.0'),
          'node_modules/string-width-cjs': { ...registryEntry('string-width', '4.2.3'), name: 'string-width' },
        },
        { ws: '^8.22.0' }
      )
    );

    const result = await scanPullRequest();

    expect(result.findings.filter((finding) => finding.ruleId === 'lockfile-tamper')).toHaveLength(0);
  });

  test('a registry with a path prefix in .npmrc is read past the prefix', async () => {
    const prefixed = (tarballName: string, version: string) => ({
      version,
      resolved: `https://npm.example.com/api/npm/remote/${tarballName}/-/${tarballName}-${version}.tgz`,
      integrity: `sha512-${tarballName.replace(/[^a-z]/g, '')}${version.replace(/\./g, '')}`,
    });
    await write('.npmrc', 'registry=https://npm.example.com/api/npm/remote/\n');
    await commitNpmBase({ 'node_modules/ws': prefixed('ws', '8.22.0') });
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/ws': { ...prefixed('ws', '8.22.1'), dependencies: { 'string-width-cjs': 'npm:string-width@^4.2.0' } },
          'node_modules/left-pad': { ...prefixed('event-stream', '3.3.6'), version: '1.3.0' },
          'node_modules/string-width-cjs': { ...prefixed('string-width', '4.2.3'), name: 'string-width' },
        },
        { ws: '^8.22.0' }
      )
    );

    const result = await scanPullRequest();

    expect(signalsFor(result, 'ws')).toHaveLength(0);
    expect(signalsFor(result, 'string-width-cjs')).toHaveLength(0);
    expect(signalsFor(result, 'left-pad')).toContain('tarball-name-mismatch:event-stream');
  });
});

describe('B3: a manifest beside a lockfile is read whatever its directory is called', () => {
  async function commitRootBase(): Promise<void> {
    await write('package.json', manifest({ lodash: '^4.17.21' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': LODASH_NPM }, { lodash: '^4.17.21' }));
    await commitAll('base');
  }

  test('build/package.json with build/package-lock.json beside it gets the name checks', async () => {
    await commitRootBase();
    await write('build/package.json', manifest({ lodahs: '^1.0.0' }));
    await write(
      'build/package-lock.json',
      npmLock({ 'node_modules/lodahs': registryEntry('lodahs', '1.0.0') }, { lodahs: '^1.0.0' })
    );

    const result = await scanPullRequest();

    const findings = findingsFor(result, 'typosquat', 'lodahs');
    expect(findings).not.toHaveLength(0);
    expect(findings[0].manifestPath).toBe('build/package.json');
    expect(result.exitCode).toBe(1);
    expect(result.run.diagnostics.map((d) => d.code)).not.toContain('manifest-skipped-dirname');
  });

  test('vendor/package.json with a pnpm-lock.yaml beside it gets the name checks', async () => {
    await commitRootBase();
    await write('vendor/tool/package.json', manifest({ lodahs: '^1.0.0' }));
    await write('vendor/tool/pnpm-lock.yaml', pnpmLock([LODAHS_PNPM]));

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).not.toHaveLength(0);
    expect(result.exitCode).toBe(1);
  });

  test('dist/package.json with a yarn.lock beside it gets the name checks', async () => {
    await commitRootBase();
    await write('dist/package.json', manifest({ lodahs: '^1.0.0' }));
    await write('dist/yarn.lock', '# yarn lockfile v1\n');

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).not.toHaveLength(0);
  });

  test('control: build/package.json with no lockfile beside it keeps the note and is not read', async () => {
    await commitRootBase();
    await write('build/package.json', manifest({ lodahs: '^1.0.0' }));

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).toHaveLength(0);
    const note = result.run.diagnostics.find((d) => d.code === 'manifest-skipped-dirname');
    expect(note?.message).toContain('build/package.json');
    expect(note?.message).not.toContain('would still be read');
  });
});

// Variants an independent review reproduced against the first round of
// these fixes, each of which still exited 0.
describe('review round: B1, a link target must be a workspace member of its install root', () => {
  async function commitNpmOnlyBase(extra: Record<string, unknown> = {}): Promise<void> {
    await write('package.json', manifest({ lodash: '^4.17.21' }, extra));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': LODASH_NPM }, { lodash: '^4.17.21' }));
    await commitAll('base');
  }

  test('B1a: a planted package.json outside every workspaces glob does not exempt the name', async () => {
    await commitNpmOnlyBase();
    await write('package.json', manifest({ lodash: '^4.17.21', lodahs: '^1.0.0' }));
    await write('evil/lodahs/package.json', JSON.stringify({ name: 'lodahs', version: '0.0.1' }));
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/lodash': LODASH_NPM,
          'node_modules/lodahs': { resolved: 'evil/lodahs', link: true },
          'evil/lodahs': { name: 'lodahs', version: '0.0.1' },
        },
        { lodash: '^4.17.21', lodahs: '^1.0.0' }
      )
    );

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).not.toHaveLength(0);
    expect(result.exitCode).toBe(1);
    expect(result.run.diagnostics.find((d) => d.code === 'workspace-link-unconfirmed')?.message).toContain(
      'workspaces'
    );
  });

  test('B1b: a pnpm repository switched to packageManager npm with a planted package does not exempt it', async () => {
    await write('package.json', manifest({ lodash: '^4.17.21' }));
    await write('pnpm-lock.yaml', pnpmLock([LODASH_PNPM]));
    await commitAll('base');
    await write('package.json', manifest({ lodash: '^4.17.21', lodahs: '^1.0.0' }, { packageManager: 'npm@10.9.0' }));
    await write('pnpm-lock.yaml', pnpmLock([LODASH_PNPM, LODAHS_PNPM]));
    await write('evil/lodahs/package.json', JSON.stringify({ name: 'lodahs', version: '1.0.0' }));
    await write(
      'package-lock.json',
      JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodahs': { resolved: 'evil/lodahs', link: true } } })
    );

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).not.toHaveLength(0);
    expect(result.exitCode).toBe(1);
  });

  test('B1f: a bare packageManager npm with a planted package does not exempt it', async () => {
    await write('package.json', manifest({ lodash: '^4.17.21' }));
    await write('pnpm-lock.yaml', pnpmLock([LODASH_PNPM]));
    await commitAll('base');
    await write('package.json', manifest({ lodash: '^4.17.21', lodahs: '^1.0.0' }, { packageManager: 'npm' }));
    await write('pnpm-lock.yaml', pnpmLock([LODASH_PNPM, LODAHS_PNPM]));
    await write('evil/lodahs/package.json', JSON.stringify({ name: 'lodahs', version: '1.0.0' }));
    await write(
      'package-lock.json',
      JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodahs': { resolved: 'evil/lodahs', link: true } } })
    );

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).not.toHaveLength(0);
  });

  test('under --trust-base a workspaces glob the pull request adds does not confirm its own link', async () => {
    await commitNpmOnlyBase({ workspaces: ['packages/*'] });
    await write(
      'package.json',
      manifest({ lodash: '^4.17.21', lodahs: '^1.0.0' }, { workspaces: ['packages/*', 'evil/*'] })
    );
    await write('evil/lodahs/package.json', JSON.stringify({ name: 'lodahs', version: '1.0.0' }));
    await write(
      'package-lock.json',
      npmLock(
        { 'node_modules/lodash': LODASH_NPM, 'node_modules/lodahs': { resolved: 'evil/lodahs', link: true } },
        { lodash: '^4.17.21', lodahs: '^1.0.0' }
      )
    );

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).not.toHaveLength(0);
    const note = result.run.diagnostics.find((d) => d.code === 'workspace-link-unconfirmed')?.message ?? '';
    expect(note).toContain('on the trust base');
    expect(note).toContain('this change edits that field');
  });

  test('control: a member the base glob already covers, added in the pull request, stays exempt', async () => {
    await commitNpmOnlyBase({ workspaces: ['packages/*'] });
    await write('package.json', manifest({ lodash: '^4.17.21', lodahs: '^1.0.0' }, { workspaces: ['packages/*'] }));
    await write('packages/lodahs/package.json', JSON.stringify({ name: 'lodahs', version: '1.0.0' }));
    await write(
      'package-lock.json',
      npmLock(
        { 'node_modules/lodash': LODASH_NPM, 'node_modules/lodahs': { resolved: 'packages/lodahs', link: true } },
        { lodash: '^4.17.21', lodahs: '^1.0.0' }
      )
    );

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).toHaveLength(0);
    expect(result.run.diagnostics.map((d) => d.code)).not.toContain('workspace-link-unconfirmed');
  });
});

describe('review round: B3, a workspace member of an install root under a skipped directory is read', () => {
  async function commitRootBase(): Promise<void> {
    await write('package.json', manifest({ lodash: '^4.17.21' }));
    await write('package-lock.json', npmLock({ 'node_modules/lodash': LODASH_NPM }, { lodash: '^4.17.21' }));
    await commitAll('base');
  }

  test('B3a: build/app declared by build/package.json workspaces gets the name checks', async () => {
    await commitRootBase();
    await write('build/package.json', manifest({}, { workspaces: ['app'] }));
    await write('build/app/package.json', JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { lodahs: '^1.0.0' } }));
    await write(
      'build/package-lock.json',
      npmLock(
        {
          'node_modules/app': { resolved: 'app', link: true },
          app: { name: 'app', version: '1.0.0', dependencies: { lodahs: '^1.0.0' } },
          'node_modules/lodahs': registryEntry('lodahs', '1.0.0'),
        },
        {}
      )
    );

    const result = await scanPullRequest();

    const findings = findingsFor(result, 'typosquat', 'lodahs');
    expect(findings).not.toHaveLength(0);
    expect(findings[0].manifestPath).toBe('build/app/package.json');
    expect(result.exitCode).toBe(1);
  });

  test('a pnpm install root under vendor reads the members its pnpm-workspace.yaml names', async () => {
    await commitRootBase();
    await write('vendor/tool/package.json', manifest({}));
    await write('vendor/tool/pnpm-workspace.yaml', "packages:\n  - 'pkgs/*'\n");
    await write('vendor/tool/pkgs/a/package.json', JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { lodahs: '^1.0.0' } }));
    await write('vendor/tool/pnpm-lock.yaml', pnpmLock([LODAHS_PNPM]));

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).not.toHaveLength(0);
  });

  test('a committed node_modules package with a lockfile beside it is still not read', async () => {
    await commitRootBase();
    await write(
      'node_modules/foo/package.json',
      JSON.stringify({ name: 'foo', version: '1.0.0', dependencies: { lodahs: '^1.0.0' } })
    );
    await write('node_modules/foo/yarn.lock', '# yarn lockfile v1\n');

    const result = await scanPullRequest();

    expect(findingsFor(result, 'typosquat', 'lodahs')).toHaveLength(0);
  });
});

describe('review round: the alias excuse needs an alias edge, and its target is name-checked', () => {
  async function commitWsBase(packages: Record<string, Record<string, unknown>> = {}): Promise<void> {
    await write('package.json', manifest({ ws: '^8.22.0' }));
    await write(
      'package-lock.json',
      npmLock({ 'node_modules/ws': registryEntry('ws', '8.22.0'), ...packages }, { ws: '^8.22.0' })
    );
    await commitAll('base');
  }

  test('C1: an added transitive entry whose name field names another package, with no alias edge, is critical', async () => {
    await commitWsBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/ws': registryEntry('ws', '8.22.0'),
          'node_modules/left-pad': { ...registryEntry('left-pad', '3.3.6', 'event-stream', '3.3.6'), name: 'event-stream' },
        },
        { ws: '^8.22.0' }
      )
    );

    const result = await scanPullRequest();

    expect(signalsFor(result, 'left-pad')).toContain('tarball-name-mismatch:event-stream');
    expect(result.exitCode).toBe(1);
  });

  test('C1b: the same under a nested key is critical', async () => {
    await commitWsBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/ws': registryEntry('ws', '8.22.0'),
          'node_modules/ws/node_modules/lodash': {
            ...registryEntry('lodash', '0.1.1', 'flatmap-stream', '0.1.1'),
            name: 'flatmap-stream',
          },
        },
        { ws: '^8.22.0' }
      )
    );

    const result = await scanPullRequest();

    expect(signalsFor(result, 'lodash')).toContain('tarball-name-mismatch:flatmap-stream');
  });

  test('an alias edge clears the tarball check, and the alias target is name-checked instead', async () => {
    await commitWsBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/ws': { ...registryEntry('ws', '8.22.0'), dependencies: { 'left-pad': 'npm:lodahs@^1.0.0' } },
          'node_modules/left-pad': { ...registryEntry('lodahs', '1.0.0'), name: 'lodahs' },
        },
        { ws: '^8.22.0' }
      )
    );

    const result = await scanPullRequest();

    expect(signalsFor(result, 'left-pad')).toHaveLength(0);
    expect(findingsFor(result, 'typosquat', 'lodahs')).not.toHaveLength(0);
    expect(result.exitCode).toBe(1);
  });

  test('C1c: a changed transitive entry gets no alias excuse even with an alias edge', async () => {
    await commitWsBase({ 'node_modules/debug': registryEntry('debug', '4.3.4') });
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/ws': { ...registryEntry('ws', '8.22.0'), dependencies: { debug: 'npm:flatmap-stream@4.3.5' } },
          'node_modules/debug': { ...registryEntry('debug', '4.3.5', 'flatmap-stream', '4.3.5'), name: 'flatmap-stream' },
        },
        { ws: '^8.22.0' }
      )
    );

    const result = await scanPullRequest();

    expect(signalsFor(result, 'debug')).toContain('tarball-name-mismatch:flatmap-stream');
    expect(result.exitCode).toBe(1);
  });

  test('C1c as the review wrote it, with no alias edge, is critical', async () => {
    await commitWsBase({ 'node_modules/debug': registryEntry('debug', '4.3.4') });
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/ws': registryEntry('ws', '8.22.0'),
          'node_modules/debug': { ...registryEntry('debug', '4.3.5', 'flatmap-stream', '4.3.5'), name: 'flatmap-stream' },
        },
        { ws: '^8.22.0' }
      )
    );

    const result = await scanPullRequest();

    expect(signalsFor(result, 'debug')).toContain('tarball-name-mismatch:flatmap-stream');
  });
});

describe('review round: a percent-encoded scope in a tarball path', () => {
  async function commitTypesBase(): Promise<void> {
    const deps = { '@types/node': '^22.0.0', '@types/ws': '^8.0.0' };
    await write('package.json', manifest(deps));
    await write(
      'package-lock.json',
      npmLock(
        { 'node_modules/@types/node': registryEntry('@types/node', '22.0.0'), 'node_modules/@types/ws': registryEntry('@types/ws', '8.0.0') },
        deps
      )
    );
    await commitAll('base');
  }

  test('@types%2fnode reads as @types/node and is clean', async () => {
    await commitTypesBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/@types/node': {
            ...registryEntry('@types/node', '22.0.1'),
            resolved: 'https://registry.npmjs.org/@types%2fnode/-/node-22.0.1.tgz',
          },
          'node_modules/@types/ws': registryEntry('@types/ws', '8.0.0'),
        },
        { '@types/node': '^22.0.0', '@types/ws': '^8.0.0' }
      )
    );

    const result = await scanPullRequest();

    expect(signalsFor(result, '@types/node')).toHaveLength(0);
  });

  test('@evil%2fws under @types/ws is critical', async () => {
    await commitTypesBase();
    await write(
      'package-lock.json',
      npmLock(
        {
          'node_modules/@types/node': registryEntry('@types/node', '22.0.0'),
          'node_modules/@types/ws': {
            ...registryEntry('@types/ws', '8.0.1'),
            resolved: 'https://registry.npmjs.org/@evil%2fws/-/ws-8.0.1.tgz',
          },
        },
        { '@types/node': '^22.0.0', '@types/ws': '^8.0.0' }
      )
    );

    const result = await scanPullRequest();

    expect(signalsFor(result, '@types/ws')).toContain('tarball-name-mismatch:@evil/ws');
    expect(severityOf(result, '@types/ws', 'tarball-name-mismatch')).toBe('critical');
  });
});
