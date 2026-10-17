# W18 — Document Editor

> **Status: Implemented.**

## Purpose

Writing one document by hand takes two surfaces today, `EditDrawer` and `InsertDrawer`. Both are 400px drawers holding a plain textarea. Editing makes the user pick an Operation kind before touching a value: Replace (the whole document as JSON) or Update (a hand-typed `$set` into a buffer that starts empty, so field names are typed from memory). Nothing lets a user change one value without writing JSON.

This spec replaces both drawers with one **Document Editor** (see `CONTEXT.md`). It is a centered modal holding one draft of the document, shown through two views: **Fields**, one typed row per field, and **JSON**, the whole draft as text. Saving a change sends only what changed, as a compare-and-set on the fields it touches ([ADR 0012](../docs/adr/0012-document-edits-save-as-a-diff.md)). There is no mode to choose.

## Scope

- **In**: one modal replacing `EditDrawer` (edit) and `InsertDrawer` (insert, duplicate, and paste-an-array insert-many).
- **In**: the Fields view (typed rows, nested objects, arrays, type selector, add and remove field, filter box, the W17 type warning) and the JSON view (CodeMirror, Shell Syntax per X14).
- **In**: diff-based save with compare-and-set, and conflict handling.
- **In**: entry points in all three result views, the `E` key, ⌘↵ to save, and layered Escape.
- **In**: Quick Edit (the inline Table cell) extended to numbers and booleans.
- **Out**: editing several documents at once. Bulk update is its own feature.
- **Out**: a read-only viewer. On a Read-Only Connection, Edit stays disabled, as today.
- **Out**: ⌘S as a save key. ⌘↵ only, for now.
- **Out**: undo. The save is an Operation like any other, and X13 records and reverses it when X13 lands; nothing here is special-cased for it.

## Dependencies

- [W08](./W08-document-write-ops.md): the write IPC this reuses (`doc:updateOne`, `doc:insert`, `doc:insertMany`). This spec supersedes W08's drawer UI, not its channels.
- [W17](./W17-edit-drawer-type-warning.md): `checkFieldType` / `getStructureEntries`, moved from the Update drawer onto field rows.
- [X14](./X14-shell-syntax-input.md): `useShellSyntaxField`. The JSON view accepts Shell Syntax and commits it to Canonical EJSON.
- [X15](./X15-dialog-consolidation.md): the dirty guard and `confirmDestructive` on dismiss.
- [X19](./X19-keyboard-operability.md): focus return (`useDialogFocusReturn`) and keyboard reach from result rows.
- [ADR 0012](../docs/adr/0012-document-edits-save-as-a-diff.md): save as a diff, compare-and-set.
- Table rows need a discoverable Edit action (today Table only has it on right-click) before "open from every view" holds.

---

## 1. The surface

- A Mantine `Modal`, centered, default width 720px, maximum height 80vh. The body scrolls; the header (title, view switch) and footer (Save, Cancel) stay fixed.
- Resizable. The last size is stored in `app_state` under `ui.workspace.documentEditorSize` via `api.prefs`, next to the other `ui.workspace.*` sizes.
- Title: `Edit document` or `New document`, with the namespace (`db.collection`) as a subtitle.
- `closeOnClickOutside={false}`, as every dirty-guarded dialog here has (X15).

## 2. One draft, two views

The editor holds one **draft**: an EJSON document (or, when creating, possibly an array; see §6).

- A segmented control switches the view: **Fields** (the default) or **JSON**.
- Both views read and write the same draft. Switching never saves and never discards.
- Switching from JSON to Fields parses the JSON text first. If it doesn't parse, the switch is refused and the error stays inline in the JSON view. Save is refused the same way. The draft keeps its last valid version until the text parses. Invalid text is never discarded.
- The draft is **dirty** when `diff(original, draft)` is non-empty (§5). When creating, it is dirty when the draft differs from the value it opened with. The X15 dirty guard reads this.

## 3. The Fields view

One row per top-level field, in document order. Each row has three parts: the field name, a value input chosen by type, and a type selector.

| BSON type | Input |
| --- | --- |
| String | single-line text; grows to multi-line past one line |
| Int32 / Int64 / Double / Decimal128 | numeric input. The type is kept as loaded: editing `42` in an Int64 field saves an Int64. |
| Boolean | switch |
| Date | ISO-8601 UTC text (`2026-09-24T20:31:00Z`), with the local time shown beneath as a hint. The stored value is what is typed; no time-zone conversion on save. |
| ObjectId | text validated as 24 hex characters |
| Null | a `null` chip; the type selector changes it |
| Object | an expandable row whose children are indented rows of the same kind, recursively |
| Array | an expandable row whose children are element rows (`[0]`, `[1]`, …) of the same kind, recursively — an "Add item" button appends a new element (default: empty string) in place of "Add field" |
| anything else (Binary, RegExp, Timestamp, …) | read-only rendering plus an "Edit in JSON" link that switches to the JSON view |

