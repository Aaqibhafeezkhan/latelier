// Per-group drag targeting. `BuilderPane`'s `GroupView` resolves its own
// drop target from its `path: NodePath` prop instead of a single
// pane-level handler that always inserted at the root. These tests cover
// what filter-tree-drawer.spec.tsx's root-only drag tests don't: a drop
// landing in the *nested* group under the cursor, at arbitrary depth, with
// only that group highlighted, an empty group's header/border still
// accepting a drop, and the whole thing staying inert under `readOnly`.
//
// Each group's wrapping div carries `data-group-path` (`pathKey(path)` —
// 'root' for the root group, dot-joined indices for nested ones), which is
// how these tests address a specific group without any geometry/coordinate
// hit-testing of their own — the same NodePath-as-identity the component
// itself uses to resolve a drop target.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { DRAGGED_FIELD_MIME } from '../../src/pages/Workspace/builder';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTabState, WorkspaceTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

const now = '2026-08-20T12:00:00.000Z';

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

/** Returns the most recent `queryRaw` written via `api.tabs.update`, if any. */
function lastWrittenQueryRaw(updateSpy: ReturnType<typeof vi.fn>): string | undefined {
  for (let i = updateSpy.mock.calls.length - 1; i >= 0; i--) {
    const arg = updateSpy.mock.calls[i]?.[1] as { state?: Partial<CollectionTabState> } | undefined;
    const patch = arg?.state;
    if (patch && 'queryRaw' in patch) return patch.queryRaw;
  }
  return undefined;
}

function mountWith(state: CollectionTabState) {
  const findSpy = vi.fn<IpcApi['query']['find']>(async () => ({
    documents: [],
    durationMs: 3,
    hasMore: false,
  }));
  const updateSpy = vi.fn(async () => makeCollectionTab(state));

  installAtelierMock({
    tabs: {
      list: async () => [makeCollectionTab(state)],
      setActive: async (id) => ({ id }),
      update: updateSpy as unknown as IpcApi['tabs']['update'],
    },
    conn: { list: async () => [CONNECTION] },
    query: { find: findSpy, count: async () => ({ count: 0 }) },
  });

  const utils = render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
  return { ...utils, findSpy, updateSpy };
}

function dataTransferFor(field: string, value: unknown) {
  return {
    types: [DRAGGED_FIELD_MIME],
    getData: (type: string) =>
      type === DRAGGED_FIELD_MIME ? JSON.stringify({ field, value }) : '',
  };
}

/** The one div per group carrying `data-group-path` — the drop target itself. */
function groupEl(path: string): HTMLElement {
  const el = document.querySelector(`[data-group-path="${path}"]`);
  if (!el) throw new Error(`no group rendered at path "${path}"`);
  return el as HTMLElement;
}

/**
 * The real drag source (`draggable` field rows elsewhere in the app) fires
 * this on `document` when a drag operation ends for any reason — dropped,
 * cancelled, dragged outside the window. `FilterDrawer` listens for it at
 * the document level as the single "clear every level's highlight" signal
 * — a per-scope `dragLeave`-based guard is an easy place to get an edge
 * case wrong.
 */
