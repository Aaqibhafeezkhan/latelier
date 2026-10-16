import type { Db, Document } from 'mongodb';
import type { CollectionDetails, CollectionInfo, DbInfo } from '@shared/ipc';
import type { ValidationAction, ValidationLevel } from '@shared/types';
import { NotFoundError } from '../errors.ts';
import { ejsonEncodeArray, ejsonStringify } from './ejson.ts';
import { classifyMongoOpError, isMaxTimeMSExpired } from './errors.ts';
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

  constructor(pool: MongoPool) {
    this.pool = pool;
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
        documentCount: 0,
        sizeBytes: 0,
        indexCount: 0,
        capped: Boolean((s.options as { capped?: boolean } | undefined)?.capped),
      };
      const stats = await readStorageStats(db, s.name);
      info.documentCount = stats.documentCount;
      info.sizeBytes = stats.sizeBytes;
      info.indexCount = stats.indexCount;
      if (stats.lastModified) info.lastModified = stats.lastModified;
      return info;
    });
  }

  async collectionDetails(input: CollectionDetailsInput): Promise<CollectionDetails> {
    const client = await this.pool.readClient(input.connectionId);
    const db = client.db(input.dbName);
    let specs: CollectionSpec[];
    try {
      specs = await db
        .listCollections<CollectionSpec>({ name: input.collection }, { nameOnly: false, maxTimeMS: STATS_TIMEOUT_MS })
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
      },
    };
    // A view has no storage of its own to measure.
    if (type !== 'view') {
      const { lastModified: _unused, ...stats } = await readStorageStats(db, spec.name);
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
  };
}

function collectionType(t: string | undefined): CollectionInfo['type'] {
  return t === 'view' ? 'view' : t === 'timeseries' ? 'timeseries' : 'collection';
}

interface StorageStats {
  documentCount: number;
  sizeBytes: number;
  indexCount: number;
  lastModified?: string;
  /** The three below come from `$collStats` only; absent on the estimate fallback. */
  storageSizeBytes?: number;
  avgObjSizeBytes?: number;
  totalIndexSizeBytes?: number;
}

/**
 * One collection's storage figures. Bounded by the stats budget: with
 * `LIST_COLLECTIONS_CONCURRENCY` parallel runners, the worst case is N
 * collections / concurrency x budget, but no single Mongo round-trip can hang
 * the IPC reply for longer than this.
 */
async function readStorageStats(db: Db, name: string): Promise<StorageStats> {
  type Storage = {
    count?: number;
    size?: number;
    nindexes?: number;
    storageSize?: number;
    avgObjSize?: number;
    totalIndexSize?: number;
    wiredTiger?: { creationTime?: string };
  };
  const out: StorageStats = { documentCount: 0, sizeBytes: 0, indexCount: 0 };
  try {
    const stats = await db
      .collection(name)
      .aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: STATS_TIMEOUT_MS })
      .next();
    const storage = (stats as { storageStats?: Storage } | null)?.storageStats;
    if (storage) {
      out.documentCount = storage.count ?? 0;
      out.sizeBytes = storage.size ?? 0;
      out.indexCount = storage.nindexes ?? 0;
      if (storage.storageSize !== undefined) out.storageSizeBytes = storage.storageSize;
      if (storage.avgObjSize !== undefined) out.avgObjSizeBytes = storage.avgObjSize;
      if (storage.totalIndexSize !== undefined) out.totalIndexSizeBytes = storage.totalIndexSize;
      if (storage.wiredTiger?.creationTime) out.lastModified = storage.wiredTiger.creationTime;
    }
  } catch {
    // Atlas free tier / restricted user: fall back to cheap estimates.
    // Both fallback calls share the same timeout budget so a single
    // hung collection can't hold up the whole list.
    const [countResult, indexesResult] = await Promise.allSettled([
      db.collection(name).estimatedDocumentCount({ maxTimeMS: STATS_TIMEOUT_MS }),
      db.collection(name).indexes({ maxTimeMS: STATS_TIMEOUT_MS }),
    ]);
    out.documentCount = countResult.status === 'fulfilled' ? countResult.value : 0;
    out.indexCount = indexesResult.status === 'fulfilled' ? indexesResult.value.length : 0;
  }
  return out;
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
