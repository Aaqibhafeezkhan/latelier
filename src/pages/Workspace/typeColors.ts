import type { DisplayType } from '../../utils/displayValue';

// Soft, translucent badges that read as labels rather than blocks of color.
// Backgrounds are alpha-blended brand tones; foregrounds are the matching
// solid tone so the badge stays legible on both Paper and Deep surfaces.
// Theme-derived entries (string/number/boolean/null) use Mantine CSS vars so
// dark mode switches automatically without JS.
// Moved out of component `.tsx` files so `eslint-plugin-react-refresh`
// (`only-export-components`) permits exporting the object constants (#307).
export const TYPE_HUES: Partial<Record<DisplayType, { bg: string; fg: string }>> = {
  objectid: { bg: 'rgba(138,107,64,0.12)', fg: '#8A6B40' },
  date: { bg: 'rgba(26,80,104,0.10)', fg: '#1A5068' },
  long: { bg: 'rgba(107,58,138,0.10)', fg: '#6B3A8A' },
  decimal: { bg: 'rgba(107,58,138,0.10)', fg: '#6B3A8A' },
  regex: { bg: 'rgba(184,76,20,0.12)', fg: '#B84C14' },
  binary: { bg: 'rgba(80,80,80,0.10)', fg: '#666' },
  array: { bg: 'rgba(107,58,138,0.10)', fg: '#6B3A8A' },
  object: { bg: 'rgba(80,80,138,0.10)', fg: '#5050A8' },
};

// Theme-sensitive badge colors expressed purely as CSS variables so no JS
// re-read is needed when the color scheme flips. Defined in index.css under
// :root / [data-mantine-color-scheme="dark"].
export const TYPE_THEMED: Partial<Record<DisplayType, { bg: string; fg: string }>> = {
  string: { bg: 'transparent', fg: 'var(--atelier-text-ghost)' },
  number: { bg: 'var(--atelier-accent-soft)', fg: 'var(--atelier-accent-ink)' },
  boolean: { bg: 'var(--atelier-green-soft)', fg: 'var(--atelier-green-text)' },
  null: { bg: 'var(--atelier-surface-raised)', fg: 'var(--atelier-text-ghost)' },
  undefined: { bg: 'var(--atelier-surface-raised)', fg: 'var(--atelier-text-ghost)' },
};
