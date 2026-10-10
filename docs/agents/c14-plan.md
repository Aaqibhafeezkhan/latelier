# C14 Import Wizard — implementation plan (issue #398)

Integration branch `feat/398-import-wizard` (off `main`); one PR at the end, `Closes #398`. Workers use worktrees `../wt-c14-<slice>` on branch `feat/398-<slice>` off the integration branch; lead merges each slice into the integration branch (never amend; new commits).

## 0. Grounding facts (verified in code)

- Old IPC: `conn:importPreview|importCommit|previewUris|createFromUris` live in `shared/ipc.ts:180-184,461-464`, `electron/preload.ts:52-55`, `electron/ipc/handlers/connExport.ts` (`registerConnExportChannels`), `electron/services/ConnectionExportService.ts` (`importPreview`, `importCommit`, `previewUris`, `createFromUris`, private `storeSecrets`), `electron/main.ts:606,681` (`connExportSvc`; `clearPending` at :380), `scripts/ipc-secret-allowlist.txt` (`conn:importCommit`, `conn:previewUris`, `conn:createFromUris`; `conn:export` stays), `tests/helpers/atelierMock.ts:37-40,359-362`.
- Old types: `ImportPreview`, `ImportCommitInput`, `ImportCommitResult`, `UriBatchDefaults`, `UriCredentials`, `UriPreviewEntry`, `UriPreview`, `UriCommitInput` in `shared/types.ts:104-178`. `RepickFile`, `ExportSecretField`, `ParsedUri`, `ParsedUriWarning` stay (extended).
- Reusable: `connectionExportFormat.ts` (`parseConnectionExport`, `entryToConnectionInput`, `decryptSelected`, `planNames`, `uniqueName`, `MAX_FILE_BYTES`, `MAX_NAME_LENGTH`, `BadPassphraseError`); `connectionBulkAdd.ts` (`parseLine`, `baseNames`, `planLineNames`, `needsCredentials`, `repickFor`, `lineToInput`, `lineInputProblem`, `MAX_URI_LINES/LENGTH`) — `lineToInput` hardcodes `DEFAULT_COLOR` and `defaults.directConnection`; `ConnectionExportService.storeSecrets` (C13 §4.4 logic) — extract/reuse, do not rewrite.
- Renderer: `ConnectionImportDialog.tsx` (191 lines) + `ConnectionAddDialog.tsx` (356 lines, Paste URIs) are the screens to replace. Mounts: `ConnectionTransferProvider.tsx` (palette/File menu/empty screen via `openImport`), `ConnectionExpandedTable.tsx:651` (footer, mounts `ConnectionAddDialog`). `ConnectionForm.tsx:1058` `handlePasteUri` consumes `api.conn.parseUri` (`ParsedUri`).
- Tests touching old surface (must be rewritten/removed): `tests/component/connection-import-dialog.spec.tsx`, `connection-add-dialog.spec.tsx`, `tests/integration/conn-export-handlers.spec.ts`, `connection-export-service.spec.ts`, `tests/e2e/c13-add-connections.e2e.ts`, `c13-connection-export-import.e2e.ts`, `tests/unit/uri-parser.spec.ts`, `uri-parse.property.spec.ts`.
- `tests/fixtures/` does not exist yet. `bson` (`EJSON`) is already a dependency (`electron/mongo/ejson.ts`). Stryker already mutates `uri-parse.ts`, `connectionBulkAdd.ts`, `connectionExportFormat.ts` (any edit there must keep >=90%).

## 1. Slice A — contract (S). Lands first, alone.

Adds only; nothing removed. Keeps `tsc -b` green because it also wires preload + atelierMock.

Files: `shared/types.ts`, `shared/ipc.ts`, `electron/preload.ts`, `tests/helpers/atelierMock.ts`, new `electron/services/import/candidateRow.ts` (main-only internal type, shared by B/C/D/E).

```ts
// shared/types.ts — ADD
export type MapTarget =
  | 'name' | 'connectionString' | 'host' | 'port' | 'username'
  | 'password' | 'authDatabase' | 'defaultDb' | 'tls';
// shared/ is types-only: the runtime target list lives in unknownJson.ts (main) and mapTargets.ts (renderer).

export type ImportSource = 'latelier' | 'compass' | 'uris' | 'unknown';

export type ReviewRow =
  | {
      index: number; ok: true;
      savedAs: string;
      host: string; port?: number; srv: boolean;        // port absent on SRV
      authUsername?: string;
      hasPassword: boolean;                              // a password exists, plaintext or sealed
      passwordSealed: boolean;                           // the password only exists sealed (needs the passphrase); see §9 L4
      needsCredentials: boolean;                         // password-auth row with no password at all; false for x509/awsiam/none
      directConnection: boolean | null;                  // null on SRV
      defaultTicked: boolean;
      repick: RepickFile[];
      warnings: string[];
      tls: boolean; defaultDb?: string; ssh: boolean;    // §6 read-only fields (spec §8 omits these; see issue S9)
    }
  | { index: number; ok: false; reason: string };

export interface Review { hasEncryptedSecrets: boolean; rows: ReviewRow[]; }

export interface MappingField { path: string; sample: string; masked: boolean; suggested?: MapTarget; }
export interface MappingCollection { at: string; rows: number; fields: MappingField[]; truncatedRows?: number; }

export type ImportOpenResult =
  | { cancelled: true }
  | { token: string; source: 'latelier' | 'compass'; review: Review }
  | { token: string; source: 'unknown'; collections: MappingCollection[] };

export interface ImportMapInput { token: string; at: string; mapping: Partial<Record<MapTarget, string>>; }
export interface ImportMapResult { review: Review; }

export interface ImportUrisInput { uris: string[]; }
export interface ImportUrisResult { token: string; review: Review; }

export interface ImportCommitInput2 {                    // named ImportCommitInput after slice R
  token: string;
  indices: number[];
  passphrase?: string;
  withoutSecrets?: boolean;
  readOnly: boolean;
  credentials: { index: number; username?: string; password?: string }[];
  directConnection: { index: number; value: boolean }[];  // renderer sends one per ticked non-SRV row
}
export interface ImportCommitResult2 {                   // ImportCommitResult after R
  created: { index: number; id: string; name: string }[];
  renamed: { index: number; from: string; to: string }[];
  skipped: { index: number; name: string; reason: string }[];   // validation/create failures (replaces `failed`)
  repick: { name: string; files: RepickFile[] }[];
  secretsNotStored: { name: string; reason: string }[];
  warnings: { name: string; message: string }[];         // e.g. Compass secret fields dropped after decryption (§9 L4)
}

// ParsedUri — EXTEND (slice B implements; A only declares)
export interface ParsedUri {
  input: Partial<ConnectionInput>;
  warnings: ParsedUriWarning[];
  repick?: RepickFile[];                 // tlsCAFile -> 'tlsCa', tlsCertificateKeyFile -> 'tlsClientCert'
  directConnectionExplicit?: boolean;    // string set directConnection itself (any value)
}
// ParsedUriWarning.code: add 'PROXY_DROPPED'
```

