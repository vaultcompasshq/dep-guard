import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tamperCheck } from '../src/checks/tamper.js';
import { fingerprintFinding } from '../src/fingerprint.js';
import { isBlocking } from '../src/gate.js';
import { parseManifest } from '../src/manifest.js';
import type { CheckContext, ResolvedConfig } from '../src/checks/types.js';
import type { Corpus } from '../src/corpus.js';
import type { DepChange, DependencyDelta, LockEntryChange } from '../src/delta.js';
import type { LockEntry, LockfileFormat } from '../src/lockfiles/types.js';
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
  lockfileFormat?: LockfileFormat;
  lockEntryChanges?: LockEntryChange[];
  lockfilePath?: string;
  hasComparisonBase?: boolean;
}

function makeContext(changes: DepChange[], options: ContextOptions = {}): CheckContext {
  const delta: DependencyDelta = {
    changes,
    lockEntryChanges: options.lockEntryChanges ?? [],
    onlyBuiltAdded: [],
    lockfileFormat: options.lockfileFormat ?? 'npm',
    // Spelled with "in" rather than "??" so a test can ask for a delta with
    // no lockfile path at all, which is what a repository with no lockfile
    // produces.
    lockfilePath: 'lockfilePath' in options ? options.lockfilePath : 'package-lock.json',
    hasComparisonBase: options.hasComparisonBase ?? true,
    workspaceLocalNames: new Set(),
    diagnostics: [],
  };
  return {
    corpus: STUB_CORPUS,
    config: { ...BASE_CONFIG, ...options.config },
    delta,
    npmrcRegistryPins: new Map<string, string>(),
    diagnostics: [] as Diagnostic[],
    allowed: [] as string[],
  };
}

describe('tamperCheck: integrity stripped', () => {
  test('integrity present before and missing after is critical', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', integrity: 'sha512-abc' },
        after: { version: '4.17.21' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('lockfile-tamper');
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].packageName).toBe('lodash');
    expect(findings[0].details?.signal).toBe('integrity-removed');
  });

  test('integrity present on both sides is silent', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', integrity: 'sha512-abc' },
        after: { version: '4.17.22', integrity: 'sha512-def' },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  test('integrity gained (absent before, present after) is silent', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21' },
        after: { version: '4.17.21', integrity: 'sha512-abc' },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  test('a kind added dep with both sides present (existed transitively) is still checked', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'added',
        before: { version: '4.17.21', integrity: 'sha512-abc' },
        after: { version: '4.17.21' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
  });
});

describe('tamperCheck: resolved host repointed', () => {
  test('resolvedUrl host differing from before host is critical', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
        after: { version: '4.17.21', resolvedUrl: 'https://evil.example.test/lodash/-/lodash-4.17.21.tgz' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    // The signal names the origin the bytes now come from, not merely the
    // kind of change, so a baseline entry accepting one destination
    // cannot accept a different one.
    expect(findings[0].details?.signal).toBe('host-changed:https://evil.example.test');
    // The two sides must be distinguishable in the output -- a consumer
    // reading only details has to be able to tell what changed.
    expect(findings[0].details?.beforeOrigin).not.toBe(findings[0].details?.afterOrigin);
  });

  test('resolvedUrl host unchanged is silent', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
        after: { version: '4.17.22', resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.22.tgz' },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  test('an unparseable resolvedUrl does not throw and produces no finding for that rule', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'not a url' },
        after: { version: '4.17.21', resolvedUrl: 'also not a url' },
      }),
    ];
    expect(() => tamperCheck(makeContext(changes))).not.toThrow();
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  // file: URLs have an empty host by construction, and the
  // specifier-message path collapses an empty host to null so the
  // "github:owner/repo" shorthand doesn't print a bogus parenthetical.
  // That same null-collapse, reused for the resolvedUrl comparison, would
  // make ANY pair where either side is a file: URL skip this rule
  // entirely (both sides have to be non-null to compare) -- exactly the
  // registry-to-local-tarball swap this rule exists to catch. The
  // resolvedUrl rule needs its own identity that treats a file:
  // resolution as a distinct, non-null value rather than collapsing it
  // away.
  test('a registry tarball repointed to an absolute file: URL is still critical', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
        after: { version: '4.17.21', resolvedUrl: 'file:///tmp/payload.tgz' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(String(findings[0].details?.signal)).toMatch(/^host-changed:/);
  });

  test('a registry tarball repointed to a relative file: URL is still critical', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
        after: { version: '4.17.21', resolvedUrl: 'file:../vendor/lodash.tgz' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
  });

  test('a file: URL repointed to an evil https host is still critical', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'file:///tmp/payload.tgz' },
        after: { version: '4.17.21', resolvedUrl: 'https://evil.example.test/lodash/-/lodash-4.17.21.tgz' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
  });

  test('two identical file: resolutions are silent (not a swap)', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'file:///tmp/payload.tgz' },
        after: { version: '4.17.22', resolvedUrl: 'file:///tmp/payload.tgz' },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  // A resolution's identity is "where the bytes come from". For a network
  // URL that is the scheme and host; for a hostless one (every file: URL
  // has an empty host) it is the scheme and the path, since the path is
  // the only thing that says which bytes. Comparing scheme+host alone
  // would leave a file-to-file repoint -- vendored tarball swapped for a
  // planted one -- completely silent.
  test('two different file: paths are a repoint, not a path detail', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'file:///tmp/vendor/a.tgz' },
        after: { version: '4.17.21', resolvedUrl: 'file:///tmp/evil/payload.tgz' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    // The signal names the KIND of fact only. The path is what moves
    // under a version bump, so folding it in would mint a fresh
    // fingerprint for every vendored bump -- one the baseline could never
    // absorb. It stays in the details, where nothing hashes it.
    expect(findings[0].details?.signal).toBe('local-source-changed');
    expect(findings[0].details?.afterOrigin).toBe('file:///tmp/evil/payload.tgz');
  });

  // Two vendored-tarball bumps in a row are the same fact about the same
  // dependency, so accepting the first has to accept the second.
  test('two successive vendored-tarball bumps hash to one fingerprint', () => {
    function bump(from: string, to: string, fromHash: string, toHash: string) {
      return tamperCheck(
        makeContext([
          makeChange({
            name: 'lodash',
            kind: 'changed',
            before: { version: '1.0.0', resolvedUrl: from, integrity: fromHash },
            after: { version: '1.1.0', resolvedUrl: to, integrity: toHash },
          }),
        ])
      );
    }
    const first = bump(
      'file:///repo/vendor/lodash-1.0.0.tgz',
      'file:///repo/vendor/lodash-1.1.0.tgz',
      'sha512-a',
      'sha512-b'
    );
    const second = bump(
      'file:///repo/vendor/lodash-1.1.0.tgz',
      'file:///repo/vendor/lodash-1.2.0.tgz',
      'sha512-b',
      'sha512-c'
    );
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(fingerprintFinding(second[0])).toBe(fingerprintFinding(first[0]));
  });

  // Narrowed after the local-source rule fired critical on two shapes that
  // are ordinary repository work: renaming a vendored tarball and moving the
  // vendor directory. An integrity hash that is present and identical on
  // both sides proves the bytes did not change, and a path move over
  // unchanged bytes is a reorg, not an acquisition of a new source.
  //
  // The fixture holds the version still on purpose: bumping the version
  // while keeping one hash across both sides would be a lockfile that
  // cannot exist -- two versions are two sets of bytes and cannot share a
  // digest -- so it would prove nothing about the rule it names. A
  // rename over unchanged bytes IS a version-less event.
  test('a vendored tarball renamed with an identical integrity hash is silent', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'file:///repo/vendor/lodash-4.17.21.tgz', integrity: 'sha512-same' },
        after: { version: '4.17.21', resolvedUrl: 'file:///repo/vendor/lodash.tgz', integrity: 'sha512-same' },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  test('a vendor directory reorg with an identical integrity hash is silent', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'file:///repo/vendor/lodash-4.17.21.tgz', integrity: 'sha512-same' },
        after: { version: '4.17.21', resolvedUrl: 'file:///repo/third_party/lodash-4.17.21.tgz', integrity: 'sha512-same' },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  test('a path change with no integrity hash to vouch for the bytes is still critical', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'file:///repo/vendor/lodash-4.17.21.tgz' },
        after: { version: '4.17.21', resolvedUrl: 'file:///repo/evil/payload.tgz' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.signal).toBe('local-source-changed');
    expect(findings[0].details?.afterOrigin).toBe('file:///repo/evil/payload.tgz');
  });

  test('a path change whose integrity hash also changed is still critical', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'file:///repo/vendor/lodash-4.17.21.tgz', integrity: 'sha512-a' },
        after: { version: '4.17.21', resolvedUrl: 'file:///repo/evil/payload.tgz', integrity: 'sha512-b' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details?.signal).toBe('local-source-changed');
  });

  test('a path change whose integrity hash was removed is still critical, and says both things', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'file:///repo/vendor/lodash-4.17.21.tgz', integrity: 'sha512-a' },
        after: { version: '4.17.21', resolvedUrl: 'file:///repo/evil/payload.tgz' },
      }),
    ];
    const signals = tamperCheck(makeContext(changes)).map((finding) => String(finding.details?.signal));
    expect(signals).toContain('integrity-removed');
    expect(signals).toContain('local-source-changed');
  });
});

