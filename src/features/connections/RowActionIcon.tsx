import React from 'react';
import { ActionIcon, Tooltip } from '@mantine/core';

/**
 * A row action icon shared by `ConnectionSwitcher`'s popover rows and
 * `ConnectionExpandedTable`'s table rows — same Tooltip+ActionIcon shape,
 * the same string doing double duty as the tooltip label and the accessible
 * name, and the same stopPropagation guards, because both surfaces nest this
 * inside a row whose own click/keydown handling would otherwise intercept
 * Tab+Enter/click before it reaches the button.
 *
 * Opens on keyboard focus, not just mouse hover, via the app-wide `Tooltip`
 * default in `theme/mantineTheme.ts` — a keyboard-only user tabbing onto one
 * of these buttons needs the same hint a mouse hover gets (e.g. the
 * popover's own legend delegates ⌘↵/⌫ discovery to this tooltip).
 */
export function RowActionIcon({
  label,
  color = 'gray',
  pressed,
  tooltip,
  onClick,
  children,
}: {
  label: string;
  color?: 'gray' | 'red';
  /** Makes this a toggle button; omitted for a plain action. */
  pressed?: boolean;
  /** Hover text when it should differ from the accessible name (a toggle keeps one name). */
  tooltip?: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={tooltip ?? label} withArrow openDelay={400}>
      <ActionIcon
        variant="subtle"
        color={color}
        size="sm"
        aria-label={label}
        aria-pressed={pressed}
        onClick={(e) => {
          e.stopPropagation();
          onClick(e);
        }}
        onKeyDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </ActionIcon>
    </Tooltip>
  );
}
