# C06 — Overview tab (real stats)

> **Status: Implemented.**

## Purpose

Replace the mocked server/storage/performance cards with real data drawn from the live Mongo server. Shows only metrics we can trust: MongoDB version, uptime, connection counts, DB count, data/storage size, index count, ops/sec, cache hit rate, topology.

## Scope

- **In**: `mongo:serverInfo` and `mongo:ping` IPC channels (F05), ServerInfo card rendering, loading/error states, manual refresh, auto-refresh cadence.
- **In (§9)**: the Monitor tab beside Overview: running operations (`$currentOp`), killOp, and the database profiler.
- **Out**: Connection CRUD (C02), collections table (C07).

## Dependencies

- C05 (selected connection), F05 (`MongoPool.serverInfo` and `ping`), F04 (event stream optional).

## 1. Data source

`MongoPool.serverInfo(id): Promise<ServerInfo>` (F05 §2) runs inside main:

```ts
const admin = (await pool.getClient(id)).db('admin');
const [buildInfo, serverStatus, listDbs] = await Promise.all([
  admin.command({ buildInfo: 1 }),
  admin.command({ serverStatus: 1 }),
  admin.command({ listDatabases: 1, nameOnly: false }),
]);
```

Derived fields:

| ServerInfo field       | Source |
| ---------------------- | ------ |
| `version`              | `buildInfo.version` |
| `uptimeSeconds`        | `serverStatus.uptime` |
| `connectionsCurrent`   | `serverStatus.connections.current` |
| `connectionsAvailable` | `serverStatus.connections.available` |
| `opcountersPerSec`     | delta of `serverStatus.opcounters` sum over 1s — see §2 |
| `latencyP99Ms`         | `serverStatus.opLatencies.reads.latency / ops` if available (else undefined) |
| `cacheHitRate`         | `wiredTiger.cache` ratios if available (else undefined) |
| `databaseCount`        | `listDbs.databases.length` |
| `dataSizeBytes`        | `listDbs.totalSize` |
| `storageSizeBytes`     | `sum over listDbs.databases[*].sizeOnDisk` |
| `indexCount`           | sum of per-collection `nindexes` across all databases; see §3 |
| `topology`             | from the `hello` reply captured at connect (`Single`, `ReplicaSet`, `Sharded`, or `Unknown` when hello failed) |

## 2. Ops/sec computation

`serverStatus` opcounters are cumulative. First call: record baseline and return `0`. Subsequent call: `(now - prev) / (seconds elapsed)`. Cache baseline per connection id in main.

## 3. Index count

Counting all indexes server-wide may be expensive on huge deployments. Heuristic:
- If `databaseCount > 50`, **do not** iterate collections; render `indexCount: null` and the UI shows "—".
- Else enumerate via `listCollections` + `collection.indexes()`; sum `length`.

This computation is async and may take seconds on large clusters. The Overview card renders a "Computing…" state for `indexCount` while the rest of the card is already filled.

## 4. IPC contract

Already declared in F05; restated:

| Channel             | Input    | Output        |
| ------------------- | -------- | ------------- |
| `mongo:serverInfo`  | `{id}`   | `ServerInfo`  |
| `mongo:ping`        | `{id}`   | `{ roundTripMs }` |

Errors surface as normal envelope failures.

## 5. UI

### Layout
Three cards (Server, Storage, Performance) in a flex-wrap row — same as mock. Each card shows 4–5 rows. A small Refresh button in the section's top-right. The whole Overview panel has a single "Last updated" timestamp above the cards.

### Loading / disconnected
- If `pool.status(id).status === 'connected'` and no ServerInfo cached yet → show a skeleton card (three rows per card, shimmering).
- If `status === 'connecting'`:
  - Render a centered card showing "Connecting…" and a **Cancel connection** button.
  - Clicking Cancel connection calls `api.mongo.disconnect(id)`, which force-closes the in-flight client; the pool's `catch` block only flips to `error` if status is still `connecting`, so a user-initiated cancel leaves the terminal status as `disconnected`, not `error`. The Overview tab transitions back to the disconnected / Connect CTA state automatically via the `mongo:status` event.
- If `status === 'disconnected'` (never connected):
  - Render a centered card: "Not connected. [Connect]".
  - Clicking Connect calls `api.mongo.connect(id)`; on success, triggers a serverInfo fetch.
- If `status === 'error'`:
  - Centered card with the last `errorMessage` and a `Retry` button.

