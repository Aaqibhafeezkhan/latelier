# Security Policy

## Supported Versions

L'Atelier is a desktop app with one active line of development, not a library
with parallel maintained majors. Security fixes land on the latest release
only; there is no version-support matrix to publish.

## Reporting a Vulnerability

Report a vulnerability privately through GitHub: open the repo's **Security**
tab and use **Report a vulnerability** (private security advisory). Do not
open a public issue for a security report.

There is no fixed SLA. Expect an acknowledgement within a few days; the
maintainer will follow up with next steps once the report is triaged.

## Security model

What the app stores, what it can reach, and what it does and does not
guarantee. Every claim links to the code or document that implements it; where
a protection has a limit, the limit is stated next to it. This section
describes the current source tree, so check the link rather than the prose if
the two ever disagree.

### Process model

- **Renderer.** The window is created with `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true` and `webSecurity: true`, and
  DevTools are disabled in a packaged build
  ([electron/main.ts](electron/main.ts)). The renderer's only route to the
  outside world is the `window.atelier` bridge
  ([electron/preload.ts](electron/preload.ts)); the design is in
  [specs/X17-renderer-hardening.md](specs/X17-renderer-hardening.md).
- **Content-Security-Policy.** Served as a response header with
  `default-src 'self'`, `script-src 'self'` and `connect-src 'self'` in a
  packaged build; `object-src`, `frame-src`, `worker-src`, `base-uri` and
  `form-action` are `'none'`. `style-src` keeps `'unsafe-inline'` because the
  UI writes inline style attributes; the dev-server policy is looser
  ([contentSecurityPolicy in electron/main.ts](electron/main.ts)).
- **Windows, navigation, permissions.** Every `window.open` is denied, top-level
  navigation away from the app's own document is blocked, and `<webview>`
  attachment is blocked ([guardWebContents in electron/main.ts](electron/main.ts),
  [electron/security/appLocation.ts](electron/security/appLocation.ts)). The
  permission handlers deny everything except
  `clipboard-sanitized-write` ([electron/security/permissions.ts](electron/security/permissions.ts)).
  The packaged app's menu has no Reload or Toggle Developer Tools entry
  ([electron/security/appMenu.ts](electron/security/appMenu.ts)).
- **All I/O is in the main process.** MongoDB, SQLite, the filesystem, the
  keychain and child processes are reached only from main
  ([CLAUDE.md](CLAUDE.md) states the rule; the lint config forbids the renderer
  from importing `electron`, `mongodb` and Node built-ins such as `fs`,
  [eslint.config.js](eslint.config.js)).
- **IPC.** Every channel is registered through one router that first checks
  the sender is the app's own top-level frame at the app's own location, then
  runs a zod validator, and returns a typed error envelope
  ([electron/ipc/router.ts](electron/ipc/router.ts),
  [electron/ipc/senderGuard.ts](electron/ipc/senderGuard.ts)). Details that
  matter to a reviewer:
  - `prefs:set` and `prefs:get` accept only an allowlist of UI keys; security
    relevant keys are not writable from the renderer
    ([electron/ipc/prefKeys.ts](electron/ipc/prefKeys.ts)).
  - TLS CA, TLS client-certificate and SSH key paths, and data-import paths, are
    accepted only if main's own file dialog returned them; a typed path is
    refused ([electron/security/credentialPaths.ts](electron/security/credentialPaths.ts),
    [electron/ipc/handlers/data.ts](electron/ipc/handlers/data.ts)).
  - `app:openExternal` opens only `https:` URLs on `github.com` and
    `www.mongodb.com`, with no credentials or explicit port in the URL; the
    docs channel is narrower still (`www.mongodb.com/docs/`)
    ([electron/security/externalUrl.ts](electron/security/externalUrl.ts),
    [electron/ipc/handlers/app.ts](electron/ipc/handlers/app.ts),
    [electron/ipc/handlers/shell.ts](electron/ipc/handlers/shell.ts)).
  - A connection with an SSH tunnel enabled is rejected, because no tunnel is
    implemented ([electron/ipc/schemas/connection.ts](electron/ipc/schemas/connection.ts)).
    The dependency list carries no SSH client ([package.json](package.json)).

