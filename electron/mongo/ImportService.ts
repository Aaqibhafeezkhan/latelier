import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { MongoBulkWriteError, type Collection, type Db, type Document } from 'mongodb';
import type { CsvPreview, DataImportInput, DataImportProgressEvent, ImportFormat, ImportReport } from '@shared/types';
import { AppError, NotFoundError, SystemError, ValidationError } from '../errors.ts';
import { DEFAULT_MAX_EJSON_BYTES } from './ejson.ts';
import { classifyMongoOpError } from './errors.ts';
import { csvRecords, previewCsv } from './csvImport.ts';
import {
  emptyReport,
  extensionFormat,
  parseJsonArray,
  parseJsonlLine,
  recordFailure,
  sniffFormat,
  type ImportRecord,
} from './importParse.ts';
import type { MongoPool } from './MongoPool.ts';
import { QUERY_TIMEOUT_MS } from './timeouts.ts';
import { attachUndo, importDigest, MAX_IMPORT_CAPTURE_DOCS } from './undo.ts';

const DEFAULT_BATCH_SIZE = 1000;

type EmitFn = (event: DataImportProgressEvent) => void;

// Filesystem failures are not driver errors, so they must never reach
// `classifyMongoOpError` and come back labelled MONGO_ERROR.
function fileError(action: string, err: unknown, details?: Record<string, unknown>): SystemError {
  return new SystemError('INTERNAL', `failed to ${action} import file: ${(err as Error).message}`, details);
}

async function sniffFile(filePath: string): Promise<ImportFormat> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  try {
    for await (const chunk of stream) {
      const format = sniffFormat(chunk as string);
      if (format) return format;
    }
  } catch (err) {
    throw fileError('read', err);
  } finally {
    stream.destroy();
  }
  // Empty or whitespace only: as JSONL it is simply no documents.
  return 'jsonl';
}

// `onBytes` rides the same underlying stream `readline` consumes — attaching
// a second `data` listener doesn't steal chunks from the first, so it gives
// an exact read count without readline exposing one itself.
export async function* jsonlRecords(stream: Readable, onBytes: (n: number) => void): AsyncGenerator<ImportRecord> {
  stream.on('data', (chunk) => onBytes(Buffer.byteLength(chunk as string, 'utf8')));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of lines) {
      // Counted before the blank check, so a reported line number is the
      // editor's line number.
      lineNo++;
      const record = parseJsonlLine(line, lineNo);
      if (record) yield record;
    }
  } finally {
    // Leaving early (a cancel, or a batch that failed outright) only pauses
    // readline's input; a file past its first chunk never reaches EOF, so
    // without this its descriptor stays open.
    stream.destroy();
  }
}

async function readWhole(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw fileError('read', err);
  }
}

/**
 * Imports a JSON array, JSONL or CSV file into an existing collection. Parses in
 * main and inserts unordered in batches, so a malformed line or a rejected
 * document is counted in the report rather than stopping the import. An error
 * that does stop it part-way carries `insertedCount` in its details, which is
 * what records the audit row as `partial`.
 */
export class ImportService {
  private pool: MongoPool;
  private maxArrayBytes: number;
  private batchSize: number;
  private emit?: EmitFn;
  private maxUndoCaptureDocs: number;
  // Token -> live run's cancel flag. A plain mutable holder (not a boolean
  // map) so `cancel()` can flip it after `importFile` has already captured
  // its reference, the same shape as QueryService's `active` map.
  private active = new Map<string, { cancelled: boolean }>();
  // Imports in flight, token or not; `active` only holds tokened ones.
  private running = 0;

  constructor(
    pool: MongoPool,
    opts: { maxArrayBytes?: number; batchSize?: number; emit?: EmitFn; maxUndoCaptureDocs?: number } = {},
  ) {
    this.pool = pool;
    this.maxArrayBytes = opts.maxArrayBytes ?? DEFAULT_MAX_EJSON_BYTES;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.emit = opts.emit;
    this.maxUndoCaptureDocs = opts.maxUndoCaptureDocs ?? MAX_IMPORT_CAPTURE_DOCS;
  }

