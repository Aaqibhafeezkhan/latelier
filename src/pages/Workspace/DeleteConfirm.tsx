import React from 'react';
import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { api, getErrorMessage } from '../../api/atelier';
import { invalidateSampleSchemaCache } from '../../features/fieldSuggestions/sources/sampleSchemaSource';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { SubmitButton } from '../../components/SubmitButton';
import { buildIdFilter } from './views/docId';
import { AUDIT_UNDO_DOC_LIMIT } from '../../utils/auditUndo';

interface DeleteConfirmProps {
  connectionId: string;
  dbName: string;
  collection: string;
  docs: unknown[];
  filter?: string;
  /** The tab's collation (W14 §9), for a delete by the tab's filter.
   *  `confirmDeleteMany`/`deleteMany` send only the filter, so with a
   *  collation set they would delete a different set of documents than the
   *  one on screen: a filter-wide delete is refused instead. */
  collation?: string;
  /** The tab's hint (W14 §9), refused the same way: a hinted sparse index
   *  can show fewer documents than the filter matches. */
  hint?: string;
  /** Disables the confirm button outright rather than letting the
   * user complete the confirmation flow only to hit a server-side rejection. */
  readOnly?: boolean;
  onClose: () => void;
  /** `auditId` is set when the delete can be undone — single document
   *  always; delete-all-matching only within X13's bulk capture ceiling.
   *  `message` names what happened (singular for one document, a count for
   *  delete-all), so the caller's one toast (Undo-bearing or plain) reports
   *  it correctly either way. */
  onDeleted: (auditId: string | undefined, message: string) => void;
}

/**
 * Result of the `doc.confirmDeleteMany` count-before-commit fetch (see
 * below). `pending` is both "not started" (single-doc path never leaves it)
 * and "in flight" (multi-doc path, before the promise settles) — collapsing
 * those avoids a synchronous `setState` inside the effect body.
 */
type CountState =
  | { status: 'pending' }
  | { status: 'ready'; count: number; confirmToken: string }
  | { status: 'error'; message: string };

