// Building the popularity list that ships as top.json.
//
// What the list is for, and why that makes it a trust input
// ---------------------------------------------------------
// typosquat.ts reads the popularity list three ways: a name in the list is
// exempt from being reported at all, a name in the list is a valid target
// for another name to be reported against, and the rank splits severity.
// The exemption is the part that matters here. A name on this list can
// never be reported as a squat of anything, so getting a name onto it buys
// permanent immunity from the rule. That makes the list a trust input, not
// merely data, and it is why nothing here believes a ranking source about
// what is popular.
//
// Every candidate has to clear two independent checks before it earns a
// place:
//
//   1. It exists. Checked against the names walked out of the registry
//      replica by build-corpus.mjs, which is the same set the existence
//      rule reads. A name the walk never saw is not put in front of users
//      as a package they might have meant to type.
//   2. It is used. Checked against npm's own downloads API, last week,
//      measured at build time rather than taken from the candidate list.
//      A name below the floor is dropped.
//
// The floor
// ---------
// DEFAULT_DOWNLOAD_FLOOR is ten thousand downloads in the last week. The
// reasoning, since the number is a judgement and should read as one:
//
//   - It is orders of magnitude above the traffic a package with no
//     adopters receives. A freshly published name with nothing depending
//     on it sees tens to low hundreds of downloads a week from mirrors,
//     scanners and the registry's own tooling. Ten thousand cannot be
//     reached by publishing alone.
//   - Sustaining it means real installation: being in somebody's CI, or
//     being a transitive dependency of something that is. That is exactly
//     the property the exemption needs, because the false positives this
//     list exists to kill are all packages people genuinely install.
//   - Applied to the candidate set it lands the list at roughly twenty
//     thousand names, inside the ten to twenty five thousand the check was
//     designed around.
//
// It is a bar, not a proof. Download counts can be inflated by anyone
// willing to spend on it, so the floor is one of three things standing
// between an attacker and an exemption: candidacy comes from an
// independent popularity ranking rather than self-nomination, the name has
// to exist in a registry walk this project performed itself, and the alias
// list is consulted before the top-list exemption, so a curated pair
// cannot be laundered by getting onto the list at all.
//
// Scoped names
// ------------
// The downloads API has no bulk form for scoped names: the batch endpoint
// answers "scoped packages are not currently supported in bulk lookups"
// for any batch containing one. So a scoped name costs a whole request of
// its own, where an unscoped name costs a hundred and twenty eighth of
// one. They are measured anyway, one at a time, because the alternative is
// a list with no scoped names in it, and a scoped package absent from the
// list is a scoped package the typosquat rule will report as a squat of
// its own sibling.

import {
  DOWNLOADS_BATCH_SIZE,
  fetchJson,
  readDownloadCounts,
  splitDownloadBatches,
} from './registry.mjs';

export const DEFAULT_DOWNLOAD_FLOOR = 10_000;

// Registry rules, applied to a candidate before a request is spent on it.
// Deliberately narrow: this rejects a line that is not a package name at
// all rather than trying to reimplement validate-npm-package-name.
const MAX_NAME_LENGTH = 214;

export function isPlausiblePackageName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return false;
  }
  // No whitespace anywhere, and no comma: names travel to the downloads API
  // comma separated, so a name carrying either would turn one request into
  // answers about packages nobody asked about.
  for (const character of name) {
    if (character === ',' || character.trim().length === 0) {
      return false;
    }
  }
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    return slash > 1 && slash < name.length - 1 && name.indexOf('/', slash + 1) === -1;
  }
  return !name.includes('/') && !name.startsWith('.') && !name.startsWith('_');
}

// The list files this module reads and writes are newline-delimited names
// with a '#' comment header. Plain text rather than JSON so that a diff of
// twenty thousand names is one line per change, which is the difference
// between a reviewable pull request and an unreviewable one.
export function parseNameList(text) {
  const header = [];
  const names = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith('#')) {
      header.push(line);
      continue;
    }
    names.push(line);
  }
  return { header, names };
}

export function renderNameList({ header, names }) {
  const lines = header.map((line) => (line.startsWith('#') ? line : `# ${line}`));
  return `${[...lines, ...names].join('\n')}\n`;
}

// Bulk-eligible against not. The split is the API's, not ours.
export function splitScoped(names) {
  const unscoped = [];
  const scoped = [];
  for (const name of names) {
    if (name.startsWith('@')) {
      scoped.push(name);
    } else {
      unscoped.push(name);
    }
  }
  return { unscoped, scoped };
}

