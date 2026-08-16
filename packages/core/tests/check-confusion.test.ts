import { confusionCheck } from '../src/checks/confusion.js';
import { fingerprintFinding } from '../src/fingerprint.js';
import type { CheckContext, ResolvedConfig } from '../src/checks/types.js';
import type { Corpus } from '../src/corpus.js';
import type { DepChange, DependencyDelta, LockEntryChange } from '../src/delta.js';
import type { LockEntry } from '../src/lockfiles/types.js';
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

function makeLockEntryChange(
  name: string,
  after: LockEntry,
  overrides: Partial<LockEntryChange> = {}
): LockEntryChange {
  return {
    name,
    packageName: name,
    kind: 'changed',
    manifestPath: 'package-lock.json',
    lockfilePath: 'package-lock.json',
    after,
    ...overrides,
  };
}

interface ContextOptions {
  config?: Partial<ResolvedConfig>;
  pins?: Map<string, string>;
  lockEntryChanges?: LockEntryChange[];
}

function makeContext(changes: DepChange[], options: ContextOptions = {}): CheckContext {
  const delta: DependencyDelta = {
    changes,
    lockEntryChanges: options.lockEntryChanges ?? [],
    onlyBuiltAdded: [],
    lockfileFormat: 'npm',
    hasComparisonBase: true,
    workspaceLocalNames: new Set(),
    diagnostics: [],
  };
  return {
    corpus: STUB_CORPUS,
    config: { ...BASE_CONFIG, ...options.config },
    delta,
    npmrcRegistryPins: options.pins ?? new Map<string, string>(),
    diagnostics: [] as Diagnostic[],
  };
}

