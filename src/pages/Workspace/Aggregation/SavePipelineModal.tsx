import React from 'react';
import { Button, Modal } from '@mantine/core';
import { themeVars } from '../../../theme/themeVars';
import { api, isIpcError } from '../../../api/atelier';
import { confirmDestructive } from '../../../utils/confirm';
import { useDialogFocusReturn } from '../../../hooks/useDialogFocusReturn';
import { SubmitButton } from '../../../components/SubmitButton';
import type { SavedQuery, Stage } from '@shared/types';

interface Props {
  connectionId: string;
  dbName: string;
  collection: string;
  stages: Stage[];
  initialName?: string;
  onClose: () => void;
  onSaved: (saved: SavedQuery) => void;
}

export function SavePipelineModal({
  connectionId,
  dbName,
  collection,
  stages,
  initialName,
  onClose,
  onSaved,
}: Props) {
  const T = themeVars;
  const [name, setName] = React.useState(initialName ?? '');
  const [description, setDescription] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Dismiss paths only — a successful save keeps `onClose` raw.
  const close = useDialogFocusReturn(onClose);

  const requestClose = async () => {
    // X15 §2 — dirty is "differs from initial", not "was touched". This modal
    // opens pre-filled with `initialName` when the pipeline was saved before,
    // so comparing against `''` would prompt on every clean Cancel of an
    // already-named pipeline. Untrimmed on purpose: whitespace the user typed
    // is still something they'd lose.
    const isDirty = name !== (initialName ?? '') || description !== '';
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

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setErr(null);
    try {
      const saved = await api.saved.create({
        connectionId,
        dbName,
        collection,
        kind: 'aggregation',
        name: name.trim(),
        payload: {
          kind: 'aggregation',
          stages,
          description: description.trim() || undefined,
        },
      });
      onSaved(saved);
      onClose();
    } catch (e) {
      if (isIpcError(e)) {
        if (e.code === 'CONFLICT') {
          setErr(`A pipeline named "${name.trim()}" already exists.`);
        } else {
          setErr(e.message);
        }
      } else {
        setErr(String(e));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    // X15 T6 — `closeOnClickOutside={false}` is load-bearing. Mantine defaults
    // it to `true`, which would reproduce the hand-rolled backdrop's
    // `onClick={onClose}` this migration removed: one stray click discarding a
    // typed name and description. The backdrop is now inert — it neither closes
    // nor prompts. Escape still closes, but through `requestClose`, so it
    // prompts when there is something to lose. `role="dialog"` also moves off
    // the backdrop and onto the panel, which is what Mantine marks up.
    <Modal
      opened
      onClose={() => void requestClose()}
      title="Save pipeline"
      size={400}
      centered
      closeOnClickOutside={false}
    >
      {/* The fields were bare siblings, so Enter did nothing here even
          after `SaveModal` was given a form. A real <form> gives the name input
          implicit submission for free, and both paths run the same `submit`
          (so `canSubmit` still gates). */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
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
            placeholder="e.g. monthly totals by account"
            // `data-autofocus`, not `autoFocus`: Mantine's FocusTrap moves
            // focus to the first tabbable node (the ✕) unless a descendant
            // opts in this way, and it would win the race against React's
            // plain autoFocus.
            data-autofocus
            style={{
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
            }}
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
            // through the same `submit` as the Save button.
            //
            // Every reason not to submit has to be decided BEFORE
            // `preventDefault`, or the keystroke is simply eaten: `submit`
            // returns on `!canSubmit`, so an unnamed draft would get neither a
            // save nor a newline. `isComposing` is the same trap one layer
            // down — Chromium fires keydown with `key === 'Enter'` when an IME
            // candidate is committed, and swallowing that saves a
            // half-composed description.
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey) return;
              if (e.nativeEvent.isComposing || !canSubmit) return;
              e.preventDefault();
              void submit();
            }}
            placeholder="Optional description"
            rows={3}
            style={{
              display: 'block',
              marginTop: 4,
              width: '100%',
              padding: '6px 10px',
              border: `1px solid ${T.border}`,
              borderRadius: T.rs,
              background: T.surfaceRaised,
              color: T.text,
              fontSize: 12,
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
        </label>

        {err && (
          <div role="alert" style={{ fontSize: 12, color: T.red }}>
            {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {/* Explicit `type="button"` for intent: an untyped button inside a
              form defaults to submit, and this one is first in tree order.
              Stated plainly because it was measured rather than assumed —
              deleting it does NOT break Enter, in jsdom or in Chromium. What
              carries Enter to Save is the form's `onSubmit`. */}
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
