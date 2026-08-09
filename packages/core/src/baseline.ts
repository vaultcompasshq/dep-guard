import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DepGuardError } from './types.js';

// .dep-guard.baseline.json holds the fingerprints of findings a human has
// already reviewed and accepted. It is read the same way config.ts reads
// .dep-guard.json: straight off disk, never through git, so a baseline
// entry lands on the FIRST scan after it is written rather than only
// after it is committed and staged.

const BASELINE_FILE = '.dep-guard.baseline.json';
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new DepGuardError(`${BASELINE_FILE}: not valid JSON`, 'baseline-invalid');
  }
  if (!isPlainObject(parsed)) {
    throw new DepGuardError(`${BASELINE_FILE}: baseline is not a JSON object`, 'baseline-invalid');
  }
  // A version mismatch (including a missing version) is refused rather
  // than guessed at: a future baseline format could change what a stored
  // fingerprint even means, and silently reading it under today's rules
  // could suppress a finding it was never meant to.
  if (parsed.version !== BASELINE_VERSION) {
    throw new DepGuardError(
      `${BASELINE_FILE}: unknown baseline version ${JSON.stringify(parsed.version)}, expected ${BASELINE_VERSION}`,
      'baseline-invalid'
    );
  }
  if (!isStringArray(parsed.fingerprints)) {
    throw new DepGuardError(
      `${BASELINE_FILE}: "fingerprints" must be an array of strings`,
      'baseline-invalid'
    );
  }

  return new Set(parsed.fingerprints);
}