`shared/ipc.ts`: `IPC_CHANNELS.connImportOpen: 'conn:importOpen'`, `connImportMap: 'conn:importMap'`, `connImportUris: 'conn:importUris' // SECRET_INPUT`. `conn:importCommit` already exists with C13 types and the old dialogs call it until F2 deletes them, so A adds the C14 commit as a **temporary** key `connImportCommitV2: 'conn:importCommit2'` (SECRET_INPUT) on `IpcApi.conn.importCommitV2` with `ImportCommitInput2/ImportCommitResult2`; slice R renames it to `conn:importCommit` in the same commit that deletes the old one. The temporary string never ships.

`IpcApi.conn` gets: `importOpen(): Promise<ImportOpenResult>`, `importMap(i): Promise<ImportMapResult>`, `importUris(uris: string[]): Promise<ImportUrisResult>`, `importCommitV2(i): Promise<ImportCommitResult2>`. `preload.ts` binds them (`call(IPC_CHANNELS.…, …)`); `atelierMock.ts` gets `unused(...)` entries in the strict mock and defaults (`importOpen: okAsync({ cancelled: true })`, others `noopAsync`) in the default mock — **only A edits `atelierMock.ts` until R/F2** (F tests override per-test via the existing override mechanism).

`candidateRow.ts`:
```ts
export interface CandidateRow {
  input: Partial<ConnectionInput>;      // no secrets (password/sshPassword/sshPassphrase excluded)
  secrets: SecretValues;                // plaintext, main only
  sealed?: { kind: 'latelier' | 'compass'; /* opaque to the service, decrypted at commit */ };
  nameHint: string;                     // raw name before cut/dedupe ('' => derive from host)
  explicitDirect: boolean;
  multiHost: boolean;                   // carries MULTI_HOST_TRUNCATED
  warnings: string[]; repick: RepickFile[];
  defaultTicked: boolean;
  unusable?: string;                    // reason; row cannot be ticked
}
```
Gates: `npx tsc -b`, `npm run lint`, `npm run audit:ipc`. Covers: nothing in the matrix (pure contract). Size S.

## 2. Slices

| ID | Work | Files created (C) / modified (M) | Depends | Mutate | Size |
|---|---|---|---|---|---|
| A | Contract (above) | M `shared/types.ts`, `shared/ipc.ts`, `electron/preload.ts`, `tests/helpers/atelierMock.ts`; C `electron/services/import/candidateRow.ts` | – | no | S |
| B | Parser changes + form markers | M `electron/mongo/uri-parse.ts`, `electron/services/connectionBulkAdd.ts` (`parseLine` reads `directConnectionExplicit`/`repick` from parser, drops `hasParam`; `repickFor` merges parser repick), `src/features/connections/ConnectionForm.tsx` (`handlePasteUri` toast lists re-pick files), `tests/unit/uri-parser.spec.ts`, `uri-parse.property.spec.ts`, `tests/component/` form-paste spec | A | uri-parse, connectionBulkAdd already in; keep >=90 | S |
| C | Compass reader + decryption | C `electron/services/import/compassCrypto.ts`, `compassReader.ts`; C `tests/unit/compass-crypto.spec.ts`, `compass-reader.spec.ts`, `tests/fixtures/compass/…` (§5) | A (B for `repick`/OIDC from parser; can stub) | add both | M |
| D | Unknown JSON: discover/flatten/mask/suggest/combine | C `electron/services/import/unknownJson.ts` (+ optional split `unknownJsonMask.ts`); C `tests/unit/unknown-json.spec.ts`, `unknown-json.property.spec.ts` | A, B (combine calls `parseLine`) | add all | M |
| E | Service + IPC + detection + review + commit | C `electron/services/ImportWizardService.ts`, `electron/services/import/detect.ts`, `latelierSource.ts`, `review.ts`; C `electron/ipc/handlers/connImport.ts`; M `electron/main.ts` (construct + register + clearPending), `scripts/ipc-secret-allowlist.txt` (add `conn:importUris`, `conn:importCommitV2`→later name), `connectionBulkAdd.ts` (add `directConnection` param to `lineToInput`; color from candidate); C tests `tests/unit/import-detect.spec.ts`, `import-review.spec.ts`, `tests/integration/import-wizard-service.spec.ts`, `import-wizard-handlers.spec.ts` | A, B, C, D | detect.ts, review.ts, latelierSource.ts | L |
| F1 | Wizard Source + Field Mapping steps (renderer) | C `src/features/connections/importWizard/SourceStep.tsx`, `MappingStep.tsx`, `mapTargets.ts`; C `tests/component/import-wizard-source.spec.tsx`, `import-wizard-mapping.spec.tsx` | A | no | M |
| F2 | Wizard shell + Final approval + Result + entry points; delete old dialogs | C `…/importWizard/ImportWizard.tsx`, `ReviewStep.tsx`, `ResultStep.tsx`; M `ConnectionTransferProvider.tsx`, `ConnectionExpandedTable.tsx` (footer: Paste URIs / Import open the wizard at source); D `ConnectionImportDialog.tsx`, `ConnectionAddDialog.tsx`, their two component specs; C `tests/component/import-wizard-review.spec.tsx`, `import-wizard-entry.spec.tsx` | A, F1 props only | no | L |
| G | E2E | M `tests/e2e/c13-add-connections.e2e.ts`, `c13-connection-export-import.e2e.ts` (drive wizard); C `tests/e2e/c14-import-compass.e2e.ts`, `c14-import-unknown-json.e2e.ts` | E, F1, F2, C fixture | no | M |
| R | Retire old channels | M `shared/ipc.ts` (delete 4 old keys + `IpcApi` members, rename `connImportCommitV2`→`connImportCommit`), `shared/types.ts` (delete old types, rename `*2`), `electron/preload.ts`, `electron/ipc/handlers/connExport.ts` (keep export only), `ConnectionExportService.ts` (keep `export`/dialogs/`clearPending`; delete import/uri methods), `main.ts`, allowlist (remove `conn:previewUris`, `conn:createFromUris`; keep one `conn:importCommit`, add `conn:importUris`), `atelierMock.ts`, `tests/integration/conn-export-handlers.spec.ts`, `connection-export-service.spec.ts` | E, F2 | no | S |

