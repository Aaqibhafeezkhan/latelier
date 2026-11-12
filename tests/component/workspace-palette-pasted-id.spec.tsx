// A pasted `_id` offers a row that filters the tab in front to that document
// as one undoable step of the filter drawer's own history (X07 §13.2).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import {
  CommandPaletteRoot,
  usePaletteApi,
  _resetPaletteStoreForTests,
} from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { commandRegistry } from '../../src/commands/registry';
import {
  installAtelierMock,
  uninstallAtelierMock,
  connectionFixture,
  collectionTabFixture,
} from '../helpers/atelierMock';
import type { IpcApi } from '@shared/ipc';
import type { CollectionTabState, WorkspaceTab } from '@shared/types';

const HEX = '6650c1f2a9e4b31d2c8f0a17';
const FILTER = JSON.stringify({ _id: { $oid: HEX } });
// The form the drawer prints, so Undo gives back exactly this text.
const BEFORE = '{"status":{"$eq":"paid"}}';

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

function mount(tabs: WorkspaceTab[]) {
  const find = vi.fn<IpcApi['query']['find']>(async () => ({
    documents: [],
    durationMs: 0,
    hasMore: false,
  }));
  installAtelierMock({
    conn: { list: async () => [connectionFixture({ id: 'c1' })] },
    tabs: {
      list: async () => tabs,
      update: async (id: string) => tabs.find((t) => t.id === id) ?? tabs[0],
    },
    index: { list: async () => [] },
    meta: { sampleSchema: async () => ({ docs: [] }) },
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
  return { find };
}

const collectionTab = (queryRaw = BEFORE, filterDraft?: CollectionTabState['filterDraft']) => {
  const tab = collectionTabFixture({ id: 't1', dbName: 'shop', collection: 'orders', isActive: true });
  return { ...tab, state: { ...tab.state, queryRaw, filterDraft } } as WorkspaceTab;
};

function search(q: string) {
  fireEvent.click(screen.getByText('toggle'));
  fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: q } });
}

const filterBar = () => screen.getByLabelText('Query filter') as HTMLTextAreaElement;

afterEach(() => {
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('palette: a pasted _id with a collection tab in front', () => {
  it.each([HEX, `ObjectId("${HEX}")`, `ObjectId('${HEX}')`])('offers the row first for %s', async (query) => {
    mount([collectionTab()]);
    await screen.findByLabelText('Query filter');
    search(query);

    const dialog = within(screen.getByRole('dialog'));
    const options = await dialog.findAllByRole('option');
    expect(options[0]!.textContent).toContain(`Find _id ${HEX} in shop.orders`);
    expect(options[0]!.textContent).toContain('Replaces the filter and runs it · Undo puts the old filter back');
    expect(dialog.getByText('In the tab in front')).toBeTruthy();
    expect(dialog.getByText('No other matches')).toBeTruthy();
    // The Enter key cap at the right, as the artboard draws it (`Enter` off a Mac).
    expect(options[0]!.lastElementChild?.textContent).toMatch(/^(↵|Enter)$/);
    // The value alone is set in the accent ink.
    const value = dialog.getByText(HEX);
    expect(value.style.color).toBe('var(--atelier-accent-ink)');
  });

  it('is absent with no collection tab in front', async () => {
    mount([]);
    await waitFor(() => expect(screen.getByText('toggle')).toBeTruthy());
    search(HEX);
    await screen.findByLabelText('Search commands');
    expect(within(screen.getByRole('dialog')).queryByText('In the tab in front')).toBeNull();
    expect(within(screen.getByRole('dialog')).queryByText(/Find _id/)).toBeNull();
  });

  it('is absent for a query that is not an id', async () => {
    mount([collectionTab()]);
    await screen.findByLabelText('Query filter');
    search(HEX.slice(1));
    await screen.findByLabelText('Search commands');
    expect(within(screen.getByRole('dialog')).queryByText(/Find _id/)).toBeNull();
  });

  it('Enter filters the tab to the document, runs it, and Undo puts the old filter back', async () => {
    const { find } = mount([collectionTab()]);
    await screen.findByLabelText('Query filter');
    search(`ObjectId("${HEX}")`);
    await within(screen.getByRole('dialog')).findByText('In the tab in front');
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' });

    await waitFor(() => expect(filterBar().value).toBe(FILTER));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    expect(find.mock.calls[0]![0]).toMatchObject({ filter: FILTER });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull());

    // One step: a single Undo returns to the filter the tab held.
    const undo = screen.getByRole('button', { name: 'Undo filter edit' }) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    await waitFor(() => expect(filterBar().value).toBe(BEFORE));
    expect((screen.getByRole('button', { name: 'Undo filter edit' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('switches a tab off Documents back to it, and runs the find once', async () => {
    const tab = collectionTab();
    const { find } = mount([{ ...tab, state: { ...tab.state, activeView: 'aggregation' } } as WorkspaceTab]);
    await screen.findByRole('tab', { name: 'Aggregation', selected: true });
    expect(screen.queryByLabelText('Query filter')).toBeNull();
    search(HEX);
    await within(screen.getByRole('dialog')).findByText('In the tab in front');
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' });

    await waitFor(() => expect(filterBar().value).toBe(FILTER));
    expect(screen.getByRole('tab', { name: 'Documents', selected: true })).toBeTruthy();
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    expect(find.mock.calls[0]![0]).toMatchObject({ filter: FILTER });
  });

  it('keeps the step for a drawer that was collapsed when the filter was replaced', async () => {
    const { find } = mount([collectionTab()]);
    await screen.findByLabelText('Query filter');
    // Ctrl+B collapses the query drawer.
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo filter edit' })).toBeNull());

    search(HEX);
    await within(screen.getByRole('dialog')).findByText('In the tab in front');
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    expect(filterBar().value).toBe(FILTER);

    // Expanding the drawer afterwards still has the old filter one Undo away.
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    const undo = (await screen.findByRole('button', { name: 'Undo filter edit' })) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    await waitFor(() => expect(filterBar().value).toBe(BEFORE));
  });

  it('Undo restores the drawer tree the tab had stored as a draft, switched-off row included', async () => {
    const draft: CollectionTabState['filterDraft'] = {
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
    mount([collectionTab(BEFORE, draft)]);
    await screen.findByLabelText('Query filter');
    expect(screen.queryByDisplayValue('offrow')).toBeTruthy();

    search(HEX);
    await within(screen.getByRole('dialog')).findByText('In the tab in front');
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' });
    await waitFor(() => expect(filterBar().value).toBe(FILTER));
    expect(screen.queryByDisplayValue('offrow')).toBeNull();

    const undo = screen.getByRole('button', { name: 'Undo filter edit' }) as HTMLButtonElement;
    await waitFor(() => expect(undo.disabled).toBe(false));
    fireEvent.click(undo);
    await waitFor(() => expect(filterBar().value).toBe(BEFORE));
    expect(screen.queryByDisplayValue('offrow')).toBeTruthy();
  });
});
