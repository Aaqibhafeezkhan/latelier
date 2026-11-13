import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import type { ConnectionSummary } from '@shared/types';
import { installAtelierMock, multiConnectionMock, uninstallAtelierMock } from '../helpers/atelierMock';

/**
 * X16.5, spec §4.7 — the pane of a tab whose Connection is not
 * connected shows a not-connected state with a Connect action, never the
 * result grid off whatever the tab's cache still holds. `query.find` is
 * spied in every test here as the discriminator: a bug that renders the grid
 * anyway would also fire a fetch for it, which is exactly the stale-data risk
 * the ticket exists to close.
 */

function mountDormantTab(connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }))) {
  const find = vi.fn(async () => ({ documents: [], durationMs: 0, hasMore: false }));
  installAtelierMock({
    ...multiConnectionMock({
      connections: [{ id: 'c1', name: 'Prod', status: 'disconnected' }],
      tabs: [{ id: 't1', connectionId: 'c1', dbName: 'shop', collection: 'orders', isActive: true }],
    }),
    mongo: { connect },
    query: { find },
  });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
  return { connect, find };
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('the pane of a Dormant tab shows not-connected + Connect, not the grid', () => {
  it('shows a not-connected state instead of the result grid', async () => {
    const { find } = mountDormantTab();

    await waitFor(() => expect(screen.getByText(/is not connected/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    // No CollectionHeader / result grid mounted for this tab.
    expect(screen.queryByLabelText('Insert document')).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });

  it('clicking Connect connects that tab\'s Connection', async () => {
    const { connect } = mountDormantTab();
    await screen.findByRole('button', { name: 'Connect' });

    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(connect).toHaveBeenCalledWith('c1'));
  });

  it('renders the grid normally once the Connection is connected', async () => {
    const find = vi.fn(async () => ({ documents: [], durationMs: 0, hasMore: false }));
    installAtelierMock({
      ...multiConnectionMock({
        connections: [{ id: 'c1', name: 'Prod', status: 'connected' }],
        tabs: [{ id: 't1', connectionId: 'c1', dbName: 'shop', collection: 'orders', isActive: true }],
      }),
      query: { find },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText('Insert document')).toBeTruthy();
    expect(screen.queryByText(/is not connected/i)).toBeNull();
  });
});

/**
 * the guard runs before the tab-kind branch, so a script tab on a
 * Dormant Connection gets the same placeholder a collection tab does. Before
 * the fix `activeScript` was checked first and `<ScriptTab>` rendered as if
 * the Connection were live.
 */
function mountScriptTab(status: ConnectionSummary['status']) {
  installAtelierMock({
    ...multiConnectionMock({
      connections: [{ id: 'c1', name: 'Prod', status }],
      tabs: [
        {
          id: 't1',
          kind: 'script',
          connectionId: 'c1',
          dbName: '',
          collection: '',
          isActive: true,
          state: { title: 'My script', source: '1 + 2', maxTimeMs: 60_000 },
        },
      ],
    }),
  });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
}

describe('the pane of a Dormant script tab shows not-connected + Connect', () => {
  it('renders the placeholder instead of the script editor', async () => {
    mountScriptTab('disconnected');

    await waitFor(() => expect(screen.getByText(/is not connected/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    // No ScriptTab chrome: neither the title input nor the Run button.
    expect(screen.queryByDisplayValue('My script')).toBeNull();
    expect(screen.queryByTestId('script-run-btn')).toBeNull();
  });

  it('renders the script editor normally when the Connection is connected', async () => {
    mountScriptTab('connected');

    expect(await screen.findByDisplayValue('My script')).toBeTruthy();
    expect(screen.queryByText(/is not connected/i)).toBeNull();
  });
});
