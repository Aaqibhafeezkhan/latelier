// Undo/redo history for the filter drawer's tree (W13 §5.7). Pure and
// generic: the drawer keeps one of these in component state, so it lives as
// long as the drawer's mount and no longer.

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /**
   * The coalescing key of the push that made `present`, or `null`. A run of
   * pushes with one key (a field typed a keystroke at a time) is one undo
   * step, not one per keystroke.
   */
  lastKey: string | null;
}

/** How many steps back undo can go; the oldest are dropped past this. */
export const HISTORY_CAP = 100;

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], lastKey: null };
}

/**
 * Records `next` as the new present. With the same `key` as the push before
 * it, `next` replaces the present instead of adding a step. Any push drops
 * the redo stack.
 *
 * A step that lands where the step before it started (an edit that changes
 * nothing, or typing then deleting back) is no step at all: undoing it would
 * do nothing visible. Values compare as JSON, which is what the history holds.
 */
export function pushHistory<T>(h: History<T>, next: T, key?: string): History<T> {
  const lastKey = key ?? null;
  const base = lastKey !== null && lastKey === h.lastKey ? h.past : [...h.past, h.present];
  // Settled before the cap: a no-op that cut the oldest step first would then
  // remove the duplicate and lose that step for nothing.
  if (sameValue(base.at(-1), next)) {
    return { past: base.slice(0, -1), present: next, future: [], lastKey: null };
  }
  const past = base.slice(-HISTORY_CAP);
  return { past, present: next, future: [], lastKey };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One step back; `h` itself when there is none. */
export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  return {
    past: h.past.slice(0, -1),
    present: h.past[h.past.length - 1]!,
    future: [h.present, ...h.future],
    lastKey: null,
  };
}

/** One step forward; `h` itself when there is none. */
export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  return {
    past: [...h.past, h.present],
    present: h.future[0]!,
    future: h.future.slice(1),
    lastKey: null,
  };
}

export function canUndo<T>(h: History<T>): boolean {
  return h.past.length > 0;
}

export function canRedo<T>(h: History<T>): boolean {
  return h.future.length > 0;
}
