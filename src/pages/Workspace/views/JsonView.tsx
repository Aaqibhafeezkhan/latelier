import React from 'react';
import { ActionIcon, Tooltip } from '@mantine/core';
import {
  List,
  useDynamicRowHeight,
  useListRef,
  type RowComponentProps,
} from 'react-window';
import { I } from '../../../icons';
import { ejsonStringify } from '../../../utils/ejson';
import { docKey, isRecord } from '../../../utils/displayValue';
import { tokenizeJson, type Token, type TokenKind } from '../../../utils/jsonHighlight';
import { copyToClipboard } from '../../../utils/clipboard';
import { anchorForRow, anchorFromRect, isContextMenuKey, isEditKey } from '../../../utils/contextMenuKey';
import { useRovingFocus } from '../../../hooks/useRovingFocus';
import { useCollectionWorkspace } from '../context';
import { useResultSelection } from '../resultSelection';
import { getDocId } from './docId';
import { SelectToggle } from './SelectToggle';
import { DocActionsPopup } from './RowActionsMenu';
import { useDocMenu } from './useDocMenu';

interface JsonViewProps {
  documents: unknown[];
}

/**
 * Strip the Fields control's hidden top-level fields from a document before
 * it is serialized for display. Rendering-only: every action on the
 * document (Copy, Edit, Delete/Select) is handed the original `doc`, never
 * this redacted copy — hiding a field must never change what gets sent to
 * Mongo or the clipboard. Only top-level paths are handled, matching what
 * `columnConfig.hidden` (Table's Fields control) currently stores.
 */
function redactHidden(doc: unknown, hidden: Set<string>): unknown {
  if (hidden.size === 0 || !isRecord(doc)) return doc;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!hidden.has(key)) out[key] = value;
  }
  return out;
}

function tokenColor(kind: TokenKind): string {
  switch (kind) {
    case 'key':     return 'var(--atelier-accent)';
    case 'string':  return '#2e7d32';
    case 'number':  return 'var(--atelier-color-number)';
    case 'boolean': return '#e65100';
    case 'null':    return 'var(--atelier-text-ghost)';
    case 'punct':   return 'var(--atelier-text-muted)';
    default:        return 'var(--atelier-text)';
  }
}

function tokenWeight(kind: TokenKind): React.CSSProperties['fontWeight'] {
  return kind === 'key' ? 600 : undefined;
}

// A node in the bracket-nesting tree over the flat token stream: either a
// single token, or a `{`/`[` ... `}`/`]` group holding its inner tokens as
// children (recursively, for nested groups). Building this tree is what lets
// a group collapse to a one-line summary without re-deriving JSON
// serialization — the existing tokenizer already did the formatting work.
type JsonNode =
  | { kind: 'leaf'; token: Token }
  | { kind: 'group'; id: number; open: Token; close: Token; children: JsonNode[]; entries: number };

function buildJsonTree(tokens: Token[]): JsonNode[] {
  let i = 0;
  let nextId = 0;
  function parseNodes(): JsonNode[] {
    const nodes: JsonNode[] = [];
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (t.text === '}' || t.text === ']') break;
      if (t.text === '{' || t.text === '[') {
        const open = t;
        i++;
        const children = parseNodes();
        const close = tokens[i]!;
        i++;
        let commas = 0;
        let hasContent = false;
        for (const c of children) {
          if (c.kind === 'leaf') {
            if (c.token.text === ',') commas++;
            else if (!(c.token.kind === 'punct' && /^\s*$/u.test(c.token.text))) hasContent = true;
          } else {
            hasContent = true;
          }
        }
        nodes.push({ kind: 'group', id: nextId++, open, close, children, entries: hasContent ? commas + 1 : 0 });
        continue;
      }
      nodes.push({ kind: 'leaf', token: t });
      i++;
    }
    return nodes;
  }
  return parseNodes();
}

function JsonToken({ token }: { token: Token }) {
  return (
    <span style={{ color: tokenColor(token.kind), fontWeight: tokenWeight(token.kind) }}>
      {token.text}
    </span>
  );
}

