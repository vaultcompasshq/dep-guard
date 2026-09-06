// Renders a ScanResult for a human reading a terminal. JSON mode (in
// cli.ts) never goes through this file -- it prints the ScanResult object
// verbatim -- but cli.ts's stderr notes in JSON mode reuse
// renderDiagnosticLine, so this module owns sanitization for both output
// paths where free-text repository content reaches a terminal.
import type { Diagnostic, Finding, ScanResult, Severity } from '@vaultcompass/dep-guard-core';

// Worst first, so a human scanning the report top-to-bottom sees the
// thing that would block the run before anything else.
const SEVERITY_DISPLAY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

// A finding's message and a diagnostic's message both originate from
// repository-controlled content -- a package name, a workspace glob, an
// ignorePaths entry straight out of .dep-guard.json -- and can carry ANSI
// escapes or embedded newlines. Left alone, a crafted manifest could
// inject extra lines into this tool's own report or send control
// sequences to whoever's terminal is reading it. Newlines collapse to a
// single space first, so "a\nb" reads as "a b" on one line rather than
// splitting into two; every remaining C0/C1 control character (including
// the ESC that starts an ANSI sequence) is then stripped outright.
//
// The strip set also covers the Unicode bidi-control and zero-width
// characters (U+200B-200F, U+202A-202E, U+2066-2069): a package name
// carrying a right-to-left override can make its own tail render
// reversed in a terminal, the exact trojan-source trick this security
// tool must not let its own report become a vector for.
const CONTROL_CHARS = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069]',
  'g'
);

export function sanitizeText(input: string): string {
  return input.replace(/\r\n|\r|\n/g, ' ').replace(CONTROL_CHARS, '');
}

function renderFinding(finding: Finding): string {
  const location = finding.lockfilePath
    ? `${finding.manifestPath}, ${finding.lockfilePath}`
    : finding.manifestPath;
  return `  ${sanitizeText(finding.packageName)}  [${finding.severity}]  ${finding.ruleId}  ${sanitizeText(finding.message)} (${sanitizeText(location)})`;
}

// Diagnostics are informational, never alarming -- check-single-name-only
// fires on every single checkSingle call by design, so rendering
// diagnostics as warnings would make every "check" invocation look like
// something went wrong. "note" is the one label used for all of them.
export function renderDiagnosticLine(diagnostic: Diagnostic): string {
  return `note (${diagnostic.code}): ${sanitizeText(diagnostic.message)}`;
}

export function renderText(result: ScanResult): string {
  const lines: string[] = [];

  const bySeverity = new Map<Severity, Finding[]>();
  for (const severity of SEVERITY_DISPLAY_ORDER) {
    bySeverity.set(severity, []);
  }
  for (const finding of result.findings) {
    bySeverity.get(finding.severity)?.push(finding);
  }

  if (result.findings.length === 0) {
    lines.push('No findings.');
  } else {
    for (const severity of SEVERITY_DISPLAY_ORDER) {
      const findings = bySeverity.get(severity) ?? [];
      if (findings.length === 0) {
        continue;
      }
      lines.push(`${severity.toUpperCase()} (${findings.length})`);
      for (const finding of findings) {
        lines.push(renderFinding(finding));
      }
    }
  }

  if (result.run.diagnostics.length > 0) {
    lines.push('');
    for (const diagnostic of result.run.diagnostics) {
      lines.push(renderDiagnosticLine(diagnostic));
    }
  }

  // suppressed, ignored and allowed are three different facts -- dropped by
  // the baseline, by ignorePaths, and by an allow entry -- and are printed
  // as three separate numbers here for the same reason ScanResult carries
  // them as three separate fields: collapsing any of them into another
  // count would re-hide the exact footgun the core fixed. allowed is
  // printed even at zero like the other two, because an allow entry is the
  // user's earlier decision and a scan that silently omits it reads
  // identical to one with no allow entries at all.
  //
  // Which names the allow list cleared is spelled out on its own line when
  // there are any, so the count is attributable rather than a bare number;
  // the names come from repository-controlled config, so each is sanitized
  // the same way a finding's package name is.
  if (result.allowedNames.length > 0) {
    lines.push('');
    lines.push(
      `Cleared by the allow list (${result.allowed}): ` +
        result.allowedNames.map(sanitizeText).join(', ')
    );
  }

  lines.push('');
  lines.push(
    `dep-guard ${result.run.mode}: ${result.findings.length} finding(s), ` +
      `${result.suppressed} suppressed, ${result.ignored} ignored, ` +
      `${result.allowed} allowed, ` +
      `fail-on=${result.run.failOn}, blocking=${result.run.blockingMatches}, ` +
      `exit=${result.exitCode}`
  );

  return lines.join('\n');
}
