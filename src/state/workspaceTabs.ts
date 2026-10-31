import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AggregationTabState,
  CollectionTab,
  CollectionTabState,
  CollectionView,
  ResultViewMode,
  ScriptTab,
  ScriptTabState,
  WorkspaceTab,
} from '@shared/types';
import { DEFAULT_AGGREGATION_TAB_STATE } from '@shared/defaults';
import type { AggregationSeed, IpcError } from '@shared/ipc';
import { confirmDestructive } from '../utils/confirm';
import { api, isIpcError } from '../api/atelier';
import { logFailure } from '../utils/rendererLog';
import { notify } from '../theme/notifications';
import { applyPendingPatches, carryResultFields, stripResultPatch } from './tabResultCarry';
import { registerFlusher } from './pendingFlush';

/**
 * Global sticky-default prefs key (T0.5 / W07 §1). Stores the last page size
 * the user picked in the `ResultBar` size selector; brand-new collection tabs
 * seed their `pageSize` from it via `openCollection`'s `initialState`. Follows
 * the `ui.workspace.*` prefs-key convention used for `sidebarCollapsed` /
 * `leftWidth` / `shellSplit` / `innerHSplit` in `Workspace.tsx`.
 *
 * This is distinct from a tab's own persisted `pageSize` (which lives in
 * `workspace_tabs.state_json` via the debounced `patchCollectionState`, same
 * as `page`) — the pref only seeds the initial value for tabs that don't
 * already have one.
 */
export const DEFAULT_PAGE_SIZE_PREF_KEY = 'ui.workspace.defaultPageSize';

/**
 * Canonical page-size option set (W07 §2/§5, T0.5). Single source of truth —
 * `ResultBar`'s selector imports this instead of keeping its own copy, and
 * `openCollection` below validates the stored pref against it so a
 * corrupted/out-of-range value (e.g. from a hand-edited `app_state` row)
 * can't seed a tab with an unbounded page size.
 */
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 250, 500] as const;

/** Settings' "default result view": seeds a brand-new collection tab's `view`. */
export const DEFAULT_VIEW_PREF_KEY = 'ui.workspace.defaultView';

/** Result views, in the order Settings lists them. */
export const RESULT_VIEW_OPTIONS = ['Table', 'Tree', 'JSON'] as const satisfies readonly ResultViewMode[];

