#!/usr/bin/env node
// Rebuilds the popularity list that ships as top.json.
//
//   node scripts/refresh-top-list.mjs --candidates   # gather candidates
//   node scripts/refresh-top-list.mjs --verify       # verify and rank them
//   node scripts/refresh-top-list.mjs                # both, in that order
//
// Two files come out of this, and the split between them is the point.
//
//   scripts/data/popularity-candidates.txt
//     Names worth asking about. Assembled from a vendored public ranking, a
//     first-party search sweep and the curated seed this repository already
//     had. Nothing here is trusted: it is a list of questions.
//
//   scripts/data/top-packages.txt
//     The answers. Every name that exists in the registry walk and that
//     npm's downloads API says cleared the usage floor last week, ordered by
//     that measurement. This is what build-corpus.mjs ships.
//
// Why a checked-in file at all
// ---------------------------
// A supply-chain tool that fetches its own trust data from somebody else's
// server every time it builds is arguing against itself. The popularity
// list decides which names are permanently exempt from typosquat
// reporting, so it is reviewed, versioned and diffed like source. Building
// a corpus reads it off disk; refreshing it is this deliberate command,
// run when somebody means to.
//
// Where the candidates come from, in order of how much they are believed
// ---------------------------------------------------------------------
//   1. npm's own downloads API, which is the only thing that decides
//      whether a candidate becomes a listed name.
//   2. npm's own registry search, popularity ordered, which nominates
//      candidates and reports a download figure used only to decide
//      whether a name is worth spending a verification request on.
//   3. npm-high-impact, a third-party ranking published to the registry.
//      It is fetched from registry.npmjs.org, its tarball is checked
//      against the integrity string the registry serves with it, it is
//      read with a scanner rather than executed, and every name it
//      proposes still has to clear both checks above. Its version and
//      integrity are recorded in the candidates file header.
//
// The rate this runs at
// ---------------------
// api.npmjs.org sustains roughly one request per second from one address,
// and the bulk downloads endpoint refuses scoped names, so a scoped name
// costs a whole request where an unscoped one costs a hundred and twenty
// eighth of one. A full verification pass is therefore a few hours,
// dominated entirely by scoped names. It is resumable: measurements are
// cached in the work directory as they are taken.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALIAS_SEED } from './lib/aliases.mjs';
import { aliasKeysShadowingTop } from './lib/corpus-guards.mjs';
import { readNames } from './lib/name-store.mjs';
import {
  DEFAULT_DOWNLOADS_API,
  DEFAULT_REGISTRY,
  SEARCH_PAGE_SIZE,
  USER_AGENT,
  fetchJson,
  fetchSearchPage,
} from './lib/registry.mjs';
import { integrityMatches, readTarballEntry, extractStringLiterals } from './lib/tarball.mjs';
import {
  DEFAULT_DOWNLOAD_FLOOR,
  isPlausiblePackageName,
  measureDownloads,
  parseNameList,
  presentIn,
  renderNameList,
  selectPopular,
  splitScoped,
} from './lib/top-list.mjs';
import { TOP_SEED } from './lib/top-seed.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(REPO_ROOT, 'scripts', 'data');

const DEFAULTS = {
  candidatesFile: path.join(DATA_DIR, 'popularity-candidates.txt'),
  outFile: path.join(DATA_DIR, 'top-packages.txt'),
  workDir: path.join(REPO_ROOT, '.corpus-work'),
  registry: DEFAULT_REGISTRY,
  downloadsApi: DEFAULT_DOWNLOADS_API,
  floor: DEFAULT_DOWNLOAD_FLOOR,
  delayMs: 1000,
  attempts: 6,
  // The vendored ranking. Pinned by name; the version is resolved from the
  // registry at vendor time and written into the candidates file header, so
  // a later reader can tell exactly which release the names came from.
  rankingPackage: 'npm-high-impact',
  rankingEntry: 'package/lib/top.js',
  rankingVersion: null,
  sweepTerms: 40,
  sweepPages: 12,
  // A sweep candidate has to look plausible before a verification request
  // is spent on it. Unscoped candidates are almost free to check, so they
  // come in at the floor. A scoped candidate costs a whole request, so the
  // sweep only nominates one that search already reports as heavily used;
  // below that bar a scoped name is represented only if the vendored
  // ranking named it. That is the residual gap, and it is written into the
  // candidates file header rather than left to be discovered.
  sweepScopedFloor: 250_000,
};

