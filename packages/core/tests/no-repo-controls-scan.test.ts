import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { jest } from '@jest/globals';
import { checkSingle, scan } from '../src/scan.js';
import { resolveGitBinary } from '../src/utils/git-binary.js';

const execFileAsync = promisify(execFile);
const FIXTURE_CORPUS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'corpus'
);
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const tempDirs: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(resolveGitBinary(), args, {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
  });
  return stdout;
}

async function write(root: string, relative: string, text: string): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
}

async function committedRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dep-guard-no-controls-scan-'));
  tempDirs.push(root);
  await git(root, 'init', '-q', '-b', 'main');
  await write(
    root,
    'package.json',
    JSON.stringify({
      dependencies: {
        'reeact-definitely-not-real': '1.0.0',
        '@types/node': '*',
      },
      devDependencies: { lodash: '*' },
      peerDependencies: { react: '*' },
    })
  );
  await write(root, '.dep-guard.json', JSON.stringify({ failOn: 'critical' }));
  await write(root, '.dep-guard.local.json', JSON.stringify({ ignorePaths: ['package.json'] }));
  await write(root, 'nested/.dep-guard.local.json', '{}\n');
  await write(root, '.dep-guard.baseline.json', '{"version":1,"fingerprints":[]}\n');
  await write(root, '.npmrc', '@private:registry=https://example.invalid\n');
  await git(root, 'add', '-A');
  await execFileAsync(resolveGitBinary(), ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture'], {
    cwd: root,
    env: { ...GIT_ENV, ...IDENTITY },
  });
  return root;
}

async function repoWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dep-guard-no-controls-invalid-'));
  tempDirs.push(root);
  await git(root, 'init', '-q', '-b', 'main');
  for (const [relative, content] of Object.entries(files)) await write(root, relative, content);
  await git(root, 'add', '-A');
  await execFileAsync(resolveGitBinary(), ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture'], {
    cwd: root,
    env: { ...GIT_ENV, ...IDENTITY },
  });
  return root;
}

function npmLock(name: string, resolved: string): string {
  return JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { [name]: '1.0.0' } },
      [`node_modules/${name}`]: {
        version: '1.0.0',
        resolved,
        integrity: 'sha512-fixture',
      },
    },
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const ONLINE_REFUSAL =
  'online checks would send names from a repository you do not trust to public registries; ' +
  'run without --online, or without --no-repo-controls on a checkout you trust';

