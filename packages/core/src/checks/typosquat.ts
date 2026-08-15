import type { Corpus } from '../corpus.js';
import { bandedDistance } from '../levenshtein.js';
import type { Finding, Severity } from '../types.js';
import { newRegistryNames } from './candidates.js';
import type { Check, CheckContext } from './types.js';

// Typosquat detection against the shipped popularity list.
//
// Raw edit distance alone is too noisy at distance 2, so the check is a
// fixed priority order and the first rule that hits is the one that
// reports:
//
//   1. the alias list (curated pairs plus the user's extraAliases) --
//      these are known confusions, not guesses, so they are critical;
//   2. membership in the popularity list itself -- a package that IS
//      popular is never a squat of another popular package, which is what
//      keeps 'vuex' from being reported as 'vue';
//   3. transform rules, which have better precision than distance:
//      separator swap, scope flattening, repeated character, adjacent
//      transposition, neighbouring key;
//   4. banded edit distance, tight for short names where one edit is a
//      large fraction of the name.
//
// Rules 3 and 4 differ in how they search. A transform generates the few
// candidate strings it implies and looks each up by rank, which is O(name
// length); distance has to walk the popularity list, which is why the
// Corpus exposes it. Everything is loop-based with no regular expressions:
// package names are attacker-controlled.

const SHORT_NAME_MAX_LENGTH = 6;

type MatchRule =
  | 'alias-list'
  | 'separator-swap'
  | 'scope-flattening'
  | 'character-repetition'
  | 'character-transposition'
  | 'keyboard-adjacency'
  | 'edit-distance';

interface Match {
  rule: MatchRule;
  target: string;
  targetRank: number | null;
  distance?: number;
}

// Derived views of the popularity list, built once per check run.
interface TopIndex {
  // Lengths present in the list. Every transform rule either preserves the
  // name's length or shortens it by one, so a name whose length (or length
  // minus one) is absent here cannot match any of them -- which is what
  // keeps an absurdly long dependency name from generating thousands of
  // candidate strings for nothing.
  lengths: Set<number>;
  separatorForms: Map<string, string>;
  flattenedScopes: Map<string, string>;
}

// Approximate QWERTY adjacency: same row left and right, plus the three
// keys above and below at the same column. Real keyboards stagger their
// rows, so this over-reaches by about one key in each direction; for a
// detector that only ever proposes a same-length neighbour that has to
// land exactly on a popular package name, over-reaching costs nothing and
// missing a neighbour costs a detection.
const KEYBOARD_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

function buildKeyboardNeighbours(): Map<string, string[]> {
  const neighbours = new Map<string, string[]>();
  for (let row = 0; row < KEYBOARD_ROWS.length; row += 1) {
    const keys = KEYBOARD_ROWS[row];
    for (let column = 0; column < keys.length; column += 1) {
      const near: string[] = [];
      for (let otherRow = row - 1; otherRow <= row + 1; otherRow += 1) {
        if (otherRow < 0 || otherRow >= KEYBOARD_ROWS.length) {
          continue;
        }
        const otherKeys = KEYBOARD_ROWS[otherRow];
        for (let otherColumn = column - 1; otherColumn <= column + 1; otherColumn += 1) {
          if (otherColumn < 0 || otherColumn >= otherKeys.length) {
            continue;
          }
          if (otherRow === row && otherColumn === column) {
            continue;
          }
          near.push(otherKeys[otherColumn]);
        }
      }
      neighbours.set(keys[column], near);
    }
  }
  return neighbours;
}

const KEYBOARD_NEIGHBOURS = buildKeyboardNeighbours();

// '-' and '_' are the two separators npm names use interchangeably.
// Written as split/join rather than a replace with a pattern so no regular
// expression touches a package name.
function normalizeSeparators(name: string): string {
  return name.split('_').join('-');
}

// '@babel/core' and 'babel-core' are the same words with different
// punctuation; flattening puts them in one form. Returns null for a name
// that is not scoped.
function flattenScope(name: string): string | null {
  if (!name.startsWith('@')) {
    return null;
  }
  const slash = name.indexOf('/');
  if (slash <= 1 || slash === name.length - 1) {
    return null;
  }
  return `${name.slice(1, slash)}-${name.slice(slash + 1)}`;
}

