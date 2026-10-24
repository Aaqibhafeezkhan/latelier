import { randomUUID } from 'node:crypto';
import type { FindInput, RecentKind, RecentQuery, SavedFindPayload, SavedAggregationPayload } from '@shared/types';
import type { RecentQueryRepo, RecentQueryFilter, RecentDeleteFilter } from '../db/repositories/RecentQueryRepo.ts';
import { NotFoundError } from '../errors.ts';
import type { Logger } from '../log.ts';

const MAX_PER_CONNECTION = 200;

export interface RecordAggregationInput {
  connectionId: string;
  dbName: string;
  collection: string;
  stages: Array<{ id: number; op: string; body: string; enabled: boolean }>;
}

/**
 * Callers record a run without awaiting it, so a failed write never fails the
 * query. It is logged here instead of dropped, which would hide a broken
 * history (or a run recorded against a connection that no longer exists).
 */
export function logRecentWriteFailure(log: Logger | undefined, err: unknown): void {
  log?.warn('recent', 'recording a recent query failed', {
    message: err instanceof Error ? err.message : String(err),
  });
}

export class RecentQueryService {
  private repo: RecentQueryRepo;
  /**
   * In-flight eviction Promises, keyed by `connectionId`. Used to coalesce
   * (one scheduled eviction handles every insert that lands while it is
   * pending) and to let tests `await drainEvictions()` for deterministic
   * assertions.
   */
  private pendingEvictions = new Map<string, Promise<void>>();
  private log: Logger | undefined;
  constructor(repo: RecentQueryRepo, log?: Logger) {
    this.repo = repo;
    this.log = log;
  }

  /**
   * Codex review on the W15 base → `main` PR — this used to record only the
   * filter and write a hardcoded empty builder, while `BuilderPane`'s Recent
   * hydration reads `projectionRaw` from it. So rerunning a query that had
   * excluded a field with `{"secret":0}` ran with **no projection at all** and
   * put the excluded field back on screen, silently. The run in the history
   * list was not the run you got.
   *
   * `projection` and `sort` are the compiled strings that actually executed, so
   * storing the projection as `projectionRaw` reproduces the exact query — raw
   * wins in `compileFindOptions`, and main cannot recover the modelled field
   * list from a compiled document anyway.
   *
   * `limit` is deliberately NOT recorded. `FindInput.limit` is the *effective*
   * page limit from `effectivePageLimit`, not the user's cap, so storing it
   * would make a rerun silently inherit the page size of whichever page the
   * original run happened to be on.
   *
   * The find options (W14 §9) are recorded for the same reason as the
   * projection: a collation changes which documents match, so a rerun that
   * dropped it would silently not be the run in the list. `maxTimeMS` is the
   * user's own value, so it is kept too.
   */
  async recordFind(
    input: Pick<
      FindInput,
      | 'connectionId'
      | 'dbName'
      | 'collection'
      | 'filter'
      | 'projection'
      | 'sort'
      | 'collation'
      | 'hint'
      | 'maxTimeMS'
      | 'readPreference'
    >,
    durationMs: number,
    resultCount: number,
    errorCode?: string,
  ): Promise<void> {
    // Trimmed as QueryService.matchOptions sends them, so the rerun is the run.
    const collation = input.collation?.trim();
    const hint = input.hint?.trim();
    const payload: SavedFindPayload = {
      kind: 'find',
      builder: {
        projection: [],
        ...(input.projection ? { projectionRaw: input.projection } : {}),
        sort: input.sort ?? '',
        limit: '',
        ...(collation ? { collation } : {}),
        ...(hint ? { hint } : {}),
        ...(input.maxTimeMS !== undefined ? { maxTimeMS: String(input.maxTimeMS) } : {}),
        ...(input.readPreference ? { readPreference: input.readPreference } : {}),
      },
      queryRaw: input.filter,
    };

    this.repo.insert({
      id: randomUUID(),
      connection_id: input.connectionId,
      db_name: input.dbName,
      collection: input.collection,
      kind: 'find',
      payload_json: JSON.stringify(payload),
      ran_at: new Date().toISOString(),
      duration_ms: durationMs,
      result_count: resultCount,
      error_code: errorCode ?? null,
    });

    this.evictIfNeeded(input.connectionId);
  }

