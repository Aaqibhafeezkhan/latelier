import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { commandRegistry } from '../../src/commands/registry';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { BuilderState, CollectionTabState, WorkspaceTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

/**
 * W15 Tier 2a — projection and sort share one autocomplete-backed
 * input, and projection gains the raw escape hatch that makes `{_id: 0}`
 * reachable at all. Sort sits in the query bar's advanced row; projection in
 * the Fields control (W14 §4).
 *
 * §2.3/§3.4 completion, §2.2 the `_id` exclusion and its save/restore round
 * trip, §9(b) the additive `projectionRaw`, §11 fail-closed.
 */

const now = '2026-08-06T12:00:00.000Z';

// Field candidates come from `lastRunSource`, which walks the tab's own
// result documents — `address.city` is here so the dotted-path requirement
// is exercised rather than assumed.
const DOCS = [
  { _id: '1', name: 'Ada', nickname: 'A', address: { city: 'London' } },
  { _id: '2', name: 'Grace', nickname: 'G', address: { city: 'NYC' } },
];

function makeState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun: { documents: DOCS, durationMs: 1, ranAt: now },
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

/** Latest `builder` the 250ms-debounced `tabs.update` was asked to persist. */
function lastWrittenBuilder(
  updateSpy: ReturnType<typeof vi.fn>,
): BuilderState | undefined {
  for (let i = updateSpy.mock.calls.length - 1; i >= 0; i--) {
    const arg = updateSpy.mock.calls[i]?.[1] as { state?: Partial<CollectionTabState> } | undefined;
    if (arg?.state && 'builder' in arg.state) return arg.state.builder;
  }
  return undefined;
}

/** The projection lives in the Fields control (W14 §4), behind its button. */
async function openProjection(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: /^fields/i }));
  return screen.findByTestId('fields-projection');
}

/**
 * The advanced row is collapsed while nothing is set (W14 §1), so a tab with
 * a default builder has to open it before the sort input exists.
 */
async function openAdvanced(): Promise<void> {
  await screen.findByTestId('query-bar-input');
  const trigger = document.querySelector('[aria-controls="query-bar-advanced"]');
  if (trigger && trigger.getAttribute('aria-expanded') !== 'true') {
    fireEvent.click(trigger);
  }
}

/**
 * Type into an autocomplete input and place the caret at the end, the way a
 * keyboard would. `FieldAutocompleteInput` reads `selectionStart` to slice the
 * token out; leaving it at 0 would search on an empty token and match every
 * field, which is exactly the assertion these tests need to not pass on.
 */
