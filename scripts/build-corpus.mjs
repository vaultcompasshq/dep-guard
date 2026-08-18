#!/usr/bin/env node
// Builds the four files corpus.ts loads: names.bloom, top.json,
// aliases.json and meta.json.
//
// Requires a built core, because it must not hash names itself:
//
//   pnpm build
//   node scripts/build-corpus.mjs --max-names 5000     # a slice, to prove it works
//   node scripts/build-corpus.mjs                      # the real thing
//   node scripts/build-corpus.mjs --refresh            # pick up what changed since
//
// The corpus lands in .corpus-work/corpus, and the scanner is pointed at it
// with --corpus-dir. A release installs one at core's built-in default
// path instead, which is a deliberate --out and not something a local build
// should do behind a scan's back:
//
//   node scripts/build-corpus.mjs --out packages/core/data/corpus
//
// A full walk is around 430 requests against the public registry replica
// and takes roughly ten to fifteen minutes on a home connection. It is not
// wired into any automatic path on purpose: it is a deliberate command, run
// when a corpus is wanted, and it is resumable, so a failure half way
// through costs the remaining pages rather than all of them.
//
// Where the names come from
// -------------------------
// replicate.npmjs.com, the registry's public CouchDB replica. _all_docs
// paginated at its 10000-row limit walks every package name in the
// registry; the update sequence captured before the walk starts is written
// into the state file, so a later --refresh reads _changes from that point
// instead of walking four million names again to discover a few thousand
// new ones.
//
// Where the popularity list comes from
// ------------------------------------
// scripts/data/top-packages.txt, a reviewed and versioned file in this
// repository. Every name in it exists in a registry walk this project
// performed and cleared a measured last-week download floor when the file
// was built; its header records both, along with what nominated the name in
// the first place. scripts/refresh-top-list.mjs is what rebuilds it, and
// that is a deliberate command rather than something a corpus build does
// behind anyone's back: a supply-chain tool that fetches its own trust data
// from somebody else's server on every build is arguing against itself.
//
// --rank-downloads re-measures the same list against the downloads API now
// and drops anything that no longer clears the floor, which is the same
// verification the refresh script performs, done inline. It is slow for a
// reason worth knowing: the bulk endpoint refuses scoped names, so every
// scoped name costs a request of its own. meta.json records which of the
// two a given corpus used.
//
// Two things this script refuses to do
// ------------------------------------
// It will not write a corpus whose bloom filter disagrees with the
// scanner's (lib/bloom-vector.mjs), and it will not write an alias list
// that keys a name also present in the top list (lib/corpus-guards.mjs).
// Both are silent failures in production and loud ones here.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BloomFilter } from '../packages/core/dist/bloom.js';
import { loadCorpus } from '../packages/core/dist/corpus.js';

import { ALIAS_SEED } from './lib/aliases.mjs';
import { assertBloomParity } from './lib/bloom-vector.mjs';
import {
  assertAliasKeysNotPopular,
  assertTopListWellFormed,
  buildMeta,
} from './lib/corpus-guards.mjs';
import {
  appendNames,
  countNames,
  readNames,
  readState,
  repairTrailingLine,
  rewriteNames,
  writeState,
} from './lib/name-store.mjs';
import {
  DEFAULT_DOWNLOADS_API,
  DEFAULT_REPLICA,
  USER_AGENT,
  fetchAllDocsPage,
  fetchChangesPage,
  fetchReplicaInfo,
} from './lib/registry.mjs';
import {
  DEFAULT_DOWNLOAD_FLOOR,
  measureDownloads,
  parseNameList,
  presentIn,
  selectPopular,
} from './lib/top-list.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_VERSION = 1;

const DEFAULTS = {
  // Beside the name store rather than at core's built-in default path
  // (packages/core/data/corpus). Writing there turns a locally built corpus
  // into the corpus every scan on this machine silently uses, including
  // scans that never passed --corpus-dir and never meant to consult a
  // half-walked slice. Installing a corpus as the default is a release
  // step, done deliberately with --out; building one is not.
  out: path.join(REPO_ROOT, '.corpus-work', 'corpus'),
  workDir: path.join(REPO_ROOT, '.corpus-work'),
  // The design target. At 4.25 million names this produces a filter of
  // about ten megabytes, which is the size the corpus was planned around.
  fpRate: 0.0001,
  pageSize: 10000,
  delayMs: 150,
  attempts: 5,
  replica: DEFAULT_REPLICA,
  downloadsApi: DEFAULT_DOWNLOADS_API,
  maxNames: null,
  // The shipped popularity list. Overridable with --top-file, which is what
  // a test or an experiment uses; the default is the reviewed file.
  topFile: path.join(REPO_ROOT, 'scripts', 'data', 'top-packages.txt'),
  topFloor: DEFAULT_DOWNLOAD_FLOOR,
};

