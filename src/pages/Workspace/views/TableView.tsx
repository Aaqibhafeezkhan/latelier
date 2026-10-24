import React from 'react';
import { ActionIcon, Tooltip, UnstyledButton } from '@mantine/core';
import {
  List,
  useDynamicRowHeight,
  useListRef,
  type RowComponentProps,
} from 'react-window';
import { useRovingFocus } from '../../../hooks/useRovingFocus';
import { useMenuFocus } from '../../../hooks/useMenuFocus';
import { isContextMenuKey, isEditKey, anchorForRow, anchorFromRect } from '../../../utils/contextMenuKey';
import { I } from '../../../icons';
import { isRecord, toDisplayValue, valueToClipboardText } from '../../../utils/displayValue';
import { ownGet, ownSet } from '../../../utils/ownProperty';
import {
  DRAGGED_FIELD_MIME,
  classifySort,
  parseSortString,
  type DraggedField,
  type SortClass,
} from '../builder';
import type { ReferenceRule, TableColumnConfig } from '@shared/types';
import { ReferenceChip } from '../../../features/references/ReferenceChip';
import { useCollectionWorkspace } from '../context';
import { parseFilter } from '../filterTree';
import { useResultSelection } from '../resultSelection';
import { DocFieldTree, type FieldMenuOpenPayload } from './DocFieldTree';
import { getDocId, getFullDocId, isInlineEditableKind, reviveTableValue } from './docId';
import { kindOf, parseAs, textOf, type FieldKind } from '../documentFieldTypes';
import { SelectToggle } from './SelectToggle';
import { FullValuePopover } from './FullValuePopover';
import { RowActionsMenu } from './RowActionsMenu';
import { FieldActionsMenu } from './FieldActionsMenu';
import { useAddToFilter } from './useAddToFilter';
import { useCopiedFlash } from './useCopiedFlash';
import { useDeepPaths } from './useDeepPaths';
import { useDocMenu } from './useDocMenu';
import {
  deriveColumns,
  resolveColumns,
  getValueAtPath,
  ariaSortFor,
  type ResolvedColumn,
} from './tableColumns';

interface TableViewProps {
  documents: unknown[];
  /** Per-column width overrides, keyed by field. Falls back to 200px for `_id`, 160px otherwise. */
  columns?: Record<string, { width: number }>;
  columnConfig?: TableColumnConfig;
  onColumnResize: (field: string, width: number) => void;
  /** Click-to-sort cycle (asc → desc → off); omit to disable (e.g. read-only result views). */
  onSortField?: (field: string) => void;
  /** Current sort EJSON string — drives the ↑/↓ indicator in the header. */
  sort?: string;
  /** Per-row expand state, keyed by docId — shared with the Tree view. */
  expandedRows?: Record<string, boolean>;
  onRowExpand?: (docId: string, expanded: boolean) => void;
  refsByField?: Map<string, ReferenceRule>;
  onRefHover?: (rule: ReferenceRule, value: unknown, rect: DOMRect) => void;
  onRefHoverLeave?: () => void;
  onRefOpen?: (rule: ReferenceRule, field: string, value: unknown) => void;
}

// Kept independent of the data columns — the column chooser can hide/reorder
// any derived field including `_id`, so the expand control can't live in a data cell.
// Wide enough for both the expand chevron and the select checkbox side by side.
const GUTTER_WIDTH = 54;

// Sticky right-edge actions column (Edit/Delete/More) — not a data column,
// so it stays out of `deriveColumns`/`columnConfig`/`FieldsControl` (the
// Fields control drives which document fields show, not this). Pinned with
// `position: sticky; right: 0` on each cell so it stays reachable under
// horizontal scroll, matching the recommendation in the issue this closes.
const ACTIONS_WIDTH = 92;

const EMPTY_EXPANDED_ROWS: Record<string, boolean> = {};

/**
 * The cell menu's payload on top of `useDocMenu`'s doc/anchor/focus state.
 * `field: null` (the "More actions" button, Shift+F10, a right-click on the
 * row background) hides the field items and keeps Edit/Duplicate/Delete.
 */
interface CellMenuExtra {
  field: string | null;
  value: unknown;
  hasValue: boolean;
}

const ROW_MENU_EXTRA: CellMenuExtra = { field: null, value: undefined, hasValue: false };

/**
 * The table-level sort slot in the gutter header, covering sort states the
 * per-column ↑/↓ arrows can't draw: partial, hidden (drawable but the column
 * is hidden), absent (excluded from the projection), unrepresentable (no
 * mappable key), and invalid (won't run). `'none'`/`'mapped'` need no note —
 * the arrows already tell the truth for those.
 */
const SORT_NOTE: Partial<Record<SortClass, { glyph: string; text: string; warn: boolean }>> = {
  partial: {
    glyph: '↕',
    text: 'Sorted — some of the sort fields cannot be shown in this header',
    warn: false,
  },
  hidden: {
    glyph: '↕',
    text: 'Sorted by a hidden column — show it again to see the direction',
    warn: false,
  },
  absent: {
    glyph: '↕',
    text: 'Sorted by a field that is not one of these columns',
    warn: false,
  },
  unrepresentable: {
    glyph: '↕',
    text: 'Sorted by a rule this header cannot show',
    warn: false,
  },
  invalid: {
    glyph: '!',
    text: 'The sort is not valid — this query will not run',
    warn: true,
  },
};

interface TableCellProps {
  value: unknown;
  /** Dotted path or plain field name — drag payload, title, "Copy field path". */
  fieldPath: string;
  /**
   * `col.kind === 'field'` — a real document field, as opposed to a computed
   * accessor column. W18 §8: a field this narrow but `!editable` (Date,
   * ObjectId, Object, Array, …) still gets an edit affordance, just one that
   * opens the Document Editor on it instead of inline-editing it.
   */
  isFieldColumn: boolean;
  /** The row's document, needed to build the `{_id}` filter for inline-edit writes. */
  doc: unknown;
  width: number;
  cellKey: string;
  isCopied: boolean;
  rule?: ReferenceRule;
  onCopyCell: (text: string, cellKey: string) => void;
  onContextMenu: (
    e: React.MouseEvent,
    payload: { field: string | null; value: unknown; hasValue: boolean },
  ) => void;
  onRefHover?: (rule: ReferenceRule, value: unknown, rect: DOMRect) => void;
  onRefHoverLeave?: () => void;
  onRefOpen?: (rule: ReferenceRule, field: string, value: unknown) => void;
}

/**
 * A single Table cell. Owns its own hover/popover-open/inline-edit state for
 * the click-to-expand (AC5) and inline-edit (T2.6) affordances — kept local
 * rather than lifted into `TableRowImpl`'s props, since none of it is
 * needed outside this one cell. Reads `actions`/`meta` straight off the
 * workspace context (rather than threading them through `TableRowProps`)
 * for the same reason.
 */
