// Candidate names an online step was meant to look up and did not get a
// definitive answer for (docs/design/2026-10-18-head-defined-projects-and-
// ignore-paths.md, section 8). Only "it exists" or a 404 is a checked name.
// Every other outcome a step can meet is one of three reasons:
//
//   - budget: the run's online budget was spent before the name came up;
//   - unreachable: an answer the npm or PyPI client counts as unreachable
//     (a network error, a timeout, a 5xx after the retry, a 429, any other
//     4xx except 404, and on PyPI only a 3xx or a 2xx naming another
//     project), with the HTTP status where one is known;
//   - online-disabled: online lookups were turned off on the command line
//     while the config that governs the run requires them.
//
// On a --base or --trust-base run any such name is a could-not-run (exit
// 2) unless the governing config sets "onlineUnchecked": "note". On a plain
// or audit run the names are reported and nothing else changes.

export type UncheckedReason = 'budget' | 'unreachable' | 'online-disabled';

export type OnlineStep = 'unknown-package' | 'pypi-existence' | 'asymmetry' | 'registered-squat' | 'publish-age';

export interface UncheckedName {
  name: string;
  ecosystem: 'npm' | 'pypi';
  step: OnlineStep;
  reason: UncheckedReason;
  status?: number;
}

export type UncheckedSink = (entry: UncheckedName) => void;

export const ONLINE_NAMES_UNCHECKED = 'online-names-unchecked';

const MAX_LISTED = 10;

// The HTTP status a client error carries, when it carries one.
export function errorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

export function unreachable(
  name: string,
  ecosystem: 'npm' | 'pypi',
  step: OnlineStep,
  err: unknown
): UncheckedName {
  const status = errorStatus(err);
  return { name, ecosystem, step, reason: 'unreachable', ...(status === undefined ? {} : { status }) };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// One entry per name, ecosystem and step, sorted, so the list is the same
// on every run that met the same outcomes.
export function settleUnchecked(entries: readonly UncheckedName[]): UncheckedName[] {
  const byKey = new Map<string, UncheckedName>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.ecosystem, entry.name, entry.step]);
    if (!byKey.has(key)) {
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort(
    (left, right) =>
      compare(left.name, right.name) ||
      compare(left.ecosystem, right.ecosystem) ||
      compare(left.step, right.step)
  );
}

function reasonText(entry: UncheckedName): string {
  if (entry.reason === 'budget') {
    return `online budget spent (${entry.step})`;
  }
  if (entry.reason === 'online-disabled') {
    return 'online lookups disabled on the command line while the base config requires them';
  }
  return `registry unreachable${entry.status === undefined ? '' : `, HTTP ${entry.status}`} (${entry.step})`;
}

// The could-not-run line: the text report prints it after the findings,
// stderr carries it with its code, and the JSON carries it as
// run.couldNotRun.message. It counts distinct names (one name two steps
// left unchecked is one name), each with every step's reason; ten names at
// most, then a count. The per-step entries are run.online.unchecked.names.
export function uncheckedMessage(entries: readonly UncheckedName[]): string {
  const byName = new Map<string, { name: string; reasons: string[] }>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.ecosystem, entry.name]);
    const grouped = byName.get(key) ?? { name: entry.name, reasons: [] };
    grouped.reasons.push(reasonText(entry));
    byName.set(key, grouped);
  }
  const names = [...byName.values()];
  const shown = names
    .slice(0, MAX_LISTED)
    .map((grouped) => `${grouped.name}: ${[...new Set(grouped.reasons)].join('; ')}`);
  const rest = names.length - shown.length;
  const list = rest > 0 ? `${shown.join(', ')}, and ${rest} more` : shown.join(', ');
  return (
    `could not run: ${names.length} candidate name(s) were not checked online (${list}). ` +
    'A pull-request run does not pass a name it could not check: raise onlineBudgetMs, re-run once ' +
    'the registry answers, or set "onlineUnchecked": "note" on the base branch'
  );
}
