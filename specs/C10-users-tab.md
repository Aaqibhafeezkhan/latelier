# C10 — Users tab (real listing + create / update / drop)

> **Status: Implemented.**

## Purpose

Replace the C08 `StubTab` for the Users tab in `DetailPanel.tsx` with a real database-user manager. Lists users defined on the server (per database, plus `admin`), shows their roles, and supports create / update / delete with the same safety posture as C03 connections — passwords go through `safeStorage`-encrypted *transport* (the same `SECRET_INPUT` allowlist mechanism used by `conn:create`) and never persist on disk client-side.

This is intentionally limited: MongoDB exposes a rich auth model (custom roles, role inheritance, X.509 user mapping, awsiam, OIDC, Kerberos). Iteration 1 covered the common case — SCRAM users with built-in roles — and surfaces the rest as read-only when present. Custom roles have since moved in scope: the Roles tab (§4a) creates, edits and drops them.

## Scope

- **In**: `user:list`, `user:get`, `user:create`, `user:update`, `user:drop`, `role:list`, the `UsersTab` component, create/edit drawer, two-step delete confirm.
- **In**: custom role creation / editing — `role:create`, `role:update`, `role:drop`, the `RolesTab` component (§4a), and the role-name picker in the user drawer that lists both built-in and custom roles.
- **Out**:
  - X.509 / awsiam / OIDC / Kerberos user creation. The list view shows mechanism badges for these so the user knows they exist; editing them is read-only with an explanatory hint.
  - Per-cluster user (Atlas Database User). Atlas-managed users live in the Atlas API, not in `system.users`. Out of scope.
  - Password rotation reminders / audit log.
  - LDAP-mapped users.

## Dependencies

- C05 (selected connection state), C08 (the stub being replaced), F03 (`SecretsVault` is *not* used here — passwords are submitted to MongoDB and never persisted by us), F05 (MongoPool).
- New entries in `shared/ipc.ts`, `shared/types.ts`, `electron/preload.ts`, `electron/main.ts` registration.
- New entry in `scripts/ipc-secret-allowlist.txt` for `user:create` and `user:update` (both accept plaintext `password`).

## 1. Types

```ts
// shared/types.ts (additions)

export type AuthMechanism =
  | 'SCRAM-SHA-1'
  | 'SCRAM-SHA-256'
  | 'MONGODB-X509'
  | 'PLAIN'
  | 'GSSAPI'
  | 'MONGODB-AWS'
  | 'MONGODB-OIDC';

export interface UserRoleRef {
  /** Role name. Built-in examples: 'read', 'readWrite', 'dbAdmin', 'root'. */
  role: string;
  /** Database the role applies to. May differ from the user's home db. */
  db: string;
}

export interface UserInfo {
  /** Storage db (where the user record lives — typically the auth db). */
  db: string;
  username: string;
  /**
   * Mechanism list as configured on the user. SCRAM-SHA-1 / -256 are the
   * password-based ones. Anything else means the user authenticates via
   * external mechanism — UI restricts editing in that case.
   */
  mechanisms: AuthMechanism[];
  roles: UserRoleRef[];
  /** Server-set: user-defined arbitrary metadata. Pass-through EJSON. */
  customData?: string;
  /** True when the user is *only* configured for non-password mechanisms. */
  external: boolean;
}

export interface RoleInfo {
  role: string;
  db: string;
  isBuiltin: boolean;
  /** Direct parents only — what `createRole`/`updateRole` take as `roles`. */
  roles: UserRoleRef[];
  /** Transitive closure of `roles`, as listed by the server. Display only. */
  inheritedRoles: UserRoleRef[];
  /** EJSON canonical array of the role's own (non-inherited) privileges. */
  privileges?: string;
}

export interface RoleCreateInput {
  connectionId: string;
  dbName: string;
  role: string;
  /** EJSON canonical array of privilege documents; may be `[]`. */
  privileges: string;
  /** Inherited roles; may be empty, unlike a user's roles. */
  roles: UserRoleRef[];
}

export interface RoleUpdateInput {
  connectionId: string;
  dbName: string;
  role: string;
  /** Each present field replaces the server's list; an empty patch is VALIDATION. */
  patch: { privileges?: string; roles?: UserRoleRef[] };
}

export interface RoleDropInput {
  connectionId: string;
  dbName: string;
  role: string;
}

export interface UserCreateInput {
  connectionId: string;
  /** DB the user is created against (the auth db; users authenticate against this db). */
  dbName: string;
  username: string;
  /** Plaintext — encrypted in transport by Electron contextBridge but NEVER persisted by MongoLab. */
  password: string;
  roles: UserRoleRef[];
  /** Defaults to ['SCRAM-SHA-256'] if omitted. */
  mechanisms?: AuthMechanism[];
  /** EJSON canonical string. */
  customData?: string;
}

export interface UserUpdateInput {
  connectionId: string;
  dbName: string;
  username: string;
  patch: {
    /** Replaces the role array if present. */
    roles?: UserRoleRef[];
    /** Plaintext — same caveat as create. Omit to leave unchanged. */
    password?: string;
    /** EJSON canonical string. Omit to leave unchanged. */
    customData?: string;
    /** Replaces the mechanism list. SCRAM-only edits are supported. */
    mechanisms?: AuthMechanism[];
  };
}

export interface UserDropInput {
  connectionId: string;
  dbName: string;
  username: string;
}
```

