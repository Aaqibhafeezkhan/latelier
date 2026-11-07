import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { ConnectionFormModal } from '../../src/features/connections/ConnectionFormModal';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { Connection } from '@shared/types';

const CANNED_CONNECTION: Connection = {
  id: 'c1',
  name: 'Stored',
  color: '#1A6835',
  connectionType: 'standard',
  readOnly: false,
  host: 'cluster.example.com',
  port: 27017,
  authMech: 'scram256',
  authUsername: 'alice',
  authDatabase: 'admin',
  tls: { enabled: true, verify: true },
  advanced: {
    connectTimeoutMs: 10_000,
    socketTimeoutMs: 30_000,
    serverSelectionTimeoutMs: 30_000,
    readPreference: 'primary',
    maxPoolSize: 100,
    directConnection: false,
  },
  hasPasswordStored: true,
  hasSshPasswordStored: false,
  hasSshPassphraseStored: false,
  createdAt: '2026-04-20T00:00:00Z',
  updatedAt: '2026-04-20T00:00:00Z',
};

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('ConnectionFormModal', () => {
  it('renders "New Connection" as a dialog and hosts the create form', async () => {
    installAtelierMock({});
    render(<ConnectionFormModal onSaved={vi.fn()} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'New Connection' });
    expect(within(dialog).getByPlaceholderText(/My MongoDB Server/i)).toBeTruthy();
  });

  it('renders "Edit Connection" and hydrates from conn.get for an existing id', async () => {
    installAtelierMock({ conn: { get: async () => CANNED_CONNECTION } });
    render(<ConnectionFormModal connectionId="c1" onSaved={vi.fn()} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'Edit Connection' });
    await waitFor(() => {
      expect((within(dialog).getByPlaceholderText(/My MongoDB Server/i) as HTMLInputElement).value).toBe(
        'Stored',
      );
    });
  });

  it('initialFocus="password" opens on the Auth tab with the password field focused (#396)', async () => {
    installAtelierMock({ conn: { get: async () => CANNED_CONNECTION } });
    render(
      <ConnectionFormModal connectionId="c1" initialFocus="password" onSaved={vi.fn()} onClose={vi.fn()} />,
    );

    const dialog = await screen.findByRole('dialog', { name: 'Edit Connection' });
    await waitFor(() => {
      const password = within(dialog).getByPlaceholderText(/stored — enter new to replace/);
      expect(document.activeElement).toBe(password);
    });
  });

  it('without initialFocus the form still opens on General', async () => {
    installAtelierMock({ conn: { get: async () => CANNED_CONNECTION } });
    render(<ConnectionFormModal connectionId="c1" onSaved={vi.fn()} onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'Edit Connection' });
    await waitFor(() => within(dialog).getByPlaceholderText(/My MongoDB Server/i));
    expect(within(dialog).queryByPlaceholderText(/stored — enter new to replace/)).toBeNull();
  });

  it('opens on the Name field, not on Close, in create mode and after an edit-mode load', async () => {
    installAtelierMock({ conn: { get: async () => CANNED_CONNECTION } });
    const created = render(<ConnectionFormModal onSaved={vi.fn()} onClose={vi.fn()} />);
    let dialog = await screen.findByRole('dialog', { name: 'New Connection' });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByPlaceholderText(/My MongoDB Server/i)));
    created.unmount();

    render(<ConnectionFormModal connectionId="c1" onSaved={vi.fn()} onClose={vi.fn()} />);
    dialog = await screen.findByRole('dialog', { name: 'Edit Connection' });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByPlaceholderText(/My MongoDB Server/i)));
  });

  it('coming back to General never pulls focus off the tab strip', async () => {
    installAtelierMock({});
    render(<ConnectionFormModal onSaved={vi.fn()} onClose={vi.fn()} />);
    const dialog = await screen.findByRole('dialog', { name: 'New Connection' });
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Auth' }));
    const general = within(dialog).getByRole('tab', { name: 'General' });
    await userEvent.click(general);
    expect(document.activeElement).toBe(general);
  });

  it('holds one dialog height on every tab, so Save does not move', async () => {
    installAtelierMock({});
    render(<ConnectionFormModal onSaved={vi.fn()} onClose={vi.fn()} />);
    const dialog = await screen.findByRole('dialog', { name: 'New Connection' });
    const heights = new Set<string>();
    for (const name of ['General', 'Auth', 'TLS', 'SSH', 'Advanced']) {
      await userEvent.click(within(dialog).getByRole('tab', { name }));
      heights.add(dialog.style.height);
    }
    expect([...heights]).toHaveLength(1);
    expect([...heights][0]).toContain('654px');
  });

  it('create mode: saving calls conn.create and onSaved with the new id — does not call onClose itself', async () => {
    const createSpy = vi.fn(async () => ({ id: 'new-id' }) as never);
    installAtelierMock({ conn: { create: createSpy as never } });
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<ConnectionFormModal onSaved={onSaved} onClose={onClose} />);

    const nameInput = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(nameInput, 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    await userEvent.click(screen.getByText('Auth'));
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'none');

    fireEvent.click(screen.getByText(/^Save$/));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('new-id'));
    // Whether the modal closes on save is the host's call (Workspace closes it
    // in `handleConnectionSaved`) — this component must not assume that for
    // its caller.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Cancel calls onClose without saving', async () => {
    installAtelierMock({});
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<ConnectionFormModal onSaved={onSaved} onClose={onClose} />);

    await screen.findByPlaceholderText(/My MongoDB Server/i);
    fireEvent.click(screen.getByText(/^Cancel$/));

    expect(onClose).toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('the plaintext-fallback modal opens, is reachable, and a confirm retries the save', async () => {
    let callCount = 0;
    const createSpy = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) throw { code: 'SECRETS_UNAVAILABLE', message: 'OS keychain not accessible' };
      return { id: 'c1' } as never;
    });
    const setSpy = vi.fn(async (enabled: boolean) => ({ enabled }));
    installAtelierMock({
      conn: { create: createSpy as never },
      secrets: { setPlaintextFallback: setSpy },
    });
    render(<ConnectionFormModal onSaved={vi.fn()} onClose={vi.fn()} />);

    const modalNameInput = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(modalNameInput, 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    await userEvent.click(screen.getByText('Auth'));
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'scram256');
    await userEvent.type(screen.getAllByPlaceholderText('admin')[0]!, 'alice');
    await userEvent.type(await screen.findByPlaceholderText(/^••••••••$/), 'pw');

    fireEvent.click(screen.getByText(/^Save$/));

    // Nested inside the outer Mantine `Modal` — the acceptance criterion is
    // that it's still reachable and clickable there, not just present.
    const fallbackModal = await screen.findByTestId('plaintext-fallback-modal');
    fireEvent.click(within(fallbackModal).getByText(/Store as plaintext/i));

    await waitFor(() => expect(setSpy).toHaveBeenCalledWith(true));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(2));
  });

  it('a VALIDATION error still jumps to the offending tab inside the modal', async () => {
    const createSpy = vi.fn(async () => {
      throw {
        code: 'VALIDATION',
        message: 'password: required',
        details: { issues: [{ path: ['password'], message: 'Password is required for SCRAM authentication' }] },
      };
    });
    installAtelierMock({ conn: { create: createSpy as never } });
    render(<ConnectionFormModal onSaved={vi.fn()} onClose={vi.fn()} />);

    const nameInput = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(nameInput, 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    expect(screen.queryByText(/Password is required/i)).toBeNull();

    fireEvent.click(screen.getByText(/^Save$/));

    await waitFor(() => expect(screen.getByText(/Password is required/i)).toBeTruthy());
  });

  it('⌘↵ / ⌘S inside the modal do not leak to a window shortcut listener mounted underneath', async () => {
    // Regression: hosting `ConnectionForm` in a modal over the Data
    // View means its own ⌘↵/⌘S `window` listener (test probe / save) can now
    // coexist with other window-level shortcut listeners already mounted
    // there — e.g. `AggregationTab`'s ⌘↵, which never checks
    // `defaultPrevented`. Simulate that listener directly on `window`, the
    // same way `connection-switcher.spec.tsx` asserts the Switcher's own key
    // ownership, and confirm it never fires while the modal owns the key.
    const testSpy = vi.fn(async () => ({ ok: true, serverVersion: '7.0.0', roundTripMs: 5 }));
    installAtelierMock({ conn: { test: testSpy } });
    const outsideHandler = vi.fn();
    window.addEventListener('keydown', outsideHandler);
    try {
      render(<ConnectionFormModal onSaved={vi.fn()} onClose={vi.fn()} />);
      await screen.findByPlaceholderText(/My MongoDB Server/i);

      fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
      await waitFor(() => expect(testSpy).toHaveBeenCalled());
      expect(outsideHandler).not.toHaveBeenCalled();

      outsideHandler.mockClear();
      fireEvent.keyDown(window, { key: 's', metaKey: true });
      expect(outsideHandler).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', outsideHandler);
    }
  });
});
