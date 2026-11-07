import React from 'react';
import { Alert, Button, Checkbox, Group, List, Modal, NativeSelect, Progress, Stack, Table, Text } from '@mantine/core';
import type {
  CsvColumnMapping,
  CsvColumnType,
  CsvPreview,
  DataImportInput,
  DataImportProgressEvent,
  ImportReport,
} from '@shared/types';
import { api, getErrorMessage } from '../../api/atelier';
import { fixedModalStyles } from '../../components/fixedModal';
import { themeVars } from '../../theme/themeVars';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { SubmitButton } from '../../components/SubmitButton';
import { invalidateSampleSchemaCache } from '../../features/fieldSuggestions/sources/sampleSchemaSource';
import { offerUndo } from './offerUndo';

interface ImportDialogProps {
  connectionId: string;
  dbName: string;
  collection: string;
  /** Known only to the navigator; the workspace host learns it from main's refusal. */
  readOnly?: boolean;
  onClose: () => void;
  /** Called once the import has run, while the dialog stays open on its report. */
  onImported: (report: ImportReport) => void;
  /** Called when a failure stopped the import after some documents had
   *  landed: there is no report to show, but the collection has changed, so
   *  the host refreshes whatever lists it (same role as DocumentEditor's
   *  `onPartialInsert`). */
  onPartialImport: () => void;
  /** Supplied when the opener is gone by first render (context menu). */
  returnFocusTo?: HTMLElement | null;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

// Main settles the format by the same extension test.
const CSV_FILE = /\.csv$/i;

const TYPE_OPTIONS: { value: CsvColumnType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'date', label: 'Date' },
  { value: 'objectId', label: 'ObjectId' },
  { value: 'skip', label: 'Skip' },
];

interface CsvStep {
  path: string;
  preview: CsvPreview;
  columns: CsvColumnMapping[];
}

const FORMATS = [
  { name: 'JSON array', detail: 'Extended JSON documents, canonical or relaxed.' },
  { name: 'JSONL', detail: 'One Extended JSON document on each line, canonical or relaxed.' },
  { name: 'CSV', detail: 'A header row, then one document on each row. You check each column before anything is imported.' },
];

const columnName = (header: string) => header || '(no name)';

/**
 * Import a JSON array, JSONL or CSV file into an existing collection: pick a
 * file, map a CSV's columns to types, run the import, show what landed and
 * what didn't. Props-driven rather than
 * reading the collection workspace, because the navigator hosts it too.
 */
