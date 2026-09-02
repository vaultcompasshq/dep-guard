import { resolveUnknownPackages } from '../src/online/unknown-package.js';
import { createOnlineDeadline } from '../src/online/deadline.js';
import { fingerprintFinding } from '../src/fingerprint.js';
import type { CheckContext, ResolvedConfig } from '../src/checks/types.js';
import type { Corpus } from '../src/corpus.js';
import type { Diagnostic, Finding } from '../src/types.js';

// The unknown-package rule is dep-guard's flagship blocking check and the
// one that decays fastest: every package published after a release's
// corpus walk reads as unknown to that release forever. These tests pin
// the four outcomes of asking the live registry about such a name, and
// they pin the two things that must NOT change with any of them -- the
// fingerprint, and what the network is allowed to take away.

const STUB_CORPUS: Corpus = {
  hasName: () => false,
  topRank: () => null,
  aliasTargets: () => [],
  topNames: [],
  builtAt: '2026-01-01',
};

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    failOn: 'medium',
    allow: [],
    internalScopes: [],
    internalPrefixes: [],
    extraAliases: {},
    ignorePaths: [],
    online: true,
    ...overrides,
  };
}

function makeContext(config: ResolvedConfig = makeConfig()): CheckContext {
  return {
    corpus: STUB_CORPUS,
    config,
    delta: {
      changes: [],
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

// Exactly the shape existence.ts pushes, so these tests cannot drift into
// asserting against a finding the real check never produces.
function unknownPackageFinding(name: string): Omit<Finding, 'fingerprint'> {
  return {
    ruleId: 'unknown-package',
    severity: 'high',
    packageName: name,
    message: `"${name}" is not in the known-package corpus built 2026-01-01. It may be hallucinated, or published after that date.`,
    manifestPath: 'package.json',
    details: {
      specifier: '^1.0.0',
      depType: 'dependencies',
      protocol: 'registry',
      corpusBuiltAt: '2026-01-01',
    },
  };
}

function typosquatFinding(name: string): Omit<Finding, 'fingerprint'> {
  return {
    ruleId: 'typosquat',
    severity: 'low',
    packageName: name,
    message: `"${name}" closely resembles "react".`,
    manifestPath: 'package.json',
    details: { signal: 'resembles', target: 'react' },
  };
}

const freshDeadline = () => createOnlineDeadline(10_000, () => 0);

// The facts resolveUnknownPackages asks registry-client for. A real,
// installable package: a genuine latest version, no tombstone, not a
// security holder.
const REAL_PACKAGE = { latestVersion: '1.2.3', unpublished: false, securityHolder: false };
const TOMBSTONE = { latestVersion: null, unpublished: true, securityHolder: false };
const SECURITY_HOLDER = {
  latestVersion: '0.0.1-security',
  unpublished: false,
  securityHolder: true,
};

describe('resolveUnknownPackages', () => {
  test('a packument that exists stands the finding down', async () => {
    const diagnostics: Diagnostic[] = [];
    const findings = [unknownPackageFinding('published-last-tuesday')];

    const result = await resolveUnknownPackages(
      findings,
      makeContext(),
      { fetchPackument: async () => REAL_PACKAGE },
      diagnostics,
      freshDeadline()
    );

    expect(result.some((f) => f.ruleId === 'unknown-package')).toBe(false);
    expect(diagnostics).toHaveLength(0);
  });

  test('standing an unknown-package finding down leaves every other rule alone', async () => {
    // The whole point of standing down rather than suppressing: the name
    // existing on npm says nothing about whether it is a squat. A
    // typosquat finding for the SAME package name must survive intact.
    const findings = [
      unknownPackageFinding('raect'),
      typosquatFinding('raect'),
    ];

    const result = await resolveUnknownPackages(
      findings,
      makeContext(),
      { fetchPackument: async () => REAL_PACKAGE },
      [],
      freshDeadline()
    );

    expect(result.some((f) => f.ruleId === 'unknown-package')).toBe(false);
    const typosquat = result.find((f) => f.ruleId === 'typosquat');
    expect(typosquat).toBeDefined();
    expect(typosquat?.severity).toBe('low');
  });

  test('a 404 escalates the finding to critical and says the registry confirmed it', async () => {
    const findings = [unknownPackageFinding('totally-hallucinated-xyz')];

    const result = await resolveUnknownPackages(
      findings,
      makeContext(),
      { fetchPackument: async () => null },
      [],
      freshDeadline()
    );

    const escalated = result.find((f) => f.ruleId === 'unknown-package');
    expect(escalated?.severity).toBe('critical');
    expect(escalated?.message).toContain('does not exist');
    // The message has to be strictly stronger than the corpus-absence
    // one: it must no longer offer "published after that date" as an
    // innocent explanation, because the registry just ruled that out.
    expect(escalated?.message).not.toContain('published after that date');
    expect(escalated?.details).toMatchObject({ onlineResolution: 'registry-absent' });
  });

  test('escalating to critical does not change the finding fingerprint', async () => {
    // Severity is excluded from the fingerprint on purpose
    // (docs/INVARIANTS.md). An escalation that minted a new identity
    // would silently invalidate every stored baseline the moment a user
    // turned --online on.
    const before = unknownPackageFinding('totally-hallucinated-xyz');
    const beforeFingerprint = fingerprintFinding(before);

    const result = await resolveUnknownPackages(
      [before],
      makeContext(),
      { fetchPackument: async () => null },
      [],
      freshDeadline()
    );

    const after = result.find((f) => f.ruleId === 'unknown-package');
    expect(after).toBeDefined();
    expect(fingerprintFinding(after as Omit<Finding, 'fingerprint'>)).toBe(beforeFingerprint);
  });

  test('a network failure leaves the finding exactly as the offline check made it', async () => {
    const diagnostics: Diagnostic[] = [];
    const findings = [unknownPackageFinding('maybe-real-maybe-not')];

    const result = await resolveUnknownPackages(
      findings,
      makeContext(),
      {
        fetchPackument: async () => {
          throw new Error('socket hang up');
        },
      },
      diagnostics,
      freshDeadline()
    );

    const finding = result.find((f) => f.ruleId === 'unknown-package');
    expect(finding?.severity).toBe('high');
    expect(finding?.message).toContain('not in the known-package corpus');
    expect(finding?.details).toMatchObject({ onlineResolution: 'unreachable' });
    expect(String((finding?.details as Record<string, unknown>).onlineResolutionReason)).toContain(
      'socket hang up'
    );
    expect(diagnostics.some((d) => d.code === 'online-check-unreachable')).toBe(true);
  });

  test('a spent per-run deadline skips the lookup and records why', async () => {
    const diagnostics: Diagnostic[] = [];
    let called = 0;
    const findings = [unknownPackageFinding('never-asked-about')];

    const result = await resolveUnknownPackages(
      findings,
      makeContext(),
      {
        fetchPackument: async () => {
          called += 1;
          return null;
        },
      },
      diagnostics,
      createOnlineDeadline(0, () => 0)
    );

    expect(called).toBe(0);
    const finding = result.find((f) => f.ruleId === 'unknown-package');
    expect(finding?.severity).toBe('high');
    expect(finding?.details).toMatchObject({ onlineResolution: 'deadline-exceeded' });
    expect(diagnostics.some((d) => d.code === 'online-deadline-exceeded')).toBe(true);
  });

  test('the deadline is re-checked between names, so a budget spent mid-run leaves the rest unchanged', async () => {
    // One lookup succeeds and the clock runs out while it is in flight.
    // The remaining names must not be asked about at all.
    let now = 0;
    const asked: string[] = [];
    const findings = [
      unknownPackageFinding('first-name'),
      unknownPackageFinding('second-name'),
      unknownPackageFinding('third-name'),
    ];

    const result = await resolveUnknownPackages(
      findings,
      makeContext(),
      {
        fetchPackument: async (name: string) => {
          asked.push(name);
          now = 10_000;
          return null;
        },
      },
      [],
      createOnlineDeadline(5_000, () => now)
    );

    expect(asked).toEqual(['first-name']);
    expect(result.find((f) => f.packageName === 'first-name')?.severity).toBe('critical');
    expect(result.find((f) => f.packageName === 'second-name')?.severity).toBe('high');
    expect(result.find((f) => f.packageName === 'third-name')?.severity).toBe('high');
  });

  test('a name in a configured internal scope is never sent to the registry', async () => {
    const asked: string[] = [];
    const findings = [unknownPackageFinding('@acme/private-thing')];

    const result = await resolveUnknownPackages(
      findings,
      makeContext(makeConfig({ internalScopes: ['@acme'] })),
      {
        fetchPackument: async (name: string) => {
          asked.push(name);
          return null;
        },
      },
      [],
      freshDeadline()
    );

    expect(asked).toEqual([]);
    const finding = result.find((f) => f.ruleId === 'unknown-package');
    expect(finding?.severity).toBe('high');
    expect(finding?.details).not.toHaveProperty('onlineResolution');
  });

  test('an internal prefix is honoured the same way a scope is', async () => {
    const asked: string[] = [];
    const result = await resolveUnknownPackages(
      [unknownPackageFinding('acme-internal-thing')],
      makeContext(makeConfig({ internalPrefixes: ['acme-'] })),
      {
        fetchPackument: async (name: string) => {
          asked.push(name);
          return null;
        },
      },
      [],
      freshDeadline()
    );

    expect(asked).toEqual([]);
    expect(result.find((f) => f.ruleId === 'unknown-package')?.severity).toBe('high');
  });

  // A 200 is not the same as "this package exists and can be installed".
  // npm keeps answering 200 for a name whose every version has been
  // unpublished, and for a name it has taken over for security reasons.
  // Both are names an attacker can plausibly be pointing at, and treating
  // either as registry-present would clear the finding for exactly the
  // case the finding is for.
  test('a fully unpublished name leaves the finding unchanged, marked as a tombstone', async () => {
    const findings = [unknownPackageFinding('gone-pkg')];

    const result = await resolveUnknownPackages(
      findings,
      makeContext(),
      { fetchPackument: async () => TOMBSTONE },
      [],
      freshDeadline()
    );

    const finding = result.find((f) => f.ruleId === 'unknown-package');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('high');
    expect(finding?.message).toContain('not in the known-package corpus');
    expect(finding?.details).toMatchObject({ onlineResolution: 'tombstone' });
  });

  test('an npm security-holding placeholder leaves the finding unchanged', async () => {
    const findings = [unknownPackageFinding('held-pkg')];

    const result = await resolveUnknownPackages(
      findings,
      makeContext(),
      { fetchPackument: async () => SECURITY_HOLDER },
      [],
      freshDeadline()
    );

    const finding = result.find((f) => f.ruleId === 'unknown-package');
    expect(finding?.severity).toBe('high');
    expect(finding?.details).toMatchObject({ onlineResolution: 'security-holder' });
  });

  test('a 200 with no latest version at all is not treated as present', async () => {
    // Neither an explicit tombstone nor a holder, just a body with
    // nothing installable in it. Fail closed: the question was "does this
    // package exist", and a body with no version does not answer yes.
    const result = await resolveUnknownPackages(
      [unknownPackageFinding('empty-pkg')],
      makeContext(),
      {
        fetchPackument: async () => ({
          latestVersion: null,
          unpublished: false,
          securityHolder: false,
        }),
      },
      [],
      freshDeadline()
    );

    const finding = result.find((f) => f.ruleId === 'unknown-package');
    expect(finding?.severity).toBe('high');
    expect(finding?.details).toMatchObject({ onlineResolution: 'no-usable-version' });
  });

  test('nothing is fetched when there are no unknown-package findings', async () => {
    let called = 0;
    const findings = [typosquatFinding('raect')];

    const result = await resolveUnknownPackages(
      findings,
      makeContext(),
      {
        fetchPackument: async () => {
          called += 1;
          return null;
        },
      },
      [],
      freshDeadline()
    );

    expect(called).toBe(0);
    expect(result).toHaveLength(1);
  });

  test('one lookup per distinct package name, however many findings mention it', async () => {
    // The same hallucinated name declared in two manifests is two
    // findings and one question for the registry. Asking twice would
    // double the latency of the exact scan shape (a monorepo-wide sweep)
    // this deadline exists to bound.
    const asked: string[] = [];
    const a = unknownPackageFinding('same-name');
    const b = { ...unknownPackageFinding('same-name'), manifestPath: 'packages/app/package.json' };

    const result = await resolveUnknownPackages(
      [a, b],
      makeContext(),
      {
        fetchPackument: async (name: string) => {
          asked.push(name);
          return null;
        },
      },
      [],
      freshDeadline()
    );

    expect(asked).toEqual(['same-name']);
    expect(result.filter((f) => f.severity === 'critical')).toHaveLength(2);
  });

  test('the returned list never grows, and never loses a non-unknown-package finding', async () => {
    // The standing rule for the whole online subsystem: degrading may
    // never remove a finding the offline checks established. This is the
    // one online step that removes findings at all, so it has to be
    // provably surgical about which.
    const findings = [
      unknownPackageFinding('exists-now'),
      typosquatFinding('exists-now'),
      { ...typosquatFinding('other'), ruleId: 'install-script' as const, severity: 'high' as const },
    ];

    const result = await resolveUnknownPackages(
      findings,
      makeContext(),
      { fetchPackument: async () => REAL_PACKAGE },
      [],
      freshDeadline()
    );

    expect(result.map((f) => f.ruleId).sort()).toEqual(['install-script', 'typosquat']);
  });
});