function JsonTreeNodes({
  nodes,
  docKey,
  collapsedKeys,
  onToggle,
}: {
  nodes: JsonNode[];
  docKey: string;
  collapsedKeys: Set<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <>
      {nodes.map((node, i) => {
        if (node.kind === 'leaf') return <JsonToken key={i} token={node.token} />;
        const nodeKey = `${docKey}:${node.id}`;
        const collapsed = collapsedKeys.has(nodeKey);
        const toggle = (e: React.SyntheticEvent) => {
          e.stopPropagation();
          onToggle(nodeKey);
        };
        return (
          <React.Fragment key={i}>
            <span
              role="button"
              tabIndex={0}
              onClick={toggle}
              onKeyDown={(e) => {
                // ⌘/Ctrl+Enter is Run (PanelBody's handler), not a toggle.
                if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === ' ') {
                  e.preventDefault();
                  toggle(e);
                }
              }}
              aria-label={collapsed ? 'Expand' : 'Collapse'}
              style={{ cursor: 'pointer' }}
            >
              <JsonToken token={node.open} />
              {collapsed && node.entries > 0 && (
                <span style={{ color: 'var(--atelier-text-ghost)', fontStyle: 'italic' }}>
                  {` …${node.entries} `}
                </span>
              )}
            </span>
            {!collapsed && (
              <JsonTreeNodes
                nodes={node.children}
                docKey={docKey}
                collapsedKeys={collapsedKeys}
                onToggle={onToggle}
              />
            )}
            <JsonToken token={node.close} />
          </React.Fragment>
        );
      })}
    </>
  );
}

// Collapse state is keyed by `${docKey}:${nodeId}` and owned by the caller
// (not local state here) so it survives a react-window row unmounting on
// scroll, and so a refreshed document at the same row index doesn't inherit
// another document's collapsed nodes.
export function HighlightedJson({
  json,
  docKey,
  collapsedKeys,
  onToggle,
}: {
  json: string;
  docKey: string;
  collapsedKeys: Set<string>;
  onToggle: (key: string) => void;
}) {
  const tree = React.useMemo(() => buildJsonTree(tokenizeJson(json)), [json]);

  return (
    <pre
      style={{
        margin: 0,
        fontFamily: 'monospace',
        fontSize: 11,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        color: 'var(--atelier-text)',
      }}
    >
      <JsonTreeNodes nodes={tree} docKey={docKey} collapsedKeys={collapsedKeys} onToggle={onToggle} />
    </pre>
  );
}

interface DocCardProps {
  doc: unknown;
  idx: number;
  isSelected: boolean;
  isCopied: boolean;
  // The row the list's roving focus names while the list has focus — a
  // different channel from selection, so a card can be either or both.
  isActive: boolean;
  rowId: string;
  onActivate: (idx: number) => void;
  collapsedKeys: Set<string>;
  hiddenFields: Set<string>;
  onToggleCollapse: (key: string) => void;
  onToggle: (idx: number) => void;
  onCopy: (doc: unknown, idx: number) => void;
  onEdit: (doc: unknown) => void;
  onDelete: (doc: unknown) => void;
  // Opens the shared `RowActionsMenu` (Duplicate — Edit/Delete already have
  // their own always-visible buttons on this card).
  onOpenRowMenu: (
    doc: unknown,
    anchor: { x: number; y: number },
    focus?: { returnFocusTo?: HTMLElement | null; focusMenuOnOpen?: boolean },
  ) => void;
}

