import { randomUUID } from 'node:crypto';
import type { Collection, Document, MongoClient } from 'mongodb';
import type {
  AggExplainInput,
  AggInput,
  AggResultWire,
  AggRunAndSaveInput,
  AggSaveCounts,
  AggStagePreview,
  PreviewInput,
  Stage,
  StageOp,
} from '@shared/types';
import { ejsonParse, ejsonEncode, ejsonEncodeArray, ejsonEncodeArrayJson } from './ejson.ts';
import {
  ConflictError,
  SystemError,
  ValidationError,
} from '../errors.ts';
import { classifyMongoOpError } from './errors.ts';
import type { MongoPool, WriteGrant } from './MongoPool.ts';
import { logRecentWriteFailure, type RecentQueryService } from '../services/RecentQueryService.ts';
import type { Logger } from '../log.ts';
import { isWriteStage } from './writeStages.ts';
import { PROBE_TIMEOUT_MS, QUERY_TIMEOUT_MS } from './timeouts.ts';

const COLLECTION_NAME_RE = /^[^$\0][^\0]{0,119}$/;
const SAMPLE_PER_STAGE = 5;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;
const MAX_BYTES = 200 * 1024 * 1024;
// How often a cancelled write looks for its op in `currentOp` until it shows up.
const KILL_POLL_MS = 100;
// The server's code for an op stopped by `killOp`.
const INTERRUPTED = 11601;

export { isWriteStage };

interface CancelEntry {
  controller: AbortController;
}

export class AggregationService {
  private pool: MongoPool;
  private recent: RecentQueryService;
  private active = new Map<string, CancelEntry>();
  // Runs between pipeline start and finish, token or not; `active` only holds tokened ones.
  private running = 0;
  private log: Logger | undefined;

  constructor(pool: MongoPool, recent: RecentQueryService, log?: Logger) {
    this.pool = pool;
    this.recent = recent;
    this.log = log;
  }

