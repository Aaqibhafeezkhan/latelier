import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { UsersTab } from '../../src/pages/UsersTab';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type {
  Connection,
  ConnectionRuntime,
  ConnectionSummary,
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

const X509_USER: UserInfo = {
  db: '$external',
  username: 'CN=client',
  mechanisms: ['MONGODB-X509'],
  roles: [{ role: 'readAnyDatabase', db: 'admin' }],
  external: true,
};

function renderTab() {
  return render(
      <UsersTab conn={conn} runtime={runtime} />
  );
}

describe('UsersTab — edit drawer', () => {
  it('submits a patch with roles only when password is left blank', async () => {
    const calls: UserUpdateInput[] = [];
    installAtelierMock({
      conn: { get: async () => makeFullConn() },
      meta: { listDatabases: async () => [{ name: 'myapp', sizeOnDisk: 0, empty: false }] },
      user: {
        list: async () => [READER],
        update: async (input) => {
          calls.push(input);
          return { ok: true as const };
        },
      },
    });
    renderTab();
    await waitFor(() => expect(screen.getByText('reader')).toBeTruthy());

    await userEvent.click(screen.getByLabelText('Edit user reader'));

    await waitFor(() => expect(screen.getByText(/Edit user — reader/)).toBeTruthy());

    // Modify the existing role's role-name from 'read' to 'readWrite'.
    const roleInput = screen.getByLabelText('Role name 1', { selector: 'input' });
    await userEvent.clear(roleInput);
    await userEvent.type(roleInput, 'readWrite');

    await userEvent.click(screen.getByText('Save user'));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].patch.roles).toEqual([{ role: 'readWrite', db: 'myapp' }]);
    expect(calls[0].patch.password).toBeUndefined();
    expect(calls[0].patch.customData).toBeUndefined();
  });

  it('hides password fields and keeps role-only edit for external users', async () => {
    installAtelierMock({
      conn: { get: async () => makeFullConn() },
      meta: { listDatabases: async () => [{ name: '$external', sizeOnDisk: 0, empty: false }] },
      user: {
        list: async () => [X509_USER],
        update: async () => ({ ok: true as const }),
      },
    });
    renderTab();
    await waitFor(() => expect(screen.getByText('CN=client')).toBeTruthy());

    await userEvent.click(screen.getByLabelText('Edit user CN=client'));
    await waitFor(() => expect(screen.getByText(/Edit user — CN=client/)).toBeTruthy());

    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByLabelText('Confirm password')).toBeNull();
    expect(screen.getByText(/External users are managed via your auth provider/)).toBeTruthy();
  });
});
