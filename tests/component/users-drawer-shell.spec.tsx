import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { UsersTab } from '../../src/pages/UsersTab';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type {
  Connection,
  ConnectionRuntime,
  ConnectionSummary,
  UserInfo,
} from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

/**
 * X15 T7 — the dialog shell and the unsaved-changes guard.
 *
 * The behavioural specs for this drawer live in `users-create-drawer.spec.tsx`
 * and `users-edit-drawer.spec.tsx`; this file covers only what the Mantine
 * migration is responsible for — the a11y set the hand-rolled panel never had
 * (Escape, a focus trap, focus return, a labelled ✕) and the guard that stops a
 * dismissal from discarding a half-filled user form.
 *
 * The panel had **no backdrop at all** before the migration: it was a bare
 * `position: absolute` panel inside the tab. Mantine's Escape and overlay are
 * both new dismissal surfaces here, which is why the guard travels with them.
 *
 * `UserDrawer` doubles as the *edit* drawer, so it opens **pre-filled**. That
 * is what forces `isDirty` to compare against a captured initial snapshot: a
 * comparison against `''` would report an untouched edit form dirty and prompt
 * on every clean Cancel. The clean-Cancel case below is deliberately written in
 * edit mode — in create mode a broken `username !== ''` check passes it.
 *
 * Three of these tests are the ticket's mutation targets and are named as such.
 */

const conn: ConnectionSummary = {
  id: 'c1',
  name: 'test',
  color: '#1A6835',
  host: 'localhost',
  port: 27017,
  connectionType: 'standard',
  readOnly: false,
  status: 'connected',
};
const runtime: ConnectionRuntime = { id: 'c1', status: 'connected' };

function makeFullConn(): Connection {
  return {
    id: 'c1',
    name: 'test',
    color: '#1A6835',
    connectionType: 'standard',
    readOnly: false,
    host: 'localhost',
    port: 27017,
    authMech: 'scram256',
    authUsername: 'admin',
    authDatabase: 'admin',
    tls: { enabled: false, verify: true },
    advanced: {
      connectTimeoutMs: 5000,
      socketTimeoutMs: 5000,
      serverSelectionTimeoutMs: 5000,
      readPreference: 'primary',
      maxPoolSize: 5,
      directConnection: false,
    },
    hasPasswordStored: true,
    hasSshPasswordStored: false,
    hasSshPassphraseStored: false,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
  };
}

const READER: UserInfo = {
  db: 'myapp',
  username: 'reader',
  mechanisms: ['SCRAM-SHA-256'],
  roles: [{ role: 'read', db: 'myapp' }],
  external: false,
};

const createDrawer = () => screen.getByRole('dialog', { name: 'New user (myapp)' });
const editDrawer = () => screen.getByRole('dialog', { name: 'Edit user — reader (myapp)' });
const discardPrompt = () => screen.queryByRole('dialog', { name: 'Discard changes?' });
/** The overlay carries no role by design, so it has no accessible handle. */
const overlay = () => document.body.querySelector('.mantine-Drawer-overlay') as HTMLElement;

/** Let a click's async handler settle so a *negative* assertion means something. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

function setup() {
  installAtelierMock({
    conn: { get: async () => makeFullConn() },
    meta: { listDatabases: async () => [{ name: 'myapp', sizeOnDisk: 0, empty: false }] },
    user: {
      list: async () => [READER],
      create: async () => ({ ok: true as const }),
      update: async () => ({ ok: true as const }),
    },
  });
  render(<UsersTab conn={conn} runtime={runtime} />);
}

/** Renders the tab and opens the create drawer off the real trigger. */
async function openCreate() {
  setup();
  await waitFor(() => expect(screen.getByText('reader')).toBeTruthy());
  await userEvent.selectOptions(screen.getByLabelText('Database'), 'myapp');
  const trigger = screen.getByText('+ New user').closest('button')!;
  await userEvent.click(trigger);
  await waitFor(() => expect(screen.getByLabelText('Username')).toBeTruthy());
  return trigger;
}

/** Renders the tab and opens the pre-filled edit drawer off the real trigger. */
async function openEdit() {
  setup();
  await waitFor(() => expect(screen.getByText('reader')).toBeTruthy());
  const trigger = screen.getByLabelText('Edit user reader');
  await userEvent.click(trigger);
  await waitFor(() => expect(screen.getByLabelText('Role name 1', { selector: 'input' })).toBeTruthy());
  return trigger;
}

