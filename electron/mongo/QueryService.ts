import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Sort } from 'mongodb';
import type { FindInput, FindResultWire, ExplainInput, QueryExportInput, QueryExportResult } from '@shared/types';
import {
  ByteCapExceededError,
  DEFAULT_MAX_EJSON_BYTES,
  ejsonEncode,
  ejsonEncodeArrayJson,
  ejsonStringifyRelaxed,
  parseEjsonDocument,
} from './ejson.ts';
import { classifyMongoOpError } from './errors.ts';
import { SystemError, ValidationError, type AppError } from '../errors.ts';
import type { MongoPool } from './MongoPool.ts';
import type { Logger } from '../log.ts';
import { logRecentWriteFailure, type RecentQueryService } from '../services/RecentQueryService.ts';
import { ADMIN_LONG_TIMEOUT_MS, PROBE_TIMEOUT_MS, QUERY_TIMEOUT_MS } from './timeouts.ts';
// The main process has no `src/` precedent, but `exportFormat.ts` is a pure
// module (no React/Mantine — verified: it imports only `bson`, `utils/ejson`
// and `views/tableColumns`'s types/`getValueAtPath`), and duplicating its CSV
// cell/escape/formula rules here would let the page export and this one
// silently drift. Confirmed buildable under both `tsc -b` and the real
// `vite build` main bundle before relying on it.
import {
  csvHeaderLine,
  csvRowLine,
  revive,
  type ExportColumn,
} from '../../src/pages/Workspace/exportFormat.ts';

// Hard cap on `query:export` — one matching-all export can't stream an
// unbounded collection to disk. A constructor default (not a bare module
// constant) so a test can pass a small cap instead of seeding 100k documents.
export const DEFAULT_EXPORT_CAP = 100_000;

/**
 * One JSON-array element's text, indented to match a whole-array
 * `JSON.stringify(docs, null, 2)`: every element's own lines gain one
 * `'  '` (2-space) prefix. `text` is the element already pretty-printed with
 * 2 spaces. Verified byte-identical to `exportFormat.ts`'s
 * `serializeJsonArray` for the same documents — see
 * `tests/integration/query-export.spec.ts` — save one case: a Long past 2^53
 * inside a Code's scope, which this side keeps wrapped and the page rounds.
 */
