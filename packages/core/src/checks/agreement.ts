import type { LockEntry } from '../lockfiles/types.js';

// Comparing an entry against a pairing the delta could only guess at, in
// one implementation, because there were briefly two: the real one here and
// a hand-written imitation of it in install-script.ts that approximated the
// intersection with `candidates.some(...)` and `candidates.length > 1`.
//
// The imitation was wrong in the cell the real mechanism gets right for
// free. When EVERY candidate already ran an install script, every candidate
// reaches the same verdict -- no acquisition -- so nothing was dropped for
// disagreeing and there is nothing to admit to. `some()` cannot see that:
// it fires on "at least one", which is also true when they all agree, so a
// bump of a scripted package beside a flagged nested duplicate of it -- one
// of the commonest shapes in a real lockfile -- announced an ambiguity on
// every single refresh, with a message that was simply false. That is the
// noise the derive-and-intersect work existed to remove, reintroduced in
// the honesty channel built to replace it.
//
// So the rule has one implementation and no imitations. Run the real
// comparison once per candidate, intersect the RESULTS by signal, and hand
// back both halves: what every candidate agreed on, which is a fact about
// the lockfile, and what only some of them produced, which is a fact about
// the guess and owes the caller an announcement.

export interface CandidateAgreement<T> {
  // Verdicts every candidate reached. Reportable: whichever earlier entry
  // this one succeeds, this is true of it.
  agreed: T[];
  // Verdicts some candidates reached and others did not, deduplicated by
  // signal and ordered by it. Not reportable as-is -- reporting one would
  // be reporting the guess -- but never silently discardable either.
  dropped: T[];
}

export function agreementAcrossCandidates<T>(
  candidates: readonly LockEntry[],
  verdictsFor: (candidate: LockEntry) => T[],
  signalOf: (verdict: T) => string
): CandidateAgreement<T> {
  if (candidates.length === 0) {
    return { agreed: [], dropped: [] };
  }
  const perCandidate = candidates.map((candidate) => verdictsFor(candidate));
  const [first, ...rest] = perCandidate;
  const agreed = first.filter((verdict) =>
    rest.every((other) =>
      other.some((alternative) => signalOf(alternative) === signalOf(verdict))
    )
  );

  const kept = new Set(agreed.map(signalOf));
  const dropped: T[] = [];
  const seen = new Set<string>();
  for (const produced of perCandidate) {
    for (const verdict of produced) {
      const signal = signalOf(verdict);
      if (kept.has(signal) || seen.has(signal)) {
        continue;
      }
      seen.add(signal);
      dropped.push(verdict);
    }
  }
  dropped.sort((left, right) => (signalOf(left) < signalOf(right) ? -1 : 1));
  return { agreed, dropped };
}