// A scoped name split at its first slash, e.g. "@types/ms" -> { scope:
// "@types", tail: "ms" }. Returns null for a name that is not scoped --
// the same shape flattenScope already parses, kept as a second function
// rather than reused because flattenScope answers a different question
// (the hyphen-joined flattened form) and has its own null cases baked in.
function splitScope(name: string): { scope: string; tail: string } | null {
  if (!name.startsWith('@')) {
    return null;
  }
  const slash = name.indexOf('/');
  if (slash <= 1 || slash === name.length - 1) {
    return null;
  }
  return { scope: name.slice(0, slash), tail: name.slice(slash + 1) };
}

// When `name` and `target` are both scoped under the IDENTICAL scope, the
// scope contributes nothing to how different the two names are -- nobody
// mistypes "@types/" itself, and every edit that matters sits in the part
// after the slash. Comparing (and sizing the short-target floor against)
// the full string then scores a short tail as though it were the whole,
// longer name: "@types/co" against "@types/ms" is really "co" against
// "ms", and at distance 2 that means any two-character tail matches any
// other. Returns null for an unscoped name or a pair under different
// scopes, which are compared exactly as they were before this existed --
// a scope mismatch is itself part of what makes the two names different,
// so it stays inside the comparison rather than being stripped from it.
function sameScopeTails(name: string, target: string): { nameTail: string; targetTail: string } | null {
  const nameScope = splitScope(name);
  const targetScope = splitScope(target);
  if (nameScope === null || targetScope === null || nameScope.scope !== targetScope.scope) {
    return null;
  }
  return { nameTail: nameScope.tail, targetTail: targetScope.tail };
}

function buildTopIndex(corpus: Corpus): TopIndex {
  const lengths = new Set<number>();
  const separatorForms = new Map<string, string>();
  const flattenedScopes = new Map<string, string>();

  // Rank order, so the first writer of any key is the most popular name
  // that maps to it.
  for (const top of corpus.topNames) {
    lengths.add(top.length);

    const separatorForm = normalizeSeparators(top);
    if (!separatorForms.has(separatorForm)) {
      separatorForms.set(separatorForm, top);
    }

    const flattened = flattenScope(top);
    if (flattened !== null && !flattenedScopes.has(flattened)) {
      flattenedScopes.set(flattened, top);
    }
  }

  return { lengths, separatorForms, flattenedScopes };
}

function probe(name: string, candidate: string, rule: MatchRule, corpus: Corpus): Match | null {
  if (candidate === name) {
    return null;
  }
  const targetRank = corpus.topRank(candidate);
  if (targetRank === null) {
    return null;
  }
  return { rule, target: candidate, targetRank };
}

function aliasMatch(name: string, ctx: CheckContext): Match | null {
  const targets: string[] = [];
  const seen = new Set<string>();

  const push = (target: string): void => {
    if (typeof target !== 'string' || target.length === 0 || seen.has(target)) {
      return;
    }
    seen.add(target);
    targets.push(target);
  };

  for (const target of ctx.corpus.aliasTargets(name)) {
    push(target);
  }

  // hasOwn keeps a dependency literally named 'constructor' or '__proto__'
  // from picking up an inherited Object.prototype member, and Array.isArray
  // keeps a hand-edited config from feeding a non-list through (config.ts's
  // loader validates the shape, but this check must not depend on that to
  // stay memory-safe).
  const configured = ctx.config.extraAliases;
  if (Object.hasOwn(configured, name)) {
    const extra = configured[name];
    if (Array.isArray(extra)) {
      for (const target of extra) {
        push(target);
      }
    }
  }

  if (targets.length === 0) {
    return null;
  }
  return {
    rule: 'alias-list',
    target: targets[0],
    targetRank: ctx.corpus.topRank(targets[0]),
  };
}

