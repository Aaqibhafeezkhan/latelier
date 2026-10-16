import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  act,
  emptyWorkspaceActions,
  emptyWorkspaceMeta,
} from '../helpers/render';
import { TableView } from '../../src/pages/Workspace/views/TableView';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type {
  CollectionWorkspaceActions,
  CollectionWorkspaceMeta,
  UpdateFieldOutcome,
} from '../../src/pages/Workspace/context';
import type { CollectionTabState, TableColumnConfig } from '@shared/types';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { api, getErrorMessage } from '../../src/api/atelier';
import { ejsonParse, isPlainDocument } from '../../src/utils/ejson';
import { buildUpdateRequest, setAtSegments } from '../../src/pages/Workspace/documentDiff';
import { notify } from '../../src/theme/notifications';

// jsdom doesn't implement clipboard by default; other cell interactions
// (double-click copy) can fire incidentally during these tests.
let originalClipboard: Clipboard | undefined;
beforeEach(() => {
  originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
});
afterEach(() => {
  if (originalClipboard !== undefined) {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
  } else {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  }
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function stateWithDocs(
  docs: unknown[],
  overrides: Partial<CollectionTabState> = {},
): CollectionTabState {
  return {
    view: 'Table',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun: { documents: docs, durationMs: 1, ranAt: '2026-01-01T00:00:00Z' },
    ...overrides,
  };
}

/**
 * `updateField` mirrors Workspace.tsx's real implementation (revive -> the
 * shared `buildUpdateRequest` guarded builder -> `api.doc.updateOne` ->
 * refresh callback on success, `notify.error` on failure or a matchless
 * guard) — a noop spy would only prove the affordance renders, not the
 * `$set`+guard shape or the error-feedback path (T2.6 plan validation:
 * "real/stateful actions object, not a noop spy").
 *
 * #72 — both harnesses below had their own byte-identical copy of this.
 * They differed in one respect: the rerenderable harness hardcoded
 * `openDuplicate: vi.fn()` rather than honouring `opts`. Unifying on
 * `opts.openDuplicate ?? vi.fn()` changes nothing today — that harness's
 * `opts` has no `openDuplicate` to pass — and is the behaviour you would
 * want the day it gains one.
 */
function inlineEditActions(opts: {
  onRefresh?: () => void;
  openDuplicate?: (doc: unknown) => void;
  openEdit?: (doc: unknown, focusPath?: string) => void;
}): CollectionWorkspaceActions {
  return emptyWorkspaceActions({
    ...(opts.openEdit ? { openEdit: opts.openEdit } : {}),
    updateField: (doc, fieldPath, newValue) => {
      const revived = ejsonParse<unknown>(JSON.stringify(doc));
      if (!isPlainDocument(revived)) {
        const message = 'Cannot edit a document without an _id';
        notify.error(message);
        return Promise.resolve({ ok: false, message });
      }
      const original = revived as Record<string, unknown>;
      const draft = setAtSegments(original, [fieldPath], newValue);
      let request;
      try {
        request = buildUpdateRequest(original, draft);
      } catch (e) {
        const message = getErrorMessage(e, 'Cannot save this value');
        notify.error(message);
        return Promise.resolve({ ok: false, message });
      }
      if (request === null) return Promise.resolve({ ok: true }); // unchanged
      return api.doc
        .updateOne({
          connectionId: 'c1',
          dbName: 'app',
          collection: 'orders',
          filterJson: request.filterJson,
          updateJson: request.updateJson,
        })
        .then(({ matchedCount }): UpdateFieldOutcome => {
          if (matchedCount === 0) {
            const message = 'This document changed since it was loaded; the edit was not saved.';
            notify.error(message, { title: 'Update failed' });
            return { ok: false, message };
          }
          opts.onRefresh?.();
          return { ok: true };
        })
        .catch((e: unknown): UpdateFieldOutcome => {
          const message = getErrorMessage(e, 'Update failed');
          notify.error(message, { title: 'Update failed' });
          return { ok: false, message };
        });
    },
    openDuplicate: opts.openDuplicate ?? vi.fn(),
  });
}

function renderInlineEditHarness(
  docs: unknown[],
  opts: {
    onRefresh?: () => void;
    metaOverrides?: Partial<CollectionWorkspaceMeta>;
    columnConfig?: TableColumnConfig;
    openDuplicate?: (doc: unknown) => void;
    openEdit?: (doc: unknown, focusPath?: string) => void;
  } = {},
) {
  function Harness() {
    const actions = React.useMemo<CollectionWorkspaceActions>(() => inlineEditActions(opts), []);
    return (
      <CollectionWorkspaceProvider
        state={stateWithDocs(docs)}
        actions={actions}
        meta={emptyWorkspaceMeta(opts.metaOverrides)}
      >
        <TableView
          documents={docs}
          onColumnResize={vi.fn()}
          onRowExpand={vi.fn()}
          columnConfig={opts.columnConfig}
        />
      </CollectionWorkspaceProvider>
    );
  }
  return render(<Harness />);
}

/**
 * Rerenderable variant of `renderInlineEditHarness` — the plain harness
 * above closes over a fixed `docs` array, which can't reproduce N0.2's bug
 * (a documents-array swap mid-edit rebinding the same `TableCell` instance
 * to a different document). Here `docs` is a prop, so `rerenderDocs` swaps
 * both the `TableView` `documents=` prop and the provider's `state.lastRun`
 * together, matching how Workspace.tsx replaces both after a refetch.
 */
function renderRerenderableInlineEditHarness(
  initialDocs: unknown[],
  opts: {
    onRefresh?: () => void;
    metaOverrides?: Partial<CollectionWorkspaceMeta>;
  } = {},
) {
  function Harness({ docs }: { docs: unknown[] }) {
    const actions = React.useMemo<CollectionWorkspaceActions>(() => inlineEditActions(opts), []);
    return (
      <CollectionWorkspaceProvider
        state={stateWithDocs(docs)}
        actions={actions}
        meta={emptyWorkspaceMeta(opts.metaOverrides)}
      >
        <TableView documents={docs} onColumnResize={vi.fn()} onRowExpand={vi.fn()} />
      </CollectionWorkspaceProvider>
    );
  }
  const result = render(<Harness docs={initialDocs} />);
  return {
    ...result,
    rerenderDocs: (docs: unknown[]) => result.rerender(<Harness docs={docs} />),
  };
}

describe('TableView — inline cell editing (T2.6)', () => {
  it('inline-edits a string cell via Enter: calls doc.updateOne with a $set patch, then refreshes', async () => {
    const updateCalls: Array<{ filterJson: string; updateJson: string }> = [];
    installAtelierMock({
      doc: {
        updateOne: async (input) => {
          updateCalls.push(input);
          return { matchedCount: 1, modifiedCount: 1 };
        },
      },
    });
    const onRefresh = vi.fn();
    const docs = [{ _id: { $oid: '507f1f77bcf86cd799439011' }, status: 'pending' }];
    const { getByTitle } = renderInlineEditHarness(docs, { onRefresh });

    const cell = getByTitle(/Drag to add "status/);
    fireEvent.mouseEnter(cell);
    const editBtn = within(cell).getByRole('button', { name: 'Edit cell value' });
    fireEvent.click(editBtn);

    const input = within(cell).getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('pending');
    fireEvent.change(input, { target: { value: 'shipped' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(updateCalls.length).toBe(1));
    // The compare-and-set guard (W18 §5b/§8): `_id` plus the loaded value of
    // the one path that changed, not a bare `{_id}` filter.
    expect(JSON.parse(updateCalls[0]!.filterJson)).toEqual({
      _id: { $oid: '507f1f77bcf86cd799439011' },
      status: { $eq: 'pending' },
    });
    expect(JSON.parse(updateCalls[0]!.updateJson)).toEqual({ $set: { status: 'shipped' } });

    // The refresh path (re-running the query) is Workspace.tsx's job, not
    // TableView's — this harness's `docs` prop is static, so the cell keeps
    // showing the pre-edit value until a real re-fetch replaces it. What
    // matters here is that the refresh callback actually fired.
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });

  it('commits on blur too (not just Enter)', async () => {
    const updateCalls: unknown[] = [];
    installAtelierMock({
      doc: {
        updateOne: async (input) => {
          updateCalls.push(input);
          return { matchedCount: 1, modifiedCount: 1 };
        },
      },
    });
    const docs = [{ _id: 1, status: 'pending' }];
    const { getByTitle } = renderInlineEditHarness(docs);

    const cell = getByTitle(/Drag to add "status/);
    fireEvent.mouseEnter(cell);
    fireEvent.click(within(cell).getByRole('button', { name: 'Edit cell value' }));
    const input = within(cell).getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'shipped' } });
    fireEvent.blur(input);

    await waitFor(() => expect(updateCalls.length).toBe(1));
  });

  it('Escape cancels the edit with no IPC call and restores the original value', () => {
    const updateCalls: unknown[] = [];
    installAtelierMock({
      doc: {
        updateOne: async (input) => {
          updateCalls.push(input);
          return { matchedCount: 1, modifiedCount: 1 };
        },
      },
    });
    const docs = [{ _id: 1, status: 'pending' }];
    const { getByTitle } = renderInlineEditHarness(docs);

    const cell = getByTitle(/Drag to add "status/);
    fireEvent.mouseEnter(cell);
    fireEvent.click(within(cell).getByRole('button', { name: 'Edit cell value' }));
    const input = within(cell).getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'shipped' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(cell.textContent).toContain('pending');
    expect(updateCalls.length).toBe(0);
  });

  it('a trailing blur after Escape does not commit the cancelled draft', () => {
    // In real Chromium/Electron, cancelEdit's setEditing(false) unmounts the
    // focused <input>, and unmounting a focused element synchronously fires
    // a trailing `blur`. jsdom does NOT reproduce that unmount-triggered
    // blur, which is exactly why the plain "press Escape, assert no
    // updateOne" test above doesn't catch this bug. Reproduce the trailing
    // blur directly: dispatch the Escape keydown and the blur back-to-back
    // inside a single outer `act()`. `fireEvent`'s own per-call `act()`
    // wrapping nests inside ours (only the outermost `act()` flushes), so
    // React never gets a chance to re-render/unmount the input between the
    // two dispatches — `input` stays mounted for the blur, matching what a
    // real browser guarantees, and it still reaches React's delegated
    // `onBlur` (`commitEdit`) exactly as the browser would.
    const updateCalls: unknown[] = [];
    installAtelierMock({
      doc: {
        updateOne: async (input) => {
          updateCalls.push(input);
          return { matchedCount: 1, modifiedCount: 1 };
        },
      },
    });
    const docs = [{ _id: 1, status: 'pending' }];
    const { getByTitle } = renderInlineEditHarness(docs);

    const cell = getByTitle(/Drag to add "status/);
    fireEvent.mouseEnter(cell);
    fireEvent.click(within(cell).getByRole('button', { name: 'Edit cell value' }));
    const input = within(cell).getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'shipped' } });

    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
      fireEvent.blur(input);
    });

    expect(updateCalls.length).toBe(0);
    expect(cell.textContent).toContain('pending');
  });

  it('blur with an unchanged value commits nothing (no IPC call)', () => {
    const updateCalls: unknown[] = [];
    installAtelierMock({
      doc: {
        updateOne: async (input) => {
          updateCalls.push(input);
          return { matchedCount: 1, modifiedCount: 1 };
        },
      },
    });
    const docs = [{ _id: 1, status: 'pending' }];
    const { getByTitle } = renderInlineEditHarness(docs);

    const cell = getByTitle(/Drag to add "status/);
    fireEvent.mouseEnter(cell);
    fireEvent.click(within(cell).getByRole('button', { name: 'Edit cell value' }));
    const input = within(cell).getByRole('textbox') as HTMLInputElement;
    fireEvent.blur(input);

    expect(updateCalls.length).toBe(0);
  });

  it('the _id cell exposes no inline-edit pencil, even though its value renders as a string', () => {
    const docs = [{ _id: 'abc123', status: 'pending' }];
    const { getByTitle } = renderInlineEditHarness(docs);
    const cell = getByTitle(/Drag to add "_id/);
    fireEvent.mouseEnter(cell);
    expect(within(cell).queryByRole('button', { name: 'Edit cell value' })).toBeNull();
  });

  // W18 §8 — widened from v1 (T2.6): the BSON numeric types now inline-edit
  // in place, keeping their loaded type through the guarded save path.
  it('a number-sentinel cell inline-edits, saving with its Int32 type preserved', async () => {
    const updateCalls: Array<{ filterJson: string; updateJson: string }> = [];
    installAtelierMock({
      doc: {
        updateOne: async (input) => {
          updateCalls.push(input);
          return { matchedCount: 1, modifiedCount: 1 };
        },
      },
    });
    const docs = [{ _id: 1, amount: { $numberInt: '5' } }];
    const { getByTitle } = renderInlineEditHarness(docs);
    const cell = getByTitle(/Drag to add "amount/);
    fireEvent.mouseEnter(cell);
    fireEvent.click(within(cell).getByRole('button', { name: 'Edit cell value' }));

    const input = within(cell).getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('5');
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(updateCalls.length).toBe(1));
    expect(JSON.parse(updateCalls[0]!.updateJson)).toEqual({ $set: { amount: { $numberInt: '9' } } });
  });

  it('a number-sentinel cell refuses invalid text inline, without committing', () => {
    const docs = [{ _id: 1, amount: { $numberInt: '5' } }];
    const { getByTitle } = renderInlineEditHarness(docs);
    const cell = getByTitle(/Drag to add "amount/);
    fireEvent.mouseEnter(cell);
    fireEvent.click(within(cell).getByRole('button', { name: 'Edit cell value' }));

    const input = within(cell).getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'not a number' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Still editing — Enter was refused, not silently coerced or dropped.
    expect(within(cell).getByRole('textbox')).toBeTruthy();
    expect(within(cell).getByRole('alert')).toBeTruthy();
  });

  it('a boolean cell shows an always-on toggle, no pencil, and saves on toggle', async () => {
    const updateCalls: Array<{ filterJson: string; updateJson: string }> = [];
    installAtelierMock({
      doc: {
        updateOne: async (input) => {
          updateCalls.push(input);
          return { matchedCount: 1, modifiedCount: 1 };
        },
      },
    });
    const docs = [{ _id: 1, active: true }];
    const { getByTitle } = renderInlineEditHarness(docs);
    const cell = getByTitle(/Drag to add "active/);
    fireEvent.mouseEnter(cell);
    expect(within(cell).queryByRole('button', { name: 'Edit cell value' })).toBeNull();

    const toggle = within(cell).getByRole('checkbox', { name: 'Edit active' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);

    await waitFor(() => expect(updateCalls.length).toBe(1));
    expect(JSON.parse(updateCalls[0]!.updateJson)).toEqual({ $set: { active: false } });
  });

  // A controlled checkbox has no draft to protect a second click from the
  // first: without the in-flight guard, a click before the first write
  // settles would fire a second `updateOne` whose compare-and-set guard
  // reads the stale pre-write value, and land a spurious conflict.
  it('disables the boolean toggle while a write is in flight, so a second click before it settles is a no-op', async () => {
    let resolveWrite: (() => void) | undefined;
    const updateOne = vi.fn(
      () =>
        new Promise<{ matchedCount: number; modifiedCount: number }>((resolve) => {
          resolveWrite = () => resolve({ matchedCount: 1, modifiedCount: 1 });
        }),
    );
    installAtelierMock({ doc: { updateOne } });
    const docs = [{ _id: 1, active: true }];
    const { getByTitle } = renderInlineEditHarness(docs);
    const cell = getByTitle(/Drag to add "active/);
    fireEvent.mouseEnter(cell);
    const toggle = within(cell).getByRole('checkbox', { name: 'Edit active' }) as HTMLInputElement;

    fireEvent.click(toggle);
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle); // a second click while disabled reaches no handler

    resolveWrite?.();
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  // A rebind clears the pending state before the first write settles; that
  // write's late settle must not re-enable a toggle a newer click disabled.
  it('keeps the toggle disabled when an older write settles while a newer one is in flight', async () => {
    const resolvers: Array<() => void> = [];
    const updateOne = vi.fn(
      () =>
        new Promise<{ matchedCount: number; modifiedCount: number }>((resolve) => {
          resolvers.push(() => resolve({ matchedCount: 1, modifiedCount: 1 }));
        }),
    );
    installAtelierMock({ doc: { updateOne } });
    const { getByTitle, rerenderDocs } = renderRerenderableInlineEditHarness([{ _id: 1, active: true }]);
    const toggle = () =>
      within(getByTitle(/Drag to add "active/)).getByRole('checkbox', { name: 'Edit active' }) as HTMLInputElement;

    fireEvent.click(toggle());
    expect(toggle().disabled).toBe(true);
    rerenderDocs([{ _id: 1, active: false }]);
    expect(toggle().disabled).toBe(false);
    fireEvent.click(toggle());
    expect(toggle().disabled).toBe(true);

    await act(async () => { resolvers[0]!(); });
    expect(toggle().disabled).toBe(true);

    await act(async () => { resolvers[1]!(); });
    await waitFor(() => expect(toggle().disabled).toBe(false));
  });

  // Date/ObjectId/Binary stay out of the inline editor's scope (W18 §8); the
  // pencil still shows, but opens the Document Editor on the field instead.
  it('an ObjectId-sentinel cell has no inline pencil, but its edit affordance opens the Document Editor on that field', () => {
    const openEdit = vi.fn();
    const docs = [{ _id: 1, userId: { $oid: '507f1f77bcf86cd799439011' } }];
    const { getByTitle } = renderInlineEditHarness(docs, { openEdit });
    const cell = getByTitle(/Drag to add "userId/);
    fireEvent.mouseEnter(cell);
    expect(within(cell).queryByRole('textbox')).toBeNull();

    fireEvent.click(within(cell).getByRole('button', { name: 'Edit cell value' }));

    expect(openEdit).toHaveBeenCalledTimes(1);
    expect(openEdit).toHaveBeenCalledWith(docs[0], 'userId');
  });

  it('a computed dotted-path column exposes no inline-edit pencil (must never $set on the column label)', () => {
    const docs = [{ _id: 1, address: { city: 'Springfield' } }];
    const columnConfig: TableColumnConfig = {
      computed: [{ id: 'computed:address.city', path: 'address.city' }],
    };
    const { getByTitle } = renderInlineEditHarness(docs, { columnConfig });
    const cell = getByTitle('address.city');
    fireEvent.mouseEnter(cell);
    expect(within(cell).queryByRole('button', { name: 'Edit cell value' })).toBeNull();
  });

  it('a read-only provider shows no inline-edit pencil and no Duplicate menu item', () => {
    const docs = [{ _id: 1, status: 'pending' }];
    const { getByTitle, queryByText } = renderInlineEditHarness(docs, {
      metaOverrides: { isReadOnly: true },
    });
    const cell = getByTitle(/Drag to add "status/);
    fireEvent.mouseEnter(cell);
    expect(within(cell).queryByRole('button', { name: 'Edit cell value' })).toBeNull();

    fireEvent.contextMenu(cell);
    expect(queryByText('Duplicate document')).toBeNull();
  });

  it('a failed inline update surfaces user-visible error feedback, not a silent failure', async () => {
    installAtelierMock({
      doc: {
        updateOne: async () => {
          throw { code: 'SYSTEM_ERROR', message: 'boom' };
        },
      },
    });
    const docs = [{ _id: 1, status: 'pending' }];
    const { getByTitle } = renderInlineEditHarness(docs);

    const cell = getByTitle(/Drag to add "status/);
    fireEvent.mouseEnter(cell);
    fireEvent.click(within(cell).getByRole('button', { name: 'Edit cell value' }));
    const input = within(cell).getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'shipped' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
  });

  // W18 §5c/§8 — the guarded path's conflict outcome: `matchedCount: 0`
  // means the field (or the document) changed underneath the edit, so it
  // must surface visibly, never silently drop the write.
  it('a concurrent change under an inline edit (matchedCount: 0) surfaces visibly, not silently', async () => {
    installAtelierMock({
      doc: {
        updateOne: async () => ({ matchedCount: 0, modifiedCount: 0 }),
      },
    });
    const docs = [{ _id: 1, status: 'pending' }];
    const { getByTitle } = renderInlineEditHarness(docs);

    const cell = getByTitle(/Drag to add "status/);
    fireEvent.mouseEnter(cell);
    fireEvent.click(within(cell).getByRole('button', { name: 'Edit cell value' }));
    const input = within(cell).getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'shipped' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(screen.getByText(/This document changed since it was loaded/)).toBeTruthy(),
    );
  });

  it('context menu "Duplicate document" calls actions.openDuplicate with the row document', () => {
    const openDuplicate = vi.fn();
    const docs = [{ _id: 1, status: 'pending' }];
    const { getByTitle, getByText } = renderInlineEditHarness(docs, { openDuplicate });

    const cell = getByTitle(/Drag to add "status/);
    fireEvent.contextMenu(cell);
    fireEvent.click(getByText('Duplicate document'));

    expect(openDuplicate).toHaveBeenCalledTimes(1);
    expect(openDuplicate).toHaveBeenCalledWith(docs[0]);
  });

  it('an in-flight edit does not commit to a different document when the result set swaps under it (N0.2)', async () => {
    const updateCalls: Array<{ filterJson: string; updateJson: string }> = [];
    installAtelierMock({
      doc: {
        updateOne: async (input) => {
          updateCalls.push(input);
          return { matchedCount: 1, modifiedCount: 1 };
        },
      },
    });
    const docsA = [{ _id: 1, status: 'pending' }];
    const docsB = [{ _id: 2, status: 'active' }];
    const { getByTitle, rerenderDocs } = renderRerenderableInlineEditHarness(docsA);

    const cell = getByTitle(/Drag to add "status/);
    fireEvent.mouseEnter(cell);
    fireEvent.click(within(cell).getByRole('button', { name: 'Edit cell value' }));
    const input = within(cell).getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('pending');
    fireEvent.change(input, { target: { value: 'shipped' } });

    // Simulate the documents array swapping out from under the still-open
    // editor (e.g. a re-run/refresh landing mid-edit — Workspace.tsx applies
    // the new `documents`/`lastRun` together, same as `rerenderDocs` here),
    // then the trailing blur a real unmount/refocus can fire once the swap
    // has landed. `rerenderDocs` lets the swap fully commit before the blur
    // fires (unlike the Escape+blur precedent above, which deliberately
    // nests both in one `act()` to catch the input BEFORE an unmount
    // commits) — this is what reproduces N0.2: without the fix, the swap's
    // re-render already rebinds this TableCell instance to doc `_id: 2`
    // while `editing`/`draft` survive, so the trailing blur's `commitEdit`
    // fires against the new doc with the stale, never-confirmed draft.
    rerenderDocs(docsB);
    fireEvent.blur(input);

    // No write should have landed on the new document (_id: 2) carrying the
    // stale "shipped" draft that was never committed against _id: 1.
    expect(updateCalls.length).toBe(0);

    // The guard must not be stuck: a fresh edit on the now-bound _id: 2 cell
    // still commits normally.
    const cellAfterSwap = getByTitle(/Drag to add "status/);
    fireEvent.mouseEnter(cellAfterSwap);
    fireEvent.click(within(cellAfterSwap).getByRole('button', { name: 'Edit cell value' }));
    const inputAfterSwap = within(cellAfterSwap).getByRole('textbox') as HTMLInputElement;
    expect(inputAfterSwap.value).toBe('active');
    fireEvent.change(inputAfterSwap, { target: { value: 'archived' } });
    fireEvent.keyDown(inputAfterSwap, { key: 'Enter' });

    await waitFor(() => expect(updateCalls.length).toBe(1));
    // The guarded path revives the raw doc (`documentDiff.ts`'s `Doc`), so a
    // bare JS `_id: 2` canonicalizes to Int32 the same way the Document
    // Editor's own save path would — a change of spelling on the wire, not
    // of the document, and the same Int32 the driver would have produced
    // from a bare `2` either way.
    expect(JSON.parse(updateCalls[0]!.filterJson)).toEqual({
      _id: { $numberInt: '2' },
      status: { $eq: 'active' },
    });
    expect(JSON.parse(updateCalls[0]!.updateJson)).toEqual({ $set: { status: 'archived' } });
  });
});

// A failed write used to close the editor before the write settled, so the
// typed value was gone and the only trace of the failure was a toast.
describe('TableView — a failed inline write keeps the typed value', () => {
  function openEditor(getByTitle: (m: RegExp) => HTMLElement, field: string, text: string) {
    const cell = getByTitle(new RegExp(`Drag to add "${field}`));
    fireEvent.mouseEnter(cell);
    fireEvent.click(within(cell).getByRole('button', { name: 'Edit cell value' }));
    const input = within(cell).getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: text } });
    return { cell, input };
  }
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it('keeps the editor open with the draft and an inline error, and still toasts', async () => {
    const errorSpy = vi.spyOn(notify, 'error');
    installAtelierMock({
      doc: {
        updateOne: async () => {
          throw { code: 'SYSTEM_ERROR', message: 'boom' };
        },
      },
    });
    const { getByTitle } = renderInlineEditHarness([{ _id: 1, status: 'pending' }]);
    const { cell, input } = openEditor(getByTitle, 'status', 'shipped');
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(within(cell).getByRole('alert').textContent).toBe('boom'));
    expect((within(cell).getByRole('textbox') as HTMLInputElement).value).toBe('shipped');
    expect(errorSpy).toHaveBeenCalledWith('boom', expect.anything());
  });

  it('retries with an edited value, then closes the editor on success', async () => {
    const updateCalls: Array<{ updateJson: string }> = [];
    let fail = true;
    installAtelierMock({
      doc: {
        updateOne: async (input) => {
          updateCalls.push(input);
          if (fail) throw { code: 'SYSTEM_ERROR', message: 'boom' };
          return { matchedCount: 1, modifiedCount: 1 };
        },
      },
    });
    const { getByTitle } = renderInlineEditHarness([{ _id: 1, status: 'pending' }]);
    const { cell, input } = openEditor(getByTitle, 'status', 'shipped');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(within(cell).getByRole('alert')).toBeTruthy());

    fail = false;
    fireEvent.change(input, { target: { value: 'delivered' } });
    expect(within(cell).queryByRole('alert')).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(updateCalls.length).toBe(2));
    expect(JSON.parse(updateCalls[1]!.updateJson)).toEqual({ $set: { status: 'delivered' } });
    await waitFor(() => expect(within(cell).queryByRole('textbox')).toBeNull());
  });

  it('does not re-send a failed write when the input merely loses focus', async () => {
    const updateCalls: unknown[] = [];
    installAtelierMock({
      doc: {
        updateOne: async (input) => {
          updateCalls.push(input);
          throw { code: 'SYSTEM_ERROR', message: 'boom' };
        },
      },
    });
    const { getByTitle } = renderInlineEditHarness([{ _id: 1, status: 'pending' }]);
    const { cell, input } = openEditor(getByTitle, 'status', 'shipped');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(within(cell).getByRole('alert')).toBeTruthy());

    fireEvent.blur(input);

    expect(updateCalls.length).toBe(1);
    expect(within(cell).getByRole('textbox')).toBeTruthy();
  });

  it('keeps the editor open with the draft when the document changed underneath (matchedCount: 0)', async () => {
    installAtelierMock({ doc: { updateOne: async () => ({ matchedCount: 0, modifiedCount: 0 }) } });
    const { getByTitle } = renderInlineEditHarness([{ _id: 1, status: 'pending' }]);
    const { cell, input } = openEditor(getByTitle, 'status', 'shipped');
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(within(cell).getByRole('alert').textContent).toMatch(/changed since it was loaded/),
    );
    expect((within(cell).getByRole('textbox') as HTMLInputElement).value).toBe('shipped');
  });

  it('closes the editor on success with no error shown', async () => {
    installAtelierMock({ doc: { updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }) } });
    const { getByTitle } = renderInlineEditHarness([{ _id: 1, status: 'pending' }]);
    const { cell, input } = openEditor(getByTitle, 'status', 'shipped');
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(within(cell).queryByRole('textbox')).toBeNull());
    expect(within(cell).queryByRole('alert')).toBeNull();
  });

  it('holds the editor read-only while the write is in flight, and sends one write on Enter then blur', async () => {
    const pending = deferred<{ matchedCount: number; modifiedCount: number }>();
    const updateCalls: unknown[] = [];
    installAtelierMock({
      doc: {
        updateOne: (input) => {
          updateCalls.push(input);
          return pending.promise;
        },
      },
    });
    const { getByTitle } = renderInlineEditHarness([{ _id: 1, status: 'pending' }]);
    const { cell, input } = openEditor(getByTitle, 'status', 'shipped');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);

    await waitFor(() => expect(updateCalls.length).toBe(1));
    const held = within(cell).getByRole('textbox') as HTMLInputElement;
    expect(held.readOnly).toBe(true);
    expect(held.getAttribute('aria-busy')).toBe('true');

    pending.resolve({ matchedCount: 1, modifiedCount: 1 });
    await waitFor(() => expect(within(cell).queryByRole('textbox')).toBeNull());
    expect(updateCalls.length).toBe(1);
  });

  it('Escape during a pending write closes the editor for good, even if the write then fails', async () => {
    const pending = deferred<{ matchedCount: number; modifiedCount: number }>();
    installAtelierMock({ doc: { updateOne: () => pending.promise } });
    const { getByTitle } = renderInlineEditHarness([{ _id: 1, status: 'pending' }]);
    const { cell, input } = openEditor(getByTitle, 'status', 'shipped');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(within(cell).queryByRole('textbox')).toBeNull();

    await act(async () => {
      pending.reject({ code: 'SYSTEM_ERROR', message: 'late boom' });
      await pending.promise.catch(() => undefined);
    });

    expect(within(cell).queryByRole('textbox')).toBeNull();
    expect(within(cell).queryByRole('alert')).toBeNull();
  });

  it('a stale failure does not touch the editor of the row the cell was rebound to', async () => {
    const pending = deferred<{ matchedCount: number; modifiedCount: number }>();
    installAtelierMock({ doc: { updateOne: () => pending.promise } });
    const { getByTitle, rerenderDocs } = renderRerenderableInlineEditHarness([
      { _id: 1, status: 'pending' },
    ]);
    const { input } = openEditor(getByTitle, 'status', 'shipped');
    fireEvent.keyDown(input, { key: 'Enter' });

    rerenderDocs([{ _id: 2, status: 'active' }]);
    const { cell: cellB, input: inputB } = openEditor(getByTitle, 'status', 'archived');

    await act(async () => {
      pending.reject({ code: 'SYSTEM_ERROR', message: 'late boom' });
      await pending.promise.catch(() => undefined);
    });

    expect(within(cellB).queryByRole('alert')).toBeNull();
    expect((within(cellB).getByRole('textbox') as HTMLInputElement).value).toBe('archived');
    expect(inputB.readOnly).toBe(false);
  });

  it('a stale success does not close the editor of the row the cell was rebound to', async () => {
    const pending = deferred<{ matchedCount: number; modifiedCount: number }>();
    installAtelierMock({ doc: { updateOne: () => pending.promise } });
    const { getByTitle, rerenderDocs } = renderRerenderableInlineEditHarness([
      { _id: 1, status: 'pending' },
    ]);
    const { input } = openEditor(getByTitle, 'status', 'shipped');
    fireEvent.keyDown(input, { key: 'Enter' });

    rerenderDocs([{ _id: 2, status: 'active' }]);
    const { cell: cellB } = openEditor(getByTitle, 'status', 'archived');

    await act(async () => {
      pending.resolve({ matchedCount: 1, modifiedCount: 1 });
      await pending.promise;
    });

    expect((within(cellB).getByRole('textbox') as HTMLInputElement).value).toBe('archived');
  });

  it('keeps a number cell open with its draft and an error when the write fails', async () => {
    installAtelierMock({
      doc: {
        updateOne: async () => {
          throw { code: 'SYSTEM_ERROR', message: 'boom' };
        },
      },
    });
    const { getByTitle } = renderInlineEditHarness([{ _id: 1, amount: { $numberInt: '5' } }]);
    const { cell, input } = openEditor(getByTitle, 'amount', '9');
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(within(cell).getByRole('alert').textContent).toBe('boom'));
    expect((within(cell).getByRole('textbox') as HTMLInputElement).value).toBe('9');
  });
});