function TableCell({
  value,
  fieldPath,
  isFieldColumn,
  doc,
  width,
  cellKey,
  isCopied,
  rule,
  onCopyCell,
  onContextMenu,
  onRefHover,
  onRefHoverLeave,
  onRefOpen,
}: TableCellProps) {
  const { actions, meta } = useCollectionWorkspace();
  const dv = toDisplayValue(value);
  const display = dv.display;
  const draggable = value !== undefined;
  const [hovered, setHovered] = React.useState(false);
  const [expandOpen, setExpandOpen] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [inputError, setInputError] = React.useState<string | null>(null);
  // The boolean toggle's own in-flight guard: unlike the text/number path,
  // it commits immediately with no separate draft to hold a second edit
  // apart from the first, so a second click before the first write settles
  // would guard its compare-and-set on the stale pre-write value and land a
  // spurious conflict. `pending` overrides the checked state (and disables
  // it) until `updateField`'s returned promise resolves.
  const [pendingBoolean, setPendingBoolean] = React.useState<boolean | null>(null);
  // Only the latest write may clear `pendingBoolean`: a rebind clears it
  // early, and an older write settling after a newer click would otherwise
  // re-enable the toggle while the newer write is still in flight.
  const boolWriteRef = React.useRef(0);
  const commitGuardRef = React.useRef(false);
  // The text/number editor stays mounted while its write is in flight, so a
  // failed write still has the typed value to show again. Only the latest
  // edit may settle it: Escape, a rebind to another document and a fresh
  // edit each bump the token, which orphans any write still in the air.
  const [saving, setSaving] = React.useState(false);
  const editTokenRef = React.useRef(0);
  // After a failed write, losing focus must not re-send it (and re-toast)
  // on every blur; Enter or an edit of the draft re-arms the commit.
  const writeFailedRef = React.useRef(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // W18 §8 — the cell's real BSON kind, revived from the wire sentinel once
  // and shared by the eligibility check and the editor's control choice, so
  // the two can't disagree about what this value is.
  const revived = React.useMemo(() => reviveTableValue(value), [value]);
  const kind = React.useMemo(() => kindOf(revived), [revived]);
  // T2.6 — restricted to real field columns: a computed accessor column's
  // `fieldPath` is a display label (or dotted path), never a real document
  // field, so it must never reach `$set`.
  const editable = isFieldColumn && isInlineEditableKind(kind, fieldPath);
  const isNumericKind = kind === 'int32' || kind === 'long' || kind === 'double' || kind === 'decimal';

  // Index-virtualization rebinds this same TableCell instance to a different
  // document when the array swaps mid-edit; without cancelling here, the
  // trailing unmount-blur would commit the stale draft onto the wrong document.
  const [prevDoc, setPrevDoc] = React.useState(doc);
  if (prevDoc !== doc) {
    setPrevDoc(doc);
    if (editing) {
      // eslint-disable-next-line react-hooks/refs
      commitGuardRef.current = true;
      // eslint-disable-next-line react-hooks/refs
      editTokenRef.current++;
      setEditing(false);
      setSaving(false);
      setDraft('');
      setInputError(null);
    }
    if (pendingBoolean !== null) {
      // eslint-disable-next-line react-hooks/refs
      boolWriteRef.current++;
      setPendingBoolean(null);
    }
  }

  // #53 — WCAG 2.4.11: hover alone leaves a Tab'd-to affordance invisible.
  // `onFocus`/`onBlur` here (React routes both through native `focusin`/
  // `focusout`, which bubble) act like CSS `:focus-within` on this cell —
  // real CSS was tried first and rejected for a narrower reason than an
  // earlier version of this comment claimed. jsdom's `getComputedStyle` *does*
  // apply stylesheet rules — a probe in this project's own component project
  // returned the stylesheet's value, not the CSS default. What it does not
  // reflect is dynamic pseudo-class state: with `.cell:focus-within .aff
  // { opacity: 1 }` mounted and the button focused, `cell.matches
  // (':focus-within')` is `true` while `getComputedStyle(btn).opacity` stays
  // at the unfocused value. So a `:focus-within` fix would be unverifiable by
  // the component tests this project requires. React's inline `style` prop
  // cannot express a pseudo-class either, and this file uses no stylesheet, so
  // the CSS route would also mean introducing a styling mechanism for one cell.
  const affordanceVisible = hovered || expandOpen || focused;

  const canInlineEdit = editable && !meta.isReadOnly && typeof actions.updateField === 'function';
  // W18 §8 — a real field this cell can't inline-edit (Date, ObjectId,
  // Object, Array, …) still gets an edit affordance; it opens the Document
  // Editor on the field instead. `_id` keeps neither: it already has the
  // row-level Edit action, and highlighting it as "editable here" would be
  // misleading.
  const canOpenEditorHere =
    !editable && isFieldColumn && fieldPath !== '_id' && draggable && !meta.isReadOnly;

  const startEdit = () => {
    if (isNumericKind) {
      setDraft(textOf(kind as FieldKind, revived));
    } else {
      setDraft(typeof value === 'string' ? value : '');
    }
    setInputError(null);
    commitGuardRef.current = false;
    writeFailedRef.current = false;
    editTokenRef.current++;
    setSaving(false);
    setEditing(true);
  };
  const cancelEdit = () => {
    // Unmounting a focused element fires a trailing real-browser blur (jsdom
    // doesn't reproduce it) that would otherwise commit the cancelled draft.
    commitGuardRef.current = true;
    editTokenRef.current++;
    setSaving(false);
    setEditing(false);
    setInputError(null);
  };
  // Holds the editor open until `updateField` settles: success closes it, a
  // failure keeps the draft in place with the reason beside it. The commit
  // guard stays set meanwhile, so Enter's trailing blur can't double-send.
  const submit = (next: unknown) => {
    commitGuardRef.current = true;
    const token = ++editTokenRef.current;
    setSaving(true);
    setInputError(null);
    void Promise.resolve(actions.updateField?.(doc, fieldPath, next)).then((outcome) => {
      if (editTokenRef.current !== token) return;
      setSaving(false);
      if (outcome?.ok === false) {
        writeFailedRef.current = true;
        commitGuardRef.current = false;
        setInputError(outcome.message);
        return;
      }
      setEditing(false);
    });
  };
  // Guarded against a double-fire: the editor stays mounted while the write
  // is in flight, and the browser also emits a blur for Enter's interaction.
  const commitEdit = () => {
    if (commitGuardRef.current) return;
    if (isNumericKind) {
      const parsed = parseAs(kind as FieldKind, draft);
      if (!parsed.ok) {
        // Refuse and stay in edit mode — never coerce or silently drop the
        // edit. The guard resets so a fix-then-Enter/blur can still commit.
        setInputError(parsed.error);
        return;
      }
      submit(parsed.value);
      return;
    }
    // An unchanged value still reaches `updateField`, which is now the same
    // guarded builder the Document Editor uses (W18 §5b: an empty diff sends
    // no request) — one no-op rule instead of a second one duplicated here.
    submit(draft);
  };

  // S9379 — an `autoFocus` attribute is a Sonar finding regardless of intent;
  // this is the same "focus the input once it mounts" behaviour without it.
  // Only runs when `editing` flips true, which only happens from the user's
  // own pencil click, so it never steals focus mid-typing elsewhere.
  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

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
    <div
      // Part of the grid: `gridcell` is what makes the row's `role="row"`
      // valid, and unlike `option` it is free to hold the drag, copy and
      // inline-edit controls this cell owns.
      role="gridcell"
      draggable={draggable && !editing}
      onDragStart={draggable && !editing ? handleDragStart : undefined}
      onDoubleClick={(e) => {
        if (!draggable || editing) return;
        e.stopPropagation();
        onCopyCell(valueToClipboardText(value), cellKey);
      }}
      onContextMenu={(e) => {
        if (editing) return;
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e, { field: fieldPath, value, hasValue: draggable });
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        width,
        minWidth: width,
        maxWidth: width,
        position: 'relative',
        borderBottom: '1px solid var(--atelier-border)',
        borderRight: '1px solid var(--atelier-border)',
        padding: '4px 8px',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
        cursor: draggable ? 'grab' : 'default',
        background: isCopied ? 'var(--atelier-accent)' : undefined,
        // #83 — keep the flash inside the padding: the #60 active-row outline is the
        // same accent, inset 2px, and would vanish into a full-cell flash.
        backgroundClip: isCopied ? 'content-box' : undefined,
        transition: 'background 120ms',
        color: isCopied
          ? '#fff'
          : dv.type === 'null' || dv.type === 'undefined'
          ? 'var(--atelier-text-ghost)'
          : dv.type === 'boolean'
          ? 'var(--atelier-warn)'
          : dv.type === 'number' || dv.type === 'long' || dv.type === 'decimal'
          ? 'var(--atelier-color-number)'
          : 'var(--atelier-text)',
        textAlign: isCopied ? 'center' : 'left',
        fontWeight: isCopied ? 600 : 400,
        boxSizing: 'border-box',
      }}
      // The native title carries both mouse-only gestures. A Mantine Tooltip
      // per cell would mount a floating-ui instance per cell of a
      // virtualized grid, and cells never take focus to trigger one anyway.
      title={
        draggable
          ? `Drag to add "${fieldPath} $eq …" to builder · double-click to copy`
          : undefined
      }
    >
      {canInlineEdit && kind === 'boolean' ? (
        // W18 §8 — booleans are always live, not gated behind a pencil-click
        // "editing" mode: flipping the toggle is the whole interaction.
        // Disabled while a write is in flight: `checked` has no separate
        // draft to protect a second click's guard from the first click's
        // still-unsettled value (see `pendingBoolean`'s own comment).
        <input
          type="checkbox"
          aria-label={`Edit ${fieldPath}`}
          checked={pendingBoolean ?? value === true}
          disabled={pendingBoolean !== null}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            const token = ++boolWriteRef.current;
            setPendingBoolean(next);
            void Promise.resolve(actions.updateField?.(doc, fieldPath, next)).finally(() => {
              if (boolWriteRef.current === token) setPendingBoolean(null);
            });
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          draggable={false}
          style={{ cursor: 'pointer' }}
        />
      ) : editing ? (
        <>
          <input
            ref={inputRef}
            aria-label={`Edit ${fieldPath}`}
            value={draft}
            inputMode={isNumericKind ? 'decimal' : undefined}
            readOnly={saving}
            aria-busy={saving || undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setInputError(null);
              writeFailedRef.current = false;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                commitEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancelEdit();
              }
            }}
            onBlur={() => {
              if (!writeFailedRef.current) commitEdit();
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            draggable={false}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontFamily: 'inherit',
              fontSize: 'inherit',
              color: 'var(--atelier-text)',
              background: 'var(--atelier-surface)',
              border: `1px solid ${inputError ? 'var(--atelier-red)' : 'var(--atelier-accent)'}`,
              borderRadius: 2,
              padding: '0 2px',
              outline: 'none',
            }}
          />
          {inputError && (
            <span
              role="alert"
              style={{
                position: 'absolute',
                left: 0,
                top: '100%',
                zIndex: 1,
                marginTop: 2,
                padding: '2px 4px',
                borderRadius: 2,
                background: 'var(--atelier-surface-raised)',
                color: 'var(--atelier-red)',
                fontSize: 11,
                whiteSpace: 'nowrap',
              }}
            >
              {inputError}
            </span>
          )}
        </>
      ) : isCopied ? (
        '✓ Copied'
      ) : rule ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            maxWidth: '100%',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
              flexShrink: 1,
            }}
          >
            {String(display)}
          </span>
          <ReferenceChip
            rule={rule}
            onHover={(rect) => onRefHover?.(rule, value, rect)}
            onLeave={() => onRefHoverLeave?.()}
            onClick={() => onRefOpen?.(rule, fieldPath, value)}
          />
        </span>
      ) : (
        String(display)
      )}

      {/* W18 §8 — inline single-field edit: hover-revealed pencil turns the
          cell into a text/number input (booleans get their own always-on
          toggle above, no pencil). Own stopPropagation so it doesn't steal
          row-select / drag / dblclick-copy / contextmenu, matching the
          expand affordance below. Gated on `canInlineEdit` (string, Int32,
          Int64, Double or Decimal128 values on a real field column, not a
          computed accessor or `_id`, and never on a read-only workspace) so
          a sentinel-typed or computed cell can't be silently corrupted via
          `$set`. */}
      {canInlineEdit && kind !== 'boolean' && !editing && (
        <ActionIcon
          variant="subtle"
          color="gray"
          size={16}
          c="var(--atelier-text-ghost)"
          aria-label="Edit cell value"
          onClick={(e) => {
            e.stopPropagation();
            startEdit();
          }}
          style={{
            position: 'absolute',
            right: 20,
            top: '50%',
            transform: 'translateY(-50%)',
            opacity: affordanceVisible ? 1 : 0,
            pointerEvents: affordanceVisible ? 'auto' : 'none',
            borderRadius: 3,
            background: 'var(--atelier-surface-raised)',
          }}
        >
          {I.edit}
        </ActionIcon>
      )}

      {/* W18 §8 — a field this cell can't edit inline (Date, ObjectId,
          Object, Array, …) still gets an edit affordance; it opens the
          Document Editor on the field rather than turning the cell itself
          into an input. */}
      {canOpenEditorHere && (
        <ActionIcon
          variant="subtle"
          color="gray"
          size={16}
          c="var(--atelier-text-ghost)"
          aria-label="Edit cell value"
          onClick={(e) => {
            e.stopPropagation();
            actions.openEdit(doc, fieldPath);
          }}
          style={{
            position: 'absolute',
            right: 20,
            top: '50%',
            transform: 'translateY(-50%)',
            opacity: affordanceVisible ? 1 : 0,
            pointerEvents: affordanceVisible ? 'auto' : 'none',
            borderRadius: 3,
            background: 'var(--atelier-surface-raised)',
          }}
        >
          {I.edit}
        </ActionIcon>
      )}

      {/* AC5 — click-to-expand: hover-revealed affordance opens a
          read-only popover with the untruncated value. Doesn't steal
          row-select / drag / dblclick-copy / contextmenu (own
          stopPropagation, and pointer-events are off until hovered). */}
      {draggable && !editing && (
        <FullValuePopover
          display={String(display)}
          isString={dv.type === 'string'}
          opened={expandOpen}
          onChange={setExpandOpen}
          visible={affordanceVisible}
        />
      )}
    </div>
  );
}

