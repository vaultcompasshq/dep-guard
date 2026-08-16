import { installScriptCheck } from '../src/checks/install-script.js';
import type { CheckContext, ResolvedConfig } from '../src/checks/types.js';
import type { Corpus } from '../src/corpus.js';
import type { DepChange, DependencyDelta, LockEntryChange } from '../src/delta.js';
import type { LockEntry, LockfileFormat } from '../src/lockfiles/types.js';
import type { Diagnostic } from '../src/types.js';

// None of the four remaining checks read the corpus, so a stub satisfies
// the CheckContext shape without loading the real fixture.
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
  before: LockEntry | undefined,
  after: LockEntry,
  overrides: Partial<LockEntryChange> = {}
): LockEntryChange {
  return {
    name,
    packageName: name,
    kind: before === undefined ? 'added' : 'changed',
    manifestPath: 'package.json',
    lockfilePath: 'package-lock.json',
    before,
    after,
    ...overrides,
  };
}

interface ContextOptions {
  config?: Partial<ResolvedConfig>;
  onlyBuiltAdded?: string[];
  lockfileFormat?: LockfileFormat;
  diagnostics?: Diagnostic[];
  lockEntryChanges?: LockEntryChange[];
  hasComparisonBase?: boolean;
}

function makeContext(changes: DepChange[], options: ContextOptions = {}): CheckContext {
  const delta: DependencyDelta = {
    changes,
    lockEntryChanges: options.lockEntryChanges ?? [],
    onlyBuiltAdded: options.onlyBuiltAdded ?? [],
    lockfileFormat: options.lockfileFormat ?? 'npm',
    lockfilePath: 'package-lock.json',
    hasComparisonBase: options.hasComparisonBase ?? true,
    workspaceLocalNames: new Set(),
    diagnostics: options.diagnostics ?? [],
  };
  return {
    corpus: STUB_CORPUS,
    config: { ...BASE_CONFIG, ...options.config },
    delta,
    npmrcRegistryPins: new Map<string, string>(),
    diagnostics: [] as Diagnostic[],
  };
}

const PNPM_DIAGNOSTIC: Diagnostic = {
  code: 'pnpm-no-install-script-flag',
  message: 'pnpm-lock.yaml: pnpm lockfiles do not record install-script metadata; the install-script check is skipped for this lockfile',
};

