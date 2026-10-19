// The PyPI existence check: the only existence check Python names have,
// offline or online, since no PyPI corpus ships.
//
// It is the second online step, after npm unknown-package resolution and
// before the three npm steps that add or escalate (scan.ts, enrichOnline),
// and it shares the run's one wall clock. It only ever appends findings: a
// 404 is a critical unknown-package, the same severity an npm 404 earns,
// because the registry has ruled out the innocent reading. Every other
// answer, and a spent budget, leaves the name unchecked, writes no finding,
// and is counted and named in a diagnostic: a registry problem is never a
// non-clean result.
//
// PyPI existence is asked live, never read from or written to the online
// cache: a stale "it exists" is most harmful for exactly the names a
// registry has since removed for security reasons, and a lockfile still
// pinning a project PyPI deleted is the case this check most wants to
// catch.
//
// Names are never sent when a "pypi:" internalPrefixes entry covers them,
// or when the manifest they are declared in names a package index other
// than PyPI (python-sources.ts, PythonIndexRule). A lockfile's recorded
// source skips an entry only when it equals such a declaration.

import { isPypiInternalName, pypiAllowClears } from '../checks/allow.js';
import type { PypiCandidate } from '../checks/candidates.js';
import type { CheckContext } from '../checks/types.js';
import { pypiDisplayName } from '../python-names.js';
import type { IndexSkip, PythonIndexRule } from '../python-sources.js';
import type { Diagnostic, Finding } from '../types.js';
import type { OnlineDeadline } from './deadline.js';
import { ONLINE_DEADLINE_CODE, deadlineDiagnosticMessage } from './deadline.js';
import type { PypiAnswer } from './pypi-client.js';
import { unreachable as unreachableName, type UncheckedSink } from './unchecked.js';

export const PYPI_CHECK_LABEL = 'pypi existence';
export const PYPI_PRIVATE_INDEX_SKIPPED = 'pypi-private-index-skipped';
const MAX_LISTED_NAMES = 10;

export interface PypiExistenceDeps {
  fetchPypiProject(name: string): Promise<PypiAnswer>;
}

