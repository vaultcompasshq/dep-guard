import {
  findRegisteredSquats,
  REGISTERED_SQUAT_DOWNLOAD_FLOOR,
  REGISTERED_SQUAT_MAX_AGE_DAYS,
} from '../src/online/registered-squat.js';
import type { CheckContext, ResolvedConfig } from '../src/checks/types.js';
import type { Corpus } from '../src/corpus.js';
import type { DepChange } from '../src/delta.js';
import type { Diagnostic } from '../src/types.js';

const STUB_CORPUS: Corpus = {
  hasName: () => false,
  topRank: () => null,
  aliasTargets: () => [],
  topNames: [],
  builtAt: 'test',
};

const BASE_CONFIG: ResolvedConfig = {
  failOn: 'medium',
  allow: [],
  internalScopes: [],
  internalPrefixes: [],
  extraAliases: {},
  ignorePaths: [],
  online: true,
};

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

function makeContext(changes: DepChange[]): CheckContext {
  return {
    corpus: STUB_CORPUS,
    config: BASE_CONFIG,
    delta: {
      changes,
      lockEntryChanges: [],
      onlyBuiltAdded: [],
      lockfileFormat: 'npm',
      hasComparisonBase: true,
      workspaceLocalNames: new Set(),
      diagnostics: [],
    },
    npmrcRegistryPins: new Map(),
    diagnostics: [] as Diagnostic[],
  };
}

const NOW = Date.parse('2026-08-16T00:00:00.000Z');
const nowFn = () => NOW;

function fakeDeps(downloads: Record<string, number>, packuments: Record<string, string | null>) {
  return {
    fetchWeeklyDownloads: async (names: string[]) => {
      const map = new Map<string, number>();
      for (const name of names) {
        if (name in downloads) {
          map.set(name, downloads[name]);
        }
      }
      return map;
    },
    fetchPackument: async (name: string) => {
      if (!(name in packuments)) {
        return null;
      }
      return { createdAt: packuments[name] };
    },
  };
}

describe('findRegisteredSquats', () => {
  test('flags a name below the download floor and newly created', async () => {
    const ctx = makeContext([makeChange({ name: 'react-codeshift' })]);
    const findings = await findRegisteredSquats(
      ctx,
      fakeDeps({ 'react-codeshift': 4 }, { 'react-codeshift': '2026-08-01T00:00:00.000Z' }),
      ctx.diagnostics,
      nowFn
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'registered-squat',
      severity: 'medium',
      packageName: 'react-codeshift',
      details: { signal: 'registered-squat' },
    });
  });

  test('does not flag a name at or above the download floor', async () => {
    const ctx = makeContext([makeChange({ name: 'remark-man' })]);
    const findings = await findRegisteredSquats(
      ctx,
      fakeDeps(
        { 'remark-man': REGISTERED_SQUAT_DOWNLOAD_FLOOR },
        { 'remark-man': '2026-08-01T00:00:00.000Z' }
      ),
      ctx.diagnostics,
      nowFn
    );
    expect(findings).toEqual([]);
  });

  test('does not flag a name below the floor but old enough', async () => {
    const ctx = makeContext([makeChange({ name: 'crossenv' })]);
    const oldDate = new Date(NOW - (REGISTERED_SQUAT_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    const findings = await findRegisteredSquats(
      ctx,
      fakeDeps({ crossenv: 10 }, { crossenv: oldDate }),
      ctx.diagnostics,
      nowFn
    );
    expect(findings).toEqual([]);
  });

  test('flags a recently-created name the downloads API has no record for at all', async () => {
    // A name missing from the counts Map means the API answered but has no
    // download record for this exact name -- precisely the archetypal
    // registered-squat case (a freshly-registered attacker name), and a
    // stronger signal than a low recorded count, not a reason to skip it.
    const ctx = makeContext([makeChange({ name: 'totally-made-up-hallucinated-xyz123' })]);
    const findings = await findRegisteredSquats(
      ctx,
      fakeDeps({}, { 'totally-made-up-hallucinated-xyz123': '2026-08-10T00:00:00.000Z' }),
      ctx.diagnostics,
      nowFn
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'registered-squat',
      severity: 'medium',
      packageName: 'totally-made-up-hallucinated-xyz123',
      details: { signal: 'registered-squat', weeklyDownloads: 0 },
    });
  });

  test('does not flag a name with no packument data', async () => {
    const ctx = makeContext([makeChange({ name: 'ghost-pkg' })]);
    const findings = await findRegisteredSquats(
      ctx,
      fakeDeps({ 'ghost-pkg': 1 }, {}),
      ctx.diagnostics,
      nowFn
    );
    expect(findings).toEqual([]);
  });

  test('a workspace-local name is never a candidate', async () => {
    const ctx = makeContext([makeChange({ name: 'react-codeshift' })]);
    ctx.delta.workspaceLocalNames = new Set(['react-codeshift']);
    const findings = await findRegisteredSquats(
      ctx,
      fakeDeps({ 'react-codeshift': 1 }, { 'react-codeshift': '2026-08-15T00:00:00.000Z' }),
      ctx.diagnostics,
      nowFn
    );
    expect(findings).toEqual([]);
  });

  test('does nothing, and calls nothing, when the delta has no candidates', async () => {
    const ctx = makeContext([]);
    let called = false;
    const deps = {
      fetchWeeklyDownloads: async () => {
        called = true;
        return new Map<string, number>();
      },
      fetchPackument: async () => null,
    };
    const findings = await findRegisteredSquats(ctx, deps, ctx.diagnostics, nowFn);
    expect(findings).toEqual([]);
    expect(called).toBe(false);
  });

  test('a downloads fetch failure degrades to no findings with a diagnostic', async () => {
    const ctx = makeContext([makeChange({ name: 'react-codeshift' })]);
    const diagnostics: Diagnostic[] = [];
    const deps = {
      fetchWeeklyDownloads: async () => {
        throw new Error('socket hang up');
      },
      fetchPackument: async () => null,
    };
    const findings = await findRegisteredSquats(ctx, deps, diagnostics, nowFn);
    expect(findings).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('online-check-unreachable');
  });

  test('a packument fetch failure for one name diagnoses and skips just that name', async () => {
    const ctx = makeContext([
      makeChange({ name: 'react-codeshift' }),
      makeChange({ name: 'unused-imports' }),
    ]);
    const diagnostics: Diagnostic[] = [];
    const deps = {
      fetchWeeklyDownloads: async () => new Map([['react-codeshift', 4], ['unused-imports', 9]]),
      fetchPackument: async (name: string) => {
        if (name === 'react-codeshift') {
          throw new Error('timed out');
        }
        return { createdAt: '2026-08-01T00:00:00.000Z' };
      },
    };
    const findings = await findRegisteredSquats(ctx, deps, diagnostics, nowFn);
    expect(findings).toHaveLength(1);
    expect(findings[0].packageName).toBe('unused-imports');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('online-check-unreachable');
    expect(diagnostics[0].message).toContain('react-codeshift');
  });
});
