import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { DarkCtx, useTheme } from '../ThemeContext';
import { themeVars } from '../theme/themeVars';
import { I } from '../icons';
import { AppShell } from '@mantine/core';
import { useConnections } from '../state/connections';
import { api, isIpcError } from '../api/atelier';
import { notify } from '../theme/notifications';
import type { ConnectionSummary } from '@shared/types';
import { invalidateSampleSchemaCache } from '../features/fieldSuggestions/sources/sampleSchemaSource';
import { ConnectionDeleteDialog } from '../features/connections/ConnectionDeleteDialog';
import { ConnectionDisconnectDialog } from '../features/connections/ConnectionDisconnectDialog';
import { disconnectConnection } from '../features/connections/disconnectConnection';
import { DetailPanel } from './DetailPanel';
import { usePaletteApi } from '../commands/CommandPalette';
import { useRegisterCommands } from '../commands/useRegisterCommands';
import { TitleBarBackLink } from '../components/TitleBarBackLink';

// ─── Title bar ──────────────────────────────────────────────────────────────
//
// this screen is reached only via the Switcher's "Manage connection…"
// (deep-link only, ADR 0001), never landed on. The back affordance is the
// only way out short of the browser-style history back.

function TitleBar({ dark, toggle, onCmdK, connectionName }: {
  dark: boolean;
  toggle: () => void;
  onCmdK: () => void;
  connectionName: string | null;
}) {
  const T = themeVars;
  const navigate = useNavigate();
  return (
    <div style={{
      height: 46, display: 'flex', alignItems: 'center', gap: 12,
      padding: '0 16px', borderBottom: `1px solid ${T.border}`,
      background: T.surface, flexShrink: 0,
      WebkitAppRegion: 'drag',
    } as React.CSSProperties}>
      <div style={{ width: 70, flexShrink: 0 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <TitleBarBackLink label="Data View" onClick={() => navigate('/workspace')} />
        <span style={{ color: T.textGhost }}>/</span>
        {/* Sister fix to TabStrip's own: a Connection missing from
            the list is unresolved, not literally named "Connection". The
            parenthetical reads as a state so it can't be mistaken for a
            real Connection name. */}
        <span style={{ fontSize: 13, color: T.textMuted }}>{connectionName ?? '(unresolved connection)'}</span>
      </div>
      <div style={{ flex: 1 }} />
      <button onClick={onCmdK} data-hint-anchor="palette.discover" style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '4px 9px', border: `1px solid ${T.border}`, borderRadius: T.rs,
        background: T.surfaceRaised, color: T.textMuted, cursor: 'pointer',
        fontSize: 11, fontWeight: 500, WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}>
        <span style={{ display: 'flex', alignItems: 'center' }}>{I.cmd}</span>
        K
      </button>
      <button onClick={toggle} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, border: `1px solid ${T.border}`, borderRadius: T.rs,
        background: T.surfaceRaised, color: T.textMuted, cursor: 'pointer',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}>
        {dark ? I.sun : I.moon}
      </button>
    </div>
  );
}