// A hash rewritten in place is strictly worse than one deleted: registry
// tarballs are immutable, so the same name at the same version from the
// same URL cannot honestly carry a different hash. Nothing looked for it
// before, which left the quieter half of the spec's tamper rule -- hashes
// "removed or downgraded" -- open.
describe('tamperCheck: integrity forged in place', () => {
  const URL = 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz';

  test('same version and URL with a different integrity hash is critical', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: URL, integrity: 'sha512-real' },
        after: { version: '4.17.21', resolvedUrl: URL, integrity: 'sha512-forged' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details?.signal).toBe('integrity-changed');
  });

  test('an entry with no resolved URL on either side is judged on version alone', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', integrity: 'sha512-real' },
        after: { version: '4.17.21', integrity: 'sha512-forged' },
      }),
    ];
    expect(tamperCheck(makeContext(changes))[0].details?.signal).toBe('integrity-changed');
  });

  test('a legitimate version bump, which moves version URL and hash together, does not fire', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: URL, integrity: 'sha512-a' },
        after: {
          version: '4.17.22',
          resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.22.tgz',
          integrity: 'sha512-b',
        },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  test('a removed hash reports removal only, never both', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: URL, integrity: 'sha512-real' },
        after: { version: '4.17.21', resolvedUrl: URL },
      }),
    ];
    const signals = tamperCheck(makeContext(changes)).map((finding) => String(finding.details?.signal));
    expect(signals).toEqual(['integrity-removed']);
  });

  test('a hash gained where there was none is not a forgery', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: URL },
        after: { version: '4.17.21', resolvedUrl: URL, integrity: 'sha512-real' },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  test('a host repoint that also rewrote the hash reports the repoint, not a forgery', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: URL, integrity: 'sha512-real' },
        after: {
          version: '4.17.21',
          resolvedUrl: 'https://evil.example.test/lodash/-/lodash-4.17.21.tgz',
          integrity: 'sha512-forged',
        },
      }),
    ];
    const signals = tamperCheck(makeContext(changes)).map((finding) => String(finding.details?.signal));
    expect(signals.some((signal) => signal.startsWith('host-changed:'))).toBe(true);
    expect(signals).not.toContain('integrity-changed');
  });

  // The hash is not one opaque string: it names the algorithm that produced
  // it. A lockfile migrated off an older npm rehashes every entry from sha1
  // to sha512 without anything moving, and calling that tampering would
  // file a critical per dependency on a routine migration. The reverse
  // direction is the opposite of benign -- an attacker who cannot forge a
  // sha512 can try to get the lockfile to accept a weaker hash instead --
  // and it is the "removed or downgraded" case the spec names outright.
  test('a rehash to a stronger algorithm is a migration, not a forgery', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: URL, integrity: 'sha1-oldstyle' },
        after: { version: '4.17.21', resolvedUrl: URL, integrity: 'sha512-newstyle' },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  test('sha1 to sha384 is a stronger rehash too', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: URL, integrity: 'sha1-oldstyle' },
        after: { version: '4.17.21', resolvedUrl: URL, integrity: 'sha384-newstyle' },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  test('a rehash to a weaker algorithm is a downgrade, and critical', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: URL, integrity: 'sha512-strong' },
        after: { version: '4.17.21', resolvedUrl: URL, integrity: 'sha1-weak' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details?.signal).toBe('integrity-downgraded');
  });

  test('a same-algorithm digest change is still the forgery signal, not a downgrade', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: URL, integrity: 'sha1-real' },
        after: { version: '4.17.21', resolvedUrl: URL, integrity: 'sha1-forged' },
      }),
    ];
    expect(tamperCheck(makeContext(changes))[0].details?.signal).toBe('integrity-changed');
  });

  test.each([
    ['an unrecognized algorithm after', 'sha512-real', 'weirdhash-value'],
    ['an unrecognized algorithm before', 'weirdhash-value', 'sha512-real'],
    ['no algorithm prefix at all', 'sha512-real', 'bareloosevalue'],
  ])('%s is reported rather than passed: the ladder fails closed', (_label, before, after) => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: URL, integrity: before },
        after: { version: '4.17.21', resolvedUrl: URL, integrity: after },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details?.signal).toBe('integrity-changed');
  });

  test('a transitive entry nothing declares is covered too', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'ansi-regex',
          { version: '5.0.1', resolvedUrl: 'https://registry.npmjs.org/ansi-regex/-/ansi-regex-5.0.1.tgz', integrity: 'sha512-real' },
          { version: '5.0.1', resolvedUrl: 'https://registry.npmjs.org/ansi-regex/-/ansi-regex-5.0.1.tgz', integrity: 'sha512-forged' }
        ),
      ],
    });
    const findings = tamperCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.signal).toBe('integrity-changed');
    expect(findings[0].lockfilePath).toBe('package-lock.json');
  });
});

// The integrity-forged branch requires the resolved URL to be unchanged,
// and the resolution branch treats a path-only difference on a real host
// as a version's tarball moving. Composed, an attacker who repoints a
// resolution to another tarball ON THE SAME HOST and records that
// tarball's genuine hash would trip neither: npm installs the attacker's
// bytes from a host the project already trusts, and the scan would say
// nothing at all. An ordinary bump moves the version too, and is the one
// shape that must stay silent.
describe('tamperCheck: a tarball swapped within one origin', () => {
  const REAL = 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz';
  const PLANTED = 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz';

  test('the same version repointed to another tarball on the same host, with a rewritten hash, is critical', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: REAL, integrity: 'sha512-reallodash' },
        after: { version: '4.17.21', resolvedUrl: PLANTED, integrity: 'sha512-genuineevil' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details?.signal).toBe('tarball-repointed:https://registry.npmjs.org');
    expect(findings[0].message).toContain('lodash');
  });

  test('the same swap on a transitive entry no manifest declares is caught too', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'ansi-regex',
          { version: '5.0.1', resolvedUrl: 'https://registry.npmjs.org/ansi-regex/-/ansi-regex-5.0.1.tgz', integrity: 'sha512-clean' },
          { version: '5.0.1', resolvedUrl: 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz', integrity: 'sha512-genuineevil' }
        ),
      ],
    });
    const findings = tamperCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].packageName).toBe('ansi-regex');
  });

  // The legitimate counterpart: a bump moves the version, the URL and the
  // hash in one step, and the version is what tells the two apart.
  test('an ordinary bump, which moves the version with the URL and the hash, stays silent', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: REAL, integrity: 'sha512-reallodash' },
        after: {
          version: '4.17.22',
          resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.22.tgz',
          integrity: 'sha512-realnewlodash',
        },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  test('a same-origin URL move whose hash is unchanged is a path detail, not a swap', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: REAL, integrity: 'sha512-reallodash' },
        after: { version: '4.17.21', resolvedUrl: PLANTED, integrity: 'sha512-reallodash' },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  // The ladder that forgives a sha1-to-sha512 rehash is about a hash
  // re-derived from the SAME bytes at the same URL. A swap that also moved
  // the URL has no such excuse, so the rehash direction does not buy it
  // silence.
  test('a same-origin swap whose hash also moved to a stronger algorithm is still reported', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: REAL, integrity: 'sha1-oldstyle' },
        after: { version: '4.17.21', resolvedUrl: PLANTED, integrity: 'sha512-genuineevil' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(String(findings[0].details?.signal)).toMatch(/^tarball-repointed:/);
  });

  test('a same-origin swap that also dropped the hash is the removal finding, and only that', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: REAL, integrity: 'sha512-reallodash' },
        after: { version: '4.17.21', resolvedUrl: PLANTED },
      }),
    ];
    const signals = tamperCheck(makeContext(changes)).map((finding) => String(finding.details?.signal));
    expect(signals).toEqual(['integrity-removed']);
  });

  // A repoint to a DIFFERENT origin is the more specific host-changed fact
  // and stays that way; the new signal must not start doubling it.
  test('a repoint to another host is still host-changed, not a same-origin swap', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: REAL, integrity: 'sha512-reallodash' },
        after: {
          version: '4.17.21',
          resolvedUrl: 'https://evil.example.test/lodash/-/lodash-4.17.21.tgz',
          integrity: 'sha512-genuineevil',
        },
      }),
    ];
    const signals = tamperCheck(makeContext(changes)).map((finding) => String(finding.details?.signal));
    expect(signals).toEqual(['host-changed:https://evil.example.test']);
  });
});