- **The type selector** is the only way a field's type changes. Typing `"42"` into a string field keeps it a string; changing it to a number is a selector choice, which converts the value when the conversion is lossless and clears it otherwise. There is no inference from typed text.
- **Add field**: a row at the bottom. Its name input suggests field names sampled from the collection (the existing field-suggestion sources), and its type defaults to String. Adding a name that already exists is refused inline.
- **Remove field**: a per-row control. It changes only the draft; Save is the commit point, so there is no confirmation. `_id` cannot be removed, renamed, or edited.
- **Edited rows** are marked. A row is edited when the diff (§5) contains its path. The marker and the save come from the same function, so they cannot disagree.
- **The W17 warning** shows on a row when its type disagrees with the field's sampled dominant type (`checkFieldType`, unchanged). It never blocks Save.
- **Filter box**: shown at the top when the document has more than 15 top-level fields. It narrows rows by name (substring, case-insensitive). Hidden rows keep their edits.

## 4. The JSON view

- The whole draft in the CodeMirror `ScriptEditor`, pretty-printed with `ejsonStringifyReadable`. It accepts Shell Syntax and rewrites it to Canonical EJSON on blur and on Save (`useShellSyntaxField`, X14).
- `CLAUDE.md` records that swapping a textarea for `ScriptEditor` loses two affordances. Here: the editor fills the modal body (no resize handle needed), and Escape is handled per §7.

## 5. Saving a change

Per ADR 0012. Everything in this section is a pure function in a plain `.ts` module, so it qualifies for Stryker's `mutate` list.

### 5a. The diff

`diff(original, draft) → { set: Record<path, value>, unset: path[] }`

- Walk both documents' keys. A key only in the draft → `set`. A key only in the original → `unset`. A key in both → compare.
- **Equality is BSON-aware**: two values are equal when their canonical EJSON strings are equal. A JS `===` is wrong here: `Int32(1)` and `Double(1)` differ, so a type change is a change.
- **Objects recurse**: a change inside a nested object is emitted as its dotted path (`address.city`), so a sibling field changed on the server is not overwritten.
- **Arrays are compared and emitted whole**, never by index.
- `_id` never appears in the diff.
- A field name containing a `.` or starting with `$` cannot be expressed as a dotted update path. When the diff would need one, the whole nearest safe ancestor is emitted instead (or the top-level field, if there is none).
- Invariant, for property tests: applying `{ $set, $unset }` to `original` yields a document equal to `draft` in content, ignoring key order.

### 5b. The request

- An empty diff → no request. Save closes the editor.
- Otherwise one `doc:updateOne`: `updateJson` = `{ $set: set, $unset: { p: "" … } }`, omitting an empty operator.
- **Compare-and-set filter**: `{ _id: <id>, …guards }`, one guard per changed path:
  - a path that existed in the original → `{ <path>: <original value> }`;
  - a path added by the draft → `{ <path>: { $exists: false } }`.

  Guards are built from the original, never the draft. `_id` comes from `buildIdFilter`.

### 5c. The outcome

- `matchedCount === 1` → success: close, re-run the tab's query, refresh the collection header counts.
- `matchedCount === 0` → **conflict**. One of the guarded fields changed since the editor opened, or the document was deleted. The editor stays open with the draft intact and says so, offering:
  - **Reload**: fetch the document by `_id`, make it the new `original`, and re-apply the user's diff onto it. Where the user and the server changed the same path, the user's value wins in the draft and the row is marked edited, so the next Save proves it again. If the fetch finds no document, say the document was deleted and offer only Cancel.
  - **Overwrite**: resend the same update with only `{ _id }` as the filter.
- An IPC error → shown inline. The editor stays open; the draft is never discarded on failure.

## 6. Creating a document

- **Insert** opens the editor with an empty draft (`{}`). **Duplicate** opens it with the source document minus `_id` (the existing duplicate-EJSON helper in `views/docId.ts`).
- Save sends `doc:insert` with the whole draft. A diff doesn't apply to a document that doesn't exist yet.
- **Paste-an-array insert-many** is preserved. If the JSON view holds a top-level array, Save sends `doc:insertMany`, routed by the existing `classifyInsertPayload`, and the button reads `Insert N documents`. Empty arrays and arrays with non-object items are refused as they are today. The Fields view is unavailable while the draft is an array (it shows one document) and says why. The partial-failure handling `InsertDrawer` has today carries over unchanged.

## 7. Entry points and keys

- **Open** from the row's Edit action in Table, Tree and JSON; from the row context menu's Edit item; and with `E` on the focused row of any result view. `E` is listed in the keyboard shortcut sheet.
- **Save**: ⌘↵ / Ctrl+↵ anywhere in the editor, and the Save button. No ⌘S.
- **Escape unwinds one layer at a time**: an open completion or suggestion popup closes first; then the editor itself, through the dirty guard.
- **Focus** returns to the row the editor was opened from (`useDialogFocusReturn`). When the save changed that row's position (it no longer matches the filter), focus goes to the result list.
- **Read-Only Connection**: Edit, Insert and Duplicate stay disabled with their existing tooltips. The editor never opens.

