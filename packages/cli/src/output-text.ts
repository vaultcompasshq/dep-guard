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

// The not-checked reasons, in the order the line prints them. A reason
// prints only when its count is above zero. Each counts names, so they add
// up to the not-checked total; an unreadable lockfile is counted in files
// (its names are unknown by definition) and printed as a clause of its own
// rather than added to that total.
const NOT_CHECKED_REASONS: Array<[keyof ScanResult['run']['ecosystems']['pypi']['notChecked'], string]> = [
  ['budget', 'online budget spent'],
  ['unreachable', 'PyPI unreachable'],
  ['privateIndex', 'private index'],
  ['internal', 'internal name'],
];

/**
 * The "names:" line: per ecosystem, how many new names were checked and
 * how, and how many were read but not checked and why. Printed whenever at
 * least one Python manifest or lockfile was read, so an npm-only report is
 * unchanged; null otherwise. Every value is a count, none of it
 * repository content.
 */
export function renderNamesLine(result: ScanResult): string | null {
  const { npm, pypi } = result.run.ecosystems;
  if (pypi.manifests + pypi.lockfiles === 0) {
    return null;
  }
  const online = result.run.online.enabled;
  const parts: string[] = [];
  if (npm.manifests > 0) {
    const privateNote = npm.notChecked.privateScope > 0 ? `, ${npm.notChecked.privateScope} private scope not checked` : '';
    parts.push(`npm ${npm.checked} checked (${online ? 'corpus, registry' : 'corpus'})${privateNote}`);
  }
  const resemblance = "resemblance checked against this repository's own Python names";
  let python: string;
  if (!online) {
    python = `pypi ${pypi.candidates} not checked for existence (no PyPI corpus ships; pass --online), ${resemblance}`;
  } else {
    const reasons = NOT_CHECKED_REASONS.filter(([key]) => pypi.notChecked[key] > 0).map(
      ([key, label]) => `${pypi.notChecked[key]} ${label}`
    );
    const notChecked = NOT_CHECKED_REASONS.reduce((sum, [key]) => sum + pypi.notChecked[key], 0);
    python =
      `pypi ${pypi.existenceChecked} of ${pypi.candidates} checked for existence (PyPI)` +
      (notChecked > 0 ? `; ${notChecked} not checked: ${reasons.join(', ')}; ${resemblance}` : `, ${resemblance}`);
  }
  const unreadable = pypi.notChecked.lockfileUnreadable;
  if (unreadable > 0) {
    python += `; ${unreadable} lockfile${unreadable === 1 ? '' : 's'} unreadable, ${unreadable === 1 ? 'its' : 'their'} names not checked`;
  }
  const excluded = pypi.excluded.url + pypi.excluded.vcs + pypi.excluded.path + pypi.excluded.editable;
  if (excluded > 0) {
    python += `; ${excluded} url, path or vcs requirement${excluded === 1 ? '' : 's'} excluded`;
  }
  parts.push(python);
  return `names: ${parts.join('; ')}`;
}

function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The coverage statement: for each ecosystem the run saw (npm, Python, and
 * Go when go.mod or go.sum is present), whether it was read, which checks
 * ran, and which did not and why. Built only from run.ecosystems and
 * run.online, so every value is a count or a fixed phrase and none of it is
 * repository content. Empty when no ecosystem was seen, or for a run with no
 * repository behind it.
 */