const USAGE = `Usage: node scripts/build-corpus.mjs [options]

  --out <dir>          where to write the corpus (default .corpus-work/corpus)
  --work-dir <dir>     where to keep the resumable name store (default .corpus-work)
  --fp-rate <n>        target false-positive rate (default ${DEFAULTS.fpRate})
  --page-size <n>      rows per registry request (default ${DEFAULTS.pageSize})
  --max-names <n>      stop the walk early; produces a deliberately partial corpus
  --delay <ms>         pause between requests (default ${DEFAULTS.delayMs})
  --attempts <n>       attempts per request before giving up (default ${DEFAULTS.attempts})
  --replica <url>      registry replica base URL
  --refresh            read _changes from the stored update sequence instead of walking
  --rebuild            discard the stored walk state and start from the first name
  --skip-fetch         build the artifacts from the existing name store, fetch nothing
  --rank-downloads     re-measure the popularity list against the downloads API
  --top-floor <n>      downloads a name must clear under --rank-downloads (default ${DEFAULTS.topFloor})
  --top-file <path>    popularity list to ship (default scripts/data/top-packages.txt)
  --aliases-file <p>   JSON object of confusion pairs, replacing the seed
  -h, --help           print this
`;

function fail(message) {
  process.stderr.write(`build-corpus: ${message}\n`);
  process.exitCode = 1;
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, refresh: false, rebuild: false, skipFetch: false, rankDownloads: false, aliasesFile: null };
  const numeric = new Map([
    ['--fp-rate', 'fpRate'],
    ['--page-size', 'pageSize'],
    ['--max-names', 'maxNames'],
    ['--delay', 'delayMs'],
    ['--attempts', 'attempts'],
    ['--top-floor', 'topFloor'],
  ]);
  const strings = new Map([
    ['--out', 'out'],
    ['--work-dir', 'workDir'],
    ['--replica', 'replica'],
    ['--top-file', 'topFile'],
    ['--aliases-file', 'aliasesFile'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }
    if (arg === '--refresh' || arg === '--rebuild' || arg === '--skip-fetch' || arg === '--rank-downloads') {
      const key = { '--refresh': 'refresh', '--rebuild': 'rebuild', '--skip-fetch': 'skipFetch', '--rank-downloads': 'rankDownloads' }[arg];
      options[key] = true;
      continue;
    }
    if (numeric.has(arg)) {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value)) {
        throw new Error(`${arg} needs a number`);
      }
      options[numeric.get(arg)] = value;
      index += 1;
      continue;
    }
    if (strings.has(arg)) {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.startsWith('-')) {
        throw new Error(`${arg} needs a value`);
      }
      options[strings.get(arg)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown option ${arg}`);
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function loadTopList(options) {
  const shipped = options.topFile === DEFAULTS.topFile;
  if (!existsSync(options.topFile)) {
    throw new Error(
      `no popularity list at ${options.topFile}. ` +
        (shipped
          ? 'Run scripts/refresh-top-list.mjs to build one; a corpus without it would report ' +
            'every popular package as a typosquat of its neighbour.'
          : 'Check the path passed to --top-file.')
    );
  }
  const { names } = parseNameList(readFileSync(options.topFile, 'utf8'));
  return {
    names,
    ordering: shipped ? 'verified-downloads-last-week' : 'supplied-file',
    source: path.relative(REPO_ROOT, options.topFile),
  };
}

function loadAliases(options) {
  if (options.aliasesFile === null) {
    return { ...ALIAS_SEED };
  }
  const parsed = JSON.parse(readFileSync(options.aliasesFile, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${options.aliasesFile} is not a JSON object of name to target list`);
  }
  return parsed;
}

