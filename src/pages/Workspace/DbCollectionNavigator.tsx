import React from 'react';
import {
  List,
  useDynamicRowHeight,
  useListRef,
  type RowComponentProps,
} from 'react-window';
import type { CollectionInfo, DbInfo, IpcError } from '@shared/ipc';
import type { ConnectionSummary, ProbeErrorCode } from '@shared/types';
import { api, isIpcError } from '../../api/atelier';
import { copyToClipboard } from '../../utils/clipboard';
import { disconnectConnection } from '../../features/connections/disconnectConnection';
import { isKnownNotConnected } from '../../state/connections';
import { I } from '../../icons';
import { themeVars } from '../../theme/themeVars';
import type { ThemeVars as Theme } from '../../theme/themeVars';
import {
  ContextMenu,
  type ContextMenuItem,
} from '../../components/ContextMenu';
import { CreateCollectionDrawer } from './CreateCollectionDrawer';
import { RenameCollectionModal } from './RenameCollectionModal';
import { ImportDialog } from './ImportDialog';
import { DropCollectionConfirm } from './DropCollectionConfirm';
import { DropDatabaseConfirm } from './DropDatabaseConfirm';
import { useNavigatorDialogs } from './useNavigatorDialogs';
import { useNavigatorTree } from './useNavigatorTree';
import { emptyCache } from './navigatorTreeReducer';
import { ownGet } from '../../utils/ownProperty';
import { isContextMenuKey, anchorForRow } from '../../utils/contextMenuKey';

export interface NavigatorOpenInput {
  connectionId: string;
  dbName: string;
  collection: string;
}

export interface DbCollectionNavigatorProps {
  /** One root per Connection; a Saved one (no live client, no tabs) has no root here. */
  connections: ConnectionSummary[];
  /** Connections with an open workspace tab — the half of Saved-vs-Dormant `status` can't carry. */
  connectionsWithTabs: ReadonlySet<string>;
  /** The Focused Tab's Connection — the root that opens by default. `null` when no tab is open. */
  focusedConnectionId: string | null;
  activeDbName: string | null;
  activeCollection: string | null;
  width?: number;
  onOpenCollection: (
    input: NavigatorOpenInput,
    opts: { reuseExisting: boolean },
  ) => void;
  onOpenAggregation: (input: NavigatorOpenInput) => void;
  /** `returnFocusTo`: the row to refocus, since the menu item that opened the form unmounts first. */
  onEditConnection?: (
    connectionId: string,
    returnFocusTo?: HTMLElement | null,
    opts?: { focus?: 'password' },
  ) => void;
  /** Real Disconnect (not "Cancel connecting"); caller owns confirming and closing tabs. */
  onDisconnect?: (connectionId: string, returnFocusTo?: HTMLElement | null) => void;
  /** Fired after a collection/view drop, so the caller can close any tab still pointing at it. */
  onCollectionDropped?: (connectionId: string, dbName: string, collection: string) => void;
  /** Fired after a database drop; every open tab on it should close. */
  onDatabaseDropped?: (connectionId: string, dbName: string) => void;
  /** Fired after a rename, so the caller can re-point an open tab at the new name. */
  onCollectionRenamed?: (
    connectionId: string,
    dbName: string,
    oldName: string,
    newName: string,
  ) => void;
  /**
   * Opens the reference-rules drawer for the Focused Tab's collection. Scoped
   * to the active row: the drawer reads its rules off the currently open
   * collection tab, not off whichever row the menu was opened from, so the
   * "References…" item is disabled on any other row.
   */
  onOpenReferences?: () => void;
}

type TreeRow =
  | {
      kind: 'connection';
      id: string;
      conn: ConnectionSummary;
      isExpanded: boolean;
      isConnected: boolean;
      dbCount: number | null;
      // #66 — DOM id of this root's own `conn-error` row (`connerr:`/`dberr:`),
      // when one is present, so the row can `aria-describedby` it. A
      // connection can only ever have one of the two at a time (the first
      // needs `status === 'error'`, the second needs a connected, expanded
      // root with a failed db list).
      errorRowId: string | null;
    }
  | {
      kind: 'db';
      id: string;
      connectionId: string;
      db: DbInfo;
      isExpanded: boolean;
      count: number | null;
      refreshing: boolean;
    }
  | {
      kind: 'coll';
      id: string;
      connectionId: string;
      dbName: string;
      coll: CollectionInfo;
      isActive: boolean;
    }
  | { kind: 'skeleton'; id: string; dbName: string }
  | { kind: 'coll-empty'; id: string; dbName: string }
  | { kind: 'db-skeleton'; id: string; index: number }
  | { kind: 'db-empty'; id: string; text: string }
  // Per-root, not a panel above the tree — with several Connections open, a
  // shared error banner can't say which root is down.
  | {
      kind: 'conn-error';
      id: string;
      conn: ConnectionSummary;
      title: string;
      message: string;
      code?: ProbeErrorCode;
      retry: 'connect' | 'databases';
      retryLabel: string;
    };

type MenuItem = ContextMenuItem;

// #58 — `row.id` (`conn:…`/`db:…:…`/`coll:…:…:…`) is already globally unique,
// same reasoning as DocFieldTree's `fieldRowDomId`; just namespaced so it
// can't collide with an unrelated `id` elsewhere on the page.
function navigatorRowDomId(id: string): string {
  return `navigator-row-${id}`;
}

// #66 — the only three kinds a keyboard/AT user can land on. Everything else
// (skeleton/db-skeleton/coll-empty/db-empty/conn-error) is inert content: it
// has no `id`, no focus treatment, and nothing to act on. Used everywhere
// "navigable" is decided, so there's exactly one place that list can drift.
function isNavigableRow(row: TreeRow): boolean {
  return row.kind === 'connection' || row.kind === 'db' || row.kind === 'coll';
}

/**
 * Nearest navigable row at-or-after (`dir` 1) or at-or-before (`dir` -1)
 * `from`. Starting *at* `from` (not past it) makes this recover cleanly even
 * if `focusedId` were ever somehow left pointing at a non-navigable row —
 * the search just walks outward from wherever it is. Returns -1 when there
 * is no navigable row in that direction.
 */
function nearestNavigableIndex(rows: TreeRow[], from: number, dir: 1 | -1): number {
  for (let i = from; i >= 0 && i < rows.length; i += dir) {
    if (isNavigableRow(rows[i])) return i;
  }
  return -1;
}

/**
 * First navigable row after `idx`, without leaving the current node's own
 * subtree — `boundaryKinds` are the row kinds that mark "back out to a
 * sibling or ancestor" (e.g. hitting another `db` or `connection` row).
 * Used by ArrowRight's "step into the first child": the immediate next row
 * can be a skeleton/empty placeholder today, so a blind `rows[idx + 1]`
 * either lands on one or skips past the whole subtree.
 */
function firstNavigableInSubtree(
  rows: TreeRow[],
  idx: number,
  boundaryKinds: ReadonlyArray<TreeRow['kind']>,
): number {
  for (let i = idx + 1; i < rows.length; i += 1) {
    if (boundaryKinds.includes(rows[i].kind)) return -1;
    if (isNavigableRow(rows[i])) return i;
  }
  return -1;
}

const connExpandedKey = (id: string) => `ui.workspace.navigator.connExpanded:${id}`;

/** Connection-colour rail down the left edge; muted when no live client. */
const SPINE_WIDTH = 3;

/** Delay before the one bounded retry on an empty `listDatabases` result. */
const EMPTY_DB_RETRY_DELAY_MS = 300;

/** Fallback when a failed connect's status event and backfill both miss the message. */
const GENERIC_CONNECT_ERROR = 'The connection attempt failed.';

