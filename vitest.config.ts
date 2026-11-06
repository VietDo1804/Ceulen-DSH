import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 15_000,
    restoreMocks: true,
    setupFiles: ['test/setup-flush-logs.ts'],
    // 'list' runs afterEach hooks in registration order, so the setup file's
    // log flush runs before each test file's own cleanup.
    sequence: { hooks: 'list' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      // Vendored upstream code is not ours to cover (see the vendored-code
      // policy in docs/improvement-plan.md).
      exclude: ['src/vendor/**'],
      // Floor = the 2026-11-04 baseline minus 2 points (plan 1.7):
      // lines 90.84, branches 73.51, functions 89.92.
      thresholds: { lines: 88.84, branches: 71.51, functions: 87.92, statements: 88.84 },
    },
  },
})