// tarball-repointed above catches a same-origin swap only when the BEFORE
// side carried an integrity hash to compare against. npm writes hashless
// entries for some resolutions, and a partially hand-edited lockfile has
// them, so a before entry with NO integrity, its version held, repointed to
// a different tarball path on the same host and scheme, tripped nothing:
// the integrity branches all require before.integrity, and host/scheme/
// origin all hold on a same-origin move. This is the hashless sibling of
// tarball-repointed -- the move cannot be verified against a hash that was
// never there, so it is reported at high rather than critical.
describe('tamperCheck: a same-origin repoint with no before integrity', () => {
  const BEFORE_URL = 'https://registry.npmjs.org/a/-/a-1.0.0.tgz';
  const EVIL_URL = 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz';

  test('a hashless before entry repointed to another tarball on the same host, version held, is reported at high and blocks', () => {
    const changes = [
      makeChange({
        name: 'a',
        kind: 'changed',
        before: { version: '1.0.0', resolvedUrl: BEFORE_URL },
        after: { version: '1.0.0', resolvedUrl: EVIL_URL, integrity: 'sha512-genuineevil' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('lockfile-tamper');
    expect(findings[0].severity).toBe('high');
    expect(findings[0].packageName).toBe('a');
    expect(findings[0].details?.signal).toBe(
      'tarball-repointed-unverified:https://registry.npmjs.org'
    );
    // The polarity is the whole finding: it fires BECAUSE no hash was there,
    // so the message has to say so. An earlier draft said the opposite, and
    // substring assertions like "same" were satisfied by the wrong string.
    expect(findings[0].message).toMatch(/no integrity hash/);
    expect(findings[0].message).not.toMatch(/carried an integrity hash to verify/);
    expect(isBlocking({ ...findings[0], fingerprint: 'x' }, 'medium')).toBe(true);
  });

  test('the ambiguous-candidate wording also says no integrity hash was there', () => {
    const hashlessA: LockEntry = { version: '1.0.0', resolvedUrl: BEFORE_URL };
    const hashlessB: LockEntry = {
      version: '1.0.0',
      resolvedUrl: 'https://registry.npmjs.org/a/-/a-1.0.0-other.tgz',
    };
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'a',
          hashlessA,
          { version: '1.0.0', resolvedUrl: EVIL_URL },
          { counterpartAmbiguous: true, beforeCandidates: [hashlessA, hashlessB] }
        ),
      ],
    });
    const repoint = tamperCheck(context).find((f) =>
      String(f.details?.signal).startsWith('tarball-repointed-unverified')
    );
    expect(repoint).toBeDefined();
    expect(repoint?.message).toMatch(/no integrity hash/);
    // A guessed pairing may not print one candidate's path.
    expect(repoint?.details?.beforePath).toBeUndefined();
    expect(repoint?.details?.counterpartCandidates).toBe(2);
  });

  test('the same move with neither side carrying an integrity hash is reported too', () => {
    const changes = [
      makeChange({
        name: 'a',
        kind: 'changed',
        before: { version: '1.0.0', resolvedUrl: BEFORE_URL },
        after: { version: '1.0.0', resolvedUrl: EVIL_URL },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('high');
    expect(String(findings[0].details?.signal)).toMatch(/^tarball-repointed-unverified:/);
  });

  test('the same swap on a transitive entry no manifest declares is caught too', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'ansi-regex',
          { version: '5.0.1', resolvedUrl: 'https://registry.npmjs.org/ansi-regex/-/ansi-regex-5.0.1.tgz' },
          { version: '5.0.1', resolvedUrl: EVIL_URL }
        ),
      ],
    });
    const findings = tamperCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('high');
    expect(findings[0].packageName).toBe('ansi-regex');
    expect(String(findings[0].details?.signal)).toMatch(/^tarball-repointed-unverified:/);
  });

  // The message must not carry the full URL: a resolved URL is one of the
  // places a credential can appear. Only the origin and the tarball paths.
  test('the details carry the tarball paths, not the full URLs', () => {
    const changes = [
      makeChange({
        name: 'a',
        kind: 'changed',
        before: { version: '1.0.0', resolvedUrl: BEFORE_URL },
        after: { version: '1.0.0', resolvedUrl: EVIL_URL },
      }),
    ];
    const finding = tamperCheck(makeContext(changes))[0];
    expect(finding.details?.beforePath).toBe('/a/-/a-1.0.0.tgz');
    expect(finding.details?.afterPath).toBe('/evil/-/evil-1.0.0.tgz');
    expect(JSON.stringify(finding.details)).not.toContain('registry.npmjs.org/a/-/');
  });

  // A hashed before entry stays the existing critical tarball-repointed, not
  // the weaker unverified signal: the hash proves the bytes differ.
  test('a same-host repoint WITH a valid before integrity is still the critical tarball-repointed', () => {
    const changes = [
      makeChange({
        name: 'a',
        kind: 'changed',
        before: { version: '1.0.0', resolvedUrl: BEFORE_URL, integrity: 'sha512-real' },
        after: { version: '1.0.0', resolvedUrl: EVIL_URL, integrity: 'sha512-genuineevil' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details?.signal).toBe('tarball-repointed:https://registry.npmjs.org');
  });

  // An ordinary version bump moves the URL too, and is not a same-version
  // repoint. The new signal must stay silent for it.
  test('a legitimate version bump that moves the URL is not reported by the new signal', () => {
    const changes = [
      makeChange({
        name: 'a',
        kind: 'changed',
        before: { version: '1.0.0', resolvedUrl: BEFORE_URL },
        after: { version: '1.1.0', resolvedUrl: 'https://registry.npmjs.org/a/-/a-1.1.0.tgz' },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  // No before entry at all -- audit mode, or a fresh add -- has no move to
  // detect, so this delta-mode signal reports nothing.
  test('an added entry with no before side reports nothing new', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange('a', undefined, { version: '1.0.0', resolvedUrl: EVIL_URL }),
      ],
      hasComparisonBase: false,
    });
    expect(tamperCheck(context)).toEqual([]);
  });

  // A repoint to a DIFFERENT host is the more specific host-changed fact,
  // even with no before integrity; the new signal must not double it.
  test('a hashless repoint to another host is host-changed, not the same-origin signal', () => {
    const changes = [
      makeChange({
        name: 'a',
        kind: 'changed',
        before: { version: '1.0.0', resolvedUrl: BEFORE_URL },
        after: { version: '1.0.0', resolvedUrl: 'https://evil.example.test/a/-/a-1.0.0.tgz' },
      }),
    ];
    const signals = tamperCheck(makeContext(changes)).map((f) => String(f.details?.signal));
    expect(signals).toEqual(['host-changed:https://evil.example.test']);
  });

  // A same-origin move whose URL did NOT change (only, say, a metadata
  // field) is no move at all.
  test('a hashless entry whose URL did not move is silent', () => {
    const changes = [
      makeChange({
        name: 'a',
        kind: 'changed',
        before: { version: '1.0.0', resolvedUrl: BEFORE_URL },
        after: { version: '1.0.0', resolvedUrl: BEFORE_URL },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  // The gate is the PATHNAME, not the raw resolved URL string. Everything
  // below leaves the tarball exactly where it was, so none of it is a move;
  // firing on any of them would also produce a finding whose own reported
  // beforePath and afterPath were byte-identical.
  test('a rotated registry credential in the userinfo is not a tarball move', () => {
    const changes = [
      makeChange({
        name: 'a',
        kind: 'changed',
        before: {
          version: '1.0.0',
          resolvedUrl: 'https://ci:OLDTOKEN@npm.internal.test/a/-/a-1.0.0.tgz',
        },
        after: {
          version: '1.0.0',
          resolvedUrl: 'https://ci:NEWTOKEN@npm.internal.test/a/-/a-1.0.0.tgz',
        },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  test('a proxy query parameter cycling is not a tarball move', () => {
    const changes = [
      makeChange({
        name: 'a',
        kind: 'changed',
        before: { version: '1.0.0', resolvedUrl: `${BEFORE_URL}?token=OLD` },
        after: { version: '1.0.0', resolvedUrl: `${BEFORE_URL}?token=NEW` },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  test('a fragment-only change is not a tarball move', () => {
    const changes = [
      makeChange({
        name: 'a',
        kind: 'changed',
        before: { version: '1.0.0', resolvedUrl: `${BEFORE_URL}#one` },
        after: { version: '1.0.0', resolvedUrl: `${BEFORE_URL}#two` },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  // The positive counterpart of the three above: a genuine pathname move
  // fires, and the two paths it reports actually differ.
  test('a genuine registry pathname move fires and the two reported paths differ', () => {
    const changes = [
      makeChange({
        name: 'a',
        kind: 'changed',
        before: { version: '1.0.0', resolvedUrl: BEFORE_URL },
        after: { version: '1.0.0', resolvedUrl: EVIL_URL },
      }),
    ];
    const finding = tamperCheck(makeContext(changes))[0];
    expect(finding.severity).toBe('high');
    expect(finding.details?.beforePath).not.toBe(finding.details?.afterPath);
  });

  // A git-sourced resolution is hashless BY DESIGN, so a commit bump under a
  // held version meets every other precondition. It is git-source's business,
  // not this signal's.
  test('an npm git+ssh commit bump under a held version does not fire this signal', () => {
    const changes = [
      makeChange({
        name: 'a',
        kind: 'changed',
        before: {
          version: '1.0.0',
          resolvedUrl: 'git+ssh://git@github.com/owner/repo.git#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        after: {
          version: '1.0.0',
          resolvedUrl: 'git+ssh://git@github.com/owner/repo.git#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      }),
    ];
    const signals = tamperCheck(makeContext(changes)).map((f) => String(f.details?.signal));
    expect(signals.filter((s) => s.startsWith('tarball-repointed-unverified'))).toEqual([]);
  });

  // pnpm records a github dependency as a codeload tarball, where the commit
  // sha rides in the PATH -- so the pathname genuinely moves and the pathname
  // gate alone would not stop it. This is the case the registry-only gate is
  // load-bearing for.
  test('a pnpm codeload github tarball commit bump does not fire this signal', () => {
    const changes = [
      makeChange({
        name: 'a',
        kind: 'changed',
        before: {
          version: '1.0.0',
          resolvedUrl: 'https://codeload.github.com/owner/repo/tar.gz/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        after: {
          version: '1.0.0',
          resolvedUrl: 'https://codeload.github.com/owner/repo/tar.gz/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      }),
    ];
    const signals = tamperCheck(makeContext(changes)).map((f) => String(f.details?.signal));
    expect(signals.filter((s) => s.startsWith('tarball-repointed-unverified'))).toEqual([]);
  });

  // The same shape on a transitive lockfile entry, which has no manifest
  // line at all -- the walk where a resolution is the only evidence there is.
  test('a codeload commit bump on a transitive entry does not fire either', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'dep',
          {
            version: '2.0.0',
            resolvedUrl: 'https://codeload.github.com/o/r/tar.gz/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
          {
            version: '2.0.0',
            resolvedUrl: 'https://codeload.github.com/o/r/tar.gz/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          }
        ),
      ],
    });
    expect(tamperCheck(context)).toEqual([]);
  });
});

describe('tamperCheck: scheme change on an unchanged host', () => {
  // A resolution's identity includes the scheme, so a scheme-only change
  // (same host) already trips host-changed -- but if the label were
  // host-only, the message and details.beforeHost/afterHost would show
  // the SAME string on both sides ("resolves from host X instead of X"),
  // and a plain http -> https upgrade (a registry finishing a TLS
  // migration) would fire one critical per dependency for something
  // entirely benign. The label is the full origin instead (scheme +
  // host, named beforeOrigin/afterOrigin since a "host" detail that can
  // already carry a scheme would itself be naming drift), and the rule
  // splits by direction: any move away from https is a distinct
  // scheme-downgrade signal; http -> https on the same host is not
  // reported at all; a host change stays host-changed regardless of
  // scheme, checked first since it is the more specific fact.

  test('https downgraded to http on the same host is a distinct scheme-downgrade critical', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
        after: { version: '4.17.21', resolvedUrl: 'http://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details?.signal).toBe('scheme-downgrade:http://registry.npmjs.org');
    expect(findings[0].details?.beforeOrigin).toBe('https://registry.npmjs.org');
    expect(findings[0].details?.afterOrigin).toBe('http://registry.npmjs.org');
    expect(findings[0].details?.beforeOrigin).not.toBe(findings[0].details?.afterOrigin);
    expect(findings[0].message).toContain('https://registry.npmjs.org');
    expect(findings[0].message).toContain('http://registry.npmjs.org');
  });

  test('an internal registry finishing a TLS migration (http to https, same host) is not reported', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'http://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
        after: { version: '4.17.21', resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  test('https to git+https on the same host is also a scheme-downgrade critical', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
        after: { version: '4.17.21', resolvedUrl: 'git+https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details?.signal).toBe('scheme-downgrade:git+https://registry.npmjs.org');
  });

  test('a same-origin path-only change is silent', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
        after: { version: '4.17.22', resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.22.tgz' },
      }),
    ];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });
});

// If a resolved URL the engine cannot parse made the whole resolution
// comparison return silently, that would be a problem: npm genuinely
// writes bare relative paths into that field, so "vendor/payload.tgz"
// with a rewritten hash would be a repoint that produces nothing at all
// -- against two rules this engine states outright: every guess owes a
// diagnostic, and a URL or a hash the engine cannot read must never be
// treated as one it approved.
describe('tamperCheck: a resolution the engine cannot read', () => {
  const REAL = 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz';

  function contextFor(before: LockEntry, after: LockEntry): CheckContext {
    return makeContext([makeChange({ name: 'lodash', kind: 'changed', before, after })]);
  }

  test('a registry tarball repointed to a bare relative path with a rewritten hash is critical', () => {
    const context = contextFor(
      { version: '4.17.21', resolvedUrl: REAL, integrity: 'sha512-reallodash' },
      { version: '4.17.21', resolvedUrl: 'vendor/payload.tgz', integrity: 'sha512-planted' }
    );
    const findings = tamperCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details?.signal).toBe('resolution-unreadable');
    expect(findings[0].packageName).toBe('lodash');
  });

  test('it is reportable on the strength of the other side parsing alone', () => {
    const context = contextFor(
      { version: '4.17.21', resolvedUrl: REAL },
      { version: '4.17.21', resolvedUrl: 'vendor/payload.tgz' }
    );
    expect(tamperCheck(context)).toHaveLength(1);
  });

  test('an unreadable resolution names the package in a diagnostic', () => {
    const context = contextFor(
      { version: '4.17.21', resolvedUrl: REAL, integrity: 'sha512-reallodash' },
      { version: '4.17.21', resolvedUrl: 'vendor/payload.tgz', integrity: 'sha512-planted' }
    );
    tamperCheck(context);
    const notice = context.diagnostics.find((d) => d.code === 'tamper-resolution-unreadable');
    expect(notice).toBeDefined();
    expect(notice?.message).toContain('lodash');
  });

  test('the unreadable value itself never reaches the message or the details', () => {
    const context = contextFor(
      { version: '4.17.21', resolvedUrl: REAL },
      { version: '4.17.21', resolvedUrl: 'vendor/ghp_SECRETTOKEN/payload.tgz' }
    );
    const findings = tamperCheck(context);
    expect(findings[0].message).not.toContain('ghp_SECRETTOKEN');
    expect(JSON.stringify(findings[0].details)).not.toContain('ghp_SECRETTOKEN');
    expect(JSON.stringify(context.diagnostics)).not.toContain('ghp_SECRETTOKEN');
  });

  // The same reasoning local-source-changed already applies: a hash present
  // and identical on both sides settles what the path was standing in for.
  test('an unreadable move whose identical hash vouches for the bytes is noted, not reported', () => {
    const context = contextFor(
      { version: '4.17.21', resolvedUrl: 'vendor/lodash-4.17.21.tgz', integrity: 'sha512-same' },
      { version: '4.17.21', resolvedUrl: 'vendor/lodash.tgz', integrity: 'sha512-same' }
    );
    expect(tamperCheck(context)).toEqual([]);
    expect(context.diagnostics.map((d) => d.code)).toContain('tamper-resolution-unreadable');
  });

  test('two unreadable resolutions with nothing else to go on are noted, not reported', () => {
    const context = contextFor(
      { version: '4.17.21', resolvedUrl: 'not a url' },
      { version: '4.17.22', resolvedUrl: 'also not a url' }
    );
    expect(tamperCheck(context)).toEqual([]);
    expect(context.diagnostics.map((d) => d.code)).toContain('tamper-resolution-unreadable');
  });

  test('one package produces one diagnostic however many entries carry it', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'lodash',
          { version: '4.17.21', resolvedUrl: REAL },
          { version: '4.17.21', resolvedUrl: 'vendor/payload.tgz' }
        ),
        makeLockEntryChange(
          'lodash',
          { version: '4.17.21', resolvedUrl: REAL },
          { version: '4.17.21', resolvedUrl: 'vendor/payload.tgz' }
        ),
      ],
    });
    tamperCheck(context);
    expect(context.diagnostics.filter((d) => d.code === 'tamper-resolution-unreadable')).toHaveLength(1);
  });
});

describe('tamperCheck: git/url source swap', () => {
  // The attack shape this rule exists to catch: a pinned range rewritten
  // to a git source arrives as a changed dependency, never an added one.
  test('a changed dependency repointed at a git source is critical', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        protocol: 'git',
        specifier: 'github:evil/lodash',
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].message).toContain('git');
    expect(findings[0].details?.signal).toBe('git-source');
  });

  test('an added dependency pointed at a url source is critical', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'added',
        protocol: 'url',
        specifier: 'https://evil.example.test/lodash.tgz',
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details?.signal).toBe('url-source:evil.example.test');
  });

  // These two signals read the manifest specifier and nothing else -- the
  // audit-mode diagnostic says as much, and the yarn and bun loaders tell
  // users their checks fall back to manifest evidence. Gating them on the
  // lockfile format would mean a specifier rewritten to a git source in a
  // yarn, bun, or lockfile-less repository produces nothing at all.
  test.each(['yarn', 'bun', 'none'] as const)(
    'a git-source swap is reported for %s, which has no resolutions to read',
    (lockfileFormat) => {
      const changes = [
        makeChange({
          name: 'lodash',
          kind: 'changed',
          protocol: 'git',
          specifier: 'git+https://evil.example.test/lodash.git',
        }),
      ];
      const findings = tamperCheck(makeContext(changes, { lockfileFormat }));
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe('critical');
      expect(findings[0].details?.signal).toBe('git-source:evil.example.test');
    }
  );

  test('a url-source swap in a repository with no lockfile at all is reported too', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        protocol: 'url',
        specifier: 'https://evil.example.test/lodash.tgz',
      }),
    ];
    const context = makeContext(changes, { lockfileFormat: 'none', lockfilePath: undefined });
    const findings = tamperCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.signal).toBe('url-source:evil.example.test');
    expect(findings[0].lockfilePath).toBeUndefined();
  });

  test('an ordinary registry dependency is not reported by the source-swap rule', () => {
    const changes = [makeChange({ name: 'lodash', kind: 'added', protocol: 'registry' })];
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  // A git/url specifier is exactly where a credential appears, so echoing
  // the raw specifier verbatim into the message and details would leak
  // one. The host is named instead -- the same shape the resolvedUrl rule
  // already uses -- since .host never carries userinfo the way the full
  // specifier string can.
  test('a credential-bearing git specifier leaks no token into the message or details', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        protocol: 'git',
        specifier: 'git+https://x-access-token:ghp_SECRETTOKEN@github.com/evil/lodash.git',
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].message).not.toContain('ghp_SECRETTOKEN');
    expect(findings[0].message).not.toContain('x-access-token');
    expect(JSON.stringify(findings[0].details)).not.toContain('ghp_SECRETTOKEN');
    expect(JSON.stringify(findings[0].details)).not.toContain('x-access-token');
    expect(findings[0].message).toContain('github.com');
  });

  // The "github:owner/repo" shorthand has no host in its own text at all
  // (manifest.ts classifies it as protocol 'git' with no rewriting), so
  // there is nothing to extract -- this must not throw and must not fall
  // back to printing the raw specifier either.
  test('a specifier with no extractable host still reports without the raw specifier', () => {
    const changes = [
      makeChange({ name: 'lodash', kind: 'added', protocol: 'git', specifier: 'github:evil/lodash' }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].message).not.toContain('github:evil/lodash');
    expect(JSON.stringify(findings[0].details)).not.toContain('github:evil/lodash');
  });
});

// A full commit SHA names bytes that cannot change; a branch or a tag
// names bytes whoever controls the repository can replace. Reporting both
// at the same unconditional critical hard-blocked the first commit of any
// repository with a long-standing pinned git dependency, which is a
// legitimate configuration this gate has no business refusing.
//
// The demotion is a property of the STATE case alone, and these all run
// with no comparison base for that reason. The pin says the bytes cannot
// change from here; it says nothing about whether moving to them was the
// change under review. See the delta-mode describe below, which is the
// half that must never be softened.
describe('tamperCheck: a pre-existing pinned git source, seen with no earlier revision', () => {
  function statePin(specifier: string) {
    const changes = [makeChange({ name: 'dep', kind: 'added', protocol: 'git', specifier })];
    const findings = tamperCheck(makeContext(changes, { hasComparisonBase: false }));
    expect(findings).toHaveLength(1);
    return findings[0];
  }

  test('a 40-hex commit SHA reports at low, under the default medium gate', () => {
    expect(
      statePin('git+https://git.example.test/owner/repo.git#49103de6ed70804e940637bf3e9e29e4a3f54e64')
        .severity
    ).toBe('low');
  });

  // The message has to say WHY it is not blocking, and the reason is the
  // missing revision, not the pin on its own.
  test('the low message says the scan has no earlier revision and the pin cannot change', () => {
    const finding = statePin(
      'git+https://git.example.test/owner/repo.git#49103de6ed70804e940637bf3e9e29e4a3f54e64'
    );
    expect(finding.message).toContain('immutable commit');
    expect(finding.message).toContain('no earlier revision');
    expect(finding.message).toContain('cannot change');
  });

  // git repositories are migrating to sha256 object ids, and a 64-hex ref
  // is exactly as immutable as a 40-hex one.
  test('a 64-hex sha256 commit id is immutable too', () => {
    expect(
      statePin(
        'git+https://git.example.test/owner/repo.git#8b1a9953c4611296a827abf8c47804d7c470c39cf17b2a4d1e2f7e5a2c0d3b6f'
      ).severity
    ).toBe('low');
  });

  test('the github: shorthand with a pinned SHA is immutable even though it carries no host', () => {
    const finding = statePin('github:owner/repo#49103de6ed70804e940637bf3e9e29e4a3f54e64');
    expect(finding.severity).toBe('low');
    expect(finding.details?.host).toBeNull();
  });

  test.each([
    ['a tag ref', 'git+https://git.example.test/owner/repo.git#v1.2.3'],
    ['a branch ref', 'git+https://git.example.test/owner/repo.git#main'],
    ['no ref at all', 'git+https://git.example.test/owner/repo.git'],
    ['a short SHA', 'git+https://git.example.test/owner/repo.git#49103de'],
    ['a 40-character non-hex ref', 'git+https://git.example.test/owner/repo.git#zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
  ])('%s keeps its blocking severity even with no comparison base', (_label, specifier) => {
    expect(statePin(specifier).severity).toBe('critical');
  });

  test('the mutable-ref message says the installed code can change without the manifest changing', () => {
    const finding = statePin('git+https://git.example.test/owner/repo.git#main');
    expect(finding.message).toContain('can change');
    expect(finding.message).not.toContain('immutable commit');
  });

  // A url source names a tarball at a URL. The bytes behind that URL can
  // be replaced whatever the path looks like, so a hex-shaped fragment on
  // one buys nothing and must not read as a pin.
  test('a url source with a hex-shaped fragment is not treated as an immutable pin', () => {
    const changes = [
      makeChange({
        name: 'dep',
        kind: 'added',
        protocol: 'url',
        specifier:
          'https://evil.example.test/dep.tgz#49103de6ed70804e940637bf3e9e29e4a3f54e64',
      }),
    ];
    const findings = tamperCheck(makeContext(changes, { hasComparisonBase: false }));
    expect(findings[0].severity).toBe('critical');
  });

  // The credential rule holds for the new branches too: a ref is read to
  // classify the pin, never echoed alongside the rest of the specifier.
  test('an immutable pin on a credential-bearing specifier still leaks no token', () => {
    const finding = statePin(
      'git+https://x-access-token:ghp_SECRETTOKEN@git.example.test/o/r.git#49103de6ed70804e940637bf3e9e29e4a3f54e64'
    );
    expect(finding.severity).toBe('low');
    expect(finding.message).not.toContain('ghp_SECRETTOKEN');
    expect(JSON.stringify(finding.details)).not.toContain('ghp_SECRETTOKEN');
  });
});

// The attack this check was written for, named in its own header: a pinned
// range rewritten to a git source. An attacker's fork pinned to a commit is
// still an attacker's fork, and the pin makes it MORE attractive, not less,
// because it looks deliberate and reviewed. A severity computed from the
// specifier alone would report exactly that at low and exit 0.
describe('tamperCheck: a move to a git source with a comparison base always blocks', () => {
  function deltaChange(kind: 'added' | 'changed', specifier: string) {
    const changes = [makeChange({ name: 'lodash', kind, protocol: 'git', specifier })];
    const findings = tamperCheck(makeContext(changes, { hasComparisonBase: true }));
    expect(findings).toHaveLength(1);
    return findings[0];
  }

  test('a registry range repointed to an attacker fork pinned to a commit is critical', () => {
    const finding = deltaChange(
      'changed',
      'github:attacker/lodash#49103de6ed70804e940637bf3e9e29e4a3f54e64'
    );
    expect(finding.severity).toBe('critical');
    expect(finding.details?.kind).toBe('changed');
  });

  test('that finding blocks at the default medium threshold', () => {
    const finding = deltaChange(
      'changed',
      'github:attacker/lodash#49103de6ed70804e940637bf3e9e29e4a3f54e64'
    );
    expect(isBlocking({ ...finding, fingerprint: 'x' }, 'medium')).toBe(true);
  });

  // A dependency genuinely added in this revision is an event too. Only
  // the no-comparison-base case reads everything as added falsely, and
  // that case is the only one the demotion covers.
  test('a newly added pinned git dependency is critical when the scan has a comparison base', () => {
    expect(
      deltaChange('added', 'github:attacker/lodash#49103de6ed70804e940637bf3e9e29e4a3f54e64')
        .severity
    ).toBe('critical');
  });

  test('the delta-mode message for a pinned source does not read as reassurance', () => {
    const finding = deltaChange(
      'changed',
      'github:attacker/lodash#49103de6ed70804e940637bf3e9e29e4a3f54e64'
    );
    expect(finding.message).toContain('this revision');
    expect(finding.message).not.toContain('no earlier revision');
  });
});

// The pin test decides a severity, so its edges are a gate boundary rather
// than a formatting detail: one character either side of a commit id, and a
// fragment that is not a ref at all.
describe('tamperCheck: what counts as a full commit object id', () => {
  function severityOf(fragment: string) {
    const changes = [
      makeChange({
        name: 'dep',
        kind: 'added',
        protocol: 'git',
        specifier: `git+https://git.example.test/owner/repo.git#${fragment}`,
      }),
    ];
    return tamperCheck(makeContext(changes, { hasComparisonBase: false }))[0].severity;
  }

  test('39 hex characters is not a commit id', () => {
    expect(severityOf('49103de6ed70804e940637bf3e9e29e4a3f54e6')).toBe('critical');
  });

  test('41 hex characters is not a commit id', () => {
    expect(severityOf('49103de6ed70804e940637bf3e9e29e4a3f54e644')).toBe('critical');
  });

  test('63 hex characters is not a commit id', () => {
    expect(
      severityOf('8b1a9953c4611296a827abf8c47804d7c470c39cf17b2a4d1e2f7e5a2c0d3b6')
    ).toBe('critical');
  });

  // npm's "#semver:" fragment selects a tag by range. It is a ref
  // selector, not a ref, and what it selects moves as tags are published.
  test('a #semver: range fragment is not a commit id', () => {
    expect(severityOf('semver:^1.0.0')).toBe('critical');
  });

  test('an uppercase 40-hex commit id is still a commit id', () => {
    expect(severityOf('49103DE6ED70804E940637BF3E9E29E4A3F54E64')).toBe('low');
  });

  test('a mixed-case 40-hex commit id is still a commit id', () => {
    expect(severityOf('49103De6eD70804e940637Bf3E9e29E4a3F54e64')).toBe('low');
  });
});

// The git-source and url-source signals read a manifest specifier and
// nothing else, so they are state signals: they say what a dependency IS,
// never that anything happened between two revisions. With no earlier
// revision behind the scan every dependency reads as added, and spelling
// that state fact as an event told a first-time adopter their long-standing
// pinned dependency had just been introduced.
describe('tamperCheck: the source-swap signals report state, not an event', () => {
  test('with no comparison base the kind is "present", not "added"', () => {
    const changes = [
      makeChange({ name: 'dep', kind: 'added', protocol: 'git', specifier: 'github:owner/repo' }),
    ];
    const findings = tamperCheck(makeContext(changes, { hasComparisonBase: false }));
    expect(findings[0].details?.kind).toBe('present');
  });

  test('a url source with no comparison base reports "present" too', () => {
    const changes = [
      makeChange({
        name: 'dep',
        kind: 'added',
        protocol: 'url',
        specifier: 'https://evil.example.test/dep.tgz',
      }),
    ];
    const findings = tamperCheck(makeContext(changes, { hasComparisonBase: false }));
    expect(findings[0].details?.kind).toBe('present');
  });

  test.each(['added', 'changed'] as const)(
    'with a comparison base the real kind %s survives',
    (kind) => {
      const changes = [
        makeChange({ name: 'dep', kind, protocol: 'git', specifier: 'github:owner/repo' }),
      ];
      const findings = tamperCheck(makeContext(changes, { hasComparisonBase: true }));
      expect(findings[0].details?.kind).toBe(kind);
    }
  );

  // The comparison-derived signals genuinely are events, and their kind
  // must not be rewritten by any of this.
  test('a comparison-derived signal keeps its own kind with no comparison base', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', integrity: 'sha512-abc' },
        after: { version: '4.17.21' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes, { hasComparisonBase: false }));
    expect(findings[0].details?.signal).toBe('integrity-removed');
    expect(findings[0].details?.kind).toBe('changed');
  });
});

// The fingerprint is a sha256 over exactly ruleId, packageName,
// manifestPath and details.signal. Severity, the message and every other
// details key are excluded on purpose, so none of the changes above may
// move a stored baseline. The literal below was produced by dep-guard
// 0.2.2 scanning a real repository whose manifest declares
// "github:owner/repo#<40-hex>"; if it moves, every baseline holding this
// finding silently stops matching.
describe('tamperCheck: the git-source fingerprint survives the severity and kind changes', () => {
  test('the recorded 0.2.2 fingerprint for a pinned git dependency still matches', () => {
    const changes = [
      makeChange({
        name: '@modelcontextprotocol/conformance',
        kind: 'added',
        protocol: 'git',
        specifier: 'github:modelcontextprotocol/conformance#49103de6ed70804e940637bf3e9e29e4a3f54e64',
        manifestPath: 'sdk/typescript/package.json',
      }),
    ];
    const findings = tamperCheck(makeContext(changes, { hasComparisonBase: false }));
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.signal).toBe('git-source');
    expect(fingerprintFinding(findings[0])).toBe(
      '62fb257534522fc3545cd90db5f299678ff7b630035aff02677f7878864f3233'
    );
  });
});

// The severity split is decided from a specifier, and a specifier only
// reaches this check after manifest.ts has classified its protocol. The
// table-driven cases above hand-build DepChanges, so they would keep
// passing if classifySpecifier stopped calling one of these shapes a git
// source at all. This one starts from a real manifest file.
describe('tamperCheck: git source severities read off a parsed manifest', () => {
  const GIT_MANIFEST = readFileSync(
    fileURLToPath(new URL('./fixtures/manifest-git-sources.json', import.meta.url)),
    'utf8'
  );

  function severityByName(): Map<string, string> {
    const manifest = parseManifest('package.json', GIT_MANIFEST);
    const changes = manifest.deps.map((dep) =>
      makeChange({
        name: dep.name,
        registryName: dep.registryName,
        specifier: dep.specifier,
        protocol: dep.protocol,
        depType: dep.depType,
        kind: 'added',
      })
    );
    const findings = tamperCheck(makeContext(changes, { hasComparisonBase: false }));
    return new Map(findings.map((finding) => [finding.packageName, finding.severity]));
  }

  test('every declared source dependency is still reported', () => {
    expect([...severityByName().keys()].sort()).toEqual([
      'branch-ref',
      'no-ref',
      'pinned-sha1',
      'pinned-sha256',
      'tag-ref',
      'url-source',
    ]);
  });

  test('the two commit-pinned dependencies are low and the rest still block', () => {
    const severities = severityByName();
    expect(severities.get('pinned-sha1')).toBe('low');
    expect(severities.get('pinned-sha256')).toBe('low');
    expect(severities.get('tag-ref')).toBe('critical');
    expect(severities.get('branch-ref')).toBe('critical');
    expect(severities.get('no-ref')).toBe('critical');
    expect(severities.get('url-source')).toBe('critical');
  });
});

describe('tamperCheck: multi-signal', () => {
  // Three independent tamper signals can fire on one dependency at once
  // (a git-source swap that also lost its integrity hash and moved
  // host), and the fingerprint is sha256 over (ruleId, packageName,
  // manifestPath) alone -- without a per-finding signal, baselining one
  // would silently suppress the other two.
  test('a dependency tripping all three tamper rules gets three distinct signal values', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        protocol: 'git',
        specifier: 'github:evil/lodash',
        before: {
          version: '4.17.21',
          integrity: 'sha512-abc',
          resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
        },
        after: {
          version: '4.17.21',
          resolvedUrl: 'https://evil.example.test/lodash/-/lodash-4.17.21.tgz',
        },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(3);
    const signals = findings.map((finding) => finding.details?.signal).sort();
    expect(signals).toEqual([
      'git-source',
      'host-changed:https://evil.example.test',
      'integrity-removed',
    ]);
  });
});

// Same hazard, same fix as confusion.ts -- tamperCheck loops over
// delta.changes directly, so two DepChanges resolving to the same
// (manifestPath, registryName) would each independently produce a
// finding for the same signal, hashing identically. Deduped on
// (manifestPath, packageName, signal), so this check's genuinely
// distinct signals (git-source, integrity-removed, host-changed, ...)
// still all survive for one dependency.
describe('tamperCheck: fingerprint-colliding duplicates', () => {
  test('two aliases onto the same registry name with the same host-changed tamper report only once', () => {
    const changes = [
      makeChange({
        name: 'a',
        registryName: 'lodash',
        kind: 'added',
        protocol: 'alias',
        specifier: 'npm:lodash@4.17.21',
        before: { version: '4.17.21', resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
        after: { version: '4.17.21', resolvedUrl: 'https://evil.example.test/lodash/-/lodash-4.17.21.tgz' },
      }),
      makeChange({
        name: 'b',
        registryName: 'lodash',
        kind: 'added',
        protocol: 'alias',
        specifier: 'npm:lodash@4.17.21',
        before: { version: '4.17.21', resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
        after: { version: '4.17.21', resolvedUrl: 'https://evil.example.test/lodash/-/lodash-4.17.21.tgz' },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.signal).toBe('host-changed:https://evil.example.test');
  });

  // The strongest version of the multi-signal guard: two DepChanges for
  // one dependency, each independently tripping
  // ALL THREE tamper signals, still yield exactly three findings -- one
  // per DISTINCT signal, not six (3 signals x 2 changes) and not one
  // (collapsed past the point of usefulness). Each of the three surviving
  // findings must also hash to a distinct fingerprint, which is the
  // property baselining actually depends on.
  test('two aliases each tripping all three signals still yield exactly three findings with three distinct fingerprints', () => {
    const changes = [
      makeChange({
        name: 'a',
        registryName: 'lodash',
        kind: 'changed',
        protocol: 'git',
        specifier: 'github:evil/lodash',
        before: {
          version: '4.17.21',
          integrity: 'sha512-abc',
          resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
        },
        after: {
          version: '4.17.21',
          resolvedUrl: 'https://evil.example.test/lodash/-/lodash-4.17.21.tgz',
        },
      }),
      makeChange({
        name: 'b',
        registryName: 'lodash',
        kind: 'changed',
        protocol: 'git',
        specifier: 'github:evil/lodash',
        before: {
          version: '4.17.21',
          integrity: 'sha512-abc',
          resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
        },
        after: {
          version: '4.17.21',
          resolvedUrl: 'https://evil.example.test/lodash/-/lodash-4.17.21.tgz',
        },
      }),
    ];
    const findings = tamperCheck(makeContext(changes));
    expect(findings).toHaveLength(3);
    const signals = findings.map((finding) => finding.details?.signal).sort();
    expect(signals).toEqual([
      'git-source',
      'host-changed:https://evil.example.test',
      'integrity-removed',
    ]);

    const fingerprints = new Set(findings.map((finding) => fingerprintFinding(finding)));
    expect(fingerprints.size).toBe(3);
  });
});

describe('tamperCheck: general behavior', () => {
  test('only one side present skips the lockfile-comparison rules without crashing', () => {
    const changes = [makeChange({ name: 'lodash', kind: 'added', after: { version: '1.0.0' } })];
    expect(() => tamperCheck(makeContext(changes))).not.toThrow();
    expect(tamperCheck(makeContext(changes))).toEqual([]);
  });

  // allow says "I know about this package". A stripped integrity hash or
  // a repointed resolution is a fact about where the bytes come from,
  // which is not something an allow entry was ever asked about -- and
  // treating it as one would turn one careless allow line into a silent
  // acceptance of the exact attack this rule exists to catch.
  test('an allow-listed package is still reported for a stripped integrity hash', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', integrity: 'sha512-abc' },
        after: { version: '4.17.21' },
      }),
    ];
    const context = makeContext(changes, { config: { allow: ['lodash'] } });
    const findings = tamperCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].details?.signal).toBe('integrity-removed');
  });

  test('an allow-listed scope is still reported for a host repoint', () => {
    const changes = [
      makeChange({
        name: '@acme/widgets',
        kind: 'changed',
        before: { version: '1.0.0', resolvedUrl: 'https://registry.npmjs.org/a.tgz' },
        after: { version: '1.0.0', resolvedUrl: 'https://evil.example.test/a.tgz' },
      }),
    ];
    const context = makeContext(changes, { config: { allow: ['@acme/*'] } });
    expect(tamperCheck(context)).toHaveLength(1);
  });

  test.each(['yarn', 'bun', 'none'] as const)('produces nothing for %s format', (lockfileFormat) => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', integrity: 'sha512-abc' },
        after: { version: '4.17.21' },
      }),
    ];
    expect(tamperCheck(makeContext(changes, { lockfileFormat }))).toEqual([]);
  });

  test('runs for pnpm format too', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', integrity: 'sha512-abc' },
        after: { version: '4.17.21' },
      }),
    ];
    expect(tamperCheck(makeContext(changes, { lockfileFormat: 'pnpm' }))).toHaveLength(1);
  });

  // Every finding this check raises is about a lockfile, so each one
  // names which lockfile it came from.
  test('a finding names the lockfile it came from', () => {
    const changes = [
      makeChange({
        name: 'lodash',
        kind: 'changed',
        before: { version: '4.17.21', integrity: 'sha512-abc' },
        after: { version: '4.17.21' },
      }),
    ];
    expect(tamperCheck(makeContext(changes))[0].lockfilePath).toBe('package-lock.json');
  });
});

