# The Audit Log records document-changing Operations only, and never blocks one

## Status

accepted

## Context

The originating request asked for a log of "destructive/mutating
operations (`docInsert`, `docReplace`, `deleteMany`, index drops, user grants)" with undo where
reversible. Read literally that spans most of the mutating IPC surface, and two of the named
channels — `user:create`, `user:update` — are on the plaintext-secret allowlist
(`scripts/ipc-secret-allowlist.txt`).

The app already carries three things that constrain the design:

- `recent_queries` (`001-init.sql`) is a per-Connection history of reads, kept to be re-run.
- `createRouter` (`electron/ipc/router.ts`) already wraps every channel and already summarises
  request, outcome, error code and duration — to a text log, not a queryable table.
- Nothing captures a pre-image. `deleteOne` returns `{ deletedCount }` and no document.

## Decision

**Recording is the spine; Undo is a capability that hangs off a subset of it.** The Audit Log is a
durable per-Connection record of Operations. Undo exists only where putting the state back is
honest.

**Nine Operations are audited**, chosen by blast radius on documents rather than by API level:
`docInsertMany`, `docUpdateOne`, `docUpdateMany`, `docDeleteOne`, `docDeleteMany`,
`collectionDrop`, `collectionRename`, `databaseDrop`, and a data import. The `op` set is frozen in
the migration's `CHECK`, because SQLite cannot alter one in place. There is no `docReplace`
to audit: the Document Editor saves through `docUpdateOne`, and the `doc:replace` channel is gone.

Excluded, deliberately:

- **Reads** — `recent_queries` is already that history, and reads would be ~95% of rows.
- **`users:*`** — no document changes, and excluding them means **no credential can ever reach the
  table**. There is no redaction rule to design, get right, or re-verify on every future change.
- **`indexCreate` / `indexDrop` / `collectionCreate`** — no documents at risk; index state is
  already visible in the Indexes tab.
- **`scriptRun` / `mshellWrite`** — arbitrary and unstructured. A script that deletes 400 documents
  is invisible to this feature.
- **`agg:run` with a write stage / `agg:runAndSave`** — `$out` replaces a whole collection, which a
  Pre-image cannot cover (unbounded, as with `collectionDrop`), so a row would record the write
  without offering Undo. The pipeline text can hold user data. The write is already gated by an
  explicit confirmation in the UI.

**Recording taps the router**, driven by a static per-channel table. A channel absent from that
table is not audited, so a channel added later fails closed. Pre-image capture lives in the
services, because only they run before the write.

**Undo refuses when the target has changed since the Operation.** Overwriting would let the feature
built to prevent data loss cause it — silently, and recorded as a success.

**A failed audit write never blocks or fails the Operation.** It is logged and the entry is lost.

## Considered Options

- **Extend `recent_queries` instead of a new table** — rejected. Retention is opposite (recent
  evicts at 200/connection because losing a query costs nothing; an evicted `databaseDrop` entry is
  worthless), and the affordances conflict — the recent-queries list exists to re-run what you click.
- **Merge with the activity log** — rejected.
  That log records failures that vanished, app-wide, for the current session; this records state that
  changed, per Connection, durably. Splitting them later is cheap; unsplitting is not.
- **Audit blocks the Operation when it can't record** — rejected. The only honest version refuses to
  run the Operation at all, which makes deleting a document depend on SQLite being healthy. This is a
  local convenience tool on the user's own data, not a compliance system.
- **Instrument `dbProxy` to audit inside scripts** — rejected for now. It is the upgrade path if the
  escape-hatch blind spot ever stings.
- **Capture pre-images for `collectionDrop` / `databaseDrop`** — rejected. Unbounded; a dropped
  collection can be gigabytes.

## Consequences

- `docInsert` (single) is not audited; `docInsertMany` is, because its undo needs no capture at all —
  `insertMany` already returns `insertedIds`.
- A partial `insertMany` (`ordered: true` stops mid-batch) changes state but reports an error. It is
  recorded truthfully as a partial and is **never reversible**: the error path yields the count, not
  the ids. Making it reversible means pre-generating `_id`s, which is a change to how insert works.
- Ceilings are visible rather than surprising: `confirmDeleteMany` already counts matches, so the
  confirm dialogs state whether the action can be undone.
- Undo on the same document unwinds in reverse order. If the intervening change came from outside
  L'Atelier there is nothing to unwind first, and Undo stays refused.
- Pre-images make retention non-uniform: the payload lives in memory for the session only (never on
  disk — it is a full copy of production documents), the record is durable. Old Pre-images are also evicted in-session past a per-Connection and total-size cap. After a restart, or once evicted, an entry
  is still listed but no longer undoable.
- The Audit Log dies with its Connection (`ON DELETE CASCADE`) — no ghost data, and no trail for a
  server you can no longer reach.