describe('UserDrawer — dialog shell (X15 T7)', () => {
  it('puts role="dialog" on the panel — the element holding the form, not the backdrop', async () => {
    await openCreate();
    expect(within(createDrawer()).getByLabelText('Username')).toBeTruthy();
    expect(overlay()).not.toBeNull();
    expect(overlay().getAttribute('role')).toBeNull();
  });

  it('names the dialog and gives the close control an aria-label', async () => {
    await openCreate();
    // `getByRole('dialog', { name: … })` above already proves the accessible
    // name; the ✕ did not exist at all before the migration.
    expect(within(createDrawer()).getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('moves focus into the panel on open', async () => {
    await openCreate();
    await waitFor(() => expect(createDrawer().contains(document.activeElement)).toBe(true));
  });

  it('Escape closes a clean drawer without prompting, and returns focus to the trigger', async () => {
    const trigger = await openEdit();
    await waitFor(() => expect(editDrawer().contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByLabelText('Role name 1', { selector: 'input' })).toBeNull());
    expect(discardPrompt()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  /**
   * MUTATION TARGET 1 — the pre-fill case. Replace any `initial.*` comparison
   * in `UserDrawer`'s `isDirty` with a bare literal (`username !== ''`,
   * `!scram256`, `customDataEnabled`) and this must go red: an untouched edit
   * form reads dirty and the user is asked to discard changes they never made.
   *
   * It has to be the EDIT drawer. In create mode every field really does open
   * empty, so the broken comparison passes there and proves nothing.
   */
  it('closing an untouched pre-filled edit drawer from Cancel does not prompt', async () => {
    await openEdit();
    expect((screen.getByLabelText('Role name 1', { selector: 'input' }) as HTMLInputElement).value).toBe('read');

    fireEvent.click(within(editDrawer()).getByRole('button', { name: 'Cancel' }));
    await settle();

    expect(discardPrompt()).toBeNull();
    await waitFor(() => expect(screen.queryByLabelText('Role name 1', { selector: 'input' })).toBeNull());
  });

  it('closing an untouched create drawer from Cancel does not prompt', async () => {
    await openCreate();
    fireEvent.click(within(createDrawer()).getByRole('button', { name: 'Cancel' }));
    await settle();

    expect(discardPrompt()).toBeNull();
    await waitFor(() => expect(screen.queryByLabelText('Username')).toBeNull());
  });
});

describe('UserDrawer — unsaved-changes guard (X15 T7)', () => {
  /**
   * MUTATION TARGET 2 — delete `closeOnClickOutside={false}` from `UserDrawer`
   * and the last assertion must go red: the backdrop starts routing through
   * `requestClose` and raises a prompt the user never asked for. The other
   * assertions stay green under that mutation, which is exactly why "no prompt"
   * has to be asserted rather than "text survived".
   *
   * Do not "fix" this test into expecting a prompt. An inert backdrop is the
   * point: `closeOnClickOutside={false}` is what stops one stray click from
   * reaching the close path at all.
   */
  it('a backdrop click with a dirty field is inert — no close, no prompt, text intact', async () => {
    await openCreate();
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newby' } });

    fireEvent.click(overlay());
    await settle();

    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('newby');
    expect(createDrawer()).toBeTruthy();
    expect(discardPrompt()).toBeNull();
  });

  it('Escape with dirty fields prompts, and Cancel leaves every field intact', async () => {
    await openCreate();
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newby' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByLabelText('SCRAM-SHA-1'));

    fireEvent.keyDown(document.body, { key: 'Escape' });

    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(discardPrompt()).toBeNull());
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('newby');
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('hunter2');
    expect((screen.getByLabelText('Confirm password') as HTMLInputElement).value).toBe('hunter2');
    expect((screen.getByLabelText('SCRAM-SHA-1') as HTMLInputElement).checked).toBe(true);
  });

  it('Escape with a dirty field closes once Discard is confirmed', async () => {
    await openCreate();
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newby' } });

    fireEvent.keyDown(document.body, { key: 'Escape' });

    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(screen.queryByLabelText('Username')).toBeNull());
  });

  /**
   * MUTATION TARGET 3 — narrow `isDirty` in `UserDrawer` to the username alone
   * (`username !== initial.username`, the obvious narrowing) and this must go
   * red. The username is deliberately left UNTOUCHED here: the work at risk is
   * the password pair and the added role, and a per-field check reports the
   * form clean while discarding both.
   */
  it('dirtying a field other than the first still prompts', async () => {
    await openCreate();

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByText('+ Add role'));
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('');

    fireEvent.click(within(createDrawer()).getByRole('button', { name: 'Cancel' }));

    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(discardPrompt()).toBeNull());
    expect(createDrawer()).toBeTruthy();
  });
});
