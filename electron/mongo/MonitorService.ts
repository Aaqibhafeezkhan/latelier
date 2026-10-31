import type {
  CurrentOpInput,
  CurrentOpSummary,
  ProfileLevel,
  ProfileStatus,
} from '@shared/types';
import type { MongoClient } from 'mongodb';
import { ejsonEncodeArray, ejsonStringifyDriverValue } from './ejson.ts';
import { classifyMongoOpError } from './errors.ts';
import type { MongoPool } from './MongoPool.ts';
import { STATS_TIMEOUT_MS } from './timeouts.ts';
import { redactSecrets, type Logger } from '../log.ts';

const OPS_LIMIT = 200;
const COMMAND_MAX_CHARS = 2000;
const TRUNCATED_MARK = '… (truncated)';

interface RawOp {
  opid?: unknown;
  op?: string;
  ns?: string;
  secs_running?: number;
  client?: string;
  client_s?: string;
  desc?: string;
  planSummary?: string;
  command?: unknown;
}

/**
 * The Monitor tab (C06 §9): running operations, killOp and the database
 * profiler. Kill and set-level go through `pool.write`, so a read-only
 * connection refuses them (ADR 0005). None of this changes a document, so none
 * of it is audited (ADR 0002).
 *
 * `currentOp` and `killOp` run over a control client of their own, like
 * `AggregationService.killWrite`: on the pooled client they would queue behind
 * any op holding the pool's last connection, which is exactly the op a user
 * opens this tab to see and stop. Profiler reads and writes stay pooled.
 */
export class MonitorService {
  private pool: MongoPool;
  private log: Logger | undefined;

  constructor(pool: MongoPool, log?: Logger) {
    this.pool = pool;
    this.log = log;
  }

  async currentOp(input: CurrentOpInput): Promise<{ ops: CurrentOpSummary[] }> {
    const match: Record<string, unknown> = {};
    if (input.activeOnly) match.active = true;
    if (input.minSecsRunning !== undefined && input.minSecsRunning > 0) {
      match.secs_running = { $gte: input.minSecsRunning };
    }
    const rows = await this.withControlClient(input.connectionId, (client) =>
      client
        .db('admin')
        .aggregate(
          [
            // Idle sessions carry no opid and cannot be killed.
            { $currentOp: { allUsers: true, idleConnections: false, idleSessions: false } },
            { $match: match },
            { $sort: { secs_running: -1 } },
            { $limit: OPS_LIMIT },
          ],
          { maxTimeMS: STATS_TIMEOUT_MS },
        )
        .toArray(),
    );
    return { ops: (rows as RawOp[]).map(toOpSummary) };
  }

  async killOp(input: { connectionId: string; opid: string }): Promise<{ ok: true }> {
    // Refuses a read-only connection; the kill itself goes over the control client.
    this.pool.write(input.connectionId);
    await this.withControlClient(input.connectionId, (client) =>
      client
        .db('admin')
        .command({ killOp: 1, op: opidForKill(input.opid), maxTimeMS: STATS_TIMEOUT_MS }),
    );
    return { ok: true };
  }

  /** One control client per call, closed whatever happens. */
  private async withControlClient<T>(
    connectionId: string,
    fn: (client: MongoClient) => Promise<T>,
  ): Promise<T> {
    let control: MongoClient | undefined;
    try {
      control = await this.pool.openControlClient(connectionId);
      return await fn(control);
    } catch (err) {
      throw classifyMongoOpError(err);
    } finally {
      await control?.close().catch((err: unknown) => {
        this.log?.warn('mongo', 'closing the control client failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  async profileStatus(input: { connectionId: string; dbName: string }): Promise<ProfileStatus> {
    const client = await this.pool.readClient(input.connectionId);
    try {
      // `profile: -1` reads without changing; the current level comes back as `was`.
      const res = (await client
        .db(input.dbName)
        .command({ profile: -1, maxTimeMS: STATS_TIMEOUT_MS })) as { was: ProfileLevel; slowms: number };
      return { level: res.was, slowms: res.slowms };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  async setProfileLevel(input: {
    connectionId: string;
    dbName: string;
    level: ProfileLevel;
    slowms?: number;
  }): Promise<{ ok: true }> {
    const w = this.pool.write(input.connectionId);
    const cmd: Record<string, unknown> = { profile: input.level, maxTimeMS: STATS_TIMEOUT_MS };
    if (input.slowms !== undefined) cmd.slowms = input.slowms;
    const client = await w.client();
    try {
      await client.db(input.dbName).command(cmd);
      return { ok: true };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  async profileTail(input: {
    connectionId: string;
    dbName: string;
    limit?: number;
  }): Promise<{ docs: unknown[] }> {
    const client = await this.pool.readClient(input.connectionId);
    // The handler's schema caps `limit` at 100.
    const limit = input.limit ?? 50;
    try {
      const docs = await client
        .db(input.dbName)
        .collection('system.profile')
        .find({}, { sort: { ts: -1 }, limit, maxTimeMS: STATS_TIMEOUT_MS })
        .toArray();
      return { docs: ejsonEncodeArray(docs) };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }
}

/** Exported for its unit tests: opid-less rows, redaction and truncation. */
export function toOpSummary(raw: RawOp): CurrentOpSummary {
  const out: CurrentOpSummary = {
    op: raw.op ?? 'none',
    command: commandText(raw.command),
  };
  if (raw.opid !== undefined && raw.opid !== null) out.opid = String(raw.opid);
  if (raw.ns) out.ns = raw.ns;
  if (raw.secs_running !== undefined) out.secsRunning = raw.secs_running;
  const client = raw.client ?? raw.client_s;
  if (client) out.client = client;
  if (raw.desc) out.desc = raw.desc;
  if (raw.planSummary) out.planSummary = raw.planSummary;
  return out;
}

/**
 * The op's command as canonical EJSON with secret-named fields masked (a
 * `createUser` in flight carries its `pwd`), cut on a code-point boundary and
 * marked when cut. Redacted after encoding, on plain JSON: `redactSecrets`
 * rebuilds every object it walks, which would flatten a live BSON value.
 */
function commandText(command: unknown): string {
  const canonical = JSON.parse(ejsonStringifyDriverValue(command ?? {})) as unknown;
  const text = JSON.stringify(redactSecrets(canonical));
  const points = Array.from(text);
  return points.length > COMMAND_MAX_CHARS
    ? `${points.slice(0, COMMAND_MAX_CHARS).join('')}${TRUNCATED_MARK}`
    : text;
}

/**
 * The opid as the server gave it: a number on mongod, a `"shard:id"` string on
 * mongos. `String()` of the former round-trips through this.
 */
export function opidForKill(opid: string): number | string {
  return /^-?\d+$/.test(opid) ? Number.parseInt(opid, 10) : opid;
}
