// The palette's Query… and Filter by field… (X07 §13.6), against a real
// mounted `<Workspace/>`: its tab state is real `useState`, so an appended row
// shows only once the drawer's patch comes back through props.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import Workspace from '../../src/pages/Workspace';
import {
  CommandPaletteRoot,
  usePaletteApi,
  _resetPaletteStoreForTests,
} from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { commandRegistry } from '../../src/commands/registry';
import { _resetTabRequestsForTests } from '../../src/pages/Workspace/tabRequest';
import {
  invalidateSampleSchemaCache,
  sampleSchemaSource,
} from '../../src/features/fieldSuggestions/sources/sampleSchemaSource';
import {
  installAtelierMock,
  uninstallAtelierMock,
  connectionFixture,
  collectionTabFixture,
} from '../helpers/atelierMock';
import type { CollectionInfo, DbInfo, IpcApi } from '@shared/ipc';
import type { CollectionTab, CollectionTabState } from '@shared/types';

const coll = (name: string): CollectionInfo => ({
  name,
  type: 'collection',
  documentCount: 0,
  sizeBytes: 0,
  indexCount: 0,
  capped: false,
});
const db = (name: string): DbInfo => ({ name, sizeOnDisk: 1, empty: false });

// The form the drawer prints, so Undo gives back exactly this text.
const BEFORE = '{"status":{"$eq":"paid"}}';
const DRAFT: CollectionTabState['filterDraft'] = {
  queryRaw: BEFORE,
  root: {
    kind: 'group',
    logic: '$and',
    children: [
      { kind: 'cond', field: 'status', op: '$eq', valType: 'string', value: 'paid' },
      { kind: 'cond', field: 'offrow', op: '$eq', valType: 'string', value: 'x', disabled: true },
    ],
  },
};

const DOCS = [
  { status: 'paid', customer: 'ann', createdAt: { $date: '2026-11-01T00:00:00Z' }, tags: ['a'] },
  { status: 'open', customer: 'bob', createdAt: { $date: '2026-11-02T00:00:00Z' } },
];

const ordersTab = (state: Partial<CollectionTabState> = { queryRaw: BEFORE, filterDraft: DRAFT }): CollectionTab => {
  const tab = collectionTabFixture({ id: 't1', connectionId: 'c1', dbName: 'shop', collection: 'orders', isActive: true });
  return { ...tab, state: { ...tab.state, ...state } };
};

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

function mount(opts: { tabs?: CollectionTab[]; opened?: CollectionTab; sample?: IpcApi['meta']['sampleSchema'] } = {}) {
  let rows = opts.tabs ?? [ordersTab()];
  const sampleSchema = vi.fn<IpcApi['meta']['sampleSchema']>(opts.sample ?? (async () => ({ docs: DOCS })));
  const find = vi.fn<IpcApi['query']['find']>(async () => ({ documents: [], durationMs: 0, hasMore: false }));
  const openCollection = vi.fn(async () => {
    const opened = opts.opened ?? rows[0]!;
    if (!rows.some((r) => r.id === opened.id)) rows = [...rows.map((r) => ({ ...r, isActive: false })), opened];
    return opened;
  });
  installAtelierMock({
    conn: { list: async () => [connectionFixture({ id: 'c1', name: 'Production' })] },
    tabs: {
      list: async () => rows,
      openCollection: openCollection as never,
      update: async (id: string) => rows.find((t) => t.id === id) ?? rows[0]!,
    },
    meta: {
      listDatabases: (async () => [db('shop')]) as never,
      listCollections: (async () => [coll('orders'), coll('customers')]) as never,
      sampleSchema,
    },
    index: { list: async () => [] },
    query: { find },
  });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <Workspace />
          <ToggleButton />
        </CommandPaletteRoot>
      </PaletteContextProvider>
    </MemoryRouter>,
  );
  return { sampleSchema, find, openCollection };
}

const dialog = () => within(screen.getByRole('dialog', { name: 'Command palette' }));
const input = () => dialog().getByRole('combobox');
const key = (k: string, extra: Partial<KeyboardEvent> = {}) => fireEvent.keyDown(input(), { key: k, ...extra });
const filterBar = () => screen.getByLabelText('Query filter') as HTMLTextAreaElement;
const undoButton = () => screen.getByRole('button', { name: 'Undo filter edit' }) as HTMLButtonElement;