export function ImportDialog({
  connectionId,
  dbName,
  collection,
  readOnly = false,
  onClose,
  onImported,
  onPartialImport,
  returnFocusTo,
}: ImportDialogProps) {
  const close = useDialogFocusReturn(onClose, returnFocusTo);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<ImportReport | null>(null);
  const [progress, setProgress] = React.useState<DataImportProgressEvent | null>(null);
  const [csv, setCsv] = React.useState<CsvStep | null>(null);
  const cancelTokenRef = React.useRef<string | null>(null);
  const unsubscribeRef = React.useRef<(() => void) | null>(null);

  // The import keeps running in main even if this component unmounts (e.g.
  // the workspace tab closes mid-import), so this only stops listening —
  // it never cancels the run.
  React.useEffect(() => () => unsubscribeRef.current?.(), []);

  const startRun = (): string => {
    setError(null);
    setRunning(true);
    setProgress(null);
    const cancelToken = crypto.randomUUID();
    cancelTokenRef.current = cancelToken;
    unsubscribeRef.current = api.data.onImportProgress((evt) => {
      if (evt.cancelToken === cancelToken) setProgress(evt);
    });
    return cancelToken;
  };

  const endRun = () => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    cancelTokenRef.current = null;
    setRunning(false);
    setProgress(null);
  };

  const importPath = async (path: string, cancelToken: string, mapping?: DataImportInput['csv']) => {
    // The field-suggestion sample describes the pre-import documents. This
    // dialog never goes through `useDocumentDialogs`, so it drops it itself.
    const dropStaleSample = () => invalidateSampleSchemaCache(connectionId, dbName, collection);
    let result: ImportReport;
    try {
      result = await api.data.import({
        connectionId, dbName, collection, path, cancelToken, ...(mapping ? { csv: mapping } : {}),
      });
    } catch (err) {
      // A failure that stops the import part-way says how many documents had
      // landed by then (same shape as DocumentEditor's partial insert); a
      // refusal before any batch carries none and leaves the sample alone.
      const details = (err as { details?: unknown }).details;
      const insertedCount =
        details !== null && typeof details === 'object'
          ? (details as { insertedCount?: unknown }).insertedCount
          : undefined;
      if (typeof insertedCount === 'number' && insertedCount > 0) {
        dropStaleSample();
        onPartialImport();
      }
      throw err;
    }
    dropStaleSample();
    setCsv(null);
    setReport(result);
    onImported(result);
    // No toast when nothing landed — `result.auditId` is only set when
    // something did (offerUndo no-ops on undefined either way). Undo removes
    // the imported documents, so it drops the sample again.
    offerUndo(`${plural(result.inserted, 'document')} imported from ${result.fileName}`, result.auditId, () => {
      dropStaleSample();
      onImported(result);
    });
  };

  const chooseAndImport = async () => {
    const cancelToken = startRun();
    try {
      const { path } = await api.app.pickFile('data-import');
      if (path === null) return; // cancelled picker: stay open, nothing ran
      if (CSV_FILE.test(path)) {
        // A CSV stops at its mapping step; `importCsv` runs it.
        const preview = await api.data.previewCsv({ path });
        setReport(null);
        setCsv({
          path,
          preview,
          columns: preview.headers.map((header, i) => ({ header, type: preview.inferred[i] ?? 'string', emptyAsNull: false })),
        });
        return;
      }
      setCsv(null);
      await importPath(path, cancelToken);
    } catch (err) {
      setError(getErrorMessage(err, 'Import failed'));
    } finally {
      endRun();
    }
  };

  // A failed run keeps the mapping step up, so a clashing or mistyped
  // column can be changed and the import tried again.
  const importCsv = async (step: CsvStep) => {
    const cancelToken = startRun();
    try {
      await importPath(step.path, cancelToken, { columns: step.columns });
    } catch (err) {
      setError(getErrorMessage(err, 'Import failed'));
    } finally {
      endRun();
    }
  };

  const setColumn = (index: number, patch: Partial<CsvColumnMapping>) =>
    setCsv((step) => step && { ...step, columns: step.columns.map((c, i) => (i === index ? { ...c, ...patch } : c)) });

  const cancelImport = () => {
    const token = cancelTokenRef.current;
    if (token) void api.data.cancelImport({ token });
  };

  const at = (n: number) => {
    if (report?.format === 'json') return `Index ${n}`;
    return report?.format === 'csv' ? `Row ${n}` : `Line ${n}`;
  };

  return (
    <Modal
      opened
      // The import keeps running in main whatever the dialog does, so it
      // stays up until the report is in.
      onClose={running ? () => {} : close}
      withCloseButton={!running}
      title={`Import into "${collection}"`}
      centered
      // One size in every state, CSV mapping included, so the title, the close
      // button and the footer never move. Lists and tables scroll inside the
      // body; notices take their room from the body, never from the dialog.
      size={780}
      styles={fixedModalStyles(440)}
    >
      <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {report === null ? (
            running ? (
              <Stack gap={themeVars.gapXs}>
                <Text size="sm">
                  Importing {csv?.preview.fileName ?? 'the file'} into {dbName}.{collection}.
                </Text>
                <Progress
                  value={progress && progress.totalBytes > 0 ? Math.min(100, (progress.bytesRead / progress.totalBytes) * 100) : 0}
                  size="sm"
                  aria-label="Import progress"
                />
                <Text size="xs" c="dimmed">
                  {progress ? `${plural(progress.inserted, 'document')} imported` : 'Starting…'}
                </Text>
              </Stack>
            ) : csv ? (
              <Stack gap={themeVars.gapXs}>
                <Text size="xs" c="dimmed">
                  The first {plural(csv.preview.rows.length, 'row')} of {csv.preview.fileName}. Each column&apos;s type
                  was inferred from the whole file; change any before importing. A dotted header nests, and an empty cell
                  leaves its field out unless Empty → null is ticked.
                </Text>
                <Table withTableBorder withColumnBorders fz="xs" aria-label={`Preview of ${csv.preview.fileName}`}>
                  <Table.Thead>
                    <Table.Tr>
                      {csv.columns.map((c, i) => (
                        <Table.Th key={i} miw={120}>
                          <Stack gap={themeVars.gapXs}>
                            <Text size="xs" fw={600} ff="monospace">{columnName(c.header)}</Text>
                            <NativeSelect
                              size="xs"
                              aria-label={`Type of ${columnName(c.header)}`}
                              data={TYPE_OPTIONS}
                              value={c.type}
                              onChange={(e) => setColumn(i, { type: e.currentTarget.value as CsvColumnType })}
                            />
                            <Checkbox
                              size="xs"
                              label="Empty → null"
                              aria-label={`Empty ${columnName(c.header)} as null`}
                              checked={c.emptyAsNull}
                              disabled={c.type === 'skip'}
                              onChange={(e) => setColumn(i, { emptyAsNull: e.currentTarget.checked })}
                            />
                          </Stack>
                        </Table.Th>
                      ))}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {csv.preview.rows.map((row, r) => (
                      <Table.Tr key={r}>
                        {csv.columns.map((_c, i) => <Table.Td key={i}>{row[i] ?? ''}</Table.Td>)}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Stack>
            ) : (
              <Stack gap="xs">
                <Text size="sm">
                  Choose a file to import into {dbName}.{collection}.
                </Text>
                {FORMATS.map((f) => (
                  <div key={f.name}>
                    <Text size="sm" fw={600}>{f.name}</Text>
                    <Text size="xs" c="dimmed">{f.detail}</Text>
                  </div>
                ))}
              </Stack>
            )
          ) : (
            <Stack gap="sm">
              <Text size="sm" role="status">
                {report.cancelled ? 'Cancelled — ' : 'Imported '}
                {plural(report.inserted, 'document')}{report.cancelled ? ' landed' : ''} from {report.fileName}
                {report.failed > 0 ? `; ${plural(report.failed, 'document')} failed.` : '.'}
              </Text>
              {report.errors.length > 0 && (
                <List size="xs" spacing={2} aria-label="Import failures">
                  {report.errors.map((e) => (
                    <List.Item key={e.at}>
                      <Text span size="xs" ff="monospace">{at(e.at)}:</Text> {e.message}
                    </List.Item>
                  ))}
                </List>
              )}
              {report.errorsTruncated && (
                <Text size="xs" c="dimmed">
                  Only the first {report.errors.length} failures are listed.
                </Text>
              )}
            </Stack>
          )}
        </div>
        {readOnly && (
          <Alert color="yellow" variant="light" role="alert" style={{ flex: 'none' }}>
            This connection is read-only. Importing is disabled.
          </Alert>
        )}
        {error && (
          <Alert color="red" variant="light" role="alert" style={{ flex: 'none' }}>
            {error}
          </Alert>
        )}
        {/* "Choose another file…" sits furthest left so it appears without
            pushing Cancel or Import; each button keeps a minimum width that
            fits its longest label, so a label change never moves the one beside it. */}
        <Group justify="flex-end" gap="xs" pt="sm" style={{ flex: 'none', borderTop: `1px solid ${themeVars.border}` }}>
          {csv && !running && (
            <Button variant="default" size="compact-xs" onClick={() => void chooseAndImport()} disabled={readOnly}>
              Choose another file…
            </Button>
          )}
          <Button
            variant="subtle"
            size="compact-xs"
            miw={92}
            onClick={running ? cancelImport : close}
          >
            {running ? 'Cancel import' : report === null ? 'Cancel' : 'Close'}
          </Button>
          <SubmitButton
            size="compact-xs"
            miw={140}
            submitting={running}
            disabled={readOnly}
            // The dialog opens on its one primary action rather than on Close.
            data-autofocus
            onClick={() => void (csv ? importCsv(csv) : chooseAndImport())}
          >
            {running ? 'Importing…' : csv ? 'Import' : report === null ? 'Choose file…' : 'Import another file…'}
          </SubmitButton>
        </Group>
      </Stack>
    </Modal>
  );
}
