import { ActionIcon, Tooltip } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';

interface SelectToggleProps {
  selected: boolean;
  /** Short, human-scannable document id (`getDocId`) folded into the
   * aria-label/title so multiple checkboxes in the same list are
   * distinguishable to assistive tech. */
  docLabel: string;
  onToggle: () => void;
  /** `-1` takes the button out of the Tab order while keeping it clickable. */
  tabIndex?: number;
}

/**
 * Per-row selection checkbox shared by Table, Tree and JSON. A plain click
 * on a row/card only makes it the active row now; this (plus ⌘/Ctrl+click)
 * is the one visible way to add a row to the bulk-action selection. An
 * unselected box is empty (a ghost-coloured check read as already checked).
 *
 * `aria-pressed` on a `<button>`, not a real `<input type="checkbox">` — the
 * toggle-button pattern — so it can sit inside a `role="group"`/`"row"`/
 * `"treeitem"` container that already holds other buttons (Copy/Edit/
 * Delete) without becoming a form control nested in one.
 */
export function SelectToggle({ selected, docLabel, onToggle, tabIndex }: SelectToggleProps) {
  const label = `${selected ? 'Deselect' : 'Select'} document ${docLabel}`;
  return (
    <Tooltip label={label} withArrow openDelay={400}>
      <ActionIcon
        type="button"
        tabIndex={tabIndex}
        variant="default"
        size={16}
        radius={4}
        c="var(--atelier-accent-text)"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        aria-pressed={selected}
        aria-label={label}
        style={{
          flexShrink: 0,
          minWidth: 16,
          minHeight: 16,
          borderWidth: 1.5,
          // Drawn as a checkbox, not a button: no fill while off, solid accent while on.
          ...(selected
            ? { background: 'var(--atelier-accent)', borderColor: 'var(--atelier-accent)' }
            : { background: 'transparent', borderColor: 'var(--atelier-text-ghost)' }),
        }}
      >
        {selected ? <IconCheck size={12} stroke={3} /> : null}
      </ActionIcon>
    </Tooltip>
  );
}
