import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseBaseline } from '../src/baseline.js';
import { loadConfig } from '../src/config.js';
import { parseNpmLockfile } from '../src/lockfiles/npm.js';
import { parseOnlyBuilt, parsePnpmLockfile } from '../src/lockfiles/pnpm.js';
import { parseManifest } from '../src/manifest.js';
import { parseNpmrcDefaultRegistry, parseNpmrcPins } from '../src/state.js';

// npm and pnpm read a JSON or YAML file that starts with a UTF-8 byte order
// mark, so every file the scan parses accepts one too.
const BOM = '﻿';

describe('a leading UTF-8 byte order mark is accepted wherever a file is parsed', () => {
  test('a manifest', () => {
    const manifest = parseManifest('package.json', `${BOM}${JSON.stringify({ name: 'x', dependencies: { lodash: '^4.17.21' } })}`);
    expect(manifest.name).toBe('x');
    expect(manifest.deps.map((dep) => dep.name)).toEqual(['lodash']);
  });

  test('an npm lockfile', () => {
    const lock = parseNpmLockfile(
      'package-lock.json',
      `${BOM}${JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.21' } } })}`
    );
    expect([...lock.entries.keys()]).toEqual(['lodash']);
  });

  test('a pnpm lockfile', () => {
    const lock = parsePnpmLockfile(
      'pnpm-lock.yaml',
      `${BOM}lockfileVersion: '9.0'\npackages:\n  lodash@4.17.21:\n    resolution: {integrity: sha512-x}\n`
    );
    expect([...lock.entries.keys()]).toEqual(['lodash']);
  });

  test('a pnpm workspace file', () => {
    expect(parseOnlyBuilt(`${BOM}onlyBuiltDependencies:\n  - esbuild\n`, [])).toEqual(['esbuild']);
  });

  test('the config file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'depguard-bom-'));
    writeFileSync(path.join(dir, '.dep-guard.json'), `${BOM}${JSON.stringify({ failOn: 'high' })}`);
    expect(loadConfig(dir).failOn).toBe('high');
  });

  test('the baseline file', () => {
    const fingerprint = 'a'.repeat(64);
    expect([...parseBaseline(`${BOM}${JSON.stringify({ version: 1, fingerprints: [fingerprint] })}`, 'baseline')]).toEqual([
      fingerprint,
    ]);
  });

  // npm's ini parser (ini 5.0.0, shipped with npm 10.9.8) honours a first
  // line that follows a byte order mark: ini.parse returns the key
  // "registry" for the registry line below, and "@corp:registry" for the
  // pin. So this tool honours that line too.
  test('a project .npmrc, whose first line after the mark is honoured as npm honours it', () => {
    expect(parseNpmrcDefaultRegistry(`${BOM}registry=https://npm.corp.example/\n`)).toBe(
      'https://npm.corp.example/'
    );
    expect([...parseNpmrcPins(`${BOM}@corp:registry=https://npm.corp.example/\n`)]).toEqual([
      ['@corp', 'https://npm.corp.example/'],
    ]);
  });
});