export function DeleteConfirm({
  connectionId,
  dbName,
  collection,
  docs,
  filter,
  collation,
  hint,
  readOnly = false,
  onClose,
  onDeleted,
}: DeleteConfirmProps) {
  // Dismiss paths only — `submit`'s own `onClose()` below stays raw, because a
  // completed delete hands off to the refreshed grid.
  const close = useDialogFocusReturn(onClose);
  const [confirm, setConfirm] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [countState, setCountState] = React.useState<CountState>({ status: 'pending' });
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

  const isMulti = docs.length > 1 || !!filter;
  const collationBlocks = isMulti && !!collation?.trim();
  const hintBlocks = isMulti && !!hint?.trim();
  // A refused delete asks for no count either: the count is by the filter
  // alone, so a title saying "Delete 3 matching documents?" would name a set
  // that is not the one on screen.
  const optionBlocks = collationBlocks || hintBlocks;
  const matchesCollectionName = confirm === collection;
  // The filter this delete is scoped to — same string for the count fetch
  // and the eventual `deleteMany` so the token (bound server-side to this
  // exact filter) is never sent alongside a different filter than the one
  // it was minted for.
  const matchFilterJson = filter ?? '{}';

  // Count-before-commit (): fetch the real match count + a
  // confirmToken as soon as the modal opens for a multi-doc delete, instead
  // of on click. Reused directly by `handleDelete` below — no second
  // `confirmDeleteMany` round trip when the user actually confirms.
  //
  // `ignore` guards against React StrictMode's dev-mode double-invocation
  // (two effect runs, two in-flight promises racing) and against
  // setState-after-unmount if the modal closes before the fetch resolves.
  // Keying the effect on `matchFilterJson` (not just mount) means a
  // superseded filter's response is also dropped — though in practice this
  // component is always remounted with a fresh `key` rather than patched in
  // place, so this only matters as a defensive guarantee.
  React.useEffect(() => {
    if (!isMulti || optionBlocks) return;
    let ignore = false;
    void (async () => {
      try {
        const { count, confirmToken } = await api.doc.confirmDeleteMany({
          connectionId,
          dbName,
          collection,
          filterJson: matchFilterJson,
        });
        if (!ignore) setCountState({ status: 'ready', count, confirmToken });
      } catch (e) {
        if (!ignore) {
          setCountState({
            status: 'error',
            message: getErrorMessage(e, 'Could not count matching documents'),
          });
        }
      }
    })();
    return () => {
      ignore = true;
    };
  }, [isMulti, optionBlocks, connectionId, dbName, collection, matchFilterJson]);

  const handleDelete = async () => {
    if (loading) return; // #91 — see SubmitButton.tsx
    setLoading(true);
    setErr(null);
    let auditId: string | undefined;
    let message: string;
    try {
      if (!isMulti && docs[0] !== undefined) {
        const doc = docs[0];
        // `buildIdFilter` is the same helper Workspace.tsx's `updateField`
        // uses — it returns null when the document
        // has no `_id` (e.g. a find with `{_id: 0}` projection), which this
        // path must refuse rather than fall through to `{}` and delete an
        // ARBITRARY document (N0.1).
        const filterJson = buildIdFilter(doc);
        if (filterJson === null) {
          setErr('Cannot delete a document without an _id');
          return;
        }
        const res = await api.doc.deleteOne({ connectionId, dbName, collection, filterJson });
        auditId = res.auditId;
        // A compare-and-set that lost its race (someone else deleted it
        // first) matched nothing — say so rather than claiming a delete that
        // didn't happen (X13 §4: `matchedCount: 0` is never reversible).
        message = res.deletedCount === 1 ? 'Document deleted' : 'Nothing was deleted: the document was already gone';
      } else {
        if (countState.status !== 'ready') return;
        const res = await api.doc.deleteMany({
          connectionId,
          dbName,
          collection,
          filterJson: matchFilterJson,
          confirmToken: countState.confirmToken,
        });
        auditId = res.auditId;
        message = `${res.deletedCount.toLocaleString()} document${res.deletedCount === 1 ? '' : 's'} deleted`;
      }
      // This dialog's own collection, not the Focused Tab's: focus can move
      // while the request is in flight, and the caller only sees the tab it
      // finds at completion.
      invalidateSampleSchemaCache(connectionId, dbName, collection);
      onDeleted(auditId, message);
      // The write is reported either way; only a dialog still on screen is
      // ours to close.
      if (mountedRef.current) onClose();
    } catch (e) {
      // A deleteMany that fails can stop part-way, so the sample is dropped
      // here too; harmless if the request was refused before touching data.
      invalidateSampleSchemaCache(connectionId, dbName, collection);
      setErr(getErrorMessage(e, 'Delete failed'));
    } finally {
      setLoading(false);
    }
  };

  const isCounting = isMulti && !optionBlocks && countState.status === 'pending';
  const countErr = countState.status === 'error' ? countState.message : null;

  const title = isMulti
    ? countState.status === 'ready'
      ? `Delete ${countState.count.toLocaleString()} matching document${countState.count === 1 ? '' : 's'}?`
      : 'Delete matching documents?'
    : 'Delete document?';

  const deleteDisabled =
    readOnly ||
    optionBlocks ||
    (isMulti &&
      (!matchesCollectionName ||
        countState.status !== 'ready' ||
        countState.count === 0));

  // States a fact about this specific action (ADR 0013 — never what tier the
  // dialog is on). A single document always keeps a Pre-image. A bulk delete
  // is bounded twice (X13 §5): the count here only proves the document-count
  // half, so under the limit is "undo is available" rather than a flat
  // guarantee — the byte ceiling can still drop it, and the confirm dialog
  // has no cheap way to know that in advance. Above the limit is an absolute
  // "cannot" — breaching either ceiling alone is enough to refuse capture.
  const undoLine = !isMulti
    ? 'This can be undone.'
    : countState.status === 'ready'
      ? countState.count <= AUDIT_UNDO_DOC_LIMIT
        ? `Within the ${AUDIT_UNDO_DOC_LIMIT.toLocaleString()}-document undo limit — Undo will be offered if they total under 1 MB.`
        : `Above the ${AUDIT_UNDO_DOC_LIMIT.toLocaleString()}-document undo limit — this cannot be undone.`
      : null;

  return (
    <Modal opened onClose={close} title={title} centered size="md">
      <Stack gap="sm">
        {undoLine && (
          <Text size="xs" c="dimmed">
            {undoLine}
          </Text>
        )}

        {readOnly && (
          <Alert color="yellow" variant="light" role="alert">
            This connection is read-only. Deleting is disabled.
          </Alert>
        )}

        {collationBlocks && (
          <Alert color="yellow" variant="light" role="alert">
            Clear the collation to delete by filter: it would change which documents match.
          </Alert>
        )}

        {hintBlocks && (
          <Alert color="yellow" variant="light" role="alert">
            Clear the hint to delete by filter: a hinted sparse index can show fewer documents than the filter matches.
          </Alert>
        )}

        {isCounting && (
          <Text size="xs" c="dimmed">
            Counting matching documents…
          </Text>
        )}

        {isMulti && (
          <Stack gap={6}>
            <Text size="xs" c="dimmed">
              Type <strong>{collection}</strong> to confirm
            </Text>
            <TextInput
              value={confirm}
              onChange={(e) => setConfirm(e.currentTarget.value)}
              placeholder={collection}
              aria-label={`Type ${collection} to confirm`}
              size="xs"
            />
          </Stack>
        )}

        {(err ?? countErr) && (
          <Alert color="red" variant="light" role="alert">
            {err ?? countErr}
          </Alert>
        )}

        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" size="compact-xs" onClick={close}>
            Cancel
          </Button>
          <SubmitButton
            variant="filled"
            color="red"
            size="compact-xs"
            onClick={() => void handleDelete()}
            disabled={deleteDisabled}
            submitting={loading}
          >
            {loading ? 'Deleting…' : 'Delete'}
          </SubmitButton>
        </Group>
      </Stack>
    </Modal>
  );
}