export function renderCoverageLines(result: ScanResult): string[] {
  const { npm, pypi, go } = result.run.ecosystems;
  const online = result.run.online.enabled;
  const lines: string[] = [];

  if (npm.manifests > 0 && npm.lockfile !== 'not-applicable') {
    const ran = ['unknown-package', 'typosquat', 'version-hygiene', 'dependency-confusion'];
    const didNot: string[] = [];
    if (npm.lockfile === 'read') {
      // What the two lockfile checks can honestly claim: an audit scan has
      // nothing to compare, and a pnpm lockfile has no per-entry flag.
      ran.push(
        result.run.mode === 'audit'
          ? 'lockfile-tamper (git-source and url-source signals only; no earlier revision to compare)'
          : 'lockfile-tamper',
        result.run.lockfileFormat === 'pnpm'
          ? 'install-script (onlyBuiltDependencies only; pnpm lockfiles carry no per-entry flag)'
          : 'install-script'
      );
    } else if (npm.lockfile === 'missing') {
      didNot.push('lockfile-tamper and install-script (no npm or pnpm lockfile found)');
    } else {
      didNot.push('lockfile-tamper and install-script (a lockfile is present but dep-guard does not read its format)');
    }
    if (online) {
      ran.push('registered-squat', 'publish-age');
    } else {
      didNot.push('registered-squat and publish-age (they need --online)');
    }
    lines.push(
      `  npm: read, ${npm.lockfile === 'missing' ? 'no lockfile' : 'with a lockfile'}. Ran: ${ran.join(', ')}.` +
        (didNot.length > 0 ? ` Did not run: ${didNot.join(', ')}.` : '')
    );
  }

  if (pypi.manifests + pypi.lockfiles > 0) {
    const ran = online
      ? ['unknown-package (PyPI)', "typosquat against this repository's own Python names", 'tamper for git and url requirements']
      : ["typosquat against this repository's own Python names", 'tamper for git and url requirements'];
    const didNot: string[] = [];
    if (!online) {
      didNot.push('unknown-package (it needs --online; no PyPI corpus ships)');
    }
    didNot.push(
      'lockfile-tamper comparison and install-script (dep-guard reads npm and pnpm lockfiles only; Python lockfiles are read for names)'
    );
    let line =
      `  pypi: read (${plural(pypi.manifests, 'manifest')}, ${plural(pypi.lockfiles, 'lockfile')}). ` +
      `Ran: ${ran.join(', ')}. Did not run: ${didNot.join(', ')}.`;
    if (pypi.requirements > 0 && pypi.pinned === pypi.requirements) {
      line += ` All ${pypi.requirements} requirements are pinned exactly; pinned requirements are not a lockfile dep-guard compares.`;
    }
    lines.push(line);
  }

  if (go.files > 0) {
    lines.push(`  go: not read. go.mod and go.sum are not read by dep-guard (${plural(go.files, 'file')} seen).`);
  }

  return lines.length === 0 ? [] : ['coverage:', ...lines];
}

// Notes that state what an audit scan (no earlier revision to compare
// against) could not do. Several of them repeat on every audit run, so the
// text report folds them into one line; the JSON result keeps each one.
const AUDIT_LIMIT_CODES: ReadonlySet<string> = new Set([
  'audit-no-tamper-comparison',
  'pnpm-no-install-script-flag',
  'pypi-names-not-checked',
]);
const AUDIT_LIMITS_CODE = 'audit-limits';

