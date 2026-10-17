import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { DarkCtx, useTheme } from '../ThemeContext';
import { themeVars } from '../theme/themeVars';
import { AppShell } from '@mantine/core';
import { type PanelImperativeHandle } from 'react-resizable-panels';
import { useWorkspaceTabs } from '../state/workspaceTabs';
import { useConnections, isConnectionActive, isKnownNotConnected } from '../state/connections';
import { setFocusedConnectionId as publishFocusedConnectionId } from '../state/focusedConnection';
import { api, getErrorMessage, isIpcError } from '../api/atelier';
import { notify } from '../theme/notifications';
import { ejsonParse, isPlainDocument } from '../utils/ejson';
import { buildUpdateRequest, setAtSegments } from './Workspace/documentDiff';
import { copyToClipboard } from '../utils/clipboard';
import { BUILDER_MIN_PCT } from './Workspace/panelSizes';
import type { CollectionView } from '@shared/types';
import { DEFAULT_AGGREGATION_TAB_STATE, DEFAULT_SCHEMA_TAB_STATE } from '@shared/defaults';
import { useReferenceRules } from '../features/references/useReferenceRules';
import { useReferenceDrawer } from './Workspace/useReferenceDrawer';
import { groupTabsByConnection } from './Workspace/tabGroups';
import {
  type CollectionWorkspaceActions,
  type CollectionWorkspaceMeta,
  type UpdateFieldOutcome,
} from './Workspace/context';
import { useQueryRunner } from './Workspace/useQueryRunner';
import type { RunnerTarget } from './Workspace/useQueryRunner';
import { useWorkspacePanelPrefs } from './Workspace/useWorkspacePanelPrefs';
import { useNavigatorData, useNavigatorStatusSync } from './Workspace/useNavigatorData';
import { ownGet } from '../utils/ownProperty';
import type { DbInfo } from '@shared/ipc';
import { useConnectionDialogs } from './Workspace/useConnectionDialogs';
import { useDocumentDialogs } from './Workspace/useDocumentDialogs';
import { offerUndo } from './Workspace/offerUndo';
import { useCollectionTabActions } from './Workspace/useCollectionTabActions';
import { DialogStack } from './Workspace/DialogStack';
import { ShellSection } from './Workspace/ShellSection';
import { PanelBody, type PanelBodyCollectionProps } from './Workspace/PanelBody';
import type { IndexCreateRequest } from './IndexesTab';
import { useSettings } from './SettingsContext';
import { useRegisterCommands } from '../commands/useRegisterCommands';
import { useLatest } from '../commands/useLatest';
import { usePaletteApi } from '../commands/CommandPalette';
import { useFeatureHint } from '../hints/useFeatureHint';
import { useHints } from '../hints/HintsContext';
import { queryRunKey } from '../utils/queryRunKey';
import { looksLikeForeignIdField } from '../utils/foreignIdField';
import {
  compileFindOptions,
  currentFilterJson,
  effectivePageLimit,
  findProblem,
  isDefaultQueryState,
} from './Workspace/builder';
import type { SuggestionContext } from '../features/fieldSuggestions/types';
import { invalidateSampleSchemaCache } from '../features/fieldSuggestions/sources/sampleSchemaSource';

const OK: UpdateFieldOutcome = { ok: true };
/** Collection listings the palette sweep keeps in flight at once. */
const SWEEP_CONCURRENCY = 4;

