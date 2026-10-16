import React from 'react';
import { api, getErrorMessage } from '../../api/atelier';
import type { CollectionDetails } from '@shared/ipc';
import { onCollectionChanged } from '../../state/collectionChanges';

/**
 * One collection's `meta:collectionDetails`, read on entry and on `reload`.
 * Structure reads it once and hands it to both the statistics and the
 * validation sections, so entering the view costs one round trip.
 */
export function useCollectionDetails(connectionId: string, dbName: string, collection: string) {
  // Keyed by target so a reply (or an error) is only ever shown for the
  // collection it was read for: switching collections shows Loading, not the
  // previous collection's details.
  const targetKey = `${connectionId}|${dbName}|${collection}`;
  const [fetched, setFetched] = React.useState<{ key: string; details: CollectionDetails } | null>(null);
  const details = fetched?.key === targetKey ? fetched.details : null;
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  // Only the latest request may write state: a slow reply for a collection the
  // tab has since left must not overwrite the one now on screen.
  const latest = React.useRef(0);
  // The target the hook is on now. A `reload` handed out for an earlier one (a
  // save that resolves after the tab moved on) must not bump `latest`, or the
  // current target's own read would be discarded and it would be left empty.
  const currentKey = React.useRef(targetKey);

  const reload = React.useCallback(async () => {
    if (currentKey.current !== targetKey) return;
    const id = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const d = await api.meta.collectionDetails({ connectionId, dbName, collection });
      if (id === latest.current) setFetched({ key: targetKey, details: d });
    } catch (e) {
      if (id === latest.current) {
        setFetched(null);
        setError(getErrorMessage(e, String(e)));
      }
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, [connectionId, dbName, collection, targetKey]);

  /* eslint-disable react-hooks/set-state-in-effect */
  React.useEffect(() => {
    currentKey.current = targetKey;
    void reload();
    return () => {
      latest.current++;
    };
  }, [reload, targetKey]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // A view modified from the navigator changes what this tab shows ("View on X").
  React.useEffect(
    () =>
      onCollectionChanged((c) => {
        if (c.connectionId === connectionId && c.dbName === dbName && c.collection === collection) void reload();
      }),
    [connectionId, dbName, collection, reload],
  );

  return { details, error, loading, reload };
}
