import type { Db, Document } from 'mongodb';
import type { CollectionDetails, CollectionInfo, DbInfo } from '@shared/ipc';
import type { ValidationAction, ValidationLevel } from '@shared/types';
import { NotFoundError } from '../errors.ts';
import { ejsonEncodeArray, ejsonStringify } from './ejson.ts';
import { classifyMongoOpError, isMaxTimeMSExpired } from './errors.ts';
import type { Logger } from '../log.ts';
import type { MongoPool } from './MongoPool.ts';
import { QUERY_TIMEOUT_MS, STATS_TIMEOUT_MS } from './timeouts.ts';

const SYSTEM_DBS = new Set(['admin', 'local', 'config']);

/** Raw `listDatabases` reply. `nameOnly: true` returns names and nothing else. */
interface ListDatabasesReply {
  databases?: Array<{ name: string; sizeOnDisk?: number; empty?: boolean }>;
}

const SAMPLE_DEFAULT = 50;
// Cap the parallel fan-out from `listCollections`. A connection on a
// 50-collection database used to fire 50 simultaneous `$collStats`
// aggregates; on a slow Atlas link that piled up against the driver pool
// and held the IPC handler open until every one resolved.
const LIST_COLLECTIONS_CONCURRENCY = 10;

export interface ListDatabasesInput {
  connectionId: string;
  includeSystem?: boolean;
}

export interface ListCollectionsInput {
  connectionId: string;
  dbName: string;
}

export interface CollectionDetailsInput {
  connectionId: string;
  dbName: string;
  collection: string;
}

export interface SampleSchemaInput {
  connectionId: string;
  dbName: string;
  collection: string;
  size?: number;
}

export class MetaService {
  private pool: MongoPool;
  private log: Logger | undefined;

  constructor(pool: MongoPool, log?: Logger) {
    this.pool = pool;
    this.log = log;
  }

  async listDatabases(input: ListDatabasesInput): Promise<DbInfo[]> {
    const client = await this.pool.readClient(input.connectionId);
    // authorizedDatabases=true returns the databases the user has privileges
    // on even when they lack the `listDatabases` admin privilege (Atlas free
    // tier, scoped read-only roles, etc.). Without it, restricted users get
    // an empty list or a permission error.
    let res: ListDatabasesReply;
    // Cleared by the degraded path below, which asks for names only and so
    // gets no sizes back at all.
    let sizesMeasured = true;
    try {
      // The interactive budget, not the stats one: `nameOnly: false` makes the
      // server total storage per database, so the cost scales with how many
      // there are rather than being the fixed-cost catalog read the stats
      // bound assumes. The navigator blocks on this, and a bound that fires
      // leaves it with nothing at all.
      res = (await client.db('admin').command({
        listDatabases: 1,
        nameOnly: false,
        authorizedDatabases: true,
        maxTimeMS: QUERY_TIMEOUT_MS,
      })) as ListDatabasesReply;
    } catch (err) {
      if (!isMaxTimeMSExpired(err)) {
        // Classify auth/network failures so the envelope carries a stable
        // code (UNAUTHORIZED/NETWORK) instead of leaking a raw driver error
        // as INTERNAL.
        throw classifyMongoOpError(err);
      }
      // Degraded path: retry with `nameOnly: true`, the fixed-cost catalog
      // read, instead of the per-database stats total that just blew the
      // budget. The navigator renders names, so this still gets it what it
      // needs rather than nothing at all. The retry keeps the full budget
      // rather than a tighter one — it is the last chance, and failing it
      // returns the empty navigator this whole path exists to avoid.
      sizesMeasured = false;
      try {
        res = (await client.db('admin').command({
          listDatabases: 1,
          nameOnly: true,
          authorizedDatabases: true,
          maxTimeMS: QUERY_TIMEOUT_MS,
        })) as ListDatabasesReply;
      } catch (retryErr) {
        throw classifyMongoOpError(retryErr);
      }
    }
    const dbs = res.databases ?? [];
    return dbs
      .filter((d) => input.includeSystem || !SYSTEM_DBS.has(d.name))
      .map((d) => ({
        name: d.name,
        // Omitted, not defaulted to 0, when the degraded path produced this
        // list. `DetailPanel` prints this figure beside every database name,
        // so a stand-in 0 would read as a measured "0 B" rather than as the
        // absence of a measurement — `undefined` is what lets it say so.
        ...(sizesMeasured ? { sizeOnDisk: d.sizeOnDisk ?? 0 } : {}),
        empty: Boolean(d.empty),
      }));
  }

