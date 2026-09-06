import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { scan, checkSingle } from '../src/scan.js';
import { DepGuardError } from '../src/types.js';

// Pull-request mode. Every test here is the same shape: a base branch that
// carries the approved control inputs, a feature branch that adds a
// dependency the corpus does not know AND tries to mute the finding it
// raises, and an assertion that the mute did not take, the finding still
// blocks at the BASE severity, and the attempt is reported.
//
// The "before" behaviour these pin -- each of these mutes working, exit 0
// -- was reproduced by hand against a scratch repository before any of
// this was built, in --base mode, which is the mode CI runs.

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
  await writeFile(path.join(repo, relPath), content, 'utf8');
}

async function commitAll(message: string): Promise<void> {
  await git('add', '-A');
  await git('commit', '-q', '-m', message);
}

const UNKNOWN_NAME = 'reeact-definitely-not-real';

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

function baselineJson(fingerprints: string[]): string {
  return JSON.stringify({ version: 1, fingerprints }, null, 2);
}

/**
 * The base branch: a committed config, a committed baseline, an empty
 * manifest and lockfile. Every test starts here, so "the base" means the
 * same approved state in all of them.
 */
async function makeBase(config: Record<string, unknown> = { failOn: 'medium' }): Promise<void> {
  repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-trust-'));
  tempDirs.push(repo);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'dep guard test');
  await git('config', 'commit.gpgsign', 'false');
  await write('package.json', manifestJson({}));
  await write('package-lock.json', lockJson({}));
  await write('.dep-guard.json', JSON.stringify(config, null, 2));
  await write('.dep-guard.baseline.json', baselineJson([]));
  await commitAll('base state');
  await git('checkout', '-q', '-b', 'feature');
}

/** The pull request: adds the unknown dependency, plus whatever else. */
async function addUnknownDependency(): Promise<void> {
  await write('package.json', manifestJson({ [UNKNOWN_NAME]: '1.0.0' }));
  await write('package-lock.json', lockJson({ [UNKNOWN_NAME]: '1.0.0' }));
}

function scanPullRequest(overrides: Record<string, unknown> = {}) {
  return scan({
    repoRoot: repo,
    mode: { kind: 'base', ref: 'main' },
    corpusDir: FIXTURE_CORPUS,
    trustBase: 'main',
    ...overrides,
  });
}

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  repo = '';
});

