# C14 — Import Wizard

> **Status: Implemented.**

## Purpose

One place to add Connections in bulk, whatever they come from: a L'Atelier Connection Export, a MongoDB Compass export, any other JSON file, or pasted connection strings. The wizard works out which **Import Source** it has been given. For a JSON file it doesn't recognise, the user assigns the file's fields to Connection fields in a **Field Mapping** step (see `CONTEXT.md`). Every source then ends in the same final approval and commit.

This replaces the import flow in [C13](./C13-connection-export-import.md) §4.1 and the Paste URIs screen in C13 §7.1. C13 keeps the Connection Export file format (§1), its encryption (§2), Export (§3), and the import rules this spec reuses unchanged: identity and name clashes (§4.2), credential file paths are never imported (§4.3), and secrets on an install that can't store them securely (§4.4).

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
  - OIDC, Kerberos, LDAP and client-side field-level encryption (FLE). Rows that need them are reported, never silently degraded (§4.3).
  - Mapping SSH or TLS certificate settings from an unknown file. These are edited in the form afterwards.
  - Editing a Connection's settings inside the wizard, beyond what §6 lists.
  - Updating existing Connections. As in C13, import only ever adds.

## Dependencies

- **C13**: the Connection Export format and the §4.2–§4.4 rules. The parse, decrypt, naming, validation and secret-storing code is reused, not rewritten (`connectionExportFormat.ts`, `connectionBulkAdd.ts`, `storeImportedSecrets`).
- **C01**: `ConnectionInput`, and `electron/mongo/uri-parse.ts`, the URI parser behind the form's paste and every connection string the wizard reads (§3).
- **F03**: `SecretsVault`.

Main-process code: `electron/services/ImportWizardService.ts` (tokens and commit) and `electron/services/import/` (`detect`, `latelierSource`, `compassReader`, `compassCrypto`, `unknownJson`, `review`). Renderer: `src/features/connections/importWizard/`.

## 1. Flow

```
Source ──► detect ──┬─ L'Atelier export ─┐
 (file or paste)    ├─ Compass export ───┤
                    ├─ Pasted URIs ──────┼──► Final approval ──► Commit ──► Result
                    └─ Unknown JSON ─► Field Mapping ─┘
```

1. **Source.** One screen offers both inputs: *Choose file…*, which opens main's open dialog, and a box to paste connection strings, one per line.
2. **Detect** (§2). Main reads and classifies the input. An input that can't be read ends the flow with its reason, and nothing is written.
3. **Field Mapping** (§5), for Unknown JSON only. Known sources skip it: their mapping is fixed, so there is nothing for the user to confirm.
4. **Final approval** (§6). This is the same screen for every source.
5. **Commit and result** (§7).

Entry points are C13 §6's: the command palette and File menu ("Import Connections…"), the Connections table footer, and the empty first-launch screen. All of them open the wizard on the Source screen. There is one wizard, mounted at app level: asking to open it, or to open Export, while it is open does nothing, so a menu command never replaces a review in progress. The footer keeps its three buttons:
- **+ New** opens the form, as before.
- **Paste URIs** opens the wizard with the paste box focused.
- **Import** opens the wizard with *Choose file…* focused.

## 2. Detecting the Import Source

Main enforces C13's `MAX_FILE_BYTES` (5 MB) twice: on the file's size before reading it, and on the text it read, counted in bytes. A file over the limit is refused with *"This file is too large to import (5 MB limit)."* A file system error is refused with *"This file can't be read."* The error itself is only logged, by its code, because its message names the file's absolute path.

The text is then parsed as JSON. A file that isn't JSON is refused with *"This isn't a JSON file."* The parsed value is tested in this order:

| Import Source | Recognised by |
|---|---|
| L'Atelier export | top-level `format === "latelier.connection-export"`. From here C13 §1 applies in full, including the newer-version refusal and the strict schema. |
| Compass export | top-level `type === "Compass Connections"`. The text is parsed again with `bson`'s `EJSON.parse` (§4.1). Only `version` 1 is supported. Any other version is refused with *"This Compass export version isn't supported."* EJSON that `bson` rejects, or a version 1 file without a `connections` array of entries, is refused with *"This Compass export can't be read."* |
| Unknown JSON | anything else |

Pasted text is always the **Pasted URIs** source. The Source screen trims each line and drops blank ones. It keeps C13 §7.1's limits: up to 100 lines of up to 4096 characters each. The screen checks them as the user types, and main checks them again on the channel.

Every source produces the same thing: a list of **candidate rows**. Each row is a `ConnectionInput` without its secrets, plus that row's plaintext secrets, any still-sealed secrets, warnings, re-pick markers, default tick, and, for an unusable row, its reason. The rows stay in main, behind the token (§8), until commit.

## 3. URI rules shared by every source