const USAGE = `Usage: node scripts/refresh-top-list.mjs [options]

  --candidates          gather candidates only
  --verify              verify and rank existing candidates only
  --candidates-file <p> candidate list (default scripts/data/popularity-candidates.txt)
  --out <path>          verified list (default scripts/data/top-packages.txt)
  --work-dir <dir>      where the name store and the measurement cache live
  --floor <n>           last-week downloads a name must clear (default ${DEFAULTS.floor})
  --registry <url>      registry base URL for search and package metadata
  --downloads-api <url> downloads API base URL
  --delay <ms>          pause between requests (default ${DEFAULTS.delayMs})
  --attempts <n>        attempts per request before giving up (default ${DEFAULTS.attempts})
  --ranking-version <v> pin the vendored ranking to a version
  --sweep-terms <n>     query terms in the search sweep (default ${DEFAULTS.sweepTerms})
  --sweep-pages <n>     pages per term (default ${DEFAULTS.sweepPages})
  --no-sweep            skip the search sweep
  -h, --help            print this
`;

function log(message) {
  process.stderr.write(`${message}\n`);
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, candidates: false, verify: false, sweep: true };
  const numeric = new Map([
    ['--floor', 'floor'],
    ['--delay', 'delayMs'],
    ['--attempts', 'attempts'],
    ['--sweep-terms', 'sweepTerms'],
    ['--sweep-pages', 'sweepPages'],
  ]);
  const strings = new Map([
    ['--candidates-file', 'candidatesFile'],
    ['--out', 'outFile'],
    ['--work-dir', 'workDir'],
    ['--registry', 'registry'],
    ['--downloads-api', 'downloadsApi'],
    ['--ranking-version', 'rankingVersion'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }
    if (arg === '--candidates') {
      options.candidates = true;
      continue;
    }
    if (arg === '--verify') {
      options.verify = true;
      continue;
    }
    if (arg === '--no-sweep') {
      options.sweep = false;
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
  if (!options.candidates && !options.verify) {
    options.candidates = true;
    options.verify = true;
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Query terms for the sweep, taken from the names the vendored ranking
// already proposes rather than from anyone's taste. Popular package names
// are built out of a small vocabulary, so the tokens that recur across a
// known-popular set are the ones that will surface more of the same.
export function sweepTermsFrom(names, count) {
  const frequency = new Map();
  for (const name of names) {
    const body = name.startsWith('@') ? name.slice(1) : name;
    const seen = new Set();
    let token = '';
    const flush = () => {
      if (token.length >= 2 && token.length <= 16 && !seen.has(token)) {
        seen.add(token);
        frequency.set(token, (frequency.get(token) ?? 0) + 1);
      }
      token = '';
    };
    for (const character of body) {
      const isWord =
        (character >= 'a' && character <= 'z') ||
        (character >= 'A' && character <= 'Z') ||
        (character >= '0' && character <= '9');
      if (isWord) {
        token += character.toLowerCase();
      } else {
        flush();
      }
    }
    flush();
  }
  return [...frequency.entries()]
    .sort((left, right) => (right[1] !== left[1] ? right[1] - left[1] : left[0] < right[0] ? -1 : 1))
    .slice(0, count)
    .map(([term]) => term);
}

async function vendorRanking(options, fetchOptions) {
  const metadataUrl = `${options.registry}/${options.rankingPackage}`;
  const metadata = await fetchJson(metadataUrl, fetchOptions);
  const version = options.rankingVersion ?? metadata?.['dist-tags']?.latest;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${options.rankingPackage} has no resolvable version`);
  }
  const release = metadata?.versions?.[version];
  const tarball = release?.dist?.tarball;
  const integrity = release?.dist?.integrity;
  if (typeof tarball !== 'string' || typeof integrity !== 'string') {
    throw new Error(`${options.rankingPackage}@${version} has no tarball or integrity string`);
  }

  log(`Fetching ${options.rankingPackage}@${version} from ${options.registry}`);
  const response = await fetch(tarball, {
    headers: { 'user-agent': 'dep-guard-corpus-builder/0.1' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`tarball request failed: ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());

  // Checked before anything in the archive is read, not after. An archive
  // that does not match the metadata the registry served with it is not the
  // artifact anybody reviewed, and the only safe thing to do with it is stop.
  if (!integrityMatches(bytes, integrity)) {
    throw new Error(
      `${options.rankingPackage}@${version} did not match its published integrity string; ` +
        'refusing to read it'
    );
  }

  const entry = readTarballEntry(bytes, options.rankingEntry);
  if (entry === null) {
    throw new Error(`${options.rankingEntry} is not in ${options.rankingPackage}@${version}`);
  }
  const names = extractStringLiterals(entry.toString('utf8')).filter(isPlausiblePackageName);
  if (names.length < 1000) {
    throw new Error(
      `${options.rankingEntry} yielded only ${names.length} names, which does not look like the ` +
        'ranking it is supposed to be'
    );
  }
  log(`  ${names.length} candidate names, integrity verified`);
  return { version, integrity, names, publishedAt: metadata?.time?.[version] ?? null };
}

async function sweepSearch(options, terms, fetchOptions) {
  const rows = new Map();
  let requests = 0;
  for (const term of terms) {
    for (let page = 0; page < options.sweepPages; page += 1) {
      const from = page * SEARCH_PAGE_SIZE;
      let found;
      try {
        found = await fetchSearchPage(options.registry, { text: term, from }, fetchOptions);
      } catch (err) {
        log(`  search "${term}" page ${page} gave up: ${err.message}`);
        break;
      }
      requests += 1;
      for (const row of found) {
        const previous = rows.get(row.name);
        if (previous === undefined || (row.weekly ?? 0) > previous) {
          rows.set(row.name, row.weekly ?? 0);
        }
      }
      if (found.length < SEARCH_PAGE_SIZE) {
        break;
      }
      await sleep(options.delayMs);
    }
    log(`  swept "${term}": ${rows.size} names seen, ${requests} requests`);
  }
  return rows;
}

function candidateHeader(values) {
  return [
    'dep-guard popularity candidates. NOT a trust list: every name here is a',
    'question, and scripts/refresh-top-list.mjs --verify is what answers it.',
    'Nothing in this file is exempt from anything until it has been checked',
    'against the registry walk and npm\'s downloads API.',
    '',
    `generated-at: ${values.generatedAt}`,
    `generated-by: scripts/refresh-top-list.mjs --candidates`,
    `total-candidates: ${values.total}`,
    '',
    'Sources, in the order they were merged:',
    '',
    `  1. ${values.rankingPackage}@${values.rankingVersion}, a third-party ranking of`,
    '     packages npm itself classifies as high impact (one million or more',
    '     downloads a week, or five hundred or more dependent packages).',
    `     published-at: ${values.rankingPublishedAt}`,
    `     integrity:    ${values.rankingIntegrity}`,
    `     entry:        ${values.rankingEntry}`,
    `     names:        ${values.rankingCount}`,
    '     Fetched from the registry, checked against the integrity string the',
    '     registry served with it, and read with a scanner rather than',
    '     executed. It nominates names. It does not vouch for them.',
    '',
    `  2. A sweep of the registry search API at ${values.registry}, ordered by`,
    '     popularity, over query terms taken from the tokens that recur most',
    `     across source 1. terms: ${values.sweepTerms}, pages per term: ${values.sweepPages},`,
    `     names seen: ${values.sweepSeen}, admitted: ${values.sweepAdmitted}.`,
    `     Unscoped names were admitted at the usage floor (${values.floor} a week).`,
    '     A scoped name costs a whole verification request where an unscoped',
    '     one costs a hundred and twenty eighth of one, because the bulk',
    '     downloads endpoint refuses scoped names, so the sweep only admits a',
    `     scoped name search already reports at ${values.sweepScopedFloor} a week or more.`,
    '     RESIDUAL GAP: a scoped package between the usage floor and that bar',
    '     is a candidate only if source 1 or source 3 named it.',
    '',
    `  3. The curated seed this repository shipped before this list existed`,
    `     (scripts/lib/top-seed.mjs, ${values.curatedCount} names), carried forward so that`,
    '     replacing a hand-written list cannot silently drop a name from it.',
  ];
}

function verifiedHeader(values) {
  return [
    'dep-guard popularity list. This file IS a trust input: typosquat.ts',
    'exempts every name in it from being reported as a squat of anything, and',
    'reads its position as the rank that splits severity. Adding a name here',
    'buys that name permanent immunity from the rule, so nothing is added by',
    'hand and nothing is taken on trust.',
    '',
    `generated-at: ${values.generatedAt}`,
    `generated-by: scripts/refresh-top-list.mjs --verify`,
    `candidates:   ${values.candidatesFile}`,
    `listed:       ${values.listed}`,
    `order:        last-week downloads, descending; ties by name ascending`,
    '',
    'How a name earned its place. Both checks, independently, no exceptions:',
    '',
    `  Existence: the name was seen by this project's own walk of the registry`,
    `     replica (${values.storedNames} names, update sequence ${values.updateSeq}).`,
    '     A name the walk never saw is not put in front of anybody as a',
    '     package they might have meant to type.',
    '',
    `  Usage: npm's downloads API at ${values.downloadsApi} reported at least`,
    `     ${values.floor} downloads in the last week, measured here rather than`,
    '     taken from whatever nominated the name. Unscoped names were measured',
    '     in batches of a hundred and twenty eight; scoped names one at a time,',
    '     because the bulk endpoint refuses them.',
    '',
    'What the floor is and is not. Ten thousand downloads a week is orders of',
    'magnitude above what a package with no adopters receives, and cannot be',
    'reached by publishing alone: it means real installs, in real CI, or being',
    'a transitive dependency of something that is. It is a bar, not a proof.',
    'Counts can be inflated by anyone willing to spend on it, which is why the',
    'floor is one of three things in the way: candidacy comes from an',
    'independent ranking rather than self-nomination, the name has to exist in',
    'a walk this project performed itself, and the alias list is consulted',
    'before this exemption, so a curated pair cannot be laundered by getting',
    'onto this list.',
    '',
    `Dropped at verification: ${values.droppedAbsent} absent from the walk,`,
    `${values.droppedUnmeasured} with no download figure, ${values.droppedBelowFloor} below the floor,`,
    `${values.droppedMalformed} not shaped like a package name.`,
  ];
}

function readCacheFile(cachePath) {
  const cache = new Map();
  if (!existsSync(cachePath)) {
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
    for (const [name, value] of Object.entries(parsed?.counts ?? {})) {
      cache.set(name, typeof value === 'number' ? value : null);
    }
  } catch {
    // A cache that cannot be read is a cache that is not used. It only ever
    // saves requests, so losing it costs time and nothing else.
    return new Map();
  }
  return cache;
}

function writeCacheFile(cachePath, cache) {
  const counts = {};
  for (const [name, value] of cache) {
    counts[name] = value;
  }
  writeFileSync(cachePath, `${JSON.stringify({ writtenAt: new Date().toISOString(), counts })}\n`);
}

async function gatherCandidates(options, fetchOptions) {
  const ranking = await vendorRanking(options, fetchOptions);

  let sweepSeen = 0;
  let sweepAdmitted = 0;
  const fromSweep = [];
  if (options.sweep) {
    const terms = sweepTermsFrom(ranking.names, options.sweepTerms);
    log(`Sweeping registry search over ${terms.length} terms: ${terms.slice(0, 12).join(' ')} ...`);
    const rows = await sweepSearch(options, terms, fetchOptions);
    sweepSeen = rows.size;
    for (const [name, weekly] of rows) {
      if (!isPlausiblePackageName(name)) {
        continue;
      }
      const bar = name.startsWith('@') ? options.sweepScopedFloor : options.floor;
      if (weekly >= bar) {
        fromSweep.push(name);
      }
    }
    sweepAdmitted = fromSweep.length;
    log(`  ${sweepSeen} names seen, ${sweepAdmitted} admitted as candidates`);
  }

  const merged = [];
  const seen = new Set();
  for (const name of [...ranking.names, ...fromSweep, ...TOP_SEED]) {
    if (!isPlausiblePackageName(name) || seen.has(name)) {
      continue;
    }
    seen.add(name);
    merged.push(name);
  }

  const header = candidateHeader({
    generatedAt: new Date().toISOString(),
    total: merged.length,
    rankingPackage: options.rankingPackage,
    rankingVersion: ranking.version,
    rankingPublishedAt: ranking.publishedAt ?? 'unknown',
    rankingIntegrity: ranking.integrity,
    rankingEntry: options.rankingEntry,
    rankingCount: ranking.names.length,
    registry: options.registry,
    sweepTerms: options.sweep ? options.sweepTerms : 0,
    sweepPages: options.sweep ? options.sweepPages : 0,
    sweepSeen,
    sweepAdmitted,
    sweepScopedFloor: options.sweepScopedFloor,
    floor: options.floor,
    curatedCount: TOP_SEED.length,
  });

  mkdirSync(path.dirname(options.candidatesFile), { recursive: true });
  writeFileSync(options.candidatesFile, renderNameList({ header, names: merged }));
  log(`Wrote ${merged.length} candidates to ${options.candidatesFile}`);
}

async function verifyCandidates(options, fetchOptions) {
  const { names: candidates } = parseNameList(readFileSync(options.candidatesFile, 'utf8'));
  if (candidates.length === 0) {
    throw new Error(`${options.candidatesFile} has no candidate names in it`);
  }
  log(`Verifying ${candidates.length} candidates.`);

  const namesPath = path.join(path.resolve(options.workDir), 'names.txt');
  if (!existsSync(namesPath)) {
    throw new Error(
      `no name store at ${namesPath}. Existence cannot be checked without one; run ` +
        'scripts/build-corpus.mjs first.'
    );
  }
  const present = presentIn(readNames(namesPath), candidates);
  log(`  ${present.size} of ${candidates.length} were seen by the registry walk.`);

  const measurable = candidates.filter((name) => present.has(name));
  const { unscoped, scoped } = splitScoped(measurable);
  log(
    `  measuring ${unscoped.length} unscoped names in batches and ${scoped.length} scoped names ` +
      'one at a time'
  );

  const cachePath = path.join(path.resolve(options.workDir), 'downloads-cache.json');
  const cache = readCacheFile(cachePath);
  if (cache.size > 0) {
    log(`  ${cache.size} measurement(s) already cached at ${cachePath}`);
  }

  const startedAt = Date.now();
  const counts = await measureDownloads({
    names: measurable,
    downloadsApi: options.downloadsApi,
    fetchOptions,
    delayMs: options.delayMs,
    cache,
    onProgress: ({ done, total, phase }) => {
      if (done % 250 === 0 || done === total) {
        const rate = done / Math.max(1, (Date.now() - startedAt) / 1000);
        const left = Math.round((total - done) / Math.max(rate, 0.01) / 60);
        log(`    ${phase}: ${done}/${total}, about ${left}m left`);
      }
    },
    onCheckpoint: (current) => writeCacheFile(cachePath, current),
  });

  const { listed, dropped } = selectPopular({
    candidates,
    counts,
    present,
    floor: options.floor,
  });

  const state = existsSync(path.join(path.resolve(options.workDir), 'state.json'))
    ? JSON.parse(readFileSync(path.join(path.resolve(options.workDir), 'state.json'), 'utf8'))
    : {};

  const names = listed.map((entry) => entry.name);
  const shadowing = aliasKeysShadowingTop(ALIAS_SEED, names);
  if (shadowing.length > 0) {
    // Reported rather than swallowed. The corpus builder refuses to ship a
    // corpus in this state, so a list written here that trips the guard has
    // to be resolved by a person deciding which of the two entries is wrong.
    log(
      `WARNING: ${shadowing.length} alias key(s) are also in this list and will fail the corpus ` +
        `build: ${shadowing.join(', ')}`
    );
  }

  const header = verifiedHeader({
    generatedAt: new Date().toISOString(),
    candidatesFile: path.relative(REPO_ROOT, options.candidatesFile),
    listed: names.length,
    storedNames: state.nameCount ?? 'unknown',
    updateSeq: state.updateSeq ?? 'unknown',
    downloadsApi: options.downloadsApi,
    floor: options.floor,
    droppedAbsent: dropped.absent.length,
    droppedUnmeasured: dropped.unmeasured.length,
    droppedBelowFloor: dropped.belowFloor.length,
    droppedMalformed: dropped.malformed.length,
  });

  mkdirSync(path.dirname(options.outFile), { recursive: true });
  writeFileSync(options.outFile, renderNameList({ header, names }));

  const scopedListed = names.filter((name) => name.startsWith('@')).length;
  log('');
  log(`Wrote ${options.outFile}`);
  log(`  listed            ${names.length} (${scopedListed} scoped)`);
  log(`  floor             ${options.floor} downloads last week`);
  log(`  dropped absent    ${dropped.absent.length}`);
  log(`  dropped no figure ${dropped.unmeasured.length}`);
  log(`  dropped below     ${dropped.belowFloor.length}`);
  log(`  dropped malformed ${dropped.malformed.length}`);
  if (names.length > 0) {
    log(`  rank 1            ${names[0]}`);
    log(`  rank ${names.length}${' '.repeat(Math.max(0, 12 - String(names.length).length))}${names[names.length - 1]}`);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`refresh-top-list: ${err.message}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
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
      if (attempt >= 3) {
        log(`  retry ${attempt} in ${delayMs}ms: ${reason}`);
      }
    },
  };

  if (options.candidates) {
    await gatherCandidates(options, fetchOptions);
  }
  if (options.verify) {
    await verifyCandidates(options, fetchOptions);
  }
}

main().catch((err) => {
  process.stderr.write(`refresh-top-list: ${err?.stack ?? String(err)}\n`);
  process.exitCode = 1;
});
