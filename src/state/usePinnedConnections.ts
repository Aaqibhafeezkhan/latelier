import React from 'react';
import { api } from '../api/atelier';
import { notify } from '../theme/notifications';
import { PINNED_PREF_KEY, parsePinned, togglePinned } from './connectionPins';

// The switcher popover and the Connections table can be mounted together, so a
// pin toggled in one has to reach the other without a re-read.
const listeners = new Set<(ids: string[]) => void>();

/**
 * The pinned connection ids, read from `ui.connections.pinned`. Ids of
 * connections that no longer exist are dropped when read.
 */
export function usePinnedConnections(connections: readonly { id: string }[]): {
  pinnedIds: ReadonlySet<string>;
  togglePin: (id: string) => Promise<void>;
} {
  const [stored, setStored] = React.useState<string[]>([]);
  // Mirrors `stored` so a toggle reads the latest list even before a re-render.
  const storedRef = React.useRef(stored);
  const apply = React.useCallback((ids: string[]) => {
    storedRef.current = ids;
    setStored(ids);
  }, []);
  // Every pref operation chains onto this: the first read, then each toggle in
  // call order. It never rejects.
  const queue = React.useRef<Promise<void>>(Promise.resolve());
  // With the saved pins unread, `stored` is a guess; writing from it would
  // overwrite them.
  const loadFailed = React.useRef(false);

  React.useEffect(() => {
    let active = true;
    loadFailed.current = false;
    queue.current = api.prefs
      .get<unknown>(PINNED_PREF_KEY)
      .then((value) => {
        if (active) apply(parsePinned(value));
      })
      .catch((err: unknown) => {
        loadFailed.current = true;
        console.warn('[pins] could not load the pinned connections', err);
        notify.error('Could not load pinned connections', { id: 'pins-load-failed' });
      });
    listeners.add(apply);
    return () => {
      active = false;
      listeners.delete(apply);
    };
  }, [apply]);

  const liveIds = React.useMemo(() => new Set(connections.map((c) => c.id)), [connections]);
  const pinnedIds = React.useMemo(
    () => new Set(stored.filter((id) => liveIds.has(id))),
    [stored, liveIds],
  );

  const togglePin = React.useCallback(
    (id: string): Promise<void> => {
      const run = queue.current.then(async () => {
        if (loadFailed.current) {
          notify.error('Pins are unavailable because they could not be loaded', { id: 'pins-load-failed' });
          return;
        }
        const before = storedRef.current;
        const next = togglePinned(before, id, liveIds);
        const publish = (ids: string[]) => listeners.forEach((fn) => fn(ids));
        publish(next);
        try {
          await api.prefs.set(PINNED_PREF_KEY, next);
        } catch (err) {
          console.warn('[pins] could not save the pinned connections', err);
          publish(before);
          notify.error('Could not save pinned connections', { id: 'pins-save-failed' });
        }
      });
      queue.current = run;
      return run;
    },
    [liveIds],
  );

  return { pinnedIds, togglePin };
}