export interface PypiExistenceStats {
  existenceChecked: number;
  budget: number;
  unreachable: number;
  privateIndex: number;
  internal: number;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The fixed order names are looked up in, so the not-looked-up set is
 * reproducible: names a manifest declares first (what an agent writes),
 * then lockfile-only names (what a resolver wrote), each sorted by anchor
 * path, then normalised name.
 */
export function pypiLookupOrder(candidates: readonly PypiCandidate[]): PypiCandidate[] {
  const rank = (candidate: PypiCandidate): number => (candidate.source === 'manifest' ? 0 : 1);
  return [...candidates].sort(
    (left, right) =>
      rank(left) - rank(right) || compare(left.anchorPath, right.anchorPath) || compare(left.name, right.name)
  );
}

function nameList(names: readonly string[]): string {
  if (names.length <= MAX_LISTED_NAMES) {
    return names.join(', ');
  }
  return `${names.slice(0, MAX_LISTED_NAMES).join(', ')} and ${names.length - MAX_LISTED_NAMES} more`;
}

function absentMessage(candidate: PypiCandidate): string {
  return (
    `${pypiDisplayName(candidate.written, candidate.name)} does not exist on PyPI: the PyPI JSON API was ` +
    `queried for the project "${candidate.name}" and answered 404. A name that is on no index this ` +
    'repository declares cannot be installed from it, so this is a hallucinated or mistyped dependency, ' +
    'or a project PyPI has removed.'
  );
}

function skipFor(candidate: PypiCandidate, rule: PythonIndexRule | null): IndexSkip | null {
  if (rule === null) {
    return null;
  }
  if (candidate.recordedOrigin !== null && candidate.lockfilePath !== undefined) {
    const fromLock = rule.lockfileSkip(candidate.lockfilePath, candidate.recordedOrigin);
    if (fromLock !== null) {
      return fromLock;
    }
    if (candidate.source === 'lockfile') {
      return null;
    }
  }
  return candidate.source === 'manifest' ? rule.skipFor(candidate.anchorPath, candidate.name) : null;
}

/**
 * Looks up every Python candidate on PyPI, one request per normalised
 * name, and returns the unknown-package findings (one per anchor) and the
 * per-reason counts. Never throws: every failure becomes a diagnostic.
 */
export async function checkPypiExistence(
  candidates: readonly PypiCandidate[],
  ctx: CheckContext,
  rule: PythonIndexRule | null,
  deps: PypiExistenceDeps,
  diagnostics: Diagnostic[],
  deadline: OnlineDeadline,
  unchecked: UncheckedSink = () => {}
): Promise<{ findings: Omit<Finding, 'fingerprint'>[]; stats: PypiExistenceStats }> {
  const stats: PypiExistenceStats = { existenceChecked: 0, budget: 0, unreachable: 0, privateIndex: 0, internal: 0 };
  const findings: Omit<Finding, 'fingerprint'>[] = [];

  // One question per normalised name, in lookup order, with every anchor
  // that name was declared at.
  const byName = new Map<string, PypiCandidate[]>();
  for (const candidate of pypiLookupOrder(candidates)) {
    const group = byName.get(candidate.name);
    if (group === undefined) {
      byName.set(candidate.name, [candidate]);
    } else {
      group.push(candidate);
    }
  }

  const skipNotes = new Map<string, { skip: IndexSkip; names: Set<string> }>();
  // Names skipped at every anchor. A name skipped at one anchor and looked
  // up at another was checked, so no skip note counts it as not checked.
  const fullySkipped = new Set<string>();
  const deadlineSkipped: string[] = [];
  const unreachable: Array<{ name: string; reason: string }> = [];

  for (const [name, group] of byName) {
    if (isPypiInternalName(name, ctx.config.internalPrefixes)) {
      stats.internal += 1;
      continue;
    }
    const sendable: PypiCandidate[] = [];
    for (const candidate of group) {
      const skip = skipFor(candidate, rule);
      if (skip === null) {
        sendable.push(candidate);
        continue;
      }
      const key = JSON.stringify([skip.declaredIn, skip.origin, skip.option]);
      const note = skipNotes.get(key) ?? { skip, names: new Set<string>() };
      note.names.add(name);
      skipNotes.set(key, note);
    }
    if (sendable.length === 0) {
      stats.privateIndex += 1;
      fullySkipped.add(name);
      continue;
    }
    // Asked before every name, as resolveUnknownPackages asks it: one slow
    // lookup can spend the whole budget.
    if (deadline.expired()) {
      stats.budget += 1;
      deadlineSkipped.push(name);
      unchecked({ name, ecosystem: 'pypi', step: 'pypi-existence', reason: 'budget' });
      continue;
    }
    let answer: PypiAnswer;
    try {
      answer = await deps.fetchPypiProject(name);
    } catch (err) {
      stats.unreachable += 1;
      unreachable.push({ name, reason: (err as Error).message });
      unchecked(unreachableName(name, 'pypi', 'pypi-existence', err));
      continue;
    }
    stats.existenceChecked += 1;
    if (answer === 'exists') {
      continue;
    }
    if (pypiAllowClears(ctx, name)) {
      continue;
    }
    for (const candidate of sendable) {
      findings.push({
        ruleId: 'unknown-package',
        severity: 'critical',
        packageName: name,
        message: absentMessage(candidate),
        manifestPath: candidate.anchorPath,
        ...(candidate.lockfilePath !== undefined && candidate.lockfilePath !== candidate.anchorPath
          ? { lockfilePath: candidate.lockfilePath }
          : {}),
        details: {
          ecosystem: 'pypi',
          writtenName: candidate.written,
          onlineResolution: 'registry-absent',
          specifier: candidate.specifier,
          depType: candidate.depType,
          source: candidate.source,
        },
      });
    }
  }

  // One note for the ecosystem, not one per name: a PyPI outage on a large
  // audit would otherwise print hundreds of identical lines. It carries the
  // count, the first names and the first reason.
  if (unreachable.length > 0) {
    const first = unreachable[0];
    diagnostics.push({
      code: 'online-check-unreachable',
      message:
        `${PYPI_CHECK_LABEL}: could not get an answer from PyPI for ${unreachable.length} name(s) ` +
        `(${nameList(unreachable.map((entry) => entry.name))}); the first failure was: ${first?.reason ?? 'unknown'}. ` +
        'Those names were not checked for existence',
    });
  }

  for (const { skip, names: skippedHere } of skipNotes.values()) {
    const names = [...skippedHere].filter((name) => fullySkipped.has(name));
    if (names.length === 0) {
      continue;
    }
    const count = names.length;
    const exposure = skip.alsoPypi
      ? '; pip still resolves these names from PyPI as well, so a name that is not on PyPI is exposed to ' +
        'dependency confusion; this run did not check it'
      : '';
    diagnostics.push({
      code: PYPI_PRIVATE_INDEX_SKIPPED,
      message:
        `${skip.declaredIn}: ${count} Python name(s) not checked for existence on PyPI, because ${skip.declaredIn} ` +
        `declares the package index ${skip.origin} (${skip.option}). This is a coverage gap, not a safety ` +
        `property${exposure}`,
    });
  }

  if (deadlineSkipped.length > 0) {
    diagnostics.push({
      code: ONLINE_DEADLINE_CODE,
      message: deadlineDiagnosticMessage(
        PYPI_CHECK_LABEL,
        deadlineSkipped.length,
        deadline,
        `those names were not checked for existence on PyPI: ${nameList(deadlineSkipped)}`
      ),
    });
  }

  return { findings, stats };
}