function DocCard({
  doc,
  idx,
  isSelected,
  isCopied,
  isActive,
  rowId,
  onActivate,
  collapsedKeys,
  hiddenFields,
  onToggleCollapse,
  onToggle,
  onCopy,
  onEdit,
  onDelete,
  onOpenRowMenu,
}: DocCardProps) {
  const json = React.useMemo(() => {
    const visible = redactHidden(doc, hiddenFields);
    try {
      return ejsonStringify(visible, 2);
    } catch {
      return JSON.stringify(visible, null, 2);
    }
  }, [doc, hiddenFields]);

  // A plain click makes this the active card, so the next Arrow key moves
  // on from it. It does not touch selection — toggling on a plain click
  // surprised anyone who'd learned Table or Tree first. ⌘/Ctrl+click still
  // toggles it, matching the other two views; the visible checkbox below is
  // the plain-click-free way in.
  const handleCardClick = (e: React.MouseEvent) => {
    onActivate(idx);
    if (e.metaKey || e.ctrlKey) onToggle(idx);
  };

  return (
    <div
      onClick={handleCardClick}
      // `E` with one of this card's own buttons focused edits this card. `E`
      // on the list itself (the active card) is the list's handler; a key
      // typed on a button inside never reaches that one's own-target guard.
      // Only buttons live inside, so no typing reaches it.
      onKeyDown={(e) => {
        if (!isEditKey(e)) return;
        e.preventDefault();
        onEdit(doc);
      }}
      // `treeitem` of the list's `tree`, as Tree view rows are. Not `button`:
      // that role is "children presentational" in ARIA, and this card holds
      // real <button>s (the corner actions, and the JSON body's collapse
      // toggles), which axe's nested-interactive forbids inside one. No
      // Tab stop: `tabIndex={-1}` keeps the card out of the tab order (the
      // list owns the single stop and `aria-activedescendant`) but lets a
      // click focus it, so `onFocus` hands that focus straight to the list;
      // otherwise the next Arrow key would target the card and the list's
      // own-target guard would swallow it.
      id={rowId}
      role="treeitem"
      tabIndex={-1}
      onFocus={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.closest<HTMLElement>('[role="tree"]')?.focus();
      }}
      aria-label={`Document ${idx + 1}`}
      style={{
        border: `1px solid ${isSelected ? 'var(--atelier-accent-border)' : 'var(--atelier-border)'}`,
        borderRadius: 'var(--atelier-radius-sm)',
        background: isSelected ? 'var(--atelier-accent-soft)' : 'var(--atelier-surface-raised)',
        padding: '8px 10px',
        cursor: 'default',
        position: 'relative',
        outline: isActive ? '2px solid var(--atelier-accent)' : undefined,
        outlineOffset: isActive ? '-2px' : undefined,
      }}
    >
      <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 4 }}>
        <SelectToggle selected={isSelected} docLabel={getDocId(doc)} onToggle={() => onToggle(idx)} />
        <Tooltip label="Copy JSON" withArrow openDelay={400}>
          <ActionIcon
            variant="default"
            size="sm"
            c={isCopied ? 'var(--atelier-accent)' : 'var(--atelier-text-muted)'}
            onClick={(e) => {
              e.stopPropagation();
              onCopy(doc, idx);
            }}
            aria-label={`Copy JSON for document ${getDocId(doc)}`}
          >
            {isCopied ? I.check : I.copy}
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Edit" withArrow openDelay={400}>
          <ActionIcon
            variant="default"
            size="sm"
            c="var(--atelier-text-muted)"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(doc);
            }}
            aria-label={`Edit document ${getDocId(doc)}`}
          >
            {I.edit}
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Delete" withArrow openDelay={400}>
          <ActionIcon
            variant="default"
            size="sm"
            c="var(--atelier-red)"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(doc);
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
      <HighlightedJson
        json={json}
        docKey={docKey(doc, idx)}
        collapsedKeys={collapsedKeys}
        onToggle={onToggleCollapse}
      />
    </div>
  );
}

const MemoDocCard = React.memo(DocCard);

interface JsonRowProps {
  documents: unknown[];
  selectedIndices: Set<number>;
  copiedIdx: number | null;
  /** Roving `highlightIndex`: `-1` while the list doesn't have focus. */
  activeIndex: number;
  rowId: (index: number) => string;
  setActiveIndex: (index: number) => void;
  collapsedKeys: Set<string>;
  hiddenFields: Set<string>;
  onToggleCollapse: (key: string) => void;
  onToggle: (idx: number) => void;
  onCopy: (doc: unknown, idx: number) => void;
  onEdit: (doc: unknown) => void;
  onDelete: (doc: unknown) => void;
  onOpenRowMenu: DocCardProps['onOpenRowMenu'];
}