Dependency edges: A→{B,C,D,F1,F2}; B→{C(repick),D,E}; {C,D}→E; {E,F2}→R; {E,F1,F2,R,fixture}→G.

## 3. Ownership matrix (every criterion/test exactly one owner)

| # | Acceptance criterion / test case | Owner | Also exercised by |
|---|---|---|---|
| AC1 | Every C13 §6 entry point opens wizard; footer Paste URIs/Import open at matching source | F2 (component) | G |
| AC2 | Detection routing + refusals (non-JSON, Compass ≠1) | E (unit `detect`) | – |
| AC3 | L'Atelier/Compass skip Field Mapping | F2 (shell state machine) | G |
| AC4 | Compass mapping (string, name, colour, SSH, identity file→sshKey) | C | – |
| AC5 | Encrypted Compass: decrypt / `BAD_PASSPHRASE` retry / without passwords | C (crypto unit); retry + withoutSecrets flow = E integration | G |
| AC6 | OIDC unimportable; FLE/proxy warn | C | – |
| AC7 | Favourite ticked, recent unticked | C | – |
| AC8 | Collections within 5 levels, largest default, lone object | D | – |
| AC9 | Flatten, masking in main + hint | D | F1 (hint rendered) |
| AC10 | Suggestions (names + `mongodb://` rule), editable/clearable | D (suggest) | F1 (UI edit/clear) |
| AC11 | Next disabled until string or host mapped | F1 | – |
| AC12 | Connection string base, fill-only, conflict warn | D | – |
| AC13 | Unusable rows listed with reason, unticked/disabled | F2 (disabled tick) | D (reason), E |
| AC14 | One final-approval component for all four sources | F2 | – |
| AC15 | Direct connection default/explicit/multi-host/SRV | E (`review.ts` unit) | F2 (toggle UI, absent on SRV) |
| AC16 | `tlsCAFile`/`tlsCertificateKeyFile` → re-pick (incl. form paste) | B | – |
| AC17 | No secret/raw sample/key to renderer | E (integration: JSON-serialize every channel output, assert no planted secret) | D property |
| AC18 | Old channels + allowlist entries gone | R | – |
| T1 | Unit: detection order + 3 refusals ("No connections found" part) | E (not-JSON, version≠1); D (no rows found) | – |
| T2 | Unit: Compass decryption vs real fixture (right/wrong/tampered tag) | C | – |
| T3 | Unit: Compass entry → row (favourite, recent, SSH pw, identity file, OIDC, FLE, non-hex colour) | C | – |
| T4 | Unit: collection discovery (top array, nested largest-first, lone object, depth, 500 cap) | D | – |
| T5 | Unit: masking cases | D | – |
| T6 | Unit: §5.5 combination incl. conflict, Port/TLS coercions | D | – |
| T7 | Unit: Direct connection defaults | E | – |
| T8 | Property: masked samples `••••`; no planted secret in `importOpen` output | D (property on `buildCollections`); E asserts the full-output variant in AC17 | – |
| T9 | Integration: commit applies ticks/credentials/direct/readOnly; only ticked created; C13 §4.4 | E | – |
| T10 | E2E: Compass fixture with passphrase → connect | G | – |
| T11 | E2E: unknown JSON `servers[{label,uri,secret}]` → connect | G | – |

## 4. Schedule (cap 3 workers, own worktree each)

| Wave | Slots | Notes |
|---|---|---|
| 0 | A (lead may do it inline, ~S) | Merge before anything else; everyone codes against it. |
| 1 | B, C, D | B is small; when it finishes start F1 in its slot (rolling). C fixture-independent parts only (§5). D calls `parseLine` — pull B first or stub with current `parseLine` (B only adds fields). |
| 2 | E, F1 (if not started), F2 | E needs B,C,D merged. F2 needs F1's prop interfaces (spec'd below), not its code. |
| 3 | R (needs E, F2), then G (needs fixture, E, F1, F2, R) | G and R touch disjoint files; run R first, then G on the clean tree, or both in parallel (2 slots). |
| 4 | Lead | Full DoD chain on integration branch: tsc, lint, `npm test`, `npm run test:mutation`, `npm run audit:ipc` + `ipc-channel-auditor`, `npm run test:e2e`, `spec-compliance-reviewer` vs C14 (status line `Accepted`→`Implemented`; C13 §4.1/§7.1 notes updated; `specs/README.md` index), independent PR reviewer (Gitar disabled), open the PR. |

