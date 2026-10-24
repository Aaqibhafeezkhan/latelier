import React from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Drawer,
  Group,
  Modal,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { themeVars } from '../theme/themeVars';
import { I } from '../icons';
import { api, isIpcError } from '../api/atelier';
import { confirmDestructive } from '../utils/confirm';
import { ejsonParse, ejsonStringifyReadable } from '../utils/ejson';
import { SubmitButton } from '../components/SubmitButton';
import { useDialogFocusReturn } from '../hooks/useDialogFocusReturn';
import { RoleRowsEditor } from './RoleRowsEditor';
import type { DbInfo } from '@shared/ipc';
import type {
  ConnectionRuntime,
  ConnectionSummary,
  RoleInfo,
  RoleUpdateInput,
  UserRoleRef,
} from '@shared/types';

// Shared with UsersTab on purpose: both tabs follow the database last picked
// in either. UsersTab can store its "all databases" sentinel there, which has
// no meaning for roles — `rolesInfo` is per database — so it reads as admin.
const LAST_DB_KEY = 'ui.users.lastDb';
const USERS_ALL_DBS = '__all__';
const DEFAULT_DB = 'admin';

function privilegeCount(privileges: string | undefined): number | null {
  if (privileges === undefined) return null;
  const parsed = ejsonParse(privileges);
  return Array.isArray(parsed) ? parsed.length : null;
}

