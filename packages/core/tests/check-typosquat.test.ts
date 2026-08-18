import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BloomFilter } from '../src/bloom.js';
import { typosquatCheck } from '../src/checks/typosquat.js';
import type { CheckContext, ResolvedConfig } from '../src/checks/types.js';
import type { Corpus } from '../src/corpus.js';
import { loadCorpus } from '../src/corpus.js';
import type { DepChange } from '../src/delta.js';
import type { Diagnostic } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'corpus');
const fixtureCorpus = loadCorpus(FIXTURE_DIR);

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

interface ContextOptions {
  config?: Partial<ResolvedConfig>;
  corpus?: Corpus;
  workspaceLocalNames?: Set<string>;
}

function makeContext(changes: DepChange[], options: ContextOptions = {}): CheckContext {
  return {
    corpus: options.corpus ?? fixtureCorpus,
    config: { ...BASE_CONFIG, ...options.config },
    delta: {
      changes,
      lockEntryChanges: [],
      onlyBuiltAdded: [],
      lockfileFormat: 'npm',
      hasComparisonBase: true,
      workspaceLocalNames: options.workspaceLocalNames ?? new Set(),
      diagnostics: [],
    },
    npmrcRegistryPins: new Map<string, string>(),
    diagnostics: [] as Diagnostic[],
  };
}

// Runs one added registry dependency through the check.
function findingsFor(name: string, options: ContextOptions = {}): ReturnType<typeof typosquatCheck> {
  return typosquatCheck(makeContext([makeChange({ name })], options));
}

// The committed fixture corpus tops out at 50 names, so the rank-based
// severity split needs a corpus deep enough to have names past rank 1000.
function writeCorpus(top: string[]): Corpus {
  const dir = mkdtempSync(path.join(tmpdir(), 'depguard-typosquat-'));
  const filter = BloomFilter.create(top, top.length, 0.001);
  writeFileSync(path.join(dir, 'names.bloom'), filter.serialize());
  writeFileSync(path.join(dir, 'top.json'), JSON.stringify(top));
  writeFileSync(path.join(dir, 'aliases.json'), JSON.stringify({}));
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ builtAt: '2026-08-01', nameCount: top.length, fpRate: 0.001 })
  );
  return loadCorpus(dir);
}

function rankedNames(count: number): string[] {
  const names: string[] = [];
  for (let rank = 1; rank <= count; rank += 1) {
    names.push(`pkg-${String(rank).padStart(4, '0')}`);
  }
  return names;
}

const deepCorpus = writeCorpus(rankedNames(1300));

describe('typosquatCheck: alias list first', () => {
  test('a curated alias pair is critical and names its target', () => {
    const findings = findingsFor('unused-imports');
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('typosquat');
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].packageName).toBe('unused-imports');
    expect(findings[0].message).toContain('eslint-plugin-unused-imports');
    expect(findings[0].details).toMatchObject({
      matchedBy: 'alias-list',
      target: 'eslint-plugin-unused-imports',
    });
  });

  test('config extraAliases are merged with the corpus alias list', () => {
    const findings = findingsFor('acme-utils', {
      config: { extraAliases: { 'acme-utils': ['@acme/utils'] } },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details).toMatchObject({ matchedBy: 'alias-list', target: '@acme/utils' });
  });

  // "chalkk" is also a repetition transform and a distance-1 neighbour of
  // "chalk"; the alias rule runs first and is the only rule that reports.
  test('an alias hit wins over a transform and a distance hit', () => {
    const findings = findingsFor('chalkk', {
      config: { extraAliases: { chalkk: ['chalk-internal'] } },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({
      matchedBy: 'alias-list',
      target: 'chalk-internal',
    });
  });

  test('an inherited object key is not treated as an alias entry', () => {
    expect(findingsFor('constructor')).toEqual([]);
  });

  // The alias list is consulted before the top-list exemption, so a
  // configured pair reports even when the name is itself popular. Pinned
  // because the order is a decision, not an accident.
  test('an alias entry beats the top-list exemption', () => {
    const findings = findingsFor('react', { config: { extraAliases: { react: ['preact'] } } });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details).toMatchObject({ matchedBy: 'alias-list', target: 'preact' });
  });
});

