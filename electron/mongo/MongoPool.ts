import { EventEmitter } from 'node:events';
import {
  MongoClient,
  type Db,
  type Document,
  type MongoClientOptions,
  type TopologyDescriptionChangedEvent,
} from 'mongodb';
import type {
  Connection,
  ConnectionInput,
  ConnectionRuntime,
  ConnectionStatus,
  MongoTopology,
  ProbeErrorCode,
  ProbeResult,
} from '@shared/types';
import { NotFoundError, ReadOnlyConnectionError, SystemError, ValidationError } from '../errors.ts';
import type { Logger } from '../log.ts';
import type { SecretsVault } from '../secrets/SecretsVault.ts';
import { classifyMongoError, classifyMongoOpError, isMaxTimeMSExpired } from './errors.ts';
import { QUERY_TIMEOUT_MS } from './timeouts.ts';
import { topologyFromHello, type HelloResponse } from './topology.ts';
import { buildOptions, buildUri, redactUriUserInfo } from './uri.ts';

export interface ConnectionReader {
  findById(id: string): Connection | null;
}

export interface ServerInfo {
  version: string;
  uptimeSeconds: number;
  connectionsCurrent: number;
  connectionsAvailable: number;
  opcountersPerSec: number;
  latencyP99Ms?: number;
  cacheHitRate?: number;
  /** Null when `listDatabases` failed — see the note on `ServerInfo` in `shared/ipc.ts`. */
  databaseCount: number | null;
  dataSizeBytes: number | null;
  storageSizeBytes: number | null;
  indexCount: number | null;
  topology: MongoTopology;
  /** False when the user lacks `serverStatus` admin privilege. */
  serverStatsAvailable: boolean;
}

interface Entry {
  status: ConnectionStatus;
  client?: MongoClient;
  connectPromise?: Promise<MongoClient>;
  errorCode?: ProbeErrorCode;
  errorMessage?: string;
  connectedAt?: string;
  serverVersion?: string;
  topology?: MongoTopology;
  opcountersBaseline?: { sum: number; t: number };
  // Cached defaultDb populated from the repo at connect time. Lets getDb()
  // skip a SQLite + vault round-trip on every Mongo op. The invariant is:
  // after a successful connect, this mirrors the repo row. ConnectionService
  // disconnects the pool whenever default_db changes (see
  // mongoRelevantFieldsChanged), so the next connect repopulates it.
  defaultDb?: string;
  /**
   * Which connect attempt currently owns this entry's mutable state. Bumped
   * once per `connect(id)` that starts a fresh `run()`.
   *
   * `run()` and its `.catch`/`.finally` close over the shared `entry`, so
   * without this a cancelled attempt that settles *after* a retry has started
   * writes its outcome over the newer attempt's: it clears the retry's live
   * client, flips the entry to 'error' with the cancelled attempt's message,
   * emits a transition the live attempt never made, and drops the retry's
   * `connectPromise`. Cancel → Retry is the intended recovery path of
   * X16 §4.3, so that is the ordinary case and not a corner.
   */
  connectGen?: number;
}

/**
 * Dependency-injected factory so tests can substitute a fake client.
 */
export type ClientFactory = (uri: string, options: MongoClientOptions) => MongoClient;

export interface MongoPoolOpts {
  repo: ConnectionReader;
  vault: SecretsVault;
  log?: Logger;
  clientFactory?: ClientFactory;
  /**
   * When true, attach listeners to driver events (serverHeartbeatFailed,
   * topologyDescriptionChanged, connectionPoolClosed) and log them at debug
   * level. Off by default — gated by `ATELIER_DEBUG_DRIVER=1` in main.
   * The point is to dump a full driver-side timeline when a user reports an
   * intermittent connect/topology issue.
   */
  debugDriverEvents?: boolean;
  /** Overridable so tests don't wait out the full grace window. */
  connectionLossGraceMs?: number;
}

/**
 * How long the driver must see a completely unreachable deployment before we
 * call a Connection lost. SDAM re-probes a failed server every
 * `minHeartbeatFrequencyMS` (500ms in driver 7.x), so this window covers about
 * ten re-probes: long enough that an ordinary blip never reaches the UI, short
 * enough that a real drop surfaces while the user is still looking at it.
 */
const CONNECTION_LOSS_GRACE_MS = 5_000;

