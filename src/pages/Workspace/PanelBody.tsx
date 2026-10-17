import React from 'react';
import { Alert, AppShell, Button, Group, Tabs } from '@mantine/core';
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
  type PanelImperativeHandle,
} from 'react-resizable-panels';
import { getErrorMessage, isIpcError } from '../../api/atelier';
import { notify } from '../../theme/notifications';
import { themeVars } from '../../theme/themeVars';
import { I } from '../../icons';
import { isKnownNotConnected } from '../../state/connections';
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
  BUILDER_COLLAPSED_PCT,
  BUILDER_MIN_PCT,
  isUserChosenBuilderSplit,
} from './panelSizes';
import { AggregationTab } from './Aggregation/AggregationTab';
import { StructureView } from './StructureView';
import type { IndexCreateRequest } from '../IndexesTab';
import { QueryBar } from './QueryBar';
import { ResultViewer } from './ResultViewer';
import { BuilderPane } from './BuilderPane';
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
              <span aria-hidden="true" style={{ fontSize: 10, opacity: 0.7 }}>
                {t.icon}
              </span>
            }
            style={{
              padding: '0 11px',
              fontSize: 10,
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
}

export function PanelBody({
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
}: PanelBodyProps) {
  const T = themeVars;
  const { openImport } = useConnectionTransfer();
  const {
    prefsReady,
    refDrawerWidth, setRefDrawerWidth, commitRefDrawerWidth,
    innerHSplit, commitInnerHSplit,
    shellSplit, commitShellSplit,
    builderCollapsed,
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
          defaultSize={shellOpen && focusedConnection ? 100 - shellSplit : 100}
          minSize={30}
          style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}
        >
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {initialLoadPending || tabs.loading ? (
          <CenteredPane>
            <span>Loading workspace…</span>
          </CenteredPane>
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
        ) : active && isKnownNotConnected(focusedConnection) ? (
          // Never render the result grid off a stale cache while the tab's own connection is dormant.
          <CenteredPane>
            <div style={{ textAlign: 'center', maxWidth: 320 }}>
              <div style={{ color: T.textMuted, marginBottom: 12 }}>
                {focusedConnection!.name} is not connected.
              </div>
              <Button
                variant="filled"
                size="xs"
                onClick={() => openConnection(active.connectionId)}
              >
                Connect
              </Button>
            </div>
          </CenteredPane>
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
                  // Geometry-based guard: a state flag races toggleBuilder's synchronous collapse() call.
                  const builderPct = layout['h-builder'];
                  if (!isUserChosenBuilderSplit(builderPct)) return;
                  commitInnerHSplit(builderPct);
                }}
              >
                <Panel
                  id="h-result"
                  defaultSize={100 - innerHSplit}
                  minSize={30}
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
                        runShortcutRef={runShortcutRef}
                      />
                      <ResultViewer>
                        <ResultViewer.Pagination />
                        <ResultViewer.SelectionBar onDeleteSelected={setDeleteSelected} />
                        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                          <ResultViewer.Body
                            onClearFilter={clearActiveFilter}
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
                />
                <Panel
                  id="h-builder"
                  panelRef={builderPanelRef}
                  defaultSize={builderCollapsed ? BUILDER_COLLAPSED_PCT : innerHSplit}
                  minSize={BUILDER_MIN_PCT}
                  collapsible
                  collapsedSize={BUILDER_COLLAPSED_PCT}
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
                          onOpenInTab={(saved) => {
                            if (saved.kind === 'aggregation') {
                              // Main loads the stored stages and refuses a pipeline
                              // that was deleted since the list loaded; say so rather
                              // than leave the click doing nothing.
                              tabs
                                .openAggregation({
                                  connectionId: saved.connectionId,
                                  dbName: saved.dbName,
                                  collection: saved.collection,
                                  savedId: saved.id,
                                  name: saved.name,
                                })
                                .catch((e: unknown) =>
                                  notify.error(
                                    // Main's NOT_FOUND text names the row by its id.
                                    isIpcError(e) && e.code === 'NOT_FOUND'
                                      ? 'It no longer exists.'
                                      : getErrorMessage(e, String(e)),
                                    { title: `Could not open “${saved.name}”` },
                                  ),
                                );
                            } else if (saved.kind === 'script') {
                              void tabs.openScript({ connectionId: saved.connectionId });
                            }
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
                            styles={{ message: { fontSize: 12, lineHeight: 1.5 } }}
                          >
                            The Query Builder only applies to the Documents
                            view.{' '}
                            <Button
                              variant="subtle"
                              size="compact-xs"
                              onClick={() => selectActiveView('documents')}
                              styles={{ root: { padding: 0, height: 'auto', fontSize: 12 } }}
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
                fontSize: 13,
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
              defaultSize={shellSplit}
              minSize={10}
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
