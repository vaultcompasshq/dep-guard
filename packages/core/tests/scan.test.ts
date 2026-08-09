import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fingerprintFinding } from '../src/fingerprint.js';
import { checkSingle, scan } from '../src/scan.js';
import { COMPARISON_TAMPER_SIGNALS } from '../src/tamper-signals.js';
import { DepGuardError } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CORPUS = path.join(__dirname, '..', 'fixtures', 'corpus');

const execFileAsync = promisify(execFile);

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

function manifestJson(dependencies: Record<string, string>): string {
  return JSON.stringify({ name: 'root', version: '1.0.0', dependencies });
}

// A lockfileVersion 3 package-lock, built from the packages map alone: the
// root "" entry is filled in for every fixture so the lockfile is the shape
// npm actually writes, and each test only has to spell out the resolved
// entries the scenario turns on.
function npmLockJson(
  packages: Record<string, Record<string, unknown>>,
  rootDependencies: Record<string, string> = {}
): string {
  return JSON.stringify({
    name: 'root',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'root', version: '1.0.0', dependencies: rootDependencies },
      ...packages,
    },
  });
}

const CLEAN_LODASH = {
  version: '4.17.21',
  resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
  integrity: 'sha512-cleanlodash',
};

const CLEAN_ANSI_REGEX = {
  version: '5.0.1',
  resolved: 'https://registry.npmjs.org/ansi-regex/-/ansi-regex-5.0.1.tgz',
  integrity: 'sha512-cleanansi',
};

function signalsFor(findings: readonly { ruleId: string; packageName: string; details?: Record<string, unknown> }[], packageName: string): string[] {
  return findings
    .filter((finding) => finding.ruleId === 'lockfile-tamper' && finding.packageName === packageName)
    .map((finding) => String(finding.details?.signal ?? ''));
}