describe('typosquatCheck: top-list names are never flagged', () => {
  test('a top-list name is silent', () => {
    expect(findingsFor('react')).toEqual([]);
  });

  test('a top-list name one edit from another top-list name is silent', () => {
    expect(findingsFor('vuex')).toEqual([]);
    expect(findingsFor('nuxt')).toEqual([]);
  });

  test('a corpus-known name that resembles nothing popular is silent', () => {
    expect(findingsFor('my-real-dep')).toEqual([]);
  });
});

describe('typosquatCheck: transform rules', () => {
  test('a separator swap matches the top-list name', () => {
    const findings = findingsFor('react_dom');
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({
      matchedBy: 'separator-swap',
      target: 'react-dom',
    });
  });

  test('a flattened scope matches the scoped top-list name', () => {
    const findings = findingsFor('babel-core');
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({
      matchedBy: 'scope-flattening',
      target: '@babel/core',
    });
  });

  test('a second flattened scope pair matches as well', () => {
    const findings = findingsFor('types-node');
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({
      matchedBy: 'scope-flattening',
      target: '@types/node',
    });
  });

  test('a scoped name flattens onto an unscoped top-list name', () => {
    const findings = findingsFor('@react/dom');
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({
      matchedBy: 'scope-flattening',
      target: 'react-dom',
    });
  });

  test('a repeated character collapses onto the top-list name', () => {
    const findings = findingsFor('reeact');
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({
      matchedBy: 'character-repetition',
      target: 'react',
    });
  });

  test('a trailing repeated character collapses too', () => {
    const findings = findingsFor('lodashh');
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({
      matchedBy: 'character-repetition',
      target: 'lodash',
    });
  });

  // Two adjacent characters swapped is distance 2 under plain Levenshtein,
  // so a six-character name like "lodahs" would fall outside its own band;
  // the transform rule is what catches it.
  test('an adjacent transposition matches within a short name', () => {
    const findings = findingsFor('lodahs');
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({
      matchedBy: 'character-transposition',
      target: 'lodash',
    });
  });

  test('the react transposition matches as well', () => {
    const findings = findingsFor('raect');
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({
      matchedBy: 'character-transposition',
      target: 'react',
    });
  });

  test('a transposition in a long name matches as a transform rather than a distance-2 hit', () => {
    const findings = findingsFor('typescirpt');
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({
      matchedBy: 'character-transposition',
      target: 'typescript',
    });
  });

  test('a neighbouring key substitution matches on QWERTY', () => {
    const findings = findingsFor('reqct');
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({
      matchedBy: 'keyboard-adjacency',
      target: 'react',
    });
  });

  test('a substitution by a key nowhere near the original is not an adjacency hit', () => {
    const findings = findingsFor('repct');
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({ matchedBy: 'edit-distance', target: 'react' });
  });
});

describe('typosquatCheck: banded distance', () => {
  test('an omitted character is a distance-1 hit', () => {
    const findings = findingsFor('rect');
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({
      matchedBy: 'edit-distance',
      target: 'react',
      distance: 1,
    });
  });

  test('a long name is matched at distance 2', () => {
    const findings = findingsFor('comandr');
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({
      matchedBy: 'edit-distance',
      target: 'commander',
      distance: 2,
    });
  });

  test('a long name at distance 1 also matches', () => {
    const findings = findingsFor('typescrpt');
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({ target: 'typescript', distance: 1 });
  });

  test('a short name at distance 2 is out of band and silent', () => {
    expect(findingsFor('chulks')).toEqual([]);
  });

  // Matching coverage for a target under IMPRECISE_TARGET_LENGTH's old
  // floor (now retired from severity, but the matching itself still has
  // to fire): a three-character target is the tightest case
  // sameScopeTails and the short-name band have to handle correctly for
  // an UNSCOPED name, where nameScope is null and the comparison runs on
  // the full string rather than a tail.
  test('a distance hit on a short unscoped target still matches', () => {
    const findings = findingsFor('hue');
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({ matchedBy: 'edit-distance', target: 'vue' });
  });

  test('a keyboard-adjacency hit on a short unscoped target still matches', () => {
    const findings = findingsFor('due');
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({ matchedBy: 'keyboard-adjacency', target: 'vue' });
  });
});