export function DbCollectionNavigator({
  connections,
  connectionsWithTabs,
  focusedConnectionId,
  activeDbName,
  activeCollection,
  width,
  onOpenCollection,
  onOpenAggregation,
  onEditConnection,
  onDisconnect,
  onCollectionDropped,
  onDatabaseDropped,
  onCollectionRenamed,
  onOpenReferences,
}: DbCollectionNavigatorProps) {
  const T = themeVars;
  const { state: tree, dispatch, isMounted } = useNavigatorTree();
  const { caches, connectErrors, expandedConnId, expanded } = tree;
  const [filter, setFilter] = React.useState('');
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  // Sticky-header trick: overflow:hidden on the container, overflow:auto only on the tree region.
  const treeRef = React.useRef<HTMLDivElement | null>(null);
  // Set on 'disconnected'/'error', consumed on 'connected' to background-refresh expanded DBs.
  const sawDisconnectRef = React.useRef<Set<string>>(new Set());
  const expandedRef = React.useRef(expanded);
  const activeDbNameRef = React.useRef(activeDbName);

  const expandedConn =
    connections.find((c) => c.id === expandedConnId) ?? null;
  const connectionId = expandedConn ? expandedConnId : null;
  // Inlined own-property check (not `ownGet`) so the React Compiler can still
  // prove this memoization-dependency value stable.
  const cache =
    connectionId && Object.prototype.hasOwnProperty.call(caches, connectionId)
      ? caches[connectionId]
      : emptyCache();
  // Gate is the pool's live-client flag, never `cache` (which outlives a drop within a session).
  const isConnected = expandedConn?.status === 'connected';
  const dbExpanded = React.useMemo(
    () => (connectionId ? ownGet(expanded, connectionId) ?? {} : {}),
    [expanded, connectionId],
  );

  const loadDbs = React.useCallback(async (id: string): Promise<DbInfo[] | null> => {
    dispatch({ type: 'dbsLoadStart', id });
    try {
      let rows = await api.meta.listDatabases({ connectionId: id });
      if (rows.length === 0) {
        // A brand-new database can be briefly invisible to listDatabases right
        // after connect (driver/server catalog-visibility race) — one bounded retry.
        await new Promise((resolve) => setTimeout(resolve, EMPTY_DB_RETRY_DELAY_MS));
        // The navigator can unmount during the delay; a gone view must not
        // spend another main-process round trip on a result nobody will read.
        if (!isMounted()) return null;
        rows = await api.meta.listDatabases({ connectionId: id });
      }
      dispatch({ type: 'dbsLoadSuccess', id, dbs: rows });
      return rows;
    } catch (e) {
      const err: IpcError = isIpcError(e)
        ? e
        : { code: 'INTERNAL', message: String(e) };
      dispatch({ type: 'dbsLoadError', id, err });
      return null;
    }
  }, [dispatch, isMounted]);

  const loadColls = React.useCallback(async (id: string, dbName: string) => {
    dispatch({ type: 'collsLoadStart', id, dbName });
    try {
      const rows = await api.meta.listCollections({ connectionId: id, dbName });
      // Sort A→Z so large databases are scannable; server returns insertion order.
      const sorted = [...rows].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      );
      dispatch({ type: 'collsLoadSuccess', id, dbName, colls: sorted });
    } catch {
      dispatch({ type: 'collsLoadError', id, dbName });
    }
  }, [dispatch]);

  // The expanded root follows the Focused Tab's Connection on *change*, not
  // value — a root expanded by hand while on another tab stays expanded. Only
  // on the first change (mount) is the stored per-Connection expand flag consulted.
  const followedConnRef = React.useRef<string | null>(null);
  const firstFollowRef = React.useRef(true);
  React.useEffect(() => {
    if (!focusedConnectionId || focusedConnectionId === followedConnRef.current) return;
    followedConnRef.current = focusedConnectionId;
    const isFirst = firstFollowRef.current;
    firstFollowRef.current = false;
    let cancelled = false;
    queueMicrotask(() => {
      void (async () => {
        if (!isFirst) {
          if (cancelled) return;
          dispatch({ type: 'expandedConnSet', id: focusedConnectionId });
          return;
        }
        let stored: boolean | null;
        try {
          stored = await api.prefs.get<boolean>(connExpandedKey(focusedConnectionId));
        } catch {
          stored = null;
        }
        if (cancelled || stored === false) return;
        // Never stomp a root the user opened while this read was in flight.
        dispatch({ type: 'expandedConnSetIfNull', id: focusedConnectionId });
      })();
    });
    return () => {
      cancelled = true;
    };
  }, [focusedConnectionId, dispatch]);

  React.useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  React.useEffect(() => {
    activeDbNameRef.current = activeDbName;
  }, [activeDbName]);

  // One subscription for every Connection id (not per root): reconnect
  // background-refreshes a Connection's previously-expanded DBs, and a
  // Connection reconnecting into an empty navigator opens its root — only
  // when nothing is already expanded.
  React.useEffect(() => {
    const off = api.mongo.onStatus((runtime) => {
      // A transition away from 'error' retires the message on that root.
      if (runtime.status === 'error') {
        dispatch({
          type: 'connectErrorSet',
          id: runtime.id,
          message: runtime.errorMessage ?? GENERIC_CONNECT_ERROR,
          code: runtime.errorCode,
        });
      } else {
        dispatch({ type: 'connectErrorClear', id: runtime.id });
      }
      if (runtime.status === 'disconnected' || runtime.status === 'error') {
        sawDisconnectRef.current.add(runtime.id);
      } else if (runtime.status === 'connected') {
        dispatch({ type: 'expandedConnSetIfNull', id: runtime.id });
        if (sawDisconnectRef.current.has(runtime.id)) {
          const snapshot = ownGet(expandedRef.current, runtime.id) ?? {};
          for (const db of Object.keys(snapshot).filter((d) => snapshot[d])) {
            void loadColls(runtime.id, db);
          }
          sawDisconnectRef.current.delete(runtime.id);
        }
      }
    });
    return off;
  }, [loadColls, dispatch]);

  // Backfills the error message for a Connection already 'error' at mount,
  // whose failure predates this component's status subscription.
  const backfilledRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    for (const c of connections) {
      if (c.status !== 'error') {
        backfilledRef.current.delete(c.id);
        continue;
      }
      if (backfilledRef.current.has(c.id)) continue;
      backfilledRef.current.add(c.id);
      const id = c.id;
      void (async () => {
        const runtime = await api.mongo.status(id).catch(() => null);
        if (!runtime || runtime.status !== 'error' || !runtime.errorMessage) return;
        const message = runtime.errorMessage;
        dispatch({ type: 'connectErrorBackfill', id, message, code: runtime.errorCode });
      })();
    }
  }, [connections, dispatch]);

  const dbsPresent = cache.dbs !== null;
  const dbsLoading = cache.dbsLoading;
  const cacheHasError = cache.err !== null;
  React.useEffect(() => {
    if (!connectionId || !isConnected) return;
    if (dbsPresent || dbsLoading || cacheHasError) return;
    queueMicrotask(() => {
      void loadDbs(connectionId);
    });
  }, [connectionId, isConnected, dbsPresent, dbsLoading, cacheHasError, loadDbs]);

  // Auto-expands the Focused Tab's DB + fetches its collections, scoped to
  // that Connection only (another root's same-named DB is a different one).
  const activeIsExpandedRoot =
    !!focusedConnectionId && focusedConnectionId === connectionId;
  const activeDbCollsPresent =
    !!activeDbName && !!ownGet(cache.colls, activeDbName);
  const activeDbCollsLoading =
    !!activeDbName && !!ownGet(cache.collsLoading, activeDbName);
  React.useEffect(() => {
    if (!connectionId || !activeIsExpandedRoot || !activeDbName || !dbsPresent) return;
    queueMicrotask(() => {
      dispatch({ type: 'dbExpandedSet', connectionId, dbName: activeDbName, value: true });
      if (!activeDbCollsPresent && !activeDbCollsLoading) {
        void loadColls(connectionId, activeDbName);
      }
    });
  }, [
    connectionId,
    activeIsExpandedRoot,
    activeDbName,
    dbsPresent,
    activeDbCollsPresent,
    activeDbCollsLoading,
    loadColls,
    dispatch,
  ]);

  const filterLower = filter.trim().toLowerCase();
  const filterActive = filterLower.length > 0;

  React.useEffect(() => {
    if (!filterActive || !connectionId || !cache.dbs) return;
    queueMicrotask(() => {
      if (!connectionId || !cache.dbs) return;
      for (const db of cache.dbs) {
        if (!ownGet(cache.colls, db.name) && !ownGet(cache.collsLoading, db.name)) {
          void loadColls(connectionId, db.name);
        }
      }
    });
  }, [filterActive, connectionId, cache.dbs, cache.colls, cache.collsLoading, loadColls]);

  const toggleDb = React.useCallback(
    (db: string) => {
      if (!connectionId) return;
      const next = !ownGet(dbExpanded, db);
      dispatch({ type: 'dbExpandedSet', connectionId, dbName: db, value: next });
      if (next && (isConnected || !ownGet(cache.colls, db)) && !ownGet(cache.collsLoading, db)) {
        void loadColls(connectionId, db);
      }
    },
    [connectionId, dbExpanded, cache.colls, cache.collsLoading, loadColls, isConnected, dispatch],
  );

  // Expanding one root collapses whichever was open (both persisted); expanding
  // a Dormant root also connects it, fire-and-forget like `reconnect` below.
  const toggleConnection = React.useCallback(
    (id: string) => {
      const next = expandedConnId === id ? null : id;
      if (expandedConnId && expandedConnId !== next) {
        void api.prefs.set(connExpandedKey(expandedConnId), false).catch(() => {});
      }
      void api.prefs.set(connExpandedKey(id), next === id).catch(() => {});
      if (next === id && isKnownNotConnected(connections.find((c) => c.id === id))) {
        void api.mongo.connect(id).catch(() => {});
      }
      dispatch({ type: 'expandedConnSet', id: next });
    },
    [expandedConnId, connections, dispatch],
  );

  const refreshDb = React.useCallback(
    (id: string, dbName: string) => {
      // Dedup a rapid double-click: loadColls's own gate doesn't prevent the
      // listCollections call itself. `ownGet`, not `?.` — a hostile `id` can
      // resolve to a truthy inherited Object.prototype member.
      const c = ownGet(caches, id);
      if (c && ownGet(c.collsLoading, dbName)) return;
      void loadColls(id, dbName);
    },
    [caches, loadColls],
  );

  // Re-populates every previously-expanded DB (except the active one, already
  // re-fetched elsewhere) after a whole-connection refresh. Keyed by
  // connectionId so an in-flight refresh on one Connection can't block another.
  const refreshInFlightRef = React.useRef<Set<string>>(new Set());
  const refreshAll = React.useCallback(
    async (id: string) => {
      if (refreshInFlightRef.current.has(id)) return;
      refreshInFlightRef.current.add(id);
      try {
        const previouslyExpanded = ownGet(expandedRef.current, id) ?? {};
        dispatch({ type: 'cacheReset', id });
        const dbs = await loadDbs(id);
        const pending: Promise<void>[] = [];
        for (const db of dbs ?? []) {
          if (ownGet(previouslyExpanded, db.name) && db.name !== activeDbNameRef.current) {
            pending.push(loadColls(id, db.name));
          }
        }
        await Promise.allSettled(pending);
      } finally {
        refreshInFlightRef.current.delete(id);
      }
    },
    [dispatch, loadDbs, loadColls],
  );

  const {
    menu,
    createCollDb,
    renameTarget,
    dropCollTarget,
    dropDbTarget,
    importTarget,
    menuTrigger,
    setMenu,
    setCreateCollDb,
    setRenameTarget,
    setDropCollTarget,
    setDropDbTarget,
    setImportTarget,
    setMenuTrigger,
    closeMenu,
    cancelCreateColl,
    handleCollectionCreated,
    cancelRename,
    handleCollectionRenamed,
    cancelDropColl,
    handleCollectionDropped,
    cancelDropDb,
    handleDatabaseDropped,
    closeImport,
    handleImported,
  } = useNavigatorDialogs({
    refreshDb,
    refreshAll,
    onCollectionRenamed,
    onCollectionDropped,
    onDatabaseDropped,
  });

  const disconnect = React.useCallback((id: string) => {
    void disconnectConnection(id);
  }, []);

  const reconnect = React.useCallback((id: string) => {
    void api.mongo.connect(id).catch(() => {});
  }, []);

  const retryDatabases = React.useCallback((cid: string) => void loadDbs(cid), [loadDbs]);

  const onCreateCollection = React.useCallback((cid: string, db: string) => {
    setMenuTrigger(null);
    setCreateCollDb({ connectionId: cid, dbName: db });
  }, [setMenuTrigger, setCreateCollDb]);

  // Flat row list, used for both rendering and keyboard navigation.
  const rows = React.useMemo<TreeRow[]>(() => {
    const matches = (name: string) =>
      !filterActive || name.toLowerCase().includes(filterLower);
    const out: TreeRow[] = [];
    for (const conn of connections) {
      // Open/Connecting/Failed always root; Dormant (has tabs, no client) roots
      // greyed; Saved (no client, no tabs) has no root at all.
      const hasRoot =
        conn.status === 'connected' ||
        conn.status === 'connecting' ||
        conn.status === 'error' ||
        connectionsWithTabs.has(conn.id);
      if (!hasRoot) continue;
      const isExpanded = conn.id === connectionId;
      // #66 — computed up front so the row below can carry it: `cache` is
      // only ever this connection's own cache when `isExpanded` (it's a
      // single value keyed by the one open root), so `dberr` can only apply
      // here, never to a collapsed sibling.
      const errorRowId =
        conn.status === 'error'
          ? navigatorRowDomId(`connerr:${conn.id}`)
          : isExpanded && isConnected && cache.err
            ? navigatorRowDomId(`dberr:${conn.id}`)
            : null;
      out.push({
        kind: 'connection',
        id: `conn:${conn.id}`,
        conn,
        isExpanded,
        isConnected: conn.status === 'connected',
        dbCount: isExpanded && isConnected && cache.dbs ? cache.dbs.length : null,
        errorRowId,
      });
      // A failed connect explains itself on its own root, expanded or not.
      if (conn.status === 'error') {
        out.push({
          kind: 'conn-error',
          id: `connerr:${conn.id}`,
          conn,
          title: 'Could not connect',
          message: ownGet(connectErrors, conn.id)?.message ?? GENERIC_CONNECT_ERROR,
          code: ownGet(connectErrors, conn.id)?.code,
          retry: 'connect',
          retryLabel: `Retry connecting to ${conn.name}`,
        });
        continue;
      }
      if (!isExpanded) continue;
      if (!isConnected) {
        out.push({
          kind: 'db-empty',
          id: `no-client:${conn.id}`,
          text: conn.status === 'connecting' ? 'Connecting…' : 'Not connected. Nothing to browse.',
        });
        continue;
      }
      if (cache.err) {
        out.push({
          kind: 'conn-error',
          id: `dberr:${conn.id}`,
          conn,
          title: "Couldn't load databases",
          message: cache.err.message,
          retry: 'databases',
          retryLabel: `Retry loading databases for ${conn.name}`,
        });
        continue;
      }
      if (cache.dbs === null) {
        for (let i = 0; i < 3; i += 1) {
          out.push({ kind: 'db-skeleton', id: `dbskel:${conn.id}:${i}`, index: i });
        }
        continue;
      }
      if (cache.dbs.length === 0) {
        out.push({ kind: 'db-empty', id: `nodbs:${conn.id}`, text: 'No databases.' });
        continue;
      }
      for (const db of cache.dbs) {
        const dbIsExpanded = filterActive ? true : !!ownGet(dbExpanded, db.name);
        const colls = ownGet(cache.colls, db.name);
        const filteredColls = colls ? colls.filter((c) => matches(c.name)) : null;
        if (filterActive && filteredColls && filteredColls.length === 0) continue;
        out.push({
          kind: 'db',
          id: `db:${conn.id}:${db.name}`,
          connectionId: conn.id,
          db,
          isExpanded: dbIsExpanded,
          count: colls ? colls.length : null,
          refreshing: !!colls && !!ownGet(cache.collsLoading, db.name),
        });
        if (!dbIsExpanded) continue;
        if (!colls && ownGet(cache.collsLoading, db.name)) {
          for (let i = 0; i < 3; i += 1) {
            out.push({ kind: 'skeleton', id: `skel:${conn.id}:${db.name}:${i}`, dbName: db.name });
          }
          continue;
        }
        if (colls && (!filteredColls || filteredColls.length === 0)) {
          out.push({ kind: 'coll-empty', id: `empty:${conn.id}:${db.name}`, dbName: db.name });
          continue;
        }
        for (const c of filteredColls ?? []) {
          out.push({
            kind: 'coll',
            id: `coll:${conn.id}:${db.name}:${c.name}`,
            connectionId: conn.id,
            dbName: db.name,
            coll: c,
            isActive:
              conn.id === focusedConnectionId &&
              db.name === activeDbName &&
              c.name === activeCollection,
          });
        }
      }
    }
    return out;
  }, [
    connections,
    connectionsWithTabs,
    connectErrors,
    connectionId,
    isConnected,
    focusedConnectionId,
    cache.err,
    cache.dbs,
    cache.colls,
    cache.collsLoading,
    dbExpanded,
    filterActive,
    filterLower,
    activeDbName,
    activeCollection,
  ]);

  const listRef = useListRef(null);
  const rowHeight = useDynamicRowHeight({ defaultRowHeight: 26 });

  React.useEffect(() => {
    const activeId =
      focusedConnectionId && activeDbName && activeCollection
        ? `coll:${focusedConnectionId}:${activeDbName}:${activeCollection}`
        : null;
    const focusedStillVisible = focusedId
      ? rows.some((r) => r.id === focusedId)
      : false;
    if (focusedId && focusedStillVisible) return;
    if (!focusedId && !activeId) return;
    queueMicrotask(() => {
      setFocusedId((prev) => {
        if (prev && rows.some((r) => r.id === prev)) return prev;
        return activeId ?? rows[0]?.id ?? null;
      });
    });
  }, [rows, focusedId, focusedConnectionId, activeDbName, activeCollection]);

  React.useEffect(() => {
    if (!focusedConnectionId || !activeDbName || !activeCollection) return;
    const idx = rows.findIndex(
      (r) =>
        r.kind === 'coll' &&
        r.connectionId === focusedConnectionId &&
        r.dbName === activeDbName &&
        r.coll.name === activeCollection,
    );
    if (idx >= 0) listRef.current?.scrollToRow({ index: idx, align: 'auto' });
  }, [focusedConnectionId, activeDbName, activeCollection, rows, listRef]);

  React.useEffect(() => {
    if (!focusedId) return;
    const idx = rows.findIndex((r) => r.id === focusedId);
    if (idx >= 0) listRef.current?.scrollToRow({ index: idx, align: 'auto' });
  }, [focusedId, rows, listRef]);

  const openFromRow = React.useCallback(
    (
      row: Extract<TreeRow, { kind: 'coll' }>,
      opts: { newTab?: boolean; aggregation?: boolean },
    ) => {
      const input: NavigatorOpenInput = {
        connectionId: row.connectionId,
        dbName: row.dbName,
        collection: row.coll.name,
      };
      if (opts.aggregation) {
        onOpenAggregation(input);
      } else {
        onOpenCollection(input, { reuseExisting: !opts.newTab });
      }
    },
    [onOpenCollection, onOpenAggregation],
  );

  const handleCollClick = React.useCallback((
    e: React.MouseEvent,
    row: Extract<TreeRow, { kind: 'coll' }>,
  ) => {
    e.preventDefault();
    setFocusedId(row.id);
    if (e.altKey) {
      openFromRow(row, { aggregation: true });
      return;
    }
    openFromRow(row, { newTab: e.metaKey || e.ctrlKey });
  }, [openFromRow]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // #66 — a key bubbling up from a nested real control (Retry, Cancel,
    // Create collection, Refresh…) is that control's own action, not the
    // tree's roving-focus navigation. Without this, an ancestor
    // `preventDefault()` on the bubble phase cancels the button's own
    // Enter-activates-click default action before it fires — mirrors
    // `useRovingFocus`'s identical guard and TableView/TreeView's copy of it.
    if (e.target !== e.currentTarget) return;
    if (rows.length === 0) return;
    const idx = focusedId ? rows.findIndex((r) => r.id === focusedId) : -1;
    const row = idx >= 0 ? rows[idx] : null;

    // #55 — Shift+F10 / ContextMenu key: open the menu for the focused row,
    // anchored to its bounding rect, not a stale cursor position. #133 — the
    // list is virtualized, and PageDown or the wheel can have scrolled that
    // row out and unmounted it: open anyway (anchored to the tree) and bring
    // the row back into view.
    if (isContextMenuKey(e)) {
      if (!row) return;
      e.preventDefault();
      const rowEl = document.getElementById(navigatorRowDomId(row.id));
      const anchor = anchorForRow(rowEl, treeRef.current);
      if (!anchor) return;
      if (!rowEl) listRef.current?.scrollToRow({ index: idx, align: 'auto' });
      openMenuFor(row, anchor);
      return;
    }

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        // #66 — start the search AT `idx` (not `idx + 1`) whenever the
        // currently focused row isn't itself navigable, so a stray
        // placeholder focus (should never happen — see the audit at this
        // ticket's call sites) still recovers to the nearest navigable row
        // below it, rather than skipping one past it.
        const from = idx < 0 ? 0 : row && isNavigableRow(row) ? idx + 1 : idx;
        const next = nearestNavigableIndex(rows, from, 1);
        if (next >= 0) setFocusedId(rows[next].id);
        return;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const from = idx < 0 ? 0 : row && isNavigableRow(row) ? idx - 1 : idx;
        const next = nearestNavigableIndex(rows, from, -1);
        if (next >= 0) setFocusedId(rows[next].id);
        return;
      }
      case 'ArrowRight': {
        if (!row) return;
        e.preventDefault();
        if (row.kind === 'connection') {
          if (!row.isExpanded) {
            toggleConnection(row.conn.id);
          } else {
            const next = firstNavigableInSubtree(rows, idx, ['connection']);
            if (next >= 0) setFocusedId(rows[next].id);
          }
        } else if (row.kind === 'db') {
          if (!row.isExpanded) {
            toggleDb(row.db.name);
          } else {
            const next = firstNavigableInSubtree(rows, idx, ['db', 'connection']);
            if (next >= 0) setFocusedId(rows[next].id);
          }
        }
        return;
      }
      case 'ArrowLeft': {
        if (!row) return;
        e.preventDefault();
        // #66 — `row` can only ever be `connection`/`db`/`coll` now (the
        // invariant every other case here maintains), so the old
        // `conn-error` branch and its final `else if (connectionId)`
        // catch-all — the fallback for a placeholder having somehow been
        // focused — are unreachable and gone.
        if (row.kind === 'connection' && row.isExpanded) {
          toggleConnection(row.conn.id);
        } else if (row.kind === 'db' && row.isExpanded) {
          toggleDb(row.db.name);
        } else if (row.kind === 'db') {
          setFocusedId(`conn:${row.connectionId}`);
        } else if (row.kind === 'coll') {
          setFocusedId(`db:${row.connectionId}:${row.dbName}`);
        }
        return;
      }
      case 'Home': {
        e.preventDefault();
        const next = nearestNavigableIndex(rows, 0, 1);
        if (next >= 0) setFocusedId(rows[next].id);
        return;
      }
      case 'End': {
        e.preventDefault();
        const next = nearestNavigableIndex(rows, rows.length - 1, -1);
        if (next >= 0) setFocusedId(rows[next].id);
        return;
      }
      case 'Enter': {
        if (!row) return;
        e.preventDefault();
        if (row.kind === 'connection') {
          toggleConnection(row.conn.id);
        } else if (row.kind === 'db') {
          toggleDb(row.db.name);
        } else if (row.kind === 'coll') {
          if (e.altKey) openFromRow(row, { aggregation: true });
          else openFromRow(row, { newTab: e.metaKey || e.ctrlKey });
        }
        return;
      }
      default:
        return;
    }
  };

  // #58/#66 — the container (not a row) always holds real DOM focus; the
  // active row is only named via `aria-activedescendant`, and only when it's
  // `isNavigableRow` — `focusedId` can no longer land on a placeholder (see
  // the onKeyDown audit above), but this stays defensive rather than assuming.
  const focusedRow = focusedId ? rows.find((r) => r.id === focusedId) : undefined;
  const activeDescendantId =
    focusedRow && isNavigableRow(focusedRow) ? navigatorRowDomId(focusedRow.id) : undefined;

  const buildCollMenu = React.useCallback((
    row: Extract<TreeRow, { kind: 'coll' }>,
  ): MenuItem[] => [
    { kind: 'item', label: 'Open', icon: I.open, onClick: () => openFromRow(row, {}) },
    { kind: 'item', label: 'Open in new tab', icon: I.openTab, onClick: () => openFromRow(row, { newTab: true }) },
    { kind: 'item', label: 'Open as aggregation', icon: I.play, onClick: () => openFromRow(row, { aggregation: true }) },
    { kind: 'sep' },
    { kind: 'item', label: 'Copy name', icon: I.copy, onClick: () => void copyToClipboard(row.coll.name, 'Collection name copied to the clipboard.') },
    { kind: 'item', label: 'Copy namespace', icon: I.copy, onClick: () => void copyToClipboard(`${row.dbName}.${row.coll.name}`, 'Namespace copied to the clipboard.') },
    { kind: 'sep' },
    {
      kind: 'item',
      label: 'References…',
      icon: I.link,
      onClick: () => onOpenReferences?.(),
      disabled: !row.isActive || !onOpenReferences,
      disabledTitle: 'Open this collection first',
    },
    { kind: 'sep' },
    // A view holds no documents of its own to import into.
    ...(row.coll.type === 'view'
      ? []
      : [{
          kind: 'item' as const,
          label: 'Import documents…',
          icon: I.upload,
          onClick: () =>
            setImportTarget({
              connectionId: row.connectionId,
              dbName: row.dbName,
              collection: row.coll.name,
            }),
        }]),
    row.coll.type === 'view'
      ? {
          kind: 'item',
          label: 'Modify view',
          icon: I.edit,
          onClick: () => {},
          disabled: true,
          disabledTitle: 'Coming soon',
        }
      : {
          kind: 'item',
          label: 'Rename collection',
          icon: I.edit,
          onClick: () =>
            setRenameTarget({
              connectionId: row.connectionId,
              dbName: row.dbName,
              collection: row.coll.name,
            }),
        },
    {
      kind: 'item',
      label: row.coll.type === 'view' ? 'Drop view' : 'Drop collection',
      icon: I.trash,
      onClick: () =>
        setDropCollTarget({
          connectionId: row.connectionId,
          dbName: row.dbName,
          collection: row.coll.name,
        }),
      destructive: true,
    },
  ], [openFromRow, setRenameTarget, setDropCollTarget, setImportTarget, onOpenReferences]);

  const buildDbMenu = React.useCallback((row: Extract<TreeRow, { kind: 'db' }>): MenuItem[] => [
    {
      kind: 'item',
      label: 'Create collection',
      icon: I.plus,
      onClick: () => setCreateCollDb({ connectionId: row.connectionId, dbName: row.db.name }),
    },
    {
      kind: 'item',
      label: 'Refresh collections',
      icon: I.sync,
      onClick: () => refreshDb(row.connectionId, row.db.name),
    },
    { kind: 'item', label: 'Copy DB name', icon: I.copy, onClick: () => void copyToClipboard(row.db.name, 'Database name copied to the clipboard.') },
    { kind: 'sep' },
    {
      kind: 'item',
      label: 'Drop database',
      icon: I.trash,
      onClick: () => setDropDbTarget({ connectionId: row.connectionId, dbName: row.db.name }),
      destructive: true,
    },
  ], [refreshDb, setCreateCollDb, setDropDbTarget]);

  const buildConnectionMenu = React.useCallback((
    row: Extract<TreeRow, { kind: 'connection' }>,
    trigger: HTMLElement | null,
  ): MenuItem[] => {
    const id = row.conn.id;
    const items: MenuItem[] = [
      {
        kind: 'item',
        label: 'Refresh databases',
        icon: I.sync,
        onClick: () => void refreshAll(id),
        disabled: !row.isExpanded || !row.isConnected,
        disabledTitle: row.isConnected ? 'Expand this connection first' : 'Not connected',
      },
      {
        kind: 'item',
        label: 'Edit connection',
        icon: I.edit,
        onClick: () => onEditConnection?.(id, trigger),
        disabled: !onEditConnection,
        disabledTitle: 'Edit navigation not available',
      },
      {
        kind: 'item',
        label: 'Copy connection string',
        icon: I.copy,
        onClick: () => {},
        disabled: true,
        disabledTitle: 'Coming soon',
      },
      { kind: 'sep' },
    ];
    if (row.isConnected) {
      items.push({
        kind: 'item',
        label: 'Disconnect',
        icon: I.close,
        // Routed through the caller's confirm flow, unlike "Cancel connecting" below.
        onClick: () => onDisconnect?.(id, trigger),
        destructive: true,
        disabled: !onDisconnect,
        disabledTitle: 'Disconnect not available',
      });
    } else if (row.conn.status === 'connecting') {
      items.push({
        kind: 'item',
        label: 'Cancel connecting',
        icon: I.close,
        onClick: () => disconnect(id),
      });
    } else {
      items.push({
        kind: 'item',
        label: 'Reconnect',
        icon: I.sync,
        onClick: () => reconnect(id),
      });
    }
    return items;
  }, [refreshAll, onEditConnection, onDisconnect, disconnect, reconnect]);

  // #55/#69 — shared by the mouse (`onRowContextMenu`) and keyboard
  // (Shift+F10 / ContextMenu key, in `onKeyDown` above) open paths; only the
  // anchor coordinate differs between them now — both hand `ContextMenu` the
  // same `returnFocusTo` (see below).
  const openMenuFor = React.useCallback(
    (row: TreeRow, anchor: { x: number; y: number }) => {
      setFocusedId(row.id);
      // #58 — used to be `e.currentTarget` (the row itself). Rows no longer
      // carry a `tabIndex` (see ConnectionRow/DbRow/CollRow below), so a row
      // is not a valid `.focus()` target any more — `useDialogFocusReturn`
      // would silently no-op and drop focus to `<body>`. The tree container
      // is the one thing here that always holds real focus and always stays
      // mounted (a row can scroll out of the virtualized window and unmount),
      // so it's what every dialog this menu can open — and `onEditConnection`/
      // `onDisconnect`, which hand `trigger` on to `Workspace.tsx` — return
      // focus to. `focusedId` (set just above) still names the right row, so
      // `aria-activedescendant` keeps pointing at it.
      const trigger = treeRef.current;
      setMenuTrigger(trigger);
      let items: MenuItem[] = [];
      if (row.kind === 'coll') items = buildCollMenu(row);
      else if (row.kind === 'db') items = buildDbMenu(row);
      else if (row.kind === 'connection') items = buildConnectionMenu(row, trigger);
      if (items.length === 0) return;
      setMenu({
        ...anchor,
        items,
        // #69 — set on both open paths now (`trigger` is a valid focus
        // target for either — see the comment above), so Escape/click-away
        // no longer strands focus on `<body>` after a right-click. Mantine's
        // own `FocusTrap` already grabs focus into the menu on any open
        // regardless of this field (see `ContextMenuState.returnFocusTo`'s
        // docstring) — only the close-time restore was missing for a mouse
        // open, and this is that.
        returnFocusTo: trigger,
      });
    },
    [setMenuTrigger, buildCollMenu, buildDbMenu, buildConnectionMenu, setMenu],
  );

  const onRowContextMenu = React.useCallback(
    (e: React.MouseEvent, row: TreeRow) => {
      e.preventDefault();
      e.stopPropagation();
      openMenuFor(row, { x: e.clientX, y: e.clientY });
    },
    [openMenuFor],
  );

  const spineFor = React.useCallback(
    (conn: ConnectionSummary) =>
      conn.status === 'connected' ? conn.color || T.greenDot : T.border,
    [T.greenDot, T.border],
  );
  const subtreeSpine = expandedConn ? spineFor(expandedConn) : T.border;

  const readOnlyOf = React.useCallback(
    (id: string) => connections.find((c) => c.id === id)?.readOnly ?? false,
    [connections],
  );

  // Memoized so <List> gets the same object across renders that don't touch
  // any of these fields — a fresh literal here would re-trigger every visible
  // row (TableView's and TreeView's rowProps are memoized the same way).
  const rowProps = React.useMemo<NavRowProps>(
    () => ({
      rows,
      focusedId,
      focusedConnectionId,
      activeDbName,
      isConnected,
      subtreeSpine,
      spineFor,
      T,
      setFocusedId,
      toggleConnection,
      toggleDb,
      refreshDb,
      cancelConnection: disconnect,
      retryConnection: reconnect,
      reenterPassword: onEditConnection,
      retryDatabases,
      onCreateCollection,
      handleCollClick,
      onRowContextMenu,
    }),
    [
      rows,
      focusedId,
      focusedConnectionId,
      activeDbName,
      isConnected,
      subtreeSpine,
      spineFor,
      T,
      toggleConnection,
      toggleDb,
      refreshDb,
      disconnect,
      reconnect,
      onEditConnection,
      retryDatabases,
      onCreateCollection,
      handleCollClick,
      onRowContextMenu,
    ],
  );

  return (
    <div
      aria-label="Database navigator"
      style={{
        // AppShell.Navbar pins width via its own CSS var; 100% fills it there.
        width: width ?? '100%',
        height: '100%',
        borderRight: `1px solid ${T.border}`,
        background: T.surface,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      {/* Filter + refresh row */}
      <div
        style={{
          padding: '8px 10px',
          borderBottom: `1px solid ${T.border}`,
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 8px',
            background: T.surfaceRaised,
            border: `1px solid ${T.border}`,
            borderRadius: T.rs,
            color: T.textGhost,
          }}
        >
          {I.search}
          <input
            aria-label="Filter collections"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: 12,
              color: T.text,
              minWidth: 0,
            }}
          />
        </div>
        <button
          onClick={() => {
            if (connectionId) void refreshAll(connectionId);
          }}
          aria-label="Refresh"
          title="Refresh connection"
          disabled={!connectionId || !isConnected}
          style={{
            background: 'none',
            border: `1px solid ${T.border}`,
            borderRadius: T.rs,
            padding: '4px 6px',
            cursor: connectionId && isConnected ? 'pointer' : 'not-allowed',
            color: T.textMuted,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          {I.sync}
        </button>
      </div>

      {/* Tree (connection → DB → collection). The container owns ARIA + keyboard
          nav; <List> owns the scroll viewport. */}
      <div
        ref={treeRef}
        role="tree"
        tabIndex={0}
        aria-label="Databases and collections"
        aria-activedescendant={activeDescendantId}
        onKeyDown={onKeyDown}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          outline: 'none',
        }}
      >
        {/* Both failure surfaces — a failed connect and a failed db list —
            are `conn-error` rows inside the list now, so each sits on
            the root it belongs to rather than above all of them. */}
        {rows.length > 0 && (
          <List<NavRowProps>
            listRef={listRef}
            rowComponent={NavRow as typeof NavRowImpl}
            rowCount={rows.length}
            rowHeight={rowHeight}
            overscanCount={8}
            rowProps={rowProps}
            style={{
              flex: 1,
              minHeight: 0,
            }}
          />
        )}

      </div>

      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}

      {createCollDb && (
        <CreateCollectionDrawer
          connectionId={createCollDb.connectionId}
          dbName={createCollDb.dbName}
          returnFocusTo={menuTrigger}
          onCancel={cancelCreateColl}
          onCreated={handleCollectionCreated}
        />
      )}

      {renameTarget && (
        <RenameCollectionModal
          connectionId={renameTarget.connectionId}
          dbName={renameTarget.dbName}
          collection={renameTarget.collection}
          returnFocusTo={menuTrigger}
          onCancel={cancelRename}
          onRenamed={handleCollectionRenamed}
        />
      )}

      {dropCollTarget && (
        <DropCollectionConfirm
          connectionId={dropCollTarget.connectionId}
          dbName={dropCollTarget.dbName}
          collection={dropCollTarget.collection}
          readOnly={readOnlyOf(dropCollTarget.connectionId)}
          returnFocusTo={menuTrigger}
          onCancel={cancelDropColl}
          onDropped={handleCollectionDropped}
        />
      )}

      {importTarget && (
        <ImportDialog
          connectionId={importTarget.connectionId}
          dbName={importTarget.dbName}
          collection={importTarget.collection}
          readOnly={readOnlyOf(importTarget.connectionId)}
          returnFocusTo={menuTrigger}
          onClose={closeImport}
          onImported={handleImported}
          onPartialImport={handleImported}
        />
      )}

      {dropDbTarget && (
        <DropDatabaseConfirm
          connectionId={dropDbTarget.connectionId}
          dbName={dropDbTarget.dbName}
          readOnly={readOnlyOf(dropDbTarget.connectionId)}
          returnFocusTo={menuTrigger}
          onCancel={cancelDropDb}
          onDropped={handleDatabaseDropped}
        />
      )}
    </div>
  );
}

