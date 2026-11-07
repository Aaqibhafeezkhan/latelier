import React from 'react';
import { Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';

/**
 * Shared confirm-before-destroy dialog for a Connection — used by both
 * ConnectionManager's deep list and the Switcher. Extracted rather
 * than duplicated so the two entry points can't drift on copy: content,
 * destructive styling, and the "server data is untouched" reassurance stay
 * one definition.
 *
 * Type-to-confirm (docs/adr/0013): deleting a connection also drops its
 * saved queries, history and (once audited writes land) its audit log via
 * CASCADE — locally unrecoverable, so it sits on the same rung as dropping a
 * collection, not a plain two-button confirm.
 */
export function ConnectionDeleteDialog({ name, count = 1, tabCount, onCancel, onConfirm, returnFocusTo }: {
  name: string;
  /**
   * More than one (the Connections table's checked rows, C13 §8): `name` is
   * then the phrase to type back, and the copy speaks of all of them.
   */
  count?: number;
  /**
   * Spec §4.6 — folded into the existing body rather than a second
   * dialog: "Two dialogs for one action is the thing people click through
   * without reading."
   */
  tabCount: number;
  onCancel: () => void;
  onConfirm: () => void;
  /**
   * Where to send focus on cancel, when the opener knows better than this
   * dialog can. Opened from a row of `ConnectionExpandedTable`, that
   * row is already detached by this component's first render, so the
   * render-time capture inside the hook yields a no-op.
   */
  returnFocusTo?: HTMLElement | null;
}) {
  // Dismiss paths only — `onConfirm` deletes the connection this was opened
  // from, so its trigger is gone by the time focus could go back.
  const close = useDialogFocusReturn(onCancel, returnFocusTo);
  const [typed, setTyped] = React.useState('');
  const matches = typed === name;
  return (
    <Modal
      opened
      onClose={close}
      title={count > 1 ? `Delete ${count} connections?` : `Delete "${name}"?`}
      centered
      size="md"
      role="alertdialog"
    >
      <Stack gap="md">
        <Text size="xs" c="dimmed" lh={1.5}>
          {count > 1
            ? 'This removes these saved connections and all their saved queries and history.'
            : 'This removes the saved connection and all its saved queries and history.'}{' '}
          Mongo data on the server is not touched. This cannot be undone.
          {tabCount > 0
            ? ` It also closes ${tabCount} open tab${tabCount === 1 ? '' : 's'}.`
            : ''}
        </Text>
        <Stack gap="var(--atelier-gap-xs)">
          <Text size="xs" c="dimmed">
            {count > 1 ? <>Type <b>{name}</b> to confirm:</> : 'Type the connection name to confirm:'}
          </Text>
          <TextInput
            aria-label={count > 1 ? 'Confirm deletion' : 'Confirm connection name'}
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
            size="xs"
            styles={{
              input: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' },
            }}
          />
        </Stack>
        <Group justify="flex-end" gap="xs">
          <Button size="compact-xs" variant="subtle" onClick={close}>Cancel</Button>
          <Button size="compact-xs" variant="filled" color="red" onClick={onConfirm} disabled={!matches}>
            Delete
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
