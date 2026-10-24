// Phase 1 characterization tests (specs/PLAN-workspace-decomposition.md §5,
// T1) for the delete-mode block at Workspace.tsx:2637-2700 — an IIFE inside
// JSX that resolves three mutually-exclusive delete modes (single doc /
// delete-all-matching / delete-selected) and two refusals. These tests pin
// down *current* behavior, before Phase 2 (R1) lifts the decision into
// `deleteMode.ts`'s `resolveDeleteMode`. Every case mounts the real
// `<Workspace />` and drives it through the DOM — no reaching into
// `WorkspaceInner`.
//
// T1.4/T1.5 ("Delete selected" and its `$in`-derivation refusal) are
// deliberately NOT here — per the plan's carved exception, result-row
// selection isn't reachable from a full-page mount in jsdom (both existing
// selection tests mount `ResultBar`/`ResultViewer` in isolation instead).
// Those land as unit tests on `resolveDeleteMode` in R1.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock, connectionFixture } from '../helpers/atelierMock';
import type { CollectionTab, CollectionTabState } from '@shared/types';

const NOW = '2026-08-01T12:00:00.000Z';
const DOC = { _id: '1', sku: 'widget' };

function tab(
  stateOverrides: Partial<CollectionTabState> = {},
  tabOverrides: Partial<CollectionTab> = {},
): CollectionTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'shop',
    collection: 'orders',
    position: 0,
    isActive: true,
    openedAt: NOW,
    pinned: false,
    state: {
      view: 'Tree',
      builder: { projection: [], sort: '', limit: '' },
      queryRaw: '{}',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
      // Rendered straight from tab state (ResultViewer reads
      // `state.lastRun?.documents`), so seeding this shows the row without
      // needing to click Run — and it also gates the auto-run-on-open
      // effect (Workspace.tsx:939), which would otherwise fire an
      // unmocked `query.find`.
      lastRun: { documents: [DOC], durationMs: 1, ranAt: NOW },
      ...stateOverrides,
    },
    ...tabOverrides,
  };
}

