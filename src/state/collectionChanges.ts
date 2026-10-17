/**
 * "This collection or view was written" — raised by whoever wrote it, heard by
 * whoever shows it. The navigator's tree and a Structure tab sit in different
 * branches of the workspace and neither owns the other's cache, so a write made
 * in one (Save as view in the pipeline tab, Modify view in the navigator) would
 * otherwise leave the other showing the old state until a manual refresh.
 * Same module-level pattern as `notifyConnectionsChanged`.
 */
export interface CollectionChange {
  connectionId: string;
  dbName: string;
  collection: string;
}

const listeners = new Set<(change: CollectionChange) => void>();

export function notifyCollectionChanged(change: CollectionChange): void {
  for (const fn of [...listeners]) fn(change);
}

/** Returns the unsubscribe. */
export function onCollectionChanged(fn: (change: CollectionChange) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
