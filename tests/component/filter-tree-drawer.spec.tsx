// W13 §11 — "filter-tree-drawer.spec.tsx: add / edit / remove / nest, each
// asserted through `queryRaw`." Covers the ticket's own criteria: nested
// groups at arbitrary depth, and drag-and-drop still appending a `$eq` cond.
//
// Assertions go through `queryRaw` (what `api.tabs.update` was actually
// called with) rather than internal component state — per the ticket's
// testing note, a test that only inspects rendered DOM structure can pass
// against a tree the printer would refuse to run.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { DRAGGED_FIELD_MIME } from '../../src/pages/Workspace/builder';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { invalidateSampleSchemaCache } from '../../src/features/fieldSuggestions/sources/sampleSchemaSource';
import type { CollectionTabState, GroupNode, RecentQuery, SavedQuery, WorkspaceTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';
import { isoToLocalInput, localInputToIso } from '../../src/pages/Workspace/condValue';

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

/** Returns the most recent `queryRaw` written via `api.tabs.update`, if any. */
function lastWrittenQueryRaw(updateSpy: ReturnType<typeof vi.fn>): string | undefined {
  for (let i = updateSpy.mock.calls.length - 1; i >= 0; i--) {
    // `tabs.update(id, { state: patch })` — see shared/ipc.ts.
    const arg = updateSpy.mock.calls[i]?.[1] as { state?: Partial<CollectionTabState> } | undefined;
    const patch = arg?.state;
    if (patch && 'queryRaw' in patch) return patch.queryRaw;
  }
  return undefined;
}

/** The most recent patch that carried a `filterDraft` key, and that key's value. */
function lastWrittenDraft(
  updateSpy: ReturnType<typeof vi.fn>,
): { found: boolean; draft: CollectionTabState['filterDraft'] } {
  for (let i = updateSpy.mock.calls.length - 1; i >= 0; i--) {
    const arg = updateSpy.mock.calls[i]?.[1] as { state?: Partial<CollectionTabState> } | undefined;
    const patch = arg?.state;
    if (patch && 'filterDraft' in patch) return { found: true, draft: patch.filterDraft };
  }
  return { found: false, draft: undefined };
}

function fieldValues(): string[] {
  return (screen.queryAllByPlaceholderText('field') as HTMLInputElement[]).map((f) => f.value);
}

const A1 = { kind: 'cond', field: 'a', op: '$eq', valType: 'number', value: '1' } as const;
const B2 = { kind: 'cond', field: 'b', op: '$eq', valType: 'number', value: '2' } as const;

function andRoot(...children: GroupNode['children']): GroupNode {
  return { kind: 'group', logic: '$and', children };
}

function mountWith(
  state: CollectionTabState,
  overrides: { count?: IpcApi['query']['count']; sampleSchema?: IpcApi['meta']['sampleSchema'] } = {},
) {
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
    query: { find: findSpy, count: overrides.count ?? (async () => ({ count: 0 })) },
    ...(overrides.sampleSchema ? { meta: { sampleSchema: overrides.sampleSchema } } : {}),
  });

  const utils = render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
  return { ...utils, findSpy, updateSpy };
}

