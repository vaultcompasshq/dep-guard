import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DepGuardError } from './types.js';

// .dep-guard.baseline.json holds the fingerprints of findings a human has
// already reviewed and accepted. It is read the same way config.ts reads
// .dep-guard.json: straight off disk, never through git, so a baseline
// entry lands on the FIRST scan after it is written rather than only
// after it is committed and staged.

// Exported so trust-base.ts reads the same path out of the base ref that
// loadBaseline reads off disk, for the reason config.ts's CONFIG_FILE is
// exported: one spelling, not two.
export const BASELINE_FILE = '.dep-guard.baseline.json';
const BASELINE_VERSION = 1;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

// An absent baseline is not an error: it is the ordinary state of a repo
// where nobody has reviewed and accepted a finding yet, and suppresses
// nothing.
export function loadBaseline(repoRoot: string): Set<string> {
  const filePath = path.join(repoRoot, BASELINE_FILE);

  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set();
    }
    throw new DepGuardError(
      `${BASELINE_FILE}: could not be read (${(error as Error).message})`,
      'baseline-invalid'
    );
  }

  return parseBaseline(content, BASELINE_FILE);
}

/**
 * The same baseline, parsed from content rather than read from a path.
 *
 * Pull-request mode reads the baseline out of the base ref through git, so
 * it has text where loadBaseline has a path. Every validation below is
 * shared rather than repeated: a base-ref baseline at an unknown version,
 * or with a "fingerprints" key that is not an array of strings, is refused
 * in exactly the words an on-disk one is, and refused for the same reason
 * -- a suppression list that cannot be read is could-not-run, never an
 * empty suppression list.
 *
 * `label` names where the bytes came from, so a broken base baseline reads
 * as "origin/main:.dep-guard.baseline.json" rather than as a complaint
 * about the copy in the working tree.
 */
export function parseBaseline(content: string, label: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new DepGuardError(`${label}: not valid JSON`, 'baseline-invalid');
  }
  if (!isPlainObject(parsed)) {
    throw new DepGuardError(`${label}: baseline is not a JSON object`, 'baseline-invalid');
  }
  // A version mismatch (including a missing version) is refused rather
  // than guessed at: a future baseline format could change what a stored
  // fingerprint even means, and silently reading it under today's rules
  // could suppress a finding it was never meant to.
  if (parsed.version !== BASELINE_VERSION) {
    throw new DepGuardError(
      `${label}: unknown baseline version ${JSON.stringify(parsed.version)}, expected ${BASELINE_VERSION}`,
      'baseline-invalid'
    );
  }
  if (!isStringArray(parsed.fingerprints)) {
    throw new DepGuardError(
      `${label}: "fingerprints" must be an array of strings`,
      'baseline-invalid'
    );
  }

  return new Set(parsed.fingerprints);
}
