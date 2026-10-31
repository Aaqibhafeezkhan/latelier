import React from 'react';
import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { api, getErrorMessage } from '../../api/atelier';
import { invalidateSampleSchemaCache } from '../../features/fieldSuggestions/sources/sampleSchemaSource';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { SubmitButton } from '../../components/SubmitButton';
import { isValidEjson } from '../../utils/ejson';
import { useShellSyntaxField } from './useShellSyntaxField';
import { AUDIT_UNDO_DOC_LIMIT } from '../../utils/auditUndo';

interface UpdateConfirmProps {
  connectionId: string;
  dbName: string;
  collection: string;
  /** Canonical EJSON — the tab's current query filter, always present when
   *  this dialog is open (`useDocumentDialogs.openUpdateAllModal` refuses to
   *  open it otherwise, same guard as delete-all). */
  filter: string;
  /** The tab's collation (W14 §9). `confirmUpdateMany`/`updateMany` send only
   *  the filter, so with a collation set they would update a different set
   *  of documents than the one on screen: the update is refused instead. */
  collation?: string;
  /** The tab's hint (W14 §9), refused the same way: a hinted sparse index
   *  can show fewer documents than the filter matches. */
  hint?: string;
  readOnly?: boolean;
  onClose: () => void;
  /** `auditId` is set when the update can be undone — within X13's bulk
   *  capture ceiling. `message` carries the matched/modified counts so the
   *  caller's one toast (Undo-bearing or plain) still reports them. */
  onUpdated: (auditId: string | undefined, message: string) => void;
}

/**
 * What `doc:confirmUpdateMany` handed back for the update body currently
 * shown in the editor. Cleared on any edit — the token is bound to the exact
 * text it counted against (ADR 0013: the count and the confirm gate must
 * describe the action that will actually run, not a stale draft).
 */
type Reviewed = { count: number; confirmToken: string; updateJson: string };

/**
 * "Update all matching…" (W08/#143) — same two-step confirm-token pattern as
 * `DeleteConfirm`'s multi-doc path, plus one step `DeleteConfirm` doesn't
 * need: the update body is free text the user is still editing, so the count
 * can't be fetched on mount the way delete's fixed filter is. An explicit
 * Review step commits the buffer, sends it to `confirmUpdateMany`, and only
 * then unlocks the type-the-collection-name gate — editing the buffer after
 * Review clears it, so a stale token can never authorize a different update.
 */