describe('installScriptCheck (npm format)', () => {
  test('an added dependency whose after entry runs an install script is flagged', () => {
    const changes = [makeChange({ name: 'sharp', kind: 'added', after: { version: '1.0.0', hasInstallScript: true } })];
    const findings = installScriptCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('install-script');
    expect(findings[0].severity).toBe('high');
    expect(findings[0].packageName).toBe('sharp');
    expect(findings[0].details?.signal).toBe('added');
  });

  test('an added dependency without an install script is silent', () => {
    const changes = [makeChange({ name: 'left-pad', kind: 'added', after: { version: '1.0.0' } })];
    expect(installScriptCheck(makeContext(changes))).toEqual([]);
  });

  // Flag acquisition: the before entry lacked the flag, the after entry has
  // it. This is the shape a hand-edited lockfile takes when it turns
  // scripts on without moving the manifest specifier at all.
  test('a changed dependency that newly acquires an install script is flagged', () => {
    const changes = [
      makeChange({
        name: 'sharp',
        kind: 'changed',
        before: { version: '1.0.0' },
        after: { version: '1.0.1', hasInstallScript: true },
      }),
    ];
    const findings = installScriptCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].packageName).toBe('sharp');
    expect(findings[0].details?.signal).toBe('flag-acquired');
  });

  // The critical no-fire case: a routine version bump of a package that
  // already ran install scripts must not refile on every lockfile refresh.
  test('a routine version bump of an already-scripted package does not fire', () => {
    const changes = [
      makeChange({
        name: 'sharp',
        kind: 'changed',
        before: { version: '1.0.0', hasInstallScript: true },
        after: { version: '1.0.1', hasInstallScript: true },
      }),
    ];
    expect(installScriptCheck(makeContext(changes))).toEqual([]);
  });

  // A dep newly declared direct fires even if it already existed
  // transitively (and so already carries a populated `before`) -- presence
  // of `before` on an added dep is not proof the flag was already known.
  test('an added dependency with a populated before entry still fires', () => {
    const changes = [
      makeChange({
        name: 'sharp',
        kind: 'added',
        before: { version: '1.0.0', hasInstallScript: true },
        after: { version: '1.0.0', hasInstallScript: true },
      }),
    ];
    const findings = installScriptCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.signal).toBe('added');
  });

  test('a flag turning off between before and after is not reported', () => {
    const changes = [
      makeChange({
        name: 'sharp',
        kind: 'changed',
        before: { version: '1.0.0', hasInstallScript: true },
        after: { version: '1.0.1' },
      }),
    ];
    expect(installScriptCheck(makeContext(changes))).toEqual([]);
  });

  test('an allow-listed package does not fire even on acquisition', () => {
    const changes = [makeChange({ name: 'sharp', kind: 'added', after: { version: '1.0.0', hasInstallScript: true } })];
    const context = makeContext(changes, { config: { allow: ['sharp'] } });
    expect(installScriptCheck(context)).toEqual([]);
  });

  // git dependencies are not exempt from the delta, and npm records
  // hasInstallScript for them same as any other resolved entry, so
  // echoing the raw git+https specifier (credentials and all) into
  // details.specifier would leak a token into a finding -- the same class
  // of bug tamper.ts guards against for its own specifiers.
  test('a credential-bearing git specifier leaks no token anywhere in the finding', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'added',
        protocol: 'git',
        specifier: 'git+https://x-access-token:ghp_SECRETTOKEN@github.com/evil/lodash.git',
        after: { version: '1.0.0', hasInstallScript: true },
      }),
    ];
    const findings = installScriptCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    // JSON.stringify walks every own enumerable property of the whole
    // finding recursively, so this catches a leak through any field --
    // not just the ones (message, details.specifier) already known to be
    // suspect.
    const serialized = JSON.stringify(findings[0]);
    expect(serialized).not.toContain('ghp_SECRETTOKEN');
    expect(serialized).not.toContain('x-access-token');
  });
});

// Same fingerprint-collision hazard candidates.ts already guards
// against for existence/typosquat -- two DepChanges that resolve to the
// same (manifestPath, registryName) produce findings that hash identically
// (the fingerprint never looks at depType or which alias key produced the
// change), so without a dedupe here baselining one silently suppresses
// the rest.
describe('installScriptCheck (npm format): fingerprint-colliding duplicates (C1)', () => {
  test('two aliases retargeting the same package that both acquire install scripts report only once', () => {
    const changes = [
      makeChange({
        name: 'a',
        registryName: 'evil',
        protocol: 'alias',
        specifier: 'npm:evil@1.0.0',
        kind: 'added',
        after: { version: '1.0.0', hasInstallScript: true },
      }),
      makeChange({
        name: 'b',
        registryName: 'evil',
        protocol: 'alias',
        specifier: 'npm:evil@1.0.0',
        kind: 'added',
        after: { version: '1.0.0', hasInstallScript: true },
      }),
    ];
    const findings = installScriptCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].packageName).toBe('evil');
  });

  test('the same registry name added to dependencies and devDependencies with an install script reports only once', () => {
    const changes = [
      makeChange({
        name: 'sharp',
        depType: 'dependencies',
        kind: 'added',
        after: { version: '1.0.0', hasInstallScript: true },
      }),
      makeChange({
        name: 'sharp',
        depType: 'devDependencies',
        kind: 'added',
        after: { version: '1.0.0', hasInstallScript: true },
      }),
    ];
    const findings = installScriptCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
  });
});

