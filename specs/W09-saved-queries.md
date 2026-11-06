# W09 — Saved queries (repo + UI)

> **Status: Implemented.** The "Saved for this collection" strip in §7 was removed.

## Purpose

Persist named queries (find-style) and aggregation pipelines so users can re-run them on the same or different connection/collection. Surface them in the workspace Saved tab and, optionally, in the Builder tab's "Saved for {collection}" section.

## Scope

- **In**: `SavedQueryRepo`, `SavedQueryService`, `saved:*` IPC channels, Save dialog, Saved tab UI (inside Builder pane for find, inside Aggregation shell for pipelines), CRUD flows (create, list, update, delete, rename).
- **Out**: "Script" kind — model reserved but no UI in iteration 1. Importing Compass favorites (deferred).

## Dependencies

- F02 (`saved_queries`), F04, W01/W04 (find payload), A01 (pipeline payload).

## See also

- **X06 — Contextual feature hints**: defines a `saved.create` hint anchored to the Save button, fired after the same `queryHash` runs three times in a session. Discoverability for this feature lives there.

## 1. Types

```ts
// shared/types.ts
export type SavedKind = 'find' | 'aggregation' | 'script';

export interface SavedQuerySummary {
  id: string;
  connectionId: string;
  dbName: string;
  collection: string;
  kind: SavedKind;
  name: string;
  updatedAt: string;
}

export interface SavedFindPayload {
  kind: 'find';
  builder: BuilderState;
  queryRaw?: string;       // freeform override if user saved from DIRTY state
}

export interface SavedAggregationPayload {
  kind: 'aggregation';
  stages: Stage[];
  description?: string;
}

export type SavedPayload = SavedFindPayload | SavedAggregationPayload;

export interface SavedQuery extends SavedQuerySummary {
  payload: SavedPayload;
  createdAt: string;
}
```

## 2. IPC channels

| Channel          | Input                                                             | Output                 |
| ---------------- | ----------------------------------------------------------------- | ---------------------- |
| `saved:list`     | `{ connectionId?, dbName?, collection?, kind? }`                  | `SavedQuerySummary[]`  |
| `saved:get`      | `{ id }`                                                          | `SavedQuery`           |
| `saved:create`   | `SavedCreateInput`: target, name, and a `kind` with its matching payload; no `description` (derived from the payload) | `SavedQuery`           |
| `saved:update`   | `{ id, patch: Partial<Pick<SavedQuery,'name'\|'payload'>> }`      | `SavedQuery`           |
| `saved:delete`   | `{ id }`                                                          | `void`                 |
| `saved:duplicate`| `{ id, newName: string }`                                         | `SavedQuery`           |

`saved:list` returns summaries ordered by `updated_at DESC`. Filters are AND-combined.