export function UpdateConfirm({
  connectionId,
  dbName,
  collection,
  filter,
  collation,
  hint,
  readOnly = false,
  onClose,
  onUpdated,
}: UpdateConfirmProps) {
  const T = themeVars;
  const close = useDialogFocusReturn(onClose);

  const [buffer, setBuffer] = React.useState('{ "$set": {  } }');
  const [confirm, setConfirm] = React.useState('');
  const [reviewing, setReviewing] = React.useState(false);
  const [reviewed, setReviewed] = React.useState<Reviewed | null>(null);
  const [running, setRunning] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // Whether this very dialog is still on screen. The Focused Tab moving
  // closes it while its request is in flight, and by the time the write lands
  // the caller's `onClose` may belong to a dialog opened since on another tab.
  // Set in the effect body, not just reset in cleanup, so StrictMode's
  // simulated remount leaves it true.
  const mountedRef = React.useRef(false);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Live snapshots of what a Review response must still match once it lands.
  // `confirmUpdateMany` is in flight for a round trip; the textarea is
  // read-only for that window (below), but nothing stops the *filter/target*
  // this dialog is scoped to from moving underneath it (a live re-run of
  // `currentFilterJson` in DialogStack). Refs, not state — `handleReview`
  // only reads them once the awaited call resolves, and a ref read/written
  // during render is unreliable (and `react-hooks/refs` refuses it), so the
  // sync runs from an effect instead.
  const bufferRef = React.useRef(buffer);
  const targetRef = React.useRef({ connectionId, dbName, collection, filter });
  React.useEffect(() => {
    bufferRef.current = buffer;
    targetRef.current = { connectionId, dbName, collection, filter };
  });

  // Write surfaces stay strict (ADR 0004) — Shell Syntax reaches this editor
  // the same way it reaches EditDrawer, repaired on blur so what Review sends
  // is exactly what's on screen.
  const shell = useShellSyntaxField({
    value: buffer,
    commit: (next) => {
      setBuffer(next);
      setReviewed(null);
    },
  });
  const canonical = shell.outcome.kind === 'repaired' ? shell.outcome.text : buffer;
  const isValid = isValidEjson(canonical);
  const refusal = shell.liveRefusal;

  const handleChange = (next: string) => {
    setBuffer(next);
    setReviewed(null);
    setErr(null);
  };

  const handleReview = async () => {
    if (reviewing) return;
    const submitted = shell.commitNow().text;
    if (!isValidEjson(submitted)) {
      setErr('Invalid EJSON');
      return;
    }
    // What this specific request describes — compared against the live refs
    // once the response lands, not against `filter`/`connectionId`/… again,
    // which would just re-read the same (possibly since-changed) closure.
    const requested = { connectionId, dbName, collection, filter, updateJson: submitted };
    setReviewing(true);
    setErr(null);
    try {
      const { count, confirmToken } = await api.doc.confirmUpdateMany({
        connectionId,
        dbName,
        collection,
        filterJson: filter,
        updateJson: submitted,
      });
      // The textarea is read-only for this window, but the buffer can still
      // have been repaired by a blur that fired after this call started, and
      // the filter/target this dialog is scoped to can move under it (a live
      // re-run of `currentFilterJson` in DialogStack). Either one means this
      // response describes an action the user is no longer looking at — drop
      // it rather than arm Update with a token minted for a different body.
      const current = targetRef.current;
      const stale =
        bufferRef.current !== requested.updateJson ||
        current.connectionId !== requested.connectionId ||
        current.dbName !== requested.dbName ||
        current.collection !== requested.collection ||
        current.filter !== requested.filter;
      if (stale) return;
      setReviewed({ count, confirmToken, updateJson: submitted });
    } catch (e) {
      setErr(getErrorMessage(e, 'Could not review this update'));
    } finally {
      setReviewing(false);
    }
  };

  const handleUpdate = async () => {
    if (running || !reviewed) return;
    setRunning(true);
    setErr(null);
    try {
      const { matchedCount, modifiedCount, auditId } = await api.doc.updateMany({
        connectionId,
        dbName,
        collection,
        filterJson: filter,
        updateJson: reviewed.updateJson,
        confirmToken: reviewed.confirmToken,
      });
      // This dialog's own collection, not the Focused Tab's: focus can move
      // while the request is in flight, and the caller only sees the tab it
      // finds at completion.
      invalidateSampleSchemaCache(connectionId, dbName, collection);
      // One toast either way (Undo-bearing when `auditId` is set, plain
      // otherwise) — the caller decides which, so a reversible and an
      // irreversible bulk update never show two.
      onUpdated(auditId, `${matchedCount.toLocaleString()} matched, ${modifiedCount.toLocaleString()} modified`);
      // The write is reported either way; only a dialog still on screen is
      // ours to close.
      if (mountedRef.current) onClose();
    } catch (e) {
      // updateMany is not atomic across documents: a failure can leave the
      // earlier ones modified, so the sample is dropped here too; harmless if
      // the request was refused before touching data.
      invalidateSampleSchemaCache(connectionId, dbName, collection);
      setErr(getErrorMessage(e, 'Update failed'));
    } finally {
      setRunning(false);
    }
  };

  const matchesCollectionName = confirm === collection;
  const collationSet = !!collation?.trim();
  const hintSet = !!hint?.trim();
  const optionBlocks = collationSet || hintSet;
  const reviewDisabled = readOnly || optionBlocks || reviewing || !isValid;
  const updateDisabled = readOnly || optionBlocks || running || reviewed === null || !matchesCollectionName;

  // States a fact about this specific action (ADR 0013); no line until
  // Review runs `confirmUpdateMany`, since the count isn't known before
  // that. Same ceiling and same
  // caveat as `DeleteConfirm`'s bulk line: within the document-count limit
  // is "Undo will be offered", not a flat guarantee — the byte ceiling
  // (X13 §5) can still drop it, and there's no cheap way to know that here.
  const undoLine =
    reviewed === null
      ? null
      : reviewed.count <= AUDIT_UNDO_DOC_LIMIT
        ? `Within the ${AUDIT_UNDO_DOC_LIMIT.toLocaleString()}-document undo limit — Undo will be offered if they total under 1 MB.`
        : `Above the ${AUDIT_UNDO_DOC_LIMIT.toLocaleString()}-document undo limit — this cannot be undone.`;

  return (
    <Modal opened onClose={close} title="Update all matching documents" centered size="md">
      <Stack gap="sm">
        {undoLine && (
          <Text size="xs" c="dimmed">
            {undoLine}
          </Text>
        )}

        {readOnly && (
          <Alert color="yellow" variant="light" role="alert">
            This connection is read-only. Updating is disabled.
          </Alert>
        )}

        {collationSet && (
          <Alert color="yellow" variant="light" role="alert">
            Clear the collation to update by filter: it would change which documents match.
          </Alert>
        )}

        {hintSet && (
          <Alert color="yellow" variant="light" role="alert">
            Clear the hint to update by filter: a hinted sparse index can show fewer documents than the filter matches.
          </Alert>
        )}

        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            Filter
          </Text>
          <Text
            size="xs"
            style={{ fontFamily: 'monospace', wordBreak: 'break-all', color: T.text }}
          >
            {filter}
          </Text>
        </Stack>

        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            Update ($set, $unset, $inc, …)
          </Text>
          <textarea
            aria-label="Update document"
            value={buffer}
            onChange={(e) => handleChange(e.target.value)}
            onBlur={() => shell.onBlur()}
            // Locked for the round trip: a Review response is bound to the
            // body it counted, so an edit during that window must never be
            // possible to make silently — the `handleReview` staleness check
            // above is the correctness guard, this is what stops the user
            // from ever seeing the discarded response as if it had counted.
            readOnly={reviewing}
            aria-invalid={!isValid}
            aria-describedby={refusal ? 'update-all-syntax-error' : undefined}
            spellCheck={false}
            rows={6}
            style={{
              fontFamily: 'monospace',
              fontSize: 12,
              padding: '8px 10px',
              border: `1px solid ${!isValid ? T.warn : T.border}`,
              borderRadius: T.rs,
              background: T.surfaceRaised,
              color: T.text,
              resize: 'vertical',
              outline: 'none',
              lineHeight: 1.5,
            }}
          />
          {refusal && (
            <div id="update-all-syntax-error" role="alert" style={{ fontSize: 11, color: T.warn }}>
              {refusal}
            </div>
          )}
        </Stack>

        {reviewed === null ? (
          <Group justify="flex-end">
            <SubmitButton
              variant="light"
              size="compact-xs"
              onClick={() => void handleReview()}
              disabled={reviewDisabled}
              submitting={reviewing}
            >
              {reviewing ? 'Counting…' : 'Review'}
            </SubmitButton>
          </Group>
        ) : (
          <Stack gap={6}>
            <Text size="xs" fw={600}>
              {reviewed.count.toLocaleString()} matching document{reviewed.count === 1 ? '' : 's'}
            </Text>
            <Text size="xs" c="dimmed">
              Type <strong>{collection}</strong> to confirm
            </Text>
            <TextInput
              value={confirm}
              onChange={(e) => setConfirm(e.currentTarget.value)}
              placeholder={collection}
              size="xs"
            />
          </Stack>
        )}

        {err && (
          <Alert color="red" variant="light" role="alert">
            {err}
          </Alert>
        )}

        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" size="compact-xs" onClick={close}>
            Cancel
          </Button>
          {reviewed !== null && (
            <SubmitButton
              variant="filled"
              color="red"
              size="compact-xs"
              onClick={() => void handleUpdate()}
              disabled={updateDisabled}
              submitting={running}
            >
              {running ? 'Updating…' : 'Update'}
            </SubmitButton>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
