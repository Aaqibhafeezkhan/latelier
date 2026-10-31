import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mantineTheme } from '../../src/theme/mantineTheme';

// jsdom does not evaluate media queries, so the rule is checked as text.
const css = readFileSync(resolve(__dirname, '../../src/index.css'), 'utf8');

describe('prefers-reduced-motion', () => {
  it('index.css shortens every animation and transition, keeping the end events', () => {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('\n}\n', start));
    expect(rule).toContain('*, *::before, *::after');
    expect(rule).toContain('animation-duration: 0.01ms !important');
    expect(rule).toContain('animation-iteration-count: 1 !important');
    expect(rule).toContain('transition-duration: 0.01ms !important');
    expect(rule).toContain('scroll-behavior: auto !important');
  });

  it('Mantine components respect the setting', () => {
    expect(mantineTheme.respectReducedMotion).toBe(true);
  });
});