A connection string from any source, whether pasted, Compass's `connectionString`, or a field mapped to *Connection string*, goes through `uri-parse.ts` exactly as the form's paste does. That means:

- **Multiple hosts.** `ConnectionInput` holds one host, so a multi-host string keeps its first host and the row carries the parser's `MULTI_HOST_TRUNCATED` warning. `replicaSet` is dropped, as the parser already does with `OPTION_DROPPED`.
- **Credential file paths.** `tlsCAFile` becomes a `tlsCa` re-pick marker and `tlsCertificateKeyFile` becomes a `tlsClientCert` marker, never a path (C13 §4.3). Any parameter name casing works. An X.509 row always needs its client certificate picked again, and is listed once even when the string also names the file. The form's URI paste uses the same parser, so its toast names the files still to pick.
- **Explicit `directConnection`.** The parser reports whether a non-SRV string set `directConnection` itself, with any value (`directConnectionExplicit`). The absence of the parameter and an explicit `false` would otherwise look the same, and §6 needs to tell them apart. The form's own paste default is unchanged.
- **Proxy options.** `proxyHost`, `proxyPort`, `proxyUsername` and `proxyPassword` are not imported. The row carries one `PROXY_DROPPED` warning: *"Proxy options in the string were not imported; the connection goes direct."* It names no value, because `proxyPassword` is a secret.
- **Refusals.** A string the parser refuses makes the row unusable, with the parser's reason as the row's reason:
  - `MONGODB-OIDC` gives *"OIDC sign-in isn't supported yet."*, in any casing.
  - Any other mechanism the parser doesn't support, such as Kerberos (`GSSAPI`) or LDAP (`PLAIN`), gives `unsupported authMechanism: <value>`.
  - A host with characters a host name can't contain, or a port outside 1–65535, is refused in words, never by quoting the input. A host name holds letters, digits, `.`, `-` and `_`, or is a bracketed IPv6 literal. A `%` is allowed only when the host ends in `.sock`, the driver's Unix-socket form, so `good%2eexample` is refused.
  - A non-ASCII host such as `münchen.example` is accepted, in any case, only when DNS would resolve the name shown: it must convert to punycode (`domainToASCII`) and back (`domainToUnicode`) to the same name, bar case. This refuses what UTS46 rewrites or drops, such as an ideographic full stop, zero-width characters, a soft hyphen, fullwidth `／＠？＃：，` and a right-to-left override. The driver gets such a host as its punycode, for standard and SRV connections alike; a stored host whose punycode would name a different host (cut at an encoded `/`, `?` or `#`, or a folded dot) goes to the driver as written instead.
  - A string the connection-string library can't parse at all gives the fixed sentence *"This isn't a valid connection string."* The library's own message quotes the userinfo, password included, so it is never passed on.

The debug log masks a connection string's userinfo and its secret query parameters (`password`, `proxyPassword`, `tlsCertificateKeyFilePassword`, `sslPEMKeyPassword`, and an `authMechanismProperties` value holding `AWS_SESSION_TOKEN`). It reads parameter names, and the `authMechanismProperties` value it checks for `AWS_SESSION_TOKEN`, percent-decoded as the driver does: valid escapes are decoded and a malformed one is kept as written. It does not recognise a parameter after the legacy `;` separator, or a connection string percent-encoded inside a parameter.

## 4. Compass export

The rules below are pinned by real exports from MongoDB Compass 1.49.7, committed as `tests/fixtures/compass/plain.json` (no passphrase) and `encrypted.json` (with a passphrase, kept in `passphrase.txt`). They hold four favourites: one with a password and `authSource`, one SSH tunnel with a password, one SSH tunnel with an identity file and key passphrase, and one OIDC. The format belongs to someone else. A fixture built from this description would only prove our own reading of it.

### 4.1 Mapping

The file is canonical EJSON: `version` is `{"$numberInt":"1"}`, and ports are `$numberInt` too. Main reads it with `EJSON.parse`. A plain `JSON.parse` would leave the version as an object and refuse every real export. Each element of `connections` becomes one row. Keys this reader doesn't use are ignored, but a key it does read that holds the wrong type in any entry (a port that isn't a number, say) makes the whole file refused with *"This Compass export can't be read."*

| Compass | Connection |
|---|---|
| `connectionOptions.connectionString` | everything §3 derives from the string. An entry without one is unusable, with the reason *"No connection string."* |
| `favorite.name` | `name`. With no name, the name comes from the host, using C13 §7.1 step 3's rule. |
| `favorite.color` | `color`, only when it is a `#rrggbb` value. Compass stores named colours (`"color1"` to `"color10"`), so a real export gets the default colour. There is no table translating Compass's names, because their shades are Compass's own. |
| `connectionOptions.sshTunnel.{host,port,username}` | `ssh.{host,port,username}`, with `ssh.enabled: true` |
| `sshTunnel.password` | `sshPassword`. A tunnel without an identity file uses `ssh.authMethod: 'password'`, whether its password is inline, sealed (§4.2) or blank: that is Compass's password tab. |
| `sshTunnel.identityKeyFile` | never imported as a path. It sets `ssh.authMethod: 'key'` and adds an `sshKey` re-pick marker. `identityKeyPassphrase` becomes `sshPassphrase`. |