interface TableRowProps {
  documents: unknown[];
  columns: ResolvedColumn[];
  widths: Record<string, number>;
  indices: Set<number>;
  /**
   * #60 — the row `useRovingFocus`'s `highlightIndex` currently names, or
   * `-1` when the grid doesn't have focus. Compared against a row's own
   * `index` to decide whether it paints the active-row outline — a
   * different channel from `indices` (selection), so a row can be active,
   * selected, both, or neither, and each combination reads distinctly.
   */
  activeIndex: number;
  copiedCell: string | null;
  expandedRows: Record<string, boolean>;
  deepPaths: Set<string>;
  fieldCopiedPath: string | null;
  refsByField?: Map<string, ReferenceRule>;
  // Widened from React.MouseEvent so a keyboard Enter/Space on the row can
  // drive the same selection logic as a click — both event types carry
  // metaKey/ctrlKey, which is all this reads. A plain click only moves the
  // active row; ⌘/Ctrl+click also toggles the row into/out of the
  // selection — the checkbox below is the plain-click-free way in.
  onSelect: (e: { metaKey: boolean; ctrlKey: boolean }, idx: number) => void;
  onToggleSelect: (idx: number) => void;
  // stable per-row DOM id so the grid's `aria-activedescendant` (set
  // by `useRovingFocus` in the component below) always names a real element.
  rowId: (index: number) => string;
  onCopyCell: (text: string, cellKey: string) => void;
  onContextMenu: (
    e: React.MouseEvent,
    payload: {
      doc: unknown;
      field: string | null;
      value: unknown;
      hasValue: boolean;
    },
  ) => void;
  onRowExpand: (docId: string, expanded: boolean) => void;
  toggleDeepPath: (path: string) => void;
  handleCopyField: (path: string, value: unknown) => void;
  handleOpenFieldMenu: (payload: FieldMenuOpenPayload) => void;
  onRefHover?: (rule: ReferenceRule, value: unknown, rect: DOMRect) => void;
  onRefHoverLeave?: () => void;
  onRefOpen?: (rule: ReferenceRule, field: string, value: unknown) => void;
  onEditDoc: (doc: unknown) => void;
  onDeleteDoc: (doc: unknown) => void;
  // Opens the same cell-level context menu the right-click/Shift+F10 paths
  // use (Edit/Duplicate/Delete), anchored to the "More actions" button
  // rather than the cursor. `focus` carries the keyboard-open pair
  // (`returnFocusTo`/`focusMenuOnOpen`) only when the click itself came
  // from the keyboard — see the button's own `onClick` for how that's told
  // apart from a mouse click.
  onOpenRowMenu: (
    doc: unknown,
    anchor: { x: number; y: number },
    focus?: { returnFocusTo?: HTMLElement | null; focusMenuOnOpen?: boolean },
  ) => void;
  // Hand-computed pin for the actions column — see `TableView`'s own
  // `actionsOffset` for why native `position: sticky` can't be used here.
  actionsOffset: number;
}

