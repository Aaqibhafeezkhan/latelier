import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_THEME, mergeMantineTheme } from '@mantine/core';
import { cssVariablesResolver, mantineTheme } from '../../src/theme/mantineTheme';
import {
  parseColor,
  relativeLuminance,
  blend,
  contrastRatio,
  type RGB,
} from '../../src/theme/contrast';

// Parses the live src/index.css theme blocks — the source of truth — rather
// than duplicating token literals in the test, so a future token edit that
// regresses contrast is caught here without the test needing to change.
const INDEX_CSS = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'index.css'),
  'utf8',
);

/** Extracts the `{ ... }` body of the first rule whose selector contains `marker`. */
function extractBlock(css: string, marker: string): string {
  const markerIndex = css.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`extractBlock: marker "${marker}" not found in index.css`);
  }
  const openBrace = css.indexOf('{', markerIndex);
  const closeBrace = css.indexOf('}', openBrace);
  if (openBrace === -1 || closeBrace === -1) {
    throw new Error(`extractBlock: malformed rule near marker "${marker}"`);
  }
  return css.slice(openBrace + 1, closeBrace);
}

/** Reads a single `--custom-property: value;` declaration's raw value out of a CSS block. */
function readVar(block: string, name: string): string {
  const re = new RegExp(`${name}\\s*:\\s*([^;]+);`);
  const m = block.match(re);
  if (!m) {
    throw new Error(`readVar: "${name}" not found in block`);
  }
  return m[1].trim();
}

const lightBlock = extractBlock(INDEX_CSS, '[data-mantine-color-scheme="light"]');
const darkBlock = extractBlock(INDEX_CSS, '[data-mantine-color-scheme="dark"]');

const THEMES = {
  light: {
    block: lightBlock,
    surfaces: ['--atelier-bg', '--atelier-surface', '--atelier-surface-raised', '--atelier-surface-active'],
  },
  dark: {
    block: darkBlock,
    surfaces: ['--atelier-bg', '--atelier-surface', '--atelier-surface-raised', '--atelier-surface-active'],
  },
} as const;

const TOKENS = {
  muted: { varName: '--atelier-text-muted', minRatio: 4.5 },
  ghost: { varName: '--atelier-text-ghost', minRatio: 4.5 },
  'json number': { varName: '--atelier-color-number', minRatio: 4.5 },
  'json string': { varName: '--atelier-color-string', minRatio: 4.5 },
  'json boolean': { varName: '--atelier-color-boolean', minRatio: 4.5 },
} as const;