export interface WorkspaceTabsState {
  tabs: WorkspaceTab[];
  activeId: string | null;
  loading: boolean;
  error: IpcError | null;
  refresh: () => Promise<void>;
  openCollection: (input: {
    connectionId: string;
    dbName: string;
    collection: string;
    reuseExisting?: boolean;
  }) => Promise<CollectionTab>;
  /**
   * Opens the collection's Aggregation view. With a `savedId`, a `name` or an
   * `initialState`, main replaces the pipeline on the collection's open tab, so
   * a tab with unsaved pipeline edits asks first; `null` when the user keeps
   * them instead.
   */
  openAggregation: (input: {
    connectionId: string;
    dbName: string;
    collection: string;
    savedId?: string;
    name?: string;
    initialState?: AggregationSeed;
  }) => Promise<CollectionTab | null>;
  openScript: (input: {
    connectionId: string;
    initialState?: Partial<ScriptTabState>;
  }) => Promise<ScriptTab>;
  close: (id: string) => Promise<void>;
  /**
   * X16 §7 — close one Connection's tabs. This inverts the old
   * `closeAll(keepConnectionId?)`, whose meaning was "close every tab NOT on
   * this Connection": that was the single-Connection switch teardown, and
   * switching no longer closes anything. The only callers left are the two
   * that destroy a Connection — Disconnect and Delete — and each owns exactly
   * its own tabs. Renamed rather than inverted in place: a `closeAll` that
   * spares every other Connection is a name that lies at the call site, and
   * `closeForNamespace` below already sets the naming pattern.
   */
  closeForConnection: (connectionId: string) => Promise<void>;
  /**
   * N0.5 — close every open collection tab pointing at a namespace that was
   * just dropped (a specific collection, or every collection in a dropped
   * database when `collection` is omitted). A tab with unsaved aggregation
   * pipeline edits (`state.aggregation.dirty`) prompts for confirmation
   * first, same as the manual tab-close guard in `Workspace.tsx`.
   */
  closeForNamespace: (input: {
    connectionId: string;
    dbName: string;
    collection?: string;
  }) => Promise<void>;
  /**
   * N0.5 — re-point any open tab on a renamed collection to its new name in
   * place (preserving query/filter/pagination state) via `tabs:collectionRenamed`.
   */
  retargetCollection: (input: {
    connectionId: string;
    dbName: string;
    collection: string;
    newCollection: string;
  }) => Promise<void>;
  setActive: (id: string) => Promise<void>;
  setActiveView: (id: string, view: CollectionView) => void;
  reorder: (orderedIds: string[]) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  /**
   * Patch the state of a collection tab. Writes through to main via a 250ms
   * debounce to avoid hammering SQLite on fast UI updates.
   */
  patchCollectionState: (id: string, patch: Partial<CollectionTabState>) => void;
  /**
   * Functional-updater variant of `patchCollectionState`. The callback
   * receives the latest merged state (current state plus any pending,
   * unflushed patches) so a "read-modify-write" sequence run inside the
   * 250ms debounce window doesn't clobber prior updates. Use this for
   * any patch that depends on existing values — column widths,
   * expanded-row sets, the nested `schema` blob — so two callbacks
   * firing in the same tick can each see the other's changes.
   */
  patchCollectionStateWith: (
    id: string,
    fn: (prev: CollectionTabState) => Partial<CollectionTabState>,
  ) => void;
  /**
   * Patch the nested aggregation sub-view state. Convenience wrapper around
   * `patchCollectionState` that merges into `state.aggregation`.
   */
  patchAggregationState: (id: string, patch: Partial<AggregationTabState>) => void;
  /**
   * Patch a script tab's state (W12). Same 250ms debounced write-through
   * as collection-tab patches.
   */
  patchScriptState: (id: string, patch: Partial<ScriptTabState>) => void;
}

const DEBOUNCE_MS = 250;

function isNoOpPatch<S extends Record<string, unknown>>(
  state: S,
  patch: Partial<S>,
): boolean {
  for (const key of Object.keys(patch) as Array<keyof S>) {
    if (patch[key] !== state[key]) return false;
  }
  return true;
}