describe('pull-request mode: a head-side config never takes effect', () => {
  test('an allow entry the pull request adds does not clear the finding it adds', async () => {
    await makeBase();
    await addUnknownDependency();
    await write('.dep-guard.json', JSON.stringify({ failOn: 'medium', allow: [UNKNOWN_NAME] }));
    await commitAll('add the dependency and allow it');

    const result = await scanPullRequest();

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ ruleId: 'unknown-package', packageName: UNKNOWN_NAME });
    expect(result.exitCode).toBe(1);
    expect(result.run.blockingMatches).toBe(1);
    // The counter reports what the BASE allow list did, which is nothing.
    expect(result.allowed).toBe(0);
    expect(result.allowedNames).toEqual([]);
    expect(result.trustBase?.proposals).toEqual([
      `config changed in this pull request (proposed: allow ${UNKNOWN_NAME})`,
    ]);
    expect(result.trustBase?.configChanged).toBe(true);
  });

  test('an ignorePaths entry the pull request adds does not drop the finding', async () => {
    await makeBase();
    await addUnknownDependency();
    await write(
      '.dep-guard.json',
      JSON.stringify({ failOn: 'medium', ignorePaths: ['package.json'] })
    );
    await commitAll('add the dependency and ignore its manifest');

    const result = await scanPullRequest();

    expect(result.findings).toHaveLength(1);
    expect(result.ignored).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.proposals).toEqual([
      'config changed in this pull request (proposed: ignorePaths package.json)',
    ]);
  });

  test('a failOn the pull request loosens does not lower the gate', async () => {
    await makeBase();
    await addUnknownDependency();
    await write('.dep-guard.json', JSON.stringify({ failOn: 'critical' }));
    await commitAll('add the dependency and raise the threshold above it');

    const result = await scanPullRequest();

    // The run used the BASE threshold, and says so.
    expect(result.run.failOn).toBe('medium');
    expect(result.run.blockingMatches).toBe(1);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.proposals).toEqual([
      'config changed in this pull request (failOn loosened to critical)',
    ]);
  });

  test('an internalScopes entry the pull request adds does not re-route the finding', async () => {
    await makeBase();
    const scoped = '@acme/hallucinated-helper';
    await write('package.json', manifestJson({ [scoped]: '1.0.0' }));
    await write('package-lock.json', lockJson({ [scoped]: '1.0.0' }));
    await write('.dep-guard.json', JSON.stringify({ failOn: 'medium', internalScopes: ['@acme'] }));
    await commitAll('add a scoped dependency and declare its scope internal');

    const result = await scanPullRequest();

    // Judged by the base config, under which the name is simply unknown.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe('unknown-package');
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.proposals).toEqual([
      'config changed in this pull request (proposed: internalScopes @acme)',
    ]);
  });

  test('a baseline entry the pull request adds does not suppress the finding', async () => {
    await makeBase();
    await addUnknownDependency();
    await commitAll('add the dependency');
    // Take the real fingerprint from a run, then baseline it, which is
    // exactly what an attacker able to run the tool would do.
    const first = await scanPullRequest();
    const fingerprint = first.findings[0]?.fingerprint ?? '';
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    await write('.dep-guard.baseline.json', baselineJson([fingerprint]));
    await commitAll('baseline the fingerprint it introduces');

    const result = await scanPullRequest();

    expect(result.findings).toHaveLength(1);
    expect(result.suppressed).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.baselineChanged).toBe(true);
    expect(result.trustBase?.proposals).toEqual([
      'baseline changed in this pull request (1 baseline entries added)',
    ]);
  });

  test('a config the pull request adds where the base had none falls back to defaults', async () => {
    // No config and no baseline at the base at all: first adoption.
    repo = await mkdtemp(path.join(tmpdir(), 'dep-guard-trust-'));
    tempDirs.push(repo);
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.invalid');
    await git('config', 'user.name', 'dep guard test');
    await git('config', 'commit.gpgsign', 'false');
    await write('package.json', manifestJson({}));
    await write('package-lock.json', lockJson({}));
    await commitAll('base state with no control inputs');
    await git('checkout', '-q', '-b', 'feature');
    await addUnknownDependency();
    await write('.dep-guard.json', JSON.stringify({ failOn: 'none', allow: [UNKNOWN_NAME] }));
    await commitAll('adopt dep-guard and turn it off in the same commit');

    const result = await scanPullRequest();

    // The defaults, not the head's "failOn": "none".
    expect(result.run.failOn).toBe('medium');
    expect(result.findings).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.proposals[0]).toContain('config added in this pull request');
  });

  test('a base-side allow entry is still honoured and still counted', async () => {
    await makeBase({ failOn: 'medium', allow: [UNKNOWN_NAME] });
    await addUnknownDependency();
    await commitAll('add a dependency the base already allows');

    const result = await scanPullRequest();

    expect(result.findings).toHaveLength(0);
    expect(result.allowed).toBe(1);
    expect(result.allowedNames).toEqual([UNKNOWN_NAME]);
    expect(result.exitCode).toBe(0);
    expect(result.trustBase?.proposals).toEqual([]);
  });

  test('a name in the base allow list that the head re-adds is not reported twice', async () => {
    await makeBase({ failOn: 'medium', allow: [UNKNOWN_NAME] });
    await addUnknownDependency();
    // The head keeps the base entry and adds one more.
    await write(
      '.dep-guard.json',
      JSON.stringify({ failOn: 'medium', allow: [UNKNOWN_NAME, 'another-name'] })
    );
    await commitAll('keep the base allow entry and add another');

    const result = await scanPullRequest();

    // Cleared once, by the base list, and counted once.
    expect(result.allowed).toBe(1);
    expect(result.allowedNames).toEqual([UNKNOWN_NAME]);
    // The proposal names only what the head ADDED, never the entry that
    // was already approved and already reported on the allow line.
    expect(result.trustBase?.proposals).toEqual([
      'config changed in this pull request (proposed: allow another-name)',
    ]);
  });

  test('a base differing only in a file that is not a control input is accepted', async () => {
    await makeBase();
    await addUnknownDependency();
    await write('README.md', 'a file that is not a control input\n');
    await commitAll('add the dependency and an unrelated file');

    const result = await scanPullRequest();

    expect(result.findings).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.configChanged).toBe(false);
    expect(result.trustBase?.baselineChanged).toBe(false);
    expect(result.trustBase?.proposals).toEqual([]);
  });
});

