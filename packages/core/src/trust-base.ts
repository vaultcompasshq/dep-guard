/**
 * Pull-request mode: read every control input from the base ref.
 *
 * The defect this closes, stated plainly. Every input that decides what
 * dep-guard reports lived inside the tree dep-guard was judging. On a
 * pull_request run the pull request's author owns those files, so one
 * commit could add a hallucinated dependency AND add that dependency's
 * name to `allow`, or add its manifest to `ignorePaths`, or raise `failOn`
 * above the finding's severity, or write the finding's own fingerprint
 * into the baseline. The gate read the rewritten control input, agreed
 * with it, and exited 0.
 *
 * The fix is not a heuristic about which edits look suspicious. It is base
 * versus head, and it is plain git: on a pull-request run the CONTROL
 * INPUTS come from the base ref, and the head tree is the thing under
 * judgment. A control input that differs between the two never takes
 * effect for the run, and the report says it was proposed. Outside
 * pull-request mode nothing changes, because a pre-commit hook and a
 * direct CLI run are already inside the trust boundary.
 *
 * Three rules hold everything here together, and they are the same three
 * the family's other gates hold to:
 *
 *  - READS ONLY, AND NEVER INTO THE REPOSITORY. `git rev-parse`,
 *    `git ls-tree` and `git show`, all of which only read. No checkout
 *    switch, no stash, no temporary worktree, no write of any kind. A gate
 *    that moved the user's HEAD to do its job would be a worse bug than
 *    the one it fixes.
 *
 *  - FAIL CLOSED ON THE REF. A ref that will not resolve is could-not-run
 *    and exits 2. It is never a reason to fall back to the head, because
 *    falling back to the head is precisely the behaviour being removed,
 *    and it would be reachable by anyone who could make the base ref
 *    unfetchable.
 *
 *  - A MISSING PATH AT THE BASE IS NOT A FAILURE. It is the ordinary state
 *    of a branch adopting the tool for the first time, and it means "no
 *    control input", which this tool already knows how to report: the
 *    defaults, and an empty baseline. The ref is verified first precisely
 *    so this case can be told apart from a broken ref.
 *
 * `--trust-base` is NOT `--base`, and the two never imply each other.
 * `--base <ref>` decides which lockfile and manifest state the working
 * tree is compared against -- what the change under judgment even is.
 * `--trust-base <ref>` decides where the config and the baseline are read
 * from -- what the rules for judging it are. In CI they usually name the
 * same ref, because the base branch is both the state you diverged from
 * and the state whose rules were approved, but they are two questions and
 * either can be asked without the other.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BASELINE_FILE, parseBaseline } from './baseline.js';
import type { ResolvedConfig } from './checks/types.js';
import { CONFIG_FILE, LOCAL_CONFIG_FILE, loadConfigFromTexts } from './config.js';
import { NPMRC, isUsableRef } from './git-source.js';
import { parseNpmrcPins } from './state.js';
import { DepGuardError } from './types.js';

const execFileAsync = promisify(execFile);

// Same cap git-source.ts uses. A control file is small, but the cap is
// about not letting an overrun kill the child silently rather than about
// the expected size.
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The one line a report prints when the head proposes a different config. */
export const CONFIG_PROPOSAL_LINE = 'config changed in this pull request';

/** The one line a report prints when the head proposes a different baseline. */
export const BASELINE_PROPOSAL_LINE = 'baseline changed in this pull request';

/** The line for a control input the head introduces and the base does not carry. */
export const CONFIG_ADDED_LINE = 'config added in this pull request';

/** The same, for the baseline. */
export const BASELINE_ADDED_LINE = 'baseline added in this pull request';

/**
 * The one line a report prints when the head proposes a different .npmrc.
 *
 * .npmrc earns its place beside the config and the baseline because its
 * scope pins GATE a rule rather than being judged by one: the
 * dependency-confusion pin-mismatch rule fires only for a scope that has a
 * pin, so a pull request that deletes .npmrc deletes the rule. That was
 * live: a base pinning @scope to a private host, a pull request adding
 * @scope/pkg from the public registry, exit 1; the same pull request also
 * deleting .npmrc, exit 0 and a report that said no control input had
 * changed.
 */