### Card rows

**Server**
- Host (`host:port`) — from the `Connection` shape; not from ServerInfo.
- Version — `version`.
- Uptime — human-formatted (`humanDuration(uptimeSeconds)` → "14d 6h").
- Topology — `topology`.

**Storage**
- Databases — `databaseCount`.
- Data size — `humanBytes(dataSizeBytes)`.
- Storage size — `humanBytes(storageSizeBytes)`.
- Indexes — `indexCount ?? '—'`.

**Performance**
- Connections — `${current} / ${available + current}`.
- Ops/sec — rounded.
- Latency p99 — "{n} ms" or "—".
- Cache hit — `${(cacheHitRate * 100).toFixed(1)}%` or "—".

### Refresh
- Manual: button in header triggers fetch.
- Automatic: if the tab is visible, refetch every 15 seconds. Stop when tab hidden (use `document.visibilityState`).

## 6. Error handling

- If `serverInfo` throws `NETWORK` / `TIMEOUT` → render cards with their cached values (if any) and a small amber "Stale — couldn't refresh" pill.
- If no cache and it fails → render the error state card.

## 7. Acceptance criteria

- Selecting a connection in C05 and clicking Overview triggers at most one `mongo:serverInfo` call.
- Opening Overview on a cached connection renders within one frame (< 16ms).
- Refresh interval stops when the window is hidden.
- Values are formatted humanely (bytes as KB/MB/GB/TB, uptime as days/hours).
- Disconnected state offers Connect; Connect transition works.
- Large-deploy heuristic skips index count when `databaseCount > 50`.

## 8. Test cases

### Integration (against `mongodb-memory-server`)
- **`tests/integration/mongo-pool.spec.ts`**: returns populated fields; `databaseCount >= 1`; topology is `Single` for in-memory, with and without a logger attached; a client whose `hello` fails still connects and reports `Unknown`.
- **opcounters-delta.spec.ts**: two successive calls on a quiet server report a small (≥ 0, < large) per-sec rate.
- **index-count-skip.spec.ts**: stub `listDatabases` to return 60 entries → `indexCount === null`.

### Component
- **overview-loading.spec.tsx**: initial render shows skeleton; resolving mock hides it.
- **disconnected-connect.spec.tsx**: status disconnected → Connect button calls `api.mongo.connect` then refetches.
- **refresh-visibility.spec.tsx**: toggling `document.visibilityState` stops/resumes the interval.
- **stale-pill.spec.tsx**: second fetch errors → cached values remain; stale pill visible.

### E2E
- **overview-flow.e2e.ts**: create conn against memory Mongo → open ConnectionManager → Overview renders real version + db count.

## 9. Monitor tab

A second tab in the connection detail panel, right after Overview, for watching what the server is doing now. Cluster-scoped, so it stays in the Connection Manager (ADR 0003). Nothing here changes a document, so nothing is audited (ADR 0002).

### Channels

All non-secret, served by `MonitorService` and registered by `registerAdminChannels`. Errors go through `classifyMongoOpError`.

| Channel | Input | Output | Access |
| --- | --- | --- | --- |
| `admin:currentOp` | `{connectionId, activeOnly?, minSecsRunning?}` | `{ ops: CurrentOpSummary[] }` | read |
| `admin:killOp` | `{connectionId, opid: string}` | `{ ok: true }` | write |
| `admin:profileStatus` | `{connectionId, dbName}` | `{ level: 0\|1\|2, slowms }` | read |
| `admin:setProfileLevel` | `{connectionId, dbName, level: 0\|1\|2, slowms?}` | `{ ok: true }` | write |
| `admin:profileTail` | `{connectionId, dbName, limit? ≤ 100}` | `{ docs }`, canonical EJSON | read |

