import React from 'react';
import { valueToClipboardText } from '../../../utils/displayValue';
import { copyToClipboard } from '../../../utils/clipboard';

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

interface FieldActionsMenuProps {
  fieldPath: string;
  value: unknown;
  /** Gates Copy value and Add to filter; Copy field path always renders. */
  hasValue: boolean;
  isReadOnly?: boolean;
  /** Add to filter disables up front when the filter bar's text doesn't parse. */
  filterBarValid: boolean;
  onAddToFilter: (fieldPath: string, value: unknown) => Promise<void>;
  onClose: () => void;
}

/**
 * The field-specific items (Copy value / Copy field path / Add to filter)
 * shared by TableView's cell and field menus and TreeView's field menu. The
 * caller owns the menu container. Each item stops propagation itself so a
 * click never reaches `useMenuFocus`'s window dismiss listener — a no-op
 * where the container already does that, required where it doesn't.
 */
export function FieldActionsMenu({
  fieldPath,
  value,
  hasValue,
  isReadOnly,
  filterBarValid,
  onAddToFilter,
  onClose,
}: FieldActionsMenuProps) {
  return (
    <>
      {hasValue && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            void copyToClipboard(valueToClipboardText(value), 'Value copied to the clipboard.');
            onClose();
          }}
          style={itemStyle}
        >
          Copy value
        </button>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          void copyToClipboard(fieldPath, 'Field name copied to the clipboard.');
          onClose();
        }}
        style={itemStyle}
      >
        Copy field path
      </button>
      {!isReadOnly && hasValue && (
        <button
          disabled={!filterBarValid}
          onClick={(e) => {
            e.stopPropagation();
            void onAddToFilter(fieldPath, value);
            onClose();
          }}
          title={filterBarValid ? undefined : "The filter bar's text isn't valid JSON"}
          style={{
            ...itemStyle,
            cursor: filterBarValid ? 'pointer' : 'not-allowed',
            color: filterBarValid ? 'var(--atelier-text)' : 'var(--atelier-text-muted)',
          }}
        >
          Add to filter
        </button>
      )}
    </>
  );
}
