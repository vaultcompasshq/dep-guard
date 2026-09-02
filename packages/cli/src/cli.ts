#!/usr/bin/env node
// dep-guard's command-line entry point: two commands, "scan" and "check",
// both thin wrappers over core's scan()/checkSingle(). No gate logic lives
// here -- blockingMatches, exitCode, and the failOn threshold all come
// straight out of the ScanResult core already computed, so a CLI change
// can never leave this tool's pass/fail decision disagreeing with core's.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { checkSingle, DepGuardError, FAIL_ON_LEVELS, scan } from '@vaultcompass/dep-guard-core';
import type { FailOn, ScanMode, ScanResult } from '@vaultcompass/dep-guard-core';
import { renderDiagnosticLine, renderText, sanitizeText } from './output-text.js';

// A pipe reader (head, less, a CI log collector that stops reading early)
// closing its end mid-write is ordinary, not a bug in this tool -- but
// Node's Writable streams have no listener on process.stdout/stderr by
// default, so an EPIPE would otherwise surface as an unhandled 'error'
// event: the default Node behaviour for that is to print a raw stack
// trace and force process.exitCode to 1, silently overriding whatever
// exit code the gate already decided. Registered once, at module load,
// before anything can be written.
function ignoreEpipe(stream: NodeJS.WritableStream): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') {
      throw err;
    }
    // Swallowed: the reader is gone, there is nothing left to write to,
    // and process.exitCode -- set before this write was attempted -- is
    // left exactly as it was.
  });
}
ignoreEpipe(process.stdout);
ignoreEpipe(process.stderr);

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

// FAIL_ON_LEVELS comes from core so this validation can never drift from
// the set config.ts checks a config's "failOn" key against -- this is
// where --fail-on has to be rejected, because core's own override path
// (scan.ts's applyFailOnOverride) accepts whatever it is given and folds
// it straight into the effective config, with no validation of its own.
// Passing a bad value through unchecked does not error: severityAtLeast's
// SEVERITY_ORDER.indexOf returns -1 for an unrecognized floor, and every
// real finding's severity index is >= 0, so an unrecognized --fail-on
// value would silently block on everything rather than fail loudly. That
// is the "fails closed on garbage but says nothing useful" behavior this
// validation exists to catch before it ever reaches core.

type OutputFormat = 'json' | 'text';

// Both commands take the same pair of online flags, declared once so the
// two can never drift into describing the same switch differently.
//
// ORDER IS LOAD-BEARING, and the reason is a commander behaviour that
// fails silently in the dangerous direction. Commander gives a `--no-x`
// option a default value of `true` for `x` -- unless `--x` was declared
// FIRST, in which case the pair leaves the value undefined until one of
// them is actually passed. Undefined is exactly what core's resolveOnline
// needs in order to let .dep-guard.json decide (scan.ts). Declaring
// `--no-online` alone, or first, would make every plain `dep-guard scan`
// start making network requests with no flag asked for and nothing in the
// output saying so. `cli.test.ts` pins this with a test that runs the CLI
// with no flags at all and asserts nothing online happened.
const ONLINE_FLAG_DESCRIPTION =
  'enable registry-backed checks: unknown-package resolution, popularity asymmetry, ' +
  'and registered-squat detection (network required)';
const NO_ONLINE_FLAG_DESCRIPTION =
  'force the registry-backed checks off, overriding "online": true in .dep-guard.json';

// A bad --format or --fail-on value, or an unusable combination of flags
// (--staged with --base). Kept distinct from DepGuardError -- which only
// core code throws -- so reportError can say "core rejected this" and
// "the command line was wrong" in two different, equally clear ways
// without pretending one came from the other.
class CliUsageError extends Error {}

function parseFailOn(value: string | undefined): FailOn | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!(FAIL_ON_LEVELS as ReadonlySet<string>).has(value)) {
    throw new CliUsageError(
      `--fail-on must be one of ${[...FAIL_ON_LEVELS].join(', ')} (got "${value}")`
    );
  }
  return value as FailOn;
}

function parseFormat(value: string): OutputFormat {
  if (value !== 'json' && value !== 'text') {
    throw new CliUsageError(`--format must be "json" or "text" (got "${value}")`);
  }
  return value;
}

interface ScanCliOptions {
  staged?: boolean;
  base?: string;
  format: string;
  failOn?: string;
  corpusDir?: string;
  online?: boolean;
}

interface CheckCliOptions {
  format: string;
  failOn?: string;
  corpusDir?: string;
  online?: boolean;
}

function resolveMode(options: ScanCliOptions): ScanMode {
  if (options.staged && options.base !== undefined) {
    throw new CliUsageError('--staged and --base cannot be used together');
  }
  if (options.staged) {
    return { kind: 'staged' };
  }
  if (options.base !== undefined) {
    return { kind: 'base', ref: options.base };
  }
  return { kind: 'audit' };
}