// Which of the wanted names the registry walk actually saw. Streams the
// name store rather than loading it: the store is four and a quarter
// million lines, and the wanted set is twenty thousand, so the small side
// is the one to hold in memory.
export function presentIn(nameIterable, wanted) {
  const remaining = new Set(wanted);
  const present = new Set();
  for (const name of nameIterable) {
    if (remaining.delete(name)) {
      present.add(name);
      if (remaining.size === 0) {
        break;
      }
    }
  }
  return present;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Measured counts for a set of names, unscoped in batches and scoped one at
// a time. Returns a Map of name to count; a name the API had no answer for
// is absent from the Map rather than present as zero, because "no data" and
// "no downloads" are different claims and only one of them is being made.
//
// The cache is a plain object of name to count carried across runs by the
// caller. It exists because the scoped half of a full pass is thousands of
// sequential requests against an API that sustains roughly one per second,
// and losing that to a dropped connection at request four thousand should
// cost the connection rather than the pass.
export async function measureDownloads({
  names,
  downloadsApi,
  fetchOptions,
  delayMs = 0,
  cache = new Map(),
  onProgress = () => {},
  onCheckpoint = () => {},
  checkpointEvery = 250,
  fetchImpl = fetchJson,
}) {
  const counts = new Map();
  const wanted = [];
  for (const name of names) {
    if (cache.has(name)) {
      const cached = cache.get(name);
      if (typeof cached === 'number') {
        counts.set(name, cached);
      }
      continue;
    }
    wanted.push(name);
  }

  const { unscoped, scoped } = splitScoped(wanted);
  let done = 0;
  let sinceCheckpoint = 0;
  const total = wanted.length;

  const record = (name, value) => {
    cache.set(name, value);
    if (typeof value === 'number') {
      counts.set(name, value);
    }
  };

  for (const batch of splitDownloadBatches(unscoped, DOWNLOADS_BATCH_SIZE)) {
    const url = `${downloadsApi}/downloads/point/last-week/${batch.join(',')}`;
    const payload = await fetchImpl(url, fetchOptions);
    // readDownloadCounts returns { counts, noRecord } (core's shape); this
    // module has only ever needed the numeric counts, so noRecord is
    // discarded here -- a name absent from `counts` is already recorded
    // as unanswered (null) below, whether that is because npm confirmed
    // no record or because the response simply did not mention it.
    const answered = readDownloadCounts(payload, batch).counts;
    for (const name of batch) {
      // null rather than undefined: a name the API answered nothing for is
      // recorded as asked-and-unanswered, so a resumed run does not ask
      // again and get the same nothing.
      record(name, answered.has(name) ? answered.get(name) : null);
    }
    done += batch.length;
    sinceCheckpoint += batch.length;
    onProgress({ done, total, phase: 'bulk' });
    if (sinceCheckpoint >= checkpointEvery) {
      sinceCheckpoint = 0;
      onCheckpoint(cache);
    }
    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  for (const name of scoped) {
    const url = `${downloadsApi}/downloads/point/last-week/${name}`;
    let payload = null;
    try {
      payload = await fetchImpl(url, fetchOptions);
    } catch {
      // A scoped name the API refuses to answer for (unpublished, or
      // simply absent from its records) is recorded as unanswered and the
      // pass continues. One name is not worth failing a pass that has
      // already spent an hour.
      payload = null;
    }
    const answered = payload === null ? new Map() : readDownloadCounts(payload, [name]).counts;
    record(name, answered.has(name) ? answered.get(name) : null);
    done += 1;
    sinceCheckpoint += 1;
    onProgress({ done, total, phase: 'scoped' });
    if (sinceCheckpoint >= checkpointEvery) {
      sinceCheckpoint = 0;
      onCheckpoint(cache);
    }
    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  onCheckpoint(cache);
  return counts;
}

// The selection itself, kept pure so it can be tested without a network.
// Order is downloads descending, ties broken by name ascending: rank is a
// 1-based array position that severity keys off, so two builds of the same
// data have to produce the same positions.
export function selectPopular({ candidates, counts, present, floor = DEFAULT_DOWNLOAD_FLOOR }) {
  const seen = new Set();
  const listed = [];
  const dropped = { malformed: [], absent: [], unmeasured: [], belowFloor: [] };

  for (const name of candidates) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);

    if (!isPlausiblePackageName(name)) {
      dropped.malformed.push(name);
      continue;
    }
    if (!present.has(name)) {
      dropped.absent.push(name);
      continue;
    }
    const count = counts.get(name);
    if (typeof count !== 'number') {
      dropped.unmeasured.push(name);
      continue;
    }
    if (count < floor) {
      dropped.belowFloor.push(name);
      continue;
    }
    listed.push({ name, downloads: count });
  }

  listed.sort((left, right) => {
    if (right.downloads !== left.downloads) {
      return right.downloads - left.downloads;
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });

  return { listed, dropped };
}