describe('theme token contrast (WCAG AA, worst-case surface)', () => {
  for (const [themeName, theme] of Object.entries(THEMES)) {
    for (const [tokenName, token] of Object.entries(TOKENS)) {
      const fgRaw = readVar(theme.block, token.varName);
      const fg = parseColor(fgRaw);

      for (const surfaceVar of theme.surfaces) {
        it(`${themeName} ${tokenName} (${token.varName}) over ${surfaceVar} clears ${token.minRatio}:1`, () => {
          const bgRaw = readVar(theme.block, surfaceVar);
          const bg = parseColor(bgRaw);
          const blended = blend(fg, bg);
          const ratio = contrastRatio(blended, bg);
          expect(ratio).toBeGreaterThanOrEqual(token.minRatio);
        });
      }
    }

    // Accent as text: `--atelier-accent-ink` over each surface, and over the selected-row
    // tint (`--atelier-accent-soft`) painted on each of them.
    const ink = parseColor(readVar(theme.block, '--atelier-accent-ink'));
    const soft = parseColor(readVar(theme.block, '--atelier-accent-soft'));
    for (const surfaceVar of theme.surfaces) {
      const surface = parseColor(readVar(theme.block, surfaceVar));
      it(`${themeName} accent ink over ${surfaceVar} clears 4.5:1`, () => {
        expect(contrastRatio(ink, surface)).toBeGreaterThanOrEqual(4.5);
      });
      it(`${themeName} accent ink over accent-soft on ${surfaceVar} clears 4.5:1`, () => {
        expect(contrastRatio(ink, blend(soft, surface))).toBeGreaterThanOrEqual(4.5);
      });
    }

    it(`${themeName}: muted alpha is higher than ghost alpha`, () => {
      const mutedAlpha = parseColor(readVar(theme.block, TOKENS.muted.varName)).a;
      const ghostAlpha = parseColor(readVar(theme.block, TOKENS.ghost.varName)).a;
      expect(mutedAlpha).toBeGreaterThan(ghostAlpha);
    });

    it(`${themeName}: --mantine-color-dimmed aliases --atelier-text-muted`, () => {
      expect(readVar(theme.block, '--mantine-color-dimmed')).toBe('var(--atelier-text-muted)');
    });
  }

  // Mantine's own rule outranks index.css, so these reach the page only through the resolver.
  it('routes Mantine dimmed and placeholder text to the tokens measured above', () => {
    const resolved = cssVariablesResolver(mergeMantineTheme(DEFAULT_THEME, mantineTheme));
    expect(resolved.light['--mantine-color-dimmed']).toBe('var(--atelier-text-muted)');
    expect(resolved.light['--mantine-color-placeholder']).toBe('var(--atelier-text-ghost)');
    expect(resolved.dark['--mantine-color-placeholder']).toBe('var(--atelier-text-ghost)');
  });
});

describe('contrast.ts helpers', () => {
  it('parseColor handles #rrggbb', () => {
    expect(parseColor('#1a1a2e')).toEqual({ r: 26, g: 26, b: 46, a: 1 });
  });

  it('parseColor expands shorthand #rgb', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#0a3')).toEqual({ r: 0, g: 170, b: 51, a: 1 });
  });

  it('parseColor handles rgba()', () => {
    expect(parseColor('rgba(26,26,46,0.5)')).toEqual({ r: 26, g: 26, b: 46, a: 0.5 });
  });

  it('relativeLuminance of white is 1, black is 0', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
  });

  it('contrastRatio of black on white is 21:1', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 1);
  });
});

// X19 #83 — the #60 active-row outline is `2px solid var(--atelier-accent)`.
// It has to clear WCAG 1.4.11 (non-text contrast, >= 3:1) against every
// *plain* background a row can show behind that outline band — the copy-flash
// itself is handled separately (`backgroundClip: 'content-box'` on
// TableCell/FieldNode keeps the flash off that band; see
// `x19-copy-flash-outline.e2e.ts`), so what's left underneath is always one
// of these. Read from the row-background rules in TableView.tsx/
// TreeView.tsx/DocFieldTree.tsx: zebra rows are `--atelier-surface` /
// `--atelier-surface-raised`, and a selected row is the translucent
// `--atelier-accent-soft` painted over `--atelier-surface`.
describe('active-row outline contrast against every plain row surface (WCAG 1.4.11, X19 #83)', () => {
  for (const [themeName, theme] of Object.entries(THEMES)) {
    const accent = parseColor(readVar(theme.block, '--atelier-accent'));
    const surface = parseColor(readVar(theme.block, '--atelier-surface'));
    const surfaceRaised = parseColor(readVar(theme.block, '--atelier-surface-raised'));
    const accentSoft = parseColor(readVar(theme.block, '--atelier-accent-soft'));

    const rowBackgrounds: Record<string, RGB> = {
      '--atelier-surface': surface,
      '--atelier-surface-raised': surfaceRaised,
      '--atelier-accent-soft over --atelier-surface (selected row)': blend(accentSoft, surface),
    };

    for (const [bgName, bg] of Object.entries(rowBackgrounds)) {
      it(`${themeName}: --atelier-accent (outline) over ${bgName} clears 3:1`, () => {
        expect(contrastRatio(accent, bg)).toBeGreaterThanOrEqual(3);
      });
    }
  }
});
