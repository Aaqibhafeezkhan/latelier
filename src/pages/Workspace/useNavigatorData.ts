import React from 'react';
import type { DbInfo, IpcError } from '@shared/ipc';
import { api, isIpcError } from '../../api/atelier';
import { useNavigatorTree } from './useNavigatorTree';
import type { NavigatorTreeAction } from './navigatorTreeReducer';
import { ownGet } from '../../utils/ownProperty';

/** Fallback when a failed connect's status event and backfill both miss the message. */
export const GENERIC_CONNECT_ERROR = 'The connection attempt failed.';

/** Delay before the one bounded retry on an empty `listDatabases` result. */
const EMPTY_DB_RETRY_DELAY_MS = 300;

export type NavigatorData = ReturnType<typeof useNavigatorData>;

/** `force`: start a fresh load even when one is already in flight. */
export interface LoadOptions {
  force?: boolean;
}

/**
 * The navigator's tree state and its two loaders, owned above the navigator so
 * the cache outlives a collapsed sidebar and the command palette reads the same
 * databases and collections instead of fetching its own. No effects here: the
 * navigator mounts its own copy when it is rendered standalone, and that copy
 * must stay inert when a shared one is passed in. The owner subscribes it to
 * connection status with `useNavigatorStatusSync`.
 */
export function useNavigatorData() {
  const { state: tree, dispatch: rawDispatch, isMounted } = useNavigatorTree();

  // Two callers asking in the same tick (the navigator's mount effect and the
  // palette's sweep both see an empty cache) share one IPC round trip. The
  // reducer's own loading flags can't stop the second call: both read the
  // same render's snapshot. A `force` load (a refresh after a change) never
  // joins an older one: it starts its own, and the older one's late result is
  // discarded (`isCurrent` turns false) so it cannot overwrite the newer one.
  const inFlight = React.useRef(new Map<string, { p: Promise<unknown> }>());
  const once = React.useCallback(
    <T,>(key: string, force: boolean, run: (isCurrent: () => boolean) => Promise<T>): Promise<T> => {
      const pending = inFlight.current.get(key);
      if (pending && !force) return pending.p as Promise<T>;
      const entry: { p: Promise<unknown> } = { p: Promise.resolve() };
      const isCurrent = () => inFlight.current.get(key) === entry;
      inFlight.current.set(key, entry);
      const p = run(isCurrent).finally(() => {
        if (isCurrent()) inFlight.current.delete(key);
      });
      entry.p = p;
      return p;
    },
    [],
  );

  // A `cacheReset` (whole-connection Refresh) forgets that connection's
  // in-flight loads: their late answers describe the catalog before the
  // refresh, so `isCurrent` turns false and they are dropped, and an unforced
  // load after the reset (the active-database effect, the palette sweep)
  // starts a fresh listing instead of joining the stale one.
  const dispatch = React.useCallback(
    (action: NavigatorTreeAction) => {
      if (action.type === 'cacheReset') {
        for (const key of [...inFlight.current.keys()]) {
          if (key.split('\u0000')[1] === action.id) inFlight.current.delete(key);
        }
      }
      rawDispatch(action);
    },
    [rawDispatch],
  );

  const loadDbs = React.useCallback(
    (id: string, opts: LoadOptions = {}): Promise<DbInfo[] | null> =>
      once(`dbs\u0000${id}`, !!opts.force, async (isCurrent) => {
        dispatch({ type: 'dbsLoadStart', id });
        try {
          let rows = await api.meta.listDatabases({ connectionId: id });
          if (rows.length === 0) {
            // A brand-new database can be briefly invisible to listDatabases right
            // after connect (driver/server catalog-visibility race) — one bounded retry.
            await new Promise((resolve) => setTimeout(resolve, EMPTY_DB_RETRY_DELAY_MS));
            // The owner can unmount during the delay; a gone view must not
            // spend another main-process round trip on a result nobody will read.
            if (!isMounted()) return null;
            rows = await api.meta.listDatabases({ connectionId: id });
          }
          if (!isCurrent()) return null;
          dispatch({ type: 'dbsLoadSuccess', id, dbs: rows });
          return rows;
        } catch (e) {
          if (!isCurrent()) return null;
          const err: IpcError = isIpcError(e)
            ? e
            : { code: 'INTERNAL', message: String(e) };
          dispatch({ type: 'dbsLoadError', id, err });
          return null;
        }
      }),
    [once, dispatch, isMounted],
  );

  const loadColls = React.useCallback(
    (id: string, dbName: string, opts: LoadOptions = {}): Promise<void> =>
      once(`colls\u0000${id}\u0000${dbName}`, !!opts.force, async (isCurrent) => {
        dispatch({ type: 'collsLoadStart', id, dbName });
        try {
          const rows = await api.meta.listCollections({ connectionId: id, dbName });
          // Sort A→Z so large databases are scannable; server returns insertion order.
          const sorted = [...rows].sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
          );
          if (isCurrent()) dispatch({ type: 'collsLoadSuccess', id, dbName, colls: sorted });
        } catch {
          if (isCurrent()) dispatch({ type: 'collsLoadError', id, dbName });
        }
      }),
    [once, dispatch],
  );

  return { tree, dispatch, isMounted, loadDbs, loadColls };
}

/**
 * Keeps a tree in step with the connection pool's status stream: connect
 * errors in and out, and a reconnect background-refreshes that Connection's
 * previously-expanded DBs, then calls `onReconnect` with its id. A Connection
 * reconnecting into an empty tree opens its root — only when nothing is
 * already expanded. Called by whoever owns the tree; `null` subscribes
 * nothing, so a tree never has two writers.
 */
export function useNavigatorStatusSync(
  nav: NavigatorData | null,
  onReconnect?: (connectionId: string) => void,
) {
  const dispatch = nav?.dispatch;
  const loadColls = nav?.loadColls;
  const expanded = nav?.tree.expanded;
  const expandedRef = React.useRef(expanded);
  const onReconnectRef = React.useRef(onReconnect);
  React.useEffect(() => {
    expandedRef.current = expanded;
    onReconnectRef.current = onReconnect;
  }, [expanded, onReconnect]);
  // Set on 'disconnected'/'error', consumed on 'connected'.
  const sawDisconnectRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    if (!dispatch || !loadColls) return;
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
          const snapshot = ownGet(expandedRef.current ?? {}, runtime.id) ?? {};
          for (const db of Object.keys(snapshot).filter((d) => snapshot[d])) {
            void loadColls(runtime.id, db);
          }
          sawDisconnectRef.current.delete(runtime.id);
          onReconnectRef.current?.(runtime.id);
        }
      }
    });
    return off;
  }, [loadColls, dispatch]);
}