describe('confusionCheck: silent by default', () => {
  test('no config and no pins is silent even for a scoped, internal-looking name', () => {
    const changes = [
      makeChange({
        name: '@acme/widgets',
        after: { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/@acme/widgets/-/widgets-1.0.0.tgz' },
      }),
    ];
    expect(confusionCheck(makeContext(changes))).toEqual([]);
  });
});

describe('confusionCheck: rule 1, pinned scope resolves elsewhere', () => {
  test('a pinned scope resolving from a different host is high', () => {
    const pins = new Map([['@acme', 'https://npm.acme.example/']]);
    const changes = [
      makeChange({
        name: '@acme/widgets',
        after: { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/@acme/widgets/-/widgets-1.0.0.tgz' },
      }),
    ];
    const findings = confusionCheck(makeContext(changes, { pins }));
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('dependency-confusion');
    expect(findings[0].severity).toBe('high');
    expect(findings[0].packageName).toBe('@acme/widgets');
    // The signal carries the host it actually resolved from, so accepting
    // one wrong host in a baseline does not accept every later one under
    // the same rule.
    expect(findings[0].details?.signal).toBe('pin-mismatch:registry.npmjs.org');
  });

  test('two different resolved hosts under one pin get two different fingerprints', () => {
    const pins = new Map([['@acme', 'https://npm.acme.example/']]);
    const at = (host: string) =>
      confusionCheck(
        makeContext(
          [
            makeChange({
              name: '@acme/widgets',
              after: { version: '1.0.0', resolvedUrl: `https://${host}/@acme/widgets/-/widgets-1.0.0.tgz` },
            }),
          ],
          { pins }
        )
      )[0];

    expect(fingerprintFinding(at('registry.npmjs.org'))).not.toBe(
      fingerprintFinding(at('evil.example.test'))
    );
  });

  // Rule 1 is not gated on kind: a resolution repointed with no manifest
  // change at all is exactly what a changed (not added) registry
  // dependency looks like, and it is exactly the shape this rule exists
  // to catch.
  test('a changed registry dependency resolving from a different host is still high', () => {
    const pins = new Map([['@acme', 'https://npm.acme.example/']]);
    const changes = [
      makeChange({
        name: '@acme/widgets',
        kind: 'changed',
        after: { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/@acme/widgets/-/widgets-1.0.0.tgz' },
      }),
    ];
    expect(confusionCheck(makeContext(changes, { pins }))).toHaveLength(1);
  });

  test('a pinned scope resolving from the matching host is silent', () => {
    const pins = new Map([['@acme', 'https://npm.acme.example/']]);
    const changes = [
      makeChange({
        name: '@acme/widgets',
        after: { version: '1.0.0', resolvedUrl: 'https://npm.acme.example/@acme/widgets/-/widgets-1.0.0.tgz' },
      }),
    ];
    expect(confusionCheck(makeContext(changes, { pins }))).toEqual([]);
  });

  test('a pin for an unrelated scope does not apply', () => {
    const pins = new Map([['@other', 'https://npm.acme.example/']]);
    const changes = [
      makeChange({
        name: '@acme/widgets',
        after: { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/@acme/widgets/-/widgets-1.0.0.tgz' },
      }),
    ];
    expect(confusionCheck(makeContext(changes, { pins }))).toEqual([]);
  });

  test('an unscoped name is never subject to rule 1', () => {
    const pins = new Map([['@acme', 'https://npm.acme.example/']]);
    const changes = [
      makeChange({
        name: 'left-pad',
        after: { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz' },
      }),
    ];
    expect(confusionCheck(makeContext(changes, { pins }))).toEqual([]);
  });

  // npmrc pin values may carry inline "#" comment text and must be parsed
  // defensively; failure to parse is fail-soft, not a throw. A genuinely
  // unparseable pin also has to be visible as a skipped check, not just
  // silent, so it raises a diagnostic naming the scope -- never the pin
  // value itself.
  test('a genuinely unparseable pin value fails soft and raises a diagnostic naming only the scope', () => {
    const pins = new Map([['@acme', 'not a url at all SECRETMARKER']]);
    const changes = [
      makeChange({
        name: '@acme/widgets',
        after: { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/@acme/widgets/-/widgets-1.0.0.tgz' },
      }),
    ];
    const context = makeContext(changes, { pins });
    expect(() => confusionCheck(context)).not.toThrow();
    expect(confusionCheck(context)).toEqual([]);
    expect(context.diagnostics).toHaveLength(1);
    expect(context.diagnostics[0].code).toBe('npmrc-pin-unparseable');
    expect(context.diagnostics[0].message).toContain('@acme');
    expect(context.diagnostics[0].message).not.toContain('SECRETMARKER');
  });

  // npm accepts a protocol-relative registry pin
  // ("//npm.acme.example/") and state.ts deliberately preserves it as-is,
  // so a bare `new URL()` call on it throws; the check must retry with an
  // "https:" prefix rather than treating it as unparseable.
  test('a protocol-relative pin resolving to a different host is high', () => {
    const pins = new Map([['@acme', '//npm.acme.example/']]);
    const changes = [
      makeChange({
        name: '@acme/widgets',
        after: { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/@acme/widgets/-/widgets-1.0.0.tgz' },
      }),
    ];
    const context = makeContext(changes, { pins });
    const findings = confusionCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('dependency-confusion');
    expect(context.diagnostics).toEqual([]);
  });

  test('a protocol-relative pin resolving to the matching host is silent', () => {
    const pins = new Map([['@acme', '//npm.acme.example/']]);
    const changes = [
      makeChange({
        name: '@acme/widgets',
        after: { version: '1.0.0', resolvedUrl: 'https://npm.acme.example/@acme/widgets/-/widgets-1.0.0.tgz' },
      }),
    ];
    expect(confusionCheck(makeContext(changes, { pins }))).toEqual([]);
  });

  // If the retry above were unconditional, WHATWG host parsing would
  // accept nearly any space-free string as a syntactically valid host, so
  // garbage pins (a leaked token, a Windows path, a bare file:// pin)
  // could become high-severity findings whose message and
  // details.pinHost contained the pin text itself -- exactly what the
  // retry guard exists to prevent. The accepted host also has to look
  // like a hostname (contains a dot, or the hostname is exactly
  // "localhost") before it is trusted; anything else takes the
  // unparseable path.
  describe('a garbage pin never produces a finding or leaks into any output', () => {
    test.each([
      ['a leaked GitHub token', 'ghp_PINSECRETVALUE'],
      ['a leaked API key', 'sk-live-ABCDEF123456'],
      ['a Windows filesystem path', 'C:\\npm\\registry'],
      ['a bare file: URL', 'file:///srv/registry'],
    ])('%s', (_label, pinValue) => {
      const pins = new Map([['@acme', pinValue]]);
      const changes = [
        makeChange({
          name: '@acme/widgets',
          after: { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/@acme/widgets/-/widgets-1.0.0.tgz' },
        }),
      ];
      const context = makeContext(changes, { pins });
      const findings = confusionCheck(context);
      expect(findings).toEqual([]);
      expect(context.diagnostics).toHaveLength(1);
      expect(context.diagnostics[0].code).toBe('npmrc-pin-unparseable');
      expect(context.diagnostics[0].message).not.toContain(pinValue);
    });
  });

  // The genuine forms I2 introduced must keep working after NEW-2's
  // tightened validation: protocol-relative (asserted above), a bare
  // hostname with no scheme at all, and a bare host:port pin (the shape a
  // self-hosted registry like Verdaccio commonly uses).
  test('a bare hostname pin with no scheme at all still works', () => {
    const pins = new Map([['@acme', 'npm.acme.example']]);
    const changes = [
      makeChange({
        name: '@acme/widgets',
        after: { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/@acme/widgets/-/widgets-1.0.0.tgz' },
      }),
    ];
    const context = makeContext(changes, { pins });
    expect(confusionCheck(context)).toHaveLength(1);
    expect(context.diagnostics).toEqual([]);
  });

  test('a bare host:port pin (e.g. a self-hosted registry) still works', () => {
    const pins = new Map([['@acme', 'localhost:4873']]);
    const changes = [
      makeChange({
        name: '@acme/widgets',
        after: { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/@acme/widgets/-/widgets-1.0.0.tgz' },
      }),
    ];
    const context = makeContext(changes, { pins });
    expect(confusionCheck(context)).toHaveLength(1);
    expect(context.diagnostics).toEqual([]);
  });

  test('a bare host:port pin matching the resolved host is silent', () => {
    const pins = new Map([['@acme', 'localhost:4873']]);
    const changes = [
      makeChange({
        name: '@acme/widgets',
        after: { version: '1.0.0', resolvedUrl: 'http://localhost:4873/@acme/widgets/-/widgets-1.0.0.tgz' },
      }),
    ];
    expect(confusionCheck(makeContext(changes, { pins }))).toEqual([]);
  });

  test('an unparseable resolvedUrl fails soft instead of throwing', () => {
    const pins = new Map([['@acme', 'https://npm.acme.example/']]);
    const changes = [makeChange({ name: '@acme/widgets', after: { version: '1.0.0', resolvedUrl: 'not a url' } })];
    expect(() => confusionCheck(makeContext(changes, { pins }))).not.toThrow();
    expect(confusionCheck(makeContext(changes, { pins }))).toEqual([]);
  });

  test('no after entry at all means nothing to compare, so rule 1 is silent', () => {
    const pins = new Map([['@acme', 'https://npm.acme.example/']]);
    const changes = [makeChange({ name: '@acme/widgets' })];
    expect(confusionCheck(makeContext(changes, { pins }))).toEqual([]);
  });

  // Credential-adjacent handling: the raw pin value never reaches a
  // finding message, only the derived host.
  test('the raw pin value never appears in the finding message', () => {
    const pins = new Map([['@acme', 'https://npm.acme.example/some/secret-path-marker']]);
    const changes = [
      makeChange({
        name: '@acme/widgets',
        after: { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/@acme/widgets/-/widgets-1.0.0.tgz' },
      }),
    ];
    const findings = confusionCheck(makeContext(changes, { pins }));
    expect(findings).toHaveLength(1);
    expect(findings[0].message).not.toContain('secret-path-marker');
    expect(JSON.stringify(findings[0].details)).not.toContain('secret-path-marker');
  });

  test('an allow-listed scoped package is silent even on a host mismatch', () => {
    const pins = new Map([['@acme', 'https://npm.acme.example/']]);
    const changes = [
      makeChange({
        name: '@acme/widgets',
        after: { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/@acme/widgets/-/widgets-1.0.0.tgz' },
      }),
    ];
    const context = makeContext(changes, { pins, config: { allow: ['@acme/*'] } });
    expect(confusionCheck(context)).toEqual([]);
  });
});

// pin-mismatch judges a RESOLUTION, and resolutions live in the lockfile
// walk. Looping delta.changes alone would mean the rule sees only the
// small minority of entries a manifest declares -- so a transitive
// package under a pinned scope, resolving from the public registry,
// would be invisible to the one rule written to catch exactly that.
describe('confusionCheck: rule 1 reads the lockfile walk too', () => {
  const PINS = new Map([['@acme', 'https://npm.acme.example/']]);
  const PUBLIC: LockEntry = {
    version: '1.0.0',
    resolvedUrl: 'https://registry.npmjs.org/@acme/widgets/-/widgets-1.0.0.tgz',
  };

  test('a transitive entry under a pinned scope resolving publicly is high', () => {
    const context = makeContext([], {
      pins: PINS,
      lockEntryChanges: [makeLockEntryChange('@acme/widgets', PUBLIC)],
    });
    const findings = confusionCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('dependency-confusion');
    expect(findings[0].severity).toBe('high');
    expect(findings[0].packageName).toBe('@acme/widgets');
    expect(findings[0].details?.signal).toBe('pin-mismatch:registry.npmjs.org');
    expect(findings[0].lockfilePath).toBe('package-lock.json');
  });

  test('a newly added transitive entry is judged the same way', () => {
    const context = makeContext([], {
      pins: PINS,
      lockEntryChanges: [makeLockEntryChange('@acme/widgets', PUBLIC, { kind: 'added' })],
    });
    expect(confusionCheck(context)).toHaveLength(1);
  });

  test('an entry resolving from the pinned host itself is silent', () => {
    const context = makeContext([], {
      pins: PINS,
      lockEntryChanges: [
        makeLockEntryChange('@acme/widgets', {
          version: '1.0.0',
          resolvedUrl: 'https://npm.acme.example/@acme/widgets/-/widgets-1.0.0.tgz',
        }),
      ],
    });
    expect(confusionCheck(context)).toEqual([]);
  });

  test('an unscoped entry has no pin to miss', () => {
    const context = makeContext([], {
      pins: PINS,
      lockEntryChanges: [
        makeLockEntryChange('lodash', {
          version: '4.17.21',
          resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
        }),
      ],
    });
    expect(confusionCheck(context)).toEqual([]);
  });

  test('an allow entry still exempts the package, as it does on the manifest walk', () => {
    const context = makeContext([], {
      pins: PINS,
      config: { allow: ['@acme/*'] },
      lockEntryChanges: [makeLockEntryChange('@acme/widgets', PUBLIC)],
    });
    expect(confusionCheck(context)).toEqual([]);
  });

  test('the same mismatch reached by both walks is reported once', () => {
    const context = makeContext(
      [makeChange({ name: '@acme/widgets', kind: 'changed', after: PUBLIC })],
      {
        pins: PINS,
        lockEntryChanges: [makeLockEntryChange('@acme/widgets', PUBLIC, { manifestPath: 'package.json' })],
      }
    );
    expect(confusionCheck(context)).toHaveLength(1);
  });
});

describe('confusionCheck: rule 2, internal-looking name added publicly', () => {
  test('an added registry dependency matching an internal scope is high', () => {
    const changes = [makeChange({ name: '@acme/widgets', kind: 'added', protocol: 'registry' })];
    const context = makeContext(changes, { config: { internalScopes: ['@acme'] } });
    const findings = confusionCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('dependency-confusion');
    expect(findings[0].severity).toBe('high');
    expect(findings[0].details?.signal).toBe('internal-name');
  });

  test('an added registry dependency matching an internal prefix is high', () => {
    const changes = [makeChange({ name: 'acme-widgets', kind: 'added', protocol: 'registry' })];
    const context = makeContext(changes, { config: { internalPrefixes: ['acme-'] } });
    expect(confusionCheck(context)).toHaveLength(1);
  });

  test('a changed dependency (not added) at protocol registry matching an internal scope is not reported by rule 2', () => {
    const changes = [makeChange({ name: '@acme/widgets', kind: 'changed', protocol: 'registry' })];
    const context = makeContext(changes, { config: { internalScopes: ['@acme'] } });
    expect(confusionCheck(context)).toEqual([]);
  });

  // If rule 2 were invisible to npm: aliases entirely, "ui-kit":
  // "npm:@acme/internal-ui@1.0.0" with internalScopes ['@acme'] would
  // produce zero findings from every check -- existence deliberately
  // skips internal names because confusion owns them, so confusion
  // missing the alias target would leave nothing to catch it. Rule 2
  // admits an alias-protocol dependency at any kind instead, the same
  // shape candidates.ts's existence/typosquat admission already uses,
  // since an alias's installed target is never the manifest key and a
  // changed alias's target has never been judged before.
  test('an added alias dependency matching an internal scope IS reported by rule 2', () => {
    const changes = [
      makeChange({ name: 'ui-kit', registryName: '@acme/internal-ui', kind: 'added', protocol: 'alias' }),
    ];
    const context = makeContext(changes, { config: { internalScopes: ['@acme'] } });
    const findings = confusionCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].packageName).toBe('@acme/internal-ui');
    expect(findings[0].details?.signal).toBe('internal-name');
  });

  test('a changed alias dependency matching an internal scope is also reported by rule 2', () => {
    const changes = [
      makeChange({ name: 'ui-kit', registryName: '@acme/internal-ui', kind: 'changed', protocol: 'alias' }),
    ];
    const context = makeContext(changes, { config: { internalScopes: ['@acme'] } });
    expect(confusionCheck(context)).toHaveLength(1);
  });

  test('no internal scope or prefix configured leaves the name unreported', () => {
    const changes = [makeChange({ name: '@acme/widgets', kind: 'added', protocol: 'registry' })];
    expect(confusionCheck(makeContext(changes))).toEqual([]);
  });

  test('an allow-listed internal-looking package is silent', () => {
    const changes = [makeChange({ name: '@acme/widgets', kind: 'added', protocol: 'registry' })];
    const context = makeContext(changes, { config: { internalScopes: ['@acme'], allow: ['@acme/*'] } });
    expect(confusionCheck(context)).toEqual([]);
  });
});

// confusionCheck loops over delta.changes directly (unlike
// existence/typosquat, which dedupe candidates up front via
// candidates.ts), so two DepChanges resolving to the same (manifestPath,
// registryName) -- two aliases retargeting one internal package, say --
// would each independently run the same rule and produce findings that
// hash identically (the fingerprint never sees which alias or manifest
// key produced the change). Deduped on (manifestPath, packageName,
// signal), not the pair alone, since rule 1 (pin-mismatch) and rule 2
// (internal-name) legitimately both fire for one dependency and must not
// suppress each other.
describe('confusionCheck: fingerprint-colliding duplicates', () => {
  test('two aliases retargeting the same internal package report rule 2 only once', () => {
    const changes = [
      makeChange({
        name: 'ui-kit',
        registryName: '@acme/internal-ui',
        kind: 'added',
        protocol: 'alias',
        specifier: 'npm:@acme/internal-ui@1.0.0',
      }),
      makeChange({
        name: 'ui-kit-2',
        registryName: '@acme/internal-ui',
        kind: 'added',
        protocol: 'alias',
        specifier: 'npm:@acme/internal-ui@2.0.0',
      }),
    ];
    const context = makeContext(changes, { config: { internalScopes: ['@acme'] } });
    const findings = confusionCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].packageName).toBe('@acme/internal-ui');
    expect(findings[0].details?.signal).toBe('internal-name');
  });

  // The multi-signal property has to survive the dedupe: two DepChanges
  // for the same dependency, each independently tripping BOTH rules,
  // must still yield exactly one pin-mismatch finding and one
  // internal-name finding -- two total, not four and not one.
  test('two aliases each tripping both rules still yield exactly one finding per signal', () => {
    const pins = new Map([['@acme', 'https://npm.acme.example/']]);
    const changes = [
      makeChange({
        name: 'ui-kit',
        registryName: '@acme/internal-ui',
        kind: 'added',
        protocol: 'alias',
        specifier: 'npm:@acme/internal-ui@1.0.0',
        after: {
          version: '1.0.0',
          resolvedUrl: 'https://registry.npmjs.org/@acme/internal-ui/-/internal-ui-1.0.0.tgz',
        },
      }),
      makeChange({
        name: 'ui-kit-2',
        registryName: '@acme/internal-ui',
        kind: 'added',
        protocol: 'alias',
        specifier: 'npm:@acme/internal-ui@2.0.0',
        after: {
          version: '2.0.0',
          resolvedUrl: 'https://registry.npmjs.org/@acme/internal-ui/-/internal-ui-2.0.0.tgz',
        },
      }),
    ];
    const context = makeContext(changes, { pins, config: { internalScopes: ['@acme'] } });
    const findings = confusionCheck(context);
    expect(findings).toHaveLength(2);
    const signals = findings.map((finding) => finding.details?.signal).sort();
    expect(signals).toEqual(['internal-name', 'pin-mismatch:registry.npmjs.org']);
  });
});

describe('confusionCheck: multi-signal', () => {
  // A single dependency can trip both rule 1 and rule 2 at once, and each
  // needs its own stable details.signal so the fingerprint (sha256 over
  // ruleId, packageName, manifestPath) does not collide the two findings
  // into one baseline-suppressible fingerprint.
  test('a dependency tripping both rules gets two findings with distinct signals', () => {
    const pins = new Map([['@acme', 'https://npm.acme.example/']]);
    const changes = [
      makeChange({
        name: '@acme/widgets',
        kind: 'added',
        protocol: 'registry',
        after: { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/@acme/widgets/-/widgets-1.0.0.tgz' },
      }),
    ];
    const context = makeContext(changes, { pins, config: { internalScopes: ['@acme'] } });
    const findings = confusionCheck(context);
    expect(findings).toHaveLength(2);
    const signals = findings.map((finding) => finding.details?.signal).sort();
    expect(signals).toEqual(['internal-name', 'pin-mismatch:registry.npmjs.org']);
  });
});
