import { describe, it, expect } from 'vitest';
import { DEFAULT_THEME, mergeMantineTheme } from '@mantine/core';
import { cssVariablesResolver, filledFills, mantineTheme } from '../../src/theme/mantineTheme';
import { contrastRatio, parseColor } from '../../src/theme/contrast';

// Goes through the resolver Mantine actually calls, so a change to how the
// theme builds filled buttons (not just to the table) is what gets measured.
const theme = mergeMantineTheme(DEFAULT_THEME, mantineTheme);
const WHITE = { r: 255, g: 255, b: 255 };

describe('filled control contrast: white text on rest and hover', () => {
  for (const color of Object.keys(filledFills)) {
    const resolved = theme.variantColorResolver({ color, theme, variant: 'filled' });
    for (const state of ['background', 'hover'] as const) {
      it(`${color} ${state} clears 4.5:1`, () => {
        expect(resolved.color).toBe('var(--mantine-color-white)');
        expect(contrastRatio(parseColor(resolved[state]), WHITE)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('uses the approved danger and primary fills', () => {
    expect(theme.variantColorResolver({ color: 'red', theme, variant: 'filled' }).background).toBe('#c92a2a');
    expect(theme.variantColorResolver({ color: 'violet', theme, variant: 'filled' }).background).toBe('#6857de');
  });

  it('gives a control with no color or variant the same fill, through the primary-filled variable', () => {
    const { variables } = cssVariablesResolver(theme);
    expect(variables['--mantine-primary-color-filled']).toBe(filledFills.violet!.bg);
    expect(variables['--mantine-primary-color-filled-hover']).toBe(filledFills.violet!.hover);
  });

  it('leaves non-filled variants on the stock resolver', () => {
    const light = theme.variantColorResolver({ color: 'red', theme, variant: 'light' });
    expect(light.color).toBe('var(--mantine-color-red-light-color)');
    expect(light.background).toBe('var(--mantine-color-red-light)');
  });
});
