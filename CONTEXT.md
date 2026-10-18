# L'Atelier — domain vocabulary

A desktop app for connecting to MongoDB servers and exploring/editing their data. This glossary pins down the vocabulary the UI and code should use consistently.

The decisions behind this vocabulary live in `docs/adr/`. Two shape it most: [ADR 0001](./docs/adr/0001-data-view-home-connection-switcher.md) made the Data View the app's home, and [ADR 0006](./docs/adr/0006-multi-connection-data-view.md) moved connection identity from the view onto the tab — which is why **Active Connection** is not a term here and **Open Connection** and **Focused Tab** are.

## Language

### Connections and data

**Connection**:
A saved definition of how to reach one MongoDB server or cluster — host, auth, TLS, SSH. Creating one is what the `NewConnection` form does. A Connection is a *saved* record; being *connected* (a live pooled client) is a separate runtime status.
_Avoid_: db, database, server profile, instance

**Database**:
One namespace *inside* a connected server, containing collections. Surfaced in the workspace navigator tree under its Connection's root once that Connection is open. Never call this a "connection."
_Avoid_: db (as a synonym for connection)

**Collection**:
A container of documents inside a Database. The unit a workspace tab is opened against.

**Structure**:
The view within a Collection tab showing the collection's *observed shape* (sampled schema) and its *access paths* (indexes) — as opposed to Documents, which shows contents. One stacked pane, not a set of tabs: the insight it exists to produce is the join between the two ("this field is filtered on, and nothing indexes it"). Replaces the former Schema view, which becomes a section within it.
_Avoid_: schema (that is one section of it), info, overview (collides with the Connection Manager's tab of that name)

**Data View** (a.k.a. **Workspace**):
The tabbed, IDE-like screen where the user browses Databases/Collections and runs queries. It holds one navigator root per Open Connection, and one tab strip whose tabs may belong to different Connections.
_Avoid_: editor, explorer

**Connection Switcher**:
A lightweight popup, reachable from within the Data View, that lists saved Connections and opens the full Connections table ("Manage connections"), where adding, importing and exporting live — the entry point that replaces bouncing out to a separate connections screen.
_Avoid_: database picker

**Open Connection**:
A Connection with a live client, browsable in the Data View. Several Connections can be open at the same time, each with its own navigator root and its own tabs. Opening one is a deliberate action; so is closing one, which closes its tabs after a confirmation.
_Avoid_: active connection (retired — there is no longer a single one), current connection

**Dormant Connection**:
A Connection the Data View is holding a place for — it has tabs and a navigator root, but no live client. Produced by a launch restore, or by a Connection dropping on its own (network loss, server restart) — never by an explicit disconnect, which removes the Connection from the Data View entirely. A Dormant Connection shows no Databases, no Collections and no documents; one click on its root or one of its tabs wakes it into an Open Connection.
_Avoid_: greyed connection, stale connection, cached connection

**Focused Tab**:
The one tab the Data View is showing. Its Connection, Database and Collection are the answer to "where am I" — that identity belongs to the tab, not to the view. A new tab opens against the Connection of the navigator root it was opened from.
_Avoid_: active tab, selected tab

**Tab Group**:
The run of tabs in the tab strip that belong to one Connection, under a header filled with that Connection's colour. Clicking the header collapses or expands the group; the header is brighter when the group holds the Focused Tab. Groups are separated by a gap. A Tab Group is not a menu: it carries no Connection actions.
_Avoid_: chip, connection chip, tab section

**Read-Only Connection**:
A Connection with a persisted flag that blocks every MongoDB write reachable through it — document writes, collection/database/index/user admin operations, `$out`/`$merge` aggregation stages, and script/shell-pane writes. Enforced in the main process, never only hidden in the renderer, because the shell pane is unsandboxed (see [ADR 0005](docs/adr/0005-read-only-connection-enforcement.md)). A whole-connection property, not scoped to individual Databases within it. Unrelated to the pre-existing `readOnly` prop on components like `ScriptEditor`/`BuilderPane`, which is renderer-only editor/view state and enforces nothing against MongoDB.
_Avoid_: read-only mode (ambiguous with the unrelated UI-state prop of the same name)

**Connection Export**:
A file holding one or more Connections, written by **Export** and read by **Import**. Carries Connections only — never their saved queries, tabs or Audit Log — and never credential file paths. Importing one always adds new Connections; it never changes an existing one.
_Avoid_: backup (implies the whole app state), config, profile

**Checked Connection**:
A row ticked in the Connections table for a batch action — export or delete. Not the same as the *selected* row, whose details are open. A search unchecks the rows it hides, so a batch never reaches a Connection the user cannot see.
_Avoid_: selected (that is the open row), marked

**Export Passphrase**:
The passphrase that protects the secrets inside a Connection Export. A Connection Export without secrets has none.
_Avoid_: password (that word belongs to the Connection's own credentials)

**Import Source**:
What the Import Wizard was given: a Connection Export, a MongoDB Compass export, Pasted URIs, or Unknown JSON. Detected by the wizard, never chosen by the user.
_Avoid_: format (a Connection Export has a `format` field; an Import Source is wider), provider

**Field Mapping**:
The user's assignment of an Unknown JSON file's field paths (e.g. `servers.0.host`) to Connection fields such as Connection string, Host or Password. Only Unknown JSON has one; known Import Sources map themselves. Never remembered between imports.
_Avoid_: schema, template

### Query language and surfaces

**Shell Syntax**:
Query text as a person writes it in mongosh — unquoted keys, single-quoted strings, trailing commas, regex literals like `/^acme/i`, and value constructors like `ObjectId("…")` or `ISODate("…")`. It is the syntax of every MongoDB tutorial and forum answer, and the syntax users paste in. It is *not* a serialization format; nothing is ever stored or transmitted as Shell Syntax — every surface that accepts it rewrites it to Canonical EJSON in the box, when the user finishes it: on blur, and again on the action itself (Run, Explain, Save, Insert), because a click can land before a blur ever fires.

Accepted on the four read-query surfaces (Filter Bar, sort, projection, aggregation stage bodies) and, since the edit and insert drawers were added, on those too. Arithmetic and other computed expressions are rejected rather than deferred: they would need an evaluator, and that is the thing [ADR 0004](docs/adr/0004-shell-syntax-input.md) exists to avoid.
_Avoid_: relaxed MQL, loose JSON, JS syntax

**Canonical EJSON**:
Extended JSON v2 in canonical form — strict JSON with explicit type sentinels (`{"$oid": …}`, `{"$date": …}`). The single wire format between renderer and main, and the only form a query surface stores. Corresponds to `relaxed: false` in `bson`.
_Avoid_: strict JSON, EJSON (unqualified)

**Relaxed EJSON**:
Extended JSON v2 in relaxed form, where some types collapse to plain JSON values. The word "relaxed" belongs to this concept alone — never use it for Shell Syntax, which is a different idea entirely.

**Filter Bar**:
The single-line text surface in the Data View that holds a find filter as Canonical EJSON. The text it holds is what the query actually runs.
_Avoid_: query bar, search box

**Query Builder**:
The structured, row-per-condition panel beside the Filter Bar. It presents the same filter as editable rows, and stays in two-way sync with the Filter Bar.
_Avoid_: filter panel, builder pane

### Editing documents

**Document Editor**:
The popup for writing one document by hand, whether changing an existing one or creating a new one. It shows a single draft through two views, **Fields** (one typed row per field) and **JSON** (the whole document as text). Saving a change records one Operation containing only what changed.
_Avoid_: edit drawer, insert drawer, edit popup, replace mode, update mode

**Quick Edit**:
Changing a single value in place, where it is displayed, without opening the Document Editor.
_Avoid_: inline edit (as a user-facing name)

### Operations and history

**Operation**:
One attempt to change document state on a server — replacing, updating or deleting documents, inserting many at once, or dropping/renaming the container they live in. The unit of the Audit Log. An attempt that failed is still an Operation; a read never is.
_Avoid_: action, event, mutation, write

**Query**:
A read the user might want to run again. The unit of recent queries, and never an Operation — the two histories are separate on purpose.

**Run**:
Executing the Focused Tab's current Query — the Filter Bar's filter plus sort and projection — against its Collection. Always a read, never an Operation. It always includes the latest Query Builder edits; there is no separate "apply" step before it.
_Avoid_: execute, search, apply

**Audit Log**:
The durable, per-Connection record of Operations. Survives relaunch; dies with its Connection. Distinct from the transient notification history, which records failures the user might otherwise miss and keeps nothing.
_Avoid_: activity log, history, event log

**Pre-image**:
The document or documents as they existed immediately before an Operation. Captured only when small enough to be worth keeping, and held in memory for the running session only — never written to disk, so a restart forgets them, and only the most recent ones are kept even within a session.
_Avoid_: snapshot, backup, previous version

**Reversible**:
Property of an Operation whose Pre-image was captured. Decided once, when the Operation is recorded. It is a statement about what was *kept*, not a promise that Undo will succeed.

**Undo**:
Putting back what an Operation changed. Only offered on a Reversible Operation, and refused at the moment of use if the target has changed since — so Operations on the same document unwind in reverse order.
_Avoid_: revert, rollback, restore

