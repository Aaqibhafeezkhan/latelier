# W12 — Script editor tab

> **Status: Implemented.**

## Purpose

Give users a workspace tab where they can write a multi-statement
JavaScript/Mongo script, run the whole buffer against the active
connection, and see the result rendered as structured output (not a
stdout stream). Complements W11 (the REPL pane): same `db` surface,
different UX — write-and-run instead of read-eval-print. Scripts run
in a separate process, one per run (see §3 and ADR 0014).

The script editor is the right tool when the work is "compose a few
lines, iterate, save, share"; the shell pane is the right tool when
the work is "poke the cluster one expression at a time".

## Scope

- **In**: a `'script'` workspace tab kind backed by
  `workspace_tabs.state_json`; a CodeMirror 6 editor in the renderer
  with JS syntax highlighting; a `ScriptService` in main that orchestrates
  a script-runner child process, which runs the user buffer in a
  `node:vm` context wrapped in an async IIFE and reaches the database
  only through an RPC bridge back to main; IPC channels
  `script:run` / `script:cancel`; structured result rendering (last
  expression value + a print buffer); cancellation by killing the
  child, keyed on a cancel token.
- **Out**: persisting scripts as named/saved entities (covered by a
  future `W13-saved-scripts.md`); multi-file imports / `require()`;
  scheduled / repeating runs; sharing scripts across connections.

## Why a tab (not the W11 pane)

W11 already exposes a stdin/stdout REPL with the exact same backing
machinery. A script editor is a *different* UX problem:

1. **Editing affordance.** Multi-line composition with syntax
   highlighting and key-bindings beats a single-line `<input>`.
2. **Result shape.** Users want to see the *return value* of their
   script as a typed, navigable structure — a table when it's an array
   of docs, a JSON tree when it's a `UpdateResult` — not a
   monospaced text stream.
3. **Lifecycle.** A tab persists per-workspace (the buffer survives
   relaunch via `state_json`); the W11 pane is intentionally
   ephemeral.

The two surfaces share the `db` proxy and the `MongoPool` integration
point — execution is identical, only the UX differs.

## Dependencies

- C02 (`Connection`), F04 (IPC pattern), F05 (`MongoPool` —
  `getClient(connectionId)`), W01 (workspace tab model), W11
  (`ShellService` — the `db` proxy / collection-alias helpers are
  extracted and reused).

## 1. Types

```ts
// shared/types.ts

export type WorkspaceTabKind = 'collection' | 'script';

export interface ScriptTabState {
  /** Editor buffer. UTF-8. */
  source: string;
  /** Selected database for the `db` proxy at run time. Blank means the
   *  connection's default database, else `test`. Scripts can also
   *  explicitly call `use("...")`. */
  dbName?: string;
  /** Last successful run's result. Renderer memory only: main strips it
   *  before every `state_json` write, so it does not survive relaunch. */
  lastResult?: ScriptRunResultWire;
  /** Last error, if the last run failed. Mutually exclusive with
   *  lastResult. Renderer memory only, like lastResult. */
  lastError?: { code: string; message: string };
}

export interface ScriptRunInput {
  connectionId: string;
  /** Blank or absent means the connection's default database, else `test`
   *  (`MongoPool.resolveDbName`). */
  dbName?: string;
  source: string;
  /** Renderer-supplied UUID; used by `script:cancel`. */
  cancelToken?: string;
  /** Hard ceiling so a runaway script can't pin the main process.
   *  Defaults to 60_000 ms. User-selectable per-tab via a toolbar
   *  knob: 15s / 60s / 5min / no limit (≈24 h). */
  maxTimeMs?: number;
  /** EJSON canonical (false) vs relaxed (true). Default false to
   *  match the rest of the app. */
  ejsonRelaxed?: boolean;
}

export interface ScriptRunResultWire {
  /** EJSON-encoded last-expression value. May be a JSON array,
   *  object, or scalar. `null` when the script produced no value. */
  valueJson: string | null;
  /** Concatenated `print()` / `printjson()` output, capped at 64 KB.
   *  Empty string when the script did not call print. */
  printBuffer: string;
  durationMs: number;
}
```

