import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { hygieneCheck } from '../src/checks/hygiene.js';
import { fingerprintFinding } from '../src/fingerprint.js';
import { parseManifest } from '../src/manifest.js';
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
  online: false,
  minAgeDays: 7,
  minAgeAllow: [],
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
    ...(overrides.lockfilePath === undefined ? {} : { lockfilePath: overrides.lockfilePath }),
    ...(overrides.previousSpecifier === undefined ? {} : { previousSpecifier: overrides.previousSpecifier }),
    ...(overrides.specifierHeld === true ? { specifierHeld: true as const } : {}),
  };
}

function makeContext(changes: DepChange[], config: Partial<ResolvedConfig> = {}): CheckContext {
  const delta: DependencyDelta = {
    changes,
    lockEntryChanges: [],
    onlyBuiltAdded: [],
    lockfileFormat: 'npm',
    hasComparisonBase: true,
    workspaceLocalNames: new Set(),
    diagnostics: [],
  };
  return {
    corpus: STUB_CORPUS,
    config: { ...BASE_CONFIG, ...config },
    delta,
    npmrcRegistryPins: new Map<string, string>(),
    diagnostics: [] as Diagnostic[],
    allowed: [] as string[],
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

  test('an unchanged wildcard says the spec did not move and names the resolution that did', () => {
    const findings = hygieneCheck(
      makeContext([
        makeChange({
          name: 'left-pad',
          kind: 'changed',
          specifier: '*',
          previousSpecifier: '*',
          specifierHeld: true,
          manifestPath: 'packages/app/package.json',
          lockfilePath: 'pnpm-lock.yaml',
          before: { version: '1.2.3' },
          after: { version: '1.2.4' },
        }),
      ])
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe(
      '"left-pad" is specified as "*", which pins no version at all. ' +
        'The spec in packages/app/package.json did not change; pnpm-lock.yaml resolved it from 1.2.3 to 1.2.4.'
    );
    expect(findings[0].severity).toBe('medium');
    const plain = hygieneCheck(
      makeContext([
        makeChange({
          name: 'left-pad',
          kind: 'changed',
          specifier: '*',
          manifestPath: 'packages/app/package.json',
        }),
      ])
    );
    expect(fingerprintFinding(findings[0])).toBe(fingerprintFinding(plain[0]));
  });

  test('a held wildcard whose hash was removed names that and does not say different bytes', () => {
    const findings = hygieneCheck(
      makeContext([
        makeChange({
          name: 'left-pad',
          kind: 'changed',
          specifier: '*',
          specifierHeld: true,
          lockfilePath: 'package-lock.json',
          before: { version: '1.2.3', integrity: 'sha512-one' },
          after: { version: '1.2.3' },
        }),
      ])
    );
    expect(findings[0].message).toBe(
      '"left-pad" is specified as "*", which pins no version at all. ' +
        'The spec in package.json did not change; package-lock.json dropped the recorded hash.'
    );
    expect(findings[0].message).not.toContain('different bytes');
  });

  test('a held wildcard whose hash was recorded names that and does not say different bytes', () => {
    const findings = hygieneCheck(
      makeContext([
        makeChange({
          name: 'left-pad',
          kind: 'changed',
          specifier: '*',
          specifierHeld: true,
          lockfilePath: 'package-lock.json',
          before: { version: '1.2.3' },
          after: { version: '1.2.3', integrity: 'sha512-one' },
        }),
      ])
    );
    expect(findings[0].message).toBe(
      '"left-pad" is specified as "*", which pins no version at all. ' +
        'The spec in package.json did not change; package-lock.json recorded a hash.'
    );
  });

  test('a held wildcard rehashed upward names that and does not say different bytes', () => {
    const findings = hygieneCheck(
      makeContext([
        makeChange({
          name: 'left-pad',
          kind: 'changed',
          specifier: '*',
          specifierHeld: true,
          lockfilePath: 'package-lock.json',
          before: { version: '1.2.3', integrity: 'sha1-one' },
          after: { version: '1.2.3', integrity: 'sha512-two' },
        }),
      ])
    );
    expect(findings[0].message).toBe(
      '"left-pad" is specified as "*", which pins no version at all. ' +
        'The spec in package.json did not change; package-lock.json rehashed it upward.'
    );
  });

  test('a held wildcard resolved to a weaker hash names that and does not say different bytes', () => {
    const findings = hygieneCheck(
      makeContext([
        makeChange({
          name: 'left-pad',
          kind: 'changed',
          specifier: '*',
          specifierHeld: true,
          lockfilePath: 'package-lock.json',
          before: { version: '1.2.3', integrity: 'sha512-one' },
          after: { version: '1.2.3', integrity: 'sha1-two' },
        }),
      ])
    );
    expect(findings[0].message).toBe(
      '"left-pad" is specified as "*", which pins no version at all. ' +
        'The spec in package.json did not change; package-lock.json resolved it to a weaker hash.'
    );
  });

  test('a held wildcard with an unreadable hash names a different hash', () => {
    const findings = hygieneCheck(
      makeContext([
        makeChange({
          name: 'left-pad',
          kind: 'changed',
          specifier: '*',
          specifierHeld: true,
          lockfilePath: 'package-lock.json',
          before: { version: '1.2.3', integrity: 'sha512-one' },
          after: { version: '1.2.3', integrity: 'not-a-hash' },
        }),
      ])
    );
    expect(findings[0].message).toBe(
      '"left-pad" is specified as "*", which pins no version at all. ' +
        'The spec in package.json did not change; package-lock.json resolved it to a different hash.'
    );
    expect(findings[0].message).not.toContain('different bytes');
  });

  test('an unchanged wildcard whose versions match says the lockfile resolved different bytes', () => {
    const findings = hygieneCheck(
      makeContext([
        makeChange({
          name: 'left-pad',
          kind: 'changed',
          specifier: '*',
          previousSpecifier: '*',
          specifierHeld: true,
          lockfilePath: 'package-lock.json',
          before: { version: '1.2.3', integrity: 'sha512-one' },
          after: { version: '1.2.3', integrity: 'sha512-two' },
        }),
      ])
    );
    expect(findings[0].message).toBe(
      '"left-pad" is specified as "*", which pins no version at all. ' +
        'The spec in package.json did not change; package-lock.json resolved it to different bytes.'
    );
  });

  test('a held wildcard with a version recorded on only one side names that', () => {
    const findings = hygieneCheck(
      makeContext([
        makeChange({
          name: 'left-pad',
          kind: 'changed',
          specifier: '*',
          specifierHeld: true,
          lockfilePath: 'package-lock.json',
          before: { integrity: 'sha512-same', resolvedUrl: 'https://registry.npmjs.org/left-pad/-/left-pad-1.2.3.tgz' },
          after: {
            version: '1.2.3',
            integrity: 'sha512-same',
            resolvedUrl: 'https://registry.npmjs.org/left-pad/-/left-pad-1.2.3.tgz',
          },
        }),
      ])
    );
    expect(findings[0].message).toBe(
      '"left-pad" is specified as "*", which pins no version at all. ' +
        'The spec in package.json did not change; package-lock.json resolved it from no recorded version to 1.2.3.'
    );
  });

  test('a held wildcard whose integrity and resolved URL both moved names both', () => {
    const findings = hygieneCheck(
      makeContext([
        makeChange({
          name: 'left-pad',
          kind: 'changed',
          specifier: '*',
          specifierHeld: true,
          lockfilePath: 'package-lock.json',
          before: {
            version: '1.2.3',
            integrity: 'sha512-one',
            resolvedUrl: 'https://registry.npmjs.org/left-pad/-/left-pad-1.2.3.tgz',
          },
          after: {
            version: '1.2.3',
            integrity: 'sha512-two',
            resolvedUrl: 'https://registry.example/left-pad/-/left-pad-1.2.3.tgz',
          },
        }),
      ])
    );
    expect(findings[0].message).toBe(
      '"left-pad" is specified as "*", which pins no version at all. ' +
        'The spec in package.json did not change; package-lock.json resolved it to different bytes and a different URL.'
    );
  });

  test('matching specifier text without the held-spec decision keeps the original sentence', () => {
    const findings = hygieneCheck(
      makeContext([
        makeChange({
          name: 'left-pad',
          kind: 'changed',
          specifier: '*',
          previousSpecifier: '*',
          lockfilePath: 'package-lock.json',
          before: {
            version: '1.2.3',
            integrity: 'sha512-same',
            resolvedUrl: 'https://registry.npmjs.org/left-pad/-/left-pad-1.2.3.tgz',
          },
          after: {
            version: '1.2.3',
            integrity: 'sha512-same',
            resolvedUrl: 'https://registry.example/left-pad/-/left-pad-1.2.3.tgz',
          },
        }),
      ])
    );
    expect(findings[0].message).toBe('"left-pad" is specified as "*", which pins no version at all.');
  });

  test('an added wildcard keeps the original sentence even when the selected version moved', () => {
    const findings = hygieneCheck(
      makeContext([
        makeChange({
          name: 'left-pad',
          kind: 'added',
          specifier: '*',
          previousSpecifier: '*',
          before: { version: '1.2.3' },
          after: { version: '1.2.4' },
        }),
      ])
    );
    expect(findings[0].message).toBe('"left-pad" is specified as "*", which pins no version at all.');
  });

  test('a spec rewritten to a wildcard keeps the original sentence', () => {
    const findings = hygieneCheck(
      makeContext([
        makeChange({
          name: 'left-pad',
          kind: 'changed',
          specifier: '*',
          previousSpecifier: '^1.2.3',
          before: { version: '1.2.3' },
          after: { version: '1.2.4' },
        }),
      ])
    );
    expect(findings[0].message).toBe('"left-pad" is specified as "*", which pins no version at all.');
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

// A peer range is a compatibility statement addressed to whoever installs
// this package; nothing is installed from it by the package declaring it.
// The wildcard-plus-peerDependenciesMeta shape below is how a library says
// "I work with any version of this, and you do not need it at all", and it
// is completely standard.
describe('hygieneCheck: peerDependencies are exempt', () => {
  test.each(['*', 'latest', ''])(
    'a peer dependency with specifier "%s" is silent',
    (specifier) => {
      const changes = [makeChange({ name: 'happy-dom', specifier, depType: 'peerDependencies' })];
      expect(hygieneCheck(makeContext(changes))).toEqual([]);
    }
  );

  test('a real library manifest declaring optional wildcard peers reports nothing for them', () => {
    const content = readFileSync(
      fileURLToPath(new URL('./fixtures/manifest-optional-peers.json', import.meta.url)),
      'utf8'
    );
    const manifest = parseManifest('packages/runner/package.json', content);
    const changes: DepChange[] = manifest.deps.map((dep) => ({
      name: dep.name,
      registryName: dep.registryName,
      specifier: dep.specifier,
      kind: 'added',
      depType: dep.depType,
      protocol: dep.protocol,
      manifestPath: manifest.path,
    }));

    const findings = hygieneCheck(makeContext(changes));

    // Three wildcard peers in that manifest, and one wildcard dev
    // dependency. Only the dev one is this tool's business.
    expect(findings.map((finding) => finding.packageName)).toEqual(['strip-literal']);
    expect(findings[0].severity).toBe('low');
  });
});

// Who carries the risk decides the severity. npm resolves a package's
// runtime dependencies for everyone who installs it, so a wildcard there is
// inflicted on strangers; it does not install dependencies' dev
// dependencies, so a wildcard there is inflicted only on the maintainer of
// this repository. Optional dependencies ship to consumers the same way
// runtime ones do, so they group with dependencies. Low keeps the dev case
// visible without blocking at the default medium gate.
describe('hygieneCheck: severity by dependency section', () => {
  test('a wildcard in dependencies is medium', () => {
    const changes = [makeChange({ name: 'left-pad', specifier: '*', depType: 'dependencies' })];
    expect(hygieneCheck(makeContext(changes))[0].severity).toBe('medium');
  });

  test('a wildcard in optionalDependencies is medium', () => {
    const changes = [
      makeChange({ name: 'left-pad', specifier: '*', depType: 'optionalDependencies' }),
    ];
    expect(hygieneCheck(makeContext(changes))[0].severity).toBe('medium');
  });

  test('a wildcard in devDependencies is low', () => {
    const changes = [makeChange({ name: 'left-pad', specifier: '*', depType: 'devDependencies' })];
    expect(hygieneCheck(makeContext(changes))[0].severity).toBe('low');
  });

  test('a later section that wins the collapse uses that section sentence', () => {
    const findings = hygieneCheck(
      makeContext([
        makeChange({
          name: 'left-pad',
          kind: 'changed',
          specifier: '*',
          specifierHeld: true,
          depType: 'devDependencies',
          lockfilePath: 'package-lock.json',
          before: { version: '1.2.3' },
          after: { version: '1.2.4' },
        }),
        makeChange({
          name: 'left-pad',
          kind: 'changed',
          specifier: '*',
          previousSpecifier: '^1.0.0',
          depType: 'optionalDependencies',
          before: { version: '1.2.3' },
          after: { version: '1.2.4' },
        }),
      ])
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('medium');
    expect(findings[0].details).toMatchObject({ depType: 'optionalDependencies', specifier: '*' });
    expect(findings[0].message).toBe('"left-pad" is specified as "*", which pins no version at all.');
  });

  test('one name in two sections is reported at the more severe of the two, whichever arrives first', () => {
    // The two sections collapse to one finding (they share a fingerprint),
    // so which severity survives must not depend on the order the delta
    // happened to produce them in.
    const devFirst = [
      makeChange({ name: 'left-pad', specifier: '*', depType: 'devDependencies' }),
      makeChange({ name: 'left-pad', specifier: '*', depType: 'dependencies' }),
    ];
    const findings = hygieneCheck(makeContext(devFirst));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('medium');
  });

  test('the section is in the details, so the severity can be read back to its cause', () => {
    const changes = [makeChange({ name: 'left-pad', specifier: '*', depType: 'devDependencies' })];
    expect(hygieneCheck(makeContext(changes))[0].details).toMatchObject({
      depType: 'devDependencies',
    });
  });
});

// A DefinitelyTyped package ships no runtime code -- its declarations are
// erased at compile time -- so an unpinned range on one cannot hand an
// attacker code that executes the way a wildcard on an ordinary runtime
// dependency can. Demoted rather than exempted: the finding stays visible
// to an auditor, and install-script still covers the residual risk. This
// was measured against nine well maintained public repositories: every one
// of jest's 19 blocking version-hygiene findings was a wildcard on
// "@types/node" in dependencies.
describe('hygieneCheck: type-only packages are demoted', () => {
  test('a wildcard on an @types package in dependencies is low, not medium', () => {
    const changes = [makeChange({ name: '@types/node', specifier: '*', depType: 'dependencies' })];
    const findings = hygieneCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('low');
  });

  test('a wildcard on an @types package in optionalDependencies is low, not medium', () => {
    const changes = [
      makeChange({ name: '@types/node', specifier: '*', depType: 'optionalDependencies' }),
    ];
    expect(hygieneCheck(makeContext(changes))[0].severity).toBe('low');
  });

  test('a wildcard on an @types package in devDependencies stays low', () => {
    const changes = [
      makeChange({ name: '@types/node', specifier: '*', depType: 'devDependencies' }),
    ];
    expect(hygieneCheck(makeContext(changes))[0].severity).toBe('low');
  });

  test('a wildcard on an @types package in peerDependencies stays exempt', () => {
    const changes = [makeChange({ name: '@types/node', specifier: '*', depType: 'peerDependencies' })];
    expect(hygieneCheck(makeContext(changes))).toEqual([]);
  });

  test('a non-@types scoped package is unaffected and stays medium', () => {
    const changes = [makeChange({ name: '@babel/core', specifier: '*', depType: 'dependencies' })];
    expect(hygieneCheck(makeContext(changes))[0].severity).toBe('medium');
  });

  // A name merely containing "types" is not the @types scope; only a
  // package actually published under it is type-only by this rule's
  // reasoning.
  test('an unscoped package named "types-something" is unaffected', () => {
    const changes = [makeChange({ name: 'types-utils', specifier: '*', depType: 'dependencies' })];
    expect(hygieneCheck(makeContext(changes))[0].severity).toBe('medium');
  });

  test('an @types package still respects the allow list', () => {
    const changes = [makeChange({ name: '@types/node', specifier: '*', depType: 'dependencies' })];
    const context = makeContext(changes, { allow: ['@types/node'] });
    expect(hygieneCheck(context)).toEqual([]);
  });

  // The literal name '@types/' cannot exist on the registry, but the
  // boundary guard is worth pinning anyway: it mirrors allow.ts's
  // isAllowed scope-pattern check, and a bare startsWith without it would
  // treat the prefix as matching itself.
  test('the bare scope "@types/" is not treated as a type-only match', () => {
    const changes = [makeChange({ name: '@types/', specifier: '*', depType: 'dependencies' })];
    expect(hygieneCheck(makeContext(changes))[0].severity).toBe('medium');
  });

  // Regression: the merge tie-break used to compare each candidate's
  // REPORTED severity, which a type-only package always collapses to
  // 'low' regardless of section, so the choice of which depType survives
  // into details silently became whichever DepChange arrived first. It
  // has to compare the UNDEMOTED per-section severity instead, so
  // dependencies (medium before demotion) is recorded as the surviving
  // section over devDependencies (low before and after) regardless of
  // arrival order -- an auditor reading details.depType should see the
  // section that actually carries the runtime risk.
  test('an @types wildcard in both dependencies and devDependencies keeps dependencies in details, dependencies first', () => {
    const changes = [
      makeChange({ name: '@types/node', specifier: '*', depType: 'dependencies' }),
      makeChange({ name: '@types/node', specifier: '*', depType: 'devDependencies' }),
    ];
    const findings = hygieneCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('low');
    expect(findings[0].details).toMatchObject({ depType: 'dependencies' });
  });

  test('an @types wildcard in both dependencies and devDependencies keeps dependencies in details, devDependencies first', () => {
    const changes = [
      makeChange({ name: '@types/node', specifier: '*', depType: 'devDependencies' }),
      makeChange({ name: '@types/node', specifier: '*', depType: 'dependencies' }),
    ];
    const findings = hygieneCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('low');
    expect(findings[0].details).toMatchObject({ depType: 'dependencies' });
  });
});