## 2. IPC contract

| Channel        | Input              | Output                | Notes                                          |
| -------------- | ------------------ | --------------------- | ---------------------------------------------- |
| `user:list`    | `{ connectionId, dbName? }` | `UserInfo[]` | `dbName` omitted → `usersInfo: 1, forAllDBs: true` against `admin`. Otherwise scoped to `dbName`. |
| `user:get`     | `{ connectionId, dbName, username }` | `UserInfo` | Convenience for refresh. |
| `user:create`  | `UserCreateInput`  | `{ ok: true }`        | **`SECRET_INPUT`** — accepts plaintext password. |
| `user:update`  | `UserUpdateInput`  | `{ ok: true }`        | **`SECRET_INPUT`** — accepts plaintext password. |
| `user:drop`    | `UserDropInput`    | `{ dropped: true }`   |                                                |
| `role:list`    | `{ connectionId, dbName }` | `RoleInfo[]` | Powers the role picker and the Roles tab. Pulls built-in + custom from the given db, with `showPrivileges: true`.  |
| `role:create`  | `RoleCreateInput`  | `{ ok: true }`        | Write grant (read-only connections refuse). Not `SECRET_INPUT`. |
| `role:update`  | `RoleUpdateInput`  | `{ ok: true }`        | Write grant. Not `SECRET_INPUT`.               |
| `role:drop`    | `RoleDropInput`    | `{ dropped: true }`   | Write grant. Not `SECRET_INPUT`.               |

Channel name registry additions in `shared/ipc.ts`:

```ts
userList:   'user:list',
userGet:    'user:get',
userCreate: 'user:create', // SECRET_INPUT
userUpdate: 'user:update', // SECRET_INPUT
userDrop:   'user:drop',
roleList:   'role:list',
roleCreate: 'role:create',
roleUpdate: 'role:update',
roleDrop:   'role:drop',
```

The three role write channels register in the same `registerUserChannels` as the user channels. Like the `user:*` writes they are not audited (ADR 0002).

`scripts/ipc-secret-allowlist.txt` additions:

```
user:create
user:update
```

`IpcApi` gains:

```ts
user: {
  list:   (input: { connectionId: string; dbName?: string }) => Promise<UserInfo[]>;
  get:    (input: { connectionId: string; dbName: string; username: string }) => Promise<UserInfo>;
  create: (input: UserCreateInput) => Promise<{ ok: true }>;
  update: (input: UserUpdateInput) => Promise<{ ok: true }>;
  drop:   (input: UserDropInput)   => Promise<{ dropped: true }>;
};
role: {
  list: (input: { connectionId: string; dbName: string }) => Promise<RoleInfo[]>;
};
```