For `kind` `find` and `aggregation`, `saved:create` and `saved:update` require `payload.kind` to equal the query's `kind` and the payload to match that variant's shape (`saved:update` checks against the stored row's kind, since a patch names none), rejecting a mismatch with `VALIDATION`; `script` has no payload variant, so its payload is not checked, and reads never validate, so rows saved before this rule stay readable.

`description` is stored in the payload (`saved:create` sets it) and `saved:update` replaces the payload as a whole, with one exception: an update payload that names no `description` keeps the stored one, so the stages-only payload of the aggregation Save (§5) does not drop what the Save dialog recorded. A `description` the payload does name replaces it, an empty string included: that stores an empty description. A name-only patch never touches the payload.

## 3. Repo

```ts
class SavedQueryRepo {
  insert(row: SavedRow): void;
  update(id: string, patch: SavedPatch): void;
  findById(id: string): SavedRow | null;
  list(filter: Filter): SavedRow[];
  deleteById(id: string): void;
}
```

Name uniqueness is **per connection + dbName + collection + kind** — migration 003:

```sql
-- 003-saved-unique-name.sql
CREATE UNIQUE INDEX uq_saved_name
  ON saved_queries(connection_id, db_name, collection, kind, name);
UPDATE schema_version SET version = 3;
```

Duplicate name → `CONFLICT`.

## 4. Save flow (find)

From the workspace:
- User clicks a "Save" button next to Reset/Copy code in the Builder pane footer (new control).
- Opens a small modal:
  - **Name** (required).
  - **Scope** radio: `This collection only` (default) or `This connection — all collections`. Iteration 1 persists `connection + db + collection` identically; the radio is a future-proofing hint and for now changes the visibility scope (see §7).
  - **Description** (optional).
- Submit → `saved:create` with `kind: 'find'`, payload based on current `BuilderState` and `queryRaw` if DIRTY.
- On success: toast "Saved '{name}'". The Saved tab refreshes.

## 5. Save flow (aggregation)

- "Save" / "Save as" buttons in the Aggregation title bar (A01/A06).
- `Save`:
  - If the tab was opened from an existing saved pipeline (`state.savedId` set): `saved:update` with `patch.payload = { kind: 'aggregation', stages }`. The stored `description` is kept (§2).
  - Else: open the same modal as find, pre-selected kind `aggregation`.
- `Save as`: always open modal pre-filled with current name + " (copy)".

## 6. Load / run flow

- Saved tab rows render with:
  - Kind icon (filter for find, funnel for aggregation).
  - Name, `meta` line (`updatedAt` relative, number of conditions for find or stages for aggregation).
  - Actions: `Run here`, `Open in new tab`, `Rename`, `Delete`.
- **Run here**: hydrate the active tab's state from payload and immediately trigger Run.
  - If active tab kind mismatches payload kind, falls back to "Open in new tab".
  - If active tab is clean → overwrite; if active tab has unsaved changes → confirm dialog.
- **Open in new tab**: call `tabs:openCollection` or `tabs:openAggregation`. For a pipeline the call carries `savedId`, not stages: main reads the saved row and seeds the tab's `stages` from it (W01 §5), so the tab never opens empty over a stored pipeline, which its next Save would overwrite.
  - The collection's tab is reused when one is open, and its pipeline is replaced. If that pipeline has unsaved changes → the same confirm as closing the tab ("Discard unsaved pipeline changes?"); Cancel leaves the tab as it was.
- **Rename**: inline edit (see §8).
- **Delete**: confirm dialog → `saved:delete` → remove from list.

## 7. "Saved for this collection" (Builder pane)

- Filter `saved:list({ connectionId, dbName, collection, kind: 'find' })`; show up to 5 most-recently-updated.
- Each has `Run here` and `Open in new tab`.
- Falls through to the full Saved tab when clicked "See all".

## 8. Renaming

- Click the name → it becomes an inline input.
- `Enter` submits; `Esc` cancels.
- Collision: show VALIDATION message and keep editing.

## 9. Deletion

- Confirm modal: "Delete saved query '{name}'? This can't be undone."
- After delete, if it's currently open in a tab, the tab's `state.savedId` clears and the name field in the tab title reverts to a generic "Pipeline (unsaved)".

## 10. Acceptance criteria

- Create, list, update, delete, duplicate, and rename all round-trip through IPC.
- Duplicate name in the same scope returns CONFLICT with a readable message.
- Saved tab shows only queries scoped to the tab's collection by default; a small "Show all" toggles the scope to connection-wide.
- "Run here" hydrates state correctly for both kinds.
- Saved aggregation reopened in a fresh window preserves `stages` exactly.
- Opening a saved pipeline, then Save with no edits, leaves the stored `stages` and `description` unchanged.
- Deleting a saved query that's currently loaded in a tab doesn't break the tab; the tab drops its `savedId`.

## 11. Test cases

### Integration (temp SQLite)
- **crud.spec.ts**: create, list, update (name), update (payload), delete.
- **unique-name.spec.ts**: second create with same name in same scope → CONFLICT.
- **duplicate.spec.ts**: `duplicate` returns a new row with suffixed name.
- **cascade.spec.ts**: delete parent connection → saved queries cascade.

### Component
- **save-find.spec.tsx**: open modal → enter name → submit → `api.saved.create` called with compiled payload.
- **save-aggregation-save-as.spec.tsx**: from a loaded saved pipeline, "Save" updates the existing; "Save as" creates new.
- **run-here-hydration.spec.tsx**: clicking Run here on an agg saved row pushes `stages` into the tab's state.
- **rename-inline.spec.tsx**: inline edit dispatches `api.saved.update` with new name.
- **delete-confirm.spec.tsx**: confirm then list refresh.

### E2E
- **save-and-relaunch.e2e.ts**: save a find and an agg; quit; relaunch; Saved tab lists both; Run here works on each.