### Credentials

- Connection passwords, SSH passwords and SSH key passphrases are encrypted with
  Electron `safeStorage` (macOS Keychain, Windows DPAPI, Linux libsecret or
  KWallet). The encrypted bytes, not the key, are stored in the
  `connection_secrets` table of the app's SQLite database
  ([electron/secrets/SecretsVault.ts](electron/secrets/SecretsVault.ts),
  [specs/F03-secrets-vault.md](specs/F03-secrets-vault.md)). Anyone who can read
  the database file and also use that user's keychain can decrypt them.
- A stored secret is read only inside main, when a connection is opened
  ([electron/mongo/MongoPool.ts](electron/mongo/MongoPool.ts)). The renderer
  sees `hasPasswordStored`-style booleans, never the secret
  ([electron/mongo/ConnectionService.ts](electron/mongo/ConnectionService.ts)).
  The renderer does hold a password while the user is typing it into the form.
- If no keychain is available, saving a password is refused unless the user opts
  in to plaintext storage. The switch can be turned on only through a native
  confirmation dialog shown by main, not by the renderer's own UI or `prefs:set`
  ([electron/ipc/handlers/secrets.ts](electron/ipc/handlers/secrets.ts),
  [electron/main.ts](electron/main.ts)). Plaintext rows are flagged
  (`is_plaintext`) and stored as raw bytes in the same database.
- Linux: Electron reports a `basic_text` backend (a hardcoded key) when no
  keyring is reachable. The vault treats `basic_text` and `unknown` as "no
  keychain", so a Linux machine without a keyring takes the refuse-or-opt-in
  path above ([electron/secrets/keychainAvailability.ts](electron/secrets/keychainAvailability.ts)).
  Rows already encrypted under `basic_text` stay readable, but they are only
  obfuscated with a hardcoded key; re-enter or delete such connections' passwords.
- Logs and the diagnostic bundle redact secret-named keys at any depth and mask
  the userinfo of `mongodb://` and `mongodb+srv://` URIs found in strings
  ([electron/log.ts](electron/log.ts),
  [electron/services/DiagnosticService.ts](electron/services/DiagnosticService.ts)).
  This is key-name and URI matching, not a general scrubber of document data.
- TLS is on and certificate verification is on by default for a new connection
  ([src/features/connections/ConnectionForm.tsx](src/features/connections/ConnectionForm.tsx),
  [electron/mongo/uri.ts](electron/mongo/uri.ts)). Turning verification off, or
  turning TLS off for a host that is not local, shows a warning in the form and
  on the connection detail ([src/utils/hostLocality.ts](src/utils/hostLocality.ts));
  a pasted URI with `tlsAllowInvalidCertificates=true` is applied with a
  warning, while `tlsInsecure` and `tlsAllowInvalidHostnames` are not honoured
  ([electron/mongo/uri-parse.ts](electron/mongo/uri-parse.ts)).

### Local data

Everything lives in the Electron `userData` directory, named for the app
(`~/Library/Application Support/L'Atelier` on macOS). L'Atelier does not encrypt
the directory as a whole; rely on OS disk encryption (FileVault, BitLocker,
LUKS) for that. It does encrypt the database columns that hold values taken from
your MongoDB data, described below.

