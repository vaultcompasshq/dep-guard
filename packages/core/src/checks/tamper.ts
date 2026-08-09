import type { DepChange, LockEntryChange } from '../delta.js';
import type { LockEntry } from '../lockfiles/types.js';
import type { Resolution } from '../resolution.js';
import { resolutionOf } from '../resolution.js';
import { agreementAcrossCandidates } from './agreement.js';
import { comparisonSignal, type ComparisonTamperSignal } from '../tamper-signals.js';
import type { Diagnostic, Finding } from '../types.js';
import type { Check } from './types.js';

// Lockfile tampering: an attacker (or a compromised registry) rewrites the
// resolution of a dependency without ever touching package.json, or
// repoints the manifest specifier itself at a source the registry never
// vouched for.
//
// Three independent signals, each severe enough on its own to be
// critical, and each looked for on both an added AND a changed
// dependency. The git/url-source swap in particular tends to arrive as a
// changed specifier -- a pinned "^4.17.21" rewritten to
// "github:evil/lodash" -- never as a brand-new dependency, so gating any
// of this on kind === 'added' alone would miss the shape the attack
// actually takes.
//
// Only meaningful for the two lockfile formats this tool parses
// resolution metadata from at all.
//
// Each finding carries a stable details.signal: a single dependency can
// trip more than one of these three rules at once -- a git-source swap
// that also lost its integrity hash, say -- and the fingerprint hashes
// only (ruleId, packageName, manifestPath), so without a per-finding
// signal, baselining one would silently suppress the others.
//
// Where a signal has a value-bearing subject, that value is part of the
// signal string, not merely of details. A baseline entry records a fact a
// user accepted; "this package's resolution moved hosts" is not a fact,
// it is a category, and accepting the category would accept every later
// move too -- including the one to an attacker's host. The value folded
// in is the resolution the bytes now come from, which is exactly what the
// user was shown and accepted. It cannot move under a corpus refresh or a
// version bump, which is what the fingerprint-stability contract actually
// protects.
//
// allow is deliberately NOT consulted here. allow's own doctrine is "I
// know about this package"; where the bytes are fetched from is not a
// property of the package, and a resolution swap under an allowed name is
// exactly the attack an allow entry must not buy.

// An integrity value is not one opaque string: it names the algorithm that
// produced the digest ("sha512-<base64>"), and comparing two of them
// without reading that prefix conflates three different events. The
// algorithms are ordered explicitly rather than compared as strings --
// "sha1" sorts after "sha384" and before "sha512" lexically, which is two
// wrong answers out of two.
//
// Higher is stronger. An algorithm absent from this list is unknown, which
// is not the same as weak: the comparison fails closed and reports, because
// the one thing that must not happen is a hash the engine cannot read being
// treated as a hash it approved.
// A resolution the engine could not parse is coverage it did not give, and
// coverage it did not give is said out loud rather than left to look like a
// clean result.
const UNREADABLE_RESOLUTION_CODE = 'tamper-resolution-unreadable';

// The delta owns this code, but not the decision behind it any more: see
// certainFindings below for why the announcement now has to be raised by
// the code that does the suppressing.
const AMBIGUOUS_LOCK_ENTRY_CODE = 'delta-ambiguous-lock-entry';

// The signal of the escalation below. Deliberately NOT a member of
// COMPARISON_TAMPER_SIGNALS: that list is the set of verdicts the
// comparison rules reach, and it is what the lost-coverage diagnostics
// enumerate. This is not a verdict about a resolution at all -- it is a
// statement that a verdict could not be attributed -- so listing it there
// would have audit mode claiming it could not evaluate a signal that does
// not exist without a comparison in the first place.
//
// It carries no value-bearing subject, and that is the stability contract
// rather than an oversight. The subject would be WHICH verdicts were
// undecided, and that set moves as a lockfile gains and loses nested
// duplicates -- which happens on ordinary refreshes -- so folding it in
// would mint a fresh fingerprint no baseline could absorb, exactly the
// trap local-source-changed fell into. The list lives in the details,
// where nothing hashes it.
const AMBIGUOUS_CRITICAL_SIGNAL = 'ambiguous-critical';

