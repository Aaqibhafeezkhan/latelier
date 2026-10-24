import {
  CloseButton,
  createTheme,
  Tooltip,
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

export const mantineTheme: MantineThemeOverride = createTheme({
  primaryColor: 'violet',
  respectReducedMotion: true,
  primaryShade: { light: 4, dark: 4 },
  colors: { violet },
  defaultRadius: 'md',
  fontFamily: 'Inter, system-ui, sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  headings: { fontFamily: 'Inter, system-ui, sans-serif' },
  shadows: {
    sm: '0 1px 3px rgba(0,0,0,0.06),0 4px 12px rgba(0,0,0,0.04)',
    lg: '0 8px 32px rgba(0,0,0,0.10)',
  },
  components: {
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
