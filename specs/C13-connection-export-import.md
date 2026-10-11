# C13 — Connection Export / Import

> **Status: Implemented.**

## Purpose

Let a user write some or all of their saved Connections to a file and read them back, either on another machine, after a reinstall, or into a teammate's install. The file is a **Connection Export** (see `CONTEXT.md`). Secrets can travel inside it, but only encrypted under an **Export Passphrase** the user chooses at export time.

This is a standalone feature. It is **not** the safety net for the app-identity switch in [X09](./X09-namespace-rename.md) Phase 3: that switch keeps the userData directory where it is, so Connections survive it without an export.

## Scope

- **In**: exporting a chosen set of Connections, optionally with their secrets; importing a Connection Export with a preview (now through the [C14](./C14-import-wizard.md) wizard); passphrase encryption of secrets; entry points in the command palette, the File menu and the empty first-launch screen.
- **Out**:
  - Anything that belongs to a Connection rather than being part of it: saved queries, recent queries, workspace tabs, reference rules, the Audit Log, recent field values.
  - App preferences (`app_state`).
  - Credential file paths (TLS CA file, TLS client certificate, SSH private key). See §4.3.
  - Importing other tools' formats, such as MongoDB Compass connection exports. See [C14](./C14-import-wizard.md).
  - Updating an existing Connection from a file. Import only ever adds.

## Dependencies

- C01 (the `ConnectionInput` shape), C02 (the repository), F03 (`SecretsVault`, including its plaintext-fallback behaviour).
- `electron/security/credentialPaths.ts`: its rule that a credential path must come from a Browse pick is why §4.3 drops paths.

## 1. File format

A Connection Export is UTF-8 JSON. Suggested filename: `latelier-connections-YYYY-MM-DD.json`.

```jsonc
{
  "format": "latelier.connection-export",
  "version": 1,
  "exportedAt": "2026-10-02T09:00:00.000Z",
  "encryption": null,            // or the block in §2 when any secret is included
  "connections": [
    {
      "name": "Prod",
      // every other ConnectionInput field except password, sshPassword,
      // sshPassphrase and the three credential paths (§4.3). The paths are
      // the nested `tls.caPath`, `tls.clientCertPath` and `ssh.privateKeyPath`.
      "repick": ["tlsCa"],       // which credential files were set; names only, never a path
      "secrets": {               // present only when this Connection's secrets were exported
        "password": { "iv": "<b64>", "ct": "<b64>", "tag": "<b64>" }
      }
    }
  ]
}
```

- `format` and `version` are checked first. A file with a different `format` is not a Connection Export. A file with a `version` higher than this build supports is refused with *"This file was made by a newer version of L'Atelier. Update to import it."* Lower versions always import.
- `repick` is written by Export from whichever of the three paths were set: `'tlsCa' | 'tlsClientCert' | 'sshKey'`. It is how §4.1 and §4.3 know which files to ask for again, because a flag like `tls.enabled` cannot say whether a CA file was in use (Atlas-style TLS uses none). It carries no path.
- Within a supported version the schema is strict. An unknown field is an error, not something silently ignored: a field we don't understand could be a security setting that should not be lost.
- Every non-secret field is plain, readable JSON, so a user can inspect a file before importing it or sending it.
- No Connection `id`s and no timestamps are written. Import always creates new Connections (§4.2).

## 2. Secret encryption

Only the three secret fields (`password`, `sshPassword`, `sshPassphrase`) are ever encrypted. When at least one secret is included, the file carries:

```jsonc
"encryption": {
  "kdf": "scrypt", "salt": "<b64, 16 bytes>", "N": 131072, "r": 8, "p": 1,
  "cipher": "aes-256-gcm"
}
```

