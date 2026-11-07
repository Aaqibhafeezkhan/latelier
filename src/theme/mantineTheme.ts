import {
  Badge,
  Button,
  CloseButton,
  createTheme,
  type CSSVariablesResolver,
  defaultVariantColorsResolver,
  Input,
  InputWrapper,
  SegmentedControl,
  Tooltip,
  type VariantColorsResolver,
  type CloseButtonProps,
  type MantineColorsTuple,
  type MantineThemeOverride,
} from '@mantine/core';

// Brand violet derived from the X08 atelier-violet (#7c6af7) and the
// existing tokens.ts accent so Mantine's primary CSS variable stays
// aligned with themeVars.accent during the X12 coexistence period.
// 10-step tuple: 0 lightest -> 9 darkest. Index 4 is the seed.
const violet: MantineColorsTuple = [
  '#f1eefe',
  '#dcd6fb',
  '#b7abf7',
  '#8e7df3',
  '#7c6af7',
  '#6857de',
  '#5743c4',
  '#46339f',
  '#36277b',
  '#251a55',
];

// Mantine paints dark dialogs, menus, dropdowns, popovers and inputs from its
// `dark` palette, which is neutral grey. Mapped onto the app's blue-black
// surfaces (index.css `--atelier-*`) so they match the page behind them: 7 is
// the dialog and dropdown surface (= --atelier-surface), 6 the input and raised
// surface, 5 hover (= surface-active), 4 borders, 8 and 9 the page and below it.
// The light steps are text: 0 body (11.8:1 on 7), 2 descriptions, 3 placeholders
// (5.4:1 on the input surface), so none falls under 4.5:1.
const dark: MantineColorsTuple = [
  '#cdd5de',
  '#b9c2cc',
  '#a9b4c0',
  '#8b98a5',
  '#2e3842',
  '#232b34',
  '#1c2228',
  '#161a1e',
  '#0f1214',
  '#0a0d0f',
];

// White text on a filled control needs 4.5:1. `primaryShade` is one number for
// every colour and also drives outline borders and `c="red"` text, so moving it
// would shift variants that are fine today. Only the filled background and its
// hover are overridden, and identically in both schemes. Shades come from the
// palette except red's hover, which is darker than any Mantine red.
// Components that hand-roll a filled control (BuilderPane's mode switch) read
// the same values so they cannot drift from the buttons.
export const filledFills: Record<string, { bg: string; hover: string }> = {
  violet: { bg: violet[5], hover: violet[6] },
  red: { bg: '#c92a2a', hover: '#a61e1e' },
};

const variantColorResolver: VariantColorsResolver = (input) => {
  const base = defaultVariantColorsResolver(input);
  const fill = filledFills[input.color ?? ''];
  if (input.variant !== 'filled' || !fill) return base;
  return { ...base, background: fill.bg, hover: fill.hover };
};

// One density for every control: compact buttons 26 px, regular buttons and
// inputs 36 px, labels 13 px. Mantine has no 13 px step (it pairs 36 px with
// 14 px), so these go through the size vars rather than per call site. ActionIcon
// stays out: icon buttons are sized where they sit, and the pager keeps its 22 px.
const LABEL_FZ = 'var(--atelier-fs-md)';

// Mantine writes `--mantine-color-dimmed` itself (gray-6, 3.3:1 on white) from a
// `:root[data-mantine-color-scheme]` rule that outranks the alias in index.css, so
// every `c="dimmed"` in light mode missed 4.5:1. Resolved here, where Mantine builds
// the variable, so each use (descriptions, hints, counts) gets the muted token. Dark
// keeps Mantine's own value, dark[2], which already clears 4.5:1. Placeholders have the
// same problem in both schemes (gray-5 and dark-3), so they take the ghost token.
// A Button, ActionIcon or Badge with neither `color` nor `variant` never reaches
// variantColorResolver: its stylesheet falls back to the primary-filled variable, so that
// variable has to carry the same fill.
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {
    '--mantine-primary-color-filled': filledFills.violet!.bg,
    '--mantine-primary-color-filled-hover': filledFills.violet!.hover,
  },
  light: {
    '--mantine-color-dimmed': 'var(--atelier-text-muted)',
    '--mantine-color-placeholder': 'var(--atelier-text-ghost)',
  },
  dark: { '--mantine-color-placeholder': 'var(--atelier-text-ghost)' },
});

