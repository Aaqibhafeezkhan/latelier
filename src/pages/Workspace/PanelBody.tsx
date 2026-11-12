import React from 'react';
import { Alert, AppShell, Button, Group, Tabs } from '@mantine/core';
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
  type PanelImperativeHandle,
} from 'react-resizable-panels';
import { getErrorMessage } from '../../api/atelier';
import { notify } from '../../theme/notifications';
import { themeVars } from '../../theme/themeVars';
import { I } from '../../icons';
import { isKnownNotConnected } from '../../state/connections';
import { ownGet } from '../../utils/ownProperty';
import { PaneState } from '../../components/PaneState';
import type {
  CollectionView,
  CollectionTab,
  ScriptTab as ScriptTabType,
  WorkspaceTab,
  ConnectionSummary,
  AggregationTabState,
  SchemaTabState,
} from '@shared/types';
import type { WorkspaceTabsState } from '../../state/workspaceTabs';
import type { SuggestionContext } from '../../features/fieldSuggestions/types';
import { ConnectionSwitcher, type ConnectionSwitcherProps } from '../../features/connections/ConnectionSwitcher';
import { ReferenceDrawer } from '../../features/references/ReferenceDrawer';
import type { UseReferenceRulesResult } from '../../features/references/useReferenceRules';
import {
  asPercent,
  BUILDER_COLLAPSED_PX,
  BUILDER_MIN_PCT,
  isUserChosenBuilderSplit,
} from './panelSizes';
import { AggregationTab } from './Aggregation/AggregationTab';
import { StructureView } from './StructureView';
import type { IndexCreateRequest } from '../IndexesTab';
import { QueryBar } from './QueryBar';
import { ResultViewer } from './ResultViewer';
import { BuilderPane } from './BuilderPane';
import { openSavedPipeline, renameOpenPipelines } from './savedActions';
import { ResizeHandle } from './ResizeHandle';
import { DividerNotch } from './DividerNotch';
import { MongoShellPane } from './MongoShellPane';
import { ScriptTab } from './ScriptTab';
import { CollectionHeader } from './CollectionHeader';
import {
  CollectionWorkspaceProvider,
  type CollectionWorkspaceActions,
  type CollectionWorkspaceMeta,
} from './context';
import { useConnectionTransfer } from '../../features/connections/ConnectionTransferProvider';
import { useWorkspacePanelPrefs } from './useWorkspacePanelPrefs';
import { ONE_PANEL_BUILDER_PX } from './sidePanels';
import { GENERIC_CONNECT_ERROR } from './useNavigatorData';
import type { ConnectErrorInfo } from './navigatorTreeReducer';
import { latestFailedConnection } from './resultPaneState';
import { useCollectionTabActions } from './useCollectionTabActions';
import { useDocumentDialogs } from './useDocumentDialogs';
import type { ReferenceDrawerState } from './useReferenceDrawer';

const SUB_TABS: ReadonlyArray<{
  key: CollectionView;
  label: string;
  icon: string;
}> = [
  { key: 'documents', label: 'Documents', icon: '⚡' },
  { key: 'aggregation', label: 'Aggregation', icon: 'Σ' },
  { key: 'structure', label: 'Structure', icon: '⚙' },
];

/**
 * The Documents / Aggregation / Structure strip. Mantine's `Tabs` gives it the
 * tablist pattern (arrow keys, Home/End, a single tab stop, aria-controls). It
 * must sit inside the same `<Tabs>` root as the `Tabs.Panel`s: Mantine only
 * sets a tab's `aria-controls` once its panel is mounted.
 */
function SubTabStrip({ active }: { active: CollectionView }) {
  const T = themeVars;
  return (
    <Tabs.List
      aria-label="Collection view"
      style={{
        height: 26,
        flexWrap: 'nowrap',
        alignItems: 'stretch',
        borderBottom: `1px solid ${T.border}`,
        background: T.surfaceRaised,
        flexShrink: 0,
        paddingLeft: 12,
      }}
    >
      {SUB_TABS.map((t) => {
        const selected = t.key === active;
        return (
          <Tabs.Tab
            key={t.key}
            value={t.key}
            leftSection={
              <span aria-hidden="true" style={{ fontSize: T.fsXs, opacity: 0.7 }}>
                {t.icon}
              </span>
            }
            style={{
              padding: '0 11px',
              fontSize: T.fsXs,
              fontWeight: 600,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              whiteSpace: 'nowrap',
              background: 'transparent',
              color: selected ? T.text : T.textMuted,
              border: 'none',
              borderBottom: selected ? `2px solid ${T.accent}` : '2px solid transparent',
              borderRadius: 0,
            }}
          >
            {t.label}
          </Tabs.Tab>
        );
      })}
    </Tabs.List>
  );
}