## 2. IPC channels

| Channel         | Input             | Output                | Notes |
| --------------- | ----------------- | --------------------- | ----- |
| `script:run`    | `ScriptRunInput`  | `ScriptRunResultWire` | runs the buffer in a runner child process, in a fresh `vm.Context`. Throws `MongoOpError` / `ValidationError` / `SystemError`. |
| `script:cancel` | `{ token: string }` | `void`              | kills the runner bound to that token. No-op if unknown. |

No `SECRET_INPUT` tag — no credential crosses the renderer/main IPC
boundary, and none reaches the runner either: it holds no client, URI
or password (see §3, "The database bridge").

## 3. ScriptService (main)

```ts
class ScriptService {
  run(input: ScriptRunInput): Promise<ScriptRunResultWire>;
  cancel(token: string): void;
}
```

### Process model

`ScriptService` is an orchestrator; the script never runs in the main
process. Each `run()` forks one Electron `utilityProcess`
(`electron/script-runner/runner.ts`, built to `dist-electron/script-runner.cjs`
and shipped inside `app.asar`), posts it a single request, and waits for
one message back. The process is single-use and is killed as soon as it
has answered.

- **Timeout and cancel are kills.** Main arms one wall-clock timer per
  run, covering spawn, the runner's connect, the script, and result
  encoding. When it fires, or `script:cancel` arrives, or the app quits
  (`cancelAll`), main kills the child and rejects with `TIMEOUT`
  (`script exceeded …ms …` or `script cancelled`). A sync loop, a
  microtask loop (`while (true) await Promise.resolve()`), and a
  promise that never settles are all stopped the same way, and none of
  them can stall main, because the runner shares no memory or event
  loop with it.
- **A dead runner is a clean error.** A child that exits before
  answering surfaces as `SystemError('INTERNAL', 'script runner exited
  unexpectedly …')`.
- **Connect in main first.** `run` calls `pool.readClient` before
  spawning, so connect failures and connection status events surface as
  before. That client is the one the run then uses: there is no second
  connection per run.
- **The runner holds no `MongoClient`, connection string or
  credentials.** Its request (`RunRequest`) carries the source, the
  starting database name and the EJSON mode, nothing about the
  connection, and its environment is an allowlist (`PATH`, OS temp/home,
  Windows `SystemRoot`), not a copy of main's. Every database call it
  makes is an RPC to main (below).
- **Read-only is enforced in main, for every route a script can take.**
  Main executes each call through `makeDbProxy` over its own client with
  the connection's flag read live from the stored connection on every
  call, so a write is refused whatever the script does and whatever the
  child's state: `insertOne`, `getCollection`/`collection`, a cached
  method reference, `admin()`, `runCommand`, an aggregate with `$out` or
  `$merge`, and a frame posted by hand all arrive at the same check. A
  connection flipped to read-only mid-run therefore has its next write
  refused even if nothing stops the run.
- **A connection turned read-only mid-run also stops its scripts.**
  On top of the live check, `ConnectionService.update` announces a
  false-to-true flip on the pool and `ScriptService` kills that
  connection's runners with a `READ_ONLY` refusal, so a script started
  on a writable connection does not carry on after the flip.
- **A connection that goes away mid-run stops its scripts.** Disconnect,
  Cancel-connect, deleting the connection, or an edit that reconnects
  would otherwise leave a script running against a client main has
  closed. `ScriptService` listens for the pool's `disconnected` status
  and kills that connection's runners with a `DB_ERROR`. That status also
  fires when the pool decides the deployment is unreachable (its own
  client saw no known servers for the loss grace window), so a script is
  stopped on a dropped connection too. This is deliberate and
  fail-closed: do not narrow it to user-initiated disconnects.
- **Results are encoded in the runner** (50 MB cap, print buffer cap
  64 KB) and cross the port as a string.

### The database bridge