// The sampled schema is cached per collection for the whole module, so one
// test's sample would otherwise answer the next test's rows.
beforeEach(() => {
  invalidateSampleSchemaCache();
});

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Filter drawer — add / edit / remove / nest through queryRaw (W13 §11)', () => {
  it('filling a fresh condition row writes the printed filter to queryRaw', async () => {
    const { updateSpy } = mountWith(makeState());

    fireEvent.click(await screen.findByRole('button', { name: 'Add condition' }));
    const fieldInput = await screen.findByPlaceholderText('field');
    fireEvent.change(fieldInput, { target: { value: 'status' } });
    const valueInput = await screen.findByPlaceholderText('value');
    fireEvent.change(valueInput, { target: { value: 'paid' } });

    await waitFor(() => {
      expect(lastWrittenQueryRaw(updateSpy)).toBe('{"status":{"$eq":"paid"}}');
    });
  });

  it('removing a condition writes the printed filter (down to {})', async () => {
    const { updateSpy } = mountWith(
      makeState({ queryRaw: '{"status":{"$eq":"paid"}}' }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Remove condition status' }));

    await waitFor(() => {
      expect(lastWrittenQueryRaw(updateSpy)).toBe('{}');
    });
  });

  it('nested groups render and edit at arbitrary depth', async () => {
    // {"$and":[{"a":{"$eq":1}},{"$or":[{"b":{"$eq":2}}]}]} — a top-level cond
    // alongside a nested OR group holding one cond.
    const { updateSpy } = mountWith(
      makeState({
        queryRaw: '{"$and":[{"a":{"$eq":1}},{"$or":[{"b":{"$eq":2}}]}]}',
      }),
    );

    // Both the root AND's condition and the nested OR group's condition
    // render — two field inputs, "a" and "b".
    await waitFor(() => {
      const fields = screen.getAllByPlaceholderText('field') as HTMLInputElement[];
      expect(fields.map((f) => f.value).sort()).toEqual(['a', 'b']);
    });

    // Editing the nested condition's value updates queryRaw, proving the
    // edit reached a node two levels deep, not just the root. Each CondRow
    // renders its field input immediately before its value input, in tree
    // order, so the field's index lines up with the value's index — both
    // conds here use `$eq`, so neither row skips its value input (§ CondRow
    // hides the value input only for `$exists`).
    const fields = screen.getAllByPlaceholderText('field') as HTMLInputElement[];
    const values = screen.getAllByPlaceholderText('value') as HTMLInputElement[];
    const nestedIndex = fields.findIndex((f) => f.value === 'b');
    expect(nestedIndex).toBeGreaterThanOrEqual(0);
    fireEvent.change(values[nestedIndex]!, { target: { value: '99' } });

    await waitFor(() => {
      const raw = lastWrittenQueryRaw(updateSpy);
      expect(raw).toBeDefined();
      // §3a — a group with exactly one printable child prints as that child
      // (the nested $or's envelope drops since it now holds one cond, not
      // two); $nor is the only logic that always survives that collapse.
      expect(JSON.parse(raw!)).toEqual({
        $and: [{ a: { $eq: 1 } }, { b: { $eq: 99 } }],
      });
    });
  });

  it('adding a nested group via "Add group" then a condition inside it produces a nested filter', async () => {
    const { updateSpy } = mountWith(makeState({ queryRaw: '{"a":{"$eq":1}}' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Add group' }));
    // The new group is the root's second child.
    fireEvent.click(await screen.findByRole('button', { name: 'Add condition to group 2' }));

    const fields = await screen.findAllByPlaceholderText('field');
    const pendingField = (fields as HTMLInputElement[]).find((f) => f.value === '')!;
    fireEvent.change(pendingField, { target: { value: 'b' } });
    const values = screen.getAllByPlaceholderText('value') as HTMLInputElement[];
    const pendingValue = values.find((v) => v.value === '')!;
    fireEvent.change(pendingValue, { target: { value: '2' } });

    await waitFor(() => {
      const raw = lastWrittenQueryRaw(updateSpy);
      expect(raw).toBeDefined();
      // A fresh "+ Condition" row defaults to valType 'string' (§4/builder.ts
      // `emptyBuilder`-equivalent default), so the typed "2" prints as a
      // string, not a number, unless the user also changes the value type.
      expect(JSON.parse(raw!)).toEqual({ $and: [{ a: { $eq: 1 } }, { b: { $eq: '2' } }] });
    });
  });

  it('drag-and-drop of a result field still appends a $eq condition', async () => {
    const { updateSpy } = mountWith(makeState());

    const dropTarget = await screen.findByLabelText('Drop a field here to add a condition');
    const dataTransfer = {
      types: [DRAGGED_FIELD_MIME],
      getData: (type: string) =>
        type === DRAGGED_FIELD_MIME ? JSON.stringify({ field: 'sku', value: 'apple-001' }) : '',
    };

    fireEvent.dragOver(dropTarget, { dataTransfer });
    fireEvent.drop(dropTarget, { dataTransfer });

    await waitFor(() => {
      const raw = lastWrittenQueryRaw(updateSpy);
      expect(raw).toBeDefined();
      expect(JSON.parse(raw!)).toEqual({ sku: { $eq: 'apple-001' } });
    });
  });

  // The string-value drop above doesn't exercise `condFromDragged`'s other
  // valType branches (builder.ts) — each has its own value-string encoding,
  // so a regression in one wouldn't fail that test. Cover the EJSON-sentinel
  // branches here.
  it('drag-and-drop of an ObjectId field appends a $eq condition with the hex value', async () => {
    const { updateSpy } = mountWith(makeState());

    const dropTarget = await screen.findByLabelText('Drop a field here to add a condition');
    const dataTransfer = {
      types: [DRAGGED_FIELD_MIME],
      getData: (type: string) =>
        type === DRAGGED_FIELD_MIME
          ? JSON.stringify({ field: '_id', value: { $oid: '507f1f77bcf86cd799439011' } })
          : '',
    };

    fireEvent.dragOver(dropTarget, { dataTransfer });
    fireEvent.drop(dropTarget, { dataTransfer });

    await waitFor(() => {
      const raw = lastWrittenQueryRaw(updateSpy);
      expect(raw).toBeDefined();
      expect(JSON.parse(raw!)).toEqual({ _id: { $eq: { $oid: '507f1f77bcf86cd799439011' } } });
    });
  });

  it('drag-and-drop of a Date field appends a $eq condition with the ISO value', async () => {
    const { updateSpy } = mountWith(makeState());

    const dropTarget = await screen.findByLabelText('Drop a field here to add a condition');
    const dataTransfer = {
      types: [DRAGGED_FIELD_MIME],
      getData: (type: string) =>
        type === DRAGGED_FIELD_MIME
          ? JSON.stringify({ field: 'createdAt', value: { $date: '2026-01-01T00:00:00.000Z' } })
          : '',
    };

    fireEvent.dragOver(dropTarget, { dataTransfer });
    fireEvent.drop(dropTarget, { dataTransfer });

    await waitFor(() => {
      const raw = lastWrittenQueryRaw(updateSpy);
      expect(raw).toBeDefined();
      expect(JSON.parse(raw!)).toEqual({ createdAt: { $eq: { $date: '2026-01-01T00:00:00.000Z' } } });
    });
  });

  it('drag-and-drop of a boolean field appends a $eq condition with the boolean value', async () => {
    const { updateSpy } = mountWith(makeState());

    const dropTarget = await screen.findByLabelText('Drop a field here to add a condition');
    const dataTransfer = {
      types: [DRAGGED_FIELD_MIME],
      getData: (type: string) =>
        type === DRAGGED_FIELD_MIME ? JSON.stringify({ field: 'active', value: true }) : '',
    };

    fireEvent.dragOver(dropTarget, { dataTransfer });
    fireEvent.drop(dropTarget, { dataTransfer });

    await waitFor(() => {
      const raw = lastWrittenQueryRaw(updateSpy);
      expect(raw).toBeDefined();
      expect(JSON.parse(raw!)).toEqual({ active: { $eq: true } });
    });
  });
});

describe('Filter drawer — switching a condition off (disable)', () => {
  it('unchecking a row drops it from queryRaw but keeps it on screen, and re-checking brings it back', async () => {
    const { updateSpy } = mountWith(
      makeState({ queryRaw: '{"$and":[{"a":{"$eq":1}},{"b":{"$eq":2}}]}' }),
    );

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Include condition b' }));

    await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"a":{"$eq":1}}'));
    expect(fieldValues()).toEqual(['a', 'b']);
    const box = screen.getByRole('checkbox', { name: 'Include condition b' }) as HTMLInputElement;
    expect(box.checked).toBe(false);

    const { draft } = lastWrittenDraft(updateSpy);
    expect(draft?.queryRaw).toBe('{"a":{"$eq":1}}');
    expect(draft?.root.children[1]).toMatchObject({ field: 'b', disabled: true });

    fireEvent.click(box);
    await waitFor(() =>
      expect(lastWrittenQueryRaw(updateSpy)).toBe('{"$and":[{"a":{"$eq":1}},{"b":{"$eq":2}}]}'),
    );
  });

  it('names each group control by the group\'s position, so no two read the same', async () => {
    mountWith(
      makeState({
        queryRaw: '{"$and":[{"$or":[{"a":{"$eq":1}},{"b":{"$eq":2}}]},{"$or":[{"c":{"$eq":3}},{"$or":[{"d":{"$eq":4}},{"e":{"$eq":5}}]}]}]}',
      }),
    );

    const names = (await screen.findAllByRole('checkbox', { name: /^Include group/ })).map((c) =>
      c.getAttribute('aria-label'),
    );
    expect(names).toEqual(['Include group 1', 'Include group 2', 'Include group 2.2']);
    expect(screen.getAllByRole('button', { name: /^Negate group/ })).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Negate group 2.2' })).toBeTruthy();
  });

  it('a row inside a switched-off group says so to assistive tech; one in an included group does not', async () => {
    mountWith(
      makeState({
        queryRaw: '{"a":{"$eq":1}}',
        filterDraft: {
          queryRaw: '{"a":{"$eq":1}}',
          root: andRoot(A1, { kind: 'group', logic: '$or', disabled: true, children: [B2, { kind: 'group', logic: '$and', children: [{ kind: 'raw', json: '{"z":1}' }] }] }),
        },
      }),
    );

    const EXCLUDED = 'Excluded: its group is switched off';
    expect(await screen.findByRole('checkbox', { name: 'Include condition b', description: EXCLUDED })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Include group 2.2', description: EXCLUDED })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Include raw clause 2.2.1', description: EXCLUDED })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Raw clause 2.2.1', description: EXCLUDED })).toBeTruthy();
    // Not inside a switched-off group: no cue, on the row or on the group's own box.
    expect(screen.getByRole('checkbox', { name: 'Include condition a' }).getAttribute('aria-describedby')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Include group 2' }).getAttribute('aria-describedby')).toBeNull();
  });

  it('unchecking a nested group drops the whole group from queryRaw', async () => {
    const { updateSpy } = mountWith(
      makeState({ queryRaw: '{"$and":[{"a":{"$eq":1}},{"$or":[{"b":{"$eq":2}},{"c":{"$eq":3}}]}]}' }),
    );

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Include group 2' }));

    await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"a":{"$eq":1}}'));
    expect(fieldValues()).toEqual(['a', 'b', 'c']);
  });
});

describe('Filter drawer — the persisted draft', () => {
  it('seeds from a matching draft, so a switched-off row is still there', async () => {
    mountWith(
      makeState({
        queryRaw: '{"a":{"$eq":1}}',
        filterDraft: { queryRaw: '{"a":{"$eq":1}}', root: andRoot(A1, { ...B2, disabled: true }) },
      }),
    );

    const box = (await screen.findByRole('checkbox', { name: 'Include condition b' })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(fieldValues()).toEqual(['a', 'b']);
  });

  it('ignores a malformed draft and seeds from the text, without throwing', async () => {
    mountWith(
      makeState({
        queryRaw: '{"a":{"$eq":1}}',
        filterDraft: {
          queryRaw: '{"a":{"$eq":1}}',
          root: { kind: 'group', logic: '$and' } as unknown as GroupNode,
        },
      }),
    );

    await waitFor(() => expect(fieldValues()).toEqual(['a']));
  });

  it('ignores a draft written for other filter text', async () => {
    mountWith(
      makeState({
        queryRaw: '{"a":{"$eq":1}}',
        filterDraft: { queryRaw: '{"x":{"$eq":1}}', root: andRoot(A1, { ...B2, disabled: true }) },
      }),
    );

    await waitFor(() => expect(fieldValues()).toEqual(['a']));
  });

  it('ignores a draft whose tree prints to something other than queryRaw', async () => {
    mountWith(
      makeState({
        queryRaw: '{"a":{"$eq":1}}',
        // Same text recorded, but the tree itself prints {"$and":[a, b]}:
        // showing it would put a tree on screen that is not what runs.
        filterDraft: { queryRaw: '{"a":{"$eq":1}}', root: andRoot(A1, B2) },
      }),
    );

    await waitFor(() => expect(fieldValues()).toEqual(['a']));
  });

  it('a draft holding a row that cannot print comes back with its "not applied" banner', async () => {
    mountWith(
      makeState({
        queryRaw: '{"a":{"$eq":1}}',
        filterDraft: {
          queryRaw: '{"a":{"$eq":1}}',
          root: andRoot(A1, { kind: 'cond', field: 'n', op: '$eq', valType: 'number', value: 'abc' }),
        },
      }),
    );

    const values = (await screen.findAllByPlaceholderText('value')) as HTMLInputElement[];
    expect(values.map((v) => v.value)).toEqual(['1', 'abc']);
    expect(screen.getByRole('status').textContent).toContain('1 not applied: n');
  });

  it('an edit to the filter text from outside the drawer clears the draft', async () => {
    const { updateSpy } = mountWith(
      makeState({
        queryRaw: '{"a":{"$eq":1}}',
        filterDraft: { queryRaw: '{"a":{"$eq":1}}', root: andRoot(A1, { ...B2, disabled: true }) },
      }),
    );
    await waitFor(() => expect(fieldValues()).toEqual(['a', 'b']));

    const bar = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;
    fireEvent.change(bar, { target: { value: '{"c":1}' } });

    await waitFor(() => expect(fieldValues()).toEqual(['c']));
    await waitFor(() => expect(lastWrittenDraft(updateSpy)).toEqual({ found: true, draft: undefined }));
  });

  it('Reset clears the draft along with the filter', async () => {
    const { updateSpy } = mountWith(
      makeState({
        queryRaw: '{}',
        filterDraft: { queryRaw: '{}', root: andRoot({ ...A1, disabled: true }) },
      }),
    );
    await waitFor(() => expect(fieldValues()).toEqual(['a']));

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Reset' })[0]!);

    await waitFor(() => expect(fieldValues()).toEqual([]));
    await waitFor(() => expect(lastWrittenDraft(updateSpy)).toEqual({ found: true, draft: undefined }));
  });
});

describe('Filter drawer — negation (NOT)', () => {
  it('Negate (NOT) wraps a condition in a one-child $nor shown as NOT, and Remove negation unwraps it', async () => {
    const { updateSpy } = mountWith(makeState({ queryRaw: '{"a":{"$eq":1}}' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Condition options 1' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Negate (NOT)' }));

    await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"$nor":[{"a":{"$eq":1}}]}'));
    expect(screen.getByText('NOT')).toBeTruthy();
    // The NOT label replaces the logic picker on that group; only the root's is left.
    expect(screen.getAllByRole('radiogroup', { name: 'Group logic' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Remove negation 1' }));

    await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"a":{"$eq":1}}'));
    expect(screen.queryByText('NOT')).toBeNull();
    expect(fieldValues()).toEqual(['a']);
  });

  it('a top-level NOT read back from the filter text still shows as NOT', async () => {
    mountWith(makeState({ queryRaw: '{"$nor":[{"a":{"$eq":1}}]}' }));

    expect(await screen.findByText('NOT')).toBeTruthy();
    expect(screen.getAllByRole('radiogroup', { name: 'Group logic' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^Remove negation/ })).toBeTruthy();
  });

  it('Negate group wraps a nested group in $nor', async () => {
    const { updateSpy } = mountWith(
      makeState({ queryRaw: '{"$and":[{"a":{"$eq":1}},{"$or":[{"b":{"$eq":2}},{"c":{"$eq":3}}]}]}' }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Negate group 2' }));

    await waitFor(() =>
      expect(lastWrittenQueryRaw(updateSpy)).toBe(
        '{"$and":[{"a":{"$eq":1}},{"$nor":[{"$or":[{"b":{"$eq":2}},{"c":{"$eq":3}}]}]}]}',
      ),
    );
    // The new NOT wrapper offers no "Negate group" of its own; the $or inside it still does.
    expect(screen.getAllByRole('button', { name: /^Negate group/ }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Negate group 2.1',
    ]);
    expect(screen.getByRole('button', { name: 'Remove negation 2' })).toBeTruthy();
  });

  it('a second child turns a negation back into an ordinary NOR group', async () => {
    mountWith(makeState({ queryRaw: '{"$and":[{"a":{"$eq":1}},{"$nor":[{"b":{"$eq":2}}]}]}' }));

    await screen.findByText('NOT');
    fireEvent.click(screen.getByRole('button', { name: 'Add condition to group 2' }));

    await waitFor(() => expect(screen.queryByText('NOT')).toBeNull());
    expect(screen.getAllByRole('radiogroup', { name: 'Group logic' })).toHaveLength(2);
  });
});

describe('Filter drawer — insert a condition between rows', () => {
  const AB = '{"$and":[{"a":{"$eq":1}},{"b":{"$eq":2}}]}';

  it('Insert condition above puts a blank row before this one, focused, and leaves queryRaw alone', async () => {
    const { updateSpy } = mountWith(makeState({ queryRaw: AB }));
    await waitFor(() => expect(fieldValues()).toEqual(['a', 'b']));
    const writesBefore = updateSpy.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Condition options 2' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Insert condition above' }));

    await waitFor(() => expect(fieldValues()).toEqual(['a', '', 'b']));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getAllByPlaceholderText('field')[1]),
    );
    // The blank row is pending, so nothing new reaches queryRaw.
    await new Promise((r) => setTimeout(r, 300));
    const newPatches = (updateSpy.mock.calls as unknown[][])
      .slice(writesBefore)
      .map((c) => (c[1] as { state?: Partial<CollectionTabState> } | undefined)?.state ?? {});
    expect(newPatches.length).toBeGreaterThan(0);
    expect(newPatches.some((p) => 'queryRaw' in p)).toBe(false);
  });

  it('Insert condition below puts a blank row after this one, focused', async () => {
    mountWith(makeState({ queryRaw: AB }));
    await waitFor(() => expect(fieldValues()).toEqual(['a', 'b']));

    fireEvent.click(screen.getByRole('button', { name: 'Condition options 1' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Insert condition below' }));

    await waitFor(() => expect(fieldValues()).toEqual(['a', '', 'b']));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getAllByPlaceholderText('field')[1]),
    );
  });

  it('a raw clause row offers the same inserts', async () => {
    mountWith(makeState({ queryRaw: '{"$and":[{"a":{"$eq":1}},{"items":{"$elemMatch":{"sku":1}}}]}' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Raw clause options 2' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Insert condition above' }));

    await waitFor(() => expect(fieldValues()).toEqual(['a', '']));
  });
});

describe('Filter drawer — a bar edit that comes back to the same text', () => {
  it('a typo in the bar, then deleted, keeps the switched-off row, the undo history and the draft', async () => {
    const AB = '{"$and":[{"a":{"$eq":1}},{"b":{"$eq":2}}]}';
    const { updateSpy } = mountWith(makeState({ queryRaw: AB }));
    await waitFor(() => expect(fieldValues()).toEqual(['a', 'b']));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include condition b' }));
    await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"a":{"$eq":1}}'));
    const callsBefore = updateSpy.mock.calls.length;

    const bar = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;
    fireEvent.change(bar, { target: { value: '{"a":{"$eq":1}}x' } });
    await screen.findByText(/isn't valid JSON/);
    fireEvent.change(bar, { target: { value: '{"a":{"$eq":1}}' } });
    await waitFor(() => expect(screen.queryByText(/isn't valid JSON/)).toBeNull());

    expect(fieldValues()).toEqual(['a', 'b']);
    expect((screen.getByRole('checkbox', { name: 'Include condition b' }) as HTMLInputElement).checked).toBe(false);
    const undo = screen.getByRole('button', { name: 'Undo filter edit' }) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    // The draft holding the switched-off row is not cleared.
    const later = updateSpy.mock.calls.slice(callsBefore).map((c) => (c as unknown[])[1] as { state?: object });
    expect(later.some((arg) => arg.state && 'filterDraft' in arg.state)).toBe(false);

    fireEvent.click(undo);
    await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe(AB));
  });
});

describe('Filter drawer — a bar edit that comes back to the same text, over a blocked row', () => {
  it('a typo in the bar, then deleted, keeps a row that does not print and the undo history', async () => {
    const OID = '507f1f77bcf86cd799439011';
    const AO = `{"$and":[{"a":{"$eq":1}},{"o":{"$eq":{"$oid":"${OID}"}}}]}`;
    const { updateSpy } = mountWith(makeState({ queryRaw: AO }));
    const oid = (await screen.findByDisplayValue(OID)) as HTMLInputElement;
    fireEvent.change(oid, { target: { value: 'abc' } });
    await screen.findByText(/not applied/);
    expect(lastWrittenQueryRaw(updateSpy)).toBeUndefined();

    const bar = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;
    fireEvent.change(bar, { target: { value: `${AO}x` } });
    await screen.findByText(/isn't valid JSON/);
    fireEvent.change(bar, { target: { value: AO } });
    await waitFor(() => expect(screen.queryByText(/isn't valid JSON/)).toBeNull());

    expect(screen.getByDisplayValue('abc')).toBeTruthy();
    expect(screen.getByText(/not applied/)).toBeTruthy();
    const undo = screen.getByRole('button', { name: 'Undo filter edit' }) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    await waitFor(() => expect(screen.getByDisplayValue(OID)).toBeTruthy());
  });
});

describe('Filter drawer — invalid bar text, edited and put back', () => {
  it('stays frozen read-only: there is no tree the text stands for', async () => {
    mountWith(makeState({ queryRaw: '{"a":' }));
    await screen.findByText(/isn't valid JSON/);
    const bar = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;
    fireEvent.change(bar, { target: { value: '{"a":x' } });
    fireEvent.change(bar, { target: { value: '{"a":' } });

    await screen.findByText(/isn't valid JSON/);
    expect(screen.getByRole('button', { name: 'Add condition' })).toHaveProperty('disabled', true);
  });
});

describe('Filter drawer — the bar moves to other valid text, then back', () => {
  it('re-parses the tree from the text it came back to, not from the one it left', async () => {
    const A = '{"a":{"$eq":1}}';
    mountWith(makeState({ queryRaw: A }));
    await waitFor(() => expect(fieldValues()).toEqual(['a']));
    const bar = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;

    fireEvent.change(bar, { target: { value: '{"b":{"$eq":2}}' } });
    await waitFor(() => expect(fieldValues()).toEqual(['b']));
    fireEvent.change(bar, { target: { value: A } });

    await waitFor(() => expect(fieldValues()).toEqual(['a']));
  });
});

describe('Filter drawer — opened over invalid text with a draft from earlier text', () => {
  const A = '{"a":{"$eq":1}}';
  const B = '{"b":{"$eq":2}}';

  // On the Saved tab the drawer isn't mounted, so the bar moves through
  // valid B without the drawer seeing it or clearing A's draft.
  async function openFrozenOnDraft() {
    mountWith(
      makeState({
        queryRaw: A,
        activeBuilderTab: 'Saved',
        filterDraft: { queryRaw: A, root: andRoot(A1, { ...B2, disabled: true }) },
      }),
    );
    const bar = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;
    fireEvent.change(bar, { target: { value: B } });
    fireEvent.change(bar, { target: { value: `${B}x` } });
    fireEvent.click(screen.getByRole('tab', { name: 'Filter' }));
    await screen.findByText(/as you last left it in the drawer/);
    return bar;
  }

  async function typoShowsLastValid(bar: HTMLTextAreaElement, text: string) {
    fireEvent.change(bar, { target: { value: `${text}x` } });
    await screen.findByText(/last valid version/);
    expect(screen.queryByText(/as you last left it in the drawer/)).toBeNull();
  }

  it('says the frozen tree is the one last left in the drawer, not the last valid text', async () => {
    const bar = await openFrozenOnDraft();
    expect(screen.queryByText(/last valid version/)).toBeNull();
    expect(fieldValues()).toEqual(['a', 'b']);

    fireEvent.change(bar, { target: { value: B } });
    await waitFor(() => expect(fieldValues()).toEqual(['b']));
    expect(screen.queryByRole('alert')).toBeNull();
    // B's tree was parsed this session: a typo now freezes on the last valid version.
    await typoShowsLastValid(bar, B);
  });

  it('putting the draft\'s text back restores its tree, and a later typo freezes on the last valid version', async () => {
    const bar = await openFrozenOnDraft();

    fireEvent.change(bar, { target: { value: A } });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(fieldValues()).toEqual(['a', 'b']);
    await typoShowsLastValid(bar, A);
  });

  it('after Clear filter, a typo freezes on the last valid version', async () => {
    const bar = await openFrozenOnDraft();

    fireEvent.click(await screen.findByRole('button', { name: 'Clear filter' }));
    await waitFor(() => expect(fieldValues()).toEqual([]));
    await typoShowsLastValid(bar, '{}');
  });
});

describe('Filter drawer — Clear filter', () => {
  // Only a switched-off row, so the tree prints to '{}', the text Clear
  // filter writes: a text comparison alone can't see the clear.
  const OFF_ONLY = { queryRaw: '{}', root: andRoot({ ...A1, disabled: true }) };

  it('while the bar is invalid, drops the switched-off rows with the draft', async () => {
    mountWith(makeState({ filterDraft: OFF_ONLY }));
    await waitFor(() => expect(fieldValues()).toEqual(['a']));
    const bar = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;
    fireEvent.change(bar, { target: { value: '{}x' } });
    await screen.findByText(/isn't valid JSON/);

    fireEvent.click(await screen.findByRole('button', { name: 'Clear filter' }));

    await waitFor(() => expect(bar.value).toBe('{}'));
    await waitFor(() => expect(fieldValues()).toEqual([]));
    expect(screen.getByRole('button', { name: 'Add condition' })).toHaveProperty('disabled', false);
  });

  it('on a later page of an unfiltered query, drops the switched-off rows with the draft', async () => {
    mountWith(makeState({ page: 1, filterDraft: OFF_ONLY }));
    await waitFor(() => expect(fieldValues()).toEqual(['a']));

    fireEvent.click(await screen.findByRole('button', { name: 'Clear filter' }));

    await waitFor(() => expect(fieldValues()).toEqual([]));
  });
});

describe('Filter drawer — undo / redo', () => {
  const AB = '{"$and":[{"a":{"$eq":1}},{"b":{"$eq":2}}]}';

  function undoButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: 'Undo filter edit' }) as HTMLButtonElement;
  }
  function redoButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: 'Redo filter edit' }) as HTMLButtonElement;
  }

  it('undo puts a removed condition back in queryRaw, and redo removes it again', async () => {
    const { updateSpy } = mountWith(makeState({ queryRaw: AB }));
    await waitFor(() => expect(fieldValues()).toEqual(['a', 'b']));
    expect(undoButton().disabled).toBe(true);
    expect(redoButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Remove condition b' }));
    await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"a":{"$eq":1}}'));

    fireEvent.click(undoButton());
    await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe(AB));
    expect(fieldValues()).toEqual(['a', 'b']);
    expect(undoButton().disabled).toBe(true);

    fireEvent.click(redoButton());
    await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"a":{"$eq":1}}'));
    expect(fieldValues()).toEqual(['a']);
    expect(redoButton().disabled).toBe(true);
  });

  it('when Undo or Redo runs out of steps, focus moves to the other one instead of falling to the page', async () => {
    mountWith(makeState({ queryRaw: AB }));
    await waitFor(() => expect(fieldValues()).toEqual(['a', 'b']));
    fireEvent.click(screen.getByRole('button', { name: 'Remove condition b' }));
    await waitFor(() => expect(undoButton().disabled).toBe(false));

    undoButton().focus();
    fireEvent.click(undoButton());
    await waitFor(() => expect(undoButton().disabled).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(redoButton()));

    fireEvent.click(redoButton());
    await waitFor(() => expect(redoButton().disabled).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(undoButton()));
  });

  it('typing into one field is a single undo step', async () => {
    mountWith(makeState());

    fireEvent.click(await screen.findByRole('button', { name: 'Add condition' }));
    const field = await screen.findByPlaceholderText('field');
    for (const v of ['s', 'st', 'sta']) fireEvent.change(field, { target: { value: v } });
    await waitFor(() => expect(fieldValues()).toEqual(['sta']));

    fireEvent.click(undoButton());
    await waitFor(() => expect(fieldValues()).toEqual(['']));

    fireEvent.click(undoButton());
    await waitFor(() => expect(fieldValues()).toEqual([]));
  });

  it('typing into a box then deleting back leaves no do-nothing undo step', async () => {
    mountWith(makeState());

    fireEvent.click(await screen.findByRole('button', { name: 'Add condition' }));
    const field = await screen.findByPlaceholderText('field');
    fireEvent.change(field, { target: { value: 's' } });
    fireEvent.change(field, { target: { value: '' } });
    await waitFor(() => expect(fieldValues()).toEqual(['']));

    fireEvent.click(undoButton());
    await waitFor(() => expect(fieldValues()).toEqual([]));
  });

  it('an edit to the filter text from outside the drawer clears the history', async () => {
    mountWith(makeState({ queryRaw: AB }));
    await waitFor(() => expect(fieldValues()).toEqual(['a', 'b']));

    fireEvent.click(screen.getByRole('button', { name: 'Remove condition b' }));
    await waitFor(() => expect(undoButton().disabled).toBe(false));

    const bar = (await screen.findByTestId('query-bar-input')) as HTMLTextAreaElement;
    fireEvent.change(bar, { target: { value: '{"c":1}' } });

    await waitFor(() => expect(fieldValues()).toEqual(['c']));
    expect(undoButton().disabled).toBe(true);
  });
});

describe('Filter drawer — a Saved or Recent load drops the draft', () => {
  const FIND_PAYLOAD = {
    kind: 'find' as const,
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{"z":{"$eq":"loaded"}}',
  };
  const DRAFT = { queryRaw: '{}', root: andRoot({ ...A1, disabled: true }) };

  function mountLoading(tab: 'Saved' | 'Recent') {
    const state = makeState({ activeBuilderTab: tab, filterDraft: DRAFT });
    const updateSpy = vi.fn(async () => makeCollectionTab(state));
    const saved = {
      id: 'q1', connectionId: 'c1', dbName: 'mydb', collection: 'users', kind: 'find',
      name: 'Loaded', createdAt: now, updatedAt: now, payload: FIND_PAYLOAD,
    } as unknown as SavedQuery;
    const recent = {
      id: 'r1', connectionId: 'c1', dbName: 'mydb', collection: 'users', kind: 'find',
      payload: FIND_PAYLOAD, ranAt: now, durationMs: 1, resultCount: 0,
    } as unknown as RecentQuery;
    installAtelierMock({
      tabs: {
        list: async () => [makeCollectionTab(state)],
        setActive: async (id) => ({ id }),
        update: updateSpy as unknown as IpcApi['tabs']['update'],
      },
      conn: { list: async () => [CONNECTION] },
      saved: { list: async () => [saved], get: async () => saved } as unknown as IpcApi['saved'],
      recent: { list: async () => [recent] } as unknown as IpcApi['recent'],
      query: { find: vi.fn(async () => ({ documents: [], durationMs: 1, hasMore: false })), count: async () => ({ count: 0 }) },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );
    return updateSpy;
  }

  it.each(['Saved', 'Recent'] as const)('Run here from %s writes filterDraft: undefined with the loaded queryRaw', async (tab) => {
    const updateSpy = mountLoading(tab);

    fireEvent.click(await screen.findByRole('button', { name: /in this tab$/ }));

    await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"z":{"$eq":"loaded"}}'));
    expect(lastWrittenDraft(updateSpy)).toEqual({ found: true, draft: undefined });
  });
});

describe('Filter drawer — a drop onto a switched-off row keeps it off', () => {
  function dropOnRow(container: HTMLElement, rowKey: string, field: string, value: unknown) {
    const row = container.querySelector(`[data-row-path="${rowKey}"]`)!;
    expect(row).toBeTruthy();
    const dataTransfer = {
      types: [DRAGGED_FIELD_MIME],
      getData: (type: string) => (type === DRAGGED_FIELD_MIME ? JSON.stringify({ field, value }) : ''),
    };
    fireEvent.dragOver(row, { dataTransfer });
    fireEvent.drop(row, { dataTransfer });
  }

  it.each([
    ['a condition', { ...B2, disabled: true }, 'Include condition b'],
    ['a raw clause', { kind: 'raw' as const, json: '', disabled: true }, 'Include raw clause 2'],
  ])('dropping onto %s that is switched off leaves it off and queryRaw unchanged', async (_what, row, label) => {
    const { container, updateSpy } = mountWith(
      makeState({ queryRaw: '{"a":{"$eq":1}}', filterDraft: { queryRaw: '{"a":{"$eq":1}}', root: andRoot(A1, row) } }),
    );
    expect(((await screen.findByRole('checkbox', { name: label })) as HTMLInputElement).checked).toBe(false);

    dropOnRow(container, '1', 'b', 5);

    await waitFor(() => expect(lastWrittenDraft(updateSpy).found).toBe(true));
    const { draft } = lastWrittenDraft(updateSpy);
    expect(draft?.root.children[1]).toMatchObject({ kind: 'cond', field: 'b', disabled: true });
    expect(lastWrittenQueryRaw(updateSpy)).toBeUndefined();
    expect((screen.getByRole('checkbox', { name: 'Include condition b' }) as HTMLInputElement).checked).toBe(false);
  });

  it('a switched-off hand-typed raw clause stays off after the replace is confirmed', async () => {
    const { container, updateSpy } = mountWith(
      makeState({
        queryRaw: '{"a":{"$eq":1}}',
        filterDraft: { queryRaw: '{"a":{"$eq":1}}', root: andRoot(A1, { kind: 'raw', json: '{"z":1}', disabled: true }) },
      }),
    );
    await screen.findByRole('checkbox', { name: 'Include raw clause 2' });

    dropOnRow(container, '1', 'b', 5);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));

    await waitFor(() =>
      expect(lastWrittenDraft(updateSpy).draft?.root.children[1]).toMatchObject({ field: 'b', disabled: true }),
    );
    expect(lastWrittenQueryRaw(updateSpy)).toBeUndefined();
  });
});