- The key is derived once per file from the Export Passphrase with Node's `crypto.scrypt`, using a random salt for each file. The parameters are recorded in the file so they can be raised later without a format change. At the default N, `maxmem` has to be raised above Node's default.
- The parameters in a file are bounded before they are used, because a crafted file would otherwise choose how much memory and time scrypt takes on the importer's machine. `N` must be a power of 2 with `2^10 ≤ N`, `N × r ≤ 2^21`, `N < 2^(16 × r)` (OpenSSL's own limit), `1 ≤ r ≤ 32` and `1 ≤ p ≤ 4`. A file outside these bounds is invalid and nothing is imported. The default (`N = 2^17`, `r = 8`) is half the cap, which leaves room to raise it.
- Each secret is encrypted with AES-256-GCM under its own random 12-byte IV.
- A wrong passphrase shows up as a GCM authentication failure on the first secret decrypted. There is no separate check value.
- All of this runs in the main process. Plaintext secrets never reach the renderer, and the renderer never sees the derived key.

**Export Passphrase rules:** at least 12 characters, entered twice. No strength meter.

## 3. Export

1. The user opens Export. A checklist lists every Connection, all ticked.
2. An "Include passwords" option, off by default. Turning it on reveals the two passphrase fields, and the action stays disabled until they match and satisfy §2.
3. On confirm, main reads the chosen Connections, builds the file and shows the save dialog. The file is written with mode `0600`, the same way `app:diagnosticBundle` writes, and an existing file the user chose to overwrite is tightened to `0600` as well.
4. If a chosen Connection's saved secret cannot be decrypted (`SECRET_DECRYPT_FAILED`), that Connection is still exported, without that secret. The result lists it: *"Prod: password not included, it couldn't be read."* One broken secret never blocks the export.
5. The result reports how many Connections were written and which secrets were omitted. Cancelling the save dialog writes nothing and reports nothing.

## 4. Import

### 4.1 Flow

> Replaced by [C14](./C14-import-wizard.md): every Import Source, a Connection Export included, runs through its one wizard (C14 §1), and the preview below is its final approval (C14 §6). The steps are kept here as the flow C14 started from. §4.2–§4.4 keep applying.

1. The user opens Import and picks a file. Main reads and validates it (§1). Any validation failure ends the flow with that error, and nothing is written.
2. **Preview:** a checklist of the file's Connections, all ticked. Each row shows, before anything is written:
   - the name it will be saved under (§4.2), with renames highlighted;
   - the credential files the user will need to pick again (§4.3);
   - whether it carries secrets.
3. If the file has encrypted secrets, the preview asks for the Export Passphrase. A wrong passphrase can be retried, and **"Import without passwords"** is always available as a way out.
4. On confirm, main creates the ticked Connections and then their secrets.
5. A result screen repeats what was renamed and what still needs a file picked, and lists any secrets that could not be stored (§4.4).

### 4.2 Identity and name clashes

- Every imported Connection gets a new UUID. Nothing that already exists is modified.
- Names are unique (C02). An imported name that clashes with an existing one, or with an earlier row in the same import, becomes `"<name> (2)"`, or the next free number.

### 4.3 Credential file paths are never imported

`tls.caPath`, `tls.clientCertPath` and `ssh.privateKeyPath` are neither written by Export nor accepted by Import. A file from someone else could otherwise point the TLS client-certificate field at `~/.ssh/id_rsa` and have the driver send that key to their server. That is exactly what `credentialPaths.ts` prevents. A Connection that had TLS or SSH enabled is imported with those features still enabled and their path fields empty. The preview and the result both list "re-pick CA file" (and the other files) for that Connection, from its `repick` marker. A Connection that needs a client certificate (X.509) is imported without one, so it cannot connect until the file is picked again; the import's own validation does not require the certificate or the secrets that Create would. Import also keeps `ssh.enabled` as exported rather than rejecting the file: connecting with SSH on is refused by the connect path with its own message, and rejecting the file would lose the other Connections in it.

### 4.4 Secrets on an install that can't store them securely

