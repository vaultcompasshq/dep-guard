// Turns a scan result into counts, and nothing but counts.
//
// The private tier of the dogfood harness runs dep-guard against whatever
// repositories the operator has locally -- client work, internal services,
// anything. That is the tier where the interesting findings are, and it is
// only safe to run at all if its output cannot carry a package name, a
// repository name, a path, a message or a fingerprint out of those
// repositories. "Be careful what you paste" is not a control; this file is.
//
// The mechanism is that repository-derived text can never become a key.
// Every bucket is seeded from a vocabulary declared here, and a value that
// is not already in its bucket increments `other` instead of creating an
// entry. So a rule id or a diagnostic code this harness has not heard of
// shows up as a number under a fixed name, and a package name -- which is
// never read in the first place -- has no route into the output even if it
// somehow arrived in one of these fields. assertCountsOnly then checks the
// finished structure against the same vocabulary, so the guarantee is
// verified rather than assumed.
//
// Nothing here reads finding.packageName, finding.manifestPath,
// finding.message, finding.fingerprint, finding.details, or a diagnostic's
// message. That is the whole list of fields that carry repository content,
// and it is short enough to check by eye.

export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);

export const RULE_IDS = Object.freeze([
  'unknown-package',
  'typosquat',
  'install-script',
  'lockfile-tamper',
  'version-hygiene',
  'dependency-confusion',
  'registered-squat',
  'publish-age',
]);

export const LOCKFILE_FORMATS = Object.freeze(['npm', 'pnpm', 'yarn', 'bun', 'none']);

// The codes core and the CLI can raise. A stale entry here costs nothing; a
// missing one costs a number under `other` and a note on the run, never a
// key. bench/tests/counts.test.mjs fails when the source emits a code this
// list does not name, so a new code cannot fall into `other` unnoticed.
export const DIAGNOSTIC_CODES = Object.freeze([
  'audit-anchor-differs',
  'audit-limits',
  'audit-no-tamper-comparison',
  'check-single-name-only',
  'delta-ambiguous-lock-entry',
  'delta-new-lock-entries',
  'ignore-path-dropped',
  'ignore-path-unmatched',
  'lockfile-binary-skipped',
  'lockfile-downgrade-acknowledged',
  'lockfile-format-manifest-only',
  'lockfile-missing',
  'lockfile-nested-changed',
  'lockfile-nested-ignored',
  'lockfile-nested-removed',
  'lockfile-not-read',
  'lockfile-outside-prefix',
  'lockfile-unread-comparison-side',
  'lockfile-unread-sibling',
  'manifest-alias-empty',
  'manifest-skipped-dirname',
  'manifest-unparsed',
  'multiple-lockfiles',
  'npm-lockfile-invalid-entry',
  'npm-lockfile-unverifiable-name',
  'npm-lockfile-v1',
  'npmrc-pin-unparseable',
  'online-check-unreachable',
  'online-deadline-exceeded',
  'path-outside-root',
  'pnpm-lockfile-invalid-entry',
  'pnpm-multi-document-lockfile',
  'pnpm-no-install-script-flag',
  'publish-age-allowed',
  'publish-age-package-unknown',
  'publish-age-private-origin-skipped',
  'publish-age-version-unknown',
  'pypi-names-not-checked',
  'pypi-private-index-skipped',
  'python-index-unread-comparison-side',
  'python-lockfile-unreadable',
  'python-name-invalid',
  'python-workspace-unconfirmed',
  'registered-squat-private-origin-skipped',
  'requirements-line-unread',
  'symlink-cycle',
  'symlinked-input-comparison-side',
  'tamper-resolution-unreadable',
  'typosquat-asymmetry-private-origin-skipped',
  'unknown-package-private-origin-skipped',
  'unknown-package-private-scope-skipped',
  'workspace-dir-unreadable',
  'workspace-duplicate-directory',
  'workspace-glob-unsupported',
  'workspace-link-unconfirmed',
  'workspace-pattern-unread-comparison-side',
]);

const OTHER = 'other';