## 3. Service (main)

```ts
// electron/mongo/UserService.ts

export class UserService {
  constructor(private pool: MongoPool) {}

  async list(input): Promise<UserInfo[]> {
    const client = await this.pool.getClient(input.connectionId);
    const db = client.db(input.dbName ?? 'admin');
    const cmd = input.dbName
      ? { usersInfo: 1, showCredentials: false }
      : { usersInfo: 1, showCredentials: false, forAllDBs: true };
    try {
      const res = (await db.command(cmd)) as { users: ServerUser[] };
      return res.users.map(toUserInfo);
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  async create(input): Promise<{ ok: true }> {
    validateUsername(input.username);
    validatePassword(input.password); // length >= 1; no other constraint client-side
    validateRoles(input.roles);
    const customData = input.customData ? ejsonParse(input.customData) : undefined;
    const db = (await this.pool.getClient(input.connectionId)).db(input.dbName);
    try {
      await db.command({
        createUser: input.username,
        pwd: input.password,
        roles: input.roles,
        mechanisms: input.mechanisms ?? ['SCRAM-SHA-256'],
        ...(customData ? { customData } : {}),
      });
      return { ok: true };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  async update(input): Promise<{ ok: true }> {
    const { username, dbName, patch } = input;
    const cmd: Record<string, unknown> = { updateUser: username };
    if (patch.password !== undefined) {
      validatePassword(patch.password);
      cmd.pwd = patch.password;
    }
    if (patch.roles !== undefined) {
      validateRoles(patch.roles);
      cmd.roles = patch.roles;
    }
    if (patch.mechanisms !== undefined) cmd.mechanisms = patch.mechanisms;
    if (patch.customData !== undefined) cmd.customData = ejsonParse(patch.customData);
    if (Object.keys(cmd).length === 1) {
      throw new ValidationError('patch is empty', { username });
    }
    const db = (await this.pool.getClient(input.connectionId)).db(dbName);
    try {
      await db.command(cmd);
      return { ok: true };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  async drop(input): Promise<{ dropped: true }> {
    const db = (await this.pool.getClient(input.connectionId)).db(input.dbName);
    try {
      await db.command({ dropUser: input.username });
      return { dropped: true };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  async listRoles(input): Promise<RoleInfo[]> {
    const db = (await this.pool.getClient(input.connectionId)).db(input.dbName);
    try {
      const res = (await db.command({
        rolesInfo: 1,
        showBuiltinRoles: true,
      })) as { roles: ServerRole[] };
      return res.roles.map(toRoleInfo);
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }
}
```

Wired into `electron/main.ts` like the other services.

### Password handling

- `password` reaches main as a JS string (Electron contextBridge already runs in process; no plaintext on disk).
- `UserService` passes it directly to `db.command({ createUser / updateUser, pwd })`.
- The driver wire protocol always tunnels password fields as part of an authenticated session over TLS (when configured) — same envelope MongoDB itself uses.
- **Never** logged. `electron/log.ts` already redacts known field names; add `'pwd'` and `'password'` to the redaction list as part of this spec's implementation. Verify with a unit test that captures the logger output for a `createUser` call.
- **Never** echoed in error messages. `classifyMongoOpError` strips the `pwd` field from any included document before serialisation.
- `UserCreateInput` / `UserUpdateInput.patch` carry the password but neither IPC handler stores them — once the Mongo command returns, the value is dropped by the GC.

### Error classification

