import React from 'react';
import { themeVars } from '../theme/themeVars';
import { I } from '../icons';
import {
  ActionIcon,
  Alert,
  Badge as MantineBadge,
  Button,
  Drawer,
  Group,
  Modal,
  PasswordInput,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { api, isIpcError } from '../api/atelier';
import { confirmDestructive } from '../utils/confirm';
import { DisclosureToggle } from '../components/DisclosureToggle';
import { SubmitButton } from '../components/SubmitButton';
import { useDialogFocusReturn } from '../hooks/useDialogFocusReturn';
import { RoleRowsEditor } from './RoleRowsEditor';
import type { DbInfo } from '@shared/ipc';
import type {
  AuthMechanism,
  Connection,
  ConnectionRuntime,
  ConnectionSummary,
  UserCreateInput,
  UserInfo,
  UserRoleRef,
  UserUpdateInput,
} from '@shared/types';

const LAST_DB_KEY = 'ui.users.lastDb';
const ALL_DBS = '__all__';
const ROLE_TRUNCATE_AT = 4;

function RoleBadge({
  label,
  tone,
  title,
}: {
  label: string;
  tone?: 'accent' | 'warn';
  title?: string;
}) {
  const color = tone === 'accent' ? 'green' : tone === 'warn' ? 'orange' : 'gray';
  return (
    <MantineBadge
      size="xs"
      variant="light"
      color={color}
      title={title}
      style={{ textTransform: 'none', fontFamily: 'inherit', fontWeight: 400 }}
    >
      {label}
    </MantineBadge>
  );
}

function shortMech(m: string): string {
  return m.replace('SCRAM-SHA-', 'SCRAM-').replace('MONGODB-', '');
}

function isSelfRow(
  user: UserInfo,
  connFull: Connection | null,
): boolean {
  if (!connFull) return false;
  if (!connFull.authUsername) return false;
  if (user.username !== connFull.authUsername) return false;
  const authDb = connFull.authDatabase ?? 'admin';
  return user.db === authDb;
}

export function UsersTab({
  conn,
  runtime,
}: {
  conn: ConnectionSummary;
  runtime: ConnectionRuntime;
}) {
  const T = themeVars;
  const [dbs, setDbs] = React.useState<DbInfo[] | null>(null);
  const [picked, setPicked] = React.useState<string>(ALL_DBS);
  const [users, setUsers] = React.useState<UserInfo[] | null>(null);
  const [filter, setFilter] = React.useState('');
  const [error, setError] = React.useState<{ message: string; code?: string } | null>(null);
  const [dbError, setDbError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [expandedRow, setExpandedRow] = React.useState<string | null>(null);
  const [connFull, setConnFull] = React.useState<Connection | null>(null);
  const [drawerMode, setDrawerMode] = React.useState<
    | { kind: 'create' }
    | { kind: 'edit'; user: UserInfo }
    | null
  >(null);
  const [dropTarget, setDropTarget] = React.useState<UserInfo | null>(null);
  // Captured alongside `dropTarget`, in the same click handler that sets it —
  // reading a ref's `.current` has to happen in an event handler or effect,
  // never during render (`react-hooks/refs`), so this can't be
  // `scrollRegionRef.current` inline in the JSX below.
  const [dropReturnFocus, setDropReturnFocus] = React.useState<HTMLElement | null>(null);
  // #74's focus-return target for a successful drop: the row is gone by then,
  // but this scroll region is mounted for the tab's whole lifetime. Not the
  // "Refresh" button, the obvious-looking alternative — it's `disabled={loading}`,
  // and the success path kicks off a reload, so it is disabled at the exact
  // moment focus would land there. A disabled focused button drops focus to
  // <body> itself — the same disabled-focused-button defect documented at
  // FieldsControl.tsx:84-91 — which is the bug this exists to fix.
  const scrollRegionRef = React.useRef<HTMLDivElement>(null);

  // Fetch full connection (auth_username / auth_database) for self-protection.
  React.useEffect(() => {
    void api.conn.get(conn.id).then(setConnFull).catch(() => { /* non-fatal */ });
  }, [conn.id]);

  React.useEffect(() => {
    void api.prefs
      .get<string>(LAST_DB_KEY)
      .then((v) => v && setPicked(v))
      .catch(() => { /* non-fatal */ });
  }, []);

  const loadDatabases = React.useCallback(async () => {
    if (runtime.status !== 'connected') return;
    try {
      const rows = await api.meta.listDatabases({
        connectionId: conn.id,
        includeSystem: true,
      });
      setDbs(rows);
      setDbError(null);
    } catch (err) {
      setDbError(isIpcError(err) ? err.message : String(err));
    }
  }, [conn.id, runtime.status]);

  // Only the latest request may write state: a slow reply for a database the
  // picker has since left must not overwrite the one now on screen.
  const latest = React.useRef(0);

  const loadUsers = React.useCallback(async () => {
    if (runtime.status !== 'connected') return;
    const id = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const rows = await api.user.list({
        connectionId: conn.id,
        ...(picked === ALL_DBS ? {} : { dbName: picked }),
      });
      if (id === latest.current) setUsers(rows);
    } catch (err) {
      if (id === latest.current) {
        if (isIpcError(err)) {
          setError({ message: err.message, code: err.code });
        } else {
          setError({ message: String(err) });
        }
        setUsers(null);
      }
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, [conn.id, runtime.status, picked]);

  /* eslint-disable react-hooks/set-state-in-effect */
  React.useEffect(() => {
    void loadDatabases();
  }, [loadDatabases]);

  React.useEffect(() => {
    void loadUsers();
    setExpandedRow(null);
    const request = latest;
    return () => {
      request.current++;
    };
  }, [loadUsers]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const onPickDb = (next: string) => {
    setPicked(next);
    void api.prefs.set(LAST_DB_KEY, next).catch(() => { /* ok */ });
  };

  if (runtime.status !== 'connected') {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: T.textMuted }}>
        Not connected. Open the Overview tab to connect.
      </div>
    );
  }

  if (dbError) {
    return (
      <div style={{ padding: 20, color: T.warn }}>
        {dbError}
        <Button variant="subtle" size="compact-xs" c={T.accent} ml={8} onClick={() => void loadDatabases()}>
          Retry
        </Button>
      </div>
    );
  }

  const lowered = filter.trim().toLowerCase();
  const filteredUsers = users
    ? users.filter((u) =>
        !lowered ||
        u.username.toLowerCase().includes(lowered) ||
        u.db.toLowerCase().includes(lowered),
      )
    : null;

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 16px',
          borderBottom: `1px solid ${T.border}`,
          background: T.surface,
        }}
      >
        <select
          aria-label="Database"
          value={picked}
          onChange={(e) => onPickDb(e.target.value)}
          style={{
            border: `1px solid ${T.border}`,
            borderRadius: T.rs,
            background: T.surfaceRaised,
            padding: '4px 8px',
            fontSize: 12,
            color: T.text,
            minWidth: 160,
          }}
        >
          <option value={ALL_DBS}>All databases</option>
          {dbs?.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}
            </option>
          ))}
        </select>

        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            border: `1px solid ${T.border}`,
            borderRadius: T.rs,
            background: T.surfaceRaised,
            padding: '4px 8px',
            maxWidth: 280,
          }}
        >
          <span style={{ color: T.textGhost, display: 'flex' }}>{I.search}</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter users…"
            aria-label="Filter users"
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 12,
              color: T.text,
              fontFamily: 'inherit',
            }}
          />
        </div>

        <div style={{ flex: 1 }} />

        <Button
          size="compact-xs"
          variant="filled"
          onClick={() => setDrawerMode({ kind: 'create' })}
          disabled={picked === ALL_DBS}
          title={picked === ALL_DBS ? 'Pick a specific database to create a user.' : undefined}
        >
          + New user
        </Button>

        <Button size="compact-xs" variant="subtle" onClick={() => void loadUsers()} leftSection={I.sync} disabled={loading}>
          Refresh
        </Button>
      </div>

      <div
        ref={scrollRegionRef}
        tabIndex={-1}
        role="region"
        aria-label="Users"
        style={{ flex: 1, overflowY: 'auto' }}
      >
        {loading && !users && (
          <div style={{ padding: 20, color: T.textMuted, fontSize: 13 }}>Loading users…</div>
        )}

        {error && (
          <Alert
            role="alert"
            color="orange"
            variant="light"
            m="sm"
            styles={{ message: { fontSize: 12 } }}
          >
            {error.code === 'UNAUTHORIZED' ? (
              <Stack gap={4}>
                <Text size="xs">
                  This connection lacks the privilege to read users on{' '}
                  {picked === ALL_DBS ? 'this server' : picked}.
                </Text>
                <Text size="xs" c="dimmed">
                  Roles like <code>userAdminAnyDatabase</code> are required.
                </Text>
              </Stack>
            ) : (
              <Text size="xs">{error.message}</Text>
            )}
            <Button
              variant="subtle"
              size="compact-xs"
              mt={4}
              onClick={() => void loadUsers()}
            >
              Retry
            </Button>
          </Alert>
        )}

        {!error && filteredUsers && filteredUsers.length === 0 && (
          <div style={{ padding: 20, color: T.textMuted, fontSize: 13, textAlign: 'center' }}>
            {lowered
              ? `No users match "${filter}".`
              : `No users defined on ${picked === ALL_DBS ? 'this server' : picked}.`}
          </div>
        )}

        {!error && filteredUsers && filteredUsers.length > 0 && (
          <Table
            striped
            highlightOnHover
            withTableBorder
            withColumnBorders={false}
            styles={{
              table: { fontSize: 12 },
              th: {
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                fontWeight: 600,
                color: T.textMuted,
                padding: '8px 12px',
              },
              td: { padding: '8px 12px', verticalAlign: 'middle' },
            }}
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Username</Table.Th>
                <Table.Th>Auth db</Table.Th>
                <Table.Th>Roles</Table.Th>
                <Table.Th>Mechs</Table.Th>
                <Table.Th style={{ width: 64 }} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filteredUsers.map((u) => {
                const rowKey = `${u.db}.${u.username}`;
                const open = expandedRow === rowKey;
                const isSelf = isSelfRow(u, connFull);
                const visibleRoles = u.roles.slice(0, ROLE_TRUNCATE_AT);
                const overflow = u.roles.length - visibleRoles.length;
                return (
                  <React.Fragment key={rowKey}>
                    <Table.Tr
                      onClick={() => setExpandedRow(open ? null : rowKey)}
                      style={{ cursor: 'pointer' }}
                    >
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <DisclosureToggle open={open}>
                            <span
                              style={{
                                fontFamily: 'monospace',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                color: T.text,
                              }}
                            >
                              {u.username}
                            </span>
                          </DisclosureToggle>
                          {isSelf && (
                            <RoleBadge label="this connection" tone="accent" />
                          )}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <Text size="xs" c="dimmed">{u.db}</Text>
                          {u.db === '$external' && <RoleBadge label="external" />}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="wrap">
                          {visibleRoles.map((r) => (
                            <RoleBadge
                              key={`${r.role}@${r.db}`}
                              label={`${r.role}@${r.db}`}
                              tone={r.role === 'root' ? 'warn' : undefined}
                            />
                          ))}
                          {overflow > 0 && (
                            <RoleBadge
                              label={`+${overflow}`}
                              title={u.roles
                                .slice(ROLE_TRUNCATE_AT)
                                .map((r) => `${r.role}@${r.db}`)
                                .join(', ')}
                            />
                          )}
                          {u.roles.length === 0 && (
                            <Text size="xs" c="dimmed">—</Text>
                          )}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="wrap">
                          {u.mechanisms.length === 0 ? (
                            <Text size="xs" c="dimmed">—</Text>
                          ) : (
                            u.mechanisms.map((m) => (
                              <RoleBadge key={m} label={shortMech(m)} />
                            ))
                          )}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} justify="flex-end" wrap="nowrap">
                          {!isSelf && (
                            <>
                              <ActionIcon
                                aria-label={`Edit user ${u.username}`}
                                variant="subtle"
                                color="gray"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDrawerMode({ kind: 'edit', user: u });
                                }}
                                title="Edit"
                              >
                                {I.edit}
                              </ActionIcon>
                              <ActionIcon
                                aria-label={`Drop user ${u.username}`}
                                variant="subtle"
                                color="red"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDropTarget(u);
                                  setDropReturnFocus(scrollRegionRef.current);
                                }}
                                title="Drop"
                              >
                                {I.trash}
                              </ActionIcon>
                            </>
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>

                    {open && (
                      <Table.Tr>
                        <Table.Td
                          colSpan={5}
                          style={{
                            background: T.surfaceRaised,
                            paddingLeft: 38,
                          }}
                        >
                          <Stack gap={6} py={4}>
                            <Text size="xs" c="dimmed">
                              <span style={{ color: T.textMuted }}>External</span>
                              {' · '}
                              {u.external ? 'yes' : 'no'}
                            </Text>
                            <Text size="xs" c="dimmed">
                              <span style={{ color: T.textMuted }}>Mechanisms</span>
                              {' · '}
                              {u.mechanisms.length > 0 ? u.mechanisms.join(', ') : '—'}
                            </Text>
                            <Text size="xs" c="dimmed">
                              <span style={{ color: T.textMuted }}>Roles</span>
                              {' · '}
                              {u.roles.length > 0
                                ? u.roles.map(roleLabel).join(', ')
                                : '—'}
                            </Text>
                            {u.customData && (
                              <Text
                                size="xs"
                                c="dimmed"
                                style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}
                              >
                                <span style={{ color: T.textMuted, fontFamily: 'inherit' }}>
                                  customData
                                </span>
                                {' · '}
                                {u.customData}
                              </Text>
                            )}
                          </Stack>
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </React.Fragment>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </div>

      {drawerMode && (drawerMode.kind === 'edit' || picked !== ALL_DBS) && (
        <UserDrawer
          mode={drawerMode}
          connectionId={conn.id}
          dbName={drawerMode.kind === 'edit' ? drawerMode.user.db : picked}
          onCancel={() => setDrawerMode(null)}
          onSaved={() => {
            setDrawerMode(null);
            void loadUsers();
          }}
        />
      )}

      {dropTarget && (
        <DropUserDialog
          user={dropTarget}
          connectionId={conn.id}
          onCancel={() => setDropTarget(null)}
          onDropped={() => {
            setDropTarget(null);
            void loadUsers();
          }}
          returnFocusTo={dropReturnFocus}
        />
      )}
    </div>
  );
}

function roleLabel(r: UserRoleRef): string {
  return `${r.role}@${r.db}`;
}

// ─── Create / Edit drawer ──────────────────────────────────────────────────

function UserDrawer({
  mode,
  connectionId,
  dbName,
  onCancel,
  onSaved,
}: {
  mode: { kind: 'create' } | { kind: 'edit'; user: UserInfo };
  connectionId: string;
  dbName: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const T = themeVars;
  const editing = mode.kind === 'edit';
  const editedUser = mode.kind === 'edit' ? mode.user : null;
  const isExternal = editing && editedUser?.external === true;

  // Dismiss paths only — `onSaved` hands off to the refreshed user list.
  const close = useDialogFocusReturn(onCancel);

  /**
   * X15 §2 — every `useState` below seeds from this one snapshot, so the seed
   * and the dirty comparison cannot drift. It has to be a snapshot rather than
   * a set of literals because **edit mode opens pre-filled**: comparing against
   * `''` would report the form dirty the instant it opened and prompt on every
   * clean Cancel. Dirtiness is "differs from initial", never "was touched".
   */
  const [initial] = React.useState(() => ({
    username: editedUser?.username ?? '',
    roles: editedUser?.roles ? [...editedUser.roles] : [],
    scram256: !editedUser || editedUser.mechanisms.includes('SCRAM-SHA-256'),
    scram1: Boolean(editedUser?.mechanisms.includes('SCRAM-SHA-1')),
    customData: editedUser?.customData ?? '',
    customDataEnabled: Boolean(editedUser?.customData),
  }));

  const [username, setUsername] = React.useState(initial.username);
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [roles, setRoles] = React.useState<UserRoleRef[]>(initial.roles);
  const [scram256, setScram256] = React.useState(initial.scram256);
  const [scram1, setScram1] = React.useState(initial.scram1);
  const [customData, setCustomData] = React.useState(initial.customData);
  const [customDataEnabled, setCustomDataEnabled] = React.useState(initial.customDataEnabled);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The disjunction over EVERY field, not the focused one: fill in a password
  // and a role, clear the username, dismiss, and a check reading only the
  // username reports clean while the rest is lost. Both booleans compare
  // against `initial` rather than being bare-truthy — `scram256` opens `true`
  // in create mode, so `scram256 ||` would prompt on every clean Cancel.
  const isDirty =
    username !== initial.username ||
    password !== '' ||
    confirm !== '' ||
    JSON.stringify(roles) !== JSON.stringify(initial.roles) ||
    scram256 !== initial.scram256 ||
    scram1 !== initial.scram1 ||
    customData !== initial.customData ||
    customDataEnabled !== initial.customDataEnabled;

  const requestClose = async () => {
    if (!isDirty) return close();
    const discard = await confirmDestructive({
      title: 'Discard changes?',
      body: 'This closes the editor and loses what you typed.',
      confirmLabel: 'Discard',
    });
    if (discard) close();
  };

  const submit = async () => {
    if (submitting) return;
    setError(null);
    if (!editing && username.trim().length === 0) {
      setError('Username is required.');
      return;
    }
    if (!editing && !isExternal) {
      if (password.length === 0) {
        setError('Password is required.');
        return;
      }
      if (password !== confirm) {
        setError('Passwords do not match.');
        return;
      }
    }
    if (editing && !isExternal && password.length > 0 && password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (roles.length === 0) {
      setError('At least one role is required.');
      return;
    }
    if (customDataEnabled && customData.trim()) {
      try {
        JSON.parse(customData);
      } catch {
        setError('customData: invalid JSON.');
        return;
      }
    }
    const mechanisms: AuthMechanism[] = [];
    if (scram256) mechanisms.push('SCRAM-SHA-256');
    if (scram1) mechanisms.push('SCRAM-SHA-1');
    // The role rows warn on trimmed names; send what they checked.
    const trimmedRoles = roles.map((r) => ({ role: r.role.trim(), db: r.db.trim() }));

    setSubmitting(true);
    try {
      if (editing && editedUser) {
        const patch: UserUpdateInput['patch'] = { roles: trimmedRoles };
        if (!isExternal && password.length > 0) patch.password = password;
        if (!isExternal && mechanisms.length > 0) patch.mechanisms = mechanisms;
        if (customDataEnabled) patch.customData = customData || '{}';
        await api.user.update({
          connectionId,
          dbName: editedUser.db,
          username: editedUser.username,
          patch,
        });
      } else {
        const create: UserCreateInput = {
          connectionId,
          dbName,
          username: username.trim(),
          password,
          roles: trimmedRoles,
          mechanisms: mechanisms.length > 0 ? mechanisms : ['SCRAM-SHA-256'],
        };
        if (customDataEnabled && customData.trim()) create.customData = customData;
        await api.user.create(create);
      }
      onSaved();
    } catch (err) {
      setError(isIpcError(err) ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // X15 §2 — the backdrop is inert: it does not close and it does not prompt.
    // Escape goes through the guard.
    <Drawer
      opened
      onClose={() => void requestClose()}
      position="right"
      size={400}
      title={
        editing ? `Edit user — ${editedUser?.username} (${editedUser?.db})` : `New user (${dbName})`
      }
      padding="md"
      closeOnClickOutside={false}
      // see the note in `IndexesTab.tsx`. Without the column context the
      // `flex: 1` on the scroll region below is ignored, so a long role list
      // grows the body past the drawer and pushes the Cancel / Save footer off
      // the bottom rather than scrolling; `minHeight: 0` is what lets the body
      // bound it. Uncovered by the component suite — jsdom does no layout.
      styles={{
        content: { display: 'flex', flexDirection: 'column' },
        body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
      }}
    >
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {!editing && (
          <DrawerSection title="Username">
            <input
              aria-label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              style={drawerInputStyle(T)}
            />
          </DrawerSection>
        )}

        {isExternal && (
          <div
            style={{
              padding: '8px 10px',
              borderRadius: T.rs,
              border: `1px solid ${T.borderMed}`,
              background: T.surfaceRaised,
              color: T.textMuted,
              fontSize: 11,
              lineHeight: 1.5,
            }}
          >
            External users are managed via your auth provider. L'Atelier only supports editing
            roles.
          </div>
        )}

        {!isExternal && (
          <DrawerSection title="Password">
            {/* Mantine's reveal toggle is out of the tab order by default;
                `visibilityToggleFocusable` puts it back so the keyboard can
                reach it. It is a toggle button: the name stays fixed and
                Mantine's aria-pressed carries the state — a name that flipped
                to "Hide" would announce as "Hide password, pressed". */}
            <PasswordInput
              aria-label="Password"
              size="xs"
              spellCheck={false}
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              placeholder={editing ? 'Leave blank to keep current password' : ''}
              visibilityToggleFocusable
              visibilityToggleButtonProps={{ 'aria-label': 'Show password' }}
            />
            <PasswordInput
              aria-label="Confirm password"
              size="xs"
              mt={6}
              spellCheck={false}
              value={confirm}
              onChange={(e) => setConfirm(e.currentTarget.value)}
              placeholder="Confirm"
              visibilityToggleFocusable
              visibilityToggleButtonProps={{ 'aria-label': 'Show confirm password' }}
            />
          </DrawerSection>
        )}

        <DrawerSection title="Roles">
          <RoleRowsEditor
            connectionId={connectionId}
            defaultDb={dbName}
            rows={roles}
            onChange={setRoles}
          />
        </DrawerSection>

        {!isExternal && (
          <DrawerSection title="Mechanisms">
            <DrawerCheck label="SCRAM-SHA-256" checked={scram256} onChange={setScram256} />
            <DrawerCheck label="SCRAM-SHA-1" checked={scram1} onChange={setScram1} />
          </DrawerSection>
        )}

        <DrawerSection title="Custom data">
          <DrawerCheck
            label="Set customData"
            checked={customDataEnabled}
            onChange={setCustomDataEnabled}
          />
          {customDataEnabled && (
            <textarea
              aria-label="customData"
              value={customData}
              onChange={(e) => setCustomData(e.target.value)}
              rows={3}
              placeholder="{}"
              style={{ ...drawerInputStyle(T), fontFamily: 'monospace', resize: 'vertical' }}
            />
          )}
        </DrawerSection>

        {error && (
          <div
            role="alert"
            style={{
              padding: '8px 10px',
              borderRadius: T.rs,
              border: `1px solid ${T.warn}`,
              background: 'rgba(184,76,20,0.08)',
              color: T.warn,
              fontSize: 11,
            }}
          >
            {error}
          </div>
        )}
      </div>

      <div
        style={{
          paddingTop: 12,
          borderTop: `1px solid ${T.border}`,
          display: 'flex',
          gap: 8,
          justifyContent: 'flex-end',
        }}
      >
        <Button
          variant="subtle"
          size="compact-xs"
          onClick={() => void requestClose()}
          disabled={submitting}
        >
          Cancel
        </Button>
        <SubmitButton variant="filled" size="compact-xs" onClick={() => void submit()} submitting={submitting}>
          {submitting ? 'Saving…' : editing ? 'Save user' : 'Create user'}
        </SubmitButton>
      </div>
    </Drawer>
  );
}

function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  const T = themeVars;
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: T.textMuted,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function DrawerCheck({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const T = themeVars;
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        color: T.text,
        marginBottom: 4,
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: T.accent }}
      />
      <span>{label}</span>
    </label>
  );
}

function drawerInputStyle(T: typeof themeVars): React.CSSProperties {
  return {
    width: '100%',
    border: `1px solid ${T.border}`,
    borderRadius: T.rs,
    padding: '4px 8px',
    fontSize: 12,
    color: T.text,
    background: T.surfaceRaised,
    outline: 'none',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  };
}

// ─── Drop confirm dialog ───────────────────────────────────────────────────

function DropUserDialog({
  user,
  connectionId,
  onCancel,
  onDropped,
  returnFocusTo,
}: {
  user: UserInfo;
  connectionId: string;
  onCancel: () => void;
  onDropped: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  const close = useDialogFocusReturn(onCancel);
  // Separate call on purpose, not a shared one with `close` above: `close`
  // keeps the render-time captured trigger — the "Drop user" `ActionIcon`
  // still exists after a Cancel and is the better target there. `finish`
  // needs the scroll container instead, because the row (and its ActionIcon)
  // is gone by the time a successful drop reloads the list. This call's own
  // `useState` capture of `document.activeElement` is dead weight since
  // `returnFocusTo` always wins when passed — don't collapse these into one.
  const finish = useDialogFocusReturn(onDropped, returnFocusTo);
  const [typed, setTyped] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const matches = typed === user.username;

  const submit = async () => {
    if (!matches || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.user.drop({ connectionId, dbName: user.db, username: user.username });
      finish();
    } catch (err) {
      setError(isIpcError(err) ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      opened
      onClose={close}
      title={`Drop user "${user.username}" on ${user.db}?`}
      centered
      size="md"
      aria-label="Drop user"
    >
      <Stack gap="sm">
        <Text size="xs" c="dimmed" lh={1.5}>
          This is permanent. Apps using these credentials will fail to authenticate.
        </Text>
        <Stack gap={6}>
          <Text size="xs" c="dimmed">
            Type the username to confirm:
          </Text>
          <TextInput
            aria-label="Confirm username"
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
            size="xs"
            styles={{ input: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' } }}
          />
        </Stack>
        {error && (
          <Alert color="red" variant="light" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" size="compact-xs" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <SubmitButton variant="filled" color="red" size="compact-xs" onClick={() => void submit()} disabled={!matches} submitting={submitting}>
            {submitting ? 'Dropping…' : 'Drop'}
          </SubmitButton>
        </Group>
      </Stack>
    </Modal>
  );
}