// Re-runs the popularity list's own verification against live data: does
// the walk still hold this name, and does the downloads API still report it
// above the floor. A name that fails either is dropped rather than kept in
// place, because the whole value of the list is that membership means
// something, and a name nobody can measure any more is a name nobody has
// checked.
//
// This is the same work scripts/refresh-top-list.mjs does, and it is slow
// for the same reason: the bulk downloads endpoint refuses scoped names, so
// each of those costs a request of its own against an API that sustains
// about one a second.
async function verifyTopList(names, namesPath, options, fetchOptions) {
  const present = presentIn(readNames(namesPath), names);
  const absent = names.length - present.size;
  if (absent > 0) {
    log(`  ${absent} listed name(s) are not in the walked name store and will be dropped`);
  }

  const startedAt = Date.now();
  const counts = await measureDownloads({
    names: names.filter((name) => present.has(name)),
    downloadsApi: options.downloadsApi,
    fetchOptions,
    delayMs: options.delayMs,
    onProgress: ({ done, total }) => {
      if (done % 500 === 0 || done === total) {
        const rate = done / Math.max(1, (Date.now() - startedAt) / 1000);
        log(`  downloads: ${done}/${total}, about ${Math.round((total - done) / Math.max(rate, 0.01) / 60)}m left`);
      }
    },
  });

  const { listed, dropped } = selectPopular({
    candidates: names,
    counts,
    present,
    floor: options.topFloor,
  });
  log(
    `  kept ${listed.length}; dropped ${dropped.absent.length} absent, ` +
      `${dropped.unmeasured.length} unmeasured, ${dropped.belowFloor.length} below ${options.topFloor}`
  );
  return listed.map((entry) => entry.name);
}

async function walkAllDocs(options, state, statePath, namesPath, fetchOptions) {
  const repaired = repairTrailingLine(namesPath);
  if (repaired.truncatedBytes > 0) {
    log(`Trimmed ${repaired.truncatedBytes} byte(s) of a half-written name left by an earlier run.`);
  }

  const startedAt = Date.now();
  let walked = 0;
  for (;;) {
    const page = await fetchAllDocsPage(
      options.replica,
      { startKey: state.lastKey, limit: options.pageSize },
      fetchOptions
    );

    if (page.rowCount === 0 || (page.ids.length === 0 && page.lastKey === state.lastKey)) {
      state.phase = 'complete';
      writeState(statePath, state);
      log('Reached the end of the registry.');
      break;
    }

    // Names first, then the key: a crash between the two re-fetches one
    // page on the next run, which is cheap and idempotent. The other order
    // would skip a page and lose its names silently.
    appendNames(namesPath, page.ids);
    state.lastKey = page.lastKey;
    state.pageCount = (state.pageCount ?? 0) + 1;
    state.nameCount = (state.nameCount ?? 0) + page.ids.length;
    writeState(statePath, state);
    walked += page.ids.length;

    if (state.pageCount % 10 === 0 || walked === page.ids.length) {
      const elapsed = Date.now() - startedAt;
      const rate = walked / Math.max(1, elapsed / 1000);
      const remaining = state.docCount ? Math.max(0, state.docCount - state.nameCount) : null;
      const eta = remaining === null ? '' : `, about ${formatDuration((remaining / rate) * 1000)} left`;
      log(
        `  page ${state.pageCount}: ${state.nameCount} names` +
          `, ${Math.round(rate)}/s${eta}`
      );
    }

    if (options.maxNames !== null && state.nameCount >= options.maxNames) {
      log(`Stopping at --max-names ${options.maxNames}; the corpus will be a partial slice.`);
      break;
    }
    if (options.delayMs > 0) {
      await sleep(options.delayMs);
    }
  }
}

async function applyChanges(options, state, statePath, namesPath, fetchOptions) {
  if (typeof state.updateSeq !== 'number' && typeof state.updateSeq !== 'string') {
    throw new Error(
      'no update sequence in the walk state, so there is nothing to refresh from. ' +
        'Run a full walk first.'
    );
  }

  const changed = new Set();
  const deleted = new Set();
  let since = state.updateSeq;
  let pages = 0;

  for (;;) {
    const page = await fetchChangesPage(
      options.replica,
      { since, limit: options.pageSize },
      fetchOptions
    );
    for (const id of page.changed) {
      changed.add(id);
      deleted.delete(id);
    }
    for (const id of page.deleted) {
      deleted.add(id);
      changed.delete(id);
    }
    pages += 1;
    since = page.lastSeq;
    log(`  changes page ${pages}: ${changed.size} updated, ${deleted.size} deleted`);
    if (page.resultCount < options.pageSize) {
      break;
    }
    if (options.delayMs > 0) {
      await sleep(options.delayMs);
    }
  }

  const drop = new Set([...changed, ...deleted]);
  const result = rewriteNames(namesPath, { drop, add: [...changed] });
  state.updateSeq = since;
  state.nameCount = result.kept;
  writeState(statePath, state);
  log(`Refreshed: ${changed.size} name(s) updated, ${deleted.size} removed, ${result.kept} total.`);
}

