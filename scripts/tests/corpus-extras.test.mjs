import { describe, expect, it } from '@jest/globals';

import { collectExtras } from '../lib/corpus-extras.mjs';

// Pins the sharing itself (scripts/build-corpus.mjs and
// scripts/lib/shippable-corpus.mjs both import this one implementation)
// and, in particular, the defensive shape handling that used to live only
// in the gate's copy: the builder never calls this with a malformed shape,
// but the gate calls it with values read back off disk, so those cases
// have to keep behaving the same way after the extraction.
describe('collectExtras', () => {
  it('returns a Set of the top-list names and every alias target', () => {
    const extras = collectExtras(['react', 'vue'], { crossenv: ['cross-env'], vuex: ['vue', 'vuex-persist'] });

    expect(extras).toBeInstanceOf(Set);
    expect([...extras].sort()).toEqual(['cross-env', 'react', 'vue', 'vuex-persist']);
  });

  it('deduplicates a name that appears in both the top list and an alias target', () => {
    const extras = collectExtras(['react'], { compat: ['react'] });
    expect([...extras]).toEqual(['react']);
  });

  it('tolerates a non-array top list by contributing no top-list names', () => {
    const extras = collectExtras({ not: 'an array' }, { crossenv: ['cross-env'] });
    expect([...extras]).toEqual(['cross-env']);
  });

  it('tolerates a non-object aliases value by contributing no alias targets', () => {
    expect([...collectExtras(['react'], null)]).toEqual(['react']);
    expect([...collectExtras(['react'], [1, 2, 3])]).toEqual(['react']);
    expect([...collectExtras(['react'], 'not an object')]).toEqual(['react']);
  });

  it('skips an alias entry whose targets are not an array', () => {
    const extras = collectExtras([], { broken: 'not-an-array' });
    expect([...extras]).toEqual([]);
  });

  it('skips non-string and empty-string alias targets', () => {
    const extras = collectExtras([], { broken: [42, '', null, 'ok'] });
    expect([...extras]).toEqual(['ok']);
  });

  it('returns an empty Set when both inputs are malformed', () => {
    const extras = collectExtras(null, undefined);
    expect(extras).toBeInstanceOf(Set);
    expect(extras.size).toBe(0);
  });
});
