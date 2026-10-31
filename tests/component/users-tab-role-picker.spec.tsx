import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { UsersTab } from '../../src/pages/UsersTab';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type {
  ConnectionRuntime,
  ConnectionSummary,
  RoleInfo,
  UserInfo,
  UserUpdateInput,
} from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

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

const READER: UserInfo = {
  db: 'myapp',
  username: 'reader',
  mechanisms: ['SCRAM-SHA-256'],
  roles: [{ role: 'read', db: 'myapp' }],
  external: false,
};

function role(name: string, db = 'myapp'): RoleInfo {
  return { role: name, db, isBuiltin: false, roles: [], inheritedRoles: [] };
}

const roleInput = () => screen.getByLabelText('Role name 1', { selector: 'input' });

async function openEdit(roleList: (input: { dbName: string }) => Promise<RoleInfo[]>) {
  const updates: UserUpdateInput[] = [];
  const listSpy = vi.fn(roleList);
  installAtelierMock({
    conn: { get: async () => null as never },
    meta: { listDatabases: async () => [{ name: 'myapp', sizeOnDisk: 0, empty: false }] },
    user: {
      list: async () => [READER],
      update: async (input) => {
        updates.push(input);
        return { ok: true as const };
      },
    },
    role: { list: listSpy },
  });
  render(<UsersTab conn={conn} runtime={runtime} />);
  await waitFor(() => expect(screen.getByText('reader')).toBeTruthy());
  await userEvent.click(screen.getByLabelText('Edit user reader'));
  await waitFor(() => expect(roleInput()).toBeTruthy());
  return { updates, listSpy };
}

describe('UserDrawer — role picker', () => {
  it('suggests the roles that role:list returns for the row database', async () => {
    const { listSpy } = await openEdit(async () => [role('read'), role('readWrite'), role('appAuditor')]);
    await waitFor(() =>
      expect(listSpy).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'myapp' }),
    );

    await userEvent.clear(roleInput());
    await userEvent.type(roleInput(), 'appA');
    await userEvent.click(await screen.findByRole('option', { name: 'appAuditor' }));

    expect((roleInput() as HTMLInputElement).value).toBe('appAuditor');
  });

  it('warns about a role the list does not know, without blocking the save', async () => {
    const { updates } = await openEdit(async () => [role('read'), role('readWrite')]);
    await waitFor(() => expect(screen.queryByText('Unknown role on myapp')).toBeNull());

    await userEvent.clear(roleInput());
    await userEvent.type(roleInput(), 'nosuchRole');
    await waitFor(() => expect(screen.getByText('Unknown role on myapp')).toBeTruthy());

    await userEvent.click(screen.getByText('Save user'));
    await waitFor(() => expect(updates.length).toBe(1));
    expect(updates[0].patch.roles).toEqual([{ role: 'nosuchRole', db: 'myapp' }]);
  });

  it('fetches the catalog of a database typed into a row', async () => {
    const { listSpy } = await openEdit(async ({ dbName }) =>
      dbName === 'logs' ? [role('logReader', 'logs')] : [role('read')],
    );
    const dbInput = screen.getByLabelText('Role db 1');
    await userEvent.clear(dbInput);
    await userEvent.type(dbInput, 'logs');

    await waitFor(() =>
      expect(listSpy).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'logs' }),
    );
    // Debounced: the half-typed names in between were never fetched.
    expect(listSpy.mock.calls.map(([i]) => i.dbName)).not.toContain('lo');
    await waitFor(() => expect(screen.getByText('Unknown role on logs')).toBeTruthy());
  });

  it('trims role names and dbs before sending', async () => {
    const { updates } = await openEdit(async () => [role('read')]);
    fireEvent.change(roleInput(), { target: { value: ' readWrite ' } });
    fireEvent.change(screen.getByLabelText('Role db 1'), { target: { value: ' myapp ' } });
    await userEvent.click(screen.getByText('Save user'));
    await waitFor(() => expect(updates.length).toBe(1));
    expect(updates[0].patch.roles).toEqual([{ role: 'readWrite', db: 'myapp' }]);
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'survives a row database named %s (no prototype lookup in the catalog)',
    async (db) => {
      const { listSpy } = await openEdit(async ({ dbName }) =>
        dbName === db ? [role('special', db)] : [role('read')],
      );
      fireEvent.change(screen.getByLabelText('Role db 1'), { target: { value: db } });
      await waitFor(() => expect(listSpy).toHaveBeenCalledWith({ connectionId: 'c1', dbName: db }));
      await waitFor(() => expect(screen.getByText(`Unknown role on ${db}`)).toBeTruthy());
      fireEvent.change(roleInput(), { target: { value: 'special' } });
      await waitFor(() => expect(screen.queryByText(`Unknown role on ${db}`)).toBeNull());
    },
  );

  it('shows no warning when the role list cannot be read', async () => {
    const { listSpy } = await openEdit(async () => {
      throw { code: 'UNAUTHORIZED', message: 'not authorized' };
    });
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    await userEvent.clear(roleInput());
    await userEvent.type(roleInput(), 'nosuchRole');
    // Give a failed fetch's state update time to land before asserting absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Unknown role/)).toBeNull();
  });
});

describe('UserDrawer — password reveal (#185)', () => {
  it('reaches the reveal toggle by keyboard and switches the field to text', async () => {
    await openEdit(async () => []);
    const pw = screen.getByLabelText('Password') as HTMLInputElement;
    expect(pw.type).toBe('password');

    pw.focus();
    await userEvent.tab();
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(document.activeElement).toBe(toggle);

    await userEvent.keyboard('{Enter}');
    expect(pw.type).toBe('text');
    // A toggle button: the name stays fixed and aria-pressed carries the
    // state, so a screen reader does not hear "Hide password, pressed".
    expect(toggle.getAttribute('aria-label')).toBe('Show password');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    // The confirm field has its own toggle and stays masked.
    expect((screen.getByLabelText('Confirm password') as HTMLInputElement).type).toBe('password');
  });
});