beforeEach(async () => {
  repo = await makeTempDir('dep-guard-scan-');
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

describe('scan', () => {
  test('staging a manifest that adds an unknown package yields a blocking unknown-package finding', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');
    await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ruleId: 'unknown-package',
      packageName: 'reeact-definitely-not-real',
      manifestPath: 'package.json',
    });
    expect(result.findings[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.suppressed).toBe(0);
    expect(result.run.mode).toBe('staged');
    expect(result.run.failOn).toBe('medium');
    expect(result.run.blockingMatches).toBe(1);
    expect(result.run.corpusBuiltAt).toBe('2026-08-01');
    expect(result.run.lockfileFormat).toBe('none');
    expect(typeof result.run.durationMs).toBe('number');
    expect(result.run.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.exitCode).toBe(1);
  });

  test('baselining the finding fingerprint suppresses it', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');
    await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
    await git('add', '-A');

    const fingerprint = fingerprintFinding({
      ruleId: 'unknown-package',
      severity: 'high',
      packageName: 'reeact-definitely-not-real',
      message: 'irrelevant to the hash',
      manifestPath: 'package.json',
    });
    await write(
      '.dep-guard.baseline.json',
      JSON.stringify({ version: 1, fingerprints: [fingerprint] })
    );

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(result.findings).toHaveLength(0);
    expect(result.suppressed).toBe(1);
    expect(result.run.blockingMatches).toBe(0);
    expect(result.exitCode).toBe(0);
  });

  test('a clean staged scan with no new dependencies exits 0', async () => {
    await write('package.json', manifestJson({ react: '18.0.0' }));
    await commitAll('first');
    await write('package.json', manifestJson({ react: '18.0.0' }));
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(result.findings).toHaveLength(0);
    expect(result.suppressed).toBe(0);
    expect(result.exitCode).toBe(0);
  });

  describe('ignorePaths', () => {
    test('a finding whose manifestPath matches an ignore entry is dropped', async () => {
      await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['package.json'] }));
      await write('package.json', manifestJson({}));
      await commitAll('first');
      await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
      await git('add', '-A');

      const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

      expect(result.findings).toHaveLength(0);
      expect(result.suppressed).toBe(0); // dropped by ignorePaths, not the baseline
      expect(result.ignored).toBe(1);
      expect(result.run.blockingMatches).toBe(0);
      expect(result.exitCode).toBe(0);
    });

    test('an ignore entry for a different path does not drop the finding', async () => {
      await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['vendor/'] }));
      await write('package.json', manifestJson({}));
      await commitAll('first');
      await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
      await git('add', '-A');

      const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

      expect(result.findings).toHaveLength(1);
      expect(result.exitCode).toBe(1);
    });

    test('a directory-style ignore entry drops findings from every manifest underneath it', async () => {
      await write(
        '.dep-guard.json',
        JSON.stringify({ ignorePaths: ['packages/vendored'] })
      );
      await write('package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
      await write(
        'packages/vendored/package.json',
        JSON.stringify({ name: 'vendored', dependencies: {} })
      );
      await commitAll('first');
      await write(
        'packages/vendored/package.json',
        JSON.stringify({
          name: 'vendored',
          dependencies: { 'reeact-definitely-not-real': '1.0.0' },
        })
      );
      await git('add', '-A');

      const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

      expect(result.findings).toHaveLength(0);
      expect(result.exitCode).toBe(0);
    });
  });

  // If a finding dropped by ignorePaths vanished with nothing to show for
  // it -- neither suppressed (that counter is the baseline's) nor
  // anywhere else -- it would be byte-identical to a genuinely clean
  // scan. A wildcard entry that matches every manifest at any depth is
  // the simplest possible drop to pin down; a bare "**" would be the
  // same test but is refused outright by config validation.
  describe('ignored count', () => {
    test('a wildcard ignorePaths entry that matches is counted in "ignored", separately from "suppressed"', async () => {
      await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['**/package.json'] }));
      await write('package.json', manifestJson({}));
      await commitAll('first');
      await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
      await git('add', '-A');

      const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

      expect(result.findings).toHaveLength(0);
      expect(result.ignored).toBe(1);
      expect(result.suppressed).toBe(0);
      expect(result.exitCode).toBe(0);
    });
  });

  // The matcher's whole-path, segment-for-segment semantics are kept
  // (that precision is the point -- see git-source.ts), but a config
  // entry that never matched anything is exactly the kind of silent
  // no-op a user cannot discover on their own, so it gets a diagnostic
  // instead.
  describe('ignorePaths coverage diagnostic', () => {
    test('an entry that matches no finding path is named in a diagnostic, and the finding is not dropped', async () => {
      // The natural-looking "packages/*" does not match a manifest one
      // level deeper ("packages/vendored/package.json" is three segments,
      // "packages/*" is two) -- the matcher compares whole paths, not
      // prefixes, once a wildcard is involved.
      await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['packages/*'] }));
      await write('package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
      await write('packages/vendored/package.json', JSON.stringify({ name: 'vendored', dependencies: {} }));
      await commitAll('first');
      await write(
        'packages/vendored/package.json',
        JSON.stringify({ name: 'vendored', dependencies: { 'reeact-definitely-not-real': '1.0.0' } })
      );
      await git('add', '-A');

      const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

      expect(result.findings).toHaveLength(1);
      expect(result.ignored).toBe(0);
      const notice = result.run.diagnostics.find((d) => d.code === 'ignore-path-unmatched');
      expect(notice?.message).toContain('packages/*');
    });

    test('an entry that did match produces no unmatched diagnostic', async () => {
      await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['package.json'] }));
      await write('package.json', manifestJson({}));
      await commitAll('first');
      await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
      await git('add', '-A');

      const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

      expect(result.run.diagnostics.map((d) => d.code)).not.toContain('ignore-path-unmatched');
    });

    // dep-guard runs per commit, where most runs are clean. Deriving
    // "unmatched" from findings alone would mean a clean scan with any
    // ignorePaths configured warns on nearly every invocation -- exactly
    // the noise this diagnostic exists to avoid creating. Gated on there
    // having been at least one raw finding to check entries against at
    // all.
    test('a clean scan with ignorePaths configured does not warn about any entry', async () => {
      await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['packages/*'] }));
      await write('package.json', manifestJson({ react: '18.0.0' }));
      await commitAll('first');
      await write('package.json', manifestJson({ react: '18.0.0' }));
      await git('add', '-A');

      const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

      expect(result.findings).toHaveLength(0);
      expect(result.run.diagnostics.map((d) => d.code)).not.toContain('ignore-path-unmatched');
    });

    // If matchingIgnoreEntry were first-match-wins, with ignorePaths
    // ["package.json", "**/package.json"] the exact entry checked first
    // would short-circuit before the wildcard was ever evaluated against
    // the SAME finding, and the wildcard -- which genuinely covers it
    // too, redundantly -- would be reported unmatched. Every entry that
    // matches a given finding gets credited instead, not just the first
    // one checked.
    test('every entry that matches the same finding is credited, not just the first one checked', async () => {
      await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['package.json', '**/package.json'] }));
      await write('package.json', manifestJson({}));
      await commitAll('first');
      await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
      await git('add', '-A');

      const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

      expect(result.findings).toHaveLength(0);
      expect(result.ignored).toBe(1);
      expect(result.run.diagnostics.map((d) => d.code)).not.toContain('ignore-path-unmatched');
    });

    // Still-valid case: a genuinely unused entry alongside one that did
    // match must still warn -- fixing modes 1 and 2 above must not make
    // this diagnostic silent altogether.
    test('a genuinely unused entry still warns even when another entry in the same list matched', async () => {
      await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['package.json', 'vendor/'] }));
      await write('package.json', manifestJson({}));
      await commitAll('first');
      await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
      await git('add', '-A');

      const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

      expect(result.findings).toHaveLength(0); // "package.json" matched and dropped it
      const notice = result.run.diagnostics.find((d) => d.code === 'ignore-path-unmatched');
      expect(notice?.message).toContain('vendor/');
    });
  });

  // The CLI's --fail-on needs a way to override config.failOn per
  // invocation without re-exporting the gate itself; blockingMatches and
  // run.failOn both have to reflect the override, not the config value.
  describe('failOn override', () => {
    test('an explicit failOn overrides the config default', async () => {
      await write('package.json', manifestJson({}));
      await commitAll('first');
      await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
      await git('add', '-A');

      const result = await scan({
        repoRoot: repo,
        mode: { kind: 'staged' },
        corpusDir: FIXTURE_CORPUS,
        failOn: 'critical',
      });

      expect(result.run.failOn).toBe('critical');
      expect(result.run.blockingMatches).toBe(0); // unknown-package is "high", not "critical"
      expect(result.exitCode).toBe(0);
    });
  });

  // manifests always resolve against the git root (git-source.ts anchors
  // every path there in every mode), but reading config and the baseline
  // from whatever directory opts.repoRoot named would mean scanning a
  // subdirectory silently discards the repository's own .dep-guard.json
  // and baseline. Both tests below scan the SAME repo from a
  // subdirectory and confirm root-level config/baseline still apply.
  describe('config and baseline resolve against the git root', () => {
    test('a subdirectory scan still honours the repo-root .dep-guard.json', async () => {
      await write('.dep-guard.json', JSON.stringify({ failOn: 'critical' }));
      await write('package.json', manifestJson({}));
      await write('sub/keep.txt', 'a subdirectory to scan from\n');
      await commitAll('first');
      await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
      await git('add', '-A');

      const fromRoot = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });
      const fromSub = await scan({
        repoRoot: path.join(repo, 'sub'),
        mode: { kind: 'staged' },
        corpusDir: FIXTURE_CORPUS,
      });

      expect(fromRoot.run.failOn).toBe('critical');
      expect(fromSub.run.failOn).toBe('critical');
      // "high" severity under a "critical" threshold: neither blocks.
      expect(fromRoot.exitCode).toBe(0);
      expect(fromSub.exitCode).toBe(0);
    });

    test('a subdirectory scan still honours the repo-root baseline', async () => {
      await write('package.json', manifestJson({}));
      await write('sub/keep.txt', 'a subdirectory to scan from\n');
      await commitAll('first');
      await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
      await git('add', '-A');

      const fingerprint = fingerprintFinding({
        ruleId: 'unknown-package',
        severity: 'high',
        packageName: 'reeact-definitely-not-real',
        message: 'irrelevant to the hash',
        manifestPath: 'package.json',
      });
      await write('.dep-guard.baseline.json', JSON.stringify({ version: 1, fingerprints: [fingerprint] }));

      const fromSub = await scan({
        repoRoot: path.join(repo, 'sub'),
        mode: { kind: 'staged' },
        corpusDir: FIXTURE_CORPUS,
      });

      expect(fromSub.suppressed).toBe(1);
      expect(fromSub.exitCode).toBe(0);
    });
  });

  describe('diagnostics', () => {
    test('the pnpm no-install-script-flag diagnostic is merged, not doubled', async () => {
      await write('package.json', manifestJson({ lodash: '4.17.20' }));
      await write(
        'pnpm-lock.yaml',
        ['lockfileVersion: "9.0"', 'packages:', '  lodash@4.17.20:', '    resolution: {}', ''].join(
          '\n'
        )
      );
      await commitAll('first');
      await write('package.json', manifestJson({ lodash: '4.17.21' }));
      await write(
        'pnpm-lock.yaml',
        ['lockfileVersion: "9.0"', 'packages:', '  lodash@4.17.21:', '    resolution: {}', ''].join(
          '\n'
        )
      );
      await git('add', '-A');

      const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

      expect(result.run.lockfileFormat).toBe('pnpm');
      const pnpmDiagnostics = result.run.diagnostics.filter(
        (d) => d.code === 'pnpm-no-install-script-flag'
      );
      expect(pnpmDiagnostics).toHaveLength(1);
    });

    test('StatePair diagnostics (e.g. an unsupported workspace glob) reach the run block', async () => {
      await write(
        'package.json',
        JSON.stringify({ name: 'root', workspaces: ['packages/*/inner'] })
      );
      await git('add', '-A');

      const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

      expect(result.run.diagnostics.map((d) => d.code)).toContain('workspace-glob-unsupported');
    });
  });

  // If loadConfig ran before the scannable-path check, naming a file
  // where a directory belongs would surface as config-invalid
  // (path.join(file, '.dep-guard.json') fails with ENOTDIR, which reads
  // as "the config file could not be read") instead of the plain
  // path-missing this actually is.
  describe('a repoRoot that is a file, not a directory', () => {
    test('reports path-missing, not config-invalid', async () => {
      await write('not-a-directory.json', '{}');
      const filePath = path.join(repo, 'not-a-directory.json');

      let caught: unknown;
      try {
        await scan({ repoRoot: filePath, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DepGuardError);
      expect((caught as DepGuardError).code).toBe('path-missing');
    });

    test('a repoRoot that does not exist at all also reports path-missing', async () => {
      const missing = path.join(repo, 'no-such-directory');

      let caught: unknown;
      try {
        await scan({ repoRoot: missing, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DepGuardError);
      expect((caught as DepGuardError).code).toBe('path-missing');
    });
  });
});

describe('checkSingle', () => {
  test('a typosquat name returns the typosquat finding', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');

    const result = await checkSingle({ repoRoot: repo, name: 'raect', corpusDir: FIXTURE_CORPUS });

    // 'raect' is also absent from the corpus outright, so the existence
    // check reports it too -- checkSingle runs the same six checks a scan
    // does, and this name genuinely trips two of them. The typosquat
    // finding, which is the one this test exists to pin down, still has
    // to be among them.
    const typosquat = result.findings.find((f) => f.ruleId === 'typosquat');
    expect(typosquat).toMatchObject({ ruleId: 'typosquat', packageName: 'raect' });
    expect(result.run.mode).toBe('audit');
    expect(result.run.corpusBuiltAt).toBe('2026-08-01');
  });

  test('a known-good name returns no findings', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');

    const result = await checkSingle({ repoRoot: repo, name: 'react', corpusDir: FIXTURE_CORPUS });

    expect(result.findings).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  test('an unknown name returns the unknown-package finding', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');

    const result = await checkSingle({
      repoRoot: repo,
      name: 'reeact-definitely-not-real',
      corpusDir: FIXTURE_CORPUS,
    });

    expect(result.findings.map((f) => f.ruleId)).toContain('unknown-package');
  });

  // checkSingle fabricates 'package.json' as a manifestPath since there
  // is no real file behind the propose-time question. Filtering against
  // that fabricated location -- via ignorePaths, or via the baseline
  // (whose fingerprints are keyed off manifestPath too) -- would let a
  // repo's config for a completely unrelated question silently launder
  // "is this name safe" into "clean" answers.
  describe('skips path-based filters', () => {
    test('an ignorePaths entry matching the synthetic manifest path does not suppress the finding', async () => {
      await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['package.json'] }));
      await write('package.json', manifestJson({}));
      await commitAll('first');

      const result = await checkSingle({ repoRoot: repo, name: 'raect', corpusDir: FIXTURE_CORPUS });

      const typosquat = result.findings.find((f) => f.ruleId === 'typosquat');
      expect(typosquat).toBeDefined();
      expect(result.ignored).toBe(0);
    });

    test('a baseline entry matching the synthetic finding fingerprint does not suppress it', async () => {
      await write('package.json', manifestJson({}));
      await commitAll('first');

      const fingerprint = fingerprintFinding({
        ruleId: 'typosquat',
        severity: 'critical',
        packageName: 'raect',
        message: 'irrelevant to the hash',
        manifestPath: 'package.json',
      });
      await write('.dep-guard.baseline.json', JSON.stringify({ version: 1, fingerprints: [fingerprint] }));

      const result = await checkSingle({ repoRoot: repo, name: 'raect', corpusDir: FIXTURE_CORPUS });

      const typosquat = result.findings.find((f) => f.ruleId === 'typosquat');
      expect(typosquat).toBeDefined();
      expect(result.suppressed).toBe(0);
    });
  });

  // checkSingle structurally only exercises existence, typosquat, and
  // confusion's internal-name rule -- there is no lockfile for tamper or
  // install-script to read, and the synthetic specifier can never be one
  // of hygiene's flagged forms. install-script.ts's own doctrine (its
  // standing pnpm diagnostic) is "say when coverage was skipped instead of
  // going quiet and looking clean"; checkSingle needs the same courtesy.
  describe('diagnoses its own reduced coverage', () => {
    test('every checkSingle call reports the check-single-name-only diagnostic', async () => {
      await write('package.json', manifestJson({}));
      await commitAll('first');

      const result = await checkSingle({ repoRoot: repo, name: 'react', corpusDir: FIXTURE_CORPUS });

      expect(result.run.diagnostics.map((d) => d.code)).toContain('check-single-name-only');
    });
  });

  // An empty name has no meaningful answer -- silently reporting "safe"
  // for it would be actively misleading, especially since it would
  // otherwise surface via a manifest-alias-empty diagnostic that has
  // nothing to do with what actually happened.
  describe('rejects an unusable name', () => {
    test('an empty name throws a DepGuardError rather than answering "safe"', async () => {
      await write('package.json', manifestJson({}));
      await commitAll('first');

      await expect(checkSingle({ repoRoot: repo, name: '', corpusDir: FIXTURE_CORPUS })).rejects.toThrow(
        DepGuardError
      );
    });

    test('a whitespace-only name is rejected the same way, with code name-invalid', async () => {
      await write('package.json', manifestJson({}));
      await commitAll('first');

      let caught: unknown;
      try {
        await checkSingle({ repoRoot: repo, name: '   ', corpusDir: FIXTURE_CORPUS });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DepGuardError);
      expect((caught as DepGuardError).code).toBe('name-invalid');
    });
  });

  // Same ordering rule as scan()'s -- checkSingle must not read config
  // before checking whether repoRoot is actually a directory.
  describe('a repoRoot that is a file, not a directory', () => {
    test('reports path-missing, not a config error', async () => {
      await write('not-a-directory.json', '{}');
      const filePath = path.join(repo, 'not-a-directory.json');

      let caught: unknown;
      try {
        await checkSingle({ repoRoot: filePath, name: 'left-pad', corpusDir: FIXTURE_CORPUS });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DepGuardError);
      expect((caught as DepGuardError).code).toBe('path-missing');
    });
  });

  // checkSingle gets the same failOn override scan() does, so the CLI
  // can implement `dep-guard check --fail-on` without a second gate path.
  describe('failOn override', () => {
    test('an explicit failOn overrides the config default', async () => {
      await write('package.json', manifestJson({}));
      await commitAll('first');

      const result = await checkSingle({
        repoRoot: repo,
        name: 'raect',
        corpusDir: FIXTURE_CORPUS,
        failOn: 'none',
      });

      expect(result.run.failOn).toBe('none');
      expect(result.exitCode).toBe(0);
    });
  });
});