| What | Where | Retention |
| --- | --- | --- |
| Connection settings (host, port, auth mechanism and username, TLS options and file paths, read-only flag). Secrets are in their own table, see above. | `connections` in `latelier.db` ([001-init.sql](electron/db/migrations/001-init.sql)) | Until the connection is deleted; its secrets, saved and recent queries, audit rows and tabs go with it (`ON DELETE CASCADE`) |
| Saved queries and scripts | `saved_queries` | Until the user deletes them; no expiry |
| Recent queries (filter or pipeline text, duration, result count; no result documents) | `recent_queries` ([RecentQueryRepo.ts](electron/db/repositories/RecentQueryRepo.ts)) | Newest 200 per connection ([RecentQueryService.ts](electron/services/RecentQueryService.ts)) and 30 days ([MaintenanceService.ts](electron/services/MaintenanceService.ts)) |
| Recent filter values (values typed into the query builder for suggestions; never recorded for secret-named fields) | `recent_field_values` ([016-column-cipher.sql](electron/db/migrations/016-column-cipher.sql), [RecentFieldValueService.ts](electron/services/RecentFieldValueService.ts)) | Newest 50 per field and 30 days; "clear all" is available |
| Workspace tab layout (builder, query and script text, pagination, column widths) | `workspace_tabs.state_json` | Until the tab is closed; result documents are stripped before every write ([tabStateResults.ts](electron/services/tabStateResults.ts)) and were scrubbed from existing rows by [014-strip-persisted-results.sql](electron/db/migrations/014-strip-persisted-results.sql) |
| Operation audit log (which write ran, on what, when, how it ended; update and delete rows include the filter text, import rows the file name) | `audit_log` ([012-audit-log.sql](electron/db/migrations/012-audit-log.sql), [AuditService.ts](electron/services/AuditService.ts)) | 90 days ([MaintenanceService.ts](electron/services/MaintenanceService.ts)) |
| UI preferences, window bounds, reference rules | `app_state`, `reference_rules` | Until changed or the user resets them |
| The key that encrypts the columns described below, wrapped by the OS keychain | `column_keys` ([016-column-cipher.sql](electron/db/migrations/016-column-cipher.sql)) | Until "Reset protected data" |

- **Values from your MongoDB data are encrypted at rest.** Five columns — saved
  queries (`saved_queries.payload_json`), recent queries
  (`recent_queries.payload_json`), recent filter values
  (`recent_field_values.value`), audit rows (`audit_log.summary_json`) and tab
  state (`workspace_tabs.state_json`) — are stored as AES-256-GCM cells, each
  bound to its table, column and row so a cell moved elsewhere fails to decrypt
  ([electron/db/columnCipher.ts](electron/db/columnCipher.ts)). Recent filter
  values are padded so a short literal's length does not show, and are
  deduplicated on a keyed hash rather than the value. The key is in the
  `column_keys` table, wrapped by the OS keychain through the same `safeStorage`
  gate as connection passwords
  ([electron/db/columnKeyStore.ts](electron/db/columnKeyStore.ts)). Plaintext
  left by an older version is sealed on the first start after the upgrade,
  followed by a `VACUUM`; `temp_store = MEMORY` keeps that VACUUM's working
  copy off disk
  ([specs/X21-encryption-at-rest.md](specs/X21-encryption-at-rest.md)).
  If the keychain can no longer unwrap the key, startup stops with a dialog
  offering Quit or "Reset protected data" (deletes those five tables' rows and
  the key, keeps connections); a new key is never generated silently.

  What this does **not** cover:
  - **Code running as you.** Any process in your session can ask the keychain
    for the key, exactly as it can for the connection passwords.
  - **Backups taken before the upgrade** keep their plaintext. The upgrade
    erases it from the live file only; copies in Time Machine, File History or
    a copied `userData` folder are out of reach.
  - **Schema names.** Database, collection and field names, reference rules
    and schema paths inside tab state stay plaintext: they are what lookups
    filter on.
  - **Linux without a usable keychain.** With no keyring (or only the
    `basic_text` backend), the key is stored unwrapped next to the data, so the
    data is obfuscated, not protected. Settings says so; the key is wrapped on
    the first start where a keychain is available.
  - The WAL truncate after the upgrade sets the file length to zero without
    overwriting the freed blocks; a filesystem snapshot taken in that window
    can keep them.
- **Query results are not persisted.** They live in renderer memory only
  (see the tab-layout row above); exports and imports write or read only the
  files the user picks.
- **Undo data is session-only.** The before-and-after copies of edited documents
  that Undo needs are held in main-process memory, capped at 200 per connection
  and 64 MiB in total, oldest first, and are gone on quit. Nothing is written to
  disk, and the `undo_json` column is always NULL; migration
  [015-null-undo-json.sql](electron/db/migrations/015-null-undo-json.sql) erased
  values an older version had left
  ([electron/services/UndoStore.ts](electron/services/UndoStore.ts),
  [specs/X13-operation-audit-log.md](specs/X13-operation-audit-log.md) section 7).
