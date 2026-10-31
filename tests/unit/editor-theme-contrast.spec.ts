import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { blend, contrastRatio, parseColor } from '../../src/theme/contrast';

// The dark editor theme (src/components/scriptEditor/editorTheme.ts) paints
// syntax with `--atelier-syn-*` tokens on `--atelier-surface`. Parse the live
// stylesheet so a palette edit that drops below WCAG AA fails here.
const css = readFileSync(resolve(__dirname, '../../src/index.css'), 'utf8');
const darkBlock = css.slice(css.indexOf('[data-mantine-color-scheme="dark"]'));
const darkBody = darkBlock.slice(0, darkBlock.indexOf('}'));

function darkToken(name: string): string {
  const m = darkBody.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`dark block has no ${name}`);
  return m[1].trim();
}

const surface = parseColor(darkToken('--atelier-surface'));
const ratio = (token: string) =>
  contrastRatio(blend(parseColor(darkToken(token)), surface), surface);

describe('dark editor syntax palette', () => {
  it.each([
    '--atelier-syn-keyword',
    '--atelier-syn-string',
    '--atelier-syn-property',
    '--atelier-syn-punct',
    '--atelier-color-number',
    '--atelier-text',
  ])('%s reaches 4.5:1 on the dark surface', (token) => {
    expect(ratio(token)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    '--atelier-text',
    '--atelier-syn-keyword',
    '--atelier-syn-string',
    '--atelier-syn-property',
    '--atelier-syn-comment',
    '--atelier-syn-punct',
    '--atelier-color-number',
  ])('selected %s text reaches 3:1 on the selection background', (token) => {
    const selection = parseColor(darkToken('--atelier-editor-selection'));
    expect(selection.a).toBe(1);
    const sel = blend(selection, surface);
    expect(contrastRatio(blend(parseColor(darkToken(token)), sel), sel)).toBeGreaterThanOrEqual(3);
  });

  it('the selection background stands out from the surface', () => {
    const sel = blend(parseColor(darkToken('--atelier-editor-selection')), surface);
    expect(contrastRatio(sel, surface)).toBeGreaterThanOrEqual(1.5);
  });

  it('the editor theme paints the native selection with that token', () => {
    const theme = readFileSync(
      resolve(__dirname, '../../src/components/scriptEditor/editorTheme.ts'),
      'utf8',
    );
    expect(theme).toMatch(/'\.cm-content ::selection[^']*':\s*\{\s*backgroundColor: 'var\(--atelier-editor-selection\)'/);
  });

  it('comments reach 3:1 on the dark surface', () => {
    expect(ratio('--atelier-syn-comment')).toBeGreaterThanOrEqual(3);
  });

  it('every --atelier-syn-* token in the dark block is covered above', () => {
    const names = [...darkBody.matchAll(/(--atelier-syn-[a-z]+):/g)].map((m) => m[1]);
    expect(names.sort((a, b) => a.localeCompare(b))).toEqual([
      '--atelier-syn-comment',
      '--atelier-syn-keyword',
      '--atelier-syn-property',
      '--atelier-syn-punct',
      '--atelier-syn-string',
    ]);
  });
});
