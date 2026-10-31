import React from 'react';
import { ActionIcon } from '@mantine/core';
import { I } from '../../../icons';
import { isRecord, toDisplayValue, type DisplayType } from '../../../utils/displayValue';
import { DRAGGED_FIELD_MIME, type DraggedField } from '../builder';
import type { ReferenceRule } from '@shared/types';
import { ReferenceChip } from '../../../features/references/ReferenceChip';
import { useRovingFocus } from '../../../hooks/useRovingFocus';
import { flattenVisibleFieldRows, type FlatFieldRow } from './docFieldFlatten';
import { isContextMenuKey, anchorFromRect } from '../../../utils/contextMenuKey';
import { childKey, pathCoversSubtree, rootKey } from './fieldPathKey';
import { TYPE_HUES, TYPE_THEMED } from '../typeColors';
import { FullValuePopover } from './FullValuePopover';

// Shared FIELD | VALUE | TYPE column layout — the Tree view's expanded-row
// header (TreeView's sticky overlay) and the Table view's row-expand panel
// both rely on this exact template so their headers and the FieldNode rows
// underneath line up.
export const DOC_FIELD_TREE_GRID_TEMPLATE = '140px 1fr 72px';

// `path` (`rootKey`/`childKey` in `fieldPathKey.ts`) embeds `docId` and
// escapes `.`/`:`/`\` in every segment before joining, so two different
// field paths can never collapse to the same string (#86) — it's globally
// unique on its own, no need to mix in anything else to make the DOM id
// collision-safe across documents.
function fieldRowDomId(path: string): string {
  return `field-row-${path}`;
}

export function TypeBadge({ type }: { type: DisplayType }) {
  const colors = TYPE_HUES[type] ?? TYPE_THEMED[type] ?? {
    bg: 'var(--atelier-surface-raised)',
    fg: 'var(--atelier-text-muted)',
  };
  return (
    <span
      style={{
        fontSize: 9,
        padding: '1px 5px',
        borderRadius: 'var(--atelier-radius-xs)',
        background: colors.bg,
        color: colors.fg,
        fontWeight: 600,
        letterSpacing: '0.03em',
        textTransform: 'uppercase',
        flexShrink: 0,
      }}
    >
      {type}
    </span>
  );
}

/**
 * #68/#69 — payload a field row's context-menu open hands upward. `anchor`
 * replaces a raw `React.MouseEvent` so a keyboard open (no mouse event at
 * all) can produce the exact same shape as a right-click — see
 * `anchorFromRect`/`isContextMenuKey` in `utils/contextMenuKey.ts`.
 *
 * Split into two interfaces rather than one with optional fields: a
 * `FieldNode`'s own mouse-driven `onContextMenu` can't reach `DocFieldTree`'s
 * roving-focus container, so it can't supply `returnFocusTo` itself —
 * `DocFieldTree` injects that (and `focusMenuOnOpen`, keyboard-open only) in
 * the wrapper it hands down to `FieldNode` instead. See `useMenuFocus`'s
 * docstring for why `focusMenuOnOpen` has to stay keyboard-only even though
 * `returnFocusTo` is now set on both paths.
 */
export interface FieldMenuOpenPayload {
  anchor: { x: number; y: number };
  fieldPath: string;
  value: unknown;
  returnFocusTo: HTMLElement | null;
  focusMenuOnOpen?: boolean;
}