const HASH_STRENGTH: ReadonlyMap<string, number> = new Map([
  ['md5', 1],
  ['sha1', 2],
  ['sha256', 3],
  ['sha384', 4],
  ['sha512', 5],
]);

// Subresource-integrity values may carry several space-separated hashes,
// and what such a value is worth is its strongest one. A value with no
// recognized algorithm in it at all reads as unknown.
function integrityStrength(value: string): number | null {
  let strongest: number | null = null;
  for (const token of value.trim().split(/\s+/)) {
    const separator = token.indexOf('-');
    if (separator <= 0) {
      continue;
    }
    const strength = HASH_STRENGTH.get(token.slice(0, separator).toLowerCase());
    if (strength !== undefined && (strongest === null || strength > strongest)) {
      strongest = strength;
    }
  }
  return strongest;
}

// What a hash rewritten in place, with the version and the resolved URL
// both unchanged, actually means. Three outcomes, and the middle one is the
// reason this ladder exists at all.
function integrityVerdict(before: string, after: string): 'forged' | 'downgraded' | null {
  const beforeStrength = integrityStrength(before);
  const afterStrength = integrityStrength(after);
  if (beforeStrength === null || afterStrength === null) {
    // Fail closed. An unreadable algorithm on either side means the engine
    // cannot say the rehash was benign, and "cannot say" may never resolve
    // to silence in this rule.
    return 'forged';
  }
  if (afterStrength > beforeStrength) {
    // A rehash upward is what an npm lockfile migration does to every entry
    // it touches (sha1 to sha512), and it re-derives the digest from the
    // same bytes. Reporting it would file a critical per dependency on a
    // routine upgrade.
    return null;
  }
  if (afterStrength < beforeStrength) {
    // The spec's tamper rule covers hashes "removed or downgraded", and
    // this is the downgraded half: an attacker who cannot forge a sha512
    // digest can try to get the lockfile to accept a weaker one instead.
    return 'downgraded';
  }
  // Same algorithm, different digest. A registry tarball is immutable, so
  // one version fetched from one URL has one digest under one algorithm
  // forever -- there is no innocent version of this.
  return 'forged';
}

// Used only for the git/url specifier message below: a host is worth
// naming in the message, and an empty host (the "github:owner/repo"
// shorthand parses with no host at all) collapses to null so the message
// omits the parenthetical instead of printing an empty string.
function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.host === '' ? null : parsed.host;
  } catch {
    return null;
  }
}

// The resolvedUrl comparison below cannot reuse hostOf: its
// empty-host-to-null collapse is correct for a message but wrong for an
// equality check -- a file: URL legitimately has an empty host, so a
// registry resolution swapped for file:///tmp/payload.tgz would have both
// "hosts" fail their non-null requirement and the rule would skip itself
// entirely on exactly the resolution swap it exists to catch. The parsing
// itself lives in resolution.ts instead, because delta.ts pairs entries by
// the same notion of origin this rule judges them by, and two copies of it
// would let the delta pair two entries this check then calls different.
//
// If the message and details named the host alone, a scheme-only change
// (the origin's identity now differs, but the host string does not) would
// produce a self-contradicting message -- "resolves from host X instead of
// X" -- with details.beforeHost equal to details.afterHost, leaving no
// consumer able to tell what changed. Both report the full origin instead,
// and the detail keys are named accordingly (beforeOrigin/afterOrigin)
// rather than "Host" names for a value that can carry a scheme.
// What the two entry-comparison rules need to know about whatever produced
// the pair, so that one implementation serves both the manifest walk (a
// declared dependency's selected entries) and the lockfile walk (every
// entry, declared or not). Keeping one implementation is the point: the two
// callers disagreeing about what counts as tampering is how this check came
// to be blind to transitive entries in the first place.
interface ComparisonSubject {
  packageName: string;
  manifestPath: string;
  kind: 'added' | 'changed';
  before: LockEntry;
  after: LockEntry;
  // How many before entries this comparison is one of. One for a decided
  // pairing; more when the delta could not say which earlier entry the
  // after entry succeeds, in which case a message may only state what is
  // true of every one of them.
  candidateCount: number;
}