// `ariaAttributes` is intentionally not destructured off the row props.
// react-window offers `role="listitem"` + posinset/setsize to pair with the
// `role="list"` it puts on its own container; this table is a grid, and a
// `listitem` between the grid and its rows would break the rows' ownership.
function TableRowImpl({
  index,
  style,
  documents,
  columns,
  widths,
  indices,
  activeIndex,
  copiedCell,
  expandedRows,
  deepPaths,
  fieldCopiedPath,
  refsByField,
  onSelect,
  onToggleSelect,
  onCopyCell,
  onContextMenu,
  onRowExpand,
  toggleDeepPath,
  handleCopyField,
  handleOpenFieldMenu,
  onRefHover,
  onRefHoverLeave,
  onRefOpen,
  rowId,
  onEditDoc,
  onDeleteDoc,
  onOpenRowMenu,
  actionsOffset,
}: RowComponentProps<TableRowProps>) {
  const doc = documents[index];
  const isSelected = indices.has(index);
  const isActive = index === activeIndex;
  const docId = getFullDocId(doc);
  const isExpanded = !!ownGet(expandedRows, docId);
  // The actions column shows on row hover (mouse), when the row is the
  // roving-focus target (`isActive`, keyboard), or when real DOM focus is
  // inside it (Tab reaches these buttons the same way it already reaches
  // TableCell's own hover-revealed pencil/expand buttons — see those for
  // why `focused` state, not `:focus-within`, catches that: this project's
  // component tests read `getComputedStyle`, which doesn't reflect dynamic
  // pseudo-classes in jsdom). Local hover/focus state rather than CSS for
  // the same reason.
  const [rowHovered, setRowHovered] = React.useState(false);
  const [actionsFocused, setActionsFocused] = React.useState(false);
  const actionsVisible = rowHovered || isActive || actionsFocused;
  const rowBackground = isSelected
    ? 'var(--atelier-accent-soft)'
    : index % 2 === 0
    ? 'var(--atelier-surface-raised)'
    : 'var(--atelier-surface)';

  return (
    <div
      // No role here on purpose — see the note on this function's props. The
      // grid's row and index attributes are set on the strip below.
      data-selected={isSelected}
      style={{
        ...style,
        background: rowBackground,
      }}
    >
      {/* This strip behaves like an activatable row (plain click makes it
          the active/highlighted row, ⌘/Ctrl+click also toggles it into/out
          of the selection) while wrapping other real interactive controls:
          draggable cells, the expand chevron, the select checkbox, the edit
          affordances. `role="option"` was the first attempt and was wrong:
          `option` is "children presentational" in ARIA, so it may not
          contain any of those, and it needs a `listbox` parent this never
          had.

          `row` inside `role="grid"` is the pattern for exactly this — a data
          table whose cells hold controls. `row` is not children
          presentational, so the cell controls stay exposed, and
          `aria-selected` is valid on it. `aria-rowindex` is 1-based and
          counts the header, so the first document row is 2.

          No `tabIndex` at all: a plain `div` with none is already out of
          both the Tab order AND click-focusable — the HTML focusing-steps
          algorithm treats any declared `tabIndex` (negative included) as
          making the element focusable via a real click, and a click leaving
          real DOM focus sitting on the row would make the next Arrow/Home/End
          reach the grid's `onKeyDown` with `e.target` = this row instead of
          the grid itself, where its own-target guard would swallow every one
          of them. Leaving `tabIndex` off lets a click's focusing steps walk
          up to the nearest focusable ancestor instead, which is the grid —
          exactly where real focus needs to live. The grid's
          `aria-activedescendant` (set in `TableView` below) still points at
          this row via its `id`; `onSelect` also moves the roving index here
          on click, so a click and the next Arrow agree on which row is
          active. */}
      <div
        id={rowId(index)}
        role="row"
        aria-rowindex={index + 2}
        aria-selected={isSelected}
        style={{
          display: 'flex',
          alignItems: 'stretch',
          cursor: 'pointer',
          fontSize: 11,
          fontFamily: 'monospace',
          // #60 — sighted-visible counterpart to `aria-activedescendant`.
          // An inset outline (paints on top, reserves no layout space) so it
          // never shifts the row, and it's a different channel from the
          // selected background above it, so active-and-selected still
          // reads as both.
          outline: isActive ? '2px solid var(--atelier-accent)' : undefined,
          outlineOffset: isActive ? '-2px' : undefined,
        }}
        onClick={(e) => onSelect(e, index)}
        onMouseEnter={() => setRowHovered(true)}
        onMouseLeave={() => setRowHovered(false)}
      >
        {/* Fixed expand+select gutter — independent of the (hide/reorder-able)
            data columns. A `gridcell` like the rest, so the row owns nothing
            but cells. */}
        <div
          role="gridcell"
          style={{
            width: GUTTER_WIDTH,
            minWidth: GUTTER_WIDTH,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            borderBottom: '1px solid var(--atelier-border)',
            borderRight: '1px solid var(--atelier-border)',
            boxSizing: 'border-box',
          }}
        >
          <SelectToggle
            selected={isSelected}
            docLabel={getDocId(doc)}
            onToggle={() => onToggleSelect(index)}
          />
          <ActionIcon
            variant="subtle"
            color="gray"
            size={20}
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
        </div>

        {columns.map((col) => {
          const val =
            col.kind === 'field'
              ? isRecord(doc)
                ? doc[col.field]
                : undefined
              : isRecord(doc)
              ? getValueAtPath(doc, col.path)
              : undefined;
          const fieldPath = col.kind === 'field' ? col.field : col.label ?? col.path;
          const cellKey = `${index}:${col.field}`;
          const isCopied = copiedCell === cellKey;
          const width = ownGet(widths, col.field) ?? 160;
          const rule = val !== undefined ? refsByField?.get(fieldPath) : undefined;

          return (
            <TableCell
              key={col.field}
              value={val}
              fieldPath={fieldPath}
              isFieldColumn={col.kind === 'field'}
              doc={doc}
              width={width}
              cellKey={cellKey}
              isCopied={isCopied}
              rule={rule}
              onCopyCell={onCopyCell}
              onContextMenu={(e, payload) => onContextMenu(e, { doc, ...payload })}
              onRefHover={onRefHover}
              onRefHoverLeave={onRefHoverLeave}
              onRefOpen={onRefOpen}
            />
          );
        })}

        {/* Right-edge actions column — Edit/Delete always visible (matching
            Tree/JSON, which never gate them on `isReadOnly`; they're no-ops
            for read-only providers), plus a "More actions" button that
            opens the same cell-level context menu the right-click/
            Shift+F10 paths use (it already gates Duplicate on
            `!meta.isReadOnly`, so nothing new to gate here). Kept reachable
            under horizontal scroll via `actionsOffset`, a hand-computed
            `transform` rather than native `position: sticky` — see
            `TableView`'s own comment on `actionsOffset` for why sticky
            doesn't reach across react-window's `List`. Not a data column:
            it's rendered here directly rather than through `columns`/
            `deriveColumns`, so it never reaches `columnConfig` or the
            Fields control. */}
        <div
          role="gridcell"
          style={{
            width: ACTIONS_WIDTH,
            minWidth: ACTIONS_WIDTH,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 2,
            padding: '0 6px',
            borderBottom: '1px solid var(--atelier-border)',
            borderLeft: '1px solid var(--atelier-border)',
            boxSizing: 'border-box',
            background: rowBackground,
            transform: `translateX(${actionsOffset}px)`,
            opacity: actionsVisible ? 1 : 0,
            pointerEvents: actionsVisible ? 'auto' : 'none',
          }}
          onFocus={() => setActionsFocused(true)}
          onBlur={() => setActionsFocused(false)}
        >
          <Tooltip label="Edit document" withArrow openDelay={400}>
            <ActionIcon
              variant="default"
              size="sm"
              c="var(--atelier-text-muted)"
              onClick={(e) => {
                e.stopPropagation();
                onEditDoc(doc);
              }}
              aria-label={`Edit document ${getDocId(doc)}`}
            >
              {I.edit}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Delete document" withArrow openDelay={400}>
            <ActionIcon
              variant="default"
              size="sm"
              c="var(--atelier-red)"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteDoc(doc);
              }}
              aria-label={`Delete document ${getDocId(doc)}`}
            >
              {I.trash}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="More actions" withArrow openDelay={400}>
            <ActionIcon
              variant="default"
              size="sm"
              c="var(--atelier-text-muted)"
              onClick={(e) => {
                e.stopPropagation();
                // A keyboard-activated click (Enter/Space) reports `detail:
                // 0` in Chromium (the app's only runtime — a mouse click is
                // always >= 1); only that path grabs focus into the menu and
                // returns it to this button on dismiss, matching the
                // keyboard-open convention the field/cell menus above use.
                const viaKeyboard = e.detail === 0;
                onOpenRowMenu(doc, anchorFromRect(e.currentTarget.getBoundingClientRect()), {
                  returnFocusTo: viaKeyboard ? e.currentTarget : undefined,
                  focusMenuOnOpen: viaKeyboard,
                });
              }}
              aria-label={`More actions for document ${getDocId(doc)}`}
            >
              {I.more}
            </ActionIcon>
          </Tooltip>
        </div>
      </div>

      {/* Row expand (AC1/AC2) — the same recursive FIELD|VALUE|TYPE tree the
          Tree view renders, via the shared `DocFieldTree`, which owns its
          own `role="tree"`/`data-expanded-doc-section` wrapper and (#20)
          its own roving-focus tab stop. */}
      {isExpanded && isRecord(doc) && (
        <DocFieldTree
          doc={doc}
          docId={docId}
          expandedPaths={deepPaths}
          onToggle={toggleDeepPath}
          copiedPath={fieldCopiedPath}
          onCopy={handleCopyField}
          onOpenMenu={handleOpenFieldMenu}
          refsByField={refsByField}
          onRefHover={onRefHover}
          onRefHoverLeave={onRefHoverLeave}
          onRefOpen={onRefOpen}
        />
      )}
    </div>
  );
}