// Every name in top.json has to be in the filter too. Without this, a
// corpus built from a partial walk (or one where a curated name has been
// unpublished) would have the existence check calling a package unknown
// while the typosquat check exempts it as popular -- two rules disagreeing
// about the same name, which is exactly the shape of bug this codebase
// keeps finding.
function* namesForFilter(namesPath, extras) {
  yield* readNames(namesPath);
  yield* extras;
}

function collectExtras(top, aliases) {
  const extras = new Set(top);
  for (const targets of Object.values(aliases)) {
    if (!Array.isArray(targets)) {
      continue;
    }
    for (const target of targets) {
      if (typeof target === 'string' && target.length > 0) {
        extras.add(target);
      }
    }
  }
  return [...extras];
}

// A rough empirical read on the filter, probed with names shaped like real
// ones but random enough not to be any. It is a sanity check on the sizing
// maths rather than a measurement: at a target of one in ten thousand, a
// sample this size sees single-digit hits, so treat a wildly different
// number as a signal and a slightly different one as noise.
function measureFalsePositives(filter, probes) {
  let hits = 0;
  for (let index = 0; index < probes; index += 1) {
    const probe = `zzq-${index.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (filter.has(probe)) {
      hits += 1;
    }
  }
  return hits / probes;
}

function writeArtifacts({ outDir, filter, top, aliases, meta }) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'names.bloom'), filter.serialize());
  writeFileSync(path.join(outDir, 'top.json'), `${JSON.stringify(top, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'aliases.json'), `${JSON.stringify(aliases, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
}

// The last thing the build does is read its own output back through the
// loader the scanner uses. A corpus that this cannot load is a corpus that
// fails closed on every scan, and finding that out here costs a second.
function verifyThroughLoader(outDir, top) {
  const corpus = loadCorpus(outDir);
  if (corpus.topRank(top[0]) !== 1) {
    throw new Error(`corpus verification failed: ${top[0]} did not load as rank 1`);
  }
  const missing = top.filter((name) => !corpus.hasName(name));
  if (missing.length > 0) {
    throw new Error(
      `corpus verification failed: ${missing.length} top-list name(s) are absent from the ` +
        `bloom filter, starting with ${missing.slice(0, 5).join(', ')}`
    );
  }
  return corpus;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err.message);
    process.stderr.write(USAGE);
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  // Before anything is fetched or written: the filter this script is about
  // to fill has to be the filter the scanner will read.
  assertBloomParity(BloomFilter);

  const topSource = loadTopList(options);
  const aliases = loadAliases(options);
  assertTopListWellFormed(topSource.names);
  assertAliasKeysNotPopular(aliases, topSource.names);

  const workDir = path.resolve(options.workDir);
  const outDir = path.resolve(options.out);
  const statePath = path.join(workDir, 'state.json');
  const namesPath = path.join(workDir, 'names.txt');
  mkdirSync(workDir, { recursive: true });

  let state = options.rebuild ? null : readState(statePath);
  if (state === null || state.version !== STATE_VERSION) {
    state = {
      version: STATE_VERSION,
      phase: 'walk',
      lastKey: null,
      pageCount: 0,
      nameCount: 0,
      updateSeq: null,
      docCount: null,
      startedAt: new Date().toISOString(),
    };
    if (options.rebuild) {
      writeFileSync(namesPath, '');
    }
    writeState(statePath, state);
  }

  // attempts, timeoutMs and userAgent are passed explicitly: fetchJson now
  // comes from the built core, whose own defaults are tuned tight for a
  // live scan (2 attempts, 5s, a generic user agent), not this batch job's
  // patient old defaults (5 attempts, 120s, a walk-specific user agent),
  // which this script still needs and now has to ask for by name.
  const fetchOptions = {
    attempts: options.attempts,
    timeoutMs: 120_000,
    userAgent: USER_AGENT,
    onRetry: ({ attempt, delayMs, reason }) => {
      log(`  retry ${attempt} in ${delayMs}ms: ${reason}`);
    },
  };

  const startedAt = Date.now();

  if (!options.skipFetch) {
    if (options.refresh) {
      log(`Refreshing from update sequence ${state.updateSeq} at ${options.replica}`);
      await applyChanges(options, state, statePath, namesPath, fetchOptions);
    } else {
      if (state.updateSeq === null) {
        // Captured BEFORE the walk, not after: a package published while
        // the walk is running may be missed by _all_docs, and a sequence
        // taken from the start means the next --refresh replays it.
        // Replaying a change is free; missing one is not.
        const info = await fetchReplicaInfo(options.replica, fetchOptions);
        state.updateSeq = info.update_seq ?? null;
        state.docCount = info.doc_count ?? null;
        writeState(statePath, state);
        log(`Registry reports ${state.docCount} packages at sequence ${state.updateSeq}.`);
      }
      log(
        state.lastKey === null
          ? `Walking ${options.replica} from the first name.`
          : `Resuming the walk after "${state.lastKey}" (${state.nameCount} names so far).`
      );
      await walkAllDocs(options, state, statePath, namesPath, fetchOptions);
    }
  }

  let top = topSource.names;
  let ordering = topSource.ordering;
  if (options.rankDownloads) {
    log(`Re-measuring ${top.length} listed name(s) against ${options.downloadsApi}.`);
    top = await verifyTopList(top, namesPath, options, fetchOptions);
    ordering = 'downloads-last-week';
    assertTopListWellFormed(top);
    assertAliasKeysNotPopular(aliases, top);
  }

  log('Counting stored names.');
  const storedCount = countNames(namesPath);
  const extras = collectExtras(top, aliases);
  const nameCount = storedCount + extras.length;
  if (nameCount < 1) {
    fail('the name store is empty, so there is nothing to build');
    return;
  }

  log(`Building the filter over ${storedCount} walked names plus ${extras.length} curated ones.`);
  const filter = BloomFilter.create(namesForFilter(namesPath, extras), nameCount, options.fpRate);
  const serialized = filter.serialize();
  const observedFpRate = measureFalsePositives(filter, 200_000);

  // Read back out of the serialized header rather than recomputed from the
  // sizing formulas: what got written is what the scanner will read, and if
  // the two ever disagree the header is the one that is true.
  const bloomBytes = serialized.length;
  const header = new DataView(serialized.buffer, serialized.byteOffset, serialized.byteLength);
  const bitCount = header.getUint32(5, false);
  const hashCount = serialized[9];

  const meta = buildMeta({
    builtAt: new Date().toISOString(),
    nameCount,
    fpRate: options.fpRate,
    observedFpRate,
    topCount: top.length,
    topOrdering: ordering,
    topSource: topSource.source,
    aliasCount: Object.keys(aliases).length,
    bitCount,
    hashCount,
    bloomBytes,
    source: options.replica,
    updateSeq: state.updateSeq,
    walkComplete: state.phase === 'complete',
  });

  writeArtifacts({ outDir, filter, top, aliases, meta });
  const corpus = verifyThroughLoader(outDir, top);

  log('');
  log(`Wrote ${outDir}`);
  log(`  names            ${nameCount}${meta.walkComplete ? '' : ' (partial walk)'}`);
  log(`  top list         ${top.length} (${ordering})`);
  log(`  aliases          ${meta.aliasCount}`);
  log(`  filter           ${formatBytes(bloomBytes)}, ${bitCount} bits, ${hashCount} hashes`);
  log(`  target fp rate   ${options.fpRate}`);
  log(`  observed fp rate ${observedFpRate.toExponential(2)} over 200000 probes`);
  log(`  built at         ${corpus.builtAt}`);
  log(`  elapsed          ${formatDuration(Date.now() - startedAt)}`);
  log(`  name store       ${formatBytes(statSync(namesPath).size)} at ${namesPath}`);
  if (!meta.walkComplete && !options.skipFetch && !options.refresh) {
    log('');
    log('The walk did not reach the end of the registry. Run again without --max-names');
    log('to continue from where it stopped.');
  }
}

main().catch((err) => {
  fail(err?.stack ?? String(err));
});
