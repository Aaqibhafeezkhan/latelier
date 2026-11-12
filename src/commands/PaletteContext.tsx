import React from 'react';
import { useLocation } from 'react-router-dom';
import type { PaletteContext as PaletteContextValue } from './types';
import { useFocusedConnectionId } from '../state/focusedConnection';

const Ctx = React.createContext<PaletteContextValue>({
  pathname: '/',
  connectionId: null,
});

// eslint-disable-next-line react-refresh/only-export-components
export function usePaletteContext(): PaletteContextValue {
  return React.useContext(Ctx);
}

const CONNECTION_ID_RE = /^\/connections\/([^/]+)(?:\/.*)?$/;

function parseConnectionId(pathname: string): string | null {
  const m = CONNECTION_ID_RE.exec(pathname);
  if (!m || m[1] === 'new') return null;
  return m[1];
}

/**
 * Publishes route-derived palette context. Mounted at the App level so every
 * `when` predicate sees the same values. The provider sits outside the
 * `<Routes>` tree, so route params are parsed from the pathname rather than
 * pulled via `useParams` (which would return empty here).
 *
 * Tab-scoped state stays inside Workspace via component-level command
 * registrations rather than being pushed through this context.
 *
 * `connectionId` prefers the URL (`/connections/:id`) over the Data View's
 * Connection, not the other way round: on the deep management screen the
 * route id is the Connection being managed, which can differ from whatever
 * Connection the Data View is on — a command scoped to a Connection must act
 * on the one you're looking at, not the one that happens to be open
 * elsewhere. Off that screen (notably the Data View home, where the route
 * carries no id) it falls back to the Focused Tab's Connection
 * — without this, every command gated on `connectionId` silently stops being
 * offered the moment `/workspace` became the app's home screen instead of
 * `/connections/:id`.
 */
export function PaletteContextProvider({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const focusedConnectionId = useFocusedConnectionId();
  const value = React.useMemo<PaletteContextValue>(
    () => ({
      pathname: location.pathname,
      connectionId: parseConnectionId(location.pathname) ?? focusedConnectionId,
    }),
    [location.pathname, focusedConnectionId],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