- `currentOp` runs `[{ $currentOp: { allUsers: true, idleConnections: false, idleSessions: false } }, { $match }, { $sort: { secs_running: -1 } }, { $limit: 200 }]` on `admin` with `maxTimeMS: STATS_TIMEOUT_MS`, over a control client opened and closed per call (see `killOp`), so it lists an op that holds the pool's last connection. Idle sessions are left out because they carry no opid. "Active only" matches `active: true`; "Running ≥ N s" matches `secs_running ≥ N`.
- `CurrentOpSummary` is `{ opid?, op, ns?, secsRunning?, client?, desc?, planSummary?, command }`. `opid` is `String()` of the server's opid: a number on mongod, `"shard:id"` on mongos. It is absent on a row the server gives none, and such a row offers no Kill. `client` falls back to `client_s` (mongos). `command` is the op's command as canonical EJSON with secret-named fields (`pwd`, `password`, …, the `log.ts` list) masked, since a `createUser` in flight carries its password. Past 2000 code points it is cut on a code-point boundary and ends in `… (truncated)`, so the UI shows it as text and never parses it.
- `killOp` sends a numeric opid as a number and anything else as the string. It goes through `pool.write`, so a read-only connection refuses it (ADR 0005). The kill runs on a control client of its own, so it never queues behind the op it targets when that op holds the pool's last connection.
- `profileStatus` is `profile: -1`; the server reports the current level as `was`.
- `setProfileLevel` goes through `pool.write`, so a read-only connection refuses it. `slowms` is server-wide, not per database.
- `profileTail` reads `system.profile` sorted by `ts` descending, 50 rows by default.

### UI

- Disconnected: the same "Not connected. Open the Overview tab to connect." text as the other tabs, and no calls.
- **Current operations.** Fetches `admin:currentOp` on open, then polls every 5 seconds (the Overview pattern, at 5s instead of 15s). A tick is skipped while the window is hidden or while the previous request is still pending. A Pause button stops polling until Resume. Filters: "Active only" (on by default) and "Running ≥ N s". The table shows opid, op, namespace, secs, client and plan; each row expands to show its command. Kill asks first through `confirmDestructive` ("Kill operation <opid>?", with the op, namespace and running time in the body, confirm label "Kill").
- **Profiler.** A database select (the connection's default database, else the first listed), the current level and slowms, an Off/Slow/All `SegmentedControl` with a slowms field (marked server-wide) and Apply, and the latest 50 `system.profile` rows (time, op, namespace, millis, plan) with Refresh.
- A reply for a database no longer picked is dropped. A failed profiler load clears the shown status and keeps Apply disabled, so the defaults are never sent; Apply is enabled only once a status has loaded.
- On a read-only connection Kill, the level control, slowms and Apply are disabled and point (`aria-describedby`) at a visible note saying why.

### Acceptance criteria

- The Monitor tab sits right after Overview and shows the Not connected text when disconnected.
- While connected, `admin:currentOp` is called on open and then every 5 seconds; an interval tick is skipped while the window is hidden or a request is still pending, and none fires while paused.
- The Active only and Running ≥ N s filters reach the `$match`.
- Kill opens a confirm and calls `admin:killOp` only once confirmed; cancelling kills nothing.
- A read-only connection refuses `admin:killOp` and `admin:setProfileLevel` in main, and the UI disables those controls.
- Killing an opid that does not exist succeeds (the server answers ok).
- At `maxPoolSize: 1`, an op holding the only pooled connection is listed and can be killed.
- The command never carries a secret-named field's value.
- Setting level 1 with slowms 0, then running a find, lists that find in the profile tail.

### Test cases

- **`tests/integration/monitor-service.spec.ts`** (own mongod, since slowms is server-wide): currentOp lists its own aggregate with and without Active only, and Running ≥ 3600 s drops it; killOp of a missing opid resolves; killOp stops a running `$where: sleep` find; a read-only connection refuses kill and set-level but reads status; status → set level 1 / slowms 0 → find → profile tail lists it as canonical EJSON; at `maxPoolSize: 1` currentOp lists and killOp stops the op holding the only pooled connection; the stage asks for `idleSessions: false`; opid-less rows, command redaction and code-point truncation; opid conversion.
- **`tests/integration/admin-handlers.spec.ts`**: zod bounds for every channel.
- **`tests/integration/ipc-channel-registration.spec.ts`**: includes `registerAdminChannels`.
- **`tests/component/monitor-tab.spec.tsx`**: renders ops and expands a command; kill confirm and cancel; read-only disables controls; fake-timer polling, hidden and paused; filters; profiler reads canonical rows and applies a level; in-flight tick skip; Kill does not toggle the row or reach a parent handler; opid-less rows have no Kill; a stale profiler reply is dropped; a failed load keeps Apply off; read-only disables the level radios and points at the note.
- **`tests/component/detail-panel.spec.tsx`**: tab order and opening the monitor.
- **`tests/e2e/conn-monitor.e2e.ts`**: open Monitor, set the profiler to All, run a query in the workspace, and see it in the profile tail.