// "@types/co" vs "@types/ms" is really "co" against "ms": an identical
// scope contributes nothing to how different the names are, so comparing
// the full nine-character string scores a two-character tail as though it
// were a long name, and at distance 2 that means any two-character tail
// matches any other.
describe('typosquatCheck: scoped names compare on the differing tail', () => {
  const scopedCorpus = writeCorpus(['@types/ms', 'react', 'vue']);

  test('a two-character tail two edits from another top-list tail under the same scope is not reported', () => {
    // This is the exact repro against jest's real dependency tree:
    // "@types/co" was reported as a typosquat of "@types/ms". Once the
    // comparison runs on the tail ("co" vs "ms"), the short-tail band
    // (maxK 1, same as any other <= 6 character name) excludes a
    // distance-2 pair outright, the way it already would for the
    // unscoped "co" against "ms".
    const findings = findingsFor('@types/co', { corpus: scopedCorpus });
    expect(findings).toEqual([]);
  });

  test('a one-edit tail under the same scope still matches', () => {
    // 'p' and 'm' are not QWERTY neighbours, so this reaches distanceMatch
    // rather than keyboardMatch.
    const findings = findingsFor('@types/ps', { corpus: scopedCorpus });
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({
      matchedBy: 'edit-distance',
      target: '@types/ms',
      distance: 1,
    });
  });

  // 'n' and 'm' are QWERTY neighbours, so this is a keyboard-adjacency
  // match rather than a plain distance-1 one -- the tail comparison has to
  // apply to that rule too, not just edit-distance.
  test('a keyboard-adjacency tail hit under the same scope also matches', () => {
    const findings = findingsFor('@types/ns', { corpus: scopedCorpus });
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({ matchedBy: 'keyboard-adjacency' });
  });

  test('a same-scope transform (not edit-distance or keyboard) matches on a short tail', () => {
    // "sm" is an adjacent transposition of "ms".
    const findings = findingsFor('@types/sm', { corpus: scopedCorpus });
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({
      matchedBy: 'character-transposition',
      target: '@types/ms',
    });
  });

  test('a different scope with the identical short tail is not tail-compared', () => {
    // Only the scope differs (an extra "x" in "typesx" vs "types"); the
    // tail "ms" is identical on both sides. Because the scopes are not the
    // same, this must still be judged as the full-length strings, exactly
    // as before the fix -- not tail-compared just because the shared
    // suffix happens to be short. ("typesx" is not a QWERTY neighbour
    // substitution of "types" at any single position and the lengths
    // differ, so this reaches distanceMatch rather than keyboardMatch.)
    const findings = findingsFor('@typesx/ms', { corpus: scopedCorpus });
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({
      matchedBy: 'edit-distance',
      target: '@types/ms',
      distance: 1,
    });
  });
});

// Confidence, not proximity or target rank, decides severity: see
// severityFor in typosquat.ts. The alias list is 48 curated pairs from
// documented registry incidents and stays blocking; every other rule here
// is resemblance, measured against nine well maintained public
// repositories at three false positives and zero true positives, so it
// reports low -- visible to an auditor, out of the default gate.
describe('typosquatCheck: severity by confidence', () => {
  test('an alias-list match is critical', () => {
    expect(findingsFor('unused-imports')[0].severity).toBe('critical');
  });

  test.each([
    ['separator-swap', 'react_dom'],
    ['scope-flattening', 'babel-core'],
    ['character-repetition', 'reeact'],
    ['character-transposition', 'raect'],
    ['keyboard-adjacency', 'reqct'],
    ['edit-distance', 'rect'],
  ])('a %s match is low, however close the resemblance', (rule, name) => {
    const findings = findingsFor(name);
    expect(findings).toHaveLength(1);
    expect(findings[0].details).toMatchObject({ matchedBy: rule });
    expect(findings[0].severity).toBe('low');
  });

  // Target rank still travels in details, unused by severity today, kept
  // for the popularity-asymmetry work deferred to 0.2.0 (see INVARIANTS.md
  // and TODO.local.md).
  test('a match against a top-1000 target still records its rank', () => {
    const findings = findingsFor('pkg-0500x', { corpus: deepCorpus });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('low');
    expect(findings[0].details).toMatchObject({ target: 'pkg-0500', targetRank: 500 });
  });

  // Matching coverage against a popularity list past the 50-name fixture:
  // buildTopIndex's separatorForms/flattenedScopes maps are populated once
  // per check run, first-writer-wins in rank order, and every other test
  // in this file runs against the tiny fixture, which cannot exercise a
  // regression that only shows up once the list is large. A transform
  // match at a rank past the fixture's own size (deepCorpus goes to 1300)
  // exercises that the maps are actually built correctly at scale, not
  // just for the first few entries.
  test('a transform match still fires against a target deep in a large popularity list', () => {
    const findings = findingsFor('pkg_1200', { corpus: deepCorpus });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('low');
    expect(findings[0].details).toMatchObject({
      matchedBy: 'separator-swap',
      target: 'pkg-1200',
      targetRank: 1200,
    });
  });
});

