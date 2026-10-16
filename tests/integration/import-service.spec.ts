import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Collection, Decimal128, Long, MongoClient, MongoNetworkError, ObjectId } from 'mongodb';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { createReadStream } from 'node:fs';
import { ImportService, jsonlRecords } from '../../electron/mongo/ImportService';
import { importDigest, undoCaptureOf } from '../../electron/mongo/undo';
import type { SecretsVault } from '../../electron/secrets/SecretsVault';
import type { CsvColumnMapping, CsvColumnType } from '../../shared/types';
import { getSharedServer, makeConnection, makeReader, uriToHostPort } from '../helpers/mongo';

describe('ImportService.importFile', () => {
  let server: MongoMemoryServer;
  let client: MongoClient;
  let pool: MongoPool;
  let svc: ImportService;
  let dir: string;
  let dbName: string;
  const coll = 'people';

  beforeAll(async () => {
    server = await getSharedServer();
    const hp = uriToHostPort(server.getUri());
    client = await MongoClient.connect(server.getUri());
    pool = new MongoPool({
      repo: makeReader([makeConnection('c1', hp), makeConnection('c-ro', hp, { readOnly: true })]),
      vault: { get: () => null } as unknown as SecretsVault,
    });
  }, 60_000);

  afterAll(async () => {
    await pool.disconnectAll();
    await client.close();
  });

  beforeEach(async () => {
    svc = new ImportService(pool);
    dbName = `import_${randomUUID().slice(0, 8)}`;
    await client.db(dbName).createCollection(coll);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latelier-import-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await client.db(dbName).dropDatabase();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function file(name: string, content: string): Promise<string> {
    const p = path.join(dir, name);
    await fs.writeFile(p, content, 'utf8');
    return p;
  }

  const run = (p: string, over: Record<string, string> = {}) =>
    svc.importFile({ connectionId: 'c1', dbName, collection: coll, path: p, ...over });

  const stored = () => client.db(dbName).collection(coll).find({}, { sort: { _id: 1 } }).toArray();

  it('imports a JSON array, reviving canonical and relaxed EJSON', async () => {
    const oid = new ObjectId();
    const p = await file('people.json', JSON.stringify([
      { _id: { $oid: oid.toHexString() }, n: { $numberDecimal: '1.5' } },
      { _id: 'b', at: { $date: '2024-01-02T03:04:05Z' }, age: 7 },
    ]));
    const report = await run(p);
    expect(report).toEqual({ fileName: 'people.json', format: 'json', inserted: 2, failed: 0, errors: [], errorsTruncated: false, cancelled: false });
    const docs = await client.db(dbName).collection(coll).find().toArray();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    expect(byId.get(oid.toHexString())!.n).toEqual(Decimal128.fromString('1.5'));
    expect(byId.get('b')!.at).toEqual(new Date('2024-01-02T03:04:05Z'));
  });

  // JSON.parse rounds a bare integer past 2^53, so what the file says as
  // 9007199254740993 used to land as 9007199254740992. Both formats, and the
  // server-side $type, not only what the driver hands back.
  it.each([
    ['a JSON array', 'big.json', '[{"_id":1,"n":9007199254740993,"m":-9223372036854775808,"d":1.5e18}]'],
    ['JSONL', 'big.jsonl', '{"_id":1,"n":9007199254740993,"m":-9223372036854775808,"d":1.5e18}\n'],
  ])('imports a bare integer past 2^53 from %s as an exact int64, and a double spelling as a double (#279)', async (_name, fileName, content) => {
    const report = await run(await file(fileName, content));
    expect(report.inserted).toBe(1);
    const c = client.db(dbName).collection(coll);
    expect(await c.countDocuments({ n: { $type: 'long' }, m: { $type: 'long' }, d: { $type: 'double' } })).toBe(1);
    const doc = (await c.findOne({ _id: 1 as never }, { promoteLongs: false }))!;
    expect((doc.n as Long).toString()).toBe('9007199254740993');
    expect((doc.m as Long).toString()).toBe('-9223372036854775808');
    expect(doc.d).toBe(1.5e18);
  });

  it('imports JSONL, skipping blank lines and a leading BOM', async () => {
    const p = await file('people.jsonl', '﻿{"_id":1}\r\n\n{"_id":2}\n   \n{"_id":3}');
    const report = await run(p);
    expect(report).toMatchObject({ format: 'jsonl', inserted: 3, failed: 0 });
    expect((await stored()).map((d) => d._id)).toEqual([1, 2, 3]);
  });

  it('reads a .json file whose content is one document per line as JSONL', async () => {
    const p = await file('export.json', '﻿  \n{"_id":1}\n{"_id":2}\n');
    const report = await run(p);
    expect(report).toMatchObject({ fileName: 'export.json', format: 'jsonl', inserted: 2 });
  });

  it('treats an empty file as no documents', async () => {
    expect(await run(await file('empty.json', ''))).toMatchObject({ format: 'jsonl', inserted: 0, failed: 0 });
  });

  it('reports a malformed line by its line number, blank lines counted, and imports the rest', async () => {
    const p = await file('bad.jsonl', '{"_id":1}\n\n{"_id":2,\n[1,2]\n{"_id":3}\n');
    const report = await run(p);
    expect(report.inserted).toBe(2);
    expect(report.failed).toBe(2);
    expect(report.errors.map((e) => e.at)).toEqual([3, 4]);
    expect(report.errors[0]!.message).toMatch(/^invalid document: /);
    expect(report.errors[1]!.message).toMatch(/expected a document/);
  });

  it('reports a non-document array element by its index, not failing the file', async () => {
    const p = await file('mixed.json', '[{"_id":1}, 5, {"when":{"$date":"not a date"}}, {"_id":2}]');
    const report = await run(p);
    expect(report).toMatchObject({ inserted: 2, failed: 2 });
    expect(report.errors.map((e) => e.at)).toEqual([1, 2]);
  });

  it('refuses a JSON array that is not valid JSON', async () => {
    const p = await file('broken.json', '[{"_id":1},');
    await expect(run(p)).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/^invalid JSON array/) });
    expect(await stored()).toEqual([]);
  });

  it('reports a duplicate _id against its line and inserts the rest', async () => {
    await client.db(dbName).collection(coll).insertOne({ _id: 2 } as never);
    const p = await file('dup.jsonl', '{"_id":1}\n{"_id":2}\n{"_id":3}\n');
    const report = await run(p);
    expect(report).toMatchObject({ inserted: 2, failed: 1 });
    expect(report.errors).toEqual([{ at: 2, message: expect.stringMatching(/E11000/) }]);
  });

  it('maps a write error in a later batch back to its own line', async () => {
    svc = new ImportService(pool, { batchSize: 2 });
    await client.db(dbName).collection(coll).insertOne({ _id: 4 } as never);
    const p = await file('dup.jsonl', '{"_id":1}\n{"_id":2}\n{"_id":3}\n{"_id":4}\n{"_id":5}\n');
    const report = await run(p);
    expect(report).toMatchObject({ inserted: 4, failed: 1 });
    expect(report.errors.map((e) => e.at)).toEqual([4]);
  });

  it('inserts 2500 documents in batches of 1000', async () => {
    const spy = vi.spyOn(Collection.prototype, 'insertMany');
    const lines = Array.from({ length: 2500 }, (_, i) => JSON.stringify({ _id: i })).join('\n');
    const report = await run(await file('many.jsonl', lines));
    expect(report.inserted).toBe(2500);
    expect(spy.mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual([1000, 1000, 500]);
    expect(spy.mock.calls.every((c) => (c[1] as { ordered?: boolean }).ordered === false)).toBe(true);
  });

  it('lists the first 50 failures and counts the rest', async () => {
    const lines = Array.from({ length: 53 }, () => 'nope').join('\n');
    const report = await run(await file('junk.jsonl', lines));
    expect(report.failed).toBe(53);
    expect(report.errors).toHaveLength(50);
    expect(report.errors[49]!.at).toBe(50);
    expect(report.errorsTruncated).toBe(true);
  });

  it('refuses a read-only connection before touching the file', async () => {
    const statSpy = vi.spyOn(fs, 'stat');
    await expect(
      svc.importFile({ connectionId: 'c-ro', dbName, collection: coll, path: path.join(dir, 'missing.json') }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(statSpy).not.toHaveBeenCalled();
  });

  it('refuses a collection that does not exist, and a view', async () => {
    const p = await file('a.jsonl', '{"_id":1}');
    await expect(run(p, { collection: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await client.db(dbName).createCollection('v', { viewOn: coll, pipeline: [] });
    await expect(run(p, { collection: 'v' })).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/view/) });
    expect(await client.db(dbName).listCollections({ name: 'nope' }).toArray()).toEqual([]);
  });

  it('refuses a JSON array over the size cap, but not JSONL of the same size', async () => {
    svc = new ImportService(pool, { maxArrayBytes: 20 });
    const array = await file('big.json', '[{"_id":1},{"_id":2},{"_id":3}]');
    await expect(run(array)).rejects.toMatchObject({ code: 'VALIDATION', details: { maxBytes: 20 } });
    const lines = await file('big-lines.json', '{"_id":1}\n{"_id":2}\n{"_id":3}\n');
    expect((await run(lines)).inserted).toBe(3);
  });

  it('refuses a relative path, an extension outside the allow-list, and a directory', async () => {
    await expect(run('people.json')).rejects.toMatchObject({ code: 'VALIDATION', details: { field: 'path' } });
    await expect(run(await file('people.txt', 'a\n1'))).rejects.toMatchObject({ code: 'VALIDATION', details: { field: 'path' } });
    await fs.mkdir(path.join(dir, 'folder.json'));
    await expect(run(path.join(dir, 'folder.json'))).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/not a file/) });
  });

  it('reports a file that does not exist as INTERNAL, not a Mongo error', async () => {
    await expect(run(path.join(dir, 'gone.jsonl'))).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringMatching(/failed to open import file: .*ENOENT/),
    });
  });

  it.skipIf(process.getuid?.() === 0)('reports a file it may not read as INTERNAL, for either format', async () => {
    const lines = await file('locked.jsonl', '{"_id":1}\n');
    const array = await file('locked.json', '[{"_id":1}]');
    await fs.chmod(lines, 0o000);
    await fs.chmod(array, 0o000);
    await expect(run(lines)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringMatching(/failed to read import file: .*EACCES/),
      details: { insertedCount: 0 },
    });
    await expect(run(array)).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringMatching(/EACCES/) });
  });

  it('a failure after earlier batches landed carries insertedCount', async () => {
    svc = new ImportService(pool, { batchSize: 2 });
    const real = Collection.prototype.insertMany;
    let calls = 0;
    vi.spyOn(Collection.prototype, 'insertMany').mockImplementation(function (this: Collection, ...args) {
      calls++;
      if (calls === 2) return Promise.reject(new MongoNetworkError('connection reset'));
      return real.apply(this, args as Parameters<typeof real>);
    });
    const p = await file('net.jsonl', '{"_id":1}\n{"_id":2}\n{"_id":3}\n{"_id":4}\n');
    await expect(run(p)).rejects.toMatchObject({ code: 'NETWORK', message: expect.stringMatching(/connection reset/), details: { insertedCount: 2 } });
  });

  describe('runningCount', () => {
    const jsonl = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ _id: i })).join('\n');

    it('counts an import in flight, tokened or not, and not after it ends', async () => {
      const p = await file('rc.jsonl', jsonl(3));
      const seen: number[] = [];
      const spy = vi.spyOn(Collection.prototype, 'insertMany').mockImplementation(async () => {
        seen.push(svc.runningCount());
        return { insertedCount: 3, insertedIds: {}, acknowledged: true } as never;
      });
      expect(svc.runningCount()).toBe(0);
      await run(p);
      await svc.importFile({ connectionId: 'c1', dbName, collection: coll, path: p, cancelToken: 'rc-tok' });
      spy.mockRestore();
      expect(seen).toEqual([1, 1]);
      expect(svc.runningCount()).toBe(0);
    });

    it('stops counting a cancelled import and one that fails to parse', async () => {
      svc = new ImportService(pool, { batchSize: 1, emit: () => svc.cancel('rc-cancel') });
      const p = await file('rc2.jsonl', jsonl(3));
      const report = await svc.importFile({ connectionId: 'c1', dbName, collection: coll, path: p, cancelToken: 'rc-cancel' });
      expect(report.cancelled).toBe(true);
      expect(svc.runningCount()).toBe(0);
      const bad = await file('rc3.json', '[{"_id":1},');
      await expect(run(bad)).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(svc.runningCount()).toBe(0);
    });
  });

  describe('cancel', () => {
    it('cancels after the first batch of a 2500-doc file, keeping only what landed', async () => {
      const events: { processed: number; inserted: number; failed: number }[] = [];
      svc = new ImportService(pool, {
        batchSize: 1000,
        emit: (e) => {
          events.push({ processed: e.processed, inserted: e.inserted, failed: e.failed });
          if (events.length === 1) svc.cancel('tok');
        },
      });
      const lines = Array.from({ length: 2500 }, (_, i) => JSON.stringify({ _id: i })).join('\n');
      const p = await file('many.jsonl', lines);
      const report = await svc.importFile({ connectionId: 'c1', dbName, collection: coll, path: p, cancelToken: 'tok' });
      expect(report.inserted).toBe(1000);
      expect(report.cancelled).toBe(true);
      expect(await stored()).toHaveLength(1000);
    });

    it('emits progress events with processed monotonically non-decreasing', async () => {
      const processed: number[] = [];
      svc = new ImportService(pool, {
        batchSize: 500,
        emit: (e) => processed.push(e.processed),
      });
      const lines = Array.from({ length: 1500 }, (_, i) => JSON.stringify({ _id: i })).join('\n');
      const p = await file('progress.jsonl', lines);
      await svc.importFile({ connectionId: 'c1', dbName, collection: coll, path: p, cancelToken: 'progress-tok' });
      expect(processed.length).toBeGreaterThan(0);
      for (let i = 1; i < processed.length; i++) expect(processed[i]).toBeGreaterThanOrEqual(processed[i - 1]!);
      expect(processed.at(-1)).toBe(1500);
    });

    it('never emits without a cancelToken', async () => {
      const emit = vi.fn();
      svc = new ImportService(pool, { batchSize: 10, emit });
      const p = await file('nocancel.jsonl', Array.from({ length: 25 }, (_, i) => JSON.stringify({ _id: i })).join('\n'));
      await svc.importFile({ connectionId: 'c1', dbName, collection: coll, path: p });
      expect(emit).not.toHaveBeenCalled();
    });

    it('unregisters the cancel token when the file fails to parse', async () => {
      const p = await file('broken-tok.json', '[{"_id":1},');
      await expect(
        svc.importFile({ connectionId: 'c1', dbName, collection: coll, path: p, cancelToken: 'parse-fail' }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect((svc as unknown as { active: Map<string, unknown> }).active.size).toBe(0);
    });

    it('destroys the JSONL read stream when the import stops before EOF', async () => {
      // Well past one 64 KiB read chunk, so the stream can't hit EOF (and
      // auto-close) on its own before the consumer stops.
      const p = await file('big.jsonl', Array.from({ length: 5000 }, (_, i) => JSON.stringify({ _id: i, pad: 'x'.repeat(40) })).join('\n'));
      const stream = createReadStream(p, { encoding: 'utf8' });
      for await (const record of jsonlRecords(stream, () => {})) {
        expect(record).toMatchObject({ at: 1 });
        break;
      }
      expect(stream.destroyed).toBe(true);
    });
  });

  describe('CSV', () => {
    const col = (header: string, type: CsvColumnType = 'string', emptyAsNull = false): CsvColumnMapping =>
      ({ header, type, emptyAsNull });
    const runCsv = (p: string, columns: CsvColumnMapping[]) =>
      svc.importFile({ connectionId: 'c1', dbName, collection: coll, path: p, csv: { columns } });

    it('imports each row through its column mapping, nesting dotted headers', async () => {
      const oid = new ObjectId();
      const p = await file('people.csv', [
        '\uFEFF_id,name,age,active,born,ref,addr.city,addr.zip,note,nick',
        `1,Ann,42,TRUE,2024-01-02T03:04:05Z,${oid.toHexString()},Paris,75001,"a, ""quoted""\nnote",`,
        '2,Bob,,false,2020-05-06,,,,x,',
      ].join('\r\n'));
      const report = await runCsv(p, [
        col('_id', 'number'), col('name'), col('age', 'number', true), col('active', 'boolean'), col('born', 'date'),
        col('ref', 'objectId'), col('addr.city'), col('addr.zip'), col('note', 'skip'), col('nick', 'string', true),
      ]);
      expect(report).toEqual({ fileName: 'people.csv', format: 'csv', inserted: 2, failed: 0, errors: [], errorsTruncated: false, cancelled: false });
      expect(await stored()).toEqual([
        { _id: 1, name: 'Ann', age: 42, active: true, born: new Date('2024-01-02T03:04:05Z'), ref: oid, addr: { city: 'Paris', zip: '75001' }, nick: null },
        { _id: 2, name: 'Bob', age: null, active: false, born: new Date('2020-05-06'), nick: null },
      ]);
    });

    it('reports a cell that will not convert by its spreadsheet row, and imports the rest', async () => {
      const p = await file('ages.csv', 'name,age\nann,3\n\nbob,old\ncid,4,extra\ndan,5\n');
      const report = await runCsv(p, [col('name'), col('age', 'number')]);
      expect(report).toMatchObject({ format: 'csv', inserted: 2, failed: 2 });
      expect(report.errors).toEqual([
        { at: 4, message: 'column "age": not a number' },
        { at: 5, message: '3 fields, but the header row has 2' },
      ]);
      expect((await stored()).map((d) => d.name).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(['ann', 'dan']);
    });

    it('refuses a CSV without a mapping, a mapping for another format, and a mapping the file has outgrown — before writing', async () => {
      const p = await file('people.csv', 'a,b\n1,2\n');
      await expect(run(p)).rejects.toMatchObject({ code: 'VALIDATION', details: { field: 'csv' } });
      const json = await file('people.jsonl', '{"_id":1}\n');
      await expect(runCsv(json, [col('a')])).rejects.toMatchObject({ code: 'VALIDATION', details: { field: 'csv' } });
      await expect(runCsv(p, [col('a')])).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/header row/) });
      await expect(runCsv(p, [col('a'), col('a')])).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/header row/) });
      await expect(runCsv(await file('clash.csv', 'a,a.b\n1,2\n'), [col('a'), col('a.b')]))
        .rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/same field/) });
      await expect(runCsv(await file('open.csv', 'a\n"1\n'), [col('a')]))
        .rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/never closes/) });
      expect(await stored()).toEqual([]);
    });

    it('refuses a CSV over the size cap', async () => {
      svc = new ImportService(pool, { maxArrayBytes: 5 });
      const p = await file('big.csv', 'a\n1\n2\n3\n');
      await expect(runCsv(p, [col('a')])).rejects.toMatchObject({
        code: 'VALIDATION', message: expect.stringMatching(/^a CSV file over 5 bytes/), details: { maxBytes: 5 },
      });
      await expect(svc.previewCsv(p)).rejects.toMatchObject({ code: 'VALIDATION', details: { maxBytes: 5 } });
    });

    it('captures digests that match what the server stored', async () => {
      const p = await file('undo.csv', `_id,when,ref,a.b\n1,2024-01-02,${new ObjectId().toHexString()},x\n`);
      const report = await runCsv(p, [col('_id', 'number'), col('when', 'date'), col('ref', 'objectId'), col('a.b')]);
      const [doc] = await stored();
      expect(undoCaptureOf(report)?.digests).toEqual([importDigest(doc!)]);
    });

    describe('previewCsv', () => {
      it('returns the file name, header, first rows and inferred types', async () => {
        const p = await file('people.csv', 'name,age\nann,3\nbob,\n');
        expect(await svc.previewCsv(p)).toEqual({
          fileName: 'people.csv',
          headers: ['name', 'age'],
          rows: [['ann', '3'], ['bob', '']],
          inferred: ['string', 'number'],
        });
      });

      it('reads only an absolute path to a .csv file', async () => {
        await expect(svc.previewCsv('people.csv')).rejects.toMatchObject({ code: 'VALIDATION', details: { field: 'path' } });
        await expect(svc.previewCsv(await file('people.jsonl', '{"_id":1}\n')))
          .rejects.toMatchObject({ code: 'VALIDATION', message: 'only a .csv file has a column preview' });
        await expect(svc.previewCsv(await file('secret.pem', 'x'))).rejects.toMatchObject({ code: 'VALIDATION', details: { field: 'path' } });
        await expect(svc.previewCsv(path.join(dir, 'gone.csv'))).rejects.toMatchObject({ code: 'INTERNAL' });
        await expect(svc.previewCsv(await file('empty.csv', ''))).rejects.toMatchObject({ code: 'VALIDATION', message: 'the CSV file is empty' });
      });
    });
  });

  describe('undo capture (X13 §5 option (b))', () => {
    it('captures an id + digest per landed document, up to the injectable ceiling', async () => {
      svc = new ImportService(pool, { maxUndoCaptureDocs: 2 });
      const p = await file('small.jsonl', '{"_id":1,"n":"a"}\n{"_id":2,"n":"b"}\n');
      const report = await run(p);
      const capture = undoCaptureOf(report);
      expect(capture?.importedIds).toEqual([1, 2]);
      expect(capture?.digests).toHaveLength(2);
      expect(capture?.digests?.[0]).toBe(importDigest({ _id: 1, n: 'a' }));
      expect(capture?.digests?.[0]).not.toBe(capture?.digests?.[1]);
    });

    it('keeps nothing above the injectable ceiling', async () => {
      svc = new ImportService(pool, { maxUndoCaptureDocs: 2 });
      const p = await file('over.jsonl', '{"_id":1}\n{"_id":2}\n{"_id":3}\n');
      const report = await run(p);
      expect(report.inserted).toBe(3);
      expect(undoCaptureOf(report)).toBeUndefined();
    });

    it('captures nothing when nothing landed', async () => {
      const p = await file('junk.jsonl', 'nope\n');
      const report = await run(p);
      expect(report.inserted).toBe(0);
      expect(undoCaptureOf(report)).toBeUndefined();
    });

    it('only captures the documents that actually landed in a batch with a write error', async () => {
      await client.db(dbName).collection(coll).insertOne({ _id: 2 } as never);
      const p = await file('dup.jsonl', '{"_id":1}\n{"_id":2}\n{"_id":3}\n');
      const report = await run(p);
      expect(report).toMatchObject({ inserted: 2, failed: 1 });
      expect(undoCaptureOf(report)?.importedIds).toEqual([1, 3]);
    });

    it('still captures what landed before a cancel', async () => {
      svc = new ImportService(pool, {
        batchSize: 1,
        emit: () => svc.cancel('tok'),
      });
      const p = await file('cancel.jsonl', '{"_id":1}\n{"_id":2}\n{"_id":3}\n');
      const report = await svc.importFile({ connectionId: 'c1', dbName, collection: coll, path: p, cancelToken: 'tok' });
      expect(report.cancelled).toBe(true);
      expect(report.inserted).toBe(1);
      expect(undoCaptureOf(report)?.importedIds).toEqual([1]);
    });
  });
});