/**
 * The database the Shell opens on: the focused tab's own. Taken from the tab
 * and not from `collection`, which is null while the workspace meta loads even
 * though a collection tab is active. A script tab with a blank field has none,
 * so the connection's default database applies.
 */
function shellDbName(active: WorkspaceTab | null): string | undefined {
  if (active?.kind === 'collection') return active.dbName;
  if (active?.kind === 'script') return active.state.dbName?.trim() || undefined;
  return undefined;
}

function CenteredPane({ children }: { children: React.ReactNode }) {
  const T = themeVars;
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: T.textMuted,
      }}
    >
      {children}
    </div>
  );
}

/** A pane with no live connection behind it says why, in the words of the state it is in. */
function ConnectionPane({
  conn,
  connectError,
  onConnect,
  extraActions,
}: {
  conn: ConnectionSummary;
  connectError?: ConnectErrorInfo;
  onConnect: () => void;
  extraActions?: React.ReactNode;
}) {
  if (conn.status === 'connecting') return <PaneState title={`Connecting to ${conn.name}…`} />;
  const connect = (label: string) => (
    <Button variant="filled" size="xs" onClick={onConnect}>
      {label}
    </Button>
  );
  if (conn.status === 'error') {
    return (
      <PaneState
        tone="error"
        title={`Could not connect to ${conn.name}`}
        detail={connectError?.message ?? GENERIC_CONNECT_ERROR}
        actions={
          <>
            {/* A denied macOS keychain stays denied until relaunch, so Retry cannot succeed. */}
            {connectError?.code !== 'KEYCHAIN_BLOCKED' && connect('Retry')}
            {extraActions}
          </>
        }
      />
    );
  }
  if (conn.lostReason) {
    return (
      <PaneState
        tone="error"
        title={`The connection to ${conn.name} was lost`}
        detail={conn.lostReason}
        actions={connect('Reconnect')}
      />
    );
  }
  return <PaneState title={`${conn.name} is not connected.`} actions={connect('Connect')} />;
}

// `key={v-${prefsReady}}`/`key={h-${prefsReady}}` must stay on the PanelGroup elements below — jsdom's no-op ResizeObserver means a relocated key passes silently, but workspace-panel-prefs.spec.tsx pins it by DOM identity.

// `actions` must stay the exact `workspaceActions` reference from Workspace.tsx — workspace-actions-identity.spec.tsx pins it across renders.
export interface PanelBodyCollectionProps {
  tab: CollectionTab;
  meta: CollectionWorkspaceMeta;
  actions: CollectionWorkspaceActions;
  view: CollectionView;
  aggregationState: AggregationTabState;
  schemaState: SchemaTabState;
  suggestionContext: SuggestionContext | null;
  savedRefreshKey: number;
}

export interface PanelBodyProps {
  panelPrefs: ReturnType<typeof useWorkspacePanelPrefs>;
  collectionTabActions: ReturnType<typeof useCollectionTabActions>;
  documentDialogs: ReturnType<typeof useDocumentDialogs>;
  refDrawer: ReferenceDrawerState;
  tabs: WorkspaceTabsState;
  referenceRules: UseReferenceRulesResult;
  shellOpen: boolean;
  setShellOpen: React.Dispatch<React.SetStateAction<boolean>>;
  focusedConnection: ConnectionSummary | null;
  initialLoadPending: boolean;
  anyConnectionOpen: boolean;
  switcherProps: Omit<ConnectionSwitcherProps, 'variant'>;
  setNewTabOpen: (open: boolean) => void;
  active: WorkspaceTab | null;
  openConnection: (id: string) => void;
  activeScript: ScriptTabType | null;
  collection: PanelBodyCollectionProps | null;
  dark: boolean;
  builderPanelRef: React.RefObject<PanelImperativeHandle | null>;
  toggleBuilder: () => void;
  notchRef: React.RefObject<HTMLButtonElement | null>;
  /** See `IndexCreateRequest` — scoped to `collection`'s own tab by the caller (`Workspace.tsx`) before it reaches here. */
  structureInitialCreate?: IndexCreateRequest | null;
  onStructureInitialCreateConsumed?: () => void;
  connectErrors: Record<string, ConnectErrorInfo>;
  /** Loads that replace the query from outside (the palette's saved Open/Run), counted with this pane's own. */
  externalLoadGen?: number;
}