/**
 * Proof that a connection was checked and is writable. Obtained from
 * `MongoPool.write()`, which refuses a read-only connection before returning
 * one, so holding a grant is what makes the handles below reachable.
 */
export interface WriteGrant {
  db(dbName?: string): Promise<Db>;
  client(): Promise<MongoClient>;
}

export class MongoPool extends EventEmitter {
  private repo: ConnectionReader;
  private vault: SecretsVault;
  private log?: Logger;
  private clientFactory: ClientFactory;
  private debugDriverEvents: boolean;
  private connectionLossGraceMs: number;
  private entries = new Map<string, Entry>();

  constructor(opts: MongoPoolOpts) {
    super();
    this.repo = opts.repo;
    this.vault = opts.vault;
    this.log = opts.log;
    this.clientFactory = opts.clientFactory ?? ((uri, options) => new MongoClient(uri, options));
    this.debugDriverEvents = opts.debugDriverEvents ?? false;
    this.connectionLossGraceMs = opts.connectionLossGraceMs ?? CONNECTION_LOSS_GRACE_MS;
  }

  /**
   * Wire driver-side listeners onto a freshly-constructed MongoClient.
   * Listeners are removed implicitly when the client is closed and
   * dereferenced.
   *
   * Two independent concerns share the hook. The per-event logging below stays
   * gated behind `ATELIER_DEBUG_DRIVER=1` because it is noisy. Loss detection
   * always runs — X16 §2 requires a Connection that drops on its own to go
   * Dormant, and nothing else in the pool ever notices.
   */
  private attachDriverEventListeners(client: MongoClient, connectionId: string): void {
    this.attachLossDetection(client, connectionId);
    if (!this.debugDriverEvents || !this.log) return;
    client.on('serverHeartbeatFailed', (evt: { connectionId?: number; failure?: Error; duration?: number }) => {
      this.log?.debug('mongo:driver', 'serverHeartbeatFailed', {
        connectionId,
        durationMs: evt.duration,
        failure: evt.failure?.message,
      });
    });
    client.on('topologyDescriptionChanged', (evt: { previousDescription?: { type?: string }; newDescription?: { type?: string } }) => {
      this.log?.debug('mongo:driver', 'topologyDescriptionChanged', {
        connectionId,
        from: evt.previousDescription?.type,
        to: evt.newDescription?.type,
      });
    });
    client.on('connectionPoolClosed', (evt: { address?: string }) => {
      this.log?.debug('mongo:driver', 'connectionPoolClosed', {
        connectionId,
        address: evt.address,
      });
    });
  }

  /**
   * Flip an entry to Dormant once the driver can no longer reach any server in
   * the deployment.
   *
   * The signal is `TopologyDescription.hasKnownServers`. SDAM marks a server
   * Unknown the moment one heartbeat fails, so "no known servers" is the
   * driver's own verdict that nothing in the deployment answers — it aggregates
   * a replica set for free, where counting `serverHeartbeatFailed` events would
   * re-derive per-server state SDAM already tracks. Reading
   * `newDescription.type` instead does not work: a `directConnection` yields
   * TopologyType Single, which the driver freezes for the life of the client
   * and never moves to 'Unknown'.
   *
   * The grace timer is what keeps a normal blip off the UI. One missed
   * heartbeat clears `hasKnownServers`, but the monitor re-probes every
   * `minHeartbeatFrequencyMS`, so a recovery lands well inside the window and
   * cancels the pending timer.
   */
  private attachLossDetection(client: MongoClient, connectionId: string): void {
    let lossTimer: NodeJS.Timeout | undefined;
    client.on('topologyDescriptionChanged', (evt: TopologyDescriptionChangedEvent) => {
      if (evt.newDescription.hasKnownServers) {
        clearTimeout(lossTimer);
        lossTimer = undefined;
        return;
      }
      if (lossTimer) return;
      // unref'd — a pending loss timer must never hold the process open at quit.
      lossTimer = setTimeout(() => {
        lossTimer = undefined;
        this.markConnectionLost(connectionId, client);
      }, this.connectionLossGraceMs).unref();
    });
  }