describe('pull-request mode: shape changes', () => {
  test('a config the head turned into a symlink is reported and ignored', async () => {
    await makeBase({ failOn: 'medium' });
    await addUnknownDependency();
    // A link whose target holds a muting config. Content comparison alone
    // is blind to this: git stores the link as its target text.
    await write('elsewhere.json', JSON.stringify({ failOn: 'none', allow: [UNKNOWN_NAME] }));
    await rm(path.join(repo, '.dep-guard.json'));
    await symlink('elsewhere.json', path.join(repo, '.dep-guard.json'));
    await commitAll('point the config at a file the base never approved');

    const result = await scanPullRequest();

    expect(result.run.failOn).toBe('medium');
    expect(result.findings).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.configShapeChange).toBe('symlink');
    expect(result.trustBase?.proposals).toContain(
      'config is a symlink at the head commit, not a regular file'
    );
  });

  test('a config the head removed is reported as removed and the base config still applies', async () => {
    await makeBase({ failOn: 'medium', allow: ['already-approved'] });
    await addUnknownDependency();
    await rm(path.join(repo, '.dep-guard.json'));
    await commitAll('delete the config the base approved');

    const result = await scanPullRequest();

    expect(result.findings).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.configShapeChange).toBe('removed');
    expect(result.trustBase?.proposals).toContain('config removed in this pull request');
  });

  test('a config whose file mode the head changed is reported', async () => {
    await makeBase({ failOn: 'medium' });
    await addUnknownDependency();
    // Set on the file itself rather than through update-index, because the
    // "git add -A" in commitAll re-reads the mode off disk and would undo
    // an index-only chmod.
    await chmod(path.join(repo, '.dep-guard.json'), 0o755);
    await commitAll('set the execute bit on the config');

    const result = await scanPullRequest();

    expect(result.trustBase?.configShapeChange).toBe('mode');
    expect(result.trustBase?.proposals).toContain('config file mode changed in this pull request');
    expect(result.exitCode).toBe(1);
  });

  test('a baseline the head turned into a symlink is reported', async () => {
    await makeBase();
    await addUnknownDependency();
    await write('elsewhere.json', baselineJson([]));
    await rm(path.join(repo, '.dep-guard.baseline.json'));
    await symlink('elsewhere.json', path.join(repo, '.dep-guard.baseline.json'));
    await commitAll('point the baseline at another file');

    const result = await scanPullRequest();

    expect(result.trustBase?.baselineShapeChange).toBe('symlink');
    expect(result.trustBase?.proposals).toContain(
      'baseline is a symlink at the head commit, not a regular file'
    );
  });
});

