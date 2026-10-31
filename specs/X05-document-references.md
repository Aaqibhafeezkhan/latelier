# X05 — Document references

> **Status: Implemented.** The reference chips its follow-up section proposes now exist in the Table and Tree views.

## Purpose

Let the user declare lightweight "foreign key" rules that map a field in one
collection (`orders.contact_id`) to a document in another
(`contacts._id`). When the user is browsing results, the renderer surfaces a
subtle chip next to referenced values; hovering shows a projected preview,
clicking opens a right-side drawer that loads the referenced document
on-demand and lets the user navigate deeper. Purely a UI affordance — the
underlying data is never joined or mutated.

## Scope

- **In**: `ReferenceRule` shape, `reference_rules` table (migration 005),
  `ReferenceRulesRepo`, `ReferenceRulesService` (CRUD + resolver +
  naming-convention auto-detect), `refs:*` IPC channels, renderer chip /
  hover popover / drawer / rule-editor modal, wiring into the collection
  tab's TreeView.
- **Out** (deferred):
  - Inline-expand mode that merges the referenced doc directly into the
    source row visually.
  - Auto-prefetch on row render (v1 resolves only on hover / click).
  - Reference rendering in TableView / JsonView. V1 targets TreeView.
  - Rule import/export, cross-connection references, schema-validator
    or index-based detection.

## Dependencies

- F02 (SQLite persistence) for the new table.
- F04 (IPC bridge) for the `refs:*` surface.
- F05 (Mongo pool) for `findOne` on the target collection.
- W01/W06 (workspace + result views) for rendering the chip/drawer.

## See also

- **X06 — Contextual feature hints**: defines a `refs.configure` hint anchored to the **References** button on `ResultViewer` (formerly `ResultArea`, see X11), fired the first time a collection's results contain `_id`/`Id`-suffixed fields and no rules exist. Discoverability for this feature lives there.

## 1. Types

```ts
// shared/types.ts (runtime-free)

export interface ReferenceRule {
  id: string;
  connectionId: string;
  sourceDb: string;
  sourceCollection: string;
  sourceField: string;        // dotted path
  targetDb: string;
  targetCollection: string;
  targetField: string;        // default "_id"
  projection: string[];       // empty = full doc
  displayTemplate?: string;   // "{name} ({email})"
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceRuleCreateInput { /* as above minus timestamps/id */ }
export type ReferenceRuleUpdateInput = Partial<
  Pick<ReferenceRule,
    'targetDb' | 'targetCollection' | 'targetField' |
    'projection' | 'displayTemplate' | 'enabled'>
>;

export interface ReferenceResolveInput  { ruleId: string; valueEjson: string }
export interface ReferenceResolveResult {
  ruleId: string;
  found: boolean;
  document: unknown | null;   // EJSON-encoded
  durationMs: number;
}

export interface ReferenceAutodetectInput  { connectionId; dbName; collection; sampleDocs? }
export interface ReferenceAutodetectCandidate {
  sourceField: string;
  targetDb: string;
  targetCollection: string;
  targetField: string;
  alreadyConfigured: boolean;
}
```

## 2. Database — migration 005

```sql
CREATE TABLE reference_rules (
  id                 TEXT PRIMARY KEY,
  connection_id      TEXT NOT NULL,
  source_db          TEXT NOT NULL,
  source_collection  TEXT NOT NULL,
  source_field       TEXT NOT NULL,
  target_db          TEXT NOT NULL,
  target_collection  TEXT NOT NULL,
  target_field       TEXT NOT NULL DEFAULT '_id',
  projection_json    TEXT NOT NULL DEFAULT '[]',
  display_template   TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_reference_rules_source
  ON reference_rules(connection_id, source_db, source_collection, source_field);
CREATE INDEX idx_reference_rules_source
  ON reference_rules(connection_id, source_db, source_collection);
```

Append-only per F02. Rules are scoped per connection; `ON DELETE CASCADE`
removes them when the owning connection is deleted.

## 3. IPC contract

No channel carries plaintext secrets — nothing is added to
`scripts/ipc-secret-allowlist.txt`.

| Channel | Input | Output |
|---|---|---|
| `refs:list` | `{connectionId, dbName?, collection?}` | `ReferenceRule[]` |
| `refs:get` | `{id}` | `ReferenceRule` |
| `refs:create` | `ReferenceRuleCreateInput` | `ReferenceRule` |
| `refs:update` | `{id, patch}` | `ReferenceRule` |
| `refs:delete` | `{id}` | `void` |
| `refs:resolve` | `{ruleId, valueEjson}` | `ReferenceResolveResult` |
| `refs:autodetect` | `{connectionId, dbName, collection, sampleDocs?}` | `ReferenceAutodetectCandidate[]` |

Errors reuse the existing codes: `VALIDATION` (bad EJSON, empty required
fields), `NOT_FOUND` (rule ID missing), `CONFLICT` (duplicate source
field), `MONGO_ERROR` (target query failed).

## 4. Resolver behavior

`ReferenceRulesService.resolve(ruleId, valueEjson)`:

1. Look up the rule (404 if missing).
2. `EJSON.parse(valueEjson, { relaxed: false })` — `VALIDATION` on failure.
3. `pool.getDb(rule.connectionId, rule.targetDb)` — reuses the single
   active connection; no per-rule connection.
4. `coll.findOne({ [rule.targetField]: value }, { projection })` with the
   projection fields coerced to `{ field: 1 }` (plus `_id: 1` always).
   Empty projection → `undefined` → full doc.