function subjectOfChange(change: DepChange): ComparisonSubject | null {
  const { before, after } = change;
  if (before === undefined || after === undefined) {
    return null;
  }
  return {
    packageName: change.registryName,
    manifestPath: change.manifestPath,
    kind: change.kind,
    before,
    after,
    candidateCount: 1,
  };
}

// How a message refers to the before side. A decided pairing has one, and
// says "before"; a guessed one may only describe all the candidates at
// once, since naming any single one of them would be reporting the guess.
function priorSide(subject: ComparisonSubject): string {
  return subject.candidateCount > 1
    ? `every one of the ${subject.candidateCount} earlier entries recorded under this name`
    : 'before';
}

// Every before entry a changed lock entry might be the successor of. One
// when the delta could decide the pairing; several when it could not.
//
// If a guessed pairing returned nothing at all here, that blanket
// suppression would be constructible: any name carrying two before entries
// -- which nested duplicates make ubiquitous in a real lockfile -- could
// be repointed to any host in one move, since giving the evil entry a
// version no candidate shares makes every narrowing step fail and every
// comparison signal go quiet. What the guess actually costs is the
// before-value a message would print, never the verdict itself: an entry
// resolving from a host none of the candidates ever resolved from has
// moved whichever one it succeeds. So each candidate is compared and a
// verdict they all reach is reported, worded in terms of what is certain.
function candidatesOfLockEntry(entryChange: LockEntryChange): LockEntry[] {
  if (entryChange.beforeCandidates !== undefined && entryChange.beforeCandidates.length > 0) {
    return entryChange.beforeCandidates;
  }
  return entryChange.before === undefined ? [] : [entryChange.before];
}

// Whether the two sides of a pair name the same place, for the purpose of
// deciding what a rewritten integrity hash means. Identical URL text is the
// easy case (and covers a pair with no resolved URL at all on either side);
// beyond that the question is the one resolution.ts answers, so that this
// rule and the delta's own pairing never disagree about what "the same
// place" is. Two URLs that differ in origin are somebody else's finding --
// host-changed, scheme-downgrade or local-source-changed, all below -- and
// a pair the engine cannot parse is neither held nor moved, so it says no.
function sameOriginPair(before: LockEntry, after: LockEntry): boolean {
  if (before.resolvedUrl === after.resolvedUrl) {
    return true;
  }
  if (before.resolvedUrl === undefined || after.resolvedUrl === undefined) {
    return false;
  }
  const beforeRes = resolutionOf(before.resolvedUrl);
  const afterRes = resolutionOf(after.resolvedUrl);
  return beforeRes !== null && afterRes !== null && beforeRes.origin === afterRes.origin;
}

// The origin, and the tarball path, of an entry whose resolved URL has
// already been established as parseable by sameOriginPair. The fallbacks
// are unreachable from that one caller and exist so neither helper widens
// its return type to null for a value the caller has already checked.
function originLabel(entry: LockEntry): string {
  const resolution = entry.resolvedUrl === undefined ? null : resolutionOf(entry.resolvedUrl);
  return resolution?.origin ?? 'unknown';
}

function pathLabel(entry: LockEntry): string {
  if (entry.resolvedUrl === undefined) {
    return 'none';
  }
  try {
    return new URL(entry.resolvedUrl).pathname;
  } catch {
    return 'unreadable';
  }
}