function seed(keys) {
  const bucket = Object.create(null);
  for (const key of keys) {
    bucket[key] = 0;
  }
  bucket[OTHER] = 0;
  return bucket;
}

// The only place a value from the scan touches the output. It selects an
// existing key or it does not; it never creates one.
function tally(bucket, key) {
  if (typeof key === 'string' && Object.hasOwn(bucket, key) && key !== OTHER) {
    bucket[key] += 1;
    return;
  }
  bucket[OTHER] += 1;
}

export function summarize(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const diagnostics = Array.isArray(result?.run?.diagnostics) ? result.run.diagnostics : [];

  const byRule = seed(RULE_IDS);
  const bySeverity = seed(SEVERITIES);
  for (const found of findings) {
    tally(byRule, found?.ruleId);
    tally(bySeverity, found?.severity);
  }

  const byCode = seed(DIAGNOSTIC_CODES);
  for (const diagnostic of diagnostics) {
    tally(byCode, diagnostic?.code);
  }

  // One-hot rather than a string, so the summary has no string values at
  // all and the check for that can be absolute.
  const lockfile = seed(LOCKFILE_FORMATS);
  tally(lockfile, result?.run?.lockfileFormat);

  return {
    exitCode: Number(result?.exitCode ?? 0),
    suppressed: Number(result?.suppressed ?? 0),
    ignored: Number(result?.ignored ?? 0),
    findings: { total: findings.length, byRule, bySeverity },
    diagnostics: { total: diagnostics.length, byCode },
    lockfile,
  };
}

// Every key a summary is allowed to contain, derived from the same lists
// summarize counts into rather than written out a second time.
export function countedKeys() {
  return new Set([
    'exitCode',
    'suppressed',
    'ignored',
    'findings',
    'diagnostics',
    'lockfile',
    'total',
    'byRule',
    'bySeverity',
    'byCode',
    OTHER,
    ...RULE_IDS,
    ...SEVERITIES,
    ...DIAGNOSTIC_CODES,
    ...LOCKFILE_FORMATS,
  ]);
}

// The private tier's whole entry, not just its counts. A summary that
// carries nothing is no use if the record wrapped around it carries a path,
// so the wrapper is constrained too: a positional identifier, and counts.
// The position is derivable only by whoever holds the local repository
// list, which never leaves their machine.
const PRIVATE_REPO_ID = /^local-[1-9][0-9]*$/;

export function assertPrivateEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('a private-tier entry must be an object');
  }
  const keys = Object.keys(entry).sort();
  if (keys.join(',') !== 'counts,repo,sha') {
    throw new Error(
      `a private-tier entry carries exactly repo, sha and counts; found ${keys.join(', ')}`
    );
  }
  if (typeof entry.repo !== 'string' || !PRIVATE_REPO_ID.test(entry.repo)) {
    throw new Error(
      `a private-tier entry is identified by its position in the local list ("local-1"), ` +
        `not by anything read off the repository; found ${JSON.stringify(entry.repo)}`
    );
  }
  if (entry.sha !== null) {
    throw new Error('a private-tier entry records no commit');
  }
  assertCountsOnly(entry.counts);
  return entry;
}

export function assertCountsOnly(value, { allowed = countedKeys(), pathSoFar = '$' } = {}) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${pathSoFar} is not a finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    throw new Error(`${pathSoFar} is an array; a summary carries counts only`);
  }
  if (value === null || typeof value !== 'object') {
    throw new Error(
      `${pathSoFar} is a ${typeof value}; a summary carries counts only, and a string here ` +
        'would be something read out of the scanned repository'
    );
  }
  for (const [key, child] of Object.entries(value)) {
    if (!allowed.has(key)) {
      throw new Error(
        `${pathSoFar}.${key} is not a key this harness declares. A key that came from the ` +
          'scanned repository is exactly what the counts-only rule exists to prevent.'
      );
    }
    assertCountsOnly(child, { allowed, pathSoFar: `${pathSoFar}.${key}` });
  }
  return value;
}