function typeWithCaret(input: HTMLElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  (input as HTMLInputElement).setSelectionRange(value.length, value.length);
  fireEvent.keyUp(input, { key: 'a' });
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

// ─── §2.3 / §3.4 ────────────────────────────────────────────────────────────

describe('W15 §2.3/§3.4 — field completion on projection and sort', () => {
  it('typing a prefix in the projection input offers field candidates, and picking one inserts it', async () => {
    mountWith(makeState());
    const input = await openProjection();
    typeWithCaret(input, '{ nam');

    const option = await screen.findByRole('option', { name: /^name/ });
    // Ranked, not "everything": `address` doesn't match the token `nam`.
    expect(screen.queryByRole('option', { name: /^address$/ })).toBeNull();

    fireEvent.click(option);

    // The token is replaced in place — the `{ ` the user already typed
    // survives, so the completion drops into the document being written.
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('{ name'));
  });

  it('pressing a suggestion keeps the Fields popover open and inserts the pick', async () => {
    // The input lives in a Mantine Popover dropdown whose click-outside
    // handler watches the DOM path of a real mousedown. A suggestion list
    // portaled out of that dropdown would close it (and commit the half-typed
    // projection) before the click landed.
    mountWith(makeState());
    const input = await openProjection();
    typeWithCaret(input, '{ nam');
    const option = await screen.findByRole('option', { name: /^name/ });

    await userEvent.click(option);

    await waitFor(() => expect((input as HTMLInputElement).value).toBe('{ name'));
    expect(screen.getByTestId('fields-projection')).toBe(input);
  });

  it('completes dotted paths', async () => {
    mountWith(makeState());
    const input = await openProjection();
    typeWithCaret(input, '{ address.ci');

    fireEvent.click(await screen.findByRole('option', { name: /address\.city/ }));

    await waitFor(() =>
      expect((input as HTMLInputElement).value).toBe('{ address.city'),
    );
  });

  it('Enter commits a complete projection instead of appending the top suggestion', async () => {
    // The e2e regression this control introduced: the popover opens on focus
    // with row 0 auto-highlighted, so Enter used to insert `_id` and produce
    // `{ name: 1 }_id`. Typing a whole projection and pressing Enter is the
    // ordinary way to use this input.
    const { updateSpy } = mountWith(makeState());
    const input = await openProjection();
    typeWithCaret(input, '{ name: 1 }');
    // Popover is open and offering — this is not a "no suggestions" pass.
    expect(await screen.findByRole('option', { name: /^name/ })).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(lastWrittenBuilder(updateSpy)?.projection).toEqual(['name']);
    });
    expect((input as HTMLInputElement).value).not.toMatch(/_id/);
  });

  it('ArrowDown then Enter inserts the chosen candidate, through the real input', async () => {
    // The other half of the Enter rule, and deliberately not in the popover's
    // own harness: `FieldAutocompleteInput` re-renders on `onKeyUp`, and the
    // engagement resets on any new `items` identity, so "arrow then Enter"
    // has to be proven through a call site that moves between the two keys.
    // `{ n` matches two candidates, so landing on the *second* is evidence the
    // arrow moved rather than the list happening to have one entry.
    mountWith(makeState());
    const input = await openProjection();
    typeWithCaret(input, '{ n');
    await screen.findByRole('option', { name: /^name/ });
    expect(screen.getByRole('option', { name: /^nickname/ })).toBeTruthy();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect((input as HTMLInputElement).value).toBe('{ nickname'));
  });

  it('the sort input offers the same completion from the same control', async () => {
    mountWith(makeState());
    await openAdvanced();

    const input = await screen.findByTestId('query-bar-sort');
    typeWithCaret(input, '{"nickn');

    const option = await screen.findByRole('option', { name: /nickname/ });
    fireEvent.click(option);

    // The opening quote is punctuation, not part of the token: 'token' mode
    // completes the field word and leaves the JSON the user is building.
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('{"nickname'));
  });
});

// ─── §2.2 / §9(b) ───────────────────────────────────────────────────────────

