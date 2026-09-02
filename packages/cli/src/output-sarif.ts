// Renders a ScanResult as SARIF 2.1.0, for GitHub code scanning and any
// other consumer that speaks it.
//
// The mapping below is the vaultcompass family's decided mapping, shared
// across its gates rather than invented per tool, so a consumer reading
// two of these reports can rely on the same fields meaning the same
// things. The rules that are easy to get subtly wrong, and why each one
// is the way it is:
//
//  - `properties.blocking` is dep-guard's OWN decision, taken by calling
//    core's isBlocking with the failOn the run actually used. It is never
//    recomputed from a severity ladder kept in this file. A second copy of
//    the gate living in the renderer is exactly the described-not-derived
//    shape docs/INVARIANTS.md is about, and it would drift silently: the
//    SARIF report would say "blocking: false" about a finding that had
//    just failed somebody's build.
//
//  - `partialFingerprints` reuses the finding's existing fingerprint,
//    unchanged and unhashed. GitHub uses partialFingerprints to track an
//    alert across commits, and dep-guard already has a stability contract
//    for exactly that purpose (docs/INVARIANTS.md, "The fingerprint is a
//    promise about facts"). Hashing something new here would mint a second
//    identity for every finding, one that moves when the first one does
//    not, and every alert would resurface on the next scan.
//
//  - The physical location's uri is RELATIVE, with forward slashes, under
//    `%SRCROOT%`. An absolute path breaks %SRCROOT% resolution on the
//    consumer side and leaks a local directory layout into an artifact
//    that gets uploaded. Findings already carry repository-root-relative
//    paths (docs/INVARIANTS.md, "Path spellings have one source"), so this
//    normalises rather than recomputes: a leading "./" is dropped,
//    backslashes become forward slashes, and BOTH spellings of an
//    absolute path are stripped -- a leading "/" and a Windows drive
//    prefix like "C:/". The drive prefix is the one that was missed
//    first time: it is just as absolute as a leading slash, and stripping
//    only the slash left it to reach an uploaded artifact intact.
//
//  - No physical location at all for a `dep-guard check` result. That
//    command answers "is this name safe to add", a question with no file
//    behind it, so core fabricates a "package.json" manifestPath for it.
//    Emitting a physical location for that would annotate the consumer's
//    REAL root manifest with a finding about a package that is not in it.
//    A missing location is honest; a fabricated one is worse than none,
//    and it is indistinguishable from a true one once uploaded, exactly
//    like a guessed line number. The discriminator is core's own
//    CHECK_SINGLE_DIAGNOSTIC_CODE rather than the path spelling, because
//    a real audit-mode finding at the repository root carries that same
//    literal path and must keep its location.
//
//  - A region is emitted ONLY when a real line number is known, and no
//    rule produces one today. An invented startLine annotates an unrelated
//    line of somebody's manifest and is indistinguishable from a true one
//    once uploaded, so the field is absent rather than guessed. The
//    reader is written now so the day a rule does record a line, nothing
//    has to change here but the rule.

import { CHECK_SINGLE_DIAGNOSTIC_CODE, isBlocking } from '@vaultcompass/dep-guard-core';
import type { Finding, RuleId, ScanResult, Severity } from '@vaultcompass/dep-guard-core';

export const SARIF_RULE_NAMESPACE = 'dep-guard';

// Versioned on purpose. If the fingerprint's four components ever change
// (which docs/INVARIANTS.md says waits for a major version, because it
// invalidates every baseline), the new one ships under "dep-guard/v2" and
// a consumer can tell the two apart instead of silently comparing hashes
// of different things.
export const SARIF_FINGERPRINT_KEY = 'dep-guard/v1';

const SARIF_SCHEMA =
  'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json';

// Typed as a total map over RuleId, not a lookup with a fallback: a rule
// added to core's RuleId union without a description here is a compile
// error rather than a result that uploads with an empty rule name.
const RULE_DESCRIPTIONS: Record<RuleId, string> = {
  'unknown-package': 'A dependency name that is not a known published package',
  typosquat: 'A dependency name that closely resembles a popular package',
  'install-script': 'A dependency that runs a script at install time',
  'lockfile-tamper': 'A lockfile entry whose resolution or integrity changed suspiciously',
  'version-hygiene': 'A dependency specifier that does not pin a reviewable version',
  'dependency-confusion': 'A dependency name or resolution that crosses an internal boundary',
  'registered-squat': 'A recently published, near-unused package name',
};