// With no earlier revision behind the scan, every entry reads as added and
// every install-script flag reads as newly acquired -- true of the scan,
// false of the repository. Sweeping an adopted repo would file hundreds of
// blocking highs claiming a change that did not happen. The fact is worth
// reporting (knowing which dependencies run install scripts is most of why
// someone audits), so it is reported as a fact, at a severity that sits
// under the default gate.
describe('installScriptCheck: a scan with no comparison base', () => {
  const AUDIT = { hasComparisonBase: false };

  test('a flagged dependency is reported as present, at low, without claiming a change', () => {
    const changes = [makeChange({ name: 'sharp', kind: 'added', after: { version: '1.0.0', hasInstallScript: true } })];
    const findings = installScriptCheck(makeContext(changes, AUDIT));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('low');
    expect(findings[0].details?.signal).toBe('present');
    expect(findings[0].message).not.toContain('did not run before');
  });

  test('a flagged lockfile entry no manifest declares is reported the same way', () => {
    const context = makeContext([], {
      ...AUDIT,
      lockEntryChanges: [makeLockEntryChange('esbuild', undefined, { version: '1.0.0', hasInstallScript: true })],
    });
    const findings = installScriptCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('low');
    expect(findings[0].details?.signal).toBe('present');
  });

  test('an unflagged dependency is still silent', () => {
    const changes = [makeChange({ name: 'left-pad', kind: 'added', after: { version: '1.0.0' } })];
    expect(installScriptCheck(makeContext(changes, AUDIT))).toEqual([]);
  });

  test('an allow-listed package is still exempt', () => {
    const changes = [makeChange({ name: 'sharp', kind: 'added', after: { version: '1.0.0', hasInstallScript: true } })];
    expect(installScriptCheck(makeContext(changes, { ...AUDIT, config: { allow: ['sharp'] } }))).toEqual([]);
  });

  // The other half of the decision: nothing about the delta modes moves.
  test('a delta mode keeps the acquisition severity and signals unchanged', () => {
    const added = [makeChange({ name: 'sharp', kind: 'added', after: { version: '1.0.0', hasInstallScript: true } })];
    const acquired = [
      makeChange({
        name: 'sharp',
        kind: 'changed',
        before: { version: '1.0.0' },
        after: { version: '1.0.1', hasInstallScript: true },
      }),
    ];
    const addedFinding = installScriptCheck(makeContext(added))[0];
    const acquiredFinding = installScriptCheck(makeContext(acquired))[0];

    expect(addedFinding.severity).toBe('high');
    expect(addedFinding.details?.signal).toBe('added');
    expect(addedFinding.message).toContain('did not run before');
    expect(acquiredFinding.severity).toBe('high');
    expect(acquiredFinding.details?.signal).toBe('flag-acquired');
  });
});