  async recordAggregation(
    input: RecordAggregationInput,
    durationMs: number,
    resultCount: number,
    errorCode?: string,
  ): Promise<void> {
    const payload: SavedAggregationPayload = {
      kind: 'aggregation',
      stages: input.stages,
    };

    this.repo.insert({
      id: randomUUID(),
      connection_id: input.connectionId,
      db_name: input.dbName,
      collection: input.collection,
      kind: 'aggregation',
      payload_json: JSON.stringify(payload),
      ran_at: new Date().toISOString(),
      duration_ms: durationMs,
      result_count: resultCount,
      error_code: errorCode ?? null,
    });

    this.evictIfNeeded(input.connectionId);
  }

  list(filter: RecentQueryFilter = {}): RecentQuery[] {
    return this.repo.list(filter).map(rowToRecentQuery);
  }

  get(id: string): RecentQuery {
    const row = this.repo.findById(id);
    if (!row) throw new NotFoundError(`recent query ${id} not found`);
    return rowToRecentQuery(row);
  }

  clear(filter: RecentDeleteFilter): { deleted: number } {
    const deleted = this.repo.deleteByFilter(filter);
    return { deleted };
  }

  /**
   * Cap the recent-query history per connection. Runs after the IPC reply
   * has returned: even though both statements are cheap on a 200-row
   * partition, every successful find/aggregate funnels through this path
   * and the correlated-subquery DELETE adds latency to the result hand-off
   * for no user-visible benefit.
   *
   * Coalesced — concurrent inserts for the same connection share one
   * pending eviction. When the eviction runs it reads the current count,
   * which already reflects every insert that landed before its tick.
   */
  private evictIfNeeded(connectionId: string): void {
    if (this.pendingEvictions.has(connectionId)) return;
    const promise = new Promise<void>((resolve) => {
      setImmediate(() => {
        try {
          const count = this.repo.countByConnection(connectionId);
          if (count > MAX_PER_CONNECTION) {
            this.repo.deleteOldestByConnection(connectionId, MAX_PER_CONNECTION);
          }
        } catch (err) {
          // Best-effort housekeeping: the original recordFind/recordAggregation
          // succeeded, so the error is not surfaced to the caller. It is logged
          // because a failing eviction lets the per-connection cap lapse
          // unnoticed; the next insert's deferred eviction retries.
          this.log?.warn('recent', 'evicting old recent queries failed', {
            connectionId,
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          this.pendingEvictions.delete(connectionId);
          resolve();
        }
      });
    });
    this.pendingEvictions.set(connectionId, promise);
  }

  /**
   * Wait for any in-flight eviction work to settle. Production callers
   * should never need this — eviction is best-effort and bounded — but
   * integration tests use it to make assertions deterministic.
   */
  async drainEvictions(): Promise<void> {
    await Promise.all(this.pendingEvictions.values());
  }
}

function rowToRecentQuery(row: {
  id: string;
  connection_id: string;
  db_name: string;
  collection: string;
  kind: RecentKind;
  payload_json: string;
  ran_at: string;
  duration_ms: number;
  result_count: number | null;
  error_code: string | null;
}): RecentQuery {
  return {
    id: row.id,
    connectionId: row.connection_id,
    dbName: row.db_name,
    collection: row.collection,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as RecentQuery['payload'],
    ranAt: row.ran_at,
    durationMs: row.duration_ms,
    resultCount: row.result_count ?? undefined,
    errorCode: row.error_code ?? undefined,
  };
}
