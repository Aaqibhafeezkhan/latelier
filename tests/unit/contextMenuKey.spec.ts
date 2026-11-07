import { describe, it, expect } from 'vitest';
import { isContextMenuKey, isDeleteKey, isEditKey, anchorFromRect, anchorForRow } from '../../src/utils/contextMenuKey';

// X19/#55 — the platform-conventional keys for "open the context menu for the
// focused thing": the dedicated ContextMenu key, and Shift+F10. Every caller
// (DbCollectionNavigator, TableView, TabStrip) shares this one predicate
// rather than re-deriving it, so the five assertions below are what actually
// protects every keyboard-open call site.
describe('isContextMenuKey', () => {
  it('is true for the dedicated ContextMenu key alone', () => {
    expect(isContextMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true);
  });

  it('is true for the ContextMenu key even with Shift held', () => {
    expect(isContextMenuKey({ key: 'ContextMenu', shiftKey: true })).toBe(true);
  });

  it('is true for Shift+F10', () => {
    expect(isContextMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
  });

  it('is false for F10 without Shift', () => {
    expect(isContextMenuKey({ key: 'F10', shiftKey: false })).toBe(false);
  });

  it('is false for Shift held with an unrelated key', () => {
    expect(isContextMenuKey({ key: 'Enter', shiftKey: true })).toBe(false);
  });
});

describe('anchorFromRect', () => {
  it('anchors at the bottom-left corner of the rect, matching the bottom-start menu position', () => {
    expect(anchorFromRect({ left: 42, bottom: 84 })).toEqual({ x: 42, y: 84 });
  });
});

// #133 — the active row of a virtualized list can be scrolled out and
// unmounted; the keyboard open must still land somewhere visible.
describe('anchorForRow', () => {
  const box = (left: number, top: number, bottom: number) => ({
    getBoundingClientRect: () => ({ left, top, bottom }),
  });

  it("anchors at the row's bottom-left corner when the row is mounted", () => {
    expect(anchorForRow(box(10, 20, 44), box(0, 100, 500))).toEqual({ x: 10, y: 44 });
  });

  it("falls back to the list's top-left corner when the row is not mounted", () => {
    expect(anchorForRow(null, box(5, 100, 500))).toEqual({ x: 5, y: 100 });
  });

  it('is null when neither the row nor the list is there', () => {
    expect(anchorForRow(null, null)).toBeNull();
  });
});

describe('isEditKey', () => {
  const none = { metaKey: false, ctrlKey: false, altKey: false };
  it('is true for e and E with no modifier', () => {
    expect(isEditKey({ key: 'e', ...none })).toBe(true);
    expect(isEditKey({ key: 'E', ...none })).toBe(true);
  });

  it.each(['metaKey', 'ctrlKey', 'altKey'] as const)('is false with %s held', (mod) => {
    expect(isEditKey({ key: 'e', ...none, [mod]: true })).toBe(false);
  });

  it('is false for another key', () => {
    expect(isEditKey({ key: 'r', ...none })).toBe(false);
  });
});

describe('isDeleteKey', () => {
  const none = { metaKey: false, ctrlKey: false, altKey: false };
  it('is true for d and D with no modifier', () => {
    expect(isDeleteKey({ key: 'd', ...none })).toBe(true);
    expect(isDeleteKey({ key: 'D', ...none })).toBe(true);
  });

  it.each(['metaKey', 'ctrlKey', 'altKey'] as const)('is false with %s held', (mod) => {
    expect(isDeleteKey({ key: 'd', ...none, [mod]: true })).toBe(false);
  });

  it('is false for another key, the edit key included', () => {
    expect(isDeleteKey({ key: 'e', ...none })).toBe(false);
  });
});
