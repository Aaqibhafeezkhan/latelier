import React from 'react';
import { AppShell } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { isKnownNotConnected } from '../../state/connections';
import { confirmDestructive } from '../../utils/confirm';
import { getErrorMessage } from '../../api/atelier';
import { notify } from '../../theme/notifications';
import type { WorkspaceTab, ConnectionSummary } from '@shared/types';
import type { WorkspaceTabsState } from '../../state/workspaceTabs';
import { ConnectionSwitcher, type ConnectionSwitcherProps } from '../../features/connections/ConnectionSwitcher';
import { TitleBar } from './TitleBar';
import { TabStrip } from './TabStrip';
import { ResizeHandle } from './ResizeHandle';
import { DividerNotch } from './DividerNotch';
import { DbCollectionNavigator, type NavigatorOpenInput } from './DbCollectionNavigator';
import { useSettings } from '../SettingsContext';
import { usePaletteApi } from '../../commands/CommandPalette';
import { useHints } from '../../hints/HintsContext';
import { useWorkspacePanelPrefs } from './useWorkspacePanelPrefs';
import { useConnectionDialogs } from './useConnectionDialogs';
import type { NavigatorData } from './useNavigatorData';

// Returns a fragment: AppShell places .Header/.Navbar/.Main by CSS grid on direct children, so a wrapper here would break layout.
export interface ShellSectionProps {
  dark: boolean;
  toggle: () => void;
  focusedConnection: ConnectionSummary | null;
  switcherProps: Omit<ConnectionSwitcherProps, 'variant'>;
  settings: ReturnType<typeof useSettings>;
  palette: ReturnType<typeof usePaletteApi>;
  shellOpen: boolean;
  setShellOpen: React.Dispatch<React.SetStateAction<boolean>>;
  tabs: WorkspaceTabsState;
  connections: ConnectionSummary[];
  connectionsWithTabs: Set<string>;
  active: WorkspaceTab | null;
  scratchConnectionId: string | null;
  hints: ReturnType<typeof useHints>;
  openConnection: (id: string) => void;
  panelPrefs: ReturnType<typeof useWorkspacePanelPrefs>;
  connectionDialogs: ReturnType<typeof useConnectionDialogs>;
  /** The navigator's tree, owned by Workspace so it survives the sidebar collapsing. */
  navigatorData: NavigatorData;
  /** Opens the reference-rules drawer for the Focused Tab's collection. */
  onOpenReferences: () => void;
}