  cancel(token: string): void {
    const state = this.active.get(token);
    if (state) state.cancelled = true;
  }

  /**
   * The dialog's mapping step for a `.csv` file. Reads the file the same way
   * `importFile` does, and the whole of it, so each column's inferred type
   * holds for every row rather than only the ones shown.
   */
  async previewCsv(filePath: string): Promise<CsvPreview> {
    const { format, size } = await this.checkFile(filePath);
    if (format !== 'csv') throw new ValidationError('only a .csv file has a column preview', { field: 'path' });
    this.checkWholeFileSize(format, size);
    return { fileName: path.basename(filePath), ...previewCsv(await readWhole(filePath)) };
  }

  async importFile(input: DataImportInput): Promise<ImportReport> {
    // First, before the file is touched: refuses a read-only connection.
    const w = this.pool.write(input.connectionId);
    const { format, size } = await this.checkFile(input.path);
    if ((format === 'csv') !== (input.csv !== undefined)) {
      throw new ValidationError(
        format === 'csv' ? 'a .csv file needs a column mapping' : 'a column mapping applies only to a .csv file',
        { field: 'csv' },
      );
    }
    this.checkWholeFileSize(format, size);
    const db = await w.db(input.dbName);
    await this.assertCollection(db, input);
    const coll = db.collection(input.collection);
    const report = emptyReport(path.basename(input.path), format);

    const token = input.cancelToken;
    const state = token ? { cancelled: false } : undefined;
    if (token && state) this.active.set(token, state);
    this.running++;

    // Registered before the file is read, so a cancel clicked while a large
    // array is still parsing is not lost; the outer finally unregisters it
    // on every exit, including a read or parse failure.
    try {
      let bytesRead = 0;
      let records: Iterable<ImportRecord> | AsyncIterable<ImportRecord>;
      if (format !== 'jsonl') {
        const text = await readWhole(input.path);
        bytesRead = size; // whole file is already in memory once parsed
        records = format === 'json' ? parseJsonArray(text) : csvRecords(text, input.csv!.columns);
      } else {
        records = jsonlRecords(createReadStream(input.path, { encoding: 'utf8' }), (n) => { bytesRead += n; });
      }

      const emitProgress = () => {
        if (!token) return;
        this.emit?.({
          cancelToken: token,
          processed: report.inserted + report.failed,
          inserted: report.inserted,
          failed: report.failed,
          bytesRead,
          totalBytes: size,
        });
      };

      // X13 §5 option (b): ids + a per-document digest for every landed
      // document, up to `maxUndoCaptureDocs` — above that, nothing partial is
      // kept, so the arrays are dropped rather than trimmed.
      const importedIds: unknown[] = [];
      const digests: string[] = [];
      let captureOverflowed = false;
      const captureLanded = (docs: Record<string, unknown>[]) => {
        if (captureOverflowed) return;
        for (const doc of docs) {
          importedIds.push(doc._id);
          digests.push(importDigest(doc));
        }
        if (importedIds.length > this.maxUndoCaptureDocs) {
          captureOverflowed = true;
          importedIds.length = 0;
          digests.length = 0;
        }
      };
      // A cancelled run is still undoable for whatever landed, so both exits
      // below go through this rather than a bare `return report`.
      const finish = (): ImportReport =>
        !captureOverflowed && importedIds.length > 0 ? attachUndo(report, { importedIds, digests }) : report;

      let batch: { at: number; doc: Record<string, unknown> }[] = [];
      try {
        for await (const record of records) {
          if ('error' in record) {
            recordFailure(report, record.at, record.error);
            continue;
          }
          batch.push(record);
          if (batch.length >= this.batchSize) {
            captureLanded(await this.insertBatch(coll, batch, report));
            batch = [];
            emitProgress();
            // Never mid-batch: an aborted in-flight `insertMany` would leave the
            // landed count unknowable, so cancel only takes effect once the
            // batch that was already running has fully landed.
            if (state?.cancelled) {
              report.cancelled = true;
              return finish();
            }
          }
        }
        if (batch.length > 0) {
          captureLanded(await this.insertBatch(coll, batch, report));
          emitProgress();
        }
      } catch (err) {
        // `insertBatch` has already classified its own errors; what is left is
        // the JSONL stream failing to read part-way.
        const failure = err instanceof AppError ? err : fileError('read', err, { insertedCount: report.inserted });
        // The batches that fully landed before the failure stay undoable. The
        // failing batch's own landed documents can't be told apart from the
        // ones it never wrote, so they are not captured and Undo leaves them.
        // The capture rides the error object in main (a WeakMap), never its
        // `details`, which are what cross IPC.
        if (!captureOverflowed && importedIds.length > 0) attachUndo(failure, { importedIds, digests });
        throw failure;
      }
      return finish();
    } finally {
      this.running--;
      if (token) this.active.delete(token);
    }
  }