describe('Filter drawer — type-aware value editors', () => {
  const OID = '0123456789abcdef01234567';

  async function setValueType(type: string) {
    // Mantine labels the listbox with the input's name too; the input is the trigger.
    const trigger = screen.getAllByLabelText('Value type').find((el) => el.tagName === 'INPUT');
    fireEvent.click(trigger!);
    fireEvent.click(await screen.findByRole('option', { name: type }));
  }

  describe('date', () => {
    const START = '2026-01-01T00:00:00.000Z';

    it('Pick date opens a datetime input holding the value in local time', async () => {
      mountWith(makeState({ queryRaw: `{"d":{"$gte":{"$date":"${START}"}}}` }));

      fireEvent.click(await screen.findByRole('button', { name: 'Pick date' }));
      const input = (await screen.findByLabelText('Date and time')) as HTMLInputElement;
      expect(input.type).toBe('datetime-local');
      expect(input.value).toBe(isoToLocalInput(START));
    });

    it('a preset writes its timestamp to queryRaw', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));
      const { updateSpy } = mountWith(makeState({ queryRaw: `{"d":{"$gte":{"$date":"${START}"}}}` }));

      fireEvent.click(await screen.findByRole('button', { name: 'Pick date' }));
      fireEvent.click(await screen.findByRole('button', { name: '7 days ago' }));

      await waitFor(() =>
        expect(lastWrittenQueryRaw(updateSpy)).toBe('{"d":{"$gte":{"$date":"2026-10-08T12:00:00.000Z"}}}'),
      );
    });

    it('changing the datetime input writes that moment to queryRaw', async () => {
      const { updateSpy } = mountWith(makeState({ queryRaw: `{"d":{"$gte":{"$date":"${START}"}}}` }));

      fireEvent.click(await screen.findByRole('button', { name: 'Pick date' }));
      fireEvent.change(await screen.findByLabelText('Date and time'), { target: { value: '2026-03-04T05:06' } });

      await waitFor(() =>
        expect(lastWrittenQueryRaw(updateSpy)).toBe(
          `{"d":{"$gte":{"$date":"${localInputToIso('2026-03-04T05:06')}"}}}`,
        ),
      );
    });

    it('a half-filled datetime input (reported as empty) leaves the value alone', async () => {
      const { updateSpy } = mountWith(makeState({ queryRaw: `{"d":{"$gte":{"$date":"${START}"}}}` }));

      fireEvent.click(await screen.findByRole('button', { name: 'Pick date' }));
      const writesBefore = updateSpy.mock.calls.length;
      fireEvent.change(await screen.findByLabelText('Date and time'), { target: { value: '' } });

      await new Promise((r) => setTimeout(r, 300));
      expect(updateSpy.mock.calls.length).toBe(writesBefore);
      expect((screen.getByPlaceholderText('value') as HTMLInputElement).value).toBe(START);
    });

    it('edits made in the datetime input are one undo step', async () => {
      const { updateSpy } = mountWith(makeState({ queryRaw: `{"d":{"$gte":{"$date":"${START}"}}}` }));

      fireEvent.click(await screen.findByRole('button', { name: 'Pick date' }));
      const input = await screen.findByLabelText('Date and time');
      fireEvent.change(input, { target: { value: '2026-03-04T05:06' } });
      fireEvent.change(input, { target: { value: '2026-03-04T05:07' } });
      await waitFor(() =>
        expect(lastWrittenQueryRaw(updateSpy)).toBe(`{"d":{"$gte":{"$date":"${localInputToIso('2026-03-04T05:07')}"}}}`),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Undo filter edit' }));

      await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe(`{"d":{"$gte":{"$date":"${START}"}}}`));
    });

    it('the picker is a dialog holding the input and the presets, not a menu', async () => {
      mountWith(makeState({ queryRaw: `{"d":{"$gte":{"$date":"${START}"}}}` }));

      fireEvent.click(await screen.findByRole('button', { name: 'Pick date' }));
      const picker = await screen.findByRole('dialog', { name: 'Pick date' });

      expect(within(picker).getByLabelText('Date and time')).toBeTruthy();
      expect(within(picker).getByRole('button', { name: 'Start of this month' })).toBeTruthy();
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('arrow keys in the datetime input stay with the input instead of jumping to the presets', async () => {
      mountWith(makeState({ queryRaw: `{"d":{"$gte":{"$date":"${START}"}}}` }));

      fireEvent.click(await screen.findByRole('button', { name: 'Pick date' }));
      const input = await screen.findByLabelText('Date and time');
      input.focus();
      fireEvent.keyDown(input, { key: 'ArrowDown' });

      expect(document.activeElement).toBe(input);
    });
  });

  describe('chips for $in', () => {
    it('shows each element as a chip, and typing, removing and pasting edit the list', async () => {
      const { updateSpy } = mountWith(makeState({ queryRaw: '{"s":{"$in":["a","b"]}}' }));

      const chipBox = await screen.findByRole('combobox', { name: 'Values' });
      // Mantine drops a change to an unfocused combobox input as autofill, so
      // the box is focused the way a user's click would focus it.
      act(() => chipBox.focus());
      expect(screen.getByRole('button', { name: 'Remove a' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Remove b' })).toBeTruthy();

      fireEvent.change(chipBox, { target: { value: 'c' } });
      fireEvent.keyDown(chipBox, { key: 'Enter' });
      await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"s":{"$in":["a","b","c"]}}'));

      fireEvent.click(screen.getByRole('button', { name: 'Remove a' }));
      await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"s":{"$in":["b","c"]}}'));

      fireEvent.paste(chipBox, { clipboardData: { getData: () => 'x, y\nB' } });
      await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"s":{"$in":["b","c","x","y","B"]}}'));
    });

    it('a typed number or quoted text keeps its type', async () => {
      // An empty list in the text stays a raw clause, so the list starts with one item.
      const { updateSpy } = mountWith(makeState({ queryRaw: '{"s":{"$in":["a"]}}' }));

      const chipBox = await screen.findByRole('combobox', { name: 'Values' });
      act(() => chipBox.focus());
      fireEvent.change(chipBox, { target: { value: '42' } });
      fireEvent.keyDown(chipBox, { key: 'Enter' });
      fireEvent.change(chipBox, { target: { value: '"42"' } });
      fireEvent.keyDown(chipBox, { key: 'Enter' });

      await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"s":{"$in":["a",42,"42"]}}'));
    });

    it('a string list keeps typed digits as text', async () => {
      const { updateSpy } = mountWith(
        makeState({ queryRaw: '{"$and":[{"s":{"$in":["a"]}},{"s":{"$exists":true}}]}' }),
      );
      // Make the list's row a string row: the parser types a list as `array`.
      await screen.findAllByPlaceholderText('field');
      const trigger = screen.getAllByLabelText('Value type').find((el) => el.tagName === 'INPUT');
      fireEvent.click(trigger!);
      fireEvent.click(await screen.findByRole('option', { name: 'string' }));

      const chipBox = await screen.findByRole('combobox', { name: 'Values' });
      act(() => chipBox.focus());
      fireEvent.change(chipBox, { target: { value: '007' } });
      fireEvent.keyDown(chipBox, { key: 'Enter' });

      await waitFor(() =>
        expect(lastWrittenQueryRaw(updateSpy)).toBe('{"$and":[{"s":{"$in":["a","007"]}},{"s":{"$exists":true}}]}'),
      );
    });

    it('offers value suggestions as chips, and picking one adds it', async () => {
      const { updateSpy } = mountWith(
        makeState({
          queryRaw: '{"s":{"$in":["a"]}}',
          lastRun: { documents: [{ s: 'shipped' }, { s: 'pending' }], durationMs: 0, ranAt: now },
        }),
      );

      const chipBox = await screen.findByRole('combobox', { name: 'Values' });
      fireEvent.focus(chipBox);
      fireEvent.click(chipBox);
      fireEvent.click(await screen.findByRole('option', { name: 'shipped' }));

      await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"s":{"$in":["a","shipped"]}}'));
    });

    it('Edit as JSON swaps to the text input holding the list', async () => {
      mountWith(makeState({ queryRaw: '{"s":{"$in":["b","c"]}}' }));

      fireEvent.click(await screen.findByRole('button', { name: 'Edit as JSON' }));

      expect((screen.getByPlaceholderText('value') as HTMLInputElement).value).toBe('["b","c"]');
      expect(screen.queryByRole('combobox', { name: 'Values' })).toBeNull();
    });

    it('a row\'s "Edit as JSON" stays with that row, not with the slot, when a row above it goes', async () => {
      const AB = '{"$and":[{"s":{"$in":["a"]}},{"t":{"$in":["b"]}}]}';
      const { updateSpy } = mountWith(makeState({ queryRaw: AB }));
      await waitFor(() => expect(screen.getAllByRole('combobox', { name: 'Values' })).toHaveLength(2));

      fireEvent.click(screen.getAllByRole('button', { name: 'Edit as JSON' })[0]!);
      // Typing in the JSON box is this row's own edit: it stays JSON.
      const json = screen.getByPlaceholderText('value') as HTMLInputElement;
      fireEvent.change(json, { target: { value: '["a","z"]' } });
      await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"$and":[{"s":{"$in":["a","z"]}},{"t":{"$in":["b"]}}]}'));
      expect((screen.getByPlaceholderText('value') as HTMLInputElement).value).toBe('["a","z"]');
      expect(screen.getAllByRole('combobox', { name: 'Values' })).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: 'Remove condition s' }));
      await waitFor(() => expect(fieldValues()).toEqual(['t']));
      // The row that moved up into the slot shows its own chips.
      expect(screen.getByRole('combobox', { name: 'Values' })).toBeTruthy();
      expect(screen.queryByPlaceholderText('value')).toBeNull();

      // Undo puts the removed row back in the slot; neither row takes the
      // other's JSON view, so both show their chips.
      fireEvent.click(screen.getByRole('button', { name: 'Undo filter edit' }));
      await waitFor(() => expect(fieldValues()).toEqual(['s', 't']));
      expect(screen.getAllByRole('combobox', { name: 'Values' })).toHaveLength(2);
      expect(screen.queryByPlaceholderText('value')).toBeNull();
    });

    it('a field dropped onto a row in "Edit as JSON" merges into the list and stays JSON', async () => {
      const { container, updateSpy } = mountWith(makeState({ queryRaw: '{"s":{"$in":["a"]}}' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Edit as JSON' }));
      const row = container.querySelector('[data-row-path="0"]')!;
      expect(row).toBeTruthy();
      const dataTransfer = {
        types: [DRAGGED_FIELD_MIME],
        getData: (type: string) => (type === DRAGGED_FIELD_MIME ? JSON.stringify({ field: 's', value: 'b' }) : ''),
      };

      fireEvent.dragOver(row, { dataTransfer });
      fireEvent.drop(row, { dataTransfer });

      await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"s":{"$in":["a","b"]}}'));
      expect((screen.getByPlaceholderText('value') as HTMLInputElement).value).toBe('["a","b"]');
      expect(screen.queryByRole('combobox', { name: 'Values' })).toBeNull();
    });

    it('a list a chip cannot show keeps the text input', async () => {
      mountWith(makeState({ queryRaw: `{"s":{"$in":[{"$oid":"${OID}"}]}}` }));

      const value = await screen.findByPlaceholderText('value');
      expect(screen.queryByRole('combobox', { name: 'Values' })).toBeNull();

      // Typing a list that parses does not swap the box out from under the caret.
      fireEvent.change(value, { target: { value: '["a"]' } });
      await waitFor(() => expect((screen.getByPlaceholderText('value') as HTMLInputElement).value).toBe('["a"]'));
      expect(screen.queryByRole('combobox', { name: 'Values' })).toBeNull();
    });
  });

  it('a boolean value is a true / false choice', async () => {
    const { updateSpy } = mountWith(makeState({ queryRaw: '{"f":{"$eq":true}}' }));

    const group = await screen.findByRole('radiogroup', { name: 'Value' });
    expect((within(group).getByRole('radio', { name: 'true' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByPlaceholderText('value')).toBeNull();

    fireEvent.click(within(group).getByRole('radio', { name: 'false' }));

    await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"f":{"$eq":false}}'));
  });

  /** The text of the element(s) an input names as its description. */
  function descriptionOf(el: HTMLElement): string {
    return (el.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => (id ? (document.getElementById(id)?.textContent ?? '') : ''))
      .join(' ')
      .trim();
  }

  it('an ObjectId that is not 24 hex characters is described on its input and never printed', async () => {
    const { updateSpy } = mountWith(makeState());

    fireEvent.click(await screen.findByRole('button', { name: 'Add condition' }));
    fireEvent.change(await screen.findByPlaceholderText('field'), { target: { value: 'o' } });
    await setValueType('objectid');
    const value = screen.getByPlaceholderText('value');
    fireEvent.change(value, { target: { value: 'abc' } });

    await waitFor(() => expect(descriptionOf(value)).toBe('ObjectId must be 24 hex characters'));
    expect(value.getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
    // Tab writes are debounced; once they settle, none carries the bad id.
    await new Promise((r) => setTimeout(r, 300));
    const written = (updateSpy.mock.calls as unknown[][]).map(
      (c) => (c[1] as { state?: Partial<CollectionTabState> } | undefined)?.state?.queryRaw,
    );
    expect(written.some((q) => q?.includes('"abc"'))).toBe(false);

    fireEvent.change(value, { target: { value: OID } });

    await waitFor(() => expect(descriptionOf(value)).toBe(''));
    expect(value.getAttribute('aria-invalid')).not.toBe('true');
    await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe(`{"o":{"$eq":{"$oid":"${OID}"}}}`));
  });

  it('a list of valid ObjectIds edited as JSON shows no error', async () => {
    const { updateSpy } = mountWith(makeState({ queryRaw: `{"o":{"$in":[{"$oid":"${OID}"}]}}` }));
    // A tree read back from queryRaw is not re-checked until it is edited, so edit it.
    const list = `[{"$oid":"${OID}"},{"$oid":"${OID.replace('0', '1')}"}]`;
    const value = await screen.findByPlaceholderText('value');
    fireEvent.change(value, { target: { value: list } });

    await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe(`{"o":{"$in":${list}}}`));
    expect(value.getAttribute('aria-invalid')).not.toBe('true');
    expect(descriptionOf(value)).toBe('');
  });

  it('a null value has no value input', async () => {
    mountWith(makeState({ queryRaw: '{"n":{"$eq":"x"}}' }));

    expect(await screen.findByPlaceholderText('value')).toBeTruthy();
    await setValueType('null');

    await waitFor(() => expect(screen.queryByPlaceholderText('value')).toBeNull());
  });

  it('the mongosh preview sits on its own line, and gives way to a value error rather than stacking with it', async () => {
    mountWith(makeState());

    fireEvent.click(await screen.findByRole('button', { name: 'Add condition' }));
    fireEvent.change(await screen.findByPlaceholderText('field'), { target: { value: 'o' } });
    await setValueType('objectid');
    const value = screen.getByPlaceholderText('value');
    fireEvent.change(value, { target: { value: 'abc' } });

    await waitFor(() => expect(descriptionOf(value)).toBe('ObjectId must be 24 hex characters'));
    expect(screen.queryByText('ObjectId("abc")')).toBeNull();

    fireEvent.change(value, { target: { value: OID } });

    const preview = await screen.findByText(`ObjectId("${OID}")`);
    expect(preview.getAttribute('aria-hidden')).toBe('true');
    // Beside the input it took the width the input needed; under it, it takes none.
    const inputRow = preview.previousElementSibling;
    expect(inputRow?.contains(value)).toBe(true);
    expect(inputRow?.contains(preview)).toBe(false);
  });
});

