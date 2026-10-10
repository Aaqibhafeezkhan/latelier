# L'Atelier — Specifications

The design source of truth for L'Atelier. Each spec describes one testable component (UI component, service, data model, or cross-cutting concern) in enough detail to implement and test independently. Open follow-ups live in GitHub Issues; architectural decisions live in [`docs/adr/`](../docs/adr/).

## History

The project started as **MongoLab**. Iteration 1 — F01–F06, C01–C08, W01–W10, A01–A06 and X01–X06 — shipped and is implemented and tested. Everything marked *post-iteration-1* below came after it; some of it supersedes iteration-1 designs (W13 replaces the W04 condition model and the W05 sync machine, X16 retires the single-active-connection policy). The rename to L'Atelier is [X09](./X09-namespace-rename.md).

## Architectural ground rules

1. **All logic lives in the main process.** The renderer is a dumb UI — it must never import `mongodb`, `better-sqlite3`, `ssh2`, `fs`, or any Node-only API. All I/O, all data persistence, all Mongo calls, all secret decryption happen in main and are exposed to the renderer through a typed IPC bridge.
2. **Persistence**: SQLite via `better-sqlite3` at `app.getPath('userData')/latelier.db`. Migrations on startup. Schema versioned.
3. **Secrets**: Electron `safeStorage` encrypts per-field strings; ciphertext stored as blobs in `connection_secrets`; plaintext never crosses IPC back to the renderer.
4. **IPC**: one `window.atelier` namespace exposed via `contextBridge` (renamed from `window.mongolab`, see [X09](./X09-namespace-rename.md)). Every channel is `invoke`-style (promise). Every payload is runtime-validated in main. Errors return a structured envelope, not raw throws.
5. **Process model**: single window with a tab system. Connection creation is a modal-like route; ConnectionManager and Workspace are top-level routes; Aggregation is a sub-view of a collection tab *inside* Workspace.
6. **BSON across the wire**: Extended JSON v2 (EJSON). Serialized in main, parsed in renderer when rendering; renderer-side edits are round-tripped through EJSON back to main.
7. **Testing**: Vitest for unit/integration/component tests; Playwright + `@playwright/test` with the Electron driver for end-to-end. Each spec declares its test cases.

## Spec index

### Foundation (F) — infrastructure and cross-layer

| ID  | Title | Layer |
| --- | ----- | ----- |
| [F01](./F01-architecture.md) | Architecture & conventions | meta |
| [F02](./F02-sqlite-persistence.md) | SQLite persistence & migrations | main |
| [F03](./F03-secrets-vault.md) | Secrets vault (safeStorage) | main |
| [F04](./F04-ipc-bridge.md) | IPC bridge & error envelope | main + preload |
| [F05](./F05-mongo-client-pool.md) | Mongo client pool & lifecycle | main |
| [F06](./F06-app-lifecycle.md) | App startup & shutdown | main |

### Connections (C) — phase 1 + phase 2

| ID  | Title | Layer |
| --- | ----- | ----- |
| [C01](./C01-connection-model.md) | Connection model, URI parser, validation | main |
| [C02](./C02-connection-repository.md) | Connection repository (CRUD) | main |
| [C03](./C03-new-connection-page.md) | NewConnection page UI | renderer |
| [C04](./C04-test-connection.md) | Test connection action | main + renderer |
| [C05](./C05-connection-manager-shell.md) | ConnectionManager deep detail screen (`/connections/:id`) | renderer |
| [C06](./C06-overview-tab.md) | Overview tab (real stats) | main + renderer |
| [C07](./C07-collections-tab.md) | Collections tab (real listing) | main + renderer |
| [C08](./C08-edit-delete-stubs.md) | Edit, delete, stub tabs, CmdK stub | renderer |
| [C09](./C09-indexes-tab.md) | Indexes tab (real listing + create / drop) — *post-iteration-1, amended by W16 Tier 1, removed by W16 Tier 2* | main + renderer |
| [C10](./C10-users-tab.md) | Users tab (real listing + create / update / drop) — *post-iteration-1* | main + renderer |
| [C11](./C11-troubleshooting.md) | Connection troubleshooting drawer + inline explainers + docs — *post-iteration-1* | renderer + docs |
| [C12](./C12-auto-remediation.md) | Auto-remediation buttons in the troubleshooting drawer — *post-iteration-1* | renderer |
| [C13](./C13-connection-export-import.md) | Connection Export / Import — chosen Connections to a file, secrets passphrase-encrypted — *post-iteration-1* | main + renderer |
| [C14](./C14-import-wizard.md) | Import Wizard — L'Atelier, Compass, pasted URIs and unknown JSON via Field Mapping, one final approval — *post-iteration-1* | main + renderer |