| Mongo code / class                   | IPC code        | Surfacing                                                |
| ------------------------------------ | --------------- | -------------------------------------------------------- |
| Unauthorized / 13                    | `UNAUTHORIZED`  | Banner: "This connection lacks permissions to manage users." |
| UserAlreadyExists / 51003            | `CONFLICT`      | Inline form error.                                       |
| UserNotFound / 11                    | `NOT_FOUND`     | Toast (most common: drop on a row that's already gone).  |
| RoleNotFound / 31                    | `VALIDATION`    | Inline form error on the role picker.                    |
| BadValue / 2 (e.g., empty password)  | `VALIDATION`    | Inline form error.                                       |
| anything else                        | `MONGO_ERROR`   | Inline banner.                                           |

## 4. Renderer — `UsersTab` component

Replaces `<StubTab title="User management" .../>` at `DetailPanel.tsx:641`.

### Layout

```
┌─ Search row ──────────────────────────────────────────────────────┐
│ [Database ▾]  [Filter users…]   [+ New user]   [⟳ Refresh]        │
├───────────────────────────────────────────────────────────────────┤
│ Username       Auth db    Roles                       Mechs       │
│ ───────────────────────────────────────────────────────────────── │
│ readonly       myapp      readWrite@myapp             SCRAM-256   │
│ admin          admin      root@admin                  SCRAM-256   │
│ ci             admin      readWrite@app, read@logs    SCRAM-256   │
│ x509-client    $external  readAnyDatabase@admin       MONGODB-X509│
│ …                                                                 │
└───────────────────────────────────────────────────────────────────┘
```

- DB picker:
  - Default: `All databases` → `user:list({ connectionId })` (forAllDBs).
  - Otherwise scoped to a single DB. Same `ui.showSystemDbs` toggle as Collections / Indexes; when off, picker still shows `admin` because that's where most users live.
- Last picked DB persists in `app_state['ui.users.lastDb']` (string or `'all'`).

### Row anatomy

- **Username**: 12 px, monospace.
- **Auth db**: 11 px muted. `$external` users get a small badge.
- **Roles**: comma-separated `Pill`s, each `role@db`. Truncate at 4; the rest in a tooltip.
- **Mechs**: `Pill`s. Multiple SCRAM versions stack.
- Trailing actions: `Edit`, `Drop` icon buttons. Both hidden for the user the *current connection itself authenticates as* — dropping or rotating yourself out is a foot-gun we refuse without a hard escape hatch (a v2 toggle).

### Drill-down details

Clicking a row toggles an inline expander showing:
- All roles (no truncation).
- `customData` JSON (if any), pretty-printed with the same EJSON renderer the doc views use.
- Mechanism list verbatim.

### Empty / error states

- Connection not connected → reuse the "Not connected" copy from CollectionsTab.
- `user:list` UNAUTHORIZED → amber banner: "This connection lacks the privilege to read users on {db}." Plus a hint: "Roles like `userAdminAnyDatabase` are required."
- `user:list` returned `[]` → "No users defined on {db}." with a `+ New user` CTA.

### Create / Edit drawer

Right-side drawer (400 px), reuses W08 drawer styling.

```
┌─ New user (myapp) ────────────────────────────┐
│ Username                                       │
│ [_______________________________________]      │
│                                                │
│ Password                                       │
│ [_______________________________________]      │
│ Confirm                                        │
│ [_______________________________________]      │
│                                                │
│ Roles                                          │
│ [+ Add role]                                   │
│   readWrite @ myapp           [×]              │
│   read       @ logs           [×]              │
│                                                │
│ Mechanisms                                     │
│ [✓] SCRAM-SHA-256                              │
│ [ ] SCRAM-SHA-1                                │
│                                                │
│ Custom data (EJSON)                            │
│ ┌────────────────────────────────────────┐    │
│ │ {}                                     │    │
│ └────────────────────────────────────────┘    │
│                                                │
│              [ Cancel ]  [ Create user ]       │
└────────────────────────────────────────────────┘
```

- Each role row is a role-name `Autocomplete` and a db field. The suggestions come from `role:list({ connectionId, dbName })` for that row's db: fetched once per distinct db (the drawer's own db at open, a db typed into a row after a 300 ms debounce) and cached for the drawer's lifetime.
- A role name the loaded list lacks shows "Unknown role on {db}" under the row. It warns and never blocks the save. When `role:list` fails (usually a missing privilege) no warning is shown for that db.
- Password and Confirm are Mantine `PasswordInput`s. Each reveal toggle is in the tab order (`visibilityToggleFocusable`) and is a toggle button with a fixed name ("Show password", "Show confirm password") whose state is carried by `aria-pressed`.
- Edit mode: drawer reads "Edit user — `{username}` (auth db `{db}`)". Username and auth db are immutable. Password fields read "Leave blank to keep current password."
- External (X.509 / awsiam / OIDC) users → drawer reads "External users are managed via your auth provider. MongoLab only supports editing roles." Password fields hidden; mechanism toggles disabled.
- Validation:
  - Username: 1–128 chars, no NUL byte, no `\x00`.
  - Password: 1–4096 chars. Confirm matches.
  - At least one role.
  - `customData`: valid EJSON.