describe('Filter drawer — a canonical EJSON date', () => {
  it('pasted as {$date:{$numberLong}} is an editable raw row, not a condition on "$date"', async () => {
    const src = '{"d":{"$date":{"$numberLong":"1700000000000"}}}';
    mountWith(makeState({ queryRaw: src }));

    const rawBox = (await screen.findByRole('textbox', { name: 'Raw clause 1' })) as HTMLTextAreaElement;
    expect(rawBox.value).toBe(src);
    expect(screen.queryByText(/is not encodable/)).toBeNull();
    expect(screen.queryByPlaceholderText('value')).toBeNull();
  });
});

describe('Filter drawer — a value whose type disagrees with the sample', () => {
  const statusSample = () => vi.fn(async () => ({ docs: Array(10).fill({ status: 'a' }) }));

  it('says what the sampled documents hold, once per disagreeing row, from one sample', async () => {
    const sampleSchema = statusSample();
    mountWith(makeState({ queryRaw: '{"$and":[{"status":{"$eq":5}},{"status":{"$eq":"x"}}]}' }), { sampleSchema });

    expect(await screen.findByText('Sample: status is string in 100% of documents that have it')).toBeTruthy();
    expect(screen.getAllByText(/^Sample: /)).toHaveLength(1);
    expect(sampleSchema).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the value agrees', async () => {
    const sampleSchema = statusSample();
    mountWith(makeState({ queryRaw: '{"status":{"$eq":"x"}}' }), { sampleSchema });

    await waitFor(() => expect(sampleSchema).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/^Sample: /)).toBeNull();
  });

  it('does not sample for a row whose field is still blank', async () => {
    const sampleSchema = statusSample();
    mountWith(makeState(), { sampleSchema });

    fireEvent.click(await screen.findByRole('button', { name: 'Add condition' }));
    await screen.findByPlaceholderText('field');
    await new Promise((r) => setTimeout(r, 50));
    expect(sampleSchema).not.toHaveBeenCalled();
  });
});

