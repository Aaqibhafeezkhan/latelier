import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Stryker reruns the suite once per mutant, so this deliberately excludes the
// integration project (mongodb-memory-server boot per test) and component
// project — mutation testing here is scoped to the unit-tested pure modules
// listed in stryker.config.json's `mutate`.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'shared'),
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.spec.ts'],
  },
});