An export made without a passphrase carries its secrets inline: the password in the connection string's userinfo, plus `sshTunnel.password` and `sshTunnel.identityKeyPassphrase`. Main moves each one into the row's secrets as it reads the entry, so no secret stays in the row's `ConnectionInput`.

**Default ticks:** every entry has a `savedConnectionType`, either `"favorite"` or `"recent"`. Favourites are ticked and recent connections are not. An entry without the field is ticked when it has a `favorite` object. The Compass CLI's `--exportConnections` exports favourites only, so in practice an unticked recent connection only comes from a file exported some other way or edited by hand. Unusable rows are never ticked.

### 4.2 Encrypted Compass exports

An export made with a passphrase removes each entry's secrets: the password is stripped from the string, which keeps its username, and `sshTunnel.password` and `identityKeyPassphrase` are absent. Each entry gets a base64 `connectionSecrets` blob instead. Every entry has a blob, even one with no secrets; its blob decrypts to `{"secrets":{}}`.

Decryption runs in main, at commit, for the ticked rows only:

1. The bytes are laid out as: 2-byte big-endian version (must be `1`), 16-byte salt, 16-byte IV, 16-byte auth tag, then the ciphertext.
2. The key is PBKDF2-SHA512 over the passphrase and salt, with 100,000 iterations and 32 bytes of output. It is derived with the asynchronous `pbkdf2`, because 100,000 rounds for each sealed entry would otherwise block the main process. Each entry has its own salt, so each costs one derivation. The first ticked sealed entry is opened alone, so a wrong passphrase fails after one derivation; the rest run two at a time, leaving threads for file and DNS work, and every started job settles before the commit returns or fails.
3. The cipher is AES-256-GCM, with no additional authenticated data.
4. The plaintext is JSON: `{ "secrets": { "password", "sshTunnelPassword" or "sshTunnelPassphrase", … } }`.
5. `password` becomes the row's password. `sshTunnelPassword` and `sshTunnelPassphrase` become its SSH secrets. An empty or null secret is skipped silently, with no warning. Any other secret, or a kept name that doesn't hold text, is dropped. The result names it in a warning, never with its value: *"The "<name>" secret was not imported."*

Before the passphrase is given, a blob is opaque. So the review assumes a sealed password whenever the string carries a username and signs in with a password (default negotiation or SCRAM), and reports it with `passwordSealed`.

A GCM authentication failure fails with the stable `BAD_PASSPHRASE` code and *"Wrong passphrase for this Compass export."* GCM can't tell a wrong passphrase from a tampered tag or ciphertext, so both get that message. The retry and *"Import without passwords"* work as in C13 §4.1 step 3. A blob that isn't valid base64, is shorter than its header, or decrypts to anything but a `secrets` object is refused with *"This Compass export's secrets are damaged."* A blob version other than 1 is refused before any key is derived: *"This Compass export's secrets use an unsupported format."*

Source for the format: the Compass repository, `packages/connection-storage/src/encrypt.ts` and `import-export-connection.ts`.

### 4.3 What L'Atelier can't represent

| Compass feature | Row outcome |
|---|---|
| OIDC (`authMechanism=MONGODB-OIDC` in the string) | **Not importable.** The row is listed but can't be ticked, with the reason *"OIDC sign-in isn't supported yet."* OIDC is detected from the connection string only. Compass's `oidc` options block is ignored. |
| Kerberos, LDAP | **Not importable**, with the parser's reason (§3). |
| FLE (`connectionOptions.fleOptions.autoEncryption` with any setting) | Imported without it, with the warning *"In-use encryption (FLE) settings were not imported."* A bare `fleOptions` gets no warning, because Compass may write one with defaults for any connection. |
| Application-level proxy (`useApplicationLevelProxy: true`) | Imported without it, with the warning *"Application-level proxy settings were not imported."* |
| Proxy options in the string | Imported without them, with the parser's `PROXY_DROPPED` warning (§3) |

## 5. Field Mapping (Unknown JSON)

### 5.1 Finding the rows

Main walks the parsed value, at most 5 levels deep:

- Every non-empty array whose elements are all objects is a **collection**. Arrays are found inside objects and inside array elements alike. A collection's own rows are not searched for more collections: an array inside a row is one of the row's fields (§5.2).
- When there is more than one collection, the screen lists them by path (for example `data.servers`) with their row counts, and the user picks one. The default pick is the largest; ties keep document order. A top-level array is the collection at `''`, shown as "This file".
- When there is no collection and the top level is an object, that object is treated as a single row, at `''`.
- Otherwise the file is refused with *"No connections found in this file."*

