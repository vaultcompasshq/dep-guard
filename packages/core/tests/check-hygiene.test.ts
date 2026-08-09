import { hygieneCheck } from '../src/checks/hygiene.js';
import type { CheckContext, ResolvedConfig } from '../src/checks/types.js';
import type { Corpus } from '../src/corpus.js';
import type { DepChange, DependencyDelta } from '../src/delta.js';
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

function makeContext(changes: DepChange[], config: Partial<ResolvedConfig> = {}): CheckContext {
  const delta: DependencyDelta = {
    changes,
    lockEntryChanges: [],
    onlyBuiltAdded: [],
    lockfileFormat: 'npm',
    hasComparisonBase: true,
    diagnostics: [],
  };
  return {
    corpus: STUB_CORPUS,
    config: { ...BASE_CONFIG, ...config },
    delta,
    npmrcRegistryPins: new Map<string, string>(),
    diagnostics: [] as Diagnostic[],
  };
}

describe('hygieneCheck: flagged specifiers', () => {
  test.each(['*', 'latest', ''])('an added registry dependency with specifier "%s" is medium', (specifier) => {
    const findings = hygieneCheck(makeContext([makeChange({ name: 'left-pad', specifier })]));
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('version-hygiene');
    expect(findings[0].severity).toBe('medium');
    expect(findings[0].packageName).toBe('left-pad');
  });

  test('a normal semver range is silent', () => {
    const findings = hygieneCheck(makeContext([makeChange({ name: 'left-pad', specifier: '^1.0.0' })]));
    expect(findings).toEqual([]);
  });

  test('an "x" bare range is silent (v1 only flags *, latest, and empty)', () => {
    const findings = hygieneCheck(makeContext([makeChange({ name: 'left-pad', specifier: 'x' })]));
    expect(findings).toEqual([]);
  });

  // Attacks arrive as changed too: a pinned range rewritten to a wildcard.
  test('a changed dependency whose specifier is now a wildcard is flagged', () => {
    const changes = [makeChange({ name: 'left-pad', kind: 'changed', specifier: '*' })];
    const findings = hygieneCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
  });

  test('a changed dependency with an ordinary bumped range is silent', () => {
    const changes = [makeChange({ name: 'left-pad', kind: 'changed', specifier: '^1.2.0' })];
    expect(hygieneCheck(makeContext(changes))).toEqual([]);
  });
});

describe('hygieneCheck: protocol exemptions', () => {
  test('a workspace-protocol dependency is exempt even with specifier "*"', () => {
    const changes = [makeChange({ name: 'left-pad', protocol: 'workspace', specifier: 'workspace:*' })];
    expect(hygieneCheck(makeContext(changes))).toEqual([]);
  });

  test('a git-protocol dependency is exempt', () => {
    const changes = [makeChange({ name: 'left-pad', protocol: 'git', specifier: '*' })];
    expect(hygieneCheck(makeContext(changes))).toEqual([]);
  });

  test('a url-protocol dependency is exempt', () => {
    const changes = [makeChange({ name: 'left-pad', protocol: 'url', specifier: '*' })];
    expect(hygieneCheck(makeContext(changes))).toEqual([]);
  });
});

// An alias IS a registry install of its target at a version range, unlike
// the truly wiring-only protocols above -- grouping it with them as
// "exempt by construction" would be wrong. delta.ts's
// versionRangeOf pulls the range out from behind the "npm:" wrapper, so
// "npm:lodash@*" is judged on its "*", not on the literal string
// "npm:lodash@*" (which trivially never equals any flagged form).
describe('hygieneCheck: alias dependencies use the alias version range', () => {
  test('npm:lodash@* fires', () => {
    const changes = [
      makeChange({ name: 'ld', registryName: 'lodash', protocol: 'alias', specifier: 'npm:lodash@*' }),
    ];
    const findings = hygieneCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('version-hygiene');
    expect(findings[0].packageName).toBe('lodash');
  });

  test('an alias pinned to a normal range is silent', () => {
    const changes = [
      makeChange({ name: 'ld', registryName: 'lodash', protocol: 'alias', specifier: 'npm:lodash@^4.17.21' }),
    ];
    expect(hygieneCheck(makeContext(changes))).toEqual([]);
  });

  test('an allow-listed alias target does not fire even with a wildcard range', () => {
    const changes = [
      makeChange({ name: 'ld', registryName: 'lodash', protocol: 'alias', specifier: 'npm:lodash@*' }),
    ];
    const context = makeContext(changes, { allow: ['lodash'] });
    expect(hygieneCheck(context)).toEqual([]);
  });

  // Confirmed intentional: an alias with no version range at all --
  // "pkg": "npm:lodash" -- installs whatever is newest, the same
  // as an explicit "latest" would. versionRangeOf returns an empty string
  // for a target with no "@version" suffix, which is already one of the
  // three flagged forms, so this fires correctly rather than by accident.
  // Pinned here as a deliberate behavior, not an incidental side effect.
  test('an alias with no version range at all fires (equivalent to latest)', () => {
    const changes = [makeChange({ name: 'ld', registryName: 'lodash', protocol: 'alias', specifier: 'npm:lodash' })];
    const findings = hygieneCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('version-hygiene');
    expect(findings[0].packageName).toBe('lodash');
  });
});

// candidates.ts already dedupes the two name checks by (manifestPath,
// registryName) so that two aliases retargeting the same package, or the
// same name in both dependencies and devDependencies, report once -- the
// fingerprint only hashes ruleId/packageName/manifestPath/signal, so two
// findings that differ only in which manifest key produced them are
// otherwise indistinguishable, and baselining one silently suppresses the
// rest.
describe('hygieneCheck: fingerprint-colliding duplicates (C1)', () => {
  test('two aliases retargeting the same package in one manifest report only once', () => {
    const changes = [
      makeChange({ name: 'a', registryName: 'left-pad', protocol: 'alias', specifier: 'npm:left-pad@*' }),
      makeChange({ name: 'b', registryName: 'left-pad', protocol: 'alias', specifier: 'npm:left-pad@latest' }),
    ];
    const findings = hygieneCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].packageName).toBe('left-pad');
  });

  test('the same registry name added to dependencies and devDependencies reports only once', () => {
    const changes = [
      makeChange({ name: 'left-pad', specifier: '*', depType: 'dependencies' }),
      makeChange({ name: 'left-pad', specifier: '*', depType: 'devDependencies' }),
    ];
    const findings = hygieneCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
  });
});

describe('hygieneCheck: allow list', () => {
  test('an allow-listed package does not fire even with specifier "*"', () => {
    const context = makeContext([makeChange({ name: 'left-pad', specifier: '*' })], { allow: ['left-pad'] });
    expect(hygieneCheck(context)).toEqual([]);
  });
});