interface FieldNodeProps {
  name: string;
  value: unknown;
  depth: number;
  /** Path key used for tracking expansion state — includes a docId prefix. */
  path: string;
  /** Dot-path of the field within the document (no docId prefix). */
  fieldPath: string;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  copiedPath: string | null;
  onCopy: (path: string, value: unknown) => void;
  // #68 — mouse path only; `DocFieldTree` injects `returnFocusTo` (and, for
  // its own keyboard path, `focusMenuOnOpen`) before this reaches the caller.
  onOpenMenu: (payload: Omit<FieldMenuOpenPayload, 'returnFocusTo' | 'focusMenuOnOpen'>) => void;
  refsByField?: Map<string, ReferenceRule>;
  onRefHover?: (rule: ReferenceRule, value: unknown, rect: DOMRect) => void;
  onRefHoverLeave?: () => void;
  onRefOpen?: (rule: ReferenceRule, field: string, value: unknown) => void;
  // #20 — stable per-row DOM id so the field tree's `aria-activedescendant`
  // (set by `useRovingFocus` in `DocFieldTree` below) always names a real
  // element. Keyed by `path`, not position — expanding an earlier sibling
  // shifts every later row's *index* in the flat order, which a memoized
  // `FieldNode` further down may not re-render for, but never changes a
  // row's own `path`.
  rowId: (path: string) => string;
  // #20 — found in review: a click needs to make the clicked row the roving
  // index too (even a non-expandable leaf, which has no `onToggle` action of
  // its own), or the next Arrow key jumps from wherever the highlight was
  // sitting rather than from the row just clicked.
  onActivate: (path: string) => void;
  // #60 — the path of the row the container's `highlightIndex` currently
  // names, or `null` when the tree doesn't have focus (or has no rows).
  // Compared against this node's own `path` — not an index, since this tree
  // is keyed by path (see `rowId`'s docstring above) — to decide whether to
  // paint the active-row outline.
  activePath: string | null;
  // The path whose full-value popover is open, or `null`. Held once in
  // `DocFieldTree` (so Enter on the active row can open it) and compared
  // here by path, like `activePath`.
  fullValuePath: string | null;
  onFullValueChange: (path: string, opened: boolean) => void;
}

