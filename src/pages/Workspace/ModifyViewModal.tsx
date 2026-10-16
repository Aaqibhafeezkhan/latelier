import React from 'react';
import { Alert, Button, Group, Modal, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { api, getErrorMessage } from '../../api/atelier';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { SubmitButton } from '../../components/SubmitButton';

interface Props {
  connectionId: string;
  dbName: string;
  /** The view being edited. */
  collection: string;
  onClose: () => void;
  onSaved: () => void;
  /** Supplied when the opener is gone by first render (context menu). */
  returnFocusTo?: HTMLElement | null;
}

/**
 * Edits a view's source collection and pipeline in place (`collMod`). A plain
 * textarea rather than the script editor, so it keeps its resize handle and
 * Escape closes the dialog.
 */
export function ModifyViewModal({ connectionId, dbName, collection, onClose, onSaved, returnFocusTo }: Props) {
  const [viewOn, setViewOn] = React.useState('');
  const [pipeline, setPipeline] = React.useState('');
  const [loaded, setLoaded] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const close = useDialogFocusReturn(onClose, returnFocusTo);
  const finish = useDialogFocusReturn(onSaved, returnFocusTo);

  React.useEffect(() => {
    let live = true;
    api.meta
      .collectionDetails({ connectionId, dbName, collection })
      .then((d) => {
        if (!live) return;
        setViewOn(d.options.viewOn ?? '');
        setPipeline(JSON.stringify(JSON.parse(d.options.pipeline ?? '[]'), null, 2));
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (live) setError(getErrorMessage(e, 'Could not read the view'));
      });
    return () => {
      live = false;
    };
  }, [connectionId, dbName, collection]);

  const submit = async () => {
    if (!loaded || submitting) return;
    if (!isJsonArray(pipeline)) {
      setError('The pipeline must be a JSON array of stages.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.collection.modify({ connectionId, dbName, collection, options: { viewOn: viewOn.trim(), pipeline } });
      finish();
    } catch (e) {
      setError(getErrorMessage(e, 'Could not modify the view'));
    } finally {
      setSubmitting(false);
    }
  };

  const mono = { input: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' } };

  return (
    <Modal opened onClose={close} title={`Modify view "${collection}"`} centered size="lg">
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          {dbName}.{collection}
        </Text>
        <TextInput
          label="Source collection"
          value={viewOn}
          onChange={(e) => setViewOn(e.currentTarget.value)}
          disabled={!loaded}
          size="xs"
          styles={mono}
        />
        <Textarea
          label="Pipeline"
          value={pipeline}
          onChange={(e) => setPipeline(e.currentTarget.value)}
          disabled={!loaded}
          rows={14}
          resize="vertical"
          size="xs"
          styles={mono}
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
            disabled={!loaded || viewOn.trim() === ''}
            submitting={submitting}
          >
            Save
          </SubmitButton>
        </Group>
      </Stack>
    </Modal>
  );
}

function isJsonArray(text: string): boolean {
  try {
    return Array.isArray(JSON.parse(text));
  } catch {
    return false;
  }
}
