# C14 — Import Wizard

> **Status: Accepted.** Nothing has shipped yet; C13's import flow is still the current behaviour.

## Purpose

One place to add Connections in bulk, whatever they come from: a L'Atelier Connection Export, a MongoDB Compass export, any other JSON file, or pasted connection strings. The wizard works out which **Import Source** it has been given. For a JSON file it doesn't recognise, the user assigns the file's fields to Connection fields in a **Field Mapping** step (see `CONTEXT.md`). Every source then ends in the same final approval and commit.

This replaces the flow in [C13](./C13-connection-export-import.md) §4.1 and the Paste URIs screen in C13 §7.1. C13 keeps the Connection Export file format (§1), its encryption (§2), Export (§3), and the import rules this spec reuses unchanged: identity and name clashes (§4.2), credential file paths are never imported (§4.3), and secrets on an install that can't store them securely (§4.4).

## Scope

- **In**:
  - detecting the Import Source;
  - reading Compass exports, including passphrase-encrypted ones;
  - Field Mapping for JSON files in an unknown format;
  - one final approval step for every source;
  - folding Paste URIs into the wizard;
  - a per-row *Direct connection* choice.
- **Out**:
  - Studio 3T and other named formats, beyond what Field Mapping covers.
  - Non-JSON files: CSV, YAML, and the like.
  - Remembering a Field Mapping between imports.
  - OIDC, Kerberos and client-side field-level encryption (FLE). Rows that need them are reported, never silently degraded (§4.3).
  - Mapping SSH or TLS certificate settings from an unknown file. These are edited in the form afterwards.
  - Editing a Connection's settings inside the wizard, beyond what §6 lists.
  - Updating existing Connections. As in C13, import only ever adds.

## Dependencies

- **C13**: the Connection Export format and the §4.2–§4.4 rules. The parse, validate and secret code is reused, not rewritten.
- **C01**: `ConnectionInput`, and `electron/mongo/uri-parse.ts`, the URI parser behind the form's paste and §7.1.
- **F03**: `SecretsVault`.
- `electron/services/connectionBulkAdd.ts` (the §7.1 bulk add) is the starting point for the shared commit (§7).

## 1. Flow

```
Source ──► detect ──┬─ L'Atelier export ─┐
 (file or paste)    ├─ Compass export ───┤
                    ├─ Pasted URIs ──────┼──► Final approval ──► Commit ──► Result
                    └─ Unknown JSON ─► Field Mapping ─┘
```

1. **Source.** The user either picks a file through main's open dialog, or pastes connection strings, one per line.
2. **Detect** (§2). Main reads and classifies the input. An input that can't be read ends the flow with its reason, and nothing is written.
3. **Field Mapping** (§5), for Unknown JSON only. Known sources skip it: their mapping is fixed, so there is nothing for the user to confirm.
4. **Final approval** (§6). This is the same screen for every source.
5. **Commit and result** (§7).

Entry points are C13 §6's: the command palette and File menu ("Import Connections…"), the Connections table footer, and the empty first-launch screen. The footer keeps its three buttons:
- **+ New** opens the form, as before.
- **Paste URIs** opens the wizard at the paste source.
- **Import** opens the wizard at the file picker.

## 2. Detecting the Import Source

Main reads the file, up to `MAX_FILE_BYTES` (5 MB, the C13 limit), and parses it as JSON. A file that isn't JSON is refused with *"This isn't a JSON file."* The parsed value is then tested in this order:

| Import Source | Recognised by |
|---|---|
| L'Atelier export | top-level `format === "latelier.connection-export"`. From here C13 §1 applies in full, including the newer-version refusal and strict schema. |
| Compass export | top-level `type === "Compass Connections"`. Only `version === 1` is supported; any other version is refused with *"This Compass export version isn't supported."* |
| Unknown JSON | anything else |

Pasted text is always the **Pasted URIs** source. It keeps C13 §7.1's limits: up to 100 lines of up to 4096 characters each.

