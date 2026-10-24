import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { commandRegistry } from '../../src/commands/registry';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTabState, WorkspaceTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

const now = '2026-08-02T12:00:00.000Z';

function makeState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    // Seeded so the auto-run-on-open effect doesn't fire a background
    // find and desynchronize the call-count assertions below.
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

/**
 * Mount Workspace over a single collection tab holding `state`. Returns the
 * `find` spy and the `tabs.update` spy — the latter is how we observe what a
 * UI interaction actually persisted, since tab state is written through IPC.
 */
function mountWith(
  state: CollectionTabState,
  prefs: Record<string, unknown> = {},
) {
  const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
    documents: [],
    durationMs: 3,
    hasMore: false,
  }));
  const confirmDeleteManySpy = vi.fn<IpcApi['doc']['confirmDeleteMany']>(async () => ({
    count: 0,
    confirmToken: 'tok',
  }));
  const updateSpy = vi.fn(async () => makeCollectionTab(state));

  installAtelierMock({
    tabs: {
      list: async () => [makeCollectionTab(state)],
      setActive: async (id) => ({ id }),
      update: updateSpy as unknown as IpcApi['tabs']['update'],
    },
    conn: { list: async () => [CONNECTION] },
    prefs: {
      get: async (key: string) => prefs[key] ?? null,
      set: async () => undefined,
    } as unknown as IpcApi['prefs'],
    query: { find: findSpy, count: async () => ({ count: 0 }) },
    doc: { confirmDeleteMany: confirmDeleteManySpy } as unknown as IpcApi['doc'],
  });

  const utils = render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
  return { ...utils, findSpy, confirmDeleteManySpy, updateSpy };
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

