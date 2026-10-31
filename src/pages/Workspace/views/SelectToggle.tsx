import { ActionIcon, Tooltip } from '@mantine/core';
import { I } from '../../../icons';

interface SelectToggleProps {
  selected: boolean;
  /** Short, human-scannable document id (`getDocId`) folded into the
   * aria-label/title so multiple checkboxes in the same list are
   * distinguishable to assistive tech. */
  docLabel: string;
  onToggle: () => void;
}

/**
 * Per-row selection checkbox shared by Table, Tree and JSON. A plain click
 * on a row/card only makes it the active row now; this (plus ⌘/Ctrl+click)
 * is the one visible way to add a row to the bulk-action selection.
 *
 * `aria-pressed` on a `<button>`, not a real `<input type="checkbox">` — the
 * toggle-button pattern — so it can sit inside a `role="group"`/`"row"`/
 * `"treeitem"` container that already holds other buttons (Copy/Edit/
 * Delete) without becoming a form control nested in one.
 */
export function SelectToggle({ selected, docLabel, onToggle }: SelectToggleProps) {
  const label = `${selected ? 'Deselect' : 'Select'} document ${docLabel}`;
  return (
    <Tooltip label={label} withArrow openDelay={400}>
      <ActionIcon
        type="button"
        variant="default"
        size="sm"
        c={selected ? 'var(--atelier-accent)' : 'var(--atelier-text-ghost)'}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        aria-pressed={selected}
        aria-label={label}
        style={{
          flexShrink: 0,
          ...(selected && {
            background: 'var(--atelier-accent-soft)',
            borderColor: 'var(--atelier-accent-border)',
          }),
        }}
      >
        {I.check}
      </ActionIcon>
    </Tooltip>
  );
}