### Workspace (W)

| ID  | Title | Layer |
| --- | ----- | ----- |
| [W01](./W01-workspace-shell.md) | Workspace shell + tab management | renderer |
| [W02](./W02-db-collection-navigator.md) | DB/collection navigator sidebar | main + renderer |
| [W03](./W03-query-runner.md) | Query runner service | main |
| [W04](./W04-query-builder-pane.md) | Query builder pane (state + compile) | renderer |
| [W05](./W05-query-bar.md) | Query bar + bidirectional MQL sync | renderer |
| [W06](./W06-result-views.md) | Result views (Tree / JSON / Table) | renderer |
| [W07](./W07-pagination.md) | Pagination control | renderer |
| [W08](./W08-document-write-ops.md) | Document write ops (insert/edit/delete) | main + renderer |
| [W09](./W09-saved-queries.md) | Saved queries (repo + UI) | main + renderer |
| [W10](./W10-recent-preview.md) | Recent queries + preview fields | main + renderer |
| [W11](./W11-mongo-shell.md) | Mongo shell pane (REPL in a runner child) — *post-iteration-1* | main + renderer |
| [W12](./W12-script-editor.md) | Script editor tab — *post-iteration-1* | main + renderer |
| [W13](./W13-filter-tree-editor.md) | Filter tree editor (supersedes the W04 condition model + W05 sync machine) — *post-iteration-1* | renderer |
| [W14](./W14-query-bar-advanced-row.md) | Query bar advanced row: correctness, affordance, projection — *post-iteration-1* | renderer |
| [W15](./W15-query-composition.md) | Query composition audit — projection / sort / limit / skip and the drawer's role after W13 — *post-iteration-1* | renderer |
| [W16](./W16-structure-view.md) | Structure view — indexes + schema in the collection tab, plan badge, create-this-index (amends C09; ADR 0003) — *post-iteration-1* | renderer + main |
| [W17](./W17-edit-drawer-type-warning.md) | A field-type warning in the Update drawer — *post-iteration-1* | renderer |
| [W18](./W18-document-editor.md) | Document Editor — one modal for editing and creating documents, saved as a diff (supersedes W08's drawers; ADR 0012) — *post-iteration-1* | renderer |

### Aggregation (A)

| ID  | Title | Layer |
| --- | ----- | ----- |
| [A01](./A01-aggregation-shell.md) | Aggregation shell + tab routing | renderer |
| [A02](./A02-pipeline-outline.md) | Pipeline outline + model | renderer |
| [A03](./A03-stage-accordion.md) | Stage accordion + add-stage picker | renderer |
| [A04](./A04-aggregation-runner.md) | Aggregation runner service | main |
| [A05](./A05-output-panel.md) | Pipeline output panel | renderer |
| [A06](./A06-save-explain.md) | Save pipeline / save as collection / explain | main + renderer |

### Cross-cutting (X)

| ID  | Title | Layer |
| --- | ----- | ----- |
| [X01](./X01-theme-window-state.md) | Theme & window state persistence | main + renderer |
| [X02](./X02-field-suggestions.md) | Field & value suggestions (autocomplete) | renderer + main |
| [X03](./X03-mql-operators.md) | MQL operator autocomplete | renderer |
| [X04](./X04-operator-docs.md) | MQL operator inline docs | renderer |
| [X05](./X05-document-references.md) | Document references (cross-collection chips/drawer) | main + renderer |
| [X06](./X06-feature-hints.md) | Contextual feature hints | renderer |
| [X07](./X07-command-palette.md) | Command palette (⌘K) — *post-iteration-1* | renderer |
| [X08](./X08-brand-identity.md) | Brand identity (L'Atelier visual rollout) — *post-iteration-1* | renderer |
| [X09](./X09-namespace-rename.md) | Namespace rename (MongoLab → L'Atelier) — *post-iteration-1* | main + preload + renderer |
| [X10](./X10-renderer-retheme.md) | Renderer re-theme — *post-iteration-1* | renderer |
| [X11](./X11-workspace-composition.md) | Workspace composition refactor — *post-iteration-1* | renderer |
| [X12](./X12-mantine-migration.md) | Mantine migration — *post-iteration-1* | renderer |
| [X13](./X13-operation-audit-log.md) | Operation audit log & undo — *post-iteration-1* | main + renderer |
| [X14](./X14-shell-syntax-input.md) | Shell Syntax input on the read-query surfaces — *post-iteration-1* | renderer |
| [X15](./X15-dialog-consolidation.md) | Dialog consolidation onto Mantine + unsaved-changes guards — *post-iteration-1* | renderer |
| [X16](./X16-multi-connection.md) | Multi-connection Data View (retires the single-active-connection policy assumed by W02 §1b) — *post-iteration-1* | renderer + pool |
| [X17](./X17-renderer-hardening.md) | Renderer hardening — *post-iteration-1* | main + renderer |
| [X18](./X18-deepening-seams.md) | Deepening seams: Shell Syntax fields and the Read-Only handle — *post-iteration-1* | main + renderer |
| [X19](./X19-keyboard-operability.md) | Keyboard operability of custom controls — *post-iteration-1* | renderer |
| [X20](./X20-auto-update.md) | Auto-update from GitHub Releases (macOS + Windows) — *post-iteration-1* | main + renderer + build |

### Plans

| File | Sequences |
| ---- | --------- |
| [PLAN-foundation](./PLAN-foundation.md) | F01 → F06 |
| [PLAN-connections](./PLAN-connections.md) | C01 → C08 |
| [PLAN-workspace](./PLAN-workspace.md) | W01 → W10, plus X01 and X06 |
| [PLAN-workspace-decomposition](./PLAN-workspace-decomposition.md) | Workspace component decomposition |


## Numbering

Iteration-1 specs are numbered in the order they were built: foundation first (F01→F06), then connections (C01→C08), workspace (W01→W10) and aggregation (A01→A06), with X01 touched throughout. Later specs take the next free number in their area.

## Spec template

Every spec opens with a status line directly under its title:

> **Status: Implemented.** An optional sentence on what differs from the text below.

The value is one of:

- **Draft**: the design is still being worked out.
- **Accepted**: agreed and being built; the sentence says which parts have shipped.
- **Implemented**: shipped, and the current behaviour.
- **Superseded by [ID]**: replaced by another spec.

The PR that ships or replaces a spec updates its status line. Gaps and follow-ups are GitHub Issues, not text in the spec: the status line says where a spec stands, an issue says what is left.

After the status line come:

1. **Purpose** — what this component does, in one paragraph.
2. **Scope** — explicit in-scope / out-of-scope bullets.
3. **Dependencies** — other specs this one depends on.

Then numbered design sections, shaped by the component: types and data model, IPC contract, behavior and edge cases, UI and keyboard/accessibility notes, persistence, error handling — whichever apply. Most end with:

- **Acceptance criteria** — verifiable outcomes, written as plain bullets, not checkboxes. They say what done means, not whether it is done; the Test cases section, where a spec has one, is what proves them.
- **Test cases** — unit / integration / component / E2E.
