# Changelog

All notable changes to L'Atelier.

This file is the durable record. GitHub Releases carries the same history for
now, but release metadata does not travel with the source, so anything that
matters long-term belongs here.

Two things to know when reading the older entries:

- **Entries up to and including 0.14.0 are the commit subjects as written at
  the time**, grouped by the tag that shipped them and dated by that tag. They
  were not rewritten into user-facing prose after the fact, because rewriting
  them later would mean inventing intent the commits do not record.
- **The `(#nnn)` numbers in those entries point at the repository this project
  was developed in before it was published.** They are part of the original
  commit subjects and are kept for provenance; they do not resolve against this
  repository's issues.

Entries from 0.15.0 onward follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.18.0] — 2026-10-26

### Added

- **Import wizard.** One flow imports Connections from L'Atelier exports,
  MongoDB Compass exports (plain or passphrase-encrypted), pasted connection
  strings, and any other JSON file through Field Mapping. Every source ends on
  the same final-approval screen, and nothing is saved until you click Import.
- **Query to pipeline and code.** Open a Builder or Find query as an
  aggregation pipeline, copy a query as mongosh, Node or Python code, and drop
  a field onto Sort. The query bar gains find options: collation, hint,
  maxTimeMS and read preference.
- **Value suggestions.** Filters and stage bodies suggest values from
  validator enums, field samples and your recent `$match` stages. Fields that
  look secret are never suggested.
- **Builder v2.** The filter tree has toggles, NOT groups, typed editors and a
  live document count.
- **Command palette and navigation.** Fuzzy matching, recent collections per
  connection, quick-open for a namespace, a tab menu, and a keyboard shortcut
  sheet (⌘/). The collection view strip is a real tab list with arrow keys.
- **Collection structure.** Statistics above the indexes, distinct counts and
  numeric ranges in the schema view, a per-stage explain tree with a plan
  badge, and editable validation rules.
- **Views.** Save an aggregation pipeline as a view, and modify a view's
  source and pipeline from the navigator.
- **Roles tab.** Create, edit and drop roles, and pick roles when you edit a
  user.
- **Monitor tab.** See current operations, kill one, and read the profiler.
  The Collections tab is now a table.
- **Create collection** supports clustered collections and numeric capped
  inputs.
- **Settings.** System theme, default page size and view, editor font size, an
  app-themed code editor, reduced motion, and a *Reopen tabs on launch*
  switch.
- **Honest state.** A failed inline edit keeps your text and says why; the
  app tells you what stopped a query; a preference that fails to save says so.
  Quitting while an import, aggregation or script is running asks first, and
  so does quitting with an unsaved connection form or pipeline. An activity
  log keeps recent error messages.
- **Navigator.** A CAPPED badge, a server-version badge, pinned connections,
  and *Duplicate view*. *Copy URI* on a saved connection leaves the password
  out.

### Changed

- **Aggregation Cancel now stops a `$out` or `$merge` on the server.** A write
  that already reached the server is never reported as cancelled, and its own
  error still shows.
- **Buttons across the app moved to Mantine,** with filled Tab Group headers
  and no ⚡ icon or + button on the tab strip.
- **Connection create and update are atomic with the saved-password vault,**
  and export files are readable by their owner only.
- **The local database file is now `latelier.db`,** renamed from `mongolab.db`
  the first time you start this version. Your connections and settings carry
  over. Log files and the diagnostic file use the L'Atelier name too
  (`latelier.<date>.log`, `latelier-diagnostic-<time>.json`); older logs keep
  their name and age out as usual. Going back to 0.17.1 or older needs one
  manual step, described in the troubleshooting guide.

### Fixed

- **Large integers keep their precision** in the EJSON parsers, the stage
  Format button and Double display.
- **Shell and Script start on the focused tab's database** instead of `test`,
  print the contents of thrown values and un-awaited Promises, and print a
  hint for a bare `db.<collection>`.
- **The References button is back** on the collection header, with its rule
  count.
- **Stale list responses** in the Indexes and Users tabs no longer overwrite
  the list after you switch target.
- **Count** works for `$where` and `$near` filters.
- **Copy code** handles quoted hints and Python infinity.
- **The Monitor profiler** keeps its own database after a switch, and the
  Roles drop dialog ignores Escape while a drop is pending.

## [0.17.1] — 2026-10-06

A maintenance release with no user-facing changes. It is the first version
0.17.0 can update to on its own, so it exercises the automatic update path
on macOS and Windows end to end.

## [0.17.0] — 2026-10-05

This is the first release signed and notarized by Apple, with the new app
identity `io.github.anonhym.latelier`. Saved passwords carry over: the first
time you connect, macOS asks whether L'Atelier may use its saved passwords.
**Click "Always Allow".** If you clicked Deny, quit and reopen the app, and
macOS asks again.

On macOS, users of 0.16.0 install this release by hand once, because macOS
does not let an unsigned app update itself into a signed one. Later releases
then install automatically.

### Added

- **Automatic updates on macOS and Windows.** The app checks GitHub Releases
  once at launch and downloads a new version in the background. When the
  download finishes, a notification offers **Restart to update**. If you
  dismiss it, the update installs the next time you quit. Update failures are
  logged and never interrupt you. Linux is unchanged.

### Changed

- **The macOS app is signed with a Developer ID and notarized,** so Gatekeeper
  opens it without a warning and the quarantine workaround is no longer needed.
  Windows builds stay unsigned.
- **The app identity is now `io.github.anonhym.latelier`.** The startup notice
  that asked you to export connections before this release is gone.