describe('W15 §2.2 — {_id: 0} is expressible and survives a round trip', () => {
  it('commits an exclusion to projectionRaw and persists it', async () => {
    // Seeded with a modelled projection so "the two are mutually exclusive"
    // is an assertion about a field that had something in it to clear.
    const { updateSpy } = mountWith(
      makeState({ builder: { projection: ['name'], sort: '', limit: '' } }),
    );
    const input = await openProjection();
    fireEvent.change(input, { target: { value: '{"_id": 0}' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(lastWrittenBuilder(updateSpy)?.projectionRaw).toBe('{"_id": 0}');
    });
    // The two fields are mutually exclusive — a stale inclusion list left
    // beside the raw text would give the compiler two answers.
    expect(lastWrittenBuilder(updateSpy)?.projection).toEqual([]);
    // Committed, so the input shows the stored value rather than a draft.
    expect((input as HTMLInputElement).value).toBe('{"_id": 0}');
  });

  it('a tab restored with projectionRaw shows it and sends it verbatim', async () => {
    const { findSpy } = mountWith(
      makeState({ builder: { projection: [], projectionRaw: '{ "name": 1, "_id": 0 }', sort: '', limit: '' } }),
    );

    const input = await openProjection();
    expect((input as HTMLInputElement).value).toBe('{ "name": 1, "_id": 0 }');

    fireEvent.click(screen.getByTestId('query-run-btn'));
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    // Verbatim — no `{_id: 1}` seeding on the way out, which is the whole
    // reason `{_id: 0}` was unreachable before.
    expect(findSpy.mock.calls[0]?.[0]?.projection).toBe('{ "name": 1, "_id": 0 }');
  });

  it('switching back to an inclusion clears the raw projection', async () => {
    const { updateSpy } = mountWith(
      makeState({ builder: { projection: [], projectionRaw: '{"_id":0}', sort: '', limit: '' } }),
    );

    const input = await openProjection();
    fireEvent.change(input, { target: { value: '{ name: 1 }' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(lastWrittenBuilder(updateSpy)?.projection).toEqual(['name']);
    });
    expect(lastWrittenBuilder(updateSpy)?.projectionRaw).toBeUndefined();
  });
});

describe('W15 §9(b) — projectionRaw is additive', () => {
  it('a tab persisted with a plain string[] projection and no projectionRaw restores identically', async () => {
    const { findSpy, updateSpy } = mountWith(
      makeState({ builder: { projection: ['name', 'nickname'], sort: '', limit: '' } }),
    );

    // Same rendering as before …
    const input = await openProjection();
    expect((input as HTMLInputElement).value).toBe('{ name: 1, nickname: 1 }');

    // … same compiled projection …
    fireEvent.click(screen.getByTestId('query-run-btn'));
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    expect(findSpy.mock.calls[0]?.[0]?.projection).toBe('{"_id":1,"name":1,"nickname":1}');

    // … and nothing wrote a `projectionRaw` behind the user's back.
    const written = lastWrittenBuilder(updateSpy);
    if (written) {
      expect(written.projection).toEqual(['name', 'nickname']);
      expect(written.projectionRaw).toBeUndefined();
    }
  });
});

// ─── §11 fail-closed ────────────────────────────────────────────────────────

describe('W15 §11 — a refused projection never widens the query', () => {
  it('gates Run, says why, and never calls find', async () => {
    // A raw projection the app can no longer parse — a hand-edited tab row, a
    // half-typed value that got persisted. Refusing it must not mean running
    // the find with no projection at all.
    const { findSpy } = mountWith(
      makeState({ builder: { projection: [], projectionRaw: '{"_id":0', sort: '', limit: '' } }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('query-run-btn')).toHaveProperty('disabled', true);
    });
    await openProjection();
    expect(screen.getByText(/Can't parse this projection/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('query-run-btn'));
    await new Promise((r) => setTimeout(r, 0));
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('the runner refuses too, on the paths with no button to disable', async () => {
    const { findSpy } = mountWith(
      makeState({ builder: { projection: [], projectionRaw: '{"_id":0', sort: '', limit: '' } }),
    );

    await screen.findByTestId('query-run-btn');
    const runCmd = commandRegistry.list().find((c) => c.id === 'query.run');
    expect(runCmd).toBeDefined();

    act(() => {
      void runCmd!.perform({ pathname: '/workspace', connectionId: 'c1' });
    });

    await waitFor(() => {
      expect(screen.getByText(/VALIDATION: Can't parse this projection/)).toBeTruthy();
    });
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('an unmodelable projection that is not a document is refused with the fix named', async () => {
    const { updateSpy } = mountWith(makeState());
    const input = await openProjection();
    // A projection that can neither be modelled nor passed through. X14 §3
    // took `{_id: 0}` out of that class — the transform repairs it to
    // a document and it commits to `projectionRaw` — so what remains is text
    // the transform refuses, and the fixture is unbalanced to match. §11's
    // guarantee is the one under test: refused means refused, never widened.
    //
    // X14 §5 settled the wording: the transform's own reason, located
    // by line and column, because "quote the keys" fixes nothing here.
    fireEvent.change(input, { target: { value: '{_id: 0' } });
    fireEvent.blur(input);

    expect(await screen.findByText(/^Line 1, column 8: /)).toBeTruthy();
    // The draft survives — it is the only copy of what the user typed …
    expect((input as HTMLInputElement).value).toBe('{_id: 0');
    // … and nothing was committed from it.
    await new Promise((r) => setTimeout(r, 300));
    expect(lastWrittenBuilder(updateSpy)?.projectionRaw).toBeUndefined();
  });
});
