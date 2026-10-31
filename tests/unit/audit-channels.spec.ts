import { describe, it, expect } from 'vitest';
import { auditRecordFor } from '../../electron/ipc/auditChannels';
import { IPC_CHANNELS, type Envelope, type IpcError } from '../../shared/ipc';

const T = { connectionId: 'c1', dbName: 'shop', collection: 'orders' };
const okEnv = (data: unknown): Envelope<unknown> => ({ ok: true, data });
const errEnv = (error: IpcError): Envelope<unknown> => ({ ok: false, error });

describe('auditRecordFor', () => {
  it('returns null for a channel outside the audit table', () => {
    for (const channel of [
      IPC_CHANNELS.docInsert,
      IPC_CHANNELS.docConfirmDeleteMany,
      IPC_CHANNELS.docConfirmUpdateMany,
      IPC_CHANNELS.queryFind,
      IPC_CHANNELS.userCreate,
      IPC_CHANNELS.auditList,
      'toString',
      'constructor',
    ]) {
      expect(auditRecordFor(channel, T, okEnv({}))).toBeNull();
    }
  });

  it('builds each audited op from input and result', () => {
    expect(auditRecordFor(IPC_CHANNELS.docInsertMany, { ...T, docsJson: '[{"a":1}]' }, okEnv({ insertedCount: 1, insertedIds: ['x'] })))
      .toEqual({ ...T, op: 'insertMany', summary: { op: 'insertMany', insertedCount: 1 }, outcome: 'ok', errorCode: null });
    expect(auditRecordFor(IPC_CHANNELS.docUpdateOne, { ...T, filterJson: '{"_id":1}', updateJson: '{"$set":{"a":1}}' }, okEnv({ matchedCount: 1, modifiedCount: 0 })))
      .toEqual({ ...T, op: 'updateOne', summary: { op: 'updateOne', filter: '{"_id":1}', matchedCount: 1, modifiedCount: 0 }, outcome: 'ok', errorCode: null });
    expect(auditRecordFor(IPC_CHANNELS.docDeleteOne, { ...T, filterJson: '{"_id":1}' }, okEnv({ deletedCount: 1 })))
      .toEqual({ ...T, op: 'deleteOne', summary: { op: 'deleteOne', filter: '{"_id":1}', deletedCount: 1 }, outcome: 'ok', errorCode: null });
    expect(auditRecordFor(IPC_CHANNELS.docDeleteMany, { ...T, filterJson: '{}', confirmToken: 'tok' }, okEnv({ deletedCount: 9 })))
      .toEqual({ ...T, op: 'deleteMany', summary: { op: 'deleteMany', filter: '{}', deletedCount: 9 }, outcome: 'ok', errorCode: null });
    expect(auditRecordFor(IPC_CHANNELS.docUpdateMany, { ...T, filterJson: '{}', updateJson: '{"$set":{"a":1}}', confirmToken: 'tok' }, okEnv({ matchedCount: 4, modifiedCount: 3 })))
      .toEqual({ ...T, op: 'updateMany', summary: { op: 'updateMany', filter: '{}', matchedCount: 4, modifiedCount: 3 }, outcome: 'ok', errorCode: null });
    expect(auditRecordFor(IPC_CHANNELS.collectionRename, { ...T, newName: 'orders2' }, okEnv({ name: 'orders2' })))
      .toEqual({ ...T, op: 'collectionRename', summary: { op: 'collectionRename', fromName: 'orders', toName: 'orders2' }, outcome: 'ok', errorCode: null });
    expect(auditRecordFor(IPC_CHANNELS.collectionDrop, T, okEnv({ dropped: true })))
      .toEqual({ ...T, op: 'collectionDrop', summary: { op: 'collectionDrop' }, outcome: 'ok', errorCode: null });
    expect(auditRecordFor(IPC_CHANNELS.databaseDrop, { connectionId: 'c1', dbName: 'shop' }, okEnv({ dropped: true })))
      .toEqual({ connectionId: 'c1', dbName: 'shop', collection: null, op: 'databaseDrop', summary: { op: 'databaseDrop' }, outcome: 'ok', errorCode: null });
  });

  describe('collectionModify', () => {
    const modify = (options: Record<string, unknown>, env: Envelope<unknown> = okEnv({})) =>
      auditRecordFor(IPC_CHANNELS.collectionModify, { ...T, options }, env);
    const view = { viewOn: 'src', pipeline: '[]' };

    it('names the changed groups in a fixed order, whatever order the options arrive in', () => {
      expect(modify({ validationAction: 'warn', validationLevel: 'moderate', validator: '{}' })).toEqual({
        ...T,
        op: 'collectionModify',
        summary: { op: 'collectionModify', changed: ['validator', 'validationLevel', 'validationAction'] },
        outcome: 'ok',
        errorCode: null,
      });
    });

    it.each([
      [{ validator: '{"a":1}' }, ['validator']],
      [{ validationLevel: 'off' }, ['validationLevel']],
      [{ validationAction: 'error' }, ['validationAction']],
      [{ validator: '{}', validationAction: 'error' }, ['validator', 'validationAction']],
      [{ validationLevel: 'strict', validationAction: 'warn' }, ['validationLevel', 'validationAction']],
      [view, ['view']],
      [{ viewOn: 'src' }, ['view']],
      [{ pipeline: '[]' }, ['view']],
    ])('summarises %j as %j', (options, changed) => {
      expect(modify(options)!.summary).toEqual({ op: 'collectionModify', changed });
    });

    it('treats an undefined option as absent', () => {
      expect(modify({ validator: undefined, validationLevel: 'off' })!.summary)
        .toEqual({ op: 'collectionModify', changed: ['validationLevel'] });
    });

    it('never carries an option value', () => {
      const rec = modify({
        validator: '{"$jsonSchema":{"enum":["VALUE-MARKER"]}}',
        validationLevel: 'strict',
        validationAction: 'warn',
      });
      expect(JSON.stringify(rec)).not.toMatch(/VALUE-MARKER|\$jsonSchema|strict|warn/);
      const viewRec = modify({ viewOn: 'VALUE-MARKER', pipeline: '[{"$match":{"s":"VALUE-MARKER"}}]' });
      expect(JSON.stringify(viewRec)).not.toContain('VALUE-MARKER');
    });

    it('records a failure with the envelope code and the same groups', () => {
      expect(modify(view, errEnv({ code: 'MONGO_ERROR', message: 'no' }))).toStrictEqual({
        ...T,
        op: 'collectionModify',
        summary: { op: 'collectionModify', changed: ['view'] },
        outcome: 'error',
        errorCode: 'MONGO_ERROR',
      });
    });
  });

  it('keeps document bodies and the confirm token out of the record', () => {
    const recs = [
      auditRecordFor(IPC_CHANNELS.docInsertMany, { ...T, docsJson: '[{"secret":"BODY"}]' }, okEnv({ insertedCount: 1, insertedIds: ['BODY-ID'] })),
      auditRecordFor(IPC_CHANNELS.docUpdateOne, { ...T, filterJson: '{}', updateJson: '{"$set":{"s":"BODY"}}' }, okEnv({ matchedCount: 1, modifiedCount: 1 })),
      auditRecordFor(IPC_CHANNELS.docDeleteMany, { ...T, filterJson: '{}', confirmToken: 'BODY-TOKEN' }, okEnv({ deletedCount: 1 })),
      auditRecordFor(IPC_CHANNELS.docUpdateMany, { ...T, filterJson: '{}', updateJson: '{"$set":{"s":"BODY"}}', confirmToken: 'BODY-TOKEN' }, okEnv({ matchedCount: 1, modifiedCount: 1 })),
    ];
    expect(JSON.stringify(recs)).not.toContain('BODY');
  });

  it('ignores a count that is not a number', () => {
    expect(auditRecordFor(IPC_CHANNELS.docDeleteOne, { ...T, filterJson: '{}' }, okEnv({ deletedCount: '1' }))!.summary)
      .toEqual({ op: 'deleteOne', filter: '{}', deletedCount: undefined });
    expect(auditRecordFor(IPC_CHANNELS.docDeleteOne, { ...T, filterJson: '{}' }, okEnv(null))!.summary)
      .toEqual({ op: 'deleteOne', filter: '{}', deletedCount: undefined });
  });

  it('records a failure with the envelope code and no counts', () => {
    const rec = auditRecordFor(
      IPC_CHANNELS.docDeleteOne,
      { ...T, filterJson: '{"_id":1}' },
      errEnv({ code: 'UNAUTHORIZED', message: 'nope', details: { deletedCount: 5, insertedCount: 2 } }),
    );
    // `toStrictEqual`, not `toEqual`: deleteOne is neither insertMany nor
    // import, so the insertedCount branch must never run for it even though
    // `details.insertedCount` is present — `toEqual` treats a key present as
    // `undefined` the same as a key absent, which would hide an
    // `insertedCount: undefined` the branch adds to `summary` if it ran.
    expect(rec).toStrictEqual({
      ...T,
      op: 'deleteOne',
      summary: { op: 'deleteOne', filter: '{"_id":1}', deletedCount: undefined },
      outcome: 'error',
      errorCode: 'UNAUTHORIZED',
    });
  });

  it('records an insertMany that stopped part-way as partial, and one that inserted nothing as error', () => {
    const input = { ...T, docsJson: '[]' };
    expect(auditRecordFor(IPC_CHANNELS.docInsertMany, input, errEnv({ code: 'CONFLICT', message: 'dup', details: { insertedCount: 3 } })))
      .toMatchObject({ outcome: 'partial', errorCode: 'CONFLICT', summary: { op: 'insertMany', insertedCount: 3 } });
    expect(auditRecordFor(IPC_CHANNELS.docInsertMany, input, errEnv({ code: 'CONFLICT', message: 'dup', details: { insertedCount: 0 } })))
      .toMatchObject({ outcome: 'error', errorCode: 'CONFLICT', summary: { op: 'insertMany', insertedCount: 0 } });
    expect(auditRecordFor(IPC_CHANNELS.docInsertMany, input, errEnv({ code: 'NETWORK', message: 'down' })))
      .toEqual({ ...T, op: 'insertMany', summary: { op: 'insertMany', insertedCount: undefined }, outcome: 'error', errorCode: 'NETWORK' });
  });

  describe('import', () => {
    const input = { ...T, path: '/home/me/exports/people.json' };
    const report = (over: Record<string, unknown> = {}) =>
      ({ fileName: 'people.json', format: 'jsonl', inserted: 5, failed: 0, errors: [], errorsTruncated: false, ...over });

    it('records a clean import as ok, naming only the file', () => {
      expect(auditRecordFor(IPC_CHANNELS.dataImport, input, okEnv(report()))).toEqual({
        ...T,
        op: 'import',
        summary: { op: 'import', fileName: 'people.json', format: 'jsonl', insertedCount: 5, failedCount: 0 },
        outcome: 'ok',
        errorCode: null,
      });
    });

    it('records an import with rejected documents as partial, however many landed', () => {
      expect(auditRecordFor(IPC_CHANNELS.dataImport, input, okEnv(report({ failed: 2 }))))
        .toMatchObject({ outcome: 'partial', errorCode: null, summary: { insertedCount: 5, failedCount: 2 } });
      expect(auditRecordFor(IPC_CHANNELS.dataImport, input, okEnv(report({ inserted: 0, failed: 1 }))))
        .toMatchObject({ outcome: 'partial' });
    });

    it('keeps the format only when the report states a known one', () => {
      expect(auditRecordFor(IPC_CHANNELS.dataImport, input, okEnv(report({ format: 'json' })))!.summary)
        .toMatchObject({ format: 'json' });
      expect(auditRecordFor(IPC_CHANNELS.dataImport, input, okEnv(report({ format: 'csv' })))!.summary)
        .toMatchObject({ format: 'csv' });
      expect(auditRecordFor(IPC_CHANNELS.dataImport, input, okEnv(report({ format: 'xml' })))!.summary)
        .toEqual({ op: 'import', fileName: 'people.json', format: undefined, insertedCount: 5, failedCount: 0 });
      expect(auditRecordFor(IPC_CHANNELS.dataImport, input, okEnv(null))!.summary)
        .toEqual({ op: 'import', fileName: 'people.json', format: undefined, insertedCount: undefined, failedCount: undefined });
    });

    it('records a failed import by file name, partial when earlier batches landed', () => {
      expect(auditRecordFor(IPC_CHANNELS.dataImport, input, errEnv({ code: 'READ_ONLY', message: 'ro' }))).toEqual({
        ...T,
        op: 'import',
        summary: { op: 'import', fileName: 'people.json', format: undefined, insertedCount: undefined, failedCount: undefined },
        outcome: 'error',
        errorCode: 'READ_ONLY',
      });
      expect(auditRecordFor(IPC_CHANNELS.dataImport, input, errEnv({ code: 'NETWORK', message: 'down', details: { insertedCount: 2000 } })))
        .toEqual({
          ...T,
          op: 'import',
          summary: { op: 'import', fileName: 'people.json', format: undefined, insertedCount: 2000, failedCount: undefined },
          outcome: 'partial',
          errorCode: 'NETWORK',
        });
      expect(auditRecordFor(IPC_CHANNELS.dataImport, input, errEnv({ code: 'INTERNAL', message: 'eacces', details: { insertedCount: 0 } })))
        .toMatchObject({ outcome: 'error', summary: { insertedCount: 0 } });
    });

    it('records a cancelled import as partial and carries cancelled in the summary', () => {
      expect(auditRecordFor(IPC_CHANNELS.dataImport, input, okEnv(report({ cancelled: true, inserted: 1000, failed: 0 }))))
        .toMatchObject({ outcome: 'partial', summary: { insertedCount: 1000, cancelled: true } });
    });

    it('omits cancelled from the summary when the run was not cancelled', () => {
      expect(auditRecordFor(IPC_CHANNELS.dataImport, input, okEnv(report()))!.summary).toEqual({
        op: 'import',
        fileName: 'people.json',
        format: 'jsonl',
        insertedCount: 5,
        failedCount: 0,
      });
    });

    it('takes a failed import\'s format from an extension that settles it, never from .json', () => {
      const failed = (p: string) =>
        auditRecordFor(IPC_CHANNELS.dataImport, { ...T, path: p }, errEnv({ code: 'READ_ONLY', message: 'ro' }))!.summary;
      expect(failed('/d/a.jsonl')).toMatchObject({ fileName: 'a.jsonl', format: 'jsonl' });
      expect(failed('/d/a.NDJSON')).toMatchObject({ format: 'jsonl' });
      expect(failed('/d/a.json')).toMatchObject({ format: undefined });
      expect(failed('/d/a.jsonl.bak')).toMatchObject({ format: undefined });
      expect(failed('/d/a.Csv')).toMatchObject({ format: 'csv' });
      expect(failed('/d/a.csv.bak')).toMatchObject({ format: undefined });
      expect(auditRecordFor(IPC_CHANNELS.dataImport, { ...T, path: '/d/a.jsonl' }, okEnv({ format: 'json' }))!.summary)
        .toMatchObject({ format: 'json' });
    });
  });
});
