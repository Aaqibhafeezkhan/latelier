import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { ResultBar } from '../../src/pages/Workspace/ResultBar';
import { notify } from '../../src/theme/notifications';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionWorkspaceMeta } from '../../src/pages/Workspace/context';
import type { CollectionTabState } from '@shared/types';

beforeEach(() => {
  installAtelierMock();
});
afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function makeState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun: {
      documents: [
        { _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'Ann, A.', age: { $numberInt: '30' } },
      ],
      durationMs: 5,
      ranAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

function renderBar(
  stateOverrides: Partial<CollectionTabState> = {},
  metaOverrides: Partial<CollectionWorkspaceMeta> = {},
) {
  const actions = emptyWorkspaceActions();
  const meta = emptyWorkspaceMeta(metaOverrides);
  render(
    <CollectionWorkspaceProvider state={makeState(stateOverrides)} actions={actions} meta={meta}>
      <ResultBar />
    </CollectionWorkspaceProvider>,
  );
  return { actions };
}

async function openExportDialog() {
  const trigger = await screen.findByRole('button', { name: 'Documents' });
  fireEvent.click(trigger);
  const item = await screen.findByRole('menuitem', { name: /Export…/ });
  fireEvent.click(item);
  return screen.findByRole('dialog', { name: /Export documents/ });
}

describe('ResultBar — Export', () => {
  it('is absent in a read-only provider, along with the rest of the Documents menu', () => {
    renderBar({}, { isReadOnly: true });
    expect(screen.queryByRole('button', { name: 'Documents' })).toBeNull();
  });

  it('is disabled with no run yet (no Export…, matching Delete all matching)', async () => {
    renderBar({ lastRun: undefined });
    const trigger = await screen.findByRole('button', { name: 'Documents' });
    fireEvent.click(trigger);
    const item = await screen.findByRole('menuitem', { name: /Export…/ });
    expect((item as HTMLButtonElement).disabled).toBe(true);
  });

  it('defaults to Canonical JSON and writes the page via api.app.saveFile', async () => {
    const saveFile = vi.fn<(input: { defaultName?: string; content: string }) => Promise<{ path: string | null }>>(
      async () => ({ path: '/tmp/orders.json' }),
    );
    installAtelierMock({ app: { saveFile } as never });
    renderBar({}, { collection: 'orders' });

    await openExportDialog();
    fireEvent.click(screen.getByRole('button', { name: /^Export…$/ }));

    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const { defaultName, content } = saveFile.mock.calls[0]![0];
    expect(defaultName).toBe('orders.json');
    // Canonical by default — the wire shape, unmodified.
    expect(JSON.parse(content)).toEqual([
      { _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'Ann, A.', age: { $numberInt: '30' } },
    ]);
  });

  it('keeps the dialog open when the save panel is cancelled', async () => {
    const saveFile = vi.fn(async () => ({ path: null }));
    installAtelierMock({ app: { saveFile } as never });
    renderBar({}, { collection: 'orders' });

    await openExportDialog();
    fireEvent.click(screen.getByRole('button', { name: /^Export…$/ }));

    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect((screen.getByRole('button', { name: /^Export…$/ }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByRole('dialog', { name: 'Export documents' })).not.toBeNull();
  });

  it('keeps the button focusable while exporting, and ignores a second click', async () => {
    let finish: (v: { path: string | null }) => void = () => {};
    const saveFile = vi.fn(() => new Promise<{ path: string | null }>((resolve) => (finish = resolve)));
    installAtelierMock({ app: { saveFile } as never });
    renderBar({}, { collection: 'orders' });

    await openExportDialog();
    fireEvent.click(screen.getByRole('button', { name: /^Export…$/ }));
    const busy = (await screen.findByRole('button', { name: /^Exporting…$/ })) as HTMLButtonElement;
    // A real `disabled` gets Chromium to blur the focused button out of the dialog.
    expect(busy.disabled).toBe(false);
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(busy);
    expect(saveFile).toHaveBeenCalledTimes(1);

    finish({ path: null });
    await screen.findByRole('button', { name: /^Export…$/ });
  });

  it('reports a failed write instead of swallowing it, and stays open', async () => {
    const saveFile = vi.fn(async () => {
      throw new Error('EACCES: permission denied');
    });
    installAtelierMock({ app: { saveFile } as never });
    const error = vi.spyOn(notify, 'error').mockImplementation(() => undefined as never);
    renderBar({}, { collection: 'orders' });

    await openExportDialog();
    fireEvent.click(screen.getByRole('button', { name: /^Export…$/ }));

    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error.mock.calls[0]![0]).toMatch(/Export failed: .*permission denied/);
    expect(screen.queryByRole('dialog', { name: 'Export documents' })).not.toBeNull();
    error.mockRestore();
  });

  it('writes CSV using the visible Fields control columns, quoting a field with a comma', async () => {
    const saveFile = vi.fn<(input: { defaultName?: string; content: string }) => Promise<{ path: string | null }>>(
      async () => ({ path: '/tmp/orders.csv' }),
    );
    installAtelierMock({ app: { saveFile } as never });
    renderBar({}, { collection: 'orders' });

    await openExportDialog();
    fireEvent.click(screen.getByRole('radio', { name: 'CSV' }));
    fireEvent.click(screen.getByRole('button', { name: /^Export…$/ }));

    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const { defaultName, content } = saveFile.mock.calls[0]![0];
    expect(defaultName).toBe('orders.csv');
    // Column order is the Fields control's derived order: `_id` first, then
    // the rest alphabetized (`deriveColumns`).
    expect(content).toBe('_id,age,name\n507f1f77bcf86cd799439011,30,"Ann, A."\n');
  });

  it('a Relaxed EJSON export unwraps the int sentinel', async () => {
    const saveFile = vi.fn<(input: { defaultName?: string; content: string }) => Promise<{ path: string | null }>>(
      async () => ({ path: '/tmp/orders.json' }),
    );
    installAtelierMock({ app: { saveFile } as never });
    renderBar();

    await openExportDialog();
    fireEvent.click(screen.getByRole('checkbox', { name: /Relaxed EJSON/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Export…$/ }));

    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const { content } = saveFile.mock.calls[0]![0];
    expect(JSON.parse(content)[0].age).toBe(30);
  });
});

describe('ResultBar — Export all matching', () => {
  it('sends the committed filter/sort/limit and closes on success', async () => {
    const exportFn = vi.fn<(input: Record<string, unknown>) => Promise<{ path: string | null; written: number; truncated: boolean }>>(
      async () => ({ path: '/tmp/orders.json', written: 3, truncated: false }),
    );
    installAtelierMock({ query: { export: exportFn } as never });
    renderBar(
      { queryRaw: '{"active":true}', builder: { projection: [], sort: '{"n":1}', limit: '50' } },
      { collection: 'orders', connectionId: 'conn-1', dbName: 'app' },
    );

    await openExportDialog();
    fireEvent.click(screen.getByRole('radio', { name: /All matching/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Export…$/ }));

    await vi.waitFor(() => expect(exportFn).toHaveBeenCalledTimes(1));
    const input = exportFn.mock.calls[0]![0];
    expect(input).toMatchObject({
      connectionId: 'conn-1',
      dbName: 'app',
      collection: 'orders',
      filter: '{"active":true}',
      sort: '{"n":1}',
      limit: 50,
      format: 'json',
    });
    await vi.waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Export documents' })).toBeNull(),
    );
  });

  it('sends a filter padded with Unicode spaces as the trimmed text find sends', async () => {
    const exportFn = vi.fn<(input: Record<string, unknown>) => Promise<{ path: string | null; written: number; truncated: boolean }>>(
      async () => ({ path: '/tmp/orders.json', written: 1, truncated: false }),
    );
    installAtelierMock({ query: { export: exportFn } as never });
    renderBar({ queryRaw: '\u00a0{"active":true}\u00a0' });

    await openExportDialog();
    fireEvent.click(screen.getByRole('radio', { name: /All matching/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Export…$/ }));

    await vi.waitFor(() => expect(exportFn).toHaveBeenCalledTimes(1));
    expect(exportFn.mock.calls[0]![0].filter).toBe('{"active":true}');
  });

  // W14 §9 — a collation changes which documents match, so the export of
  // "all matching" has to carry it; maxTimeMS is a find-only option.
  it('sends the collation, hint and read preference with the filter', async () => {
    const exportFn = vi.fn<(input: Record<string, unknown>) => Promise<{ path: string | null; written: number; truncated: boolean }>>(
      async () => ({ path: '/tmp/orders.json', written: 2, truncated: false }),
    );
    installAtelierMock({ query: { export: exportFn } as never });
    renderBar({
      queryRaw: '{"name":"a"}',
      builder: {
        projection: [],
        sort: '',
        limit: '',
        collation: ' {"locale":"en","strength":2} ',
        hint: '_id_',
        maxTimeMS: '500',
        readPreference: 'nearest',
      },
    });

    await openExportDialog();
    fireEvent.click(screen.getByRole('radio', { name: /All matching/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Export…$/ }));

    await vi.waitFor(() => expect(exportFn).toHaveBeenCalledTimes(1));
    const input = exportFn.mock.calls[0]![0];
    expect(input).toMatchObject({
      filter: '{"name":"a"}',
      collation: '{"locale":"en","strength":2}',
      hint: '_id_',
      readPreference: 'nearest',
    });
    expect(input).not.toHaveProperty('maxTimeMS');
  });

  it('warns when the export hit the cap, naming how many were written', async () => {
    const exportFn = vi.fn(async () => ({ path: '/tmp/orders.json', written: 100_000, truncated: true }));
    installAtelierMock({ query: { export: exportFn } as never });
    const warning = vi.spyOn(notify, 'warning').mockImplementation(() => undefined as never);
    renderBar({}, { collection: 'orders' });

    await openExportDialog();
    fireEvent.click(screen.getByRole('radio', { name: /All matching/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Export…$/ }));

    await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
    expect(warning.mock.calls[0]![0]).toMatch(/100,000/);
    warning.mockRestore();
  });

  it('keeps the dialog open when the save panel is cancelled', async () => {
    const exportFn = vi.fn(async () => ({ path: null, written: 0, truncated: false }));
    installAtelierMock({ query: { export: exportFn } as never });
    renderBar({}, { collection: 'orders' });

    await openExportDialog();
    fireEvent.click(screen.getByRole('radio', { name: /All matching/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Export…$/ }));

    await vi.waitFor(() => expect(exportFn).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect((screen.getByRole('button', { name: /^Export…$/ }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByRole('dialog', { name: 'Export documents' })).not.toBeNull();
  });

  it('is disabled when the current filter is unrunnable, same gate as Run', async () => {
    const exportFn = vi.fn(async () => ({ path: '/tmp/orders.json', written: 0, truncated: false }));
    installAtelierMock({ query: { export: exportFn } as never });
    renderBar({ queryRaw: 'not json' }, { collection: 'orders' });

    await openExportDialog();
    fireEvent.click(screen.getByRole('radio', { name: /All matching/ }));

    expect((screen.getByRole('button', { name: /^Export…$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^Export…$/ }));
    expect(exportFn).not.toHaveBeenCalled();
  });

  it('sends CSV columns from the Fields control, same as the page export', async () => {
    const exportFn = vi.fn<(input: { columns?: unknown }) => Promise<{ path: string | null; written: number; truncated: boolean }>>(
      async () => ({ path: '/tmp/orders.csv', written: 1, truncated: false }),
    );
    installAtelierMock({ query: { export: exportFn } as never });
    renderBar({}, { collection: 'orders' });

    await openExportDialog();
    fireEvent.click(screen.getByRole('radio', { name: /All matching/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'CSV' }));
    fireEvent.click(screen.getByRole('button', { name: /^Export…$/ }));

    await vi.waitFor(() => expect(exportFn).toHaveBeenCalledTimes(1));
    const input = exportFn.mock.calls[0]![0];
    expect(input.columns).toEqual([
      { header: '_id', path: '_id' },
      { header: 'age', path: 'age' },
      { header: 'name', path: 'name' },
    ]);
  });
});