Every source produces the same thing: a list of **candidate rows**. Each row is a `ConnectionInput` without its secrets, plus that row's secrets, warnings, re-pick markers and default tick. The rows stay in main, behind the token (§8), until commit.

## 3. URI rules shared by every source

A connection string from any source, whether pasted, Compass's `connectionString`, or a field mapped to *Connection string*, goes through `uri-parse.ts` exactly as the form's paste does. That means:

- **Multiple hosts.** `ConnectionInput` holds one host, so a multi-host string keeps its first host and the row carries the parser's `MULTI_HOST_TRUNCATED` warning. `replicaSet` is dropped, as the parser already does with `OPTION_DROPPED`.
- **Credential file paths (new parser behaviour).** Today `uri-parse.ts` ignores `tlsCAFile` and `tlsCertificateKeyFile` without saying so. This spec makes the parser turn them into `tlsCa` and `tlsClientCert` re-pick markers, never paths (C13 §4.3). Because the form's URI paste uses the same parser, the form gains the same markers.
- **Unsupported auth mechanisms.** An auth mechanism the parser rejects makes the row unusable, with the parser's reason. The one exception is `MONGODB-OIDC`, which gets §4.3's message instead.

## 4. Compass export

### 4.1 Mapping

The file is canonical EJSON. Main parses it with `bson`'s `EJSON.parse`. Each element of `connections` becomes one row:

| Compass | Connection |
|---|---|
| `connectionOptions.connectionString` | everything §3 derives from the string |
| `favorite.name` | `name`. With no favourite, the name comes from the host, using C13 §7.1 step 3's rule. |
| `favorite.color` | `color`, when it is a valid hex value; otherwise the default colour |
| `connectionOptions.sshTunnel.{host,port,username}` | `ssh.{host,port,username}`, with `ssh.enabled: true` |
| `sshTunnel.password` | `sshPassword`, with `ssh.authMethod: 'password'` |
| `sshTunnel.identityKeyFile` | never imported as a path. It sets `ssh.authMethod: 'key'` and adds an `sshKey` re-pick marker. `identityKeyPassphrase` becomes `sshPassphrase`. |

**Default ticks:** favourites (rows with a `favorite`) are ticked; recent connections (no `favorite`) are unticked. Whether Compass's export includes recent connections at all is unverified; the rule costs nothing if it doesn't.

### 4.2 Encrypted Compass exports

An export made with a passphrase has its secrets removed from each entry and replaced by a base64 `connectionSecrets` string. Decryption, all in main:

1. The bytes are laid out as: 2-byte big-endian version (must be `1`), 16-byte salt, 16-byte IV, 16-byte auth tag, then the ciphertext.
2. The key is `pbkdf2(passphrase, salt, 100000, 32, 'sha512')`.
3. The cipher is AES-256-GCM, with no additional authenticated data.
4. The plaintext is EJSON `{ secrets: { password, sshTunnelPassword, sshTunnelPassphrase, … } }`.
5. `password` goes back into the row as its password. `sshTunnelPassword` and `sshTunnelPassphrase` become the row's SSH secrets. Every other secret field is dropped with a row warning.

A GCM authentication failure is a wrong passphrase. It uses C13's flow unchanged: the stable `BAD_PASSPHRASE` code, retry allowed, and *"Import without passwords"* always available.

Source: the Compass repository, `packages/connection-storage/src/encrypt.ts` and `import-export-connection.ts`. The format belongs to someone else, so the unit tests pin it with a fixture produced by a real Compass export: one saved favourite and one SSH connection, exported both with and without a passphrase. The fixture has to come from an actual Compass install. One built from this description would only prove our own reading of it.

### 4.3 What L'Atelier can't represent

| Compass feature | Row outcome |
|---|---|
| OIDC (`authMechanism=MONGODB-OIDC` or an `oidc` block) | **Not importable.** The row is listed but can't be ticked, with the reason *"OIDC sign-in isn't supported yet."* |
| FLE (`fleOptions`) | Imported without it, with a warning |
| Application-level proxy, or proxy options in the string | Imported without it, with a warning |

