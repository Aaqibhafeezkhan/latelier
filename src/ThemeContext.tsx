import React from 'react';
import { api, getErrorMessage } from './api/atelier';
import { notify } from './theme/notifications';

export type ThemeMode = 'light' | 'dark' | 'system';

// Boolean dark-mode flag for the rare component that needs the resolved scheme
// in JS (e.g. CodeMirror theme selection). Design tokens themselves come from
// CSS variables via src/theme/themeVars.ts — there is no JS theme object.
export const DarkCtx = React.createContext<boolean>(false);
export const useIsDark = () => React.useContext(DarkCtx);

const LEGACY_LS_KEY = 'ml-theme';

function prefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolveDark(mode: ThemeMode): boolean {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return prefersDark();
}

/**
 * Theme controller backed by main-process app_state via api.prefs. Returns the
 * resolved dark flag (drives MantineProvider's color scheme) and a toggle.
 * Migrates the old localStorage value once on first run after upgrade.
 */
export function useTheme(): [boolean, () => void] {
  const [mode, setMode] = React.useState<ThemeMode>(() => {
    const legacy = typeof localStorage !== 'undefined' ? localStorage.getItem(LEGACY_LS_KEY) : null;
    if (legacy === 'dark') return 'dark';
    if (legacy === 'light') return 'light';
    return 'system';
  });
  const [systemDark, setSystemDark] = React.useState<boolean>(() => prefersDark());

  // One-time migration from localStorage → app_state, then load the canonical mode.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const legacy = typeof localStorage !== 'undefined' ? localStorage.getItem(LEGACY_LS_KEY) : null;
      if (legacy === 'dark' || legacy === 'light') {
        try {
          await api.prefs.setTheme(legacy);
        } catch (err) {
          // Non-fatal: the legacy value is dropped below either way and the
          // canonical mode is read next.
          console.warn('[theme] legacy theme migration failed', err);
        }
        try {
          localStorage.removeItem(LEGACY_LS_KEY);
        } catch (err) {
          console.warn('[theme] could not clear the legacy theme key', err);
        }
      }
      try {
        const stored = await api.prefs.getTheme();
        if (!cancelled) setMode(stored);
      } catch (err) {
        // Keep the current mode rather than flashing to a default.
        console.warn('[theme] could not load the stored theme', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to main-process theme broadcasts (user-set or OS flip in 'system' mode).
  React.useEffect(() => {
    const off = api.prefs.onThemeChanged((next) => setMode(next));
    return off;
  }, []);

  // Track OS appearance changes — only matters while mode is 'system'.
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setSystemDark(mql.matches);
    mql.addEventListener?.('change', handler);
    return () => mql.removeEventListener?.('change', handler);
  }, []);

  const dark = mode === 'dark' || (mode === 'system' && systemDark);

  // The latest mode, readable by `toggle` without re-creating it. Kept out of
  // a `setMode` updater on purpose: StrictMode runs updaters twice, and a
  // write inside one went out twice per click.
  const modeRef = React.useRef(mode);
  React.useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const toggle = React.useCallback(() => {
    const next: ThemeMode = resolveDark(modeRef.current) ? 'light' : 'dark';
    // Two toggles in one tick must flip twice, before a re-render catches up.
    modeRef.current = next;
    setMode(next);
    void api.prefs.setTheme(next).catch(() => {
      // The switch already took effect for this session; say it will not
      // survive a relaunch instead of letting it silently revert.
      notify.error('Could not save the theme', { id: 'theme-save-failed' });
    });
  }, []);

  return [dark, toggle];
}

/**
 * The stored mode itself (Light / Dark / System), for the Settings control.
 * `useTheme()` only exposes the resolved flag; main broadcasts every set, so
 * its instances follow a change made here.
 */
export function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setMode] = React.useState<ThemeMode>('system');

  React.useEffect(() => {
    let cancelled = false;
    api.prefs
      .getTheme()
      .then((stored) => {
        if (!cancelled) setMode(stored);
      })
      .catch((err) => {
        notify.error(getErrorMessage(err, 'Could not read the theme setting.'), {
          id: 'theme-read-failed',
        });
      });
    const off = api.prefs.onThemeChanged((next) => setMode(next));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const modeRef = React.useRef(mode);
  React.useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const set = React.useCallback((next: ThemeMode) => {
    const prev = modeRef.current;
    setMode(next);
    void api.prefs.setTheme(next).catch(() => {
      setMode(prev);
      notify.error('Could not save the theme', { id: 'theme-save-failed' });
    });
  }, []);

  return [mode, set];
}

export const EDITOR_FONT_SIZE_PREF_KEY = 'ui.editor.fontSize';
export const EDITOR_FONT_SIZE_MIN = 10;
export const EDITOR_FONT_SIZE_MAX = 20;

/** Points every CodeMirror editor at `px` through a CSS variable, no context plumbing. */
export function applyEditorFontSize(px: number): void {
  document.documentElement.style.setProperty('--atelier-editor-font-size', `${px}px`);
}

/** True for a stored font size the editors may use; anything else is treated as never set. */
export function isEditorFontSize(v: unknown): v is number {
  return (
    typeof v === 'number' && Number.isInteger(v) && v >= EDITOR_FONT_SIZE_MIN && v <= EDITOR_FONT_SIZE_MAX
  );
}
