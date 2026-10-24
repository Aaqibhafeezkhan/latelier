import React from 'react';
import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { api, getErrorMessage } from '../../api/atelier';
import { invalidateSchemaEnumCache } from '../../features/fieldSuggestions/sources/schemaEnumSource';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { SubmitButton } from '../../components/SubmitButton';

interface DropDatabaseConfirmProps {
  connectionId: string;
  dbName: string;
  /** Disables the confirm button outright when the connection is read-only. */
  readOnly?: boolean;
  onCancel: () => void;
  onDropped: () => void;
  /** Supplied when the opener is gone by first render (context menu). */
  returnFocusTo?: HTMLElement | null;
}

/**
 * Type-to-confirm drop dialog for an entire database (T1.1). Drops every
 * collection in `dbName` via `database:drop`. Confirm stays disabled until
 * the typed text exactly matches the database name.
 */
export function DropDatabaseConfirm({
  connectionId,
  dbName,
  readOnly = false,
  onCancel,
  onDropped,
  returnFocusTo,
}: DropDatabaseConfirmProps) {
  // #89 — both paths restore focus to the same `returnFocusTo` (the tree
  // container survives a drop, unlike #74's tabs which had nothing to
  // restore to). Two calls because `useDialogFocusReturn` memoizes on its
  // own `onClose`, so one hook can't serve two different close reasons.
  const close = useDialogFocusReturn(onCancel, returnFocusTo);
  const finish = useDialogFocusReturn(onDropped, returnFocusTo);
  const [typed, setTyped] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const matches = typed === dbName;

  const submit = async () => {
    if (!matches || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.database.drop({ connectionId, dbName });
      // The cache has no per-database scope, so the whole Connection's enum
      // suggestions go with the database's collections.
      invalidateSchemaEnumCache(connectionId);
      finish();
    } catch (err) {
      setError(getErrorMessage(err, 'Drop failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      opened
      onClose={close}
      title={`Drop database "${dbName}"?`}
      centered
      size="md"
      aria-label="Drop database"
    >
      <Stack gap="sm">
        <Text size="xs" c="dimmed" lh={1.5}>
          This permanently deletes every collection in this database. This cannot be undone.
        </Text>
        <Stack gap={6}>
          <Text size="xs" c="dimmed">
            Type the database name to confirm:
          </Text>
          <TextInput
            aria-label="Confirm database name"
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
            size="xs"
            styles={{
              input: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' },
            }}
          />
        </Stack>
        {readOnly && (
          <Alert color="yellow" variant="light" role="alert">
            This connection is read-only. Dropping is disabled.
          </Alert>
        )}
        {error && (
          <Alert color="red" variant="light" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" size="compact-xs" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <SubmitButton variant="filled" color="red" size="compact-xs" onClick={() => void submit()} disabled={!matches || readOnly} submitting={submitting}>
            {submitting ? 'Dropping…' : 'Drop database'}
          </SubmitButton>
        </Group>
      </Stack>
    </Modal>
  );
}