Overlap hazards and rules:
- `shared/types.ts`, `shared/ipc.ts`, `electron/preload.ts`, `tests/helpers/atelierMock.ts`: A creates all additions; B–G must not edit them. R is the only later editor. If a worker needs a type tweak it returns a note; lead applies it on the integration branch and tells siblings to rebase.
- `electron/main.ts`, `scripts/ipc-secret-allowlist.txt`: E (add) and R (remove) only, sequential.
- `connectionBulkAdd.ts`: B edits `parseLine`/`repickFor`; E edits `lineToInput`. Sequential (B merged before E starts); D only imports.
- `uri-parse.ts` tests: only B.
- `ConnectionForm.tsx`: only B (single function).
- Component tests: F1/F2 override mock methods locally inside their spec files (`makeAtelierMock({ conn: { importOpen: … } })` style as existing specs do) — never edit the helper.
- F1/F2 prop contract (so they can run in parallel): `SourceStep({ onFile(): void; onUris(uris: string[]): void; initial: 'file'|'paste'; busy; error })`, `MappingStep({ collections: MappingCollection[]; onBack(); onNext(at: string, mapping: Partial<Record<MapTarget,string>>) })`. F2's shell owns the state machine and all `api.conn.*` calls; F1 components are presentational.
- Never `npm ci`/`npm install` in any worktree (shared `node_modules` symlink). Never run two file-mutating agents in one checkout.

## 5. Compass fixture (slice C)

**Superseded by §9 L1** — the lead generated real fixtures; the list below is kept for history only.