A collection is capped at 500 rows, ranked by its full count. Anything beyond the cap is left out, and the screen says how many rows were.

A path joins keys with `.`, so two lists can share one. A key with a dot in it can sit beside real nesting (`"db.servers"` and `db` → `servers`). An empty key or a `"0"` key can sit beside an array index. Picking by path could then import the other list, so no list at a shared path is offered. The screen says how many paths were left out. When that leaves no list at all, the file is refused with *"The lists of connections in this file can't be told apart: each has the same path as another list."* The top-level object is not used as a row instead.

Two kinds of key are skipped everywhere, in collection paths and field paths alike:
- a key that holds a connection string (`mongodb://` or `mongodb+srv://`, any case), because a path is shown on screen and the string may carry a password;
- a key longer than 256 characters: nobody maps one, and the file would otherwise control how much work each leaf costs.

### 5.2 Fields

Within the chosen collection, each row is flattened to dot paths over its scalar leaves (string, number, boolean). Array indexes inside a row are plain path segments, for example `servers.0.host`. `null`, objects and arrays are never mappable themselves. Leaves more than 20 levels below the row are not offered; the limit also bounds the walk. A `__proto__` key stays data. Two leaves of a row can share a path the same way two lists can (§5.1), as in `{"a.b": 1, "a": {"b": 2}}`. Which one is meant can't be told, so neither is offered, sampled or read. A path shared in any row is left out for every row, and the screen says how many paths were. The screen lists the union of paths across all rows, in document order, up to 200, each with **one sample value**, taken from the first row that has the path.

**Masking.** Masking happens in main, and a raw secret value never reaches the renderer. A field is masked when either rule below applies. When main hides the value whole (`••••`), the screen shows `••••` and the hint *"Taken from the file — not shown"*. When main sends a connection string with its secrets stripped, the screen shows that string, so the user can recognise the field.

- **Key rule.** The path's last key is its last segment that isn't an all-digit array index, so a list under `apiKeys` is masked like a single key. When that key contains `pass`, `pw`, `pwd`, `secret`, `token`, `key` or `credential` (case-insensitive substring), the sample is replaced by `••••`, whatever the value's type. Because it is a substring rule, it also masks harmless names such as `keyboard`. A needless mask only costs the user a sample. A missed one shows a secret. `auth` is not on the list, so `authSource` and `authMechanism` samples stay visible.
- **Value rule.** This rule covers any text that holds `mongodb://` or `mongodb+srv://` anywhere, in any case.
  - The text is first trimmed of spaces and zero-width characters.
  - Text that holds a second connection string, or that the connection-string library can't parse (text before the string included), is replaced by `••••`. It fails closed, because where each string ends inside it can't be told reliably.
  - Otherwise these secrets are stripped: the userinfo password, the query parameters `tlsCertificateKeyFilePassword` and `proxyPassword` (any case, any repeat, percent-encoded names included), and a whole `authMechanismProperties` value that holds `AWS_SESSION_TOKEN`. This is the set Compass itself treats as secrets.
  - When something was stripped, the field is masked and its sample is the string without those parts. A string with none of them is shown as it is.

Known gaps, accepted because the cases are contrived: a parameter after the legacy `;` separator is not recognised, and neither is a connection string percent-encoded inside a query parameter.

### 5.3 Targets

Each target takes at most one path, and each path goes to at most one target. On the screen, choosing a target that another path holds moves the target. Main refuses a mapping that sends one path to two targets.

| Target | Accepts |
|---|---|
| Name | string |
| Connection string | a string starting with `mongodb://` or `mongodb+srv://` (after trimming) |
| Host | a string that is a valid host for the parser (§3), optionally `host:port` |
| Port | an integer 1–65535, as a number or a string of digits (`1.5`, `-1`, `0x10` and `1e3` are refused) |
| Username | string |
| Password | string |
| Auth database | string |
| Default database | string |
| TLS | `true`/`false`, or exactly `"true"`/`"false"` |

*Next* is enabled once either Connection string or Host is mapped.

A value the target doesn't accept is ignored for that row. The row shows a warning naming the path, never the value. A missing or empty value is simply absent, with no warning. Every field that isn't mapped takes the same default as a pasted string.

**Secret paths.** A path the key or value rule masks can only feed Password or Connection string, the two targets whose value never appears in the review. Mapped to any other target, it is ignored with the warning *"<path> was ignored: it holds a secret; map it to Password or Connection string."* Otherwise a value the mapping screen hid could come back through a field the review shows.

### 5.4 Suggestions

The screen opens with assignments pre-filled. The user can change or clear any of them. The suggestions come from:

