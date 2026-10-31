import React from 'react';
import { ActionIcon, Popover, VisuallyHidden } from '@mantine/core';

interface FullValuePopoverProps {
  /** The value's display text, untruncated. */
  display: string;
  /** Strings are shown quoted, so `"1"` and `1` stay distinguishable. */
  isString: boolean;
  opened: boolean;
  onChange: (opened: boolean) => void;
  /** Hover/focus-revealed: the trigger is always mounted, but invisible and
   * click-through until the host says it should show. */
  visible: boolean;
  ariaLabel?: string;
  /** `-1` keeps the trigger out of Tab order where the host already opens
   * the popover from the keyboard (Enter on the active Tree leaf). */
  tabIndex?: number;
  /** Move focus into the dropdown when it mounts, so a keyboard user (and a
   * screen reader) lands on the value. Escape handling stays the host's. */
  focusOnOpen?: boolean;
}

/**
 * The `⤢` affordance that opens a read-only popover with a value's full,
 * untruncated text. Shared by Table cells and Tree/expanded-row leaves. The
 * trigger is absolutely positioned at the right edge of its host, which must
 * be `position: relative`. Its own `stopPropagation` keeps a click from also
 * selecting, expanding or activating the row underneath.
 */
export function FullValuePopover({
  display,
  isString,
  opened,
  onChange,
  visible,
  ariaLabel = 'Expand cell value',
  tabIndex,
  focusOnOpen = false,
}: FullValuePopoverProps) {
  const labelId = React.useId();
  // A stable callback ref runs once per mount of the dropdown, which the
  // popover's transition renders a commit or more after `opened` flips.
  const focusDropdown = React.useCallback(
    (el: HTMLDivElement | null) => {
      if (el && focusOnOpen) el.focus();
    },
    [focusOnOpen],
  );
  return (
    <Popover
      opened={opened}
      onChange={onChange}
      position="bottom-start"
      withinPortal
      shadow="md"
      // Without this, closing on a click outside a focusable element drops
      // focus to <body>. Safe here because the dropdown has no focusable
      // content to autofocus (see `FieldsControl`'s comment for why an
      // autofocus would break this).
      returnFocus
    >
      <Popover.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={16}
          c="var(--atelier-text-ghost)"
          aria-label={ariaLabel}
          tabIndex={tabIndex}
          onClick={(e) => {
            e.stopPropagation();
            onChange(true);
          }}
          style={{
            position: 'absolute',
            right: 2,
            top: '50%',
            transform: 'translateY(-50%)',
            opacity: visible ? 1 : 0,
            pointerEvents: visible ? 'auto' : 'none',
            borderRadius: 3,
            background: 'var(--atelier-surface-raised)',
            fontSize: 10,
            lineHeight: '16px',
          }}
        >
          ⤢
        </ActionIcon>
      </Popover.Target>
      {/* Named "Full value" rather than after its trigger: Mantine labels the
          dialog by the trigger's id by default, and the trigger's name is an
          action ("Expand cell value"), not what the dialog holds. */}
      <Popover.Dropdown ref={focusDropdown} aria-labelledby={labelId}>
        <VisuallyHidden id={labelId}>Full value</VisuallyHidden>
        <div
          style={{
            maxWidth: 320,
            maxHeight: 240,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            color: 'var(--atelier-text)',
          }}
        >
          {isString ? `"${display}"` : display}
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
