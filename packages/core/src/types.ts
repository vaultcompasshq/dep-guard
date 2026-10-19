// Core finding and diagnostic shapes shared by every rule, the gate, and
// the CLI. Later tasks (bloom filter, individual checks) depend on these
// exact names and fields, so changes here ripple across the whole package.

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type FailOn = Severity | 'none';

export type RuleId =
  | 'unknown-package'
  | 'typosquat'
  | 'install-script'
  | 'lockfile-tamper'
  | 'version-hygiene'
  | 'dependency-confusion'
  | 'registered-squat'
  | 'publish-age';

export interface Finding {
  ruleId: RuleId;
  severity: Severity;
  packageName: string;
  message: string;
  manifestPath: string;
  lockfilePath?: string;
  fingerprint: string;
  details?: Record<string, unknown>;
  // Set on a finding ignorePaths would have dropped and did not, because
  // the change makes its path a project the reference side does not
  // install that way (0.16.0): the entries that matched, and how the path
  // is installed. Never part of the fingerprint, and never placed in
  // details.signal, which the fingerprint hashes.
  ignoreOverride?: { entries: string[]; position: string };
}

export interface Diagnostic {
  code: string;
  message: string;
}

export class DepGuardError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}
