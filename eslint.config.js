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
    // Type scale: a font size in src/ comes from themeVars (fsXs..fsLg, 11/12/13/16px),
    // never a literal, and nothing is below 11px. The selectors match a number or a
    // "<n>px/em/rem" string only, so `fontSize: 'inherit'`, `var(...)` strings, the
    // editor-size preference and `fz="xs"` stay legal. Token definitions live in
    // index.css and themeVars.ts (strings starting `var(`), which these never match.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Property[key.name='fontSize'][value.type='Literal'][value.raw=/^['\"]?\\d/], Property[key.value='fontSize'][value.type='Literal'][value.raw=/^['\"]?\\d/]",
          message:
            'Literal font size. Use a themeVars token: fsXs (11), fsSm (12), fsMd (13) or fsLg (16). Nothing below 11px.',
        },
        {
          selector:
            "JSXAttribute[name.name=/^(fz|fontSize)$/][value.type='JSXExpressionContainer'][value.expression.type='Literal'][value.expression.raw=/^['\"]?\\d/], JSXAttribute[name.name=/^(fz|fontSize)$/][value.type='Literal'][value.raw=/^['\"]?\\d/]",
          message:
            'Literal font size on fz/fontSize. Use a themeVars token: fsXs (11), fsSm (12), fsMd (13) or fsLg (16). Nothing below 11px.',
        },
        {
          selector:
            "JSXOpeningElement[name.name='Text'] > JSXAttribute[name.name='size'][value.type='Literal'][value.raw=/^['\"]?\\d/]",
          message:
            'Literal px size on Text. Use fz with a themeVars token (fsXs, fsSm, fsMd or fsLg). Nothing below 11px.',
        },
        // Gap scale, the same way: a gap is a themeVars token (gapXs..gapXl, 4/8/12/16/24px),
        // never a literal. 0 stays legal, and so do Mantine's named sizes (`gap="xs"`).
        {
          selector:
            "Property[key.name=/^(gap|rowGap|columnGap)$/][value.type='Literal'][value.raw=/^['\"]?(?!0['\"]?$)\\d/]",
          message: 'Literal gap. Use a themeVars token: gapXs (4), gapSm (8), gapMd (12), gapLg (16) or gapXl (24).',
        },
        {
          selector:
            "JSXAttribute[name.name=/^(gap|rowGap|columnGap)$/][value.type='JSXExpressionContainer'][value.expression.type='Literal'][value.expression.raw=/^(?!0$)\\d/], JSXAttribute[name.name=/^(gap|rowGap|columnGap)$/][value.type='Literal'][value.raw=/^['\"]\\d/]",
          message: 'Literal gap. Use a themeVars token: gapXs (4), gapSm (8), gapMd (12), gapLg (16) or gapXl (24).',
        },
      ],
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