function FieldNodeImpl({
  name,
  value,
  depth,
  path,
  fieldPath,
  expandedPaths,
  onToggle,
  copiedPath,
  onCopy,
  onOpenMenu,
  refsByField,
  onRefHover,
  onRefHoverLeave,
  onRefOpen,
  rowId,
  onActivate,
  activePath,
  fullValuePath,
  onFullValueChange,
}: FieldNodeProps) {
  const dv = toDisplayValue(value);
  const isExpandable = dv.type === 'object' || dv.type === 'array';
  const isExpanded = isExpandable && expandedPaths.has(path);
  const isCopied = copiedPath === path;
  const isActive = path === activePath;
  const fullValueOpen = fullValuePath === path;
  const [hovered, setHovered] = React.useState(false);
  // The trigger is out of Tab order (Enter on the active leaf is the
  // keyboard path), but a click still focuses it and the popover returns
  // focus to it on close, so focus has to reveal it as hover does
  // (WCAG 2.4.11) — same reasoning as the Table cell's `focused`.
  const [focused, setFocused] = React.useState(false);
  const rule = refsByField?.get(fieldPath);

  const childEntries: Array<[string, unknown]> = React.useMemo(() => {
    if (!isExpanded) return [];
    if (dv.type === 'array' && Array.isArray(value)) {
      return value.map((v, i): [string, unknown] => [String(i), v]);
    }
    if (dv.type === 'object' && isRecord(value)) {
      return Object.entries(value);
    }
    return [];
  }, [isExpanded, dv.type, value]);

  const rowClickable = isExpandable;

  // A doc field can legitimately hold JS `undefined` (BSON's deprecated
  // Undefined type round-trips to it via EJSON `{$undefined:true}`), and
  // dragging that row crashed —
  // `condFromDragged` stored `undefined` where a string is required, and
  // the printer's validation later called `.trim()` on it. `TableView`'s
  // cell already gates its own drag source on `value !== undefined`; this
  // row didn't. Root-cause fix belongs here, not just at the drop end.
  const draggable = value !== undefined;

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    const payload: DraggedField = { field: fieldPath, value };
    e.dataTransfer.setData(DRAGGED_FIELD_MIME, JSON.stringify(payload));
    e.dataTransfer.setData(
      'text/plain',
      typeof value === 'string' ? value : JSON.stringify(value),
    );
    e.dataTransfer.effectAllowed = 'copy';
    e.stopPropagation();
  };

  return (
    <>
      <div
        draggable={draggable}
        onDragStart={draggable ? handleDragStart : undefined}
        // Always marks the clicked row active (even a non-expandable leaf,
        // which has no toggle of its own) — found in review: without this,
        // a click left the roving index sitting wherever it was before, so
        // the next Arrow key jumped from there instead of from the row just
        // clicked. No `tabIndex` on this row at all (see below) — #20
        // originally left `tabIndex={-1}` plus a matching keydown guard
        // here, but review found any declared `tabIndex` (negative
        // included) makes an element click-focusable per the HTML
        // focusing-steps algorithm, even though it's excluded from Tab
        // order. That left real DOM focus on the row after a click, so the
        // next Arrow/Home/End reached this tree's own `onKeyDown` with
        // `e.target` = this row rather than the tree, and its own-target
        // guard swallowed it. Removing `tabIndex` lets a click's focusing
        // steps walk up to the nearest focusable ancestor — the tree
        // itself — instead, which is what makes this row's former
        // Enter/Space handler dead code (a keydown can only ever target an
        // element that can hold real focus): deleted, in favour of the
        // tree-level handling in `DocFieldTree` below.
        onClick={() => {
          onActivate(path);
          if (rowClickable) onToggle(path);
        }}
        id={rowId(path)}
        role="treeitem"
        aria-expanded={isExpandable ? isExpanded : undefined}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onCopy(path, value);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpenMenu({ anchor: { x: e.clientX, y: e.clientY }, fieldPath, value });
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        title={
          draggable
            ? `Drag to add "${fieldPath} $eq …" to builder · double-click to copy`
            : undefined
        }
        style={{
          display: 'grid',
          gridTemplateColumns: DOC_FIELD_TREE_GRID_TEMPLATE,
          alignItems: 'center',
          gap: 12,
          padding: '3px 12px',
          paddingLeft: 12 + depth * 16,
          minHeight: 24,
          fontSize: 11,
          cursor: rowClickable ? 'pointer' : 'grab',
          userSelect: 'none',
          background: isCopied ? 'var(--atelier-accent)' : undefined,
          // #83 — keep the flash inside the padding: the #60 outline below is the
          // same accent, inset 2px, and would vanish into a full-row flash.
          backgroundClip: isCopied ? 'content-box' : undefined,
          color: isCopied ? '#fff' : undefined,
          transition: 'background 120ms',
          // #60 — sighted-visible counterpart to `aria-activedescendant`.
          // Driven by `path`, not a CSS descendant selector off the outer
          // Table/Tree grid's `aria-activedescendant` — this tree mounts
          // *inside* an expanded outer row, and a descendant selector would
          // paint this tree's active row even while the outer grid, not this
          // tree, has focus.
          outline: isActive ? '2px solid var(--atelier-accent)' : undefined,
          outlineOffset: isActive ? '-2px' : undefined,
        }}
      >
        {isCopied ? (
          <span
            style={{
              gridColumn: '1 / -1',
              textAlign: 'center',
              fontWeight: 600,
              fontFamily: '"JetBrains Mono", monospace',
            }}
          >
            ✓ Copied
          </span>
        ) : (
          <>
            {/* Col 1 — chevron + field name (mono, muted) */}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                color: 'var(--atelier-text-muted)',
                fontFamily: '"JetBrains Mono", monospace',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {isExpandable ? (
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size={14}
                  c={isCopied ? '#fff' : 'var(--atelier-text-ghost)'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(path);
                  }}
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                  style={{
                    flexShrink: 0,
                    transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                    transition: 'transform 120ms',
                  }}
                >
                  {I.chevD}
                </ActionIcon>
              ) : (
                <span style={{ width: 14, flexShrink: 0 }} />
              )}
              {name}
            </span>

            {/* Col 2 — value (mono, default text) */}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                minWidth: 0,
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <span
                style={{
                  color: isCopied ? '#fff' : 'var(--atelier-text)',
                  fontFamily: '"JetBrains Mono", monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                  flexShrink: 1,
                }}
              >
                {dv.type === 'string' ? `"${dv.display}"` : dv.display}
              </span>
              {/* A leaf's value is truncated to the column; this shows all
                  of it. Revealed on hover or while the row is active, so a
                  keyboard user sees which row Enter will open it for. */}
              {!isExpandable && draggable && (
                <FullValuePopover
                  display={dv.display}
                  isString={dv.type === 'string'}
                  opened={fullValueOpen}
                  onChange={(opened) => onFullValueChange(path, opened)}
                  visible={hovered || focused || isActive || fullValueOpen}
                  ariaLabel="Expand field value"
                  // Tab must not walk every leaf of a wide document.
                  tabIndex={-1}
                  focusOnOpen
                />
              )}
              {rule && (
                <ReferenceChip
                  rule={rule}
                  onHover={(rect) => onRefHover?.(rule, value, rect)}
                  onLeave={() => onRefHoverLeave?.()}
                  onClick={() => onRefOpen?.(rule, fieldPath, value)}
                />
              )}
            </span>

            {/* Col 3 — type badge */}
            <span style={{ display: 'inline-flex', justifyContent: 'flex-start' }}>
              <TypeBadge type={dv.type} />
            </span>
          </>
        )}
      </div>
      {isExpanded &&
        childEntries.map(([k, v]) => (
          <FieldNode
            key={childKey(path, k)}
            name={k}
            value={v}
            depth={depth + 1}
            path={childKey(path, k)}
            fieldPath={`${fieldPath}.${k}`}
            expandedPaths={expandedPaths}
            onToggle={onToggle}
            copiedPath={copiedPath}
            onCopy={onCopy}
            onOpenMenu={onOpenMenu}
            refsByField={refsByField}
            onRefHover={onRefHover}
            onRefHoverLeave={onRefHoverLeave}
            onRefOpen={onRefOpen}
            rowId={rowId}
            onActivate={onActivate}
            activePath={activePath}
            fullValuePath={fullValuePath}
            onFullValueChange={onFullValueChange}
          />
        ))}
    </>
  );
}

