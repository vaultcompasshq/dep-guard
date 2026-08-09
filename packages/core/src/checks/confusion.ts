import type { Finding } from '../types.js';
import { isAllowed, isInternalName } from './allow.js';
import type { Check, CheckContext } from './types.js';

// Dependency confusion: a scoped package resolving from somewhere other
// than the private registry the project pinned it to, and a name that
// looks internal showing up as a plain public registry install at all
// (the classic namesquat: publish a package under the victim's internal
// name on the public registry and hope an unscoped install picks it up
// instead of the real one).
//
// Two independent rules. isInternalName is the one function every check
// reads for "does this name belong to us" (see allow.ts) -- existence
// already skips internal names on the strength of that same function, and
// this file calls it rather than re-deriving the same answer from
// internalScopes/internalPrefixes a second way, which is how two checks
// end up disagreeing about what a scope covers.
//
// Both rules admit an alias-protocol dependency at any kind, the same
// shape candidates.ts's newRegistryNames uses for existence/typosquat: an
// npm: alias retargets what actually installs independent of the
// manifest key, so "ui-kit": "npm:@acme/internal-ui@1.0.0" needs the same
// scrutiny as adding "@acme/internal-ui" directly would, and a *changed*
// alias's target has never been judged before (the delta carries no
// previous alias target to diff against). If rule 2 required kind 'added'
// AND protocol 'registry', an internal-scoped alias would be invisible to
// the whole engine -- existence deliberately skips internal names because
// this file is the one that owns them, so that combination would produce
// zero findings anywhere.

function scopeOf(name: string): string | null {
  if (!name.startsWith('@')) {
    return null;
  }
  const slash = name.indexOf('/');
  if (slash <= 1 || slash === name.length - 1) {
    return null;
  }
  return name.slice(0, slash);
}

// npmrc pin values are free text from a file the project controls but did
// not necessarily write for machine parsing -- an inline "#" comment
// after a registry URL is legal npmrc content that the .npmrc reader does
// not strip (state.ts only drops whole-line comments), and npm also
// accepts a protocol-relative pin ("//npm.acme.example/") or a bare
// DOTTED hostname/host:port with no scheme at all ("npm.acme.example",
// "localhost:4873" -- "localhost" is the one undotted exception), both of
// which state.ts's own reader preserves rather than rejecting. A bare
// `new URL()` call throws or yields no host on those forms, so a retry is
// attempted with an "https:" prefix before the value is treated as
// genuinely unparseable.
//
// If that retry were unconditional, WHATWG host parsing would accept
// nearly any space-free string as a syntactically valid host
// ("https://ghp_SECRET" parses to host "ghp_secret" without complaint) --
// so a leaked token or a stray filesystem path pasted into npmrc could
// become a "resolved" pin host and reach a high-severity finding
// verbatim. A host obtained through the retry therefore also has to look
// like a hostname -- contain a dot, or be exactly "localhost" -- to be
// trusted; anything else is treated the same as a parse failure. A host
// obtained directly, with no retry needed (the pin already carried its
// own explicit scheme), is not put through that extra check: an
// already-well-formed absolute URL is not the shape a stray secret takes.
//
// Note that only a DOTTED hostname passes the check above generically. A
// scheme-less SINGLE-LABEL internal host (a self-hosted registry
// literally named "verdaccio" or "artifactory-internal", no dot anywhere)
// and an IPv6 literal ("[::1]:4873") both fail the dot-or-localhost check
// and take the unparseable path with a visible npmrc-pin-unparseable
// diagnostic rather than being silently trusted. That is an accepted
// trade: a narrow false negative on real but uncommon pin shapes, made in
// exchange for closing the token-leak risk described above.
//
// Known gap: the dot requirement is a shape check, not a secret detector.
// A dot-bearing value -- a JWT-shaped secret ("header.payload.signature"),
// for instance -- still parses as a plausible "hostname" and can be
// echoed as pinHost. Dot-free token formats (ghp_*, npm_*, glpat-*, the
// shapes the retry guard above targets) cannot reach this path; a dotted
// secret remains a narrower residual risk this check does not close.
// Never throws.
function tryHost(value: string): string | null {
  try {
    const url = new URL(value);
    return url.host === '' ? null : url.host;
  } catch {
    return null;
  }
}

