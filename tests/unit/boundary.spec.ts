import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';

/**
 * Proves the renderer boundary rule actually works.
 *
 * Writes a scratch file at src/__boundary-probe__.ts that imports a forbidden
 * module, runs ESLint programmatically, asserts the expected rule fires,
 * then cleans up.
 */
describe('renderer boundary', () => {
  it('forbids renderer files from importing main-only modules', async () => {
    const probePath = path.resolve(__dirname, '../..', 'src/__boundary-probe__.ts');
    fs.writeFileSync(
      probePath,
      `import Database from 'better-sqlite3';
void Database;
`,
    );

    const eslint = new ESLint({
      overrideConfigFile: path.resolve(__dirname, '../..', 'eslint.config.js'),
    });

    try {
      const results = await eslint.lintFiles([probePath]);
      const messages = results.flatMap((r) => r.messages);
      const forbidden = messages.find((m) => m.ruleId === 'no-restricted-imports');
      expect(forbidden, 'expected no-restricted-imports to fire').toBeDefined();
    } finally {
      fs.rmSync(probePath, { force: true });
    }
    // The config is type-aware, so linting even one file builds a TypeScript
    // program for the whole renderer: ~2s locally, ~12s on the CI runner under
    // coverage, past the unit project's 5s default.
  }, 30_000);
});