export const FieldNode = React.memo(FieldNodeImpl, (prev, next) => {
  // Cheap identity checks first.
  if (
    prev.value !== next.value ||
    prev.name !== next.name ||
    prev.path !== next.path ||
    prev.fieldPath !== next.fieldPath ||
    prev.depth !== next.depth ||
    prev.onToggle !== next.onToggle ||
    prev.onCopy !== next.onCopy ||
    prev.onOpenMenu !== next.onOpenMenu ||
    prev.refsByField !== next.refsByField ||
    prev.onRefHover !== next.onRefHover ||
    prev.onRefHoverLeave !== next.onRefHoverLeave ||
    prev.onRefOpen !== next.onRefOpen ||
    prev.rowId !== next.rowId ||
    prev.onActivate !== next.onActivate ||
    prev.onFullValueChange !== next.onFullValueChange
  ) {
    return false;
  }
  // #60 — a "did THIS row's own flag change" check is not enough, and review
  // caught it. A `FieldNode` renders its expanded children itself, so each
  // child's `activePath`/`copiedPath` comes from *this* node's render. When
  // the value moves between two children of the same node (or clears while a
  // descendant holds it), this node's own flag is unchanged, a path-only
  // check skips its render, and the children keep the stale value. `{ a: { b, c } }`
  // with `a` expanded is the smallest case: `a` is neither `a.b` nor `a.c`.
  //
  // So: re-render when the value changed AND it was, or now is, inside this
  // node's subtree (`pathCoversSubtree`). #85 hit the identical bug on
  // `copiedPath`, written to the same own-path-only idiom — same fix, reused.
  if (
    prev.activePath !== next.activePath &&
    (pathCoversSubtree(next.path, prev.activePath) || pathCoversSubtree(next.path, next.activePath))
  ) {
    return false;
  }
  if (
    prev.fullValuePath !== next.fullValuePath &&
    (pathCoversSubtree(next.path, prev.fullValuePath) ||
      pathCoversSubtree(next.path, next.fullValuePath))
  ) {
    return false;
  }
  if (
    prev.copiedPath !== next.copiedPath &&
    (pathCoversSubtree(next.path, prev.copiedPath) || pathCoversSubtree(next.path, next.copiedPath))
  ) {
    return false;
  }
  // expandedPaths Set identity changes on every toggle, but most FieldNodes
  // are unaffected. Skip render if neither THIS path's expansion changed nor
  // (when expanded) any descendant path's expansion changed.
  if (prev.expandedPaths !== next.expandedPaths) {
    const wasExpanded = prev.expandedPaths.has(prev.path);
    const isExpanded = next.expandedPaths.has(next.path);
    if (wasExpanded !== isExpanded) return false;
    if (isExpanded) {
      const prefix = `${next.path}.`;
      for (const p of prev.expandedPaths) {
        if (p.startsWith(prefix) && !next.expandedPaths.has(p)) return false;
      }
      for (const p of next.expandedPaths) {
        if (p.startsWith(prefix) && !prev.expandedPaths.has(p)) return false;
      }
    }
  }
  return true;
});