describe('installScriptCheck (pnpm format)', () => {
  test('a name newly added to onlyBuiltDependencies is flagged', () => {
    const context = makeContext([], { lockfileFormat: 'pnpm', onlyBuiltAdded: ['esbuild'] });
    const findings = installScriptCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('install-script');
    expect(findings[0].severity).toBe('high');
    expect(findings[0].packageName).toBe('esbuild');
    expect(findings[0].details?.signal).toBe('only-built-added');
  });

  // onlyBuiltDependencies is a workspace-wide setting (pnpm-workspace.yaml
  // merged with every manifest's own pnpm field), not any one
  // package.json, and a repo can configure it entirely from
  // the root package.json with no pnpm-workspace.yaml on disk at all --
  // naming that file as manifestPath could point at a file that does not
  // exist. The root manifest is attributed instead; which file the
  // setting actually lives in still shows up, in details.source.
  test('an onlyBuiltAdded finding is attributed to the root manifest, with the source noted in details', () => {
    const context = makeContext([], { lockfileFormat: 'pnpm', onlyBuiltAdded: ['esbuild'] });
    const findings = installScriptCheck(context);
    expect(findings[0].manifestPath).toBe('package.json');
    expect(findings[0].details?.source).toBe('pnpm-workspace.yaml');
  });

  // Same false sentence the npm path had, in the sibling code path: with no
  // before state nothing was "newly" added to the allowlist, the whole
  // allowlist simply exists. The list is short enough that it could not
  // wreck a sweep, but a gate that says something untrue about a short list
  // is still saying something untrue.
  test('with no comparison base the allowlist is reported as present, at low', () => {
    const context = makeContext([], {
      lockfileFormat: 'pnpm',
      onlyBuiltAdded: ['esbuild'],
      hasComparisonBase: false,
    });
    const findings = installScriptCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('low');
    expect(findings[0].details?.signal).toBe('present');
    expect(findings[0].message).not.toContain('newly');
    expect(findings[0].details?.source).toBe('pnpm-workspace.yaml');
  });

  test('a delta mode keeps the only-built-added signal and its high severity', () => {
    const context = makeContext([], { lockfileFormat: 'pnpm', onlyBuiltAdded: ['esbuild'] });
    const findings = installScriptCheck(context);
    expect(findings[0].severity).toBe('high');
    expect(findings[0].details?.signal).toBe('only-built-added');
    expect(findings[0].message).toContain('newly added');
  });

  test('no onlyBuiltAdded names produces no findings', () => {
    const context = makeContext([], { lockfileFormat: 'pnpm', onlyBuiltAdded: [] });
    expect(installScriptCheck(context)).toEqual([]);
  });

  test('an allow-listed onlyBuiltAdded name does not fire', () => {
    const context = makeContext([], {
      lockfileFormat: 'pnpm',
      onlyBuiltAdded: ['esbuild'],
      config: { allow: ['esbuild'] },
    });
    expect(installScriptCheck(context)).toEqual([]);
  });

  test('per-entry hasInstallScript is never trusted for pnpm even if present', () => {
    // pnpm v9 never sets this field, but the check must not rely on it for
    // this format even if a parser bug somehow set it, since the standing
    // diagnostic already says this format cannot give that coverage.
    const changes = [makeChange({ name: 'sharp', kind: 'added', after: { version: '1.0.0', hasInstallScript: true } })];
    const context = makeContext(changes, { lockfileFormat: 'pnpm' });
    expect(installScriptCheck(context)).toEqual([]);
  });

  test('the standing pnpm-no-install-script-flag diagnostic is passed through when the delta touched dependencies', () => {
    const changes = [makeChange({ name: 'left-pad', kind: 'added', after: { version: '1.0.0' } })];
    const context = makeContext(changes, {
      lockfileFormat: 'pnpm',
      diagnostics: [PNPM_DIAGNOSTIC],
    });
    installScriptCheck(context);
    expect(context.diagnostics).toHaveLength(1);
    expect(context.diagnostics[0].code).toBe('pnpm-no-install-script-flag');
  });

  test('the diagnostic is not duplicated if already present in the sink', () => {
    const changes = [makeChange({ name: 'left-pad', kind: 'added', after: { version: '1.0.0' } })];
    const context = makeContext(changes, {
      lockfileFormat: 'pnpm',
      diagnostics: [PNPM_DIAGNOSTIC],
    });
    context.diagnostics.push(PNPM_DIAGNOSTIC);
    installScriptCheck(context);
    expect(context.diagnostics).toHaveLength(1);
  });

  test('nothing is passed through when the delta is empty', () => {
    const context = makeContext([], {
      lockfileFormat: 'pnpm',
      diagnostics: [PNPM_DIAGNOSTIC],
    });
    installScriptCheck(context);
    expect(context.diagnostics).toEqual([]);
  });
});

describe('installScriptCheck (yarn/bun/none formats)', () => {
  test.each(['yarn', 'bun', 'none'] as const)('produces nothing for %s format', (lockfileFormat) => {
    const changes = [makeChange({ name: 'sharp', kind: 'added', after: { version: '1.0.0', hasInstallScript: true } })];
    const context = makeContext(changes, { lockfileFormat, onlyBuiltAdded: ['esbuild'] });
    expect(installScriptCheck(context)).toEqual([]);
  });
});