describe('Filter drawer — starter templates', () => {
  const LABELS = ['Last 7 days', 'Exists and is not null', 'Contains text (any case)', 'One of a list'];

  it('an empty filter offers the four starters', async () => {
    mountWith(makeState());

    for (const name of LABELS) expect(await screen.findByRole('button', { name })).toBeTruthy();
  });

  it('a starter adds one pending row, focused on its field, and leaves queryRaw alone', async () => {
    const { updateSpy } = mountWith(makeState());

    fireEvent.click(await screen.findByRole('button', { name: 'Last 7 days' }));

    await waitFor(() => expect(fieldValues()).toEqual(['']));
    expect((screen.getByDisplayValue('$gte') as HTMLInputElement).placeholder).toBe('$op');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText('field')));
    // The row waits for a field, so nothing reaches queryRaw.
    await new Promise((r) => setTimeout(r, 300));
    expect(lastWrittenQueryRaw(updateSpy)).toBeUndefined();
    // The starters are for an empty filter only.
    expect(screen.queryByRole('button', { name: 'Last 7 days' })).toBeNull();
  });

  it('a starter runs once its field is filled in', async () => {
    const { updateSpy } = mountWith(makeState());

    fireEvent.click(await screen.findByRole('button', { name: 'Exists and is not null' }));
    fireEvent.change(await screen.findByPlaceholderText('field'), { target: { value: 'email' } });

    await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"email":{"$ne":null}}'));
  });

  it('picking a string field suggestion keeps the null the starter chose', async () => {
    const sampleSchema = vi.fn(async () => ({ docs: Array(10).fill({ email: 'a@b.c' }) }));
    const { updateSpy } = mountWith(makeState(), { sampleSchema });

    fireEvent.click(await screen.findByRole('button', { name: 'Exists and is not null' }));
    const field = await screen.findByPlaceholderText('field');
    fireEvent.focus(field);
    fireEvent.click(await screen.findByRole('option', { name: /email/ }));

    await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"email":{"$ne":null}}'));
  });

  it('picking a field suggestion on a plain new row adopts the suggested type', async () => {
    const sampleSchema = vi.fn(async () => ({ docs: Array(10).fill({ qty: 5 }) }));
    mountWith(makeState(), { sampleSchema });

    fireEvent.click(await screen.findByRole('button', { name: 'Add condition' }));
    const field = await screen.findByPlaceholderText('field');
    fireEvent.focus(field);
    fireEvent.click(await screen.findByRole('option', { name: /qty/ }));

    await waitFor(() =>
      expect(
        (screen.getAllByLabelText('Value type').find((el) => el.tagName === 'INPUT') as HTMLInputElement).value,
      ).toBe('number'),
    );
  });

  it('picking a field suggestion keeps the type of a starter that already holds a value', async () => {
    const sampleSchema = vi.fn(async () => ({ docs: Array(10).fill({ qty: 5 }) }));
    mountWith(makeState(), { sampleSchema });

    fireEvent.click(await screen.findByRole('button', { name: 'Contains text (any case)' }));
    const field = await screen.findByPlaceholderText('field');
    fireEvent.focus(field);
    fireEvent.click(await screen.findByRole('option', { name: /qty/ }));

    await waitFor(() => expect((field as HTMLInputElement).value).toBe('qty'));
    expect(
      (screen.getAllByLabelText('Value type').find((el) => el.tagName === 'INPUT') as HTMLInputElement).value,
    ).toBe('string');
  });

  it('a filter that cannot be edited offers no starters', async () => {
    mountWith(makeState({ queryRaw: '{not json' }));

    await screen.findByLabelText('Drop a field here to add a condition');
    expect(screen.queryByRole('button', { name: 'Last 7 days' })).toBeNull();
  });
});

