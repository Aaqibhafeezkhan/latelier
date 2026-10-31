import path from 'node:path';
import { IPC_CHANNELS, type Envelope } from '@shared/ipc';
import type { AuditOp, AuditOutcome, AuditSummary, ImportFormat } from '@shared/types';

type ModifiedGroup = Extract<AuditSummary, { op: 'collectionModify' }>['changed'][number];

/** One audit row, before it has an id or timestamps. */
export interface AuditRecord {
  connectionId: string;
  dbName: string;
  collection: string | null;
  op: AuditOp;
  summary: AuditSummary;
  outcome: AuditOutcome;
  errorCode: string | null;
}

type Fields = Record<string, unknown>;

interface ChannelSpec {
  op: AuditOp;
  /** `data` is the handler's result, or undefined when the Operation failed. */
  summarize: (input: Fields, data: unknown) => AuditSummary;
  /** The outcome of an ok envelope, when that can be less than `'ok'`. */
  outcome?: (data: unknown) => AuditOutcome;
}

function count(source: unknown, key: string): number | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  const v = (source as Fields)[key];
  return typeof v === 'number' ? v : undefined;
}

// Summaries name what was targeted and what came back — never a document body
// (`docsJson`, `updateJson`), and never a confirm token (deleteMany's or
// updateMany's).
const filterOf = (input: Fields): string => input.filterJson as string;

// The report's format when there is one: it reflects what the file turned
// out to hold. Without one, only an extension that settles it counts — a
// `.json` file can be either shape until it is read.
function importFormat(input: Fields, data: unknown): ImportFormat | undefined {
  const v = data === null || typeof data !== 'object' ? undefined : (data as Fields).format;
  if (v === 'json' || v === 'jsonl' || v === 'csv') return v;
  const p = input.path as string;
  if (/\.csv$/i.test(p)) return 'csv';
  return /\.(jsonl|ndjson)$/i.test(p) ? 'jsonl' : undefined;
}

// `undefined`, never `false`, when the run wasn't cancelled — keeps the
// common case out of the persisted summary and off `toEqual` assertions that
// predate cancel.
function importCancelled(data: unknown): true | undefined {
  return data !== null && typeof data === 'object' && (data as Fields).cancelled === true ? true : undefined;
}

// Which option groups a collMod carried, in a fixed order. `viewOn` and
// `pipeline` travel together (the zod schema refuses half a view), so either
// one stands for the 'view' group. Values are deliberately not read.
function modifiedGroups(input: Fields): ModifiedGroup[] {
  const options = input.options as Fields;
  const present = (k: string): boolean => options[k] !== undefined;
  const changed: ModifiedGroup[] = [];
  if (present('validator')) changed.push('validator');
  if (present('validationLevel')) changed.push('validationLevel');
  if (present('validationAction')) changed.push('validationAction');
  if (present('viewOn') || present('pipeline')) changed.push('view');
  return changed;
}

/**
 * The audited channels. A channel absent from this table is not audited, so a
 * write channel added later stays unrecorded until someone decides what its
 * row should hold — failing closed rather than recording something it
 * shouldn't.
 */
const AUDITED_CHANNELS: Readonly<Record<string, ChannelSpec>> = {
  [IPC_CHANNELS.docInsertMany]: {
    op: 'insertMany',
    summarize: (_input, data) => ({ op: 'insertMany', insertedCount: count(data, 'insertedCount') }),
  },
  [IPC_CHANNELS.docUpdateOne]: {
    op: 'updateOne',
    summarize: (input, data) => ({
      op: 'updateOne',
      filter: filterOf(input),
      matchedCount: count(data, 'matchedCount'),
      modifiedCount: count(data, 'modifiedCount'),
    }),
  },
  [IPC_CHANNELS.docUpdateMany]: {
    op: 'updateMany',
    summarize: (input, data) => ({
      op: 'updateMany',
      filter: filterOf(input),
      matchedCount: count(data, 'matchedCount'),
      modifiedCount: count(data, 'modifiedCount'),
    }),
  },
  [IPC_CHANNELS.docDeleteOne]: {
    op: 'deleteOne',
    summarize: (input, data) => ({
      op: 'deleteOne',
      filter: filterOf(input),
      deletedCount: count(data, 'deletedCount'),
    }),
  },
  [IPC_CHANNELS.docDeleteMany]: {
    op: 'deleteMany',
    summarize: (input, data) => ({
      op: 'deleteMany',
      filter: filterOf(input),
      deletedCount: count(data, 'deletedCount'),
    }),
  },
  [IPC_CHANNELS.collectionDrop]: {
    op: 'collectionDrop',
    summarize: () => ({ op: 'collectionDrop' }),
  },
  [IPC_CHANNELS.collectionRename]: {
    op: 'collectionRename',
    summarize: (input) => ({
      op: 'collectionRename',
      fromName: input.collection as string,
      toName: input.newName as string,
    }),
  },
  [IPC_CHANNELS.collectionModify]: {
    op: 'collectionModify',
    summarize: (input) => ({ op: 'collectionModify', changed: modifiedGroups(input) }),
  },
  [IPC_CHANNELS.databaseDrop]: {
    op: 'databaseDrop',
    summarize: () => ({ op: 'databaseDrop' }),
  },
  // The file name comes from the input, not the report, so a failed import's
  // row still names its file. Only the basename: the directory is the user's
  // business, not the log's.
  [IPC_CHANNELS.dataImport]: {
    op: 'import',
    summarize: (input, data) => ({
      op: 'import',
      fileName: path.basename(input.path as string),
      format: importFormat(input, data),
      insertedCount: count(data, 'inserted'),
      failedCount: count(data, 'failed'),
      cancelled: importCancelled(data),
    }),
    // Rejected documents do not fail the import, but they do make it
    // partial — so does a cancel, whatever landed.
    outcome: (data) => ((count(data, 'failed') ?? 0) > 0 || importCancelled(data) ? 'partial' : 'ok'),
  },
};

/**
 * The row an invocation of `channel` should leave, or null when the channel is
 * not audited. `input` is the validated payload; `envelope` is exactly what
 * the renderer received, so `error_code` can never disagree with it.
 */
export function auditRecordFor(
  channel: string,
  input: unknown,
  envelope: Envelope<unknown>,
): AuditRecord | null {
  if (!Object.hasOwn(AUDITED_CHANNELS, channel)) return null;
  const spec = AUDITED_CHANNELS[channel]!;
  const fields = input as Fields;
  const target = {
    connectionId: fields.connectionId as string,
    dbName: fields.dbName as string,
    collection: (fields.collection as string | undefined) ?? null,
    op: spec.op,
  };
  if (envelope.ok) {
    return {
      ...target,
      summary: spec.summarize(fields, envelope.data),
      outcome: spec.outcome?.(envelope.data) ?? 'ok',
      errorCode: null,
    };
  }
  // `ordered: true` stops at the first failing document, and an import stops
  // at a failure between batches, so either can fail having changed the
  // collection. The error carries how many landed; anything above zero is a
  // partial, not a plain failure.
  const insertedCount =
    spec.op === 'insertMany' || spec.op === 'import' ? count(envelope.error.details, 'insertedCount') : undefined;
  if (insertedCount !== undefined) {
    return {
      ...target,
      summary: { ...spec.summarize(fields, undefined), insertedCount } as AuditSummary,
      outcome: insertedCount > 0 ? 'partial' : 'error',
      errorCode: envelope.error.code,
    };
  }
  return { ...target, summary: spec.summarize(fields, undefined), outcome: 'error', errorCode: envelope.error.code };
}