// C1/C3: the check's comparison rules read every entry the lockfile diff
// produced, not only the one entry a manifest walk happened to select for a
// declared dependency.
describe('tamperCheck: lockfile entries no manifest declares', () => {
  const CLEAN: LockEntry = {
    version: '5.0.1',
    resolvedUrl: 'https://registry.npmjs.org/ansi-regex/-/ansi-regex-5.0.1.tgz',
    integrity: 'sha512-clean',
  };

  test('a transitive entry repointed at another host is critical', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange('ansi-regex', CLEAN, {
          version: '5.0.1',
          resolvedUrl: 'https://evil.example.test/ansi-regex/-/ansi-regex-5.0.1.tgz',
          integrity: 'sha512-clean',
        }),
      ],
    });
    const findings = tamperCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].packageName).toBe('ansi-regex');
    expect(findings[0].lockfilePath).toBe('package-lock.json');
  });

  test('a transitive entry stripped of its integrity is critical', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange('ansi-regex', CLEAN, {
          version: '5.0.1',
          resolvedUrl: CLEAN.resolvedUrl,
        }),
      ],
    });
    expect(tamperCheck(context)).toHaveLength(1);
  });

  test('a newly added entry with no before side is not a comparison finding', () => {
    const context = makeContext([], {
      lockEntryChanges: [makeLockEntryChange('ansi-regex', undefined, CLEAN)],
    });
    expect(tamperCheck(context)).toEqual([]);
  });

  test('an allow entry does not silence it either', () => {
    const context = makeContext([], {
      config: { allow: ['ansi-regex'] },
      lockEntryChanges: [
        makeLockEntryChange('ansi-regex', CLEAN, {
          version: '5.0.1',
          resolvedUrl: 'https://evil.example.test/ansi-regex/-/ansi-regex-5.0.1.tgz',
          integrity: 'sha512-clean',
        }),
      ],
    });
    expect(tamperCheck(context)).toHaveLength(1);
  });

  test('the same fact reached from both the manifest walk and the entry walk is reported once', () => {
    const before: LockEntry = {
      version: '4.17.21',
      resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
      integrity: 'sha512-a',
    };
    const after: LockEntry = {
      version: '4.17.21',
      resolvedUrl: 'https://evil.example.test/lodash/-/lodash-4.17.21.tgz',
      integrity: 'sha512-a',
    };
    const context = makeContext([makeChange({ name: 'lodash', kind: 'changed', before, after })], {
      lockEntryChanges: [makeLockEntryChange('lodash', before, after)],
    });
    expect(tamperCheck(context)).toHaveLength(1);
  });

  // If a pairing the delta could only guess at suppressed every
  // comparison signal outright, that suppression would be constructible
  // -- any name carrying two before entries, which is ubiquitous in a
  // real lockfile, could be repointed to any host in one move by giving
  // the evil entry a version no candidate shares. What the guess actually
  // costs is the message's before-value, not the verdict: if every
  // surviving candidate yields the same one, the verdict is a fact about
  // the lockfile and gets reported, phrased in terms of what is certain.
  // Only a genuinely candidate-dependent difference stays quiet.
  test('a verdict every candidate agrees on is reported, not suppressed', () => {
    const nested: LockEntry = {
      version: '4.17.20',
      resolvedUrl: 'https://registry.npmjs.org/ansi-regex/-/ansi-regex-4.17.20.tgz',
      integrity: 'sha512-nested',
    };
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'ansi-regex',
          CLEAN,
          { version: '9.9.9', resolvedUrl: 'https://evil.example.test/ansi-regex-9.9.9.tgz', integrity: 'sha512-evil' },
          { counterpartAmbiguous: true, beforeCandidates: [CLEAN, nested] }
        ),
      ],
    });
    const findings = tamperCheck(context);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details?.signal).toBe('host-changed:https://evil.example.test');
  });

  test('the message and details name what is certain, never one of the candidates', () => {
    const nested: LockEntry = {
      version: '4.17.20',
      resolvedUrl: 'https://mirror.example.test/ansi-regex-4.17.20.tgz',
      integrity: 'sha512-nested',
    };
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'ansi-regex',
          CLEAN,
          { version: '9.9.9', resolvedUrl: 'https://evil.example.test/ansi-regex-9.9.9.tgz', integrity: 'sha512-evil' },
          { counterpartAmbiguous: true, beforeCandidates: [CLEAN, nested] }
        ),
      ],
    });
    const findings = tamperCheck(context);
    expect(findings[0].message).toContain('evil.example.test');
    expect(findings[0].message).not.toContain('registry.npmjs.org');
    expect(findings[0].message).not.toContain('mirror.example.test');
    expect(findings[0].details?.beforeOrigin).toBeUndefined();
    expect(findings[0].details?.counterpartCandidates).toBe(2);
  });

  test('an integrity strip every candidate had a hash to lose is reported', () => {
    const nested: LockEntry = { version: '4.17.20', resolvedUrl: CLEAN.resolvedUrl, integrity: 'sha512-nested' };
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'ansi-regex',
          CLEAN,
          { version: '9.9.9', resolvedUrl: CLEAN.resolvedUrl },
          { counterpartAmbiguous: true, beforeCandidates: [CLEAN, nested] }
        ),
      ],
    });
    const signals = tamperCheck(context).map((finding) => String(finding.details?.signal));
    expect(signals).toEqual(['integrity-removed']);
  });

  // "Suppressed" here means suppressed AS ITSELF: the critical is not filed
  // against a candidate nobody can identify. What replaced the silence is
  // the escalation below it, which blocks without claiming which candidate
  // applies.
  test('a strip one candidate had no hash to lose stays suppressed', () => {
    const hashless: LockEntry = { version: '4.17.20', resolvedUrl: CLEAN.resolvedUrl };
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'ansi-regex',
          CLEAN,
          { version: '9.9.9', resolvedUrl: CLEAN.resolvedUrl },
          { counterpartAmbiguous: true, beforeCandidates: [CLEAN, hashless] }
        ),
      ],
    });
    const signals = tamperCheck(context).map((finding) => String(finding.details?.signal));
    expect(signals).not.toContain('integrity-removed');
    expect(signals).toEqual(['ambiguous-critical']);
  });

  test('a repoint one candidate already resolved from stays suppressed', () => {
    const alreadyThere: LockEntry = {
      version: '4.17.20',
      resolvedUrl: 'https://evil.example.test/ansi-regex-4.17.20.tgz',
      integrity: 'sha512-nested',
    };
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'ansi-regex',
          CLEAN,
          { version: '9.9.9', resolvedUrl: 'https://evil.example.test/ansi-regex-9.9.9.tgz', integrity: 'sha512-evil' },
          { counterpartAmbiguous: true, beforeCandidates: [CLEAN, alreadyThere] }
        ),
      ],
    });
    const signals = tamperCheck(context).map((finding) => String(finding.details?.signal));
    expect(signals.some((signal) => signal.startsWith('host-changed'))).toBe(false);
    expect(signals).toEqual(['ambiguous-critical']);
  });

  test('yarn and bun formats read no entries at all', () => {
    const context = makeContext([], {
      lockfileFormat: 'yarn',
      lockEntryChanges: [
        makeLockEntryChange('ansi-regex', CLEAN, { version: '5.0.1', resolvedUrl: 'https://evil.example.test/a.tgz' }),
      ],
    });
    expect(tamperCheck(context)).toEqual([]);
  });
});