function mountWorkspace() {
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

describe('workspace delete modes (T1)', () => {
  it('row "Delete" opens DeleteConfirm scoped to that one document, with no filter', async () => {
    const deleteOne = vi.fn(async () => ({ deletedCount: 1 }));
    installAtelierMock({
      tabs: { list: async () => [tab()] },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
      doc: { deleteOne },
    });
    mountWorkspace();

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: /^Delete document/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete document?' });
    // Single-doc mode carries no "type the collection name" confirmation —
    // that's the tell for the filter-scoped mode (isMulti).
    expect(within(dialog).queryByPlaceholderText('orders')).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(deleteOne).toHaveBeenCalledWith({
        connectionId: 'c1',
        dbName: 'shop',
        collection: 'orders',
        filterJson: JSON.stringify({ _id: '1' }),
      }),
    );
  });

  it('"Delete all matching…" with a valid filter carries that filter to confirmDeleteMany', async () => {
    const confirmDeleteMany = vi.fn(async () => ({ count: 2, confirmToken: 'tok-1' }));
    installAtelierMock({
      tabs: { list: async () => [tab({ queryRaw: '{"status":"pending"}' })] },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
      doc: { confirmDeleteMany },
    });
    mountWorkspace();

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByText('Delete all matching…'));

    await waitFor(() =>
      expect(confirmDeleteMany).toHaveBeenCalledWith({
        connectionId: 'c1',
        dbName: 'shop',
        collection: 'orders',
        filterJson: '{"status":"pending"}',
      }),
    );
    expect(await screen.findByText('Delete 2 matching documents?')).toBeTruthy();
  });

  // W14 §9 — the doc channels send only the filter, so with a collation on
  // the tab a write by filter would act on a different set than the one on
  // screen. The tab's collation has to reach the dialogs for them to refuse.
  it('"Delete all matching…" and "Update all matching…" refuse while the tab has a collation', async () => {
    const collated = tab({
      queryRaw: '{"status":"pending"}',
      builder: { projection: [], sort: '', limit: '', collation: '{"locale":"en","strength":2}' },
    });
    const confirmDeleteMany = vi.fn(async () => ({ count: 2, confirmToken: 'tok-1' }));
    installAtelierMock({
      tabs: { list: async () => [collated] },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
      doc: { confirmDeleteMany },
    });
    mountWorkspace();

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByText('Delete all matching…'));
    const del = await screen.findByRole('dialog', { name: 'Delete matching documents?' });
    expect(confirmDeleteMany).not.toHaveBeenCalled();
    expect(
      within(del).getByText('Clear the collation to delete by filter: it would change which documents match.'),
    ).toBeTruthy();
    expect((within(del).getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(del).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByText('Update all matching…'));
    const upd = await screen.findByRole('dialog', { name: 'Update all matching documents' });
    expect(
      within(upd).getByText('Clear the collation to update by filter: it would change which documents match.'),
    ).toBeTruthy();
  });

  it('a row "Delete" is not refused by the tab collation: it deletes by _id', async () => {
    installAtelierMock({
      tabs: {
        list: async () => [tab({ builder: { projection: [], sort: '', limit: '', collation: '{"locale":"en"}' } })],
      },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
    });
    mountWorkspace();

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: /^Delete document/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete document?' });
    expect(within(dialog).queryByText(/Clear the collation/)).toBeNull();
    expect((within(dialog).getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false);
  });

  // W14 §9 — a hint naming a sparse index can show fewer documents than the
  // filter matches, so the tab's hint has to reach the dialogs too.
  it('"Delete all matching…" and "Update all matching…" refuse while the tab has a hint', async () => {
    const hinted = tab({
      queryRaw: '{"status":"pending"}',
      builder: { projection: [], sort: '', limit: '', hint: 'status_1_sparse' },
    });
    const confirmDeleteMany = vi.fn(async () => ({ count: 2, confirmToken: 'tok-1' }));
    installAtelierMock({
      tabs: { list: async () => [hinted] },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
      doc: { confirmDeleteMany },
    });
    mountWorkspace();

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByText('Delete all matching…'));
    const del = await screen.findByRole('dialog', { name: 'Delete matching documents?' });
    expect(confirmDeleteMany).not.toHaveBeenCalled();
    expect(within(del).getByText(/^Clear the hint to delete by filter/)).toBeTruthy();
    expect((within(del).getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(del).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByText('Update all matching…'));
    const upd = await screen.findByRole('dialog', { name: 'Update all matching documents' });
    expect(within(upd).getByText(/^Clear the hint to update by filter/)).toBeTruthy();
  });

  it('a row "Delete" is not refused by the tab hint: it deletes by _id', async () => {
    installAtelierMock({
      tabs: {
        list: async () => [tab({ builder: { projection: [], sort: '', limit: '', hint: 'status_1_sparse' } })],
      },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
    });
    mountWorkspace();

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: /^Delete document/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete document?' });
    expect(within(dialog).queryByText(/Clear the hint/)).toBeNull();
    expect((within(dialog).getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false);
  });

  // falling through to DeleteConfirm's `filter ?? '{}'` default here
  // would count/delete the *entire* collection. `openDeleteAllModal` must
  // refuse to open the dialog at all when the tab's filter text is blank or
  // not valid EJSON.
  it('"Delete all matching…" refuses to open when the filter is blank', async () => {
    const confirmDeleteMany = vi.fn();
    installAtelierMock({
      tabs: { list: async () => [tab({ queryRaw: '' })] },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
      doc: { confirmDeleteMany },
    });
    mountWorkspace();

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByText('Delete all matching…'));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(confirmDeleteMany).not.toHaveBeenCalled();
  });

  it('"Delete all matching…" refuses to open when the filter text is invalid EJSON', async () => {
    const confirmDeleteMany = vi.fn();
    installAtelierMock({
      tabs: { list: async () => [tab({ queryRaw: '{not json' })] },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
      doc: { confirmDeleteMany },
    });
    mountWorkspace();

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByText('Delete all matching…'));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(confirmDeleteMany).not.toHaveBeenCalled();
  });

  // The other half of that same guard — `openDeleteAllModal` refusing to open covers the
  // filter being invalid up front, but the render-time guard
  // (`deleteAllActive = deleteAllOpen && deleteAllFilterJson !== null`) is a
  // second, independent check for the filter going invalid *after* the
  // dialog is already open (editing the query bar behind it). Without that
  // guard, `filter` would reach DeleteConfirm as `undefined` and its own
  // `filter ?? '{}'` default would count/delete the whole collection.
  it('an already-open "Delete all matching…" dialog closes itself if the filter goes invalid while it is up', async () => {
    installAtelierMock({
      tabs: { list: async () => [tab({ queryRaw: '{"status":"pending"}' })] },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
      doc: { confirmDeleteMany: async () => ({ count: 2, confirmToken: 'tok-1' }) },
    });
    mountWorkspace();

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByText('Delete all matching…'));
    await screen.findByRole('dialog');

    // Edit the query bar's raw filter — still mounted behind the modal —
    // to blank, exactly the scenario the source comment at Workspace.tsx
    // names ("the bar text goes invalid while the modal is already up").
    fireEvent.change(screen.getByTestId('query-bar-input'), { target: { value: '' } });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('onClose clears the row-delete state — canceling it does not leak into a later "Delete all matching…"', async () => {
    // Regression for the mutual-exclusivity guardrail: DeleteConfirm's `docs`
    // ternary checks `deleteDoc !== null` first, so if Cancel failed to null
    // it out, the *next* dialog opened (delete-all, a different mode) would
    // still render as the single-doc one instead of the filter-scoped one.
    installAtelierMock({
      tabs: { list: async () => [tab({ queryRaw: '{"status":"pending"}' })] },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
      doc: { confirmDeleteMany: async () => ({ count: 2, confirmToken: 'tok-1' }) },
    });
    mountWorkspace();

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: /^Delete document/ }));
    const rowDialog = await screen.findByRole('dialog', { name: 'Delete document?' });
    fireEvent.click(within(rowDialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByText('Delete all matching…'));

    const dialog = await screen.findByRole('dialog');
    // The filter-scoped mode's tell — present only when isMulti (docs.length
    // > 1 || !!filter). A leaked `deleteDoc` would render the single-doc
    // dialog instead, which has no such input.
    expect(within(dialog).getByPlaceholderText('orders')).toBeTruthy();
  });

  it('onClose clears the delete-all state too — canceling it does not leak into a later row Delete', async () => {
    // The symmetric leak: `deleteAllOpen` staying true after Cancel would
    // make `deleteAllActive` true again as soon as any later row Delete
    // reopens the dialog (both read the same still-valid `queryRaw` filter),
    // rendering the filter-scoped mode instead of the single-doc one.
    installAtelierMock({
      tabs: { list: async () => [tab({ queryRaw: '{"status":"pending"}' })] },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
      doc: { confirmDeleteMany: async () => ({ count: 2, confirmToken: 'tok-1' }) },
    });
    mountWorkspace();

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByText('Delete all matching…'));
    const allDialog = await screen.findByRole('dialog');
    expect(within(allDialog).getByPlaceholderText('orders')).toBeTruthy();
    fireEvent.click(within(allDialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /^Delete document/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete document?' });
    // A leaked `deleteAllOpen` would render the filter-scoped dialog instead,
    // which carries this confirmation input.
    expect(within(dialog).queryByPlaceholderText('orders')).toBeNull();
  });

  it('onDeleted closes the dialog and re-runs the active query', async () => {
    const deleteOne = vi.fn(async () => ({ deletedCount: 1 }));
    const find = vi.fn(async () => ({ documents: [], durationMs: 0, hasMore: false }));
    installAtelierMock({
      tabs: { list: async () => [tab()] },
      conn: { list: async () => [connectionFixture({ id: 'c1' })] },
      doc: { deleteOne },
      query: { find },
    });
    mountWorkspace();

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: /^Delete document/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete document?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteOne).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  // X16.1 — the delete dialog's `readOnly` reads the Focused Tab's own
  // Connection, not some other open Connection. Two Connections here with
  // opposite `readOnly` flags catch a naive "first Connection in the list" or
  // stale "active Connection" read red-handed.
  it("readOnly reads off the Focused Tab's Connection, not another open one", async () => {
    installAtelierMock({
      tabs: {
        list: async () => [
          tab({}, { id: 't1', connectionId: 'c1', isActive: false, position: 0 }),
          tab({}, { id: 't2', connectionId: 'c2', isActive: true, position: 1 }),
        ],
      },
      conn: {
        list: async () => [
          connectionFixture({ id: 'c1', name: 'Writable', readOnly: false }),
          connectionFixture({ id: 'c2', name: 'ReadOnly', readOnly: true }),
        ],
      },
    });
    mountWorkspace();

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: /^Delete document/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete document?' });
    expect(
      within(dialog).getByText('This connection is read-only. Deleting is disabled.'),
    ).toBeTruthy();
    expect(
      (within(dialog).getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
