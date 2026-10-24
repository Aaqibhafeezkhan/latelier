import React from 'react';
import { Button, Modal } from '@mantine/core';
import { themeVars } from '../../../theme/themeVars';
import { api, isIpcError } from '../../../api/atelier';
import { confirmDestructive } from '../../../utils/confirm';
import { invalidateSampleSchemaCache } from '../../../features/fieldSuggestions/sources/sampleSchemaSource';
import { invalidateSchemaEnumCache } from '../../../features/fieldSuggestions/sources/schemaEnumSource';
import { useDialogFocusReturn } from '../../../hooks/useDialogFocusReturn';
import { SubmitButton } from '../../../components/SubmitButton';
import type { AggMergeOptions, AggSaveMode, Stage } from '@shared/types';
import type { SaveResultInfo } from './saveResultMessage';

interface Props {
  connectionId: string;
  dbName: string;
  collection: string;
  stages: Stage[];
  onClose: () => void;
  onWritten: (info: SaveResultInfo) => void;
}

export function SaveAsCollectionModal({
  connectionId,
  dbName,
  collection,
  stages,
  onClose,
  onWritten,
}: Props) {
  const T = themeVars;
  const [targetDb, setTargetDb] = React.useState(dbName);
  const [targetColl, setTargetColl] = React.useState('');
  const [mode, setMode] = React.useState<AggSaveMode>('$out');
  const [whenMatched, setWhenMatched] =
    React.useState<NonNullable<AggMergeOptions['whenMatched']>>('merge');
  const [whenNotMatched, setWhenNotMatched] =
    React.useState<NonNullable<AggMergeOptions['whenNotMatched']>>('insert');
  const [confirmText, setConfirmText] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // Dismiss paths only — a successful write keeps `onClose` raw.
  const close = useDialogFocusReturn(onClose);

  const requestClose = async () => {
    // X15 §2 — dirty is "differs from initial", and it spans every buffer the
    // dialog owns, not just the visible one. `targetDb` opens pre-filled with
    // the source database, so comparing it against `''` would mark the modal
    // dirty the instant it mounts. The two mode selects count too: picking
    // `$merge` and configuring whenMatched/whenNotMatched is work the user
    // would have to redo, and leaving them out is exactly the silent-loss
    // shape §2 warns about.
    const isDirty =
      targetDb !== dbName ||
      targetColl !== '' ||
      confirmText !== '' ||
      mode !== '$out' ||
      whenMatched !== 'merge' ||
      whenNotMatched !== 'insert';
    if (!isDirty) return close();
    const discard = await confirmDestructive({
      title: 'Discard changes?',
      body: 'This closes the dialog and loses what you typed.',
      confirmLabel: 'Discard',
    });
    if (discard) close();
  };

  // Follow-up fix — the form made Enter submit from EVERY field, so the gate
  // has to bind every input that decides where the write lands, not just the
  // one the confirmation echoes. `targetDb` was in neither: an empty one only
  // failed at `NonEmpty` in the agg handler (a raw `VALIDATION:` string in the
  // error area), and a *changed* one submitted against a confirmation the user
  // typed for a different destination. Editing it clears `confirmText` below,
  // which re-arms the type-to-confirm rather than trusting a stale one.
  const fieldsValid =
    targetDb.trim().length > 0 &&
    targetColl.trim().length > 0 &&
    confirmText.trim() === targetColl.trim();
  const canSubmit = fieldsValid && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setErr(null);
    try {
      const result = await api.agg.runAndSave({
        connectionId,
        dbName,
        collection,
        stages,
        allowWrite: true,
        target: {
          dbName: targetDb.trim(),
          collection: targetColl.trim(),
          mode,
          merge:
            mode === '$merge' ? { whenMatched, whenNotMatched } : undefined,
        },
      });
      onWritten({
        dbName: targetDb.trim(),
        collection: targetColl.trim(),
        mode,
        writtenCount: result.writtenCount,
        mergeCounts: result.mergeCounts,
      });
      onClose();
    } catch (e) {
      if (isIpcError(e)) {
        setErr(`${e.code}: ${e.message}`);
      } else {
        setErr(String(e));
      }
    } finally {
      // The target's documents were replaced or merged into, so a sample of it
      // taken earlier describes the old ones — also when a `$merge` failed
      // part-way. Harmless if nothing was written.
      invalidateSampleSchemaCache(connectionId, targetDb.trim(), targetColl.trim());
      invalidateSchemaEnumCache(connectionId, targetDb.trim(), targetColl.trim());
      setSaving(false);
    }
  };

  return (
    // X15 T6 — `closeOnClickOutside={false}` is load-bearing. Mantine defaults
    // it to `true`, which would reproduce the hand-rolled backdrop's
    // `onClick={onClose}` this migration removed: one stray click discarding a
    // typed target and its type-to-confirm. The backdrop is now inert — it
    // neither closes nor prompts. Escape still closes, but through
    // `requestClose`, so it prompts when there is something to lose.
    // `role="dialog"` also moves off the backdrop and onto the panel.
    <Modal
      opened
      onClose={() => void requestClose()}
      title="Save results to collection"
      size={460}
      centered
      closeOnClickOutside={false}
    >
      {/* The fields were bare siblings, so Enter did nothing here even
          after `SaveModal` was given a form. A real <form> gives every text
          input implicit submission for free, and both paths run the same
          `submit` (so `canSubmit`, type-to-confirm included, still gates). */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <label style={{ fontSize: 12, color: T.textMuted }}>
          Target database
          <input
            value={targetDb}
            onChange={(e) => {
              setTargetDb(e.target.value);
              // Retyping the destination retracts the confirmation that was
              // given for the old one — same rule `canSubmit` already applies
              // to `targetColl`, which disarms itself by comparison.
              setConfirmText('');
            }}
            style={inputStyle(T)}
          />
        </label>

        <label style={{ fontSize: 12, color: T.textMuted }}>
          Target collection *
          <input
            value={targetColl}
            onChange={(e) => setTargetColl(e.target.value)}
            placeholder="e.g. monthlyByAccount"
            // `data-autofocus`, not `autoFocus`: Mantine's FocusTrap moves
            // focus to the first tabbable node (the ✕) unless a descendant
            // opts in this way, and it would win the race against React's
            // plain autoFocus.
            data-autofocus
            style={inputStyle(T)}
          />
        </label>

        <label style={{ fontSize: 12, color: T.textMuted }}>
          Mode
          <select
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as AggSaveMode);
              // Same retraction as `targetDb`, and the sharper case of it:
              // confirming under `$merge` reads the banner about matching
              // `_id`s, so carrying that confirmation into `$out` would
              // replace the whole collection on a promise never made.
              setConfirmText('');
            }}
            style={inputStyle(T)}
          >
            <option value="$out">$out — replace collection</option>
            <option value="$merge">$merge — merge by _id</option>
          </select>
        </label>

        {mode === '$merge' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <label style={{ fontSize: 12, color: T.textMuted, flex: 1 }}>
              whenMatched
              <select
                value={whenMatched}
                onChange={(e) =>
                  setWhenMatched(
                    e.target.value as NonNullable<AggMergeOptions['whenMatched']>,
                  )
                }
                style={inputStyle(T)}
              >
                <option value="merge">merge</option>
                <option value="replace">replace</option>
                <option value="keepExisting">keepExisting</option>
                <option value="fail">fail</option>
              </select>
            </label>
            <label style={{ fontSize: 12, color: T.textMuted, flex: 1 }}>
              whenNotMatched
              <select
                value={whenNotMatched}
                onChange={(e) =>
                  setWhenNotMatched(
                    e.target.value as NonNullable<AggMergeOptions['whenNotMatched']>,
                  )
                }
                style={inputStyle(T)}
              >
                <option value="insert">insert</option>
                <option value="discard">discard</option>
                <option value="fail">fail</option>
              </select>
            </label>
          </div>
        )}

        <div
          role="alert"
          style={{
            fontSize: 11,
            color: T.warn,
            padding: '6px 8px',
            background: 'rgba(200,160,0,0.08)',
            borderRadius: T.rs,
            border: `1px solid ${T.border}`,
          }}
        >
          {mode === '$out'
            ? 'This replaces all documents in the target collection.'
            : 'Existing documents with matching _id will be modified per whenMatched; non-matching documents will be handled per whenNotMatched.'}
        </div>

        <label style={{ fontSize: 12, color: T.textMuted }}>
          Type <span style={{ fontFamily: 'monospace', color: T.text }}>{targetColl || '…'}</span>{' '}
          to confirm
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            style={inputStyle(T)}
          />
        </label>

        {err && (
          <div role="alert" style={{ fontSize: 12, color: T.red, whiteSpace: 'pre-wrap' }}>
            {err}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {/* Explicit `type="button"` for intent: an untyped button inside a
              form defaults to submit, and this one is first in tree order.
              Stated plainly because it was measured rather than assumed —
              deleting it does NOT break Enter, in jsdom or in Chromium. What
              carries Enter to the write is the form's `onSubmit`. */}
          <Button type="button" variant="default" size="xs" c={T.textMuted} onClick={() => void requestClose()}>
            Cancel
          </Button>
          <SubmitButton
            type="submit"
            size="xs"
            disabled={!fieldsValid} // #91 — real disabled excludes `saving`, see SubmitButton.tsx
            submitting={saving}
          >
            {saving ? 'Writing…' : `Confirm ${mode}`}
          </SubmitButton>
        </div>
      </form>
    </Modal>
  );
}

function inputStyle(T: typeof themeVars): React.CSSProperties {
  return {
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
  };
}
