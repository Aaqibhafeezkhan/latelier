import type { DisplayType } from '../../utils/displayValue';

// Four families plus a neutral, all CSS variables so both color schemes resolve without
// JS: ids and dates take their own tokens (index.css `--atelier-type-*`, each held to 4.5:1
// by tests/unit/theme-contrast.spec.ts), the numeric types share the `number` badge, and the
// container-like types (array, object, regex, binary) stay neutral. Fixed hex values used to
// live here and went dark-on-dark in the dark scheme.
// Moved out of component `.tsx` files so `eslint-plugin-react-refresh`
// (`only-export-components`) permits exporting the object constants (#307).
const tinted = (token: string) => ({
  bg: `color-mix(in srgb, var(${token}) 14%, transparent)`,
  fg: `var(${token})`,
});
const NUMERIC = { bg: 'var(--atelier-accent-soft)', fg: 'var(--atelier-accent-ink)' };
const NEUTRAL = { bg: 'var(--atelier-surface-raised)', fg: 'var(--atelier-text-muted)' };

export const TYPE_HUES: Partial<Record<DisplayType, { bg: string; fg: string }>> = {
  objectid: tinted('--atelier-type-id'),
  date: tinted('--atelier-type-date'),
  long: NUMERIC,
  decimal: NUMERIC,
  regex: NEUTRAL,
  binary: NEUTRAL,
  array: NEUTRAL,
  object: NEUTRAL,
};

// Theme-derived badge colors (string, number, boolean, null), also CSS variables.
export const TYPE_THEMED: Partial<Record<DisplayType, { bg: string; fg: string }>> = {
  string: { bg: 'transparent', fg: 'var(--atelier-text-ghost)' },
  number: { bg: 'var(--atelier-accent-soft)', fg: 'var(--atelier-accent-ink)' },
  boolean: { bg: 'var(--atelier-green-soft)', fg: 'var(--atelier-green-text)' },
  null: { bg: 'var(--atelier-surface-raised)', fg: 'var(--atelier-text-ghost)' },
  undefined: { bg: 'var(--atelier-surface-raised)', fg: 'var(--atelier-text-ghost)' },
};