Submit calls `api.user.create` / `api.user.update`. On success: close drawer, refetch list, toast `User "{username}" created` / `…updated`. Form-level errors (CONFLICT / VALIDATION) keep the drawer open with inline copy.

### Drop confirm dialog

Two-step like W08 / C09:

```
Drop user "ci" on admin?
This is permanent. Apps using these credentials will fail to authenticate.

Type the username to confirm:
[__________________________________________]
                                [ Cancel ] [ Drop ]
```

`Drop` button disabled until the typed text equals `username` exactly.

### Self-protection

- The DetailPanel knows the active connection's `auth_username` and `auth_database`. The `UsersTab` reads them and hides Edit/Drop buttons on the row that matches. A subtle inline pill reads "← this connection".
- This is UI-only; main does not refuse self-drop because in environments where a single shared user is expected to clean up after itself, that's a legitimate workflow. The UI nudge is enough.

## 4a. Roles tab

`DetailPanel` gains a fourth tab, **Roles**, rendering `RolesTab`.

- **Database picker.** Same `<select>` as the Users tab, sharing the `ui.users.lastDb` pref so both tabs follow the last database picked in either. `rolesInfo` has no all-databases form, so the Users tab's "All databases" value opens Roles on `admin`, and Roles offers no such option.
- **List.** One row per role: name, direct inherited roles (`role@db`), privilege count. Built-in roles are hidden behind a "Show built-in" checkbox (default off), carry a "built-in" badge, and are read-only — no Edit or Drop.
- **Create / Edit drawer.** Name (create only); inherited roles through the same role-row editor and Autocomplete as the user drawer (an empty list is allowed); privileges in a plain `Textarea` holding an EJSON array. The client refuses invalid EJSON or a non-array before calling. Edit seeds the inherited roles from `roles` (direct parents), never `inheritedRoles`, so a save does not flatten the hierarchy, and the `role:update` patch carries only the fields that differ from the seed. Role names and dbs are trimmed before sending, in both drawers. The drawer carries the X15 §2 unsaved-changes guard.
- **Drop** is type-to-confirm, the same tier as dropping a user (ADR 0013): the role name must be typed back before Drop enables. On success `role:drop`, refetch, and focus returns to the list region (the dropped row's button is gone).
- **Main.** `createRole` / `updateRole` / `dropRole` take `pool.write(connectionId)` before anything else (ADR 0005), send `maxTimeMS: STATS_TIMEOUT_MS`, parse `privileges` as EJSON and refuse a non-array with `VALIDATION`, and classify errors through `classifyMongoOpError`.

## 5. State & persistence

- No new SQLite tables. No migration.
- `app_state['ui.users.lastDb']: string | 'all'` persisted via existing `prefs:set`.
- Passwords never persist anywhere on the renderer or in main beyond the lifetime of a single `command()` call.

## 6. Error handling

| Source              | Surfacing                                           |
| ------------------- | --------------------------------------------------- |
| `user:list` UNAUTHORIZED | Amber banner with hint about required roles.   |
| `user:list` other err | Red banner with Retry.                            |
| `user:create` CONFLICT | Inline drawer error: "User '{name}' already exists on {db}." |
| `user:create` VALIDATION (RoleNotFound) | Inline error on the offending role row.       |
| `user:update` NOT_FOUND | Toast "User no longer exists" + refetch.        |
| `user:drop` NOT_FOUND   | Toast "User already dropped" + refetch.         |
| any UNAUTHORIZED on a write | Banner inside drawer; drawer stays open.    |

## 7. Acceptance criteria

- Users tab in `DetailPanel.tsx` no longer renders `StubTab`; renders the new `UsersTab` component.
- `All databases` listing returns every server-side user including those on `$external`.
- Per-database listing only returns users whose home db matches the picker.
- Creating a user with `readWrite@myapp` succeeds; the new row appears after refetch.
- Creating a duplicate user keeps the drawer open with a `CONFLICT` inline error.
- Editing a user's role list replaces it (verified server-side: old roles gone, new roles present).
- Editing with an empty password field leaves the password unchanged.
- Dropping a non-self user removes it after the two-step confirm.
- On the row matching `connection.auth_username` + `connection.auth_database`, Edit and Drop buttons are absent.
- `external: true` users open the drawer in role-only edit mode; password fields hidden.
- `npm run audit:ipc` passes with the two new entries (`user:create`, `user:update`) in `scripts/ipc-secret-allowlist.txt`.
- No log entry produced by a `createUser` / `updateUser` flow contains the plaintext password (verified by snapshot).
- The user drawer's role-name field suggests the roles `role:list` returns for the row's db; an unknown name warns inline without blocking the save; a failed list shows no warning.
- The password reveal toggles are reachable by Tab and toggle with Enter.
- The Roles tab lists a database's custom roles; built-ins appear only with "Show built-in" and have no Edit / Drop.
- Creating a role with privileges and inherited roles succeeds and the new row appears after refetch.
- Editing a role replaces its privileges and direct inherited roles; inherited-only (transitive) roles are never written back.
- Dropping a role happens only after its name is typed back; focus then lands on the list.
- `role:create`, `role:update` and `role:drop` are refused on a read-only connection with the ADR 0005 error, and non-array privileges give `VALIDATION`.

## 8. Test cases

### Unit
- **to-user-info.spec.ts** — server `usersInfo` shape → `UserInfo[]`; `external: true` when the user has only non-password mechanisms.
- **validate-username.spec.ts** — empty / NUL-byte / 129-char names rejected with `ValidationError`.
- **password-redaction.spec.ts** — `electron/log.ts` redaction list covers `pwd` and `password`; a logger spy receives `'<redacted>'` instead of the plaintext for a stubbed `createUser` log call.

### Integration (against `mongodb-memory-server` started with `--auth`)
- **list-users.spec.ts** — seed two users → `user:list` returns both; per-db scoping returns only the matching one.
- **create-update-drop.spec.ts** — full lifecycle: create → list shows it → update roles → list shows new roles → drop → list does not show it.
- **conflict.spec.ts** — duplicate create returns `CONFLICT`.
- **unauthorized.spec.ts** — connect as a user without `userAdminAnyDatabase` → `user:list` returns `UNAUTHORIZED`.
- **role-list.spec.ts** — `role:list` against `admin` returns `> 0` built-in roles plus any custom roles seeded.
- **user-service.spec.ts (custom roles)** — create / update / drop round-trip with privileges; `roles` is the direct parents while `inheritedRoles` is the closure; bad privileges give `VALIDATION`; a read-only connection refuses all three writes.
- **user-handlers.spec.ts** — zod for `role:create` / `role:update` / `role:drop` (empty inherited roles accepted, empty names rejected).

### Component
- **users-tab-render.spec.tsx** — mock `api.user` → component renders DB picker, table, and "this connection" pill on the matching row.
- **users-create-drawer.spec.tsx** — open drawer, fill, submit → `api.user.create` payload includes the typed password, role list, default mechanism `['SCRAM-SHA-256']`.
- **users-edit-drawer.spec.tsx** — open in edit mode, leave password blank, change one role, submit → patch contains `roles` but no `password`.
- **users-self-protection.spec.tsx** — for the row matching `auth_username + auth_database`, Edit and Drop buttons absent.
- **users-external.spec.tsx** — for an `$external` user, password fields hidden, mechanism toggles disabled.
- **users-drop-confirm.spec.tsx** — Drop button opens dialog; typing the wrong username keeps Drop disabled; typing the right one + Drop → `api.user.drop` called.
- **users-tab-role-picker.spec.tsx** — the Autocomplete lists roles from a mocked `role.list`; the unknown-role warning; the db-typed fetch is debounced; a failed list shows no warning; the password reveal toggle works by keyboard.
- **roles-tab.spec.tsx** — list with the built-in toggle; create; non-array privileges refused; edit seeded from direct parents; type-to-confirm drop and focus return.

### E2E
- **users-create-and-drop.e2e.ts** — open Users tab → All databases → New user → fill (`ci`, password, `read@app`) → Create → row appears → Drop → confirm → row gone.
- **users-unauthorized.e2e.ts** — connect as a user without privilege → Users tab renders the "lacks the privilege" banner and no rows.
- **conn-detail-roles.e2e.ts** — open the Roles tab → New role → fill name and privileges → Create → the role lists.

## 9. Implementation order

Three commits, each independently mergeable:

1. **Backend.** `UserService` + `user:list`, `user:get`, `role:list` only. Wire into `main.ts`. Tests: to-user-info unit, list-users integration, role-list integration. UI still renders `StubTab`.
2. **Read-only UI.** Replace `StubTab` with `UsersTab` showing the table + drill-down + self-protection pill. Persist `ui.users.lastDb`. Tests: users-tab-render, users-self-protection.
3. **Mutations.** Create / update / drop channels + drawer + drop-confirm dialog. Add `user:create` and `user:update` to `scripts/ipc-secret-allowlist.txt`. Add `pwd` / `password` to log redaction. Tests: password-redaction unit, create-update-drop + conflict integration, users-create-drawer + users-edit-drawer + users-drop-confirm component, full E2E.

## 10. Risks and mitigations

- **Plaintext password crossing IPC.** Mitigated by (a) `SECRET_INPUT` allowlist + audit script, (b) redacted logging, (c) error envelopes that strip `pwd` before serialisation. Same posture as `conn:create`. Reviewed by tests.
- **User drops themselves.** Mitigated by UI hiding the action on the matching row. Power users who want to anyway can open another connection authenticated as a sufficiently privileged user — that's a feature, not a bug.
- **Atlas managed users.** `usersInfo` against an Atlas cluster only returns server-side users, not Atlas-API-managed users. The empty-state copy nudges the user toward the Atlas console; we deliberately do not try to detect Atlas (out of scope per F05).
- **Custom-role inheritance display.** Custom roles can inherit from other custom roles arbitrarily deep. The Users tab displays only the immediate role array on a user, and the Roles tab shows each role's direct parents; the transitive `inheritedRoles` is carried on `RoleInfo` but not displayed. Not perfect, but sufficient for the common case.
- **`$external` mechanism mix.** A user can be configured for both SCRAM and X.509. `external: true` only when *all* mechanisms are non-password. This is a deliberate, documented heuristic; the alternative (allowing password edits when at least one SCRAM mech is present) is correct but harder to explain in copy. Re-evaluate after first user feedback.

## 11. Future work — call-outs

- **Per-cluster (Atlas) user view**: requires Atlas Admin API integration; large enough to be its own connection-type feature.
- **OIDC / Kerberos** create flows: blocked on us having a plausible test environment.