  /**
   * X16 §2: "Drops on its own (network loss, server restart) → Dormant. Tabs
   * survive." Only a live, connected entry can drop, and only the client that
   * raised the event may act on it.
   *
   * `entry.client !== client` is load-bearing in three places, not one: a
   * `probe()` client is attached with a real connection id on the edit-dialog
   * path but never stored on an entry; a client superseded by a reconnect is
   * still emitting; and `disconnect()`'s own `close()` tears the topology down,
   * which emits this very event. All three must be inert. Same discipline as
   * `connectGen` in connect(), keyed on the client instead.
   *
   * Deliberately not a call to `disconnect()`. An involuntary drop is not the
   * user asking to close, and closing would kill the driver's monitor mid
   * self-heal. Keeping the client costs nothing: `connect()` closes it when the
   * user wakes the Connection, `disconnectAll()` closes it at quit. errorCode /
   * errorMessage stay clear (connect() already cleared them) so the UI renders
   * Dormant rather than a failure the user never caused.
   */
  private markConnectionLost(id: string, client: MongoClient): void {
    const entry = this.entries.get(id);
    if (!entry || entry.client !== client || entry.status !== 'connected') return;
    entry.status = 'disconnected';
    entry.connectedAt = undefined;
    clearServerFacts(entry);
    this.log?.warn('mongo', 'connection lost — deployment unreachable', { connectionId: id });
    this.emit('status', this.status(id));
  }