function resolutionFinding(
  subject: ComparisonSubject,
  signal: Extract<ComparisonTamperSignal, 'host-changed' | 'scheme-downgrade' | 'local-source-changed'>,
  beforeRes: Resolution,
  afterRes: Resolution
): Omit<Finding, 'fingerprint'> {
  const ambiguous = subject.candidateCount > 1;
  return {
    ruleId: 'lockfile-tamper',
    severity: 'critical',
    packageName: subject.packageName,
    message: ambiguous
      ? `"${subject.packageName}" now resolves from origin "${afterRes.origin}", which is not where ${priorSide(subject)} resolved from.`
      : `"${subject.packageName}" now resolves from origin "${afterRes.origin}" instead of "${beforeRes.origin}".`,
    manifestPath: subject.manifestPath,
    details: {
      // The destination is part of the signal, so a baseline entry accepts
      // the move that was reviewed and nothing else.
      //
      // local-source-changed is the exception, and it is the stability
      // contract that makes it one rather than taste. A hostless origin IS
      // the path, and a vendored tarball's path moves on every bump of it
      // -- so folding it in would mint a new fingerprint for each bump,
      // which no baseline could ever absorb, and the rule that a value may
      // enter a signal only if it cannot move under a version bump exists
      // precisely to stop that. Both origins stay in the details, where
      // nothing hashes them.
      signal:
        signal === 'local-source-changed'
          ? comparisonSignal(signal)
          : comparisonSignal(signal, afterRes.origin),
      kind: subject.kind,
      // The before origin is one candidate's, so it is only a fact when
      // there was one candidate. Where there were several, what the
      // details can honestly carry instead is how many.
      ...(ambiguous
        ? { counterpartCandidates: subject.candidateCount }
        : { beforeOrigin: beforeRes.origin }),
      afterOrigin: afterRes.origin,
    },
  };
}