- **Download file names changed** from `L.Atelier-*` to `L-Atelier-*`, with
  the architecture in the macOS names (`L-Atelier-0.17.0-arm64.dmg`).
- The macOS release adds a zip per architecture, which the updater installs
  from. The dmg stays the file to download by hand.

### Fixed

- When macOS refuses access to the saved passwords, the app now says so and
  tells you how to recover: quit, reopen, and click "Always Allow". It no
  longer offers a Retry that cannot succeed. The troubleshooting guide covers
  this case and a saved password that can no longer be read.
- In the Document Editor, pressing Escape while the suggestion list is open
  closes only the list. It no longer closes the editor and discards the draft.

### Documentation

- The troubleshooting guide explains how to move data from an old MongoLab
  install by hand.

## [0.16.0] — 2026-10-05

This is the last unsigned release. The next one is signed by Apple and has a
new app identity, so on macOS it cannot read passwords saved by this one. A
startup notice explains this. **Export your connections, including their
passwords, before you update.**

### Added

- **Connection export and import (C13).** Export a checklist of connections to
  a readable JSON file written owner-only. Passwords are optional; when
  included they are encrypted with scrypt + AES-256-GCM under an export
  passphrase of at least 12 characters. Import shows a preview first: the name
  each connection will be saved under (clashes become `Prod (2)`), which
  credential files need re-picking, and whether it carries passwords. Import
  only ever creates new connections, never accepts credential file paths from
  the file, lets you retry a wrong passphrase, and can always proceed without
  passwords. Reachable from the command palette, the File menu, and the empty
  first-launch screen.
- **A Connections manager** lists every saved connection, with multi-select
  export and delete. **Paste URIs** adds several connections at once from
  pasted connection strings, asking for any missing credentials per row, and
  the Add connection dialog is reworked around it.
- **A saved password that can't be decrypted says so.** Connecting fails with
  "This connection's saved password can't be read on this install. Re-enter
  it." instead of an unknown error, and the navigator offers **Re-enter
  password**.
- **Document Editor.** One modal for inserting, editing and duplicating
  documents, replacing the edit drawer. Fields are typed rows, with nested
  objects and arrays as child rows, a type selector, add and remove field, and
  a JSON view on the code editor with a field filter. Save sends only the
  fields you changed, and if the document changed since you opened it you get
  a conflict prompt instead of a silent overwrite. Quick Edit now covers
  numbers and booleans, and pasting a JSON array inserts many documents.
- **Data export:** export the current page or every matching document as
  JSON, JSONL or CSV.
- **Data import:** import a JSON array, JSONL or CSV file into a collection.
  CSV columns go through a per-column type mapping. Import shows progress, can
  be cancelled, can be undone, and is offered on an empty collection.
- **Update all matching documents** from the new **Documents** menu.
- **Operation log and undo (X13).** Writes are recorded in an operation log,
  and a single-document edit or delete, a bulk write, an import, and a rename
  can be undone. Confirm dialogs say whether a change can be undone.
- **Structure view.** The collection tab's Schema view becomes Structure: the
  collection's indexes sit above its schema, so indexes are reachable from the
  collection you're querying. An explain plan that shows a collection scan
  offers to create the index that fixes it.
- **Filter value suggestions** from the last run's results and from values you
  have recently filtered on.
- **Cancel a running find** from the Run button.
- **⌘↵ runs the query from anywhere in the Documents view,** not only from the
  query bar. A refused run says why under the query bar (for example `Not run:
  Invalid sort`). Run now sits beside the builder: `Save · History · Run ▾`.
- **One Fields control** in Table, Tree and JSON replaces Preview fields,
  Columns and the projection. Tree and JSON hide the fields it hides.
- **Visible Edit, Delete and More actions on every row,** and a plain click
  makes a row active in every result view; selection is explicit.
- **The Saved tab lists finds, aggregations and scripts,** each opening in its
  own kind of tab, behind a single Save button in the toolbar.
- First-run guidance in the Documents view points a new user at Run.

### Security

- **Scripts and the shell run in a separate child process,** killed on
  timeout, and reach the database over an RPC bridge. Read-only is enforced in
  the main process, and the child never holds connection credentials.
- **Electron hardening:** fuses flipped on the packaged app and verified in the
  release build; permissions denied by default; every webContents guarded; no
  DevTools in a packaged build; external links limited to an https allowlist.
- **Data at rest:** the user-data directory, database and logs are owner-only
  (0700/0600), as are exports and the diagnostic bundle. Deleted data is erased
  on disk (`secure_delete`, WAL truncation, a one-time `VACUUM` after upgrade).
  Query, aggregation and script results are no longer saved with tab state.
  Undo pre-images stay in memory only, and recent filter values expire after
  30 days.
- **Connections:** a warning when TLS verification is off or a remote host is
  reached without TLS. TLS and SSH key paths are accepted only from the file
  picker. SSH tunnels are rejected until they exist.
- **Preferences:** the renderer can read and write only allow-listed
  preference keys, and turning on plaintext secret storage asks for
  confirmation in a native dialog owned by the main process.
- **Logging** scrubs credentials inside URI strings and covers more secret
  field names, and a failure to write the log is reported.
- The byte cap on find, aggregate and undo output counts every byte of the
  serialized array in UTF-8, so an output over the cap no longer slips through.
- On Linux, the `basic_text` keyring backend is treated as no keychain.
- The security model is documented in `SECURITY.md`.

### Fixed

- The suggestion popover no longer treats ⌘/Ctrl+Enter as a pick, which used
  to pick a value and run the query at the same time.
