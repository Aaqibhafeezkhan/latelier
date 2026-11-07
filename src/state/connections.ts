import { useCallback, useEffect, useState } from 'react';
import type { ConnectionStatus, ConnectionSummary } from '@shared/types';
import type { IpcError } from '@shared/ipc';
import { api, isIpcError } from '../api/atelier';

// Pool emits ConnectionStatus, which lacks the 'unknown' value the sidebar
// uses to mark "never connected this session". Mirror the same mapping that
// ConnectionService.list() applies server-side (electron/mongo/ConnectionService.ts).
function mapRuntimeStatus(s: ConnectionStatus): ConnectionSummary['status'] {
  return s === 'disconnected' ? 'unknown' : s;
}

// 'connecting' is treated as active so a stuck attempt can be cancelled with
// the same toggle; 'error' returns to inactive because the client is gone.
export function isConnectionActive(s: ConnectionSummary['status']): boolean {
  return s === 'connected' || s === 'connecting';
}

// X16.5 — a Connection is "known not connected" once it has actually
// resolved into the list and its status isn't 'connected'. `undefined`/`null`
// (the Connection hasn't loaded into `connections` yet) is deliberately NOT
// the same thing: TabStrip's own test distinguishes an unresolved
// Connection from a Dormant one, and this predicate is what every consumer
// that acts on "has no live client" (tab-click connect, expanding a root, the
// auto-run guard, the pane's not-connected state) shares so they can't drift
// on that null rule the way a hand-rolled `!== 'connected'` at each call site
// would.
export function isKnownNotConnected(
  conn: ConnectionSummary | null | undefined,
): boolean {
  return !!conn && conn.status !== 'connected';
}

// Dormant is one of the four runtime states X16 §5 names (Open,
// Dormant, Connecting, Failed), not the whole of "not Open". Connecting and
// Failed have no live client either, so `isKnownNotConnected` is right for
// anything that reacts to *that*; it is wrong for anything that renders the
// Dormant *treatment*, because Connecting already shows progress on its
// navigator root and Failed shows the error with Retry. Muting all three
// identically makes them indistinguishable in the tab strip.
export function isDormant(conn: ConnectionSummary | null | undefined): boolean {
  return (
    !!conn &&
    conn.status !== 'connected' &&
    conn.status !== 'connecting' &&
    conn.status !== 'error'
  );
}

// Connections can change outside any component that owns a `useConnections`
// (an import run from an App-level dialog), so every instance listens here.
const connectionsChanged = new EventTarget();

export function notifyConnectionsChanged(): void {
  connectionsChanged.dispatchEvent(new Event('changed'));
}

export interface ConnectionsState {
  connections: ConnectionSummary[];
  loading: boolean;
  error: IpcError | null;
  refresh: () => Promise<void>;
  removeLocal: (id: string) => void;
}

/**
 * Subscribe to the live connection list. Re-fetches on window focus so stale
 * state caused by another renderer or CLI edit catches up quickly.
 */
export function useConnections(): ConnectionsState {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<IpcError | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await api.conn.list();
      setConnections(rows);
      setError(null);
    } catch (e) {
      if (isIpcError(e)) setError(e);
      else setError({ code: 'INTERNAL', message: String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + focus refresh. Split to satisfy react-hooks/set-state-in-effect.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    connectionsChanged.addEventListener('changed', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      connectionsChanged.removeEventListener('changed', onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    // Kick off the first load asynchronously so React finishes this commit first.
    queueMicrotask(() => {
      void refresh();
    });
  }, [refresh]);

  // Stay live with pool status events so the sidebar dots reflect connect /
  // disconnect / error transitions without waiting on a focus-driven refetch.
  useEffect(() => {
    const off = api.mongo.onStatus((runtime) => {
      setConnections((cs) => {
        const idx = cs.findIndex((c) => c.id === runtime.id);
        if (idx === -1) return cs;
        const current = cs[idx]!;
        const nextStatus = mapRuntimeStatus(runtime.status);
        const nextVersion = runtime.serverVersion ?? current.serverVersion;
        if (
          current.status === nextStatus &&
          current.serverVersion === nextVersion &&
          current.lostReason === runtime.lostReason
        ) {
          return cs;
        }
        const next = cs.slice();
        next[idx] = { ...current, status: nextStatus, serverVersion: nextVersion, lostReason: runtime.lostReason };
        return next;
      });
    });
    return off;
  }, []);

  const removeLocal = useCallback((id: string) => {
    setConnections((cs) => cs.filter((c) => c.id !== id));
  }, []);

  return { connections, loading, error, refresh, removeLocal };
}