describe('typosquatCheck: scope of the check', () => {
  test('an exact allow entry silences the finding', () => {
    const findings = typosquatCheck(
      makeContext([makeChange({ name: 'raect' })], { config: { allow: ['raect'] } })
    );
    expect(findings).toEqual([]);
  });

  test('a scope allow pattern silences the finding', () => {
    const findings = typosquatCheck(
      makeContext([makeChange({ name: '@react/dom' })], { config: { allow: ['@react/*'] } })
    );
    expect(findings).toEqual([]);
  });

  test('a changed registry dependency is not checked', () => {
    const findings = typosquatCheck(makeContext([makeChange({ name: 'raect', kind: 'changed' })]));
    expect(findings).toEqual([]);
  });

  // A retargeted alias installs a different package under the same
  // manifest key, so the new target is judged even though the key is not
  // new.
  test('a changed alias dependency is checked by its new registry name', () => {
    const findings = typosquatCheck(
      makeContext([
        makeChange({
          name: 'react',
          registryName: 'raect',
          kind: 'changed',
          protocol: 'alias',
          specifier: 'npm:raect@1.0.0',
        }),
      ])
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].packageName).toBe('raect');
    expect(findings[0].details).toMatchObject({ matchedBy: 'character-transposition' });
  });

  test('a workspace-protocol dependency is not checked', () => {
    const findings = typosquatCheck(
      makeContext([makeChange({ name: 'raect', protocol: 'workspace', specifier: 'workspace:*' })])
    );
    expect(findings).toEqual([]);
  });

  // A workspace-local package (an npm sibling, marked in the delta rather
  // than by protocol -- see candidates.ts) is never installed from a
  // registry, so it cannot be a typosquat of anything on the popularity
  // list, however close the two names happen to look.
  test('a workspace-local name is not checked, even one edit from a top-list name', () => {
    const findings = typosquatCheck(
      makeContext([makeChange({ name: 'raect', specifier: '^1.0.0' })], {
        workspaceLocalNames: new Set(['raect']),
      })
    );
    expect(findings).toEqual([]);
  });

  test('an alias dependency is checked by its registry name', () => {
    const findings = typosquatCheck(
      makeContext([
        makeChange({
          name: 'react',
          registryName: 'raect',
          protocol: 'alias',
          specifier: 'npm:raect@1.0.0',
        }),
      ])
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].packageName).toBe('raect');
  });

  test('an empty registry name produces a diagnostic instead of a finding', () => {
    const context = makeContext([
      makeChange({ name: 'broken-alias', registryName: '', protocol: 'alias', specifier: 'npm:' }),
    ]);
    expect(typosquatCheck(context)).toEqual([]);
    expect(context.diagnostics).toHaveLength(1);
    expect(context.diagnostics[0].code).toBe('manifest-alias-empty');
    expect(context.diagnostics[0].message).toContain('broken-alias');
  });

  test('the same name in two sections of one manifest is one finding', () => {
    const changes = [
      makeChange({ name: 'raect' }),
      makeChange({ name: 'raect', depType: 'devDependencies' }),
    ];
    expect(typosquatCheck(makeContext(changes))).toHaveLength(1);
  });

  test('several squatted names each get their own finding', () => {
    const changes = [makeChange({ name: 'raect' }), makeChange({ name: 'lodahs' })];
    const findings = typosquatCheck(makeContext(changes));
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.packageName)).toEqual(['raect', 'lodahs']);
  });

  test('an empty delta produces nothing', () => {
    expect(typosquatCheck(makeContext([]))).toEqual([]);
  });

  // Every rule is candidate generation or a banded scan, both linear in the
  // name length; a very long dependency name must not turn into a stall.
  test('a pathological dependency name is checked quickly', () => {
    const name = `${'a-'.repeat(4000)}z`;
    const started = Date.now();
    expect(typosquatCheck(makeContext([makeChange({ name })]))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
