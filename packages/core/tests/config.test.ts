import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { DepGuardError } from '../src/types.js';

function makeRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'depguard-config-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe('loadConfig', () => {
  test('absent config files yield the documented defaults', () => {
    const repoRoot = makeRepo();
    expect(loadConfig(repoRoot)).toEqual({
      failOn: 'medium',
      allow: [],
      internalScopes: [],
      internalPrefixes: [],
      extraAliases: {},
      ignorePaths: [],
      online: false,
    });
  });

  test('absent config files default online to false', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'depguard-config-'));
    expect(loadConfig(dir).online).toBe(false);
  });

  test('online can be turned on in .dep-guard.json', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'depguard-config-'));
    writeFileSync(path.join(dir, '.dep-guard.json'), JSON.stringify({ online: true }));
    expect(loadConfig(dir).online).toBe(true);
  });

  test('a non-boolean online value throws config-invalid', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'depguard-config-'));
    writeFileSync(path.join(dir, '.dep-guard.json'), JSON.stringify({ online: 'yes' }));
    expect(() => loadConfig(dir)).toThrow(/online.*must be a boolean/);
  });

  test('reads values from .dep-guard.json', () => {
    const repoRoot = makeRepo({
      '.dep-guard.json': JSON.stringify({
        failOn: 'high',
        allow: ['left-pad'],
        internalScopes: ['@acme'],
        internalPrefixes: ['acme-'],
        extraAliases: { foo: ['bar'] },
        ignorePaths: ['vendor/'],
      }),
    });
    expect(loadConfig(repoRoot)).toEqual({
      failOn: 'high',
      allow: ['left-pad'],
      internalScopes: ['@acme'],
      internalPrefixes: ['acme-'],
      extraAliases: { foo: ['bar'] },
      ignorePaths: ['vendor/'],
      online: false,
    });
  });

  test('an absent .dep-guard.json but present .dep-guard.local.json still resolves', () => {
    const repoRoot = makeRepo({
      '.dep-guard.local.json': JSON.stringify({ failOn: 'low' }),
    });
    expect(loadConfig(repoRoot).failOn).toBe('low');
  });

  // Shallow merge, local wins: a key present in both files takes the local
  // value; a key present only in the base file survives the overlay.
  test('the local config overlay wins over the base config for a shared key', () => {
    const repoRoot = makeRepo({
      '.dep-guard.json': JSON.stringify({ failOn: 'high', allow: ['left-pad'] }),
      '.dep-guard.local.json': JSON.stringify({ failOn: 'low' }),
    });
    const config = loadConfig(repoRoot);
    expect(config.failOn).toBe('low');
    expect(config.allow).toEqual(['left-pad']);
  });

  test('allow supports an exact name and a "@scope/*" pattern together', () => {
    const repoRoot = makeRepo({
      '.dep-guard.json': JSON.stringify({ allow: ['left-pad', '@acme/*'] }),
    });
    expect(loadConfig(repoRoot).allow).toEqual(['left-pad', '@acme/*']);
  });

  test('an unknown key in the base config throws config-invalid', () => {
    const repoRoot = makeRepo({
      '.dep-guard.json': JSON.stringify({ notARealKey: true }),
    });
    expect(() => loadConfig(repoRoot)).toThrow(DepGuardError);
    try {
      loadConfig(repoRoot);
      throw new Error('expected loadConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DepGuardError);
      expect((error as DepGuardError).code).toBe('config-invalid');
    }
  });

  test('an unknown key in the local overlay throws config-invalid', () => {
    const repoRoot = makeRepo({
      '.dep-guard.json': JSON.stringify({}),
      '.dep-guard.local.json': JSON.stringify({ notARealKey: true }),
    });
    expect(() => loadConfig(repoRoot)).toThrow(DepGuardError);
  });

  test('an invalid failOn value throws config-invalid', () => {
    const repoRoot = makeRepo({
      '.dep-guard.json': JSON.stringify({ failOn: 'catastrophic' }),
    });
    expect(() => loadConfig(repoRoot)).toThrow(DepGuardError);
    try {
      loadConfig(repoRoot);
    } catch (error) {
      expect((error as DepGuardError).code).toBe('config-invalid');
    }
  });

  test.each(['critical', 'high', 'medium', 'low', 'none'])('failOn "%s" is accepted', (failOn) => {
    const repoRoot = makeRepo({ '.dep-guard.json': JSON.stringify({ failOn }) });
    expect(loadConfig(repoRoot).failOn).toBe(failOn);
  });

  test('a non-array allow value throws config-invalid', () => {
    const repoRoot = makeRepo({
      '.dep-guard.json': JSON.stringify({ allow: 'left-pad' }),
    });
    expect(() => loadConfig(repoRoot)).toThrow(DepGuardError);
  });

  test('an allow array containing a non-string throws config-invalid', () => {
    const repoRoot = makeRepo({
      '.dep-guard.json': JSON.stringify({ allow: ['left-pad', 42] }),
    });
    expect(() => loadConfig(repoRoot)).toThrow(DepGuardError);
  });

  test('internalScopes must be a string array', () => {
    const repoRoot = makeRepo({
      '.dep-guard.json': JSON.stringify({ internalScopes: { '@acme': true } }),
    });
    expect(() => loadConfig(repoRoot)).toThrow(DepGuardError);
  });

  test('ignorePaths must be a string array', () => {
    const repoRoot = makeRepo({
      '.dep-guard.json': JSON.stringify({ ignorePaths: [1, 2] }),
    });
    expect(() => loadConfig(repoRoot)).toThrow(DepGuardError);
  });

  test('extraAliases must be an object', () => {
    const repoRoot = makeRepo({
      '.dep-guard.json': JSON.stringify({ extraAliases: ['not', 'an', 'object'] }),
    });
    expect(() => loadConfig(repoRoot)).toThrow(DepGuardError);
  });

  test('an extraAliases entry must be an array of strings', () => {
    const repoRoot = makeRepo({
      '.dep-guard.json': JSON.stringify({ extraAliases: { foo: 'bar' } }),
    });
    expect(() => loadConfig(repoRoot)).toThrow(DepGuardError);
  });

  test('a prototype-polluting extraAliases key is rejected', () => {
    // Written as a raw JSON string rather than JSON.stringify(objectLiteral):
    // `{ __proto__: [...] }` as a JS object literal sets the prototype
    // instead of creating an own "__proto__" property, which would not
    // exercise this path at all.
    const repoRoot = makeRepo({
      '.dep-guard.json': '{"extraAliases":{"__proto__":["bar"]}}',
    });
    expect(() => loadConfig(repoRoot)).toThrow(DepGuardError);
  });

  test('a constructor extraAliases key is rejected', () => {
    const repoRoot = makeRepo({
      '.dep-guard.json': JSON.stringify({ extraAliases: { constructor: ['bar'] } }),
    });
    expect(() => loadConfig(repoRoot)).toThrow(DepGuardError);
  });

  test('malformed JSON throws config-invalid rather than a raw parse error', () => {
    const repoRoot = makeRepo({ '.dep-guard.json': '{ not json' });
    expect(() => loadConfig(repoRoot)).toThrow(DepGuardError);
    try {
      loadConfig(repoRoot);
    } catch (error) {
      expect((error as DepGuardError).code).toBe('config-invalid');
    }
  });

  test('a JSON array instead of an object throws config-invalid', () => {
    const repoRoot = makeRepo({ '.dep-guard.json': '[1, 2, 3]' });
    expect(() => loadConfig(repoRoot)).toThrow(DepGuardError);
  });

  // If DEFAULT_CONFIG's array/object fields were reused by reference
  // across calls, mutating one caller's result would pollute every later
  // loadConfig() call that fell back to a default.
  test('default array and object fields are not shared by reference across calls', () => {
    const repoRootA = makeRepo();
    const repoRootB = makeRepo();
    const configA = loadConfig(repoRootA);
    configA.allow.push('should-not-leak');
    configA.internalScopes.push('@should-not-leak');
    configA.internalPrefixes.push('should-not-leak-');
    configA.ignorePaths.push('should-not-leak/');
    configA.extraAliases.leak = ['should-not-leak'];

    const configB = loadConfig(repoRootB);
    expect(configB.allow).toEqual([]);
    expect(configB.internalScopes).toEqual([]);
    expect(configB.internalPrefixes).toEqual([]);
    expect(configB.ignorePaths).toEqual([]);
    expect(configB.extraAliases).toEqual({});
  });

  // allow refuses a bare star on the stated grounds that a security gate
  // should not have a quiet off switch. Without the same refusal,
  // ignorePaths would accept one, and it would drop findings before the
  // gate ever saw their severity.
  describe('a whole-tree ignorePaths entry is refused', () => {
    // If the refusal named only two spellings, a pattern built only out
    // of wildcards and separators would walk straight around it: "**/**",
    // "**/*" and "*/**" all match every manifest path there is. Any
    // pattern with nothing in it but wildcards and separators is the same
    // off switch spelled differently.
    test.each(['*', '**', ' ** ', './**', '**/', '**/**', '**/*', '*/**', './**/*', '*/*'])(
      'refuses %p',
      (entry) => {
        const repoRoot = makeRepo({ '.dep-guard.json': JSON.stringify({ ignorePaths: [entry] }) });
        let caught: unknown;
        try {
          loadConfig(repoRoot);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(DepGuardError);
        expect((caught as DepGuardError).code).toBe('config-invalid');
        expect((caught as DepGuardError).message).toContain('ignorePaths');
      }
    );

    test('refuses it from the local overlay as well', () => {
      const repoRoot = makeRepo({
        '.dep-guard.local.json': JSON.stringify({ ignorePaths: ['**'] }),
      });
      expect(() => loadConfig(repoRoot)).toThrow(DepGuardError);
    });

    test('a scoped wildcard entry is still allowed', () => {
      const repoRoot = makeRepo({
        '.dep-guard.json': JSON.stringify({ ignorePaths: ['vendor/**', 'packages/*'] }),
      });
      expect(loadConfig(repoRoot).ignorePaths).toEqual(['vendor/**', 'packages/*']);
    });

    // A bare root manifest is a legitimate thing to ignore: a monorepo
    // whose root package.json holds only tooling, where the dependencies
    // that matter live in the workspace packages. It names one file and
    // hides nothing else, so it is not an off switch.
    test('a bare package.json is still allowed', () => {
      const repoRoot = makeRepo({
        '.dep-guard.json': JSON.stringify({ ignorePaths: ['package.json'] }),
      });
      expect(loadConfig(repoRoot).ignorePaths).toEqual(['package.json']);
    });
  });

  test('unrelated files in the repo root do not affect the result', () => {
    const repoRoot = makeRepo({ 'package.json': JSON.stringify({ name: 'x' }) });
    expect(loadConfig(repoRoot)).toEqual({
      failOn: 'medium',
      allow: [],
      internalScopes: [],
      internalPrefixes: [],
      extraAliases: {},
      ignorePaths: [],
      online: false,
    });
  });
});