  /** Imports in flight, for the quit confirmation. */
  runningCount(): number {
    return this.running;
  }

  /** JSON arrays and CSV are parsed whole, so their size is capped; JSONL streams. */
  private checkWholeFileSize(format: ImportFormat, size: number): void {
    if (format === 'jsonl' || size <= this.maxArrayBytes) return;
    const advice = format === 'json' ? ' — convert it to JSONL, which is read line by line' : '';
    throw new ValidationError(
      `a ${format === 'json' ? 'JSON array' : 'CSV'} file over ${this.maxArrayBytes} bytes cannot be imported${advice}`,
      { size, maxBytes: this.maxArrayBytes },
    );
  }

  /** Re-checks the path the renderer sent: absolute, an allowed extension, a regular file. */
  private async checkFile(filePath: string): Promise<{ format: ImportFormat; size: number }> {
    if (!path.isAbsolute(filePath)) {
      throw new ValidationError('import path must be absolute', { field: 'path' });
    }
    const byExtension = extensionFormat(filePath);
    if (byExtension === undefined) {
      throw new ValidationError('only .json, .jsonl, .ndjson and .csv files can be imported', { field: 'path' });
    }
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (err) {
      throw fileError('open', err);
    }
    if (!stat.isFile()) {
      throw new ValidationError(`${path.basename(filePath)} is not a file`, { field: 'path' });
    }
    const format = byExtension === 'sniff' ? await sniffFile(filePath) : byExtension;
    return { format, size: stat.size };
  }

  private async assertCollection(db: Db, input: DataImportInput): Promise<void> {
    let found: Document[];
    try {
      found = await db.listCollections({ name: input.collection }).toArray();
    } catch (err) {
      throw classifyMongoOpError(err);
    }
    if (found.length === 0) {
      throw new NotFoundError(`collection ${input.dbName}.${input.collection} not found`);
    }
    if (found[0]!.type === 'view') {
      throw new ValidationError(`${input.collection} is a view — documents cannot be imported into it`);
    }
  }

  /** Inserts `batch`, returning the documents that actually landed — the driver mutates each with its `_id` in place. */
  private async insertBatch(
    coll: Collection,
    batch: { at: number; doc: Record<string, unknown> }[],
    report: ImportReport,
  ): Promise<Record<string, unknown>[]> {
    try {
      const result = await coll.insertMany(batch.map((r) => r.doc), { ordered: false, maxTimeMS: QUERY_TIMEOUT_MS });
      report.inserted += result.insertedCount;
      return batch.map((r) => r.doc);
    } catch (err) {
      if (err instanceof MongoBulkWriteError) {
        const writeErrors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
        // Unordered: every document either landed or has a write error. When
        // the two don't add up to the batch, something beyond per-document
        // rejections went wrong, and the import stops.
        if (writeErrors.length > 0 && err.result.insertedCount + writeErrors.length === batch.length) {
          report.inserted += err.result.insertedCount;
          const failedAt = new Set(writeErrors.map((e) => e.index));
          for (const e of writeErrors) recordFailure(report, batch[e.index]!.at, e.errmsg ?? `write error ${e.code}`);
          return batch.filter((_r, i) => !failedAt.has(i)).map((r) => r.doc);
        }
        report.inserted += err.result.insertedCount;
      }
      throw classifyMongoOpError(err, { insertedCount: report.inserted });
    }
  }
}