// JSON mode prints exactly one ScanResult object on stdout and nothing
// else, so a consumer can pipe stdout straight into a JSON parser without
// scraping human-facing text out of it first. Diagnostics still have to
// reach a human somewhere -- check-single-name-only fires on every
// checkSingle call by design -- so JSON mode renders them to stderr
// instead of folding them into stdout. Text mode has no such constraint:
// nothing downstream is trying to parse it, so its diagnostics print
// inline as part of the one human-facing report on stdout. This split is
// deliberate, not an inconsistency to "fix" into one stream or the other.
function emit(result: ScanResult, format: OutputFormat): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    for (const diagnostic of result.run.diagnostics) {
      process.stderr.write(`${renderDiagnosticLine(diagnostic)}\n`);
    }
    return;
  }
  process.stdout.write(`${renderText(result)}\n`);
}

// Set when the corpus directory was left to core's own default rather
// than supplied via --corpus-dir, and no corpus has actually been built
// there yet. Without this, a first-time run reports "corpus file
// missing: <path into this package's own internals>" -- true, and
// fail-closed, but not actionable: nothing about it tells a user that
// --corpus-dir is the fix.
function reportError(err: unknown, corpusDirWasDefaulted = false): void {
  if (err instanceof DepGuardError) {
    if (err.code === 'corpus-missing' && corpusDirWasDefaulted) {
      process.stderr.write(
        'dep-guard: no corpus directory was given, and the bundled corpus is not built ' +
          'yet in this install; pass --corpus-dir pointing at a built corpus directory ' +
          '(corpus-missing)\n'
      );
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`dep-guard: ${sanitizeText(err.message)} (${err.code})\n`);
    process.exitCode = 2;
    return;
  }
  if (err instanceof CliUsageError) {
    process.stderr.write(`dep-guard: ${sanitizeText(err.message)}\n`);
    process.exitCode = 2;
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`dep-guard: unexpected error: ${sanitizeText(message)}\n`);
  process.exitCode = 2;
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name('dep-guard')
    .description('Scan dependency changes for supply-chain risk before they land.')
    .version(pkg.version)
    // Without this, commander calls process.exit() itself on any usage
    // problem -- no args, an unknown command, an unknown or missing flag,
    // a missing argument -- always with exit code 1, indistinguishable to
    // a CI wrapper from "blocking findings found" (scan's own exit code
    // for that case). exitOverride makes commander throw a CommanderError
    // instead, caught below and remapped into this CLI's own exit-2
    // vocabulary, the same one --format and --fail-on validation already
    // use for a bad command line. Has to be set on the program AND on
    // each subcommand -- it is not inherited.
    .exitOverride();

  program
    .command('scan')
    .description('Scan a repository for risky dependency changes')
    .argument('[path]', 'repository or directory to scan', '.')
    .option('--staged', 'compare the git index against HEAD')
    .option('--base <ref>', 'compare the working tree against a git ref')
    .option('--format <format>', 'output format: json or text', 'text')
    .option(
      '--fail-on <level>',
      'severity threshold that fails the run: critical, high, medium, low, or none'
    )
    .option('--corpus-dir <dir>', 'override the corpus directory')
    .option('--online', ONLINE_FLAG_DESCRIPTION)
    .option('--no-online', NO_ONLINE_FLAG_DESCRIPTION)
    .exitOverride()
    .action(async (targetPath: string, options: ScanCliOptions) => {
      try {
        const format = parseFormat(options.format);
        const failOn = parseFailOn(options.failOn);
        const mode = resolveMode(options);
        const result = await scan({
          repoRoot: path.resolve(targetPath),
          mode,
          corpusDir: options.corpusDir,
          failOn,
          online: options.online,
        });
        emit(result, format);
        process.exitCode = result.exitCode;
      } catch (err) {
        reportError(err, options.corpusDir === undefined);
      }
    });

  program
    .command('check')
    .description('Check whether a single package name is safe to add')
    .argument('<name>', 'package name to check')
    .option('--format <format>', 'output format: json or text', 'text')
    .option(
      '--fail-on <level>',
      'severity threshold that fails the run: critical, high, medium, low, or none'
    )
    .option('--corpus-dir <dir>', 'override the corpus directory')
    .option('--online', ONLINE_FLAG_DESCRIPTION)
    .option('--no-online', NO_ONLINE_FLAG_DESCRIPTION)
    .exitOverride()
    .action(async (name: string, options: CheckCliOptions) => {
      try {
        const format = parseFormat(options.format);
        const failOn = parseFailOn(options.failOn);
        const result = await checkSingle({
          repoRoot: process.cwd(),
          name,
          corpusDir: options.corpusDir,
          failOn,
          online: options.online,
        });
        emit(result, format);
        process.exitCode = result.exitCode;
      } catch (err) {
        reportError(err, options.corpusDir === undefined);
      }
    });

  return program;
}

// Every action handler above already catches its own errors, so this is
// the backstop for what exitOverride() turns into a thrown CommanderError
// instead of an internal process.exit(): --help and --version already
// carry commander's own exitCode 0 (they printed what they needed to and
// succeeded); every other CommanderError -- an unknown command, an
// unknown or missing flag, a missing argument -- is a command-line
// mistake and exits 2, the same code every other usage problem in this
// CLI uses. Nothing here should ever be allowed to fall through as an
// uncaught rejection and print a stack trace instead of a readable
// message.
async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exitCode = err.exitCode === 0 ? 0 : 2;
      return;
    }
    reportError(err);
  }
}

await main();
