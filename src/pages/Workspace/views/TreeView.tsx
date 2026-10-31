import React from 'react';
import { ActionIcon, Tooltip } from '@mantine/core';
import {
  List,
  useDynamicRowHeight,
  useListRef,
  type RowComponentProps,
} from 'react-window';
import { useRovingFocus } from '../../../hooks/useRovingFocus';
import { useMenuFocus } from '../../../hooks/useMenuFocus';
import { anchorFromRect, isEditKey } from '../../../utils/contextMenuKey';
import { I } from '../../../icons';
import { isRecord, toDisplayValue, valueToClipboardText } from '../../../utils/displayValue';
import type { ReferenceRule } from '@shared/types';
import { ownGet } from '../../../utils/ownProperty';
import { useCollectionWorkspace } from '../context';
import { parseFilter } from '../filterTree';
import { useResultSelection } from '../resultSelection';
import { DocFieldTree, DOC_FIELD_TREE_GRID_TEMPLATE, type FieldMenuOpenPayload } from './DocFieldTree';
import { getDocId, getFullDocId } from './docId';
import { deriveColumns, orderFields } from './tableColumns';
import { SelectToggle } from './SelectToggle';
import { DocActionsPopup } from './RowActionsMenu';
import { useDocMenu } from './useDocMenu';
import { FieldActionsMenu } from './FieldActionsMenu';
import { useAddToFilter } from './useAddToFilter';
import { useCopiedFlash } from './useCopiedFlash';
import { useDeepPaths } from './useDeepPaths';

interface TreeViewProps {
  documents: unknown[];
  /** Per-row expand state, keyed by docId. Defaults to an empty (fully collapsed) object. */
  expandedRows?: Record<string, boolean>;
  onSelect: (doc: unknown) => void;
  onRowExpand: (docId: string, expanded: boolean) => void;
  /** Map from dotted source-field path to the matching reference rule. */
  refsByField?: Map<string, ReferenceRule>;
  onRefHover?: (rule: ReferenceRule, value: unknown, rect: DOMRect) => void;
  onRefHoverLeave?: () => void;
  onRefOpen?: (rule: ReferenceRule, field: string, value: unknown) => void;
}

function getPreviewFields(
  doc: unknown,
  override?: string[] | null,
): Array<[string, unknown]> {
  if (!isRecord(doc)) return [];
  if (override != null) {
    return override
      .filter((k) => k !== '_id' && k in doc)
      .slice(0, 4)
      .map((k) => [k, doc[k]] as [string, unknown]);
  }
  const allKeys = Object.keys(doc).filter((k) => k !== '_id');
  return allKeys.slice(0, 4).map((k) => [k, doc[k]]);
}

/** Rendered height of the FIELD|VALUE|TYPE header; drives the sticky overlay's slide-off. */
const STICKY_HEADER_HEIGHT = 22;

const PREVIEW_VALUE_MAX_CHARS = 25;

function truncatePreviewValue(s: string): string {
  return s.length > PREVIEW_VALUE_MAX_CHARS
    ? s.slice(0, PREVIEW_VALUE_MAX_CHARS) + '…'
    : s;
}

interface CollapsedRowPreviewProps {
  doc: unknown;
  previewFields?: string[] | null;
}

const CollapsedRowPreview = React.memo(function CollapsedRowPreview({
  doc,
  previewFields,
}: CollapsedRowPreviewProps) {
  const preview = React.useMemo(
    () => getPreviewFields(doc, previewFields),
    [doc, previewFields],
  );
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 10,
        overflow: 'hidden',
        flexWrap: 'nowrap',
        minWidth: 0,
      }}
    >
      {preview.map(([field, val]) => {
        const dv = toDisplayValue(val);
        const rendered =
          dv.type === 'string'
            ? `"${truncatePreviewValue(dv.display)}"`
            : truncatePreviewValue(dv.display);
        return (
          <span
            key={field}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              color: 'var(--atelier-text-muted)',
              minWidth: 0,
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            <span style={{ color: 'var(--atelier-text-ghost)', flexShrink: 0 }}>{field}:</span>
            <span
              style={{
                color: 'var(--atelier-text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {rendered}
            </span>
          </span>
        );
      })}
    </div>
  );
});