The runner's `db` (`electron/script-runner/rpcClient.ts`) has the
mongosh-flavoured surface scripts are written against, but it is a
facade. Each call that must reach the server becomes a frame
`{ type: 'rpc', id, target, dbName, coll?, cursorId?, method, argsEjson }`
posted to main, answered by `{ type: 'rpc-result', id, valueEjson }`,
`{ type: 'rpc-result', id, cursorId }` or
`{ type: 'rpc-error', id, error }`. `target` is `db`, `admin`
(`db.admin()`'s object), `collection` or `cursor`. Arguments and results
cross as canonical EJSON strings.

Main answers in `electron/script-runner/rpcHost.ts`. A frame never says
*what* to run, only which entry of a fixed list:

- **Per-object allowlists** (`rpcSurface.ts`): one set each for Db,
  Admin, Collection, cursor-shaping and cursor-terminal methods, checked
  with `Set.has`. There is no generic "call property X" path, so a
  driver internal (a cursor's client, a collection's `s` bag) is not
  addressable at all, and `__proto__`, `constructor` and inherited names
  are refused like any other unlisted name.
- **A well-formed frame the allowlist rejects gets an `rpc-error`
  reply**, which the script can catch. A frame with no usable `id`
  cannot be answered and ends the run as `INTERNAL` ("malformed
  message"), the same as any structurally malformed message.
- **Cursors are main-side handles** with an id main mints, scoped to the
  run, capped in number, and closed when the run ends, is killed, or the
  child dies. A frame naming a cursor this run did not create is refused.
  `find`/`aggregate` stay synchronous in the script, so the facade
  queues the shaping calls (`sort`, `limit`, `skip`, `project`, ...) and
  opens the real cursor on the first terminal call; shaping after that
  throws. `forEach`, `map` and `for await` run in the script's process
  over `next()`.
- **Results leave main only as data.** A call's result must be a
  primitive, array, plain document or BSON value; a driver object (a
  `Collection`, a change stream) is refused rather than serialized, and
  `createCollection`/`rename` answer `{ ok: 1 }`. A result over the 50 MB
  cap is an error the script can catch.
  A call's result is encoded in main, synchronously, on main's event
  loop: about 50 ms for a 10 MB result, growing toward the 50 MB cap, and
  the wall-clock kill does not bound it (it can only act between event
  loop turns). This is the same trade as the UI query path, which encodes
  its results in main the same way.
- **A script cannot flood main.** A run may have at most 64 calls
  outstanding (`MAX_RPC_IN_FLIGHT`); a frame past that is answered with an
  `rpc-error` ('rpc: too many calls in flight') and the run goes on. An
  `argsEjson` longer than 16 MiB characters (`MAX_RPC_ARGS_CHARS`) is
  refused before it is parsed. These bound the work one run can queue on
  the shared pool client; they are not a rate limit.
- **Arguments** are parsed with the shape-exact EJSON parser, so a
  filter such as `{ $regex, $options }` stays a filter. Numbers keep the
  type the driver would have given them (`rpcCodec.ts`): results are
  promoted back to plain JS numbers as the driver returns them (so
  `doc.n === 1`, and a millisecond timestamp stored as a double reads as a
  number, not a `Long`), a JS integer outside the int32 range is written
  as a double exactly as the driver writes any JS number, a `Double` the
  script asked for on purpose stays a double, and a real `Long` stays a
  `Long`.
- **A kill aborts the work main started.** Each run has its own abort
  signal, threaded into every call, and the run's cursors are closed at
  settle, whichever way it ends.

What the facade does not carry, because it would hand back a live driver
object or bypass the check: `watch` (change streams), the bulk builders
(`initializeOrderedBulkOp` / `initializeUnorderedBulkOp`), `db.aggregate`,
`db.collections`, and the aggregation-cursor builders (`out`, `merge`,
`group`, `match`, ...). Calling one is a `TypeError`, as for any
unknown method. Also not carried, for the same economy: cursor `clone`,
`rewind` and `stream`, and the driver's data properties on a collection or
cursor (`readPreference`, `closed`, ...); `collectionName`, `dbName` and
`namespace` are. `bulkWrite` answers with its counts and id maps rather
than the driver's result object.

Behaviour of the script itself:

- A fresh `vm.Context` is created per call. The context globals are:
  - `db` — the bridge facade above. In main the calls run through the
    same proxy `ShellService` builds (`electron/mongo/dbProxy.ts`, one
    implementation for both), so the mongosh-style aliases
    (`runCommand` → `command`, `count` → `countDocuments`) carry over.
    `db.getCollection(name)` and `db.collection(name)` both return a
    collection, and `db.getSiblingDB(name)` a sibling `db`.
  - `use(name)` — switches the facade's current database. Each frame
    names its database, so a collection handle taken before `use()`
    stays on the database it came from.
  - `print(...args)` / `printjson(value)` — append to the print
    buffer (capped at 64 KB; further writes are silently dropped to
    keep the IPC payload bounded).
  - `EJSON` — re-export of `bson.EJSON`.
  - `ObjectId`, `ISODate`, `Long`, `Decimal128`, `UUID` — re-exports
    of `bson` constructors so users can write `new ObjectId(...)`
    just as they would in mongosh.
  - `signal` — an `AbortSignal`, exposed as a global so scripts that
    reference it keep working. Cancel kills the process rather than
    aborting this signal, so it never fires. An AbortSignal has no EJSON
    form, so a `signal` option a script passes is dropped from the call;
    main threads the run's own signal into every driver call instead
    (the proxy rewrites `find(filter)` to `find(filter, { signal })` and
    so on), which is what stops in-flight work when the run is killed.
- The buffer is wrapped in an async IIFE before evaluation:
  ```js
  (async () => {
    <user source>
  })()
  ```
  The Promise it returns is awaited. Top-level `await` works because
  the wrapper is async.
- There is no `vm` `timeout`: it only bounds the synchronous part of a
  run and cannot see a microtask loop. The wall-clock kill above is the
  single ceiling.
- The "result value" is the last expression of the script. The
  wrapper parses the source with `acorn` (pure-JS, no native deps);
  if the final top-level statement is an `ExpressionStatement` it is
  prefixed with `return ` before evaluation. Anything else
  (assignments, declarations) produces no value, and `valueJson` is
  `null`. If acorn fails to parse, the source is run as-is and
  `valueJson` stays `null` — the syntax error surfaces from the vm
  with the user's original line number (e.g., "syntax error (line 5):
  Unexpected token"), not the wrapper's. Mirrors how Node's REPL
  surfaces the last expression without forcing users to write `return`.
- The returned value is EJSON-encoded via the existing
  `ejsonEncode` (objects/arrays) or `ejsonStringifyRelaxed` helpers.
  Non-serialisable values (functions, the `db` proxy itself) collapse
  to `null` — the print buffer is the escape hatch for those.
- `cancel(token)` aborts that run's controller, which kills its runner;
  the token stays in the `active` map until the run's own cleanup
  removes it, so a same-token `run()` fired right after `cancel` is
  still rejected as `CONFLICT`. Idempotent.

### Trust boundary

`vm.createContext` is *not* a security boundary, and this spec does not
pretend otherwise: user scripts can reach Node primordials through the
host-realm objects in their context. The process split and the bridge
change what an escaped script can reach.

- **It holds no credentials.** The runner has no URI, password, TLS
  material or driver client to find, and nothing main sends it carries
  one. To use the connection it must send frames, and main applies the
  read-only guard and the allowlists to each. A script that escapes the
  `vm` context and posts frames by hand gets the same answers as one that
  did not.
- **It has no route to main's memory, the secrets vault, the SQLite
  database, or other connections.**
- **It still has the OS user's reach.** The runner is an ordinary child
  process of the same OS user: it can read and write that user's files,
  run programs and open network connections. Against a deployment that
  needs no authentication (a local `mongod` with auth off) it can open its
  own connection directly and write, because there is nothing to withhold;
  read-only cannot hold against that, and neither can any other control in
  the app. Where the deployment has authentication, the credentials stay
  in main.
- **MongoDB roles remain the authoritative control.** A read-only
  connection in this app is a guard on the paths the app controls. For a
  guarantee, connect with a database user that only has read privileges.

The threat model is otherwise unchanged from W11: the user's own code, on
the user's own machine, against the user's own database. `isolated-vm` is
rejected on the same grounds as in W11: native ABI complications on top of
`better-sqlite3`, and no gain beyond what the process split gives.

## 4. Renderer surface

### 4.1 Tab kind

`WorkspaceTabKind` extends to `'collection' | 'script'`. The existing
tab strip already keys on `kind`; a new icon (`{I.code}`) and label
("Script") are added. New-script creation lives behind a "+ Script"
entry in the same overflow menu the workspace already uses for "+
Collection" tabs.

### 4.2 `ScriptTab.tsx`

Layout: vertical split, editor on top, result panel on the bottom,
`ResizeHandle` between (height ratio persisted in `state_json` so the
split survives relaunch).

- **Editor**: a `<ScriptEditor>` component wrapping CodeMirror 6 with
  `@codemirror/lang-javascript`, the project's existing dark/light
  theme tokens, and a controlled `value` / `onChange` API. Buffer
  changes flow through the same 250 ms-debounced
  `api.tabs.update({ stateJson })` path the rest of the workspace
  uses.
- **Run / Cancel toolbar**: Run is `Cmd/Ctrl+Enter`. While a run is
  in flight the button flips to Cancel and dispatches
  `script:cancel`.
- **Result panel**: branches by result shape.
  - **Array** → reuse the W06 result components (`TreeView` /
    `JsonView` / `TableView`) with a Tree / JSON / Table toggle
    persisted per-tab as `state.resultView`. Column widths and tree
    row-expansion state also round-trip through `state_json`
    (`resultColumns`, `resultExpandedRows`). When the array is
    not all records (e.g. `db.coll.distinct(...)`) only the JSON
    view is enabled.
  - **Single record** → reuse `JsonView` with a one-element array;
    no toggle.
  - **Scalar / `null`** → small inline `<pre>` with
    EJSON pretty-print.
  - **`undefined` with nothing printed** → the W06 pane state "The
    script returned nothing", with Run again.
  - **Error** → the W06 error pane state, "The script failed", with
    `code: message` and Run again.
  Before the first run the panel collapses to a one-line hint bar so
  the editor gets the full viewport; once a result or error is
  present it expands to the persisted height. The hint bar stays a
  line rather than a pane state: a pane state does not fit in it.
  The print buffer renders below the value as a collapsed `<pre>`
  (auto-expanded when non-empty).
- **Completions**: collection names and field suggestions come from
  the database a run would use: the toolbar's database field, else the
  connection's default database (`ConnectionSummary.defaultDb`), else
  `test`.
- **Status row**: connection name, db name (with a dropdown to
  override), duration, error code (when applicable).

### 4.3 No new editor anywhere else (yet)

CodeMirror 6 is introduced *only* in `ScriptTab.tsx`. The query bar,
filter input, and aggregation stage editor keep their existing
textarea + autocomplete hook. Migrating those is out of scope and
tracked as a follow-up in GitHub Issues.

## 5. Security

- No credentials cross the renderer/main IPC boundary, and none reach the
  runner: it has no client and no connection details, and every database
  call is an RPC that main checks.
- A call made through the bridge gets no more database authority than
  the connection has, and no more than the app grants it: main refuses
  writes on a read-only connection (live flag) and refuses any method not
  on the allowlists. A script that escapes its sandbox is not limited to
  the bridge; see "Trust boundary" for what it keeps.
- Evaluation happens in a **runner child process**, never in main. The
  renderer only sees the structured wire result.
- The wall-clock kill (`maxTimeMs`) is the only ceiling, and it holds
  against sync loops, microtask loops and awaited promises alike.
- Read-only is enforced in main. It does not stop a script that escapes
  its sandbox from using the OS user's own reach, including a direct
  connection to a deployment that requires no authentication (see "Trust
  boundary").

## 6. Acceptance criteria

- Opening a Script tab shows an empty CodeMirror 6 editor with JS
  syntax highlighting and the project's theme.
- `Cmd/Ctrl+Enter` runs the buffer; the result panel renders the
  last expression value.
- `db.users.find().toArray()` produces a renderable array result
  using the existing `ResultTable` (Tree / JSON / Table toggle,
  same components as the W06 collection result area).
- `print("hi")` appears in the print buffer below the value.
- A script run with a blank database field runs on the connection's
  default database (else `test`), and the editor's completions list
  that database's collections.
- An infinite loop (`while (true) {}`) is killed by the
  `maxTimeMs` ceiling; the renderer shows a `SystemError` with a
  clear "script exceeded N ms" message.
- A microtask loop (`while (true) await Promise.resolve()`) with a
  500 ms limit returns `TIMEOUT` within about a second, other IPC
  calls keep answering meanwhile, and the next run succeeds.
- A runner that dies mid-run surfaces a `SystemError`, and live
  runners are killed on quit.
- On a read-only connection a write is refused by main by every
  route (collection call, `getCollection`/`collection`, a cached
  method reference, `admin()`, `runCommand`, `$out`/`$merge`), and a
  connection flipped read-only mid-run has its next write refused
  even with no kill.
- Crafted frames from an escaped script (an unknown method, a
  prototype name, another run's or an invented cursor id, malformed
  EJSON) are answered with an `rpc-error` and change nothing.
- No URI, password or connection string appears in any message sent
  to the runner, its argv, or its environment.
- The runner entry is built to `dist-electron/script-runner.cjs`
  and ships inside `app.asar`; a packaged macOS arm64 build (unsigned,
  `--dir`) with the release fuses runs a script. Windows, Linux and a
  signed macOS build are not yet verified.
- Cancelling a long `find` (large collection, no index) via the
  Cancel button aborts within ~1 s.
- Closing and reopening the app restores the buffer text, but not
  the most recent result/error: results can hold production
  documents, so they are never written to `state_json` (main strips
  `lastResult` / `lastError` on every write and a migration scrubs
  older rows). A reopened script tab shows its empty output state
  until Run.
- EJSON round-trips (an `ObjectId` written in the buffer comes
  back as `$oid` in the result, and renders as `ObjectId(...)` in
  the table).

## 7. Test cases

### Unit (main)
- **script-service.spec.ts** (forks the real runner under Node against
  `mongodb-memory-server`): last-expression capture, `print` buffering
  + cap, top-level `await`, sync-loop / microtask-loop / never-settling
  / awaited-server-call timeouts, runner crash, `cancelAll`, cancel
  token bookkeeping, the 50 MB cap, a connection flipped read-only
  mid-run, syntax errors throw `ValidationError`, runtime errors throw
  `MongoOpError` (or `SystemError` for non-Mongo), and the database a
  run starts on: an explicit `dbName` over the connection's default
  database (used when `dbName` is blank), else `test`.
- **script-rpc.spec.ts** (integration, same harness): read-only refused
  by main on every route, a flip mid-run with no kill, crafted frames
  from an escaped script, no credential in any message,
  number and BSON type fidelity through the bridge, cursor shaping and
  cleanup on end and on kill, in-flight work stopped by a kill.
- **rpc-host / rpc-surface / rpc-codec / script-runner-protocol /
  script-result-encode** (unit, in the Stryker `mutate` list): the host
  over a fake client (allowlists, frame validation, live read-only,
  cursor handles, result checks, size cap), the pinned allowlist
  contents, the number rule, wire error round-trip, result encoding and
  cap.

### Integration (main + memory Mongo)
- **script-handler.spec.ts**: drives `script:run` against
  `mongodb-memory-server`. Covers a `find().toArray()` round-trip
  through EJSON, `cancel` aborts an in-flight `find`, `dbName`
  override is respected, the `db` proxy and the W11 shell agree on
  the same expression's output.

### Component
- **script-tab.spec.tsx**: mounts `<ScriptTab>` against a mocked
  `api.script`. Verifies `Cmd+Enter` invokes `script.run` with the
  buffer, the result table renders an array result, the print
  buffer renders below the value, Cancel calls `script.cancel`,
  buffer changes flow through `api.tabs.update`, and the collection
  completions follow the typed database, else the connection's default,
  else `test`.

### E2E
- **script-editor.e2e.ts**: launches the real Electron app, seeds a
  connection against an in-memory MongoDB, opens a Script tab,
  types `db.users.insertOne({ name: "x" }); db.users.find().toArray();`,
  hits Cmd+Enter, asserts the document appears in the table and
  survives a relaunch.