export const mantineTheme: MantineThemeOverride = createTheme({
  primaryColor: 'violet',
  respectReducedMotion: true,
  primaryShade: { light: 4, dark: 4 },
  colors: { violet, dark },
  variantColorResolver,
  defaultRadius: 'md',
  fontFamily: 'Inter, system-ui, sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  headings: { fontFamily: 'Inter, system-ui, sans-serif' },
  shadows: {
    sm: '0 1px 3px rgba(0,0,0,0.06),0 4px 12px rgba(0,0,0,0.04)',
    lg: '0 8px 32px rgba(0,0,0,0.10)',
  },
  components: {
    Button: Button.extend({
      vars: (_theme, { size }) => {
        if (size === 'compact-xs' || size === 'compact-sm') {
          return { root: { '--button-height': '26px', '--button-padding-x': '10px', '--button-fz': LABEL_FZ } };
        }
        if (size === 'xs') return { root: { '--button-height': '36px', '--button-fz': LABEL_FZ } };
        return { root: size === undefined || size === 'sm' ? { '--button-fz': LABEL_FZ } : {} };
      },
    }),
    Input: Input.extend({
      vars: (_theme, { size }) => {
        if (size === 'xs') return { wrapper: { '--input-height': '36px', '--input-fz': LABEL_FZ } };
        return { wrapper: size === undefined || size === 'sm' ? { '--input-fz': LABEL_FZ } : {} };
      },
    }),
    // The 11 px floor reaches Mantine's own named sizes: Badge xs and sm default to 9 and
    // 10 px, and an xs input's description and error to 10 px.
    Badge: Badge.extend({
      vars: (_theme, { size }) => ({
        root: size === 'xs' || size === 'sm' ? { '--badge-fz': 'var(--atelier-fs-xs)' } : {},
      }),
    }),
    InputWrapper: InputWrapper.extend({
      vars: (_theme, { size }) => {
        const floor = size === 'xs' ? 'var(--atelier-fs-xs)' : undefined;
        return {
          label: {},
          error: { '--input-error-size': floor },
          success: { '--input-success-size': floor },
          description: { '--input-description-size': floor },
        };
      },
    }),
    // Same outer height as a compact button, so a switch lines up beside one.
    SegmentedControl: SegmentedControl.extend({
      styles: { root: { padding: 2 } },
      vars: (_theme, { size }) => ({
        root: size === 'xs' ? { '--sc-padding': '1px 8px', '--sc-font-size': LABEL_FZ } : {},
      }),
    }),

    // Mantine's own default is `events: { hover: true, focus: false, touch:
    // false }` — a Tooltip on an icon-only button never shows for a
    // keyboard-only user tabbing onto it, only for a mouse hovering it. That
    // gap shipped in the connection-switcher redesign (caught in code
    // review): the popover's shortcut legend was cut down on the premise
    // that "the rest are taught by the row-action tooltips," which wasn't
    // true until this default changed. Set once, here, rather than per call
    // site — every Tooltip in the app (there were 39, none opting into
    // `focus: true` individually) gets the fix, and nobody has to remember
    // to ask for it on the next one.
    Tooltip: Tooltip.extend({
      defaultProps: {
        events: { hover: true, focus: true, touch: false },
      },
    }),

    // Mantine's `CloseButton` ships no default `aria-label`; its
    // `defaultProps` are `{ variant: 'subtle' }` and nothing more. Every
    // `Modal`/`Drawer` renders its ✕ through it, so any dialog that didn't pass
    // `closeButtonProps` had a close control a screen reader announced as bare
    // "button". Twelve of the fourteen were in that state.
    //
    // Set here for the same reason as `Tooltip` above: the per-call-site fix
    // works but has to be remembered on the next dialog, and X15 is the epic
    // that exists because a dozen dialogs each independently forgot the same
    // handful of details. A theme default cannot be forgotten.
    //
    // Call sites that pass their own `closeButtonProps` still win — `useProps`
    // merges theme defaults *under* explicit props — so a dialog wanting a more
    // specific name ("Close explain") just says so.
    CloseButton: CloseButton.extend({
      // The cast is about the type, not the behaviour. `CloseButtonProps`
      // extends `BoxProps`/`StylesApiProps` but not `ElementProps<'button'>`,
      // so `aria-label` is missing from it even though the component is
      // polymorphic over `button` and spreads the prop straight onto the
      // element. `close-button-label.spec.tsx` asserts the rendered result
      // rather than trusting either the cast or the docs.
      defaultProps: { 'aria-label': 'Close' } as Partial<CloseButtonProps>,
    }),
  },
});
