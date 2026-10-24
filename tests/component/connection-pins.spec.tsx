import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '../helpers/render';
import { ConnectionExpandedTable } from '../../src/features/connections/ConnectionExpandedTable';
import { ConnectionSwitcher } from '../../src/features/connections/ConnectionSwitcher';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { ConnectionSummary } from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function conn(overrides: Partial<ConnectionSummary>): ConnectionSummary {
  return {
    id: 'c1',
    name: 'Alpha',
    color: '#1A6835',
    host: 'localhost',
    port: 27017,
    connectionType: 'standard',
    readOnly: false,
    status: 'unknown',
    ...overrides,
  };
}

const CONNS = [
  conn({ id: 'c1', name: 'Alpha' }),
  conn({ id: 'c2', name: 'Bravo' }),
  conn({ id: 'c3', name: 'Charlie' }),
];

function renderTable(connections: ConnectionSummary[]) {
  render(
    <ConnectionExpandedTable
      connections={connections}
      initialQuery=""
      returnFocusTo={null}
      onClose={vi.fn()}
      onConnect={vi.fn()}
      onManage={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onAdd={vi.fn()}
      onImport={vi.fn()}
      tabCountFor={() => 0}
      onDeleteMany={vi.fn(async () => undefined)}
    />,
  );
}

function renderSwitcher(connections: ConnectionSummary[]) {
  render(
    <ConnectionSwitcher
      connections={connections}
      focusedConnectionId={connections[0]?.id ?? null}
      onSwitch={vi.fn()}
      onManage={vi.fn()}
      onDisconnect={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onExpand={vi.fn()}
    />,
  );
}

/** Row names in on-screen order. */
const tableNames = () =>
  screen
    .getAllByRole('row')
    .map((r) => within(r).queryByText(/^(Alpha|Bravo|Charlie)$/)?.textContent)
    .filter((n): n is string => n !== undefined);

describe('pinned connections', () => {
  it('a stored pin sorts its row first in the Connections table, and stored ids of deleted connections are ignored', async () => {
    installAtelierMock({ prefs: { get: async () => ['c3', 'deleted-id'] as never } });
    renderTable(CONNS);

    await waitFor(() => expect(tableNames()).toEqual(['Charlie', 'Alpha', 'Bravo']));
  });

  it('Pin on the open row moves it to the top and saves the pin list; pressing it again unpins', async () => {
    const set = vi.fn(async (_k: string, v: unknown) => v);
    installAtelierMock({ prefs: { get: async () => null, set: set as never } });
    renderTable(CONNS);

    fireEvent.click(await screen.findByText('Bravo'));
    const pin = await screen.findByRole('button', { name: 'Pin Bravo' });
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pin);

    await waitFor(() => expect(tableNames()).toEqual(['Bravo', 'Alpha', 'Charlie']));
    expect(set).toHaveBeenCalledWith('ui.connections.pinned', ['c2']);
    // Same accessible name, flipped state: the label never negates itself.
    const unpin = screen.getByRole('button', { name: 'Pin Bravo' });
    expect(unpin.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Unpin Bravo' })).toBeNull();

    fireEvent.click(unpin);
    await waitFor(() => expect(tableNames()).toEqual(['Alpha', 'Bravo', 'Charlie']));
    expect(set).toHaveBeenLastCalledWith('ui.connections.pinned', []);
  });

  it('a failed save puts the row back and says so', async () => {
    installAtelierMock({
      prefs: {
        get: async () => null,
        set: (async () => {
          throw { code: 'VALIDATION', message: 'nope' };
        }) as never,
      },
    });
    renderTable(CONNS);

    fireEvent.click(await screen.findByText('Bravo'));
    fireEvent.click(await screen.findByRole('button', { name: 'Pin Bravo' }));

    await screen.findByText('Could not save pinned connections');
    await waitFor(() => expect(tableNames()).toEqual(['Alpha', 'Bravo', 'Charlie']));
  });

  it('when the saved pins could not be read, pinning is refused and nothing is written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const set = vi.fn(async (_k: string, v: unknown) => v);
    installAtelierMock({
      prefs: {
        get: (async () => {
          throw { code: 'SYSTEM', message: 'db locked' };
        }) as never,
        set: set as never,
      },
    });
    renderTable(CONNS);

    await screen.findByText('Could not load pinned connections');
    fireEvent.click(await screen.findByText('Bravo'));
    fireEvent.click(await screen.findByRole('button', { name: 'Pin Bravo' }));

    await screen.findByText('Pins are unavailable because they could not be loaded');
    expect(set).not.toHaveBeenCalled();
    expect(tableNames()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    // The cause is kept, not dropped.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[pins]'), expect.objectContaining({ message: 'db locked' }));
  });

  it('overlapping toggles run in order: a failed first save cannot roll back the second pin', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let failFirst!: () => void;
    const set = vi
      .fn<(k: string, v: unknown) => Promise<unknown>>()
      .mockImplementationOnce(() => new Promise((_, reject) => (failFirst = () => reject({ message: 'disk full' }))))
      .mockImplementation(async (_k, v) => v);
    installAtelierMock({ prefs: { get: async () => null, set: set as never } });
    renderTable(CONNS);

    fireEvent.click(await screen.findByText('Bravo'));
    fireEvent.click(await screen.findByRole('button', { name: 'Pin Bravo' }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('Charlie'));
    fireEvent.click(await screen.findByRole('button', { name: 'Pin Charlie' }));
    // The second toggle waits for the first save to settle.
    expect(set).toHaveBeenCalledTimes(1);

    failFirst();

    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    // Built from the rolled-back list, so Bravo's failed pin is not in it.
    expect(set).toHaveBeenLastCalledWith('ui.connections.pinned', ['c3']);
    await waitFor(() => expect(tableNames()).toEqual(['Charlie', 'Alpha', 'Bravo']));
  });

  it('the switcher lists a pinned connection first', async () => {
    installAtelierMock({ prefs: { get: async () => ['c2'] as never } });
    renderSwitcher(CONNS);

    fireEvent.click(screen.getByRole('button', { name: /^Connection: / }));
    const listbox = await screen.findByRole('listbox', { name: 'Connections' });
    await waitFor(() =>
      expect(within(listbox).getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual([
        'Bravo',
        'Alpha',
        'Charlie',
      ]),
    );
  });
});

describe('server version badge', () => {
  const VERSIONED = [
    conn({ id: 'c1', name: 'Alpha', status: 'connected', serverVersion: '7.0.5' }),
    conn({ id: 'c2', name: 'Bravo', status: 'error', serverVersion: '6.0.1' }),
    conn({ id: 'c3', name: 'Charlie', status: 'connected' }),
  ];

  it('shows v{version} in the table only for a connected connection that has one', async () => {
    installAtelierMock();
    renderTable(VERSIONED);

    expect(await screen.findByText('v7.0.5')).toBeTruthy();
    expect(screen.queryByText('v6.0.1')).toBeNull();
    expect(screen.getAllByText(/^v\d/)).toHaveLength(1);
  });

  it('shows it in the switcher rows by the same rule', async () => {
    installAtelierMock();
    renderSwitcher(VERSIONED);

    fireEvent.click(screen.getByRole('button', { name: /^Connection: / }));
    const listbox = await screen.findByRole('listbox', { name: 'Connections' });
    expect(within(listbox).getByText('v7.0.5')).toBeTruthy();
    expect(within(listbox).queryByText('v6.0.1')).toBeNull();
    expect(within(listbox).getAllByText(/^v\d/)).toHaveLength(1);
  });
});
