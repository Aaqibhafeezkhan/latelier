# Connection troubleshooting

This guide expands the in-app **Help me fix this** drawer with the same
recipes plus longer-form context. Each section's heading anchor matches
the recipe id used by the drawer.

> If you arrived here from the app, your browser opened the right
> section directly. Use **Find in page** (`⌘F` / `Ctrl+F`) to jump to
> a different one.

The taxonomy is keyed off the `errorCode` produced by
`electron/mongo/errors.ts`. If your failure looks like none of these,
the **`unknown`** section at the bottom catches everything else.

---

## auth-default

**You see:** `errorCode: AUTH` in the in-app pill, or the Mongo driver
reports `Authentication failed`.

**What it means:** The server received your credentials and decided
they don't match a user in the auth database it checked.

### When to suspect this

- The error is reproducible with the exact same form values that
  worked elsewhere.
- Pasting the credentials into `mongosh` fails the same way.

### Fix

1. **Check the Auth database.** On the **Auth** tab, *Auth database* is
   where the user record lives (typically `admin`), **not** the
   application database where you intend to read data. The app
   database goes in *Default database* on the **General** tab.
2. **Verify the credentials byte-for-byte.** The form URL-encodes
   special characters (`:`, `@`, `/`, `?`, `#`, `%`) for you — do not
   pre-encode them.
3. **Confirm the user has at least one role.** A user with no roles
   authenticates but cannot read or write anything. As an admin:
   `db.getUser("<name>")`.

---

## docker-tls

**You see:** `errorCode: TIMEOUT` with a message containing
`ECONNRESET`, `TLS handshake`, or
`Client network socket disconnected before secure TLS connection was established`.

**What it means:** TLS is on in MongoLab, but the server reset the
connection before the handshake completed. Almost always: the server
isn't listening for TLS at all. Common with locally-run dev MongoDB and
Docker images that ship without TLS by default.

### When to suspect this

- You started a Mongo container with no `--tlsMode` argument.
- You can connect with the `mongosh` shell *without* `--tls` but
  MongoLab fails.

### Fix

1. **Toggle TLS off.** Open the **TLS** tab, uncheck *Enable TLS / SSL*,
   then **Test** again. For dev work this is the right answer.
2. **If you do need TLS**, restart the server with
   `--tlsMode requireTLS` and supply its CA in *CA Certificate* on the
   **TLS** tab. For self-signed certs, you can untick *Verify
   certificate* — but only as a last resort; prefer importing the CA.

---

## replica-host

**You see:** `errorCode: TIMEOUT` with a message containing
`getaddrinfo ENOTFOUND` or `EAI_AGAIN`. The hostname in the error
message is often a long hex string (a Docker container id).

**What it means:** The server you reached belongs to a replica set, and
the set advertised hostnames your machine cannot resolve via DNS.
Inside the Docker network those hostnames are routable; from your
laptop they are not.

### When to suspect this

- You pointed at a replica-set primary on `localhost:27017` (or
  similar) but get name-resolution errors for hostnames that are not
  the one you typed.
- `mongosh --host <docker-id>:27017` fails with the same DNS error.

### Fix

1. **Turn on Direct connection.** Open the **Advanced** tab and toggle
   *Direct connection* on, then **Test** again. This skips replica-set
   discovery and talks directly to the host you typed.
2. **If you genuinely need to reach the replica set**, add `/etc/hosts`
   entries that map the advertised names to reachable IPs, or
   reconfigure the set with `host:port` pairs your machine can
   resolve (`rs.reconfig` on the primary).

---

## network-default

**You see:** `errorCode: NETWORK`. The driver couldn't even open a TCP
connection.

**What it means:** Either nothing is listening at the host/port you
typed, or something between your machine and the server (firewall,
VPN, IP allow-list) blocks the connection.

### When to suspect this

- `nc -zv <host> <port>` (or `Test-NetConnection` on Windows) also
  fails.
- The server might be down, or you're off VPN.

### Fix

1. **Re-check host and port.** Atlas connection strings hide the port;
   the standard one is **27017**. Self-hosted servers often pick
   something else.
2. **Walk the network path.** From this machine,
   `nc -zv <host> <port>` will tell you whether TCP itself is working.
3. **Atlas: check the IP allow-list.** Atlas blocks every connection by
   default. Add your current public IP under
   **Network Access → IP Access List** in the Atlas console.
   `0.0.0.0/0` works in a pinch but is unsafe past development.

---

## tls-default

**You see:** `errorCode: TLS`. The driver got far enough into the
handshake to recognise it as a TLS error, but couldn't agree on a
certificate chain.

**What it means:** Either the certificate is signed by a CA we don't
trust, the hostname doesn't match the certificate, or the certificate
is expired.

### When to suspect this

- The error mentions `unable to verify the first certificate`,
  `certificate has expired`, or `Hostname/IP does not match`.
- You're connecting to a private deployment with a self-signed CA.

### Fix

1. **Provide the CA.** On the **TLS** tab, set *CA Certificate* to the
   issuer of the server cert. For Atlas this is the system trust store
   and works out of the box; for self-signed or private CAs you must
   point us at the PEM file.
2. **Match the hostname.** The host in **General → Host** must match a
   Subject Alternative Name on the certificate. Connecting by IP when
   the cert names a hostname will fail here.