// ─── blank or invalid filter text (W13-updated) ────────────────────────────
//
// Pre-W13, this block covered a builder condition the compiler couldn't
// encode (e.g. `$elemMatch`), which still compiled to syntactically-valid,
// semantically-wrong EJSON. W13 deletes that whole failure class: the
// drawer's raw-node degradation (§2) means an `$elemMatch` clause is now just
// ordinary `queryRaw` text, valid and runnable. What's left of that case is the
// blank/invalid-text refusal — `currentFilterJson` returning `null` — and
// this block now covers that instead, through the two paths that don't go
// through a disableable button: the command palette, and delete-all.
describe(' a blank or invalid filter text has no runnable filter', () => {
  it('the runner refuses even when invoked with no button to disable', async () => {
    // Disabling the Run button isn't enough — `query.run` (palette / ⌘↵)
    // calls the runner directly, bypassing the button's disabled state
    // entirely. The guard has to live in the runner itself.
    const { findSpy } = mountWith(makeState({ queryRaw: '   ' }));

    await screen.findByTestId('query-run-btn');
    const ctx = { pathname: '/workspace', connectionId: 'c1' };
    const runCmd = commandRegistry.list().find((c) => c.id === 'query.run');
    expect(runCmd).toBeDefined();

    act(() => {
      void runCmd!.perform(ctx);
    });

    await waitFor(() => {
      expect(screen.getByText(/blank or not valid JSON/)).toBeTruthy();
    });
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('delete-all refuses to arm on blank filter text — the confirm dialog never mounts', async () => {
    // This is the regression proof for the ticket's `currentFilterJson`
    // contract: if a `?? '{}'`-shaped fallback ever crept into
    // `openDeleteAllModal`'s guard or `currentFilterJson` itself, this test
    // would instead see the confirm dialog mount (and, given more time,
    // `doc.confirmDeleteMany` fire against the whole collection). Assert on
    // the dialog's absence — not the toast wording — so a message reword
    // can't silently defang the guard.
    const { confirmDeleteManySpy } = mountWith(makeState({ queryRaw: '   ' }));

    const overflow = await screen.findByRole('button', { name: 'Documents' });
    fireEvent.click(overflow);
    const deleteAllItem = await screen.findByRole('menuitem', { name: /Delete all matching/ });
    fireEvent.click(deleteAllItem);

    // Give the (wrongly) armed modal a tick to mount, then assert it didn't.
    // Matches DeleteConfirm's dialog title exactly ("Delete matching
    // documents?" / "Delete N matching document(s)?") rather than a bare
    // "matching document" substring, which also appears in the result bar's
    // own empty-results text ("No matching documents") and would false-pass.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/^Delete .*matching document/)).toBeNull();
    expect(confirmDeleteManySpy).not.toHaveBeenCalled();
  });
});

// ─── builder edits do not clobber a hand-edited filter ─────────────────────

describe(' builder edits do not clobber a hand-edited filter', () => {
  const HAND_WRITTEN_RAW = '{"$expr":{"$gt":["$a","$b"]}}';

  it('a drawer edit leaves the hand-written filter in the bar', async () => {
    mountWith(makeState({ queryRaw: HAND_WRITTEN_RAW }));

    // "add condition…" is the drawer's own affordance — the interaction most
    // likely to happen right after someone hand-writes a filter.
    const addCond = await screen.findByRole('button', { name: 'Add condition' });
    fireEvent.click(addCond);

    // The pending row renders…
    await waitFor(() => {
      expect(screen.getByPlaceholderText('field')).toBeTruthy();
    });
    // …and a pending row (§5) never writes `queryRaw` — the bar still holds
    // exactly the text the user typed.
    const textarea = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;
    expect(textarea.value).toBe(HAND_WRITTEN_RAW);
  });

  it('removing the last condition collapses the filter to {} in the bar', async () => {
    // W13 deletes the SYNCED/DIRTY distinction entirely (spec §5, §6a): the
    // drawer always writes straight to `queryRaw` through `printFilter`,
    // seeded from `queryRaw` alone — `builder.conditions` plays no part in
    // what the drawer renders.
    mountWith(makeState({ queryRaw: '{"name":{"$eq":"alice"}}' }));

    const textarea = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe('{"name":{"$eq":"alice"}}'));

    fireEvent.click(await screen.findByRole('button', { name: 'Remove condition name' }));

    await waitFor(() => {
      expect(textarea.value).toBe('{}');
    });
  });
});

// ─── one SaveModal, owned above the builder pane ───────────────────────────

describe(' one SaveModal, owned above the builder pane', () => {
  // X15 T5 moved SaveModal onto a Mantine `Modal`, so its panel now lives in a
  // portal on `document.body` rather than beside the builder. The Name field
  // stays the reliable per-instance marker — it is an accessible query, so it
  // counts mounted modals wherever they render.
  const mountedSaveModals = () => screen.queryAllByLabelText(/Name/).length;

  it('exactly one Save button renders in the Documents view, and it carries the save hint anchor', async () => {
    mountWith(makeState());

    // The toolbar's Save exists…
    await screen.findByRole('button', { name: /^Save$/ });
    // …and the drawer footer's copy is gone rather than just hidden —
    // `queryAllByRole` over the whole rendered tree, not a scoped query, so a
    // stray second Save anywhere in the Documents view would fail this.
    expect(screen.queryAllByRole('button', { name: /^Save$/ })).toHaveLength(1);

    // The `saved.create` feature hint moved with the toolbar Save.
    expect(document.querySelectorAll('[data-hint-anchor="saved.create"]')).toHaveLength(1);
  });

  it('the toolbar Save opens exactly one modal', async () => {
    mountWith(makeState());

    // The toolbar button is labelled by its visible text, not an aria-label —
    // it is the only Save button left; the builder-drawer footer's copy is
    // gone.
    const toolbarSave = await screen.findByRole('button', { name: /^Save$/ });
    expect(mountedSaveModals()).toBe(0);
    fireEvent.click(toolbarSave);

    await waitFor(() => expect(mountedSaveModals()).toBe(1));
  });

  it('the query.save command survives a collapsed builder pane', async () => {
    // The behavioural half of the fix: `query.save` used to be registered
    // inside BuilderPane, which is unmounted while collapsed — so the palette
    // command silently vanished exactly when the drawer's own Save button was
    // also unreachable. The toolbar Save lives in QueryBar, outside
    // BuilderPane, so it — and the command — survive the collapse.
    mountWith(makeState(), { 'ui.workspace.builderCollapsed': true });

    await screen.findByRole('button', { name: /^Save$/ });

    const ctx = { pathname: '/workspace', connectionId: 'c1' };
    const saveCmd = commandRegistry.list().find((c) => c.id === 'query.save');
    expect(saveCmd).toBeDefined();
    expect(saveCmd!.when?.(ctx) ?? true).toBe(true);

    act(() => {
      void saveCmd!.perform(ctx);
    });
    await waitFor(() => expect(mountedSaveModals()).toBe(1));
  });
});

// ─── History works with the builder drawer collapsed ───────────────────────

describe(' History works with the builder drawer collapsed', () => {
  it('expands the drawer and shows the Recent tab', async () => {
    mountWith(makeState(), { 'ui.workspace.builderCollapsed': true });

    // Collapsed: BuilderPane is not mounted, so its tab strip is absent.
    const history = await screen.findByRole('button', { name: 'History' });
    await waitFor(() => {
      // W13 §6 renames the first tab's label Builder → Filter.
      expect(screen.queryByRole('tab', { name: 'Filter' })).toBeNull();
    });

    fireEvent.click(history);

    // One click: the pane is mounted…
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Filter' })).toBeTruthy();
    });
    // …and it landed on Recent, not on its default Filter tab (whose footer
    // — Reset / Copy code / Save, post-W13 — is Filter-tab-only).
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('switches an already-expanded drawer to the Recent tab', async () => {
    mountWith(makeState(), { 'ui.workspace.builderCollapsed': false });

    // The footer (Reset / Copy code / Save) renders on the Builder tab only,
    // so Reset disappearing is the signal that the pane actually switched
    // tabs rather than just persisting a flag. (Pre-W13 this used the
    // drawer's own Run button as the signal; W13 §7 deleted it.)
    await screen.findByRole('button', { name: 'Reset' });
    fireEvent.click(await screen.findByRole('button', { name: 'History' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
    });
  });
});

// ─── W13 §7 ──────────────────────────────────────────────────────────────────

describe('W13 §7 — single owner, single Run', () => {
  it('exactly one Run button renders in the Documents view', async () => {
    mountWith(makeState());

    // The bar's Run exists…
    await screen.findByTestId('query-run-btn');
    // …and the drawer's is gone rather than just hidden — `getAllByTestId`
    // over the whole rendered tree, not a scoped query, so a stray second
    // Run anywhere in the Documents view would fail this.
    expect(screen.queryAllByTestId('builder-run-btn')).toHaveLength(0);
  });

  it('⌘/Ctrl+Enter runs from inside a drawer input, not just the query bar', async () => {
    // Removing BuilderPane's footer Run (§7) only costs no reach if ⌘↵
    // actually reaches drawer inputs — prove it by dispatching the key event
    // on a real drawer input (the condition row's field TextInput, which
    // renders entirely inside BuilderPane), not on `document` or the query
    // bar's own textarea.
    const { findSpy } = mountWith(makeState());

    const addCond = await screen.findByRole('button', { name: 'Add condition' });
    fireEvent.click(addCond);
    const fieldInput = await screen.findByPlaceholderText('field');
    expect(findSpy).not.toHaveBeenCalled();

    fireEvent.keyDown(fieldInput, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
  });

  it('⌘/Ctrl+Enter from a drawer input stays inert when the bar holds invalid JSON', async () => {
    // Same rule, same button, two entry points: the bar's own Run is
    // disabled here (`isValidEjson` fails), so a drawer input's ⌘↵ must be
    // inert too — otherwise the drawer becomes a second Run under a looser
    // rule than the bar's, which is the exact defect this section exists to kill.
    //
    // W13 §6a freezes the drawer read-only while the bar holds invalid
    // JSON — every add/edit control is disabled, so there's no editable
    // condition row to dispatch on here. The "Filter" tab button is still
    // inside the Documents view the ⌘↵ handler covers (`PanelBody`'s panel
    // group) and stays enabled even while frozen, so it still proves the
    // handler is reachable — and inert — from within the drawer.
    const { findSpy } = mountWith(makeState({ queryRaw: 'not valid json{{{' }));

    const runBtn = await screen.findByTestId('query-run-btn');
    expect(runBtn).toHaveProperty('disabled', true);

    await screen.findByText(/isn't valid JSON/);
    const filterTabBtn = screen.getByRole('tab', { name: 'Filter' });

    fireEvent.keyDown(filterTabBtn, { key: 'Enter', metaKey: true });

    // Give any (wrongly) queued run a tick to land, then assert it didn't.
    await new Promise((r) => setTimeout(r, 0));
    expect(findSpy).not.toHaveBeenCalled();
  });
});

// ─── ⌘↵ from anywhere in the Documents view ──────────────────────────────
//
// The key used to be bound to the filter textarea and the drawer root only,
// so after dragging a field from the results into the drawer — focus stays
// on the result row — ⌘↵ did nothing. One handler on the panel group now
// covers the whole view, and repairs every draft before it gates.
describe('W13 §7 — ⌘↵ runs from anywhere in the Documents view', () => {
  const DOC = { _id: '1', sku: 'widget' };
  const cmdEnter = { key: 'Enter', metaKey: true };

  it('runs once from the result tree without expanding the focused row', async () => {
    const { findSpy } = mountWith(
      makeState({ lastRun: { documents: [DOC], durationMs: 0, ranAt: now } }),
    );
    const tree = await screen.findByRole('tree', { name: 'Documents' });

    fireEvent.keyDown(tree, cmdEnter);

    // Checked before the run lands, whose empty result unmounts the row. The
    // tree's own Enter expands the active row; ⌘↵ must not also do that.
    expect(within(tree).queryByRole('button', { name: 'Collapse document' })).toBeNull();
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
  });

  it('runs once from the result table without toggling the row selection', async () => {
    const { findSpy } = mountWith(
      makeState({ view: 'Table', lastRun: { documents: [DOC], durationMs: 0, ranAt: now } }),
    );
    const grid = await screen.findByRole('grid');
    act(() => grid.focus()); // focus makes the first row the active one

    fireEvent.keyDown(grid, cmdEnter);

    // Checked before the run lands: its empty result would clear a selection
    // anyway. The table's own ⌘+Space (and, before, ⌘+Enter) toggles it.
    expect(screen.queryByTestId('selection-bar-count')).toBeNull();
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
  });

  it('repairs a Shell Syntax sort that was never blurred, and runs it', async () => {
    const { findSpy } = mountWith(
      makeState({ builder: { projection: [], sort: '{sku: 1}', limit: '' } }),
    );

    fireEvent.keyDown(await screen.findByTestId('query-bar-sort'), { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    expect(findSpy.mock.calls[0][0].sort).toBe('{"sku": 1}');
  });

  // The projection's input sits in the Fields control's dropdown, a dialog
  // the panel-level ⌘↵ skips — so the control runs this one itself.
  it('commits a projection draft that was never blurred, and runs it', async () => {
    const { findSpy } = mountWith(makeState());
    fireEvent.click(await screen.findByRole('button', { name: /^fields/i }));
    const projection = await screen.findByTestId('fields-projection');

    fireEvent.change(projection, { target: { value: '{sku: 1}' } });
    fireEvent.keyDown(projection, cmdEnter);

    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    expect(findSpy.mock.calls[0][0].projection).toContain('sku');
  });

  it('refuses an invalid sort from a drawer input, says why, and clears on the next edit', async () => {
    const { findSpy } = mountWith(
      makeState({ builder: { projection: [], sort: '[1,2]', limit: '' } }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add condition' }));

    fireEvent.keyDown(await screen.findByPlaceholderText('field'), cmdEnter);

    const line = await screen.findByText('Not run: Invalid sort');
    expect(line.getAttribute('role')).toBe('alert');
    await new Promise((r) => setTimeout(r, 0));
    expect(findSpy).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('query-bar-sort'), { target: { value: '{"sku": 1}' } });
    await waitFor(() => expect(screen.queryByText('Not run: Invalid sort')).toBeNull());
  });

  it('announces a repeated refused press again', async () => {
    mountWith(makeState({ builder: { projection: [], sort: '[1,2]', limit: '' } }));
    const sort = await screen.findByTestId('query-bar-sort');

    fireEvent.keyDown(sort, cmdEnter);
    const first = await screen.findByText('Not run: Invalid sort');
    fireEvent.keyDown(sort, cmdEnter);

    // A new alert node, not the same one re-rendered — only a fresh
    // `role="alert"` is announced.
    await waitFor(() => expect(screen.getByText('Not run: Invalid sort')).not.toBe(first));
  });

  // W14 §9 — the shortcut's gate reads the find options too, or ⌘↵ would
  // run a query the disabled Run button refuses.
  it('refuses a find option that cannot run, and says so', async () => {
    const { findSpy } = mountWith(
      makeState({ builder: { projection: [], sort: '', limit: '', collation: 'en' } }),
    );

    fireEvent.keyDown(await screen.findByTestId('query-bar-collation'), cmdEnter);

    expect(await screen.findByText('Not run: Invalid find option')).toBeTruthy();
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('names a refused filter whose notice was already on screen', async () => {
    const { findSpy } = mountWith(makeState({ queryRaw: '[1,2]' }));
    const textarea = await screen.findByTestId('query-bar-input');
    fireEvent.blur(textarea);
    await screen.findByText(/A filter must be a document/);

    // That notice is old news by now; the press has to say something itself.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Filter' }), cmdEnter);

    expect(await screen.findByText('Not run: Invalid MQL')).toBeTruthy();
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('leaves ⌘↵ inside a dialog to that dialog', async () => {
    const { findSpy } = mountWith(makeState());
    fireEvent.click(await screen.findByTestId('query-bar-expand-btn'));
    const dialog = await screen.findByRole('dialog');

    fireEvent.keyDown(within(dialog).getByRole('textbox'), cmdEnter);

    // The expand modal's own ⌘↵ applies and closes; the find query stays put.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('does not run a find query from the Aggregation view', async () => {
    const { findSpy } = mountWith(makeState({ activeView: 'aggregation' }));
    const result = await screen.findByRole('button', { name: /Run/ });

    fireEvent.keyDown(result, cmdEnter);

    await new Promise((r) => setTimeout(r, 0));
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('puts Run last in the toolbar, after History', async () => {
    mountWith(makeState());
    const run = await screen.findByTestId('query-run-btn');
    const history = screen.getByRole('button', { name: 'History' });

    expect(history.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// ─── X15 T5 — the ⌘B guard survives portaling ─────────────────────────
//
// `Workspace.tsx`'s window-level ⌘B handler skips the toggle when the event
// originates inside `[role="dialog"]` (a review finding — ⌘B inside a
// modal toggled the builder *behind* it and pulled focus out). SaveModal and
// NewTabPicker used to satisfy that check through the normal tree; they now
// render in Mantine's portal on `document.body`. `closest` walks the DOM, not
// React's tree, so the ancestry still holds — these two tests are the proof,
// and the first is the positive control without which the second passes even
// if ⌘B were wired to nothing at all.
describe('X15 T5 — ⌘B does not reach the builder from inside a dialog', () => {
  it('control: ⌘B from outside a dialog does toggle the builder', async () => {
    mountWith(makeState());
    await screen.findByRole('tab', { name: 'Filter' });

    fireEvent.keyDown(document.body, { key: 'b', metaKey: true });

    // Collapsed means BuilderPane is unmounted, so its tab strip goes with it.
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Filter' })).toBeNull());
  });

  it('⌘B from inside the portaled SaveModal leaves the builder alone', async () => {
    mountWith(makeState());

    fireEvent.click(await screen.findByRole('button', { name: /^Save$/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Save query' });

    fireEvent.keyDown(within(dialog).getByLabelText(/Name/), { key: 'b', metaKey: true });

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('tab', { name: 'Filter' })).not.toBeNull();
  });

  it('⌘B from inside the portaled NewTabPicker leaves the builder alone', async () => {
    mountWith(makeState());
    await screen.findByRole('tab', { name: 'Filter' });

    // ⌘T is the picker's own shortcut, registered by the same handler.
    fireEvent.keyDown(document.body, { key: 't', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Open collection' });

    fireEvent.keyDown(within(dialog).getByLabelText('Database'), { key: 'b', metaKey: true });

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('tab', { name: 'Filter' })).not.toBeNull();
  });
});
