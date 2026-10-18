import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, expectKeyboardDisclosureToggle } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { IndexesTab } from '../../src/pages/IndexesTab';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { IndexInfo } from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function renderTab() {
  return render(
      <IndexesTab connectionId="c1" dbName="alpha" collection="people" />
  );
}

const ID_INDEX: IndexInfo = {
  name: '_id_',
  key: [{ field: '_id', direction: 1 }],
  isIdIndex: true,
  unique: false,
  sparse: false,
  hidden: false,
  version: 2,
  sizeBytes: 4096,
  usage: { ops: 12, since: '2026-04-01T00:00:00.000Z' },
};

const TTL_INDEX: IndexInfo = {
  name: 'created_-1_ttl',
  key: [{ field: 'created', direction: -1 }],
  isIdIndex: false,
  unique: false,
  sparse: false,
  hidden: false,
  version: 2,
  expireAfterSeconds: 86400,
  sizeBytes: 8192,
  usage: { ops: 1234, since: '2026-04-01T00:00:00.000Z' },
};

const UNIQUE_INDEX: IndexInfo = {
  name: 'email_unique',
  key: [{ field: 'email', direction: 1 }],
  isIdIndex: false,
  unique: true,
  sparse: false,
  hidden: false,
  version: 2,
  sizeBytes: 16384,
};

describe('IndexesTab — render', () => {
  it('lists the given namespace\'s indexes with no picker', async () => {
    installAtelierMock({
      index: {
        list: async ({ connectionId, dbName, collection }) => {
          expect({ connectionId, dbName, collection }).toEqual({
            connectionId: 'c1',
            dbName: 'alpha',
            collection: 'people',
          });
          return [ID_INDEX, TTL_INDEX, UNIQUE_INDEX];
        },
      },
    });

    renderTab();

    expect(screen.queryByLabelText('Database')).toBeNull();
    expect(screen.queryByLabelText('Collection')).toBeNull();

    await waitFor(() => {
      expect(screen.getByText('_id_')).toBeTruthy();
      expect(screen.getByText('email_unique')).toBeTruthy();
      expect(screen.getByText('created_-1_ttl')).toBeTruthy();
    });

    // Badges from indexBadges.
    expect(screen.getByText('default')).toBeTruthy();
    expect(screen.getByText('unique')).toBeTruthy();
    expect(screen.getByText(/^ttl 1d$/)).toBeTruthy();

    // Size + use columns rendered for at least the TTL index.
    expect(screen.getByText('8.0 KB')).toBeTruthy();
    expect(screen.getByText(/1\.2k/)).toBeTruthy();
  });

  it('expands the row drill-down on click and shows version + usage detail', async () => {
    installAtelierMock({
      index: {
        list: async () => [
          {
            ...UNIQUE_INDEX,
            partialFilterExpression: '{"status":{"$eq":"active"}}',
          },
        ],
      },
    });

    renderTab();

    const row = await screen.findByText('email_unique');
    await userEvent.click(row);

    await waitFor(() => {
      expect(screen.getByText(/v2/)).toBeTruthy();
      expect(screen.getByText(/partialFilterExpression/)).toBeTruthy();
    });
  });

  it('is keyboard-operable: Enter and Space toggle aria-expanded, and focus stays on the toggle', async () => {
    installAtelierMock({
      index: { list: async () => [UNIQUE_INDEX] },
    });

    renderTab();

    await expectKeyboardDisclosureToggle('email_unique', /v2/);
  });

  it('does not strand focus on <body> when the expanded index is dropped', async () => {
    let dropped = false;
    installAtelierMock({
      index: {
        list: async () => (dropped ? [] : [UNIQUE_INDEX]),
        drop: async () => {
          dropped = true;
          return { dropped: true as const };
        },
      },
    });

    renderTab();

    await userEvent.click(await screen.findByRole('button', { name: 'email_unique' }));
    await waitFor(() => expect(screen.getByText(/v2/)).toBeTruthy());

    await userEvent.click(screen.getByLabelText('Drop index email_unique'));
    const confirmInput = await screen.findByLabelText('Confirm index name');
    await userEvent.type(confirmInput, 'email_unique');
    await userEvent.click(screen.getByText('Drop').closest('button')!);

    await waitFor(() => expect(screen.queryByText('email_unique')).toBeNull());
    // #74 fixed this — focus now lands on the tab's scroll region, not <body>.
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Indexes' }));
  });

  it('reloads the list when the namespace prop changes', async () => {
    const calls: Array<{ dbName: string; collection: string }> = [];
    installAtelierMock({
      index: {
        list: async ({ dbName, collection }) => {
          calls.push({ dbName, collection });
          return dbName === 'beta' ? [ID_INDEX] : [UNIQUE_INDEX];
        },
      },
    });

    const { rerender } = render(
      <IndexesTab connectionId="c1" dbName="alpha" collection="people" />,
    );
    await waitFor(() => expect(screen.getByText('email_unique')).toBeTruthy());

    rerender(<IndexesTab connectionId="c1" dbName="beta" collection="logs" />);

    await waitFor(() => expect(screen.getByText('_id_')).toBeTruthy());
    expect(calls).toEqual([
      { dbName: 'alpha', collection: 'people' },
      { dbName: 'beta', collection: 'logs' },
    ]);
  });

  it('shows the newer collection\'s indexes when an older list call resolves last', async () => {
    const pending: Record<string, { resolve: (r: IndexInfo[]) => void; reject: (e: unknown) => void }> = {};
    installAtelierMock({
      index: {
        list: ({ collection }) =>
          new Promise<IndexInfo[]>((resolve, reject) => {
            pending[collection] = { resolve, reject };
          }),
      },
    });

    const { rerender } = renderTab();
    await waitFor(() => expect(pending.people).toBeDefined());
    rerender(<IndexesTab connectionId="c1" dbName="alpha" collection="orders" />);
    await waitFor(() => expect(pending.orders).toBeDefined());

    await act(async () => {
      pending.orders.resolve([UNIQUE_INDEX]);
    });
    await act(async () => {
      pending.people.resolve([TTL_INDEX]);
    });

    expect(screen.getByText('email_unique')).toBeTruthy();
    expect(screen.queryByText('created_-1_ttl')).toBeNull();
  });

  it('ignores a stale failure and a stale loading flag from the collection left behind', async () => {
    const pending: Record<string, { resolve: (r: IndexInfo[]) => void; reject: (e: unknown) => void }> = {};
    installAtelierMock({
      index: {
        list: ({ collection }) =>
          new Promise<IndexInfo[]>((resolve, reject) => {
            pending[collection] = { resolve, reject };
          }),
      },
    });

    const { rerender } = renderTab();
    await waitFor(() => expect(pending.people).toBeDefined());
    rerender(<IndexesTab connectionId="c1" dbName="alpha" collection="orders" />);
    await waitFor(() => expect(pending.orders).toBeDefined());

    // The stale call fails first: it must neither show its error nor clear the
    // loading state the newer call is still holding.
    await act(async () => {
      pending.people.reject(new Error('stale boom'));
    });
    expect(screen.queryByText(/stale boom/)).toBeNull();
    expect((screen.getByRole('button', { name: /refresh/i }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      pending.orders.resolve([UNIQUE_INDEX]);
    });
    expect(screen.getByText('email_unique')).toBeTruthy();
    expect((screen.getByRole('button', { name: /refresh/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});
