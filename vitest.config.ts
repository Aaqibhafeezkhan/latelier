import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'shared'),
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    // jsdom is noisy at the 300ms default; flag only genuinely slow tests.
    slowTestThreshold: 1_000,
    // Off unless asked for (`npm test -- --coverage`); CI sends the lcov
    // reports to SonarCloud. `include` lists the app's own code so a file no
    // test loads reports as uncovered rather than not at all.
    coverage: {
      provider: 'v8',
      reporter: ['lcovonly'],
      include: ['{electron,src,shared}/**/*.{ts,tsx}'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.spec.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.spec.ts'],
          globalSetup: ['tests/helpers/mongoGlobalSetup.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'component',
          environment: 'jsdom',
          include: ['tests/component/**/*.spec.{ts,tsx}'],
          setupFiles: ['tests/helpers/jsdomSetup.ts'],
          // jsdom role queries over a large tree run ~8x slower on the CI
          // runner under --coverage than locally; the 5s default flaked (#550).
          // Only coverage runs get the headroom, so a slow test still fails
          // (or shows up via slowTestThreshold) in a plain run. `npm test`
          // forwards `--coverage` into each child vitest's argv.
          testTimeout: process.argv.includes('--coverage') ? 20_000 : 5_000,
          // The setup file runs in a forked worker, whose argv is the worker
          // script, not this command line, so it cannot look for `--coverage`
          // itself. Hand it the answer from here.
          env: { ATELIER_COVERAGE_RUN: process.argv.includes('--coverage') ? '1' : '0' },
        },
      },
    ],
  },
});
