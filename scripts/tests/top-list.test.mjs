import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_DOWNLOAD_FLOOR,
  isPlausiblePackageName,
  measureDownloads,
  parseNameList,
  presentIn,
  renderNameList,
  selectPopular,
  splitScoped,
} from '../lib/top-list.mjs';

describe('isPlausiblePackageName', () => {
  it('accepts ordinary and scoped names', () => {
    expect(isPlausiblePackageName('lodash')).toBe(true);
    expect(isPlausiblePackageName('@types/node')).toBe(true);
    expect(isPlausiblePackageName('npm-run-all2')).toBe(true);
  });

  it('rejects anything a comma-separated bulk request could not carry', () => {
    // The downloads API takes names comma separated, so a name containing a
    // comma would split one request into two answers for names nobody asked
    // about.
    expect(isPlausiblePackageName('lodash,react')).toBe(false);
    expect(isPlausiblePackageName('with\nnewline')).toBe(false);
  });

  it('rejects paths, half-written scopes and padded lines', () => {
    expect(isPlausiblePackageName('a/b')).toBe(false);
    expect(isPlausiblePackageName('@scope')).toBe(false);
    expect(isPlausiblePackageName('@/name')).toBe(false);
    expect(isPlausiblePackageName('@scope/')).toBe(false);
    expect(isPlausiblePackageName('@scope/a/b')).toBe(false);
    expect(isPlausiblePackageName(' lodash')).toBe(false);
  });

  it('rejects a non-string and an over-long name', () => {
    expect(isPlausiblePackageName(undefined)).toBe(false);
    expect(isPlausiblePackageName('a'.repeat(215))).toBe(false);
  });
});

describe('parseNameList and renderNameList', () => {
  it('keeps comment lines out of the names', () => {
    const parsed = parseNameList('# provenance\n#\nreact\n\nlodash\n');
    expect(parsed.header).toEqual(['# provenance', '#']);
    expect(parsed.names).toEqual(['react', 'lodash']);
  });

  it('round-trips a rendered file', () => {
    const rendered = renderNameList({ header: ['a header line'], names: ['react', 'vue'] });
    expect(rendered.startsWith('# a header line\n')).toBe(true);
    expect(parseNameList(rendered).names).toEqual(['react', 'vue']);
  });
});

describe('splitScoped', () => {
  it('separates the names the bulk endpoint refuses', () => {
    expect(splitScoped(['react', '@types/node', 'vue'])).toEqual({
      unscoped: ['react', 'vue'],
      scoped: ['@types/node'],
    });
  });
});

describe('presentIn', () => {
  it('reports only the wanted names the store actually holds', () => {
    const present = presentIn(['react', 'vue', 'left-pad'], ['react', 'never-published']);
    expect([...present]).toEqual(['react']);
  });

  it('stops walking once every wanted name has been found', () => {
    // The store is four million lines and the wanted set is twenty thousand,
    // so an early exit is the difference between one pass and one pass that
    // finishes early on a hot list.
    let read = 0;
    function* store() {
      for (const name of ['react', 'vue', 'lodash', 'chalk']) {
        read += 1;
        yield name;
      }
    }
    presentIn(store(), ['react', 'vue']);
    expect(read).toBe(2);
  });
});

