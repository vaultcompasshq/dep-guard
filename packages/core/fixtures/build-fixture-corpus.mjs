#!/usr/bin/env node
// Generates the committed dev fixture corpus used by
// packages/core/tests/corpus.test.ts and by every later check's tests.
//
// Run once, after building core so the compiled bloom filter is available:
//   pnpm build
//   node packages/core/fixtures/build-fixture-corpus.mjs
//
// Commit the generated files (names.bloom, top.json, aliases.json,
// meta.json) alongside this script -- they are fixtures, not build output.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BloomFilter } from '../dist/bloom.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'corpus');

// Ordered by real-world npm popularity; rank is 1-based position in this
// array. Keep 'react' first -- corpus.test.ts pins topRank('react') === 1.
const TOP = [
  'react',
  'lodash',
  'express',
  'chalk',
  'commander',
  'typescript',
  'eslint',
  'jest',
  'axios',
  'vue',
  'webpack',
  'vite',
  'next',
  'nuxt',
  'rollup',
  'parcel',
  'eslint-plugin-react',
  'prettier',
  'mocha',
  'chai',
  'sinon',
  'nodemon',
  'dotenv',
  'moment',
  'dayjs',
  'uuid',
  'yargs',
  'inquirer',
  'rimraf',
  'glob',
  'minimist',
  'semver',
  'tslib',
  'rxjs',
  'redux',
  'react-dom',
  'react-router',
  'react-router-dom',
  'vuex',
  'pinia',
  'svelte',
  '@sveltejs/kit',
  'postcss',
  'sass',
  'tailwindcss',
  'bootstrap',
  'jquery',
  '@babel/core',
  '@types/node',
  'vitest',
];

const ALIASES = {
  'unused-imports': ['eslint-plugin-unused-imports'],
};

// Names the bloom filter must recognize beyond the top list, so checks that
// only consult the bloom (not the ranked top list) still see them as known.
const EXTRA_BLOOM_NAMES = ['left-pad', 'is-even', 'my-real-dep'];

const FP_RATE = 0.001;
const BUILT_AT = '2026-08-01';

const allNames = [...TOP, ...EXTRA_BLOOM_NAMES];
const filter = BloomFilter.create(allNames, allNames.length, FP_RATE);

mkdirSync(OUT_DIR, { recursive: true });

writeFileSync(path.join(OUT_DIR, 'names.bloom'), filter.serialize());
writeFileSync(path.join(OUT_DIR, 'top.json'), `${JSON.stringify(TOP, null, 2)}\n`);
writeFileSync(path.join(OUT_DIR, 'aliases.json'), `${JSON.stringify(ALIASES, null, 2)}\n`);
writeFileSync(
  path.join(OUT_DIR, 'meta.json'),
  `${JSON.stringify(
    { builtAt: BUILT_AT, nameCount: allNames.length, fpRate: FP_RATE },
    null,
    2
  )}\n`
);

console.log(`Wrote fixture corpus (${allNames.length} names) to ${OUT_DIR}`);