function fireDragEnd() {
  fireEvent(document, new Event('dragend', { bubbles: true }));
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe(' per-group drag targeting for nested filter groups', () => {
  it('a drop on a nested group at depth 1 lands there, not at the root', async () => {
    // {"$and":[{"a":{"$eq":1}},{"$or":[{"b":{"$eq":2}}]}]} — root AND with a
    // top-level cond plus a nested OR group at path [1].
    const { updateSpy } = mountWith(
      makeState({ queryRaw: '{"$and":[{"a":{"$eq":1}},{"$or":[{"b":{"$eq":2}}]}]}' }),
    );
    await screen.findAllByPlaceholderText('field');

    const dataTransfer = dataTransferFor('c', 3);
    fireEvent.dragOver(groupEl('1'), { dataTransfer });
    fireEvent.drop(groupEl('1'), { dataTransfer });

    await waitFor(() => {
      const raw = lastWrittenQueryRaw(updateSpy);
      expect(raw).toBeDefined();
      expect(JSON.parse(raw!)).toEqual({
        $and: [{ a: { $eq: 1 } }, { $or: [{ b: { $eq: 2 } }, { c: { $eq: 3 } }] }],
      });
    });
  });

  it('a drop on the innermost of several nested levels targets that group, not an ancestor', async () => {
    // root AND > nested OR (path [1]) > nested AND (path [1,0]) holding one
    // cond — three levels deep. Dispatched on a descendant *inside* the
    // innermost group that carries no drag handler of its own (its
    // LogicPicker), not on the innermost group's own div directly — so the
    // event actually has to bubble through 1.0 → 1 → root, and it's really
    // `stopPropagation()` at 1.0 (not just which element the test happened
    // to pick) that keeps 1 and root from also claiming it.
    const queryRaw = '{"$and":[{"a":{"$eq":1}},{"$or":[{"$and":[{"b":{"$eq":2}}]}]}]}';
    const { updateSpy } = mountWith(makeState({ queryRaw }));
    await screen.findAllByPlaceholderText('field');

    const innermost = groupEl('1.0');
    const bubbleFrom = innermost.querySelector('[aria-label="Group logic"]');
    expect(bubbleFrom).toBeTruthy(); // sanity: this element has no own handler

    const dataTransfer = dataTransferFor('c', 3);
    fireEvent.dragOver(bubbleFrom!, { dataTransfer });

    // Only the innermost group highlights — the event never reached 1 or
    // root's own handlers.
    await waitFor(() => expect(innermost.style.background).not.toBe(''));
    expect(groupEl('1').style.background).toBe('');
    expect(groupEl('root').style.background).toBe('');

    fireEvent.drop(bubbleFrom!, { dataTransfer });

    await waitFor(() => {
      const raw = lastWrittenQueryRaw(updateSpy);
      expect(raw).toBeDefined();
      // §3a — a group with exactly one printable child prints as that child,
      // so the nested $or's envelope drops once its one child (the $and
      // group) has two conds; the $and itself survives since it now holds
      // two.
      expect(JSON.parse(raw!)).toEqual({
        $and: [{ a: { $eq: 1 } }, { $and: [{ b: { $eq: 2 } }, { c: { $eq: 3 } }] }],
      });
    });
  });

  it('only the group under drag-over highlights — not the root, and drag end clears every level', async () => {
    const queryRaw = '{"$and":[{"a":{"$eq":1}},{"$or":[{"b":{"$eq":2}}]}]}';
    mountWith(makeState({ queryRaw }));
    await screen.findAllByPlaceholderText('field');

    const root = groupEl('root');
    const nested = groupEl('1');
    const dataTransfer = dataTransferFor('c', 3);

    fireEvent.dragOver(nested, { dataTransfer });

    // The nested group picked up the highlight background…
    await waitFor(() => expect(nested.style.background).not.toBe(''));
    // …and the root, whose own dragOver handler never fired for that event
    // (the nested group's `stopPropagation()` on the bubbling event stopped
    // it there), did not.
    expect(root.style.background).toBe('');

    // The drag ending (dropped, cancelled, dragged outside the window — all
    // fire `dragend` on the drag source) clears the one shared
    // `activeDropPath`, so whichever level was lit releases.
    fireDragEnd();
    await waitFor(() => expect(nested.style.background).toBe(''));

    // Positive control: the root itself is a real, working drop target —
    // "root did not highlight" above is meaningful only if the root is
    // proven capable of highlighting at all.
    fireEvent.dragOver(root, { dataTransfer });
    await waitFor(() => expect(root.style.background).not.toBe(''));
  });

  it('dragging out without dropping clears the highlight — via dragend, not a per-group dragLeave guess', async () => {
    // A `dragLeave`-based guard has to correctly tell a real exit apart
    // from a flicker between plain children and a hand-off to a nested
    // drop-owner — an easy place to get a case wrong. `activeDropPath` is
    // lifted to `FilterDrawer` and cleared by one document-level `dragend`
    // listener instead, so there's no per-group heuristic left to get
    // wrong: this covers a drag ending anywhere, at any nesting depth, in
    // one place.
    const queryRaw = '{"$and":[{"a":{"$eq":1}},{"$or":[{"b":{"$eq":2}}]}]}';
    mountWith(makeState({ queryRaw }));
    await screen.findAllByPlaceholderText('field');

    const nested = groupEl('1');
    const dataTransfer = dataTransferFor('c', 3);

    fireEvent.dragOver(nested, { dataTransfer });
    await waitFor(() => expect(nested.style.background).not.toBe(''));

    fireDragEnd();
    await waitFor(() => expect(nested.style.background).toBe(''));
  });

  it('moving from a group\'s own surface onto a nested row hands off the highlight, not just stalls it', async () => {
    // Dropping onto an existing condition must not leave the *root's*
    // highlight stuck lit, even though the drop lands correctly on the row
    // — a `relatedTarget`-only `dragLeave` guard could easily read "pointer
    // moves onto a nested row" as "still inside my subtree, don't clear".
    // With a single shared `activeDropPath`, there is no separate "clear"
    // step to get wrong for this transition: the row's own `onDragOver`
    // simply overwrites the path to its own, which un-highlights the group
    // for free.
    const queryRaw = '{"$and":[{"a":{"$eq":1}},{"$or":[{"b":{"$eq":2}}]}]}';
    mountWith(makeState({ queryRaw }));
    await screen.findAllByPlaceholderText('field');

    const nested = groupEl('1');
    const childInput = nested.querySelector('input[placeholder="field"]');
    expect(childInput).toBeTruthy();
    const dataTransfer = dataTransferFor('c', 3);

    fireEvent.dragOver(nested, { dataTransfer });
    await waitFor(() => expect(nested.style.background).not.toBe(''));

    fireEvent.dragOver(childInput!, { dataTransfer });
    await waitFor(() => expect(nested.style.background).toBe(''));
  });

  it('a drop on an empty nested group succeeds via its header/border area', async () => {
    // A group with zero children (empty $or) renders with near-zero content
    // height — the drop surface has to be the group's own header/border div
    // (the one carrying `data-group-path`), not its (empty) children list.
    const queryRaw = '{"$and":[{"a":{"$eq":1}},{"$or":[]}]}';
    const { updateSpy } = mountWith(makeState({ queryRaw }));
    await screen.findAllByPlaceholderText('field');

    const empty = groupEl('1');
    // Confirms this really is the near-zero-height case: no field/value
    // inputs live inside it.
    expect(empty.querySelector('input[placeholder="field"]')).toBeNull();

    const dataTransfer = dataTransferFor('c', 3);
    fireEvent.dragOver(empty, { dataTransfer });
    fireEvent.drop(empty, { dataTransfer });

    await waitFor(() => {
      const raw = lastWrittenQueryRaw(updateSpy);
      expect(raw).toBeDefined();
      expect(JSON.parse(raw!)).toEqual({ $and: [{ a: { $eq: 1 } }, { c: { $eq: 3 } }] });
    });
  });

  it('drag is inert on every group, root and nested, when the tree is read-only', async () => {
    // Invalid JSON in the bar freezes the whole drawer read-only (§6a) — the
    // pre-existing invariant this refactor must preserve, now threaded
    // through each per-group handler instead of one pane-level guard.
    const { updateSpy } = mountWith(makeState({ queryRaw: 'not valid json{{{' }));

    await screen.findByText(/isn't valid JSON/);
    const root = groupEl('root');

    const dataTransfer = dataTransferFor('c', 3);
    fireEvent.dragOver(root, { dataTransfer });
    fireEvent.drop(root, { dataTransfer });

    await new Promise((r) => setTimeout(r, 0));
    expect(lastWrittenQueryRaw(updateSpy)).toBeUndefined();
    // No highlight either — canAcceptDrop's readOnly guard blocks setActiveDropPath.
    expect(root.style.background).toBe('');
  });

  it('a payload missing its value key is rejected rather than crashing the drawer', async () => {
    // A doc field can legitimately hold JS `undefined` (BSON's deprecated
    // Undefined type), and
    // `JSON.stringify({field, value: undefined})` drops the `value` key
    // entirely, so a real payload can arrive with no `value` at all.
    // `condFromDragged` used to store `undefined` where a string is
    // required, and the printer's validation crashed calling `.trim()` on
    // it. `DocFieldTree`'s drag source no longer starts such a drag, but
    // this covers any other payload source reaching the same drop target.
    const queryRaw = '{"a":{"$eq":1}}';
    const { updateSpy } = mountWith(makeState({ queryRaw }));
    await screen.findAllByPlaceholderText('field');

    const root = groupEl('root');
    const dataTransfer = {
      types: [DRAGGED_FIELD_MIME],
      getData: (type: string) => (type === DRAGGED_FIELD_MIME ? JSON.stringify({ field: 'c' }) : ''),
    };

    // A throw inside a React event handler doesn't propagate synchronously
    // to the code that called `fireEvent` — React catches it and rethrows
    // via the DOM's own uncaught-exception channel, so `expect(() =>
    // fireEvent.drop(...)).not.toThrow()` would pass even with the crash
    // still happening. Listen for that channel directly instead.
    const onError = vi.fn();
    window.addEventListener('error', onError);
    try {
      fireEvent.dragOver(root, { dataTransfer });
      fireEvent.drop(root, { dataTransfer });
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      window.removeEventListener('error', onError);
    }

    expect(onError).not.toHaveBeenCalled();
    expect(lastWrittenQueryRaw(updateSpy)).toBeUndefined();
  });

  it('a drop on the "N not applied" problems banner lands on the root group, not a dead zone', async () => {
    // The banner is a sibling of the root GroupView inside FilterDrawer's
    // outer wrapper, not a descendant of it — a drop landing exactly there
    // never reaches any GroupView's `stopPropagation()`'d handler. ADR 0007
    // states no drop should be able to land outside every group's DOM node,
    // so the wrapper itself needs a fallback that treats an unclaimed drop
    // as targeting the root.
    mountWith(makeState({ queryRaw: '{"qty":{"$gt":5}}' }));
    const valueInput = await screen.findByPlaceholderText('value');
    fireEvent.change(valueInput, { target: { value: 'not-a-number' } });
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('not applied');
    expect(screen.getAllByPlaceholderText('field')).toHaveLength(1);

    const dataTransfer = dataTransferFor('c', 3);
    fireEvent.dragOver(banner, { dataTransfer });
    fireEvent.drop(banner, { dataTransfer });

    // The still-broken `qty` row keeps the overall print failing (so
    // `queryRaw` doesn't commit), but the tree itself — the thing the drop
    // targets — gains the new row regardless.
    await waitFor(() => {
      expect(screen.getAllByPlaceholderText('field')).toHaveLength(2);
    });
  });

  it('a drop on the read-only banner does not insert — the whole drawer is frozen, not just the groups', async () => {
    const { updateSpy } = mountWith(makeState({ queryRaw: 'not valid json{{{' }));
    const banner = await screen.findByText(/isn't valid JSON/);

    const dataTransfer = dataTransferFor('c', 3);
    fireEvent.dragOver(banner, { dataTransfer });
    fireEvent.drop(banner, { dataTransfer });

    await new Promise((r) => setTimeout(r, 0));
    expect(lastWrittenQueryRaw(updateSpy)).toBeUndefined();
  });

  it(' the always-visible "+ Add condition" strip appends a sibling even once the group already has a row, instead of a drop landing on that row and silently replacing it', async () => {
    // Mechanically the strip already bubbled to the group's own onDrop (it's
    // a sibling of the rows, not nested inside one), so this was never
    // "broken" — but a drop released anywhere else over a non-empty group
    // (the far more likely spot for a real cursor than a labeled 20px
    // sliver) landed on the row instead and replaced it, per
    // `mergeOrReplaceDragged`'s different-field replace path — silent, no
    // confirm, easy to trigger by accident. This test targets the strip
    // itself, by its `title` (added alongside the label so it reads as a
    // deliberate target, not release-anywhere-and-hope), and asserts it
    // appends rather than replaces the existing row.
    const queryRaw = '{"a":{"$eq":1}}';
    const { updateSpy } = mountWith(makeState({ queryRaw }));
    await screen.findAllByPlaceholderText('field');

    const appendStrip = groupEl('root').querySelector(
      '[title="Drop a field here to add a condition to this filter"]',
    );
    expect(appendStrip).toBeTruthy();

    const dataTransfer = dataTransferFor('c', 3);
    fireEvent.dragOver(appendStrip!, { dataTransfer });
    fireEvent.drop(appendStrip!, { dataTransfer });

    await waitFor(() => {
      const raw = lastWrittenQueryRaw(updateSpy);
      expect(raw).toBeDefined();
      expect(JSON.parse(raw!)).toEqual({ $and: [{ a: { $eq: 1 } }, { c: { $eq: 3 } }] });
    });
  });
});

describe('a malformed drag payload is ignored, not thrown', () => {
  // `JSON.parse('null')` succeeds, so a `null` payload reached
  // `dragged.field` and threw — in the row, group and fallback handlers alike.
  // React reports a throwing handler on window rather than failing
  // `fireEvent`, so collect those reports.
  it('drops of null and of a bare string change nothing', async () => {
    const thrown: unknown[] = [];
    const onError = (e: ErrorEvent) => {
      thrown.push(e.error);
      e.preventDefault();
    };
    window.addEventListener('error', onError);
    const { updateSpy } = mountWith(makeState({ queryRaw: '{"$and":[{"a":{"$eq":1}}]}' }));
    const [fieldInput] = await screen.findAllByPlaceholderText('field');
    const targets = [fieldInput!, groupEl('root'), groupEl('root').parentElement!];
    for (const payload of ['null', '"age"']) {
      const dataTransfer = {
        types: [DRAGGED_FIELD_MIME],
        getData: (type: string) => (type === DRAGGED_FIELD_MIME ? payload : ''),
      };
      for (const target of targets) {
        fireEvent.dragOver(target, { dataTransfer });
        fireEvent.drop(target, { dataTransfer });
      }
    }
    window.removeEventListener('error', onError);
    expect(thrown).toEqual([]);
    expect(lastWrittenQueryRaw(updateSpy)).toBeUndefined();
  });
});
