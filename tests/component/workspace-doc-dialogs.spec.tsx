// Phase 1 characterization tests (specs/PLAN-workspace-decomposition.md §5,
// T2) for the Insert/Duplicate/Edit wiring at Workspace.tsx:2602-2634, plus
// `openDuplicate` (~1124) and `openInsertModal` (~1068). Every case mounts
// the real `<Workspace />` and drives it through the DOM.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock, connectionFixture } from '../helpers/atelierMock';
import { stripIdForDuplicate } from '../../src/pages/Workspace/views/docId';
import type { CollectionTab, CollectionTabState } from '@shared/types';
import type { ScriptEditorProps } from '../../src/components/ScriptEditor';
import type { IpcApi } from '@shared/ipc';

// The Document Editor's JSON view mounts a real CodeMirror 6 `ScriptEditor`,
// which needs layout APIs jsdom doesn't implement (see
// `document-editor.spec.tsx`). This suite only drives its text and blur, not
// the completion popup, so the stub stays minimal.
vi.mock('../../src/components/ScriptEditor', () => ({
  ScriptEditor: ({ value, onChange, onBlur, testId, ariaLabel }: ScriptEditorProps) => (
    <textarea
      data-testid={testId}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onBlur?.()}
    />
  ),
}));

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
      // Rendered straight from tab state — seeding it shows the row without
      // clicking Run, and skips the auto-run-on-open effect.
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