## 8. Quick Edit, extended

Quick Edit (the inline Table cell) keeps its behavior for strings and gains:

- **numbers**: a numeric input that keeps the loaded numeric type, saved as a one-path diff through the same save path (§5) with its compare-and-set guard;
- **booleans**: a toggle, saved the same way.

A string or number cell stays open, read-only, until its write settles. A failed write (an error, or a compare-and-set that matched nothing) keeps the cell open with the typed value and the reason in an inline alert, as well as the toast; Enter, or editing the value first, tries again, and losing focus does not re-send the failed write. Escape, or the table swapping to other documents, drops a write still in flight: its late result touches nothing.

Any other type (Date, ObjectId, Object, Array, …) opens the Document Editor on that field: scrolled into view, focused, and expanded if nested. `isInlineEditable` widens to match; `_id` stays non-editable.

## 9. What goes away

- `EditDrawer.tsx` and `InsertDrawer.tsx`, and their Replace / Update-fields mode toggle, including its raw `$set` label.
- The `doc:replace` channel. `EditDrawer`'s Replace mode is its only caller, so it is removed across the whole IPC contract (`shared/ipc.ts`, `electron/preload.ts`, the handler and its registration, the tests), and the `ipc-channel-auditor` confirms nothing is left half-wired.

## 10. IPC contract

None new. `doc:updateOne` already returns `{ matchedCount, modifiedCount }`, which is what §5c needs. `doc:insert` and `doc:insertMany` are unchanged. Reload's fetch-by-`_id` uses the existing find path.

## 11. Acceptance criteria

- Edit, Insert and Duplicate open one centered modal; neither drawer remains.
- The modal remembers its resized size across relaunch.
- Fields is the default view; switching views keeps edits both ways.
- Invalid JSON blocks both the switch to Fields and Save, with the text preserved.
- Each scalar type edits in its own input and saves with its type preserved (Int64 stays Int64).
- A type changes only through the type selector.
- Nested objects edit as rows; arrays edit as rows of expandable, recursive elements (`[i]`), with Add item and per-element remove.
- Add and remove field work; `_id` is not editable or removable; a duplicate name is refused.
- Edited rows are marked, and editing a value back to its original clears the mark.
- The W17 warning appears on a disagreeing row and never blocks Save.
- The filter box appears above 15 fields and not at or below it.
- Save with no change sends no request.
- Save sends `$set` / `$unset` of exactly the changed paths, dotted for nested objects, whole for arrays, never `replaceOne`.
- The update filter carries one compare-and-set guard per changed path.
- A concurrent change to an edited field shows the conflict; Reload re-applies the edits onto the fresh copy; Overwrite saves unguarded.
- A concurrent change to a field the user did not touch does not block the save.
- A top-level array in the JSON view inserts many, with the count on the button.
- ⌘↵ saves; ⌘S does nothing; Escape closes a popup before the editor.
- `E` on a focused row opens the editor in all three views; focus returns to the row on close.
- Quick Edit edits numbers and booleans in place with types preserved; other types open the editor on that field.
- A Quick Edit write that fails keeps the cell open with the typed value and an inline error.

## 12. Test cases

### Unit — diff and request builder

- the diff for: an unchanged document (empty); a changed scalar; an added field; a removed field; a nested change (dotted path); an array change (whole array); an `Int32(1)` → `Double(1)` change (detected); `_id` ignored;
- a field name with a `.` or a leading `$` falls back to its nearest safe ancestor;
- guard building: existing path → original value; added path → `$exists: false`;
- **property** (`*.property.spec.ts`, fast-check with real `bson` constructors): for generated `original` and `draft`, applying the diff to `original` equals `draft` in content; `diff(x, x)` is empty.

### Component

- view switching preserves edits both ways; invalid JSON blocks the switch and Save;
- each type row renders its input and saves the right EJSON type;
- the type selector converts losslessly or clears;
- the edited marker follows the diff, including editing back to the original;
- the filter box threshold;
- the conflict flow with a mocked `matchedCount: 0`: the draft is kept, and Reload / Overwrite send the expected requests;
- ⌘↵ saves; Escape with the completion popup open closes only the popup (dispatch the trailing blur explicitly, as `CLAUDE.md`'s jsdom note requires).

### Integration (real SQLite + `mongodb-memory-server`)

- the compare-and-set update: an edited field changed underneath → `matchedCount: 0`; an unrelated field changed underneath → `matchedCount: 1` and both changes survive.

### E2E

- open from Table, Tree and JSON (button and `E`), edit a number and a nested field, save, see the re-run result and the updated header count;
- insert many by pasting an array into the JSON view;
- Quick Edit a boolean cell in Table.
