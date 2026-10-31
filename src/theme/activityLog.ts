/**
 * The session's error and warning toasts, kept after the toast closes so the
 * activity log can show them again. In memory only: a restart starts empty.
 * `notify.error` and `notify.warning` record here; nothing else does.
 */
export interface ActivityEntry {
  id: string;
  level: 'error' | 'warning';
  title?: string;
  message: string;
  /** ISO-8601. */
  at: string;
}

export const ACTIVITY_LIMIT = 100;
/** A longer message is cut to this many characters, the last an ellipsis, so one huge error text is not held 100 times. */
export const ACTIVITY_MESSAGE_LIMIT = 500;

// Replaced, never mutated, on every change: `useSyncExternalStore` compares
// snapshots by identity, so `getActivity` must return the same array until
// something changes.
let entries: readonly ActivityEntry[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly ActivityEntry[]): void {
  entries = next;
  for (const cb of listeners) cb();
}

/** Adds an entry at the front, dropping the oldest past `ACTIVITY_LIMIT`. */
export function recordActivity(entry: ActivityEntry): void {
  const message =
    entry.message.length > ACTIVITY_MESSAGE_LIMIT
      ? `${entry.message.slice(0, ACTIVITY_MESSAGE_LIMIT - 1)}…`
      : entry.message;
  publish([{ ...entry, message }, ...entries].slice(0, ACTIVITY_LIMIT));
}

/** Newest first. */
export function getActivity(): readonly ActivityEntry[] {
  return entries;
}

/** Calls `cb` after every change; returns the unsubscribe. */
export function subscribeActivity(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function clearActivity(): void {
  publish([]);
}