// The delta's manifest walk answers "which declared dependencies moved",
// and the tamper and install-script checks would consume only that
// answer if they read nothing else. Both attacks below live entirely
// inside the lockfile, where the overwhelming majority of entries are
// transitive and no manifest declares them at all, so the manifest walk
// alone could not see either one.
describe('lockfile entries are compared in full, not only where a manifest declares them', () => {
  test('a transitive entry repointed at another host, stripped of its integrity, and given an install script blocks the scan', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson(
        { 'node_modules/lodash': CLEAN_LODASH, 'node_modules/ansi-regex': CLEAN_ANSI_REGEX },
        { lodash: '^4.17.21' }
      )
    );
    await commitAll('first');

    await write(
      'package-lock.json',
      npmLockJson(
        {
          'node_modules/lodash': CLEAN_LODASH,
          'node_modules/ansi-regex': {
            version: '5.0.1',
            resolved: 'https://evil.example.test/ansi-regex/-/ansi-regex-5.0.1.tgz',
            hasInstallScript: true,
          },
        },
        { lodash: '^4.17.21' }
      )
    );
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    const signals = signalsFor(result.findings, 'ansi-regex');
    expect(signals.some((signal) => signal.startsWith('host-changed'))).toBe(true);
    expect(signals).toContain('integrity-removed');
    expect(
      result.findings.some(
        (finding) => finding.ruleId === 'install-script' && finding.packageName === 'ansi-regex'
      )
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  // The anchor Finding.lockfilePath has carried since the type was written,
  // populated by nothing until now: a finding about a lockfile entry has to
  // name the lockfile, or the only location it reports is a manifest that
  // never mentioned the package.
  test('a lockfile-derived finding names the lockfile it came from', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson({ 'node_modules/ansi-regex': CLEAN_ANSI_REGEX }, { lodash: '^4.17.21' })
    );
    await commitAll('first');

    await write(
      'package-lock.json',
      npmLockJson(
        {
          'node_modules/ansi-regex': {
            version: '5.0.1',
            resolved: 'https://evil.example.test/ansi-regex/-/ansi-regex-5.0.1.tgz',
            integrity: 'sha512-cleanansi',
          },
        },
        { lodash: '^4.17.21' }
      )
    );
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    const tamper = result.findings.find((finding) => finding.ruleId === 'lockfile-tamper');
    expect(tamper?.lockfilePath).toBe('package-lock.json');
  });

  test('a same-version decoy entry does not hide a tampered top-level entry', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' })
    );
    await commitAll('first');

    // npm installs the top-level entry; the nested one exists only to give
    // a single-answer selector something innocent to pick.
    await write(
      'package-lock.json',
      npmLockJson(
        {
          'node_modules/lodash': {
            version: '4.17.21',
            resolved: 'https://evil.example.test/lodash/-/lodash-4.17.21.tgz',
          },
          'node_modules/decoy/node_modules/lodash': CLEAN_LODASH,
        },
        { lodash: '^4.17.21' }
      )
    );
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    const signals = signalsFor(result.findings, 'lodash');
    expect(signals.some((signal) => signal.startsWith('host-changed'))).toBe(true);
    expect(signals).toContain('integrity-removed');
    expect(result.exitCode).toBe(1);
  });

  // If the counterpart-ambiguity suppression were end to end, it would be
  // constructible: nested duplicates give most real lockfiles several
  // entries under one name; giving the repointed entry a version none of
  // them shares would make every narrowing step fail, and a guessed
  // pairing would suppress every comparison signal at once. The verdict
  // here does not depend on the guess -- neither earlier entry resolved
  // from the attacker's host -- so it is reported.
  test('a repoint hidden behind two indistinguishable earlier entries is still caught', async () => {
    const nested = {
      version: '4.1.1',
      resolved: 'https://registry.npmjs.org/ansi-regex/-/ansi-regex-4.1.1.tgz',
      integrity: 'sha512-nestedansi',
    };
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson(
        {
          'node_modules/lodash': CLEAN_LODASH,
          'node_modules/ansi-regex': CLEAN_ANSI_REGEX,
          'node_modules/nested/node_modules/ansi-regex': nested,
        },
        { lodash: '^4.17.21' }
      )
    );
    await commitAll('first');

    await write(
      'package-lock.json',
      npmLockJson(
        {
          'node_modules/lodash': CLEAN_LODASH,
          'node_modules/ansi-regex': {
            version: '9.9.9',
            resolved: 'https://evil.example.test/ansi-regex/-/ansi-regex-9.9.9.tgz',
            integrity: 'sha512-evilansi',
          },
          'node_modules/nested/node_modules/ansi-regex': nested,
        },
        { lodash: '^4.17.21' }
      )
    );
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    const signals = signalsFor(result.findings, 'ansi-regex');
    expect(signals).toContain('host-changed:https://evil.example.test');
    expect(result.exitCode).toBe(1);
    // The one thing the guess really costs: the finding may not claim which
    // of the two earlier entries this one succeeded.
    const finding = result.findings.find((f) => f.ruleId === 'lockfile-tamper');
    expect(finding?.message).not.toContain('registry.npmjs.org');
    expect(finding?.details?.counterpartCandidates).toBe(2);
  });

  // The whole reason the suppression above is allowed to exist: when the
  // verdict really does depend on which earlier entry this one succeeded,
  // the scan says so. A partially migrated lockfile is the ordinary shape
  // that produces it -- one entry rehashed to sha512, its nested duplicate
  // of the same version at the same URL still on sha1 -- and rewriting the
  // migrated hash reads as a forgery against one candidate and as the
  // migration's own rehash against the other. This used to exit 0 with no
  // findings and no diagnostics at all.
  test('a forgery the earlier entries disagree about is announced rather than dropped in silence', async () => {
    const migrating = {
      version: '5.0.1',
      resolved: 'https://registry.npmjs.org/ansi-regex/-/ansi-regex-5.0.1.tgz',
      integrity: 'sha1-oldansi',
    };
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson(
        {
          'node_modules/lodash': CLEAN_LODASH,
          'node_modules/ansi-regex': CLEAN_ANSI_REGEX,
          'node_modules/nested/node_modules/ansi-regex': migrating,
        },
        { lodash: '^4.17.21' }
      )
    );
    await commitAll('first');

    await write(
      'package-lock.json',
      npmLockJson(
        {
          'node_modules/lodash': CLEAN_LODASH,
          'node_modules/ansi-regex': { ...CLEAN_ANSI_REGEX, integrity: 'sha512-forgedansi' },
          'node_modules/nested/node_modules/ansi-regex': migrating,
        },
        { lodash: '^4.17.21' }
      )
    );
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    // The critical is genuinely candidate-dependent, so it is not filed as
    // one. A diagnostic alone would leave anyone reading the exit code
    // looking at a clean scan, so the drop becomes a blocking finding of its
    // own: high, which fails the default medium gate.
    expect(signalsFor(result.findings, 'ansi-regex')).toEqual(['ambiguous-critical']);
    const escalated = result.findings.find((f) => f.details?.signal === 'ambiguous-critical');
    expect(escalated?.severity).toBe('high');
    expect(escalated?.lockfilePath).toBe('package-lock.json');
    expect(result.exitCode).toBe(1);
    const notice = result.run.diagnostics.find((d) => d.code === 'delta-ambiguous-lock-entry');
    expect(notice).toBeDefined();
    expect(notice?.message).toContain('ansi-regex');
    expect(notice?.message).toContain('integrity-changed');
    expect(notice?.message).not.toContain('sha1');
    expect(notice?.message).not.toContain('sha512');
  });

  test('an untouched lockfile still scans clean', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson(
        { 'node_modules/lodash': CLEAN_LODASH, 'node_modules/ansi-regex': CLEAN_ANSI_REGEX },
        { lodash: '^4.17.21' }
      )
    );
    await commitAll('first');
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(result.findings).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  // A tampered entry that a manifest DOES declare must still be reported
  // exactly once: the manifest walk and the entry walk both reach it, and
  // two criticals for one fact is how a gate teaches people to skim it.
  test('a tampered direct dependency is reported once, not twice', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' })
    );
    await commitAll('first');

    await write(
      'package-lock.json',
      npmLockJson(
        {
          'node_modules/lodash': {
            version: '4.17.21',
            resolved: 'https://evil.example.test/lodash/-/lodash-4.17.21.tgz',
            integrity: 'sha512-cleanlodash',
          },
        },
        { lodash: '^4.17.21' }
      )
    );
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(signalsFor(result.findings, 'lodash')).toHaveLength(1);
    expect(new Set(result.findings.map((finding) => finding.fingerprint)).size).toBe(
      result.findings.length
    );
  });
});