// ─── Root component ────────────────────────────────────────────────────────
//
// the deep, bare detail screen (ADR 0001). No more list sidebar: the
// Switcher popover is the one canonical list of saved Connections now, and
// this route is reached only through its "Manage connection…" action.
// Selection comes strictly from `:id` — there is no "select the first
// Connection" fallback, because there is no longer a list to fall back
// through; an id that doesn't resolve is a not-found state, not an empty one.
export default function ConnectionManager() {
  const [dark, toggle] = useTheme();
  const T = themeVars;
  const { connections, loading, refresh, removeLocal } = useConnections();
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  // both dialogs snapshot `{ id, name, tabCount }` rather than the
  // full `ConnectionSummary`: this screen has no `useWorkspaceTabs()` (that
  // hook stays at its one call site in `Workspace.tsx`), so the tab count is
  // fetched via `api.tabs.list()` at open time and carried in the snapshot,
  // matching `Workspace.tsx`'s `deleteConnectionTarget`/`disconnectTarget`.
  const [deleteTarget, setDeleteTarget] = React.useState<
    { id: string; name: string; tabCount: number } | null
  >(null);
  const [disconnectTarget, setDisconnectTarget] = React.useState<
    { id: string; name: string; tabCount: number } | null
  >(null);
  const palette = usePaletteApi();

  // Shared by both dialogs' openers below (the header buttons and the
  // palette commands) — best-effort: a failed count still opens the dialog,
  // just naming zero rather than blocking the confirm on an IPC round trip.
  const fetchTabCount = React.useCallback(async (id: string) => {
    try {
      const allTabs = await api.tabs.list();
      return allTabs.filter((t) => t.connectionId === id).length;
    } catch {
      return 0;
    }
  }, []);

  const selected = connections.find((c) => c.id === params.id) ?? null;

  const selectedRef = React.useRef(selected);
  React.useEffect(() => { selectedRef.current = selected; }, [selected]);

  const openDeleteConfirm = React.useCallback(async (target: ConnectionSummary) => {
    const tabCount = await fetchTabCount(target.id);
    setDeleteTarget({ id: target.id, name: target.name, tabCount });
  }, [fetchTabCount]);

  // Spec §4.6 — opens the confirm dialog; `confirmDisconnect` below
  // does the actual disconnect + tab close.
  const openDisconnectConfirm = React.useCallback(async (target: ConnectionSummary) => {
    const tabCount = await fetchTabCount(target.id);
    setDisconnectTarget({ id: target.id, name: target.name, tabCount });
  }, [fetchTabCount]);

  useRegisterCommands(
    [
      {
        id: 'connection.delete',
        title: 'Delete selected connection',
        group: 'connection',
        keywords: ['remove', 'drop'],
        when: (ctx) => ctx.connectionId !== null && selectedRef.current !== null,
        perform: () => {
          if (selectedRef.current) void openDeleteConfirm(selectedRef.current);
        },
      },
      {
        id: 'connection.refresh',
        title: 'Refresh connection',
        group: 'connection',
        keywords: ['reload', 'sync'],
        when: (ctx) => ctx.pathname.startsWith('/connections'),
        perform: () => { void refresh(); },
      },
    ],
    [refresh, openDeleteConfirm],
  );

  const handleDelete = React.useCallback((id: string) => {
    const target = connections.find((c) => c.id === id);
    if (target) void openDeleteConfirm(target);
  }, [connections, openDeleteConfirm]);

  // the header's real Disconnect button (shown only while
  // `connected`); `DetailPanel`'s own "Cancel connection" stays wired
  // directly to the raw `disconnectConnection` helper, unconfirmed.
  const handleDisconnect = React.useCallback((id: string) => {
    const target = connections.find((c) => c.id === id);
    if (target) void openDisconnectConfirm(target);
  }, [connections, openDisconnectConfirm]);

  const closeDisconnectTarget = React.useCallback(() => setDisconnectTarget(null), []);

  // unlike `confirmDelete`, this screen must close the tabs itself:
  // deleting a Connection cascades in SQLite (`workspace_tabs.connection_id
  // REFERENCES connections(id) ON DELETE CASCADE`), but disconnecting does
  // not touch the row at all. Mirrors `closeForConnection`
  // (`src/state/workspaceTabs.ts`) minus its React-state bookkeeping — this
  // screen has no tab-strip to update, only SQLite rows to close.
  const confirmDisconnect = React.useCallback(async () => {
    if (!disconnectTarget) return;
    const id = disconnectTarget.id;
    setDisconnectTarget(null);
    void disconnectConnection(id);
    try {
      const allTabs = await api.tabs.list();
      const toClose = allTabs.filter((t) => t.connectionId === id);
      await Promise.all(toClose.map((t) => api.tabs.close(t.id).catch(() => { /* best-effort */ })));
    } catch (err) {
      notify.error(isIpcError(err) ? err.message : String(err), {
        title: 'Disconnected, but its tabs could not be closed',
      });
    }
  }, [disconnectTarget]);

  const confirmDelete = React.useCallback(async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    try {
      await api.conn.delete(id);
      removeLocal(id);
      // Drop any cached sample-schema entries scoped to this connection so
      // suggestions don't keep returning paths from a collection that no
      // longer exists in the renderer's worldview.
      invalidateSampleSchemaCache(id);
      setDeleteTarget(null);
      // No sibling row to fall back to — this screen only ever shows one
      // Connection, so a delete always sends the user back to the Data View.
      void navigate('/workspace', { replace: true });
    } catch (err) {
      setDeleteTarget(null);
      if (isIpcError(err) && err.code === 'NOT_FOUND') {
        // Out-of-band removal — the Connection is already gone.
        void navigate('/workspace', { replace: true });
      } else {
        notify.error(isIpcError(err) ? err.message : String(err), { title: 'Delete failed' });
      }
    }
  }, [deleteTarget, navigate, removeLocal]);

  // X12 phase 6 — header-only AppShell, matching Workspace's shell so both
  // routes share the same height + visual rhythm across navigation.
  return (
    <DarkCtx.Provider value={dark}>
      <AppShell
        mode="static"
        header={{ height: 46 }}
        padding={0}
        withBorder={false}
        style={{
          height: '100vh',
          background: T.bg,
          color: T.text,
          fontSize: 13,
        }}
      >
        <AppShell.Header withBorder={false} style={{ background: 'transparent' }}>
          <TitleBar dark={dark} toggle={toggle} onCmdK={palette.toggle} connectionName={selected?.name ?? null} />
        </AppShell.Header>
        <AppShell.Main
          style={{
            display: 'flex',
            overflow: 'hidden',
            minHeight: 0,
            minWidth: 0,
          }}
        >
          <DetailPanel
            key={selected?.id ?? 'none'}
            selected={selected}
            loading={loading}
            onDelete={handleDelete}
            onDisconnect={handleDisconnect}
          />
        </AppShell.Main>
        {deleteTarget && (
          <ConnectionDeleteDialog
            name={deleteTarget.name}
            tabCount={deleteTarget.tabCount}
            onCancel={() => setDeleteTarget(null)}
            onConfirm={confirmDelete}
          />
        )}
        {disconnectTarget && (
          <ConnectionDisconnectDialog
            name={disconnectTarget.name}
            tabCount={disconnectTarget.tabCount}
            onCancel={closeDisconnectTarget}
            onConfirm={() => void confirmDisconnect()}
          />
        )}
      </AppShell>
    </DarkCtx.Provider>
  );
}
