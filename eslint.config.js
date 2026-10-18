import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

const RENDERER_FORBIDDEN_PATTERNS = [
  { group: ['electron', 'electron/*'], message: 'Renderer must not import from electron; use window.atelier.' },
  { group: ['mongodb', 'mongodb/*'], message: 'Renderer must not import mongodb; go through IPC.' },
  { group: ['better-sqlite3'], message: 'Renderer must not import better-sqlite3; go through IPC.' },
  { group: ['ssh2', 'ssh2/*'], message: 'Renderer must not import ssh2.' },
  { group: ['fs', 'node:fs', 'fs/*', 'node:fs/*'], message: 'Renderer must not import fs.' },
  { group: ['path', 'node:path'], message: 'Renderer must not import path.' },
  { group: ['os', 'node:os'], message: 'Renderer must not import os.' },
  { group: ['child_process', 'node:child_process'], message: 'Renderer must not import child_process.' },
  { group: ['../electron/*', '../../electron/*'], message: 'Renderer must not reach into electron/.' },
]

export default defineConfig([
  // `.claude/worktrees` holds full checkouts made by agent worktree runs, each
  // carrying its own `.claude/workflows/` that the root-only ignore above does
  // not match. Git-excluded, so this is a local-only false red.
  // `.stryker-tmp` is Stryker's sandbox — a full repo copy per mutation run,
  // same class of false red as `.claude/worktrees` above: a nested
  // tsconfig.json makes typescript-eslint unable to pick one tsconfigRootDir.
  globalIgnores(['dist', 'dist-electron', 'node_modules', '.claude/workflows', '.claude/worktrees', '.remember', '.docket', '.stryker-tmp', 'reports', 'coverage']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        // Type information for the promise rules below. These configs sit in
        // no tsconfig project, so the default project lints them.
        projectService: {
          allowDefaultProject: [
            'vitest.config.ts',
            'vitest.stryker.config.ts',
            'playwright.config.ts',
            '.claude/skills/crash-fuzz/harness.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A floating rejection in main is fatal (unhandledRejection handler).
      '@typescript-eslint/no-floating-promises': 'error',
      // JSX attributes are off: a rejected renderer handler is not fatal and a
      // `void` wrapper would only silence it.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
  {
    // Enforce main-process-only modules cannot be imported from renderer.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: RENDERER_FORBIDDEN_PATTERNS }],
    },
  },
  {
    // filterTree.ts (W13) is a pure module — no React, no
    // CollectionTabState, no api — so it stays reusable as the aggregation
    // `$match` editor later without a rewrite (specs/W13-filter-tree-editor.md
    // §1). Flat config REPLACES a rule's options per matching file rather
    // than merging them, so this block re-declares the renderer-forbidden
    // patterns above alongside its own additions instead of losing them.
    files: ['src/pages/Workspace/filterTree.ts'],
    rules: {
      // The core rule can't distinguish type-only specifiers reliably; the
      // typescript-eslint variant can, which matters for blocking
      // `import type { CollectionTabState } from '@shared/types'`.
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            ...RENDERER_FORBIDDEN_PATTERNS,
            { group: ['react', 'react/*', 'react-dom', 'react-dom/*'], message: 'filterTree.ts is a pure module — no React.' },
            { group: ['**/api/atelier', '**/api/atelier*'], message: 'filterTree.ts is a pure module — no api.' },
          ],
          paths: [
            {
              name: '@shared/types',
              importNames: ['CollectionTabState'],
              message: 'filterTree.ts is a pure module — no CollectionTabState.',
            },
          ],
        },
      ],
    },
  },
])