// The diagnostics as note lines, with an audit run's limits folded into one
// "limits of this scan" line at the place the first of them stood. The
// folded line carries every message in full, numbered, so nothing the
// separate notes said is lost; a single limit is left as its own note.
function renderDiagnosticLines(result: ScanResult): string[] {
  const { diagnostics } = result.run;
  const limits = result.run.mode === 'audit' ? diagnostics.filter((entry) => AUDIT_LIMIT_CODES.has(entry.code)) : [];
  if (limits.length < 2) {
    return diagnostics.map(renderDiagnosticLine);
  }
  const lines: string[] = [];
  let folded = false;
  for (const diagnostic of diagnostics) {
    if (!AUDIT_LIMIT_CODES.has(diagnostic.code)) {
      lines.push(renderDiagnosticLine(diagnostic));
    } else if (!folded) {
      folded = true;
      lines.push(
        renderDiagnosticLine({
          code: AUDIT_LIMITS_CODE,
          message: `limits of this scan: ${limits.map((limit, index) => `(${index + 1}) ${sanitizeText(limit.message)}`).join('; ')}`,
        })
      );
    }
  }
  return lines;
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

  // A run that scanned and still could not stand behind its verdict (exit
  // 2 with a report): the one line right after the findings. The names in
  // it are repository content, so it is sanitized like a finding.
  if (result.run.couldNotRun !== undefined) {
    lines.push('');
    lines.push(sanitizeText(result.run.couldNotRun.message));
  }

  if (result.run.diagnostics.length > 0) {
    lines.push('');
    lines.push(...renderDiagnosticLines(result));
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

  // Pull-request mode, printed only when the run was actually in it, so a
  // report without --trust-base is byte-identical to what it was before
  // the flag existed.
  //
  // Placed AFTER the allow line on purpose. The two say different things
  // and a reviewer needs both: the allow line is what the BASE allow list
  // actually cleared on this run, and the proposals below are what the
  // pull request asked for and did not get. Read in that order they say
  // "here is what the approved config did" and then "here is what this
  // change wanted instead".
  //
  // Every proposal is sanitized. A proposal names package names and
  // ignorePaths entries straight out of a config file the pull request
  // wrote, which is exactly the repository-controlled content the finding
  // and diagnostic renderers above already sanitize; a proposal line is no
  // safer a place for an ANSI escape than a finding message is.
  //
  // The no-proposals case prints a line rather than nothing, for the
  // reason `allowed` prints at zero: a run that says nothing about its
  // control inputs is indistinguishable from a run that was never in
  // pull-request mode at all, and that is the state this whole feature
  // exists to make visible.
  if (result.trustBase !== undefined) {
    lines.push('');
    lines.push(`Pull-request mode: control inputs from ${sanitizeText(result.trustBase.ref)}`);
    if (result.trustBase.proposals.length === 0) {
      lines.push('  no control input changed in this pull request');
    } else {
      for (const proposal of result.trustBase.proposals) {
        lines.push(`  ${sanitizeText(proposal)}`);
      }
    }
  }

  // "kept over ignorePaths" is printed, at zero too, on every run that had
  // a side to judge the change against, which is where an ignorePaths
  // entry can be refused for a path the change wires into the install. The
  // scan records that itself: an audit has no such side, and neither has a
  // staged run with no committed HEAD and no trust base.
  const ignoreRuleApplies = result.ignoreRuleApplied === true;
  lines.push('');
  lines.push(
    `dep-guard ${result.run.mode}: ${result.findings.length} finding(s), ` +
      `${result.suppressed} suppressed, ${result.ignored} ignored, ` +
      (ignoreRuleApplies ? `${result.ignoreKept ?? 0} kept over ignorePaths, ` : '') +
      `${result.allowed} allowed, ` +
      `fail-on=${result.run.failOn}, blocking=${result.run.blockingMatches}, ` +
      `exit=${result.exitCode}`
  );
  const names = renderNamesLine(result);
  if (names !== null) {
    lines.push(names);
  }
  lines.push(...renderCoverageLines(result));

  // One line under the summary, only when online checks actually ran
  // (issue #75): a disabled run has nothing to add here that the summary
  // line above does not already imply, and printing five zeros on every
  // ordinary offline run would be noise on the common case. All five
  // numbers are already plain facts about this run, none of them
  // repository-controlled content, so nothing here needs sanitizeText.
  if (result.run.online.enabled) {
    lines.push(
      `online: budgetMs=${result.run.online.budgetMs}, ` +
        `lookupsAttempted=${result.run.online.lookupsAttempted}, ` +
        `cacheHits=${result.run.online.cacheHits}, ` +
        `lookupsSkippedByDeadline=${result.run.online.lookupsSkippedByDeadline}, ` +
        `deadlineExceeded=${result.run.online.deadlineExceeded}`
    );
  }

  return lines.join('\n');
}