test.each([
  ['scan', (root: string) => scan({
    repoRoot: root,
    mode: { kind: 'audit' } as const,
    corpusDir: FIXTURE_CORPUS,
    online: true,
    noRepoControls: true,
  })],
  ['check', (root: string) => checkSingle({
    repoRoot: root,
    name: 'private-package-name',
    corpusDir: FIXTURE_CORPUS,
    online: true,
    noRepoControls: true,
  })],
] as const)('%s refuses online before fetch under no-repo-controls', async (_command, run) => {
  const root = await repoWith({
    'package.json': '{"dependencies":{"private-package-name":"1.0.0"}}\n',
    'requirements.txt': 'private-python-name==1.0.0\n',
  });
  const originalFetch = globalThis.fetch;
  const fetchStub = jest.fn(async () => {
    throw new Error('fetch must not be called');
  });
  globalThis.fetch = fetchStub as typeof fetch;
  try {
    await expect(run(root)).rejects.toThrow(ONLINE_REFUSAL);
    expect(fetchStub).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('judges every HEAD dependency with defaults and reports ignored repository controls', async () => {
  const root = await committedRepo();
  const ordinary = await scan({ repoRoot: root, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
  expect(ordinary.findings).toHaveLength(0);
  await write(root, 'package.json', JSON.stringify({ dependencies: {} }));

  const result = await scan({
    repoRoot: root,
    mode: { kind: 'audit' },
    corpusDir: FIXTURE_CORPUS,
    noRepoControls: true,
  });

  expect(result.findings).toEqual(
    expect.arrayContaining([
    expect.objectContaining({
      ruleId: 'unknown-package',
      packageName: 'reeact-definitely-not-real',
      manifestPath: 'package.json',
    }),
      expect.objectContaining({
        ruleId: 'version-hygiene',
        packageName: '@types/node',
        severity: 'medium',
        details: expect.objectContaining({ repositoryContext: expect.any(Object) }),
      }),
      expect.objectContaining({
        ruleId: 'version-hygiene',
        packageName: 'lodash',
        severity: 'medium',
        details: expect.objectContaining({ repositoryContext: expect.any(Object) }),
      }),
      expect.objectContaining({
        ruleId: 'version-hygiene',
        packageName: 'react',
        severity: 'medium',
        details: expect.objectContaining({ repositoryContext: expect.any(Object) }),
      }),
    ])
  );
  expect(result.run.failOn).toBe('medium');
  expect(result.exitCode).toBe(1);
  expect(result.repoControls).toEqual({
    honoured: false,
    present: [
      '.dep-guard.baseline.json',
      '.dep-guard.json',
      '.dep-guard.local.json',
      '.npmrc',
      'nested/.dep-guard.local.json',
    ],
  });
  expect(result.scannedCommit).toBe((await git(root, 'rev-parse', 'HEAD')).trim());
  expect(result.scannedRoot).toBe(await import('node:fs/promises').then(({ realpath }) => realpath(root)));
  expect(result.notScanned).toEqual([
    expect.objectContaining({ path: 'package.json', kind: 'declined' }),
  ]);
  expect(result.notScannedCount).toBe(1);
});

test('committed npm scope pins can add dependency-confusion under no-repo-controls', async () => {
  const name = '@acmecorp/private-package';
  const root = await repoWith({
    '.npmrc': '@acmecorp:registry=https://npm.acmecorp.invalid/\n',
    'package.json': JSON.stringify({ dependencies: { [name]: '1.0.0' } }),
    'package-lock.json': npmLock(
      name,
      'https://registry.npmjs.org/@acmecorp/private-package/-/private-package-1.0.0.tgz'
    ),
  });

  const result = await scan({
    repoRoot: root,
    mode: { kind: 'audit' },
    corpusDir: FIXTURE_CORPUS,
    noRepoControls: true,
  });

  expect(result.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'dependency-confusion',
        severity: 'high',
        packageName: name,
      }),
    ])
  );
});

test('committed npm scope pins cannot suppress unknown-package under no-repo-controls', async () => {
  const name = '@acmecorp/definitely-not-in-corpus';
  const root = await repoWith({
    '.npmrc': '@acmecorp:registry=https://npm.acmecorp.invalid/\n',
    'package.json': JSON.stringify({ dependencies: { [name]: '1.0.0' } }),
    'package-lock.json': npmLock(
      name,
      'https://npm.acmecorp.invalid/@acmecorp/definitely-not-in-corpus/-/definitely-not-in-corpus-1.0.0.tgz'
    ),
  });

  const result = await scan({
    repoRoot: root,
    mode: { kind: 'audit' },
    corpusDir: FIXTURE_CORPUS,
    noRepoControls: true,
  });

  expect(result.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ruleId: 'unknown-package', packageName: name }),
    ])
  );
});

test('judges a case-variant package manifest under no-repo-controls', async () => {
  const root = await repoWith({
    'Package.json': '{"dependencies":{"case-variant-not-in-corpus":"1.0.0"}}\n',
  });

  const result = await scan({
    repoRoot: root,
    mode: { kind: 'audit' },
    corpusDir: FIXTURE_CORPUS,
    noRepoControls: true,
  });

  expect(result.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'unknown-package',
        packageName: 'case-variant-not-in-corpus',
      }),
    ])
  );
});

