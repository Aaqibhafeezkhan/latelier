import React from 'react';
import { Button, Checkbox, Group, Modal, SegmentedControl, Stack } from '@mantine/core';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { SubmitButton } from '../../components/SubmitButton';
import { api, getErrorMessage } from '../../api/atelier';
import { notify } from '../../theme/notifications';
import { useCollectionWorkspace } from './context';
import { EMPTY_DOCUMENTS } from './resultSelection';
import { compileFindOptions, findProblem } from './builder';
import { deriveColumns, resolveColumns } from './views/tableColumns';
import {
  exportColumnsFrom,
  exportFileExtension,
  serializeCsv,
  serializeJsonArray,
  serializeJsonl,
  type ExportFormat,
} from './exportFormat';

interface ExportDialogProps {
  onClose: () => void;
}

type ExportScope = 'page' | 'all';

const FORMAT_DATA: { value: ExportFormat; label: string }[] = [
  { value: 'json', label: 'JSON array' },
  { value: 'jsonl', label: 'JSONL' },
  { value: 'csv', label: 'CSV' },
];

// Mirrors `DEFAULT_EXPORT_CAP` in `electron/mongo/QueryService.ts` — the
// renderer has no import path into main, so this is a display-only copy of
// the same number, not the enforced limit itself.
const EXPORT_ALL_CAP = 100_000;

/**
 * Export the current result page, or every matching document up to a hard
 * cap via `query:export` (main streams the find cursor straight to a file,
 * since the renderer can't page past `find`'s own 1000-document limit).
 * Reads the page's documents and the Fields control's visible-column config
 * straight off `useCollectionWorkspace()`, same as `FieldsControl` itself,
 * so this needs no prop plumbing from `ResultBar`.
 *
 * Format defaults to Canonical EJSON with a single Relaxed checkbox, and CSV
 * columns are exactly the Fields control's visible (ordered, non-hidden,
 * including computed) field list — for both scopes.
 */
export function ExportDialog({ onClose }: ExportDialogProps) {
  const { state, meta } = useCollectionWorkspace();
  const close = useDialogFocusReturn(onClose);
  const documents = state.lastRun?.documents ?? EMPTY_DOCUMENTS;
  const [scope, setScope] = React.useState<ExportScope>('page');
  const [format, setFormat] = React.useState<ExportFormat>('json');
  const [relaxed, setRelaxed] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // Same gate as the Run button (W03) — an "All matching" export sends the
  // committed `queryRaw` straight to the driver, so it must be at least as
  // runnable as a Run click.
  const canRunAll = findProblem(state) === null;
  const canExport = scope === 'page' ? documents.length > 0 : canRunAll;

  const columns = () =>
    exportColumnsFrom(resolveColumns(deriveColumns(documents), state.columnConfig));

  const exportPage = async () => {
    const content =
      format === 'csv'
        ? serializeCsv(documents, columns())
        : format === 'jsonl'
          ? serializeJsonl(documents, relaxed)
          : serializeJsonArray(documents, relaxed);
    const defaultName = `${meta.collection}.${exportFileExtension(format)}`;
    const { path } = await api.app.saveFile({ defaultName, content });
    // `null` is a cancelled save panel: stay open with the format choice
    // intact so the user can just try again.
    if (path !== null) close();
  };

  const exportAll = async () => {
    const { sort, projection, limit, collation, hint, readPreference } = compileFindOptions(state.builder);
    const defaultName = `${meta.collection}.${exportFileExtension(format)}`;
    const { path, written, truncated } = await api.query.export({
      connectionId: meta.connectionId,
      dbName: meta.dbName,
      collection: meta.collection,
      filter: state.queryRaw,
      sort,
      projection,
      collation,
      hint,
      readPreference,
      limit: limit ?? undefined,
      format,
      relaxed,
      columns: format === 'csv' ? columns() : undefined,
      defaultName,
    });
    if (path === null) return; // cancelled save panel — stay open
    close();
    if (truncated) {
      notify.warning(
        `Only the first ${EXPORT_ALL_CAP.toLocaleString()} matching documents were exported (${written.toLocaleString()} written).`,
      );
    }
  };

  const handleExport = async () => {
    if (!canExport || saving) return;
    setSaving(true);
    try {
      await (scope === 'page' ? exportPage() : exportAll());
    } catch (err) {
      notify.error(`Export failed: ${getErrorMessage(err, 'the file could not be written')}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened onClose={close} title="Export documents" size={380} centered>
      <Stack gap={12}>
        <SegmentedControl
          size="xs"
          fullWidth
          value={scope}
          onChange={(v) => setScope(v as ExportScope)}
          data={[
            { value: 'page', label: `Current page (${documents.length.toLocaleString()})` },
            { value: 'all', label: `All matching (up to ${EXPORT_ALL_CAP.toLocaleString()})` },
          ]}
        />

        <SegmentedControl
          size="xs"
          fullWidth
          value={format}
          onChange={(v) => setFormat(v as ExportFormat)}
          data={FORMAT_DATA}
        />

        {format !== 'csv' && (
          <Checkbox
            size="xs"
            label="Relaxed EJSON (friendlier to other tools; not lossless for every type)"
            checked={relaxed}
            onChange={(e) => setRelaxed(e.currentTarget.checked)}
          />
        )}

        <Group justify="flex-end" gap={8} mt={4}>
          <Button variant="default" size="xs" onClick={close}>
            Cancel
          </Button>
          <SubmitButton size="xs" submitting={saving} disabled={!canExport} onClick={() => void handleExport()}>
            {saving ? 'Exporting…' : 'Export…'}
          </SubmitButton>
        </Group>
      </Stack>
    </Modal>
  );
}
