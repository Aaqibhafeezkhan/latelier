// W15 §13.4 / §13.5 / §13.7 — the Saved tab and the Recent tab: honest
// labels, a query you can identify, copy actions that report, and chrome
// that survives loading and error.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '../helpers/render';
import { SavedTab } from '../../src/pages/Workspace/views/SavedTab';
import { RecentTab } from '../../src/pages/Workspace/views/RecentTab';
import { notifications } from '@mantine/notifications';
import { modals } from '@mantine/modals';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { IpcApi } from '@shared/ipc';
import type { RecentQuery, SavedQuerySummary } from '@shared/types';

afterEach(() => {
  // Mantine's notification store is module-global and outlives RTL's
  // unmount, so a toast raised by one test would still be on screen for the
  // next one's "did it *not* claim success?" assertion.
  notifications.clean();
  // Same reason, one layer over: the delete/clear confirms live in the
  // modal manager's global store, so a test that fails mid-dialog would
  // leave it mounted for the next one.
  modals.closeAll();
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function summary(overrides: Partial<SavedQuerySummary> = {}): SavedQuerySummary {
  return {
    id: 'q1',
    connectionId: 'c1',
    dbName: 'shop',
    collection: 'orders',
    kind: 'find',
    name: 'Unpaid orders',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function recent(overrides: Partial<RecentQuery> = {}): RecentQuery {
  return {
    id: 'r1',
    connectionId: 'c1',
    dbName: 'shop',
    collection: 'orders',
    kind: 'find',
    payload: {
      kind: 'find',
      builder: { projection: [], sort: '', limit: '' },
      queryRaw: '{"status":{"$eq":"paid"}}',
    },
    ranAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    durationMs: 12,
    resultCount: 4,
    ...overrides,
  };
}

/**
 * A recent row as it was written before `queryRaw` existed. The live
 * `SavedFindPayload` type requires `queryRaw`, but the wire's IPC schema
 * validates recent payloads loosely (`z.record`), so a pre-W13 row really can
 * arrive shaped like this — the double cast mirrors that mismatch instead of
 * typechecking it away, the same way `saved-legacy-payload.spec.tsx` does.
 */
const LEGACY_PAYLOAD = {
  kind: 'find',
  builder: { projection: [], sort: '', limit: '' },
} as unknown as RecentQuery['payload'];

function renderRecent() {
  return render(
    <RecentTab connectionId="c1" dbName="shop" collection="orders" onRunHere={() => {}} />,
  );
}

function renderSaved(overrides: { onRunHere?: () => void; onOpenInTab?: (s: SavedQuerySummary) => void } = {}) {
  return render(
    <SavedTab
      connectionId="c1"
      dbName="shop"
      collection="orders"
      onRunHere={overrides.onRunHere ?? (() => {})}
      onOpenInTab={overrides.onOpenInTab ?? (() => {})}
    />,
  );
}

describe('Recent rows — icon buttons carry a tooltip', () => {
  it('shows the Delete tooltip when keyboard focus lands on a Recent row delete button', async () => {
    installAtelierMock({ recent: { list: async () => [recent()] } });
    renderRecent();

    fireEvent.focus(await screen.findByRole('button', { name: /^Delete .* from recent history$/ }));

    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('Delete');
  });
});

describe('W10 — consecutive identical runs show as one row with a run count', () => {
  const PREVIEW = '{"status":{"$eq":"paid"}}';
  const threeRuns = () => [recent({ id: 'a' }), recent({ id: 'b' }), recent({ id: 'c' })];

  it('collapses three adjacent identical runs into one row badged ×3', async () => {
    installAtelierMock({ recent: { list: async () => threeRuns() } });
    renderRecent();

    // The visible "×3" is hidden from assistive tech; the spoken form is text.
    const spoken = await screen.findByText('Ran 3 times');
    const visible = screen.getByText('×3');
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    expect(spoken.closest('[aria-hidden="true"]')).toBeNull();
    expect(screen.getAllByText(PREVIEW)).toHaveLength(1);
  });

  it('shows no badge on a run that happened once', async () => {
    installAtelierMock({ recent: { list: async () => [recent()] } });
    renderRecent();

    await screen.findByText(PREVIEW);
    expect(screen.queryByText(/^Ran \d+ times$/)).toBeNull();
    expect(screen.queryByText(/^×\d+$/)).toBeNull();
  });

  it('deleting a merged row deletes every run in it, and the confirm says how many', async () => {
    const clear = vi.fn(async () => ({ deleted: 1 }));
    installAtelierMock({ recent: { list: async () => threeRuns(), clear } });
    renderRecent();

    fireEvent.click(
      await screen.findByRole('button', { name: `Delete ${PREVIEW} from recent history` }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Delete these 3 runs?');
    expect(dialog.textContent).toContain('(3 runs)');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(clear).toHaveBeenCalledTimes(3));
    const scope = { connectionId: 'c1', dbName: 'shop', collection: 'orders', kind: 'find' };
    expect(clear.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { id: 'a', ...scope },
      { id: 'b', ...scope },
      { id: 'c', ...scope },
    ]);
  });
});

describe('a failed delete of a merged row still reloads the list', () => {
  it('reloads after the second clear rejects and shows the error', async () => {
    const clear = vi
      .fn()
      .mockResolvedValueOnce({ deleted: 1 })
      .mockRejectedValueOnce(new Error('disk full'));
    const list = vi.fn(async () => [recent({ id: 'a' }), recent({ id: 'b' }), recent({ id: 'c' })]);
    installAtelierMock({ recent: { list, clear } });
    renderRecent();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete {"status":{"$eq":"paid"}} from recent history' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(clear).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/disk full/)).toBeTruthy();
  });
});

// ─── §13.4 Recent rows ───────────────────────────────────────────────────────

describe('W15 §13.4 — a Recent row shows what was queried', () => {
  it('renders the filter and a timestamp that disambiguates days', async () => {
    installAtelierMock({ recent: { list: async () => [recent()] } });
    renderRecent();

    await screen.findByText('{"status":{"$eq":"paid"}}');
    // A bare `toLocaleTimeString()` made a run from three days ago read
    // `14:32`, indistinguishable from one an hour ago.
    expect(screen.getByText(/3d ago/)).toBeTruthy();
  });

  it('says so on a legacy row that stored no query', async () => {
    installAtelierMock({
      recent: {
        list: async () => [
          recent({
            payload: LEGACY_PAYLOAD,
          }),
        ],
      },
    });
    renderRecent();

    expect(await screen.findByText('no stored query')).toBeTruthy();
    // And it says so instead of rendering an empty or invented filter: the
    // row carries no `$`-prefixed operator text at all.
    expect(screen.queryByText(/\$/)).toBeNull();
  });
});

describe('W15 §13.7 — Recent\'s Copy MQL reports, and never silently no-ops', () => {
  it('copies and says so', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    installAtelierMock({ recent: { list: async () => [recent()] } });
    renderRecent();

    fireEvent.click(await screen.findByRole('button', { name: /^Copy MQL to the clipboard$/ }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('{"status":{"$eq":"paid"}}'));
    await screen.findByText(/Query copied to the clipboard/);
  });

  it('reports a rejected copy rather than claiming success', async () => {
    const writeText = vi.fn(async () => { throw new Error('denied'); });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    installAtelierMock({ recent: { list: async () => [recent()] } });
    renderRecent();

    fireEvent.click(await screen.findByRole('button', { name: /^Copy MQL to the clipboard$/ }));

    await screen.findByText(/Could not copy to the clipboard/);
    expect(screen.queryByText(/Query copied to the clipboard/)).toBeNull();
  });

  it('is unavailable, with the reason stated, on a row with no stored query', async () => {
    installAtelierMock({
      recent: {
        list: async () => [
          recent({
            payload: LEGACY_PAYLOAD,
          }),
        ],
      },
    });
    renderRecent();

    const copy = await screen.findByRole('button', { name: /Copy MQL — this run has no stored query/ });
    expect(copy).toHaveProperty('disabled', true);
  });

  it('states the reason in its tooltip on a row with no stored query, even though the button is disabled', async () => {
    installAtelierMock({ recent: { list: async () => [recent({ payload: LEGACY_PAYLOAD })] } });
    renderRecent();

    const copy = await screen.findByRole('button', { name: /Copy MQL — this run has no stored query/ });
    // The disabled button receives no pointer events; its wrapper is the tooltip target.
    fireEvent.mouseEnter(copy.parentElement!);

    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'This run has no stored query to copy',
    );
  });
});

// ─── §13.5 chrome survives loading / error, and icon buttons have names ──────

describe('W15 §13.5 — Saved and Recent keep their chrome through loading and error', () => {
  it('Recent keeps its header while loading and after a failure', async () => {
    let reject!: (e: Error) => void;
    installAtelierMock({
      recent: {
        list: (() => new Promise((_res, rej) => { reject = rej; })) as unknown as IpcApi['recent']['list'],
      },
    });
    renderRecent();

    // Loading: the header is there, not a bare centered message.
    await screen.findByText('Loading…');
    expect(screen.getByText(/Recent ·/)).toBeTruthy();

    reject(new Error('boom'));
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    // Error: still there, and the refresh control is still reachable.
    expect(screen.getByText(/Recent ·/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh recent queries' })).toBeTruthy();
  });

  it('Saved keeps its header while loading and after a failure', async () => {
    let reject!: (e: Error) => void;
    installAtelierMock({
      saved: {
        list: (() => new Promise((_res, rej) => { reject = rej; })) as unknown as IpcApi['saved']['list'],
      },
    });
    renderSaved();

    await screen.findByText('Loading…');
    expect(screen.getByText(/Saved ·/)).toBeTruthy();

    reject(new Error('boom'));
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.getByText(/Saved ·/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh saved queries' })).toBeTruthy();
  });

  // jsdom never blurs an element that goes `disabled`, and the e2e suite cannot
  // inject IPC latency, so the focus drop itself is unobservable here; what the
  // fix guarantees (and what is asserted) is that Refresh never takes the real
  // `disabled` attribute, which is what makes Chromium blur it.
  it.each([
    ['Recent', 'Refresh recent queries', 'recent', renderRecent],
    ['Saved', 'Refresh saved queries', 'saved', renderSaved],
  ] as const)('%s keeps Refresh focusable while loading and swallows a second click', async (_tab, name, ns, renderTab) => {
    let lists = 0;
    let finish: (rows: never[]) => void = () => {};
    installAtelierMock({
      [ns]: {
        list: (() => {
          lists += 1;
          return new Promise<never[]>((resolve) => { finish = resolve; });
        }) as unknown as never,
      },
    });
    renderTab();

    const refresh = await screen.findByRole('button', { name });
    await waitFor(() => expect(lists).toBe(1));
    expect(refresh.hasAttribute('disabled')).toBe(false);
    expect(refresh.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(refresh);
    expect(lists).toBe(1);

    await act(async () => { finish([]); });
    expect(screen.getByRole('button', { name }).hasAttribute('aria-disabled')).toBe(false);
  });

  it('Saved\'s icon-only delete has a real accessible name, not just a title', async () => {
    installAtelierMock({ saved: { list: async () => [summary({ name: 'Unpaid orders' })] } });
    renderSaved();

    const del = await screen.findByRole('button', { name: 'Delete "Unpaid orders"' });
    // The tooltip is the hover/focus hint; it is not what names the button.
    fireEvent.focus(del);
    expect((await screen.findByRole('tooltip')).textContent).toBe('Delete');
    // Row actions are distinguishable from one another, per row.
    expect(screen.getByRole('button', { name: 'Run "Unpaid orders" in this tab' })).toBeTruthy();
  });
});

// SavedTab is the only surface listing saved aggregation/script items now
// that SavedStrip is gone, so it has to be able to open them, not just find
// queries.
describe('SavedTab opens every saved kind, not just find', () => {
  it('a find row runs in place via onRunHere', async () => {
    const onRunHere = vi.fn();
    installAtelierMock({
      saved: {
        list: async () => [summary({ kind: 'find', name: 'Unpaid orders' })],
        get: async () => ({ ...summary({ kind: 'find' }), payload: { kind: 'find', builder: { projection: [], sort: '', limit: '' }, queryRaw: '{}' } } as never),
      },
    });
    renderSaved({ onRunHere });

    fireEvent.click(await screen.findByRole('button', { name: 'Run "Unpaid orders" in this tab' }));

    await waitFor(() => expect(onRunHere).toHaveBeenCalledTimes(1));
  });

  it('an aggregation row opens as its own tab via onOpenInTab, not onRunHere', async () => {
    const onRunHere = vi.fn();
    const onOpenInTab = vi.fn();
    const agg = summary({ kind: 'aggregation', name: 'Top spenders' });
    installAtelierMock({ saved: { list: async () => [agg] } });
    renderSaved({ onRunHere, onOpenInTab });

    fireEvent.click(await screen.findByRole('button', { name: 'Open "Top spenders" in a new tab' }));

    expect(onOpenInTab).toHaveBeenCalledWith(agg);
    expect(onRunHere).not.toHaveBeenCalled();
  });

  it('a script row opens as its own tab via onOpenInTab, not onRunHere', async () => {
    const onRunHere = vi.fn();
    const onOpenInTab = vi.fn();
    const script = summary({ kind: 'script', name: 'Backfill emails' });
    installAtelierMock({ saved: { list: async () => [script] } });
    renderSaved({ onRunHere, onOpenInTab });

    fireEvent.click(await screen.findByRole('button', { name: 'Open "Backfill emails" in a new tab' }));

    expect(onOpenInTab).toHaveBeenCalledWith(script);
    expect(onRunHere).not.toHaveBeenCalled();
  });

  it('labels each row by kind so find, aggregation and script are distinguishable', async () => {
    installAtelierMock({
      saved: {
        list: async () => [
          summary({ id: 'q1', kind: 'find', name: 'Unpaid orders' }),
          summary({ id: 'q2', kind: 'aggregation', name: 'Top spenders' }),
          summary({ id: 'q3', kind: 'script', name: 'Backfill emails' }),
        ],
      },
    });
    renderSaved();

    await screen.findByText('Unpaid orders');
    expect(screen.getByText('Find')).toBeTruthy();
    expect(screen.getByText('Aggregation')).toBeTruthy();
    expect(screen.getByText('Script')).toBeTruthy();
  });
});

// Recent's delete and clear-history.
describe(' Recent can delete a row and clear its history', () => {
  const PREVIEW = '{"status":{"$eq":"paid"}}';

  it('per-row delete asks first, and is bounded by the tab’s scope', async () => {
    const clear = vi.fn(async () => ({ deleted: 1 }));
    installAtelierMock({ recent: { list: async () => [recent()], clear } });
    renderRecent();

    fireEvent.click(
      await screen.findByRole('button', { name: `Delete ${PREVIEW} from recent history` }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Delete this run?');
    expect(clear).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    // The id alone used to be the whole filter. A review finding
    // pointed out that a stale `recent.list` can put another collection's rows
    // under this header, and a bare id would then delete that collection's
    // history. The scope travels with it so the delete ANDs down to nothing
    // rather than to the wrong thing.
    await waitFor(() =>
      expect(clear).toHaveBeenCalledWith({
        id: 'r1',
        connectionId: 'c1',
        dbName: 'shop',
        collection: 'orders',
        kind: 'find',
      }),
    );
  });

  it('cancelling the per-row delete deletes nothing', async () => {
    const clear = vi.fn(async () => ({ deleted: 1 }));
    installAtelierMock({ recent: { list: async () => [recent()], clear } });
    renderRecent();

    fireEvent.click(
      await screen.findByRole('button', { name: `Delete ${PREVIEW} from recent history` }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(clear).not.toHaveBeenCalled();
  });

  it('clear history confirms with the collection named, then clears the full four-part scope', async () => {
    const clear = vi.fn(async () => ({ deleted: 3 }));
    installAtelierMock({ recent: { list: async () => [recent()], clear } });
    renderRecent();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Clear recent find history for orders' }),
    );

    const dialog = await screen.findByRole('dialog');
    // The scope decision has to be legible before the user commits to it.
    expect(dialog.textContent).toContain('orders');
    expect(dialog.textContent).toContain('shop');
    expect(dialog.textContent).toContain('Aggregation history');
    expect(clear).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Clear history' }));
    // `kind: 'find'` is the guard: without it this wipes aggregation history
    // the tab never listed. `dbName` keeps it off `analytics.orders`.
    await waitFor(() => expect(clear).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'shop',
      collection: 'orders',
      kind: 'find',
    }));
  });

  it('cancelling clear history clears nothing', async () => {
    const clear = vi.fn(async () => ({ deleted: 3 }));
    installAtelierMock({ recent: { list: async () => [recent()], clear } });
    renderRecent();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Clear recent find history for orders' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(clear).not.toHaveBeenCalled();
  });
});
