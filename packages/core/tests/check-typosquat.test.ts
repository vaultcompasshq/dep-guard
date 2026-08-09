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
    expect(findings[0].severity).toBe('critical');
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
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details).toMatchObject({
      matchedBy: 'character-transposition',
      target: 'lodash',
    });
  });

  test('the react transposition matches as well', () => {
    const findings = findingsFor('raect');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details).toMatchObject({
      matchedBy: 'character-transposition',
      target: 'react',
    });
  });

  // A transposition in a long name would be distance 2, and therefore only
  // high, if the distance rule reached it first. Reporting it as a
  // transform instead is what makes it critical, so the escalation is
  // pinned deliberately rather than left to rule ordering.
  test('a transposition in a long name is critical rather than distance-2 high', () => {
    const findings = findingsFor('typescirpt');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details).toMatchObject({
      matchedBy: 'character-transposition',
      target: 'typescript',
    });
  });

  test('a neighbouring key substitution matches on QWERTY', () => {
    const findings = findingsFor('reqct');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
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
    expect(findings[0].severity).toBe('critical');
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

  test('a distance-2 hit is high rather than critical', () => {
    expect(findingsFor('comandr')[0].severity).toBe('high');
  });

  test('a long name at distance 1 is critical', () => {
    const findings = findingsFor('typescrpt');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details).toMatchObject({ target: 'typescript', distance: 1 });
  });

  test('a short name at distance 2 is out of band and silent', () => {
    expect(findingsFor('chulks')).toEqual([]);
  });
});

// One edit against a three-character target mutates a third of the name,
// so "hue" resembling "vue" is arithmetic rather than evidence. These stay
// visible but below the default gate; the precise rules (alias list and
// the transforms other than keyboard adjacency) are unaffected.
describe('typosquatCheck: short targets', () => {
  test('a distance hit on a short target is low', () => {
    const findings = findingsFor('hue');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('low');
    expect(findings[0].details).toMatchObject({ matchedBy: 'edit-distance', target: 'vue' });
  });

  test('a keyboard-adjacency hit on a short target is low', () => {
    const findings = findingsFor('due');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('low');
    expect(findings[0].details).toMatchObject({ matchedBy: 'keyboard-adjacency', target: 'vue' });
  });

  test('a precise transform on a short target keeps its severity', () => {
    const findings = findingsFor('vuee');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details).toMatchObject({
      matchedBy: 'character-repetition',
      target: 'vue',
    });
  });

  test('a distance hit on a five-character target is still critical', () => {
    expect(findingsFor('rect')[0].severity).toBe('critical');
  });
});

describe('typosquatCheck: severity by target rank', () => {
  test('a distance-1 hit on a top-1000 target is critical', () => {
    const findings = findingsFor('pkg-0500x', { corpus: deepCorpus });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details).toMatchObject({ target: 'pkg-0500', targetRank: 500 });
  });

  test('a distance-1 hit on a target past rank 1000 is high', () => {
    const findings = findingsFor('pkg-1200x', { corpus: deepCorpus });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('high');
    expect(findings[0].details).toMatchObject({ target: 'pkg-1200', targetRank: 1200 });
  });

  test('a transform hit on a top-1000 target is critical', () => {
    const findings = findingsFor('pkg_0500', { corpus: deepCorpus });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].details).toMatchObject({ matchedBy: 'separator-swap' });
  });

  test('a transform hit on a target past rank 1000 is high', () => {
    const findings = findingsFor('pkg_1200', { corpus: deepCorpus });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('high');
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
    expect(findings[0].severity).toBe('critical');
  });

  test('a workspace-protocol dependency is not checked', () => {
    const findings = typosquatCheck(
      makeContext([makeChange({ name: 'raect', protocol: 'workspace', specifier: 'workspace:*' })])
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