describe('Filter drawer — an empty $in list is never printed', () => {
  const EMPTY = '$in needs at least one value';

  function descriptionOf(el: HTMLElement): string {
    return (el.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => (id ? (document.getElementById(id)?.textContent ?? '') : ''))
      .join(' ')
      .trim();
  }

  it('the One of a list starter waits for its first value', async () => {
    const { updateSpy } = mountWith(makeState());

    fireEvent.click(await screen.findByRole('button', { name: 'One of a list' }));
    fireEvent.change(await screen.findByPlaceholderText('field'), { target: { value: 'tags' } });

    const chipBox = await screen.findByRole('combobox', { name: 'Values' });
    await waitFor(() => expect(descriptionOf(chipBox)).toBe(EMPTY));
    expect(lastWrittenQueryRaw(updateSpy)).toBeUndefined();

    act(() => chipBox.focus());
    fireEvent.change(chipBox, { target: { value: 'a' } });
    fireEvent.keyDown(chipBox, { key: 'Enter' });
    await waitFor(() => expect(lastWrittenQueryRaw(updateSpy)).toBe('{"tags":{"$in":["a"]}}'));
  });

  it('removing the last chip leaves the filter text as it was', async () => {
    const { updateSpy } = mountWith(makeState({ queryRaw: '{"s":{"$in":["a"]}}' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Remove a' }));

    await waitFor(() => expect(descriptionOf(screen.getByRole('combobox', { name: 'Values' }))).toBe(EMPTY));
    expect(lastWrittenQueryRaw(updateSpy)).toBeUndefined();
  });

  it('switching $eq to $in over a value that is not a list leaves the filter text as it was', async () => {
    const { updateSpy } = mountWith(makeState({ queryRaw: '{"s":{"$eq":"x"}}' }));

    const op = await screen.findByDisplayValue('$eq');
    fireEvent.change(op, { target: { value: '$in' } });
    fireEvent.blur(op);

    await waitFor(() => expect(descriptionOf(screen.getByPlaceholderText('value'))).toBe(EMPTY));
    expect(lastWrittenQueryRaw(updateSpy)).toBeUndefined();
  });
});