// X19 #82 — this used to be `React.memo(TableRowImpl, comparator)` with a
// careful index-keyed comparator (selection, copy-flash, expansion, #60
// active row). Deleted: none of it ever ran. react-window's `List` rebuilds
// its row array in a `useMemo` keyed on `rowProps` and hands every rebuilt
// row a brand-new inline `style` object, so the comparator's mandatory
// `prev.style !== next.style` top guard returned `false` for every mounted
// row, every time — the rest of the comparator body was unreachable. See
// #82 for the full writeup and the render-count probe that confirmed it.
//
// Measured before deleting, not guessed. Method: a prod build, 500 seeded
// docs (8 fields), a 1280x800 window, 28 mounted rows x 10 columns; an
// ArrowDown/ArrowUp keydown dispatched in-page and timed to the target
// row's own `style` mutation via a `MutationObserver` plus a forced layout
// read, alternating Down/Up so the mounted set stays constant, n=60-120
// samples per run (throwaway e2e probe, deleted after use). Result: median
// 5.3-5.5ms; p95 ranged 7.2-9.4ms across repeated runs — close to half a
// 60Hz frame (8.3ms), not comfortably clear of it. Page size (default vs.
// 500) didn't move the number: react-window only mounts what's in the
// viewport, so rows-in-view x columns drives cost, not total row count.
// Deleting is still the right call on this measurement — the median has
// headroom, and TreeView (below) clears the threshold by an order of
// magnitude on the same rig — but this one is a judgment call, not a clean
// pass. If TableView picks up materially more columns or heavier cells,
// re-measure before assuming the margin still holds; a value-based `style`
// comparison measured 0.8ms median / 1.4ms p95 in the same conditions and
// is the fallback if it doesn't. Every mounted row re-rendering today is
// also what makes selection, copy-flash, expansion, and #60's active-row
// outline repaint; removing the memo is a no-op on behaviour, just honest
// about it.