## 5. Field Mapping (Unknown JSON)

### 5.1 Finding the rows

Main walks the parsed value, at most 5 levels deep:

- Every array whose elements are all objects is a **collection**. When there is more than one, the screen lists them by path (e.g. `data.servers`) with their row counts, and the user picks one. The default pick is the largest.
- When there is no collection and the top level is an object, that object is treated as a single row.
- Otherwise the file is refused with *"No connections found in this file."*

A collection is capped at 500 rows. Anything beyond that is left out and reported.

### 5.2 Fields

Within the chosen collection, each row is flattened to dot paths over its scalar leaves (string, number, boolean). Array indexes inside a row are plain path segments, for example `servers.0.host`. `null`, objects and arrays are never mappable themselves. The screen lists the union of paths across all rows, up to 200, with:

- **one sample value**, taken from the first row that has the path;
- **masking.** The sample is replaced with `••••` and the hint *"Taken from the file — not shown"* when the path's last segment matches `pass`, `pwd`, `secret`, `token`, `key` or `credential` (case-insensitive substring), or when the value is a connection string that carries a secret. A connection string's sample is shown with its secrets removed: the password in userinfo, and the query parameters `tlsCertificateKeyFilePassword` and `proxyPassword`, and `AWS_SESSION_TOKEN` inside `authMechanismProperties`. This is the same set Compass itself treats as secrets.

Masking happens in main. A raw secret value never reaches the renderer.

### 5.3 Targets

Each target takes at most one path, and each path goes to at most one target.

| Target | Accepts |
|---|---|
| Name | string |
| Connection string | a string starting with `mongodb://` or `mongodb+srv://` |
| Host | string |
| Port | integer 1–65535, as a number or a numeric string |
| Username | string |
| Password | string |
| Auth database | string |
| Default database | string |
| TLS | boolean, or `"true"`/`"false"` |

*Next* is enabled once either Connection string or Host is mapped.

A value the target doesn't accept is ignored for that row, and the row shows a warning naming the path. Every field that isn't mapped takes the same default as the form.

### 5.4 Suggestions

The screen opens with assignments pre-filled. The user can change or clear any of them. The suggestions come from:

- **key names.** The last path segment is compared case-insensitively against a fixed list:
  - Connection string: `uri`, `url`, `connectionString`, `connection_string`, `mongoUri`, `mongoUrl`
  - Host: `host`, `hostname`, `server`
  - Port: `port`
  - Username: `user`, `username`, `login`
  - Password: `password`, `pass`, `pwd`
  - Auth database: `authSource`, `authDb`, `authDatabase`
  - Default database: `db`, `database`, `dbName`
  - Name: `name`, `label`, `title`
  - TLS: `tls`, `ssl`
- **values.** The only value rule: a path whose sample starts with `mongodb://` or `mongodb+srv://` is suggested as Connection string.

### 5.5 Combining a row's values

1. **With Connection string mapped,** the string is parsed (§3) and becomes the base. Mapped Username, Password, Auth database, Default database and TLS fill in only what the string lacks. A mapped value that conflicts with a non-empty value in the string is ignored, and the row shows a warning. Host and Port are ignored for that row.
2. **Without a Connection string,** Host (required) and Port (default 27017) build a standard, non-SRV Connection. The other mapped fields are applied directly.
3. **A row with neither** a usable Connection string nor a Host is listed in the final approval as unusable, with the reason.

**Name:** the mapped Name, else C13 §7.1 step 3's host rule. It is cut to 64 characters, then deduplicated with `" (2)"` (C13 §4.2).

### 5.6 Leaving the step

*Back* returns to Source. *Next* sends only the chosen collection and the path→target assignments to main (§8). Main applies them to the file it holds and returns the final approval rows.

## 6. Final approval

The same screen serves every source. It lists every candidate row, usable or not, before anything is written. Usable rows have a tick box.

