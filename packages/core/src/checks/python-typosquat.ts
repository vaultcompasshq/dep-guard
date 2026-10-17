// Python typosquat, without a corpus.
//
// No list of popular PyPI projects ships: a short shipped list would be a
// popularity list held to none of the safeguards docs/INVARIANTS.md ("The
// popularity list is a trust input") demands of one. So a new Python name
// is compared, with the same transform rules and banded distance the npm
// check uses, against the OTHER normalised Python names the repository
// itself declares: every Python manifest and lockfile on the judged side,
// and on a comparison run every Python name the comparison side declared.
// It catches the edit an agent actually makes ("requests" rewritten to
// "reqeusts" in one file while the base still has "requests") and misses a
// typo of any project the repository does not already name, which only the
// online existence check can catch, and only when the typo is not itself a
// registered project.
//
// Severity is low, the npm resemblance severity: outside the default gate,
// because resemblance between two real neighbouring projects ("boto" and
// "boto3", "attr" and "attrs") is a false positive this rule cannot rule
// out. An exact normalised match is never a typosquat: two spellings that
// normalise alike are one project, which is dedupe, not a finding. Names
// are compared normalised, so a separator swap cannot fire here.
//
// When both names of a resembling pair are new (an audit run sees every
// name as new), the pair is reported once: against the name the comparison
// side already declared, else the one declared at more places, else the
// lexicographically first, so the same tree always gives the same finding.

import { bandedDistance } from '../levenshtein.js';
import { pypiDisplayName } from '../python-names.js';
import type { Finding } from '../types.js';
import { pypiAllowClears } from './allow.js';
import { newNames } from './candidates.js';
import { KEYBOARD_NEIGHBOURS, MIN_RESEMBLANCE_TARGET_LENGTH } from './typosquat.js';
import type { Check } from './types.js';

const SHORT_NAME_MAX_LENGTH = 6;

type PythonMatchRule = 'character-repetition' | 'character-transposition' | 'keyboard-adjacency' | 'edit-distance';

interface PythonMatch {
  rule: PythonMatchRule;
  target: string;
  distance?: number;
}

function collapseRuns(name: string): string {
  let collapsed = '';
  for (let index = 0; index < name.length; index += 1) {
    if (index === 0 || name.charCodeAt(index) !== name.charCodeAt(index - 1)) {
      collapsed += name[index];
    }
  }
  return collapsed;
}