export function PanelBody({
  externalLoadGen = 0,
  panelPrefs,
  collectionTabActions,
  documentDialogs,
  refDrawer,
  tabs,
  referenceRules,
  shellOpen,
  setShellOpen,
  focusedConnection,
  initialLoadPending,
  anyConnectionOpen,
  switcherProps,
  setNewTabOpen,
  active,
  openConnection,
  activeScript,
  collection,
  dark,
  builderPanelRef,
  toggleBuilder,
  notchRef,
  structureInitialCreate,
  onStructureInitialCreateConsumed,
  connectErrors,
}: PanelBodyProps) {
  const T = themeVars;
  const failedConnection = anyConnectionOpen
    ? null
    : latestFailedConnection(switcherProps.connections, connectErrors);
  // Rows already on screen outlive a dropped connection, with the band saying
  // so. Anywhere else (no rows yet, Structure, a script) a query would only be
  // the first thing to fail, so the pane says it instead.
  const connectionLost =
    focusedConnection?.lostReason &&
    focusedConnection.status !== 'connected' &&
    focusedConnection.status !== 'error' &&
    collection?.view === 'documents' &&
    collection.tab.state.lastRun
      ? {
          reason: focusedConnection.lostReason,
          reconnecting: focusedConnection.status === 'connecting',
          onReconnect: () => openConnection(focusedConnection.id),
        }
      : undefined;
  const { openImport } = useConnectionTransfer();
  // Bumped by every load that replaces the query wholesale (Reset, Saved and
  // Recent run-here, all in BuilderPane). Lifted here because QueryBar needs
  // it too: such a load re-derives the advanced row's open state, which a
  // same-tab `hasAdvanced` change alone misses when the row already had
  // values and was collapsed.
  const [ownLoadGen, bumpLoadGen] = React.useReducer((n: number) => n + 1, 0);
  const loadGen = ownLoadGen + externalLoadGen;
  const {
    prefsReady,
    refDrawerWidth, setRefDrawerWidth, commitRefDrawerWidth,
    innerHSplit, commitInnerHSplit,
    shellSplit, commitShellSplit,
    builderCollapsed,
    onePanelOnly,
  } = panelPrefs;
  const {
    patchActiveScript,
    selectActiveView,
    clearActiveFilter,
    handleColumnResize,
    handleRowExpand,
    handleSortField,
    patchAggregation,
    patchSchema,
  } = collectionTabActions;
  const { setDeleteSelected } = documentDialogs;
  const {
    refStack, setRefStack,
    refDrawerPinned, setRefDrawerPinned,
    setRefEditorOpen,
    handleRefHover, handleRefHoverLeave, handleRefOpen,
  } = refDrawer;

  // ⌘/Ctrl+Enter runs from anywhere in the Documents view: the query
  // bar, a result row (where focus stays after dragging a field into the
  // drawer), the drawer. Bound once on the panel group rather than per
  // input; QueryBar supplies the action, and only mounts in the Documents
  // view, so an empty ref means another view that owns its own ⌘↵
  // (Aggregation) or has no Run (Structure). A dialog keeps its own ⌘↵ —
  // same rule as ⌘B in Workspace.tsx; React bubbles portal events here too.
  const runShortcutRef = React.useRef<(() => void) | null>(null);
  const builderDividerUsed = React.useRef(false);
  const handleRunShortcut = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('[role="dialog"], [role="alertdialog"]')) {
      return;
    }
    const run = runShortcutRef.current;
    if (!run) return;
    // Also stops a focused Run button's native Enter activation from running twice.
    e.preventDefault();
    run();
  };

  return (
    <AppShell.Main
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0,
        minWidth: 0,
      }}
    >
      <PanelGroup
        key={`v-${String(prefsReady)}`}
        orientation="vertical"
        style={{ flex: 1, overflow: 'hidden' }}
        onLayoutChanged={(layout) => {
          if (!shellOpen || !focusedConnection) return;
          const shellPct = layout['v-shell'];
          if (shellPct === undefined) return;
          commitShellSplit(shellPct);
        }}
      >
        <Panel
          id="v-main"
          defaultSize={asPercent(shellOpen && focusedConnection ? 100 - shellSplit : 100)}
          minSize={asPercent(30)}
          style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}
        >
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {initialLoadPending || tabs.loading ? (
          <CenteredPane>
            <span>Loading workspace…</span>
          </CenteredPane>
        ) : tabs.tabs.length === 0 && failedConnection ? (
          <ConnectionPane
            conn={failedConnection}
            connectError={ownGet(connectErrors, failedConnection.id)}
            onConnect={() => openConnection(failedConnection.id)}
            extraActions={<ConnectionSwitcher {...switcherProps} variant="cta" />}
          />
        ) : tabs.tabs.length === 0 ? (
          <CenteredPane>
            <div style={{ textAlign: 'center', maxWidth: 320 }}>
              <div style={{ color: T.textMuted, marginBottom: 12 }}>
                {anyConnectionOpen
                  ? 'Select a collection from the sidebar to get started.'
                  : 'No connection is open. Select one to get started.'}
              </div>
              {anyConnectionOpen ? (
                <Button variant="filled" size="xs" leftSection={I.plus} onClick={() => setNewTabOpen(true)}>
                  Open a collection
                </Button>
              ) : (
                <Group gap="xs" justify="center">
                  <ConnectionSwitcher {...switcherProps} variant="cta" />
                  {switcherProps.connections.length === 0 && (
                    <Button variant="default" size="xs" onClick={() => openImport()}>
                      Import connections
                    </Button>
                  )}
                </Group>
              )}
            </div>
          </CenteredPane>
        ) : active && isKnownNotConnected(focusedConnection) && !connectionLost ? (
          // Never render the result grid off a stale cache while the tab's own connection is dormant.
          <ConnectionPane
            conn={focusedConnection!}
            connectError={ownGet(connectErrors, active.connectionId)}
            onConnect={() => openConnection(active.connectionId)}
          />
        ) : activeScript ? (
          <ScriptTab
            tab={activeScript}
            defaultDb={focusedConnection?.defaultDb}
            onPatch={patchActiveScript}
          />
        ) : collection ? (
            // Builder pane always renders; agg/structure views just dim it via overlay rather than unmounting.
            <CollectionWorkspaceProvider
              state={collection.tab.state}
              actions={collection.actions}
              meta={collection.meta}
            >
              <Tabs
                value={collection.view}
                onChange={(v) => {
                  if (v) selectActiveView(v as CollectionView);
                }}
                keepMounted={false}
                variant="unstyled"
                id="collection-view"
                style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
              >
              <SubTabStrip active={collection.view} />
              <PanelGroup
                key={`h-${String(prefsReady)}`}
                orientation="horizontal"
                style={{ flex: 1, overflow: 'hidden' }}
                onKeyDown={handleRunShortcut}
                onLayoutChanged={(layout) => {
                  // Only the divider is a choice to store. Layouts also change when a
                  // window crosses the one-panel width, and the drawer passes through
                  // its minimum on the way back to the stored width.
                  const fromDivider = builderDividerUsed.current;
                  builderDividerUsed.current = false;
                  const builderPct = layout['h-builder'];
                  // The drawer's width while the window is narrow is ours, too.
                  if (!fromDivider || onePanelOnly || !isUserChosenBuilderSplit(builderPct)) return;
                  commitInnerHSplit(builderPct);
                }}
              >
                <Panel
                  id="h-result"
                  defaultSize={builderCollapsed ? undefined : asPercent(100 - innerHSplit)}
                  // A plain number is pixels: enough for the toolbar on two rows.
                  minSize={320}
                  style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}
                >
                  <Tabs.Panel value="documents" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
                    <>
                      <CollectionHeader
                        connectionId={collection.tab.connectionId}
                        dbName={collection.tab.dbName}
                        collection={collection.tab.collection}
                        onOpenReferences={() => setRefEditorOpen(true)}
                        referenceRuleCount={referenceRules.rules.length}
                        refreshSignal={documentDialogs.writeVersion}
                      />
                      <QueryBar
                        suggestionContext={collection.suggestionContext}
                        loadGen={loadGen}
                        runShortcutRef={runShortcutRef}
                      />
                      <ResultViewer>
                        <ResultViewer.Pagination />
                        <ResultViewer.SelectionBar
                          onDeleteSelected={setDeleteSelected}
                          connectionLost={connectionLost}
                        />
                        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                          <ResultViewer.Body
                            onClearFilter={clearActiveFilter}
                            onQueryReplaced={bumpLoadGen}
                            onColumnResize={handleColumnResize}
                            onRowExpand={handleRowExpand}
                            onSortField={handleSortField}
                            refsByField={referenceRules.byField}
                            onRefHover={handleRefHover}
                            onRefHoverLeave={handleRefHoverLeave}
                            onRefOpen={handleRefOpen}
                          />
                          {refStack.length > 0 && (
                            <>
                              <ResizeHandle
                                edge="right"
                                value={refDrawerWidth}
                                min={160}
                                max={560}
                                onChange={setRefDrawerWidth}
                                onCommit={commitRefDrawerWidth}
                                ariaLabel="Resize reference drawer"
                              />
                              <ReferenceDrawer
                                stack={refStack}
                                pinned={refDrawerPinned}
                                width={refDrawerWidth}
                                onPush={(frame) => setRefStack((prev) => [...prev, frame])}
                                onPop={() => setRefStack((prev) => prev.slice(0, -1))}
                                onClose={() => {
                                  setRefStack([]);
                                  setRefDrawerPinned(false);
                                }}
                                onTogglePin={() => setRefDrawerPinned((p) => !p)}
                              />
                            </>
                          )}
                        </div>
                      </ResultViewer>
                    </>
                  </Tabs.Panel>
                  <Tabs.Panel value="aggregation" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
                    <AggregationTab
                      connectionId={collection.tab.connectionId}
                      dbName={collection.tab.dbName}
                      collection={collection.tab.collection}
                      state={collection.aggregationState}
                      darkMode={dark}
                      sourceCount={null}
                      onPatch={patchAggregation}
                      tabId={collection.tab.id}
                    />
                  </Tabs.Panel>
                  <Tabs.Panel value="structure" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
                    <StructureView
                      connectionId={collection.tab.connectionId}
                      dbName={collection.tab.dbName}
                      collection={collection.tab.collection}
                      state={collection.schemaState}
                      onPatch={patchSchema}
                      initialCreate={structureInitialCreate}
                      onInitialCreateConsumed={onStructureInitialCreateConsumed}
                    />
                  </Tabs.Panel>
                </Panel>
                <PanelResizeHandle
                  style={{
                    width: 4,
                    flexShrink: 0,
                    cursor: 'col-resize',
                    position: 'relative',
                    zIndex: 2,
                  }}
                  aria-label="Resize Query Builder"
                  onPointerDown={() => {
                    builderDividerUsed.current = true;
                  }}
                  // Capture: the library resizes in its own listener on this element,
                  // which runs before a bubbling React handler would.
                  onKeyDownCapture={(e) => {
                    if (e.key !== 'Tab') builderDividerUsed.current = true;
                  }}
                />
                <Panel
                  id="h-builder"
                  panelRef={builderPanelRef}
                  defaultSize={builderCollapsed ? BUILDER_COLLAPSED_PX : asPercent(innerHSplit)}
                  minSize={onePanelOnly ? ONE_PANEL_BUILDER_PX : asPercent(BUILDER_MIN_PCT)}
                  // Only once the toggle has asked for it: while open, a drag stops at
                  // the minimum. Otherwise it could collapse the panel without
                  // `builderCollapsed` knowing, leaving no way to reopen it. Workspace's
                  // sync effect does the collapse, a frame after this prop turns on.
                  collapsible={builderCollapsed}
                  collapsedSize={BUILDER_COLLAPSED_PX}
                  style={{ overflow: 'visible' }}
                >
                  {builderCollapsed ? (
                    <div
                      style={{
                        height: '100%',
                        borderLeft: `1px solid ${T.border}`,
                        background: T.surface,
                        position: 'relative',
                      }}
                    >
                      <DividerNotch
                        side="left"
                        collapsed
                        onClick={toggleBuilder}
                        ariaLabel="Open Query Builder"
                        buttonRef={notchRef}
                      />
                    </div>
                  ) : (
                    <div style={{ position: 'relative', height: '100%' }}>
                      <div
                        style={{
                          height: '100%',
                          pointerEvents: collection.view === 'documents' ? undefined : 'none',
                          opacity: collection.view === 'documents' ? 1 : 0.35,
                          filter: collection.view === 'documents' ? undefined : 'saturate(0.6)',
                        }}
                        aria-hidden={collection.view !== 'documents'}
                      >
                        <BuilderPane
                          savedRefreshKey={collection.savedRefreshKey}
                          loadGen={loadGen}
                          onLoaded={bumpLoadGen}
                          onOpenInTab={(saved) => {
                            if (saved.kind === 'aggregation') {
                              void openSavedPipeline(tabs, saved);
                            } else if (saved.kind === 'script') {
                              void tabs.openScript({ connectionId: saved.connectionId });
                            }
                          }}
                          onSavedRenamed={(saved, name) => renameOpenPipelines(tabs, saved.id, name)}
                          onOpenAsPipeline={(stages) => {
                            tabs
                              .openAggregation({
                                connectionId: collection.tab.connectionId,
                                dbName: collection.tab.dbName,
                                collection: collection.tab.collection,
                                initialState: { stages, activeStageId: null, dirty: true },
                              })
                              .catch((e: unknown) =>
                                notify.error(getErrorMessage(e, String(e)), {
                                  title: 'Could not open the pipeline',
                                }),
                              );
                          }}
                        />
                      </div>
                      <DividerNotch
                        side="left"
                        collapsed={false}
                        onClick={toggleBuilder}
                        ariaLabel="Collapse Query Builder"
                        buttonRef={notchRef}
                      />
                      {collection.view !== 'documents' && (
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            alignItems: 'flex-start',
                            justifyContent: 'center',
                            padding: '60px 16px 16px',
                            pointerEvents: 'none',
                          }}
                        >
                          <Alert
                            color="gray"
                            variant="light"
                            style={{ maxWidth: 280, pointerEvents: 'auto' }}
                            styles={{ message: { fontSize: T.fsSm, lineHeight: 1.5 } }}
                          >
                            The Query Builder only applies to the Documents
                            view.{' '}
                            <Button
                              variant="subtle"
                              size="compact-xs"
                              onClick={() => selectActiveView('documents')}
                              styles={{ root: { padding: 0, height: 'auto', fontSize: T.fsSm } }}
                            >
                              Switch to Documents
                            </Button>
                          </Alert>
                        </div>
                      )}
                    </div>
                  )}
                </Panel>
              </PanelGroup>
              </Tabs>
            </CollectionWorkspaceProvider>
          ) : (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: T.textMuted,
                fontSize: T.fsMd,
              }}
            >
              Select a collection to query.
            </div>
          )}
      </div>
        </Panel>
        {shellOpen && focusedConnection && (
          <>
            <PanelResizeHandle
              style={{
                height: 4,
                flexShrink: 0,
                cursor: 'row-resize',
                position: 'relative',
                zIndex: 2,
              }}
              aria-label="Resize shell pane"
            />
            <Panel
              id="v-shell"
              defaultSize={asPercent(shellSplit)}
              minSize={asPercent(10)}
              style={{ overflow: 'hidden' }}
            >
              <MongoShellPane
                connectionId={focusedConnection.id}
                connectionName={focusedConnection.name}
                dbName={shellDbName(active)}
                onClose={() => setShellOpen(false)}
              />
            </Panel>
          </>
        )}
      </PanelGroup>
    </AppShell.Main>
  );
}