function looksLikeHostname(host: string): boolean {
  const hostname = host.split(':')[0];
  return hostname.includes('.') || hostname === 'localhost';
}

function hostOf(value: string): string | null {
  const direct = tryHost(value);
  if (direct !== null) {
    return direct;
  }
  const retried = tryHost(value.startsWith('//') ? `https:${value}` : `https://${value}`);
  return retried !== null && looksLikeHostname(retried) ? retried : null;
}

const UNPARSEABLE_PIN_CODE = 'npmrc-pin-unparseable';

// A pin that fails to parse even after the retry above would otherwise
// make rule 1 silently do nothing -- a scope pinned to a private registry
// that resolved to registry.npmjs.org would pass unreported with no trace
// of why. The scope is named so the gap is visible; the pin value itself
// never is, credential-adjacent even after its own stripping.
function noteUnparseablePin(ctx: CheckContext, scope: string): void {
  const diagnostic = {
    code: UNPARSEABLE_PIN_CODE,
    message: `scope "${scope}" has an npmrc registry pin that could not be parsed as a URL; dependency-confusion rule 1 was skipped for it`,
  };
  for (const existing of ctx.diagnostics) {
    if (existing.code === diagnostic.code && existing.message === diagnostic.message) {
      return;
    }
  }
  ctx.diagnostics.push(diagnostic);
}

// Rule 1's whole judgment, given a name and the host it resolved from: is
// this name in a scope the project pinned somewhere else? Both walks call
// it, because both produce resolutions and the rule must not mean two
// different things depending on which one reached it.
//
// Returns the finding without a manifest path or a lockfile path -- the
// walk that found it knows where it is located, and that is the one thing
// the two walks legitimately disagree about.
function pinMismatch(
  ctx: CheckContext,
  registryName: string,
  resolvedUrl: string | undefined,
  via: string
): Omit<Finding, 'fingerprint' | 'manifestPath'> | null {
  const scope = scopeOf(registryName);
  if (scope === null) {
    return null;
  }
  const pin = ctx.npmrcRegistryPins.get(scope);
  if (pin === undefined) {
    return null;
  }
  const pinHost = hostOf(pin);
  if (pinHost === null) {
    noteUnparseablePin(ctx, scope);
    return null;
  }
  if (resolvedUrl === undefined) {
    return null;
  }
  const resolvedHost = hostOf(resolvedUrl);
  if (resolvedHost === null || pinHost === resolvedHost) {
    return null;
  }
  return {
    ruleId: 'dependency-confusion',
    severity: 'high',
    packageName: registryName,
    message:
      `"${registryName}"${via} is pinned to registry host "${pinHost}" for scope "${scope}" ` +
      `but resolved from host "${resolvedHost}" instead.`,
    // The host it actually resolved from is part of the signal, not
    // merely a detail beside it. A baseline entry records a fact a user
    // accepted -- "this dependency came from the wrong place" is a
    // category, and accepting the category would accept every later wrong
    // place too. The pin host is left out: it is the same value the
    // scope's own configuration carries, and moving the pin is not the
    // event this finding is about.
    details: { signal: `pin-mismatch:${resolvedHost}`, scope, pinHost, resolvedHost },
  };
}

