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
import { logFailure } from '../utils/rendererLog';
import { notify } from '../theme/notifications';
import { ejsonParse, isPlainDocument } from '../utils/ejson';
import { buildUpdateRequest, setAtSegments } from './Workspace/documentDiff';
import { copyToClipboard } from '../utils/clipboard';
import { BUILDER_MIN_PCT } from './Workspace/panelSizes';
import { ONE_PANEL_BUILDER_PX } from './Workspace/sidePanels';
import type { CollectionView, SavedQuerySummary, WorkspaceTab } from '@shared/types';
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
import { recordFilterStep } from './Workspace/filterStep';
import { parsePastedObjectId } from '../commands/pastedId';
import type { RunnerTarget } from './Workspace/useQueryRunner';
import { useWorkspacePanelPrefs } from './Workspace/useWorkspacePanelPrefs';
import { useNavigatorData, useNavigatorStatusSync } from './Workspace/useNavigatorData';
import { ownGet } from '../utils/ownProperty';
import type { DbInfo } from '@shared/ipc';
import { useConnectionDialogs } from './Workspace/useConnectionDialogs';
import { useDocumentDialogs } from './Workspace/useDocumentDialogs';
import { isViewCollection } from './Workspace/isViewCollection';
import { offerUndo } from './Workspace/offerUndo';
import { useCollectionTabActions } from './Workspace/useCollectionTabActions';
import { DialogStack } from './Workspace/DialogStack';
import { ShellSection } from './Workspace/ShellSection';
import { PanelBody, type PanelBodyCollectionProps } from './Workspace/PanelBody';
import type { IndexCreateRequest } from './IndexesTab';
import { useSettings } from './SettingsContext';
import { useRegisterCommands } from '../commands/useRegisterCommands';
import { useRegisterObjects } from '../commands/useRegisterObjects';
import type { PaletteObject } from '../commands/types';
import { collectionObject } from './Workspace/collectionObject';
import { databaseObject, isPaletteSaved, savedObject, tabObject } from './Workspace/paletteObjects';
import { activateTab, closeTabGuarded, tabLabel } from './Workspace/tabActions';
import { confirmDeleteSaved, openSavedPipeline } from './Workspace/savedActions';
import { requestFilter, requestSavedRename, requestTab, type FilterRequest } from './Workspace/tabRequest';
import { hydrateFindPayload, type LegacySavedFindPayload } from './Workspace/legacyBuilder';
import { usePaletteOpen } from '../commands/paletteOpenState';
import type { NavigatorDialogRequest, NavigatorRevealInput } from './Workspace/DbCollectionNavigator';
import { useLatest } from '../commands/useLatest';
import { usePaletteApi } from '../commands/CommandPalette';
import { useFeatureHint } from '../hints/useFeatureHint';
import { useHints } from '../hints/HintsContext';
import { FeatureHint } from '../hints/FeatureHint';
import { consumeLaunchRestore, isLaunchRestoreConsumed, readLaunchTabCount } from '../hints/launchRestore';
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
import { getStructureEntries, invalidateSampleSchemaCache } from '../features/fieldSuggestions/sources/sampleSchemaSource';

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
    onePanelOnly,
    sidebarCollapsed,
    builderCollapsed, commitBuilderCollapsed,
  } = panelPrefs;
  const [shellOpen, setShellOpen] = React.useState(false);
  const builderPanelRef = React.useRef<PanelImperativeHandle>(null);
  const [savedRefreshKey, setSavedRefreshKey] = React.useState(0);
  const [queryBarSaveOpen, setQueryBarSaveOpen] = React.useState(false);
  const settings = useSettings();
  const palette = usePaletteApi();

  const active = tabs.tabs.find((t) => t.id === tabs.activeId) ?? null;
  const activeCollection = active?.kind === 'collection' ? active : null;
  const activeScript = active?.kind === 'script' ? active : null;
  const activeView: CollectionView =
    activeCollection?.state.activeView ?? 'documents';

  // `resize()` treats a number as pixels and a string as a percentage —
  // `resize(26)` is 26px, not 26%. `expand()` alone reopens at the collapsed
  // 4% rail, so the width is set explicitly from the stored split after.
  const innerHSplitRef = useLatest(innerHSplit);
  const restoreBuilderWidth = React.useCallback(() => {
    const handle = builderPanelRef.current;
    if (!handle) return;
    handle.expand();
    if (onePanelOnly) {
      handle.resize(ONE_PANEL_BUILDER_PX);
      return;
    }
    // Floor at BUILDER_MIN_PCT in case a stored split is narrower than draggable.
    const pct = Math.max(innerHSplitRef.current, BUILDER_MIN_PCT);
    handle.resize(`${pct}%`);
  }, [innerHSplitRef, onePanelOnly]);

  const toggleBuilder = React.useCallback(() => {
    const next = !builderCollapsed;
    commitBuilderCollapsed(next);
    if (next) builderPanelRef.current?.collapse();
    else restoreBuilderWidth();
  }, [builderCollapsed, commitBuilderCollapsed, restoreBuilderWidth]);

  // A window crossing the one-panel width, or the navigator opening while it is
  // narrow, changes the drawer without going through the toggle above. Crossing
  // back also has to put the stored width back, not just the open state. On the
  // next frame: the navigator changes width in this same commit, and a size set
  // before the panel group has measured that would be taken against its old width.
  // Leaving Documents shuts the drawer the same way, without writing the pref, so
  // coming back restores it at its stored width (PanelBody keeps it mounted).
  const builderShut = builderCollapsed || activeView !== 'documents';
  const builderSyncedOnce = React.useRef(false);
  React.useEffect(() => {
    if (!builderSyncedOnce.current) {
      builderSyncedOnce.current = true;
      return undefined;
    }
    const frame = requestAnimationFrame(() => {
      if (builderShut) builderPanelRef.current?.collapse();
      else restoreBuilderWidth();
    });
    return () => cancelAnimationFrame(frame);
  }, [builderShut, restoreBuilderWidth]);

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
  const openConnectionsKey = openConnections.map((c) => `${c.id}\u0000${c.name}`).join('\u0001');
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

  // Dirty pipelines, for the quit question. Keyed on the count, so an edit
  // that leaves it unchanged sends nothing. Nothing is sent before the tabs
  // have loaded, or when they failed to: the empty list then is not a count,
  // and a 0 would overwrite the last real report. No reset on unmount: the
  // tabs outlive this page, and quitting from elsewhere still loses them when
  // they are not restored at launch (main decides that).
  const tabsKnown = !tabs.loading && tabs.error === null;
  const dirtyPipelineCount = tabs.tabs.filter(
    (t) => t.kind === 'collection' && t.state.aggregation?.dirty,
  ).length;
  React.useEffect(() => {
    if (!tabsKnown) return;
    api.app
      .setUnsavedWork({ source: 'pipelines', count: dirtyPipelineCount })
      .catch((err) => logFailure('reporting unsaved pipelines', err));
  }, [tabsKnown, dirtyPipelineCount]);

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

  // Tabs the previous session left behind, as main restored them at launch.
  const [restoredAtLaunch, setRestoredAtLaunch] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    void readLaunchTabCount().then((n) => {
      if (!cancelled && n > 0 && !isLaunchRestoreConsumed()) setRestoredAtLaunch(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const startupRestoreHint = useFeatureHint(
    'startup.restore',
    restoredAtLaunch && tabs.tabs.length > 0,
  );
  const startupRestoreVisible = startupRestoreHint.visible;
  React.useEffect(() => {
    if (startupRestoreVisible) consumeLaunchRestore();
  }, [startupRestoreVisible]);

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
      // The same options `useQueryRunner` records its key with (W14 §9).
      collation: compiled.collation,
      hint: compiled.hint,
      maxTimeMS: compiled.maxTimeMS,
      readPreference: compiled.readPreference,
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
  // A saved query the palette is loading into a tab (X07 §13.5), or a query
  // it is starting there (§13.6). A tab just opened is not in the tab state
  // until the render after `openCollection` settles, so the load waits for it
  // there; until then the tab must not auto-run its default `{}` query.
  const pendingSavedRef = React.useRef<
    | { kind: 'saved'; tabId: string; payload: LegacySavedFindPayload; run: boolean }
    | { kind: 'filter'; tabId: string; request: FilterRequest }
    | { kind: 'rename'; tabId: string; savedId: string }
    // `before` is the tab list the open was asked against: the run waits for a newer one.
    | { kind: 'runPipeline'; tabId: string; savedId: string; before: WorkspaceTab[] }
    | null
  >(null);
  const [pendingSavedTick, setPendingSavedTick] = React.useState(0);
  // A tab the palette switched to Documents to start a query on: the switch
  // re-fires the auto-run below, once, after the pending load has cleared.
  const skipAutoRunRef = React.useRef<string | null>(null);
  // Bumped by each saved query the palette loads, added to PanelBody's own load counter.
  const [savedLoadGen, setSavedLoadGen] = React.useState(0);
  React.useEffect(() => {
    if (!activeCollection) return;
    if (activeView !== 'documents') return;
    if (skipAutoRunRef.current === activeCollection.id) {
      skipAutoRunRef.current = null;
      return;
    }
    if (activeCollection.state.lastRun) return;
    if (!isDefaultQueryState(activeCollection.state)) return;
    if (pendingSavedRef.current?.tabId === activeCollection.id) return;
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
  // A tab the palette has just opened is not in the tab state until the next
  // render, and a view switch on an unknown tab is dropped: it waits for it.
  const pendingStructureRef = React.useRef<{ tabId: string; section: 'Indexes' | 'Schema' } | null>(null);
  const showStructure = React.useCallback(
    (tabId: string, section: 'Indexes' | 'Schema') => {
      if (!tabsRef.current.tabs.some((t) => t.id === tabId)) {
        pendingStructureRef.current = { tabId, section };
        return;
      }
      pendingStructureRef.current = null;
      structureScrollRef.current = section;
      setStructureScrollNonce((n) => n + 1);
      tabsRef.current.setActiveView(tabId, 'structure');
    },
    [tabsRef],
  );
  React.useEffect(() => {
    const pending = pendingStructureRef.current;
    if (pending && tabs.tabs.some((t) => t.id === pending.tabId)) showStructure(pending.tabId, pending.section);
  }, [tabs.tabs, showStructure]);
  React.useEffect(() => {
    const target = structureScrollRef.current;
    if (!target || activeView !== 'structure') return;
    structureScrollRef.current = null;
    const find = () =>
      document.querySelector<HTMLElement>(`[role="region"][aria-label="${target}"]`);
    // jsdom has no scrollIntoView.
    const scroll = (el: HTMLElement) => el.scrollIntoView?.({ block: 'start' });
    const now = find();
    if (now) {
      scroll(now);
      return;
    }
    // Structure holds its sections back until the collection details settle,
    // so the region may mount after this effect; wait for it, but not forever.
    const observer = new MutationObserver(() => {
      const el = find();
      if (!el) return;
      observer.disconnect();
      scroll(el);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setTimeout(() => observer.disconnect(), 5000);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
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
  const activeIsView =
    activeCollection !== null &&
    isViewCollection(
      navigatorData.tree,
      activeCollection.connectionId,
      activeCollection.dbName,
      activeCollection.collection,
    );
  // The target comes from the dialog that was opened, not from the focused tab:
  // the focus can move while a dialog is open.
  const openCollectionTab = React.useCallback(
    (target: { connectionId: string; dbName: string; collection: string }) => {
      void tabsRef.current.openCollection({ ...target, reuseExisting: true });
    },
    [tabsRef],
  );
  const documentDialogs = useDocumentDialogs({
    activeCollectionRef,
    queryRunner,
    activeTabId: tabs.activeId,
    resolveRunnerTarget,
    readOnly: focusedConnection?.readOnly ?? false,
    isView: activeIsView,
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
            isView: activeIsView,
          }
        : null,
    [activeCollection, showLoading, activeIsView],
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
          if (a) void closeTabGuarded(tabsRef.current, a.id);
        },
      },
      {
        id: 'tab.pin.toggle',
        title: 'Pin tab',
        group: 'workspace',
        keywords: ['pinned', 'sticky', 'unpin', 'current', 'toggle'],
        // Reads `active` directly, not via the ref — useLatest lags by one render.
        toggle: { checked: !!active?.pinned },
        when: () => activeRef.current !== null,
        perform: () => {
          const a = activeRef.current;
          if (a) void tabsRef.current.setPinned(a.id, !a.pinned);
        },
      },
      {
        id: 'shell.toggle',
        title: 'Shell',
        group: 'workspace',
        keywords: ['mongosh', 'repl', 'terminal', 'open', 'close', 'toggle'],
        toggle: { checked: shellOpen },
        when: () => focusedConnectionRef.current !== null,
        perform: () => setShellOpen((v) => !v),
      },
      {
        id: 'view.structure.schema',
        title: 'Go to schema',
        group: 'view',
        keywords: ['structure', 'fields', 'types', 'sample'],
        when: () => activeCollectionRef.current !== null,
        perform: () => {
          const a = activeCollectionRef.current;
          if (a) showStructure(a.id, 'Schema');
        },
      },
      {
        id: 'view.structure.indexes',
        title: 'Go to indexes',
        group: 'view',
        keywords: ['structure', 'index'],
        when: () => activeCollectionRef.current !== null,
        perform: () => {
          const a = activeCollectionRef.current;
          if (a) showStructure(a.id, 'Indexes');
        },
      },
      {
        id: 'query.drawer.toggle',
        title: 'Query drawer',
        group: 'query',
        shortcut: '⌘B',
        keywords: ['builder', 'filter', 'panel', 'sidebar', 'saved', 'recent', 'expand', 'collapse', 'toggle'],
        toggle: { checked: !builderCollapsed },
        // Builder is shut and hidden outside documents view and absent for script tabs.
        when: () =>
          activeCollectionRef.current !== null &&
          (activeCollectionRef.current.state.activeView ?? 'documents') === 'documents',
        // The palette stays open on a toggle, so focus stays in it: ⌘B moves
        // focus with the drawer, this does not.
        perform: toggleBuilder,
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
        when: () => activeCollectionRef.current !== null,
        // An empty filter is `{}` once the builder has written one, as the live count reads it.
        disabledReason: () => {
          const raw = (activeCollectionRef.current?.state.queryRaw ?? '').trim();
          return raw === '' || raw === '{}' ? 'Type a filter first' : null;
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
        // Worded like the view document dialog's note.
        disabledReason: () => (activeIsView ? "This is a view, so documents can't be inserted here" : null),
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
    [active?.pinned, builderCollapsed, shellOpen, toggleBuilder, activeIsView, showStructure],
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
  // A collection dialog the navigator owns (Rename, Import, Drop), opened from
  // the palette. The navigator is unmounted while the sidebar is collapsed, so
  // the sidebar opens first: the dialog is the navigator's own.
  const [navigatorDialogRequest, setNavigatorDialogRequest] = React.useState<NavigatorDialogRequest | null>(null);
  const clearNavigatorDialog = React.useCallback(() => setNavigatorDialogRequest(null), []);
  const panelPrefsRef = useLatest(panelPrefs);
  const requestNavigatorDialog = React.useCallback(
    (request: NavigatorDialogRequest) => {
      if (panelPrefsRef.current.sidebarCollapsed) panelPrefsRef.current.toggleSidebar();
      setNavigatorDialogRequest(request);
    },
    [panelPrefsRef],
  );
  // The navigator's Reveal: a tab's "Reveal in sidebar" asks for a collection,
  // the palette's Reveal in navigator for a database on its own.
  const [navigatorRevealRequest, setNavigatorRevealRequest] = React.useState<NavigatorRevealInput | null>(null);
  const { dispatch: navigatorDispatch } = navigatorData;
  const revealDatabase = React.useCallback(
    (connectionId: string, dbName: string) => {
      if (panelPrefsRef.current.sidebarCollapsed) panelPrefsRef.current.toggleSidebar();
      navigatorDispatch({ type: 'expandedConnSet', id: connectionId });
      navigatorDispatch({ type: 'dbExpandedSet', connectionId, dbName, value: true });
      setNavigatorRevealRequest({ connectionId, dbName });
    },
    [panelPrefsRef, navigatorDispatch, setNavigatorRevealRequest],
  );

  // One Collection object per collection, and one Database object per
  // database, of every connected Connection (X07 §13.5), from what the
  // navigator has already listed: the sweep above lists the focused one, and
  // the palette asks nothing for the others. A Connection that is not
  // connected contributes nothing; its cache is a snapshot that can't be
  // opened from. Each action calls what the navigator's menu or the tab calls.
  const connectionsRef = useLatest(connections);
  // Query… and Filter by field…: the tab's drawer takes the request once the tab is in the state.
  const startQuery = React.useCallback((tabId: string, request: FilterRequest) => {
    pendingSavedRef.current = { kind: 'filter', tabId, request };
    setPendingSavedTick((n) => n + 1);
  }, [setPendingSavedTick]);
  const namespaceObjects = React.useMemo((): PaletteObject[] => {
    // Read when an action runs, never during render.
    const tabs = () => tabsRef.current;
    const objects: PaletteObject[] = [];
    for (const conn of openConnections) {
      const cache = ownGet(navigatorTree.caches, conn.id);
      if (!cache?.dbs) continue;
      const connectionId = conn.id;
      for (const d of cache.dbs) {
        objects.push(
          // eslint-disable-next-line react-hooks/refs
          databaseObject({
            connectionId,
            db: d.name,
            connectionName: conn.name,
            requestDialog: requestNavigatorDialog,
            reveal: revealDatabase,
          }),
        );
        for (const x of ownGet(cache.colls, d.name) ?? []) {
          objects.push(
            // eslint-disable-next-line react-hooks/refs
            collectionObject({
              connectionId,
              db: d.name,
              coll: x.name,
              isView: x.type === 'view',
              connectionName: conn.name,
              tabs,
              showStructure,
              requestDialog: requestNavigatorDialog,
              // This Connection, not the focused one: read when an action runs.
              dormant: () => isKnownNotConnected(connectionsRef.current.find((c) => c.id === connectionId)),
              running: queryRunner.isRunning,
              sampleSchema: () => getStructureEntries(connectionId, d.name, x.name),
              startQuery,
            }),
          );
        }
      }
    }
    return objects;
    // `openConnections` is a fresh array each render: key on what it says.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openConnectionsKey, navigatorTree.caches, tabsRef, showStructure, requestNavigatorDialog, revealDatabase, connectionsRef, queryRunner.isRunning, startQuery]);
  useRegisterObjects(namespaceObjects, [namespaceObjects]);

  // Commands mirroring a control that had none (X07 §13.5), each gated as
  // that control is shown or disabled and calling that control's handler.
  const scratchConnectionIdRef = useLatest(scratchConnectionId);
  useRegisterCommands(
    [
      {
        // The tab strip's `+ Script`, which names no Connection when none is
        // focused and several are open.
        id: 'tab.new.script',
        title: 'New script tab',
        group: 'workspace',
        keywords: ['mongosh', 'shell', 'javascript'],
        when: (ctx) => ctx.pathname === '/workspace',
        disabledReason: () => (scratchConnectionIdRef.current ? null : 'Open a tab on the Connection first'),
        perform: () => {
          const connectionId = scratchConnectionIdRef.current;
          if (connectionId) void tabsRef.current.openScript({ connectionId });
        },
      },
      {
        // The navigator's database menu's Create collection, on the tab's database.
        id: 'collection.create',
        title: 'Create collection…',
        group: 'workspace',
        keywords: ['new', 'add'],
        when: () => activeCollectionRef.current !== null,
        perform: () => {
          const a = activeCollectionRef.current;
          if (a) requestNavigatorDialog({ connectionId: a.connectionId, dbName: a.dbName, dialog: 'createCollection' });
        },
      },
      {
        // The Run menu's Explain › queryPlanner, disabled when Run is.
        id: 'query.explain',
        title: 'Explain query',
        group: 'query',
        keywords: ['plan', 'index', 'performance'],
        when: () =>
          activeCollectionRef.current !== null &&
          (activeCollectionRef.current.state.activeView ?? 'documents') === 'documents',
        disabledReason: () => {
          const a = activeCollectionRef.current;
          if (!a) return null;
          // The Connect pane stands in for the query bar: nothing would answer.
          const conn = focusedConnectionRef.current;
          if (isKnownNotConnected(conn)) return `Connect to ${conn?.name ?? 'the connection'} first`;
          if (queryRunner.isRunning(a.id)) return 'A query is running';
          return findProblem(a.state);
        },
        perform: () => {
          const a = activeCollectionRef.current;
          if (a) requestTab('explain', a.id);
        },
      },
      {
        // The Indexes section's `+ New index`.
        id: 'index.create',
        title: 'Create index…',
        group: 'view',
        keywords: ['new', 'add', 'structure'],
        when: () => activeCollectionRef.current !== null,
        // A view's Indexes section shows its note in place of `+ New index`.
        disabledReason: () => (activeIsView ? "This is a view, so indexes can't be created here" : null),
        perform: () => openCreateIndex(null),
      },
    ],
    [requestNavigatorDialog, openCreateIndex, queryRunner.isRunning, activeIsView],
  );

  // `⌘K`, paste a document's `_id`: filter the tab in front to it. The row
  // exists only for that query, and only with a collection tab in front.
  useRegisterCommands(
    [
      {
        id: 'query.find-pasted-id',
        title: 'Find _id',
        group: 'query',
        when: () => activeCollectionRef.current !== null,
        perform: () => {},
        forQuery: (query) => {
          const a = activeCollectionRef.current;
          const value = parsePastedObjectId(query);
          if (!a || !value) return null;
          return {
            title: `Find _id ${value} in ${a.dbName}.${a.collection}`,
            subtitle: 'Replaces the filter and runs it · Undo puts the old filter back',
            emphasis: value,
            perform: () => {
              const now = activeCollectionRef.current;
              if (!now) return;
              const text = JSON.stringify({ _id: { $oid: value } });
              // One undo step in the drawer's own history, whether or not it is open.
              recordFilterStep(now.id, {
                to: text,
                from: { queryRaw: now.state.queryRaw, filterDraft: now.state.filterDraft },
              });
              // The result shows on Documents only; the switch must not auto-run as well.
              if ((now.state.activeView ?? 'documents') !== 'documents') {
                skipAutoRunRef.current = now.id;
                tabsRef.current.setActiveView(now.id, 'documents');
              }
              const patch = { queryRaw: text, filterDraft: undefined };
              tabsRef.current.patchCollectionState(now.id, patch);
              void run(patch);
            },
          };
        },
      },
    ],
    [run],
  );

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
        if (tabs.activeId) void closeTabGuarded(tabs, tabs.activeId);
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
    void api.conn.touchUsed(id).catch((err) => logFailure('marking the connection used', err));
    // The status event drives the UI; the log keeps the cause.
    void api.mongo.connect(id).catch((err) => logFailure('connect', err));
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
    (id: string) => {
      // The dialogs hook ignores the result; navigate's promise only settles the transition.
      void navigate(`/connections/${id}`);
    },
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
    openAddConnectionModal,
  } = connectionDialogs;

  // A full conn.list() refetch, not scoped to one Connection, registered
  // here for the Data View. Each Connection's own actions are registered
  // separately by ConnectionPaletteCommands, as a Connection object.
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

  // One Tab object per open tab (X07 §13.5), with the tab strip's own
  // handlers. Keyed on what the objects show, so a filter edit on a tab, which
  // replaces the tab list, does not re-register them.
  const tabObjectsKey = tabs.tabs
    .map((tab) => [tab.id, tabLabel(tab), tab.connectionId, tab.kind === 'collection' ? tab.dbName : '', tab.pinned].join('\u0000'))
    .join('\u0001');
  const connectionNamesKey = connections.map((c) => `${c.id}\u0000${c.name}`).join('\u0001');
  const tabObjects = React.useMemo(
    (): PaletteObject[] =>
      // eslint-disable-next-line react-hooks/refs
      tabs.tabs.map((tab) =>
        tabObject({
          tab,
          connectionName: connections.find((c) => c.id === tab.connectionId)?.name,
          activate: (id) =>
            activateTab(
              {
                tabs: tabsRef.current,
                connections: connectionsRef.current,
                recordSessionEvent: hints.recordSessionEvent,
                openConnection,
              },
              id,
            ),
          close: (id) => closeTabGuarded(tabsRef.current, id),
          setPinned: (id, pinned) => tabsRef.current.setPinned(id, pinned),
        }),
      ),
    // Keyed on what the objects show, not on the tab list's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabObjectsKey, connectionNamesKey, tabsRef, connectionsRef, hints.recordSessionEvent, openConnection],
  );
  useRegisterObjects(tabObjects, [tabObjects]);

  // A saved query or pipeline (X07 §13.5): Open loads it into its
  // collection's tab as the saved list's Run here does, Run runs it too; a
  // pipeline opens as the saved list opens one.
  const openSaved = React.useCallback(
    async (saved: SavedQuerySummary, runIt: boolean) => {
      const t = tabsRef.current;
      // A Connection that is not connected shows its Connect pane in the tab:
      // a run asked of it would wait and fire on its own once connected. It
      // opens, and says to connect first, as Export… does; nothing is queued.
      const conn = connectionsRef.current.find((c) => c.id === saved.connectionId);
      if (runIt && isKnownNotConnected(conn)) {
        notify.info(`Connect to ${conn?.name ?? 'the connection'} first, then run.`);
        runIt = false;
      }
      if (saved.kind === 'aggregation') {
        const before = t.tabs;
        const tab = await openSavedPipeline(t, saved);
        // The open's stages land with the next render: a run asked now would
        // run the pipeline the tab showed before.
        if (tab && runIt) {
          pendingSavedRef.current = { kind: 'runPipeline', tabId: tab.id, savedId: saved.id, before };
          setPendingSavedTick((n) => n + 1);
        }
        return;
      }
      const full = await api.saved.get({ id: saved.id });
      const tab = await t.openCollection({
        connectionId: saved.connectionId,
        dbName: saved.dbName,
        collection: saved.collection,
        reuseExisting: true,
      });
      pendingSavedRef.current = {
        kind: 'saved',
        tabId: tab.id,
        payload: full.payload as unknown as LegacySavedFindPayload,
        run: runIt,
      };
      setPendingSavedTick((n) => n + 1);
    },
    [tabsRef, connectionsRef, setPendingSavedTick],
  );
  // Applies the pending load once its tab is in the tab state, as the saved
  // list's Run here does, without the run unless asked.
  React.useEffect(() => {
    const pending = pendingSavedRef.current;
    if (!pending) return;
    const tab = tabs.tabs.find((x) => x.id === pending.tabId);
    if (tab?.kind !== 'collection') return;
    if (pending.kind === 'runPipeline') {
      if (tabs.tabs === pending.before || tab.state.aggregation?.savedId !== pending.savedId) return;
      pendingSavedRef.current = null;
      requestTab('runPipeline', tab.id);
      return;
    }
    pendingSavedRef.current = null;
    if (pending.kind === 'rename') {
      // The Saved list's own inline rename, on the collection's Saved tab.
      if ((tab.state.activeView ?? 'documents') !== 'documents') {
        skipAutoRunRef.current = tab.id;
        tabs.setActiveView(tab.id, 'documents');
      }
      if (tab.state.activeBuilderTab !== 'Saved') tabs.patchCollectionState(tab.id, { activeBuilderTab: 'Saved' });
      expandBuilder();
      requestSavedRename(tab.id, pending.savedId);
      return;
    }
    if (pending.kind === 'filter') {
      // The filter drawer takes the request as an edit of its own: shown, on
      // its Filter tab, with nothing run.
      if ((tab.state.activeView ?? 'documents') !== 'documents') {
        skipAutoRunRef.current = tab.id;
        tabs.setActiveView(tab.id, 'documents');
      }
      if (tab.state.activeBuilderTab !== 'Builder') tabs.patchCollectionState(tab.id, { activeBuilderTab: 'Builder' });
      expandBuilder();
      requestFilter(tab.id, pending.request);
      return;
    }
    const patch = hydrateFindPayload(pending.payload, tab.state.builder);
    // The switch would re-fire the auto-run: a saved `{}` would run on Open,
    // and on Run once more, cancelling the explicit run below.
    if ((tab.state.activeView ?? 'documents') !== 'documents') {
      skipAutoRunRef.current = tab.id;
      tabs.setActiveView(tab.id, 'documents');
    }
    // The draft belongs to the filter being replaced: drop it with it.
    tabs.patchCollectionState(tab.id, { ...patch, filterDraft: undefined });
    // The saved list's `onLoaded`: clears the query bar's held complaints and reseeds the drawer.
    setSavedLoadGen((n) => n + 1);
    if (pending.run) void run(patch, { ...tab, state: { ...tab.state, ...patch } });
  }, [tabs, pendingSavedTick, run, expandBuilder]);
  // Rename… opens the collection's Saved list with the entry in its rename
  // input. A Connection that is not connected shows its Connect pane instead.
  const renameSaved = React.useCallback(
    async (saved: SavedQuerySummary) => {
      const conn = connectionsRef.current.find((c) => c.id === saved.connectionId);
      if (isKnownNotConnected(conn)) {
        notify.info(`Connect to ${conn?.name ?? 'the connection'} first, then rename.`);
        return;
      }
      const tab = await tabsRef.current.openCollection({
        connectionId: saved.connectionId,
        dbName: saved.dbName,
        collection: saved.collection,
        reuseExisting: true,
      });
      pendingSavedRef.current = { kind: 'rename', tabId: tab.id, savedId: saved.id };
      setPendingSavedTick((n) => n + 1);
    },
    [connectionsRef, tabsRef, setPendingSavedTick],
  );
  const removeSaved = React.useCallback(async (saved: SavedQuerySummary) => {
    if (!(await confirmDeleteSaved(saved))) return;
    await api.saved.delete({ id: saved.id });
    setSavedRefreshKey((n) => n + 1);
  }, []);

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
        disconnectConnectionId?: string;
      }
    | null;
  const openConnectionId = navState?.openConnectionId ?? null;
  const openCollectionFromNav = navState?.openCollection ?? null;
  React.useEffect(() => {
    if (!openConnectionId) return;
    void navigate(location.pathname, { replace: true, state: null });
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

  // Same nav-state handoff as openConnectionId, for the palette's Connection
  // actions (mounted where they can't call these modal-openers directly).
  // Held until connectionsLoading clears — acting before `connections` first
  // loads would silently drop the intent.
  const deleteConnectionId = navState?.deleteConnectionId ?? null;
  const editConnectionId = navState?.editConnectionId ?? null;
  const disconnectConnectionId = navState?.disconnectConnectionId ?? null;
  // `openDeleteConnectionModal` counts the Connection's open tabs to word its
  // dialog and refuses while they are still loading: wait for them too, or the
  // intent is cleared and dropped.
  React.useEffect(() => {
    if (!deleteConnectionId || connectionsLoading || tabs.loading) return;
    void navigate(location.pathname, { replace: true, state: null });
    openDeleteConnectionModal(deleteConnectionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteConnectionId, connectionsLoading, tabs.loading]);
  React.useEffect(() => {
    if (!editConnectionId || connectionsLoading) return;
    void navigate(location.pathname, { replace: true, state: null });
    openEditConnectionModal(editConnectionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editConnectionId, connectionsLoading]);
  // `requestDisconnect` counts the Connection's open tabs to word its dialog,
  // and refuses while the tabs are still loading: wait for them too.
  React.useEffect(() => {
    if (!disconnectConnectionId || connectionsLoading || tabs.loading) return;
    void navigate(location.pathname, { replace: true, state: null });
    requestDisconnect(disconnectConnectionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disconnectConnectionId, connectionsLoading, tabs.loading]);

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
    onAdd: openAddConnectionModal,
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
        panelPrefs={panelPrefs}
        connectionDialogs={connectionDialogs}
        navigatorData={navigatorData}
        onOpenReferences={() => setRefEditorOpen(true)}
        navigatorDialogRequest={navigatorDialogRequest}
        onNavigatorDialogHandled={clearNavigatorDialog}
        navigatorRevealRequest={navigatorRevealRequest}
        setNavigatorRevealRequest={setNavigatorRevealRequest}
      />

      <PanelBody
        externalLoadGen={savedLoadGen}
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
        connectErrors={navigatorTree.connectErrors}
      />

      <FeatureHint
        id="startup.restore"
        visible={startupRestoreHint.visible}
        onDismiss={startupRestoreHint.dismiss}
        onCta={() => settings.open('editor')}
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
        openCollectionTab={openCollectionTab}
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
      <SavedPaletteObjects
        connectionId={focusedConnectionId}
        refreshKey={savedRefreshKey}
        open={openSaved}
        rename={renameSaved}
        remove={removeSaved}
      />
    </AppShell>
  );
}

/**
 * One Saved object per saved query and pipeline of the focused Connection.
 * The list is one local read each time the palette opens (X07 §13.7 rule 5),
 * and again when a save or delete lands while it is open; never per
 * keystroke, never while it is closed. Its own component, so the palette
 * opening re-renders this and not the Workspace.
 */
function SavedPaletteObjects({
  connectionId,
  refreshKey,
  open,
  rename,
  remove,
}: {
  connectionId: string | null;
  refreshKey: number;
  open: (saved: SavedQuerySummary, run: boolean) => Promise<void>;
  rename: (saved: SavedQuerySummary) => Promise<void>;
  remove: (saved: SavedQuerySummary) => Promise<void>;
}) {
  const paletteOpen = usePaletteOpen();
  const [listed, setListed] = React.useState<{ connectionId: string; list: SavedQuerySummary[] } | null>(null);
  React.useEffect(() => {
    if (!paletteOpen || !connectionId) return;
    let live = true;
    api.saved.list({ connectionId }).then(
      (list) => {
        if (live) setListed({ connectionId, list: list.filter(isPaletteSaved) });
      },
      (err: unknown) => logFailure('listing saved queries for the palette', err),
    );
    return () => {
      live = false;
    };
  }, [paletteOpen, connectionId, refreshKey]);
  const objects = React.useMemo(
    (): PaletteObject[] =>
      listed && listed.connectionId === connectionId
        ? listed.list.map((saved) => savedObject({ saved, open, rename, remove }))
        : [],
    [listed, connectionId, open, rename, remove],
  );
  useRegisterObjects(objects, [objects]);
  return null;
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
