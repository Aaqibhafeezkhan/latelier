import React from 'react';
import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { api, getErrorMessage } from '../../../api/atelier';
import { confirmDestructive } from '../../../utils/confirm';
import { useDialogFocusReturn } from '../../../hooks/useDialogFocusReturn';
import { SubmitButton } from '../../../components/SubmitButton';
import type { Stage } from '@shared/types';
import { isWriteStage, stagesToPipelineJson } from './pipeline';

interface Props {
  connectionId: string;
  dbName: string;
  collection: string;
  /** The builder's stages; required unless `pipelineJson` is given. */
  stages?: Stage[];
  /** A ready EJSON pipeline used verbatim (Duplicate view); skips the stage checks. */
  pipelineJson?: string;
  /** Seeds the name field; closing with the seed untouched needs no confirm. */
  initialName?: string;
  /** EJSON collation sent with the create (Duplicate view keeps the source view's). */
  collation?: string;
  title?: string;
  /** Replaces the help line under the title when the default wording does not fit. */
  description?: string;
  onClose: () => void;
  onCreated: (name: string) => void;
}

/**
 * Saves the builder's enabled stages as a view on the open collection. A view
 * must live in its source's database, so the only field is the name.
 */
export function SaveAsViewModal({
  connectionId,
  dbName,
  collection,
  stages,
  pipelineJson,
  initialName,
  collation,
  title = 'Save pipeline as view',
  description,
  onClose,
  onCreated,
}: Props) {
  if (stages === undefined && pipelineJson === undefined) {
    throw new Error('SaveAsViewModal needs either stages or pipelineJson');
  }
  const [name, setName] = React.useState(initialName ?? '');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const close = useDialogFocusReturn(onClose);
  const trimmed = name.trim();

  const requestClose = async () => {
    // A close mid-create lets the dialog be reopened with a new draft, which
    // the create's completion would then close.
    if (submitting) return;
    if (name === (initialName ?? '')) return close();
    const discard = await confirmDestructive({
      title: 'Discard changes?',
      body: 'This closes the dialog and loses what you typed.',
      confirmLabel: 'Discard',
    });
    if (discard) close();
  };

  const submit = async () => {
    if (!trimmed || submitting) return;
    let pipeline: string;
    if (pipelineJson !== undefined) {
      pipeline = pipelineJson;
    } else {
      // A view only reads, so a write stage is refused here rather than by the server.
      const writer = (stages ?? []).find((s) => s.enabled && isWriteStage(s.op));
      if (writer) {
        setError(`A view cannot contain ${writer.op}. Disable or remove that stage first.`);
        return;
      }
      try {
        pipeline = stagesToPipelineJson(stages ?? []);
      } catch (e) {
        setError(getErrorMessage(e, String(e)));
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.collection.create({
        connectionId,
        dbName,
        collection: trimmed,
        options: { viewOn: collection, pipeline, ...(collation ? { collation } : {}) },
      });
      onCreated(trimmed);
      onClose();
    } catch (e) {
      setError(getErrorMessage(e, 'Could not create the view'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      opened
      onClose={() => void requestClose()}
      title={title}
      centered
      size="md"
      closeOnClickOutside={false}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            {description ?? `A view on ${dbName}.${collection} that runs the enabled stages each time it is read.`}
          </Text>
          <TextInput
            label="View name"
            data-autofocus
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="e.g. open_orders"
            size="xs"
          />
          {error && (
            <Alert color="red" variant="light" role="alert">
              {error}
            </Alert>
          )}
          <Group justify="flex-end" gap="xs">
            <Button type="button" variant="subtle" size="compact-xs" onClick={() => void requestClose()}>
              Cancel
            </Button>
            <SubmitButton type="submit" variant="filled" size="compact-xs" disabled={!trimmed} submitting={submitting}>
              Create view
            </SubmitButton>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