function repetition(name: string, known: ReadonlySet<string>): string | null {
  const collapsed = collapseRuns(name);
  if (collapsed !== name && known.has(collapsed)) {
    return collapsed;
  }
  for (let position = 1; position < name.length; position += 1) {
    if (name.charCodeAt(position) !== name.charCodeAt(position - 1)) {
      continue;
    }
    const candidate = name.slice(0, position) + name.slice(position + 1);
    if (known.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function transposition(name: string, known: ReadonlySet<string>): string | null {
  for (let position = 1; position < name.length; position += 1) {
    if (name.charCodeAt(position) === name.charCodeAt(position - 1)) {
      continue;
    }
    const candidate = name.slice(0, position - 1) + name[position] + name[position - 1] + name.slice(position + 1);
    if (known.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function keyboard(name: string, known: ReadonlySet<string>): string | null {
  for (let position = 0; position < name.length; position += 1) {
    const near = KEYBOARD_NEIGHBOURS.get(name[position] ?? '');
    if (near === undefined) {
      continue;
    }
    const head = name.slice(0, position);
    const tail = name.slice(position + 1);
    for (const key of near) {
      const candidate = `${head}${key}${tail}`;
      if (known.has(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function distance(name: string, known: readonly string[]): PythonMatch | null {
  const maxK: 1 | 2 = name.length <= SHORT_NAME_MAX_LENGTH ? 1 : 2;
  let best: PythonMatch | null = null;
  let bestDistance = maxK + 1;
  for (const target of known) {
    const gap = target.length - name.length;
    if (gap > maxK || -gap > maxK) {
      continue;
    }
    const found = bandedDistance(name, target, maxK);
    if (found === null || found === 0) {
      continue;
    }
    if (found < bestDistance || (found === bestDistance && best !== null && target < best.target)) {
      bestDistance = found;
      best = { rule: 'edit-distance', target, distance: found };
    }
  }
  return best;
}

export function matchPythonName(name: string, others: ReadonlySet<string>): PythonMatch | null {
  // The exact normalised name is never its own target.
  const known = new Set([...others].filter((other) => other.length >= MIN_RESEMBLANCE_TARGET_LENGTH));
  known.delete(name);
  if (known.size === 0) {
    return null;
  }
  const repeated = repetition(name, known);
  if (repeated !== null) {
    return { rule: 'character-repetition', target: repeated };
  }
  const transposed = transposition(name, known);
  if (transposed !== null) {
    return { rule: 'character-transposition', target: transposed };
  }
  const neighbour = keyboard(name, known);
  if (neighbour !== null) {
    return { rule: 'keyboard-adjacency', target: neighbour };
  }
  return distance(name, [...known].sort());
}

function describe(rule: PythonMatchRule): string {
  switch (rule) {
    case 'character-repetition':
      return 'is a repeated-character variant of';
    case 'character-transposition':
      return 'transposes two characters of';
    case 'keyboard-adjacency':
      return 'differs by one neighbouring keyboard key from';
    case 'edit-distance':
      return 'is a near-miss of';
  }
}

export const pythonTyposquatCheck: Check = (ctx) => {
  const python = ctx.delta.python;
  if (python === undefined) {
    return [];
  }
  const candidates = newNames(ctx).pypi;
  if (candidates.length === 0) {
    return [];
  }
  const known = new Set<string>([...python.judgedNames, ...python.comparisonNames]);
  const newSet = new Set(candidates.map((candidate) => candidate.name));
  const anchorCount = new Map<string, number>();
  for (const candidate of candidates) {
    anchorCount.set(candidate.name, (anchorCount.get(candidate.name) ?? 0) + 1);
  }
  // Which of two new names stands as the target when they resemble each
  // other (see the note at the top).
  const outranks = (target: string, name: string): boolean => {
    const targetOld = python.comparisonNames.has(target);
    const nameOld = python.comparisonNames.has(name);
    if (targetOld !== nameOld) {
      return targetOld;
    }
    const targetCount = anchorCount.get(target) ?? 0;
    const nameCount = anchorCount.get(name) ?? 0;
    if (targetCount !== nameCount) {
      return targetCount > nameCount;
    }
    return target < name;
  };

  const findings: Omit<Finding, 'fingerprint'>[] = [];
  const reported = new Set<string>();
  for (const candidate of candidates) {
    const match = matchPythonName(candidate.name, known);
    if (match === null) {
      continue;
    }
    if (newSet.has(match.target) && !python.comparisonNames.has(candidate.name) && !outranks(match.target, candidate.name)) {
      continue;
    }
    const key = JSON.stringify([candidate.anchorPath, candidate.name]);
    if (reported.has(key)) {
      continue;
    }
    reported.add(key);
    if (pypiAllowClears(ctx, candidate.name)) {
      continue;
    }
    const written = pypiDisplayName(candidate.written, candidate.name);
    findings.push({
      ruleId: 'typosquat',
      severity: 'low',
      packageName: candidate.name,
      message:
        `${written} ${describe(match.rule)} "${match.target}", another Python name this repository declares. ` +
        'Confirm the name is the project you meant to install.',
      manifestPath: candidate.anchorPath,
      details: {
        ecosystem: 'pypi',
        comparedAgainst: 'repository',
        matchedBy: match.rule,
        target: match.target,
        writtenName: candidate.written,
        specifier: candidate.specifier,
        depType: candidate.depType,
        ...(match.distance === undefined ? {} : { distance: match.distance }),
      },
    });
  }
  return findings;
};