function separatorMatch(name: string, corpus: Corpus, index: TopIndex): Match | null {
  if (!index.lengths.has(name.length)) {
    return null;
  }
  const target = index.separatorForms.get(normalizeSeparators(name));
  if (target === undefined) {
    return null;
  }
  return probe(name, target, 'separator-swap', corpus);
}

function scopeMatch(name: string, corpus: Corpus, index: TopIndex): Match | null {
  // '@react/dom' flattens onto the unscoped 'react-dom'.
  const flattened = flattenScope(name);
  if (flattened !== null && index.lengths.has(flattened.length)) {
    const match = probe(name, flattened, 'scope-flattening', corpus);
    if (match !== null) {
      return match;
    }
  }
  // 'babel-core' is the flattened form of the scoped '@babel/core'.
  const scoped = index.flattenedScopes.get(name);
  if (scoped !== undefined) {
    return probe(name, scoped, 'scope-flattening', corpus);
  }
  return null;
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

// 'reeact' and 'lodashh' doubled a character; both the fully collapsed form
// and each single-run reduction are tried, so a name with one legitimate
// double letter plus one typed one still lands.
function repetitionMatch(name: string, corpus: Corpus, index: TopIndex): Match | null {
  const collapsed = collapseRuns(name);
  if (collapsed.length === name.length) {
    return null; // no repeated characters at all
  }
  if (index.lengths.has(collapsed.length)) {
    const match = probe(name, collapsed, 'character-repetition', corpus);
    if (match !== null) {
      return match;
    }
  }
  if (!index.lengths.has(name.length - 1)) {
    return null;
  }
  for (let position = 1; position < name.length; position += 1) {
    if (name.charCodeAt(position) !== name.charCodeAt(position - 1)) {
      continue;
    }
    const candidate = name.slice(0, position) + name.slice(position + 1);
    const match = probe(name, candidate, 'character-repetition', corpus);
    if (match !== null) {
      return match;
    }
  }
  return null;
}

// 'lodahs' for 'lodash'. Plain Levenshtein charges 2 for a transposition,
// so on a short name the distance band would miss it entirely; this is the
// rule that catches the single most common typo shape.
function transpositionMatch(name: string, corpus: Corpus, index: TopIndex): Match | null {
  if (!index.lengths.has(name.length)) {
    return null;
  }
  for (let position = 1; position < name.length; position += 1) {
    if (name.charCodeAt(position) === name.charCodeAt(position - 1)) {
      continue;
    }
    const candidate =
      name.slice(0, position - 1) + name[position] + name[position - 1] + name.slice(position + 1);
    const match = probe(name, candidate, 'character-transposition', corpus);
    if (match !== null) {
      return match;
    }
  }
  return null;
}

// 'reqct' for 'react': one character replaced by a key next to it.
function keyboardMatch(name: string, corpus: Corpus, index: TopIndex): Match | null {
  if (!index.lengths.has(name.length)) {
    return null;
  }
  for (let position = 0; position < name.length; position += 1) {
    const near = KEYBOARD_NEIGHBOURS.get(name[position]);
    if (near === undefined) {
      continue;
    }
    const head = name.slice(0, position);
    const tail = name.slice(position + 1);
    for (const key of near) {
      const match = probe(name, `${head}${key}${tail}`, 'keyboard-adjacency', corpus);
      if (match !== null) {
        return match;
      }
    }
  }
  return null;
}

// One edit is a much bigger deal in a six-character name than in a
// sixteen-character one, so short names get the tighter band. When name
// and a candidate target share an identical scope, that sizing (and the
// distance itself) runs on the part after the slash instead of the whole
// string -- see sameScopeTails -- since the scope cannot be what makes
// them differ. A tail is always shorter than the name it came from, so
// its band can only ever be as tight or tighter than the full-string one,
// which is what keeps bestDistance's initial sentinel (sized off the
// full-string band) a safe upper bound across every candidate.
function distanceMatch(name: string, corpus: Corpus): Match | null {
  const maxK: 1 | 2 = name.length <= SHORT_NAME_MAX_LENGTH ? 1 : 2;
  let best: Match | null = null;
  let bestDistance = maxK + 1;

  const top = corpus.topNames;
  for (let index = 0; index < top.length; index += 1) {
    const target = top[index];
    const shared = sameScopeTails(name, target);
    const compareName = shared === null ? name : shared.nameTail;
    const compareTarget = shared === null ? target : shared.targetTail;
    const compareMaxK: 1 | 2 =
      shared === null ? maxK : compareName.length <= SHORT_NAME_MAX_LENGTH ? 1 : 2;
    const gap = compareTarget.length - compareName.length;
    if (gap > compareMaxK || -gap > compareMaxK) {
      continue;
    }
    const distance = bandedDistance(compareName, compareTarget, compareMaxK);
    if (distance === null || distance === 0) {
      continue;
    }
    // The list is in rank order, so a strict improvement is the only
    // reason to move: ties keep the more popular target.
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { rule: 'edit-distance', target, targetRank: index + 1, distance };
      if (distance === 1) {
        break; // nothing closer is possible, and rank order already won
      }
    }
  }

  return best;
}

