import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existenceCheck } from '../src/checks/existence.js';
import { typosquatCheck } from '../src/checks/typosquat.js';
import type { CheckContext, ResolvedConfig } from '../src/checks/types.js';
import { loadCorpus } from '../src/corpus.js';
import type { DepChange } from '../src/delta.js';
import type { Diagnostic } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'corpus');
const corpus = loadCorpus(FIXTURE_DIR);

// Exactly the keys loadConfig resolves to; the checks read this shape and
// nothing wider.
const BASE_CONFIG: ResolvedConfig = {
  failOn: 'medium',
  allow: [],
  internalScopes: [],
  internalPrefixes: [],
  extraAliases: {},
  ignorePaths: [],
  online: false,
};

// A name the fixture bloom filter was never fed. Deterministic: the filter
// is a committed fixture, so this either collides forever or never.
const UNKNOWN = 'totally-not-a-real-package-xyz';

function makeChange(overrides: Partial<DepChange> & { name: string }): DepChange {
  return {
    name: overrides.name,
    registryName: overrides.registryName ?? overrides.name,
    specifier: overrides.specifier ?? '^1.0.0',
    kind: overrides.kind ?? 'added',
    depType: overrides.depType ?? 'dependencies',
    protocol: overrides.protocol ?? 'registry',
    manifestPath: overrides.manifestPath ?? 'package.json',
    before: overrides.before,
    after: overrides.after,
  };
}

function makeContext(
  changes: DepChange[],
  config: Partial<ResolvedConfig> = {},
  workspaceLocalNames: Set<string> = new Set()
): CheckContext {
  return {
    corpus,
    config: { ...BASE_CONFIG, ...config },
    delta: {
      changes,
      lockEntryChanges: [],
      onlyBuiltAdded: [],
      lockfileFormat: 'npm',
      hasComparisonBase: true,
      workspaceLocalNames,
      diagnostics: [],
    },
    npmrcRegistryPins: new Map<string, string>(),
    diagnostics: [] as Diagnostic[],
  };
}

