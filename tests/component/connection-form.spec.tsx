import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { ConnectionForm } from '../../src/features/connections/ConnectionForm';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { invalidateSchemaEnumCache } from '../../src/features/fieldSuggestions/sources/schemaEnumSource';
import { invalidateSampleSchemaCache } from '../../src/features/fieldSuggestions/sources/sampleSchemaSource';

// Spied so an edit can be checked for dropping the cached enum and sample suggestions.
vi.mock('../../src/features/fieldSuggestions/sources/sampleSchemaSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/fieldSuggestions/sources/sampleSchemaSource')>()),
  invalidateSampleSchemaCache: vi.fn(),
}));
vi.mock('../../src/features/fieldSuggestions/sources/schemaEnumSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/fieldSuggestions/sources/schemaEnumSource')>()),
  invalidateSchemaEnumCache: vi.fn(),
}));
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
  vi.mocked(invalidateSchemaEnumCache).mockClear();
  vi.mocked(invalidateSampleSchemaCache).mockClear();
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('ConnectionForm (host-agnostic, no router)', () => {
  it('create mode: filling the form and saving calls conn.create then onSaved with the new id, without navigating', async () => {
    const createSpy = vi.fn(async () => ({ id: 'new-id' }) as never);
    installAtelierMock({ conn: { create: createSpy as never } });
    const onSaved = vi.fn();
    const onCancel = vi.fn();
    render(<ConnectionForm mode="create" onSaved={onSaved} onCancel={onCancel} />);

    const nameInput = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(nameInput, 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    await userEvent.click(screen.getByText('Auth'));
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'none');

    fireEvent.click(screen.getByText(/^Save$/));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('new-id'));
    expect(invalidateSchemaEnumCache).not.toHaveBeenCalled();
    expect(invalidateSampleSchemaCache).not.toHaveBeenCalled();
  });

  it('edit mode: connectionId hydrates from conn.get and saving calls conn.update with that id, then onSaved', async () => {
    const updateSpy = vi.fn(async () => ({ ...CANNED_CONNECTION, id: 'c1' }) as never);
    installAtelierMock({
      conn: {
        get: async () => CANNED_CONNECTION,
        update: updateSpy as never,
      },
    });
    const onSaved = vi.fn();
    const onCancel = vi.fn();
    render(<ConnectionForm mode="edit" connectionId="c1" onSaved={onSaved} onCancel={onCancel} />);

    await waitFor(() => {
      expect((screen.getByPlaceholderText(/My MongoDB Server/i) as HTMLInputElement).value).toBe('Stored');
    });

    fireEvent.click(screen.getByText(/Save changes/i));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('c1', expect.anything()));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('c1'));
    // An edit can point the same id at another server, with other validators and fields.
    expect(invalidateSchemaEnumCache).toHaveBeenCalledExactlyOnceWith('c1');
    expect(invalidateSampleSchemaCache).toHaveBeenCalledExactlyOnceWith('c1');
  });

  it('edit mode: a legacy row stored with ssh.enabled loads as off and saves an explicit ssh.enabled=false', async () => {
    const updateSpy = vi.fn(async () => ({ ...CANNED_CONNECTION, id: 'c1' }) as never);
    installAtelierMock({
      conn: {
        get: async () => ({
          ...CANNED_CONNECTION,
          ssh: { enabled: true, host: 'bastion', port: 22, username: 'u' },
        }),
        update: updateSpy as never,
      },
    });
    const onSaved = vi.fn();
    render(<ConnectionForm mode="edit" connectionId="c1" onSaved={onSaved} onCancel={() => {}} />);

    await waitFor(() => {
      expect((screen.getByPlaceholderText(/My MongoDB Server/i) as HTMLInputElement).value).toBe('Stored');
    });

    fireEvent.click(screen.getByText(/Save changes/i));

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ ssh: { enabled: false } }),
      ),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('c1'));
  });

  it('Cancel calls onCancel', async () => {
    installAtelierMock({});
    const onSaved = vi.fn();
    const onCancel = vi.fn();
    render(<ConnectionForm mode="create" onSaved={onSaved} onCancel={onCancel} />);

    await screen.findByPlaceholderText(/My MongoDB Server/i);
    fireEvent.click(screen.getByText(/^Cancel$/));
    expect(onCancel).toHaveBeenCalled();
  });

  // the Safety section's read-only toggle lives on General (the
  // default tab), so no tab navigation is needed to reach it.
  it('create mode: toggling "Read-only connection" on and saving sends readOnly: true to conn.create', async () => {
    const createSpy = vi.fn(async () => ({ id: 'new-id' }) as never);
    installAtelierMock({ conn: { create: createSpy as never } });
    const onSaved = vi.fn();
    render(<ConnectionForm mode="create" onSaved={onSaved} onCancel={() => {}} />);

    const nameInput = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(nameInput, 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');

    await userEvent.click(screen.getByRole('switch', { name: 'Read-only connection' }));

    await userEvent.click(screen.getByText('Auth'));
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'none');

    fireEvent.click(screen.getByText(/^Save$/));

    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true })),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('new-id'));
  });

  // Edit-mode hydration: `conn.get` returns a stored connection with
  // `readOnly: true`; submitting the untouched form must round-trip that
  // value to `conn.update` rather than silently resetting it to false.
  it('edit mode: hydrates readOnly from conn.get and re-submits it unchanged to conn.update', async () => {
    const updateSpy = vi.fn(async () => ({ ...CANNED_CONNECTION, id: 'c1' }) as never);
    installAtelierMock({
      conn: {
        get: async () => ({ ...CANNED_CONNECTION, readOnly: true }),
        update: updateSpy as never,
      },
    });
    const onSaved = vi.fn();
    render(<ConnectionForm mode="edit" connectionId="c1" onSaved={onSaved} onCancel={() => {}} />);

    await waitFor(() => {
      expect((screen.getByPlaceholderText(/My MongoDB Server/i) as HTMLInputElement).value).toBe('Stored');
    });

    fireEvent.click(screen.getByText(/Save changes/i));

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith('c1', expect.objectContaining({ readOnly: true })),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('c1'));
  });

  it('a VALIDATION error from the IPC layer still sets field errors and jumps to the first offending tab', async () => {
    const createSpy = vi.fn(async () => {
      throw {
        code: 'VALIDATION',
        message: 'password: required',
        details: { issues: [{ path: ['password'], message: 'Password is required for SCRAM authentication' }] },
      };
    });
    installAtelierMock({ conn: { create: createSpy as never } });
    const onSaved = vi.fn();
    const onCancel = vi.fn();
    render(<ConnectionForm mode="create" onSaved={onSaved} onCancel={onCancel} />);

    const nameInput = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(nameInput, 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');

    // Stay on General. The offending field (`password`) lives on the Auth tab,
    // so its error text is only reachable if the save handler jumps tabs for us
    // — asserting it from the Auth tab would pass even with the jump removed.
    expect(screen.queryByText(/Password is required/i)).toBeNull();

    fireEvent.click(screen.getByText(/^Save$/));

    await waitFor(() => {
      expect(screen.getByText(/Password is required/i)).toBeTruthy();
    });
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('mode="edit" with no id throws instead of silently falling through to a create', () => {
    expect(() =>
      render(<ConnectionForm mode="edit" connectionId="" onSaved={() => {}} onCancel={() => {}} />),
    ).toThrow('ConnectionForm: mode is "edit" but connectionId is ""');
  });
});

// X59 — the General / Auth / TLS / SSH / Advanced strip was five bare
// <button>s: no role, no aria-selected, no aria-controls, five separate
// tab stops. Modelled on tests/component/drawer-tablist.spec.tsx:83-127,
// which asserts the same shape for BuilderPane's Mantine-Tabs conversion.
describe('X59 — ConnectionForm tab strip is a real tablist', () => {
  function mountForm() {
    installAtelierMock({});
    return render(<ConnectionForm mode="create" onSaved={() => {}} onCancel={() => {}} />);
  }

  it('exposes tablist / tab / aria-selected / aria-controls', async () => {
    mountForm();
    await screen.findByPlaceholderText(/My MongoDB Server/i);

    const list = screen.getByRole('tablist', { name: 'Connection settings' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['General', 'Auth', 'TLS', 'SSH', 'Advanced']);

    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    for (const t of tabs.slice(1)) expect(t.getAttribute('aria-selected')).toBe('false');

    // Each tab points at the panel it governs, and the selected one's panel
    // is really in the document.
    for (const t of tabs) expect(t.getAttribute('aria-controls')).toBeTruthy();
    expect(document.getElementById(tabs[0]!.getAttribute('aria-controls')!)).toBeTruthy();
  });

  it('is a single tab stop: only the selected tab is keyboard-reachable', async () => {
    mountForm();
    await screen.findByPlaceholderText(/My MongoDB Server/i);

    const list = screen.getByRole('tablist', { name: 'Connection settings' });
    const tabs = within(list).getAllByRole('tab');
    // Roving tabindex — exactly one tab participates in the Tab order.
    const reachable = tabs.filter((t) => t.getAttribute('tabindex') !== '-1');
    expect(reachable).toHaveLength(1);
    expect(reachable[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('ArrowRight moves selection to the next tab', async () => {
    mountForm();
    const general = await screen.findByRole('tab', { name: 'General' });
    general.focus();
    fireEvent.keyDown(general, { key: 'ArrowRight' });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Auth' }).getAttribute('aria-selected')).toBe('true');
      expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('false');
    });
  });

  // fireEvent.keyDown proves selection moves; it does no browser focus
  // management, so the focus claim needs userEvent to be trustworthy.
  it('keeps focus on the newly selected tab, never falling back to the body', async () => {
    mountForm();
    const general = await screen.findByRole('tab', { name: 'General' });
    await userEvent.click(general);
    await userEvent.keyboard('{ArrowRight}');

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Auth' }));
    });
    expect(document.activeElement).not.toBe(document.body);
  });

  // keepMounted={false} is the trap: Mantine's Tabs.Panel default keeps
  // every inactive panel in the DOM, which would put all five tabs' fields
  // in the document at once.
  it('does not mount the inactive panels', async () => {
    mountForm();
    await screen.findByPlaceholderText(/My MongoDB Server/i);

    expect(screen.queryByRole('switch', { name: 'Enable TLS / SSL' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'SSH tunnel (coming soon)' })).toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: 'TLS' }));
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Enable TLS / SSL' })).toBeTruthy();
    });
    // Switching away un-mounts General's panel again.
    expect(screen.queryByPlaceholderText(/My MongoDB Server/i)).toBeNull();
  });

  it('switching tabs preserves form state exactly as typing it', async () => {
    mountForm();
    const nameInput = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(nameInput, 'Prod cluster');

    await userEvent.click(screen.getByRole('tab', { name: 'Auth' }));
    await userEvent.click(screen.getByRole('tab', { name: 'General' }));

    await waitFor(() => {
      expect((screen.getByPlaceholderText(/My MongoDB Server/i) as HTMLInputElement).value).toBe(
        'Prod cluster',
      );
    });
  });
});

