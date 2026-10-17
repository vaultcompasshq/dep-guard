#!/usr/bin/env node
// Runs the built dep-guard against one real Python repository with --online
// and prints one JSON record for the PyPI validation baseline
// (docs/dogfood/, design 2026-10-17 section 9).
//
//   pnpm build
//   node bench/pypi-validate.mjs --repo <dir> --corpus-dir <dir> [--base <ref>]
//        [--budget-ms <ms>] [--block-network] [--url <url>] [--label <name>]
//
// The repository is only ever passed as a path: nothing is run from inside
// it. globalThis.fetch is wrapped for the run so the record can carry what
// the design asks the baseline to decide open point 7 on: how many PyPI
// requests were made, how large the largest body was, and how slow the
// slowest answer was. --block-network makes every request fail, for the
// "network blocked" repeat of the planted runs.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = await import(path.join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js'));
const gitSource = await import(path.join(REPO_ROOT, 'packages', 'core', 'dist', 'git-source.js'));
const output = await import(path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'output-text.js'));

function parseArgs(argv) {
  const options = { blockNetwork: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--block-network') {
      options.blockNetwork = true;
      continue;
    }
    const value = argv[index + 1];
    index += 1;
    if (arg === '--repo') options.repo = value;
    else if (arg === '--corpus-dir') options.corpusDir = value;
    else if (arg === '--base') options.base = value;
    else if (arg === '--budget-ms') options.budgetMs = Number(value);
    else if (arg === '--url') options.url = value;
    else if (arg === '--label') options.label = value;
    else throw new Error(`unknown option ${arg}`);
  }
  if (options.repo === undefined || options.corpusDir === undefined) {
    throw new Error('--repo and --corpus-dir are required');
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const requests = { pypi: [], npm: 0, other: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (options.blockNetwork) {
    throw new TypeError('network blocked for this validation run');
  }
  if (!url.startsWith('https://pypi.org/')) {
    if (url.includes('npmjs.org')) requests.npm += 1;
    else requests.other += 1;
    return realFetch(input, init);
  }
  const started = Date.now();
  const response = await realFetch(input, init);
  const record = { url, status: response.status, bytes: null, ms: null };
  requests.pypi.push(record);
  const body = await response.clone().arrayBuffer().catch(() => null);
  record.bytes = body === null ? null : body.byteLength;
  record.ms = Date.now() - started;
  return response;
};

const mode = options.base === undefined ? { kind: 'audit' } : { kind: 'base', ref: options.base };
const sha = execFileSync('git', ['-C', options.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const states = await gitSource.loadStates(options.repo, mode);
const files = { requirements: [], pyproject: [], pipfile: [], 'uv-toml': [], lockfiles: [] };
for (const manifest of states.after.manifests) {
  if (manifest.python !== undefined) files[manifest.python.kind].push(manifest.path);
}
for (const lockfile of states.after.pythonLockfiles ?? []) {
  files.lockfiles.push(`${lockfile.path}${lockfile.unreadable === undefined ? '' : ' (unreadable)'}`);
}

const started = Date.now();
const result = await core.scan({
  repoRoot: options.repo,
  mode,
  corpusDir: options.corpusDir,
  online: true,
  ...(options.budgetMs === undefined ? {} : { onlineBudgetMs: options.budgetMs }),
});
const wallMs = Date.now() - started;

const byCode = {};
for (const diagnostic of result.run.diagnostics) {
  byCode[diagnostic.code] = (byCode[diagnostic.code] ?? 0) + 1;
}
const largest = requests.pypi.reduce((best, entry) => ((entry.bytes ?? 0) > (best?.bytes ?? -1) ? entry : best), null);
const slowest = requests.pypi.reduce((best, entry) => ((entry.ms ?? 0) > (best?.ms ?? -1) ? entry : best), null);
const projectOf = (entry) => (entry === null ? null : decodeURIComponent(entry.url.split('/pypi/')[1]?.split('/')[0] ?? ''));

const record = {
  label: options.label ?? path.basename(options.repo),
  url: options.url ?? null,
  sha,
  mode: options.base === undefined ? 'audit' : `base ${options.base}`,
  depGuardVersion: JSON.parse(
    execFileSync('git', ['-C', REPO_ROOT, 'show', 'HEAD:packages/core/package.json'], { encoding: 'utf8' })
  ).version,
  networkBlocked: options.blockNetwork,
  pythonFilesRead: files,
  ecosystems: result.run.ecosystems,
  online: result.run.online,
  wallMs,
  pypiRequests: requests.pypi.length,
  pypiStatuses: requests.pypi.reduce((acc, entry) => ({ ...acc, [entry.status]: (acc[entry.status] ?? 0) + 1 }), {}),
  largestPypiBody: largest === null ? null : { project: projectOf(largest), bytes: largest.bytes, ms: largest.ms },
  slowestPypiAnswer: slowest === null ? null : { project: projectOf(slowest), bytes: slowest.bytes, ms: slowest.ms },
  npmRequests: requests.npm,
  findings: result.findings.map((finding) => ({
    ruleId: finding.ruleId,
    severity: finding.severity,
    packageName: finding.packageName,
    manifestPath: finding.manifestPath,
    ecosystem:
      finding.details?.ecosystem ??
      (states.after.manifests.find((manifest) => manifest.path === finding.manifestPath)?.python === undefined
        ? 'npm'
        : 'pypi'),
    ...(finding.details?.target === undefined ? {} : { target: finding.details.target }),
  })),
  diagnosticsByCode: byCode,
  pypiDiagnostics: result.run.diagnostics
    .filter((diagnostic) =>
      /^(pypi-|python-|requirements-line-unread)/.test(diagnostic.code) ||
      (diagnostic.code.startsWith('online-') && diagnostic.message.startsWith('pypi existence'))
    )
    .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
  namesLine: output.renderNamesLine(result),
  exitCode: result.exitCode,
};
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