// Audit mode has no before side at all, so every tamper signal that
// works by comparison is structurally unreachable -- and that gap needs
// to be said out loud. Sweeping a repository you just adopted is exactly
// the case where there is no before side and where an absolute judgment
// matters most.
describe('audit mode says which tamper signals it cannot evaluate', () => {
  test('auditing a repo whose committed lockfile already resolves from another host reports a diagnostic', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson(
        {
          'node_modules/lodash': {
            version: '4.17.21',
            resolved: 'https://evil.example.test/lodash/-/lodash-4.17.21.tgz',
          },
        },
        { lodash: '^4.17.21' }
      )
    );
    await commitAll('first');

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    const notice = result.run.diagnostics.find((d) => d.code === 'audit-no-tamper-comparison');
    expect(notice).toBeDefined();
    expect(notice?.message).toContain('integrity-removed');
    expect(notice?.message).toContain('host-changed');
    // The notice is a statement of this scan's blind spot, so it has to
    // name every comparison-derived signal, not the three it happened to
    // list when it was written.
    expect(notice?.message).toContain('integrity-changed');
    expect(notice?.message).toContain('integrity-downgraded');
    expect(notice?.message).toContain('scheme-downgrade');
    expect(notice?.message).toContain('local-source-changed');
    // Two signals were added to the check after this message was written,
    // and the message did not learn about them: naming a subset under-reports
    // the blind spot the notice exists to report.
    expect(notice?.message).toContain('tarball-repointed');
    expect(notice?.message).toContain('resolution-unreadable');
    // And the same relationship the delta notice is held to: every
    // comparison-derived signal there is, not a list that was right once.
    for (const signal of COMPARISON_TAMPER_SIGNALS) {
      expect(notice?.message).toContain(signal);
    }
  });

  test('a staged scan, which does have a before side, does not report it', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' })
    );
    await commitAll('first');
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(result.run.diagnostics.map((d) => d.code)).not.toContain('audit-no-tamper-comparison');
  });

  // Audit mode is the usual way to have no before side; a staged scan of a
  // repository with no commit yet is the other, and the gap is identical.
  test('a staged scan of a repository with no commit yet reports it too', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' })
    );
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(result.run.diagnostics.map((d) => d.code)).toContain('audit-no-tamper-comparison');
  });

  test('a lockfile format with no resolution metadata does not report it either', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write('yarn.lock', '# yarn lockfile v1\n');
    await commitAll('first');

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    expect(result.run.diagnostics.map((d) => d.code)).not.toContain('audit-no-tamper-comparison');
  });
});