- Result rows no longer toggle selection or expand on ⌘↵.
- Shell output no longer force-scrolls to the bottom while a command streams.
- Collection document and index counts refresh after a write.
- A script syntax error names the line it is on.
- The Query Builder's operator box offers only field operators, and a
  half-typed operator is a draft until you finish it, so rows no longer shift
  or flag an error mid-keystroke.
- Keyboard navigation in a long result list no longer leaves the active row
  off-screen while row heights are still being measured.
- A dropped connection during a write or import reports a network error
  instead of a generic MongoDB error.
- A failed aggregation output download is reported instead of silently
  ignored, and its download button has an accessible name.
- Connection-form controls are named by their visible labels for assistive
  technology.

### Changed

- The collection header shows only the breadcrumb and counts, and the bare
  overflow menu became the **Documents** menu, holding "Delete all matching…".
- Destructive actions follow one rule, set by what they destroy. Deleting a
  saved connection now asks you to type its name, like dropping a collection.
  Removing an aggregation stage is instant, with an Undo toast.
- Labels follow the glossary: **Query Builder**, **References (n)**, and
  **docs in collection** for the header count.
- Dependency updates: `@codemirror/search` 6.7.2, `react-window` 2.3.3,
  `react-resizable-panels` 4.14.1.

### Removed

- The Preview fields and Columns controls, replaced by the Fields control.
- The Schema view, replaced by Structure. A saved tab on Schema opens on
  Structure.
- The edit drawer, replaced by the Document Editor.
- The Connection Manager's separate Indexes tab, now part of Structure.

## [0.15.0] — 2026-09-23

### Added