function mount(overrides: Parameters<typeof installAtelierMock>[0] = {}, t: CollectionTab = tab()) {
  installAtelierMock({
    tabs: { list: async () => [t] },
    conn: { list: async () => [connectionFixture({ id: 'c1' })] },
    ...overrides,
  });
  return mountWorkspace();
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

/** The editor's JSON textbox, after switching that dialog to the JSON view. */
function jsonTextOf(dialog: HTMLElement): string {
  fireEvent.click(within(dialog).getByRole('radio', { name: 'JSON' }));
  return (within(dialog).getByRole('textbox', { name: 'Document JSON' }) as HTMLTextAreaElement).value;
}

describe('workspace doc dialogs (T2)', () => {
  it('toolbar "Insert" opens the Document Editor with the default {} document', async () => {
    mount();

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: 'Insert document' }));

    const dialog = await screen.findByRole('dialog', { name: 'Insert document' });
    expect(jsonTextOf(dialog)).toBe('{}');
  });

  // The header's doc count used to be fetched once at open and never again —
  // a completed insert re-runs the query but the header kept the stale
  // number. This drives the real toolbar Insert flow end to end and checks
  // the header text, not just that a refresh function was called.
  it('a completed insert bumps the header doc count', async () => {
    // Stateful, not call-order-based: `documentCount` reflects the real
    // count, bumped only by a completed insert. A call-order mock (1st call
    // -> 1, every call after -> 2) can't tell an insert-triggered refetch
    // apart from the unrelated one-time prefs-ready remount (see
    // CollectionHeader's refreshSignal effect) — if that remount's own
    // refetch happens to land before the insert, it alone would already
    // paint "2 docs", and the test would pass even with no insert-triggered
    // refetch at all. Deriving the count from actual insert calls makes any
    // refetch before the insert honestly return 1.
    let docCount = 1;
    const collectionDetails = vi.fn(async () => ({
      name: 'orders',
      type: 'collection' as const,
      capped: false,
      stats: { documentCount: docCount, indexCount: 1 },
      options: {},
    }));
    const insert = vi.fn(async () => {
      docCount += 1;
      return { insertedId: 'x' };
    });
    mount({ meta: { collectionDetails }, doc: { insert } });

    // Matched by its own textContent ("N docs · 1 indexes") rather than a
    // bare digit — a bare "1" also matches pagination/row-count text
    // elsewhere in the mounted Workspace.
    const headerStats = (n: number) =>
      screen.getByText((_, el) => el?.textContent?.startsWith(`${n} docs`) ?? false);

    await screen.findByText(/widget/);
    await waitFor(() => expect(headerStats(1)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Insert document' }));
    const dialog = await screen.findByRole('dialog', { name: 'Insert document' });
    fireEvent.click(within(dialog).getByRole('button', { name: /^insert/i }));

    await waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
    // The observable outcome, not the fetch count: the panel prefs load
    // (`useWorkspacePanelPrefs`) remounts the whole panel subtree — this
    // header included — exactly once, whenever its own async prefs fetch
    // resolves, independently of any insert. Under full-suite load that
    // remount can land at an indeterminate point relative to the insert,
    // so asserting a `collectionDetails` call count (however it's counted)
    // is inherently racy. The header text is what a user actually sees,
    // and it can only read "2" once a refetch has landed a fresh count.
    await waitFor(() => expect(headerStats(2)).toBeTruthy());
  });

  // T2.6 — "Duplicate document" is wired from TableView's row context menu
  // only (TreeView/JsonView don't offer it), so this seeds the tab in Table
  // view rather than driving a view switch through the SegmentedControl.
  it('"Duplicate document" opens the Document Editor pre-filled with the source doc\'s EJSON minus _id', async () => {
    mount({}, tab({ view: 'Table' }));

    await screen.findByText(/widget/);
    fireEvent.contextMenu(screen.getByTitle(/Drag to add "sku/));
    fireEvent.click(screen.getByText('Duplicate document'));

    const dialog = await screen.findByRole('dialog', { name: 'Insert document' });
    // Fields is the default view, so the seeded field renders straight into
    // its own row — no need to switch to JSON to see it.
    expect((within(dialog).getByRole('textbox', { name: 'sku' }) as HTMLInputElement).value).toBe('widget');
    const jsonText = jsonTextOf(dialog);
    expect(jsonText).toBe(stripIdForDuplicate(DOC));
    expect(jsonText).not.toContain('_id');
  });

  it('closing after a duplicate clears duplicateDocJson, so the next plain Insert opens empty again', async () => {
    mount({}, tab({ view: 'Table' }));

    await screen.findByText(/widget/);
    fireEvent.contextMenu(screen.getByTitle(/Drag to add "sku/));
    fireEvent.click(screen.getByText('Duplicate document'));

    const dupDialog = await screen.findByRole('dialog', { name: 'Insert document' });
    fireEvent.click(within(dupDialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Switch back to Tree so the toolbar "Insert document" button is
    // reachable the same way case 1 above finds it (Table view has no such
    // toolbar button visible without it — CollectionHeader is shared, so
    // this is just re-establishing the same entry point).
    fireEvent.click(screen.getByRole('button', { name: 'Insert document' }));

    const dialog = await screen.findByRole('dialog', { name: 'Insert document' });
    expect(jsonTextOf(dialog)).toBe('{}');
  });

  it('onInserted closes the drawer and re-runs the query; onPartialInsert re-runs without closing', async () => {
    const insert = vi.fn(async () => ({ insertedId: 'x' }));
    const find = vi.fn(async () => ({ documents: [], durationMs: 0, hasMore: false }));
    mount({ doc: { insert }, query: { find } });

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: 'Insert document' }));
    const dialog = await screen.findByRole('dialog', { name: 'Insert document' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'JSON' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Document JSON' }), {
      target: { value: '{"sku":"new"}' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Insert$/ }));

    await waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Insert document' })).toBeNull());
  });

  it('onPartialInsert (a failed insertMany with some docs already written) re-runs the query but keeps the drawer open', async () => {
    const insertMany = vi.fn(async () => {
      const err = new Error('duplicate key') as Error & { code?: string; details?: unknown };
      err.code = 'CONFLICT';
      err.details = { insertedCount: 1 };
      throw err;
    });
    const find = vi.fn(async () => ({ documents: [], durationMs: 0, hasMore: false }));
    mount({ doc: { insertMany }, query: { find } });

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: 'Insert document' }));
    const dialog = await screen.findByRole('dialog', { name: 'Insert document' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'JSON' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Document JSON' }), {
      target: { value: '[{"sku":"a"},{"sku":"b"}]' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Insert/ }));

    await waitFor(() => expect(insertMany).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    // Partial-insert path re-runs but does NOT close the drawer.
    expect(screen.getByRole('dialog', { name: 'Insert document' })).toBeTruthy();
  });

  // The re-run is the part of this wiring that is Workspace's own
  // (`handleDocSaved` → `refreshSource`): drop it and `find` never fires.
  it('row "Edit" opens the Document Editor on that document; a save sends only the change, re-runs the query, and closes', async () => {
    const updateOne = vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 }));
    const find = vi.fn(async () => ({ documents: [], durationMs: 0, hasMore: false }));
    mount({ doc: { updateOne }, query: { find } });

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: /^Edit document/ }));

    const dialog = await screen.findByRole('dialog', { name: /^Edit document/ });
    const sku = within(dialog).getByRole('textbox', { name: 'sku' }) as HTMLTextAreaElement;
    expect(sku.value).toBe('widget');

    fireEvent.change(sku, { target: { value: 'edited' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(1));
    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        filterJson: JSON.stringify({ _id: '1', sku: { $eq: 'widget' } }),
        updateJson: JSON.stringify({ $set: { sku: 'edited' } }),
      }),
    );
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Edit document/ })).toBeNull());
  });

  it('on a read-only connection, row "Edit" never opens the editor', async () => {
    installAtelierMock({
      tabs: { list: async () => [tab()] },
      conn: { list: async () => [connectionFixture({ id: 'c1', readOnly: true })] },
    });
    mountWorkspace();

    await screen.findByText(/widget/);
    fireEvent.click(screen.getByRole('button', { name: /^Edit document/ }));

    expect(await screen.findByText('Read-only connection')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: /^Edit document/ })).toBeNull();
  });
});

