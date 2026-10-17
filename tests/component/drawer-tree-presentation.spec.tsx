// W15 §13.1 / §13.7 — the Filter tab's tree, as presented: three
// distinguishable add buttons, exactly one Remove affordance per row, an
// empty state that says what to do, and a problems banner that names the
// rows it is counting.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTabState, WorkspaceTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

const now = '2026-08-06T12:00:00.000Z';

function makeState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun: { documents: [], durationMs: 0, ranAt: now },
    ...overrides,
  };
}

function makeCollectionTab(state: CollectionTabState): WorkspaceTab {
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

function mountWith(state: CollectionTabState) {
  const updateSpy = vi.fn(async () => makeCollectionTab(state));
  installAtelierMock({
    tabs: {
      list: async () => [makeCollectionTab(state)],
      setActive: async (id) => ({ id }),
      update: updateSpy as unknown as IpcApi['tabs']['update'],
    },
    conn: { list: async () => [CONNECTION] },
    query: {
      find: vi.fn(async () => ({ documents: [], durationMs: 1, hasMore: false })),
      count: async () => ({ count: 0 }),
    },
  });
  const utils = render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
  return { ...utils, updateSpy };
}

/**
 * The Tabler glyph a button renders, as its `tabler-icon-*` class. This is
 * what actually distinguishes the three add buttons on screen — asserting on
 * their aria-labels instead would pass with all three drawing the same plus.
 */
function glyphOf(button: HTMLElement): string {
  const svg = button.querySelector('svg');
  const cls = [...(svg?.classList ?? [])].find(
    (c) => c.startsWith('tabler-icon-') && c !== 'tabler-icon',
  );
  expect(cls).toBeTruthy();
  return cls as string;
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('W15 §13.1 — the group header\'s three add buttons', () => {
  it('draw three different glyphs, and `<>` sits on the raw clause', async () => {
    mountWith(makeState());

    const condition = await screen.findByRole('button', { name: 'Add condition' });
    const group = screen.getByRole('button', { name: 'Add group' });
    const raw = screen.getByRole('button', { name: 'Add raw clause' });

    const glyphs = [glyphOf(condition), glyphOf(group), glyphOf(raw)];
    expect(new Set(glyphs).size).toBe(3);
    // `<>` reads as raw JSON; it belongs to the one action it describes.
    expect(glyphOf(raw)).toBe('tabler-icon-code');
    expect(glyphOf(group)).not.toBe('tabler-icon-code');
  });
});

describe('W15 §13.1 — one Remove affordance per row', () => {
  it('a condition row removes from the ✕ only, and the ✕ names the field', async () => {
    mountWith(makeState({ queryRaw: '{"status":{"$eq":"paid"}}' }));

    // The direct control survives and says what it removes.
    await screen.findByRole('button', { name: 'Remove condition status' });

    // The row menu no longer duplicates it.
    fireEvent.click(screen.getByRole('button', { name: 'Condition options 1' }));
    await screen.findByRole('menuitem', { name: 'Duplicate' });
    expect(screen.queryByRole('menuitem', { name: 'Remove' })).toBeNull();
  });

  it('a raw clause row removes from the ✕ only', async () => {
    mountWith(makeState({ queryRaw: '{"items":{"$elemMatch":{"sku":1}}}' }));

    await screen.findByRole('button', { name: 'Remove raw clause 1' });

    fireEvent.click(screen.getByRole('button', { name: 'Raw clause options 1' }));
    await screen.findByRole('menuitem', { name: 'Duplicate' });
    expect(screen.queryByRole('menuitem', { name: 'Remove' })).toBeNull();
  });
});

describe('W15 §13.1 — the empty tree has an empty state', () => {
  it('says what the empty filter means and what to do, then yields to the first row', async () => {
    mountWith(makeState({ queryRaw: '{}' }));

    await screen.findByText(/matches every document/i);
    // and it names drag-and-drop, the one route the drop target never
    // advertises at rest.
    expect(screen.getByText(/drag a field/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));

    await waitFor(() => {
      expect(screen.queryByText(/matches every document/i)).toBeNull();
    });
  });

  it('stays quiet while the tree is frozen read-only on invalid bar text', async () => {
    // §6a freezes the drawer on the last valid tree when the bar holds
    // invalid JSON. On a fresh tab that tree is empty, so an unguarded empty
    // state would claim "matches every document" directly beneath the banner
    // saying the filter text is not valid JSON.
    mountWith(makeState({ queryRaw: 'not valid json{{{' }));

    await screen.findByText(/isn't valid JSON/);
    expect(screen.queryByText(/matches every document/i)).toBeNull();
  });
});

describe('W15 §13.1 — rows reorder within their group', () => {
  /** Field inputs in DOM order — the tree's visible ordering. */
  function fieldOrder(): string[] {
    return screen
      .getAllByPlaceholderText('field')
      .map((i) => (i as HTMLInputElement).value);
  }

  async function openRowMenu(index: number) {
    const buttons = await screen.findAllByRole('button', { name: /^Condition options [\d.]+$/ });
    fireEvent.click(buttons[index]);
  }

  it('Move up reorders a condition, and is disabled on the first row', async () => {
    mountWith(makeState({ queryRaw: '{"a":{"$eq":"1"},"b":{"$eq":"2"},"c":{"$eq":"3"}}' }));

    await screen.findAllByPlaceholderText('field');
    expect(fieldOrder()).toEqual(['a', 'b', 'c']);

    await openRowMenu(2);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move up' }));

    await waitFor(() => expect(fieldOrder()).toEqual(['a', 'c', 'b']));

    // The top row has nowhere to go: the item is disabled and clicking it
    // leaves the order alone.
    await openRowMenu(0);
    const up = await screen.findByRole('menuitem', { name: 'Move up' });
    expect((up as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(up);
    expect(fieldOrder()).toEqual(['a', 'c', 'b']);
  });

  it('Move down reorders a condition, and is disabled on the last row', async () => {
    mountWith(makeState({ queryRaw: '{"a":{"$eq":"1"},"b":{"$eq":"2"},"c":{"$eq":"3"}}' }));

    await screen.findAllByPlaceholderText('field');
    expect(fieldOrder()).toEqual(['a', 'b', 'c']);

    await openRowMenu(0);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move down' }));

    await waitFor(() => expect(fieldOrder()).toEqual(['b', 'a', 'c']));

    await openRowMenu(2);
    const down = await screen.findByRole('menuitem', { name: 'Move down' });
    expect((down as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(down);
    expect(fieldOrder()).toEqual(['b', 'a', 'c']);
  });

  it('reorders a nested group\'s child without collapsing the group', async () => {
    mountWith(
      makeState({
        queryRaw: '{"x":{"$eq":"0"},"$or":[{"a":{"$eq":"1"}},{"b":{"$eq":"2"}},{"c":{"$eq":"3"}}]}',
      }),
    );

    await screen.findAllByPlaceholderText('field');
    expect(fieldOrder()).toEqual(['x', 'a', 'b', 'c']);
    // The nested group is real, not flattened.
    expect(screen.getByRole('button', { name: 'Remove group 2' })).toBeTruthy();

    // The last child of the nested group, moved up inside it.
    await openRowMenu(3);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move up' }));

    await waitFor(() => expect(fieldOrder()).toEqual(['x', 'a', 'c', 'b']));
    expect(screen.getByRole('button', { name: 'Remove group 2' })).toBeTruthy();
  });
});

describe('Group and raw-row controls are named by position', () => {
  it('each nested group\'s add and remove buttons, and each raw row\'s checkbox, say which one they act on', async () => {
    mountWith(
      makeState({
        queryRaw:
          '{"x":{"$eq":"0"},"$or":[{"a":{"$eq":"1"}},{"b":{"$eq":"2"}}],"$nor":[{"c":{"$eq":"3"}},{"d":{"$eq":"4"}}],"$where":"1"}',
      }),
    );
    await screen.findAllByPlaceholderText('field');

    for (const g of ['2', '3']) {
      expect(screen.getByRole('button', { name: `Add condition to group ${g}` })).toBeTruthy();
      expect(screen.getByRole('button', { name: `Add group to group ${g}` })).toBeTruthy();
      expect(screen.getByRole('button', { name: `Add raw clause to group ${g}` })).toBeTruthy();
      expect(screen.getByRole('button', { name: `Remove group ${g}` })).toBeTruthy();
    }
    expect(screen.getByRole('checkbox', { name: 'Include raw clause 4' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Raw clause 4' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Raw clause options 4' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove raw clause 4' })).toBeTruthy();
    // Each row's menu, nested rows included.
    for (const row of ['1', '2.1', '2.2', '3.1', '3.2']) {
      expect(screen.getByRole('button', { name: `Condition options ${row}` })).toBeTruthy();
    }
    // The root is the only group without a position, so its names stay short.
    expect(screen.getAllByRole('button', { name: 'Add condition' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Add group' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Add raw clause' })).toHaveLength(1);
  });
});

describe('W15 §13.7 — the "N not applied" banner names the offending rows', () => {
  it('names the condition field rather than reporting a bare count', async () => {
    mountWith(makeState({ queryRaw: '{"qty":{"$gt":5}}' }));

    const valueInput = await screen.findByPlaceholderText('value');
    fireEvent.change(valueInput, { target: { value: 'not-a-number' } });

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('1 not applied');
    });
    // The field name is the thing that lets a user find the row in a deep
    // tree; the count alone does not.
    expect(screen.getByRole('status').textContent).toContain('qty');
  });

  it('labels a blocked raw clause as such', async () => {
    mountWith(makeState({ queryRaw: '{"items":{"$elemMatch":{"sku":1}}}' }));

    const rawInput = await screen.findByLabelText('Raw clause 1');
    fireEvent.change(rawInput, { target: { value: '{ broken' } });

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('raw clause');
    });
  });
});