/** ⌘K, the collection's action list, then `title`. */
async function runAction(name: string, title: string) {
  fireEvent.click(screen.getByText('toggle'));
  fireEvent.change(input(), { target: { value: name } });
  await waitFor(() => expect(dialog().getAllByRole('option')[0]!.textContent).toContain(name));
  key('Enter', { altKey: true });
  await dialog().findByLabelText('Filter actions');
  fireEvent.change(input(), { target: { value: title } });
  await waitFor(() => expect(dialog().getAllByRole('option')[0]!.textContent).toContain(title));
  key('Enter');
}

/** Narrows the field step to `path`, then chooses it. */
async function pickField(path: string) {
  fireEvent.change(input(), { target: { value: path } });
  await waitFor(() => expect(stepRows()[0]).toEqual([path, 'String']));
  key('Enter');
}

/** The field step's rows: title and type tag. */
function stepRows(): string[][] {
  return dialog()
    .queryAllByRole('option')
    .map((o) => [o.querySelector('[data-title]')?.getAttribute('data-title') ?? '', o.querySelector('[data-field-type]')?.textContent ?? '']);
}

/** The appended condition's row: the last root row. */
const lastRow = () => {
  const rows = document.querySelectorAll('[data-row-path]');
  return rows[rows.length - 1] as HTMLElement;
};

