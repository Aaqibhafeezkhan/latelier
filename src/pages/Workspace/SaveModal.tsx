import React from 'react';
import { Button, Modal } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { api, getErrorMessage } from '../../api/atelier';
import { confirmDestructive } from '../../utils/confirm';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { SubmitButton } from '../../components/SubmitButton';
import type { BuilderState } from '@shared/types';

interface SaveModalProps {
  connectionId: string;
  dbName: string;
  collection: string;
  builderState: BuilderState;
  queryRaw: string;
  onClose: () => void;
  onSaved: () => void;
}

export function SaveModal({
  connectionId,
  dbName,
  collection,
  builderState,
  queryRaw,
  onClose,
  onSaved,
}: SaveModalProps) {
  const T = themeVars;
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Dismiss paths only — a successful save keeps `onClose` raw.
  const close = useDialogFocusReturn(onClose);

  const requestClose = async () => {
    // X15 §2 — dirty is "differs from initial". This modal always opens empty
    // (there is no edit-an-existing-saved-query entry point), so the initial
    // state is the empty string rather than a captured ref. Untrimmed on
    // purpose: whitespace the user typed is still something they'd lose.
    const isDirty = name !== '' || description !== '';
    if (!isDirty) return close();
    const discard = await confirmDestructive({
      title: 'Discard changes?',
      body: 'This closes the dialog and loses what you typed.',
      confirmLabel: 'Discard',
    });
    if (discard) close();
  };

  const fieldsValid = name.trim().length > 0;
  const canSubmit = fieldsValid && !saving;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setErr(null);
    try {
      await api.saved.create({
        connectionId,
        dbName,
        collection,
        kind: 'find',
        name: name.trim(),
        payload: {
          kind: 'find',
          builder: builderState,
          queryRaw,
          description: description.trim() || undefined,
        },
      });
      onSaved();
      onClose();
    } catch (e) {
      const code = (e as { code?: string }).code;
      setErr(
        code === 'CONFLICT'
          ? `A query named "${name}" already exists.`
          : getErrorMessage(e, 'Save failed'),
      );
    } finally {
      setSaving(false);
    }
  };

  const fieldStyle = {
    display: 'block',
    marginTop: 4,
    width: '100%',
    padding: '6px 10px',
    border: `1px solid ${T.border}`,
    borderRadius: T.rs,
    background: T.surfaceRaised,
    color: T.text,
    fontSize: 12,
    boxSizing: 'border-box',
  } as const;

  return (
    // X15 T5 — `closeOnClickOutside={false}` is load-bearing. Mantine defaults
    // it to `true`, which would reproduce the hand-rolled backdrop's
    // `onClick={onClose}` this migration removed: one stray click discarding a
    // typed name and description. The backdrop is now inert — it neither closes
    // nor prompts. Escape still closes, but through `requestClose`, so it
    // prompts when there is something to lose.
    <Modal
      opened
      onClose={() => void requestClose()}
      title="Save query"
      size={400}
      centered
      closeOnClickOutside={false}
    >
      {/* The fields were bare siblings, so Enter did nothing. A real
          <form> gives the name input implicit submission for free, and both
          paths run the same `handleSubmit` (so `canSubmit` still gates). */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <label style={{ fontSize: 12, color: T.textMuted }}>
          Name *
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setErr(null);
            }}
            placeholder="My query"
            // `data-autofocus`, not `autoFocus`: Mantine's FocusTrap moves
            // focus to the first tabbable node (the ✕) unless a descendant
            // opts in this way, and it would win the race against React's
            // plain autoFocus.
            data-autofocus
            style={fieldStyle}
          />
        </label>

        <label style={{ fontSize: 12, color: T.textMuted }}>
          Description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            // A textarea swallows Enter, so implicit submission never reaches
            // the form from here. Enter submits / Shift+Enter newlines is the
            // conventional trade for a 3-row optional note, and it routes
            // through the same `handleSubmit` as the Save button.
            //
            // Every reason not to submit has to be decided BEFORE
            // `preventDefault`, or the keystroke is simply eaten: `handleSubmit`
            // returns on `!canSubmit`, so an unnamed draft would get neither a
            // save nor a newline. `isComposing` is the same trap one layer
            // down — Chromium fires keydown with `key === 'Enter'` when an IME
            // candidate is committed, and swallowing that saves a
            // half-composed description.
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey) return;
              if (e.nativeEvent.isComposing || !canSubmit) return;
              e.preventDefault();
              void handleSubmit();
            }}
            placeholder="Optional description"
            rows={3}
            style={{ ...fieldStyle, resize: 'vertical' }}
          />
        </label>

        {err && (
          <div role="alert" style={{ fontSize: 12, color: T.warn }}>
            {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {/* Explicit `type="button"` for intent: an untyped button inside a
              form defaults to submit, and this one is first in tree order.
              Stated plainly because it was tested rather than assumed —
              deleting it does NOT break Enter, in jsdom or in Chromium, so the
              tempting story that Cancel would otherwise swallow Enter is
              wrong. What actually carries Enter to Save is the form's
              `onSubmit`; neutering that reds
              `save-modal-dialog-shell.spec.tsx`'s Enter test immediately. */}
          <Button type="button" variant="default" size="xs" c={T.textMuted} onClick={() => void requestClose()}>
            Cancel
          </Button>
          <SubmitButton
            type="submit"
            size="xs"
            disabled={!fieldsValid} // #91 — real disabled excludes `saving`, see SubmitButton.tsx
            submitting={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </SubmitButton>
        </div>
      </form>
    </Modal>
  );
}