test('keeps pnpm onlyBuiltDependencies as adding-only data under no-repo-controls', async () => {
  const root = await repoWith({
    'package.json': JSON.stringify({
      name: 'fixture',
      pnpm: { onlyBuiltDependencies: ['native-addon'] },
    }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\npackages:\n",
  });

  const result = await scan({
    repoRoot: root,
    mode: { kind: 'audit' },
    corpusDir: FIXTURE_CORPUS,
    noRepoControls: true,
  });

  expect(result.findings).toEqual([
    expect.objectContaining({
      ruleId: 'install-script',
      severity: 'low',
      packageName: 'native-addon',
      details: expect.objectContaining({ signal: 'present' }),
    }),
  ]);
});

test('lists known unsupported dependency files and exits because nothing was judged', async () => {
  const files = [
    'setup.py',
    'setup.cfg',
    'environment.yml',
    'Cargo.toml',
    'go.mod',
  ];
  const root = await repoWith(Object.fromEntries(files.map((file) => [file, '# fixture\n'])));

  const result = await scan({
    repoRoot: root,
    mode: { kind: 'audit' },
    corpusDir: FIXTURE_CORPUS,
    noRepoControls: true,
  });

  expect(result.notScanned).toEqual(
    expect.arrayContaining(
      files.map((file) => expect.objectContaining({ path: file, kind: 'unsupported' }))
    )
  );
  expect(result.run.couldNotRun?.message).toContain('nothing was judged');
  expect(result.exitCode).toBe(2);
});

test('exits incomplete when every dependency input is under a built-in skipped directory', async () => {
  const root = await repoWith({
    'vendor/package.json': '{"dependencies":{"hidden":"1.0.0"}}\n',
  });

  const result = await scan({
    repoRoot: root,
    mode: { kind: 'audit' },
    corpusDir: FIXTURE_CORPUS,
    noRepoControls: true,
  });

  expect(result.notScanned).toEqual([
    expect.objectContaining({ path: 'vendor/package.json', kind: 'built-in-skip' }),
  ]);
  expect(result.run.couldNotRun?.message).toContain('nothing was judged');
  expect(result.exitCode).toBe(2);
});

test.each([
  ['allow entry', '.dep-guard.json', { allow: ['reeact-definitely-not-real'] }],
  ['ignore path', '.dep-guard.json', { ignorePaths: ['package.json'] }],
  ['root local overlay', '.dep-guard.local.json', { allow: ['reeact-definitely-not-real'] }],
] as const)('ignores a repository %s that ordinarily hides a finding', async (_label, control, value) => {
  const root = await repoWith({
    'package.json': '{"dependencies":{"reeact-definitely-not-real":"1.0.0"}}\n',
    [control]: `${JSON.stringify(value)}\n`,
  });
  const ordinary = await scan({ repoRoot: root, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
  expect(ordinary.findings).toEqual([]);

  const guarded = await scan({
    repoRoot: root,
    mode: { kind: 'audit' },
    corpusDir: FIXTURE_CORPUS,
    noRepoControls: true,
  });

  expect(guarded.findings).toEqual([
    expect.objectContaining({ ruleId: 'unknown-package', packageName: 'reeact-definitely-not-real' }),
  ]);
  expect(guarded.repoControls?.present).toContain(control);
});

test('uses the built-in fail threshold instead of the repository threshold', async () => {
  const root = await repoWith({
    'package.json': '{"dependencies":{"reeact-definitely-not-real":"1.0.0"}}\n',
    '.dep-guard.json': '{"failOn":"critical"}\n',
  });
  const ordinary = await scan({ repoRoot: root, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
  expect(ordinary.findings).toHaveLength(1);
  expect(ordinary.exitCode).toBe(0);

  const guarded = await scan({
    repoRoot: root,
    mode: { kind: 'audit' },
    corpusDir: FIXTURE_CORPUS,
    noRepoControls: true,
  });
  expect(guarded.run.failOn).toBe('medium');
  expect(guarded.exitCode).toBe(1);
});

test('ignores a committed baseline that ordinarily suppresses the finding', async () => {
  const root = await repoWith({
    'package.json': '{"dependencies":{"reeact-definitely-not-real":"1.0.0"}}\n',
  });
  const first = await scan({ repoRoot: root, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
  await write(
    root,
    '.dep-guard.baseline.json',
    `${JSON.stringify({ version: 1, fingerprints: [first.findings[0]?.fingerprint] })}\n`
  );
  await git(root, 'add', '.dep-guard.baseline.json');
  await execFileAsync(resolveGitBinary(), ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'baseline'], {
    cwd: root,
    env: { ...GIT_ENV, ...IDENTITY },
  });
  const ordinary = await scan({ repoRoot: root, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
  expect(ordinary.findings).toEqual([]);
  expect(ordinary.suppressed).toBe(1);

  const guarded = await scan({
    repoRoot: root,
    mode: { kind: 'audit' },
    corpusDir: FIXTURE_CORPUS,
    noRepoControls: true,
  });
  expect(guarded.findings).toHaveLength(1);
  expect(guarded.repoControls?.present).toContain('.dep-guard.baseline.json');
});

test('ignores a private npmrc scope pin that ordinarily suppresses the name check', async () => {
  const root = await repoWith({
    'package.json': '{"dependencies":{"@private/definitely-not-real":"1.0.0"}}\n',
    '.npmrc': '@private:registry=https://registry.example.invalid/\n',
  });
  const ordinary = await scan({ repoRoot: root, mode: { kind: 'audit' }, corpusDir: FIXTURE_CORPUS });
  expect(ordinary.findings).toEqual([]);

  const guarded = await scan({
    repoRoot: root,
    mode: { kind: 'audit' },
    corpusDir: FIXTURE_CORPUS,
    noRepoControls: true,
  });
  expect(guarded.findings).toEqual([
    expect.objectContaining({ ruleId: 'unknown-package', packageName: '@private/definitely-not-real' }),
  ]);
  expect(guarded.repoControls?.present).toContain('.npmrc');
});

test('rejects comparison controls before repository preparation', async () => {
  await expect(
    scan({
      repoRoot: '/path/that/must/not/be-read',
      mode: { kind: 'base', ref: 'HEAD~1' },
      corpusDir: FIXTURE_CORPUS,
      noRepoControls: true,
    })
  ).rejects.toThrow('--no-repo-controls cannot be combined');
});

test.each([
  ['package.json', { 'package.json': '{not json\n' }],
  [
    'package-lock.json',
    {
      'package.json': '{"dependencies":{"lodash":"1.0.0"}}\n',
      'package-lock.json': '{"lockfileVersion":3}\n',
    },
  ],
] as const)('reports an unparseable committed %s and exits incomplete', async (pathName, files) => {
  const root = await repoWith(files);

  const result = await scan({
    repoRoot: root,
    mode: { kind: 'audit' },
    corpusDir: FIXTURE_CORPUS,
    noRepoControls: true,
  });

  expect(result.notScanned).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: pathName, kind: 'unparseable' })])
  );
  expect(result.notScanned?.filter((entry) => entry.path === pathName)).toHaveLength(1);
  expect(result.run.couldNotRun).toMatchObject({ code: 'head-inputs-not-judged' });
  expect(result.exitCode).toBe(2);
});

test('lists a manifest skipped under a built-in directory and qualifies the result', async () => {
  const root = await repoWith({
    'package.json': '{"dependencies":{}}\n',
    'node_modules/hidden/package.json': '{"dependencies":{"hidden-name":"1.0.0"}}\n',
  });

  const result = await scan({
    repoRoot: root,
    mode: { kind: 'audit' },
    corpusDir: FIXTURE_CORPUS,
    noRepoControls: true,
  });

  expect(result.notScanned).toEqual([
    expect.objectContaining({
      path: 'node_modules/hidden/package.json',
      kind: 'built-in-skip',
    }),
  ]);
  expect(result.notScannedCount).toBe(1);
  expect(result.exitCode).toBe(0);
});

test('lists a lockfile that has no manifest in its directory', async () => {
  const root = await repoWith({
    'package-lock.json': '{"name":"fixture","lockfileVersion":3,"packages":{}}\n',
  });

  const result = await scan({
    repoRoot: root,
    mode: { kind: 'audit' },
    corpusDir: FIXTURE_CORPUS,
    noRepoControls: true,
  });

  expect(result.notScanned).toEqual([
    expect.objectContaining({ path: 'package-lock.json', kind: 'declined' }),
    expect.objectContaining({ path: 'package-lock.json', kind: 'declined' }),
  ]);
  expect(result.notScanned?.map((entry) => entry.reason)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('no comparison side'),
      expect.stringContaining('no manifest in its directory'),
    ])
  );
  expect(result.notScannedCount).toBe(2);
});
