import React from 'react';
import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { api, getErrorMessage } from '../../api/atelier';
import { invalidateSchemaEnumCache } from '../../features/fieldSuggestions/sources/schemaEnumSource';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { SubmitButton } from '../../components/SubmitButton';

interface RenameCollectionModalProps {
  connectionId: string;
  dbName: string;
  collection: string;
  onCancel: () => void;
  onRenamed: (newName: string) => void;
  /** Supplied when the opener is gone by first render (context menu). */
  returnFocusTo?: HTMLElement | null;
}

/** Same-database rename dialog (T1.1) — the driver only supports renaming
 * within the same database, so there is no target-DB field. */
export function RenameCollectionModal({
  connectionId,
  dbName,
  collection,
  onCancel,
  onRenamed,
  returnFocusTo,
}: RenameCollectionModalProps) {
  const [newName, setNewName] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const trimmed = newName.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== collection;

  // #89 — both paths restore focus to the same `returnFocusTo` (the tree
  // container survives a rename, unlike #74's tabs which had nothing to
  // restore to). Two calls because `useDialogFocusReturn` memoizes on its
  // own `onClose`, so one hook can't serve two different close reasons.
  const close = useDialogFocusReturn(onCancel, returnFocusTo);
  const finish = useDialogFocusReturn(() => onRenamed(trimmed), returnFocusTo);

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.collection.rename({ connectionId, dbName, collection, newName: trimmed });
      // The validator moves with the collection: neither name's cached
      // enum suggestions still hold.
      invalidateSchemaEnumCache(connectionId, dbName, collection);
      invalidateSchemaEnumCache(connectionId, dbName, trimmed);
      finish();
    } catch (err) {
      setError(getErrorMessage(err, 'Rename failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      opened
      onClose={close}
      title={`Rename "${collection}"`}
      centered
      size="md"
      aria-label="Rename collection"
    >
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          {dbName}.{collection} → {dbName}.{trimmed || '…'}
        </Text>
        <TextInput
          aria-label="New name"
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.currentTarget.value)}
          placeholder="new collection name"
          size="xs"
          styles={{
            input: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' },
          }}
        />
        {error && (
          <Alert color="red" variant="light" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" size="compact-xs" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <SubmitButton
            variant="filled"
            size="compact-xs"
            onClick={() => void submit()}
            disabled={!canSubmit}
            submitting={submitting}
          >
            {submitting ? 'Renaming…' : 'Rename'}
          </SubmitButton>
        </Group>
      </Stack>
    </Modal>
  );
}