function JsonRow({
  index,
  style,
  documents,
  selectedIndices,
  copiedIdx,
  activeIndex,
  rowId,
  setActiveIndex,
  collapsedKeys,
  hiddenFields,
  onToggleCollapse,
  onToggle,
  onCopy,
  onEdit,
  onDelete,
  onOpenRowMenu,
}: RowComponentProps<JsonRowProps>) {
  const doc = documents[index];
  return (
    <div style={{ ...style, paddingBottom: 8 }} data-doc-key={docKey(doc, index)}>
      <MemoDocCard
        doc={doc}
        idx={index}
        isSelected={selectedIndices.has(index)}
        isCopied={copiedIdx === index}
        isActive={index === activeIndex}
        rowId={rowId(index)}
        onActivate={setActiveIndex}
        collapsedKeys={collapsedKeys}
        hiddenFields={hiddenFields}
        onToggleCollapse={onToggleCollapse}
        onToggle={onToggle}
        onCopy={onCopy}
        onEdit={onEdit}
        onDelete={onDelete}
        onOpenRowMenu={onOpenRowMenu}
      />
    </div>
  );
}

export function JsonView({ documents }: JsonViewProps) {
  const { state, actions, meta } = useCollectionWorkspace();
  const onEditDoc = actions.openEdit;
  const onDeleteDoc = actions.openDelete;
  const onDuplicateDoc = actions.openDuplicate;
  // Fields control: same top-level `columnConfig.hidden` Table already
  // reads (`tableColumns.ts`'s `resolveColumns`) — display-only, so Copy/Edit/
  // Delete below always act on the untouched `doc`, never this set.
  const hiddenFields = React.useMemo(
    () => new Set(state.columnConfig?.hidden ?? []),
    [state.columnConfig?.hidden],
  );
  // T0.4 — selection lifted to the shared cross-view context (index-based,
  // scoped to the enclosing <ResultViewer>); falls back to local state when
  // rendered standalone (no provider mounted).
  const selection = useResultSelection(documents);
  const selectedIndices = selection.indices;
  const toggleSelect = selection.toggle;
  const [copiedIdx, setCopiedIdx] = React.useState<number | null>(null);
  const [collapsedKeys, setCollapsedKeys] = React.useState<Set<string>>(() => new Set());
  // Collapse keys are `${docKey}:${node.id}`, where node.id is assigned in
  // token order over the *redacted* JSON — hiding or showing a field shifts
  // every id after it, so a stale collapsedKeys set would collapse the wrong
  // subtree. Reset rather than try to remap ids across a hidden-fields
  // change. "Adjust state during render" pattern (see TreeView's
  // prevDocuments reset), not a useEffect, to avoid a cascading render cycle.
  const [prevHiddenFields, setPrevHiddenFields] = React.useState(hiddenFields);
  if (prevHiddenFields !== hiddenFields) {
    setPrevHiddenFields(hiddenFields);
    setCollapsedKeys(new Set());
  }
  const toggleCollapse = React.useCallback((key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const copyDoc = React.useCallback((doc: unknown, idx: number) => {
    const text = ejsonStringify(doc, 2);
    // The badge is the success feedback, so it waits for the write to
    // resolve. A failure toasts and leaves no badge behind.
    void copyToClipboard(text).then((ok) => {
      if (!ok) return;
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1200);
    });
  }, []);

  // "More actions" per-card menu — Duplicate only, since Edit/Delete already
  // have their own always-visible buttons on the card.
  const { docMenu, docMenuRef, openDocMenu: handleOpenRowMenu, closeDocMenu } = useDocMenu();

  // Cards are variable-height (driven by the doc's serialized size). The
  // estimate is intentionally generous; useDynamicRowHeight refines on render.
  const rowHeight = useDynamicRowHeight({ defaultRowHeight: 180 });

  // The list is the widget's single tab stop, wired like TreeView's: the
  // scroll has to happen in the same handler that moves the index, so the
  // row `aria-activedescendant` names is mounted.
  const listRef = useListRef(null);
  const roving = useRovingFocus({
    count: documents.length,
    idPrefix: 'json-row-',
    resetKey: documents,
    scrollToIndex: (i) => listRef.current?.scrollToRow({ index: i, align: 'auto' }),
  });
  const handleListKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      roving.onKeyDown(e);
      if (e.defaultPrevented) return;
      // A key bubbling up from a card's own button is that button's.
      if (e.target !== e.currentTarget) return;
      if (documents.length === 0) return;
      const doc = documents[roving.activeIndex];
      if (isContextMenuKey(e)) {
        e.preventDefault();
        // The active card may have been scrolled out and unmounted: open
        // anyway, anchored to the list, and bring the card back.
        const rowEl = document.getElementById(roving.rowId(roving.activeIndex));
        const anchor = anchorForRow(rowEl, listRef.current?.element ?? null);
        if (!anchor) return;
        if (!rowEl) listRef.current?.scrollToRow({ index: roving.activeIndex, align: 'auto' });
        handleOpenRowMenu(doc, anchor, {
          returnFocusTo: listRef.current?.element ?? null,
          focusMenuOnOpen: true,
        });
        return;
      }
      if (isEditKey(e)) {
        e.preventDefault();
        onEditDoc(doc);
        return;
      }
      // Enter and Space only (re)name the active card, which a card has
      // nothing to expand. Space would otherwise page-scroll the list.
      if (e.key === ' ') e.preventDefault();
    },
    // `roving` itself is a fresh object every render; depend on the members
    // this actually reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roving.onKeyDown, roving.activeIndex, roving.rowId, documents, listRef, handleOpenRowMenu, onEditDoc],
  );

  // Memoize so react-window receives a stable rowProps reference. A fresh
  // object literal on every render would force all visible rows to re-render
  // even when nothing they depend on changed (TableView does this too).
  const rowProps = React.useMemo<JsonRowProps>(
    () => ({
      documents,
      selectedIndices,
      copiedIdx,
      activeIndex: roving.highlightIndex,
      rowId: roving.rowId,
      setActiveIndex: roving.setActiveIndex,
      collapsedKeys,
      hiddenFields,
      onToggleCollapse: toggleCollapse,
      onToggle: toggleSelect,
      onCopy: copyDoc,
      onEdit: onEditDoc,
      onDelete: onDeleteDoc,
      onOpenRowMenu: handleOpenRowMenu,
    }),
    [
      documents,
      selectedIndices,
      copiedIdx,
      roving.highlightIndex,
      roving.rowId,
      roving.setActiveIndex,
      collapsedKeys,
      hiddenFields,
      toggleCollapse,
      toggleSelect,
      copyDoc,
      onEditDoc,
      onDeleteDoc,
      handleOpenRowMenu,
    ],
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {hiddenFields.size > 0 && (
        <div
          style={{
            padding: '4px 12px 0',
            fontSize: 11,
            color: 'var(--atelier-text-muted)',
          }}
        >
          {hiddenFields.size === 1 ? '1 field hidden' : `${hiddenFields.size} fields hidden`}
        </div>
      )}
      <List<JsonRowProps>
        // react-window labels its container `role="list"`, which would leave
        // the `treeitem` cards with no valid parent (aria-required-parent).
        role="tree"
        aria-label="Documents"
        listRef={listRef}
        tabIndex={roving.containerProps.tabIndex}
        aria-activedescendant={roving.containerProps['aria-activedescendant']}
        onFocus={roving.containerProps.onFocus}
        onBlur={roving.containerProps.onBlur}
        onKeyDown={handleListKeyDown}
        rowComponent={JsonRow}
        rowCount={documents.length}
        rowHeight={rowHeight}
        rowProps={rowProps}
        overscanCount={4}
        style={{
          flex: 1,
          minHeight: 0,
          padding: '8px 12px',
        }}
      />
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
    </div>
  );
}