  /**
   * `beforeExecute` runs once the pipeline is validated, the write grant is
   * taken and the cancel token is registered, just before the pipeline
   * executes. `runAndSave` counts a `$merge` target there, so a read-only
   * connection or a malformed stage is refused before the server is asked
   * anything (ADR 0005), and a cancel during the count stops the write.
   */
  async run(input: AggInput, beforeExecute?: () => Promise<void>): Promise<AggResultWire> {
    const enabled = this.requireEnabledStages(input.stages);
    const writeStage = enabled.find((s) => isWriteStage(s.op));
    if (writeStage && !input.allowWrite) {
      throw new ValidationError('run blocked: write stage present', {
        writeStageOp: writeStage.op,
        stageId: writeStage.id,
        targetCollection: extractWriteTarget(writeStage),
        kind: 'writeStage',
      });
    }
    // #2.17 — when a write stage will actually execute, apply runAndSave's
    // target guards here too: a direct agg:run with allowWrite must not be able
    // to overwrite the source collection ($out) or target a malformed name.
    // run() decides here, once, whether this pipeline writes. The grant is
    // taken at the same point the old assertWritable call stood — before the
    // target guards below — and nothing connects until getCollection asks it
    // for a handle, which is after registerCancel.
    const isWrite = Boolean(writeStage && input.allowWrite);
    const grant = isWrite ? this.pool.write(input.connectionId) : null;
    if (isWrite) {
      const target = extractWriteTarget(writeStage!);
      if (target !== undefined) validateCollectionName(target);
      if (
        writeStage!.op === '$out' &&
        outTargetsSource(writeStage!, input.dbName, input.collection)
      ) {
        throw new ConflictError('$out target cannot equal source collection', {
          writeStageOp: writeStage!.op,
          stageId: writeStage!.id,
          targetCollection: target,
        });
      }
    }

    const pipeline = enabled.map((s) => parseStage(s));
    const controller = this.registerCancel(input.cancelToken);
    let coll: Collection<Document>;
    try {
      coll = await this.getCollection(
        input.connectionId,
        input.dbName,
        input.collection,
        grant,
      );
    } catch (err) {
      // The run never started, so the try/finally below will not clear the token.
      this.clearCancel(input.cancelToken);
      throw err;
    }
    const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    let t0 = Date.now();
    // Once a $out/$merge is sent, a cancel can only ask the server to kill it,
    // so its own error, or its completion, is the real outcome.
    let writeSent = false;

    this.running++;
    try {
      if (beforeExecute) {
        await beforeExecute();
        if (controller.signal.aborted) throw new SystemError('INTERNAL', 'cancelled');
        t0 = Date.now();
      }
      let rowsJson: string;
      let rowCount: number;
      let hasMore: boolean;
      let stageCounts: Record<number, number>;
      let stageSamples: Record<number, unknown[]>;
      let durationMs: number;

      if (writeStage) {
        // Write pipelines run untouched and skip instrumentation for the
        // final write stage (it produces no documents).
        const nonWrite = enabled.slice(0, enabled.length - 1);
        // No `signal` here on purpose: aborting makes the driver drop the
        // socket and throw at once, but the server does not stop a $out/$merge
        // when its client disconnects — the write lands seconds later while the
        // UI would already say "cancelled". A cancel instead finds the op by
        // its comment and kills it, and the socket stays open to hear how the
        // write ended.
        const comment = `latelier-agg:${randomUUID()}`;
        const cursor = coll.aggregate(pipeline, {
          allowDiskUse: true,
          maxTimeMS: QUERY_TIMEOUT_MS,
          comment,
        });
        if (controller.signal.aborted) throw new SystemError('INTERNAL', 'cancelled');
        writeSent = true;
        const written = cursor.toArray();
        const stop = () => void this.killWrite(input.connectionId, comment, written);
        controller.signal.addEventListener('abort', stop, { once: true });
        try {
          await written;
        } finally {
          controller.signal.removeEventListener('abort', stop);
        }
        durationMs = Date.now() - t0;
        rowsJson = '[]';
        rowCount = 0;
        hasMore = false;
        try {
          const instrumented = await this.instrument(coll, nonWrite, controller.signal);
          stageCounts = instrumented.stageCounts;
          stageSamples = instrumented.stageSamples;
        } catch (err) {
          // The write already landed: a cancel now only skips the per-stage
          // counts, and the run is reported as completed.
          if (!controller.signal.aborted) throw err;
          stageCounts = {};
          stageSamples = {};
        }
      } else {
        const mainPipeline = [...pipeline, { $limit: limit }];
        const cursor = coll.aggregate(mainPipeline, {
          allowDiskUse: true,
          maxTimeMS: QUERY_TIMEOUT_MS,
          signal: controller.signal,
        });
        const [rawRows, instrumented] = await Promise.all([
          cursor.toArray(),
          this.instrument(coll, enabled, controller.signal),
        ]);
        // Capture durationMs before encoding so the metric reflects the
        // database work, not serialization — matches QueryService.find.
        durationMs = Date.now() - t0;
        rowsJson = ejsonEncodeArrayJson(rawRows, { maxBytes: MAX_BYTES });
        rowCount = rawRows.length;
        hasMore = rawRows.length === limit;
        stageCounts = instrumented.stageCounts;
        stageSamples = instrumented.stageSamples;
      }

      // Fire-and-forget: matches QueryService.find — history writes shouldn't
      // block the result returning to the renderer.
      void this.recent
        .recordAggregation(
          {
            connectionId: input.connectionId,
            dbName: input.dbName,
            collection: input.collection,
            stages: enabled,
          },
          durationMs,
          rowCount,
        )
        .catch((e: unknown) => logRecentWriteFailure(this.log, e));

      return {
        rowsJson,
        durationMs,
        stageCounts,
        stageSamples,
        hasMore,
      };
    } catch (err) {
      if (controller.signal.aborted && !writeSent) {
        throw new SystemError('INTERNAL', 'cancelled');
      }
      // The kill landed: a `$out` writes to a temp collection and renames it at
      // the end, so its target is untouched; a `$merge` keeps every batch it
      // already flushed, and nothing rolls them back.
      if (controller.signal.aborted && (err as { code?: unknown }).code === INTERRUPTED) {
        throw new SystemError('INTERNAL', 'cancelled', {
          writeStageOp: writeStage!.op,
          partialWrite: writeStage!.op === '$merge',
        });
      }
      const classified = classifyMongoOpError(err);
      // Record failures so the recent-query history stays consistent with
      // the find error path.
      void this.recent
        .recordAggregation(
          {
            connectionId: input.connectionId,
            dbName: input.dbName,
            collection: input.collection,
            stages: enabled,
          },
          Date.now() - t0,
          0,
          classified.code,
        )
        .catch((e: unknown) => logRecentWriteFailure(this.log, e));
      throw classified;
    } finally {
      this.running--;
      this.clearCancel(input.cancelToken);
    }
  }

  /** Runs in flight, for the quit confirmation. */
  runningCount(): number {
    return this.running;
  }