describe('pull-request mode: the ref itself', () => {
  test('a ref that does not resolve fails closed with exit 2 and scans nothing', async () => {
    await makeBase();
    await addUnknownDependency();
    await commitAll('add the dependency');

    await expect(scanPullRequest({ trustBase: 'origin/does-not-exist' })).rejects.toThrow(
      DepGuardError
    );
    await expect(scanPullRequest({ trustBase: 'origin/does-not-exist' })).rejects.toMatchObject({
      code: 'trust-base-unresolvable',
      message: expect.stringContaining('origin/does-not-exist'),
    });
    // The message has to tell CI what to do about it.
    await expect(scanPullRequest({ trustBase: 'origin/does-not-exist' })).rejects.toMatchObject({
      message: expect.stringContaining('fetch-depth: 0'),
    });
  });

  test('a ref resolving to HEAD is refused, even though it names a real commit', async () => {
    await makeBase();
    await addUnknownDependency();
    await commitAll('add the dependency');

    await expect(scanPullRequest({ trustBase: 'HEAD' })).rejects.toMatchObject({
      code: 'trust-base-is-head',
      message: expect.stringContaining('the same commit as HEAD'),
    });
  });

  test('a different commit carrying an identical tree is refused', async () => {
    await makeBase();
    await addUnknownDependency();
    await commitAll('add the dependency');
    // A commit with a different sha and the same tree, which is what a
    // pull request merge ref looks like when the base has not moved.
    const twin = (await git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'twin')).trim();

    await expect(scanPullRequest({ trustBase: twin })).rejects.toMatchObject({
      code: 'trust-base-same-tree',
      message: expect.stringContaining('identical tree'),
    });
  });

  test('a ref that is not a usable git ref is refused before it reaches git', async () => {
    await makeBase();
    await addUnknownDependency();
    await commitAll('add the dependency');

    await expect(scanPullRequest({ trustBase: '--upload-pack=touch' })).rejects.toMatchObject({
      code: 'trust-base-unresolvable',
      message: expect.stringContaining('not a usable git ref'),
    });
  });

  test('a base config that does not validate is could-not-run, not a fallback to defaults', async () => {
    await makeBase();
    // Break the config ON THE BASE branch, then branch off it.
    await git('checkout', '-q', 'main');
    await write('.dep-guard.json', '{ not json');
    await commitAll('break the base config');
    await git('checkout', '-q', 'feature');
    await git('rebase', '-q', 'main');
    await addUnknownDependency();
    await write('.dep-guard.json', JSON.stringify({ failOn: 'medium' }));
    await commitAll('add the dependency and fix the config in the same commit');

    await expect(scanPullRequest()).rejects.toMatchObject({ code: 'config-invalid' });
  });
});