interface NavRowProps {
  rows: TreeRow[];
  focusedId: string | null;
  focusedConnectionId: string | null;
  activeDbName: string | null;
  isConnected: boolean;
  subtreeSpine: string;
  spineFor: (conn: ConnectionSummary) => string;
  T: Theme;
  setFocusedId: (id: string | null) => void;
  toggleConnection: (id: string) => void;
  toggleDb: (db: string) => void;
  refreshDb: (connectionId: string, db: string) => void;
  /** Cancels an in-flight connect — this is `mongo:disconnect`. */
  cancelConnection: (connectionId: string) => void;
  retryConnection: (connectionId: string) => void;
  /** Opens the edit form with the password field focused (#396). */
  reenterPassword?: DbCollectionNavigatorProps['onEditConnection'];
  retryDatabases: (connectionId: string) => void;
  onCreateCollection: (connectionId: string, dbName: string) => void;
  handleCollClick: (e: React.MouseEvent, row: Extract<TreeRow, { kind: 'coll' }>) => void;
  onRowContextMenu: (e: React.MouseEvent, row: TreeRow) => void;
}

function NavRowImpl({
  index,
  style,
  rows,
  focusedId,
  focusedConnectionId,
  activeDbName,
  isConnected,
  subtreeSpine,
  spineFor,
  T,
  setFocusedId,
  toggleConnection,
  toggleDb,
  refreshDb,
  cancelConnection,
  retryConnection,
  reenterPassword,
  retryDatabases,
  onCreateCollection,
  handleCollClick,
  onRowContextMenu,
}: RowComponentProps<NavRowProps>) {
  const row = rows[index]!;
  // #66 — guarded by `isNavigableRow` too: only these three kinds carry the
  // `id`/outline `isFocused` drives (see the `activeDescendantId` comment above).
  const isFocused = isNavigableRow(row) && row.id === focusedId;
  let content: React.ReactNode;
  if (row.kind === 'connection') {
    content = (
      <ConnectionRow
        T={T}
        id={navigatorRowDomId(row.id)}
        conn={row.conn}
        isConnected={row.isConnected}
        isExpanded={row.isExpanded}
        dbCount={row.dbCount}
        errorRowId={row.errorRowId}
        isFocused={isFocused}
        onClick={() => {
          setFocusedId(row.id);
          toggleConnection(row.conn.id);
        }}
        onCancel={() => cancelConnection(row.conn.id)}
        onContextMenu={(e) => onRowContextMenu(e, row)}
      />
    );
  } else if (row.kind === 'conn-error') {
    content = (
      <ConnErrorRow
        T={T}
        row={row}
        onRetry={() =>
          row.retry === 'connect'
            ? retryConnection(row.conn.id)
            : retryDatabases(row.conn.id)
        }
        onReenterPassword={
          reenterPassword &&
          ((el) => reenterPassword(row.conn.id, el, { focus: 'password' }))
        }
      />
    );
  } else if (row.kind === 'db') {
    content = (
      <DbRow
        T={T}
        row={row}
        isActiveDb={
          row.connectionId === focusedConnectionId && row.db.name === activeDbName
        }
        isFocused={isFocused}
        dimmed={!isConnected}
        onClick={() => {
          setFocusedId(row.id);
          toggleDb(row.db.name);
        }}
        onContextMenu={(e) => onRowContextMenu(e, row)}
        onRefresh={() => refreshDb(row.connectionId, row.db.name)}
        onCreateCollection={() => onCreateCollection(row.connectionId, row.db.name)}
      />
    );
  } else if (row.kind === 'skeleton') {
    content = <SkeletonRow T={T} />;
  } else if (row.kind === 'db-skeleton') {
    content = <DbSkeletonRow T={T} index={row.index} />;
  } else if (row.kind === 'db-empty') {
    content = (
      <div style={{ padding: '6px 10px 6px 32px', color: T.textMuted, fontSize: 12 }}>
        {row.text}
      </div>
    );
  } else if (row.kind === 'coll-empty') {
    content = (
      <div
        style={{
          padding: '4px 10px 4px 46px',
          fontSize: 11,
          color: T.textMuted,
          fontStyle: 'italic',
        }}
      >
        No collections
      </div>
    );
  } else {
    content = (
      <CollRow
        T={T}
        row={row}
        isFocused={isFocused}
        dimmed={!isConnected}
        onClick={(e) => handleCollClick(e, row)}
        onContextMenu={(e) => onRowContextMenu(e, row)}
      />
    );
  }
  // An error row reads its own Connection's rail, not subtreeSpine — it can
  // sit under a root that isn't the expanded one.
  const spine =
    row.kind === 'connection' || row.kind === 'conn-error'
      ? spineFor(row.conn)
      : subtreeSpine;
  return (
    <div style={{ ...style, borderLeft: `${SPINE_WIDTH}px solid ${spine}` }}>
      {content}
    </div>
  );
}