// The suppression above is only defensible while it is audible. Dropping a
// verdict some candidate reached, with nothing said, is the same silence
// this whole mechanism was built to remove -- and it used to be reachable,
// because the delta decided whether to announce a guess from a hand-written
// description of what the comparison reads rather than from the comparison
// itself.
//
// The reproduction: a partially migrated lockfile holds lodash at
// sha512-clean and a nested duplicate at the SAME version and the SAME URL
// still carrying sha1-old. Rewriting the top hash to sha512-FORGED reads as
// a forgery against the first candidate and as an ordinary sha1-to-sha512
// rehash against the second, so the intersection drops the finding -- while
// the two candidates were, to the description, identical.
describe('tamperCheck: a verdict the candidates disagree on is announced', () => {
  const TARBALL = 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz';
  const CLEAN: LockEntry = { version: '4.17.21', resolvedUrl: TARBALL, integrity: 'sha512-clean' };
  const MIGRATING: LockEntry = { version: '4.17.21', resolvedUrl: TARBALL, integrity: 'sha1-old' };
  const FORGED: LockEntry = { version: '4.17.21', resolvedUrl: TARBALL, integrity: 'sha512-FORGED' };

  function forgedContext(): CheckContext {
    return makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange('lodash', CLEAN, FORGED, {
          counterpartAmbiguous: true,
          beforeCandidates: [CLEAN, MIGRATING],
        }),
      ],
    });
  }

  function ambiguities(context: CheckContext): Diagnostic[] {
    return context.diagnostics.filter((entry) => entry.code === 'delta-ambiguous-lock-entry');
  }

  test('a forged hash one candidate reads as a benign rehash is not silent', () => {
    const context = forgedContext();
    const findings = tamperCheck(context);
    // The critical itself really does depend on which entry this one
    // succeeds, so it is not filed as a critical -- but a diagnostic alone
    // leaves a consumer reading the exit code looking at a clean scan while
    // some candidate produced a critical, so the drop is escalated to a
    // blocking finding of its own.
    expect(findings.map((finding) => String(finding.details?.signal))).toEqual([
      'ambiguous-critical',
    ]);
    expect(ambiguities(context)).toHaveLength(1);
  });

  // Product decision: diagnostics never touch the exit code, and that stays
  // true. A dropped CRITICAL is instead reported as a finding in its own
  // right, at high, so it blocks at the default medium gate without any
  // diagnostic having to acquire a power it must not have.
  test('a dropped critical blocks, at high, naming what could not be decided', () => {
    const context = forgedContext();
    const finding = tamperCheck(context)[0];
    expect(finding.ruleId).toBe('lockfile-tamper');
    expect(finding.severity).toBe('high');
    expect(finding.packageName).toBe('lodash');
    expect(finding.details?.counterpartCandidates).toBe(2);
    expect(finding.details?.undecidedSignals).toEqual(['integrity-changed']);
    expect(finding.message).toContain('suspect');
  });

  test('the escalated finding names no candidate value either', () => {
    const finding = tamperCheck(forgedContext())[0];
    expect(finding.message).not.toContain('sha512-clean');
    expect(finding.message).not.toContain('sha1-old');
    expect(finding.details?.beforeOrigin).toBeUndefined();
    expect(finding.details?.beforePath).toBeUndefined();
  });

  test('one escalation per undecidable entry, not one per dropped signal', () => {
    // One candidate loses a hash it had; the other never had one but moved
    // host. Two dropped criticals, and they are one admission.
    const hashlessElsewhere: LockEntry = {
      version: '4.17.20',
      resolvedUrl: 'https://mirror.example.test/lodash-4.17.20.tgz',
    };
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'lodash',
          CLEAN,
          { version: '4.17.21', resolvedUrl: TARBALL },
          { counterpartAmbiguous: true, beforeCandidates: [CLEAN, hashlessElsewhere] }
        ),
      ],
    });
    const findings = tamperCheck(context);
    expect(findings).toHaveLength(1);
    expect(String(findings[0].details?.signal)).toBe('ambiguous-critical');
    expect(findings[0].details?.undecidedSignals).toEqual([
      'host-changed:https://registry.npmjs.org',
      'integrity-removed',
    ]);
  });

  test('an agreed verdict is still reported alongside an escalation', () => {
    // integrity-removed holds against both candidates, so it is reported as
    // itself; only the host move is undecidable.
    const elsewhere: LockEntry = {
      version: '4.17.20',
      resolvedUrl: 'https://mirror.example.test/lodash-4.17.20.tgz',
      integrity: 'sha512-mirror',
    };
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'lodash',
          CLEAN,
          { version: '4.17.21', resolvedUrl: TARBALL },
          { counterpartAmbiguous: true, beforeCandidates: [CLEAN, elsewhere] }
        ),
      ],
    });
    const signals = tamperCheck(context).map((finding) => String(finding.details?.signal));
    expect(signals).toEqual(['integrity-removed', 'ambiguous-critical']);
  });

  test('the announcement names the package and the verdict it could not decide', () => {
    const context = forgedContext();
    tamperCheck(context);
    const message = ambiguities(context)[0].message;
    expect(message).toContain('lodash');
    expect(message).toContain('integrity-changed');
    expect(message).toContain('2');
  });

  test('the announcement never names one candidate over the others', () => {
    const context = forgedContext();
    tamperCheck(context);
    const message = ambiguities(context)[0].message;
    expect(message).not.toContain('sha512-clean');
    expect(message).not.toContain('sha1-old');
  });

  test('a strip one candidate had no hash to lose is announced too', () => {
    const hashless: LockEntry = { version: '4.17.20', resolvedUrl: TARBALL };
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'lodash',
          CLEAN,
          { version: '9.9.9', resolvedUrl: TARBALL },
          { counterpartAmbiguous: true, beforeCandidates: [CLEAN, hashless] }
        ),
      ],
    });
    const signals = tamperCheck(context).map((finding) => String(finding.details?.signal));
    expect(signals).toEqual(['ambiguous-critical']);
    expect(ambiguities(context)[0].message).toContain('integrity-removed');
  });

  test('a verdict only the second candidate reaches is announced as well', () => {
    const elsewhere: LockEntry = {
      version: '4.17.20',
      resolvedUrl: 'https://mirror.example.test/lodash-4.17.20.tgz',
      integrity: 'sha512-mirror',
    };
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'lodash',
          CLEAN,
          { version: '9.9.9', resolvedUrl: TARBALL, integrity: 'sha512-other' },
          { counterpartAmbiguous: true, beforeCandidates: [CLEAN, elsewhere] }
        ),
      ],
    });
    const signals = tamperCheck(context).map((finding) => String(finding.details?.signal));
    expect(signals).toEqual(['ambiguous-critical']);
    expect(ambiguities(context)[0].message).toContain('host-changed');
  });

  test('candidates that all reach the same verdict are reported, and announce nothing', () => {
    const nested: LockEntry = {
      version: '4.17.20',
      resolvedUrl: 'https://mirror.example.test/lodash-4.17.20.tgz',
      integrity: 'sha512-nested',
    };
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'lodash',
          CLEAN,
          { version: '9.9.9', resolvedUrl: 'https://evil.example.test/lodash-9.9.9.tgz', integrity: 'sha512-evil' },
          { counterpartAmbiguous: true, beforeCandidates: [CLEAN, nested] }
        ),
      ],
    });
    expect(tamperCheck(context)).toHaveLength(1);
    expect(ambiguities(context)).toEqual([]);
  });

  test('candidates that all reach no verdict at all announce nothing', () => {
    const nested: LockEntry = { version: '4.17.20', resolvedUrl: TARBALL, integrity: 'sha512-nested' };
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'lodash',
          CLEAN,
          { version: '4.18.0', resolvedUrl: TARBALL, integrity: 'sha512-newer' },
          { counterpartAmbiguous: true, beforeCandidates: [CLEAN, nested] }
        ),
      ],
    });
    expect(tamperCheck(context)).toEqual([]);
    expect(ambiguities(context)).toEqual([]);
  });

  test('a decided pairing never announces anything', () => {
    const context = makeContext([], {
      lockEntryChanges: [makeLockEntryChange('lodash', CLEAN, FORGED)],
    });
    expect(tamperCheck(context)).toHaveLength(1);
    expect(ambiguities(context)).toEqual([]);
  });

  // The same rule resolutionFinding already honours: a value taken from one
  // candidate is a fact about which candidate the delta guessed at, not
  // about the lockfile, and a message or a detail may not carry one.
  // tarball-repointed put the first candidate's tarball path into
  // details.beforePath unconditionally. A pathname is no credential, but it
  // is somebody's guess reported as a fact, which is the defect this whole
  // area exists to prevent.
  test('a repoint every candidate agrees on names no candidate tarball path', () => {
    const alternate: LockEntry = {
      version: '4.17.21',
      resolvedUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21-nested.tgz',
      integrity: 'sha512-nested',
    };
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange(
          'lodash',
          CLEAN,
          {
            version: '4.17.21',
            resolvedUrl: 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz',
            integrity: 'sha512-evil',
          },
          { counterpartAmbiguous: true, beforeCandidates: [CLEAN, alternate] }
        ),
      ],
    });
    const findings = tamperCheck(context);
    expect(findings).toHaveLength(1);
    expect(String(findings[0].details?.signal)).toContain('tarball-repointed');
    expect(findings[0].details?.beforePath).toBeUndefined();
    expect(findings[0].details?.counterpartCandidates).toBe(2);
    expect(findings[0].details?.afterPath).toBe('/evil/-/evil-1.0.0.tgz');
  });

  test('a decided pairing still names the tarball path it moved from', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange('lodash', CLEAN, {
          version: '4.17.21',
          resolvedUrl: 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz',
          integrity: 'sha512-evil',
        }),
      ],
    });
    const findings = tamperCheck(context);
    expect(findings[0].details?.beforePath).toBe('/lodash/-/lodash-4.17.21.tgz');
    expect(findings[0].details?.counterpartCandidates).toBeUndefined();
  });

  test('one announcement per package, however many entries of it disagree', () => {
    const context = makeContext([], {
      lockEntryChanges: [
        makeLockEntryChange('lodash', CLEAN, FORGED, {
          counterpartAmbiguous: true,
          beforeCandidates: [CLEAN, MIGRATING],
        }),
        makeLockEntryChange(
          'lodash',
          CLEAN,
          { ...FORGED, version: '4.17.21' },
          { counterpartAmbiguous: true, beforeCandidates: [CLEAN, MIGRATING] }
        ),
      ],
    });
    tamperCheck(context);
    expect(ambiguities(context)).toHaveLength(1);
  });
});
