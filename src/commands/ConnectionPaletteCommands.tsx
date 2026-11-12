import { useLocation, useNavigate } from 'react-router-dom';
import { useConnections } from '../state/connections';
import { useRegisterObjects } from './useRegisterObjects';
import type { ObjectAction, PaletteObject } from './types';

/** The route intents Workspace acts on for a Connection (see Workspace.tsx). */
type ConnectionIntent = 'openConnectionId' | 'editConnectionId' | 'disconnectConnectionId' | 'deleteConnectionId';

/**
 * Registers one Connection object per saved Connection (X07 §13.4), with the
 * actions Open · Edit · Disconnect (while connected) · Delete…. Holds its own
 * `useConnections()` subscription — the cost is one extra `conn:list` call on
 * focus, well worth keeping the palette decoupled from any single page.
 *
 * The id stays `connection.open:<id>`, the id of the v1 row, so a stored MRU
 * still names it. Each action's target is baked in at creation time, not read
 * from `PaletteContext` at call time: a Connection that is open without a tab
 * (the normal state) keeps its actions, and an action's gate and its target
 * cannot disagree.
 */
export function ConnectionPaletteCommands() {
  const { connections } = useConnections();
  const navigate = useNavigate();
  const location = useLocation();

  // Every action lives in the Data View, which owns the Connections it has
  // open and their dialogs. This component is mounted above `<Routes>` and
  // can't reach them, so each action hands Workspace a route intent; its
  // effects call the exact handlers the Connection Switcher and the
  // navigator call.
  //
  // This also navigates when the user is already on /workspace: same path,
  // new location state, so the effect re-fires and Workspace stays mounted.
  //
  // `replace` when already on /workspace — Workspace's own effect replaces
  // the intent out of location.state once it acts on it, so a PUSH here
  // would leave a second, functionally-identical history entry behind on
  // every in-Workspace action, growing history unboundedly and making
  // back/forward (incl. a trackpad/Chromium swipe-back) a no-op. Arriving
  // from elsewhere still pushes, so back navigation lands where the user
  // actually came from.
  const intent = (key: ConnectionIntent, id: string) => () =>
    navigate('/workspace', { state: { [key]: id }, replace: location.pathname === '/workspace' });

  const objects: PaletteObject[] = connections.map((conn) => {
    const actions: ObjectAction[] = [
      { id: 'open', verb: 'open', title: 'Open', perform: intent('openConnectionId', conn.id) },
      { id: 'edit', verb: 'edit', title: 'Edit', perform: intent('editConnectionId', conn.id) },
    ];
    // The navigator's Connection menu offers Disconnect on the same condition.
    if (conn.status === 'connected') {
      actions.push({
        id: 'disconnect',
        verb: 'disconnect',
        title: 'Disconnect',
        perform: intent('disconnectConnectionId', conn.id),
      });
    }
    actions.push({
      id: 'delete',
      verb: 'delete',
      title: 'Delete…',
      destructive: true,
      perform: intent('deleteConnectionId', conn.id),
    });
    return {
      id: `connection.open:${conn.id}`,
      kind: 'connection',
      name: conn.name,
      subtitle: conn.host,
      keywords: ['connection'],
      actions,
    };
  });

  useRegisterObjects(objects, [connections, navigate, location.pathname]);

  return null;
}