export const NPMRC_PROPOSAL_LINE = 'npmrc changed in this pull request';

/** The same, for an .npmrc the head introduces and the base does not carry. */
export const NPMRC_ADDED_LINE = 'npmrc added in this pull request';

/** How many names a parenthetical spells out before it starts counting. */
const MAX_NAMED_ENTRIES = 5;

/** What kind of file the head made a control input into, when that changed. */
export type ControlShapeChange = 'symlink' | 'not-a-file' | 'removed' | 'mode';

export interface ControlFile {
  /** Path relative to the repository root, as it exists at that side. */
  path: string;
  /** Blob contents. For a symlink this is the LINK TARGET, not the file. */
  text: string;
  /**
   * The git file mode: 100644 a regular file, 100755 an executable one,
   * 120000 a symlink, 160000 a submodule, 040000 a directory.
   *
   * Carried because the CONTENT of a control input is not the whole of it.
   * Replacing .dep-guard.json with a symlink whose target holds the base
   * config's exact bytes changes nothing a content comparison can see, and
   * that is the first half of a two-step: land the link, then widen the
   * link target in a later pull request where .dep-guard.json never
   * appears in the diff at all.
   */
  mode: string;
  /** The git object type: blob, tree, or commit. */
  type: string;
}

export interface TrustedControls {
  /** The ref every control input was taken from. */
  ref: string;
  /** The base ref's config, validated, or the defaults when it carries none. */
  config: ResolvedConfig;
  /** The base ref's baseline fingerprints, empty when it carries none. */
  baseline: Set<string>;
  /**
   * The base ref's .npmrc scope-to-registry pins, empty when it carries
   * none. These decide whether the dependency-confusion pin-mismatch rule
   * has anything to compare against, which is why they come from the base.
   */
  npmrcPins: Map<string, string>;
  /** True when the head proposes a different config. */
  configChanged: boolean;
  /** True when the head proposes a different baseline. */
  baselineChanged: boolean;
  /** True when the head proposes different .npmrc scope pins. */
  npmrcChanged: boolean;
  /** How the head changed the SHAPE of a config file, or null. */
  configShapeChange: ControlShapeChange | null;
  /** The same for the baseline file. */
  baselineShapeChange: ControlShapeChange | null;
  /** The same for .npmrc. */
  npmrcShapeChange: ControlShapeChange | null;
  /** One line per control input the head proposes to change. */
  proposals: string[];
}

/**
 * True for the two modes that mean an ordinary file git will hand back.
 * 100644 is a regular file, 100755 the same with the execute bit.
 */
export function isRegularFileMode(mode: string): boolean {
  return mode === '100644' || mode === '100755';
}

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * What a rev resolves to, or null when it does not resolve here.
 *
 * `--quiet` suppresses git's own explanation, so there is nothing worth
 * forwarding on failure: the exception text would be
 * "Command failed: git rev-parse --verify --quiet origin/nope", which is a
 * command line to run rather than a thing to fix. Null, and the caller
 * writes the sentence.
 */