export function useWorkspaceTabs(): WorkspaceTabsState {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<IpcError | null>(null);
  const tabsRef = useRef<WorkspaceTab[]>([]);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // Pending patches accumulate as a partial CollectionTabState per tab id;
  // the flush merges them server-side via `tabs.update`.
  const pendingPatches = useRef<Map<string, Partial<CollectionTabState>>>(
    new Map(),
  );
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeId = tabs.find((t) => t.isActive)?.id ?? null;

  const refresh = useCallback(async () => {
    try {
      // Main handles the list and the updates in dispatch order, so a flush
      // that fires while the list is in flight leaves its patch out of the
      // answer and already out of `pendingPatches`: snapshot before dispatch.
      const before = new Map(pendingPatches.current);
      const list = await api.tabs.list();
      // The list lags local state by whatever is still in the debounce, so
      // layer those patches back on first. Listed tabs also carry no result
      // documents (never persisted); keep the in-memory ones of tabs that
      // were already open.
      const current = applyPendingPatches(
        applyPendingPatches(list, before),
        pendingPatches.current,
      );
      setTabs((prev) => carryResultFields(prev, current));
      setError(null);
    } catch (e) {
      setError(isIpcError(e) ? e : { code: 'INTERNAL', message: String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void refresh();
    });
  }, [refresh]);

  const openCollection: WorkspaceTabsState['openCollection'] = useCallback(
    async (input) => {
      // Seed brand-new tabs from the sticky page-size default. A `null`
      // (never-set) pref is deliberately omitted rather than coerced to a
      // number — `WorkspaceStateService.openCollection` falls back to
      // `DEFAULT_COLLECTION_TAB_STATE.pageSize` (50) itself, which is what
      // keeps "default is 50" true for first-time users. The reuse-existing
      // path on the service ignores `initialState.pageSize` entirely, so an
      // already-open tab's own persisted page size is never clobbered.
      //
      // The pref is also validated against `PAGE_SIZE_OPTIONS` — not just
      // "any finite positive number" — so a corrupted or out-of-range stored
      // value can't seed a tab (and its find query's `limit`) with an
      // unbounded page size. An out-of-set value is treated the same as a
      // never-set pref: omit `initialState` and let the server default apply.
      const seed: Partial<Pick<CollectionTabState, 'pageSize' | 'view'>> = {};
      try {
        const pageSize = await api.prefs.get<number>(DEFAULT_PAGE_SIZE_PREF_KEY);
        if (
          typeof pageSize === 'number' &&
          Number.isFinite(pageSize) &&
          (PAGE_SIZE_OPTIONS as readonly number[]).includes(pageSize)
        ) {
          seed.pageSize = pageSize;
        }
      } catch (err) {
        // Best-effort: fall back to the server-side default.
        logFailure(`reading preference ${DEFAULT_PAGE_SIZE_PREF_KEY}`, err);
      }
      try {
        // Same rule as the page size: a value outside the enum is a never-set pref.
        const view = await api.prefs.get<string>(DEFAULT_VIEW_PREF_KEY);
        if ((RESULT_VIEW_OPTIONS as readonly unknown[]).includes(view)) {
          seed.view = view as ResultViewMode;
        }
      } catch (err) {
        logFailure(`reading preference ${DEFAULT_VIEW_PREF_KEY}`, err);
      }
      const initialState = Object.keys(seed).length > 0 ? seed : undefined;
      const tab = await api.tabs.openCollection({
        ...input,
        ...(initialState ? { initialState } : {}),
      });
      await refresh();
      return tab;
    },
    [refresh],
  );

  const openAggregation: WorkspaceTabsState['openAggregation'] = useCallback(
    async (input) => {
      // With a saved pipeline, a name or seeded stages, main replaces the
      // aggregation on the collection's tab if one is open, so ask before
      // losing its unsaved edits, as closing that tab does.
      const replaces = Boolean(input.savedId || input.name || input.initialState);
      if (replaces) {
        const open = tabsRef.current.find(
          (t) =>
            t.kind === 'collection' &&
            t.connectionId === input.connectionId &&
            t.dbName === input.dbName &&
            t.collection === input.collection,
        );
        if (open?.kind === 'collection' && open.state.aggregation?.dirty) {
          const proceed = await confirmDestructive({
            title: 'Discard unsaved pipeline changes?',
            body: `Opening ${input.name ? `"${input.name}"` : 'this pipeline'} replaces the pipeline on "${input.dbName}.${input.collection}", which has edits that have not been saved.`,
            confirmLabel: 'Discard and open',
          });
          if (!proceed) return null;
        }
      }
      const tab = await api.tabs.openAggregation(input);
      // Main just overwrote these on the tab, so a patch still in the debounce
      // would otherwise be layered back over it (and later flushed over it).
      // Without a saved pipeline, name or seeded stages main keeps the
      // persisted aggregation, so the pending one is newer and stays.
      const pending = pendingPatches.current.get(tab.id);
      if (pending) {
        delete pending.activeView;
        if (replaces) delete pending.aggregation;
      }
      await refresh();
      return tab;
    },
    [refresh],
  );

  const openScript: WorkspaceTabsState['openScript'] = useCallback(
    async (input) => {
      const tab = await api.tabs.openScript(input);
      await refresh();
      return tab;
    },
    [refresh],
  );

  const close = useCallback(
    async (id: string) => {
      await api.tabs.close(id);
      await refresh();
    },
    [refresh],
  );

  const closeForConnection = useCallback(async (connectionId: string) => {
    // Clear this Connection's tabs from local state synchronously so the
    // strip stops rendering them immediately; the other Connections' tabs
    // stay put rather than being cleared and waiting on `refresh()`.
    //
    // An earlier empty-local fallback (re-fetch the whole tab list over IPC
    // when `tabsRef` is empty) is gone. It existed because a switch could
    // fire before the initial refresh had populated `tabsRef`, and a switch
    // was obliged to leave no tab behind. Nothing switches any more, so
    // nothing is owed that guarantee.
    //
    // The window where `tabsRef` is empty at launch is closed at the callers
    // instead: `requestDisconnect` and `openDeleteConnectionModal` refuse
    // while `loading`, so by the time either confirm can be accepted this
    // snapshot is populated. That gate is what the old fallback should have
    // been — `loading` distinguishes "not loaded yet" from "genuinely no
    // tabs", where an emptiness check conflates them and re-fetches blind.
    const snapshot = tabsRef.current;
    const toClose = snapshot.filter((t) => t.connectionId === connectionId);
    setTabs(snapshot.filter((t) => t.connectionId !== connectionId));
    await Promise.all(
      toClose.map((t) => api.tabs.close(t.id).catch((err) => logFailure('closing a tab', err))),
    );
    await refresh();
  }, [refresh]);

  const closeForNamespace: WorkspaceTabsState['closeForNamespace'] = useCallback(
    async ({ connectionId, dbName, collection }) => {
      const matches = tabsRef.current.filter(
        (t) =>
          t.kind === 'collection' &&
          t.connectionId === connectionId &&
          t.dbName === dbName &&
          (collection === undefined || t.collection === collection),
      );
      if (matches.length === 0) return;
      const hasDirty = matches.some(
        (t) => t.kind === 'collection' && t.state.aggregation?.dirty,
      );
      if (hasDirty) {
        const label = collection ? `"${dbName}.${collection}"` : `database "${dbName}"`;
        const proceed = await confirmDestructive({
          title: 'Discard unsaved pipeline changes?',
          body: `Closing the open tab(s) for ${label} discards pipeline edits that have not been saved.`,
          confirmLabel: 'Discard and close',
        });
        if (!proceed) return;
      }
      await Promise.all(
        matches.map((t) => api.tabs.close(t.id).catch((err) => logFailure('closing a tab', err))),
      );
      await refresh();
    },
    [refresh],
  );

  const retargetCollection: WorkspaceTabsState['retargetCollection'] = useCallback(
    async ({ connectionId, dbName, collection, newCollection }) => {
      try {
        await api.tabs.collectionRenamed({
          connectionId,
          dbName,
          oldCollection: collection,
          newCollection,
        });
      } catch (err) {
        // Best-effort: the navigator's own refresh still shows the new name.
        logFailure('retargeting tabs after a collection rename', err);
      }
      await refresh();
    },
    [refresh],
  );

  const setActive = useCallback(
    async (id: string) => {
      // Flip in-place synchronously so the UI doesn't keep rendering the
      // prior Focused Tab while the setActive IPC is in flight.
      setTabs((ts) => ts.map((t) => ({ ...t, isActive: t.id === id })));
      await api.tabs.setActive(id);
    },
    [],
  );

  const reorder = useCallback(
    async (orderedIds: string[]) => {
      setTabs((ts) => {
        const byId = new Map(ts.map((t) => [t.id, t]));
        const next: WorkspaceTab[] = [];
        for (const id of orderedIds) {
          const t = byId.get(id);
          if (t) {
            next.push({ ...t, position: next.length });
            byId.delete(id);
          }
        }
        for (const t of byId.values()) next.push({ ...t, position: next.length });
        // `position` above is assigned from `orderedIds` — `TabStrip.tsx`'s
        // `handleDrop` builds that list from raw-position order so a same-
        // group drag can't renumber pinned-first across Connections.
        // But that means `next`'s own array order is raw-position order too,
        // not the pinned-first order every other read of `tabs` promises
        // (`tabs.list()`'s `ORDER BY pinned DESC, position ASC`, and
        // `setPinned`'s matching local sort just below). Re-sort here so the
        // optimistic state matches what the next real load would return —
        // sorting after the loop only reorders this array for rendering, it
        // does not touch the `position` values already written above, so
        // `groupTabsByConnection`'s raw-`position` group order is unaffected.
        return [...next].sort(
          (a, b) => Number(b.pinned) - Number(a.pinned) || a.position - b.position,
        );
      });
      await api.tabs.reorder(orderedIds);
    },
    [],
  );

  const setPinned = useCallback(async (id: string, pinned: boolean) => {
    setTabs((ts) => {
      const updated = ts.map((t) => (t.id === id ? { ...t, pinned } : t));
      return [...updated].sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || a.position - b.position,
      );
    });
    await api.tabs.setPinned({ id, pinned });
  }, []);

  const saveFailureShown = useRef(false);
  // Sends every pending patch now, dropping the debounce, and resolves once
  // each save has succeeded or failed. Each `tabs.update` is dispatched
  // synchronously, so a caller that is about to lose the page (unmount,
  // `pagehide`) has its edits on the wire before it returns.
  const flushNow = useCallback(async (): Promise<void> => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    const entries = [...pendingPatches.current.entries()];
    pendingPatches.current.clear();
    await Promise.all(
      entries.map(async ([id, patch]) => {
        // Result documents stay in renderer memory; main strips them too,
        // this only avoids shipping them over IPC on every run.
        const state = stripResultPatch(patch);
        if (Object.keys(state).length === 0) return;
        try {
          await api.tabs.update(id, { state });
          saveFailureShown.current = false;
        } catch {
          // The tab keeps working in memory; only its saved copy is
          // behind, so tell the user once per outage, not on every flush.
          if (saveFailureShown.current) return;
          saveFailureShown.current = true;
          notify.error('Tab changes could not be saved');
        }
      }),
    );
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => void flushNow(), DEBOUNCE_MS);
  }, [flushNow]);

  // Edits still in the debounce would otherwise be lost: on unmount (leaving
  // the Workspace), on `pagehide` (a reload, or the window closing while main
  // lives on) and when main quits, which asks through `flushAll`. Unmount
  // flushes rather than only clearing the timer, because a timer left behind
  // would fire after the component (and, in a test, its environment) is gone.
  useEffect(() => {
    const unregister = registerFlusher(flushNow);
    const onPageHide = () => void flushNow();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      unregister();
      window.removeEventListener('pagehide', onPageHide);
      void flushNow();
    };
  }, [flushNow]);

  const patchCollectionState = useCallback(
    (id: string, patch: Partial<CollectionTabState>) => {
      const current = tabsRef.current.find((t) => t.id === id);
      if (!current || current.kind !== 'collection') return;
      if (
        isNoOpPatch(
          current.state as unknown as Record<string, unknown>,
          patch as unknown as Partial<Record<string, unknown>>,
        )
      ) {
        return;
      }

      setTabs((ts) =>
        ts.map((t) =>
          t.id === id && t.kind === 'collection'
            ? { ...t, state: { ...t.state, ...patch } }
            : t,
        ),
      );
      const existing = pendingPatches.current.get(id);
      pendingPatches.current.set(id, { ...(existing ?? {}), ...patch });
      scheduleFlush();
    },
    [scheduleFlush],
  );

  const patchCollectionStateWith: WorkspaceTabsState['patchCollectionStateWith'] = useCallback(
    (id, fn) => {
      const current = tabsRef.current.find((t) => t.id === id);
      if (!current || current.kind !== 'collection') return;
      // Same trick as `patchAggregationState`: prefer the pending patch
      // over `tabsRef.current.state` so a burst of synchronous calls
      // each sees the prior merge, not the stale ref. The ref only
      // catches up via the post-render effect, which is too late for
      // intra-tick correctness on nested keys (`columns`,
      // `expandedRows`, `schema`).
      const pending = pendingPatches.current.get(id) ?? {};
      const merged: CollectionTabState = { ...current.state, ...pending };
      const patch = fn(merged);
      if (
        isNoOpPatch(
          merged as unknown as Record<string, unknown>,
          patch as unknown as Partial<Record<string, unknown>>,
        )
      ) {
        return;
      }
      setTabs((ts) =>
        ts.map((t) =>
          t.id === id && t.kind === 'collection'
            ? { ...t, state: { ...t.state, ...patch } }
            : t,
        ),
      );
      const existing = pendingPatches.current.get(id);
      pendingPatches.current.set(id, { ...(existing ?? {}), ...patch });
      scheduleFlush();
    },
    [scheduleFlush],
  );

  const setActiveView: WorkspaceTabsState['setActiveView'] = useCallback(
    (id, view) => {
      patchCollectionState(id, { activeView: view });
    },
    [patchCollectionState],
  );

  const patchAggregationState: WorkspaceTabsState['patchAggregationState'] = useCallback(
    (id, patch) => {
      const current = tabsRef.current.find((t) => t.id === id);
      if (!current || current.kind !== 'collection') return;
      // Read the latest aggregation state, preferring the pending patch over
      // `tabsRef.current` because the ref lags one render behind during a
      // burst of synchronous calls. Without this, a second call in the same
      // tick would compute its merge against stale aggregation state and
      // clobber keys written by the first call.
      const pending = pendingPatches.current.get(id);
      const prev =
        (pending?.aggregation as AggregationTabState | undefined) ??
        current.state.aggregation;
      // When no aggregation state has been opened yet, seed with defaults
      // before merging — otherwise the patch would land alone (without
      // `stages`, `activeStageId`, etc.) and crash the AggregationTab on
      // first render.
      const base: AggregationTabState = prev ?? DEFAULT_AGGREGATION_TAB_STATE;
      // Same-value short-circuit: avoid a re-render + IPC when nothing
      // changed. Only meaningful when we have a real prior state to compare
      // against — a freshly-defaulted base always counts as a real change.
      if (
        prev &&
        isNoOpPatch(
          base as unknown as Record<string, unknown>,
          patch as unknown as Partial<Record<string, unknown>>,
        )
      ) {
        return;
      }
      const merged: AggregationTabState = { ...base, ...patch };
      patchCollectionState(id, { aggregation: merged });
    },
    [patchCollectionState],
  );

  const patchScriptState: WorkspaceTabsState['patchScriptState'] = useCallback(
    (id, patch) => {
      const current = tabsRef.current.find((t) => t.id === id);
      if (!current || current.kind !== 'script') return;
      if (
        isNoOpPatch(
          current.state as unknown as Record<string, unknown>,
          patch as unknown as Partial<Record<string, unknown>>,
        )
      ) {
        return;
      }
      setTabs((ts) =>
        ts.map((t) =>
          t.id === id && t.kind === 'script'
            ? { ...t, state: { ...t.state, ...patch } }
            : t,
        ),
      );
      const existing = pendingPatches.current.get(id) as
        | Partial<ScriptTabState>
        | undefined;
      pendingPatches.current.set(
        id,
        { ...(existing ?? {}), ...patch } as unknown as Partial<CollectionTabState>,
      );
      scheduleFlush();
    },
    [scheduleFlush],
  );

  return {
    tabs,
    activeId,
    loading,
    error,
    refresh,
    openCollection,
    openAggregation,
    openScript,
    close,
    closeForConnection,
    closeForNamespace,
    retargetCollection,
    setActive,
    setActiveView,
    reorder,
    setPinned,
    patchCollectionState,
    patchCollectionStateWith,
    patchScriptState,
    patchAggregationState,
  };
}