describe('pull-request mode and --base are different concepts', () => {
  test('the two naming the same ref works', async () => {
    await makeBase();
    await addUnknownDependency();
    await write('.dep-guard.json', JSON.stringify({ failOn: 'medium', allow: [UNKNOWN_NAME] }));
    await commitAll('add the dependency and allow it');

    const result = await scan({
      repoRoot: repo,
      mode: { kind: 'base', ref: 'main' },
      corpusDir: FIXTURE_CORPUS,
      trustBase: 'main',
    });

    expect(result.findings).toHaveLength(1);
    expect(result.trustBase?.ref).toBe('main');
  });

  test('the two naming different refs works, and each keeps its own job', async () => {
    await makeBase();
    // An intermediate commit on the feature branch. --base points at it,
    // so only the LAST commit's dependency is in the delta; --trust-base
    // still points at main, so the config still comes from there.
    await write('package.json', manifestJson({ lodash: '4.17.21' }));
    await write('package-lock.json', lockJson({ lodash: '4.17.21' }));
    await commitAll('add a known dependency');
    await git('branch', 'midpoint');
    await addUnknownDependency();
    await write('.dep-guard.json', JSON.stringify({ failOn: 'medium', allow: [UNKNOWN_NAME] }));
    await commitAll('add the unknown dependency and allow it');

    const result = await scan({
      repoRoot: repo,
      mode: { kind: 'base', ref: 'midpoint' },
      corpusDir: FIXTURE_CORPUS,
      trustBase: 'main',
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.packageName).toBe(UNKNOWN_NAME);
    expect(result.allowed).toBe(0);
    expect(result.trustBase?.ref).toBe('main');
    expect(result.trustBase?.proposals).toEqual([
      `config changed in this pull request (proposed: allow ${UNKNOWN_NAME})`,
    ]);
  });

  test('--trust-base works in staged mode too, where --base is not even given', async () => {
    await makeBase();
    // Commit the muting config alone, so HEAD differs from main in both
    // commit and tree while the dependency itself is still only staged.
    // That ordering is what makes this a real staged-mode proof: the
    // dependency is genuinely "added" in the index-versus-HEAD delta, so
    // the allow entry has something to try to clear.
    await write('.dep-guard.json', JSON.stringify({ failOn: 'medium', allow: [UNKNOWN_NAME] }));
    await commitAll('allow a name the base never approved');
    await addUnknownDependency();
    await git('add', '-A');

    const result = await scan({
      repoRoot: repo,
      mode: { kind: 'staged' },
      corpusDir: FIXTURE_CORPUS,
      trustBase: 'main',
    });

    expect(result.run.mode).toBe('staged');
    expect(result.trustBase?.ref).toBe('main');
    // The committed allow entry did not clear it: the base list did.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.packageName).toBe(UNKNOWN_NAME);
    expect(result.allowed).toBe(0);
    expect(result.exitCode).toBe(1);
  });
});

describe('checkSingle in pull-request mode', () => {
  test('an allow entry the pull request adds does not make a name safe', async () => {
    await makeBase();
    await addUnknownDependency();
    await write('.dep-guard.json', JSON.stringify({ failOn: 'medium', allow: [UNKNOWN_NAME] }));
    await commitAll('add the dependency and allow it');

    const result = await checkSingle({
      repoRoot: repo,
      name: UNKNOWN_NAME,
      corpusDir: FIXTURE_CORPUS,
      trustBase: 'main',
    });

    expect(result.findings.some((finding) => finding.ruleId === 'unknown-package')).toBe(true);
    expect(result.allowed).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(result.trustBase?.configChanged).toBe(true);
  });
});

describe('no-flag parity', () => {
  // The gate cases from scan.test.ts, run WITHOUT --trust-base, asserting
  // the result is what it was before pull-request mode existed. The key
  // has to be ABSENT, not present-and-undefined: a consumer doing a deep
  // comparison sees the difference even though JSON.stringify does not.
  test('a scan with no flag is byte-identical and carries no trustBase key', async () => {
    await makeBase();
    await addUnknownDependency();
    await commitAll('add the dependency');

    const result = await scan({
      repoRoot: repo,
      mode: { kind: 'base', ref: 'main' },
      corpusDir: FIXTURE_CORPUS,
    });

    expect(Object.prototype.hasOwnProperty.call(result, 'trustBase')).toBe(false);
    expect(JSON.parse(JSON.stringify(result)).trustBase).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  test('with no flag a head-side allow entry still applies, exactly as before', async () => {
    await makeBase();
    await addUnknownDependency();
    await write('.dep-guard.json', JSON.stringify({ failOn: 'medium', allow: [UNKNOWN_NAME] }));
    await commitAll('add the dependency and allow it');

    const result = await scan({
      repoRoot: repo,
      mode: { kind: 'base', ref: 'main' },
      corpusDir: FIXTURE_CORPUS,
    });

    // This is the pre-existing behaviour outside pull-request mode, and it
    // is deliberately unchanged: a local checkout is inside the trust
    // boundary. If this ever starts failing, pre-commit behaviour moved.
    expect(result.findings).toHaveLength(0);
    expect(result.allowed).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(result, 'trustBase')).toBe(false);
  });

  test('with no flag a head-side baseline entry still suppresses, exactly as before', async () => {
    await makeBase();
    await addUnknownDependency();
    await commitAll('add the dependency');
    const first = await scan({
      repoRoot: repo,
      mode: { kind: 'base', ref: 'main' },
      corpusDir: FIXTURE_CORPUS,
    });
    await write('.dep-guard.baseline.json', baselineJson([first.findings[0]?.fingerprint ?? '']));
    await commitAll('baseline it');

    const result = await scan({
      repoRoot: repo,
      mode: { kind: 'base', ref: 'main' },
      corpusDir: FIXTURE_CORPUS,
    });

    expect(result.findings).toHaveLength(0);
    expect(result.suppressed).toBe(1);
    expect(result.exitCode).toBe(0);
  });
});