interface DocRowProps {
  documents: unknown[];
  expandedRows: Record<string, boolean>;
  /** Selected row indices (T0.4 — index-based, shared across Table/Tree/JSON). */
  indices: Set<number>;
  /**
   * #60 — the row `useRovingFocus`'s `highlightIndex` currently names, or
   * `-1` when the tree doesn't have focus. Compared against a row's own
   * `index` to decide whether it paints the active-row outline — a
   * different channel from `indices` (selection), so a row can be active,
   * selected, both, or neither, and each combination reads distinctly.
   */
  activeIndex: number;
  deepPaths: Set<string>;
  copiedPath: string | null;
  previewFields?: string[] | null;
  refsByField?: Map<string, ReferenceRule>;
  onRowExpand: (docId: string, expanded: boolean) => void;
  onEditDoc: (doc: unknown) => void;
  onDeleteDoc: (doc: unknown) => void;
  // Opens the shared `RowActionsMenu` (Duplicate — Edit/Delete already have
  // their own visible buttons on this row) anchored to the "More actions"
  // button.
  onOpenRowMenu: (
    doc: unknown,
    anchor: { x: number; y: number },
    focus?: { returnFocusTo?: HTMLElement | null; focusMenuOnOpen?: boolean },
  ) => void;
  onSelect: (doc: unknown) => void;
  onToggleSelect: (index: number) => void;
  toggleDeepPath: (path: string) => void;
  handleCopy: (path: string, value: unknown) => void;
  handleOpenMenu: (payload: FieldMenuOpenPayload) => void;
  onRefHover?: (rule: ReferenceRule, value: unknown, rect: DOMRect) => void;
  onRefHoverLeave?: () => void;
  onRefOpen?: (rule: ReferenceRule, field: string, value: unknown) => void;
  // #20 — stable per-row DOM id so the tree's `aria-activedescendant` (set
  // by `useRovingFocus` in the component below) always names a real element.
  rowId: (index: number) => string;
  // #20 — found in review: a click needs to make the clicked row the roving
  // index too, or the next Arrow key jumps from wherever the highlight was
  // sitting rather than from the row just clicked.
  setActiveIndex: (index: number) => void;
}