5. EJSON-encode the result and return `{ found, document, durationMs }`.
6. Driver errors pass through `classifyMongoOpError`.

## 5. Auto-detect heuristic

`detectCandidateFieldsFromDocs(sampleDocs)` scans the first 25 docs for:

- `/(.+)_id$/` or `/(.+)Id$/` (non-empty stem — `Id` alone is ignored).
- Skips `_id` itself.
- Walks one level of nested plain objects (but ignores EJSON sentinels
  like `{$oid}`, `{$date}`).
- Deduplicates per field path.

`ReferenceRulesService.autodetect` then:

1. Lists collections in the source DB.
2. For each candidate, tries `pluralize(stem)`, `stem`, and
   `pluralize(singularize(stem))` against the collection set.
3. Returns the first match (if any) plus an `alreadyConfigured` flag so
   the UI can show existing rules as read-only.

## 6. Renderer architecture

### `useReferenceRules(connectionId, dbName, collection)`

Loads rules once per (connection, db, collection); exposes `{rules,
byField, loading, error, reload}`. Filters disabled rules out of
`byField`.

### `ReferenceChip`

Small `↗` button rendered after a field's value in TreeView's `FieldNode`.
Hover (220ms debounce) calls `onHover(rect)`; click calls `onClick(rect)`.

### `ReferenceHoverPopover`

Non-interactive tooltip anchored under the chip. Shows the projected
fields (max 5) plus the `displayTemplate` rendering. Resolves on
hover via `refs:resolve`; `loading` / `error` / `not found` states are
inline.

### `ReferenceDrawer`

Right-side overlay over the result pane. State is a stack of
`ReferenceFrame` (push on follow, pop with back arrow). Each frame:

- Shows the full projected target doc in a flat field list.
- Loads nested rules for the target collection so the user can drill
  further — nested chips on each field that matches.
- Header: breadcrumb trail + back / pin / close buttons.
- **Pin** keeps the drawer open across tab switches; otherwise it
  closes on tab change.

### `ReferenceRulesEditor`

Modal launched from a "References" button above the result area. Lists
rules for the current collection, supports create/edit/delete, and
offers "Detect from sample" which runs `refs:autodetect` against the
current `lastRun.documents`.

## 7. Integration points

- `Workspace.tsx` owns `refStack`, `refDrawerPinned`, `refHover`, and
  `refEditorOpen` state; threads handlers into `ResultViewer` (formerly
  `ResultArea`, see X11) → `TreeView` → `FieldNode`.
- Only collection tabs show the feature; aggregation tabs are out of
  scope (v1).
- Drawer state is session-only; pinning is an in-session flag, not
  persisted to `app_state` or `workspace_tabs.state_json`.

## 8. Persistence

- Rules: SQLite, CASCADE on connection deletion.
- Drawer stack / pin / hover: renderer-only memory state.

## 9. Error handling

- `refs:resolve` with bad EJSON → `VALIDATION` (drawer shows the
  message as an inline error banner).
- Target doc missing → `{found: false, document: null}` — **not** an
  error. The drawer shows "No matching document."
- Target DB / collection auth failure → `MONGO_ERROR` propagates,
  drawer shows it in place.
- `refs:autodetect` fails open (empty array) when the pool or
  `listCollections` errors — user still gets the manual "New rule"
  path.

## 10. Test cases

### Unit
- `reference-autodetect.spec.ts` — `detectCandidateFieldsFromDocs`
  across snake/camel, nested, multi-doc dedup, `_id` exclusion, EJSON
  sentinels.

### Integration
- `reference-rules.spec.ts` — repo + service + pool wired against
  `mongodb-memory-server`. Covers:
  - create / list / listForCollection / get round-trip
  - duplicate `(connectionId, sourceDb, sourceCollection, sourceField)` → CONFLICT
  - update patch + `updated_at` bump
  - delete, idempotent delete → NotFound
  - resolve against ObjectId key, string key, missing-doc, projection
  - malformed EJSON → VALIDATION
  - autodetect resolves candidates against live collections

### Component
- `reference-chip.spec.tsx` — chip fires click with anchor rect,
  fires hover after the debounce; drawer renders the projected doc
  + display-template title + close button.

## 11. Acceptance criteria

- `reference_rules` migration applies cleanly to existing DBs.
- `refs:*` IPC channels registered and reachable via
  `api.refs.*` with correct typing.
- Creating a rule on a collection surfaces the `↗` chip on
  matching fields in TreeView.
- Hovering the chip loads the target doc and shows a projected
  preview.
- Clicking the chip opens the right drawer with the full
  projected document.
- Drawer stacks multiple levels of references and the back arrow
  pops the stack.
- Drawer closes on tab switch unless pinned.
- "Detect from sample" populates candidate fields based on
  `lastRun.documents`.
- Rule editor creates/edits/deletes rules with projection +
  display-template support.
- Connection deletion cascades to reference rules (FK).
- Table chips resolve dotted rules: a rule on `address.userId` puts its chip on the `address` object cell (the first nested rule by `localeCompare` whose target is a leaf, ObjectId sentinels included), and hover/open act on the nested path and value.
- *(Follow-up)* Chip rendering in JsonView.
- *(Follow-up)* Auto-detect for aggregation tabs.
- *(Follow-up)* Drawer state persisted in
  `workspace_tabs.state_json` for tab switching while unpinned.
