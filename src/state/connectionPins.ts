/** Mirrors the `ui.connections.pinned` entry in `electron/ipc/prefKeys.ts`. */
export const PINNED_PREF_KEY = 'ui.connections.pinned';

/**
 * Pinned connections first. Stable: pinned rows and the rest each keep the
 * order `conns` already had, so pinning never reshuffles anything else.
 */
export function sortPinnedFirst<T extends { id: string }>(
  conns: readonly T[],
  pinnedIds: Iterable<string>,
): T[] {
  const pinned = new Set(pinnedIds);
  return [...conns.filter((c) => pinned.has(c.id)), ...conns.filter((c) => !pinned.has(c.id))];
}

/** The strings of a stored pref value; anything else reads as "nothing pinned". */
export function parsePinned(stored: unknown): string[] {
  return Array.isArray(stored) ? stored.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * `pinned` with `id` toggled, minus ids of connections that no longer exist.
 * The result is what gets written back, so deleted connections fall out of the
 * pref the next time anything is pinned or unpinned.
 */
export function togglePinned(pinned: readonly string[], id: string, liveIds: ReadonlySet<string>): string[] {
  const current = pinned.filter((p) => liveIds.has(p));
  return current.includes(id) ? current.filter((p) => p !== id) : [...current, id];
}