function DocRowImpl({
  index,
  style,
  documents,
  expandedRows,
  indices,
  activeIndex,
  deepPaths,
  copiedPath,
  previewFields,
  refsByField,
  onRowExpand,
  onEditDoc,
  onDeleteDoc,
  onOpenRowMenu,
  onSelect,
  onToggleSelect,
  toggleDeepPath,
  handleCopy,
  handleOpenMenu,
  onRefHover,
  onRefHoverLeave,
  onRefOpen,
  rowId,
  setActiveIndex,
}: RowComponentProps<DocRowProps>) {
  const doc = documents[index];
  const docId = getFullDocId(doc);
  const shortId = getDocId(doc);
  const isExpanded = !!ownGet(expandedRows, docId);
  const isSelected = indices.has(index);
  const isActive = index === activeIndex;

  const handleRowClick = (e: React.MouseEvent) => {
    setActiveIndex(index);
    if (e.metaKey || e.ctrlKey) {
      onToggleSelect(index);
      onSelect(doc);
    } else {
      onRowExpand(docId, !isExpanded);
    }
  };

  return (
    <div
      // Test hook for the T0.4 cross-view selection repaint (asserted in
      // selection-shared.spec.tsx) — cheaper and less brittle than
      // asserting on the inline background/borderLeft style strings.
      data-selected={isSelected}
      style={{
        ...style,
        borderBottom: '1px solid var(--atelier-border)',
        background: isSelected ? 'var(--atelier-accent-soft)' : 'transparent',
        borderLeft: isSelected
          ? '3px solid var(--atelier-accent)'
          : '3px solid transparent',
      }}
    >
      {/* Collapsed row. No `tabIndex` at all — #20 originally left
          `tabIndex={-1}` here, but review found that any declared
          `tabIndex` (negative included) is enough to make an element
          click-focusable per the HTML focusing-steps algorithm, even though
          it's excluded from *sequential* (Tab) focus. A click was leaving
          real DOM focus on the row, so the next Arrow/Home/End reached the
          tree's own `onKeyDown` with `e.target` = this row rather than the
          tree, and its own-target guard swallowed it. Removing `tabIndex`
          lets a click's focusing steps walk up to the nearest focusable
          ancestor — the tree itself — instead, which is what makes this
          row's own former Enter/Space handler dead code (a keydown can only
          ever target an element that can hold real focus): deleted, along
          with the guard it needed, in favour of the tree-level handling in
          `TreeView` below, which now also gets a plain click's
          `setActiveIndex(index)` so the next Arrow continues from the row
          just clicked. */}
      <div
        onClick={handleRowClick}
        id={rowId(index)}
        role="treeitem"
        aria-expanded={isExpanded}
        title="Click to expand · ⌘/Ctrl+click to select"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          cursor: 'pointer',
          fontSize: 12,
          minHeight: 44,
          userSelect: 'none',
          // #60 — sighted-visible counterpart to `aria-activedescendant`.
          // Inset outline, a different channel from the selected
          // background/left-border above it, so active-and-selected still
          // reads as both.
          outline: isActive ? '2px solid var(--atelier-accent)' : undefined,
          outlineOffset: isActive ? '-2px' : undefined,
        }}
      >
        <SelectToggle
          selected={isSelected}
          docLabel={getDocId(doc)}
          onToggle={() => {
            onToggleSelect(index);
            setActiveIndex(index);
          }}
        />
        <ActionIcon
          variant="subtle"
          color="gray"
          size={28}
          c="var(--atelier-text-ghost)"
          onClick={(e) => {
            e.stopPropagation();
            onRowExpand(docId, !isExpanded);
          }}
          aria-label={isExpanded ? 'Collapse document' : 'Expand document'}
          style={{
            flexShrink: 0,
            transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 120ms',
          }}
        >
          {I.chevD}
        </ActionIcon>

        <span
          style={{
            fontFamily: 'monospace',
            fontSize: 11,
            color: 'var(--atelier-accent)',
            fontWeight: 600,
            flexShrink: 0,
            minWidth: 68,
          }}
        >
          {shortId}
        </span>

        <CollapsedRowPreview
          doc={doc}
          previewFields={previewFields}
        />

        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <Tooltip label="Edit document" withArrow openDelay={400}>
            <ActionIcon
              variant="default"
              c="var(--atelier-text-muted)"
              onClick={(e) => {
                e.stopPropagation();
                onEditDoc(doc);
              }}
              aria-label={`Edit document ${shortId}`}
            >
              {I.edit}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Delete document" withArrow openDelay={400}>
            <ActionIcon
              variant="default"
              c="var(--atelier-red)"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteDoc(doc);
              }}
              aria-label={`Delete document ${shortId}`}
            >
              {I.trash}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="More actions" withArrow openDelay={400}>
            <ActionIcon
              variant="default"
              c="var(--atelier-text-muted)"
              onClick={(e) => {
                e.stopPropagation();
                const viaKeyboard = e.detail === 0;
                onOpenRowMenu(doc, anchorFromRect(e.currentTarget.getBoundingClientRect()), {
                  returnFocusTo: viaKeyboard ? e.currentTarget : undefined,
                  focusMenuOnOpen: viaKeyboard,
                });
              }}
              aria-label={`More actions for document ${shortId}`}
            >
              {I.more}
            </ActionIcon>
          </Tooltip>
        </div>
      </div>

      {/* Expanded fields — recursive. The FIELD|VALUE|TYPE column header
          sits at the top of the doc's expansion. A JS-driven overlay in the
          TreeView pins a clone of this header to the top of the
          scroll viewport while the expanded section is in view — needed
          because react-window v2 positions rows with `transform: translateY`,
          which prevents native `position: sticky` from escaping the row.
          `DocFieldTree` owns its own `role="tree"`/`data-expanded-doc-section`
          wrapper (the sticky-header effect below still finds it by that
          attribute) and, since #20, its own roving-focus tab stop. */}
      {isExpanded && isRecord(doc) && (
        <DocFieldTree
          doc={doc}
          docId={docId}
          expandedPaths={deepPaths}
          onToggle={toggleDeepPath}
          copiedPath={copiedPath}
          onCopy={handleCopy}
          onOpenMenu={handleOpenMenu}
          refsByField={refsByField}
          onRefHover={onRefHover}
          onRefHoverLeave={onRefHoverLeave}
          onRefOpen={onRefOpen}
        />
      )}
    </div>
  );
}

