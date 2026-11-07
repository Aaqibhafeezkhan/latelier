import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve(__dirname, '..', '..', 'src');
const INDEX_CSS = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');

function token(name: string): string {
  const m = INDEX_CSS.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  if (!m) throw new Error(`token ${name} not found in index.css`);
  return m[1].trim();
}

describe('type and gap scales (src/index.css)', () => {
  it('type tokens are 11, 12, 13 and 16 px', () => {
    expect(['xs', 'sm', 'md', 'lg'].map((s) => token(`--atelier-fs-${s}`))).toEqual([
      '11px',
      '12px',
      '13px',
      '16px',
    ]);
  });

  it('gap tokens are 4, 8, 12, 16 and 24 px', () => {
    expect(['xs', 'sm', 'md', 'lg', 'xl'].map((s) => token(`--atelier-gap-${s}`))).toEqual([
      '4px',
      '8px',
      '12px',
      '16px',
      '24px',
    ]);
  });

  it('no type token is below the 11 px floor', () => {
    for (const s of ['xs', 'sm', 'md', 'lg']) {
      expect(Number.parseFloat(token(`--atelier-fs-${s}`))).toBeGreaterThanOrEqual(11);
    }
  });
});

// ESLint (no-restricted-syntax) covers TS/TSX; stylesheets are out of its reach, so a literal
// font-size in one is caught here. App.css is the unused Vite starter and is not imported.
describe('stylesheets use the type tokens', () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  const sheets = walk(SRC).filter((f) => f.endsWith('.css') && path.basename(f) !== 'App.css');

  it('finds the stylesheets it is meant to check', () => {
    expect(sheets.length).toBeGreaterThan(0);
  });

  for (const sheet of sheets) {
    it(`${path.relative(SRC, sheet)} has no literal font-size`, () => {
      const literal = fs
        .readFileSync(sheet, 'utf8')
        .split('\n')
        .filter((line) => /font-size:\s*[\d.]+(px|rem|em)\b/.test(line));
      expect(literal).toEqual([]);
    });
  }
});