**Each row shows (read-only):**
- the name it will be saved under, with renames highlighted;
- host and port, or the SRV host;
- auth username;
- whether a password is present;
- default database, TLS, and SSH (on or off);
- its warnings and re-pick markers.

**Each row can change:**
- **Tick.** Starts at the source's default: every row, except Compass recent connections (§4.1).
- **Credentials.** A ticked row with no username or no password gets inline fields for them, as in C13 §7.1 step 4; a username already in the row is pre-filled. Blank is accepted. X.509 and AWS rows are never asked.
- **Direct connection**, on non-SRV rows only:
  - **Default.** On, with the hint *"Connects to this one host only. Turn off if this is one member of a replica set and you want the other members discovered."*
  - **Explicit value.** A row whose connection string sets `directConnection` itself starts with that value instead. So does a row from a L'Atelier export, which has its own `advanced.directConnection`.
  - **Multi-host string.** A row carrying `MULTI_HOST_TRUNCATED` starts **off**, so the driver discovers the replica set from the first host, which is kept as the seed.
  - **SRV.** SRV rows have no toggle; the driver refuses direct connection over SRV.

**Batch controls:**
- **Read-only, for all rows.** Off by default. It applies only to rows whose source doesn't carry the setting itself, so not to L'Atelier exports.
- **Passphrase.** When the source holds encrypted secrets (an encrypted L'Atelier export or Compass export), the passphrase field and *"Import without passwords"* behave as in C13 §4.1 step 3.

Nothing else is editable here. Read-only on a single row, renames, SSH and TLS files are all changed in the form afterwards.

## 7. Commit and result

On confirm, main:
1. re-plans names against the Connections that exist at that moment;
2. validates each ticked row with C13's import rules;
3. creates the rows one by one;
4. stores their secrets through `SecretsVault`, under C13 §4.4's rule.

A row that fails validation is reported and doesn't stop the others.

The result screen lists what was created, renamed and skipped, what still needs a file picked, and which secrets couldn't be stored.

## 8. IPC

Main owns the dialog and the parsed input. The renderer only ever holds a token, field paths, masked samples and row summaries.

| Channel | Input | Output | SECRET? |
|---|---|---|---|
| `conn:importOpen` | `{}`; main shows the open dialog | `{ cancelled: true } \| { token; source: 'latelier' \| 'compass'; review: Review } \| { token; source: 'unknown'; collections: { at: string; rows: number; fields: { path: string; sample: string; masked: boolean; suggested?: MapTarget }[] }[] }` | no |
| `conn:importMap` | `{ token; at: string; mapping: Partial<Record<MapTarget, string>> }` | `{ review: Review }` | no |
| `conn:importUris` | `{ uris: string[] }` | `{ token; review: Review }` | yes (URIs carry passwords) |
| `conn:importCommit` | `{ token; indices: number[]; passphrase?; withoutSecrets?; readOnly: boolean; credentials: { index; username?; password? }[]; directConnection: { index; value: boolean }[] }` | `{ created; renamed; skipped; repick; secretsNotStored }` | yes (passphrase, passwords) |

`Review` is `{ hasEncryptedSecrets: boolean; rows: ReviewRow[] }`. Each `ReviewRow` is either:
- usable: `{ index, ok: true, savedAs, host, port?, srv, authUsername?, hasPassword, needsCredentials, directConnection: boolean | null, defaultTicked, repick, warnings }`. `directConnection` is `null` on SRV rows.
- unusable: `{ index, ok: false, reason }`.

`MapTarget` is the §5.3 target list as a string-literal union in `shared/`.

- These channels replace `conn:importPreview` and `conn:previewUris`. `conn:importCommit` takes over `conn:createFromUris`. The retired channels are removed in the same change, along with their entries in `scripts/ipc-secret-allowlist.txt`.
- The token works as in C13 §5. Only a successful commit consumes it, so a `BAD_PASSPHRASE` failure leaves it usable for the retry. It expires when the window closes. `conn:importMap` can be called again on the same token (the user goes back and changes the mapping). Each call replaces the previous candidate rows.
- `conn:importMap` carries no secret: the renderer sends paths, never values.
- Names are illustrative. Follow the full 5-file IPC contract.

## Acceptance criteria

- [ ] Every C13 §6 entry point opens the wizard; the footer's Paste URIs and Import open it at the matching source.
- [ ] A L'Atelier export, a Compass `version: 1` export, and any other JSON are each routed to the right path; non-JSON and Compass versions other than 1 are refused with their message.
- [ ] L'Atelier and Compass exports go straight to the final approval, with no Field Mapping step.
- [ ] A Compass export maps the connection string, favourite name and hex colour, SSH host, port, username and password; an identity file becomes an `sshKey` re-pick, never a path.
- [ ] A passphrase-encrypted Compass export decrypts with the right passphrase; a wrong one gives `BAD_PASSPHRASE` and can be retried; "Import without passwords" works.
- [ ] Compass OIDC rows are listed as not importable with the OIDC message; FLE and proxy rows import with a warning.
- [ ] Compass favourites are ticked by default; recent connections are not.
- [ ] Field Mapping offers every array of objects within 5 levels, defaults to the largest, and treats a lone top-level object as one row.
- [ ] Field paths are flattened to dot paths over scalar leaves; secret-looking paths and URI passwords are masked in main, with the "taken from the file" hint.
- [ ] Suggestions pre-fill from the key-name list and the `mongodb://` value rule; the user can change or clear each one.
- [ ] Next is disabled until Connection string or Host is mapped.
- [ ] A mapped Connection string is the base; mapped fields only fill what it lacks; conflicts warn.
- [ ] Rows with no usable string or host are listed with their reason and can't be ticked.
- [ ] The final approval is the same component for all four sources and shows every row before anything is written.
- [ ] Direct connection defaults on for non-SRV rows, keeps an explicit value from the source, starts off for multi-host strings, and is absent on SRV rows.
- [ ] `tlsCAFile`/`tlsCertificateKeyFile` in any parsed string, including the form's URI paste, become re-pick markers, never paths.
- [ ] No plaintext secret, raw secret sample, or derived key crosses into the renderer.
- [ ] `conn:importPreview`, `conn:previewUris` and `conn:createFromUris` are gone, along with their allowlist entries.

## Test cases

- **Unit:** detection order and the three refusals (not JSON, Compass version ≠ 1, no rows found).
- **Unit:** Compass decryption against a fixture made by a real Compass export, covering the right passphrase, a wrong passphrase (`BAD_PASSPHRASE`), and a tampered tag.
- **Unit:** Compass entry → candidate row for favourite, recent, SSH password, SSH identity file, OIDC, FLE and a non-hex colour.
- **Unit:** collection discovery: top-level array, nested arrays (largest first), lone object, the depth limit, the 500-row cap.
- **Unit:** masking: each secret-looking segment, a URI with a password, a URI with `tlsCertificateKeyFilePassword`, `proxyPassword` or `AWS_SESSION_TOKEN`, a URI without secrets, and a non-secret path left alone.
- **Unit:** the §5.5 combination rules, including a conflict warning and the Port and TLS coercions.
- **Unit:** the Direct connection default for single-host, explicit `directConnection=false`, multi-host and SRV rows.
- **Property (fast-check):** for any generated JSON value within the limits, every `sample` the field list returns for a masked path is `••••`. No generated secret string under a secret-looking key, or in a connection string's password or secret query parameters, ever appears in the `conn:importOpen` output.
- **Integration:** commit applies ticks, inline credentials, Direct connection and Read-only as sent, creates only ticked rows, and reuses C13 §4.4 when secure storage is unavailable.
- **E2E:** import a Compass fixture with a passphrase, then connect to the in-memory server without re-entering the password.
- **E2E:** import an unknown JSON file with `{ "servers": [{ "label", "uri", "secret" }] }`, accept the suggested mapping, and connect.
