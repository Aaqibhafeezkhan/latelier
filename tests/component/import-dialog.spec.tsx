import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notifications } from '@mantine/notifications';
import { render, screen, fireEvent, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { ImportDialog } from '../../src/pages/Workspace/ImportDialog';
import { invalidateSampleSchemaCache } from '../../src/features/fieldSuggestions/sources/sampleSchemaSource';
import { ResultBar } from '../../src/pages/Workspace/ResultBar';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CsvPreview, DataImportInput, DataImportProgressEvent, ImportReport } from '@shared/types';
import type { PickFilePurpose } from '@shared/ipc';

// Mocked at the exact module the dialog imports; the rest stays real because
// ResultBar's tree reaches the suggestion sources through their barrel.
vi.mock('../../src/features/fieldSuggestions/sources/sampleSchemaSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/fieldSuggestions/sources/sampleSchemaSource')>()),
  invalidateSampleSchemaCache: vi.fn(),
}));

const REPORT: ImportReport = {
  fileName: 'people.jsonl',
  format: 'jsonl',
  inserted: 1200,
  failed: 2,
  errors: [
    { at: 3, message: 'invalid document: Unexpected end of JSON input' },
    { at: 9, message: 'E11000 duplicate key error' },
  ],
  errorsTruncated: false,
  cancelled: false,
};

const PREVIEW: CsvPreview = {
  fileName: 'people.csv',
  headers: ['name', 'age', 'addr.city'],
  rows: [['ann', '3', 'Paris'], ['bob', '', 'Oslo']],
  inferred: ['string', 'number', 'string'],
};

const CSV_REPORT: ImportReport = {
  ...REPORT,
  fileName: 'people.csv',
  format: 'csv',
  inserted: 1,
  failed: 1,
  errors: [{ at: 3, message: 'column "age": not a number' }],
};

function mockApi(opts: {
  path?: string | null;
  report?: ImportReport;
  fail?: unknown;
  onImport?: (input: DataImportInput) => void | Promise<void>;
  preview?: CsvPreview;
  previewFail?: unknown;
  undo?: (input: { entryId: string }) => Promise<{ restored: number; skipped: number }>;
} = {}) {
  const pickFile = vi.fn<(purpose: PickFilePurpose) => Promise<{ path: string | null }>>(
    async () => ({ path: opts.path === undefined ? '/home/me/people.jsonl' : opts.path }),
  );
  const importFn = vi.fn<(input: DataImportInput) => Promise<ImportReport>>(async (input) => {
    await opts.onImport?.(input);
    if (opts.fail) throw opts.fail;
    return opts.report ?? REPORT;
  });
  const cancelImport = vi.fn<(input: { token: string }) => Promise<void>>(async () => undefined);
  const previewCsv = vi.fn<(input: { path: string }) => Promise<CsvPreview>>(async () => {
    if (opts.previewFail) throw opts.previewFail;
    return opts.preview ?? PREVIEW;
  });
  const progressListeners = new Set<(evt: DataImportProgressEvent) => void>();
  const onImportProgress = vi.fn((cb: (evt: DataImportProgressEvent) => void) => {
    progressListeners.add(cb);
    return () => progressListeners.delete(cb);
  });
  const emitProgress = (evt: DataImportProgressEvent) => {
    for (const cb of progressListeners) cb(evt);
  };
  installAtelierMock({
    app: { pickFile } as never,
    data: { import: importFn, previewCsv, cancelImport, onImportProgress },
    ...(opts.undo ? { audit: { undo: opts.undo } } : {}),
  });
  return { pickFile, importFn, previewCsv, cancelImport, onImportProgress, emitProgress };
}

function renderDialog(props: Partial<React.ComponentProps<typeof ImportDialog>> = {}) {
  const onClose = vi.fn();
  const onImported = vi.fn();
  const onPartialImport = vi.fn();
  render(
    <ImportDialog
      connectionId="c1"
      dbName="shop"
      collection="people"
      onClose={onClose}
      onImported={onImported}
      onPartialImport={onPartialImport}
      {...props}
    />,
  );
  return { onClose, onImported, onPartialImport };
}

