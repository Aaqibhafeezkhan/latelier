import React from 'react';
import { Alert, Button, Group, Modal, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { api, getErrorMessage } from '../../api/atelier';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { confirmDestructive } from '../../utils/confirm';
import { ejsonParse, ejsonStringifyReadable } from '../../utils/ejson';
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
 * Escape reaches the dialog's close path instead of a completion popup. Every
 * close path asks before discarding an edit, and none closes mid-save.
 */
export function ModifyViewModal({ connectionId, dbName, collection, onClose, onSaved, returnFocusTo }: Props) {
  const [viewOn, setViewOn] = React.useState('');
  const [pipeline, setPipeline] = React.useState('');
  // What was loaded, so an edit is told apart from the prefill.
  const [initial, setInitial] = React.useState<{ viewOn: string; pipeline: string } | null>(null);
  const loaded = initial !== null;
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
        const next = {
          viewOn: d.options.viewOn ?? '',
          pipeline: ejsonStringifyReadable(ejsonParse(d.options.pipeline ?? '[]'), 2),
        };
        setViewOn(next.viewOn);
        setPipeline(next.pipeline);
        setInitial(next);
      })
      .catch((e: unknown) => {
        if (live) setError(getErrorMessage(e, 'Could not read the view'));
      });
    return () => {
      live = false;
    };
  }, [connectionId, dbName, collection]);

  const requestClose = async () => {
    // A close mid-save would drop the refresh the save's completion triggers.
    if (submitting) return;
    const dirty = initial !== null && (viewOn !== initial.viewOn || pipeline !== initial.pipeline);
    if (!dirty) return close();
    const discard = await confirmDestructive({
      title: 'Discard changes?',
      body: 'This closes the dialog and loses what you typed.',
      confirmLabel: 'Discard',
    });
    if (discard) close();
  };

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
    <Modal
      opened
      onClose={() => void requestClose()}
      title={`Modify view "${collection}"`}
      centered
      size="lg"
    >
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
          <Button variant="subtle" size="compact-xs" onClick={() => void requestClose()}>
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