export function TableView({
  documents,
  columns: columnsProp,
  columnConfig,
  onColumnResize,
  onSortField,
  sort,
  expandedRows: expandedRowsProp,
  onRowExpand,
  refsByField,
  onRefHover,
  onRefHoverLeave,
  onRefOpen,
}: TableViewProps) {
  const { state, actions, meta } = useCollectionWorkspace();
  const onEditDoc = actions.openEdit;
  const onDeleteDoc = actions.openDelete;
  const onDuplicateDoc = actions.openDuplicate;
  // Falls back to local state when rendered standalone (no provider mounted).
  const selection = useResultSelection(documents);
  // Badge, not toast — a toast per cell copy would be noise; a failed copy toasts instead.
  const { copied: copiedCell, flash: copyCell } = useCopiedFlash<string>();

  const expandedRows = React.useMemo(
    () => expandedRowsProp ?? EMPTY_EXPANDED_ROWS,
    [expandedRowsProp],
  );
  const handleRowExpand = React.useCallback(
    (docId: string, expanded: boolean) => {
      onRowExpand?.(docId, expanded);
    },
    [onRowExpand],
  );

  // Ephemeral, Table-local, reset when the document set changes (mirrors TreeView).
  const { deepPaths, toggleDeepPath } = useDeepPaths(documents);

  // Badge, not toast — same ruling as `copyCell` above.
  const { copied: fieldCopiedPath, flash: flashField } = useCopiedFlash<string>();
  const handleCopyField = React.useCallback(
    (path: string, value: unknown) => flashField(valueToClipboardText(value), path),
    [flashField],
  );

  const [fieldContextMenu, setFieldContextMenu] = React.useState<{
    x: number;
    y: number;
    fieldPath: string;
    value: unknown;
    // #68/#69 — same split as the cell menu above: `returnFocusTo` is set on
    // both the mouse and keyboard open paths (`DocFieldTree` injects it),
    // `focusMenuOnOpen` only on the keyboard one.
    returnFocusTo?: HTMLElement | null;
    focusMenuOnOpen?: boolean;
  } | null>(null);
  const fieldMenuRef = React.useRef<HTMLDivElement | null>(null);
  const handleOpenFieldMenu = React.useCallback(
    ({ anchor, fieldPath, value, returnFocusTo, focusMenuOnOpen }: FieldMenuOpenPayload) => {
      setFieldContextMenu({ ...anchor, fieldPath, value, returnFocusTo, focusMenuOnOpen });
    },
    [],
  );

  // Menus disable up front when the filter bar's text doesn't parse, rather
  // than showing a toast on click.
  const filterBarValid = React.useMemo(() => parseFilter(state.queryRaw).ok, [state.queryRaw]);

  // Shared with TreeView. Confirms whenever the Filter drawer is open
  // (deliberate over-warn — it may hold newer local input this can't see).
  const handleAddToFilter = useAddToFilter({ state, actions });
  const closeFieldContextMenu = React.useCallback(() => setFieldContextMenu(null), []);
  useMenuFocus(fieldMenuRef, fieldContextMenu, closeFieldContextMenu);

  const derivedFields = React.useMemo(() => deriveColumns(documents), [documents]);
  const columns = React.useMemo(
    () => resolveColumns(derivedFields, columnConfig),
    [derivedFields, columnConfig],
  );
  const sortMap = React.useMemo(() => parseSortString(sort ?? ''), [sort]);
  // Excludes computed columns — a computed column named after a sort key
  // must not count as "drawn" and silence the note.
  const shownFields = React.useMemo(
    () => new Set(columns.filter((c) => c.kind === 'field').map((c) => c.field)),
    [columns],
  );
  // The derived list before `hidden` is applied, so an excluded-by-projection
  // key reads "absent" rather than a chooser-unreachable "hidden".
  const schemaFields = React.useMemo(() => new Set(derivedFields), [derivedFields]);
  const sortNote = SORT_NOTE[classifySort(sort ?? '', shownFields, schemaFields)];
  const multiFieldSort = Object.keys(sortMap).length > 1;

  // Tracks the cursor on every mousemove, committed to the parent only on
  // mouseup — every-pixel commits would re-render the whole workspace tree at ~60fps.
  const [liveDrag, setLiveDrag] = React.useState<{ field: string; width: number } | null>(null);

  const propWidth = React.useCallback(
    (field: string) => columnsProp?.[field]?.width ?? (field === '_id' ? 200 : 160),
    [columnsProp],
  );
  const getWidth = React.useCallback(
    (field: string) =>
      liveDrag && liveDrag.field === field ? liveDrag.width : propWidth(field),
    [liveDrag, propWidth],
  );

  const widths = React.useMemo(() => {
    const out: Record<string, number> = {};
    for (const col of columns) ownSet(out, col.field, getWidth(col.field));
    return out;
  }, [columns, getWidth]);
  const totalWidth = React.useMemo(
    () =>
      GUTTER_WIDTH +
      ACTIONS_WIDTH +
      columns.reduce((sum, c) => sum + (ownGet(widths, c.field) ?? 160), 0),
    [columns, widths],
  );

  // The sticky actions column can't use native `position: sticky; right: 0`:
  // its nearest ancestor with non-`visible` overflow is react-window's own
  // `List` element (forced non-`visible` on both axes by its own
  // `overflowY: 'auto'` — the CSS rule that couples the two axes once
  // either one opts out of `visible`), not this wrapping div, even though
  // this div is the one that actually scrolls horizontally (`List`'s own
  // box is sized to fit its content exactly, via `minWidth: totalWidth`
  // below, so it never overflows itself). Native sticky would silently
  // resolve against `List` instead and never move — confirmed empirically
  // with a throwaway Playwright repro of the same nesting, deleted after
  // use. So the offset is computed by hand and applied as a `transform`,
  // the same trick TreeView's sticky field-header overlay uses for an
  // analogous case where react-window's row positioning breaks a native
  // CSS mechanism.
  //
  // The column's right edge is the wrapper's visible right edge, capped at
  // the grid's own content box: once the grid shows its vertical scrollbar,
  // its rows are that much narrower than the wrapper, and a `transform`
  // counts toward scrollable overflow — ending at the wrapper's edge would
  // tuck the column under the scrollbar and give the grid a horizontal
  // scrollbar of its own, shortening the viewport the roving-focus scroll
  // aims at.
  const tableWrapperRef = React.useRef<HTMLDivElement>(null);
  // Declared here rather than beside `roving` below, which also uses it:
  // the actions offset reads the grid element too.
  const listRef = useListRef(null);
  const [actionsOffset, setActionsOffset] = React.useState(0);
  const computeActionsOffset = React.useCallback(() => {
    const el = tableWrapperRef.current;
    if (!el) return;
    const visibleRight = el.scrollLeft + el.clientWidth;
    const grid = listRef.current?.element;
    setActionsOffset((grid ? Math.min(visibleRight, grid.clientWidth) : visibleRight) - totalWidth);
  }, [totalWidth, listRef]);
  const scrollRaf = React.useRef<number | null>(null);
  const handleTableScroll = React.useCallback(() => {
    if (scrollRaf.current != null) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = null;
      computeActionsOffset();
    });
  }, [computeActionsOffset]);
  React.useLayoutEffect(() => {
    computeActionsOffset();
  }, [computeActionsOffset]);
  // A window resize is not the only thing that moves the visible edge: a
  // panel splitter drag resizes the wrapper alone, and the grid's vertical
  // scrollbar appears only once enough rows have been measured.
  React.useEffect(() => {
    const el = tableWrapperRef.current;
    if (!el) return;
    const observer = new ResizeObserver(computeActionsOffset);
    observer.observe(el);
    const grid = listRef.current?.element;
    if (grid) observer.observe(grid);
    return () => observer.disconnect();
  }, [computeActionsOffset, listRef]);

  const dragState = React.useRef<{
    field: string;
    startX: number;
    startW: number;
  } | null>(null);

  const handleResizeMouseDown = (e: React.MouseEvent, field: string) => {
    e.preventDefault();
    e.stopPropagation();
    const startW = propWidth(field);
    dragState.current = {
      field,
      startX: e.clientX,
      startW,
    };
    setLiveDrag({ field, width: startW });

    const onMove = (me: MouseEvent) => {
      if (!dragState.current) return;
      const delta = me.clientX - dragState.current.startX;
      const newWidth = Math.max(60, dragState.current.startW + delta);
      setLiveDrag({ field: dragState.current.field, width: newWidth });
    };

    const onUp = () => {
      const finished = dragState.current;
      dragState.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (finished) {
        // Functional setter to read the final value without a stale closure.
        setLiveDrag((current) => {
          if (current && current.field === finished.field) {
            onColumnResize(finished.field, current.width);
          }
          return null;
        });
      } else {
        setLiveDrag(null);
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // The cell menu, doc-level (Edit/Delete included) plus the clicked cell's
  // field items. #55/#69 — every open path sets `returnFocusTo`, so
  // Escape/click-away always has somewhere to send focus back to instead of
  // stranding it on `<body>`; `focusMenuOnOpen` (grabbing focus *into* the
  // menu) stays keyboard-only — see `useMenuFocus`'s docstring.
  const {
    docMenu: contextMenu,
    docMenuRef: cellMenuRef,
    openDocMenu,
    closeDocMenu: closeContextMenu,
  } = useDocMenu<CellMenuExtra>();

  // #20 — the grid is the widget's single tab stop; `useRovingHighlight`
  // (via `useRovingFocus`) owns which row is "active" and this wires it to
  // the DOM: a stable `id` per row (set in `TableRowImpl` above) named by the
  // grid's `aria-activedescendant`, kept in sync with react-window's
  // mounted range by scrolling to the row in the same key handler that
  // moves the index — see `useRovingFocus`'s own docstring for why that has
  // to be one operation, not two. Declared before `handleSelect` below,
  // which needs `roving.setActiveIndex`.
  const roving = useRovingFocus({
    count: documents.length,
    idPrefix: 'table-row-',
    resetKey: documents,
    scrollToIndex: (i) => listRef.current?.scrollToRow({ index: i, align: 'auto' }),
  });

  // Plain click only moves the roving-focus/active-row highlight — it used
  // to also replace the selection with just this row, which made a habit
  // learned in Table surprise a user in Tree or JSON (a plain click there
  // means something else entirely). ⌘/Ctrl+click still toggles the row
  // into/out of the multi-row selection for the bulk-action bar; the visible
  // checkbox in the gutter is the plain-click-free way to select. Always
  // moves the roving-focus target too — found in review: a clicked row
  // (`tabIndex={-1}` used to make it click-focusable per the HTML
  // focusing-steps algorithm — since removed, see the row strip's own
  // comment) would otherwise leave the highlight sitting wherever it was
  // before the click, so the next Arrow key would jump from there instead of
  // from the row the user just clicked.
  const handleRowClick = React.useCallback(
    (e: { metaKey: boolean; ctrlKey: boolean }, idx: number) => {
      if (e.metaKey || e.ctrlKey) selection.toggle(idx);
      roving.setActiveIndex(idx);
    },
    // `roving` itself is a fresh object every render; depend on the one
    // function this actually calls (stable per `useRovingFocus`) so this
    // callback — and everything memoized against it, like `rowProps` below
    // — doesn't get a new identity on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, roving.setActiveIndex],
  );

  // The checkbox's own gesture: toggle the row into/out of the selection
  // (never a single-row replace — matches JSON's and Tree's checkbox, and
  // ⌘/Ctrl+click above) and also move the active row here, same as a click
  // anywhere else on the strip.
  const handleToggleSelect = React.useCallback(
    (idx: number) => {
      selection.toggle(idx);
      roving.setActiveIndex(idx);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, roving.setActiveIndex],
  );

  // Keyboard Enter/Space on the grid (handleGridKeyDown below) keeps the
  // previous plain-click semantics: replace the selection with just the
  // active row, or clear it if it was already the sole selection. Mouse and
  // keyboard deliberately diverge here — the mouse has a dedicated checkbox
  // and ⌘/Ctrl+click, but a keyboard user still needs a single-key way to
  // select the active row without reaching for a modifier.
  const handleSelect = React.useCallback(
    (e: { metaKey: boolean; ctrlKey: boolean }, idx: number) => {
      if (e.metaKey || e.ctrlKey) selection.toggle(idx);
      else selection.selectOnly(idx);
      roving.setActiveIndex(idx);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, roving.setActiveIndex],
  );

  const handleContextMenu = React.useCallback(
    (
      e: React.MouseEvent,
      payload: {
        doc: unknown;
        field: string | null;
        value: unknown;
        hasValue: boolean;
      },
    ) => {
      // #69 — same restore-on-close target the keyboard path uses below, so
      // Escape/click-away no longer strands focus on `<body>` after a
      // right-click. `focusMenuOnOpen` stays unset: a mouse open still
      // doesn't grab focus into the menu, only Escape now has somewhere to
      // send it back to.
      const { doc, ...extra } = payload;
      openDocMenu(doc, { x: e.clientX, y: e.clientY }, { returnFocusTo: listRef.current?.element ?? null }, extra);
    },
    [listRef, openDocMenu],
  );

  // The "More actions" button's own open path — anchored to the button
  // rather than the cursor, same shape as the Shift+F10 path below
  // (`field: null`/`hasValue: false`, since this isn't a specific cell).
  const handleOpenRowMenu = React.useCallback(
    (
      doc: unknown,
      anchor: { x: number; y: number },
      focus?: { returnFocusTo?: HTMLElement | null; focusMenuOnOpen?: boolean },
    ) => {
      openDocMenu(
        doc,
        anchor,
        {
          returnFocusTo: focus?.returnFocusTo ?? listRef.current?.element ?? null,
          focusMenuOnOpen: focus?.focusMenuOnOpen,
        },
        ROW_MENU_EXTRA,
      );
    },
    [listRef, openDocMenu],
  );

  // Row-expand makes rows variable-height; measure each rendered row rather
  // than assuming a fixed height (mirrors TreeView).
  const rowHeight = useDynamicRowHeight({ defaultRowHeight: 24 });

  const handleGridKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      roving.onKeyDown(e);
      if (e.defaultPrevented) return;
      // Only Enter/Space typed while the grid itself has real DOM focus
      // selects the active row — one bubbling up from a nested button
      // (edit/expand/inline-edit) is that control's own action. Rows are no
      // longer focusable at all (see the row strip's own comment), so this
      // is now the ONLY place that guard can matter.
      if (e.target !== e.currentTarget) return;
      // #55 — Shift+F10 / ContextMenu key: open the (doc-level) cell menu for
      // the active row. No specific field/value — `field: null` is exactly
      // what a right-click on the row background (rather than a cell) would
      // pass, so Copy value/Copy field path correctly don't render while
      // Edit/Duplicate/Delete do.
      if (isContextMenuKey(e)) {
        if (documents.length === 0) return;
        e.preventDefault();
        // #133 — PageDown or the wheel can have scrolled the active row out
        // and unmounted it: open anyway (anchored to the grid) and bring the
        // row back into view.
        const rowEl = document.getElementById(roving.rowId(roving.activeIndex));
        const anchor = anchorForRow(rowEl, listRef.current?.element ?? null);
        if (!anchor) return;
        if (!rowEl) listRef.current?.scrollToRow({ index: roving.activeIndex, align: 'auto' });
        openDocMenu(
          documents[roving.activeIndex],
          anchor,
          { returnFocusTo: listRef.current?.element ?? null, focusMenuOnOpen: true },
          ROW_MENU_EXTRA,
        );
        return;
      }
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
      e.preventDefault();
      handleSelect(e, roving.activeIndex);
    },
    // `roving` itself is a fresh object every render (see `handleSelect`
    // above) — depend on the members this actually reads instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roving.onKeyDown, roving.activeIndex, roving.rowId, documents, handleSelect, listRef, onEditDoc, openDocMenu],
  );

  const rowProps = React.useMemo<TableRowProps>(
    () => ({
      documents,
      columns,
      widths,
      indices: selection.indices,
      activeIndex: roving.highlightIndex,
      copiedCell,
      expandedRows,
      deepPaths,
      fieldCopiedPath,
      refsByField,
      onSelect: handleRowClick,
      onToggleSelect: handleToggleSelect,
      onCopyCell: copyCell,
      onContextMenu: handleContextMenu,
      onRowExpand: handleRowExpand,
      toggleDeepPath,
      handleCopyField,
      handleOpenFieldMenu,
      onRefHover,
      onRefHoverLeave,
      onRefOpen,
      rowId: roving.rowId,
      onEditDoc,
      onDeleteDoc,
      onOpenRowMenu: handleOpenRowMenu,
      actionsOffset,
    }),
    [
      documents,
      columns,
      widths,
      selection.indices,
      roving.highlightIndex,
      copiedCell,
      expandedRows,
      deepPaths,
      fieldCopiedPath,
      refsByField,
      handleRowClick,
      handleToggleSelect,
      copyCell,
      handleContextMenu,
      handleRowExpand,
      toggleDeepPath,
      handleCopyField,
      handleOpenFieldMenu,
      onRefHover,
      onRefHoverLeave,
      onRefOpen,
      roving.rowId,
      onEditDoc,
      onDeleteDoc,
      handleOpenRowMenu,
      actionsOffset,
    ],
  );

  return (
    <div
      ref={tableWrapperRef}
      onScroll={handleTableScroll}
      // Test hook (e2e) — the actual horizontal-scroll container. `[role="grid"]`
      // (react-window's `List`) sizes its own box to fit its content exactly
      // (`minWidth: totalWidth` below), so it never scrolls itself; this div
      // is what does, and what the actions column's `actionsOffset` tracks.
      data-testid="table-scroll-container"
      style={{
        flex: 1,
        minHeight: 0,
        overflowX: 'auto',
        overflowY: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      {/* Header — sits above the List inside the same horizontal scroll
          container so columns stay aligned when the user scrolls right.
          #53 — `role="row"` so its `columnheader` children below are valid.
          It's a DOM sibling of the grid below (sticky positioning needs it
          outside the scrolling/virtualized body), not a descendant, so
          `aria-owns` on the grid (below) is what tells assistive tech this
          is still the grid's first row rather than an orphaned `row`.

          Two residuals, both recorded rather than fixed. ARIA places an
          `aria-owns` target last in accessibility-tree traversal order
          regardless of `aria-rowindex`, so some assistive tech may reach this
          header after the body rows even though it announces as row 1 — the
          sticky-header-must-be-a-sibling constraint leaves no better option.
          And the id is a constant: `TableView` has one call site today
          (`ResultViewer.tsx`), so two instances cannot collide, but a split or
          compare view mounting two would need it made unique. */}
      <div
        id="table-header-row"
        role="row"
        aria-rowindex={1}
        style={{
          display: 'flex',
          background: 'var(--atelier-surface)',
          minWidth: totalWidth,
          flexShrink: 0,
          position: 'sticky',
          top: 0,
          zIndex: 1,
        }}
      >
        {/* Gutter — keeps the header aligned with the body's fixed expand
            column, and hosts the table-level sort note. `columnheader` to
            match its row's required-owned-elements, same as the data
            columns below (#53). */}
        <div
          role="columnheader"
          style={{
            width: GUTTER_WIDTH,
            minWidth: GUTTER_WIDTH,
            flexShrink: 0,
            borderBottom: '1px solid var(--atelier-border)',
            borderRight: '1px solid var(--atelier-border)',
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {sortNote && (
            <span
              role="img"
              aria-label={sortNote.text}
              title={sortNote.text}
              data-testid="table-header-sort-note"
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: sortNote.warn ? 'var(--atelier-warn)' : 'var(--atelier-accent)',
              }}
            >
              {sortNote.glyph}
            </span>
          )}
        </div>
        {columns.map((col) => {
          const w = ownGet(widths, col.field) ?? 160;
          const sortable = !!onSortField && col.kind === 'field';
          const dir = col.kind === 'field' ? ownGet(sortMap, col.field) : undefined;
          const indicator = dir === 1 ? '↑' : dir === -1 ? '↓' : null;
          const label = col.kind === 'field' ? col.field : col.label ?? col.path;
          const headerTitle = sortable
            ? (dir === 1
                ? `Sorted ascending — click for descending`
                : dir === -1
                  ? `Sorted descending — click to clear`
                  : `Click to sort by ${label}`) +
              (multiFieldSort
                ? ' (replaces the whole multi-field sort — edit it in the query bar’s sort field)'
                : '')
            : col.kind === 'computed'
              ? label
              : undefined;
          const labelContent = (
            <>
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </span>
              {indicator && (
                <span
                  aria-label={dir === 1 ? 'sorted ascending' : 'sorted descending'}
                  style={{ fontSize: 10, color: 'var(--atelier-accent)', flexShrink: 0 }}
                >
                  {indicator}
                </span>
              )}
            </>
          );
          return (
            <div
              key={col.field}
              role="columnheader"
              aria-sort={ariaSortFor(sortable, dir)}
              title={headerTitle}
              data-testid={`table-header-${col.field}`}
              style={{
                width: w,
                minWidth: w,
                maxWidth: w,
                borderBottom: '1px solid var(--atelier-border)',
                borderRight: '1px solid var(--atelier-border)',
                // Padding moves onto the <button> below when sortable, so
                // its hit area covers the whole cell edge-to-edge.
                padding: sortable ? 0 : '5px 8px',
                textAlign: 'left',
                fontWeight: 600,
                color: dir ? 'var(--atelier-accent)' : 'var(--atelier-text-muted)',
                fontSize: 11,
                position: 'relative',
                userSelect: 'none',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
                boxSizing: 'border-box',
                cursor: sortable ? 'pointer' : 'default',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              {/* S6848 — the old fix wrapped a plain onClick div around the
                  label + resize handle. Instead, only the label + indicator
                  (the part that actually sorts) becomes a native <button>;
                  the resize handle stays a sibling, never a descendant of
                  the button, since a <div> inside a <button> is an invalid
                  content model. This gets native Enter/Space for free. */}
              {sortable ? (
                <UnstyledButton
                  type="button"
                  onClick={() => onSortField?.(col.field)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '5px 8px',
                    font: 'inherit',
                  }}
                >
                  {labelContent}
                </UnstyledButton>
              ) : (
                labelContent
              )}
              {/* S6848 — a drag-only resize affordance has no discrete
                  "action" to run on Enter/Space the way a button does, so
                  the honest keyboard equivalent is the ARIA "window
                  splitter" pattern: role="separator" + arrow-key resize,
                  reusing the same 60px floor as the mouse drag.

                  This trades S6848 for S6845 ("`tabIndex` should only be
                  declared on interactive elements"), and that second finding
                  is accepted rather than fixed. A focusable `separator` IS
                  interactive — it is the role W3C's APG specifies for exactly
                  this widget, with `tabindex="0"`, `aria-valuenow` and
                  arrow-key resize. S6845's notion of "interactive" is a fixed
                  list that predates the splitter pattern and does not include
                  `separator`. Dropping the `tabIndex` to satisfy it would
                  delete the only keyboard path to resizing a column, which is
                  the opposite of what either rule is for. */}
              <div
                data-resize-handle="1"
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize ${label} column`}
                aria-valuenow={w}
                aria-valuemin={60}
                tabIndex={0}
                onMouseDown={(e) => handleResizeMouseDown(e, col.field)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                  e.preventDefault();
                  e.stopPropagation();
                  const delta = e.key === 'ArrowRight' ? 10 : -10;
                  onColumnResize(col.field, Math.max(60, propWidth(col.field) + delta));
                }}
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 0,
                  bottom: 0,
                  width: 5,
                  cursor: 'col-resize',
                  background: 'transparent',
                }}
              />
            </div>
          );
        })}

        {/* Header cell for the actions column below — same width and the
            same `actionsOffset` transform, so it stays aligned with the
            body's actions column under horizontal scroll. No label: the
            column holds icon-only buttons. */}
        <div
          role="columnheader"
          aria-label="Actions"
          style={{
            width: ACTIONS_WIDTH,
            minWidth: ACTIONS_WIDTH,
            flexShrink: 0,
            transform: `translateX(${actionsOffset}px)`,
            borderBottom: '1px solid var(--atelier-border)',
            borderLeft: '1px solid var(--atelier-border)',
            boxSizing: 'border-box',
            background: 'var(--atelier-surface)',
            zIndex: 1,
          }}
        />
      </div>

      <List<TableRowProps>
        // react-window labels its own container `role="list"`, which is the
        // wrong context for the rows below and leaves them with no valid
        // parent. `grid` is the required one, and `aria-rowcount` is how a
        // virtualized grid reports a total larger than what is mounted (+1
        // for the header row).
        role="grid"
        aria-label="Documents"
        aria-rowcount={documents.length + 1}
        // #53 — the sticky header row lives outside this element in the DOM
        // (see the comment above it), so `aria-owns` is what makes it the
        // grid's first row for assistive tech instead of an orphaned `row`.
        aria-owns="table-header-row"
        // #20 — the grid is the widget's only tab stop; see `roving` above.
        listRef={listRef}
        tabIndex={roving.containerProps.tabIndex}
        aria-activedescendant={roving.containerProps['aria-activedescendant']}
        onFocus={roving.containerProps.onFocus}
        onBlur={roving.containerProps.onBlur}
        onKeyDown={handleGridKeyDown}
        rowComponent={TableRowImpl}
        rowCount={documents.length}
        rowHeight={rowHeight}
        rowProps={rowProps}
        overscanCount={8}
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: totalWidth,
        }}
      />

      {/* Cell-level context menu (doc-aware — Edit/Delete included). */}
      {contextMenu && (
        // S6848 — this div's onClick only stops propagation so a click
        // inside the menu doesn't hit the window-level "click outside
        // closes" listener above; every action lives on the real <button>s
        // inside, already natively keyboard-operable. role="group", not
        // "menu", which would need role="menuitem" on all six children.
        //
        // Escape is not handled on this element itself — it lives on the
        // window, beside the click-outside dismiss, so it fires the same way
        // whether or not this div happens to hold focus right now. A mouse
        // open still never focuses it; a keyboard open does, via
        // `useMenuFocus` (#55/#87) — which is also what returns focus to the
        // grid once the window listener calls `closeContextMenu()`, unless
        // the click that dismissed it landed on another focusable control.
        <div
          ref={cellMenuRef}
          role="group"
          aria-label="Cell actions"
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
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
          {/* Same items and gates as the field-level menu below (`hasValue`
              is its `value !== undefined`, computed alongside `draggable`).
              This menu has no expand-first step, so it's arguably the more
              discoverable of the two surfaces for Add to filter. */}
          {contextMenu.field && (
            <FieldActionsMenu
              fieldPath={contextMenu.field}
              value={contextMenu.value}
              hasValue={contextMenu.hasValue ?? false}
              isReadOnly={meta.isReadOnly}
              filterBarValid={filterBarValid}
              onAddToFilter={handleAddToFilter}
              onClose={closeContextMenu}
            />
          )}
          {contextMenu.field && (
            <div
              style={{
                height: 1,
                background: 'var(--atelier-border)',
                margin: '4px 0',
              }}
            />
          )}
          {/* T2.6 — Duplicate omitted for read-only providers
              (preview/snapshot, ScriptTab's synthetic result provider),
              which either set `meta.isReadOnly` or simply don't wire
              `openDuplicate`. Shared with Tree/JSON's own "More actions"
              menu, which has no field-specific items above it. */}
          <RowActionsMenu
            doc={contextMenu.doc}
            onEdit={onEditDoc}
            onDuplicate={onDuplicateDoc}
            onDelete={onDeleteDoc}
            isReadOnly={meta.isReadOnly}
            onClose={closeContextMenu}
          />
        </div>
      )}

      {/* Field-level context menu — from inside an expanded row's
          DocFieldTree panel. Mirrors TreeView's (Copy value / Copy field
          path only — no Edit/Delete, matching the Tree view's nested-field
          menu). */}
      {fieldContextMenu && (
        // S6848 — same reasoning as the cell-level menu above, Escape
        // included: it is a window listener, not an onKeyDown here.
        <div
          ref={fieldMenuRef}
          role="group"
          aria-label="Field actions"
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: fieldContextMenu.y,
            left: fieldContextMenu.x,
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
            fieldPath={fieldContextMenu.fieldPath}
            value={fieldContextMenu.value}
            hasValue={fieldContextMenu.value !== undefined}
            isReadOnly={meta.isReadOnly}
            filterBarValid={filterBarValid}
            onAddToFilter={handleAddToFilter}
            onClose={closeFieldContextMenu}
          />
        </div>
      )}
    </div>
  );
}
