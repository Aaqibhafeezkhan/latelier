// X03's picker grouping, as the builder's condition row wires it: headers over
// the unfiltered catalog, the flat relevance list as soon as there is a token.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
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
    lastRun: { documents: [], durationMs: 0, ranAt: now },
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

/** Renders the workspace and returns the operator box of one pending row. */
async function openConditionRow(): Promise<HTMLInputElement> {
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
  });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Add condition' }));
  await screen.findByPlaceholderText('field');
  return (await screen.findByPlaceholderText('$op')) as HTMLInputElement;
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

// The page has other role=group elements (the filter tree's own), so only the
// ones inside the operator listbox count.
const headers = () => {
  const box = screen.queryByRole('listbox', { name: 'Operator suggestions' });
  return Array.from(box?.querySelectorAll('[role="group"]') ?? []).map(
    (g) => document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent,
  );
};

describe('Query Builder — grouped operator picker', () => {
  it('groups the list once the box is cleared and drops the headers when typing', async () => {
    const opInput = await openConditionRow();

    // A fresh row carries a committed op, which focus puts in the token, so
    // the list is filtered and flat.
    fireEvent.focus(opInput);
    expect(await screen.findByRole('listbox', { name: 'Operator suggestions' })).toBeTruthy();
    expect(headers()).toEqual([]);

    fireEvent.change(opInput, { target: { value: '' } });
    await waitFor(() =>
      expect(headers().slice(0, 6)).toEqual([
        'Comparison',
        'Logical',
        'Element',
        'Evaluation',
        'Array',
        'Geospatial',
      ]),
    );

    fireEvent.change(opInput, { target: { value: '$e' } });
    await waitFor(() => expect(headers()).toEqual([]));
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });
});