- **Keyboard operability across the custom controls (N2).** Every control that
  used to need a mouse now works from the keyboard alone:
  - The result views (Table, Tree, and each document's field tree) and the
    connection navigator are one tab stop each. Arrow keys, Home and End move
    an active row that assistive tech hears through `aria-activedescendant` and
    sighted users see as an outline. Enter activates the row, and a long jump
    keeps the row fully in view.
  - Context menus open with Shift+F10 or the ContextMenu key, including the
    field menu in the document tree (Copy value, Copy field path, Add to filter).
  - Table headers carry `aria-sort`, and their actions appear on focus as well
    as on hover.
  - Expandable rows in the Indexes and Users tabs, the column chooser's
    reordering, the resize separators, and the connection form's tabs are all
    keyboard-operable. The tabs are now a real tablist.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and pull-request templates,
  and `CODEOWNERS`.
- Self-hosted Inter and JetBrains Mono. The app makes no third-party font
  request at runtime, and the SIL OFL licence texts ship with the build.
- E2E now runs in CI on `main` and on pull requests targeting it, rather than
  only on manual dispatch.

### Security

- **The renderer now runs under a Content-Security-Policy**, served as a header
  so the shipped policy can be stricter than the development one. It makes no
  third-party connection, loads no remote script, and can embed no frame.
- **Child windows are denied** and **top-level navigation off the app's own
  document is refused.** Either one would have replaced the privileged renderer
  while leaving the preload bridge attached. Both are judged by parsed location
  rather than string prefix — `http://host:port@evil.example/` and
  `file:///tmp/anything.html` both defeat a prefix test.
- **Every IPC request is validated against the sending frame** before it
  reaches a handler, and answers `UNTRUSTED_SENDER` if it fails.
- **The renderer is sandboxed** (`sandbox: true`).
- **A packaged build no longer writes the payload of every IPC request to a log
  file on disk.** That meant document contents, query filters and shell input,
  for every user, by default. The level now keys off `app.isPackaged`; the
  previous `NODE_ENV` check could never be true in a shipped app.
- **A packaged build no longer binds Cmd/Ctrl+Shift+Alt+R to deleting the
  database** — the same unreachable `NODE_ENV` check guarded the developer
  reset shortcut.
- Development-only: three moderate `qs` advisories that reached the lockfile
  through Stryker are resolved with a scoped override.

### Fixed

- **The title bar drags the window across its whole empty middle again.** The
  connection switcher's wrapper was `flex: 1` and `no-drag` at once, so only a
  narrow strip of the bar could drag the window.
- **Focus is no longer dropped on the page body.** Closing a popover with
  Escape, dismissing a context menu, a successful create, rename or drop in the
  navigator and in the Indexes and Users tabs, and a failed submit whose dialog
  stays open all leave focus on a sensible control.
- **Double-clicking a table cell with nothing selected copied the row above.**
  The first click's selection bar pushed the grid down between the two clicks.
  The bar's space is now always reserved.
- The copy-confirmation flash no longer hides the active-row outline, and its
  mark follows the right field inside nested subtrees.
- A field name containing a dot no longer collides with a nested field of the
  same path in the document tree.
- Arrow keys skip loading, empty and error placeholder rows in the navigator.
- Actions in CI are pinned to commit SHAs rather than mutable tags.

### Removed

- `BACKLOG.md`. Known gaps and follow-ups live in GitHub Issues; a checked-in
  list and an issue tracker always drift, and the file lost.

## [0.14.0] — 2026-09-10

- fix(ci): grant pull-requests: write so the review bot can post
- fix(aggregation): bound every aggregate() call with maxTimeMS
- Fix crash-fuzz harness lint errors (no-explicit-any)
- Fix five workspace usability gaps
- Add crash-fuzz skill for hunting unknown regressions in the built app

## [0.13.0] — 2026-08-26

- refactor(workspace): decompose the Data View's state into named hooks
- Add mutation testing (Stryker) and property-based testing (fast-check)
- docs: rescue four audit reports from /private/tmp worktrees
- docs: fix confirmed-stale specs/BACKLOG/root-doc findings from full doc audit
- Richer drag-and-drop: per-group targeting, $in-merge/replace, discoverable Add to filter

## [0.12.0] — 2026-08-20

- X16 — Multi-connection Data View
- Let the user size the reference drawer, and remember it
- Light the panel splitters on hover and through a drag
- chore(gitnexus): commit the generated agent docs instead of leaving them dirty
- X15 — consolidate every dialog onto Mantine and guard the ones holding input
- chore(deps-dev): bump jsdom from 29.1.1 to 30.0.1
- chore(deps-dev): bump @types/node from 24.13.3 to 26.2.0
- chore(deps-dev): bump @testing-library/user-event from 14.6.3 to 14.6.4
- chore(deps-dev): bump eslint-plugin-react-refresh from 0.5.3 to 0.5.4
- Stop the Edit Connection modal from nesting two cards
- docs(skills): stack feature-base-branch tickets, spec on base, add /verify gate
- Fix cancel-then-immediate-reuse race in ScriptService cancelToken
- Validate EJSON write payloads: regex/date/binary sentinels, doc shape, size cap
- Fix orphaned cancelToken and unbounded EJSON result encoding
- Fix sanitizeHost auth-hijack and URI db-path error taxonomy
- Ignore agent worktree scratch directory

## [0.11.0] — 2026-08-13

- fix(shell): re-check read-only on every write(), not just at start()
- feat(ui): surface read-only connections in the renderer
- feat(mongo): enforce the read-only connection guard
- feat(connections): add persisted read_only flag to the connection record
- fix(mongo): route db.collection(name) through the signal-threading proxy
- docs: glossary + ADR for read-only connection enforcement
- W17 — a field-type warning in the Update drawer
- W16 — Structure: the collection's shape and access paths
- docs: data-view coherence review — twelve findings, no new features
- fix(drawers): send Canonical EJSON on the write paths, not the read buffer
- ADR 0004 completion: Tier 3 regex, symbolic operators, readable EJSON, Shell Syntax on the write surfaces
- chore: ignore .obsidian/
- fix(query): Explain reads through the X14 repair
- fix(query): one position in a refusal message, not two
- docs(specs): X14 is built — close out the status banner and §8
- feat(query): inline error feedback for refused input (T5)
- fix(agg): repair stage bodies on the save paths too
- fix(agg): repair stage bodies on the button-less run paths (T4)
- feat(agg): stage bodies accept Shell Syntax (T4)
- test(query): correct the retargeted-fixture comments (T3)
- feat(query): sort and projection accept Shell Syntax (T3)
- docs(specs): correct X14 §1 exports and the T3/T4 reuse note
- feat(query): Filter Bar accepts Shell Syntax (T2)
- docs(specs): add X14 — Shell Syntax input on the read-query surfaces
- feat(query): Shell Syntax → Canonical EJSON transform (T1)
- docs: record the query-language decision as ADR 0004
- ci: skip CI on docs-only changes
- docs(claude): require ASD-STE100 Simplified Technical English in replies
- fix(cloud): install the plugins and put gitnexus on PATH
- Pre-seed plugin marketplaces in cloud, document cloud vs local
- docs(skill): require green checks and explicit consent to merge a base
- chore(claude): source mattpocock-skills from its own marketplace
- chore(deps): cross the native/runtime majors — Electron 43 + better-sqlite3 13 (N-API)
- fix(ipc): required previewSvc, delete a vacuous meta spec, cover the $collStats fallback
- ci: dispatch runs e2e only, and keep the @claude guard armed
- ci: cut runner spend — main-only PRs, manual e2e, Claude actions off
- chore(deps): upgrade to ESLint 10, fixing 5 dead stores it caught
- chore(deps): sweep all in-range dependency updates, clearing 30 advisories
- Set package-ecosystem to 'npm' in dependabot config
- fix(mongo): reject empty replace filters
- fix(workspace): one filter rule, on every path that runs one
- fix: two Codex findings on the base → main diff
- fix: address four Codex review findings from the W15 ticket PRs
- fix(workspace): reopen the query drawer at its real width
- feat(builder): reorder conditions, show depth, name the drag
- feat(workspace): reach the query drawer by keyboard and palette
- feat(workspace): give Recent a delete and a clear-history
- feat(ui): one confirm dialog, not four
- fix(doc): give doc:* the same filter guard as query:*
- fix(workspace): report every failed clipboard copy
- fix(query): refuse a bare BSON sentinel as a document
- fix(workspace): key the hint counter on the raw projection too
- fix(ci): size the per-project test timeout as a hang detector
- test(harness): clear pending timers after every component test
- docs: a discovery blocks the work that found it
- fix(workspace): separate a sort field that is absent from one that is hidden
- fix(workspace): refuse to copy when the page is past the limit
- fix(workspace): refuse to copy a query that will not run
- fix(workspace): announce a sort whose column is hidden
- fix(workspace): re-arm the navigator's mounted ref on mount, not just unmount
- fix(workspace): stop the navigator writing state after it unmounts
- test(integration): cover the guard on count's filter and findOne's sort
- fix(workspace): carry projectionRaw through hydrateFindPayload
- fix(workspace): refuse a non-document sort, and stop the header claiming one
- fix(mongo): refuse a find argument that parses but is not a document
- docs(specs): correct W15 §4.1 — 5xyz runs with limit 5, not with no limit
- fix(builder): keep the empty state quiet while the tree is frozen read-only
- test(e2e): cover the drawer's Reset confirm and tablist roving
- fix(views): honest controls in the Saved strip, Saved tab and Recent tab
- fix(builder): confirm Reset, and make Copy code answerable
- fix(builder): make the drawer's tab strip an actual tablist
- fix(builder): three distinct add glyphs, one Remove per row, an empty state, a banner that names
- test(helpers): mount ModalsProvider in the component render wrapper
- fix(tests): retire one more pointer at the deleted sort editor, harden two assertions
- test(e2e): cover the advanced row's sort, limit, focus ring and restore
- fix(suggestions): make aria-selected match what Enter will actually do
- fix(workspace): give the advanced row's four fields accessible names
- fix(workspace): stop the table header claiming "unsorted" while a sort runs
- test(suggestions): prove the Enter rule through a real input, and both resets
- fix(suggestions): stop an auto-highlight nobody chose from swallowing Enter
- feat(workspace): W15 Tier 2a — complete projection and sort, and make {_id: 0} reachable
- fix(workspace): give the sort gate its runner half, like the filter's
- fix(workspace): W15 Tier 1 — stop the composition surface making untrue claims
- docs: record W15's three scoped-out drawer questions, and correct §14.1
- docs(specs): W15 §14 — what the drawer is missing, not just what's wrong
- docs(specs): W15 §13 — the drawer's presentation, not just what it computes
- docs(specs): add W15 — query composition audit (projection / sort / limit / skip)
- chore(cloud): configure cloud sessions — plugins, setup script, gitnexus
- W14: query bar advanced row — correctness, affordance, projection
- docs(skills): add feature-base-branch workflow skill
- docs(specs): add W14 — query bar advanced row correctness and projection
- docs: correct two false claims about the e2e ABI flip and set -e
- refactor(types): delete the unreferenced CondShape leftover
- refactor(builder): drop the pre-W13 Cond type, have condFromDragged return CondNode directly
- test(ipc): add table-driven router-registration coverage spec
- fix(tests): remove redundant as-casts on domain-data fixtures
- fix(e2e): fail the run when the build fails, and verify the ABI restore
- refactor(workspace): delete the old condition model and the dirty flag
- feat(workspace): the drawer becomes a recursive view of the filter text
- feat(workspace): one Run button, one owner for sort/limit/projection
- refactor(workspace): freeze legacy compiler behind a shim
- feat(workspace): add filterTree module — parse, print, edit MQL filters
- docs(specs): close W13 review gaps — value model, precision, ownership seams
- docs(specs): point W13's value model at builder.ts, make two criteria checkable
- docs(specs): add W13 — filter tree editor (query-builder redesign B)
- fix(query): treat a cleared query bar as no runnable filter
- fix(query): stop a flagged builder from reaching execution, and from eating hand edits
- fix(connections): stop keydown propagation in the expanded table search
- fix(theme): make Tooltip focus-visible the app-wide default
- fix(connections): address code-review findings from the switcher redesign
- fix(connections): right-size the expanded table modal, move actions to the row
- fix(connections): rebuild the switcher popover from Mantine primitives
- fix(workspace): drop redundant db/collection breadcrumb from TitleBar
- fix(connections): activate connection created via full-page route, fix expand-table focus/cache
- fix(tests): align mongo/doc handler specs with tsconfig.test.json
- test(ipc): add router-level integration specs for mongo.* and doc.*
- fix(navigator): bounded retry when listDatabases returns empty
- fix(connections): repoint navigator's Edit connection to the modal
- fix(connections): one disconnect error policy for every caller
- test(connections): pin the switch path's single-caller invariant
- feat(connections,fieldSuggestions,commands): extract shared roving-highlight hook
- fix(test-infra): stop npm test hangs/false-greens, typecheck tests/
- docs(dod): drop the /simplify pass from the DoD gate list
- docs(ux-audit): re-verify every file:line citation against current code
- fix(connections): stop switch data-loss at closeAll's root, wire Open workspace to connect
- fix(connections): Switcher rows announce host, not just name
- test(connections): rewrite e2e connection specs against the Switcher
- feat(connections): restore Active Connection on launch; Data View empty states
- feat(connections): Data View is home; retire the /connections list screen
- feat(connections): Expanded Connections table over the Switcher popover
- feat(connections): Connection Switcher row actions — manage, disconnect, delete
- feat(connections): Add and edit a Connection in a modal over the Data View
- docs: trim redundant Commands table from CLAUDE.md
- feat(connections): Connection Switcher keyboard contract
- chore: auto-refresh the GitNexus index at session start
- docs: point AGENTS.md at the DoD and correct the reviewer config
- chore: reindex GitNexus and regenerate the per-area skill files
- docs: make the definition of done canonical in CLAUDE.md
- feat(commands): command palette switches connections via the Switcher's action
- chore: sync specs, GitNexus artifacts, and ignore run traces
- feat: Connection Switcher — open, search, switch
- Add Claude Code GitHub Workflow
- refactor: decouple the Connection form from its page chrome
- feat: make the Active Connection first-class renderer state
- docs: CONTEXT.md glossary + ADR 0001 for the Connection Switcher
- fix: restore the Electron dev server under Vite 8
- chore: pin GitNexus to PDG mode via .gitnexusrc
- chore: remove stale leftover files
- skiff: N0.6 — Refresh blanks every expanded non-active database

## [0.10.0] — 2026-07-18

- chore: add Docket case tracking, agent-skills config, and dev tooling updates
- fix(workspace): reconcile open tabs when a namespace is dropped/renamed
- fix(aggregation): guard per-stage preview against out-of-order responses
- fix(connection): guard Save against double-submit / duplicate connection
- fix(table): cancel in-flight inline edit when the bound document changes
- fix(workspace): guard single-doc delete/update against an empty _id filter
- feat(ui): add a React ErrorBoundary around the route tree (T3.1)
- fix(theme): raise muted/ghost text to WCAG AA contrast in both themes
- feat(workspace): insert supports a JSON array via insertMany (T2.7)
- feat(table): in-place cell editing + safe update, no full-doc clobber (T2.6)
- feat(table): row expand, column reorder/hide, computed columns (T2.5)
- feat(aggregation): edit stage bodies in CodeMirror (T2.4)
- feat(aggregation): render explain plan as a syntax-highlighted, collapsible tree (T2.3)
- feat(aggregation): wire real drag-and-drop reorder to the stage grip (T2.2)
- feat(aggregation): make stage operator editable in place (T2.1)
- feat(collections): create / drop / rename collections & databases
- chore(e2e): run the Electron app headless-style on macOS
- fix(saved): persist and render the SaveModal description
- feat(workspace): add page-size selector to the result bar
- feat(workspace): bulk actions on selected result rows
- feat(workspace): add Update fields ($set) mode to EditDrawer
- feat(workspace): wire query filter into bulk delete-by-query
- feat(workspace): wire up explain on the find query bar

## [0.9.0] — 2026-07-02

- feat(workspace): auto-run base query when a collection tab first opens
- feat(navigator): background-refresh collection cache + reconnect freshness
- feat(connection): cancel in-flight connection

## [0.8.2] — 2026-06-23

- chore: bump version to 0.8.2
- refactor(icons): source icon set from @tabler/icons-react
- fix(builder): align SAVED strip with the sections above it
- fix(ui): normalize Mantine button sizes to compact-xs + destructive red app-wide
- fix(workspace): normalize toolbar button sizes to compact-xs

## [0.8.1] — 2026-06-22

- chore: sync package version to 0.8.1
- fix(workspace): scroll nav/data/right panes independently

## [0.8.0] — 2026-06-22

- fix(audit): address PR review feedback + de-flake CI tests
- fix(mongo): centralize agg write-target guards + EditDrawer _id guard
- fix(mongo): boot crash guards + error classification + race/keyless guards
- fix(query): size/time caps on find + script results, bound skip
- fix(builder): first-class long/decimal types + $in coercion + truncation guards
- chore(gitnexus): update symbol index metadata (4456 → 7218 symbols)
- fix(ejson): safe strict-sentinel parser — fix silent query/data-loss bugs (#2.1–2.3)
- fix(palette): restore command-palette dialog accessible name
- test(ci): pin mongodb-memory-server to 8.0.5
- fix(workspace): address PR review — side-effect-free toggles + boolean color
- test(e2e): update 4 specs to the migrated Mantine DOM
- ci: extract Electron binary with system unzip (extract-zip no-ops on runner)
- ci: TEMP diagnostic — dump electron install runtime state
- ci: clear ELECTRON_SKIP_BINARY_DOWNLOAD before installing Electron binary
- ci: install Electron binary explicitly so e2e + diagnostic test can launch
- refactor(theme): complete X12 Mantine migration — retire useT()/tokens.ts
- feat(workspace): side-panel collapse notches on the dividers
- fix(workspace): move both side-panel burgers into their respective panels
- fix(workspace): keep builder visible in agg/schema views with disabled overlay
- feat(workspace): right builder pane collapsible (mirrors left navbar)
- fix(workspace): tighten button/input sizing across migrated chrome
- fix(workspace): navbar 80px top gap — don't override AppShell.Navbar position
- fix(workspace): remove double tooltips on Mantine-Tooltip-wrapped buttons
- fix(workspace): AppShell navbar grid placement — breakpoint must be truthy
- feat(theme): X12 phase 10 — result grid themed via Mantine CSS vars
- feat(theme): X12 phase 9 — Mantine chrome around data views
- feat(theme): X12 phase 8 — Mantine Tables for Users and Indexes tabs
- feat(theme): X12 phase 7 — resizable inner panels via react-resizable-panels
- feat(theme): X12 phase 6 — AppShell layout
- feat(theme): X12 phase 5 — Spotlight command palette
- feat(theme): X12 phase 4 — NewConnection form via @mantine/form
- feat(theme): X12 phase 3 — modals & drawers via Mantine
- feat(theme): X12 phase 2 — notifications via Mantine
- feat(theme): X12 phase 1b — Mantine ContextMenu and FeatureHint
- feat(theme): X12 phase 1a — replace Btn with Mantine Button
- feat(theme): X12 phase 0 — bootstrap Mantine providers
- docs(specs): add X12 — Mantine migration plan
- test(useQueryRunner): restore real timers in afterEach
- fix(workspace): X11 review feedback — runToken, ref deps, run-here patch
- refactor(workspace): X11 phase 6 — demonstrate reuse via ScriptTab
- refactor(workspace): X11 phase 5 — ResultViewer compound
- refactor(workspace): X11 phase 4 — extract useQueryRunner hook
- refactor(workspace): X11 phase 3 — migrate consumers onto context
- refactor(workspace): X11 phase 2 — introduce CollectionWorkspaceProvider
- refactor(workspace): X11 phase 1 — thin view-component contracts
- docs(specs): add X11 — workspace composition refactor plan
- fix(workspace): honor parseProjection null contract + summarize stages in logs
- test(workspace): cover Workspace pagination handler closures
- test(workspace): cover ResultBar pagination canNext logic
- fix(workspace): use totalPages instead of hasMore for canNext
- chore(ipc): drop response summary from info log
- fix(workspace): pass page patch through to run + log every IPC call
- feat(workspace): align toolbar + result bar with mockup
- feat(workspace): rotate QUERY chevron with expand state
- fix(workspace): revert QUERY row visual to pre-collapse version
- feat(workspace): collapse advanced QueryBar rows behind chevron
- feat(workspace): restructure top query bar into toolbar + grid layout
- fix: address PR review comments (P1)
- fix: address PR review comments (P0)
- fix: address PR review comments (P0)
- fix(workspace): preserve BSON types via EJSON in edit-drawer and reference-drawer; isolate shared runtime constants
- fix(ipc/tabs): tighten tabs:update and tabs:openScript state schemas + clean BACKLOG and unused imports
- test(ipc): add handler-layer integration coverage for conn:* and user:*
- test(workspace/aggregation): add component coverage for editor components
- test(workspace/views): add component coverage for TreeView, TableView, JsonView
- refactor(workspace): split TitleBar and TabStrip out of Workspace.tsx
- fix(workspace): remove eslint-disable stale-closure escapes
- perf(workspace/views): memoize rowProps in JsonView and TreeView
- refactor(mongo): extract MetaService from meta channel handler
- refactor(electron): introduce PreviewFieldsService and encapsulate recent-query vacuum
- refactor(ipc): consolidate Zod validators and EJSON parsing helpers
- fix(workspace): preserve BSON types via EJSON in edit-drawer and reference-drawer; isolate shared runtime constants

## [0.7.0] — 2026-05-12

- chore: ignore test-results/ and .claude/scheduled_tasks.lock
- test(navigator): assert collection order from DOM, not getBoundingClientRect
- feat(workspace): extend BuilderPane to full height and align tab header with CollectionHeader
- fix(workspace): hide bottom SavedStrip when BuilderPane is on Saved tab
- fix(workspace): address gemini review — stale closure in run() + lenient parseSortString
- feat(workspace): UX tweaks — alphabetic collections, sticky saved queries, quick field sort

## [0.6.0] — 2026-05-11

- fix(workspace/tree-view): address PR review on sticky overlay
- fix(workspace/tree-view): pin FIELD|VALUE|TYPE header via JS overlay
- style(theme): retune dark palette to neutral cool-grey
- fix(workspace/table-view): drop unused useDynamicRowHeight; memoize rowProps
- refactor(workspace): migrate remaining views to react-window v2
- perf(workspace/tree-view): memoize DocRow with per-doc-scoped comparator
- refactor(workspace/tree-view): migrate to react-window v2
- fix(workspace): resolve lint errors surfaced by composition refactor
- fix(workspace): address PR review comments on composition patterns
- refactor(workspace): composition patterns P2-P4
- refactor(ui): replace Btn boolean props with variant enum; harden e2e selectors
- fix(script-editor): allow field autocomplete inside nested logical operators
- fix(workspace): address PR review comments on preview.configure hint
- feat(workspace): preview.configure feature hint
- feat(script-editor): field-name autocomplete inside db.<coll> calls
- Update dependabot.yml configuration
- Create SECURITY.md for security policy

## [0.5.0] — 2026-05-09

- fix(workspace): address PR review comments on app-v2 alignment
- refactor(SavedStrip): drop setErr useCallback wrapper
- fix(workspace): drop synchronous setState calls inside effects
- fix(e2e): bypass single-instance lock under the test harness
- feat(builder): scope tree-view drag-drop to the conditions card
- fix(e2e): restore test-mode hint suppression + match new Insert button name
- feat(workspace): de-emphasize SubTabStrip so the breadcrumb header reads first
- feat(workspace): SavedStrip lists queries + aggregations + scripts with kind badges
- feat(builder): rework pane with section headers, AND/OR top pill, MQL preview
- feat(tree): align field rows on a 3-column grid + show FIELD/VALUE/TYPE header
- feat(workspace): inline result bar between QueryBar and the data area
- feat(workspace): consolidate breadcrumb + view-switch + Insert into one header
- feat(connections): move row Connect/Disconnect out of the list, into the detail panel
- feat(theme): adopt L'Atelier app-v2 paper-cool tokens and 8/6/4 radii
- feat(connections): add Modified column + New collection button to Collections tab
- feat(workspace): compress QueryBar to a single horizontal row
- feat(workspace): add saved-queries strip to the bottom of the Builder tab
- feat(tree): soften type-badge palette to brand-aligned translucent tones
- feat(workspace): wire PreviewPicker into TreeView
- feat(brand): switch body font to Inter and use ligature wordmark in title bar
- fix(brand): set L'Atelier name + icon at runtime in dev
- feat(brand): rebrand MongoLab → L'Atelier (X08 + X09 + X10)
- fix(secrets): plaintext-fallback opt-in for hosts without an OS keychain (#4)
- fix(e2e): revert insert-textarea locator to .last() convention
- fix(workspace): address reviewer feedback on PR
- fix(workspace): make InsertDrawer reachable from docs toolbar
- fix(logging): address reviewer feedback on PR
- feat(logging): hello snapshot, driver-event capture, diagnostic bundle (#9)
- refactor(workspace): extract effectivePageLimit helper
- fix(workspace): thread builder.limit into query.find
- fix(script): close cursor in finally + early-return on exhaustion
- feat(script): auto-iterate bare cursor results in script tab
- fix(e2e): skip x06-secrets-vault-ui when safeStorage unavailable
- test(e2e): address reviewer feedback on PR
- test(e2e): add UI-driven Playwright coverage across F/C/W/A/X (24 specs)
- test(e2e)+fix: address reviewer feedback on PR
- test+fix: close P1 audit gaps (E2E coverage + perf budgets + TreeView state)
- test(e2e): leak-proof cleanup for ipc-contract + secrets-vault
- test: close P0 audit gaps (E2E IPC contracts + aggregation perf guards)
- fix(shell): preserve live buffer + trim input in history
- feat(workspace): UI/UX quick wins from the audit
- fix(workspace): close read-modify-write race on nested tab state
- perf(workspace): cut Workspace re-render cascade
- fix(script-tab): hoist useMemo above early returns
- fix(script-tab): address PR review feedback
- fix(main): tighten Mongo cursor / SQLite hygiene
- feat(workspace): structured result rendering in script tab (W12)

## [0.4.0] — 2026-04-30

- fix(workspace): apply PR review feedback
- feat(workspace): mongo-aware autocomplete in script editor
- feat(workspace): script editor tab (W12)
- fix(workspace): apply PR review feedback
- feat(workspace): in-process Mongo shell pane (W11)
- fix(connections): apply PR review feedback
- fix(connections): row Connect/Disconnect also moves selection
- docs(c05): align spec with sidebar UX changes
- refactor(connections): tighten sidebar UX changes after simplify pass
- fix(connections): live status dots, prevent silent auto-connect, row connect button + context menu

## [0.3.0] — 2026-04-28

- Disable claude code review
- chore: release v0.3.0
- fix(workspace): address PR review feedback
- feat(workspace): collection tab sub-views (Documents / Aggregation / Schema)
- fix: explain must honor sort and projection
- perf: address PR #2 review feedback
- "Claude Code Review workflow"
- "Claude PR Assistant workflow"
- perf: stringify find/aggregate results on the IPC wire
- perf: virtualize result views and DB navigator

## [0.2.0] — 2026-04-27

- build(win): override NSIS customCheckAppRunning to suppress phantom-process dialog
- chore: bump to 0.2.0
- build(win): switch NSIS installer to wizard mode (fixes false-positive "cannot close")

## [0.1.0] — 2026-04-27

- ci: tag-triggered release workflow for macOS + Windows
- ci: use `npm install` instead of `npm ci` to tolerate macOS-generated lockfile
- Fix package lock
- Refreshed package lock
- chore: resync package-lock.json version with package.json (0.0.0 → 0.1.0)
- test: stop component-test flake by leaving a permissive bridge stub on uninstall
- ci: GitHub Actions for lint + audit + test (and e2e on PR to main)
- test(e2e): connect-fails-then-succeeds retry pattern
- log: split TLS_HANDSHAKE from TIMEOUT/NETWORK + thread connectionId
- feat(c12): one-click retry buttons in the troubleshooting drawer
- specs: wire recipe suggestedAction hooks to one-click retry buttons (C12)
- docs(c11): add docs/troubleshooting.md mirroring the recipe registry
- feat(c11): wire troubleshooting triggers + TLS / Direct-connection explainers
- feat(c11): connection troubleshooting drawer + palette command
- specs: bundle help drawer + inline explainers + troubleshooting doc as C11
- feat(c09,c10): replace Indexes / Users stub tabs with real management UIs
- specs: cover Indexes (C09) and Users (C10), prune shipped backlog items
- feat(palette): global ⌘K command palette (X07)
- chore(docs): mark iteration-1 plans shipped, drop dead src/data.ts
- feat(refs): support array source values via \$in resolution
- feat(refs): field autocomplete in the rule editor
- fix(refs): renderDisplayTemplate handles all EJSON-typed values
- fix(display): recognize \$numberInt and \$numberDouble EJSON sentinels
- fix(mongo): don't block new connect on hung in-flight connect of another id
- fix(review): PR #1 follow-ups from gemini-code-assist
- fix(review): tighten constraint detection, MongoPool defaultDb, $mod, hint persistence
- feat(workspace): contextual feature hints (X06) + prerequisites
- feat(workspace): persist reference drawer state per tab (X05)
- feat(workspace): reference chip in TableView (X05)
- chore: regenerate gitnexus index for X04 + X05
- chore: ignore release artifacts
- feat(workspace): document reference rules (X05)
- chore: bump version, refresh gitnexus index, expand backlog
- feat(workspace): SavedTab delete-confirm modal; reposition collection-row active dot
- feat(fieldSuggestions): operator docs panel and tooltips (X04)
- docs(specs): register X03 MQL operators; update X02/W04/A03 to match
- fix(builder): flag malformed $mod value upfront
- refactor(fieldSuggestions): collapse source defaults, clarify catalog
- feat(fieldSuggestions): context-aware operator ranking (Phase B)
- feat(workspace): builder op input is autocomplete, expose every operator
- feat(fieldSuggestions): operator catalog + source + grammar tweak
- docs: tighten mql-operators plan for hand-off
- docs: plan for MQL operator autocomplete (phases A, B, deferred C)
- docs(field-suggestions): add X02 spec and update consumer specs
- feat(workspace): field-name autocomplete in aggregation stages and raw query editor
- docs(field-suggestions): add gotchas section — React 19 hook rules + test/ABI traps
- docs(field-suggestions): write down the roadmap for remaining phases
- feat(workspace): field-name autocomplete in the builder condition rows
- chore(gitnexus): refresh index references and untrack .gitnexus/
- fix(workspace): actually scope to the picked connection when opening workspace from a collection row
- fix(workspaceTabs): clear tabs and flip active synchronously so switching connections doesn't show the previous db's data
- perf(workspaceTabs): skip no-op patches so identical updates stop re-rendering and round-tripping IPC
- fix(DocumentService): sweep expired delete-confirm tokens on a background timer
- perf(MongoPool): cache defaultDb on the pool entry to drop per-op SQLite reads
- refactor: simplify pass — shared helpers, parallelize hot loops, consolidate error classifiers
- initial commit

