import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import NewConnection from '../../src/pages/NewConnection';
import { TroubleshootingProvider } from '../../src/troubleshooting/TroubleshootingProvider';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

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

describe('NewConnection — troubleshooting trigger', () => {
  it('shows the help button after a failed Test and opens the matching recipe', async () => {
    installAtelierMock({
      conn: {
        list: async () => [],
        get: async () => { throw new Error('unused'); },
        create: async () => { throw new Error('unused'); },
        update: async () => { throw new Error('unused'); },
        delete: async () => ({ id: 'x' }),
        touchUsed: async () => ({ id: 'x' }),
        parseUri: async () => { throw new Error('unused'); },
        test: async () => ({
          ok: false,
          errorCode: 'TIMEOUT',
          errorMessage: 'connect ECONNRESET 127.0.0.1:27017',
        }),
      },
    });

    renderNew();

    // Fill the minimum required fields and click Test.
    const name = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(name, 'My Conn');
    await userEvent.click(screen.getByText('Test connection'));

    // Help link appears next to the failure pill.
    const help = await screen.findByText(/Help me fix this/);
    await userEvent.click(help);

    // Drawer opens with the docker-tls recipe.
    await waitFor(() =>
      expect(screen.getByText("Server doesn't speak TLS on this port")).toBeTruthy(),
    );
  });

  it('does not show the help button when the test succeeds', async () => {
    installAtelierMock({
      conn: {
        list: async () => [],
        get: async () => { throw new Error('unused'); },
        create: async () => { throw new Error('unused'); },
        update: async () => { throw new Error('unused'); },
        delete: async () => ({ id: 'x' }),
        touchUsed: async () => ({ id: 'x' }),
        parseUri: async () => { throw new Error('unused'); },
        test: async () => ({ ok: true, serverVersion: '7.0.0', topology: 'Single' }),
      },
    });
    renderNew();
    const name = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(name, 'My Conn');
    await userEvent.click(screen.getByText('Test connection'));

    await waitFor(() => expect(screen.getByText(/Connection successful/)).toBeTruthy());
    expect(screen.queryByText(/Help me fix this/)).toBeNull();
  });
});