export function ShellSection({
  dark,
  toggle,
  focusedConnection,
  switcherProps,
  settings,
  palette,
  shellOpen,
  setShellOpen,
  tabs,
  connections,
  connectionsWithTabs,
  active,
  scratchConnectionId,
  hints,
  openConnection,
  panelPrefs,
  connectionDialogs,
  navigatorData,
  onOpenReferences,
}: ShellSectionProps) {
  const T = themeVars;
  const { sidebarCollapsed, toggleSidebar, leftWidth, setLeftWidth, commitLeftWidth } = panelPrefs;
  const { openEditConnectionModal, requestDisconnect } = connectionDialogs;
  const [revealRequest, setRevealRequest] = React.useState<NavigatorOpenInput | null>(null);

  const activate = (id: string) => {
    if (id !== tabs.activeId) hints.recordSessionEvent('tabSwitch', '*');
    // Clicking a dormant tab is the wake gesture: connect its Connection, same as clicking the navigator root.
    const target = tabs.tabs.find((t) => t.id === id);
    if (target) {
      const conn = connections.find((c) => c.id === target.connectionId);
      if (isKnownNotConnected(conn)) openConnection(target.connectionId);
    }
    void tabs.setActive(id);
  };

  // One prompt for the lot, naming how many pipelines would be lost. If the
  // active tab is among them, the tab the menu was opened on takes over first,
  // so focus never passes through a tab that is about to close.
  const closeMany = async (ids: string[], keepId: string) => {
    const dirty = ids.filter((id) => {
      const t = tabs.tabs.find((x) => x.id === id);
      return t?.kind === 'collection' && !!t.state.aggregation?.dirty;
    }).length;
    if (dirty > 0) {
      const proceed = await confirmDestructive({
        title: 'Discard unsaved pipeline changes?',
        body:
          dirty === 1
            ? '1 tab being closed has pipeline edits that have not been saved. Closing it discards them.'
            : `${dirty} tabs being closed have pipeline edits that have not been saved. Closing them discards them.`,
        confirmLabel: 'Discard and close',
      });
      if (!proceed) return;
    }
    // One tab failing to close (or to take focus) never stops the rest; the
    // failures are reported once at the end.
    if (tabs.activeId && ids.includes(tabs.activeId)) {
      try {
        await tabs.setActive(keepId);
      } catch (err) {
        notify.error(getErrorMessage(err, 'Could not switch to the tab'));
      }
    }
    let failed = 0;
    let lastError: unknown;
    for (const id of ids) {
      try {
        await tabs.close(id);
      } catch (err) {
        failed++;
        lastError = err;
      }
    }
    if (failed > 0) {
      notify.error(
        `${failed === 1 ? '1 tab' : `${failed} tabs`} could not be closed: ${getErrorMessage(lastError, 'close failed')}`,
      );
    }
  };

  // Activating the tab makes the navigator expand its database and load its
  // collections (the active-tab follow); opening the root and the database
  // here also covers a sidebar that is collapsed and so not following anything.
  const reveal = (id: string) => {
    const t = tabs.tabs.find((x) => x.id === id);
    if (t?.kind !== 'collection') return;
    activate(id);
    if (sidebarCollapsed) toggleSidebar();
    navigatorData.dispatch({ type: 'expandedConnSet', id: t.connectionId });
    navigatorData.dispatch({
      type: 'dbExpandedSet',
      connectionId: t.connectionId,
      dbName: t.dbName,
      value: true,
    });
    setRevealRequest({ connectionId: t.connectionId, dbName: t.dbName, collection: t.collection });
  };

  return (
    <>
      <AppShell.Header
        withBorder={false}
        style={{ display: 'flex', flexDirection: 'column', background: 'transparent' }}
      >
        <TitleBar
          dark={dark}
          toggle={toggle}
          connectionName={focusedConnection?.name ?? null}
          connectionSlot={<ConnectionSwitcher {...switcherProps} />}
          onOpenSettings={settings.open}
          onOpenPalette={palette.toggle}
          shellOpen={shellOpen}
          shellAvailable={!!focusedConnection}
          onToggleShell={() => setShellOpen((v) => !v)}
        />
        <TabStrip
          tabs={tabs.tabs}
          connections={connections}
          activeId={tabs.activeId}
          onOpenNewScript={() => {
            if (!scratchConnectionId) return;
            void tabs.openScript({ connectionId: scratchConnectionId });
          }}
          onActivate={activate}
          onClose={(id) => {
            const t = tabs.tabs.find((x) => x.id === id);
            if (t?.kind === 'collection' && t.state.aggregation?.dirty) {
              void confirmDestructive({
                title: 'Discard unsaved pipeline changes?',
                body: 'This tab has pipeline edits that have not been saved. Closing it discards them.',
                confirmLabel: 'Discard and close',
              }).then((proceed) => {
                if (proceed) void tabs.close(id);
              });
              return;
            }
            void tabs.close(id);
          }}
          onReorder={(ids) => void tabs.reorder(ids)}
          onTogglePin={(id) => {
            const t = tabs.tabs.find((x) => x.id === id);
            if (t) void tabs.setPinned(id, !t.pinned);
          }}
          onCloseMany={(ids, keepId) => void closeMany(ids, keepId)}
          onReveal={reveal}
        />
      </AppShell.Header>

      {/* DO NOT set `position` on AppShell.Navbar — Mantine's fixed-mode `top` offset becomes a layout shift under `position: relative`. Wrap the resize handle in an inner relative div instead. */}
      {/* `minHeight: 0` is load-bearing: without it the row inflates to the tree's full min-content height instead of scrolling internally. */}
      <AppShell.Navbar withBorder={false} style={{ minHeight: 0, minWidth: 0 }}>
        <div
          style={{
            position: 'relative',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'visible',
            background: T.surface,
            borderRight: `1px solid ${T.border}`,
          }}
        >
          {!sidebarCollapsed && (
            <>
              <DbCollectionNavigator
                connections={connections}
                connectionsWithTabs={connectionsWithTabs}
                focusedConnectionId={focusedConnection?.id ?? null}
                activeDbName={active?.dbName ?? null}
                activeCollection={active?.collection ?? null}
                onOpenCollection={(input: NavigatorOpenInput, opts) =>
                  void tabs.openCollection({ ...input, reuseExisting: opts.reuseExisting })
                }
                onOpenAggregation={(input: NavigatorOpenInput) =>
                  void tabs.openAggregation(input)
                }
                onEditConnection={openEditConnectionModal}
                onDisconnect={requestDisconnect}
                onCollectionDropped={(connectionId, dbName, collection) => {
                  void tabs.closeForNamespace({ connectionId, dbName, collection });
                }}
                onDatabaseDropped={(connectionId, dbName) => {
                  void tabs.closeForNamespace({ connectionId, dbName });
                }}
                onCollectionRenamed={(connectionId, dbName, oldName, newName) => {
                  void tabs.retargetCollection({
                    connectionId,
                    dbName,
                    collection: oldName,
                    newCollection: newName,
                  });
                }}
                onOpenReferences={onOpenReferences}
                data={navigatorData}
                revealRequest={revealRequest}
                onRevealHandled={() => setRevealRequest(null)}
              />
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  bottom: 0,
                  width: 4,
                  zIndex: 3,
                  display: 'flex',
                }}
              >
                <ResizeHandle
                  edge="left"
                  value={leftWidth}
                  min={160}
                  max={560}
                  onChange={setLeftWidth}
                  onCommit={commitLeftWidth}
                  ariaLabel="Resize navigator"
                />
              </div>
            </>
          )}
          <DividerNotch
            side="right"
            collapsed={sidebarCollapsed}
            onClick={toggleSidebar}
            ariaLabel={sidebarCollapsed ? 'Open navigator' : 'Collapse navigator'}
          />
        </div>
      </AppShell.Navbar>
    </>
  );
}