Imported secrets go through `SecretsVault.set` like any other secret, so its existing rule applies. If the keychain is unavailable and `secrets.allowPlaintextFallback` is off, the Connection is still imported, without its secrets, and the result says why. Import never asks to turn on plaintext storage.

## 5. IPC

Export and import run in main, following the `app:diagnosticBundle` model: main builds or reads the file and owns the dialogs. Secrets are never carried to the renderer.

| Channel | Input | Output | SECRET? |
|---|---|---|---|
| `conn:export` | `{ ids: string[]; includeSecrets: boolean; passphrase?: string }` | `{ written: number; omittedSecrets: { name: string; field: string }[] } \| { cancelled: true }` | yes (passphrase) |

- **Import channels: replaced by [C14](./C14-import-wizard.md) §8.** `conn:importPreview` was replaced by `conn:importOpen`. `conn:importCommit` keeps its name but now takes and returns C14's shape, for every Import Source. The token rules are C14 §8's.
- The `token` refers to the parsed file held in main between preview and commit. The renderer never sends the file contents back.
- A wrong passphrase on `conn:importCommit` fails with the stable code `BAD_PASSPHRASE` and writes nothing, so the user can retry.
- `conn:export` and `conn:importCommit` carry secrets, so both are listed in `scripts/ipc-secret-allowlist.txt` and tagged `SECRET_INPUT`.
- Names are illustrative. Follow the existing `conn:*` naming and the full 5-file IPC contract.

## 6. Entry points