// Severity to SARIF level. Total over Severity for the same reason
// RULE_DESCRIPTIONS is total over RuleId. dep-guard has no 'info'
// severity today (core's Severity union is critical, high, medium, low);
// the family mapping assigns info to "note" alongside low, so if one is
// ever added, this map gains one entry and nothing else moves.
const SARIF_LEVELS: Record<Severity, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
};

function toUri(manifestPath: string): string {
  let uri = manifestPath.split('\\').join('/');
  // A Windows drive prefix is absolute exactly as a leading slash is, and
  // stripping only the slash left "C:/project/package.json" intact.
  // Removed before the slash loop below so "C:/x" reduces the whole way
  // rather than to "/x".
  uri = uri.replace(/^[A-Za-z]:\/*/, '');
  while (uri.startsWith('./')) {
    uri = uri.slice(2);
  }
  // A leading slash would make the uri absolute and %SRCROOT% meaningless.
  // Findings are anchored at the repository root and should never produce
  // one; this is the belt to that braces, because the cost of being wrong
  // is a local path in an uploaded artifact.
  while (uri.startsWith('/')) {
    uri = uri.slice(1);
  }
  return uri;
}

// A line number is usable only if it is a positive integer. Anything else
// -- a float, a zero, a numeric string, a null -- is not a line, and
// coercing it into one is the invention this mapping forbids.
function readStartLine(details: Record<string, unknown> | undefined): number | undefined {
  const raw = details?.manifestLine;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return undefined;
  }
  return raw;
}

function toResult(
  finding: Finding,
  failOn: ScanResult['run']['failOn'],
  syntheticAnchor: boolean
): unknown {
  const startLine = readStartLine(finding.details);
  const physicalLocation: Record<string, unknown> = {
    artifactLocation: { uri: toUri(finding.manifestPath), uriBaseId: '%SRCROOT%' },
  };
  if (startLine !== undefined) {
    physicalLocation.region = { startLine };
  }

  const location: Record<string, unknown> = {
    logicalLocations: [{ kind: 'package', fullyQualifiedName: finding.packageName }],
  };
  if (!syntheticAnchor) {
    location.physicalLocation = physicalLocation;
  }

  return {
    ruleId: `${SARIF_RULE_NAMESPACE}/${finding.ruleId}`,
    level: SARIF_LEVELS[finding.severity],
    message: { text: finding.message },
    properties: {
      blocking: isBlocking(finding, failOn),
      severity: finding.severity,
      // The details bag verbatim. Not reshaped, not filtered: it is where
      // every rule puts what it actually established, and a consumer
      // reading a dep-guard SARIF report is entitled to the same bag a
      // consumer reading the JSON report gets.
      details: finding.details ?? {},
    },
    partialFingerprints: { [SARIF_FINGERPRINT_KEY]: finding.fingerprint },
    locations: [location],
  };
}

/**
 * Renders one ScanResult as a SARIF 2.1.0 log.
 *
 * `version` is the dep-guard version to report as tool.driver.version.
 * It is a parameter rather than read from package.json here so this
 * module stays free of filesystem access and the CLI keeps one place
 * where its own version is read.
 */
export function renderSarif(result: ScanResult, version: string): string {
  // Every rule is declared, not only the ones this run happened to
  // report. A consumer that lists a tool's rules should see dep-guard's
  // whole rule set rather than a set that changes shape depending on what
  // the last scan found.
  // A checkSingle result, whose manifestPath is fabricated. Detected by
  // core's own diagnostic code rather than by the path spelling, since a
  // genuine audit-mode finding at the repository root carries the same
  // literal "package.json" and must keep its physical location.
  const syntheticAnchor = result.run.diagnostics.some(
    (diagnostic) => diagnostic.code === CHECK_SINGLE_DIAGNOSTIC_CODE
  );

  const rules = (Object.keys(RULE_DESCRIPTIONS) as RuleId[]).map((ruleId) => ({
    id: `${SARIF_RULE_NAMESPACE}/${ruleId}`,
    name: ruleId,
    shortDescription: { text: RULE_DESCRIPTIONS[ruleId] },
  }));

  const sarif = {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'dep-guard', version, informationUri: 'https://github.com/vaultcompasshq/dep-guard', rules } },
        results: result.findings.map((finding) =>
          toResult(finding, result.run.failOn, syntheticAnchor)
        ),
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}
