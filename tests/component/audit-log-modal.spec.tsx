import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import { CommandPaletteRoot, usePaletteApi, _resetPaletteStoreForTests } from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { GlobalCommands } from '../../src/commands/GlobalCommands';
import { SettingsProvider } from '../../src/pages/SettingsContext';
import { commandRegistry } from '../../src/commands/registry';
import { setFocusedConnectionId } from '../../src/state/focusedConnection';
import { AuditLogModal } from '../../src/pages/AuditLogModal';
import type { AuditEntry, AuditListInput, ConnectionSummary } from '../../shared/types';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { invalidateSampleSchemaCache } from '../../src/features/fieldSuggestions/sources/sampleSchemaSource';
import { invalidateSchemaEnumCache } from '../../src/features/fieldSuggestions/sources/schemaEnumSource';

// Spied so each write path can be checked for dropping the cached enum suggestions.
vi.mock('../../src/features/fieldSuggestions/sources/schemaEnumSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/fieldSuggestions/sources/schemaEnumSource')>()),
  invalidateSchemaEnumCache: vi.fn(),
}));

// Mocked at the exact module AuditLogModal imports; the rest stays real
// because the palette tree reaches the suggestion sources through their barrel.
vi.mock('../../src/features/fieldSuggestions/sources/sampleSchemaSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/fieldSuggestions/sources/sampleSchemaSource')>()),
  invalidateSampleSchemaCache: vi.fn(),
}));

const CONNECTIONS = [
  { id: 'c1', name: 'Local' },
  { id: 'c2', name: 'Staging' },
] as ConnectionSummary[];

const ENTRY_BASE = { connectionId: 'c1', dbName: 'shop', reversible: false, durationMs: 4 };
const ENTRIES: AuditEntry[] = [
  {
    ...ENTRY_BASE,
    id: 'e1',
    collection: 'orders',
    op: 'deleteMany',
    summary: { op: 'deleteMany', filter: '{"status":"void"}', deletedCount: 40 },
    outcome: 'ok',
    ranAt: '2026-09-01T10:00:00.000Z',
  },
  {
    ...ENTRY_BASE,
    id: 'e2',
    collection: 'orders',
    op: 'insertMany',
    summary: { op: 'insertMany', insertedCount: 3 },
    outcome: 'partial',
    errorCode: 'CONFLICT',
    ranAt: '2026-09-01T09:00:00.000Z',
  },
  {
    ...ENTRY_BASE,
    id: 'e3',
    collection: 'orders',
    op: 'collectionRename',
    summary: { op: 'collectionRename', fromName: 'orders', toName: 'orders_old' },
    outcome: 'error',
    errorCode: 'UNAUTHORIZED',
    ranAt: '2026-09-01T08:00:00.000Z',
  },
  {
    ...ENTRY_BASE,
    id: 'e4',
    collection: 'people',
    op: 'import',
    summary: { op: 'import', fileName: 'people.json', format: 'jsonl', insertedCount: 8, failedCount: 2 },
    outcome: 'partial',
    ranAt: '2026-09-01T07:00:00.000Z',
  },
];

function mockApi(entries: AuditEntry[] = ENTRIES) {
  const list = vi.fn<(input: AuditListInput) => Promise<AuditEntry[]>>(async () => entries);
  installAtelierMock({ conn: { list: async () => CONNECTIONS }, audit: { list } });
  return list;
}

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

afterEach(() => {
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  setFocusedConnectionId(null);
  uninstallAtelierMock();
  vi.restoreAllMocks();
  vi.mocked(invalidateSampleSchemaCache).mockClear();
  vi.mocked(invalidateSchemaEnumCache).mockClear();
});

