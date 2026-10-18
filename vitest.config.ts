import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
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
          testTimeout: 20_000,
        },
      },
    ],
  },
});