- **Expiry runs at startup**, at most once per 24 hours
  ([MaintenanceService.ts](electron/services/MaintenanceService.ts)). SQLite runs
  with `secure_delete = ON`, so freed pages are zeroed. The write-ahead log is
  checkpointed and truncated on every startup and again after a purge, and a
  `VACUUM` follows any startup that applied a migration
  ([electron/db/sqlite.ts](electron/db/sqlite.ts)). A blocked checkpoint is
  logged as a warning rather than failing startup.
- **Logs** are JSON lines in `userData/logs/latelier.<date>.log`, pruned after 7
  days ([electron/log.ts](electron/log.ts)). A packaged build logs at `info`:
  per request it records the channel, duration, connection, database and
  collection, and the filter, sort, projection and pipeline stages
  **truncated to 200 characters**; a failed request also records the error
  message, which a database error can fill with document values
  ([electron/ipc/router.ts](electron/ipc/router.ts)).
  The full request payload (`ipc.req`) is logged only at `debug`, which an
  unpackaged build uses ([electron/main.ts](electron/main.ts)). A diagnostic
  bundle is written only when the user exports one; it holds connection
  metadata and the last log files, redacted as above
  ([electron/services/DiagnosticService.ts](electron/services/DiagnosticService.ts)).
- **File modes (macOS and Linux).** The data directory and `logs/` are `0700`;
  the database and its `-wal` and `-shm` files and every log file are `0600`;
  files L'Atelier creates for an export or a diagnostic bundle are created
  `0600` ([electron/utils/privateFs.ts](electron/utils/privateFs.ts),
  [electron/db/sqlite.ts](electron/db/sqlite.ts),
  [electron/ipc/handlers/app.ts](electron/ipc/handlers/app.ts),
  [electron/mongo/QueryService.ts](electron/mongo/QueryService.ts)). A data
  directory the current user does not own makes startup fail with an error
  rather than run with loose permissions. On Windows these calls are skipped and
  the per-user profile ACL applies.
- Chromium's own profile (caches, local storage) lives in the same directory;
  the cookie-encryption fuse is on.

### Scripting and the shell

- **Where the code runs.** The script pane and the Mongo shell run in an Electron
  `utilityProcess` child, not in main: one child per script run, one long-lived
  child per shell session, killed on timeout, cancel, session end or quit
  ([electron/script-runner/runner.ts](electron/script-runner/runner.ts),
  [electron/services/runner/utilityProcessSpawner.ts](electron/services/runner/utilityProcessSpawner.ts),
  [docs/adr/0014-out-of-process-script-runner.md](docs/adr/0014-out-of-process-script-runner.md)).
- **What the child is not given.** It has no MongoDB client, connection string,
  password or TLS material, and receives an environment reduced
  to a short allowlist (`PATH`, `HOME`, `TEMP` and similar) instead of main's
  ([electron/services/runner/spawner.ts](electron/services/runner/spawner.ts)).
  Its `db` object sends each call to main over a message port. Main answers only
  methods on a fixed allowlist, executes them on its own client, and reads the
  connection's read-only flag live on every call; in-flight calls and argument
  size are capped
  ([electron/script-runner/rpcHost.ts](electron/script-runner/rpcHost.ts),
  [electron/script-runner/rpcSurface.ts](electron/script-runner/rpcSurface.ts)).
  It has no route into main's memory, the secrets vault or other connections.
- **What the child still can do.** It is an ordinary process of the logged-in OS
  user. The script pane runs code in a Node `vm` context without `require`, but
  `vm` is not a security boundary, so treat a script as able to read and write
  that user's files, start processes and use the network. That includes the
  app's own data directory: it can read `latelier.db` (connection hosts, saved
  queries, recent values, audit filters, and any password stored under the
  plaintext fallback), and encrypted secrets are only as safe as the OS keychain
  is against other processes of the same user. The shell pane is a Node REPL and
  exposes `require` and `process` directly
  ([electron/script-runner/shellSession.ts](electron/script-runner/shellSession.ts)).
  Only run code you trust. Against a MongoDB deployment that requires no
  authentication, such code can open its own connection and write regardless of
  any setting in this app.
