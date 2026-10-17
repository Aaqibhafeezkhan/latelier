import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom';
import NewConnection from '../../src/pages/NewConnection';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { Connection } from '@shared/types';

// `NewConnection` blocks navigation while dirty, which needs a data router.
function renderNew(initial = '/connections/new', id?: string) {
  const router = createMemoryRouter(
    [
      { path: '/workspace', element: <div>workspace-route</div> },
      { path: '/connections/:id', element: <div>detail-route</div> },
      { path: '/connections/new', element: <NewConnection /> },
      {
        path: id ? '/connections/:id/edit' : '/connections/xxx/edit',
        element: <NewConnection />,
      },
    ],
    { initialEntries: [initial] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

/**
 * Same shape as `renderNew`, but the `/workspace` destination captures its
 * `location.state` instead of rendering a bare marker — for asserting on
 * `openConnectionId`, the nav-state intent Workspace.tsx uses to connect a
 * Connection (see `NewConnection.tsx`'s `onSaved`).
 */
function renderNewCapturingWorkspaceState(initial: Array<string | { pathname: string; state?: unknown }>) {
  const captured: { state: unknown } = { state: 'not-navigated' };
  function WorkspaceProbe() {
    captured.state = useLocation().state;
    return <div>workspace-route</div>;
  }
  const router = createMemoryRouter(
    [
      { path: '/workspace', element: <WorkspaceProbe /> },
      { path: '/connections/:id', element: <div>detail-route</div> },
      { path: '/connections/new', element: <NewConnection /> },
      { path: '/connections/:id/edit', element: <NewConnection /> },
    ],
    { initialEntries: initial },
  );
  render(<RouterProvider router={router} />);
  return captured;
}

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

describe('NewConnection (create mode)', () => {
  it('renders the form with required fields', async () => {
    installAtelierMock({});
    renderNew();
    expect(await screen.findByPlaceholderText(/My MongoDB Server/i)).toBeTruthy();
  });

  it('pasting a URI applies parsed fields', async () => {
    installAtelierMock({
      conn: {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        parseUri: async (_uri: string) => ({
          input: {
            connectionType: 'standard',
            host: 'db.example.com',
            port: 27017,
            defaultDb: 'mydb',
            authMech: 'scram256',
            authUsername: 'alice',
            password: 'pw',
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
          },
          warnings: [],
        }),
      },
    });
    renderNew();
    // Switch to Paste URI mode
    await userEvent.click(await screen.findByText(/Paste URI/i));
    const uriInput = screen.getByPlaceholderText(/mongodb\+srv/i) as HTMLInputElement;
    await userEvent.type(uriInput, 'mongodb://alice:pw@db.example.com/mydb');
    await userEvent.click(screen.getByText('Apply'));
    // URI applied message should appear.
    await waitFor(() => {
      expect(screen.getByText(/URI applied/i)).toBeTruthy();
    });
  });

  async function pasteWith(
    input: Record<string, unknown>,
    warnings: Array<{ code: string; detail?: string }>,
    repick?: string[],
  ) {
    installAtelierMock({
      conn: { parseUri: (async () => ({ input, warnings, repick })) as never },
    });
    renderNew();
    await userEvent.click(await screen.findByText(/Paste URI/i));
    await userEvent.type(screen.getByPlaceholderText(/mongodb\+srv/i), 'mongodb://db.example.com/');
    await userEvent.click(screen.getByText('Apply'));
  }

  it('pasting a URI that turns verification off says so in the toast and on the TLS tab', async () => {
    await pasteWith(
      { host: 'db.example.com', tls: { enabled: true, verify: false } },
      [{ code: 'TLS_VERIFY_DISABLED', detail: 'Certificate verification is turned off: anyone on the network path can impersonate this server' }],
    );
    expect((await screen.findByRole('status')).textContent).toMatch(/1 warning: Certificate verification is turned off/);
    await userEvent.click(screen.getByRole('tab', { name: 'TLS' }));
    expect((await screen.findByTestId('tls-warning')).textContent).toMatch(/impersonate/);
  });

  it('pasting a URI with a dropped TLS option lists it in the toast', async () => {
    await pasteWith(
      { host: 'db.example.com', tls: { enabled: true, verify: true } },
      [{ code: 'OPTION_DROPPED', detail: 'tlsinsecure' }],
    );
    expect((await screen.findByRole('status')).textContent).toMatch(/1 warning: tlsinsecure/);
  });

  it('pasting a URI that names credential files tells the user to pick them again and leaves the fields empty', async () => {
    await pasteWith(
      { host: 'db.example.com', tls: { enabled: true, verify: true } },
      [],
      ['tlsCa', 'tlsClientCert'],
    );
    const text = (await screen.findByRole('status')).textContent;
    expect(text).toMatch(/URI applied\./);
    expect(text).toMatch(/re-pick CA file, re-pick client certificate/);
    await userEvent.click(screen.getByRole('tab', { name: 'TLS' }));
    for (const box of screen.getAllByRole('textbox')) expect((box as HTMLInputElement).value).not.toMatch(/\.pem/);
  });

  it('adds the re-pick note after the warnings, and nothing when no file is named', async () => {
    await pasteWith({ host: 'h' }, [{ code: 'PROXY_DROPPED', detail: 'Proxy options in the string were not imported.' }], ['tlsCa']);
    expect((await screen.findByRole('status')).textContent).toBe(
      'URI applied. 1 warning: Proxy options in the string were not imported. Still to do: re-pick CA file.',
    );
  });

  it('a plain paste keeps the plain toast', async () => {
    await pasteWith({ host: 'h' }, [], []);
    expect((await screen.findByRole('status')).textContent).toBe('URI applied.');
  });

  it('Test button calls api.conn.test and shows ok state', async () => {
    const testSpy = vi.fn(async () => ({ ok: true, serverVersion: '7.0.0', roundTripMs: 12 }));
    installAtelierMock({ conn: { test: testSpy } });
    renderNew();
    const input = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(input, 'X');
    // Fill host
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    fireEvent.click(screen.getByText(/Test connection/));
    await waitFor(() => expect(testSpy).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => {
      expect(screen.getByText(/Connection successful/i)).toBeTruthy();
    });
  });

  it('surfaces VALIDATION errors as field errors and switches to the right tab', async () => {
    const createSpy = vi.fn(async () => {
      throw {
        code: 'VALIDATION',
        message: 'password: required',
        details: { issues: [{ path: ['password'], message: 'Password is required for SCRAM authentication' }] },
      };
    });
    installAtelierMock({ conn: { create: createSpy as never } });
    renderNew();
    const nameInput = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(nameInput, 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    // Switch to Auth tab to supply a username so client-side form is otherwise populated.
    await userEvent.click(screen.getByText('Auth'));
    const usernameInput = screen.getAllByPlaceholderText('admin')[0]!;
    await userEvent.type(usernameInput, 'alice');
    // Save
    fireEvent.click(screen.getByText(/^Save$/));
    await waitFor(() => {
      expect(screen.getByText(/Password is required/i)).toBeTruthy();
    });
  });

  it('SECRETS_UNAVAILABLE opens the plaintext-fallback modal and confirming retries the save', async () => {
    let callCount = 0;
    const createSpy = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw { code: 'SECRETS_UNAVAILABLE', message: 'OS keychain not accessible' };
      }
      return { id: 'c1' } as never;
    });
    const setSpy = vi.fn(async (enabled: boolean) => ({ enabled }));
    installAtelierMock({
      conn: { create: createSpy as never },
      secrets: { setPlaintextFallback: setSpy },
    });

    renderNew();
    const nameInput = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(nameInput, 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    await userEvent.click(screen.getByText('Auth'));
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'scram256');
    const usernameInput = screen.getAllByPlaceholderText('admin')[0]!;
    await userEvent.type(usernameInput, 'alice');
    const passwordInput = await screen.findByPlaceholderText(/^••••••••$/);
    await userEvent.type(passwordInput, 'pw');

    fireEvent.click(screen.getByText(/^Save$/));

    // First save throws SECRETS_UNAVAILABLE → modal appears.
    const modal = await screen.findByTestId('plaintext-fallback-modal');
    expect(modal).toBeTruthy();
    expect(screen.getByText(/Not recommended/i)).toBeTruthy();

    // Confirming sets the pref and re-saves.
    fireEvent.click(screen.getByText(/Store as plaintext/i));

    await waitFor(() => {
      expect(setSpy).toHaveBeenCalledWith(true);
    });
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(2);
    });
  });

  it('cancelling the plaintext-fallback modal leaves the form open with no retry', async () => {
    const createSpy = vi.fn(async () => {
      throw { code: 'SECRETS_UNAVAILABLE', message: 'OS keychain not accessible' };
    });
    const setSpy = vi.fn(async (enabled: boolean) => ({ enabled }));
    installAtelierMock({
      conn: { create: createSpy as never },
      secrets: { setPlaintextFallback: setSpy },
    });

    renderNew();
    const nameInput = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(nameInput, 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    await userEvent.click(screen.getByText('Auth'));
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'scram256');
    await userEvent.type(screen.getAllByPlaceholderText('admin')[0]!, 'alice');
    await userEvent.type(await screen.findByPlaceholderText(/^••••••••$/), 'pw');
    fireEvent.click(screen.getByText(/^Save$/));

    const modal = await screen.findByTestId('plaintext-fallback-modal');
    const { getByText: getInModal } = within(modal);
    fireEvent.click(getInModal(/^Cancel$/));

    await waitFor(() => {
      expect(screen.queryByTestId('plaintext-fallback-modal')).toBeNull();
    });
    expect(setSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('a cancelled main-process confirmation closes the modal without retrying the save', async () => {
    const createSpy = vi.fn(async () => {
      throw { code: 'SECRETS_UNAVAILABLE', message: 'OS keychain not accessible' };
    });
    // Main answers a declined dialog with the value still in force: disabled.
    const setSpy = vi.fn(async () => ({ enabled: false }));
    installAtelierMock({
      conn: { create: createSpy as never },
      secrets: { setPlaintextFallback: setSpy },
    });

    renderNew();
    await userEvent.type(await screen.findByPlaceholderText(/My MongoDB Server/i), 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    await userEvent.click(screen.getByText('Auth'));
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'scram256');
    await userEvent.type(screen.getAllByPlaceholderText('admin')[0]!, 'alice');
    await userEvent.type(await screen.findByPlaceholderText(/^••••••••$/), 'pw');
    fireEvent.click(screen.getByText(/^Save$/));

    const modal = await screen.findByTestId('plaintext-fallback-modal');
    fireEvent.click(within(modal).getByText(/Store as plaintext/i));

    await waitFor(() => expect(setSpy).toHaveBeenCalledWith(true));
    await waitFor(() => {
      expect(screen.queryByTestId('plaintext-fallback-modal')).toBeNull();
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('plaintext-fallback-banner')).toBeNull();
  });

  it('renders the plaintext-fallback banner when the pref is on and disables it on click', async () => {
    const setSpy = vi.fn(async (enabled: boolean) => ({ enabled }));
    installAtelierMock({
      prefs: {
        get: async (k: string) =>
          k === 'secrets.allowPlaintextFallback' ? true : null,
      } as never,
      secrets: { setPlaintextFallback: setSpy },
    });
    renderNew();
    const banner = await screen.findByTestId('plaintext-fallback-banner');
    expect(banner.textContent).toMatch(/Plaintext password storage is enabled/i);

    fireEvent.click(screen.getByText(/^Disable$/));
    await waitFor(() => {
      expect(setSpy).toHaveBeenCalledWith(false);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('plaintext-fallback-banner')).toBeNull();
    });
  });

  it('double-activating Save before the create promise resolves only submits once', async () => {
    let resolveCreate: ((value: { id: string }) => void) | undefined;
    const createSpy = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    installAtelierMock({ conn: { create: createSpy as never } });
    renderNew();
    const nameInput = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(nameInput, 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    await userEvent.click(screen.getByText('Auth'));
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'none');

    const saveButton = screen.getByText(/^Save$/);
    // Double-click before the pending create() resolves.
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    resolveCreate?.({ id: 'c1' });

    await waitFor(() => {
      expect(screen.getByText('workspace-route')).toBeTruthy();
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('a ⌘S keyboard save cannot double-submit while a save is already in flight', async () => {
    let resolveCreate: ((value: { id: string }) => void) | undefined;
    const createSpy = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    installAtelierMock({ conn: { create: createSpy as never } });
    renderNew();
    const nameInput = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(nameInput, 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    await userEvent.click(screen.getByText('Auth'));
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'none');

    // First submit via button click leaves create() pending (in flight).
    fireEvent.click(screen.getByText(/^Save$/));
    await waitFor(() => expect(createSpy).toHaveBeenCalled());

    // A ⌘S / Ctrl+S while the first save is in flight must NOT start a second
    // create. The keydown listener closes over a stale `saving` value, so only
    // the savingRef guard inside handleSave prevents this re-entry.
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    resolveCreate?.({ id: 'c1' });
    await waitFor(() => {
      expect(screen.getByText('workspace-route')).toBeTruthy();
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces CONFLICT as a banner', async () => {
    const createSpy = vi.fn(async () => {
      throw { code: 'CONFLICT', message: "connection name 'Dup' already exists" };
    });
    installAtelierMock({ conn: { create: createSpy as never } });
    renderNew();
    const nameInput = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(nameInput, 'Dup');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    await userEvent.click(screen.getByText('Auth'));
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'none');
    fireEvent.click(screen.getByText(/^Save$/));
    await waitFor(() => {
      expect(screen.getByText(/already exists/i)).toBeTruthy();
    });
  });

  it('opens the newly created Connection via openConnectionId nav state (⌘N / full-page route)', async () => {
    // Regression: this route used to discard the id `ConnectionForm.onSaved`
    // passes it, so a Connection created here (reachable via GlobalCommands'
    // always-on ⌘N) was never connected — unlike the Switcher's
    // "+ Add connection" modal, which connects it through
    // `handleConnectionSaved` (Workspace.tsx). `openConnectionId` is the same
    // route-intent Workspace already handles for the command palette's
    // "Open connection" action.
    const createSpy = vi.fn(async () => ({ id: 'new-c1' }));
    installAtelierMock({ conn: { create: createSpy as never } });
    const captured = renderNewCapturingWorkspaceState(['/connections/new']);

    const nameInput = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(nameInput, 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    await userEvent.click(screen.getByText('Auth'));
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'none');
    fireEvent.click(screen.getByText(/^Save$/));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('workspace-route')).toBeTruthy());
    expect(captured.state).toEqual({ openConnectionId: 'new-c1' });
  });
});

describe('NewConnection (edit mode)', () => {
  it('preloads from conn.get and shows stored-password placeholder', async () => {
    installAtelierMock({
      conn: {
        get: async () => CANNED_CONNECTION,
      },
    });
    renderNew('/connections/c1/edit', 'c1');
    await waitFor(() => {
      expect((screen.getByPlaceholderText(/My MongoDB Server/i) as HTMLInputElement).value).toBe('Stored');
    });
    // Switch to Auth tab — password field should show stored placeholder.
    await userEvent.click(screen.getByText('Auth'));
    expect(screen.getByPlaceholderText(/stored — enter new to replace/i)).toBeTruthy();
  });

  it('Remove stored password flips clearPassword to true', async () => {
    const updateSpy = vi.fn(async (_id: string, patch: unknown) => ({
      ...CANNED_CONNECTION, hasPasswordStored: false, updatedAt: '2026-04-20T00:00:00Z',
      _capturedPatch: patch,
    } as unknown as Connection));
    installAtelierMock({
      conn: {
        get: async () => CANNED_CONNECTION,
        update: updateSpy,
      },
    });
    renderNew('/connections/c1/edit', 'c1');
    await waitFor(() => {
      expect((screen.getByPlaceholderText(/My MongoDB Server/i) as HTMLInputElement).value).toBe('Stored');
    });
    await userEvent.click(screen.getByText('Auth'));
    fireEvent.click(screen.getByText(/Remove stored password/i));
    expect(screen.getByText(/Will be removed on save/i)).toBeTruthy();
    fireEvent.click(screen.getByText(/Save changes/i));
    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    const patch = updateSpy.mock.calls[0]?.[1] as { clearPassword?: boolean };
    expect(patch.clearPassword).toBe(true);
  });

  it('does not set openConnectionId nav state on save — editing must never connect a Connection', async () => {
    const updateSpy = vi.fn(async () => ({ ...CANNED_CONNECTION, updatedAt: '2026-04-21T00:00:00Z' }));
    installAtelierMock({
      conn: {
        get: async () => CANNED_CONNECTION,
        update: updateSpy,
      },
    });
    const captured = renderNewCapturingWorkspaceState([
      { pathname: '/connections/c1/edit', state: { returnTo: '/workspace' } },
    ]);

    await waitFor(() => {
      expect((screen.getByPlaceholderText(/My MongoDB Server/i) as HTMLInputElement).value).toBe('Stored');
    });
    fireEvent.click(screen.getByText(/Save changes/i));

    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('workspace-route')).toBeTruthy());
    // react-router normalizes a `state: undefined` navigate() to `null`.
    expect(captured.state).toBeFalsy();
  });
});

describe('NewConnection (unsaved-changes guard)', () => {
  const discardPrompt = () => screen.queryByRole('dialog', { name: 'Discard changes?' });

  async function dirtyForm() {
    installAtelierMock({});
    const mounted = renderNew();
    const name = (await screen.findByPlaceholderText(/My MongoDB Server/i)) as HTMLInputElement;
    await userEvent.type(name, 'Half typed');
    return { ...mounted, name };
  }

  it('the back link asks before leaving a dirty form, and stays put', async () => {
    const { router } = await dirtyForm();
    fireEvent.click(screen.getByRole('button', { name: 'Data View' }));
    expect(await screen.findByRole('dialog', { name: 'Discard changes?' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/connections/new');
  });

  it('Keep editing stays on the form with what was typed', async () => {
    const { router, name } = await dirtyForm();
    fireEvent.click(screen.getByRole('button', { name: 'Data View' }));
    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(discardPrompt()).toBeNull());
    expect(router.state.location.pathname).toBe('/connections/new');
    expect(name.value).toBe('Half typed');
    // The block was released, so the next attempt to leave is caught again.
    fireEvent.click(screen.getByRole('button', { name: 'Data View' }));
    expect(await screen.findByRole('dialog', { name: 'Discard changes?' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/connections/new');
  });

  it('Discard leaves the form', async () => {
    const { router } = await dirtyForm();
    fireEvent.click(screen.getByRole('button', { name: 'Data View' }));
    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspace'));
    expect(screen.getByText('workspace-route')).toBeTruthy();
  });

  it('the Cancel button asks too', async () => {
    const { router } = await dirtyForm();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('dialog', { name: 'Discard changes?' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/connections/new');
  });

  it('a clean form navigates away without a prompt', async () => {
    installAtelierMock({});
    const { router } = renderNew();
    await screen.findByPlaceholderText(/My MongoDB Server/i);
    fireEvent.click(screen.getByRole('button', { name: 'Data View' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspace'));
    expect(discardPrompt()).toBeNull();
  });

  it('a successful save navigates without a prompt', async () => {
    installAtelierMock({ conn: { create: (async () => ({ id: 'c1' })) as never } });
    const { router } = renderNew();
    await userEvent.type(await screen.findByPlaceholderText(/My MongoDB Server/i), 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    await userEvent.click(screen.getByText('Auth'));
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'none');
    fireEvent.click(screen.getByText(/^Save$/));
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspace'));
    expect(discardPrompt()).toBeNull();
  });

  it('leaving after the plaintext-fallback retry save shows no prompt', async () => {
    let calls = 0;
    const createSpy = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw { code: 'SECRETS_UNAVAILABLE', message: 'OS keychain not accessible' };
      return { id: 'c1' } as never;
    });
    installAtelierMock({
      conn: { create: createSpy as never },
      secrets: { setPlaintextFallback: async (enabled: boolean) => ({ enabled }) },
    });
    const { router } = renderNew();
    await userEvent.type(await screen.findByPlaceholderText(/My MongoDB Server/i), 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    await userEvent.click(screen.getByText('Auth'));
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'scram256');
    await userEvent.type(screen.getAllByPlaceholderText('admin')[0]!, 'alice');
    await userEvent.type(await screen.findByPlaceholderText(/^••••••••$/), 'pw');
    fireEvent.click(screen.getByText(/^Save$/));

    fireEvent.click(await screen.findByText(/Store as plaintext/i));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspace'));
    expect(discardPrompt()).toBeNull();
  });

  it('a navigation from elsewhere (the palette) is blocked while dirty', async () => {
    const { router } = await dirtyForm();
    act(() => {
      void router.navigate('/workspace');
    });
    expect(await screen.findByRole('dialog', { name: 'Discard changes?' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/connections/new');
  });
});