export function RolesTab({
  conn,
  runtime,
}: {
  conn: ConnectionSummary;
  runtime: ConnectionRuntime;
}) {
  const T = themeVars;
  const [dbs, setDbs] = React.useState<DbInfo[] | null>(null);
  const [picked, setPicked] = React.useState(DEFAULT_DB);
  const [roles, setRoles] = React.useState<RoleInfo[] | null>(null);
  const [showBuiltin, setShowBuiltin] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; code?: string } | null>(null);
  const [dbError, setDbError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [drawer, setDrawer] = React.useState<
    { kind: 'create' } | { kind: 'edit'; role: RoleInfo } | null
  >(null);
  const [dropTarget, setDropTarget] = React.useState<RoleInfo | null>(null);
  // Focus target after a successful drop: the dropped row and its Drop button
  // are gone, and Refresh is disabled while the list reloads (see UsersTab).
  const [dropReturnFocus, setDropReturnFocus] = React.useState<HTMLElement | null>(null);
  const scrollRegionRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    void api.prefs
      .get<string>(LAST_DB_KEY)
      .then((v) => v && v !== USERS_ALL_DBS && setPicked(v))
      .catch(() => { /* non-fatal: stay on admin */ });
  }, []);

  const loadDatabases = React.useCallback(async () => {
    if (runtime.status !== 'connected') return;
    try {
      setDbs(await api.meta.listDatabases({ connectionId: conn.id, includeSystem: true }));
      setDbError(null);
    } catch (err) {
      setDbError(isIpcError(err) ? err.message : String(err));
    }
  }, [conn.id, runtime.status]);

  // Only the latest request may write state, as in UsersTab.
  const latest = React.useRef(0);

  const loadRoles = React.useCallback(async () => {
    if (runtime.status !== 'connected') return;
    const id = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const rows = await api.role.list({ connectionId: conn.id, dbName: picked });
      if (id === latest.current) setRoles(rows);
    } catch (err) {
      if (id === latest.current) {
        setError(isIpcError(err) ? { message: err.message, code: err.code } : { message: String(err) });
        setRoles(null);
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
    void loadRoles();
    const request = latest;
    return () => {
      request.current++;
    };
  }, [loadRoles]);
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

  const dbNames = dbs?.map((d) => d.name) ?? [];
  if (!dbNames.includes(picked)) dbNames.unshift(picked);
  const visible = roles?.filter((r) => showBuiltin || !r.isBuiltin) ?? null;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
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
          {dbNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <Checkbox
          size="xs"
          label="Show built-in"
          checked={showBuiltin}
          onChange={(e) => setShowBuiltin(e.currentTarget.checked)}
        />
        <div style={{ flex: 1 }} />
        <Button size="compact-xs" variant="filled" onClick={() => setDrawer({ kind: 'create' })}>
          + New role
        </Button>
        <Button
          size="compact-xs"
          variant="subtle"
          onClick={() => void loadRoles()}
          leftSection={I.sync}
          disabled={loading}
        >
          Refresh
        </Button>
      </div>

      <div
        ref={scrollRegionRef}
        tabIndex={-1}
        role="region"
        aria-label="Roles"
        style={{ flex: 1, overflowY: 'auto' }}
      >
        {loading && !roles && (
          <div style={{ padding: 20, color: T.textMuted, fontSize: 13 }}>Loading roles…</div>
        )}

        {error && (
          <Alert role="alert" color="orange" variant="light" m="sm" styles={{ message: { fontSize: 12 } }}>
            <Text size="xs">
              {error.code === 'UNAUTHORIZED'
                ? `This connection lacks the privilege to read roles on ${picked}.`
                : error.message}
            </Text>
            <Button variant="subtle" size="compact-xs" mt={4} onClick={() => void loadRoles()}>
              Retry
            </Button>
          </Alert>
        )}

        {!error && visible && visible.length === 0 && (
          <div style={{ padding: 20, color: T.textMuted, fontSize: 13, textAlign: 'center' }}>
            {showBuiltin ? `No roles on ${picked}.` : `No custom roles on ${picked}.`}
          </div>
        )}

        {!error && visible && visible.length > 0 && (
          <Table
            striped
            withTableBorder
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
                <Table.Th>Role</Table.Th>
                <Table.Th>Inherits</Table.Th>
                <Table.Th>Privileges</Table.Th>
                <Table.Th style={{ width: 64 }} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {visible.map((r) => {
                const count = privilegeCount(r.privileges);
                return (
                  <Table.Tr key={`${r.db}.${r.role}`}>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <span style={{ fontFamily: 'monospace', color: T.text }}>{r.role}</span>
                        {r.isBuiltin && (
                          <Badge size="xs" variant="light" color="gray" style={{ textTransform: 'none' }}>
                            built-in
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {r.roles.length > 0 ? r.roles.map(roleLabel).join(', ') : '—'}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">{count ?? '—'}</Text>
                    </Table.Td>
                    <Table.Td>
                      {!r.isBuiltin && (
                        <Group gap={4} justify="flex-end" wrap="nowrap">
                          <ActionIcon
                            aria-label={`Edit role ${r.role}`}
                            variant="subtle"
                            color="gray"
                            size="sm"
                            onClick={() => setDrawer({ kind: 'edit', role: r })}
                            title="Edit"
                          >
                            {I.edit}
                          </ActionIcon>
                          <ActionIcon
                            aria-label={`Drop role ${r.role}`}
                            variant="subtle"
                            color="red"
                            size="sm"
                            onClick={() => {
                              setDropTarget(r);
                              setDropReturnFocus(scrollRegionRef.current);
                            }}
                            title="Drop"
                          >
                            {I.trash}
                          </ActionIcon>
                        </Group>
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </div>

      {drawer && (
        <RoleDrawer
          mode={drawer}
          connectionId={conn.id}
          dbName={drawer.kind === 'edit' ? drawer.role.db : picked}
          onCancel={() => setDrawer(null)}
          onSaved={() => {
            setDrawer(null);
            void loadRoles();
          }}
        />
      )}

      {dropTarget && (
        <DropRoleDialog
          role={dropTarget}
          connectionId={conn.id}
          onCancel={() => setDropTarget(null)}
          onDropped={() => {
            setDropTarget(null);
            void loadRoles();
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

function RoleDrawer({
  mode,
  connectionId,
  dbName,
  onCancel,
  onSaved,
}: {
  mode: { kind: 'create' } | { kind: 'edit'; role: RoleInfo };
  connectionId: string;
  dbName: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const editing = mode.kind === 'edit';
  const edited = mode.kind === 'edit' ? mode.role : null;
  const close = useDialogFocusReturn(onCancel);

  // X15 §2: every field seeds from one snapshot, and dirtiness is "differs
  // from it", so a clean Cancel on a pre-filled edit never prompts. The
  // inherited roles seed from the direct parents, never the transitive
  // `inheritedRoles` — saving those back would flatten the hierarchy.
  const [initial] = React.useState(() => ({
    name: edited?.role ?? '',
    roles: edited ? [...edited.roles] : [],
    privileges: edited?.privileges ? ejsonStringifyReadable(ejsonParse(edited.privileges), 2) : '[]',
  }));
  const [name, setName] = React.useState(initial.name);
  const [roles, setRoles] = React.useState<UserRoleRef[]>(initial.roles);
  const [privileges, setPrivileges] = React.useState(initial.privileges);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const isDirty =
    name !== initial.name ||
    privileges !== initial.privileges ||
    JSON.stringify(roles) !== JSON.stringify(initial.roles);

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
    if (!editing && name.trim() === '') {
      setError('Role name is required.');
      return;
    }
    let parsed: unknown;
    try {
      parsed = ejsonParse(privileges);
    } catch {
      setError('Privileges: invalid EJSON.');
      return;
    }
    if (!Array.isArray(parsed)) {
      setError('Privileges must be an array.');
      return;
    }
    if (roles.some((r) => r.role.trim() === '' || r.db.trim() === '')) {
      setError('Each inherited role needs a name and a database.');
      return;
    }
    // Trimmed here so what the server gets matches the checks above and
    // the row editor's unknown-role warning, which both compare trimmed.
    const trimmed = roles.map((r) => ({ role: r.role.trim(), db: r.db.trim() }));
    setSubmitting(true);
    try {
      if (edited) {
        // Each field goes only when it changed: a role listed without
        // privileges seeds the box with '[]', and sending that back would wipe
        // the server's list.
        const patch: RoleUpdateInput['patch'] = {};
        if (privileges !== initial.privileges) patch.privileges = privileges;
        if (JSON.stringify(trimmed) !== JSON.stringify(initial.roles)) patch.roles = trimmed;
        if (Object.keys(patch).length === 0) {
          close();
          return;
        }
        await api.role.update({ connectionId, dbName: edited.db, role: edited.role, patch });
      } else {
        await api.role.create({ connectionId, dbName, role: name.trim(), privileges, roles: trimmed });
      }
      onSaved();
    } catch (err) {
      setError(isIpcError(err) ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // X15 §2: the backdrop is inert; Escape goes through the guard.
    <Drawer
      opened
      onClose={() => void requestClose()}
      position="right"
      size={440}
      title={edited ? `Edit role — ${edited.role} (${edited.db})` : `New role (${dbName})`}
      padding="md"
      closeOnClickOutside={false}
      styles={{
        content: { display: 'flex', flexDirection: 'column' },
        body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
      }}
    >
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {!editing && (
          <TextInput
            label="Role name"
            size="xs"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        )}
        <div>
          <Text size="xs" fw={600} c="dimmed" mb={6}>
            Inherited roles
          </Text>
          <RoleRowsEditor
            connectionId={connectionId}
            defaultDb={dbName}
            rows={roles}
            onChange={setRoles}
          />
        </div>
        <Textarea
          label="Privileges"
          description='EJSON array, e.g. [{"resource": {"db": "app", "collection": ""}, "actions": ["find"]}]'
          size="xs"
          rows={8}
          resize="vertical"
          spellCheck={false}
          value={privileges}
          onChange={(e) => setPrivileges(e.currentTarget.value)}
          styles={{ input: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' } }}
        />
        {error && (
          <Alert role="alert" color="orange" variant="light" styles={{ message: { fontSize: 12 } }}>
            {error}
          </Alert>
        )}
      </div>
      <Group justify="flex-end" gap={8} pt={12} style={{ borderTop: `1px solid ${themeVars.border}` }}>
        <Button variant="subtle" size="compact-xs" onClick={() => void requestClose()} disabled={submitting}>
          Cancel
        </Button>
        <SubmitButton variant="filled" size="compact-xs" onClick={() => void submit()} submitting={submitting}>
          {submitting ? 'Saving…' : editing ? 'Save role' : 'Create role'}
        </SubmitButton>
      </Group>
    </Drawer>
  );
}

// ─── Drop confirm dialog ───────────────────────────────────────────────────

// ADR 0013: dropping a role destroys server data the way dropping a user
// does, so it takes the same type-the-name step as `DropUserDialog`.
function DropRoleDialog({
  role,
  connectionId,
  onCancel,
  onDropped,
  returnFocusTo,
}: {
  role: RoleInfo;
  connectionId: string;
  onCancel: () => void;
  onDropped: () => void;
  returnFocusTo: HTMLElement | null;
}) {
  // Two calls on purpose, as in DropUserDialog: Cancel returns to the Drop
  // button, which still exists; a successful drop returns to the list region.
  const close = useDialogFocusReturn(onCancel);
  const finish = useDialogFocusReturn(onDropped, returnFocusTo);
  const [typed, setTyped] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const matches = typed === role.role;

  const submit = async () => {
    if (!matches || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.role.drop({ connectionId, dbName: role.db, role: role.role });
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
      title={`Drop role "${role.role}" on ${role.db}?`}
      centered
      size="md"
      // The request is already out; dismissing now would hide a drop that still completes.
      closeOnEscape={!submitting}
      closeOnClickOutside={!submitting}
      withCloseButton={!submitting}
    >
      <Stack gap="sm">
        <Text size="xs" c="dimmed" lh={1.5}>
          This is permanent. Every user and role that holds it loses its privileges.
        </Text>
        <TextInput
          label="Type the role name to confirm:"
          aria-label="Confirm role name"
          autoFocus
          size="xs"
          value={typed}
          onChange={(e) => setTyped(e.currentTarget.value)}
          styles={{ input: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' } }}
        />
        {error && (
          <Alert color="red" variant="light" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" size="compact-xs" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <SubmitButton
            variant="filled"
            color="red"
            size="compact-xs"
            onClick={() => void submit()}
            disabled={!matches}
            submitting={submitting}
          >
            {submitting ? 'Dropping…' : 'Drop'}
          </SubmitButton>
        </Group>
      </Stack>
    </Modal>
  );
}