- **key names.** The path's last key (§5.2) is compared case-insensitively against a fixed list:
  - Connection string: `uri`, `url`, `connectionString`, `connection_string`, `mongoUri`, `mongoUrl`
  - Host: `host`, `hostname`, `server`
  - Port: `port`
  - Username: `user`, `username`, `login`
  - Password: `password`, `pass`, `pwd`
  - Auth database: `authSource`, `authDb`, `authDatabase`
  - Default database: `db`, `database`, `dbName`
  - Name: `name`, `label`, `title`
  - TLS: `tls`, `ssl`
- **values.** The only value rule: a path whose value, trimmed, starts with `mongodb://` or `mongodb+srv://` is suggested as Connection string, ahead of its key name. The rule reads the value, not the sample the screen shows, so it also applies under a secret-looking key whose sample is hidden.

A target is suggested for one path only: the first in document order. A path whose value rule lost its target to an earlier path gets no suggestion, rather than falling back to its key name.

### 5.5 Combining a row's values

1. **With Connection string mapped,** the string is parsed (§3) and becomes the base. A string the parser refuses makes the row unusable with the parser's reason. Mapped Host and Port are ignored for that row. Mapped Username, Password, Auth database and Default database fill in only what the string lacks. A mapped value that differs from a non-empty value in the string is ignored with the warning *"<path> was ignored: the connection string already sets a different value."* An equal value is silent. A username that fills in turns a string with no auth into default negotiation, and keeps an explicit mechanism. A mapped TLS conflicts only when the string names `tls` or `ssl` in its query. Otherwise TLS is only the parser's default, and the mapped value replaces it.
2. **Without a Connection string,** Host (required) and Port (default 27017) build a standard, non-SRV Connection with the same defaults a pasted `mongodb://host:port` would get. When Host carries its own port, that port wins. A mapped Port that differs is ignored with a warning. The other mapped fields are applied directly. A mapped Connection string whose value isn't one is ignored with a warning, and the row falls back to Host.
3. **A row with neither** a usable Connection string nor a Host is listed in the final approval as unusable, with the reason *"No connection string or host in this row."*

**Name:** the mapped Name, else C13 §7.1 step 3's host rule. It is cut to 64 characters, then deduplicated with `" (2)"` (C13 §4.2). Every usable row starts ticked.

### 5.6 Leaving the step

*Back* returns to Source. While main applies the mapping, *Back* and *Next* are disabled. *Next* sends only the chosen collection's path and the target→path assignments to main (§8). Main applies them to the file it holds and returns the final approval rows. The final approval's *Back* returns to Field Mapping with the choices intact. *Next* can be pressed again on the same token, and each call replaces the previous candidate rows.

## 6. Final approval

The same screen serves every source. It lists every candidate row, usable or not, before anything is written. Usable rows have a tick box. Unusable rows show their reason and a disabled tick box.

**Each row shows (read-only):**
- the name it will be saved under. A name renamed by a clash at review time shows *renamed from "<name>"* in text, not by colour alone;
- `host:port`, or the SRV host with an SRV badge;
- the auth username, and a *password* badge when a password exists, whether in clear or sealed;
- default database, TLS, and SSH (on or off);
- its warnings and the files to re-pick.

**Each row can change:**
- **Tick.** Starts at the source's default: every usable row, except Compass recent connections (§4.1).
- **Credentials.** A ticked row gets inline username and password fields when its auth mechanism is default negotiation, SCRAM, or none, and its username or password is missing (`needsCredentials`), as in C13 §7.1 step 4.
  - A row whose only password is sealed gets the same fields once *"Import without passwords"* is chosen.
  - A username already in the row is pre-filled.
  - A blank username saves the row without authentication. A username with no password saves the username only.
  - A password typed with a blank username blocks *Import*, since it could not be used.
  - Typed values win over the row's own. A row the user didn't type in sends nothing and keeps what the source had.
  - X.509 and AWS rows are never asked.
- **Direct connection**, on non-SRV rows. Its starting value is decided in this order:
  1. **SRV.** SRV rows have no toggle: the driver refuses direct connection over SRV.
  2. **Multi-host string.** A row carrying `MULTI_HOST_TRUNCATED` starts **off**, even when the string sets `directConnection`, so the driver discovers the replica set from the first host, which is kept as the seed.
  3. **Explicit value.** A row whose connection string sets `directConnection` itself starts with that value. So does a row from a L'Atelier export, which carries its own `advanced.directConnection`.
  4. **Default.** On, with the hint *"Connects to this one host only. Turn off if this is one member of a replica set and you want the other members discovered."*

