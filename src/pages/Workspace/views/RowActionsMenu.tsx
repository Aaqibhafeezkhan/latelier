import React from 'react';
import type { DocMenuState } from './useDocMenu';

/**
 * Shared "More actions" popup content — Edit/Duplicate/Delete for a
 * document. Table's own cell-level context menu renders this below its
 * field-specific items (Copy value / Copy field path / Add to filter);
 * Tree and JSON, which have no per-row context menu at all, render it alone
 * from their own "More actions" button, so a document gets the same
 * Duplicate affordance as Table without a second copy of the item list.
 *
 * Deliberately just the buttons, not the popup's own positioning/dismiss
 * chrome — Table's shell is shared with its field menu, while Tree and JSON
 * use `DocActionsPopup` below with `useDocMenu`'s state.
 */
export interface RowActionsMenuProps {
  doc: unknown;
  onEdit: (doc: unknown) => void;
  /** Omitted for read-only providers, same convention as `openDuplicate`
   * on `CollectionWorkspaceActions`. */
  onDuplicate?: (doc: unknown) => void;
  onDelete: (doc: unknown) => void;
  /** Read-only providers show Edit/Delete anyway (they're no-ops there,
   * matching every other per-row Edit/Delete in the app) but never
   * Duplicate — same gate `TableView`'s own menu already applies. */
  isReadOnly?: boolean;
  /** A view's document can only be looked at: Edit becomes View and the writes go. */
  isView?: boolean;
  onClose: () => void;
}

const itemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '6px 12px',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: 12,
  color: 'var(--atelier-text)',
};

export function RowActionsMenu({
  doc,
  onEdit,
  onDuplicate,
  onDelete,
  isReadOnly,
  isView,
  onClose,
}: RowActionsMenuProps) {
  return (
    <>
      <button
        onClick={() => {
          onEdit(doc);
          onClose();
        }}
        style={itemStyle}
      >
        {isView ? 'View document' : 'Edit'}
      </button>
      {!isReadOnly && !isView && onDuplicate && (
        <button
          onClick={() => {
            onDuplicate(doc);
            onClose();
          }}
          style={itemStyle}
        >
          Duplicate document
        </button>
      )}
      {!isView && (
        <button
          onClick={() => {
            onDelete(doc);
            onClose();
          }}
          style={{ ...itemStyle, color: 'var(--atelier-red)' }}
        >
          Delete
        </button>
      )}
    </>
  );
}

/** The standalone "More actions" popup Tree and JSON open from a row button. */
export function DocActionsPopup({
  menu,
  menuRef,
  ...actions
}: Omit<RowActionsMenuProps, 'doc'> & {
  menu: DocMenuState;
  menuRef: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={menuRef}
      role="group"
      aria-label="Document actions"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: menu.y,
        left: menu.x,
        background: 'var(--atelier-surface)',
        border: '1px solid var(--atelier-border-med)',
        borderRadius: 'var(--atelier-radius-sm)',
        boxShadow: 'var(--atelier-shadow)',
        zIndex: 1000,
        minWidth: 160,
        padding: '4px 0',
      }}
    >
      <RowActionsMenu doc={menu.doc} {...actions} />
    </div>
  );
}