// A hand-edited lockfile can set hasInstallScript on any entry, and
// almost every entry in a real lockfile is transitive. Reading only the
// entries a manifest declares meant the flag could be switched on anywhere
// else in the tree in complete silence.
describe('installScriptCheck: lockfile entries no manifest declares', () => {
  test('an entry that acquires the flag is flagged', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange('ansi-regex', { version: '5.0.1' }, { version: '5.0.1', hasInstallScript: true }),
      ],
    });
    const findings = installScriptCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].packageName).toBe('ansi-regex');
    expect(findings[0].details?.signal).toBe('flag-acquired');
    expect(findings[0].lockfilePath).toBe('package-lock.json');
  });

  test('a newly added entry that runs an install script is flagged', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange('ansi-regex', undefined, { version: '5.0.1', hasInstallScript: true }),
      ],
    });
    expect(installScriptCheck(context)).toHaveLength(1);
  });

  test('a version bump of an entry that already ran scripts stays silent', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'esbuild',
          { version: '1.0.0', hasInstallScript: true },
          { version: '1.1.0', hasInstallScript: true }
        ),
      ],
    });
    expect(installScriptCheck(context)).toEqual([]);
  });

  test('an allow-listed package is still exempt: this is a fact about the package', () => {
    const context = makeContext([], {
      config: { allow: ['esbuild'] },
      lockEntryChanges: [
        makeLockEntryChange('esbuild', { version: '1.0.0' }, { version: '1.0.0', hasInstallScript: true }),
      ],
    });
    expect(installScriptCheck(context)).toEqual([]);
  });

  // Acquisition is a comparison, and the delta could not say which
  // earlier entry this one succeeds -- but when NONE of the
  // candidates ran an install script, "it did not run one before" is true
  // whichever of them this entry succeeds. Only a candidate that already
  // carried the flag makes the answer depend on the guess.
  test('an ambiguous pairing where no candidate ran scripts is still an acquisition', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'esbuild',
          { version: '0.20.0' },
          { version: '0.21.1', hasInstallScript: true },
          {
            counterpartAmbiguous: true,
            beforeCandidates: [{ version: '0.20.0' }, { version: '0.19.0' }],
          }
        ),
      ],
    });
    const findings = installScriptCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.signal).toBe('flag-acquired');
  });

  test('an ambiguous pairing where one candidate already ran scripts is not judged', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'esbuild',
          { version: '0.20.0' },
          { version: '0.21.1', hasInstallScript: true },
          {
            counterpartAmbiguous: true,
            beforeCandidates: [{ version: '0.20.0' }, { version: '0.19.0', hasInstallScript: true }],
          }
        ),
      ],
    });
    expect(installScriptCheck(context)).toEqual([]);
  });

  // Same rule as tamper's: a verdict dropped because the candidates
  // disagreed about it is coverage this scan did not give, and the code that
  // drops it is the only code that can know it dropped it.
  test('a suppressed acquisition says so rather than exiting quiet', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'esbuild',
          { version: '0.20.0' },
          { version: '0.21.1', hasInstallScript: true },
          {
            counterpartAmbiguous: true,
            beforeCandidates: [{ version: '0.20.0' }, { version: '0.19.0', hasInstallScript: true }],
          }
        ),
      ],
    });
    // A dropped acquisition is a high, not a critical, so it stays
    // diagnostic-only: the escalation to a blocking finding is reserved for
    // a drop that contained a critical, which is the rare and serious case.
    expect(installScriptCheck(context)).toEqual([]);
    const notes = context.diagnostics.filter((entry) => entry.code === 'delta-ambiguous-lock-entry');
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toContain('esbuild');
    expect(notes[0].message).toContain('2');
  });

  // The cell the announcement got wrong when it was written by hand: when
  // EVERY candidate already ran scripts, all of them reach the same verdict
  // (no acquisition), nothing was dropped for disagreeing, and there is
  // nothing to admit to. Announcing here says "this scan cannot say whether
  // running one is new", which is false -- it can, and the answer is no.
  // It is also the routine shape: a bump of a scripted package beside a
  // flagged nested duplicate of it, on every refresh.
  test('candidates that all already ran scripts are a decided no, not an ambiguity', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'esbuild',
          { version: '0.20.0', hasInstallScript: true },
          { version: '0.21.1', hasInstallScript: true },
          {
            counterpartAmbiguous: true,
            beforeCandidates: [
              { version: '0.20.0', hasInstallScript: true },
              { version: '0.19.0', hasInstallScript: true },
            ],
          }
        ),
      ],
    });
    expect(installScriptCheck(context)).toEqual([]);
    expect(context.diagnostics).toEqual([]);
  });

  test('an acquisition every candidate agrees on announces nothing', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'esbuild',
          { version: '0.20.0' },
          { version: '0.21.1', hasInstallScript: true },
          {
            counterpartAmbiguous: true,
            beforeCandidates: [{ version: '0.20.0' }, { version: '0.19.0' }],
          }
        ),
      ],
    });
    installScriptCheck(context);
    expect(context.diagnostics).toEqual([]);
  });

  test('the same package reached both ways is reported once', () => {
    const after = { version: '1.0.0', hasInstallScript: true };
    const context = makeContext([makeChange({ name: 'sharp', kind: 'added', after })], {
      lockEntryChanges: [makeLockEntryChange('sharp', undefined, after)],
    });
    expect(installScriptCheck(context)).toHaveLength(1);
  });
});