  /**
   * Run `hello` (or `isMaster` on MongoDB < 4.4), log a redacted snapshot of
   * the topology when a logger is present, and return the reply so the caller
   * can classify the deployment from it. Runs with or without a logger: the
   * topology on `ConnectionRuntime` / `ServerInfo` depends on it. Best-effort:
   * a failed hello yields `null` (topology `Unknown`) and never fails a
   * successful connect/probe.
   */
  private async readHello(client: MongoClient, connectionId: string, source: 'connect' | 'probe'): Promise<HelloResponse | null> {
    const admin = client.db('admin');
    let hello: HelloResponse;
    try {
      hello = (await admin.command({ hello: 1 })) as HelloResponse;
    } catch {
      // Mongo < 4.4 doesn't know `hello`. Fall back to the legacy alias so we
      // still get a reply on those clusters.
      try {
        hello = (await admin.command({ isMaster: 1 })) as HelloResponse;
      } catch (err) {
        this.log?.debug('mongo', 'hello snapshot failed', {
          connectionId,
          source,
          message: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }
    const isPrimary = hello.isWritablePrimary ?? hello.ismaster ?? false;
    const role = isPrimary
      ? 'primary'
      : hello.secondary
        ? 'secondary'
        : hello.arbiterOnly
          ? 'arbiter'
          : hello.msg === 'isdbgrid'
            ? 'mongos'
            : 'unknown';
    this.log?.info('mongo', 'hello snapshot', {
      connectionId,
      source,
      setName: hello.setName,
      hosts: hello.hosts,
      primary: hello.primary,
      me: hello.me,
      role,
      maxWireVersion: hello.maxWireVersion,
    });
    return hello;
  }

  status(id: string): ConnectionRuntime {
    const e = this.entries.get(id) ?? { status: 'disconnected' as const };
    return {
      id,
      status: e.status,
      errorCode: e.errorCode,
      errorMessage: e.errorMessage,
      connectedAt: e.connectedAt,
      serverVersion: e.serverVersion,
      topology: e.topology,
    };
  }

  /**
   * True if the connection's persisted read_only flag is set. Looked up
   * fresh on every call (this.repo.findById is a sync SQLite read) rather
   * than cached, so toggling the flag takes effect on the very next call —
   * see ADR 0005.
   */
  isReadOnly(id: string): boolean {
    return this.repo.findById(id)?.readOnly ?? false;
  }

  /**
   * Throws ReadOnlyConnectionError if the connection is read-only. An unknown
   * connectionId doesn't throw here — the client/db fetch that inevitably
   * follows already throws NotFoundError for that case.
   *
   * Services must NOT call this: `write()` calls it for them, and
   * that is the point of the seam — a handle you ask for rather than a check
   * you remember. It stays public for exactly one caller, `ShellService`,
   * whose refusal is session-wide rather than handle-shaped (ADR 0005's third
   * enforcement point) and must stay synchronous because `write()` is.
   */
  public assertWritable(id: string): void {
    const conn = this.repo.findById(id);
    if (conn?.readOnly) {
      throw new ReadOnlyConnectionError(`Connection "${conn.name}" is read-only.`);
    }
  }

  private async getClientInternal(id: string): Promise<MongoClient> {
    const existing = this.entries.get(id);
    if (existing?.status === 'connected' && existing.client) return existing.client;
    if (existing?.connectPromise) return existing.connectPromise;
    return this.connect(id).then((r) => {
      if (r.status !== 'connected') {
        throw new SystemError(
          'DB_ERROR',
          r.errorMessage ?? 'failed to connect',
          { errorCode: r.errorCode },
        );
      }
      // Re-read the entry after connect() resolves: a `disconnect(id)` — the
      // Cancel action of X16 §4.3 — can land between the status snapshot and
      // here, leaving client undefined. Throw a typed error instead of
      // returning a non-null-asserted undefined that would later blow up as
      // `undefined.db(name)` → opaque INTERNAL.
      const entry = this.entries.get(id);
      if (!entry?.client) {
        throw new SystemError('DB_ERROR', 'connection canceled');
      }
      return entry.client;
    });
  }

  private async getDbInternal(id: string, dbName?: string): Promise<Db> {
    const client = await this.getClientInternal(id);
    const name = dbName ?? this.entries.get(id)?.defaultDb;
    if (!name) {
      throw new SystemError('VALIDATION', 'no database specified and connection has no default_db');
    }
    return client.db(name);
  }

  /**
   * The database a shell or script starts on: the caller's choice, else the
   * connection's default, else `test` (mongosh's own default). Unlike
   * `getDbInternal` it never throws, so call it after a successful connect —
   * the default is only cached then.
   */
  resolveDbName(id: string, dbName?: string): string {
    return dbName?.trim() || this.entries.get(id)?.defaultDb || 'test';
  }

  /**
   * Guarded handles (X18 §4) — the service-facing surface. A neutral
   * `getDb`/`getClient` used to hand out a handle with no read/write
   * distinction, leaving `assertWritable(id)` as an instruction every
   * write-service method had to remember to call first.
   *
   * Reads ask directly. Writes ask for a *grant* first, and the grant is what
   * connects — because refusal and connection happen at different points in a
   * write method and must stay there. The original shape was
   *
   *     assertWritable(id)      // top: refuse before anything else
   *     validate(input)         // middle: local checks, no network
   *     await getDb(id, name)   // bottom: connect
   *
   * and a single `await writeDb(...)` cannot occupy all three positions. Put it
   * at the top and local validation starts failing as connection errors on an
   * unreachable server; put it at the bottom and a malformed payload on a
   * read-only connection reports VALIDATION where it used to report READ_ONLY.
   * Both were observed — in different files — when this was one call.
   *
   * `write(id)` refuses synchronously, exactly where `assertWritable` stood;
   * `grant.db()` / `grant.client()` connect, exactly where `getDb`/`getClient`
   * stood. The check stays non-omittable because the grant is the only way to
   * reach the handle.
   *
   * Not unbypassable — a write method could still call `readDb` and write
   * through it — but the failure mode changes from invisible to visible
   * (see ADR 0005).
   */
  async readDb(id: string, dbName?: string): Promise<Db> {
    return this.getDbInternal(id, dbName);
  }

  async readClient(id: string): Promise<MongoClient> {
    return this.getClientInternal(id);
  }

  private connectArgs(id: string, conn: Connection): { uri: string; opts: MongoClientOptions } {
    const password = conn.authMech === 'none' ? undefined : this.vault.get(id, 'password') ?? undefined;
    return { uri: buildUri(conn, password), opts: buildOptions(conn) };
  }

  /**
   * A client of its own, outside the connection's pool, for a command that
   * must not queue behind the pool's operations: a `killOp` aimed at an op
   * that holds every pooled connection (always the case at `maxPoolSize: 1`).
   * Same URI, credentials and TLS as the pooled client. The caller closes it.
   */
  async openControlClient(id: string): Promise<MongoClient> {
    const conn = this.repo.findById(id);
    if (!conn) throw new NotFoundError(`connection ${id} not found`);
    if (conn.ssh?.enabled) throw new ValidationError('SSH tunnels are not supported yet');
    const { uri, opts } = this.connectArgs(id, conn);
    const client = this.clientFactory(uri, { ...opts, maxPoolSize: 1 });
    try {
      await client.connect();
    } catch (err) {
      await client.close().catch((closeErr: unknown) => {
        this.log?.warn('mongo', 'close failed (control client)', {
          connectionId: id,
          err: String(closeErr),
        });
      });
      throw err;
    }
    return client;
  }

  /**
   * Refuses a read-only connection **now**, synchronously, and hands back the
   * only route to a writable handle. Nothing is connected until the caller
   * asks the grant for one.
   */
  write(id: string): WriteGrant {
    this.assertWritable(id);
    return {
      db: (dbName?: string) => this.getDbInternal(id, dbName),
      client: () => this.getClientInternal(id),
    };
  }

  async connect(id: string): Promise<ConnectionRuntime> {
    const conn = this.repo.findById(id);
    if (!conn) throw new NotFoundError(`connection ${id} not found`);
    // Fail closed before any entry or status exists: a stored ssh_enabled row
    // (legacy data, or a patch that kept the flag) must never fall through to a
    // direct connection that bypasses the tunnel the user expected.
    if (conn.ssh?.enabled) throw new ValidationError('SSH tunnels are not supported yet');

    // X16 §4.1 — several Connections stay connected at once. The pool is
    // keyed by id and holds one entry per Connection, so connecting to B
    // leaves A alone. The preemption loop that used to close every other
    // connected/connecting entry here is deleted.
    //
    // It was load-bearing in one respect: force-closing another entry's
    // in-flight client drained the driver's topology wait queue, which made a
    // stuck client.connect() reject at once. `disconnect(id)` still does that
    // drain; what changed is that the user asks for it explicitly (Cancel,
    // §4.3) rather than getting it as a side effect of connecting elsewhere.
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { status: 'disconnected' };
      this.entries.set(id, entry);
    }
    // Reuse an in-flight connect only when the entry is still actually
    // 'connecting'. After a Cancel the status flipped to 'disconnected' but
    // the old connectPromise may still be settling; awaiting it would make a
    // fresh connect attempt return the dying one's status.
    if (entry.connectPromise && entry.status === 'connecting') {
      await entry.connectPromise;
      return this.status(id);
    }

    // Stake this attempt's claim on the entry before anything async runs. Every
    // write below is gated on still holding it, so a superseded attempt settling
    // late is inert rather than destructive. The map lookup is part of the
    // check because `disconnect` + `connect` reuse the Entry object today, but
    // nothing in the pool's contract promises they always will.
    const gen = (entry.connectGen ?? 0) + 1;
    entry.connectGen = gen;
    const isCurrent = () => this.entries.get(id) === entry && entry.connectGen === gen;

    const run = async (): Promise<MongoClient> => {
      const { uri, opts } = this.connectArgs(id, conn);
      const client = this.clientFactory(uri, opts);
      this.attachDriverEventListeners(client, id);
      // Reconnecting on an id that already holds a client (edit-reconnect,
      // error-retry, or just re-clicking an already-connected row post-#504)
      // must not leak it. Grab it and swap it out for the new one first —
      // zero awaits in between, same as before — then close it in the
      // background. Deliberately NOT awaited: disconnectAll()'s 5s budget
      // exists because a real driver's close() can hang, and awaiting it
      // here would stall this whole reconnect (and Cancel, which would be
      // fighting over the same hung close) on an old client nobody needs
      // anymore. Best-effort, like disconnect()'s close — log on failure.
      const previousClient = entry!.client;
      // Expose the in-flight client immediately so disconnect() can force it
      // closed while the connect is still hanging — the Cancel path of §4.3.
      // ops still gate on status === 'connected', so this can't be observed
      // externally.
      entry!.client = client;
      if (previousClient) {
        void previousClient.close().catch((err) => {
          this.log?.warn('mongo', 'close failed (previous client on reconnect)', {
            connectionId: id,
            err: String(err),
          });
        });
      }
      // Cancelled between an await and our next state update — or superseded by
      // a retry, in which case `entry.client` is that retry's healthy client and
      // clearing it would be the very corruption this guard is meant to
      // prevent. Close only the client we opened.
      const isCanceled = () => !isCurrent() || entry!.status !== 'connecting';
      const abandon = async (): Promise<never> => {
        try { await client.close(); } catch { /* best-effort */ }
        if (isCurrent()) entry!.client = undefined;
        throw new SystemError('DB_ERROR', 'connection canceled');
      };
      await client.connect();
      if (isCanceled()) await abandon();
      const info = (await client.db('admin').command({ buildInfo: 1 })) as { version?: string };
      const hello = await this.readHello(client, id, 'connect');
      // A Cancel can land while either read is in flight. A closed client makes
      // the driver reject them, and readHello swallows that by design, so
      // without a second check the entry would be written back as connected
      // around a client nobody can use. The check and the writes below must
      // stay in one synchronous run, with no await between them.
      if (isCanceled()) await abandon();
      entry!.serverVersion = info.version;
      entry!.topology = topologyFromHello(hello);
      entry!.status = 'connected';
      entry!.connectedAt = new Date().toISOString();
      entry!.errorCode = undefined;
      entry!.errorMessage = undefined;
      entry!.client = client;
      // Cache defaultDb only after a successful connect so a failed attempt
      // doesn't leave a stale value on a disconnected entry.
      entry!.defaultDb = conn.defaultDb ?? undefined;
      this.emit('status', this.status(id));
      return client;
    };

    entry.status = 'connecting';
    this.emit('status', this.status(id));
    entry.connectPromise = run()
      .catch((err) => {
        const cls = classifyMongoError(err);
        // Only touch the entry while we still own it. A retry started after a
        // Cancel owns it instead, and both the client clear and the status
        // flip would land on that healthy attempt.
        if (isCurrent()) {
          entry!.client = undefined;
          // A failed attempt says nothing about the server it was aimed at, so
          // the previous attempt's version and topology must not outlive it.
          clearServerFacts(entry!);
          // Only flip to 'error' if we weren't cancelled. disconnect() may have
          // set 'disconnected' to cancel us; respect that and don't overwrite.
          if (entry!.status === 'connecting') {
            entry!.status = 'error';
            entry!.errorCode = cls.code;
            entry!.errorMessage = cls.message;
            this.emit('status', this.status(id));
          }
        }
        this.log?.warn('mongo', 'connect failed', {
          connectionId: id,
          code: cls.code,
          message: cls.message,
        });
        throw err;
      })
      .finally(() => {
        // Never clear a retry's in-flight promise on our way out.
        if (isCurrent()) entry!.connectPromise = undefined;
      });

    try {
      await entry.connectPromise;
    } catch {
      // swallow — caller reads status()
    }
    return this.status(id);
  }

  async disconnect(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry?.client) return;
    const client = entry.client;
    entry.client = undefined;
    entry.status = 'disconnected';
    entry.connectedAt = undefined;
    clearServerFacts(entry);
    entry.defaultDb = undefined;
    entry.errorCode = undefined;
    entry.errorMessage = undefined;
    this.emit('status', this.status(id));
    try {
      await client.close();
    } catch (err) {
      this.log?.warn('mongo', 'close failed', { connectionId: id, err: String(err) });
    }
  }

  async disconnectAll(): Promise<void> {
    const ids = [...this.entries.keys()];
    await Promise.race([
      Promise.allSettled(ids.map((id) => this.disconnect(id))),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }

  async ping(id: string): Promise<number> {
    const client = await this.getClientInternal(id);
    const t0 = Date.now();
    try {
      await client.db('admin').command({ ping: 1 });
    } catch (err) {
      throw classifyMongoOpError(err);
    }
    return Date.now() - t0;
  }

  async serverInfo(id: string): Promise<ServerInfo> {
    const client = await this.getClientInternal(id);
    const admin = client.db('admin');

    // Each admin command is run independently so one permission failure
    // (typical: `serverStatus` on restricted roles) doesn't poison the whole
    // serverInfo call. `buildInfo` is nearly always accessible; if it fails
    // we surface the error since we can't even report a version.
    let buildInfo: { version: string };
    try {
      buildInfo = (await admin.command({ buildInfo: 1 })) as { version: string };
    } catch (err) {
      throw classifyMongoOpError(err);
    }

    let serverStatus: ServerStatusDoc | null = null;
    try {
      serverStatus = (await admin.command({ serverStatus: 1 })) as ServerStatusDoc;
    } catch {
      // Role lacks serverStatus privilege (Atlas read-only, scoped roles).
      // Leave as null — downstream fields become 0/undefined placeholders.
    }

    // Null, not an empty reply: a role without the privilege and a server
    // with no databases are different answers, and the sums below cannot tell
    // them apart once this collapses to `[]`.
    let listDbs: ListDbsDoc | null = null;
    // Only the `nameOnly: false` reply carries sizes. The degraded retry
    // below recovers the names, and with them the count, but never these.
    let sizesMeasured = false;
    try {
      listDbs = (await admin.command({
        listDatabases: 1,
        nameOnly: false,
        authorizedDatabases: true,
        // `nameOnly: false` makes the server total storage per database, so
        // the cost scales with how many there are — the same reason the
        // navigator's own listDatabases carries the interactive budget.
        maxTimeMS: QUERY_TIMEOUT_MS,
      })) as ListDbsDoc;
      sizesMeasured = true;
    } catch (err) {
      // A role without the privilege has nothing to fall back to, and leaves
      // all three figures null. A bound that fired is different: the cost
      // that blew it was the per-database stats total, and the names-only
      // catalog read is fixed-cost, so the count is still recoverable. The
      // navigator's own listDatabases degrades the same way.
      if (isMaxTimeMSExpired(err)) {
        try {
          listDbs = (await admin.command({
            listDatabases: 1,
            nameOnly: true,
            authorizedDatabases: true,
            maxTimeMS: QUERY_TIMEOUT_MS,
          })) as ListDbsDoc;
        } catch {
          // The cheap read expired too — the deployment is not answering.
          // Everything stays null rather than reporting a measured zero.
        }
      }
    }

    const entry = this.entries.get(id)!;
    let opcountersPerSec = 0;
    if (serverStatus) {
      const opsum = sumOpcounters(serverStatus.opcounters);
      const now = Date.now();
      if (entry.opcountersBaseline) {
        const dtSec = (now - entry.opcountersBaseline.t) / 1000;
        opcountersPerSec = dtSec > 0 ? Math.max(0, (opsum - entry.opcountersBaseline.sum) / dtSec) : 0;
      }
      entry.opcountersBaseline = { sum: opsum, t: now };
    } else {
      // Don't track a stale baseline when the permission comes back later.
      entry.opcountersBaseline = undefined;
    }

    const databases = listDbs?.databases ?? [];
    const storageBytes = sizesMeasured
      ? databases.reduce((a, d) => a + (d.sizeOnDisk ?? 0), 0)
      : null;
    const dataSize = sizesMeasured ? (listDbs?.totalSize ?? storageBytes) : null;

    // dbStats returns the index count for a database in a single roundtrip,
    // so we no longer need to enumerate collections and call .indexes() on
    // each one. Still capped at 50 dbs as a sanity bound on big clusters.
    let indexCount: number | null = null;
    if (databases.length <= 50) {
      const perDb = await Promise.all(
        databases.map(async (d) => {
          try {
            const stats = (await client.db(d.name).stats()) as { indexes?: number };
            return stats.indexes ?? 0;
          } catch {
            return 0;
          }
        }),
      );
      indexCount = perDb.reduce((a, b) => a + b, 0);
    }

    const cacheHitRate = serverStatus ? wiredTigerHitRate(serverStatus) : undefined;
    const latencyP99 = serverStatus ? avgReadLatencyMs(serverStatus) : undefined;

    return {
      version: buildInfo.version,
      uptimeSeconds: serverStatus?.uptime ?? 0,
      connectionsCurrent: serverStatus?.connections?.current ?? 0,
      connectionsAvailable: serverStatus?.connections?.available ?? 0,
      opcountersPerSec: Math.round(opcountersPerSec),
      latencyP99Ms: latencyP99,
      cacheHitRate,
      databaseCount: listDbs === null ? null : databases.length,
      dataSizeBytes: dataSize,
      storageSizeBytes: storageBytes,
      indexCount,
      topology: entry.topology ?? 'Unknown',
      serverStatsAvailable: serverStatus !== null,
    };
  }

  /**
   * Validate a transient config without persisting anything. Opens a brand-new
   * MongoClient, pings, closes. Never touches the pool's stored entries.
   */
  async probe(input: ConnectionInput & { id?: string }): Promise<ProbeResult> {
    if (input.ssh?.enabled) {
      return {
        ok: false,
        errorCode: 'UNKNOWN',
        errorMessage: 'SSH tunnels are not supported in this iteration.',
      };
    }
    const pseudo: Connection = {
      id: input.id ?? 'probe',
      name: input.name,
      color: input.color,
      connectionType: input.connectionType,
      host: input.host,
      port: input.port,
      defaultDb: input.defaultDb,
      authMech: input.authMech,
      authUsername: input.authUsername,
      authDatabase: input.authDatabase,
      tls: input.tls,
      ssh: input.ssh,
      advanced: {
        ...input.advanced,
        connectTimeoutMs: Math.min(input.advanced.connectTimeoutMs, 5000),
        serverSelectionTimeoutMs: Math.min(input.advanced.serverSelectionTimeoutMs, 5000),
        maxPoolSize: 1,
      },
      hasPasswordStored: false,
      hasSshPasswordStored: false,
      hasSshPassphraseStored: false,
      readOnly: input.readOnly,
      createdAt: '',
      updatedAt: '',
    };
    const uri = buildUri(pseudo, input.password);
    const opts = buildOptions(pseudo);
    // Log the URI with userinfo redacted so we can diagnose probe failures
    // without leaking credentials.
    this.log?.info('mongo', 'probe uri', {
      connectionId: pseudo.id,
      uri: redactUriUserInfo(uri),
    });
    let client: MongoClient;
    try {
      client = this.clientFactory(uri, opts);
    } catch (err) {
      const cls = classifyMongoError(err);
      this.log?.warn('mongo', 'probe client construction failed', {
        connectionId: pseudo.id,
        code: cls.code,
        message: cls.message,
        uri: redactUriUserInfo(uri),
      });
      return { ok: false, errorCode: cls.code, errorMessage: cls.message };
    }
    this.attachDriverEventListeners(client, pseudo.id);
    const t0 = Date.now();
    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      const info = (await client.db('admin').command({ buildInfo: 1 })) as { version?: string };
      const hello = await this.readHello(client, pseudo.id, 'probe');
      return {
        ok: true,
        serverVersion: info.version,
        topology: topologyFromHello(hello),
        roundTripMs: Date.now() - t0,
      };
    } catch (err) {
      const cls = classifyMongoError(err);
      this.log?.warn('mongo', 'probe connect failed', {
        connectionId: pseudo.id,
        code: cls.code,
        message: cls.message,
        uri: redactUriUserInfo(uri),
      });
      return { ok: false, errorCode: cls.code, errorMessage: cls.message };
    } finally {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Version and topology describe the server a live connection reached. Once
 * that connection is gone or a later attempt failed they describe nothing, and
 * `status()` must not report them next to 'disconnected' or 'error'.
 */
function clearServerFacts(entry: Entry): void {
  entry.serverVersion = undefined;
  entry.topology = undefined;
}

interface ServerStatusDoc extends Document {
  uptime?: number;
  connections?: { current?: number; available?: number };
  opcounters?: Record<string, number>;
  opLatencies?: Record<string, { latency?: number; ops?: number }>;
  wiredTiger?: { cache?: Record<string, number> };
}

interface ListDbsDoc extends Document {
  databases?: Array<{ name: string; sizeOnDisk?: number; empty?: boolean }>;
  totalSize?: number;
}

function sumOpcounters(op: Record<string, number> | undefined): number {
  if (!op) return 0;
  let sum = 0;
  for (const v of Object.values(op)) sum += v;
  return sum;
}

function wiredTigerHitRate(s: ServerStatusDoc): number | undefined {
  const cache = s.wiredTiger?.cache;
  if (!cache) return undefined;
  const requests = cache['pages requested from the cache'];
  const reads = cache['pages read into cache'];
  if (typeof requests !== 'number' || typeof reads !== 'number' || requests === 0) return undefined;
  return Math.max(0, Math.min(1, 1 - reads / requests));
}

function avgReadLatencyMs(s: ServerStatusDoc): number | undefined {
  const reads = s.opLatencies?.reads;
  if (!reads || !reads.latency || !reads.ops) return undefined;
  // Microseconds per op → milliseconds
  return reads.ops === 0 ? undefined : Math.round((reads.latency / reads.ops) / 10) / 100;
}
