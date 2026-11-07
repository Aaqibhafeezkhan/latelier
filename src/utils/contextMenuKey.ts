/**
 * X19/#55 — the shared `ContextMenu` had a mouse trigger (`onContextMenu`) at
 * every call site and no keyboard trigger anywhere. These two platform
 * conventions open "the context menu for the focused thing": the dedicated
 * ContextMenu key, and Shift+F10. Every caller (DbCollectionNavigator,
 * TableView, TabStrip) shares this one predicate instead of re-deriving it in
 * each key handler.
 */
export function isContextMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
}

/**
 * `E` on a focused result row opens the Document Editor on it (W18 §7).
 * Unmodified only, so ⌘E and Ctrl+E stay free for the app and the OS.
 */
export function isEditKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  return (e.key === 'e' || e.key === 'E') && !e.metaKey && !e.ctrlKey && !e.altKey;
}

/**
 * `D` on a focused result row deletes it, through the same confirmation the
 * row's Delete button opens. Unmodified only, like `isEditKey`.
 */
export function isDeleteKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  return (e.key === 'd' || e.key === 'D') && !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** A `DOMRect`-shaped input — deliberately structural, not `DOMRect` itself,
 * so this stays testable with a plain object and no DOM. */
export interface RectLike {
  left: number;
  bottom: number;
}

/**
 * Where a keyboard-opened context menu anchors: the bottom-left corner of the
 * focused row, matching where Mantine's `position="bottom-start"` would put
 * the dropdown for a real anchor element there. A keyboard open has no cursor
 * coordinate to reuse.
 */
export function anchorFromRect(rect: RectLike): { x: number; y: number } {
  return { x: rect.left, y: rect.bottom };
}

/** Anything with a layout box — a DOM element, or a plain object in tests. */
interface Boxed {
  getBoundingClientRect(): { left: number; top: number; bottom: number };
}

/**
 * #133 — the anchor for a keyboard-opened menu on a virtualized list's active
 * row. PageDown/PageUp or the wheel scroll the list natively, so the active
 * row can be unmounted when the key arrives. Anchor to the row when it is
 * there, otherwise to the list's top-left corner, so the open never silently
 * does nothing. `null` only when there is no list either.
 */
export function anchorForRow(row: Boxed | null, list: Boxed | null): { x: number; y: number } | null {
  if (row) return anchorFromRect(row.getBoundingClientRect());
  if (!list) return null;
  const r = list.getBoundingClientRect();
  return { x: r.left, y: r.top };
}