3. **Last resort: untick *Verify certificate*** on the **TLS** tab.
   This drops verification entirely — use only on networks you trust.

---

## unauthorized

**You see:** `errorCode: UNAUTHORIZED`. Authentication succeeded but
the user isn't allowed to perform the operation we tried.

**What it means:** Roles in MongoDB are scoped to specific databases.
A user with `read` on `appA` cannot read `appB`. Some operations
(listing databases, reading `admin`) require additional roles.

### When to suspect this

- The same credentials work for some operations and not others.
- The error message mentions a specific `<action>` requires a role
  you don't have.

### Fix

1. **Identify the missing role.** Common ones: `read` / `readWrite`
   (per database), `readAnyDatabase` / `readWriteAnyDatabase`
   (cluster-wide), `userAdminAnyDatabase` (user management). Ask
   whoever owns the cluster to grant the smallest role that covers
   your need.
2. **Verify with `db.runCommand({ connectionStatus: 1 })`** from a
   shell as the same user. The response shows the user's authenticated
   roles. If the list is empty or surprising, the password may be
   authenticating you as a *different* user with the same name in a
   different db.

---

## keychain-blocked

**You see:** `errorCode: KEYCHAIN_BLOCKED`. macOS asked whether
L'Atelier may read its saved passwords and the answer was Deny.

### Fix

Quit L'Atelier completely, reopen it and connect again. When macOS
asks for keychain access, click **Always Allow**. The refusal lasts
until the app is relaunched, so retrying without a relaunch fails.

---

## secret-unreadable

**You see:** `errorCode: SECRET_UNREADABLE`. The saved password was
encrypted by another install or a keychain that has since been reset.

### Fix

Open the connection's edit form, type the password again and save.

---

## unknown

**You see:** Something else entirely. The drawer's "Connection failed"
section is the umbrella for failures that don't match any of the
recipes above.

### Where to look first

- **Authentication failed** → see [auth-default](#auth-default).
- **Can't reach the server** → see [network-default](#network-default).
- **TLS / certificate issues** → see [tls-default](#tls-default).
- **Replica-set name resolution (Docker)** →
  see [replica-host](#replica-host).

### Other gotchas worth checking

- **Password contains `:` or `@`.** The form URL-encodes these for you;
  do not pre-encode them when copy-pasting.
- **`NODE_MODULE_VERSION` mismatch on launch.** This is a native-addon
  ABI mismatch, not a connection issue. It should no longer be reachable:
  `better-sqlite3` 13 is an N-API addon whose prebuilt binary serves every
  Node and Electron ABI. If you hit it, something reintroduced a
  compile-from-source path rather than something needing a rebuild.
- **Atlas free tier permissions.** Some commands (`$indexStats`,
  `serverStatus`, `dbStats`) are blocked for free-tier users. We fail
  open and degrade the affected views, but the underlying error class
  may still appear in logs.

### Data from an old MongoLab install

Installs of v0.4.0 or older ran as "MongoLab" and kept their data in a
folder of that name. L'Atelier uses a different folder and does not move
the old one. To bring the data across, quit the app, then move the
contents of the old folder into the L'Atelier folder:

| Platform | Old folder | L'Atelier folder |
|---|---|---|
| macOS | `~/Library/Application Support/MongoLab` | `~/Library/Application Support/L'Atelier` |
| Windows | `%APPDATA%\MongoLab` | `%APPDATA%\L'Atelier` |
| Linux | `~/.config/MongoLab` | `~/.config/L'Atelier` |

The old folder holds a database named `mongolab.db`. If the L'Atelier
folder already contains `latelier.db`, L'Atelier keeps using it and
ignores a `mongolab.db` moved in next to it. To bring the old data in
instead, first move `latelier.db`, `latelier.db-wal` and `latelier.db-shm`
out of the L'Atelier folder (keep them as a backup). A `mongolab.db` left
next to `latelier.db` is never read or cleaned up by the app, so delete it
(with its `-wal` and `-shm`) once you no longer need it; it can still hold
old connection details.

If none of the above match, open
[a GitHub issue](https://github.com/anonhym/latelier/issues) with the
exact error message, your connection form (with credentials redacted),
and the contents of the most recent `latelier.<date>.log` in the `logs`
folder inside the L'Atelier folder listed in the table above (logs from
before the rename are named `mongolab.<date>.log`).

### Going back to an older version

Versions up to 0.17.1 keep their data in `mongolab.db`. Later versions
rename it to `latelier.db` the first time they start. An older version
started afterwards finds no `mongolab.db` and starts empty; nothing is
lost. To go back with your data, quit the app, move the `mongolab.db`
(and `mongolab.db-wal` / `mongolab.db-shm`) the older version created out
of the folder (keep them if you entered anything while on the older
version), then rename `latelier.db` to `mongolab.db`, and `latelier.db-wal` /
`latelier.db-shm` to `mongolab.db-wal` / `mongolab.db-shm` if they are there
(after an unclean quit, rows still sit in the `-wal`).

If you start a newer version again without these steps, it keeps using
`latelier.db`. Anything entered on the older version stays in
`mongolab.db`, which the newer version does not read.

From 0.19.0, open tabs, saved queries, query history, recent filter values
and the operation log are encrypted in `latelier.db`. Version 0.18.0 and
older cannot read them, so going back from 0.19.0 is not supported: those
come back broken or empty there. Connections and their saved passwords are
not affected.