  async listCollections(input: ListCollectionsInput): Promise<CollectionInfo[]> {
    const client = await this.pool.readClient(input.connectionId);
    const db = client.db(input.dbName);
    const listCursor = db.listCollections({}, { nameOnly: false });
    let specs: Awaited<ReturnType<typeof listCursor.toArray>>;
    try {
      specs = await listCursor.toArray();
    } catch (err) {
      throw classifyMongoOpError(err);
    }
    return mapWithConcurrency(specs, LIST_COLLECTIONS_CONCURRENCY, async (s): Promise<CollectionInfo> => {
      const info: CollectionInfo = {
        name: s.name,
        type: collectionType(s.type),
        capped: Boolean((s.options as { capped?: boolean } | undefined)?.capped),
      };
      // A view has no storage of its own, and `$collStats` fails on one.
      if (info.type === 'view') return info;
      try {
        const stats = await readStorageStats(db, s.name, this.log);
        if (stats.documentCount !== undefined) info.documentCount = stats.documentCount;
        if (stats.sizeBytes !== undefined) info.sizeBytes = stats.sizeBytes;
        if (stats.indexCount !== undefined) info.indexCount = stats.indexCount;
        if (stats.lastModified) info.lastModified = stats.lastModified;
      } catch (err) {
        // One collection's stats must not sink the whole list the navigator
        // blocks on. Its figures stay absent, which the UI shows as a dash:
        // a failed read is not a measured zero.
        this.log?.warn('meta', 'collection stats read failed', {
          dbName: input.dbName,
          collection: s.name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return info;
    });
  }

  async collectionDetails(input: CollectionDetailsInput): Promise<CollectionDetails> {
    const client = await this.pool.readClient(input.connectionId);
    const db = client.db(input.dbName);
    let specs: CollectionSpec[];
    try {
      // No promotion: the pipeline and validator go back to the server through
      // Modify view and Edit rules, and a promoted whole-number Double would
      // serialize as an Int32 or a Long (with rounded digits past 2^53).
      specs = await db
        .listCollections<CollectionSpec>(
          { name: input.collection },
          { nameOnly: false, maxTimeMS: STATS_TIMEOUT_MS, promoteValues: false },
        )
        .toArray();
    } catch (err) {
      throw classifyMongoOpError(err);
    }
    const spec = specs[0];
    if (!spec) {
      throw new NotFoundError(`Collection ${input.dbName}.${input.collection} does not exist`);
    }
    const type = collectionType(spec.type);
    const opts = spec.options ?? {};
    const details: CollectionDetails = {
      name: spec.name,
      type,
      capped: Boolean(opts.capped),
      options: {
        ...(opts.viewOn !== undefined ? { viewOn: opts.viewOn } : {}),
        ...(opts.pipeline !== undefined ? { pipeline: ejsonStringify(opts.pipeline) } : {}),
        ...(opts.validator !== undefined ? { validator: ejsonStringify(opts.validator) } : {}),
        ...(opts.validationLevel !== undefined ? { validationLevel: opts.validationLevel } : {}),
        ...(opts.validationAction !== undefined ? { validationAction: opts.validationAction } : {}),
        ...(opts.collation !== undefined ? { collation: ejsonStringify(opts.collation) } : {}),
      },
    };
    // A view has no storage of its own to measure.
    if (type !== 'view') {
      const stats = await readStorageStats(db, spec.name, this.log);
      delete stats.lastModified;
      details.stats = stats;
    }
    return details;
  }

  async sampleSchema(input: SampleSchemaInput): Promise<{ docs: unknown[] }> {
    const client = await this.pool.readClient(input.connectionId);
    const coll = client.db(input.dbName).collection(input.collection);
    const n = input.size ?? SAMPLE_DEFAULT;
    // $facet runs both branches in one round trip. $sample is the first
    // stage of its branch so Mongo can use its random cursor when the
    // sample size is small relative to the collection.
    try {
      const cursor = coll.aggregate(
        [
          {
            $facet: {
              recent: [{ $sort: { _id: -1 } }, { $limit: n }],
              random: [{ $sample: { size: n } }],
            },
          },
        ],
        { allowDiskUse: false, maxTimeMS: STATS_TIMEOUT_MS },
      );
      const arr = await cursor.toArray();
      const row = (arr[0] ?? {}) as { recent?: unknown[]; random?: unknown[] };
      const merged = [...(row.recent ?? []), ...(row.random ?? [])];
      return { docs: ejsonEncodeArray(merged, false) };
    } catch {
      // Permission / timeout / hostile collection: fail open so the
      // renderer treats this source as absent rather than surfacing an
      // error. Other sources still contribute suggestions.
      return { docs: [] };
    }
  }
}

/** The slice of a `listCollections` entry that `collectionDetails` reads. */
interface CollectionSpec {
  name: string;
  type?: string;
  options?: {
    capped?: boolean;
    viewOn?: string;
    pipeline?: unknown[];
    validator?: Document;
    validationLevel?: ValidationLevel;
    validationAction?: ValidationAction;
    collation?: Document;
  };
}

function collectionType(t: string | undefined): CollectionInfo['type'] {
  return t === 'view' ? 'view' : t === 'timeseries' ? 'timeseries' : 'collection';
}

interface StorageStats {
  /** Each figure is absent when the server did not report it, never a stand-in 0. */
  documentCount?: number;
  sizeBytes?: number;
  indexCount?: number;
  lastModified?: string;
  /** The three below come from `$collStats` only; absent on the estimate fallback. */
  storageSizeBytes?: number;
  avgObjSizeBytes?: number;
  totalIndexSizeBytes?: number;
}

type CollStatsStorage = {
  count?: number;
  size?: number;
  nindexes?: number;
  storageSize?: number;
  totalIndexSize?: number;
  wiredTiger?: { creationTime?: string };
};

const addFigure = (total: number | undefined, v: number | undefined): number | undefined =>
  v === undefined ? total : (total ?? 0) + v;

/**
 * Folds the `$collStats` reply into one set of figures. A sharded cluster
 * answers with one document per shard: counts and sizes are summed across them,
 * while the index count is the same on every shard, so the largest is taken.
 * The average object size is recomputed from the totals (per-shard averages
 * cannot be added), and a time-series collection reports no `count`, which
 * stays absent here.
 */
export function foldStorageStats(replies: unknown[]): StorageStats {
  const out: StorageStats = {};
  for (const reply of replies) {
    const st = (reply as { storageStats?: CollStatsStorage } | null)?.storageStats;
    if (!st) continue;
    out.documentCount = addFigure(out.documentCount, st.count);
    out.sizeBytes = addFigure(out.sizeBytes, st.size);
    out.storageSizeBytes = addFigure(out.storageSizeBytes, st.storageSize);
    out.totalIndexSizeBytes = addFigure(out.totalIndexSizeBytes, st.totalIndexSize);
    if (st.nindexes !== undefined) out.indexCount = Math.max(out.indexCount ?? 0, st.nindexes);
    if (out.lastModified === undefined && st.wiredTiger?.creationTime) {
      out.lastModified = st.wiredTiger.creationTime;
    }
  }
  if (out.documentCount && out.sizeBytes !== undefined) {
    out.avgObjSizeBytes = out.sizeBytes / out.documentCount;
  }
  // Keys the loop never set stay off the object: `undefined` is not "absent" to toEqual/JSON.
  for (const k of Object.keys(out) as Array<keyof StorageStats>) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

/**
 * `$collStats` refused for lack of privilege, or by a deployment tier that
 * does not offer it (Atlas shared tiers answer `AtlasError` 8000 or
 * `CommandNotSupported`). These, and only these, fall back to estimates; a
 * timeout or a dropped connection is a real failure and surfaces as one.
 */
function isStatsRefused(err: unknown): boolean {
  const e = err as { code?: number; codeName?: string } | null;
  return (
    e?.code === 13 || e?.codeName === 'Unauthorized' ||
    e?.code === 115 || e?.codeName === 'CommandNotSupported' ||
    e?.code === 8000 || e?.codeName === 'AtlasError'
  );
}

/**
 * One collection's storage figures. Bounded by the stats budget: with
 * `LIST_COLLECTIONS_CONCURRENCY` parallel runners, the worst case is N
 * collections / concurrency x budget, but no single Mongo round-trip can hang
 * the IPC reply for longer than this.
 *
 * Throws (classified) when `$collStats` fails for any reason other than being
 * refused, and when it was refused and neither estimate could be read either.
 */
async function readStorageStats(db: Db, name: string, log: Logger | undefined): Promise<StorageStats> {
  const coll = db.collection(name);
  let replies: unknown[];
  try {
    replies = await coll
      .aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: STATS_TIMEOUT_MS })
      .toArray();
  } catch (err) {
    if (!isStatsRefused(err)) throw classifyMongoOpError(err);
    log?.warn('meta', '$collStats refused; using estimates', {
      dbName: db.databaseName,
      collection: name,
      message: err instanceof Error ? err.message : String(err),
    });
    return estimateStats(db, name, log);
  }
  const out = foldStorageStats(replies);
  if (out.documentCount === undefined) {
    // A time-series collection's storageStats has no count.
    const [count] = await Promise.allSettled([coll.estimatedDocumentCount({ maxTimeMS: STATS_TIMEOUT_MS })]);
    if (count.status === 'fulfilled') out.documentCount = count.value;
    else logEstimateFailure(log, db, name, 'count', count.reason);
  }
  return out;
}

/** Cheap figures for a caller who may not run `$collStats`; both calls share one timeout budget. */
async function estimateStats(db: Db, name: string, log: Logger | undefined): Promise<StorageStats> {
  const [count, indexes] = await Promise.allSettled([
    db.collection(name).estimatedDocumentCount({ maxTimeMS: STATS_TIMEOUT_MS }),
    db.collection(name).indexes({ maxTimeMS: STATS_TIMEOUT_MS }),
  ]);
  if (count.status === 'rejected' && indexes.status === 'rejected') {
    throw classifyMongoOpError(count.reason);
  }
  const out: StorageStats = {};
  if (count.status === 'fulfilled') out.documentCount = count.value;
  else logEstimateFailure(log, db, name, 'count', count.reason);
  if (indexes.status === 'fulfilled') out.indexCount = indexes.value.length;
  else logEstimateFailure(log, db, name, 'indexes', indexes.reason);
  return out;
}

function logEstimateFailure(log: Logger | undefined, db: Db, name: string, what: string, reason: unknown): void {
  log?.warn('meta', `estimated ${what} unavailable`, {
    dbName: db.databaseName,
    collection: name,
    message: reason instanceof Error ? reason.message : String(reason),
  });
}

/**
 * Map an array with bounded concurrency. Results retain input order.
 * Inlined here (no util grab-bag) because this is the only caller; can
 * be lifted into a shared helper if a second consumer appears.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i]!, i);
      }
    },
  );
  await Promise.all(runners);
  return results;
}
