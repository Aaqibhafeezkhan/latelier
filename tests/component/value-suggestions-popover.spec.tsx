// The value box next to a condition row's operator suggests
// values from the current results and from values persisted for this
// (conn, db, coll, field). Only covers what a rendered row can show: gating
// on field/op and the pick wiring. The sources themselves are covered in
// tests/unit/last-run-values-source.spec.ts and
// tests/component/recent-values-cache.spec.ts.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import {
  invalidateRecentValuesCache,
  invalidateSampleSchemaCache,
  invalidateSchemaEnumCache,
} from '../../src/features/fieldSuggestions/sources';
import type { CollectionTabState, WorkspaceTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

const now = '2026-08-09T12:00:00.000Z';

function makeState(): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun: {
      documents: [{ status: 'shipped' }, { status: 'pending' }],
      durationMs: 0,
      ranAt: now,
    },
  };
}

function makeTab(state: CollectionTabState): WorkspaceTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'mydb',
    collection: 'users',
    position: 0,
    isActive: true,
    openedAt: now,
    pinned: false,
    state,
  };
}

const CONNECTION = {
  id: 'c1',
  name: 'Local',
  color: '#1A6835',
  host: 'localhost',
  port: 27017,
  connectionType: 'standard' as const,
  readOnly: false,
  status: 'connected' as const,
};

interface Row {
  fieldInput: HTMLInputElement;
  opInput: HTMLInputElement;
  valueInput: HTMLInputElement;
}

/** Renders the workspace and returns one freshly-added, pending condition row. */
async function openConditionRow(
  valuesForField: ReturnType<typeof vi.fn>,
  meta: Partial<IpcApi['meta']> = {},
): Promise<Row> {
  const state = makeState();
  installAtelierMock({
    tabs: {
      list: async () => [makeTab(state)],
      setActive: async (id) => ({ id }),
      update: (vi.fn(async () => makeTab(state)) as unknown) as IpcApi['tabs']['update'],
    },
    conn: { list: async () => [CONNECTION] },
    query: {
      find: vi.fn(async () => ({ documents: [], durationMs: 1, hasMore: false })),
      count: async () => ({ count: 0 }),
    },
    recent: { valuesForField: valuesForField as never } as never,
    meta,
  });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Add condition' }));
  const fieldInput = (await screen.findByPlaceholderText('field')) as HTMLInputElement;
  const opInput = (await screen.findByPlaceholderText('$op')) as HTMLInputElement;
  const valueInput = (await screen.findByPlaceholderText('value')) as HTMLInputElement;
  return { fieldInput, opInput, valueInput };
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
  // `recentValuesSource` caches per (conn, db, coll, field) at module scope —
  // clear it so the next test's `valuesForField` mock actually gets called.
  invalidateRecentValuesCache();
  invalidateSampleSchemaCache();
  invalidateSchemaEnumCache();
});

describe('Query Builder — value suggestions popover', () => {
  it('shows no popover while the field is blank', async () => {
    const { valueInput } = await openConditionRow(vi.fn(async () => ({ values: [] })));

    fireEvent.focus(valueInput);
    fireEvent.change(valueInput, { target: { value: 's' } });

    expect(screen.queryByRole('listbox', { name: 'Value suggestions' })).toBeNull();
  });

  it('suggests values from the current results once a field is typed, for an allowed op ($eq)', async () => {
    const { fieldInput, valueInput } = await openConditionRow(vi.fn(async () => ({ values: [] })));

    fireEvent.change(fieldInput, { target: { value: 'status' } });
    fireEvent.focus(valueInput);
    fireEvent.change(valueInput, { target: { value: '' } });

    const listbox = await screen.findByRole('listbox', { name: 'Value suggestions' });
    expect(listbox.textContent).toContain('shipped');
    expect(listbox.textContent).toContain('pending');
  });

  it('picking a suggestion writes its display text into the value box', async () => {
    const { fieldInput, valueInput } = await openConditionRow(vi.fn(async () => ({ values: [] })));

    fireEvent.change(fieldInput, { target: { value: 'status' } });
    fireEvent.focus(valueInput);
    fireEvent.change(valueInput, { target: { value: '' } });

    const option = await screen.findByText('shipped');
    fireEvent.click(option);

    await waitFor(() => expect(valueInput.value).toBe('shipped'));
  });

  it('gets no popover for a disallowed op ($regex)', async () => {
    const { fieldInput, opInput, valueInput } = await openConditionRow(vi.fn(async () => ({ values: [] })));

    fireEvent.change(fieldInput, { target: { value: 'status' } });
    fireEvent.change(opInput, { target: { value: '$regex' } });
    fireEvent.blur(opInput);

    fireEvent.focus(valueInput);
    fireEvent.change(valueInput, { target: { value: 's' } });

    expect(screen.queryByRole('listbox', { name: 'Value suggestions' })).toBeNull();
  });

  it('suggests a low-cardinality value from the collection sample', async () => {
    const { fieldInput, valueInput } = await openConditionRow(vi.fn(async () => ({ values: [] })), {
      sampleSchema: async () => ({ docs: [{ status: 'refunded' }] }),
    });

    fireEvent.change(fieldInput, { target: { value: 'status' } });
    fireEvent.focus(valueInput);
    fireEvent.change(valueInput, { target: { value: '' } });

    const listbox = await screen.findByRole('listbox', { name: 'Value suggestions' });
    await waitFor(() => expect(listbox.textContent).toContain('refunded'));
  });

  it("suggests a value from the validator's $jsonSchema enum", async () => {
    const collectionDetails = vi.fn(async () => ({
      name: 'users',
      type: 'collection' as const,
      capped: false,
      options: {
        validator: JSON.stringify({ $jsonSchema: { properties: { status: { enum: ['on_hold'] } } } }),
      },
    }));
    const { fieldInput, valueInput } = await openConditionRow(vi.fn(async () => ({ values: [] })), {
      collectionDetails,
    });

    fireEvent.change(fieldInput, { target: { value: 'status' } });
    fireEvent.focus(valueInput);
    fireEvent.change(valueInput, { target: { value: '' } });

    const listbox = await screen.findByRole('listbox', { name: 'Value suggestions' });
    await waitFor(() => expect(listbox.textContent).toContain('on_hold'));
    expect(collectionDetails).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'mydb', collection: 'users' });
  });

  it('queries recorded values scoped to this field', async () => {
    const valuesForField = vi.fn(async () => ({
      values: [{ value: 'archived', valType: 'string', frequency: 5, lastUsedAt: now }],
    }));
    const { fieldInput, valueInput } = await openConditionRow(valuesForField);

    fireEvent.change(fieldInput, { target: { value: 'status' } });
    fireEvent.focus(valueInput);
    fireEvent.change(valueInput, { target: { value: '' } });

    const listbox = await screen.findByRole('listbox', { name: 'Value suggestions' });
    await waitFor(() => expect(listbox.textContent).toContain('archived'));
    expect(valuesForField).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'c1', dbName: 'mydb', collection: 'users', field: 'status' }),
    );
  });
});