export const tamperCheck: Check = (ctx) => {
  const { delta } = ctx;
  // The format gate does not belong above everything. The git-source and
  // url-source signals read a manifest specifier and nothing else -- the
  // audit-mode diagnostic says so in as many words, and the yarn and bun
  // loaders promise users that lockfile-backed checks fall back to
  // manifest evidence -- so gating them on a lockfile format would leave a
  // specifier rewritten to "git+https://evil/..." completely unreported in
  // a yarn, a bun, or a lockfile-less repository. The gate sits where the
  // resolution-comparison walks begin instead, which is the only part of
  // this check that needs a lockfile this tool can read.
  const comparableLockfile = delta.lockfileFormat === 'npm' || delta.lockfileFormat === 'pnpm';

  const findings: Omit<Finding, 'fingerprint'>[] = [];
  // Two DepChanges resolving to the same (manifestPath, registryName) --
  // two aliases retargeting one package that both suffer the same
  // lockfile tamper, say -- would each independently produce a finding
  // for the SAME signal, and those hash identically (the fingerprint
  // never sees which alias or manifest key produced the change). Deduped
  // on (manifestPath, packageName, signal)
  // rather than the pair alone: this check legitimately emits several
  // DISTINCT signals for one dependency (a git-source swap that also
  // lost its integrity hash), and those must not suppress each other.
  //
  // The dedupe is also what keeps the two walks below from double-reporting
  // one fact: a tampered entry that a manifest DOES declare is reached by
  // both, produces the same signal string for the same package at the same
  // manifest path, and is reported once.
  const seen = new Set<string>();
  const report = (finding: Omit<Finding, 'fingerprint'>): void => {
    const signal = typeof finding.details?.signal === 'string' ? finding.details.signal : '';
    const key = JSON.stringify([finding.manifestPath, finding.packageName, signal]);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    // Every finding this check raises is a fact about a lockfile, and
    // for a transitive entry the manifest path is only an anchor -- the
    // lockfile is the file a reader has to open.
    findings.push(
      delta.lockfilePath === undefined ? finding : { ...finding, lockfilePath: delta.lockfilePath }
    );
  };

  // Diagnostics are deduplicated on the way in rather than on the way out:
  // one note per package, however many of its entries produced it. The point
  // of each of them is that a comparison did not run for that package, and
  // repeating it per entry buries the diagnostics that name something else.
  const note = (diagnostic: Diagnostic): void => {
    for (const existing of ctx.diagnostics) {
      if (existing.code === diagnostic.code && existing.message === diagnostic.message) {
        return;
      }
    }
    ctx.diagnostics.push(diagnostic);
  };

  const noteUnreadableResolution = (packageName: string): void => {
    const inLockfile = delta.lockfilePath === undefined ? '' : ` in ${delta.lockfilePath}`;
    note({
      code: UNREADABLE_RESOLUTION_CODE,
      message:
        `"${packageName}" has a lockfile entry${inLockfile} whose resolved location could not be read ` +
        'as a URL, so the host-changed, scheme-downgrade and local-source-changed comparisons could ' +
        'not be evaluated for it',
    });
  };

  // What a guessed pairing actually cost, said out loud, in the one place
  // that can know it: a verdict some of the candidates reached and others
  // did not, dropped because reporting it would have been reporting the
  // guess. The signals are named because a reader has to be able to go and
  // look; the candidates are counted rather than named, for the same reason
  // a message may not print one candidate's origin.
  const noteSuppressedByPairing = (
    packageName: string,
    candidateCount: number,
    signals: string[]
  ): void => {
    const inLockfile = delta.lockfilePath === undefined ? '' : ` in ${delta.lockfilePath}`;
    note({
      code: AMBIGUOUS_LOCK_ENTRY_CODE,
      message:
        `"${packageName}": each of the ${candidateCount} earlier entries recorded under this name` +
        `${inLockfile} could be the counterpart of a changed entry, and they do not agree about it -- ` +
        `the ${signals.join(', ')} signal held against some of them and not the others, so it was ` +
        'not reported',
    });
  };

  // Compares one before/after pair, whichever walk produced it, and hands
  // back what it found rather than reporting it directly: when the before
  // side was a guess between several candidates, the caller runs this once
  // per candidate and keeps only the verdicts all of them reached.
  const compare = (subject: ComparisonSubject): Omit<Finding, 'fingerprint'>[] => {
    const { before, after } = subject;
    const raised: Omit<Finding, 'fingerprint'>[] = [];
    const raise = (finding: Omit<Finding, 'fingerprint'>): void => {
      raised.push(finding);
    };

    // An integrity hash that was present and is now gone is stripping,
    // not de-escalation -- a legitimate republish keeps or updates the
    // hash, it does not remove it.
    if (before.integrity !== undefined && after.integrity === undefined) {
      raise({
        ruleId: 'lockfile-tamper',
        severity: 'critical',
        packageName: subject.packageName,
        message:
          subject.candidateCount > 1
            ? `"${subject.packageName}" had an integrity hash recorded on ${priorSide(subject)} and has none now.`
            : `"${subject.packageName}" had an integrity hash recorded before and has none now.`,
        manifestPath: subject.manifestPath,
        details: { signal: comparisonSignal('integrity-removed'), kind: subject.kind },
      });
    } else if (
      before.integrity !== undefined &&
      after.integrity !== undefined &&
      before.integrity !== after.integrity &&
      before.version === after.version &&
      sameOriginPair(before, after)
    ) {
      // A hash rewritten rather than deleted, with the version held and the
      // bytes still coming from the same place. The version has to be
      // unchanged for this to mean anything -- an ordinary bump moves the
      // version, the URL and the hash together -- and a move to a different
      // origin is already the more specific host-changed, scheme-downgrade
      // or local-source-changed finding, so this branch deliberately says
      // nothing about either. The else-if is what keeps a removed hash from
      // being reported twice.
      if (before.resolvedUrl !== after.resolvedUrl) {
        // The URL moved WITHIN the origin. This is otherwise two rules'
        // blind spot at once -- the branch above requires an unchanged
        // URL, and the resolution comparison below dismisses a path-only
        // difference on a real host as a version's tarball moving -- so
        // repointing a package at another tarball on a host the project
        // already trusts, carrying that tarball's own genuine hash, would
        // scan completely clean. One version has one tarball, and that
        // tarball has one hash: a URL and a hash that moved together while
        // the version stood still is a different artifact being installed
        // under the same name. The algorithm ladder deliberately does not
        // run here -- it forgives a rehash of the SAME bytes at the same
        // URL, which is not what this is.
        raise({
          ruleId: 'lockfile-tamper',
          severity: 'critical',
          packageName: subject.packageName,
          message: `"${subject.packageName}" still resolves to the same version from origin "${originLabel(after)}" as ${priorSide(subject)}, but from a different tarball with a different integrity hash.`,
          manifestPath: subject.manifestPath,
          details: {
            // The value-bearing subject is the origin the bytes come from,
            // which is the one part of this finding that cannot move under
            // a version bump. The tarball path is deliberately out of it
            // (see local-source-changed below).
            signal: comparisonSignal('tarball-repointed', originLabel(after)),
            kind: subject.kind,
            // The tarball paths, never the URLs: a resolved URL is one of
            // the places a credential can appear, and the same rule that
            // keeps a git specifier out of a finding keeps a full URL out of
            // this one. A pathname carries no userinfo.
            //
            // The before path is one candidate's, so it is only a fact when
            // there was one candidate -- the same rule resolutionFinding
            // follows for beforeOrigin. Emitting it regardless would
            // report the delta's guess about which earlier entry this one
            // succeeds as though it were a reading of the lockfile.
            ...(subject.candidateCount > 1
              ? { counterpartCandidates: subject.candidateCount }
              : { beforePath: pathLabel(before) }),
            afterPath: pathLabel(after),
          },
        });
      } else {
        // Which of the two signals a rewrite in place is (and whether it is
        // one at all) is the algorithm ladder's answer, not this branch's.
        const verdict = integrityVerdict(before.integrity, after.integrity);
        if (verdict === 'forged') {
          raise({
            ruleId: 'lockfile-tamper',
            severity: 'critical',
            packageName: subject.packageName,
            message: `"${subject.packageName}" resolves to the same version from the same URL as ${priorSide(subject)}, but its integrity hash was rewritten.`,
            manifestPath: subject.manifestPath,
            details: { signal: comparisonSignal('integrity-changed'), kind: subject.kind },
          });
        } else if (verdict === 'downgraded') {
          raise({
            ruleId: 'lockfile-tamper',
            severity: 'critical',
            packageName: subject.packageName,
            message: `"${subject.packageName}" resolves to the same version from the same URL as ${priorSide(subject)}, but its integrity hash was re-recorded under a weaker algorithm.`,
            manifestPath: subject.manifestPath,
            details: { signal: comparisonSignal('integrity-downgraded'), kind: subject.kind },
          });
        }
      }
    }

    if (before.resolvedUrl === undefined || after.resolvedUrl === undefined) {
      return raised;
    }
    const beforeRes = resolutionOf(before.resolvedUrl);
    const afterRes = resolutionOf(after.resolvedUrl);
    if (beforeRes === null || afterRes === null) {
      // If this returned and said nothing: npm writes resolutions this
      // parser cannot read -- a bare relative path such as
      // "vendor/payload.tgz" is a shape it genuinely produces -- so
      // repointing an entry at one of them, with the integrity hash
      // rewritten to match, would be a silent success for an attacker. Two
      // rules this engine states outright forbid that: coverage the engine
      // cannot provide owes a diagnostic rather than silence, and a URL or
      // a hash it cannot read must never be treated as one it approved.
      //
      // The diagnostic is unconditional, because whichever way this ends
      // the host, scheme and local-source comparisons did not run for this
      // entry. The finding is what the engine can still say without them:
      // the resolution moved to or from something unreadable, and nothing
      // vouches for the bytes at the other end. An identical hash on both
      // sides does vouch for them -- the same settlement local-source-
      // changed already makes -- and an unreadable pair that did not move
      // at all has no repoint in it to report.
      noteUnreadableResolution(subject.packageName);
      const bytesVouchedFor =
        before.integrity !== undefined &&
        after.integrity !== undefined &&
        before.integrity === after.integrity;
      const somethingToGoOn =
        beforeRes !== null || afterRes !== null || before.integrity !== after.integrity;
      if (before.resolvedUrl !== after.resolvedUrl && !bytesVouchedFor && somethingToGoOn) {
        raise({
          ruleId: 'lockfile-tamper',
          severity: 'critical',
          packageName: subject.packageName,
          message: `"${subject.packageName}" now resolves from a location this scan could not read as a URL, and nothing on either side vouches for the bytes it names.`,
          manifestPath: subject.manifestPath,
          // No value-bearing subject is folded into the signal, and the
          // unreadable value stays out of the details as well: an
          // unparseable string is exactly where a malformed credential
          // would survive the parsing that strips one everywhere else.
          details: { signal: comparisonSignal('resolution-unreadable'), kind: subject.kind },
        });
      }
      return raised;
    }
    // Host is checked first and takes priority over any accompanying
    // scheme change -- a host change is the more specific, more serious
    // fact regardless of which schemes are involved on either side.
    if (beforeRes.host !== afterRes.host) {
      raise(resolutionFinding(subject, 'host-changed', beforeRes, afterRes));
      return raised;
    }
    if (beforeRes.protocol !== afterRes.protocol) {
      // A same-host scheme change is reported UNLESS it is the one
      // well-understood benign direction: a registry finishing a TLS
      // migration (http -> https) with nothing else different. Any
      // other direction -- https downgraded to http, or to any
      // non-https scheme such as git+https on the same host -- is a
      // distinct, more specific signal than a host change: the
      // resolution now travels over a channel with weaker or
      // different guarantees than the one that was already trusted.
      const benignUpgrade = beforeRes.protocol === 'http:' && afterRes.protocol === 'https:';
      if (!benignUpgrade) {
        raise(resolutionFinding(subject, 'scheme-downgrade', beforeRes, afterRes));
      }
      return raised;
    }
    if (beforeRes.origin !== afterRes.origin) {
      // Same scheme, same host, different origin: only reachable for a
      // hostless resolution, where the path is the source. A
      // path-only difference on a real host is a version's tarball
      // moving and is not this rule's concern.
      //
      // An integrity hash present and identical on both sides settles the
      // question the path was standing in for: the bytes are the same
      // bytes, so the move is a rename or a directory reorg rather than a
      // new source. Only an absent, removed, or rewritten hash leaves the
      // path as the only evidence of what is being installed -- which is
      // when this rule has something to say.
      const bytesVouchedFor =
        before.integrity !== undefined &&
        after.integrity !== undefined &&
        before.integrity === after.integrity;
      if (!bytesVouchedFor) {
        raise(resolutionFinding(subject, 'local-source-changed', beforeRes, afterRes));
      }
    }
    return raised;
  };

  const signalOf = (finding: Omit<Finding, 'fingerprint'>): string =>
    typeof finding.details?.signal === 'string' ? finding.details.signal : '';

  // Compares an after entry against every before entry it could be the
  // successor of, and keeps only the signals EVERY one of them produced.
  // A signal all the candidates agree on is a fact about the lockfile no
  // matter which of them this entry succeeds; a signal only some of them
  // produce would be a fact about the delta's guess, and is dropped. With
  // one candidate this is the plain comparison it always was.
  //
  // The drop and the announcement are deliberately one event, and that is
  // the whole point of this shape. Keeping them as two, in two files, would
  // mean the suppression happens here, while whether it is worth telling
  // anyone about is decided in delta.ts by a hand-written list of the
  // FACTS these comparisons read (origin, hash presence, hash equality,
  // version, URL, install-script flag), maintained alongside the rules
  // rather than derived from them. Such a list is only ever correct until
  // the next rule reads something it does not mention, and when it drifts
  // it drifts silently and in the attacker's favour: two candidates the
  // description calls identical, a verdict dropped for disagreeing, and no
  // diagnostic, because the description said there was nothing to disagree
  // about. That is exactly how a forged sha512 could hide beside a nested
  // duplicate still carrying its pre-migration sha1 -- one candidate reads
  // the rewrite as a forgery, the other as a routine sha1-to-sha512
  // rehash, and the scan would exit 0 with nothing to show.
  //
  // So nothing here predicts what the comparison will read. The comparison
  // is RUN once per candidate and the results are compared by
  // agreementAcrossCandidates, and any signal some candidate produced that
  // did not survive the intersection is announced by the same code that
  // dropped it. A rule reading a new fact cannot break this: the new fact
  // changes the results, and the results are what is being compared. Do not
  // reintroduce a key describing these rules from outside them, and do not
  // reimplement the intersection -- a local approximation gets a whole
  // cell of the truth table wrong, the same mistake install-script.ts's
  // own comment warns against.
  const certainFindings = (
    candidates: LockEntry[],
    base: Omit<ComparisonSubject, 'before' | 'candidateCount'>
  ): Omit<Finding, 'fingerprint'>[] => {
    const { agreed, dropped } = agreementAcrossCandidates(
      candidates,
      (before) => compare({ ...base, before, candidateCount: candidates.length }),
      signalOf
    );
    if (dropped.length > 0) {
      noteSuppressedByPairing(base.packageName, candidates.length, dropped.map(signalOf));
      // Diagnostics never change the exit code, and that invariant is not
      // being bent here. The problem it leaves is real though: a dropped
      // CRITICAL means some candidate said this entry was tampered with,
      // and a consumer reading only the exit code saw a clean scan. So the
      // drop is reported as what it actually is -- a finding that the
      // engine could not attribute -- at high, which blocks at the default
      // medium gate. One escalation per undecidable entry, however many
      // verdicts went undecided: they are one admission, not several.
      //
      // High rather than critical on purpose: a critical asserts the
      // tampering happened, and this cannot assert that. Drops carrying
      // nothing above high (install-script's suppressed acquisition) stay
      // diagnostic-only -- an unattributable high is not worth a blocking
      // finding of its own, and making it one would put a note on every
      // lockfile with a nested duplicate back in the gate.
      if (dropped.some((finding) => finding.severity === 'critical')) {
        agreed.push({
          ruleId: 'lockfile-tamper',
          severity: 'high',
          packageName: base.packageName,
          message:
            `"${base.packageName}" changed in a way that is a critical lockfile-tamper finding ` +
            `against some of the ${candidates.length} earlier entries recorded under this name and ` +
            'not against the others, and this scan cannot tell which of them it succeeds. Treat the ' +
            'entry as suspect and remove the duplicate entries so it can be judged.',
          manifestPath: base.manifestPath,
          details: {
            signal: AMBIGUOUS_CRITICAL_SIGNAL,
            kind: base.kind,
            // The candidates are counted, never named, and what could not be
            // decided is named by signal only -- the same rule that keeps one
            // candidate's origin or tarball path out of every other finding
            // this check raises.
            counterpartCandidates: candidates.length,
            undecidedSignals: dropped.map(signalOf),
          },
        });
      }
    }
    return agreed;
  };

  for (const change of delta.changes) {
    if (change.protocol === 'git' || change.protocol === 'url') {
      // If the raw specifier were echoed verbatim here, that would leak a
      // credential: a git/url specifier is exactly where one appears
      // (git+https://x-access-token:TOKEN@host/...). Only the host is
      // named, the same shape the resolvedUrl rule below already uses --
      // .host never carries userinfo the way the full specifier string
      // can. A shorthand like "github:owner/repo" has no host in its own
      // text at all, so the fallback omits the parenthetical rather than
      // falling back to the raw text.
      const host = hostOf(change.specifier);
      const named = host === null ? `a ${change.protocol} source` : `a ${change.protocol} source ("${host}")`;
      report({
        ruleId: 'lockfile-tamper',
        severity: 'critical',
        packageName: change.registryName,
        message: `"${change.registryName}" resolves via ${named} instead of the registry.`,
        manifestPath: change.manifestPath,
        details: {
          // Two git sources are two different facts, so the host the
          // dependency now comes from is part of the signal. A shorthand
          // with no host of its own keeps the bare signal rather than
          // borrowing the raw specifier, which is where credentials live.
          signal: `${change.protocol === 'git' ? 'git-source' : 'url-source'}${host === null ? '' : `:${host}`}`,
          protocol: change.protocol,
          kind: change.kind,
          host,
        },
      });
    }

    const subject = comparableLockfile ? subjectOfChange(change) : null;
    if (subject !== null) {
      for (const finding of compare(subject)) {
        report(finding);
      }
    }
  }

  // Every entry the lockfile diff produced, whether or not any
  // manifest declares it, and however many entries share one name.
  if (comparableLockfile) {
    for (const entryChange of delta.lockEntryChanges) {
      const candidates = candidatesOfLockEntry(entryChange);
      if (candidates.length === 0) {
        continue; // an added entry: nothing to compare it against
      }
      const certain = certainFindings(candidates, {
        packageName: entryChange.packageName,
        manifestPath: entryChange.manifestPath,
        kind: entryChange.kind,
        after: entryChange.after,
      });
      for (const finding of certain) {
        report(finding);
      }
    }
  }

  return findings;
};
