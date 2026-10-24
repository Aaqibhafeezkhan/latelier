import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { RolesTab } from '../../src/pages/RolesTab';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type {
  ConnectionRuntime,
  ConnectionSummary,
  RoleCreateInput,
  RoleDropInput,
  RoleInfo,
  RoleUpdateInput,
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

const BUILTIN: RoleInfo = { role: 'read', db: 'myapp', isBuiltin: true, roles: [], inheritedRoles: [] };
const CUSTOM: RoleInfo = {
  role: 'appAdmin',
  db: 'myapp',
  isBuiltin: false,
  roles: [{ role: 'appWriter', db: 'myapp' }],
  // The closure: must never be what the editor seeds or saves.
  inheritedRoles: [
    { role: 'appWriter', db: 'myapp' },
    { role: 'readWrite', db: 'myapp' },
  ],
  privileges: '[{"resource":{"db":"myapp","collection":"orders"},"actions":["find"]}]',
};

function setup(over: {
  pref?: string | null;
  list?: (input: { dbName: string }) => Promise<RoleInfo[]>;
  create?: (input: RoleCreateInput) => Promise<{ ok: true }>;
  update?: (input: RoleUpdateInput) => Promise<{ ok: true }>;
  drop?: (input: RoleDropInput) => Promise<{ dropped: true }>;
} = {}) {
  const list = vi.fn(over.list ?? (async () => [BUILTIN, CUSTOM]));
  installAtelierMock({
    meta: {
      listDatabases: async () => [
        { name: 'admin', sizeOnDisk: 0, empty: false },
        { name: 'myapp', sizeOnDisk: 0, empty: false },
      ],
    },
    prefs: { get: (async () => over.pref ?? 'myapp') as never, set: async (_k, v) => v },
    role: {
      list,
      ...(over.create ? { create: over.create } : {}),
      ...(over.update ? { update: over.update } : {}),
      ...(over.drop ? { drop: over.drop } : {}),
    },
  });
  render(<RolesTab conn={conn} runtime={runtime} />);
  return { list };
}

describe('RolesTab', () => {
  it('lists custom roles, hides built-ins until asked, and keeps built-ins read-only', async () => {
    const { list } = setup();
    await waitFor(() => expect(screen.getByText('appAdmin')).toBeTruthy());
    expect(list).toHaveBeenLastCalledWith({ connectionId: 'c1', dbName: 'myapp' });
    expect(screen.getByText('appWriter@myapp')).toBeTruthy();
    expect(screen.queryByText('read')).toBeNull();

    await userEvent.click(screen.getByLabelText('Show built-in'));
    expect(screen.getByText('read')).toBeTruthy();
    expect(screen.queryByLabelText('Edit role read')).toBeNull();
    expect(screen.queryByLabelText('Drop role read')).toBeNull();
    expect(screen.getByLabelText('Edit role appAdmin')).toBeTruthy();
  });

  it("reads UsersTab's all-databases pref as admin", async () => {
    const { list } = setup({ pref: '__all__' });
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list).toHaveBeenLastCalledWith({ connectionId: 'c1', dbName: 'admin' });
    expect((screen.getByLabelText('Database') as HTMLSelectElement).value).toBe('admin');
  });

  it('creates a role with privileges and inherited roles', async () => {
    const calls: RoleCreateInput[] = [];
    const { list } = setup({
      create: async (input) => {
        calls.push(input);
        return { ok: true as const };
      },
    });
    await waitFor(() => expect(screen.getByText('appAdmin')).toBeTruthy());

    await userEvent.click(screen.getByText('+ New role'));
    await userEvent.type(screen.getByLabelText('Role name'), 'auditor');
    await userEvent.click(screen.getByText('+ Add role'));
    const priv = '[{"resource":{"db":"myapp","collection":""},"actions":["find"]}]';
    fireEvent.change(screen.getByLabelText('Privileges'), { target: { value: priv } });
    const before = list.mock.calls.length;
    await userEvent.click(screen.getByText('Create role'));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toEqual({
      connectionId: 'c1',
      dbName: 'myapp',
      role: 'auditor',
      privileges: priv,
      roles: [{ role: 'read', db: 'myapp' }],
    });
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before));
  });

  it('keeps the drawer open with the CONFLICT message inline', async () => {
    setup({
      create: async () => {
        throw { code: 'CONFLICT', message: 'Role "appAdmin@myapp" already exists' };
      },
    });
    await waitFor(() => expect(screen.getByText('appAdmin')).toBeTruthy());

    await userEvent.click(screen.getByText('+ New role'));
    await userEvent.type(screen.getByLabelText('Role name'), 'appAdmin');
    await userEvent.click(screen.getByText('Create role'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already exists/));
    expect(screen.getByLabelText('Role name')).toBeTruthy();
  });

  it('refuses privileges that are not an EJSON array without calling the API', async () => {
    const create = vi.fn(async () => ({ ok: true as const }));
    setup({ create });
    await waitFor(() => expect(screen.getByText('appAdmin')).toBeTruthy());

    await userEvent.click(screen.getByText('+ New role'));
    await userEvent.type(screen.getByLabelText('Role name'), 'bad');
    fireEvent.change(screen.getByLabelText('Privileges'), { target: { value: '{"a":1}' } });
    await userEvent.click(screen.getByText('Create role'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/must be an array/));
    expect(create).not.toHaveBeenCalled();
  });

  it('edits a role seeded from its direct parents, not the inherited closure', async () => {
    const calls: RoleUpdateInput[] = [];
    setup({
      update: async (input) => {
        calls.push(input);
        return { ok: true as const };
      },
    });
    await waitFor(() => expect(screen.getByText('appAdmin')).toBeTruthy());

    await userEvent.click(screen.getByLabelText('Edit role appAdmin'));
    await waitFor(() => expect(screen.getByText(/Edit role — appAdmin/)).toBeTruthy());
    expect(screen.queryByLabelText('Role name 2', { selector: 'input' })).toBeNull();
    expect(
      (screen.getByLabelText('Role name 1', { selector: 'input' }) as HTMLInputElement).value,
    ).toBe('appWriter');

    await userEvent.click(screen.getByLabelText('Remove role 1'));
    await userEvent.click(screen.getByText('Save role'));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].role).toBe('appAdmin');
    expect(calls[0].dbName).toBe('myapp');
    // Only the field that changed goes in the patch.
    expect(calls[0].patch).toEqual({ roles: [] });
  });

  it('sends only changed privileges, and never a defaulted [] for a role listed without them', async () => {
    const calls: RoleUpdateInput[] = [];
    const bare: RoleInfo = { ...CUSTOM, role: 'bare', privileges: undefined };
    setup({
      list: async () => [CUSTOM, bare],
      update: async (input) => {
        calls.push(input);
        return { ok: true as const };
      },
    });
    await waitFor(() => expect(screen.getByText('bare')).toBeTruthy());

    await userEvent.click(screen.getByLabelText('Edit role bare'));
    await userEvent.click(screen.getByLabelText('Remove role 1'));
    await userEvent.click(screen.getByText('Save role'));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].patch).toEqual({ roles: [] });

    await waitFor(() => expect(screen.queryByText(/Edit role — bare/)).toBeNull());
    await userEvent.click(screen.getByLabelText('Edit role appAdmin'));
    fireEvent.change(screen.getByLabelText('Privileges'), { target: { value: '[]' } });
    await userEvent.click(screen.getByText('Save role'));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1].patch).toEqual({ privileges: '[]' });
  });

  it('trims inherited role names and dbs before sending', async () => {
    const calls: RoleCreateInput[] = [];
    setup({
      create: async (input) => {
        calls.push(input);
        return { ok: true as const };
      },
    });
    await waitFor(() => expect(screen.getByText('appAdmin')).toBeTruthy());

    await userEvent.click(screen.getByText('+ New role'));
    await userEvent.type(screen.getByLabelText('Role name'), 'auditor');
    await userEvent.click(screen.getByText('+ Add role'));
    fireEvent.change(screen.getByLabelText('Role name 1', { selector: 'input' }), {
      target: { value: ' appWriter ' },
    });
    fireEvent.change(screen.getByLabelText('Role db 1'), { target: { value: ' myapp ' } });
    await userEvent.click(screen.getByText('Create role'));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].roles).toEqual([{ role: 'appWriter', db: 'myapp' }]);
  });

  it('closes a clean edit drawer on Cancel without prompting, and prompts once dirty', async () => {
    setup();
    await waitFor(() => expect(screen.getByText('appAdmin')).toBeTruthy());

    await userEvent.click(screen.getByLabelText('Edit role appAdmin'));
    await waitFor(() => expect(screen.getByText(/Edit role — appAdmin/)).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/Edit role — appAdmin/)).toBeNull());
    expect(screen.queryByText('Discard changes?')).toBeNull();

    await userEvent.click(screen.getByLabelText('Edit role appAdmin'));
    await waitFor(() => expect(screen.getByText(/Edit role — appAdmin/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Privileges'), { target: { value: '[]' } });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByText('Discard changes?')).toBeTruthy());
    expect(screen.getByText(/Edit role — appAdmin/)).toBeTruthy();
  });

  it('drops a role only after its name is typed, then focuses the list', async () => {
    const drops: RoleDropInput[] = [];
    const { list } = setup({
      drop: async (input) => {
        drops.push(input);
        return { dropped: true as const };
      },
    });
    await waitFor(() => expect(screen.getByText('appAdmin')).toBeTruthy());

    await userEvent.click(screen.getByLabelText('Drop role appAdmin'));
    await waitFor(() => expect(screen.getByText('Drop role "appAdmin" on myapp?')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Drop role "appAdmin" on myapp?')).toBeNull());
    expect(drops).toEqual([]);
    // Cancel returns focus to the Drop button that opened the dialog.
    expect(document.activeElement).toBe(screen.getByLabelText('Drop role appAdmin'));

    await userEvent.click(screen.getByLabelText('Drop role appAdmin'));
    const drop = await screen.findByRole('button', { name: 'Drop' });
    await userEvent.type(screen.getByLabelText('Confirm role name'), 'appAdmi');
    expect((drop as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Confirm role name'), 'n');
    const before = list.mock.calls.length;
    await userEvent.click(drop);

    await waitFor(() =>
      expect(drops).toEqual([{ connectionId: 'c1', dbName: 'myapp', role: 'appAdmin' }]),
    );
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before));
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Roles' }));
  });
  it('Escape while a drop is in flight leaves the dialog open and then shows the result', async () => {
    let finishDrop!: () => void;
    const dropGate = new Promise<void>((res) => {
      finishDrop = res;
    });
    const drops: RoleDropInput[] = [];
    setup({
      drop: async (input) => {
        drops.push(input);
        await dropGate;
        return { dropped: true as const };
      },
    });
    await waitFor(() => expect(screen.getByText('appAdmin')).toBeTruthy());
    await userEvent.click(screen.getByLabelText('Drop role appAdmin'));
    await userEvent.type(await screen.findByLabelText('Confirm role name'), 'appAdmin');
    await userEvent.click(screen.getByRole('button', { name: 'Drop' }));
    await waitFor(() => expect(drops).toHaveLength(1));

    await userEvent.keyboard('{Escape}');
    expect(screen.getByText('Drop role "appAdmin" on myapp?')).toBeTruthy();

    finishDrop();
    await waitFor(() => expect(screen.queryByText('Drop role "appAdmin" on myapp?')).toBeNull());
  });
});