// All fields of NavRowProps are memoized at the call site (see `rowProps`
// above), so a plain shallow comparison correctly skips a row whenever
// nothing it actually reads has changed.
const NavRow = React.memo(NavRowImpl);

function DbSkeletonRow({ T, index }: { T: Theme; index: number }) {
  return (
    <div
      data-testid="nav-db-skeleton"
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '4px 10px 4px 28px',
      }}
    >
      <span
        style={{
          height: 10,
          width: 110 + index * 12,
          background: T.surfaceRaised,
          border: `1px solid ${T.border}`,
          borderRadius: T.rx,
          // T153 contrast audit: non-text shimmer block, not read as text — exempt from AA.
          opacity: 0.6,
        }}
      />
    </div>
  );
}

function SkeletonRow({ T }: { T: Theme }) {
  return (
    <div
      data-testid="nav-coll-skeleton"
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '4px 10px 4px 46px',
      }}
    >
      <span
        style={{
          height: 9,
          width: 90,
          background: T.surfaceRaised,
          border: `1px solid ${T.border}`,
          borderRadius: T.rx,
          // T153 contrast audit: non-text shimmer block, not read as text — exempt from AA.
          opacity: 0.6,
        }}
      />
    </div>
  );
}

/**
 * A failure on the root it happened to. Deliberately not a
 * colour-only signal: the heading is a sentence, the driver's own message is
 * printed in full, and the Retry names the Connection it acts on, so a person
 * reading five roots knows which one is down without matching hues.
 */