function matchName(name: string, ctx: CheckContext, index: TopIndex): Match | null {
  const alias = aliasMatch(name, ctx);
  if (alias !== null) {
    return alias;
  }

  // A popular package is never a squat of another popular package.
  if (ctx.corpus.topRank(name) !== null) {
    return null;
  }

  return (
    separatorMatch(name, ctx.corpus, index) ??
    scopeMatch(name, ctx.corpus, index) ??
    repetitionMatch(name, ctx.corpus, index) ??
    transpositionMatch(name, ctx.corpus, index) ??
    keyboardMatch(name, ctx.corpus, index) ??
    distanceMatch(name, ctx.corpus)
  );
}

// Confidence, not proximity, decides severity. The alias list is 48 pairs
// curated from documented registry incidents -- each one a known confusion,
// not a guess -- so it keeps the blocking severity a squat deserves.
//
// Every other rule here, distance and transform alike, is resemblance: it
// says two names look alike, not that either has ever been confused with
// the other in practice. The dogfood harness measured what that is worth
// against nine well maintained public repositories -- three findings, all
// of them false positives (a fork resembling what it forks, a deliberate
// sibling pair, a maintained fork of a popular package), zero true
// positives. That precision is not acceptable at a severity that blocks an
// install, so every non-alias match reports low: visible to an auditor, out
// of the default gate. See the README for how this is expected to change
// once popularity asymmetry data lets a resemblance rule tell "unpopular"
// from "merely absent from the list" (0.2.0).
function severityFor(match: Match): Severity {
  return match.rule === 'alias-list' ? 'critical' : 'low';
}

function describe(rule: MatchRule): string {
  switch (rule) {
    case 'alias-list':
      return 'is a known point of confusion with';
    case 'separator-swap':
      return 'differs only in its separators from';
    case 'scope-flattening':
      return 'differs only in its scoping from';
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

export const typosquatCheck: Check = (ctx) => {
  const candidates = newRegistryNames(ctx);
  if (candidates.length === 0) {
    return [];
  }

  const index = buildTopIndex(ctx.corpus);
  const findings: Omit<Finding, 'fingerprint'>[] = [];

  for (const { change, registryName } of candidates) {
    const match = matchName(registryName, ctx, index);
    if (match === null) {
      continue;
    }

    const rankNote = match.targetRank === null ? '' : ` (rank ${match.targetRank})`;
    const via = change.protocol === 'alias' ? ` (aliased by dependency "${change.name}")` : '';
    const details: Record<string, unknown> = {
      matchedBy: match.rule,
      target: match.target,
      targetRank: match.targetRank,
      specifier: change.specifier,
      depType: change.depType,
    };
    if (match.distance !== undefined) {
      details.distance = match.distance;
    }

    findings.push({
      ruleId: 'typosquat',
      severity: severityFor(match),
      packageName: registryName,
      message:
        `"${registryName}"${via} ${describe(match.rule)} "${match.target}"${rankNote}. ` +
        'Confirm the name is the package you meant to install.',
      manifestPath: change.manifestPath,
      details,
    });
  }

  return findings;
};