async function resolve(root: string, rev: string, kind: 'commit' | 'tree'): Promise<string | null> {
  const out = await git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{${kind}}`]);
  if (out === null) {
    return null;
  }
  const trimmed = out.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Refuse the run unless the ref names a commit that is NOT the one being
 * judged.
 *
 * Three refusals, and the last two are the ones that matter.
 *
 * Resolving the ref at all is verified BEFORE any path is read, which is
 * what lets a path that is simply absent at the base be read as "no
 * control input" rather than as a broken setup. Without this order the two
 * are the same non-zero exit from git.
 *
 * The ref must then differ from HEAD, because a trust base that IS the
 * head commit puts the whole boundary back where it started: every control
 * input comes from the tree under judgment, no config change can ever
 * differ from its own base, and the run reports pull-request mode as on
 * while checking the pull request against its own rewritten rules. Nothing
 * about that state is visible in a green tick.
 *
 * It is not a hypothetical typo. A workflow author writing
 * `--trust-base ${{ github.sha }}` gets exactly this, because on a
 * pull_request event with the default actions/checkout that SHA is the
 * merge commit, which is HEAD. The comparison is on the RESOLVED COMMITS
 * rather than on the spelling, since the same commit reached through a
 * branch name, a tag or a raw SHA is the same hole.
 *
 * AND THE TREES MUST DIFFER TOO, which the commit comparison alone does
 * not give. Two different commits can carry one identical tree, and then
 * every control input still comes from the tree under judgment while the
 * commit check waves it through. This is not a curiosity: what GitHub
 * publishes as refs/pull/N/merge is a merge commit whose tree, when the
 * base has not moved since the fork, IS the head branch's tree, and
 * actions/checkout leaves that commit checked out. A workflow passing
 * `--trust-base ${{ github.event.pull_request.head.sha }}` then names a
 * different commit holding the same tree, and the muting change passes.
 *
 * Merging the base into the branch changes the head's tree, so a pull
 * request that does that is judged normally rather than swallowed by this
 * rule.
 *
 * A branch with no commits ahead of its base resolves to the same commit
 * and is refused too. That is not a case this can tell apart from the
 * misconfiguration, and a pull request with nothing in it has nothing for
 * the gate to judge either way.
 */
export async function assertTrustBaseUsable(root: string, ref: string): Promise<void> {
  // Screened against the same pattern --base is screened against, before
  // the ref reaches git as an argument: a ref beginning with "-" would be
  // read as an option by whichever git command receives it.
  if (!isUsableRef(ref)) {
    throw new DepGuardError(
      `trust base "${ref}" is not a usable git ref. Nothing was checked.`,
      'trust-base-unresolvable'
    );
  }

  const base = await resolve(root, ref, 'commit');
  if (base === null) {
    throw new DepGuardError(
      `cannot read control inputs from trust base "${ref}": it does not resolve to a commit ` +
        'in this repository. Nothing was checked. In CI, fetch the base branch ' +
        '(actions/checkout with fetch-depth: 0) before running the gate.',
      'trust-base-unresolvable'
    );
  }

  const head = await resolve(root, 'HEAD', 'commit');
  if (head === null) {
    // No head commit to compare against, so the one property that makes
    // pull-request mode mean anything cannot be established. Fail closed:
    // this is could-not-run, not a quiet downgrade to trusting the head.
    throw new DepGuardError(
      `cannot resolve HEAD to compare against trust base "${ref}": this is not a git ` +
        'repository with any commits. Pull-request mode needs both a base commit and a ' +
        'head commit. Nothing was checked.',
      'trust-base-unresolvable'
    );
  }

  if (base === head) {
    throw new DepGuardError(
      `refusing "${ref}" as the trust base: it resolves to ${head}, the same commit as ` +
        'HEAD, so every control input would come from the tree being judged and ' +
        'pull-request mode would be off while still reporting as on. Pass the base branch ' +
        '(for example origin/main), not the head commit: on a pull_request event ' +
        'github.sha is the merge commit, which is HEAD. Nothing was checked.',
      'trust-base-is-head'
    );
  }

  const baseTree = await resolve(root, ref, 'tree');
  const headTree = await resolve(root, 'HEAD', 'tree');
  if (baseTree !== null && headTree !== null && baseTree === headTree) {
    throw new DepGuardError(
      `refusing "${ref}" as the trust base: it is a different commit from HEAD but carries ` +
        `an identical tree (${headTree}), so every control input would come from the tree ` +
        'being judged and there would be nothing for pull-request mode to compare. A pull ' +
        "request's merge ref looks exactly like this when the base has not moved. Pass the " +
        'base branch (for example origin/main), not the head or merge commit. Nothing was ' +
        'checked.',
      'trust-base-same-tree'
    );
  }
}

/**
 * One file's contents at a ref, or null when the ref does not carry it.
 *
 * The `./` is load-bearing. It makes git resolve the path relative to the
 * working directory rather than to the repository root. Every caller here
 * passes the repository toplevel, so today the two are the same path --
 * but git-source.ts anchors this tool at the toplevel deliberately, and a
 * spelling that keeps working if that ever changes is free.
 */
async function readFileAtRef(root: string, ref: string, relativePath: string): Promise<string | null> {
  return git(root, ['show', `${ref}:./${relativePath}`]);
}

/**
 * The tree entry for one path at a ref, or null when the ref has no such
 * path.
 *
 * ls-tree rather than `git show` alone, because `git show ref:path` on a
 * symlink prints the link target and says nothing about the entry being a
 * link. The mode is the only place that fact lives.
 */
async function treeEntry(
  root: string,
  ref: string,
  relativePath: string
): Promise<{ mode: string; type: string } | null> {
  const out = await git(root, ['ls-tree', ref, '--', `./${relativePath}`]);
  if (out === null) {
    return null;
  }
  const line = out.split('\n').find((candidate) => candidate.trim().length > 0);
  if (line === undefined) {
    return null;
  }
  const [mode, type] = line.split(/\s+/);
  if (!mode || !type) {
    return null;
  }
  return { mode, type };
}

/**
 * One control file at a ref, or null when that ref does not carry it.
 *
 * BOTH sides of the comparison go through this, base and head alike. A
 * head side read from the working tree with readFileSync would follow
 * symlinks: the base side would then hold a link target string while the
 * head side held the linked file's contents, the two would compare equal,
 * and a pull request that turned .dep-guard.json into a symlink would be
 * reported as having changed no control input at all. One reader for both
 * sides is the only way the two can be compared on equal terms.
 */
export async function readControlFileAtRef(
  root: string,
  ref: string,
  relativePath: string
): Promise<ControlFile | null> {
  const entry = await treeEntry(root, ref, relativePath);
  if (entry === null) {
    return null;
  }
  // A non-blob (a directory, a submodule) has no contents to read, and the
  // empty string keeps it distinguishable from a missing entry while the
  // mode carries what it actually is.
  const text = entry.type === 'blob' ? ((await readFileAtRef(root, ref, relativePath)) ?? '') : '';
  return { path: relativePath, text, mode: entry.mode, type: entry.type };
}

/**
 * Whether two control files differ in what they SAY.
 *
 * Compared as parsed documents rather than as bytes, so a reindented file
 * or a trailing newline is not reported as a proposal to loosen the gate;
 * a report that cries wolf on whitespace is a report reviewers learn to
 * skip. When either side will not parse, the raw text is compared instead,
 * which is the fail-closed direction: an unparseable head config is
 * reported as a change rather than quietly matching.
 *
 * Key ORDER still counts as a difference, because JSON.stringify preserves
 * insertion order. That over-reports rather than under-reports, which is
 * the correct direction for a line whose only effect is to tell a reviewer
 * to look.
 */
function documentsDiffer(base: string | null, head: string | null): boolean {
  if (base === null && head === null) {
    return false;
  }
  if (base === null || head === null) {
    return true;
  }
  try {
    return JSON.stringify(JSON.parse(base) ?? null) !== JSON.stringify(JSON.parse(head) ?? null);
  } catch {
    return base !== head;
  }
}

/**
 * How the head changed the SHAPE of a control input, or null when it did
 * not.
 *
 * Distinct from a content change because the shape is the part a content
 * comparison is blind to, and because each of these deserves its own
 * sentence in the report: "the config is now a link" and "the config now
 * has the execute bit" are not the same news.
 */
function shapeChange(base: ControlFile | null, head: ControlFile | null): ControlShapeChange | null {
  if (head === null) {
    return base === null ? null : 'removed';
  }
  if (head.mode === '120000') {
    return 'symlink';
  }
  if (!isRegularFileMode(head.mode)) {
    return 'not-a-file';
  }
  if (base !== null && base.mode !== head.mode) {
    return 'mode';
  }
  return null;
}

/** One line naming a shape change, for the proposals list. */
function shapeProposal(input: string, change: ControlShapeChange): string {
  switch (change) {
    case 'symlink':
      return `${input} is a symlink at the head commit, not a regular file`;
    case 'not-a-file':
      return `${input} is not a regular file at the head commit`;
    case 'removed':
      return `${input} removed in this pull request`;
    case 'mode':
      return `${input} file mode changed in this pull request`;
  }
}

/** Entries present in `head` and not in `base`, as a readable fragment. */
function addedEntries(base: readonly string[], head: readonly string[]): string[] {
  const known = new Set(base);
  return [...new Set(head.filter((entry) => !known.has(entry)))];
}

function nameList(entries: readonly string[]): string {
  if (entries.length <= MAX_NAMED_ENTRIES) {
    return entries.join(', ');
  }
  const shown = entries.slice(0, MAX_NAMED_ENTRIES).join(', ');
  return `${shown} and ${entries.length - MAX_NAMED_ENTRIES} more`;
}

// failOn is a FLOOR: only findings at or above it block. Moving it up the
// severity ladder therefore LOOSENS the gate (fewer findings block) and
// moving it down tightens it, which is the opposite of what the severity
// words suggest at a glance. The parenthetical says which direction the
// change goes in gate terms rather than in ladder terms, because a
// reviewer skimming one line needs to know whether the pull request is
// asking for less enforcement, not which word sorts higher.
const FAIL_ON_STRICTNESS: Record<string, number> = {
  low: 4,
  medium: 3,
  high: 2,
  critical: 1,
  none: 0,
};

/** The summary for a head config that would not parse or validate. */
export const UNPARSEABLE_CONFIG_DETAIL = 'head config could not be parsed';

/**
 * The short parenthetical for a config proposal, or null when nothing
 * cheap can be said.
 *
 * ADDITIONS are named individually, because each one is a rule that did
 * NOT apply and a reviewer wants to see which. REMOVALS are counted rather
 * than named: taking an entry out of `allow` or `ignorePaths` makes the
 * gate stricter, so it needs to be visible but not itemised.
 *
 * Counting them at all matters. An earlier version named additions only,
 * so a pull request that removed entries and added none printed the bare
 * `config changed in this pull request` with no parenthetical, which is
 * the same thing a reader saw when the change could not be summarised at
 * all. Two different facts rendering identically is exactly the ambiguity
 * this line exists to remove, and the unparseable case below was the other
 * half of it.
 */
function describeConfigChange(base: ResolvedConfig, head: ResolvedConfig | null): string | null {
  // Null means the head config did not parse or did not validate. The run
  // used the base config regardless, so nothing about the verdict changes
  // -- but saying so is the difference between "we could not summarise
  // this" and "there was nothing to summarise", and the first is worth a
  // reader's attention because a config that will not parse is a config
  // that will not work once merged either.
  if (head === null) {
    return UNPARSEABLE_CONFIG_DETAIL;
  }
  const parts: string[] = [];

  const allow = addedEntries(base.allow, head.allow);
  if (allow.length > 0) {
    parts.push(`proposed: allow ${nameList(allow)}`);
  }

  const ignorePaths = addedEntries(base.ignorePaths, head.ignorePaths);
  if (ignorePaths.length > 0) {
    parts.push(`proposed: ignorePaths ${nameList(ignorePaths)}`);
  }

  const internalScopes = addedEntries(base.internalScopes, head.internalScopes);
  if (internalScopes.length > 0) {
    parts.push(`proposed: internalScopes ${nameList(internalScopes)}`);
  }

  const internalPrefixes = addedEntries(base.internalPrefixes, head.internalPrefixes);
  if (internalPrefixes.length > 0) {
    parts.push(`proposed: internalPrefixes ${nameList(internalPrefixes)}`);
  }

  if (base.failOn !== head.failOn) {
    const direction =
      (FAIL_ON_STRICTNESS[head.failOn] ?? 0) < (FAIL_ON_STRICTNESS[base.failOn] ?? 0)
        ? 'loosened'
        : 'tightened';
    parts.push(`failOn ${direction} to ${head.failOn}`);
  }

  if (base.online !== head.online) {
    parts.push(`online set to ${head.online}`);
  }

  if (JSON.stringify(base.extraAliases) !== JSON.stringify(head.extraAliases)) {
    parts.push('extraAliases changed');
  }

  // Removals, counted across the four list keys rather than named. A pull
  // request that only removes entries is TIGHTENING the gate, which is not
  // a warning, but it still has to be distinguishable from a change this
  // function could not describe at all.
  const removed =
    addedEntries(head.allow, base.allow).length +
    addedEntries(head.ignorePaths, base.ignorePaths).length +
    addedEntries(head.internalScopes, base.internalScopes).length +
    addedEntries(head.internalPrefixes, base.internalPrefixes).length;
  if (removed > 0) {
    parts.push(`${removed} entries removed`);
  }

  return parts.length === 0 ? null : parts.join('; ');
}

/**
 * Whether two .npmrc files differ in the only way that gates a rule.
 *
 * The SCOPE PINS are compared, not the file text. An .npmrc carries auth
 * tokens, a default registry, and any number of unrelated settings beside
 * its scope pins, and only the scope pins decide whether the pin-mismatch
 * rule has a pin to compare against. Comparing text would report a rotated
 * auth token as a proposal to loosen the gate, which is both wrong and the
 * kind of noise that teaches a reviewer to skip the line.
 *
 * This is narrower than the config and baseline comparisons on purpose,
 * and it is safe in the fail-closed direction for the same reason it is
 * narrower: everything it ignores is something no rule reads.
 */
function pinsDiffer(base: Map<string, string>, head: Map<string, string>): boolean {
  if (base.size !== head.size) {
    return true;
  }
  for (const [scope, registry] of base) {
    if (head.get(scope) !== registry) {
      return true;
    }
  }
  return false;
}

/** The short parenthetical for an .npmrc proposal, or null. */
function describeNpmrcChange(
  base: Map<string, string>,
  head: Map<string, string>
): string | null {
  const added: string[] = [];
  const removed: string[] = [];
  const repointed: string[] = [];
  for (const scope of head.keys()) {
    if (!base.has(scope)) {
      added.push(scope);
    }
  }
  for (const [scope, registry] of base) {
    if (!head.has(scope)) {
      removed.push(scope);
    } else if (head.get(scope) !== registry) {
      repointed.push(scope);
    }
  }
  const parts: string[] = [];
  // Removals first: a deleted pin is the one that turns a rule off, and it
  // is the half a reviewer most needs to see.
  if (removed.length > 0) {
    parts.push(`proposed: unpin ${nameList(removed.sort())}`);
  }
  if (repointed.length > 0) {
    parts.push(`proposed: repoint ${nameList(repointed.sort())}`);
  }
  if (added.length > 0) {
    parts.push(`proposed: pin ${nameList(added.sort())}`);
  }
  return parts.length === 0 ? null : parts.join('; ');
}

/** The short parenthetical for a baseline proposal, or null. */
function describeBaselineChange(base: Set<string>, head: Set<string> | null): string | null {
  if (head === null) {
    return null;
  }
  let added = 0;
  for (const fingerprint of head) {
    if (!base.has(fingerprint)) {
      added += 1;
    }
  }
  let removed = 0;
  for (const fingerprint of base) {
    if (!head.has(fingerprint)) {
      removed += 1;
    }
  }
  const parts: string[] = [];
  if (added > 0) {
    parts.push(`${added} baseline entries added`);
  }
  if (removed > 0) {
    parts.push(`${removed} baseline entries removed`);
  }
  return parts.length === 0 ? null : parts.join('; ');
}

function withDetail(line: string, detail: string | null): string {
  return detail === null ? line : `${line} (${detail})`;
}

/**
 * A config that will not validate, read leniently.
 *
 * This is the HEAD side only, and it exists purely to write a
 * parenthetical. A head config that does not validate still counts as a
 * change (documentsDiffer decides that on the text), and the run still
 * uses the base's config; all that is lost is the short "proposed: allow
 * foo" hint. Throwing here would let a pull request stop the whole scan by
 * committing malformed JSON, which is a muting attack of a different
 * shape.
 */
function tryConfig(
  baseText: string | null,
  localText: string | null,
  label: string
): ResolvedConfig | null {
  try {
    return loadConfigFromTexts(baseText, localText, label);
  } catch {
    return null;
  }
}

/** The same leniency for the head baseline. */
function tryBaseline(text: string | null): Set<string> | null {
  if (text === null) {
    return null;
  }
  try {
    return parseBaseline(text, BASELINE_FILE);
  } catch {
    return null;
  }
}

/**
 * Every control input for one pull-request run, taken from the base ref.
 *
 * Throws DepGuardError when the ref will not resolve or is the tree under
 * judgment (trust-base-*), when the BASE config will not validate
 * (config-invalid), or when the BASE baseline will not validate
 * (baseline-invalid). All of them are could-not-run: exit 2, nothing
 * judged. A base control input that does not validate cannot be waved
 * through by falling back to the defaults, because the defaults may be
 * looser than what the project committed, and a gate that silently loosens
 * itself when a file is malformed is a gate anyone can loosen.
 *
 * The head side is read from HEAD rather than from the working tree, for
 * the symlink reason on readControlFileAtRef and for one more: an
 * uncommitted local edit to a control file is not something the pull
 * request proposes, and reporting it as such would make every dirty
 * working tree look like an attempted mute.
 */
export async function loadTrustedControls(root: string, ref: string): Promise<TrustedControls> {
  await assertTrustBaseUsable(root, ref);

  const [
    baseConfig,
    baseLocal,
    baseBaselineFile,
    baseNpmrcFile,
    headConfig,
    headLocal,
    headBaselineFile,
    headNpmrcFile,
  ] = await Promise.all([
    readControlFileAtRef(root, ref, CONFIG_FILE),
    readControlFileAtRef(root, ref, LOCAL_CONFIG_FILE),
    readControlFileAtRef(root, ref, BASELINE_FILE),
    readControlFileAtRef(root, ref, NPMRC),
    readControlFileAtRef(root, 'HEAD', CONFIG_FILE),
    readControlFileAtRef(root, 'HEAD', LOCAL_CONFIG_FILE),
    readControlFileAtRef(root, 'HEAD', BASELINE_FILE),
    readControlFileAtRef(root, 'HEAD', NPMRC),
  ]);

  // A base-side control input that is not a regular file has no contents
  // worth parsing. Passing a symlink's target text to the JSON parser
  // would produce "not valid JSON", which tells a reader nothing about the
  // link, so the two are told apart here.
  assertBaseIsRegularFile(baseConfig, ref, 'config-invalid');
  assertBaseIsRegularFile(baseLocal, ref, 'config-invalid');
  assertBaseIsRegularFile(baseBaselineFile, ref, 'baseline-invalid');

  const config = loadConfigFromTexts(
    baseConfig === null ? null : baseConfig.text,
    baseLocal === null ? null : baseLocal.text,
    ref
  );
  const baseline =
    baseBaselineFile === null
      ? new Set<string>()
      : parseBaseline(baseBaselineFile.text, `${ref}:${BASELINE_FILE}`);

  // A base-side .npmrc that is not a regular file is NOT refused, unlike a
  // config or a baseline that is not one. parseNpmrcPins cannot fail: it
  // reads the lines it recognises and ignores everything else, so a link's
  // target text simply yields no pins. Refusing here would turn an odd but
  // harmless base-side file into a could-not-run for every pull request
  // against that branch, and the direction of the resulting error is the
  // safe one anyway: no pins means the pin-mismatch rule stays silent
  // rather than firing wrongly.
  const npmrcPins = parseNpmrcPins(
    baseNpmrcFile !== null && isRegularFileMode(baseNpmrcFile.mode) ? baseNpmrcFile.text : null
  );
  const headNpmrcPins = parseNpmrcPins(
    headNpmrcFile !== null && isRegularFileMode(headNpmrcFile.mode) ? headNpmrcFile.text : null
  );

  // The config input is the PAIR of files, because that is what the
  // overlay makes it. A pull request that leaves .dep-guard.json alone and
  // commits a .dep-guard.local.json is proposing exactly the same kind of
  // change, one file over, and the report has to say so.
  const configShapeChange =
    shapeChange(baseConfig, headConfig) ?? shapeChange(baseLocal, headLocal);
  const baselineShapeChange = shapeChange(baseBaselineFile, headBaselineFile);
  const npmrcShapeChange = shapeChange(baseNpmrcFile, headNpmrcFile);

  // Content OR shape. A symlink whose target holds the base config's exact
  // bytes has identical content by every measure available to a text
  // comparison, so without the shape half it reads as no change at all.
  const configContentChanged =
    documentsDiffer(baseConfig?.text ?? null, headConfig?.text ?? null) ||
    documentsDiffer(baseLocal?.text ?? null, headLocal?.text ?? null);
  const configChanged = configContentChanged || configShapeChange !== null;

  const baselineContentChanged = documentsDiffer(
    baseBaselineFile?.text ?? null,
    headBaselineFile?.text ?? null
  );
  const baselineChanged = baselineContentChanged || baselineShapeChange !== null;

  // Pins OR shape, the same pairing as the other two. The shape half is
  // what catches an .npmrc turned into a symlink whose target carries the
  // base's exact pins: the pin comparison sees no difference at all, and
  // the link target can be widened later in a diff that never mentions
  // .npmrc.
  const npmrcChanged = pinsDiffer(npmrcPins, headNpmrcPins) || npmrcShapeChange !== null;

  // "Added" is the first-adoption case: the head carries a control input
  // the base does not. The run uses the defaults (or an empty baseline),
  // and the line says added rather than changed, because there was nothing
  // to change it from.
  const configAdded = baseConfig === null && baseLocal === null && (headConfig !== null || headLocal !== null);
  const baselineAdded = baseBaselineFile === null && headBaselineFile !== null;
  const npmrcAdded = baseNpmrcFile === null && headNpmrcFile !== null;

  const proposals: string[] = [];
  if (configChanged) {
    const headResolved = tryConfig(
      headConfig === null ? null : headConfig.text,
      headLocal === null ? null : headLocal.text,
      'HEAD'
    );
    proposals.push(
      configAdded
        ? withDetail(CONFIG_ADDED_LINE, describeConfigChange(config, headResolved))
        : withDetail(CONFIG_PROPOSAL_LINE, describeConfigChange(config, headResolved))
    );
  }
  if (configShapeChange !== null) {
    proposals.push(shapeProposal('config', configShapeChange));
  }
  if (baselineChanged) {
    const headResolved = tryBaseline(headBaselineFile === null ? null : headBaselineFile.text);
    proposals.push(
      baselineAdded
        ? withDetail(BASELINE_ADDED_LINE, describeBaselineChange(baseline, headResolved))
        : withDetail(BASELINE_PROPOSAL_LINE, describeBaselineChange(baseline, headResolved))
    );
  }
  if (baselineShapeChange !== null) {
    proposals.push(shapeProposal('baseline', baselineShapeChange));
  }
  if (npmrcChanged) {
    proposals.push(
      npmrcAdded
        ? withDetail(NPMRC_ADDED_LINE, describeNpmrcChange(npmrcPins, headNpmrcPins))
        : withDetail(NPMRC_PROPOSAL_LINE, describeNpmrcChange(npmrcPins, headNpmrcPins))
    );
  }
  if (npmrcShapeChange !== null) {
    proposals.push(shapeProposal('npmrc', npmrcShapeChange));
  }

  return {
    ref,
    config,
    baseline,
    npmrcPins,
    configChanged,
    baselineChanged,
    npmrcChanged,
    configShapeChange,
    baselineShapeChange,
    npmrcShapeChange,
    proposals,
  };
}

function assertBaseIsRegularFile(file: ControlFile | null, ref: string, code: string): void {
  if (file === null || isRegularFileMode(file.mode)) {
    return;
  }
  throw new DepGuardError(
    `${ref}:${file.path} is not a regular file at the trust base (git mode ${file.mode}); ` +
      'dep-guard reads its control inputs as files. Nothing was checked.',
    code
  );
}