// W18 §8 — Table Quick Edit, driven against the real `Workspace.tsx`
// `updateField`/`openEdit`, not the test-local copy `table-inline-edit.spec.tsx`
// exercises against `TableView` in isolation. That copy proves `TableCell`'s
// own behavior; these prove the real wiring it's plugged into — a
// regression in `updateField`'s guard, or a dropped `focusPath` prop on the
// way to `DocumentEditor`, would pass every `TableView`-level test unnoticed.
describe('workspace doc dialogs (T2) — Table Quick Edit (W18 §8)', () => {
  it('inline-edits a string cell through the real updateField: a guarded request, not a raw $set', async () => {
    const updateOne = vi.fn<IpcApi['doc']['updateOne']>(async () => ({ matchedCount: 1, modifiedCount: 1 }));
    const find = vi.fn(async () => ({ documents: [], durationMs: 0, hasMore: false }));
    mount({ doc: { updateOne }, query: { find } }, tab({ view: 'Table' }));

    await screen.findByText(/widget/);
    const cell = screen.getByTitle(/Drag to add "sku/);
    fireEvent.mouseEnter(cell);
    fireEvent.click(within(cell).getByRole('button', { name: 'Edit cell value' }));
    const input = within(cell).getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'gadget' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(updateOne).toHaveBeenCalledTimes(1));
    const call = updateOne.mock.calls[0]![0];
    expect(JSON.parse(call.filterJson)).toEqual({ _id: '1', sku: { $eq: 'widget' } });
    expect(JSON.parse(call.updateJson)).toEqual({ $set: { sku: 'gadget' } });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
  });

  it('a concurrent change under a real Quick Edit (matchedCount: 0) surfaces the conflict notice', async () => {
    const updateOne = vi.fn(async () => ({ matchedCount: 0, modifiedCount: 0 }));
    mount({ doc: { updateOne } }, tab({ view: 'Table' }));

    await screen.findByText(/widget/);
    const cell = screen.getByTitle(/Drag to add "sku/);
    fireEvent.mouseEnter(cell);
    fireEvent.click(within(cell).getByRole('button', { name: 'Edit cell value' }));
    const input = within(cell).getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'gadget' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(screen.getByText(/This document changed since it was loaded/)).toBeTruthy(),
    );
  });

  it('a non-inline-editable field\'s pencil opens the real Document Editor scrolled and focused on that field', async () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
    const doc = { _id: '1', sku: 'widget', createdAt: { $date: { $numberLong: '0' } } };
    mount(
      {},
      tab({ view: 'Table', lastRun: { documents: [doc], durationMs: 1, ranAt: NOW } }),
    );

    await screen.findByText(/widget/);
    const cell = screen.getByTitle(/Drag to add "createdAt/);
    fireEvent.mouseEnter(cell);
    // Never turns into an inline text box — Date opens the full editor.
    expect(within(cell).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(cell).getByRole('button', { name: 'Edit cell value' }));

    const dialog = await screen.findByRole('dialog', { name: /^Edit document/ });
    expect(scrollSpy).toHaveBeenCalled();
    // Mantine's own focus trap also moves focus on open, asynchronously —
    // let both settle before reading `document.activeElement`.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'createdAt' }));
  });
});