function WorkspaceInner() {
  const T = themeVars;
  const navigate = useNavigate();
  const location = useLocation();
  const tabs = useWorkspaceTabs();
  const {
    connections,
    loading: connectionsLoading,
    refresh: refreshConnections,
    removeLocal: removeConnectionLocal,
  } = useConnections();
  const { dark, toggle } = useWorkspaceThemeBridge();
  const [newTabOpen, setNewTabOpen] = React.useState(false);

  const panelPrefs = useWorkspacePanelPrefs();
  // The navigator's tree, owned here: it outlives a collapsed sidebar and the
  // palette's namespace commands read the same cache.
  const navigatorData = useNavigatorData();
  // A Connection that came back after a disconnect: its cached databases and
  // collections predate the gap, so the palette's next sweep of it re-lists
  // them all.
  const reconnectedRef = React.useRef(new Set<string>());
  const [reconnects, setReconnects] = React.useState(0);
  const onNavigatorReconnect = React.useCallback((id: string) => {
    reconnectedRef.current.add(id);
    setReconnects((n) => n + 1);
  }, []);
  useNavigatorStatusSync(navigatorData, onNavigatorReconnect);
  const {
    prefsReady,
    leftWidth,
    innerHSplit,
    sidebarCollapsed,
    builderCollapsed, commitBuilderCollapsed,
  } = panelPrefs;
  const [shellOpen, setShellOpen] = React.useState(false);
  const builderPanelRef = React.useRef<PanelImperativeHandle>(null);
  const [savedRefreshKey, setSavedRefreshKey] = React.useState(0);
  const [queryBarSaveOpen, setQueryBarSaveOpen] = React.useState(false);
  const settings = useSettings();
  const palette = usePaletteApi();

  // `resize()` treats a number as pixels and a string as a percentage —
  // `resize(26)` is 26px, not 26%. `expand()` alone reopens at the collapsed
  // 4% rail, so the width is set explicitly from the stored split after.
  const innerHSplitRef = useLatest(innerHSplit);
  const restoreBuilderWidth = React.useCallback(() => {
    const handle = builderPanelRef.current;
    if (!handle) return;
    handle.expand();
    // Floor at BUILDER_MIN_PCT in case a stored split is narrower than draggable.
    const pct = Math.max(innerHSplitRef.current, BUILDER_MIN_PCT);
    handle.resize(`${pct}%`);
  }, [innerHSplitRef]);

  const toggleBuilder = React.useCallback(() => {
    const next = !builderCollapsed;
    commitBuilderCollapsed(next);
    if (next) builderPanelRef.current?.collapse();
    else restoreBuilderWidth();
  }, [builderCollapsed, commitBuilderCollapsed, restoreBuilderWidth]);

  // Expands the pane first — when collapsed, BuilderPane isn't mounted, so a
  // patch targeting it would silently land in persisted state only.
  const builderCollapsedRef = useLatest(builderCollapsed);
  const expandBuilder = React.useCallback(() => {
    if (!builderCollapsedRef.current) return;
    commitBuilderCollapsed(false);
    restoreBuilderWidth();
  }, [builderCollapsedRef, commitBuilderCollapsed, restoreBuilderWidth]);

  // Moves focus to the drawer's selected tab on expand, or back to the notch
  // on collapse — a flag+effect because BuilderPane isn't mounted while
  // collapsed, so there's nothing to focus until the next render.
  const notchRef = React.useRef<HTMLButtonElement>(null);
  const moveFocusOnBuilderToggle = React.useRef(false);
  React.useEffect(() => {
    if (!moveFocusOnBuilderToggle.current) return;
    moveFocusOnBuilderToggle.current = false;
    if (builderCollapsed) {
      notchRef.current?.focus();
      return;
    }
    const selectedTab = document.querySelector<HTMLElement>(
      '[aria-label="Query drawer"] [role="tab"][aria-selected="true"]',
    );
    selectedTab?.focus();
  }, [builderCollapsed]);

  const toggleBuilderWithFocus = React.useCallback(() => {
    moveFocusOnBuilderToggle.current = true;
    toggleBuilder();
  }, [toggleBuilder]);

  const active = tabs.tabs.find((t) => t.id === tabs.activeId) ?? null;
  const activeCollection = active?.kind === 'collection' ? active : null;
  const activeScript = active?.kind === 'script' ? active : null;
  const activeView: CollectionView =
    activeCollection?.state.activeView ?? 'documents';
  const aggregationState =
    activeCollection?.state.aggregation ?? DEFAULT_AGGREGATION_TAB_STATE;
  const schemaState = activeCollection?.state.schema ?? DEFAULT_SCHEMA_TAB_STATE;
  // The active tab's own Connection — null with no tab open, not a gap to paper over.
  const focusedConnection = active
    ? connections.find((c) => c.id === active.connectionId) ?? null
    : null;

  // Gates the main pane's loading state until both the prefs read and the
  // initial Connections fetch have settled.
  const initialLoadPending = !prefsReady || connectionsLoading;
  const openConnections = connections.filter((c) => c.status === 'connected');
  const anyConnectionOpen = openConnections.length > 0;
  // "New script"/new-tab picker need a Connection with no tab open to name one;
  // fall back to the sole open Connection when unambiguous, else stay inert.
  const soleOpenConnectionId = openConnections.length === 1 ? openConnections[0]!.id : null;
  const scratchConnectionId = focusedConnection?.id ?? soleOpenConnectionId;

  // Mirrors to the module-level store so PaletteContext (mounted above
  // <Routes>) can read it once the URL no longer carries a connection :id.
  const focusedConnectionId = focusedConnection?.id ?? null;
  React.useEffect(() => {
    publishFocusedConnectionId(focusedConnectionId);
  }, [focusedConnectionId]);
  // Reset only on unmount, not on every id change (which a bare cleanup would do).
  React.useEffect(() => () => publishFocusedConnectionId(null), []);


  const referenceRules = useReferenceRules(
    activeCollection?.connectionId ?? null,
    activeCollection?.dbName ?? null,
    activeCollection?.collection ?? null,
  );

  const {
    refStack,
    setRefStack,
    refDrawerPinned,
    setRefDrawerPinned,
    refEditorOpen,
    setRefEditorOpen,
    refHover,
    handleRefHover,
    handleRefHoverLeave,
    handleRefOpen,
  } = useReferenceDrawer(
    tabs.activeId,
    tabs.tabs,
    tabs.patchCollectionState,
    activeCollection?.id ?? null,
  );

  const hints = useHints();

  const lastRunDocs = activeCollection?.state.lastRun?.documents;
  const refsConfigureWhen = React.useMemo(() => {
    if (!lastRunDocs || lastRunDocs.length === 0) return false;
    if (referenceRules.rules.length > 0) return false;
    return lastRunDocs.slice(0, 25).some(
      (doc) =>
        typeof doc === 'object' &&
        doc !== null &&
        !Array.isArray(doc) &&
        Object.keys(doc as Record<string, unknown>).some(looksLikeForeignIdField),
    );
  }, [lastRunDocs, referenceRules.rules.length]);
  const refsConfigureHint = useFeatureHint('refs.configure', refsConfigureWhen);

  // Saved vs Dormant isn't a `status` distinction — it's whether any tab is
  // still open on the Connection, which only this component tracks.
  const connectionsWithTabs = React.useMemo(
    () => new Set(tabs.tabs.map((t) => t.connectionId)),
    [tabs.tabs],
  );

  const tabSwitchCount = hints.getSessionEventCount('tabSwitch', '*');
  const anyPinned = tabs.tabs.some((t) => t.pinned);
  const tabsPinHint = useFeatureHint(
    'tabs.pin',
    tabSwitchCount >= 3 && !anyPinned && tabs.activeId !== null,
  );

  const currentQueryKey = React.useMemo(() => {
    if (!activeCollection) return '';
    const compiled = compileFindOptions(activeCollection.state.builder);
    const filter = currentFilterJson(activeCollection.state) ?? '<invalid>';
    const { skip, limit } = effectivePageLimit(
      compiled.limit,
      activeCollection.state.page,
      activeCollection.state.pageSize,
    );
    return queryRunKey({
      connectionId: activeCollection.connectionId,
      dbName: activeCollection.dbName,
      collection: activeCollection.collection,
      filter,
      sort: compiled.sort ?? '',
      projection: activeCollection.state.builder.projection,
      projectionRaw: activeCollection.state.builder.projectionRaw,
      limit,
      skip,
    });
  }, [activeCollection]);
  const savedCreateCount = hints.getSessionEventCount('queryRun', currentQueryKey);
  const savedCreateHint = useFeatureHint(
    'saved.create',
    savedCreateCount >= 3 && !!activeCollection,
  );

  const collectionSuggestionContext = React.useMemo<SuggestionContext | null>(() => {
    if (!activeCollection) return null;
    return {
      connectionId: activeCollection.connectionId,
      dbName: activeCollection.dbName,
      collection: activeCollection.collection,
      recentDocs: activeCollection.state.lastRun?.documents,
    };
  }, [activeCollection]);

  const queryRunner = useQueryRunner({
    active: activeCollection
      ? {
          id: activeCollection.id,
          connectionId: activeCollection.connectionId,
          dbName: activeCollection.dbName,
          collection: activeCollection.collection,
          state: activeCollection.state,
        }
      : null,
    patchCollectionState: tabs.patchCollectionState,
    recordSessionEvent: hints.recordSessionEvent,
  });
  const showLoading = queryRunner.isLoading;

  // The first hint a new user sees should be about Run, not a secondary
  // feature. Workspace's own auto-run effect means `lastRun` is set almost
  // as soon as a tab opens, so gating on "no lastRun" would essentially
  // never fire once the user starts editing. `savedCreateCount` is this same
  // query's exact run-key looked up in this session's run tally (recorded
  // by `useQueryRunner` on every completed run, further up in this file) —
  // zero means the query on screen right now has never actually been run,
  // whether because nothing has run yet or because it was edited since the
  // last one that did. Gated on the same two conditions the Run button
  // itself gates on (`QueryBar`'s `canRun`), or the hint would teach "Press
  // Run" while Run is disabled (an unparseable filter) or mid-flight
  // (Cancel has replaced Run).
  const runExecuteHint = useFeatureHint(
    'run.execute',
    activeView === 'documents' &&
      !!activeCollection &&
      !queryRunner.isLoading &&
      findProblem(activeCollection.state) === null &&
      savedCreateCount === 0,
  );

  // Auto-runs the base query on a fresh/restored tab landing on Documents
  // with no prior run, only while the query is still at its default shape
  // (so a loaded saved query isn't clobbered), and never against a Dormant
  // Connection. Deps are deliberately just the landing triggers, not the
  // query sub-fields — depending on those would re-fire on every keystroke.
  React.useEffect(() => {
    if (!activeCollection) return;
    if (activeView !== 'documents') return;
    if (activeCollection.state.lastRun) return;
    if (!isDefaultQueryState(activeCollection.state)) return;
    if (isKnownNotConnected(focusedConnection)) return;
    void queryRunner.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCollection?.id, activeView, queryRunner.run, focusedConnection]);

  // Refs let palette-command perform() closures see fresh values without
  // re-registering on every state tick.
  const activeRef = useLatest(active);
  const activeCollectionRef = useLatest(activeCollection);
  const activeScriptRef = useLatest(activeScript);
  const tabsRef = useLatest(tabs);
  const focusedConnectionRef = useLatest(focusedConnection);

  // "Go to Indexes" / "Go to Schema" from the palette: the Structure view may
  // not be mounted yet when the command runs, so the scroll waits for the
  // render that shows it. The nonce re-runs it when Structure is already
  // active. Both sections share one scroller, so selecting the view alone can
  // leave the schema below a long index list.
  const structureScrollRef = React.useRef<'Indexes' | 'Schema' | null>(null);
  const [structureScrollNonce, setStructureScrollNonce] = React.useState(0);
  React.useEffect(() => {
    const target = structureScrollRef.current;
    if (!target || activeView !== 'structure') return;
    structureScrollRef.current = null;
    document
      .querySelector<HTMLElement>(`[role="region"][aria-label="${target}"]`)
      // jsdom has no scrollIntoView.
      ?.scrollIntoView?.({ block: 'start' });
  }, [structureScrollNonce, activeView]);

  // Stable callbacks for the major panels, reading state via the `*Ref` bag
  // so an unrelated re-render doesn't cascade through every child.
  // `useQueryRunner` returns a fresh object each render; depend on `run` alone.
  const { run, cancel: cancelRun } = queryRunner;
  const collectionTabActions = useCollectionTabActions({
    activeCollectionRef,
    activeScriptRef,
    tabs,
    run,
    cancel: cancelRun,
  });
  const {
    patchActiveCollection,
    patchActiveCollectionWith,
    runActiveCollection,
    cancelActiveCollection,
    selectActiveView,
  } = collectionTabActions;

  // W16 Tier 4 — ExplainDrawer's "Create an index for this query". Kept as
  // plain tab-scoped state (not tab persisted state) because it's a one-shot
  // UI trigger, not data: `openCreateIndex` sets it and switches to
  // Structure; `IndexesTab` (via `PanelBody`/`StructureView`) opens the
  // drawer from it and immediately calls `onCreateIndexConsumed` — see that
  // callback's own comment for why a stale request can't be left set past
  // its one use.
  const [createIndexRequest, setCreateIndexRequest] = React.useState<
    (IndexCreateRequest & { tabId: string }) | null
  >(null);
  const openCreateIndex = React.useCallback(
    (suggestion: IndexCreateRequest['suggestion']) => {
      const a = activeCollectionRef.current;
      if (!a) return;
      setCreateIndexRequest({ tabId: a.id, requestId: crypto.randomUUID(), suggestion });
      selectActiveView('structure');
    },
    [activeCollectionRef, selectActiveView],
  );
  const onCreateIndexConsumed = React.useCallback(() => setCreateIndexRequest(null), []);
  // The post-write refresh target, resolved fresh from `tabsRef` at
  // completion time rather than snapshotted, since a drawer pinned to tab A
  // must refresh A even after the user switches to tab B.
  const resolveRunnerTarget = React.useCallback(
    (tabId: string): RunnerTarget | null => {
      const t = tabsRef.current.tabs.find((x) => x.id === tabId);
      if (t?.kind !== 'collection') return null;
      return {
        id: t.id,
        connectionId: t.connectionId,
        dbName: t.dbName,
        collection: t.collection,
        state: t.state,
      };
    },
    [tabsRef],
  );
  const documentDialogs = useDocumentDialogs({
    activeCollectionRef,
    queryRunner,
    activeTabId: tabs.activeId,
    resolveRunnerTarget,
    readOnly: focusedConnection?.readOnly ?? false,
  });
  const {
    openEdit,
    setDeleteDoc,
    openInsertModal,
    openDeleteAllModal,
    openUpdateAllModal,
    openDuplicate,
  } = documentDialogs;
  const openSaveModal = React.useCallback(
    () => setQueryBarSaveOpen(true),
    [],
  );
  // Table view's inline single-field edit (W18 §8, Quick Edit): the same
  // one-path guarded save the Document Editor uses (`documentDiff.ts`'s
  // `buildUpdateRequest`), so a concurrent change to the loaded value is
  // caught instead of silently overwritten, and `newValue`'s own type
  // (string, boolean, or a revived BSON numeric instance) is what gets
  // written — never a re-typed string coerced into another field's type. No
  // drawer to show an inline error, so this uses `notify` instead.
  // Returns the write's settlement, not just fires it: the boolean Quick
  // Edit toggle (`TableCell`, W18 §8) is a controlled checkbox with no
  // separate "editing" draft, so it needs to know when an in-flight write
  // has landed to disable itself and stop a second click mid-flight from
  // firing a guard built on the value the first click is still saving.
  const updateField = React.useCallback(
    (doc: unknown, fieldPath: string, newValue: unknown): Promise<UpdateFieldOutcome> => {
      const a = activeCollectionRef.current;
      if (!a) return Promise.resolve({ ok: false, message: 'No collection is open to save to' });
      const revived = ejsonParse<unknown>(JSON.stringify(doc));
      if (!isPlainDocument(revived)) {
        const message = 'Cannot edit a document without an _id';
        notify.error(message);
        return Promise.resolve({ ok: false, message });
      }
      const original = revived as Record<string, unknown>;
      const draft = setAtSegments(original, [fieldPath], newValue);
      let request;
      try {
        request = buildUpdateRequest(original, draft);
      } catch (e) {
        const message = getErrorMessage(e, 'Cannot save this value');
        notify.error(message);
        return Promise.resolve({ ok: false, message });
      }
      if (request === null) return Promise.resolve(OK); // unchanged — same field, same value
      return api.doc
        .updateOne({
          connectionId: a.connectionId,
          dbName: a.dbName,
          collection: a.collection,
          filterJson: request.filterJson,
          updateJson: request.updateJson,
        })
        .then(({ matchedCount, auditId }): Promise<UpdateFieldOutcome> | UpdateFieldOutcome => {
          // Guarded: nothing matching means the field (or the document)
          // changed since it was loaded, not that the write landed unseen.
          if (matchedCount === 0) {
            const message = 'This document changed since it was loaded; the edit was not saved.';
            notify.error(message, { title: 'Update failed' });
            return { ok: false, message };
          }
          // Quick Edit can change a field's type, and never passes through
          // `useDocumentDialogs`, so it drops the field-suggestion sample itself.
          invalidateSampleSchemaCache(a.connectionId, a.dbName, a.collection);
          // Re-runs the tab edited, not whichever has focus when the write
          // lands: a bare `run()` would refresh the wrong tab if focus moved
          // while the request was in flight. Resolved live, so a tab closed
          // meanwhile resolves without running anything else.
          const rerunEdited = (): Promise<void> => {
            const target = resolveRunnerTarget(a.id);
            return target ? run(undefined, target) : Promise.resolve();
          };
          // Returned (not fired-and-forgotten): the boolean Quick Edit
          // toggle stays disabled off this same promise (`TableCell`'s
          // `pendingBoolean`) until the row it reads its checked state from
          // actually reflects the write — resolving before the re-run lands
          // would re-enable it against the stale value, and a second click
          // there would guard its compare-and-set on that stale value too.
          const refreshed = rerunEdited();
          offerUndo('Field updated', auditId, () => {
            invalidateSampleSchemaCache(a.connectionId, a.dbName, a.collection);
            void rerunEdited();
          });
          return refreshed.then(() => OK);
        })
        .catch((e: unknown): UpdateFieldOutcome => {
          const message = getErrorMessage(e, 'Update failed');
          notify.error(message, { title: 'Update failed' });
          return { ok: false, message };
        });
    },
    [activeCollectionRef, resolveRunnerTarget, run],
  );
  const workspaceActions = React.useMemo<CollectionWorkspaceActions>(
    () => ({
      patch: patchActiveCollection,
      patchWith: patchActiveCollectionWith,
      run: runActiveCollection,
      cancel: cancelActiveCollection,
      openEdit,
      openDelete: setDeleteDoc,
      openDeleteAll: openDeleteAllModal,
      openUpdateAll: openUpdateAllModal,
      openInsert: openInsertModal,
      openSave: openSaveModal,
      expandBuilder,
      updateField,
      openDuplicate,
      openCreateIndex,
    }),
    [
      patchActiveCollection,
      patchActiveCollectionWith,
      runActiveCollection,
      cancelActiveCollection,
      openEdit,
      setDeleteDoc,
      openDeleteAllModal,
      openUpdateAllModal,
      openInsertModal,
      openSaveModal,
      expandBuilder,
      updateField,
      openDuplicate,
      openCreateIndex,
    ],
  );
  const workspaceMeta = React.useMemo<CollectionWorkspaceMeta | null>(
    () =>
      activeCollection
        ? {
            connectionId: activeCollection.connectionId,
            dbName: activeCollection.dbName,
            collection: activeCollection.collection,
            tabId: activeCollection.id,
            isLoading: showLoading,
          }
        : null,
    [activeCollection, showLoading],
  );
  // `actions` is the `workspaceActions` reference itself, not a rewrap, so
  // its identity only changes when that memo's own deps do.
  const panelBodyCollection = React.useMemo<PanelBodyCollectionProps | null>(
    () =>
      activeCollection && workspaceMeta
        ? {
            tab: activeCollection,
            meta: workspaceMeta,
            actions: workspaceActions,
            view: activeView,
            aggregationState,
            schemaState,
            suggestionContext: collectionSuggestionContext,
            savedRefreshKey,
          }
        : null,
    [
      activeCollection,
      workspaceMeta,
      workspaceActions,
      activeView,
      aggregationState,
      schemaState,
      collectionSuggestionContext,
      savedRefreshKey,
    ],
  );
  useRegisterCommands(
    [
      {
        id: 'tab.new',
        title: 'New tab…',
        group: 'workspace',
        shortcut: '⌘T',
        keywords: ['open', 'collection'],
        when: (ctx) => ctx.pathname === '/workspace',
        perform: () => setNewTabOpen(true),
      },
      {
        id: 'tab.new.aggregation',
        title: 'New aggregation tab on this collection',
        group: 'workspace',
        keywords: ['pipeline', 'aggregate'],
        when: () => activeCollectionRef.current !== null,
        perform: () => {
          const a = activeCollectionRef.current;
          if (!a) return;
          void tabsRef.current.openAggregation({
            connectionId: a.connectionId,
            dbName: a.dbName,
            collection: a.collection,
          });
        },
      },
      {
        id: 'tab.close',
        title: 'Close current tab',
        group: 'workspace',
        shortcut: '⌘W',
        when: () => activeRef.current !== null,
        perform: () => {
          const a = activeRef.current;
          if (a) void tabsRef.current.close(a.id);
        },
      },
      {
        id: 'tab.pin.toggle',
        // Reads `active` directly, not via the ref — useLatest lags by one render.
        title: active?.pinned ? 'Unpin current tab' : 'Pin current tab',
        group: 'workspace',
        keywords: ['pinned', 'sticky'],
        when: () => activeRef.current !== null,
        perform: () => {
          const a = activeRef.current;
          if (a) void tabsRef.current.setPinned(a.id, !a.pinned);
        },
      },
      {
        id: 'shell.toggle',
        title: shellOpen ? 'Close Shell' : 'Open Shell',
        group: 'workspace',
        keywords: ['shell', 'mongosh', 'repl', 'terminal'],
        when: () => focusedConnectionRef.current !== null,
        perform: () => setShellOpen((v) => !v),
      },
      {
        id: 'view.structure.schema',
        title: 'Go to Schema',
        group: 'view',
        keywords: ['structure', 'fields', 'types', 'sample'],
        when: () => activeCollectionRef.current !== null,
        perform: () => {
          const a = activeCollectionRef.current;
          if (!a) return;
          structureScrollRef.current = 'Schema';
          setStructureScrollNonce((n) => n + 1);
          tabsRef.current.setActiveView(a.id, 'structure');
        },
      },
      {
        id: 'view.structure.indexes',
        title: 'Go to Indexes',
        group: 'view',
        keywords: ['structure', 'index'],
        when: () => activeCollectionRef.current !== null,
        perform: () => {
          const a = activeCollectionRef.current;
          if (!a) return;
          structureScrollRef.current = 'Indexes';
          setStructureScrollNonce((n) => n + 1);
          tabsRef.current.setActiveView(a.id, 'structure');
        },
      },
      {
        id: 'query.drawer.toggle',
        title: builderCollapsed ? 'Expand query drawer' : 'Collapse query drawer',
        group: 'query',
        shortcut: '⌘B',
        keywords: ['builder', 'filter', 'panel', 'sidebar', 'saved', 'recent'],
        // Builder is aria-hidden outside documents view and absent for script tabs.
        when: () =>
          activeCollectionRef.current !== null &&
          (activeCollectionRef.current.state.activeView ?? 'documents') === 'documents',
        perform: toggleBuilderWithFocus,
      },
      {
        id: 'query.run',
        title: 'Run query',
        group: 'query',
        shortcut: '⌘↵',
        keywords: ['execute', 'find'],
        when: () => activeCollectionRef.current !== null,
        perform: () => { void queryRunner.run(); },
      },
      {
        // Registered here, not in BuilderPane, which is unmounted while collapsed.
        id: 'query.save',
        title: 'Save query',
        group: 'query',
        keywords: ['bookmark', 'persist'],
        when: () => activeCollectionRef.current !== null,
        perform: () => setQueryBarSaveOpen(true),
      },
      {
        id: 'query.copy',
        title: 'Copy MQL to clipboard',
        group: 'query',
        keywords: ['copy', 'filter'],
        when: () => {
          const a = activeCollectionRef.current;
          return !!a && (a.state.queryRaw ?? '').trim().length > 0;
        },
        perform: () => {
          const raw = activeCollectionRef.current?.state.queryRaw ?? '';
          if (raw) void copyToClipboard(raw, 'Query copied to the clipboard.');
        },
      },
      {
        id: 'doc.insert',
        title: 'Insert document…',
        group: 'workspace',
        keywords: ['insert', 'add', 'new', 'document', 'create'],
        when: () =>
          activeCollectionRef.current !== null &&
          activeCollectionRef.current.state.activeView === 'documents',
        perform: () => openInsertModal(),
      },
      {
        id: 'references.configure',
        title: 'Configure references',
        group: 'references',
        keywords: ['link', 'foreign', 'lookup'],
        when: () => activeCollectionRef.current !== null,
        perform: () => setRefEditorOpen(true),
      },
      ...(['Tree', 'JSON', 'Table'] as const).map((mode) => ({
        id: `view.mode.${mode.toLowerCase()}`,
        title: `Show results as ${mode}`,
        group: 'view' as const,
        keywords: ['view'],
        when: () =>
          // eslint-disable-next-line react-hooks/refs
          !!activeCollectionRef.current && activeCollectionRef.current.state.view !== mode,
        perform: () => {
          const a = activeCollectionRef.current;
          // eslint-disable-next-line react-hooks/refs
          if (a) tabsRef.current.patchCollectionState(a.id, { view: mode });
        },
      })),
    ],
    [active?.pinned, builderCollapsed, shellOpen, toggleBuilderWithFocus],
  );

  // `⌘K → orders`-style commands for every collection of the focused
  // Connection. The sweep fills the navigator's own cache, so the navigator
  // never fetches what the palette already has, and the reverse.
  const { tree: navigatorTree, loadDbs, loadColls } = navigatorData;
  const focusedCache = focusedConnectionId
    ? ownGet(navigatorTree.caches, focusedConnectionId)
    : undefined;
  const focusedIsConnected = focusedConnection?.status === 'connected';
  // One attempt per database per database list: a database whose listing
  // failed is not retried on every render, and a refreshed list sweeps again.
  const sweptRef = React.useRef<{ dbs: DbInfo[] | null; done: Set<string> }>({
    dbs: null,
    done: new Set(),
  });
  // Databases a reconnect left with a stale listing: swept again although cached.
  const relistRef = React.useRef<{ id: string | null; names: Set<string> }>({ id: null, names: new Set() });
  const [relists, setRelists] = React.useState(0);
  React.useEffect(() => {
    if (!focusedConnectionId || !focusedIsConnected) return;
    if (reconnectedRef.current.delete(focusedConnectionId)) {
      // The expanded databases were already re-listed by the status sync.
      const id = focusedConnectionId;
      const expanded = ownGet(navigatorTree.expanded, id) ?? {};
      void loadDbs(id, { force: true }).then((dbs) => {
        const names = (dbs ?? []).filter((d) => !ownGet(expanded, d.name)).map((d) => d.name);
        relistRef.current = { id, names: new Set(names) };
        sweptRef.current = { dbs: null, done: new Set() };
        setRelists((n) => n + 1);
      });
      return;
    }
    const c = focusedCache;
    if (!c?.dbs) {
      if (!c?.dbsLoading && !c?.err) void loadDbs(focusedConnectionId);
      return;
    }
    if (sweptRef.current.dbs !== c.dbs) sweptRef.current = { dbs: c.dbs, done: new Set() };
    const { done } = sweptRef.current;
    const relist = relistRef.current.id === focusedConnectionId ? relistRef.current.names : null;
    // A few listings at a time, the navigator's own included, so a server with
    // hundreds of databases is not asked for all of them at once. Each one that
    // settles changes the cache and so runs this again for the next.
    let inFlight = c.dbs.filter((d) => ownGet(c.collsLoading, d.name)).length;
    for (const d of c.dbs) {
      if (inFlight >= SWEEP_CONCURRENCY) break;
      if (done.has(d.name) || ownGet(c.collsLoading, d.name)) continue;
      if (ownGet(c.colls, d.name) && !relist?.has(d.name)) continue;
      done.add(d.name);
      relist?.delete(d.name);
      inFlight++;
      void loadColls(focusedConnectionId, d.name);
    }
  }, [
    focusedConnectionId,
    focusedIsConnected,
    focusedCache,
    loadDbs,
    loadColls,
    reconnects,
    relists,
    navigatorTree.expanded,
  ]);
  // A disconnected Connection's cache is a snapshot that can't be opened from.
  const paletteCollections = React.useMemo(() => {
    const c = focusedCache;
    if (!focusedIsConnected || !c?.dbs) return [];
    return c.dbs.flatMap((d) =>
      (ownGet(c.colls, d.name) ?? []).map((x) => ({ db: d.name, coll: x.name })),
    );
  }, [focusedCache, focusedIsConnected]);

  const collectionCommands = React.useMemo(
    () =>
      paletteCollections.map(({ db, coll }) => ({
        // Connection-qualified, so the same namespace on another Connection
        // is not "recent".
        id: `tab.open:${focusedConnectionId}:${db}:${coll}`,
        title: `Open: ${db}.${coll}`,
        fuzzyText: `${db}.${coll}`,
        group: 'workspace' as const,
        keywords: ['collection', 'tab', 'new', db, coll],
        hideWhenEmptyQuery: true,
        perform: () => {
          if (focusedConnectionId) {
            void tabsRef.current.openCollection({
              connectionId: focusedConnectionId,
              dbName: db,
              collection: coll,
              reuseExisting: true,
            });
          }
        },
      })),
    [paletteCollections, focusedConnectionId, tabsRef],
  );
  useRegisterCommands(collectionCommands, [collectionCommands]);

  // Keyboard shortcuts
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // Grouped-by-connection order, matching what's on screen (not stored order).
      const ids = groupTabsByConnection(tabs.tabs).flatMap((g) =>
        g.tabs.map((t) => t.id),
      );
      if (e.key === 't') {
        e.preventDefault();
        setNewTabOpen(true);
      } else if (e.key === 'b') {
        // A dialog has no ⌘B handler, so the event bubbles here — must not
        // toggle the drawer behind an open modal. `instanceof`, not a cast:
        // a window/document-dispatched keydown's target may lack `closest`.
        const origin = e.target instanceof HTMLElement ? e.target : null;
        if (origin?.closest('[role="dialog"], [role="alertdialog"]')) return;
        const a = activeCollectionRef.current;
        if (!a || (a.state.activeView ?? 'documents') !== 'documents') return;
        e.preventDefault();
        toggleBuilderWithFocus();
      } else if (e.key === 'w') {
        e.preventDefault();
        if (tabs.activeId) void tabs.close(tabs.activeId);
      } else if (e.key === 'Alt' || e.key === 'Option') {
        // noop
      } else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        const idx = tabs.activeId ? ids.indexOf(tabs.activeId) : 0;
        if (idx === -1) return;
        const next =
          e.key === 'ArrowRight'
            ? ids[(idx + 1) % ids.length]
            : ids[(idx - 1 + ids.length) % ids.length];
        if (next) void tabs.setActive(next);
      } else if (/^[1-9]$/.test(e.key)) {
        const id = ids[Number(e.key) - 1];
        if (id) {
          e.preventDefault();
          void tabs.setActive(id);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tabs, activeCollectionRef, toggleBuilderWithFocus]);

  const handlePick = async (input: {
    connectionId: string;
    dbName: string;
    collection: string;
    initialView: CollectionView;
  }) => {
    setNewTabOpen(false);
    if (input.initialView !== 'aggregation') {
      const tab = await tabs.openCollection({
        connectionId: input.connectionId,
        dbName: input.dbName,
        collection: input.collection,
      });
      if (tab.state.activeView !== input.initialView) {
        tabs.setActiveView(tab.id, input.initialView);
      }
    } else {
      await tabs.openAggregation({
        connectionId: input.connectionId,
        dbName: input.dbName,
        collection: input.collection,
      });
    }
  };

  // Touch-used + connect, no tab: opening one would mean guessing a Database
  // and Collection. Not guarded on "already connected" — re-clicking retries
  // an errored Connection, and a re-connect must rebuild the client after edits.
  const openConnection = React.useCallback((id: string) => {
    void api.conn.touchUsed(id).catch(() => { /* fire-and-forget */ });
    void api.mongo.connect(id).catch(() => { /* status event drives the UI */ });
  }, []);

  // Only the Focused Tab's own Connection auto-connects on launch; every
  // other Connection with tabs stays Dormant, keeping launch fast. Fires at
  // most once, guarded on isConnectionActive so an already-connecting/-connected one isn't re-kicked.
  const launchConnectRef = React.useRef(false);
  React.useEffect(() => {
    if (launchConnectRef.current) return;
    if (tabs.loading || connectionsLoading) return;
    launchConnectRef.current = true;
    if (focusedConnection && !isConnectionActive(focusedConnection.status)) {
      openConnection(focusedConnection.id);
    }
  }, [tabs.loading, connectionsLoading, focusedConnection, openConnection]);

  // Closes one Connection's tabs, surfacing a title on failure rather than
  // swallowing it. Shared by disconnect and delete confirmation flows.
  const closeTabsForConnection = React.useCallback(
    (id: string, errorTitle: string) =>
      tabsRef.current.closeForConnection(id).catch((err: unknown) => {
        notify.error(isIpcError(err) ? err.message : String(err), { title: errorTitle });
      }),
    [tabsRef],
  );

  const openConnectionScreen = React.useCallback(
    (id: string) => navigate(`/connections/${id}`),
    [navigate],
  );

  const connectionDialogs = useConnectionDialogs({
    connections,
    tabsRef,
    closeTabsForConnection,
    refreshConnections,
    removeConnectionLocal,
    openConnection,
    openConnectionScreen,
  });
  const {
    requestDisconnect,
    openEditConnectionModal,
    openDeleteConnectionModal,
    openConnectionTable,
  } = connectionDialogs;

  // A full conn.list() refetch, not scoped to one Connection, registered
  // here for the Data View. Per-connection delete/edit are registered
  // separately by ConnectionPaletteCommands with the id baked in.
  useRegisterCommands(
    [
      {
        id: 'connection.refresh',
        title: 'Refresh connection',
        group: 'connection',
        keywords: ['reload', 'sync'],
        when: (ctx) => ctx.pathname === '/workspace',
        perform: () => { void refreshConnections(); },
      },
    ],
    [refreshConnections],
  );

  // Acts on an `openConnection` nav-state hint (from DetailPanel or the
  // command palette, both mounted where they can't reach this component
  // directly) and opens the collection it optionally names. Runs once per
  // navigation — state is cleared immediately so back/forward doesn't replay it.
  const navState = location.state as
    | {
        openConnectionId?: string;
        openCollection?: { dbName: string; collection: string };
        deleteConnectionId?: string;
        editConnectionId?: string;
      }
    | null;
  const openConnectionId = navState?.openConnectionId ?? null;
  const openCollectionFromNav = navState?.openCollection ?? null;
  React.useEffect(() => {
    if (!openConnectionId) return;
    navigate(location.pathname, { replace: true, state: null });
    openConnection(openConnectionId);
    if (!openCollectionFromNav) return;
    void tabsRef.current
      .openCollection({
        connectionId: openConnectionId,
        dbName: openCollectionFromNav.dbName,
        collection: openCollectionFromNav.collection,
      })
      .catch((err: unknown) => {
        notify.error(isIpcError(err) ? err.message : String(err), {
          title: 'Could not open the collection',
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openConnectionId]);

  // Same nav-state handoff as openConnectionId, for the palette's
  // per-connection delete/edit rows (mounted where they can't call these
  // modal-openers directly). Held until connectionsLoading clears — acting
  // before `connections` first loads would silently drop the intent.
  const deleteConnectionId = navState?.deleteConnectionId ?? null;
  const editConnectionId = navState?.editConnectionId ?? null;
  React.useEffect(() => {
    if (!deleteConnectionId || connectionsLoading) return;
    navigate(location.pathname, { replace: true, state: null });
    openDeleteConnectionModal(deleteConnectionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteConnectionId, connectionsLoading]);
  React.useEffect(() => {
    if (!editConnectionId || connectionsLoading) return;
    navigate(location.pathname, { replace: true, state: null });
    openEditConnectionModal(editConnectionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editConnectionId, connectionsLoading]);

  // ⌘E opens the Connections table from anywhere in the Data View, not only
  // from inside the Switcher (which handles its own ⌘E and stops it there).
  // Two places keep ⌘E: an open dialog, and an Aggregation tab, where it is
  // Explain. Ctrl counts too, outside text fields.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key !== 'e' && e.key !== 'E') return;
      const origin = e.target instanceof HTMLElement ? e.target : null;
      if (origin?.closest('[role="dialog"], [role="alertdialog"]')) return;
      // In a text field a bare Ctrl+E is macOS's end-of-line (CodeMirror's
      // too); there only ⌘ opens the table.
      if (!e.metaKey && origin?.closest('input, textarea, [contenteditable]')) return;
      if (activeCollectionRef.current?.state.activeView === 'aggregation') return;
      e.preventDefault();
      // Focus goes back to wherever the user was when the table closes.
      openConnectionTable('', origin);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeCollectionRef, openConnectionTable]);

  // Shared by both ConnectionSwitcher instances so they can't drift apart.
  const switcherProps = {
    connections,
    focusedConnectionId,
    onSwitch: openConnection,
    onManage: openConnectionScreen,
    onDisconnect: requestDisconnect,
    onEdit: openEditConnectionModal,
    onDelete: openDeleteConnectionModal,
    onExpand: openConnectionTable,
  };

  // mode="static" (CSS grid), not the default "fixed" (position: fixed) —
  // the Electron viewport is exactly 100vh and inner panes rely on
  // flex + overflow: hidden, which fixed positioning doesn't tolerate.
  return (
    <AppShell
      mode="static"
      header={{ height: 80 }}
      navbar={{
        // Manual width, not Mantine's `collapsed` flag (display:none has no
        // room for an expand affordance) — a 40px rail keeps it visible.
        width: sidebarCollapsed ? 40 : leftWidth,
        // Must be truthy or Mantine's static-mode navbar CSS vars never emit,
        // pushing the navbar below Main in grid auto-placement.
        breakpoint: 'xs',
      }}
      padding={0}
      withBorder={false}
      style={{
        height: '100vh',
        // Each pane owns its own scroll region; Mantine's default `overflow:
        // auto` here would scroll the whole shell as one unit instead.
        overflow: 'hidden',
        background: T.bg,
        color: T.text,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <ShellSection
        dark={dark}
        toggle={toggle}
        focusedConnection={focusedConnection}
        switcherProps={switcherProps}
        settings={settings}
        palette={palette}
        shellOpen={shellOpen}
        setShellOpen={setShellOpen}
        tabs={tabs}
        connections={connections}
        connectionsWithTabs={connectionsWithTabs}
        active={active}
        scratchConnectionId={scratchConnectionId}
        hints={hints}
        openConnection={openConnection}
        setNewTabOpen={setNewTabOpen}
        panelPrefs={panelPrefs}
        connectionDialogs={connectionDialogs}
        navigatorData={navigatorData}
        onOpenReferences={() => setRefEditorOpen(true)}
      />

      <PanelBody
        panelPrefs={panelPrefs}
        collectionTabActions={collectionTabActions}
        documentDialogs={documentDialogs}
        refDrawer={{
          refStack, setRefStack,
          refDrawerPinned, setRefDrawerPinned,
          refEditorOpen, setRefEditorOpen,
          refHover, handleRefHover, handleRefHoverLeave, handleRefOpen,
        }}
        tabs={tabs}
        referenceRules={referenceRules}
        shellOpen={shellOpen}
        setShellOpen={setShellOpen}
        focusedConnection={focusedConnection}
        initialLoadPending={initialLoadPending}
        anyConnectionOpen={anyConnectionOpen}
        switcherProps={switcherProps}
        setNewTabOpen={setNewTabOpen}
        active={active}
        openConnection={openConnection}
        activeScript={activeScript}
        collection={panelBodyCollection}
        dark={dark}
        builderPanelRef={builderPanelRef}
        toggleBuilder={toggleBuilder}
        notchRef={notchRef}
        structureInitialCreate={
          createIndexRequest?.tabId === activeCollection?.id ? createIndexRequest : null
        }
        onStructureInitialCreateConsumed={onCreateIndexConsumed}
      />

      <DialogStack
        newTabOpen={newTabOpen}
        setNewTabOpen={setNewTabOpen}
        scratchConnectionId={scratchConnectionId}
        onPickNewTab={handlePick}
        documentDialogs={documentDialogs}
        connectionDialogs={connectionDialogs}
        connections={connections}
        activeCollection={activeCollection}
        focusedConnectionReadOnly={focusedConnection?.readOnly ?? false}
        referenceRules={referenceRules}
        refDrawer={{ refHover, refEditorOpen, setRefEditorOpen }}
        queryBarSaveOpen={queryBarSaveOpen}
        setQueryBarSaveOpen={setQueryBarSaveOpen}
        setSavedRefreshKey={setSavedRefreshKey}
        expandBuilder={expandBuilder}
        patchActiveCollection={patchActiveCollection}
        refsConfigureHint={refsConfigureHint}
        tabsPinHint={tabsPinHint}
        savedCreateHint={savedCreateHint}
        runExecuteHint={runExecuteHint}
      />
    </AppShell>
  );
}

export default function Workspace() {
  const [dark, toggle] = useTheme();
  return (
      <DarkCtx.Provider value={dark}>
        <ThemeBridgeCtx.Provider value={{ dark, toggle }}>
          <WorkspaceInner />
        </ThemeBridgeCtx.Provider>
      </DarkCtx.Provider>
  );
}

const ThemeBridgeCtx = React.createContext<{ dark: boolean; toggle: () => void }>({
  dark: false,
  toggle: () => {},
});

// eslint-disable-next-line react-refresh/only-export-components
export function useWorkspaceThemeBridge() {
  return React.useContext(ThemeBridgeCtx);
}