// The wrapper in ConnectionForm.tsx keys ConnectionFormImpl on connectionId
// specifically to force a remount instead of a reconcile when a host swaps
// targets on an already-mounted instance, since `loading` is only seeded
// once at mount while the hydrate effect re-runs per id. These specs pin
// that remount is actually happening, not just documented in a comment.
describe('ConnectionForm: connectionId swap on a mounted instance', () => {
  it('edit A -> edit B: does not show A\'s hydrated values while B is still loading', async () => {
    let resolveB!: (c: Connection) => void;
    const bPending = new Promise<Connection>((res) => {
      resolveB = res;
    });
    installAtelierMock({
      conn: {
        get: (async (id: string) => (id === 'c1' ? CANNED_CONNECTION : bPending)) as never,
      },
    });
    const onSaved = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConnectionForm mode="edit" connectionId="c1" onSaved={onSaved} onCancel={onCancel} />,
    );

    await waitFor(() => {
      expect((screen.getByPlaceholderText(/My MongoDB Server/i) as HTMLInputElement).value).toBe('Stored');
    });

    rerender(<ConnectionForm mode="edit" connectionId="c2" onSaved={onSaved} onCancel={onCancel} />);

    expect(screen.getByText(/Loading…/i)).toBeTruthy();
    expect(screen.queryByPlaceholderText(/My MongoDB Server/i)).toBeNull();

    resolveB({ ...CANNED_CONNECTION, id: 'c2', name: 'FromB' });

    await waitFor(() => {
      expect((screen.getByPlaceholderText(/My MongoDB Server/i) as HTMLInputElement).value).toBe('FromB');
    });
  });

  it('create -> edit: does not show the create draft while the edit target is still loading', async () => {
    let resolveB!: (c: Connection) => void;
    const bPending = new Promise<Connection>((res) => {
      resolveB = res;
    });
    installAtelierMock({
      conn: {
        get: (async () => bPending) as never,
      },
    });
    const onSaved = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConnectionForm mode="create" onSaved={onSaved} onCancel={onCancel} />,
    );

    const nameInput = await screen.findByPlaceholderText(/My MongoDB Server/i);
    await userEvent.type(nameInput, 'Draft');

    rerender(<ConnectionForm mode="edit" connectionId="c2" onSaved={onSaved} onCancel={onCancel} />);

    expect(screen.getByText(/Loading…/i)).toBeTruthy();
    expect(screen.queryByPlaceholderText(/My MongoDB Server/i)).toBeNull();

    resolveB({ ...CANNED_CONNECTION, id: 'c2', name: 'FromB' });

    await waitFor(() => {
      expect((screen.getByPlaceholderText(/My MongoDB Server/i) as HTMLInputElement).value).toBe('FromB');
    });
  });
});

