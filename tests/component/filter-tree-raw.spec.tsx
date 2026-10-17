// W13 §11 — "filter-tree-raw.spec.tsx: convert-to-raw, edit raw, try-to-parse."
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTabState, WorkspaceTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

const now = '2026-08-04T12:00:00.000Z';

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

function lastWrittenQueryRaw(updateSpy: ReturnType<typeof vi.fn>): string | undefined {
  for (let i = updateSpy.mock.calls.length - 1; i >= 0; i--) {
    const arg = updateSpy.mock.calls[i]?.[1] as { state?: Partial<CollectionTabState> } | undefined;
    const patch = arg?.state;
    if (patch && 'queryRaw' in patch) return patch.queryRaw;
  }
  return undefined;
}

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

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('Filter drawer — raw clauses (W13 §6, §11)', () => {
  it('typing an unmodelled op offers "Convert to raw clause"; one click produces an editable raw node', async () => {
    const { updateSpy } = mountWith(makeState({ queryRaw: '{"items":{"$eq":"x"}}' }));

    const opInput = await screen.findByPlaceholderText('$op');
    fireEvent.change(opInput, { target: { value: '$elemMatch' } });

    const convertBtn = await screen.findByRole('button', { name: 'Convert to raw clause' });
    fireEvent.click(convertBtn);

    // The op input is gone; a raw-clause textarea renders instead. It's
    // blank, not pre-filled — `toRawNode` (filterTree.ts §4) can't encode a
    // value it never validated in the first place (that's the whole reason
    // the op was unmodelled), so it falls back to a blank *pending* raw node
    // rather than fabricating one. Blank/pending means it doesn't print, so
    // `queryRaw` stays at its last good value from before the conversion.
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('$op')).toBeNull();
    });
    const rawInput = (await screen.findByLabelText('Raw clause 1')) as HTMLTextAreaElement;
    expect(rawInput.value).toBe('');
    // The (only) cond turned into a blank pending raw node, so the group has
    // no printable children left — printFilter emits `{}` (§3a: "a root with
    // no printable children prints `{}`"), which *is* a real, different
    // value from the pre-conversion `{"items":{"$eq":"x"}}`, so it does
    // commit. `tabs.update` is 250ms-debounced (`src/state/workspaceTabs.ts`)
    // — `waitFor` (not a fixed short sleep) is what makes this assertion
    // trustworthy rather than a race against that debounce.
    await waitFor(() => {
      const raw = lastWrittenQueryRaw(updateSpy);
      expect(raw).toBe('{}');
    });

    // The row is a real, working raw clause now — typing a clause into it
    // prints normally.
    fireEvent.change(rawInput, { target: { value: '{"items":{"$elemMatch":{"sku":1}}}' } });
    await waitFor(() => {
      const raw = lastWrittenQueryRaw(updateSpy);
      expect(raw).toBeDefined();
      expect(JSON.parse(raw!)).toEqual({ items: { $elemMatch: { sku: 1 } } });
    });
  });

  it('editing a raw clause updates queryRaw once the JSON is valid', async () => {
    const { updateSpy } = mountWith(
      makeState({ queryRaw: '{"items":{"$elemMatch":{"sku":1}}}' }),
    );

    const rawInput = (await screen.findByLabelText('Raw clause 1')) as HTMLTextAreaElement;
    expect(rawInput.value).toBe('{"items":{"$elemMatch":{"sku":1}}}');

    fireEvent.change(rawInput, { target: { value: '{"items":{"$elemMatch":{"sku":2}}}' } });

    await waitFor(() => {
      const raw = lastWrittenQueryRaw(updateSpy);
      expect(raw).toBeDefined();
      expect(JSON.parse(raw!)).toEqual({ items: { $elemMatch: { sku: 2 } } });
    });
  });

  it('"Try to parse" converts a modellable raw node back into conds', async () => {
    // A raw clause that §2 CAN model as a cond — a clause pasted from
    // elsewhere, or (as here) hand-edited into raw via the row menu, and
    // "Try to parse" adopts it back into the tree.
    //
    // Both `toRawNode` and `tryParseRaw` round-trip this particular clause
    // to the exact same printed text (the fixpoint guarantee, §3b) — so
    // `queryRaw` itself never changes across either step. The row *type*
    // (cond inputs vs. raw textarea) is what actually proves the tree
    // changed; `queryRaw` is asserted at the end via the query bar's live
    // value, which reflects local state immediately (unlike the 250ms
    // debounced `tabs.update` persistence).
    mountWith(makeState({ queryRaw: '{"status":{"$eq":"paid"}}' }));
    const bar = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;

    // Convert the cond row to raw via its row menu.
    fireEvent.click(await screen.findByRole('button', { name: 'Condition options 1' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Convert to raw clause' }));

    const rawInput = (await screen.findByLabelText('Raw clause 1')) as HTMLTextAreaElement;
    expect(JSON.parse(rawInput.value)).toEqual({ status: { $eq: 'paid' } });
    expect(JSON.parse(bar.value)).toEqual({ status: { $eq: 'paid' } });

    fireEvent.click(await screen.findByRole('button', { name: 'Try to parse' }));

    // Back to a cond row: field/op/value inputs render again, raw textarea
    // is gone.
    await waitFor(() => {
      expect(screen.queryByLabelText(/^Raw clause [\d.]+$/)).toBeNull();
    });
    const fieldInput = (await screen.findByPlaceholderText('field')) as HTMLInputElement;
    expect(fieldInput.value).toBe('status');
    expect(JSON.parse(bar.value)).toEqual({ status: { $eq: 'paid' } });
  });
});