- Command palette: "Export Connections…" and "Import Connections…".
- The native File menu: the same two items.
- The Connections table (the Switcher's "Manage connections", or `⌘E` anywhere in the Data View but an Aggregation tab): Import from its footer (§7), Export on checked rows (§8). Not in the Switcher popover itself, which stays a list to pick from.
- The empty first-launch screen, when no Connections exist: an "Import connections" button next to the add-connection action. This is where a user on a new machine arrives.

## 7. Add connections (connection strings, file import, form)

Import is a way of adding, so the Connections table's footer has the three ways side by side, each one click away, with no chooser in between:

- **+ New**: the existing full form, first because it is the common case, and still the only way to set up SSH or TLS certificate files.
- **Paste URIs**: connection strings, one per line. It opens the [C14](./C14-import-wizard.md) wizard with the paste box focused.
- **Import**: opens the C14 wizard with the file picker focused.

### 7.1 Connection strings

> Replaced by [C14](./C14-import-wizard.md): Pasted URIs are an Import Source in its wizard, and its per-row Direct connection choice (C14 §6) replaces the batch default in step 2. The limits, naming and credential rules here keep applying.

1. **Paste.** Each non-empty line is one `mongodb://` or `mongodb+srv://` string, parsed in main by the same parser as the form's URI paste. Up to 100 lines of up to 4096 characters each. A preview lists every line before anything is written: the name it will be saved under, the host, whether it carries credentials, and the reason for any line that cannot be parsed. Bad lines never block the good ones; they are skipped and listed.
2. **Defaults** apply to every line. All three are maintainer-overridable choices:
   - *Read-only*, off by default.
   - *Direct connection*, off by default. A line that sets `directConnection` itself keeps its own value. Never applied to an SRV line: the driver refuses `directConnection` with `mongodb+srv`.
3. **Names.** The hostname (an SRV line's cluster host; a replica-set line's first host). When lines in the same batch share a hostname with different ports, those lines are named `host:port`. A name is cut to the 64-character limit (the host itself is kept whole). Clashes with existing names, or within the batch, then get `" (2)"` exactly as §4.2.
4. **Credentials.** Any line whose string lacks a username or a password is listed again, one per row, asking for both (a username in the string is prefilled). Blank is accepted: a line with no username saves without authentication, and a username with no password saves the username only. X.509 and AWS lines are not asked: X.509 needs its client certificate picked in the form afterwards and is listed like §4.3's re-picks.
5. **Commit** re-parses and re-plans names against what exists at that moment (as §4.1 does), validates each line with the import rules, and creates them one by one. Passwords go through `SecretsVault` with §4.4's rule: no secure storage keeps the Connection and reports the password as not stored. The result lists what was created, renamed, failed, and still needs a file picked.

Passwords never travel back to the renderer: the preview reports only whether a line has one.

The channels this screen used are **replaced by [C14](./C14-import-wizard.md) §8**: `conn:previewUris` by `conn:importUris`, and `conn:createFromUris` by `conn:importCommit`.

## 8. Checked rows and batch actions

The Connections table has a checkbox column, with a header checkbox that checks or clears every row the current search shows (indeterminate when only some are). **Checked** is a separate state from the row whose details are open ("selected"). A search drops checks from the rows it hides, so a batch action never touches a Connection the user cannot see.

A bar above the table always offers these, disabled until a row is checked:

- **Export**: the §3 export with the checked Connections fixed, so it shows only the passwords option and the passphrase, not a second checklist.
- **Delete**: one confirmation naming the count and the total open tabs, then the same delete as a single row for each, reporting any that fail.

The table stays open through both, so more batch actions can join the bar later. A dialog stacked on the table takes Escape for itself; the table closes on Escape only when nothing is stacked on it.

The table's footer holds only the three ways to add (§7). Export of every Connection stays reachable from the command palette and the File menu.

## Acceptance criteria

- Export writes only the ticked Connections, every field except secrets and the three credential paths, as readable JSON with mode `0600`.
- With "Include passwords", secrets are AES-256-GCM-encrypted under an scrypt key from the Export Passphrase, whose parameters and salt are recorded in the file. Without it, the file has `"encryption": null` and no `secrets` keys.
- The Export Passphrase must be at least 12 characters and entered twice.
- A secret that can't be decrypted is left out of the export and reported. The export still succeeds.
- Import validates `format`/`version`, refuses a newer version with an "update" message, and rejects unknown fields.
- The import preview shows the final names (with clash renames), the files that need re-picking, and secrets, before anything is written. This is now C14's final approval.
- Import always creates new Connections and never modifies existing ones.
- Credential paths are never imported; affected Connections are listed.
- A wrong passphrase can be retried; "Import without passwords" imports everything else.
- Without secure storage and with the plaintext fallback off, Connections import without secrets and the result says why.
- Export and Import are reachable from the command palette, the File menu and the empty first-launch screen.
- Plaintext secrets and the derived key never cross into the renderer.
- Pasting several connection strings previews each line's saved name, credentials and errors before anything is written; bad lines are skipped and listed.
- Read-only is a batch default for every pasted line, and SRV lines never get direct connection. The batch Direct connection default is replaced by C14 §6's per-row choice.
- Lines missing a username or password are listed one per row for credentials; blanks are accepted.
- The preview never returns a password to the renderer.
- The Connections table checks rows (with check-all over the visible rows) and exports or deletes the checked set without closing.

## Test cases

- **Unit:** an encryption round trip; a wrong passphrase gives `BAD_PASSPHRASE`; a tampered ciphertext or tag is rejected; the scrypt parameters are read from the file, not hard-coded, on decrypt.
- **Property (fast-check):** for any generated set of `ConnectionInput`s, export then import (with or without secrets) recovers every field except the three paths, and the recovered names are unique against any pre-existing name set.
- **Unit:** the clash renamer: `Prod` → `Prod (2)`; with `Prod (2)` taken → `Prod (3)`; clashes inside one file.
- **Unit:** schema validation: newer `version` refused, unknown field rejected, a file with a different `format` rejected.
- **Integration:** export with one undecryptable secret still writes the file and reports the omission; import with the plaintext fallback off and the keychain unavailable creates the Connections without secrets.
- **Integration:** a file that sets `tls.clientCertPath` is rejected by the strict schema, so a crafted path never reaches `credentialPaths`.
- **E2E:** export two of three Connections with passwords, wipe userData, import with the passphrase, connect to the in-memory server without re-entering the password.