  async previewUpToStage(input: PreviewInput): Promise<AggStagePreview> {
    const enabled = this.requireEnabledStages(input.stages);
    const lastStage = enabled[enabled.length - 1]!;
    if (isWriteStage(lastStage.op)) {
      throw new ValidationError('cannot preview a write stage', {
        stageId: lastStage.id,
      });
    }
    const limit = Math.min(input.limit ?? SAMPLE_PER_STAGE, 50);
    const pipeline = enabled.map((s) => parseStage(s));
    const coll = await this.getCollection(
      input.connectionId,
      input.dbName,
      input.collection,
      null,
    );
    try {
      const sampleCursor = coll.aggregate([...pipeline, { $limit: limit }], {
        allowDiskUse: true,
        maxTimeMS: PROBE_TIMEOUT_MS,
      });
      const sampleDocs = await sampleCursor.toArray();
      const sample = ejsonEncodeArray(sampleDocs, false);

      let count: number | undefined;
      try {
        const countCursor = coll.aggregate([...pipeline, { $count: 'c' }], {
          allowDiskUse: true,
          maxTimeMS: PROBE_TIMEOUT_MS,
        });
        const arr = (await countCursor.toArray()) as Array<{ c?: number }>;
        count = arr[0]?.c ?? 0;
      } catch {
        count = undefined;
      }

      return { stageId: lastStage.id, count, sample };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  cancel(token: string): void {
    const entry = this.active.get(token);
    if (entry) {
      entry.controller.abort();
      this.active.delete(token);
    }
  }

  async runAndSave(input: AggRunAndSaveInput): Promise<AggResultWire & AggSaveCounts> {
    validateCollectionName(input.target.collection);
    if (
      input.target.mode === '$out' &&
      input.target.dbName === input.dbName &&
      input.target.collection === input.collection
    ) {
      throw new ConflictError('$out target cannot equal source collection', {
        target: input.target,
      });
    }

    const writeStage: Stage =
      input.target.mode === '$out'
        ? {
            id: maxStageId(input.stages) + 1,
            op: '$out',
            body:
              input.target.dbName === input.dbName
                ? JSON.stringify(input.target.collection)
                : JSON.stringify({
                    db: input.target.dbName,
                    coll: input.target.collection,
                  }),
            enabled: true,
          }
        : {
            id: maxStageId(input.stages) + 1,
            op: '$merge',
            body: JSON.stringify({
              into:
                input.target.dbName === input.dbName
                  ? input.target.collection
                  : { db: input.target.dbName, coll: input.target.collection },
              whenMatched: input.target.merge?.whenMatched ?? 'merge',
              whenNotMatched: input.target.merge?.whenNotMatched ?? 'insert',
            }),
            enabled: true,
          };

    // `$merge` leaves the target's existing documents in place, so only its
    // size before the run tells how much of the size after is new.
    const isMerge = input.target.mode === '$merge';
    let countBefore: number | undefined;
    const result = await this.run(
      {
        ...input,
        stages: [...input.stages, writeStage],
        allowWrite: true,
      },
      isMerge
        ? async () => {
            countBefore = await this.countTarget(input);
          }
        : undefined,
    );

    const countAfter = await this.countTarget(input);
    if (!isMerge) return { ...result, writtenCount: countAfter };
    return {
      ...result,
      mergeCounts:
        countBefore !== undefined && countAfter !== undefined
          ? { before: countBefore, after: countAfter }
          : undefined,
    };
  }

  async explain(
    input: AggExplainInput,
  ): Promise<{ plan: unknown; verbosity: string; writeStageOmitted: boolean }> {
    const enabled = this.requireEnabledStages(input.stages);
    const nonWrite = enabled.filter((s) => !isWriteStage(s.op));
    const writeStageOmitted = nonWrite.length !== enabled.length;
    if (nonWrite.length === 0) {
      throw new ValidationError('nothing to explain after removing write stages');
    }
    const pipeline = nonWrite.map((s) => parseStage(s));
    const coll = await this.getCollection(
      input.connectionId,
      input.dbName,
      input.collection,
      null,
    );
    const cursor = coll.aggregate(pipeline, {
      allowDiskUse: true,
      maxTimeMS: QUERY_TIMEOUT_MS,
    });
    try {
      const plan = await cursor.explain(input.verbosity);
      return {
        plan: ejsonEncode(plan as object, false),
        verbosity: input.verbosity,
        writeStageOmitted,
      };
    } catch (err) {
      throw classifyMongoOpError(err);
    } finally {
      // Same rationale as QueryService.explain — close eagerly so the
      // server-side cursor doesn't linger until the session times out.
      await cursor.close().catch(() => {});
    }
  }

  // ─── internals ─────────────────────────────────────────────────────────

  /**
   * Kills a sent write on the server. The op is found by the comment `run()`
   * tagged it with; the comment survives in `currentOp` even when a long
   * command shows as `command.$truncated`. `$ownOps` lets a user without the
   * `inprog` privilege see their own ops. The cursor is lazy, so the command
   * may not have reached the server when Cancel lands: keep looking until the
   * op shows up or the write settles. `killOp` answers ok for any opid, so
   * whether the write stopped is read from how `written` settles, not here.
   *
   * The commands go over a control client of their own: on the pooled client
   * they would queue behind the very aggregate they are meant to stop
   * whenever it holds the pool's last connection.
   *
   * A refusal (no `killop` privilege, a hosted tier that disallows these
   * commands) only costs the stop: the write runs to completion as before.
   */
  private async killWrite(
    connectionId: string,
    comment: string,
    written: Promise<unknown>,
  ): Promise<void> {
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    written.then(markSettled, markSettled);
    let control: MongoClient | undefined;
    try {
      control = await this.pool.openControlClient(connectionId);
      const admin = control.db('admin');
      while (!settled) {
        const { inprog } = (await admin.command({
          currentOp: 1,
          $ownOps: true,
          'command.comment': comment,
        })) as { inprog: Array<{ opid: unknown }> };
        if (inprog.length > 0) {
          // Every match: on a sharded cluster each shard runs its own part of
          // the pipeline under the same comment. The opid goes back as
          // `currentOp` gave it, a number on mongod and a "shard:opid" string
          // on mongos.
          for (const op of inprog) await admin.command({ killOp: 1, op: op.opid });
          return;
        }
        await new Promise((r) => setTimeout(r, KILL_POLL_MS));
      }
    } catch (err) {
      this.log?.warn('agg', 'could not stop the write on the server; it runs to completion', {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await control?.close().catch((err: unknown) => {
        this.log?.warn('agg', 'closing the control client failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Size of a save target, or undefined when it cannot be read. The count only
   * decorates the success message, so a failed probe must not fail a write that
   * already happened; it is logged instead. The count before a `$merge` runs
   * only once `run()` has connected, so an unreachable server has already
   * failed the save, once, before this is reached.
   */
  private async countTarget(input: AggRunAndSaveInput): Promise<number | undefined> {
    try {
      const db = await this.pool.readDb(input.connectionId, input.target.dbName);
      return await db
        .collection(input.target.collection)
        .countDocuments({}, { maxTimeMS: PROBE_TIMEOUT_MS });
    } catch (err) {
      this.log?.warn('agg', 'counting the save target failed', {
        connectionId: input.connectionId,
        dbName: input.target.dbName,
        collection: input.target.collection,
        message: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private requireEnabledStages(stages: Stage[]): Stage[] {
    const enabled = stages.filter((s) => s.enabled);
    if (enabled.length === 0) {
      throw new ValidationError('stages: no enabled stages');
    }
    return enabled;
  }

  /**
   * `grant` carries the caller's already-made write-or-not determination.
   * Passed in rather than re-derived here: `run()` decides once, from the
   * pipeline, and a second decision in this helper could disagree with it —
   * which is the per-pipeline conditionality ADR 0005 keeps at the caller.
   */
  private async getCollection(
    connectionId: string,
    dbName: string,
    collection: string,
    grant: WriteGrant | null,
  ): Promise<Collection<Document>> {
    const db = grant ? await grant.db(dbName) : await this.pool.readDb(connectionId, dbName);
    return db.collection(collection);
  }

  private registerCancel(token?: string): AbortController {
    const controller = new AbortController();
    if (token) this.active.set(token, { controller });
    return controller;
  }

  private clearCancel(token?: string): void {
    if (token) this.active.delete(token);
  }

  private async instrument(
    coll: Collection<Document>,
    stages: Stage[],
    signal: AbortSignal,
  ): Promise<{
    stageCounts: Record<number, number>;
    stageSamples: Record<number, unknown[]>;
  }> {
    if (stages.length === 0) {
      return { stageCounts: {}, stageSamples: {} };
    }
    try {
      return await this.instrumentFacet(coll, stages, signal);
    } catch {
      // Fallback to separate per-stage runs.
      return this.instrumentSeparate(coll, stages, signal);
    }
  }

  private async instrumentFacet(
    coll: Collection<Document>,
    stages: Stage[],
    signal: AbortSignal,
  ): Promise<{
    stageCounts: Record<number, number>;
    stageSamples: Record<number, unknown[]>;
  }> {
    if (signal.aborted) throw new SystemError('INTERNAL', 'cancelled');
    const cumulative: Document[] = [];
    const facet: Record<string, Document[]> = {};
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]!;
      cumulative.push(parseStage(stage));
      facet[`count_${stage.id}`] = [...cumulative, { $count: 'c' }];
      facet[`sample_${stage.id}`] = [...cumulative, { $limit: SAMPLE_PER_STAGE }];
    }
    const cursor = coll.aggregate([{ $facet: facet }], {
      allowDiskUse: true,
      maxTimeMS: QUERY_TIMEOUT_MS,
      signal,
    });
    const arr = (await cursor.toArray()) as [Record<string, Document[]>] | [];
    const row = arr[0] ?? {};
    const stageCounts: Record<number, number> = {};
    const stageSamples: Record<number, unknown[]> = {};
    for (const stage of stages) {
      const countBranch = row[`count_${stage.id}`] as Array<{ c?: number }> | undefined;
      stageCounts[stage.id] = countBranch?.[0]?.c ?? 0;
      const sampleBranch = (row[`sample_${stage.id}`] ?? []) as unknown[];
      stageSamples[stage.id] = ejsonEncodeArray(sampleBranch, false);
    }
    return { stageCounts, stageSamples };
  }

  private async instrumentSeparate(
    coll: Collection<Document>,
    stages: Stage[],
    signal: AbortSignal,
  ): Promise<{
    stageCounts: Record<number, number>;
    stageSamples: Record<number, unknown[]>;
  }> {
    const stageCounts: Record<number, number> = {};
    const stageSamples: Record<number, unknown[]> = {};
    const cumulative: Document[] = [];
    for (const stage of stages) {
      if (signal.aborted) throw new SystemError('INTERNAL', 'cancelled');
      cumulative.push(parseStage(stage));
      try {
        const countArr = (await coll
          .aggregate([...cumulative, { $count: 'c' }], {
            allowDiskUse: true,
            maxTimeMS: QUERY_TIMEOUT_MS,
            signal,
          })
          .toArray()) as Array<{ c?: number }>;
        stageCounts[stage.id] = countArr[0]?.c ?? 0;
      } catch {
        stageCounts[stage.id] = 0;
      }
      try {
        const sampleDocs = await coll
          .aggregate([...cumulative, { $limit: SAMPLE_PER_STAGE }], {
            allowDiskUse: true,
            maxTimeMS: QUERY_TIMEOUT_MS,
            signal,
          })
          .toArray();
        stageSamples[stage.id] = ejsonEncodeArray(sampleDocs, false);
      } catch {
        stageSamples[stage.id] = [];
      }
    }
    return { stageCounts, stageSamples };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function parseStage(stage: Stage): Document {
  let parsed: unknown;
  try {
    parsed = ejsonParse(stage.body);
  } catch (e) {
    throw new ValidationError(
      `stage ${stage.id} (${stage.op}): invalid EJSON`,
      { stageId: stage.id, op: stage.op, reason: (e as Error).message },
    );
  }
  return { [stage.op]: parsed } as Document;
}

function maxStageId(stages: Stage[]): number {
  return stages.reduce((m, s) => (s.id > m ? s.id : m), 0);
}

function validateCollectionName(name: string): void {
  if (!name || !COLLECTION_NAME_RE.test(name)) {
    throw new ValidationError('invalid collection name', { collection: name });
  }
}

/**
 * True when a `$out` stage would write back to the pipeline's source
 * collection (which `$out` overwrites). Handles both the string form
 * (`$out: "coll"`, implicitly the source db) and the object form
 * (`$out: { db, coll }`).
 */
function outTargetsSource(stage: Stage, sourceDb: string, sourceColl: string): boolean {
  try {
    const body = ejsonParse(stage.body);
    if (typeof body === 'string') return body === sourceColl;
    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      const db = typeof obj.db === 'string' ? obj.db : sourceDb;
      const coll = typeof obj.coll === 'string' ? obj.coll : undefined;
      return db === sourceDb && coll === sourceColl;
    }
  } catch {
    // Unparseable body — let the driver surface the error.
  }
  return false;
}

function extractWriteTarget(stage: Stage): string | undefined {
  try {
    const body = ejsonParse(stage.body);
    if (typeof body === 'string') return body;
    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      if (stage.op === '$out') {
        if (typeof obj.coll === 'string') return obj.coll as string;
      } else if (stage.op === '$merge') {
        const into = obj.into;
        if (typeof into === 'string') return into;
        if (into && typeof into === 'object') {
          const i = into as Record<string, unknown>;
          if (typeof i.coll === 'string') return i.coll as string;
        }
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

export type { StageOp };