// The rule is that a missing lockfile makes the lockfile checks skip WITH
// a diagnostic. Without it, a repository with no lockfile would scan
// byte-identically to one whose lockfile checks all ran and found
// nothing.
describe('a repository with no lockfile says so', () => {
  test('a scan with no lockfile present reports the missing-lockfile diagnostic', async () => {
    await write('package.json', manifestJson({}));
    await commitAll('first');
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(result.run.lockfileFormat).toBe('none');
    const notice = result.run.diagnostics.find((d) => d.code === 'lockfile-missing');
    expect(notice).toBeDefined();
    expect(notice?.message).toContain('install-script');
  });

  test('a scan with a lockfile present does not report it', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' })
    );
    await commitAll('first');
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(result.run.diagnostics.map((d) => d.code)).not.toContain('lockfile-missing');
  });
});

// allow means "I know about this package". Where the bytes are fetched
// from is not a fact about the package, and a resolution swap under an
// allowed name is precisely the attack an allow entry must not buy.
describe('allow does not silence lockfile tampering', () => {
  test('an allow entry for the package does not suppress a host repoint', async () => {
    await write('.dep-guard.json', JSON.stringify({ allow: ['lodash'] }));
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' })
    );
    await commitAll('first');

    await write(
      'package-lock.json',
      npmLockJson(
        {
          'node_modules/lodash': {
            version: '4.17.21',
            resolved: 'https://evil.example.test/lodash/-/lodash-4.17.21.tgz',
            integrity: 'sha512-cleanlodash',
          },
        },
        { lodash: '^4.17.21' }
      )
    );
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(signalsFor(result.findings, 'lodash')).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });
});

