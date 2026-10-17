import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import NewConnection from '../../src/pages/NewConnection';
import { TroubleshootingProvider } from '../../src/troubleshooting/TroubleshootingProvider';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { ConnectionInput, ProbeResult } from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function renderNew() {
  return render(
      <TroubleshootingProvider>
        <RouterProvider
          router={createMemoryRouter([{ path: '/connections/new', element: <NewConnection /> }], {
            initialEntries: ['/connections/new'],
          })}
        />
      </TroubleshootingProvider>
  );
}

describe('NewConnection — Retry with Direct connection', () => {
  it('flips advanced.directConnection on, re-tests, and closes the drawer on success', async () => {
    const probeCalls: Array<{ direct: boolean }> = [];
    installAtelierMock({
      conn: {
        list: async () => [],
        get: async () => { throw new Error('unused'); },
        create: async () => { throw new Error('unused'); },
        update: async () => { throw new Error('unused'); },
        delete: async () => ({ id: 'x' }),
        touchUsed: async () => ({ id: 'x' }),
        parseUri: async () => { throw new Error('unused'); },
        test: async (input: ConnectionInput): Promise<ProbeResult> => {
          probeCalls.push({ direct: input.advanced.directConnection });
          if (!input.advanced.directConnection) {
            return {
              ok: false,
              errorCode: 'TIMEOUT',
              errorMessage: 'getaddrinfo ENOTFOUND mongo-primary-7f3a9c1d',
            };
          }
          return { ok: true, serverVersion: '7.0.0', topology: 'Single' };
        },
      },
    });

    renderNew();
    await userEvent.type(
      await screen.findByPlaceholderText(/My MongoDB Server/i),
      'My Conn',
    );
    await userEvent.click(screen.getByText('Test connection'));

    await userEvent.click(await screen.findByText(/Help me fix this/));
    const retry = await screen.findByText(/Retry with Direct connection/);
    await userEvent.click(retry);

    await waitFor(() => expect(probeCalls.length).toBe(2));
    expect(probeCalls[0]!.direct).toBe(false);
    expect(probeCalls[1]!.direct).toBe(true);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText(/Connection successful/)).toBeTruthy();
  });
});
