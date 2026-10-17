import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BloomFilter } from '../src/bloom.js';
import { matchPythonName } from '../src/checks/python-typosquat.js';
import { MIN_RESEMBLANCE_TARGET_LENGTH, typosquatCheck } from '../src/checks/typosquat.js';
import type { CheckContext, ResolvedConfig } from '../src/checks/types.js';
import type { Corpus } from '../src/corpus.js';
import { loadCorpus } from '../src/corpus.js';
import type { Diagnostic } from '../src/types.js';

// A resemblance finding needs a target of at least three characters: a
// two-character name is within one edit of a great many others, and that is
// not evidence of a squat. The alias list is curated and exempt.

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

function writeCorpus(top: string[]): Corpus {
  const dir = mkdtempSync(path.join(tmpdir(), 'depguard-floor-'));
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

function findingsFor(name: string, corpus: Corpus, config: Partial<ResolvedConfig> = {}) {
  const ctx: CheckContext = {
    corpus,
    config: { ...BASE_CONFIG, ...config },
    delta: {
      changes: [
        {
          name,
          registryName: name,
          specifier: '^1.0.0',
          kind: 'added',
          depType: 'dependencies',
          protocol: 'registry',
          manifestPath: 'package.json',
        },
      ],
      lockEntryChanges: [],
      onlyBuiltAdded: [],
      lockfileFormat: 'npm',
      hasComparisonBase: true,
      workspaceLocalNames: new Set(),
      diagnostics: [],
    },
    npmrcRegistryPins: new Map<string, string>(),
    diagnostics: [] as Diagnostic[],
    allowed: [] as string[],
  };
  return typosquatCheck(ctx);
}

describe('typosquat length floor (npm)', () => {
  test('the floor is three', () => {
    expect(MIN_RESEMBLANCE_TARGET_LENGTH).toBe(3);
  });

  const shortCorpus = writeCorpus(['co', 'cos']);

  test.each([
    ['cn', 'edit distance'],
    ['oc', 'transposition'],
    ['cp', 'keyboard neighbour'],
    ['coo', 'repetition'],
    ['c-o', 'separator form'],
  ])('%s resembles a two-character target through %s and reports nothing', (name) => {
    expect(findingsFor(name, shortCorpus).filter((finding) => finding.details?.target === 'co')).toEqual([]);
  });

  test('a three-character target still reports', () => {
    const findings = findingsFor('cps', shortCorpus);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.details).toMatchObject({ target: 'cos' });
  });

  test('an alias to a two-character target still reports critical', () => {
    const findings = findingsFor('xx', shortCorpus, { extraAliases: { xx: ['co'] } });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('critical');
  });
});

describe('typosquat length floor (Python)', () => {
  test('a two-character Python name is not a resemblance target', () => {
    expect(matchPythonName('cn', new Set(['co']))).toBeNull();
    expect(matchPythonName('coo', new Set(['co']))).toBeNull();
    expect(matchPythonName('oc', new Set(['co']))).toBeNull();
  });

  test('a three-character Python name is', () => {
    expect(matchPythonName('cps', new Set(['cos']))).toMatchObject({ target: 'cos' });
  });
});