Needed from the maintainer (real Compass install, any version that writes `"type": "Compass Connections", "version": 1`): put under `tests/fixtures/compass/`:
1. `plain.json` — export **without** passphrase containing one saved favourite (name + colour) and one SSH-tunnel connection (password auth).
2. `encrypted.json` — export **with** passphrase containing the same two, plus
3. `encrypted.passphrase.txt` — the passphrase used (test-only value).
4. `ssh-key.json` + `ssh-key-encrypted.json` (+ passphrase file) — SSH connection using an identity file with a key passphrase (spec asks "with and without passphrase"; the identity-key path needs its own entry). Add a recent (non-favourite) connection and a `MONGODB-OIDC` entry only if Compass can produce them; otherwise tests use hand-edited copies marked `synthetic`.
Also ask for the Compass version number (note in `tests/fixtures/compass/README`-free: put it in the fixture's test header comment).

Can proceed without them: `compassCrypto.ts` against vectors built in the test using the documented layout (2-byte BE version=1, 16 salt, 16 IV, 16 tag, ciphertext; pbkdf2-sha512 100000 → 32 bytes; AES-256-GCM, no AAD) — covers right/wrong passphrase/tampered tag mechanically; `compassReader.ts` mapping (favourite/recent/SSH/identity file/OIDC/FLE/colour) on hand-written plaintext EJSON. **Must wait for fixture:** the "pins the format against a real export" assertion (spec §4.2 last paragraph), the Compass e2e (T10), and confirming whether recent connections appear in exports and the real field names (`favorite`, `connectionOptions.sshTunnel`, `connectionSecrets`). Synthetic vectors must be labelled as such in test names, so they never stand in for the real-fixture test.

## 6. Worker briefs (dispatch verbatim; replace `<INT>` with the integration SHA)

Common preamble for every brief: "You are in worktree `../wt-c14-<slice>` on branch `feat/398-<slice>` created off `feat/398-import-wizard`. FORBIDDEN: `npm install`, `npm ci`, `npx` installs (node_modules is a shared symlink). Edit only the files listed. No `console.log` (use `electron/log.ts`), no issue numbers in code comments, string sorts use `.localeCompare`. Every test has an assertion. Read `CLAUDE.md` and `specs/C14-import-wizard.md` sections named below first; `shared/types.ts` additions from slice A are the contract — do not edit shared files; if you need a change, stop and report it. Commit on your branch (new commits only, never `--no-verify`). Return: files changed, gate output summary, anything you could not do."

**Brief A (contract).** Branch `feat/398-A`. Files: `shared/types.ts`, `shared/ipc.ts`, `electron/preload.ts`, `tests/helpers/atelierMock.ts`, new `electron/services/import/candidateRow.ts`. Implement §1 of `docs/agents/c14-plan.md` verbatim (types, 4 new channel keys incl. temporary `connImportCommitV2`, `IpcApi` members, preload bindings, mock entries in BOTH the strict `unused()` block and the default block). Add nothing else; remove nothing. `MAP_TARGETS` runtime array must NOT be in `shared/`. Gates: `npx tsc -b`, `npm run lint`, `npm run audit:ipc` (expect it to still pass: new SECRET_INPUT tags are on `conn:importUris`/`conn:importCommitV2` — add both to `scripts/ipc-secret-allowlist.txt` in this slice; this is the one allowed edit outside the list).

**Brief B (parser).** Branch `feat/398-B`. Spec §3 and AC16. Files: `electron/mongo/uri-parse.ts`, `electron/services/connectionBulkAdd.ts`, `src/features/connections/ConnectionForm.tsx` (`handlePasteUri` only), `tests/unit/uri-parser.spec.ts`, `tests/unit/uri-parse.property.spec.ts`, the form-paste component spec (find with `grep -rl handlePasteUri\|parseUri tests/component`). Do: (1) `tlsCAFile`→`repick` `'tlsCa'`, `tlsCertificateKeyFile`→`'tlsClientCert'` (never a path in `input.tls`); X.509 mech keeps `tlsClientCert` too, deduped. (2) return `directConnectionExplicit` (key present, any value, non-SRV only); do NOT change `input.advanced.directConnection`'s absent→`false` value (the form relies on it). (3) `MONGODB-OIDC` → throw `ValidationError("OIDC sign-in isn't supported yet.")` exactly; other unknown mechs unchanged. (4) proxy params (`proxyHost`,`proxyPort`,`proxyUsername`,`proxyPassword`) → warning `PROXY_DROPPED`. (5) `parseLine` consumes the new fields and `hasParam` is deleted; `repickFor` returns the union. (6) Form toast lists re-pick files by name ("re-pick CA file", "re-pick client certificate"). Tests: each new behaviour incl. case-insensitivity of the param names; property: no path string ever appears in `input` for generated `tlsCAFile` values. Gates: `npx tsc -b`; `npm run lint`; `npx vitest run tests/unit/uri-parser.spec.ts tests/unit/uri-parse.property.spec.ts tests/unit/connection-export-format*.spec.ts <form spec>`; `npx stryker run --mutate electron/mongo/uri-parse.ts,electron/services/connectionBulkAdd.ts` (>=90%; new survivors: kill or prove equivalent with a node probe). Do not touch `shared/`.

**Brief C (Compass).** Branch `feat/398-C`. Spec §4 (all), AC4-7, T2-T3. Files (create): `electron/services/import/compassCrypto.ts` (`decryptCompassSecrets(b64: string, passphrase: string): CompassSecrets`; throws `BadPassphraseError` from `electron/errors.ts` on GCM failure and `ValidationError` on version≠1/short buffer; only `crypto.pbkdf2Sync`/`createDecipheriv`, no deps), `compassReader.ts` (`readCompass(parsed: unknown): { rows: CandidateRow[] }`; uses `EJSON.parse` from `bson` on the file text in the caller — accept an already-EJSON-parsed value; `sealed: { kind:'compass', connectionSecrets }` on encrypted entries; favourites `defaultTicked: true`, others false; colour valid hex else `#7c6af7`; identity file → `ssh.authMethod:'key'` + repick `sshKey`, never the path; OIDC → `unusable: "OIDC sign-in isn't supported yet."`; `fleOptions` / proxy → warning only; connection string via `parseLine` from `connectionBulkAdd.ts`, setting `explicitDirect`/`multiHost`; `nameHint` = `favorite.name`), plus `tests/unit/compass-crypto.spec.ts`, `compass-reader.spec.ts`, fixtures under `tests/fixtures/compass/` if the maintainer has supplied them (plan §5; otherwise synthetic vectors named `synthetic: …`). Secrets of the decrypted blob: `password`→`secrets.password`, `sshTunnelPassword`→`sshPassword`, `sshTunnelPassphrase`→`sshPassphrase`, everything else dropped with a warning string naming the field (never its value). Mutation: add both files to `stryker.config.json` `mutate` (only this slice edits that file in wave 1; D adds its own line in its brief — lead resolves the trivial array merge). Gates: `npx tsc -b`; `npm run lint`; `npx vitest run tests/unit/compass-*.spec.ts`; `npx stryker run --mutate electron/services/import/compassCrypto.ts,electron/services/import/compassReader.ts` (>=90%).

**Brief D (Unknown JSON).** Branch `feat/398-D`. Spec §5, AC8-10,12, T4-T6, T8. Files (create): `electron/services/import/unknownJson.ts` exporting pure functions `findCollections(value): Collection[] | throws ValidationError("No connections found in this file.")` (depth ≤5, largest default first, 500-row cap with `truncatedRows`, lone top-level object → `at: ''`), `flattenRow`, `buildFields(rows): MappingField[]` (≤200 paths, first-row sample, masking in this function so unmasked values never leave it; `••••` + `masked:true`), `maskConnectionString(uri)`, `suggest(fields)`, `combineRow(row, mapping): CandidateRow` (§5.5: string is base via `parseLine`; fill-only; conflict warning naming path; Port/TLS coercions; Host-only → standard non-SRV, port default 27017; neither → `unusable`; name cut to 64 via `uniqueName`/`planNames` at review time, so here `nameHint` only), tests `tests/unit/unknown-json.spec.ts`, `unknown-json.property.spec.ts`. Masking set: last segment case-insensitive substring `pass|pwd|secret|token|key|credential`; URI userinfo password, `tlsCertificateKeyFilePassword`, `proxyPassword`, `authMechanismProperties` `AWS_SESSION_TOKEN` removed from displayed sample (and still `masked:true`). Suggestion tie-break (spec silent): first path in document order wins per target; connection-string `mongodb://` value rule beats a key-name suggestion for other targets on the same path. Property tests build secrets as random strings with a unique marker prefix; assert the marker never appears in the serialized `buildFields` output. Mutation: add file(s) to `stryker.config.json`. Gates: tsc, lint, `npx vitest run tests/unit/unknown-json*.spec.ts`, `npx stryker run --mutate <files>` (>=90%).

**Brief E (service+IPC).** Branch `feat/398-E`; start only after B,C,D are merged. Spec §1-2, §6 (review computation), §7, §8, AC2,13(reason),15,17, T1,T7,T9. Files: create `electron/services/ImportWizardService.ts`, `electron/services/import/detect.ts` (`detect(text)`: JSON.parse → refusal "This isn't a JSON file."; `format===…`→latelier (reuse `parseConnectionExport`, newer-version refusal intact); `type==='Compass Connections'` → version 1 only else "This Compass export version isn't supported."; else unknown), `latelierSource.ts` (entries→`CandidateRow` via `entryToConnectionInput`, `sealed:{kind:'latelier'}`, `explicitDirect:true`), `review.ts` (pure: `buildReview(rows, existingNames)` → `Review`; names via `planNames` over ALL usable rows, unusable rows get no name; `directConnection` rule: SRV→null, `multiHost`→false, `explicitDirect`→source value, else true; `needsCredentials` per C13 §7.1 step 4, false for x509/awsiam; `hasPassword` true if sealed), `electron/ipc/handlers/connImport.ts` (strict zod schemas: `indices` ints ≥0 unique, `directConnection`/`credentials` arrays bounded by 1000, `mapping` keys limited to `MapTarget` strings, `uris` as before), M `electron/main.ts`, M `connectionBulkAdd.ts` (`lineToInput` takes direct-connection value + colour instead of batch defaults), tests `tests/unit/import-detect.spec.ts`, `import-review.spec.ts`, `tests/integration/import-wizard-service.spec.ts`, `import-wizard-handlers.spec.ts` (real SQLite per `tests/helpers/db.ts`). Reuse `storeSecrets` logic (move to a shared private helper; do not duplicate). Token semantics: pending Map<token,{source,raw,rows,file?}>; `importMap` replaces `rows`; commit deletes before await, re-sets on decrypt failure (copy `importCommit` pattern at `ConnectionExportService.ts` lines ~140-175); `clearPending` wired at `main.ts:380`. Commit: sealed secrets decrypted via `decryptSelected` (latelier) or `decryptCompassSecrets` (compass) only for ticked rows; apply `readOnly` only when `source !== 'latelier'`; re-plan names against current Connections, report `renamed`; validate with `lineInputProblem`/`ImportSchema` rules; per-row failure → `skipped`; fill `repick`. Integration test must JSON-serialize every channel response for a planted-secret file (password in URI, Compass password, unknown-JSON `secret`) and assert the planted values are absent (AC17). Add `review.ts`, `detect.ts`, `latelierSource.ts` to `stryker.config.json`. Leave old channels intact (slice R removes). Gates: tsc; lint; `npx vitest run tests/unit/import-*.spec.ts tests/integration/import-wizard-*.spec.ts tests/integration/connection-export-service.spec.ts tests/integration/conn-export-handlers.spec.ts`; `npm run audit:ipc`; `npx stryker run --mutate electron/services/import/detect.ts,…/review.ts,…/latelierSource.ts`; then ask lead to run the `ipc-channel-auditor` agent.

**Brief F1 (Source + Mapping UI).** Branch `feat/398-F1`. Spec §1 steps 1,3; §5.3-5.6 UI side; AC11, AC9/10 UI. Files (create) `src/features/connections/importWizard/SourceStep.tsx`, `MappingStep.tsx`, `mapTargets.ts` (labels + the target list in the §5.3 order), specs `tests/component/import-wizard-source.spec.tsx`, `import-wizard-mapping.spec.tsx`. Props contract in plan §4. Behaviour: Source = file button or paste box (≤100 lines/≤4096 chars, line counter); Mapping = collection picker (shown only when >1; default pre-selected), one row per field with path, sample (masked → `••••` + hint "Taken from the file — not shown"), a target `<select>` pre-filled from `suggested`, each target selectable once (choosing a taken target moves it), Clear option, *Next* disabled until `connectionString` or `host` mapped, *Back*. Native elements only (a11y rule); no `window.atelier` calls here (presentational). Renderer must not import Node/electron. Gates: tsc; lint; `npx vitest run tests/component/import-wizard-source.spec.tsx tests/component/import-wizard-mapping.spec.tsx`.

**Brief F2 (shell + approval + entry points).** Branch `feat/398-F2`. Spec §1, §6, §7 result, AC1,3,13,14, AC15 UI. Files: create `…/importWizard/ImportWizard.tsx` (state machine source→[mapping]→review→result; owns `api.conn.importOpen/importMap/importUris/importCommitV2` via `src/api/atelier.ts`; handles `BAD_PASSPHRASE` retry keeping the review), `ReviewStep.tsx` (same component for 4 sources; tick boxes, defaults from `defaultTicked`, unusable rows disabled with reason, inline credentials for ticked `needsCredentials` rows, Direct-connection checkbox on non-SRV rows with the exact hint, batch Read-only, passphrase + "Import without passwords" when `hasEncryptedSecrets`), `ResultStep.tsx` (created/renamed/skipped/repick/secretsNotStored); modify `ConnectionTransferProvider.tsx` (`openImport` → wizard at file), `ConnectionExpandedTable.tsx` footer (Paste URIs → wizard at paste, Import → wizard at file, + New unchanged); delete `ConnectionImportDialog.tsx`, `ConnectionAddDialog.tsx`, `tests/component/connection-import-dialog.spec.tsx`, `connection-add-dialog.spec.tsx`; new specs `tests/component/import-wizard-review.spec.tsx`, `import-wizard-entry.spec.tsx` (mock bridge per-test; include a stateful wrapper where a patch must round-trip). Build against F1's prop contract (import the real components once F1 is merged; until then use a local stub with the same props). Commit sends `directConnection` for every ticked non-SRV row and `credentials` only for edited rows. Popover/dialog dismiss paths need their own `stopPropagation()` (CLAUDE.md). Gates: tsc; lint; `npx vitest run tests/component/import-wizard-*.spec.tsx tests/component/connection-expanded-table*.spec.tsx` plus any spec referencing the deleted dialogs (`grep -rl ConnectionImportDialog\|ConnectionAddDialog tests src`).

**Brief G (E2E).** Branch `feat/398-G`; after E,F1,F2,R and the Compass fixture. Files: modify `tests/e2e/c13-add-connections.e2e.ts`, `c13-connection-export-import.e2e.ts` to drive the wizard (test hooks: mock `dialog.showOpenDialog` the way the existing specs do); create `tests/e2e/c14-import-compass.e2e.ts` (encrypted fixture + passphrase, wrong passphrase first then right, connect without re-entering password) and `c14-import-unknown-json.e2e.ts` (`{ "servers": [{ "label","uri","secret" }] }` written to a temp file, accept suggested mapping, connect to memory server). Gate: `npm run test:e2e -- tests/e2e/c13-*.e2e.ts tests/e2e/c14-*.e2e.ts` (cloud: wrap in `xvfb-run -a`), `npx tsc -b`, `npm run lint`.

**Brief R (retire).** Branch `feat/398-R`. AC18. Do the deletions/renames listed in the §2 table row R; `grep -rn "importPreview\|previewUris\|createFromUris\|connImportCommitV2\|ImportCommitInput2\|ImportCommitResult2" electron shared src tests scripts` must return nothing. Gates: tsc; lint; `npm test`; `npm run audit:ipc`.

## 7. Spec issues for the lead (not fixed)

1. **S1 Direct-connection default vs parser.** Spec §3/§6: "starts with that value… explicit". `uri-parse.ts:210` returns `directConnection = params.get('directconnection') === 'true'`, so absent and `=false` are indistinguishable; today `connectionBulkAdd.ts:40/50` re-reads the raw URI (`hasParam`). Spec never says whether the *form's* paste default changes (C14 only changes the wizard's default to On). Plan: parser exposes `directConnectionExplicit`; form default stays Off. Confirm.
2. **S2 OIDC from the parser.** §3: "`MONGODB-OIDC` … gets §4.3's message". `uri-parse.ts:174` throws `unsupported authMechanism: MONGODB-OIDC`; the AUTH_MECH_MAP has no OIDC. Message is for unusable rows only; plan has the parser throw the exact OIDC message (affects the form's paste error text too). Also an `oidc` block (non-string source) needs Compass-reader detection — which keys? Unspecified.
3. **S3 Proxy warning.** §4.3 "proxy options in the string → imported without it, with a warning"; `uri-parse.ts` ignores `proxyHost` etc. silently (not in `DROPPED_OPTIONS`, line 27) and `ParsedUriWarning.code` has no proxy code. Needs a new warning code (plan: `PROXY_DROPPED`) — and `proxyPassword` is also a secret query param, so drop it from nothing is leaked in warning text.
4. **S4 Encrypted rows' `hasPassword`/`needsCredentials`/warnings before decrypt.** §8: `conn:importOpen` returns `Review` with no passphrase, but §4.2 step 5's per-row "dropped secret" warnings and a sealed password's presence are only knowable after decryption (`ConnectionExportService` decrypts at commit, `decryptSelected` ~line 302). Spec doesn't say what `hasPassword`/`needsCredentials` show for sealed rows, nor where the dropped-field warnings appear (result screen?). Plan: `hasPassword=true` when sealed, `needsCredentials` computed from username only; dropped-field warnings go in the commit result (needs a field not in §8 output — `skipped`? no). **Unresolved, worker would guess.**
5. **S5 Result shape.** §8 output `{ created; renamed; skipped; repick; secretsNotStored }`, existing `ImportCommitResult` (`shared/types.ts:126-133`) has `created`, `failed`, `secretsNotStored`. `skipped` vs `failed` (unticked? unusable? validation failures?) and element shapes for `renamed`/`repick` are unspecified. Plan: `skipped` = ticked rows that failed validation/create; `renamed` = `{index,from,to}`; `repick` = `{name,files}`.
6. **S6 Review rows lack fields §6 requires.** §6 lists default database, TLS, SSH on/off per row, but the §8 `ReviewRow` has none of them (nor `name` pre-rename, nor color). Plan adds `tls`, `defaultDb`, `ssh` to `ReviewRow`.
7. **S7 Name planning scope.** §7.1 "re-plans names against the Connections that exist at that moment"; C13 §4.1 (`ConnectionExportService.ts` ~160) plans over **all** entries so unticking can't move names. C14 doesn't say; unusable rows have no name. Plan keeps C13 behaviour (all usable rows).
8. **S8 Suggestion tie-breaks.** §5.4 "last path segment compared…" but §5.2 flattening gives `servers.0.host`, `servers.1.host`, and sibling hosts (`primary.host`, `replica.host`) for one target; also a `uri`-named path whose sample isn't `mongodb://`. "Each target takes at most one path" — which wins? Plan: first in document order; value rule wins on the same path.
9. **S9 Masking/property-test scope.** §5.2 substring match masks `monkey`, `passport`, `bypass`, `keyboard`; harmless but untestable as "non-secret path left alone" unless a clean example is chosen. T8 "no secret string … ever appears in `importOpen` output" can false-fail when a generated secret equals a path name or a short common string; property tests must use unique-marker secrets. Also: `sample` for a *non-masked* path that holds a connection string containing `AWS_SESSION_TOKEN` is covered, but a free-text field (e.g. `notes`) containing a password is not — accepted.
10. **S10 Commit input vs reviewed state.** §8 `credentials`/`directConnection` arrays: spec doesn't say if `directConnection` is sent for all ticked non-SRV rows or only changes; and whether `readOnly:boolean` is silently ignored for L'Atelier source (§6 says so) — main must enforce, not the UI. Also `conn:importCommit` for Compass: batch Read-only applies (Compass carries none). Plan: send all; main ignores for `latelier`.
11. **S11 `conn:importMap` `at` for a lone object.** §5.1 "treated as a single row" but §8 `mapping`/`at: string` has no path for it. Plan: `at: ''`.
12. **S12 Passphrase on non-encrypted token / `BAD_PASSPHRASE` for Compass.** `electron/errors.ts:83` `BadPassphraseError` is C13's; same code assumed. Fine, but §6 "behave as in C13 §4.1 step 3" is a UI behaviour spec for rows where only some are ticked (decrypt only ticked, per `decryptSelected`) — wrong passphrase can pass if the only sealed rows are unticked. Confirm that's intended.
13. **S13 Colour on Paste/Latelier/Unknown.** `lineToInput` hardcodes `DEFAULT_COLOR` (`connectionBulkAdd.ts`); Compass needs per-row colour. Contract handled via `CandidateRow.input.color`; no spec impact, just noting `lineToInput` signature change (E).
14. **S14 Spec says nothing on the form's use of re-pick markers.** §3: "the form gains the same markers". `ConnectionForm.handlePasteUri` (line 1058) has no concept of re-pick; plan only surfaces them in the toast. Confirm that's enough.
15. **S15 Stale C13 note.** `specs/C13-connection-export-import.md` lines near §4.1/§7.1 and §5/§7.1 channel tables still describe the retired channels; C14 says it "replaces" them. Lead to decide whether C13's tables get a "Superseded by C14" mark in the final PR (spec-compliance reviewer will ask).
16. **S16 Entry-point overlap.** AC1 says "every C13 §6 entry point"; the palette/File menu/empty screen all funnel through `ConnectionTransferProvider.openImport` (one place), while only the footer has two sources. File menu is a main-process menu item (`appMenu.ts`, in Stryker scope) — unchanged, noted so F2 doesn't hunt for it.

## 8. Token budget (relative; C13 run = 1.0 baseline guess, adjust with real figures)

| Slice | Size | Relative | Comment |
|---|---|---|---|
| A | S | 0.3 | mechanical |
| B | S | 0.4 | + mutation survivors on an annotated file |
| C | M | 0.7 | crypto vectors easy; fixture wait costs a re-run (+0.2) |
| D | M | 0.9 | most branching + property tests + mutation |
| E | L | 1.4 | biggest; integration + 3 mutate files |
| F1 | M | 0.6 | |
| F2 | L | 1.2 | stateful component tests |
| G | M | 0.7 | e2e flake iterations |
| R | S | 0.3 | |
| Lead (reviews, full gates, auditor, spec-compliance, PR) | – | 1.2 | per "token-efficient lead loop": read diffs not files; batch PR tail |
| **Total** | | **~7.7** | vs C13: compare per-slice; A+B+R are the cheap ones; E/F2 are the risk of overrun |

## 9. Lead decisions (binding — override any "Plan:" in §7 and any brief text they contradict)

- **L1 Compass fixtures are real and in the tree.** Generated by the lead with MongoDB Compass 1.49.7 from a throwaway profile (`--user-data-dir`, `--importConnections`, `--exportConnections [--passphrase]`), committed under `tests/fixtures/compass/`: `plain.json` (no passphrase, secrets in clear), `encrypted.json` (passphrase), `passphrase.txt` (`fixture-export-passphrase`). Four favourites: "Fixture favourite" (`color: "color3"`, password + `authSource=admin`), "Fixture SSH password" (SSH password), "Fixture SSH key" (`identityKeyFile` `/nonexistent/fixture_id_ed25519` + key passphrase, SSH port 2222), "Fixture OIDC" (`mongodb+srv` + `authMechanism=MONGODB-OIDC`). Facts verified on the real export (correct §4 of the spec where it differs):
  - The file is canonical EJSON: `version` is `{"$numberInt":"1"}`, ports are `$numberInt`. Read it with `EJSON.parse` (bson), never `JSON.parse` + `=== 1`.
  - `sshTunnel` lives at `connectionOptions.sshTunnel` (not top level).
  - Every entry has `savedConnectionType` (`"favorite"` here; Compass's other value is `"recent"`). Default tick = `savedConnectionType === 'favorite'` (fall back to "has a `favorite` object" when the field is absent). The Compass CLI exports favourites only.
  - Compass colours are named (`"color1"`…`"color10"`), not hex → C14 §4.1's rule gives the default colour. Do not invent a colour map.
  - Encrypted entries: the password is stripped from the string (`mongodb://alice@…`), `sshTunnel.password`/`identityKeyPassphrase` are absent, `connectionSecrets` holds them. Layout verified: u16 BE version (1) | 16 salt | 16 IV | 16 tag | ciphertext; `pbkdf2Sync(pass, salt, 100000, 32, 'sha512')`; AES-256-GCM, no AAD; plaintext JSON `{"secrets":{"password","sshTunnelPassword"|"sshTunnelPassphrase"}}`; an entry with no secrets still has a blob decrypting to `{"secrets":{}}`.
  - Plain export: secrets are inline (`mongodb://alice:fixture-pw-1@…`, `sshTunnel.password`, `sshTunnel.identityKeyPassphrase`) and there is no `connectionSecrets`.
- **L2 (S1)** Accept: parser adds `directConnectionExplicit`; the form's own paste default does not change.
- **L3 (S2)** Accept: the parser throws exactly `OIDC sign-in isn't supported yet.` for `MONGODB-OIDC`. OIDC is detected from the connection string only; a Compass `oidc` options block is otherwise ignored.
- **L4 (S4)** `hasPassword` = a password exists, plaintext or sealed. `passwordSealed` = it exists only sealed. L'Atelier: sealed field names are readable in clear (`entry.secrets.password` present). Compass encrypted: `passwordSealed = true` when the string carries a username and the auth mechanism is password-based (the blob is opaque until commit). `needsCredentials` = password-based auth and no password at all. The review UI shows inline credentials for a ticked row when `needsCredentials || (passwordSealed && withoutSecrets)`. Secret fields dropped after decryption are reported in `ImportCommitResult2.warnings`, never their values.
- **L5 (S5, S6, S7, S8, S9, S10, S11, S12, S13, S14, S16)** Accept the plan's proposals as written in §7. For S7: names are planned over all usable rows at review and again at commit against the Connections existing then; `renamed` lists rows whose final name differs from the reviewed `savedAs`.
- **L6 (S15)** The final PR sets C14 to Implemented, rewrites C14 §4 to the L1 facts and §8 to the shipped types, and turns C13's "replaces this when it ships" notes into "replaced by C14". C13 stays Implemented (export is unchanged).
- **L7 Process.** No per-slice PRs: the lead reviews each slice branch and merges it locally into `feat/398-import-wizard` (merge commit). One PR integration → `main` at the end, `Closes #398`, after `/verify`. Worktrees: `.claude/worktrees/c14-<slice>` on `feat/398-<slice>`, `node_modules` symlinked (`ln -s ../../../node_modules`).
- **L8 Models.** A, R: sonnet/medium. B, F1, G: sonnet/high. C, D, F2: opus/high. E: opus/xhigh. Reviews: independent opus reviewer per logic slice; `ipc-channel-auditor` after E and R; `spec-compliance-reviewer` at the end.
- **L9 (review of C)** FLE: warn only when `fleOptions.autoEncryption` has settings; a bare `fleOptions` is silent (Compass may write defaults). The spec rewrite (L6) adopts this. Compass key derivation is async (`pbkdf2`, not `pbkdf2Sync`), so `decryptCompassSecrets` returns a Promise.
- **L10 (review of D)** Arrays inside a collection's rows are not separate collections. Flattening stops 20 levels below the row. A path the masking rule treats as secret can only be mapped to Password or Connection string; any other target ignores it with a warning that never shows the value.