// allow refuses a bare star because a security gate should not have a
// quiet off switch. Without the same refusal, ignorePaths would have
// exactly that switch, one key over.
describe('ignorePaths cannot be an off switch', () => {
  test('a bare ** entry is refused as an invalid config', async () => {
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['**'] }));
    await write('package.json', manifestJson({}));
    await commitAll('first');
    await write('package.json', manifestJson({ 'reeact-definitely-not-real': '1.0.0' }));
    await git('add', '-A');

    let caught: unknown;
    try {
      await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DepGuardError);
    expect((caught as DepGuardError).code).toBe('config-invalid');
  });

  test('a bare * entry is refused the same way', async () => {
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['*'] }));
    await write('package.json', manifestJson({}));
    await commitAll('first');

    await expect(
      scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS })
    ).rejects.toThrow(DepGuardError);
  });

  // If findings the lockfile walk discovers were anchored to the root
  // manifest, ignoring "package.json" -- a spelling config.ts allows on
  // purpose, since it is how a monorepo says it only cares about its
  // workspace packages -- would delete every transitive tamper and
  // install-script finding in the repository without saying so.
  test('ignoring the root manifest does not silence the lockfile walk', async () => {
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['package.json'] }));
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson(
        { 'node_modules/lodash': CLEAN_LODASH, 'node_modules/ansi-regex': CLEAN_ANSI_REGEX },
        { lodash: '^4.17.21' }
      )
    );
    await commitAll('first');

    await write(
      'package-lock.json',
      npmLockJson(
        {
          'node_modules/lodash': CLEAN_LODASH,
          'node_modules/ansi-regex': {
            version: '5.0.1',
            resolved: 'https://evil.example.test/ansi-regex/-/ansi-regex-5.0.1.tgz',
            integrity: 'sha512-cleanansi',
          },
        },
        { lodash: '^4.17.21' }
      )
    );
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    const finding = result.findings.find((f) => f.ruleId === 'lockfile-tamper');
    expect(finding?.packageName).toBe('ansi-regex');
    expect(finding?.manifestPath).toBe('package-lock.json');
    expect(result.exitCode).toBe(1);
  });

  test('ignoring the lockfile itself does silence it, which is the explicit choice', async () => {
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['package-lock.json'] }));
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson({ 'node_modules/ansi-regex': CLEAN_ANSI_REGEX }, { lodash: '^4.17.21' })
    );
    await commitAll('first');

    await write(
      'package-lock.json',
      npmLockJson(
        {
          'node_modules/ansi-regex': {
            version: '5.0.1',
            resolved: 'https://evil.example.test/ansi-regex/-/ansi-regex-5.0.1.tgz',
            integrity: 'sha512-cleanansi',
          },
        },
        { lodash: '^4.17.21' }
      )
    );
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(result.findings.filter((f) => f.ruleId === 'lockfile-tamper')).toHaveLength(0);
    expect(result.ignored).toBeGreaterThan(0);
  });

  test('a surviving pattern that drops findings reports the highest severity it dropped', async () => {
    await write('.dep-guard.json', JSON.stringify({ ignorePaths: ['package.json'] }));
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' })
    );
    await commitAll('first');

    await write(
      'package-lock.json',
      npmLockJson(
        {
          'node_modules/lodash': {
            version: '4.17.21',
            resolved: 'https://evil.example.test/lodash/-/lodash-4.17.21.tgz',
            integrity: 'sha512-cleanlodash',
          },
        },
        { lodash: '^4.17.21' }
      )
    );
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(result.findings).toHaveLength(0);
    expect(result.ignored).toBeGreaterThan(0);
    const notice = result.run.diagnostics.find((d) => d.code === 'ignore-path-dropped');
    expect(notice?.message).toContain('critical');
  });
});

