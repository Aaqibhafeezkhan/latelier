import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTabState, WorkspaceTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';
import { DRAGGED_FIELD_MIME } from '../../src/pages/Workspace/builder';

/**
 * #323 / ADR 0007 item 4 — a field dragged from the results onto the sort
 * cell sorts by it: always ascending, always replacing what was there.
 */

const now = '2026-08-06T12:00:00.000Z';

// A sort is seeded so the advanced row auto-opens (`hasAdvanced`) — the row
// is not in the DOM at all while collapsed.
function makeState(): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '{"name":1}', limit: '' },
    queryRaw: '{}',
    page: 2,
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

function mount() {
  const state = makeState();
  installAtelierMock({
    tabs: {
      list: async () => [makeTab(state)],
      setActive: async (id) => ({ id }),
      update: (async () => makeTab(state)) as unknown as IpcApi['tabs']['update'],
    },
    conn: { list: async () => [CONNECTION] },
    prefs: {
      get: async () => null,
      set: async (_key: string, value: unknown) => value,
    } as unknown as IpcApi['prefs'],
    query: {
      find: vi.fn(async () => ({ documents: [], durationMs: 3, hasMore: false })),
      count: async () => ({ count: 0 }),
    },
  });

  return render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function transfer(types: string[], data: string) {
  return { types, getData: (t: string) => (t === DRAGGED_FIELD_MIME ? data : ''), dropEffect: 'none' };
}

const fieldDrag = (field: unknown) => transfer([DRAGGED_FIELD_MIME], JSON.stringify({ field, value: 1 }));

describe('#323 — drop a field onto Sort', () => {
  it('replaces the sort with the field, ascending', async () => {
    mount();
    const input = (await screen.findByTestId('query-bar-sort')) as HTMLInputElement;
    expect(input.value).toBe('{"name":1}');
    const cell = screen.getByTestId('query-bar-sort-drop');

    const dataTransfer = fieldDrag('age');
    fireEvent.dragOver(cell, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe('copy');
    fireEvent.drop(cell, { dataTransfer });

    await waitFor(() => expect(input.value).toBe('{"age":1}'));
  });

  it('re-dropping the sorted field keeps it ascending rather than flipping or clearing it', async () => {
    mount();
    const input = (await screen.findByTestId('query-bar-sort')) as HTMLInputElement;
    fireEvent.drop(screen.getByTestId('query-bar-sort-drop'), { dataTransfer: fieldDrag('age') });
    await waitFor(() => expect(input.value).toBe('{"age":1}'));
    // The first drop has round-tripped into state, so this one sees `age`
    // already sorted — where the header's cycle would flip it.
    await act(async () => {
      fireEvent.drop(screen.getByTestId('query-bar-sort-drop'), { dataTransfer: fieldDrag('age') });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(input.value).toBe('{"age":1}');
  });

  it('ignores a drag that is not a field, or a malformed one', async () => {
    // A handler that throws does not fail `fireEvent`; React reports it on
    // window instead, so collect those reports.
    const thrown: unknown[] = [];
    const onError = (e: ErrorEvent) => {
      thrown.push(e.error);
      e.preventDefault();
    };
    window.addEventListener('error', onError);
    mount();
    const input = (await screen.findByTestId('query-bar-sort')) as HTMLInputElement;
    const cell = screen.getByTestId('query-bar-sort-drop');
    for (const dataTransfer of [
      transfer(['text/plain'], JSON.stringify({ field: 'age' })),
      transfer([DRAGGED_FIELD_MIME], '{not json'),
      transfer([DRAGGED_FIELD_MIME], 'null'),
      transfer([DRAGGED_FIELD_MIME], '"age"'),
      fieldDrag(''),
      fieldDrag(3),
    ]) {
      fireEvent.drop(cell, { dataTransfer });
    }
    window.removeEventListener('error', onError);
    expect(thrown).toEqual([]);
    expect(input.value).toBe('{"name":1}');
  });

  it('highlights while a field is over the cell, and clears on leave and on drop', async () => {
    mount();
    await screen.findByTestId('query-bar-sort');
    const cell = screen.getByTestId('query-bar-sort-drop');
    const idle = cell.style.outline;

    fireEvent.dragOver(cell, { dataTransfer: transfer(['text/plain'], '') });
    expect(cell.style.outline).toBe(idle);
    fireEvent.dragOver(cell, { dataTransfer: fieldDrag('age') });
    expect(cell.style.outline).not.toBe(idle);
    fireEvent.dragLeave(cell);
    expect(cell.style.outline).toBe(idle);

    fireEvent.dragOver(cell, { dataTransfer: fieldDrag('age') });
    fireEvent.drop(cell, { dataTransfer: fieldDrag('age') });
    expect(cell.style.outline).toBe(idle);
  });
});
