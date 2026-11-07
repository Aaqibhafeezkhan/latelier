import React from 'react';
import { useMediaQuery } from '@mantine/hooks';
import { api } from '../../api/atelier';
import { notify } from '../../theme/notifications';
import { logFailure } from '../../utils/rendererLog';
import { BUILDER_DEFAULT_PCT } from './panelSizes';
import { narrowOpenPanel, ONE_PANEL_BELOW_PX, toggleNarrowPanel, type SidePanel } from './sidePanels';

// One fixed id: a drag fires a write per release, and a failing store would
// otherwise stack a toast for each.
function persistPref(key: string, value: number | boolean): void {
  void api.prefs.set(key, value).catch(() => {
    notify.error('Could not save the layout', { id: 'pref-save-failed' });
  });
}

export function useWorkspacePanelPrefs(): {
  prefsReady: boolean;
  leftWidth: number;
  setLeftWidth: React.Dispatch<React.SetStateAction<number>>;
  commitLeftWidth: (v: number) => void;
  refDrawerWidth: number;
  setRefDrawerWidth: React.Dispatch<React.SetStateAction<number>>;
  commitRefDrawerWidth: (v: number) => void;
  innerHSplit: number;
  commitInnerHSplit: (v: number) => void;
  shellSplit: number;
  commitShellSplit: (v: number) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  builderCollapsed: boolean;
  commitBuilderCollapsed: (next: boolean) => void;
  /** Below the width that fits both side panels. Layout changes here are not the user's stored layout. */
  onePanelOnly: boolean;
} {
  const [leftWidth, setLeftWidth] = React.useState(206);
  // Pixels, not a percentage: a plain flex column resized via the bespoke ResizeHandle, not a react-resizable-panels Panel.
  const [refDrawerWidth, setRefDrawerWidth] = React.useState(380);
  const [innerHSplit, setInnerHSplit] = React.useState(BUILDER_DEFAULT_PCT);
  const [shellSplit, setShellSplit] = React.useState(25);
  // Panels render with default sizes immediately; the key flip on ready re-mounts with persisted sizes, avoiding a layout shift.
  const [prefsReady, setPrefsReady] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [builderCollapsed, setBuilderCollapsed] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [l, rdw, ihs, ss, collapsed, builderC] = await Promise.all([
          api.prefs.get<number>('ui.workspace.leftWidth'),
          api.prefs.get<number>('ui.workspace.refDrawerWidth'),
          api.prefs.get<number>('ui.workspace.innerHSplit'),
          api.prefs.get<number>('ui.workspace.shellSplit'),
          api.prefs.get<boolean>('ui.workspace.sidebarCollapsed'),
          api.prefs.get<boolean>('ui.workspace.builderCollapsed'),
        ]);
        if (!active) return;
        if (typeof l === 'number') setLeftWidth(l);
        if (typeof rdw === 'number') setRefDrawerWidth(rdw);
        if (typeof ihs === 'number') setInnerHSplit(ihs);
        if (typeof ss === 'number') setShellSplit(ss);
        if (typeof collapsed === 'boolean') setSidebarCollapsed(collapsed);
        if (typeof builderC === 'boolean') setBuilderCollapsed(builderC);
      } catch (err) {
        // Keep the default layout; the log keeps the cause.
        logFailure('reading the workspace layout preferences', err);
      } finally {
        if (active) setPrefsReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const onePanelOnly = useMediaQuery(`(max-width: ${ONE_PANEL_BELOW_PX - 0.02}px)`, false, {
    getInitialValueInEffect: false,
  });
  // Undefined until a toggle while narrow; forgotten once the window is wide
  // again, so the stored layout comes straight back.
  const [narrowChoice, setNarrowChoice] = React.useState<SidePanel | null | undefined>(undefined);
  if (!onePanelOnly && narrowChoice !== undefined) setNarrowChoice(undefined);
  const narrowOpen = narrowOpenPanel(narrowChoice, sidebarCollapsed, builderCollapsed);

  const toggleSidebar = React.useCallback(() => {
    if (onePanelOnly) {
      setNarrowChoice(toggleNarrowPanel(narrowOpen, 'navigator', narrowOpen === 'navigator'));
      return;
    }
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    persistPref('ui.workspace.sidebarCollapsed', next);
  }, [onePanelOnly, narrowOpen, sidebarCollapsed]);

  const commitLeftWidth = React.useCallback((v: number) => {
    persistPref('ui.workspace.leftWidth', v);
  }, []);

  const commitRefDrawerWidth = React.useCallback((v: number) => {
    persistPref('ui.workspace.refDrawerWidth', v);
  }, []);

  const commitShellSplit = React.useCallback((v: number) => {
    setShellSplit(v);
    persistPref('ui.workspace.shellSplit', v);
  }, []);

  const commitInnerHSplit = React.useCallback((v: number) => {
    setInnerHSplit(v);
    persistPref('ui.workspace.innerHSplit', v);
  }, []);

  const commitBuilderCollapsed = React.useCallback(
    (next: boolean) => {
      if (onePanelOnly) {
        setNarrowChoice(toggleNarrowPanel(narrowOpen, 'builder', next));
        return;
      }
      setBuilderCollapsed(next);
      persistPref('ui.workspace.builderCollapsed', next);
    },
    [onePanelOnly, narrowOpen],
  );

  return {
    prefsReady,
    leftWidth,
    setLeftWidth,
    commitLeftWidth,
    refDrawerWidth,
    setRefDrawerWidth,
    commitRefDrawerWidth,
    innerHSplit,
    commitInnerHSplit,
    shellSplit,
    commitShellSplit,
    sidebarCollapsed: onePanelOnly ? narrowOpen !== 'navigator' : sidebarCollapsed,
    toggleSidebar,
    builderCollapsed: onePanelOnly ? narrowOpen !== 'builder' : builderCollapsed,
    commitBuilderCollapsed,
    onePanelOnly,
  };
}
