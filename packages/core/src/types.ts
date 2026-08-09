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
  | 'dependency-confusion';

export interface Finding {
  ruleId: RuleId;
  severity: Severity;
  packageName: string;
  message: string;
  manifestPath: string;
  lockfilePath?: string;
  fingerprint: string;
  details?: Record<string, unknown>;
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
