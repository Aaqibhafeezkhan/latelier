import { useSyncExternalStore } from 'react';

// Whether the command palette is open, for what reads local data once per
// open (X07 §13.7 rule 5). The palette's own store is private to it.

let open = false;
const listeners = new Set<() => void>();

/** Called by the palette whenever it opens or closes. */
export function setPaletteOpen(value: boolean): void {
  if (open === value) return;
  open = value;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** True while the palette is open. */
export function usePaletteOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open);
}

/** Test-only. */
export function _resetPaletteOpenForTests(): void {
  open = false;
}