// The fingerprint's four components are the contract, but if the signal
// component carried only the KIND of fact, never the fact, baselining a
// benign migration would also accept every later repoint of the same
// package under the same rule.
describe('a baselined resolution does not accept a different one', () => {
  async function scanWithBaseline(afterHost: string, baselineFrom: string | null): Promise<Awaited<ReturnType<typeof scan>>> {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson({ 'node_modules/lodash': CLEAN_LODASH }, { lodash: '^4.17.21' })
    );
    if (baselineFrom !== null) {
      await write('.dep-guard.baseline.json', baselineFrom);
    }
    await commitAll('first');

    await write(
      'package-lock.json',
      npmLockJson(
        {
          'node_modules/lodash': {
            version: '4.17.21',
            resolved: `https://${afterHost}/lodash/-/lodash-4.17.21.tgz`,
            integrity: 'sha512-cleanlodash',
          },
        },
        { lodash: '^4.17.21' }
      )
    );
    await git('add', '-A');

    return scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });
  }

  test('baselining a migration to an internal registry does not accept a later repoint to another host', async () => {
    const accepted = await scanWithBaseline('artifactory.acme.test', null);
    const acceptedFingerprints = accepted.findings
      .filter((finding) => finding.ruleId === 'lockfile-tamper')
      .map((finding) => finding.fingerprint);
    expect(acceptedFingerprints).toHaveLength(1);

    // A second repository, same package, same rule, same manifest -- only
    // the host the bytes now come from differs.
    repo = await makeTempDir('dep-guard-scan-');
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.invalid');
    await git('config', 'user.name', 'dep guard test');
    await git('config', 'commit.gpgsign', 'false');

    const evil = await scanWithBaseline(
      'evil.example.test',
      JSON.stringify({ version: 1, fingerprints: acceptedFingerprints })
    );

    expect(evil.suppressed).toBe(0);
    expect(signalsFor(evil.findings, 'lodash')).toHaveLength(1);
    expect(evil.exitCode).toBe(1);
  });

  test('the baselined host itself stays suppressed', async () => {
    const accepted = await scanWithBaseline('artifactory.acme.test', null);
    const acceptedFingerprints = accepted.findings
      .filter((finding) => finding.ruleId === 'lockfile-tamper')
      .map((finding) => finding.fingerprint);

    repo = await makeTempDir('dep-guard-scan-');
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.invalid');
    await git('config', 'user.name', 'dep guard test');
    await git('config', 'commit.gpgsign', 'false');

    const again = await scanWithBaseline(
      'artifactory.acme.test',
      JSON.stringify({ version: 1, fingerprints: acceptedFingerprints })
    );

    expect(again.suppressed).toBe(1);
    expect(again.findings.filter((f) => f.ruleId === 'lockfile-tamper')).toHaveLength(0);
  });
});

