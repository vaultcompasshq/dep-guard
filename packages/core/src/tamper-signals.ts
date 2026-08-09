// The lockfile-tamper signals that work by comparing two resolutions, in
// one place, because more than one file has to name them and they were
// named differently in each.
//
// Two diagnostics describe coverage this engine could not give -- audit
// mode's whole-lockfile notice and the delta's new-entries notice -- and
// both list these signals so a reader knows what was not evaluated. They
// each carried their own copy of the list, and both copies were written
// when there were six of these signals. tarball-repointed and
// resolution-unreadable were added to the check afterwards; neither copy
// learned about them, and a diagnostic that names a subset of a blind spot
// under-reports the blind spot it exists to report, which is the one thing
// it must never do.
//
// So the list lives here and the messages are built from it. Adding a
// signal means adding it here, and every consumer says the new name from
// that moment: checks/tamper.ts builds its details.signal values through
// comparisonSignal() below, so a signal name absent from this list does not
// compile.
//
// The specifier-based signals (git-source, url-source) are deliberately not
// here: they read a manifest specifier, they run without any lockfile
// comparison at all, and they are exactly what these diagnostics say DID
// still run.
export const COMPARISON_TAMPER_SIGNALS = [
  'integrity-removed',
  'integrity-changed',
  'integrity-downgraded',
  'tarball-repointed',
  'host-changed',
  'scheme-downgrade',
  'local-source-changed',
  'resolution-unreadable',
] as const;

export type ComparisonTamperSignal = (typeof COMPARISON_TAMPER_SIGNALS)[number];

// How a diagnostic spells the set when it has to say which coverage was
// lost.
export function comparisonTamperSignalList(): string {
  return COMPARISON_TAMPER_SIGNALS.join(', ');
}

// A finding's details.signal, with the value-bearing subject folded in
// where it has one (see the fingerprint-stability contract in
// docs/INVARIANTS.md: a value may enter a signal only if it cannot move
// under a corpus refresh or a version bump). The point of routing every
// signal through here is the type on the first parameter.
export function comparisonSignal(signal: ComparisonTamperSignal, subject?: string): string {
  return subject === undefined ? signal : `${signal}:${subject}`;
}
