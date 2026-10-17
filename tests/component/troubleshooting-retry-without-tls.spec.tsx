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

describe('NewConnection — Retry without TLS', () => {
  it('flips tlsEnabled, re-tests, and closes the drawer on success', async () => {
    const probeCalls: Array<{ tlsEnabled: boolean }> = [];
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
          probeCalls.push({ tlsEnabled: input.tls.enabled });
          if (input.tls.enabled) {
            return {
              ok: false,
              errorCode: 'TIMEOUT',
              errorMessage: 'connect ECONNRESET 127.0.0.1:27017',
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

    // Drawer open via the failure-pill help link.
    await userEvent.click(await screen.findByText(/Help me fix this/));
    const retry = await screen.findByText(/Retry without TLS/);
    await userEvent.click(retry);

    // Probe was called twice, the second time with tls.enabled=false.
    await waitFor(() => expect(probeCalls.length).toBe(2));
    expect(probeCalls[0]!.tlsEnabled).toBe(true);
    expect(probeCalls[1]!.tlsEnabled).toBe(false);

    // Drawer auto-closed and the success pill is visible.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText(/Connection successful/)).toBeTruthy();
  });

  it('keeps the drawer open when the second test still fails', async () => {
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
          if (input.tls.enabled) {
            return {
              ok: false,
              errorCode: 'TIMEOUT',
              errorMessage: 'connect ECONNRESET 127.0.0.1:27017',
            };
          }
          // Second call: TLS off, but now AUTH fails.
          return { ok: false, errorCode: 'AUTH', errorMessage: 'auth failed' };
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
    const retry = await screen.findByText(/Retry without TLS/);
    await userEvent.click(retry);

    // Drawer still open with the original recipe.
    await waitFor(() =>
      expect(screen.getByText("Server doesn't speak TLS on this port")).toBeTruthy(),
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    // Failure pill reflects the new outcome.
    expect(screen.getByText(/Authentication failed/)).toBeTruthy();
  });
});