describe('existenceCheck', () => {
  test('flags an added dependency whose name is absent from the corpus', () => {
    const findings = existenceCheck(makeContext([makeChange({ name: UNKNOWN })]));
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('unknown-package');
    expect(findings[0].severity).toBe('high');
    expect(findings[0].packageName).toBe(UNKNOWN);
    expect(findings[0].manifestPath).toBe('package.json');
    expect(findings[0].message).toContain(UNKNOWN);
  });

  test('says nothing about an added dependency the corpus knows', () => {
    expect(existenceCheck(makeContext([makeChange({ name: 'left-pad' })]))).toEqual([]);
  });

  // A changed registry dependency was already in the base manifest under
  // the same name, so its existence was settled before this delta.
  test('ignores a changed registry dependency even when the name is unknown', () => {
    const changes = [makeChange({ name: UNKNOWN, kind: 'changed' })];
    expect(existenceCheck(makeContext(changes))).toEqual([]);
  });

  // The exception: an alias points somewhere the manifest key does not
  // name, and retargeting it is a change in what gets installed rather
  // than a version bump. The delta cannot say whether the target moved, so
  // every changed alias is re-checked.
  test('checks a changed alias dependency whose target is unknown', () => {
    const changes = [
      makeChange({
        name: 'react',
        registryName: UNKNOWN,
        kind: 'changed',
        protocol: 'alias',
        specifier: `npm:${UNKNOWN}@1.0.0`,
      }),
    ];
    const findings = existenceCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('unknown-package');
    expect(findings[0].packageName).toBe(UNKNOWN);
  });

  test('a changed alias dependency whose target the corpus knows stays silent', () => {
    const changes = [
      makeChange({
        name: 'pad-left',
        registryName: 'left-pad',
        kind: 'changed',
        protocol: 'alias',
        specifier: 'npm:left-pad@1.3.0',
      }),
    ];
    expect(existenceCheck(makeContext(changes))).toEqual([]);
  });

  test('an exact allow entry silences the finding', () => {
    const context = makeContext([makeChange({ name: UNKNOWN })], { allow: [UNKNOWN] });
    expect(existenceCheck(context)).toEqual([]);
  });

  test('a scope allow pattern silences every package in that scope', () => {
    const context = makeContext([makeChange({ name: '@acme/nowhere-near-npm' })], {
      allow: ['@acme/*'],
    });
    expect(existenceCheck(context)).toEqual([]);
  });

  test('a scope allow pattern does not silence a different scope', () => {
    const context = makeContext([makeChange({ name: '@other/nowhere-near-npm' })], {
      allow: ['@acme/*'],
    });
    expect(existenceCheck(context)).toHaveLength(1);
  });

  // An internal package is absent from the public registry by design.
  // "may be hallucinated" is the wrong sentence for it, and the
  // dependency-confusion check is the one that has something to say.
  test('an internal scope is not reported as an unknown package', () => {
    const context = makeContext([makeChange({ name: '@acme/react' })], {
      internalScopes: ['@acme'],
    });
    expect(existenceCheck(context)).toEqual([]);
  });

  test('the same scoped name is reported when no internal scope is configured', () => {
    expect(existenceCheck(makeContext([makeChange({ name: '@acme/react' })]))).toHaveLength(1);
  });

  test('an internal scope does not cover a different scope', () => {
    const context = makeContext([makeChange({ name: '@other/react' })], {
      internalScopes: ['@acme'],
    });
    expect(existenceCheck(context)).toHaveLength(1);
  });

  test('an internal prefix is not reported as an unknown package', () => {
    const context = makeContext([makeChange({ name: 'acme-widgets' })], {
      internalPrefixes: ['acme-'],
    });
    expect(existenceCheck(context)).toEqual([]);
  });

  test('the same prefixed name is reported when no internal prefix is configured', () => {
    expect(existenceCheck(makeContext([makeChange({ name: 'acme-widgets' })]))).toHaveLength(1);
  });

  test('an internal prefix does not cover an unrelated name', () => {
    const context = makeContext([makeChange({ name: UNKNOWN })], {
      internalPrefixes: ['acme-'],
    });
    expect(existenceCheck(context)).toHaveLength(1);
  });

  test('an internal scope is matched on the alias target, not the manifest key', () => {
    const changes = [
      makeChange({
        name: '@acme/react',
        registryName: UNKNOWN,
        protocol: 'alias',
        specifier: `npm:${UNKNOWN}@1.0.0`,
      }),
    ];
    expect(existenceCheck(makeContext(changes, { internalScopes: ['@acme'] }))).toHaveLength(1);
  });

  test('a workspace-protocol dependency is never checked', () => {
    const changes = [makeChange({ name: UNKNOWN, protocol: 'workspace', specifier: 'workspace:*' })];
    expect(existenceCheck(makeContext(changes))).toEqual([]);
  });

  // npm gives a workspace sibling no distinguishing protocol -- it is an
  // ordinary "registry" dependency with a plain version range, and the
  // fact that it is local instead lives in the lockfile's link entries
  // (see lockfile-npm.test.ts and delta.test.ts). A name absent from the
  // corpus for this reason is correct, not suspicious.
  test('a name the delta marks workspace-local is never reported as unknown', () => {
    const changes = [makeChange({ name: '@npmcli/mock-registry', specifier: '^1.0.0' })];
    const context = makeContext(changes, {}, new Set(['@npmcli/mock-registry']));
    expect(existenceCheck(context)).toEqual([]);
  });

  test('a workspace-local exemption does not cover an unrelated unknown name', () => {
    const changes = [
      makeChange({ name: UNKNOWN }),
      makeChange({ name: '@npmcli/mock-registry', specifier: '^1.0.0' }),
    ];
    const context = makeContext(changes, {}, new Set(['@npmcli/mock-registry']));
    const findings = existenceCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].packageName).toBe(UNKNOWN);
  });

  // The exemption is matched on the resolved registry name, exactly like
  // the allow list, so retargeting an alias at a workspace-local name
  // silences it too -- there is nothing for a registry to resolve either
  // way.
  test('a workspace-local exemption is matched on the alias target', () => {
    const changes = [
      makeChange({
        name: 'internal-docs',
        registryName: '@npmcli/mock-registry',
        protocol: 'alias',
        specifier: 'npm:@npmcli/mock-registry@1.0.0',
      }),
    ];
    const context = makeContext(changes, {}, new Set(['@npmcli/mock-registry']));
    expect(existenceCheck(context)).toEqual([]);
  });

  test('a git-protocol dependency is never checked', () => {
    const changes = [
      makeChange({ name: UNKNOWN, protocol: 'git', specifier: 'git+https://example.test/x.git' }),
    ];
    expect(existenceCheck(makeContext(changes))).toEqual([]);
  });

  test('an alias dependency is checked by its registry name, not its manifest key', () => {
    const changes = [
      makeChange({
        name: 'react',
        registryName: UNKNOWN,
        protocol: 'alias',
        specifier: `npm:${UNKNOWN}@1.0.0`,
      }),
    ];
    const findings = existenceCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].packageName).toBe(UNKNOWN);
  });

  test('an alias dependency whose target the corpus knows is silent', () => {
    const changes = [
      makeChange({
        name: 'pad-left',
        registryName: 'left-pad',
        protocol: 'alias',
        specifier: 'npm:left-pad@1.3.0',
      }),
    ];
    expect(existenceCheck(makeContext(changes))).toEqual([]);
  });

  // Allowing the manifest key would let "react": "npm:<anything>" through,
  // which is the alias attack this check exists to see.
  test('allowing the manifest key does not silence the alias target', () => {
    const changes = [
      makeChange({
        name: 'react',
        registryName: UNKNOWN,
        protocol: 'alias',
        specifier: `npm:${UNKNOWN}@1.0.0`,
      }),
    ];
    const findings = existenceCheck(makeContext(changes, { allow: ['react'] }));
    expect(findings).toHaveLength(1);
    expect(findings[0].packageName).toBe(UNKNOWN);
  });

  test('an empty registry name produces a diagnostic instead of a finding', () => {
    const context = makeContext([
      makeChange({ name: 'broken-alias', registryName: '', protocol: 'alias', specifier: 'npm:' }),
    ]);
    expect(existenceCheck(context)).toEqual([]);
    expect(context.diagnostics).toHaveLength(1);
    expect(context.diagnostics[0].code).toBe('manifest-alias-empty');
    expect(context.diagnostics[0].message).toContain('broken-alias');
    expect(context.diagnostics[0].message).toContain('package.json');
  });

  test('the same unknown name in two sections of one manifest is one finding', () => {
    const changes = [
      makeChange({ name: UNKNOWN }),
      makeChange({ name: UNKNOWN, depType: 'devDependencies' }),
    ];
    expect(existenceCheck(makeContext(changes))).toHaveLength(1);
  });

  test('the same unknown name in two manifests is one finding per manifest', () => {
    const changes = [
      makeChange({ name: UNKNOWN, manifestPath: 'packages/a/package.json' }),
      makeChange({ name: UNKNOWN, manifestPath: 'packages/b/package.json' }),
    ];
    const findings = existenceCheck(makeContext(changes));
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.manifestPath)).toEqual([
      'packages/a/package.json',
      'packages/b/package.json',
    ]);
  });

  // Both name checks decline the same malformed alias, and the user should
  // hear about it once.
  test('both name checks sharing a context report the malformed alias once', () => {
    const context = makeContext([
      makeChange({ name: 'broken-alias', registryName: '', protocol: 'alias', specifier: 'npm:' }),
    ]);
    existenceCheck(context);
    typosquatCheck(context);
    expect(context.diagnostics).toHaveLength(1);
  });

  test('an empty delta produces nothing', () => {
    expect(existenceCheck(makeContext([]))).toEqual([]);
  });
});