// X19 #82 — this used to be `React.memo(DocRowImpl, comparator)` with a
// careful docId-keyed comparator (selection, copy-flash, expansion, #60
// active row). Deleted: none of it ever ran, for the same reason as
// `TableView.tsx`'s `TableRowImpl` (see the comment there for the method) —
// react-window's `List` hands every rebuilt row a brand-new inline `style`
// object, so the comparator's mandatory `prev.style !== next.style` top
// guard returned `false` for every mounted row, every time.
//
// Measured before deleting, same rig as `TableView.tsx` (prod build, 500
// seeded docs, 1280x800 window, n=60-120 alternating ArrowDown/ArrowUp,
// throwaway e2e probe deleted after use): 16 rows mounted, median 0.2-0.3ms
// and p95 0.5-0.6ms per keypress — an order of magnitude under the 8.3ms
// half-frame line, unlike Table's borderline result. No re-render cost
// worth memoizing away here. Every mounted row re-rendering is also what
// makes selection, copy-flash, expansion, and #60's active-row outline
// repaint today; removing the memo is a no-op on behaviour.

export function TreeView({
  documents,
  expandedRows: expandedRowsProp,
  onSelect,
  onRowExpand,
  refsByField,
  onRefHover,
  onRefHoverLeave,
  onRefOpen,
}: TreeViewProps) {
  const { state, actions, meta } = useCollectionWorkspace();
  // Collapsed-row preview strip: the Fields control's per-tab columnConfig
  // (hidden + order), same source TableView/FieldsControl already read —
  // reordering or hiding a field in Fields changes the Tree preview too.
  // No config at all (a fresh tab) falls back to `getPreviewFields`'s own
  // per-doc default (that document's own first 4 keys), which is why this
  // is `null` rather than `[]` in that case.
  const columnConfig = state.columnConfig;
  const hasFieldConfig =
    (columnConfig?.order?.length ?? 0) > 0 || (columnConfig?.hidden?.length ?? 0) > 0;
  const previewFields = React.useMemo(() => {
    if (!hasFieldConfig) return null;
    const derived = deriveColumns(documents);
    const ordered = orderFields(derived, columnConfig?.order);
    const hidden = new Set(columnConfig?.hidden ?? []);
    return ordered.filter((f) => f !== '_id' && !hidden.has(f));
  }, [hasFieldConfig, documents, columnConfig?.order, columnConfig?.hidden]);
  const onEditDoc = actions.openEdit;
  const onDeleteDoc = actions.openDelete;
  const onDuplicateDoc = actions.openDuplicate;
  // Falls back to local state when rendered standalone (no provider mounted).
  const selection = useResultSelection(documents);
  const { deepPaths, toggleDeepPath } = useDeepPaths(documents);
  const { copied: copiedPath, flash } = useCopiedFlash<string>();
  const [contextMenu, setContextMenu] = React.useState<{
    x: number;
    y: number;
    fieldPath: string;
    value: unknown;
    // #68/#69 — `DocFieldTree` sets `returnFocusTo` on both the mouse and
    // keyboard open paths, `focusMenuOnOpen` only on the keyboard one. See
    // `useMenuFocus`'s docstring.
    returnFocusTo?: HTMLElement | null;
    focusMenuOnOpen?: boolean;
  } | null>(null);
  const fieldMenuRef = React.useRef<HTMLDivElement | null>(null);
  // Memoized so `?? {}` doesn't allocate a fresh object every render, which
  // would cascade into the rowProps useMemo below.
  const expandedRows = React.useMemo(
    () => expandedRowsProp ?? {},
    [expandedRowsProp],
  );

  const handleCopy = React.useCallback(
    (path: string, value: unknown) => flash(valueToClipboardText(value), path),
    [flash],
  );

  // "More actions" per-row menu — Duplicate only, since Edit/Delete already
  // have their own always-visible buttons on this row. Separate from the
  // field-level `contextMenu` above: this one is doc-level (opened from the
  // row strip, not from inside an expanded field). Declared here, ahead of
  // handleOpenMenu below, so both open handlers can close the other menu.
  const { docMenu, docMenuRef, openDocMenu, closeDocMenu } = useDocMenu();

  const handleOpenMenu = React.useCallback(
    ({ anchor, fieldPath, value, returnFocusTo, focusMenuOnOpen }: FieldMenuOpenPayload) => {
      // Symmetric with handleOpenRowMenu below: only one of the field-level
      // and doc-level menus should ever be open at once.
      closeDocMenu();
      setContextMenu({ ...anchor, fieldPath, value, returnFocusTo, focusMenuOnOpen });
    },
    [closeDocMenu],
  );

  // Menu disables up front when the filter bar's text doesn't parse, rather
  // than showing a toast on click.
  const filterBarValid = React.useMemo(() => parseFilter(state.queryRaw).ok, [state.queryRaw]);

  // Shared with TableView; confirms whenever the Filter drawer is open.
  const handleAddToFilter = useAddToFilter({ state, actions });

  // #68 — this menu previously had no Escape path at all, only
  // click-outside; a keyboard-opened menu with no keyboard way out would
  // fail #68's own acceptance. `useMenuFocus` owns dismiss and focus both.
  const closeContextMenu = React.useCallback(() => setContextMenu(null), []);
  useMenuFocus(fieldMenuRef, contextMenu, closeContextMenu);

  const handleOpenRowMenu = React.useCallback(
    (...args: Parameters<typeof openDocMenu>) => {
      // The field-level context menu and this doc-level one both only close
      // via useMenuFocus's window click listener, but this button already
      // stops propagation — so opening one while the other is open would
      // otherwise leave both on screen at once.
      setContextMenu(null);
      openDocMenu(...args);
    },
    [openDocMenu],
  );

  // Virtualize the outer doc list with react-window v2. Collapsed rows are
  // ~44px; expanded rows grow with field count. useDynamicRowHeight observes
  // each rendered row and caches its measured height — no manual ref wiring,
  // no library-side scroll correction on resize.
  const rowHeight = useDynamicRowHeight({ defaultRowHeight: 44 });

  // #20 — the tree is the widget's single tab stop; see `TableView`'s
  // identical wiring (and `useRovingFocus`'s docstring) for why the scroll
  // has to happen synchronously with the index change.
  const listRef = useListRef(null);
  const roving = useRovingFocus({
    count: documents.length,
    idPrefix: 'tree-row-',
    resetKey: documents,
    scrollToIndex: (i) => listRef.current?.scrollToRow({ index: i, align: 'auto' }),
  });
  const handleTreeKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      roving.onKeyDown(e);
      if (e.defaultPrevented) return;
      // Only Enter/Space typed while the tree itself has focus expands the
      // active row — one bubbling up from a nested button (expand/edit/
      // delete) is that control's own action. This guard used to be
      // mirrored on DocRow itself; that copy went when the rows stopped
      // being focusable, so this is now the only one.
      if (e.target !== e.currentTarget) return;
      if (isEditKey(e)) {
        if (documents.length === 0) return;
        e.preventDefault();
        onEditDoc(documents[roving.activeIndex]);
        return;
      }
      // ⌘/Ctrl+Enter is Run (PanelBody's handler), never this row's action.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (documents.length === 0) return;
      if (e.key === ' ') e.preventDefault();
      const doc = documents[roving.activeIndex];
      const docId = getFullDocId(doc);
      onRowExpand(docId, !ownGet(expandedRows, docId));
    },
    [roving, documents, expandedRows, onRowExpand, onEditDoc],
  );

  // Memoize so react-window receives a stable rowProps reference. A fresh
  // object literal on every render would re-trigger every visible DocRow
  // (TableView already does this; TreeView and JsonView were the laggards).
  const rowProps = React.useMemo<DocRowProps>(
    () => ({
      documents,
      expandedRows,
      indices: selection.indices,
      activeIndex: roving.highlightIndex,
      deepPaths,
      copiedPath,
      previewFields,
      refsByField,
      onRowExpand,
      onEditDoc,
      onDeleteDoc,
      onOpenRowMenu: handleOpenRowMenu,
      onSelect,
      onToggleSelect: selection.toggle,
      toggleDeepPath,
      handleCopy,
      handleOpenMenu,
      onRefHover,
      onRefHoverLeave,
      onRefOpen,
      rowId: roving.rowId,
      setActiveIndex: roving.setActiveIndex,
    }),
    [
      documents,
      expandedRows,
      selection.indices,
      selection.toggle,
      roving.highlightIndex,
      deepPaths,
      copiedPath,
      previewFields,
      refsByField,
      onRowExpand,
      onEditDoc,
      onDeleteDoc,
      handleOpenRowMenu,
      onSelect,
      toggleDeepPath,
      handleCopy,
      handleOpenMenu,
      onRefHover,
      onRefHoverLeave,
      onRefOpen,
      roving.rowId,
      roving.setActiveIndex,
    ],
  );

  // JS-driven sticky header: react-window v2's `translateY` row positioning
  // breaks native `position: sticky` inside a row, so an overlay header is
  // pinned above the list instead while the scroll top lies inside an
  // expanded section. Queries the scroll container by class rather than
  // react-window's imperative handle, whose `element` getter isn't
  // populated until a second render.
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  // null = hidden; 0 = fully pinned; negative = sliding off as the section's
  // bottom enters the header band, matching native sticky semantics.
  const [stickyHeaderOffset, setStickyHeaderOffset] = React.useState<
    number | null
  >(null);

  React.useEffect(() => {
    const scroller = wrapperRef.current?.querySelector<HTMLDivElement>(
      '.tree-view-no-scroll-anchor',
    );
    if (!scroller) return;
    let raf: number | null = null;
    const update = () => {
      raf = null;
      const containerTop = scroller.getBoundingClientRect().top;
      const sections = scroller.querySelectorAll<HTMLElement>(
        '[data-expanded-doc-section="true"]',
      );
      let offset: number | null = null;
      for (const section of sections) {
        const r = section.getBoundingClientRect();
        if (r.top < containerTop && r.bottom > containerTop) {
          const overshoot = r.bottom - containerTop;
          offset = overshoot >= STICKY_HEADER_HEIGHT
            ? 0
            : overshoot - STICKY_HEADER_HEIGHT;
          break;
        }
      }
      setStickyHeaderOffset(offset);
    };
    const onScroll = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(update);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [expandedRows, documents, deepPaths]);

  return (
    <>
      <div
        ref={wrapperRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
      >
        <List<DocRowProps>
          // react-window labels its own container `role="list"`, which leaves
          // the `role="treeitem"` rows below with no valid parent (axe's
          // aria-required-parent). `tree` is the one they need.
          role="tree"
          aria-label="Documents"
          // #20 — the tree is the widget's only tab stop; see `roving` above.
          listRef={listRef}
          tabIndex={roving.containerProps.tabIndex}
          aria-activedescendant={roving.containerProps['aria-activedescendant']}
          onFocus={roving.containerProps.onFocus}
          onBlur={roving.containerProps.onBlur}
          onKeyDown={handleTreeKeyDown}
          className="tree-view-no-scroll-anchor"
          rowComponent={DocRowImpl}
          rowCount={documents.length}
          rowHeight={rowHeight}
          rowProps={rowProps}
          overscanCount={4}
          style={{
            flex: 1,
            minHeight: 0,
            overflowX: 'hidden',
          }}
        />
        {stickyHeaderOffset !== null && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${stickyHeaderOffset}px)`,
              // Matches DocRow's 3px left border so the columns line up with in-row headers.
              borderLeft: '3px solid transparent',
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
              zIndex: 2,
              pointerEvents: 'none',
            }}
          >
            <span>Field</span>
            <span>Value</span>
            <span>Type</span>
          </div>
        )}
      </div>
      {contextMenu && (
        <div
          ref={fieldMenuRef}
          role="group"
          aria-label="Field actions"
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            background: 'var(--atelier-surface)',
            border: '1px solid var(--atelier-border-med)',
            borderRadius: 'var(--atelier-radius-sm)',
            boxShadow: 'var(--atelier-shadow)',
            zIndex: 1000,
            minWidth: 160,
            padding: '4px 0',
          }}
        >
          <FieldActionsMenu
            fieldPath={contextMenu.fieldPath}
            value={contextMenu.value}
            hasValue={contextMenu.value !== undefined}
            isReadOnly={meta.isReadOnly}
            filterBarValid={filterBarValid}
            onAddToFilter={handleAddToFilter}
            onClose={closeContextMenu}
          />
        </div>
      )}
      {docMenu && (
        <DocActionsPopup
          menu={docMenu}
          menuRef={docMenuRef}
          onEdit={onEditDoc}
          onDuplicate={onDuplicateDoc}
          onDelete={onDeleteDoc}
          isReadOnly={meta.isReadOnly}
          onClose={closeDocMenu}
        />
      )}
    </>
  );
}