**Batch controls:**
- **Read-only, for all rows.** Off by default. It is not offered for a L'Atelier export, whose rows carry their own Read-only, and main ignores it for that source.
- **Passphrase.** When any usable row has sealed secrets (an encrypted L'Atelier or Compass export), the screen shows the Export Passphrase field and *"Import without passwords"*, which behave as in C13 §4.1 step 3. *Import* stays disabled until a passphrase is typed or *Import without passwords* is chosen. A wrong passphrase shows main's message under the field, and the review stays for a retry. Only the ticked rows' secrets are opened, so a wrong passphrase goes unnoticed when no ticked row is sealed. *"Import without passwords"* skips only sealed secrets. A password that was in clear in the source (a pasted string, a plain Compass export, a mapped Password) is still stored.

Nothing else is editable here. Read-only on a single row, names, SSH and TLS files are all changed in the form afterwards.

## 7. Commit and result

On confirm, main:
1. refuses a selection that repeats a row, names one that isn't in the import, or includes an unusable row. Nothing is written and the token stays usable;
2. opens the ticked rows' sealed secrets (§4.2, C13 §2), all before anything is written. A failure, such as `BAD_PASSPHRASE`, writes nothing;
3. re-plans names against the Connections that exist at that moment. Like the review, it plans over every usable row, ticked or not, so unticking a row cannot move another row's name;
4. builds each ticked row's Connection from the row, its opened secrets, the typed credentials, the Direct connection value sent (else §6's starting value), and Read-only (the batch value, or the L'Atelier row's own). The row is then validated with C13's import rules;
5. creates the rows one by one;
6. stores each created row's secrets through `SecretsVault`, under C13 §4.4's rule. A refusal is reported once per Connection.

A row that fails validation or creation is reported with its reason and doesn't stop the others. The rows already created stay.

The result screen shows:
- how many Connections were imported;
- which rows were skipped, and why;
- which were renamed: rows whose final name differs from the one the review showed, because a Connection with that name appeared in the meantime;
- the files still to pick;
- which secrets couldn't be stored;
- warnings, such as Compass secrets that were dropped (§4.2).

The Connections list is refreshed after a commit. It is also refreshed after any failure other than a wrong passphrase, because rows may have been created before the failure.

## 8. IPC

Main owns the dialog, the file and the parsed input. The renderer only ever holds a token, field paths, masked samples and row summaries. No file path, file contents, plaintext secret or derived key is in any result.

| Channel | Input | Output | SECRET? |
|---|---|---|---|
| `conn:importOpen` | none (`{}`, `null` or nothing); main shows the open dialog | `ImportOpenResult` | no |
| `conn:importMap` | `ImportMapInput` | `ImportMapResult` | no |
| `conn:importUris` | `{ uris: string[] }` (`api.conn.importUris(uris)`) | `ImportUrisResult` | yes (connection strings carry passwords) |
| `conn:importCommit` | `ImportCommitInput` | `ImportCommitResult` | yes (passphrase, typed passwords) |

The types, in `shared/types.ts`:

```ts
type MapTarget = 'name' | 'connectionString' | 'host' | 'port' | 'username'
  | 'password' | 'authDatabase' | 'defaultDb' | 'tls';
type ImportSource = 'latelier' | 'compass' | 'uris' | 'unknown';

type ReviewRow =
  | { index: number; ok: true;
      savedAs: string;
      renamedFrom?: string;          // the name the row asked for, when a clash renamed it
      host: string; port?: number;   // no port on SRV
      srv: boolean;
      authUsername?: string;
      hasPassword: boolean;          // a password exists, in clear or sealed
      passwordSealed: boolean;       // it exists only sealed, so it needs the passphrase
      needsCredentials: boolean;     // §6: missing a username or password; never X.509 or AWS
      directConnection: boolean | null;  // §6's starting value; null on SRV
      defaultTicked: boolean;
      repick: RepickFile[];
      warnings: string[];
      tls: boolean; defaultDb?: string; ssh: boolean }
  | { index: number; ok: false; reason: string };

interface Review { hasEncryptedSecrets: boolean; rows: ReviewRow[] }

interface MappingField { path: string; sample: string; masked: boolean; suggested?: MapTarget }
interface MappingCollection { at: string; rows: number; fields: MappingField[]; truncatedRows?: number; ambiguousFields?: number }

type ImportOpenResult =
  | { cancelled: true }
  | { token: string; source: 'latelier' | 'compass'; review: Review }
  | { token: string; source: 'unknown'; collections: MappingCollection[]; ambiguousCollections?: number };

interface ImportMapInput { token: string; at: string; mapping: Partial<Record<MapTarget, string>> }
interface ImportMapResult { review: Review }

interface ImportUrisResult { token: string; review: Review }

interface ImportCommitInput {
  token: string;
  indices: number[];
  passphrase?: string;
  withoutSecrets?: boolean;
  readOnly: boolean;
  credentials: { index: number; username?: string; password?: string }[];
  directConnection: { index: number; value: boolean }[];  // one per ticked non-SRV row
}
interface ImportCommitResult {
  created: { index: number; id: string; name: string }[];
  renamed: { index: number; from: string; to: string }[];
  skipped: { index: number; name: string; reason: string }[];
  repick: { name: string; files: RepickFile[] }[];
  secretsNotStored: { name: string; reason: string }[];
  warnings: { name: string; message: string }[];
}
```