describe('selectPopular', () => {
  const present = new Set(['react', 'vue', 'quiet', 'unmeasured', '@types/node']);

  it('orders by measured downloads and reports every reason a name was dropped', () => {
    const result = selectPopular({
      candidates: ['react', 'vue', 'quiet', 'unmeasured', 'never-published', 'bad name'],
      counts: new Map([
        ['react', 5_000_000],
        ['vue', 9_000_000],
        ['quiet', 12],
      ]),
      present,
      floor: 1000,
    });

    expect(result.listed.map((entry) => entry.name)).toEqual(['vue', 'react']);
    expect(result.dropped.absent).toEqual(['never-published']);
    expect(result.dropped.unmeasured).toEqual(['unmeasured']);
    expect(result.dropped.belowFloor).toEqual(['quiet']);
    expect(result.dropped.malformed).toEqual(['bad name']);
  });

  it('breaks ties by name so two builds of the same data agree on rank', () => {
    // Rank is a 1-based array position and severity keys off it, so an
    // unstable order would move findings between severities for no reason.
    const counts = new Map([
      ['react', 10_000],
      ['vue', 10_000],
      ['quiet', 10_000],
    ]);
    const first = selectPopular({ candidates: ['vue', 'quiet', 'react'], counts, present });
    const second = selectPopular({ candidates: ['react', 'vue', 'quiet'], counts, present });
    expect(first.listed.map((entry) => entry.name)).toEqual(['quiet', 'react', 'vue']);
    expect(second.listed.map((entry) => entry.name)).toEqual(['quiet', 'react', 'vue']);
  });

  it('lists a duplicated candidate once', () => {
    const result = selectPopular({
      candidates: ['react', 'react'],
      counts: new Map([['react', 50_000]]),
      present,
    });
    expect(result.listed).toHaveLength(1);
  });

  it('defaults to the documented floor', () => {
    const result = selectPopular({
      candidates: ['react'],
      counts: new Map([['react', DEFAULT_DOWNLOAD_FLOOR - 1]]),
      present,
    });
    expect(result.listed).toHaveLength(0);
    expect(result.dropped.belowFloor).toEqual(['react']);
  });
});

describe('measureDownloads', () => {
  const downloadsApi = 'https://downloads.test';

  function recordingFetch(urls, answer) {
    return async (url) => {
      urls.push(url);
      return answer(url);
    };
  }

  it('batches unscoped names and asks for scoped ones one at a time', async () => {
    const urls = [];
    const counts = await measureDownloads({
      names: ['react', 'vue', '@types/node', '@types/react'],
      downloadsApi,
      fetchOptions: {},
      fetchImpl: recordingFetch(urls, (url) => {
        if (url.includes('@types/node')) {
          return { downloads: 400, package: '@types/node' };
        }
        if (url.includes('@types/react')) {
          return { downloads: 300, package: '@types/react' };
        }
        return { react: { downloads: 200 }, vue: { downloads: 100 } };
      }),
    });

    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe(`${downloadsApi}/downloads/point/last-week/react,vue`);
    expect(counts.get('react')).toBe(200);
    expect(counts.get('@types/node')).toBe(400);
    expect(counts.get('@types/react')).toBe(300);
  });

  it('records a name the API had no answer for rather than calling it zero', async () => {
    const counts = await measureDownloads({
      names: ['react', 'ghost'],
      downloadsApi,
      fetchOptions: {},
      fetchImpl: async () => ({ react: { downloads: 5 }, ghost: null }),
    });
    expect(counts.get('react')).toBe(5);
    expect(counts.has('ghost')).toBe(false);
  });

  it('does not spend a request on a name the cache already answered', async () => {
    const urls = [];
    const cache = new Map([
      ['react', 42],
      ['ghost', null],
    ]);
    const counts = await measureDownloads({
      names: ['react', 'ghost'],
      downloadsApi,
      fetchOptions: {},
      cache,
      fetchImpl: recordingFetch(urls, () => ({})),
    });
    expect(urls).toHaveLength(0);
    expect(counts.get('react')).toBe(42);
    expect(counts.has('ghost')).toBe(false);
  });

  it('keeps going when one scoped name cannot be measured', async () => {
    // A scoped pass is thousands of sequential requests. One refusal is not
    // worth throwing away the hour that came before it.
    const counts = await measureDownloads({
      names: ['@types/node', '@types/broken'],
      downloadsApi,
      fetchOptions: {},
      fetchImpl: async (url) => {
        if (url.includes('broken')) {
          throw new Error('404');
        }
        return { downloads: 7, package: '@types/node' };
      },
    });
    expect(counts.get('@types/node')).toBe(7);
    expect(counts.has('@types/broken')).toBe(false);
  });

  it('checkpoints what it has measured so a killed pass resumes', async () => {
    const checkpoints = [];
    await measureDownloads({
      names: ['@a/one', '@a/two', '@a/three'],
      downloadsApi,
      fetchOptions: {},
      checkpointEvery: 2,
      onCheckpoint: (cache) => checkpoints.push(cache.size),
      fetchImpl: async () => ({ downloads: 1 }),
    });
    expect(checkpoints.length).toBeGreaterThan(1);
    expect(checkpoints[checkpoints.length - 1]).toBe(3);
  });
});