- **Read-only mode is a safety guard inside the app, not access control.** A
  connection marked read-only refuses the app's own write channels, refuses
  script writes in main, and ends running scripts and shell sessions when the
  flag is turned on; the shell is refused outright on a read-only connection
  because a REPL cannot tell a read from a write
  ([docs/adr/0005-read-only-connection-enforcement.md](docs/adr/0005-read-only-connection-enforcement.md),
  [electron/services/ShellService.ts](electron/services/ShellService.ts),
  [electron/services/ScriptService.ts](electron/services/ScriptService.ts)). The
  flag is a per-connection setting the user can switch off, and it constrains only
  this app. **Use MongoDB roles to enforce read-only access**: connect with a
  database user that holds only read privileges.

### Network

- The app's own code opens connections only to the MongoDB servers the user
  configures, plus the DNS lookups the driver makes for those hostnames. There is
  no telemetry, analytics, crash reporter or auto-updater: the source contains no
  `autoUpdater` or `crashReporter` use and no HTTP request code, and
  [package.json](package.json) lists no updater, error-reporting or HTTP-client
  dependency. This is a statement about L'Atelier's code; background requests made
  by Chromium or the OS itself (for example spellchecker dictionary downloads on
  Windows and Linux, which the app does not disable) are not audited here. Fonts are bundled, and the packaged CSP limits
  the renderer's own requests to the app's origin
  ([electron/main.ts](electron/main.ts)).
- Because there is no updater, updates are manual: install a newer release
  yourself. Fixes ship in the latest release only (see Supported Versions).
- Links in the UI open in the system browser, restricted to the hosts
  allowlisted under Process model.
- TLS defaults are described under Credentials.

### Distribution

- Release builds come from the [release workflow](.github/workflows/release.yml),
  which runs on a `v*` tag, builds a macOS DMG (x64 and arm64) and a Windows NSIS
  installer (x64), and attaches them to a GitHub Release. The packaging
  configuration also defines a Linux AppImage target, which the release workflow
  does not build ([electron-builder.yml](electron-builder.yml)).
- **Builds are not code-signed and not notarized.** The workflow turns off
  signing-certificate discovery, and no signing secrets are configured; macOS
  Gatekeeper and Windows SmartScreen will warn on first launch
  ([release.yml](.github/workflows/release.yml),
  [docs/publication-checklist.md](docs/publication-checklist.md)). The macOS build
  carries an ad-hoc signature so it launches on Apple Silicon, which says nothing
  about who built it.
- **No signatures or attestations are published for the installers.** The release
  also carries electron-builder's `latest.yml` and `latest-mac.yml` metadata
  files ([release.yml](.github/workflows/release.yml)), and GitHub reports a
  SHA-256 digest for every release asset (`gh release view <tag> --json assets`),
  so you can compare a download with `shasum -a 256`. Both come from the same
  place as the installer, so they check that the download is intact, not who built
  it. Download only from this repository's Releases page. To get a build you can
  attribute, build from source at the tag you want (`npm ci`, then the
  `electron:build-mac` or `electron:build-win` script in
  [package.json](package.json)); reproducibility of the output is not claimed.
- **Auto-update.** A packaged macOS or Windows build checks this repository's
  GitHub Releases (`anonhym/latelier`) once per launch, downloads an update in
  the background and offers a restart; nothing is sent besides that request, and
  there is no telemetry. macOS applies an update only if its Developer ID
  signature matches the running app. Windows builds are unsigned, so a Windows
  update is checked only against the sha512 in the release's `latest.yml`, over
  HTTPS: anyone with write access to the GitHub release could replace both, the
  same trust a first download already carries
  ([specs/X20-auto-update.md](specs/X20-auto-update.md)).
- **Electron fuses** are set on the packaged binary: `RunAsNode`,
  `NODE_OPTIONS` and the `--inspect` CLI arguments are off; cookie encryption,
  `OnlyLoadAppFromAsar` and embedded ASAR integrity validation are on.
  `GrantFileProtocolExtraPrivileges` is deliberately left on because the
  renderer is loaded over `file://`. The release workflow fails if a built app
  does not match ([electron-builder.yml](electron-builder.yml),
  [scripts/verify-fuses.mjs](scripts/verify-fuses.mjs)).
- The actions used by the release workflow are pinned to commit hashes
  ([release.yml](.github/workflows/release.yml)).