`ParsedUri` (the form's `conn:parseUri`) gains `repick?: RepickFile[]` and `directConnectionExplicit?: boolean`, and `ParsedUriWarning.code` gains `'PROXY_DROPPED'` (§3).

- **Validation** (zod, in `electron/ipc/handlers/connImport.ts`):
  - `conn:importMap`: `at` and each path are at most 4096 characters, a path is non-empty, and the mapping's keys are `MapTarget`s. No path may serve two targets.
  - `conn:importUris`: 1–100 strings of 1–4096 characters.
  - `conn:importCommit`:
    - `indices` holds 1–1000 distinct non-negative integers.
    - `passphrase`, when present, is non-empty.
    - A credentials username is at most 128 characters.
    - `credentials` and `directConnection` hold at most 1000 entries each.
  - Every object is strict: an unknown key is refused.
- **Tokens.** A token works as in C13 §5 and lives in main.
  - A refused selection (§7 step 1) leaves the token usable.
  - The commit then takes the token before opening secrets. A failure while opening them, such as `BAD_PASSPHRASE` or a missing passphrase, puts it back for the retry. The exception is a window that closed meanwhile: its tokens must not outlive it.
  - A commit that gets past that point spends the token, even if every row ends up skipped.
  - Two concurrent commits on one token create the rows once.
  - Starting a new import (`conn:importOpen` or `conn:importUris`) drops every token already held, since one wizard runs at a time. A cancelled import's pasted passwords and file secrets don't stay in memory.
  - Every token expires when the window closes. Using a spent or expired token fails with *"This import has expired. Choose the file again."*
- `conn:importMap` works only on an Unknown JSON token, and only with a collection path the file has. It can be called again on the same token, and each call replaces the previous candidate rows. It carries no secret: the renderer sends paths, never values.
- `conn:importUris` and `conn:importCommit` are tagged `SECRET_INPUT` and listed in `scripts/ipc-secret-allowlist.txt`, beside C13's `conn:export`.
- These four channels are the only import channels. C13's preview, paste-preview and create-from-strings channels were removed with their allowlist entries. C13's commit channel name now carries the shape above. The channels follow the full 5-file IPC contract.

## Acceptance criteria

- Every C13 §6 entry point opens the wizard; the footer's Paste URIs and Import open it with the paste box or the file picker focused.
- A L'Atelier export, a Compass `version` 1 export, and any other JSON are each routed to the right path. A file over 5 MB, an unreadable file, non-JSON, and a Compass version other than 1 are each refused with their message.
- L'Atelier and Compass exports go straight to the final approval, with no Field Mapping step.
- A Compass export is read as canonical EJSON. It maps the connection string, the favourite name, a hex colour (a named Compass colour leaves the default), SSH host, port, username and password. An identity file becomes an `sshKey` re-pick, never a path.
- A passphrase-encrypted Compass export reviews without the passphrase, decrypts with the right one, gives `BAD_PASSPHRASE` for a wrong one and can be retried. "Import without passwords" works. A secret L'Atelier has no place for is reported by name only.
- Compass OIDC rows are listed as not importable with the OIDC message. Rows with configured FLE, an application-level proxy or proxy options in the string import with a warning.
- Compass favourites are ticked by default; recent connections are not.
- Field Mapping offers every array of objects within 5 levels, largest first, without searching a collection's rows. It treats a lone top-level object as one row and caps a collection at 500 rows.
- Field paths are flattened to dot paths over scalar leaves, at most 20 levels below the row. Secret-looking paths and connection strings that carry secrets are masked in main. A fully hidden sample (`••••`) carries the "Taken from the file — not shown" hint; a connection string with its secrets stripped shows that stripped form, with no hint.
- A path holding a secret can only feed Password or Connection string.
- Suggestions pre-fill from the key-name list and the `mongodb://` value rule, one path per target; the user can change or clear each one.
- Next is disabled until Connection string or Host is mapped.
- A mapped Connection string is the base, mapped fields only fill what it lacks, and conflicts warn. Without one, Host and Port build the Connection, and a port in Host wins over a mapped Port.
- Rows with no usable string or host are listed with their reason and can't be ticked.
- The final approval is the same component for all four sources and shows every row before anything is written.
- Direct connection is absent on SRV rows, starts off for multi-host strings, keeps an explicit value from the source, and otherwise starts on.
- Rows using default, SCRAM or no authentication and missing a username or password ask for both. X.509 and AWS rows never ask.
- Commit re-plans names, applies ticks, credentials, Direct connection and Read-only as sent (a L'Atelier row keeps its own Read-only), creates only ticked rows, and reports what was created, skipped, renamed, still needs a file, couldn't be stored, and any warnings.
- `tlsCAFile`/`tlsCertificateKeyFile` in any parsed string, including the form's URI paste, become re-pick markers, never paths.
- No plaintext secret, raw secret sample, file path or derived key crosses into the renderer.
- `conn:importOpen`, `conn:importMap`, `conn:importUris` and `conn:importCommit` are the only import channels, and the allowlist holds exactly the secret-carrying ones.

## Test cases

- **Unit** (`import-detect.spec.ts`): the size limit in bytes, before and after reading; detection order; the refusals (not JSON, Compass version other than 1, unreadable EJSON); C13's own refusals kept for a L'Atelier export; the real Compass export read as canonical EJSON; L'Atelier rows naming their sealed fields, never their values.
- **Unit** (`compass-crypto.spec.ts`): every entry of the real `encrypted.json` opens with the fixture passphrase; a wrong passphrase, a tampered tag and a tampered ciphertext give `BAD_PASSPHRASE`; an unsupported blob version is refused before key derivation; malformed blobs are damaged, not a wrong passphrase; dropped secrets are named, never valued.
- **Unit** (`compass-reader.spec.ts`): the real plain and encrypted exports cover a favourite, SSH with a password, SSH with an identity file, and OIDC; ticks from `savedConnectionType` with the favourite fallback; hex colours only; the FLE warning only when `autoEncryption` is configured; the application-level proxy warning; an entry with no string; and the refusals.
- **Unit** (`unknown-json.spec.ts`): collection discovery (top-level array, nested arrays largest first, a lone object, 5 levels but not 6, the 500-row cap, no search inside a collection's rows); fields (dot paths, first-row samples, 200 paths, 20 levels, `__proto__`); masking (each secret-looking key, secret lists, a URI with a password, `tlsCertificateKeyFilePassword`, `proxyPassword` or `AWS_SESSION_TOKEN`, invisible characters, unparseable and doubled strings, keys holding a string or over 256 characters, a non-secret path left alone); suggestions; and the §5.5 rules, including conflict warnings, Port, TLS and Host checks, a port in Host winning, and secret paths restricted to Password and Connection string.
- **Unit** (`import-review.spec.ts`): the review row, names (host rule, `host:port`, clashes, the 64-character cut, unusable rows taking no name), the Direct connection order, the credentials and sealed-password rules, and `hasEncryptedSecrets`.
- **Unit** (`uri-parser.spec.ts`): re-pick markers, `directConnectionExplicit`, the OIDC message, the proxy warning, host and port refusals, and the fixed sentence that never quotes the userinfo.
- **Property (fast-check)** (`unknown-json.property.spec.ts`): no planted secret, under a secret-looking key or in a connection string's password or secret parameters, appears in the Field Mapping output. Every path whose last key looks secret has the sample `••••`. Whatever the mapping, a row's secrets end up only in its `secrets`. The secrets are unique markers, so a match can't come from an ordinary word.
- **Integration** (`import-wizard-service.spec.ts`): each source end to end against the real fixtures. Covered:
  - a wrong passphrase, then the right one;
  - "Import without passwords" with typed credentials;
  - OIDC refused at commit with the token kept;
  - batch Read-only ignored for a L'Atelier export;
  - re-mapping on one token;
  - names re-planned at commit;
  - rows the import rules or `create()` refuse;
  - C13 §4.4 when secure storage is unavailable;
  - concurrent commits;
  - a window closing during a passphrase check;
  - `clearPending`.
- **Integration** (`import-wizard-handlers.spec.ts`): every channel's payload bounds (counts, string lengths including `at`, mapping paths and the credentials username, empty and unknown keys), and no secret in any result for each of the four sources.
- **Component** (`connection-transfer-palette.spec.tsx`): the command-palette entries for Export Connections… and Import Connections… each open their dialog.
- **Component** (`import-wizard-entry`, `-source`, `-mapping`, `-review`): entry points and dismissal, the paste limits, the mapping screen (suggestions, one path per target, masked samples, Next), and the final approval (routing per source, ticks, credentials, Direct connection, Read-only, passphrase retry with main's message, renames, result).
- **E2E** (`tests/e2e/c13-add-connections.e2e.ts`): add Connections from pasted strings with typed credentials, then batch-delete them.
- **E2E** (`tests/e2e/c13-connection-export-import.e2e.ts`): export two of three Connections with passwords, import them into a fresh profile, and connect without re-entering the password.
- **E2E** (`tests/e2e/c14-import-compass.e2e.ts`): with the encrypted Compass fixture, a wrong passphrase stays in the review and the right one imports the favourites. A Compass export imported with its passphrase connects without the password being typed again.
- **E2E** (`tests/e2e/c14-import-unknown-json.e2e.ts`): import `{ "servers": [{ "label", "uri", "secret" }] }`, accept the suggested mapping with the secret's sample masked, and connect.