export interface DocFieldTreeProps {
  /** The document to render. Callers should guard with `isRecord` first. */
  doc: Record<string, unknown>;
  /** Full docId (see `docId.ts`) — prefixes each top-level field's path. */
  docId: string;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  copiedPath: string | null;
  onCopy: (path: string, value: unknown) => void;
  // #68 — widened from `(e: React.MouseEvent, fieldPath, value) => void` so a
  // keyboard open (no `MouseEvent`) and a mouse open converge on one shape.
  onOpenMenu: (payload: FieldMenuOpenPayload) => void;
  refsByField?: Map<string, ReferenceRule>;
  onRefHover?: (rule: ReferenceRule, value: unknown, rect: DOMRect) => void;
  onRefHoverLeave?: () => void;
  onRefOpen?: (rule: ReferenceRule, field: string, value: unknown) => void;
}

/**
 * Recursive FIELD | VALUE | TYPE tree for a single document, including its
 * own column header. Extracted from `TreeView.tsx`'s `DocRow` so the Table
 * view's row-expand panel renders an identical tree instead of a second,
 * drifting implementation.
 *
 * The header markup/styling here must stay byte-for-byte in sync with
 * TreeView's `stickyHeaderOffset` overlay (`TreeView.tsx`) — that overlay
 * clones this same header and pins it to the scroll viewport while
 * an expanded section is in view. It keys off this component's own
 * `data-expanded-doc-section="true"` wrapper below.
 *
 * #20 — this is its own independent roving-focus widget: each expanded
 * document mounts a separate `DocFieldTree`, so each gets its own single tab
 * stop rather than sharing one with the outer Table/Tree grid, and its
 * active row is scoped to `flattenVisibleFieldRows`'s current flat order for
 * *this* `doc` alone — see that function's docstring for why a field tree
 * needs to recompute its row order on every render instead of using a fixed
 * count the way `TableView`/`TreeView` do.
 */