/** Waits out the drawer's focus frame and anything a run would have started. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 100)));

beforeEach(() => invalidateSampleSchemaCache());

afterEach(() => {
  act(() => notifications.clean());
  uninstallAtelierMock();
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  _resetTabRequestsForTests();
  vi.restoreAllMocks();
});

describe('Filter by field…: the step', () => {
  it('lists Query… and Filter by field… after Open in new tab, the step with a ›', async () => {
    mount();
    await screen.findByTestId('nav-coll-shop-orders');
    fireEvent.click(screen.getByText('toggle'));
    fireEvent.change(input(), { target: { value: 'shop.orders' } });
    await waitFor(() => expect(dialog().getAllByRole('option')[0]!.textContent).toContain('shop.orders'));
    key('Enter', { altKey: true });
    await dialog().findByLabelText('Filter actions');
    const titles = () =>
      dialog()
        .getAllByRole('option')
        .map((o) => o.textContent);
    await waitFor(() => expect(titles().slice(0, 4)).toEqual([
      expect.stringContaining('Open'),
      expect.stringContaining('Open in new tab'),
      'Query…',
      'Filter by field…›',
    ]));
  });

  it('shows Sampling fields… until the sample lands, then the fields with their type, and the starters', async () => {
    let land!: (v: { docs: unknown[] }) => void;
    const m = mount({ sample: () => new Promise((r) => (land = r)) });
    await screen.findByTestId('nav-coll-shop-orders');
    await runAction('shop.orders', 'Filter by field');

    expect(await dialog().findByRole('status')).toHaveProperty('textContent', 'Sampling fields…');
    expect(dialog().getByText('shop.orders')).toBeTruthy();
    expect(dialog().getByText('Filter by field')).toBeTruthy();
    expect(stepRows()).toEqual([
      ['Last 7 days', ''],
      ['Exists and is not null', ''],
      ['Contains text (any case)', ''],
      ['One of a list', ''],
    ]);
    await act(async () => land({ docs: DOCS }));
    await waitFor(() => expect(dialog().queryByRole('status')).toBeNull());
    // In the sample's order: by frequency, then by name.
    expect(stepRows().slice(0, 5)).toEqual([
      ['createdAt', 'Date'],
      ['customer', 'String'],
      ['status', 'String'],
      ['tags', 'Array'],
      ['Last 7 days', ''],
    ]);
    expect(dialog().getByText('Fields · sampled')).toBeTruthy();
    expect(dialog().getByText('Starters')).toBeTruthy();
    // The input filters both lists with the palette's matcher.
    fireEvent.change(input(), { target: { value: 'st' } });
    expect(stepRows().map(([t]) => t)).toEqual(['customer', 'status', 'Last 7 days', 'Exists and is not null', 'Contains text (any case)', 'One of a list']);
    expect(dialog().getByText('Add "customer" to the filter (nothing runs)')).toBeTruthy();
    key('ArrowDown');
    expect(dialog().getByText('Add "status" to the filter (nothing runs)')).toBeTruthy();
    expect(dialog().getByText('Back to actions')).toBeTruthy();
    expect(m.sampleSchema).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['fails', async () => Promise.reject(new Error('boom'))],
    ['is empty', async () => ({ docs: [] })],
  ])('says No fields sampled when the sample %s, and still lists the starters', async (_name, sample) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount({ sample: sample as IpcApi['meta']['sampleSchema'] });
    await screen.findByTestId('nav-coll-shop-orders');
    await runAction('shop.orders', 'Filter by field');
    await waitFor(() => expect(dialog().getByRole('status').textContent).toBe('No fields sampled'));
    expect(stepRows().map(([t]) => t)).toEqual(['Last 7 days', 'Exists and is not null', 'Contains text (any case)', 'One of a list']);
  });

  it('samples an uncached collection once, and the builder suggestions reuse that sample', async () => {
    const m = mount();
    await screen.findByTestId('nav-coll-shop-orders');
    await runAction('shop.orders', 'Filter by field');
    await pickField('customer');
    await waitFor(() => expect(screen.getAllByDisplayValue('customer').length).toBeGreaterThan(0));
    await settle();
    const suggestions = await sampleSchemaSource({ connectionId: 'c1', dbName: 'shop', collection: 'orders' });
    expect(suggestions.flatMap((s) => (s.kind === 'field' ? [s.path] : []))).toContain('customer');
    expect(m.sampleSchema).toHaveBeenCalledTimes(1);
  });

  it('goes back to the action list on Escape, and on Backspace in an empty input', async () => {
    mount();
    await screen.findByTestId('nav-coll-shop-orders');
    await runAction('shop.orders', 'Filter by field');
    await dialog().findByLabelText('Filter fields');
    key('Escape');
    expect(await dialog().findByLabelText('Filter actions')).toBeTruthy();
    // Still open: Escape went back a step, not out.
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy();
    fireEvent.change(input(), { target: { value: 'Filter by field' } });
    await waitFor(() => expect(dialog().getAllByRole('option')[0]!.textContent).toContain('Filter by field'));
    key('Enter');
    await dialog().findByLabelText('Filter fields');
    key('Backspace');
    expect(await dialog().findByLabelText('Filter actions')).toBeTruthy();
  });

  it('opens from the verb too: `filter orders`', async () => {
    mount();
    await screen.findByTestId('nav-coll-shop-orders');
    fireEvent.click(screen.getByText('toggle'));
    fireEvent.change(input(), { target: { value: 'filter orders' } });
    await waitFor(() => expect(dialog().getAllByRole('option')[0]!.textContent).toContain('shop.orders'));
    key('Enter');
    expect(await dialog().findByLabelText('Filter fields')).toBeTruthy();
  });
});

describe('Filter by field…: choosing a row', () => {
  it('appends a condition on the field to the filter already there, focus in its value, nothing run', async () => {
    const m = mount();
    await screen.findByDisplayValue('offrow');
    await runAction('shop.orders', 'Filter by field');
    await pickField('customer');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull());
    const row = await waitFor(() => {
      const r = lastRow();
      expect((r.querySelector('input[placeholder="field"]') as HTMLInputElement).value).toBe('customer');
      return r;
    });
    await waitFor(() => expect(document.activeElement).toBe(row.querySelector('input[placeholder="value"]')));
    // The filter that was there is kept, switched-off row included.
    expect(screen.getByDisplayValue('offrow')).toBeTruthy();
    expect(screen.getByDisplayValue('paid')).toBeTruthy();
    await settle();
    expect(m.find).not.toHaveBeenCalled();
  });

  it('is one step of the drawer’s undo history: Undo gives the previous filter back', async () => {
    mount();
    await screen.findByDisplayValue('offrow');
    expect(undoButton().disabled).toBe(true);
    await runAction('shop.orders', 'Filter by field');
    await pickField('customer');
    await waitFor(() => expect(screen.getAllByDisplayValue('customer').length).toBeGreaterThan(0));
    await waitFor(() => expect(filterBar().value).not.toBe(BEFORE));

    fireEvent.click(undoButton());
    await waitFor(() => expect(filterBar().value).toBe(BEFORE));
    expect(screen.queryByDisplayValue('customer')).toBeNull();
    expect(screen.getByDisplayValue('offrow')).toBeTruthy();
    expect(undoButton().disabled).toBe(true);
  });

  it('appends a starter row, focus in its field, the filter text unchanged', async () => {
    const m = mount();
    await screen.findByDisplayValue('offrow');
    await runAction('shop.orders', 'Filter by field');
    fireEvent.change(input(), { target: { value: 'exists' } });
    await waitFor(() => expect(stepRows()).toEqual([['Exists and is not null', '']]));
    expect(dialog().getByText('Add "Exists and is not null" to the filter (nothing runs)')).toBeTruthy();
    key('Enter');

    await waitFor(() => {
      const field = lastRow().querySelector('input[placeholder="field"]') as HTMLInputElement;
      expect(field.value).toBe('');
      expect(document.activeElement).toBe(field);
    });
    // A blank field is pending: the text the bar holds does not move.
    expect(filterBar().value).toBe(BEFORE);
    expect(screen.getByDisplayValue('offrow')).toBeTruthy();
    await settle();
    expect(m.find).not.toHaveBeenCalled();
  });

  it('expands a collapsed query drawer to append', async () => {
    mount();
    await screen.findByDisplayValue('offrow');
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo filter edit' })).toBeNull());
    await runAction('shop.orders', 'Filter by field');
    await pickField('customer');
    await waitFor(() => expect(screen.getAllByDisplayValue('customer').length).toBeGreaterThan(0));
    expect(screen.getByDisplayValue('offrow')).toBeTruthy();
  });

  it('on a collection with no tab open, lands in the new tab without running `{}` first', async () => {
    const fresh = collectionTabFixture({ id: 't9', connectionId: 'c1', dbName: 'shop', collection: 'customers', isActive: true });
    const m = mount({ opened: fresh });
    await screen.findByDisplayValue('offrow');
    await runAction('shop.customers', 'Filter by field');
    await pickField('customer');
    await waitFor(() => expect(m.openCollection).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByDisplayValue('customer').length).toBeGreaterThan(0));
    await settle();
    expect(m.find).not.toHaveBeenCalled();
  });
});

describe('a tab on another view with no result', () => {
  // Results are not kept across a relaunch, so a restored tab has no run; the
  // switch back to Documents must not set off the default `{}` run.
  const onStructure = () => ordersTab({ queryRaw: '{}', filterDraft: undefined, activeView: 'structure' });

  it('Filter by field… switches it to Documents and runs nothing', async () => {
    const m = mount({ tabs: [onStructure()] });
    await screen.findByTestId('nav-coll-shop-orders');
    await runAction('shop.orders', 'Filter by field');
    fireEvent.change(input(), { target: { value: 'exists' } });
    await waitFor(() => expect(stepRows()).toEqual([['Exists and is not null', '']]));
    key('Enter');
    await waitFor(() => expect(screen.getByLabelText('Query filter')).toBeTruthy());
    await waitFor(() => expect(document.querySelectorAll('[data-row-path]').length).toBe(1));
    await settle();
    expect(m.find).not.toHaveBeenCalled();
  });

  it('Query… switches it to Documents and runs nothing', async () => {
    const m = mount({ tabs: [onStructure()] });
    await screen.findByTestId('nav-coll-shop-orders');
    await runAction('shop.orders', 'Query');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add condition' })));
    await settle();
    expect(m.find).not.toHaveBeenCalled();
  });
});

describe('Query…', () => {
  it('opens the collection with focus in the builder’s first field, nothing run', async () => {
    const m = mount();
    await screen.findByDisplayValue('offrow');
    await runAction('shop.orders', 'Query');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByDisplayValue('status')));
    await settle();
    expect(m.find).not.toHaveBeenCalled();
    // No edit: nothing to undo.
    expect(undoButton().disabled).toBe(true);
  });

  it('on an empty filter, focuses + Condition', async () => {
    mount({ tabs: [ordersTab({ queryRaw: '{}', filterDraft: undefined, lastRun: { documents: [], durationMs: 0, ranAt: '' } as never })] });
    await screen.findByText('No conditions yet');
    await runAction('shop.orders', 'Query');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add condition' })));
  });
});