function jsonArrayElementText(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/** The ceilings `find` enforces; a constructor input so a test can lower them. */
export interface QueryLimits {
  maxFindBytes?: number;
  queryTimeoutMs?: number;
}

const MIB = 1024 * 1024;

function describeBytes(bytes: number): string {
  return bytes >= MIB ? `${bytes / MIB} MB` : `${bytes} bytes`;
}

export class QueryService {
  private pool: MongoPool;
  private recent: RecentQueryService;
  private active = new Map<string, AbortController>();
  private exportCap: number;
  private log: Logger | undefined;
  private maxFindBytes: number;
  private queryTimeoutMs: number;

  constructor(
    pool: MongoPool,
    recent: RecentQueryService,
    exportCap = DEFAULT_EXPORT_CAP,
    log?: Logger,
    limits: QueryLimits = {},
  ) {
    this.maxFindBytes = limits.maxFindBytes ?? DEFAULT_MAX_EJSON_BYTES;
    this.queryTimeoutMs = limits.queryTimeoutMs ?? QUERY_TIMEOUT_MS;
    this.pool = pool;
    this.recent = recent;
    this.exportCap = exportCap;
    this.log = log;
  }

  // every EJSON string off the wire is parsed with `parseEjsonDocument`,
  // never `parseEjsonField`: the renderer's own gates (`sortProblem`,
  // `isRawProjection`) are a convenience, not the trust boundary, and a `sort`
  // or `projection` that parses to `null` or an array is silently *ignored* by
  // the driver — the query runs unsorted and full-width with no error.
  // `sort` must be a document here even though the driver's `Sort` type also
  // admits strings and tuple arrays: the renderer only ever produces a
  // document and `parseSortString` only models documents, so accepting more
  // would reopen the same gap on a different shape.

  async find(input: FindInput): Promise<FindResultWire> {
    const filter = parseEjsonDocument<Record<string, unknown>>(input.filter, 'filter');
    const sort = input.sort ? parseEjsonDocument<Sort>(input.sort, 'sort') : undefined;
    const projection = input.projection
      ? parseEjsonDocument<Record<string, unknown>>(input.projection, 'projection')
      : undefined;
    const limit = Math.min(input.limit, 1000);

    const ctrl = new AbortController();
    if (input.cancelToken) this.active.set(input.cancelToken, ctrl);

    const db = await this.pool.readDb(input.connectionId, input.dbName);
    const coll = db.collection(input.collection);
    const t0 = Date.now();

    try {
      const docs = await coll
        .find(filter, {
          sort,
          projection,
          limit,
          skip: input.skip,
          signal: ctrl.signal,
          maxTimeMS: this.queryTimeoutMs,
        })
        .toArray();
      const durationMs = Date.now() - t0;
      const documentsJson = ejsonEncodeArrayJson(docs, {
        relaxed: input.ejsonRelaxed ?? false,
        maxBytes: this.maxFindBytes,
      });
      // Fire-and-forget: writing recent-query history must not block the
      // result returning to the renderer, nor may its failure fail the query.
      // The failure is logged, not dropped.
      void this.recent
        .recordFind(input, durationMs, docs.length)
        .catch((e: unknown) => logRecentWriteFailure(this.log, e));
      return { documentsJson, durationMs, hasMore: docs.length === limit };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const classified = this.explainFindCap(classifyMongoOpError(err));
      void this.recent
        .recordFind(input, durationMs, 0, classified.code)
        .catch((e: unknown) => logRecentWriteFailure(this.log, e));
      throw classified;
    } finally {
      if (input.cancelToken) this.active.delete(input.cancelToken);
    }
  }

  /**
   * The two ceilings a find can hit say what they are and what to change,
   * not a byte count under `INTERNAL` or the driver's "MaxTimeMS" wording.
   * The raw message stays in `details` for the log and the diagnostic bundle.
   */
  private explainFindCap(err: AppError): AppError {
    if (err instanceof ByteCapExceededError) {
      return new ValidationError(
        `The result is larger than ${describeBytes(this.maxFindBytes)}. Add a filter, a projection, or lower the rows per page.`,
        { mongoMessage: err.message },
      );
    }
    if (err.code === 'TIMEOUT') {
      return new SystemError(
        'TIMEOUT',
        `The query was stopped after ${this.queryTimeoutMs / 1000} s. Add an index or narrow the filter.`,
        { mongoMessage: err.message },
      );
    }
    return err;
  }

  async count(
    input: Omit<FindInput, 'limit' | 'skip' | 'projection' | 'sort' | 'cancelToken'>,
  ): Promise<{ count: number }> {
    const filter = parseEjsonDocument<Record<string, unknown>>(input.filter, 'filter');
    const db = await this.pool.readDb(input.connectionId, input.dbName);
    try {
      const count = await db
        .collection(input.collection)
        .countDocuments(filter, { maxTimeMS: PROBE_TIMEOUT_MS });
      return { count };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  async findOne(
    input: Pick<FindInput, 'connectionId' | 'dbName' | 'collection' | 'filter' | 'projection' | 'sort'>,
  ): Promise<{ document: unknown | null; durationMs: number }> {
    const filter = parseEjsonDocument<Record<string, unknown>>(input.filter, 'filter');
    const projection = input.projection
      ? parseEjsonDocument<Record<string, unknown>>(input.projection, 'projection')
      : undefined;
    const sort = input.sort ? parseEjsonDocument<Sort>(input.sort, 'sort') : undefined;
    const db = await this.pool.readDb(input.connectionId, input.dbName);
    const t0 = Date.now();
    try {
      const doc = await db
        .collection(input.collection)
        .findOne(filter, { projection, sort, maxTimeMS: QUERY_TIMEOUT_MS });
      return {
        document: doc ? ejsonEncode(doc, false) : null,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  async explain(input: ExplainInput): Promise<{ plan: unknown; verbosity: string }> {
    const filter = parseEjsonDocument<Record<string, unknown>>(input.filter, 'filter');
    // Sort/projection materially change the plan (index pick, in-memory
    // sort) — must be passed through so explain reflects the user's
    // actual query, not a stripped-down filter-only version.
    const sort = input.sort ? parseEjsonDocument<Sort>(input.sort, 'sort') : undefined;
    const projection = input.projection
      ? parseEjsonDocument<Record<string, unknown>>(input.projection, 'projection')
      : undefined;
    const db = await this.pool.readDb(input.connectionId, input.dbName);
    const cursor = db
      .collection(input.collection)
      .find(filter, { sort, projection, maxTimeMS: QUERY_TIMEOUT_MS });
    try {
      const plan = await cursor.explain(input.verbosity);
      return { plan, verbosity: input.verbosity };
    } catch (err) {
      throw classifyMongoOpError(err);
    } finally {
      // explain() leaves the underlying cursor open server-side until the
      // driver session times out; close eagerly so an explain spike can't
      // leak cursors across long-running sessions.
      await cursor.close().catch(() => {});
    }
  }

  /**
   * Export every document matching `input`'s filter/sort/projection to
   * `filePath`, up to this service's `exportCap`. Streams the find cursor
   * straight to disk rather than materializing the whole result — the same
   * reason `find` itself refuses to return more than 1000 documents.
   *
   * Every document is first canonicalized with `ejsonEncode(doc, false)` —
   * the same wire shape `find`'s `documentsJson` sends the renderer — before
   * handing it to `exportFormat.ts`'s own CSV/Relaxed helpers, so this
   * output matches the page export byte-for-byte for the same documents,
   * except that a Long past 2^53 inside a Code's scope stays exact here.
   *
   * `input.limit` (the builder's own limit, already compiled by the
   * renderer) is honoured when set, capped at `exportCap`; a limited export
   * is never `truncated` since the cursor never asks for more than the
   * limit. Otherwise the cursor asks for `exportCap + 1` and `truncated`
   * means that extra document was actually there.
   */
  async exportToFile(input: QueryExportInput, filePath: string): Promise<QueryExportResult> {
    if (input.format === 'csv' && !input.columns) {
      throw new ValidationError('columns are required for a CSV export');
    }
    const columns = input.columns as ExportColumn[] | undefined;

    const filter = parseEjsonDocument<Record<string, unknown>>(input.filter, 'filter');
    const sort = input.sort ? parseEjsonDocument<Sort>(input.sort, 'sort') : undefined;
    const projection = input.projection
      ? parseEjsonDocument<Record<string, unknown>>(input.projection, 'projection')
      : undefined;

    const cap = this.exportCap;
    // A user limit at or under the cap is the actual reason the export
    // stops short — that is not truncation, it's what was asked for. A
    // limit over the cap (or no limit at all) means the cap itself is the
    // binding constraint, so the cursor asks for one extra document to
    // learn whether the cap is what actually stopped the export (as
    // opposed to simply running out of matches before reaching it).
    const boundByCap = input.limit === undefined || input.limit > cap;
    const cursorLimit = boundByCap ? cap + 1 : input.limit!;

    const db = await this.pool.readDb(input.connectionId, input.dbName);
    const coll = db.collection(input.collection);
    const cursor = coll.find(filter, {
      sort,
      projection,
      limit: cursorLimit,
      maxTimeMS: ADMIN_LONG_TIMEOUT_MS,
    });

    // Disk failures (`fs.open`/`write`) are not Mongo driver errors, so they
    // must not be relabelled `MONGO_ERROR` by `classifyMongoOpError` below.
    // Wrapping them as a `SystemError` here means they're already an
    // `AppError` by the time they reach that call, which passes an
    // `AppError` through unchanged (mirrors `app.ts`'s `saveFile`, the only
    // other place this app writes a user-chosen file path).
    const fsError = (action: string, err: unknown) =>
      new SystemError('INTERNAL', `failed to ${action} export file: ${(err as Error).message}`);

    let handle: FileHandle | undefined;
    // `'w'` truncates/creates on a successful `fs.open` — only from that
    // point on does a failure risk leaving a *partial* file behind. If
    // `fs.open` itself throws (e.g. a permission error), nothing was
    // touched at `filePath`, so the catch below must not unlink it — that
    // path might be a save-dialog target the user picked over an existing
    // file that has nothing to do with this export.
    let opened = false;
    let written = 0;
    let truncated = false;
    let jsonArrayStarted = false;
    const write = async (text: string): Promise<void> => {
      try {
        await handle!.write(text);
      } catch (err) {
        throw fsError('write', err);
      }
    };
    try {
      try {
        // Export file contents can include user data; open owner-only (0600).
        handle = await fs.open(filePath, 'w', 0o600);
      } catch (err) {
        throw fsError('open', err);
      }
      opened = true;
      if (input.format === 'csv') {
        await write(csvHeaderLine(columns!) + '\n');
      }
      for await (const doc of cursor) {
        if (boundByCap && written >= cap) {
          truncated = true;
          break;
        }
        const wire = ejsonEncode(doc, false);
        if (input.format === 'csv') {
          await write(csvRowLine(wire, columns!) + '\n');
        } else if (input.format === 'jsonl') {
          // A document always serializes, so `ejsonStringifyRelaxed` is never `undefined` here.
          const line = input.relaxed ? (ejsonStringifyRelaxed(revive(wire)) as string) : JSON.stringify(wire);
          await write(line + '\n');
        } else {
          const element = jsonArrayElementText(
            input.relaxed ? (ejsonStringifyRelaxed(revive(wire), 2) as string) : JSON.stringify(wire, null, 2),
          );
          await write((jsonArrayStarted ? ',\n' : '[\n') + element);
          jsonArrayStarted = true;
        }
        written++;
      }
      if (input.format === 'json') {
        await write(jsonArrayStarted ? '\n]' : '[]');
      }
      // Closed here rather than in `finally`: a close that fails can mean the
      // last writes never reached disk, which is a failed export, not a
      // finished one — so it goes through the catch below like any write.
      const finished = handle;
      handle = undefined;
      try {
        await finished.close();
      } catch (err) {
        throw fsError('close', err);
      }
    } catch (err) {
      // The export has already failed; a cleanup step failing too can't
      // change that, but it is what leaves a partial file behind, so it is
      // logged rather than dropped.
      if (handle) {
        await handle.close().catch((e: unknown) => this.logCleanup('closing the export file', e));
      }
      handle = undefined;
      if (opened) {
        await fs.unlink(filePath).catch((e: unknown) => this.logCleanup('removing the partial export file', e));
      }
      throw classifyMongoOpError(err);
    } finally {
      await cursor.close().catch((e: unknown) => this.logCleanup('closing the export cursor', e));
    }
    return { path: filePath, written, truncated };
  }

  private logCleanup(step: string, err: unknown): void {
    this.log?.warn('query.export', `${step} failed`, { message: err instanceof Error ? err.message : String(err) });
  }

  cancel(token: string): void {
    this.active.get(token)?.abort();
    this.active.delete(token);
  }
}