/**
 * `Toggle` was a bare `div` with an `onClick`, inside a `label` that wrapped no
 * form control. So it took no focus, answered no key, announced no state, and
 * its own text did nothing when clicked — on the only control for the
 * read-only safety feature. A user who believed they had armed it, and had
 * not, got exactly the accident that feature exists to prevent.
 *
 * Driving the real app is what surfaced it: clicking the label text left the
 * switch off, and every write probe then succeeded against what was actually a
 * writable connection. That reads as a sandbox escape until you check a
 * screenshot, so it is worth a test that fails loudly instead.
 *
 * The read-only toggle stands in for all five in the form — they are one
 * component.
 */
describe('Toggle is a real control, not a div that happens to be clickable', () => {
  const renderForm = async (): Promise<void> => {
    installAtelierMock({});
    render(<ConnectionForm mode="create" onSaved={() => {}} onCancel={() => {}} />);
    await screen.findByPlaceholderText(/My MongoDB Server/i);
  };

  const toggle = (): HTMLElement =>
    screen.getByRole('switch', { name: 'Read-only connection' });

  it('exposes its state, so a screen reader can report whether writes are blocked', async () => {
    await renderForm();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    await userEvent.click(toggle());
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('is reachable by keyboard', async () => {
    await renderForm();
    toggle().focus();
    expect(document.activeElement).toBe(toggle());
  });

  // Space and Enter separately: a `div` with only an `onClick` answers
  // neither, and a handler wired for one of them still leaves the other dead.
  it.each([
    ['{ }', ' '],
    ['{Enter}', '\n'],
  ])('toggles on %s', async (key) => {
    await renderForm();
    toggle().focus();
    await userEvent.keyboard(key === '{ }' ? '[Space]' : '{Enter}');
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('toggles when its label text is clicked, which the cursor already promises', async () => {
    await renderForm();
    await userEvent.click(screen.getByText('Read-only connection'));
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });
});

describe('ConnectionForm: TLS tab warns when transport security is weakened', () => {
  async function openTlsTab(host: string, toggles: { off?: 'tls' | 'verify' } = {}) {
    installAtelierMock({});
    render(<ConnectionForm mode="create" onSaved={() => {}} onCancel={() => {}} />);
    await userEvent.type(await screen.findByPlaceholderText(/cluster\.mongodb\.net/i), host);
    await userEvent.click(screen.getByRole('tab', { name: 'TLS' }));
    if (toggles.off === 'tls') {
      await userEvent.click(await screen.findByRole('switch', { name: 'Enable TLS / SSL' }));
    }
    if (toggles.off === 'verify') {
      await userEvent.click(await screen.findByRole('switch', { name: 'Verify server certificate' }));
    }
  }

  it('shows no warning by default (TLS on, verified)', async () => {
    await openTlsTab('db.example.com');
    await screen.findByRole('switch', { name: 'Enable TLS / SSL' });
    expect(screen.queryByTestId('tls-warning')).toBeNull();
  });

  it('warns, as text in a status region, when Verify is turned off', async () => {
    await openTlsTab('localhost', { off: 'verify' });
    const warning = await screen.findByRole('status');
    expect(warning.textContent).toMatch(/Warning:.*impersonate this server and read your credentials/);
  });

  it('warns when TLS is off for a remote host', async () => {
    await openTlsTab('db.example.com', { off: 'tls' });
    expect((await screen.findByTestId('tls-warning')).textContent).toMatch(/cleartext/);
  });

  it.each(['localhost', '127.0.0.1', '::1'])('does not warn when TLS is off for %s', async (host) => {
    await openTlsTab(host, { off: 'tls' });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Enable TLS / SSL' }).getAttribute('aria-checked')).toBe('false');
    });
    expect(screen.queryByTestId('tls-warning')).toBeNull();
  });
});

describe('ConnectionForm TLS file paths are chosen with Browse, not typed', () => {
  const storedWithCa = {
    ...CANNED_CONNECTION,
    tls: { enabled: true, verify: true, caPath: '/stored/ca.pem' },
  };

  async function openTlsTab() {
    await userEvent.click(await screen.findByText('TLS'));
  }

  it('renders the path inputs read-only, each named after its label', async () => {
    installAtelierMock({});
    render(<ConnectionForm mode="create" onSaved={() => {}} onCancel={() => {}} />);
    await openTlsTab();
    for (const name of ['CA Certificate', 'Client Certificate']) {
      const input = screen.getByRole('textbox', { name }) as HTMLInputElement;
      expect(input.readOnly).toBe(true);
    }
  });

  it('typing into a path input changes nothing', async () => {
    installAtelierMock({});
    render(<ConnectionForm mode="create" onSaved={() => {}} onCancel={() => {}} />);
    await openTlsTab();
    const input = screen.getByRole('textbox', { name: 'CA Certificate' }) as HTMLInputElement;
    await userEvent.type(input, '/typed/ca.pem');
    expect(input.value).toBe('');
  });

  it('Browse fills the path from the dialog result for that purpose', async () => {
    const pickFile = vi.fn(async () => ({ path: '/picked/ca.pem' }));
    installAtelierMock({ app: { pickFile } });
    render(<ConnectionForm mode="create" onSaved={() => {}} onCancel={() => {}} />);
    await openTlsTab();
    await userEvent.click(screen.getByRole('button', { name: 'Browse for CA Certificate' }));
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: 'CA Certificate' }) as HTMLInputElement).value).toBe('/picked/ca.pem'),
    );
    expect(pickFile).toHaveBeenCalledWith('tls-ca');
  });

  it('has no Clear button while a path is empty', async () => {
    installAtelierMock({});
    render(<ConnectionForm mode="create" onSaved={() => {}} onCancel={() => {}} />);
    await openTlsTab();
    expect(screen.queryByRole('button', { name: /^Clear / })).toBeNull();
  });

  it('Clear, named for its path, empties only that path and is reachable by keyboard', async () => {
    installAtelierMock({ conn: { get: async () => ({ ...storedWithCa, tls: { ...storedWithCa.tls, clientCertPath: '/stored/client.pem' } }) } });
    render(<ConnectionForm mode="edit" connectionId="c1" onSaved={() => {}} onCancel={() => {}} />);
    await openTlsTab();
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: 'CA Certificate' }) as HTMLInputElement).value).toBe('/stored/ca.pem'),
    );
    const clear = screen.getByRole('button', { name: 'Clear CA Certificate' });
    clear.focus();
    expect(document.activeElement).toBe(clear);
    await userEvent.keyboard('{Enter}');
    expect((screen.getByRole('textbox', { name: 'CA Certificate' }) as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('textbox', { name: 'Client Certificate' }) as HTMLInputElement).value).toBe('/stored/client.pem');
    expect(screen.queryByRole('button', { name: 'Clear CA Certificate' })).toBeNull();
  });

  it('saving after Clear sends no CA path', async () => {
    const updateSpy = vi.fn(async () => ({ ...storedWithCa, id: 'c1' }) as never);
    installAtelierMock({ conn: { get: async () => storedWithCa, update: updateSpy as never } });
    render(<ConnectionForm mode="edit" connectionId="c1" onSaved={() => {}} onCancel={() => {}} />);
    await openTlsTab();
    await userEvent.click(await screen.findByRole('button', { name: 'Clear CA Certificate' }));
    fireEvent.click(screen.getByText(/Save changes/i));
    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    const patch = (updateSpy.mock.calls[0] as unknown as [string, { tls: { caPath?: string } }])[1];
    expect(patch.tls.caPath).toBeUndefined();
  });

  it('shows the main-process rejection against the path field', async () => {
    const createSpy = vi.fn(async () => {
      throw Object.assign(new Error('rejected'), {
        code: 'VALIDATION',
        details: { issues: [{ path: ['tls', 'caPath'], message: 'Choose this file with Browse; typed paths are not accepted' }] },
      });
    });
    installAtelierMock({ conn: { create: createSpy as never } });
    render(<ConnectionForm mode="create" onSaved={() => {}} onCancel={() => {}} />);
    await userEvent.type(await screen.findByPlaceholderText(/My MongoDB Server/i), 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    await userEvent.click(screen.getByText('Auth'));
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0]!, 'none');
    fireEvent.click(screen.getByText(/^Save$/));
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    await openTlsTab();
    expect(await screen.findByText(/typed paths are not accepted/)).toBeTruthy();
  });
});

