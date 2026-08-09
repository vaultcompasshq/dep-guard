import { isAllowed, isInternalName } from '../src/checks/allow.js';

// allow.ts is the shared matcher every check defers to for allow-list and
// internal-scope decisions. It has no dedicated caller test file elsewhere
// because it is exercised indirectly through the checks that use it, which
// leaves its own edge cases (empty names, malformed scope entries) thin.
// These tests hit isAllowed and isInternalName directly so a regression in
// the matching rules fails here instead of surfacing as a silent miss deep
// inside a check.

describe('isAllowed', () => {
  test('an empty package name is never allowed', () => {
    expect(isAllowed('', ['left-pad'])).toBe(false);
    expect(isAllowed('', [])).toBe(false);
  });

  test('an exact match is allowed', () => {
    expect(isAllowed('left-pad', ['left-pad'])).toBe(true);
  });

  test('a name outside every entry is not allowed', () => {
    expect(isAllowed('right-pad', ['left-pad'])).toBe(false);
  });

  test('a scope entry covers a package inside that scope', () => {
    expect(isAllowed('@acme/widgets', ['@acme/*'])).toBe(true);
  });

  test('a scope entry does not cover a different scope with a shared prefix', () => {
    expect(isAllowed('@acme-corp/widgets', ['@acme/*'])).toBe(false);
  });

  test('a scope entry does not match the bare scope name itself', () => {
    expect(isAllowed('@acme/', ['@acme/*'])).toBe(false);
  });

  test('a non-scope entry that starts with @ but lacks the /* suffix is skipped', () => {
    expect(isAllowed('@acme/widgets', ['@acme/widgets-typo'])).toBe(false);
  });

  test('a plain entry that does not start with @ is never treated as a scope', () => {
    expect(isAllowed('left-pad', ['left*'])).toBe(false);
  });
});

describe('isInternalName', () => {
  test('an empty package name is never internal', () => {
    expect(isInternalName('', ['@acme'], ['acme-'])).toBe(false);
    expect(isInternalName('', [], [])).toBe(false);
  });

  test('a scope written without a trailing slash covers packages in that scope', () => {
    expect(isInternalName('@acme/widgets', ['@acme'], [])).toBe(true);
  });

  test('a scope written with a trailing /* is tolerated', () => {
    expect(isInternalName('@acme/widgets', ['@acme/*'], [])).toBe(true);
  });

  test('a scope written with a trailing slash only is tolerated', () => {
    expect(isInternalName('@acme/widgets', ['@acme/'], [])).toBe(true);
  });

  test('a scope entry that is only the /* suffix is empty after stripping and matches nothing', () => {
    expect(isInternalName('@acme/widgets', ['/*'], [])).toBe(false);
  });

  test('a scope entry that is only a slash is empty after stripping and matches nothing', () => {
    expect(isInternalName('@acme/widgets', ['/'], [])).toBe(false);
  });

  test('a scope entry does not match the bare scope name itself', () => {
    expect(isInternalName('@acme', ['@acme'], [])).toBe(false);
  });

  test('a prefix entry covers a package that starts with it', () => {
    expect(isInternalName('acme-widgets', [], ['acme-'])).toBe(true);
  });

  test('a prefix entry does not match the bare prefix itself', () => {
    expect(isInternalName('acme-', [], ['acme-'])).toBe(false);
  });

  test('an empty prefix entry never matches, even against a non-empty name', () => {
    expect(isInternalName('anything', [], [''])).toBe(false);
  });

  test('a name outside every scope and prefix is not internal', () => {
    expect(isInternalName('left-pad', ['@acme'], ['acme-'])).toBe(false);
  });
});
