import React from 'react';
import { api } from '../../api/atelier';
import { notify } from '../../theme/notifications';
import { logFailure } from '../../utils/rendererLog';
import { BUILDER_DEFAULT_PCT } from './panelSizes';

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

  const toggleSidebar = React.useCallback(() => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    persistPref('ui.workspace.sidebarCollapsed', next);
  }, [sidebarCollapsed]);

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

  const commitBuilderCollapsed = React.useCallback((next: boolean) => {
    setBuilderCollapsed(next);
    persistPref('ui.workspace.builderCollapsed', next);
  }, []);

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
    sidebarCollapsed,
    toggleSidebar,
    builderCollapsed,
    commitBuilderCollapsed,
  };
}