describe('AuditLogModal', () => {
  it('opens from the command palette on the Focused Tab\'s Connection', async () => {
    const list = mockApi([]);
    act(() => setFocusedConnectionId('c2'));
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <PaletteContextProvider>
          <SettingsProvider>
            <CommandPaletteRoot>
              <GlobalCommands />
              <ToggleButton />
            </CommandPaletteRoot>
          </SettingsProvider>
        </PaletteContextProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('toggle'));
    fireEvent.click(screen.getByText('Open audit log'));

    expect(await screen.findByText('No Operations recorded.')).toBeTruthy();
    expect(list).toHaveBeenCalledWith({ connectionId: 'c2', dbName: undefined, collection: undefined });
    await waitFor(() => expect((screen.getByLabelText('Connection') as HTMLSelectElement).value).toBe('c2'));
  });

  it('falls back to the first Connection when no tab is focused', async () => {
    const list = mockApi();
    render(<AuditLogModal initialConnectionId={null} onClose={() => {}} />);

    await waitFor(() => expect(list).toHaveBeenCalledWith({ connectionId: 'c1', dbName: undefined, collection: undefined }));
  });

  it('re-lists for the picked Connection and the typed database and collection', async () => {
    const list = mockApi();
    render(<AuditLogModal initialConnectionId="c1" onClose={() => {}} />);
    await screen.findByText('shop.orders → orders_old');

    fireEvent.change(await screen.findByLabelText('Connection'), { target: { value: 'c2' } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ connectionId: 'c2', dbName: undefined, collection: undefined }));

    fireEvent.change(screen.getByLabelText('Database'), { target: { value: ' shop ' } });
    fireEvent.change(screen.getByLabelText('Collection'), { target: { value: 'orders' } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ connectionId: 'c2', dbName: 'shop', collection: 'orders' }));
  });

  it('shows each Operation read-only, with its target, counts and outcome', async () => {
    mockApi();
    render(<AuditLogModal initialConnectionId="c1" onClose={() => {}} />);

    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText('shop.orders')).toBeTruthy();
    expect(within(rows[0]!).getByText('{"status":"void"} · 40 deleted')).toBeTruthy();
    expect(within(rows[0]!).getByText('Done')).toBeTruthy();
    expect(within(rows[1]!).getByText('3 inserted')).toBeTruthy();
    expect(within(rows[1]!).getByText('Partial (CONFLICT)')).toBeTruthy();
    expect(within(rows[2]!).getByText('Failed (UNAUTHORIZED)')).toBeTruthy();
    expect(within(rows[3]!).getByText('people.json (JSONL) · 8 inserted · 2 failed')).toBeTruthy();
    expect(within(rows[3]!).getByText('Partial')).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent?.trim()).filter(Boolean)).toEqual(['Close']);
  });

  it('surfaces a failed load instead of an empty log', async () => {
    installAtelierMock({
      conn: { list: async () => CONNECTIONS },
      audit: { list: async () => Promise.reject({ code: 'DB_ERROR', message: 'database is locked' }) },
    });
    render(<AuditLogModal initialConnectionId="c1" onClose={() => {}} />);

    expect((await screen.findByRole('alert')).textContent).toBe('database is locked');
    expect(screen.queryByText('No Operations recorded.')).toBeNull();
  });

  it('does not show the previous Connection\'s rows while the new one is loading', async () => {
    // Deferred: c1's list resolves immediately, c2's stays pending until we
    // resolve it — long enough to inspect the table mid-load.
    let resolveC2!: (rows: AuditEntry[]) => void;
    const list = vi.fn<(input: AuditListInput) => Promise<AuditEntry[]>>((input) => {
      if (input.connectionId === 'c2') return new Promise((resolve) => (resolveC2 = resolve));
      return Promise.resolve(ENTRIES);
    });
    installAtelierMock({ conn: { list: async () => CONNECTIONS }, audit: { list } });
    render(<AuditLogModal initialConnectionId="c1" onClose={() => {}} />);
    await screen.findByText('shop.orders → orders_old');

    fireEvent.change(await screen.findByLabelText('Connection'), { target: { value: 'c2' } });

    // c1's rows must not still be on screen under c2's label while c2 loads.
    await waitFor(() => expect(screen.queryByText('shop.orders → orders_old')).toBeNull());

    resolveC2([]);
    expect(await screen.findByText('No Operations recorded.')).toBeTruthy();
  });

  it('clears the stale table when a re-list fails after a successful one', async () => {
    let failNext = false;
    const list = vi.fn<(input: AuditListInput) => Promise<AuditEntry[]>>(async () => {
      if (failNext) return Promise.reject({ code: 'DB_ERROR', message: 'database is locked' });
      return ENTRIES;
    });
    installAtelierMock({ conn: { list: async () => CONNECTIONS }, audit: { list } });
    render(<AuditLogModal initialConnectionId="c1" onClose={() => {}} />);
    await screen.findByText('shop.orders → orders_old');

    failNext = true;
    fireEvent.change(screen.getByLabelText('Database'), { target: { value: 'shop2' } });

    expect((await screen.findByRole('alert')).textContent).toBe('database is locked');
    // The old Connection's table must not still be showing alongside the error.
    expect(screen.queryByText('shop.orders → orders_old')).toBeNull();
  });

  describe('Revert', () => {
    const REVERSIBLE: AuditEntry = {
      ...ENTRY_BASE,
      id: 'r1',
      collection: 'orders',
      op: 'deleteOne',
      summary: { op: 'deleteOne', filter: '{"_id":1}', deletedCount: 1 },
      outcome: 'ok',
      reversible: true,
      ranAt: '2026-09-01T11:00:00.000Z',
    };

    it('is offered only on entries that can still be undone, and re-lists after undoing', async () => {
      let entries: AuditEntry[] = [REVERSIBLE, ...ENTRIES];
      const list = vi.fn(async () => entries);
      const undo = vi.fn(async () => {
        entries = [{ ...REVERSIBLE, reversible: false, undoneAt: '2026-09-01T11:01:00.000Z' }, ...ENTRIES];
        return { restored: 1, skipped: 0 };
      });
      installAtelierMock({ conn: { list: async () => CONNECTIONS }, audit: { list, undo } });
      render(<AuditLogModal initialConnectionId="c1" onClose={() => {}} />);

      const rows = (await screen.findAllByRole('row')).slice(1);
      expect(within(rows[0]!).getByRole('button', { name: 'Revert' })).toBeTruthy();
      expect(screen.getAllByRole('button', { name: 'Revert' })).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: 'Revert' }));

      await waitFor(() => expect(screen.queryByRole('button', { name: 'Revert' })).toBeNull());
      expect(undo).toHaveBeenCalledWith({ entryId: 'r1' });
      expect(within((await screen.findAllByRole('row'))[1]!).getByText('Undone')).toBeTruthy();
    });

    // Undo rewrites documents, and the entry may be a rename, drop or import
    // with no single collection, so the whole Connection's samples go. The
    // entry names its Connection; the picker can have moved on by the time
    // the request settles.
    it('drops the field-suggestion samples of the entry\'s own Connection once the Revert lands', async () => {
      const other: AuditEntry = { ...REVERSIBLE, connectionId: 'c2' };
      installAtelierMock({
        conn: { list: async () => CONNECTIONS },
        audit: { list: async () => [other], undo: async () => ({ restored: 1, skipped: 0 }) },
      });
      render(<AuditLogModal initialConnectionId="c1" onClose={() => {}} />);

      fireEvent.click(await screen.findByRole('button', { name: 'Revert' }));

      await waitFor(() => expect(invalidateSampleSchemaCache).toHaveBeenCalledExactlyOnceWith('c2'));
      await waitFor(() => expect(invalidateSchemaEnumCache).toHaveBeenCalledExactlyOnceWith('c2'));
    });

    it('drops them when the Revert is refused as well: the request may have restored documents before failing, and an extra resample is harmless', async () => {
      installAtelierMock({
        conn: { list: async () => CONNECTIONS },
        audit: {
          list: async () => [REVERSIBLE],
          undo: async () => Promise.reject({ code: 'AUDIT_UNDO_EXPIRED', message: 'AUDIT_UNDO_EXPIRED' }),
        },
      });
      render(<AuditLogModal initialConnectionId="c1" onClose={() => {}} />);

      fireEvent.click(await screen.findByRole('button', { name: 'Revert' }));

      await screen.findByRole('alert');
      expect(invalidateSampleSchemaCache).toHaveBeenCalledExactlyOnceWith('c1');
      expect(invalidateSchemaEnumCache).toHaveBeenCalledExactlyOnceWith('c1');
    });

    it('leaves them alone until a Revert is clicked', async () => {
      installAtelierMock({ conn: { list: async () => CONNECTIONS }, audit: { list: async () => [REVERSIBLE] } });
      render(<AuditLogModal initialConnectionId="c1" onClose={() => {}} />);

      await screen.findByRole('button', { name: 'Revert' });

      expect(invalidateSampleSchemaCache).not.toHaveBeenCalled();
      expect(invalidateSchemaEnumCache).not.toHaveBeenCalled();
    });

    it('explains a refused Revert in words', async () => {
      installAtelierMock({
        conn: { list: async () => CONNECTIONS },
        audit: {
          list: async () => [REVERSIBLE],
          undo: async () => Promise.reject({ code: 'AUDIT_UNDO_EXPIRED', message: 'AUDIT_UNDO_EXPIRED' }),
        },
      });
      render(<AuditLogModal initialConnectionId="c1" onClose={() => {}} />);

      fireEvent.click(await screen.findByRole('button', { name: 'Revert' }));

      expect((await screen.findByRole('alert')).textContent).toMatch(/can't be undone any more — earlier versions are kept only for recent changes, and only until L'Atelier restarts\./);
    });
  });
});