export const confusionCheck: Check = (ctx) => {
  const { delta, config, npmrcRegistryPins } = ctx;
  const findings: Omit<Finding, 'fingerprint'>[] = [];
  // Unlike existence/typosquat, this check loops over delta.changes
  // directly rather than a deduped candidate list (candidates.ts's
  // newRegistryNames), so two DepChanges resolving to the same
  // (manifestPath, registryName) -- two aliases retargeting one internal
  // package, say -- would each independently run whichever rule matched
  // and produce findings that hash identically (the fingerprint never
  // sees which alias or manifest key produced the change). Deduped on
  // (manifestPath, packageName, signal), not the pair alone: rule 1
  // (pin-mismatch) and rule 2 (internal-name) legitimately both fire for
  // one dependency and must not suppress each other.
  const seen = new Set<string>();
  const report = (finding: Omit<Finding, 'fingerprint'>): void => {
    const signal = typeof finding.details?.signal === 'string' ? finding.details.signal : '';
    const key = JSON.stringify([finding.manifestPath, finding.packageName, signal]);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    findings.push(finding);
  };

  for (const change of delta.changes) {
    if (change.protocol !== 'registry' && change.protocol !== 'alias') {
      continue;
    }
    const { registryName } = change;
    if (isAllowed(registryName, config.allow)) {
      continue;
    }
    // Rule 2's admission (below) mirrors candidates.ts: an added
    // dependency, or an alias at any kind. Rule 1 is NOT gated on this --
    // it is about whether a resolution matches its pin, which is exactly
    // as true of a changed registry dependency (a resolution repointed
    // with no manifest change at all) as of an added one, so it runs on
    // every admitted protocol at any kind.
    const via = change.protocol === 'alias' ? ` (aliased by dependency "${change.name}")` : '';

    // Rule 1: a scope pinned to a private registry resolved somewhere
    // else. The pin value itself never reaches a finding or a diagnostic
    // -- only the host each side parses to -- because a pin is
    // credential-adjacent even after .npmrc's own credential stripping,
    // and echoing it back out here would undo that.
    const mismatch = pinMismatch(ctx, registryName, change.after?.resolvedUrl, via);
    if (mismatch !== null) {
      report({ ...mismatch, manifestPath: change.manifestPath });
    }

    // Rule 2: a dependency whose name the project has told this tool is
    // internal, reaching the registry as a plain public install -- absent
    // from the public registry by design, so this is either a namesquat
    // or a misconfigured registry, either way worth a look before it
    // lands. Admits an added dependency at either protocol this check
    // considers, or an alias at any kind (see the top-of-file note).
    const admittedForRule2 = change.kind === 'added' || change.protocol === 'alias';
    if (admittedForRule2 && isInternalName(registryName, config.internalScopes, config.internalPrefixes)) {
      report({
        ruleId: 'dependency-confusion',
        severity: 'high',
        packageName: registryName,
        message: `"${registryName}"${via} matches a configured internal scope or prefix but resolves as a public registry dependency.`,
        manifestPath: change.manifestPath,
        details: { signal: 'internal-name' },
      });
    }
  }

  // Rule 1 judges a RESOLUTION, so it belongs on the lockfile walk as much
  // as tamper's and install-script's rules do. Read from delta.changes
  // alone it would see only the dependencies some manifest declares,
  // which in a real lockfile is a small minority of the tree -- and a
  // transitive package under a pinned scope quietly resolving from the
  // public registry is the dependency-confusion signature this rule
  // exists to catch. Rule 2 stays on the manifest walk, where it belongs:
  // it judges a NAME somebody declared, not a resolution.
  //
  // The dedupe in report() collapses the two views of a declared
  // dependency, exactly as it does in tamper.ts.
  for (const entryChange of delta.lockEntryChanges) {
    if (isAllowed(entryChange.packageName, config.allow)) {
      continue;
    }
    const mismatch = pinMismatch(ctx, entryChange.packageName, entryChange.after.resolvedUrl, '');
    if (mismatch !== null) {
      report({
        ...mismatch,
        manifestPath: entryChange.manifestPath,
        lockfilePath: entryChange.lockfilePath,
      });
    }
  }

  return findings;
};