describe('ConnectionForm fields are named by their visible label', () => {
  // The required asterisk is decoration (aria-hidden) but still part of the
  // label's textContent, which getByLabelText matches against.
  const byLabel = (label: string) => screen.getByLabelText(new RegExp(`^${label}\\*?$`));
  const describedBy = (el: HTMLElement) =>
    (el.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();

  async function mount() {
    installAtelierMock({});
    render(<ConnectionForm mode="create" onSaved={() => {}} onCancel={() => {}} />);
    await screen.findByPlaceholderText(/My MongoDB Server/i);
  }

  it('General tab: every field label finds its control', async () => {
    await mount();
    expect(byLabel('Name')).toBe(screen.getByPlaceholderText(/My MongoDB Server/i));
    expect(byLabel('Hostname')).toBe(screen.getByPlaceholderText(/cluster\.mongodb\.net/i));
    expect(byLabel('Default database').tagName).toBe('INPUT');
    expect(byLabel('Connection type').tagName).toBe('SELECT');
    // Port only renders for a standard (non-SRV) connection.
    await userEvent.selectOptions(byLabel('Connection type'), 'standard');
    expect(byLabel('Port').tagName).toBe('INPUT');
    await userEvent.click(screen.getByText(/Paste URI/i));
    expect(byLabel('Connection URI')).toBe(screen.getByPlaceholderText(/mongodb\+srv:\/\//i));
  });

  it('General tab: the colour swatches are a group named by their label', async () => {
    await mount();
    const group = screen.getByRole('group', { name: 'Color' });
    expect(within(group).getAllByRole('button').length).toBeGreaterThan(1);
  });

  it('Auth tab: every field label finds its control', async () => {
    await mount();
    await userEvent.click(screen.getByRole('tab', { name: 'Auth' }));
    expect(byLabel('Authentication mechanism').tagName).toBe('SELECT');
    expect(byLabel('Username').tagName).toBe('INPUT');
    expect(byLabel('Auth database').tagName).toBe('INPUT');
    expect((byLabel('Password') as HTMLInputElement).type).toBe('password');
  });

  it('TLS tab: the read-only path rows are named by their label, not an aria-label', async () => {
    await mount();
    await userEvent.click(screen.getByRole('tab', { name: 'TLS' }));
    for (const label of ['CA Certificate', 'Client Certificate']) {
      const input = byLabel(label) as HTMLInputElement;
      expect(input.readOnly).toBe(true);
      expect(input.hasAttribute('aria-label')).toBe(false);
    }
  });

  it('a field with an error is aria-invalid and described by its error text; a valid one is neither', async () => {
    installAtelierMock({
      conn: {
        create: (async () => {
          throw {
            code: 'VALIDATION',
            message: 'password: required',
            details: { issues: [{ path: ['password'], message: 'Password is required for SCRAM authentication' }] },
          };
        }) as never,
      },
    });
    render(<ConnectionForm mode="create" onSaved={() => {}} onCancel={() => {}} />);
    await userEvent.type(await screen.findByPlaceholderText(/My MongoDB Server/i), 'X');
    await userEvent.type(screen.getByPlaceholderText(/cluster\.mongodb\.net/i), 'localhost');
    fireEvent.click(screen.getByText(/^Save$/));

    const password = await waitFor(() => byLabel('Password'));
    expect(password.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(password)).toBe('Password is required for SCRAM authentication');
    const username = byLabel('Username');
    expect(username.hasAttribute('aria-invalid')).toBe(false);
    expect(username.hasAttribute('aria-describedby')).toBe(false);
  });

  it('required fields are aria-required; optional ones are not', async () => {
    await mount();
    expect(byLabel('Name').getAttribute('aria-required')).toBe('true');
    expect(byLabel('Hostname').getAttribute('aria-required')).toBe('true');
    expect(byLabel('Default database').hasAttribute('aria-required')).toBe(false);
    await userEvent.click(screen.getByRole('tab', { name: 'Auth' }));
    expect(byLabel('Username').getAttribute('aria-required')).toBe('true');
    expect(byLabel('Password').getAttribute('aria-required')).toBe('true');
    expect(byLabel('Auth database').hasAttribute('aria-required')).toBe(false);
  });

  it('the password show/hide toggle is named for its action and flips the input type', async () => {
    await mount();
    await userEvent.click(screen.getByRole('tab', { name: 'Auth' }));
    const password = byLabel('Password') as HTMLInputElement;
    expect(password.type).toBe('password');
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password.type).toBe('text');
    const hide = screen.getByRole('button', { name: 'Hide password' });
    expect(hide.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the Show password tooltip when keyboard focus lands on the toggle', async () => {
    await mount();
    await userEvent.click(screen.getByRole('tab', { name: 'Auth' }));
    fireEvent.focus(screen.getByRole('button', { name: 'Show password' }));
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('Show password');
  });

  it('text fields and the (revealed) password field opt out of spell checking', async () => {
    await mount();
    expect(byLabel('Hostname').getAttribute('spellcheck')).toBe('false');
    expect(byLabel('Name').getAttribute('spellcheck')).toBe('false');
    await userEvent.click(screen.getByRole('tab', { name: 'Auth' }));
    expect(byLabel('Username').getAttribute('spellcheck')).toBe('false');
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(byLabel('Password').getAttribute('spellcheck')).toBe('false');
  });
});