// The property every wave of this engine has had to defend: the routine
// case must be silent. A weekly lockfile refresh moves twenty resolutions,
// five of which run install scripts on both sides, and it must file
// nothing at all -- a gate that speaks up here is a gate that gets turned
// off before it ever sees a real attack.
describe('a routine lockfile refresh files nothing', () => {
  const NAMES = [
    'react', 'lodash', 'express', 'chalk', 'commander',
    'typescript', 'eslint', 'jest', 'axios', 'vue',
    'webpack', 'vite', 'next', 'nuxt', 'rollup',
    'parcel', 'prettier', 'mocha', 'chai', 'sinon',
  ];
  const ALREADY_SCRIPTED = new Set(['react', 'webpack', 'vite', 'next', 'sinon']);

  function refreshedPackages(patch: number): Record<string, Record<string, unknown>> {
    const packages: Record<string, Record<string, unknown>> = {};
    for (const name of NAMES) {
      packages[`node_modules/${name}`] = {
        version: `1.0.${patch}`,
        resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.${patch}.tgz`,
        integrity: `sha512-${name}-${patch}`,
        ...(ALREADY_SCRIPTED.has(name) ? { hasInstallScript: true } : {}),
      };
      // A nested older duplicate, held still across the refresh, of each
      // package that already runs install scripts. This is what the fixture
      // was missing: a flagged package with a flagged duplicate makes the
      // counterpart pairing undecidable on every single refresh, which is
      // the commonest shape in a real lockfile and the one an honesty
      // channel must not fire on. Every candidate agrees there is no
      // acquisition here, so there is nothing to report and nothing to
      // admit.
      if (ALREADY_SCRIPTED.has(name)) {
        packages[`node_modules/holder/node_modules/${name}`] = {
          version: '0.9.0',
          resolved: `https://registry.npmjs.org/${name}/-/${name}-0.9.0.tgz`,
          integrity: `sha512-${name}-legacy`,
          hasInstallScript: true,
        };
      }
    }
    return packages;
  }

  test('twenty bumped dependencies, five of them already scripted, yield no findings', async () => {
    const dependencies = Object.fromEntries(NAMES.map((name) => [name, '^1.0.0']));
    await write('package.json', manifestJson(dependencies));
    await write('package-lock.json', npmLockJson(refreshedPackages(0), dependencies));
    await commitAll('first');

    await write('package-lock.json', npmLockJson(refreshedPackages(1), dependencies));
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(result.findings).toEqual([]);
    expect(result.run.blockingMatches).toBe(0);
    expect(result.exitCode).toBe(0);
    // And it is quiet, not merely unblocking: a note on every refresh is
    // the noise this whole mechanism was narrowed to avoid.
    expect(result.run.diagnostics.map((d) => d.code)).not.toContain('delta-ambiguous-lock-entry');
  });
});

// A first sweep of an adopted repository has no earlier revision behind
// it, so every install-script flag in the tree reads as newly acquired.
// Reporting that as a blocking high per flagged package is how a first
// sweep gets abandoned; the fact still gets reported, under the gate.
describe('an audit sweep reports install scripts as a fact, not as a change', () => {
  test('a flagged dependency in an audited repo is a low, and does not fail the run', async () => {
    await write('package.json', manifestJson({ lodash: '^4.17.21' }));
    await write(
      'package-lock.json',
      npmLockJson(
        {
          'node_modules/lodash': CLEAN_LODASH,
          'node_modules/esbuild': {
            version: '0.21.0',
            resolved: 'https://registry.npmjs.org/esbuild/-/esbuild-0.21.0.tgz',
            integrity: 'sha512-esbuild',
            hasInstallScript: true,
          },
        },
        { lodash: '^4.17.21' }
      )
    );
    await commitAll('first');

    const result = await scan({ repoRoot: repo, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });

    const installScript = result.findings.filter((finding) => finding.ruleId === 'install-script');
    expect(installScript).toHaveLength(1);
    expect(installScript[0].severity).toBe('low');
    expect(installScript[0].details?.signal).toBe('present');
    expect(result.run.blockingMatches).toBe(0);
    expect(result.exitCode).toBe(0);
  });
});

// The counterpart a changed lock entry is compared against used to be
// picked by array position once version and URL both failed to match, so
// which entry npm happened to write first decided whether a routine bump
// read as a host repoint or an install-script acquisition. Both scenarios
// below are ordinary dependency work with nothing tampered in them.
describe('a bump beside an unrelated second entry of the same name stays quiet', () => {
  test('bumping the npmjs entry while a mirrored older entry sorts first is not a host change', async () => {
    const nestedOld = {
      version: '3.10.1',
      resolved: 'https://artifactory.example.test/lodash/-/lodash-3.10.1.tgz',
      integrity: 'sha512-oldmirror',
    };
    await write('package.json', manifestJson({}));
    await write(
      'package-lock.json',
      npmLockJson({
        'node_modules/legacy/node_modules/lodash': nestedOld,
        'node_modules/lodash': CLEAN_LODASH,
      })
    );
    await commitAll('first');

    await write(
      'package-lock.json',
      npmLockJson({
        'node_modules/legacy/node_modules/lodash': nestedOld,
        'node_modules/lodash': {
          version: '4.17.22',
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.22.tgz',
          integrity: 'sha512-newlodash',
        },
      })
    );
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(signalsFor(result.findings, 'lodash')).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('bumping the flagged entry while an unflagged older entry sorts first is not an acquisition', async () => {
    const nestedOld = {
      version: '0.20.0',
      resolved: 'https://registry.npmjs.org/esbuild/-/esbuild-0.20.0.tgz',
      integrity: 'sha512-oldesbuild',
    };
    await write('package.json', manifestJson({}));
    await write(
      'package-lock.json',
      npmLockJson({
        'node_modules/legacy/node_modules/esbuild': nestedOld,
        'node_modules/esbuild': {
          version: '0.21.0',
          resolved: 'https://registry.npmjs.org/esbuild/-/esbuild-0.21.0.tgz',
          integrity: 'sha512-esbuild210',
          hasInstallScript: true,
        },
      })
    );
    await commitAll('first');

    await write(
      'package-lock.json',
      npmLockJson({
        'node_modules/legacy/node_modules/esbuild': nestedOld,
        'node_modules/esbuild': {
          version: '0.21.1',
          resolved: 'https://registry.npmjs.org/esbuild/-/esbuild-0.21.1.tgz',
          integrity: 'sha512-esbuild211',
          hasInstallScript: true,
        },
      })
    );
    await git('add', '-A');

    const result = await scan({ repoRoot: repo, mode: { kind: 'staged' }, corpusDir: FIXTURE_CORPUS });

    expect(result.findings.filter((finding) => finding.ruleId === 'install-script')).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});
