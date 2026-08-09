/**
 * ts-jest running in ESM mode, scoped to each package's own tests
 * directory. No suites exist yet at scaffold time, so `--passWithNoTests`
 * is expected until the first real test lands.
 *
 * testMatch (not roots) is used to find test files: `roots` requires the
 * listed directories to already exist on disk, and empty tests/ folders
 * aren't tracked by git, so a fresh clone would fail Jest's directory
 * check before --passWithNoTests ever gets a chance to apply.
 *
 * Tests type-check against tsconfig.test.json rather than the build
 * config directly. tsconfig.base.json targets "NodeNext" for real Node
 * module resolution in the published output, but that hybrid module kind
 * forces ts-jest into transpile-only mode -- tsconfig.test.json swaps in
 * a plain ES2022 module target instead, since Jest never runs through
 * Node's own module resolution anyway, and that keeps import.meta usable
 * while inheriting strict mode from the shared base config.
 *
 * One gap worth knowing about: ts-jest 29.x never surfaces type
 * diagnostics as failures on this ESM transform path (confirmed by
 * reading its compiler source -- diagnostics are computed but only
 * thrown when not in ESM mode), so `pnpm test` alone won't catch a
 * strict-mode violation in a test file. `pnpm typecheck` is what
 * actually enforces that, via `tsc --noEmit -p tsconfig.test.json`
 * covering the same files with real type-checking.
 */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "<rootDir>/tsconfig.test.json",
      },
    ],
  },
  testMatch: ["<rootDir>/packages/*/tests/**/*.test.ts"],
};