export function DocFieldTree({
  doc,
  docId,
  expandedPaths,
  onToggle,
  copiedPath,
  onCopy,
  onOpenMenu,
  refsByField,
  onRefHover,
  onRefHoverLeave,
  onRefOpen,
}: DocFieldTreeProps) {
  const flatRows = React.useMemo(
    () => flattenVisibleFieldRows(doc, docId, expandedPaths),
    [doc, docId, expandedPaths],
  );

  // Not virtualized — every visible row is already mounted, so scrolling it
  // into view is a plain DOM lookup + `scrollIntoView`, no imperative list
  // API needed (unlike TableView/TreeView's react-window `listRef`).
  const roving = useRovingFocus({
    count: flatRows.length,
    // Unused: this caller identifies rows by `path` (stable across a
    // sibling's expand/collapse reordering the flat list), not by index —
    // see `rowId`'s own docstring on `FieldNodeProps`. `activeIndex` and
    // `onKeyDown` are the only pieces of the hook this caller needs.
    idPrefix: 'unused-',
    resetKey: docId,
    scrollToIndex: (i) => {
      const path = flatRows[i]?.path;
      if (path) document.getElementById(fieldRowDomId(path))?.scrollIntoView({ block: 'nearest' });
    },
    // #119 — `scrollIntoView` on a mounted row is exact, and these rows are
    // keyed by path, not `${idPrefix}${i}`, so the settle loop has nothing
    // to converge on and could never see it done.
    settle: false,
  });
  const activeRow = flatRows[roving.activeIndex] as FlatFieldRow | undefined;
  // #60 — `flatRows[-1]` is `undefined`, which is exactly what makes
  // `highlightIndex`'s `-1` (no container focus) mean "paint nothing" here
  // for free — no extra guard needed.
  const highlightRow = flatRows[roving.highlightIndex] as FlatFieldRow | undefined;

  // #68 — the focus-return target for both a keyboard-opened field menu and
  // (#69) a mouse-opened one: this container already carries `tabIndex={0}`
  // (see the `role="tree"` div below) and, unlike a row, never unmounts out
  // from under a click.
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Injects `returnFocusTo` before handing a mouse-driven open up to the
  // caller — a `FieldNode`'s own `onContextMenu` can't reach `containerRef`
  // itself. `focusMenuOnOpen` is left unset here, so this stays a no-op for
  // the "no forced refocus on a mouse-opened menu" behaviour the caller's
  // hand-rolled menus already have — only the keyboard branch below sets it.
  const handleOpenMenu = React.useCallback(
    (payload: Omit<FieldMenuOpenPayload, 'returnFocusTo' | 'focusMenuOnOpen'>) => {
      onOpenMenu({ ...payload, returnFocusTo: containerRef.current });
    },
    [onOpenMenu],
  );

  // Found in review: a click needs to make the clicked row the roving index
  // too (even a non-expandable leaf, which has no `onToggle` of its own), or
  // the next Arrow key jumps from wherever the highlight was sitting rather
  // than from the row just clicked.
  const handleActivate = React.useCallback(
    (path: string) => {
      const idx = flatRows.findIndex((r) => r.path === path);
      if (idx >= 0) roving.setActiveIndex(idx);
    },
    // `roving` itself is a fresh object every render; depend on the one
    // function this actually calls instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flatRows, roving.setActiveIndex],
  );

  const [fullValuePath, setFullValuePath] = React.useState<string | null>(null);
  // The popover belongs to the active leaf. Anything that makes another row
  // active, or takes the leaf away (a collapse, a re-run, another document),
  // closes it — otherwise the state outlives its unmounted popover, keeps
  // eating Escape, and reopens when the user arrows back. Adjusted during
  // render, not in an effect, so no frame paints the stale popover.
  if (fullValuePath !== null && activeRow?.path !== fullValuePath) {
    setFullValuePath(null);
  }
  const handleFullValueChange = React.useCallback(
    (path: string, opened: boolean) => {
      // Only the open popover ever reports a close (Mantine's `onClose`
      // no-ops on a closed one), so a close can clear the shared state.
      setFullValuePath(opened ? path : null);
      if (opened) handleActivate(path);
    },
    [handleActivate],
  );

  const handleTreeKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      // First, and only while a full-value popover is open: Escape closes it
      // and stops there, whether it came from the tree, the popover's
      // trigger or (React bubbles through portals) the dropdown itself.
      // Focus comes back to the tree, which a keyboard open left for the
      // dropdown; after a click open the popover's own `returnFocus` then
      // puts it back on the trigger.
      if (e.key === 'Escape' && fullValuePath !== null) {
        e.preventDefault();
        e.stopPropagation();
        setFullValuePath(null);
        containerRef.current?.focus();
        return;
      }
      roving.onKeyDown(e);
      if (e.defaultPrevented) return;
      // Mirrors FieldNode's own guard: only Enter/Space typed while this
      // tree itself has focus toggles the active row — one bubbling up from
      // a nested control (the expand button) is that control's own action.
      if (e.target !== e.currentTarget) return;
      // #68 — Shift+F10 / ContextMenu key: open the field menu for the
      // active row. Order matches `TableView`'s `handleGridKeyDown`: after
      // the own-target guard, before Enter/Space.
      if (isContextMenuKey(e)) {
        if (!activeRow) return;
        e.preventDefault();
        const rowEl = document.getElementById(fieldRowDomId(activeRow.path));
        if (!rowEl) return;
        onOpenMenu({
          anchor: anchorFromRect(rowEl.getBoundingClientRect()),
          fieldPath: activeRow.fieldPath,
          value: activeRow.value,
          returnFocusTo: containerRef.current,
          focusMenuOnOpen: true,
        });
        return;
      }
      // ⌘/Ctrl+Enter is Run (PanelBody's handler), never this row's action.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!activeRow) return;
      if (e.key === ' ') e.preventDefault();
      // An expandable row toggles; a leaf has nothing to expand, so it
      // shows its full value instead (the mouse's ⤢ affordance).
      if (activeRow.expandable) onToggle(activeRow.path);
      else if (activeRow.value !== undefined) setFullValuePath(activeRow.path);
    },
    // `roving` itself is a fresh object every render; depend on the one
    // function this actually calls instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roving.onKeyDown, activeRow, onToggle, onOpenMenu, fullValuePath],
  );

  return (
    <div
      // Ancestor role FieldNode's `treeitem` rows need (axe's
      // aria-required-parent) — previously a wrapper both DocRow and
      // TableView rendered around this component; folded in here since #20
      // needs the roving-focus container to be the same element and the two
      // call sites had grown byte-for-byte identical copies of it.
      data-expanded-doc-section="true"
      ref={containerRef}
      role="tree"
      tabIndex={roving.containerProps.tabIndex}
      aria-activedescendant={activeRow ? fieldRowDomId(activeRow.path) : undefined}
      onFocus={roving.containerProps.onFocus}
      onBlur={roving.containerProps.onBlur}
      onKeyDown={handleTreeKeyDown}
      style={{
        padding: '0 0 10px 0',
        borderTop: '1px solid var(--atelier-border)',
        background: 'var(--atelier-surface)',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          display: 'grid',
          gridTemplateColumns: DOC_FIELD_TREE_GRID_TEMPLATE,
          gap: 12,
          padding: '4px 12px',
          fontSize: 9,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          color: 'var(--atelier-text-ghost)',
          background: 'var(--atelier-surface-raised)',
          borderBottom: '1px solid var(--atelier-border)',
        }}
      >
        <span>Field</span>
        <span>Value</span>
        <span>Type</span>
      </div>
      {Object.entries(doc).map(([field, val]) => (
        <FieldNode
          key={field}
          name={field}
          value={val}
          depth={0}
          path={rootKey(docId, field)}
          fieldPath={field}
          expandedPaths={expandedPaths}
          onToggle={onToggle}
          copiedPath={copiedPath}
          onCopy={onCopy}
          onOpenMenu={handleOpenMenu}
          refsByField={refsByField}
          onRefHover={onRefHover}
          onRefHoverLeave={onRefHoverLeave}
          onRefOpen={onRefOpen}
          rowId={fieldRowDomId}
          onActivate={handleActivate}
          activePath={highlightRow?.path ?? null}
          fullValuePath={fullValuePath}
          onFullValueChange={handleFullValueChange}
        />
      ))}
    </div>
  );
}
