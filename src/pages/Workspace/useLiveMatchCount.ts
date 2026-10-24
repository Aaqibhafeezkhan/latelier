import * as React from 'react';
import { api, isIpcError } from '../../api/atelier';
import { compileFindOptions, optionsProblem } from './builder';
import { CollectionWorkspaceContext } from './context';

/** How long the filter has to sit still before it is counted. */
export const LIVE_COUNT_DEBOUNCE_MS = 500;

export type LiveMatchCount =
  | { state: 'idle' }
  | { state: 'counting' }
  | { state: 'ok'; count: number }
  | { state: 'unavailable' };

interface Target {
  connectionId: string;
  dbName: string;
  collection: string;
  /** The committed filter text, never an uncommitted tree: rows that did not print are not counted. */
  queryRaw: string;
  /** True while the tree cannot be trusted to match `queryRaw` (print problems, unparseable text). */
  paused: boolean;
}

/**
 * Collections whose count timed out, by connection, database and name. Module
 * state so it outlives the drawer, which remounts on every tab switch, Reset
 * and Saved or Recent load.
 *
 * ponytail: never forgotten until the window reloads; give entries an expiry
 * if a collection that shrank should be counted again sooner.
 */
const timedOutCollections = new Set<string>();

/**
 * A debounced `api.query.count` of the committed filter, so the drawer can
 * show "≈1,240 match" before Run. Nothing is asked for an empty filter or
 * while `paused`. After a count times out, that collection stays unavailable
 * for the rest of the session: a collection that is too big to count in the
 * probe budget should not be asked again on every keystroke or remount. Any
 * other failure (a regex the server rejects, say) belongs to that filter text
 * alone, so the next edit asks again. A failure that is not an IpcError is a
 * bug: it shows unavailable too, and is rethrown so it is reported.
 */
export function useLiveMatchCount({
  connectionId,
  dbName,
  collection,
  queryRaw,
  paused,
}: Target): LiveMatchCount {
  // The tab's collation, hint and read preference (W14 §9): a collation
  // changes which documents match, so the count has to carry it to agree with
  // Run. Read from the workspace when there is one, since nothing in the
  // drawer edits them; outside a provider the count has none. An option that
  // cannot run (a half-typed collation) idles the count like `paused`: asked,
  // it would come back refused for a filter that is fine.
  const builder = React.use(CollectionWorkspaceContext)?.state.builder;
  const { collation, hint, readPreference } = builder ? compileFindOptions(builder) : {};
  const collectionKey = `${connectionId}\0${dbName}\0${collection}`;
  const key = JSON.stringify([collectionKey, queryRaw, collation, hint, readPreference]);
  const [settled, setSettled] = React.useState<{ key: string; count: number } | null>(null);
  const [failedKey, setFailedKey] = React.useState<string | null>(null);
  // Mirrors the module set for this collection, so a timeout re-renders.
  const [, setTimeouts] = React.useState(0);
  const timedOut = timedOutCollections.has(collectionKey);
  const idle =
    paused ||
    queryRaw.trim() === '{}' ||
    !connectionId ||
    !collection ||
    (builder !== undefined && optionsProblem(builder) !== null);

  React.useEffect(() => {
    if (idle || timedOut || failedKey === key) return;
    let current = true;
    const timer = setTimeout(() => {
      api.query
        .count({ connectionId, dbName, collection, filter: queryRaw, collation, hint, readPreference })
        .then(({ count }) => {
          if (current) setSettled({ key, count });
        })
        .catch((e: unknown) => {
          if (isIpcError(e) && e.code === 'TIMEOUT') timedOutCollections.add(collectionKey);
          if (current) {
            if (timedOutCollections.has(collectionKey)) setTimeouts((n) => n + 1);
            else setFailedKey(key);
          }
          if (!isIpcError(e)) throw e;
        });
    }, LIVE_COUNT_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [
    idle,
    timedOut,
    failedKey,
    key,
    collectionKey,
    connectionId,
    dbName,
    collection,
    queryRaw,
    collation,
    hint,
    readPreference,
  ]);

  if (idle) return { state: 'idle' };
  if (timedOut || failedKey === key) return { state: 'unavailable' };
  if (settled?.key === key) return { state: 'ok', count: settled.count };
  return { state: 'counting' };
}