function ConnErrorRow({
  T,
  row,
  onRetry,
  onReenterPassword,
}: {
  T: Theme;
  row: Extract<TreeRow, { kind: 'conn-error' }>;
  onRetry: () => void;
  onReenterPassword?: (trigger: HTMLElement) => void;
}) {
  const buttonStyle: React.CSSProperties = {
    padding: '3px 10px',
    fontSize: 11,
    border: `1px solid ${T.border}`,
    borderRadius: T.rs,
    background: T.surface,
    color: T.text,
    cursor: 'pointer',
  };
  return (
    <div
      id={navigatorRowDomId(row.id)}
      role="alert"
      data-testid="nav-connection-error"
      data-connection-id={row.conn.id}
      style={{
        margin: '4px 10px 6px 22px',
        padding: 8,
        border: `1px solid ${T.borderMed}`,
        borderRadius: T.rs,
        background: T.surfaceRaised,
        fontSize: 12,
      }}
    >
      <div style={{ color: T.warnText, marginBottom: 4, fontWeight: 600 }}>
        {row.title}
      </div>
      <div style={{ color: T.textMuted, marginBottom: 6, overflowWrap: 'anywhere' }}>
        {row.message}
      </div>
      {/* A denied macOS keychain stays denied until relaunch, so Retry cannot succeed. */}
      {row.code !== 'KEYCHAIN_BLOCKED' && (
        <button
          type="button"
          aria-label={row.retryLabel}
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
          style={buttonStyle}
        >
          Retry
        </button>
      )}
      {row.code === 'SECRET_UNREADABLE' && onReenterPassword && (
        <button
          type="button"
          aria-label={`Re-enter password for ${row.conn.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onReenterPassword(e.currentTarget);
          }}
          style={{ ...buttonStyle, marginLeft: 6 }}
        >
          Re-enter password
        </button>
      )}
    </div>
  );
}

function ConnectionRow({
  T,
  id,
  conn,
  isConnected,
  isExpanded,
  dbCount,
  isFocused,
  errorRowId,
  onClick,
  onCancel,
  onContextMenu,
}: {
  T: Theme;
  id: string;
  conn: ConnectionSummary;
  isConnected: boolean;
  isExpanded: boolean;
  dbCount: number | null;
  isFocused: boolean;
  /** #66 — DOM id of this root's own conn-error row, when it has one. */
  errorRowId: string | null;
  onClick: () => void;
  onCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  // Status is spoken in words, never colour alone (a11y).
  const statusWord = isConnected
    ? 'Connected'
    : conn.status === 'connecting'
      ? 'Connecting'
      : conn.status === 'error'
        ? 'Connection failed'
        : 'Not connected';
  return (
    <div
      id={id}
      role="treeitem"
      aria-level={1}
      aria-expanded={isExpanded}
      aria-label={`${conn.name}. ${statusWord}${conn.readOnly ? '. Read-only' : ''}`}
      // #66 — names this root's own error message, when it has one, so a
      // keyboard/AT user landed on the root (not just on the Retry button)
      // hears why it failed, not just that it did.
      aria-describedby={errorRowId ?? undefined}
      data-testid="nav-connection"
      data-connection-id={conn.id}
      // #58 — no `tabIndex` here, not even -1. Per the HTML focusing-steps
      // algorithm any declared tabindex (negative included) makes an
      // element click-focusable, and with rows virtualized inside a
      // react-window `<List>` a row that holds real focus can unmount
      // mid-scroll, stranding focus on `<body>`. The container above keeps
      // real focus and `aria-activedescendant` (computed from `focusedId`)
      // names this row instead.
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={`Status: ${conn.status}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        cursor: 'pointer',
        userSelect: 'none',
        padding: '5px 10px',
        color: isConnected ? T.text : T.textMuted,
        fontWeight: 600,
        background: isFocused ? T.accentSoft : 'transparent',
        outline: isFocused ? `1px solid ${T.accentBorder}` : 'none',
        outlineOffset: -1,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          width: 10,
          color: T.textGhost,
          transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
          transition: 'transform 120ms',
        }}
      >
        {I.chevD}
      </span>
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {conn.name}
      </span>
      {conn.readOnly && (
        <span
          style={{
            fontSize: 9,
            letterSpacing: 0.5,
            padding: '0 4px',
            borderRadius: T.rx,
            border: `1px solid ${T.warnBorder}`,
            background: T.warnSoft,
            color: T.warnText,
          }}
        >
          RO
        </span>
      )}
      {!isConnected && (
        <span style={{ fontSize: 10, color: T.textGhost }}>
          {conn.status === 'connecting'
            ? 'connecting'
            : conn.status === 'error'
              ? 'failed'
              : 'not connected'}
        </span>
      )}
      {/* Spec §4.3 — Cancel a connect that is still in flight, on the root
          itself. A word rather than an icon, and the accessible name says
          which Connection it drops: with five roots, "Cancel" alone is a
          question. `stopPropagation` keeps the click off the row's own
          expand/collapse. */}
      {conn.status === 'connecting' && (
        <button
          type="button"
          aria-label={`Cancel connecting to ${conn.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
          style={{
            fontSize: 10,
            padding: '1px 6px',
            border: `1px solid ${T.border}`,
            borderRadius: T.rx,
            background: T.surface,
            color: T.text,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          Cancel
        </button>
      )}
      {dbCount !== null && (
        <span style={{ fontSize: 10, color: T.textGhost }}>{dbCount}</span>
      )}
    </div>
  );
}

function DbRow({
  T,
  row,
  isActiveDb,
  isFocused,
  dimmed,
  onClick,
  onContextMenu,
  onRefresh,
  onCreateCollection,
}: {
  T: Theme;
  row: Extract<TreeRow, { kind: 'db' }>;
  isActiveDb: boolean;
  isFocused: boolean;
  dimmed: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRefresh: () => void;
  onCreateCollection: () => void;
}) {
  const [hovered, setHovered] = React.useState(false);
  const barVisible = hovered || isFocused;
  return (
    <div
      id={navigatorRowDomId(row.id)}
      role="treeitem"
      aria-level={2}
      aria-expanded={row.isExpanded}
      data-testid={`nav-db-${row.db.name}`}
      // #58 — see ConnectionRow's comment: no `tabIndex`, real focus stays
      // on the container, this row is only named via `aria-activedescendant`.
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        cursor: 'pointer',
        userSelect: 'none',
        padding: '4px 6px 4px 18px',
        color: !dimmed && isActiveDb ? T.text : T.textMuted,
        fontWeight: isActiveDb ? 600 : 500,
        background: isActiveDb
          ? T.surfaceRaised
          : isFocused
            ? T.accentSoft
            : 'transparent',
        outline: isFocused ? `1px solid ${T.accentBorder}` : 'none',
        outlineOffset: -1,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          width: 10,
          color: T.textGhost,
          transform: row.isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
          transition: 'transform 120ms',
        }}
      >
        {I.chevD}
      </span>
      <span style={{ display: 'inline-flex', color: T.textGhost }}>{I.db}</span>
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {row.db.name}
      </span>
      {/* Hover action bar */}
      <div
        aria-hidden={!barVisible}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          visibility: barVisible ? 'visible' : 'hidden',
          opacity: barVisible ? 1 : 0,
          transition: 'opacity 80ms',
        }}
      >
        <HoverBarButton
          T={T}
          label="Create collection"
          icon={I.plus}
          onClick={(e) => {
            e.stopPropagation();
            onCreateCollection();
          }}
        />
        <HoverBarButton
          T={T}
          label="Refresh collections"
          icon={I.sync}
          onClick={(e) => {
            e.stopPropagation();
            onRefresh();
          }}
        />
      </div>
      {row.count !== null && !barVisible && !row.refreshing && (
        <span style={{ fontSize: 10, color: T.textGhost }}>{row.count}</span>
      )}
      {row.refreshing && (
        <span
          data-testid={`nav-db-spinner-${row.db.name}`}
          role="status"
          aria-label="Refreshing collections"
          style={{
            display: 'inline-flex',
            color: T.textGhost,
            animation: 'spin 0.7s linear infinite',
          }}
        >
          {I.sync}
        </span>
      )}
    </div>
  );
}

function HoverBarButton({
  T,
  label,
  icon,
  onClick,
  disabled,
  disabledTitle,
}: {
  T: Theme;
  label: string;
  icon: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  return (
    <button
      aria-label={label}
      title={disabled ? (disabledTitle ?? label) : label}
      disabled={disabled}
      onClick={(e) => {
        if (disabled) {
          e.stopPropagation();
          return;
        }
        onClick(e);
      }}
      style={{
        background: 'none',
        border: 'none',
        padding: 2,
        borderRadius: T.rx,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? T.textGhost : T.textMuted,
        display: 'inline-flex',
        alignItems: 'center',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        (e.currentTarget as HTMLButtonElement).style.background = T.surface;
        (e.currentTarget as HTMLButtonElement).style.color = T.text;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'none';
        (e.currentTarget as HTMLButtonElement).style.color = disabled
          ? T.textGhost
          : T.textMuted;
      }}
    >
      {icon}
    </button>
  );
}

function CollRow({
  T,
  row,
  isFocused,
  dimmed,
  onClick,
  onContextMenu,
}: {
  T: Theme;
  row: Extract<TreeRow, { kind: 'coll' }>;
  isFocused: boolean;
  dimmed: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { coll, isActive } = row;
  const icon =
    coll.type === 'view'
      ? I.view
      : coll.type === 'timeseries'
        ? I.timeseries
        : I.coll;
  return (
    <div
      id={navigatorRowDomId(row.id)}
      role="treeitem"
      aria-level={3}
      aria-selected={isActive}
      data-testid={`nav-coll-${row.dbName}-${coll.name}`}
      // #58 — see ConnectionRow's comment: no `tabIndex`, real focus stays
      // on the container, this row is only named via `aria-activedescendant`.
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={coll.type === 'view' ? 'View' : coll.type === 'timeseries' ? 'Time-series' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        cursor: 'pointer',
        userSelect: 'none',
        padding: '3px 10px 3px 46px',
        color: !dimmed && isActive ? T.accent : T.textMuted,
        background: isActive
          ? T.accentSoft
          : isFocused
            ? T.accentSoft
            : 'transparent',
        fontWeight: isActive ? 600 : 400,
        outline: isFocused && !isActive ? `1px solid ${T.accentBorder}` : 'none',
        outlineOffset: -1,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          color: isActive ? T.accent : T.textGhost,
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
        }}
      >
        {coll.name}
      </span>
      {coll.type !== 'collection' && (
        <span
          style={{
            fontSize: 9,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            padding: '0 4px',
            border: `1px solid ${T.border}`,
            borderRadius: T.rx,
            color: T.textGhost,
            background: T.surface,
          }}
        >
          {coll.type === 'view' ? 'VIEW' : 'TS'}
        </span>
      )}
      {isActive && (
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: T.accent,
            flexShrink: 0,
          }}
        />
      )}
    </div>
  );
}

