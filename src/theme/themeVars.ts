// Renderer design-token accessor, backed by the `--atelier-*` CSS custom
// properties defined in src/index.css. MantineProvider sets
// data-mantine-color-scheme on <html> (driven by useTheme()), which selects
// the light or dark block — so every value here resolves to the correct
// theme automatically, with no JS read of the color scheme.
//
// This replaces the legacy `useT()` hook + `tokens.ts` object. Because each
// field is a `var(--atelier-*)` string, it is usable anywhere a CSS value is
// expected (inline styles, SVG attributes, template literals). Import it as
// `T` at call sites: `const T = themeVars;`.
export interface ThemeVars {
  bg: string;
  surface: string;
  surfaceRaised: string;
  surfaceActive: string;
  border: string;
  borderMed: string;
  text: string;
  textMuted: string;
  textGhost: string;
  accent: string;
  accentText: string;
  /** Accent as text colour; `accent` itself is for fills, borders and outlines. */
  accentInk: string;
  accentSoft: string;
  accentBorder: string;
  greenDot: string;
  warn: string;
  red: string;
  greenSoft: string;
  greenText: string;
  greenBorder: string;
  warnSoft: string;
  warnText: string;
  warnBorder: string;
  redSoft: string;
  redText: string;
  redBorder: string;
  r: string;
  rs: string;
  rx: string;
  shadow: string;
  shadowLg: string;
  /** Type scale: 11, 12, 13 and 16 px. Nothing smaller. */
  fsXs: string;
  fsSm: string;
  fsMd: string;
  fsLg: string;
  /** Gap scale: 4, 8, 12, 16 and 24 px. */
  gapXs: string;
  gapSm: string;
  gapMd: string;
  gapLg: string;
  gapXl: string;
}

export const themeVars: ThemeVars = {
  bg: 'var(--atelier-bg)',
  surface: 'var(--atelier-surface)',
  surfaceRaised: 'var(--atelier-surface-raised)',
  surfaceActive: 'var(--atelier-surface-active)',
  border: 'var(--atelier-border)',
  borderMed: 'var(--atelier-border-med)',
  text: 'var(--atelier-text)',
  textMuted: 'var(--atelier-text-muted)',
  textGhost: 'var(--atelier-text-ghost)',
  accent: 'var(--atelier-accent)',
  accentText: 'var(--atelier-accent-text)',
  accentInk: 'var(--atelier-accent-ink)',
  accentSoft: 'var(--atelier-accent-soft)',
  accentBorder: 'var(--atelier-accent-border)',
  greenDot: 'var(--atelier-green-dot)',
  warn: 'var(--atelier-warn)',
  red: 'var(--atelier-red)',
  greenSoft: 'var(--atelier-green-soft)',
  greenText: 'var(--atelier-green-text)',
  greenBorder: 'var(--atelier-green-border)',
  warnSoft: 'var(--atelier-warn-soft)',
  warnText: 'var(--atelier-warn-text)',
  warnBorder: 'var(--atelier-warn-border)',
  redSoft: 'var(--atelier-red-soft)',
  redText: 'var(--atelier-red-text)',
  redBorder: 'var(--atelier-red-border)',
  r: 'var(--atelier-radius)',
  rs: 'var(--atelier-radius-sm)',
  rx: 'var(--atelier-radius-xs)',
  shadow: 'var(--atelier-shadow)',
  shadowLg: 'var(--atelier-shadow-lg)',
  fsXs: 'var(--atelier-fs-xs)',
  fsSm: 'var(--atelier-fs-sm)',
  fsMd: 'var(--atelier-fs-md)',
  fsLg: 'var(--atelier-fs-lg)',
  gapXs: 'var(--atelier-gap-xs)',
  gapSm: 'var(--atelier-gap-sm)',
  gapMd: 'var(--atelier-gap-md)',
  gapLg: 'var(--atelier-gap-lg)',
  gapXl: 'var(--atelier-gap-xl)',
};