const choose = () => fireEvent.click(screen.getByRole('button', { name: 'Choose file…' }));

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
  vi.mocked(invalidateSampleSchemaCache).mockClear();
});

describe('ImportDialog', () => {
  it('picks a data-import file, imports it and reports what landed and what failed', async () => {
    const { pickFile, importFn } = mockApi();
    const { onImported, onClose } = renderDialog();
    choose();

    expect((await screen.findByRole('status')).textContent).toBe(
      'Imported 1,200 documents from people.jsonl; 2 documents failed.',
    );
    expect(pickFile).toHaveBeenCalledWith('data-import');
    expect(importFn).toHaveBeenCalledWith({
      connectionId: 'c1', dbName: 'shop', collection: 'people', path: '/home/me/people.jsonl', cancelToken: expect.any(String),
    });
    expect(onImported).toHaveBeenCalledWith(REPORT);
    expect(onClose).not.toHaveBeenCalled();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      'Line 3: invalid document: Unexpected end of JSON input',
      'Line 9: E11000 duplicate key error',
    ]);
    expect(screen.queryByText(/Only the first/)).toBeNull();

    // The header's close button shares the name; this is the footer one.
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).find((b) => b.textContent === 'Close')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('labels array failures by index, says when the list is cut short, and omits the failure clause when none failed', async () => {
    mockApi({ report: { ...REPORT, format: 'json', errors: [{ at: 0, message: 'bad' }], errorsTruncated: true } });
    renderDialog();
    choose();
    expect(await screen.findByText('Index 0:')).toBeTruthy();
    expect(screen.getByText('Only the first 1 failures are listed.')).toBeTruthy();

    uninstallAtelierMock();
    mockApi({ report: { ...REPORT, inserted: 1, failed: 0, errors: [] } });
    fireEvent.click(screen.getByRole('button', { name: 'Import another file…' }));
    expect(await screen.findByText('Imported 1 document from people.jsonl.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('a cancelled picker runs nothing and leaves the dialog as it was', async () => {
    const { pickFile, importFn } = mockApi({ path: null });
    const { onImported } = renderDialog();
    choose();
    await vi.waitFor(() => expect(pickFile).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Choose file…' })).toBeTruthy();
    expect(importFn).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ignores a second click while the first pick is still open', async () => {
    const { pickFile } = mockApi();
    let release!: () => void;
    pickFile.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ path: null }); }));
    renderDialog();
    choose();
    fireEvent.click(await screen.findByRole('button', { name: 'Importing…' }));
    expect(pickFile).toHaveBeenCalledTimes(1);
    release();
    expect(await screen.findByRole('button', { name: 'Choose file…' })).toBeTruthy();
  });

  it('shows a refused import in an alert and reports nothing', async () => {
    mockApi({ fail: { code: 'READ_ONLY', message: 'Connection "prod" is read-only.' } });
    const { onImported } = renderDialog();
    choose();
    expect((await screen.findByRole('alert')).textContent).toBe('Connection "prod" is read-only.');
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('disables the import on a connection known to be read-only', () => {
    const { pickFile } = mockApi();
    renderDialog({ readOnly: true });
    expect(screen.getByRole('alert').textContent).toMatch(/read-only/);
    const button = screen.getByRole('button', { name: 'Choose file…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(pickFile).not.toHaveBeenCalled();
  });

  it('shows progress from an emitted event and cancels with the same token import got', async () => {
    let capturedInput: DataImportInput | undefined;
    let releaseImport!: () => void;
    const { cancelImport, emitProgress } = mockApi({
      report: { ...REPORT, cancelled: true, inserted: 500, failed: 0, errors: [] },
      onImport: async (input) => {
        capturedInput = input;
        emitProgress({ cancelToken: input.cancelToken!, processed: 500, inserted: 500, failed: 0, bytesRead: 50, totalBytes: 100 });
        await new Promise<void>((resolve) => { releaseImport = resolve; });
      },
    });
    renderDialog();
    choose();

    expect(await screen.findByRole('progressbar')).toBeTruthy();
    expect(await screen.findByText('500 documents imported')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel import' }));
    expect(cancelImport).toHaveBeenCalledWith({ token: capturedInput!.cancelToken });

    releaseImport();
    expect((await screen.findByRole('status')).textContent).toMatch(/^Cancelled/);
  });

  it('lists the three formats at the start, and opens on its one primary action rather than Close', async () => {
    mockApi();
    renderDialog();
    for (const name of ['JSON array', 'JSONL', 'CSV']) expect(screen.getByText(name)).toBeTruthy();
    const primary = screen.getByRole('button', { name: 'Choose file…' });
    await vi.waitFor(() => expect(document.activeElement).toBe(primary));
  });

  it('holds one dialog height at the start, on the CSV check step and on the report', async () => {
    mockApi({ path: '/home/me/people.csv', report: CSV_REPORT });
    renderDialog();
    const height = () => screen.getByRole('dialog').style.height;
    const start = height();
    expect(start).toContain('440px');
    choose();
    await screen.findByRole('table', { name: 'Preview of people.csv' });
    expect(height()).toBe(start);
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('status');
    expect(height()).toBe(start);
  });

  it('keeps Cancel and the primary button in the footer while running, with Cancel import in the Cancel slot', async () => {
    let releaseImport!: () => void;
    mockApi({ onImport: async () => { await new Promise<void>((resolve) => { releaseImport = resolve; }); } });
    renderDialog();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const primary = screen.getByRole('button', { name: 'Choose file…' });
    expect(cancel.parentElement).toBe(primary.parentElement);
    choose();
    const cancelImport = await screen.findByRole('button', { name: 'Cancel import' });
    const importing = screen.getByRole('button', { name: 'Importing…' });
    expect(cancelImport.parentElement).toBe(importing.parentElement);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    releaseImport();
    await screen.findByRole('status');
  });

  it('puts Choose another file… furthest left, so it appears without moving Cancel or Import', async () => {
    mockApi({ path: '/home/me/people.csv' });
    renderDialog();
    choose();
    await screen.findByRole('table', { name: 'Preview of people.csv' });
    const another = screen.getByRole('button', { name: 'Choose another file…' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const primary = screen.getByRole('button', { name: 'Import' });
    expect(another.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cancel.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('ignores a progress event for another run\'s token', async () => {
    let releaseImport!: () => void;
    const { emitProgress } = mockApi({
      onImport: async () => {
        emitProgress({ cancelToken: 'not-this-run', processed: 9, inserted: 9, failed: 0, bytesRead: 1, totalBytes: 10 });
        await new Promise<void>((resolve) => { releaseImport = resolve; });
      },
    });
    renderDialog();
    choose();
    await screen.findByRole('progressbar');
    expect(screen.queryByText('9 documents imported')).toBeNull();
    releaseImport();
    await screen.findByRole('status');
  });
});

// The field-suggestion sample is cached per collection, so documents that
// landed must drop it or the Update drawer's type warning and the builder's
// suggestions keep describing the pre-import collection.
describe('ImportDialog — field-suggestion sample', () => {
  const invalidate = vi.mocked(invalidateSampleSchemaCache);

  // The Undo toast outlives its test; a leftover alert would answer the next
  // test's `findByRole('alert')`.
  afterEach(() => notifications.clean());

  it('is dropped for this collection once a JSON import has run', async () => {
    mockApi();
    renderDialog();
    choose();
    await screen.findByRole('status');
    expect(invalidate).toHaveBeenCalledExactlyOnceWith('c1', 'shop', 'people');
  });

  it('is dropped once a CSV import has run', async () => {
    mockApi({ path: '/p.csv', report: CSV_REPORT });
    renderDialog();
    choose();
    await screen.findByRole('table');
    expect(invalidate).not.toHaveBeenCalled(); // the mapping step wrote nothing
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('status');
    expect(invalidate).toHaveBeenCalledExactlyOnceWith('c1', 'shop', 'people');
  });

  it('is kept when the import is refused', async () => {
    mockApi({ fail: { code: 'READ_ONLY', message: 'Connection "prod" is read-only.' } });
    renderDialog();
    choose();
    await screen.findByRole('alert');
    expect(invalidate).not.toHaveBeenCalled();
  });

  // ImportService stops part-way on a read or write failure that is not a
  // per-document error, and says how many documents had landed by then.
  it('is dropped when the import fails after some batches landed', async () => {
    mockApi({ fail: { code: 'MONGO_OP', message: 'batch 3 failed', details: { insertedCount: 2400 } } });
    renderDialog();
    choose();
    expect((await screen.findByRole('alert')).textContent).toMatch(/batch 3 failed/);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith('c1', 'shop', 'people');
  });

  it.each([
    ['carries insertedCount: 0', { insertedCount: 0 }],
    ['carries no details', undefined],
    ['carries a non-numeric insertedCount', { insertedCount: '2400' }],
  ])('is kept when a failed import %s', async (_name, details) => {
    mockApi({ fail: { code: 'MONGO_OP', message: 'batch 1 failed', details } });
    renderDialog();
    choose();
    await screen.findByRole('alert');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('is kept when the picker is cancelled', async () => {
    const { pickFile } = mockApi({ path: null });
    renderDialog();
    choose();
    await vi.waitFor(() => expect(pickFile).toHaveBeenCalledTimes(1));
    await screen.findByRole('button', { name: 'Choose file…' });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('is dropped again when Undo removes the imported documents', async () => {
    const undo = vi.fn(async () => ({ restored: 1200, skipped: 0 }));
    mockApi({ report: { ...REPORT, auditId: 'a9' }, undo });
    renderDialog();
    choose();
    await screen.findByRole('status');
    expect(invalidate).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(undo).toHaveBeenCalledWith({ entryId: 'a9' });
    expect(invalidate).toHaveBeenLastCalledWith('c1', 'shop', 'people');
  });
});

// A failure that stops the import after some batches landed has no report to
// show, but the collection did change: the host must re-list it, and the error
// stays on screen so the user still learns the import did not finish.
describe('ImportDialog — failure after some documents landed', () => {
  afterEach(() => notifications.clean());

  it('tells the host to refresh and keeps the error visible', async () => {
    mockApi({ fail: { code: 'MONGO_OP', message: 'batch 3 failed', details: { insertedCount: 2400 } } });
    const { onPartialImport, onImported } = renderDialog();
    choose();
    expect((await screen.findByRole('alert')).textContent).toMatch(/batch 3 failed/);
    expect(onPartialImport).toHaveBeenCalledTimes(1);
    expect(onImported).not.toHaveBeenCalled();
  });

  it('does the same for a CSV import, and keeps the mapping step up', async () => {
    mockApi({ path: '/p.csv', fail: { code: 'MONGO_OP', message: 'batch 2 failed', details: { insertedCount: 1000 } } });
    const { onPartialImport } = renderDialog();
    choose();
    await screen.findByRole('table');
    expect(onPartialImport).not.toHaveBeenCalled(); // the mapping step wrote nothing
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/batch 2 failed/);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(onPartialImport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['carries insertedCount: 0', { insertedCount: 0 }],
    ['carries no details', undefined],
    ['carries a non-numeric insertedCount', { insertedCount: '2400' }],
  ])('leaves the host alone when a failed import %s', async (_name, details) => {
    mockApi({ fail: { code: 'MONGO_OP', message: 'batch 1 failed', details } });
    const { onPartialImport, onImported } = renderDialog();
    choose();
    await screen.findByRole('alert');
    expect(onPartialImport).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
  });
});

describe('ImportDialog — CSV', () => {
  const typeOf = (header: string) => screen.getByRole('combobox', { name: `Type of ${header}` }) as HTMLSelectElement;
  const emptyAsNull = (header: string) => screen.getByRole('checkbox', { name: `Empty ${header} as null` }) as HTMLInputElement;

  it('previews a CSV, lets each column be retyped, and imports with that mapping', async () => {
    const { previewCsv, importFn } = mockApi({ path: '/home/me/people.CSV', report: CSV_REPORT });
    renderDialog();
    choose();

    await screen.findByRole('table', { name: 'Preview of people.csv' });
    expect(previewCsv).toHaveBeenCalledWith({ path: '/home/me/people.CSV' });
    expect(importFn).not.toHaveBeenCalled();
    expect(screen.getByText(/^The first 2 rows of people\.csv\./)).toBeTruthy();
    expect(screen.getAllByRole('row').slice(1).map((r) => r.textContent)).toEqual(['ann3Paris', 'bobOslo']);
    expect(['name', 'age', 'addr.city'].map((h) => typeOf(h).value)).toEqual(['string', 'number', 'string']);
    expect([...typeOf('age').options].map((o) => o.value)).toEqual(['string', 'number', 'boolean', 'date', 'objectId', 'skip']);

    fireEvent.change(typeOf('addr.city'), { target: { value: 'skip' } });
    expect(emptyAsNull('addr.city').disabled).toBe(true);
    fireEvent.click(emptyAsNull('age'));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect((await screen.findByRole('status')).textContent).toBe('Imported 1 document from people.csv; 1 document failed.');
    expect(importFn).toHaveBeenCalledWith({
      connectionId: 'c1', dbName: 'shop', collection: 'people', path: '/home/me/people.CSV', cancelToken: expect.any(String),
      csv: {
        columns: [
          { header: 'name', type: 'string', emptyAsNull: false },
          { header: 'age', type: 'number', emptyAsNull: true },
          { header: 'addr.city', type: 'skip', emptyAsNull: false },
        ],
      },
    });
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Row 3: column "age": not a number']);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('button', { name: 'Import another file…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose another file…' })).toBeNull();
  });

  it('names a header-less column and shows a short row\'s missing cells as blank', async () => {
    mockApi({ path: '/p.csv', preview: { fileName: 'p.csv', headers: ['', 'b'], rows: [['1']], inferred: ['number', 'string'] } });
    renderDialog();
    choose();
    expect((await screen.findByRole('combobox', { name: 'Type of (no name)' }) as HTMLSelectElement).value).toBe('number');
    expect(screen.getAllByRole('row')[1]!.querySelectorAll('td')).toHaveLength(2);
  });

  it('keeps the mapping step up when the import is refused, so it can be fixed and retried', async () => {
    const { importFn } = mockApi({ path: '/p.csv', fail: { code: 'VALIDATION', message: 'column "addr.city" writes the same field as another column — skip one of them' } });
    renderDialog();
    choose();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/same field/);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(typeOf('age').value).toBe('number');

    uninstallAtelierMock();
    const retry = mockApi({ path: '/p.csv', report: CSV_REPORT });
    fireEvent.change(typeOf('addr.city'), { target: { value: 'skip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(retry.importFn.mock.calls[0]![0].csv!.columns[2]).toEqual({ header: 'addr.city', type: 'skip', emptyAsNull: false });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a preview that fails to read in an alert and imports nothing', async () => {
    const { importFn } = mockApi({ path: '/p.csv', previewFail: { code: 'VALIDATION', message: 'the CSV file is empty' } });
    renderDialog();
    choose();
    expect((await screen.findByRole('alert')).textContent).toBe('the CSV file is empty');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('button', { name: 'Choose file…' })).toBeTruthy();
    expect(importFn).not.toHaveBeenCalled();
  });

  it('drops the mapping step when another file is chosen, and a report when a CSV is chosen after it', async () => {
    const { importFn } = mockApi({ path: '/p.csv' });
    renderDialog();
    choose();
    await screen.findByRole('table');

    uninstallAtelierMock();
    const json = mockApi({ path: '/home/me/people.jsonl' });
    fireEvent.click(screen.getByRole('button', { name: 'Choose another file…' }));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(json.importFn.mock.calls[0]![0]).not.toHaveProperty('csv');
    expect(importFn).not.toHaveBeenCalled();

    uninstallAtelierMock();
    mockApi({ path: '/p.csv' });
    fireEvent.click(screen.getByRole('button', { name: 'Import another file…' }));
    await screen.findByRole('table');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('drops the mapping step when another file is chosen, even if that import is refused', async () => {
    mockApi({ path: '/p.csv' });
    renderDialog();
    choose();
    await screen.findByRole('table');

    uninstallAtelierMock();
    mockApi({ path: '/home/me/people.jsonl', fail: { code: 'READ_ONLY', message: 'read-only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose another file…' }));
    expect((await screen.findByRole('alert')).textContent).toBe('read-only');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('button', { name: 'Choose file…' })).toBeTruthy();
  });

  it('keeps the current mapping when the picker is cancelled from it', async () => {
    mockApi({ path: '/p.csv' });
    renderDialog();
    choose();
    await screen.findByRole('table');
    fireEvent.change(typeOf('age'), { target: { value: 'string' } });

    uninstallAtelierMock();
    const { pickFile } = mockApi({ path: null });
    fireEvent.click(screen.getByRole('button', { name: 'Choose another file…' }));
    await vi.waitFor(() => expect(pickFile).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole('combobox', { name: 'Type of age' }) as HTMLSelectElement).value).toBe('string');
  });
});

describe('ResultBar — Import documents', () => {
  beforeEach(() => mockApi({ report: { ...REPORT, failed: 0, errors: [] } }));

  it('opens the import dialog on this collection and re-runs the query once documents landed', async () => {
    const actions = emptyWorkspaceActions();
    render(
      <CollectionWorkspaceProvider
        state={{ view: 'Tree', builder: { projection: [], sort: '', limit: '' }, queryRaw: '{}', page: 0, pageSize: 50, activeBuilderTab: 'Builder' }}
        actions={actions}
        meta={emptyWorkspaceMeta({ collection: 'people' })}
      >
        <ResultBar />
      </CollectionWorkspaceProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Documents' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Import documents…/ }));
    expect(await screen.findByRole('dialog', { name: /Import into "people"/ })).toBeTruthy();
    expect(actions.run).not.toHaveBeenCalled();
    choose();
    await screen.findByRole('status');
    expect(actions.run).toHaveBeenCalledTimes(1);
  });

  // The failure carries no report, so the result list is re-run from the
  // partial-import callback instead of `onImported`.
  it('re-runs the query when the import fails after some documents landed', async () => {
    uninstallAtelierMock();
    mockApi({ fail: { code: 'MONGO_OP', message: 'batch 3 failed', details: { insertedCount: 2400 } } });
    const actions = emptyWorkspaceActions();
    render(
      <CollectionWorkspaceProvider
        state={{ view: 'Tree', builder: { projection: [], sort: '', limit: '' }, queryRaw: '{}', page: 0, pageSize: 50, activeBuilderTab: 'Builder' }}
        actions={actions}
        meta={emptyWorkspaceMeta({ collection: 'people' })}
      >
        <ResultBar />
      </CollectionWorkspaceProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Documents' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Import documents…/ }));
    await screen.findByRole('dialog', { name: /Import into "people"/ });
    choose();
    expect((await screen.findByRole('alert')).textContent).toMatch(/batch 3 failed/);
    expect(actions.run).toHaveBeenCalledTimes(1);
  });
});
