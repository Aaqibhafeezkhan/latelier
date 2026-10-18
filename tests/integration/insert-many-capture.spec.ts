import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { Int32, MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { DocumentService } from '../../electron/mongo/DocumentService';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { undoCaptureOf } from '../../electron/mongo/undo';
import type { Logger } from '../../electron/log';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, type TempDb } from '../helpers/db';
import { getSharedMongoUri, uriToHostPort, makeConnection, makeReader } from '../helpers/mongo';

// Only `asStored` is swapped, and only while `failCapture` is set: the one
// step of insertMany's Undo capture that runs after the write has landed.
const control = vi.hoisted(() => ({ failCapture: false, calls: 0 }));
vi.mock('../../electron/mongo/undo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/mongo/undo')>();
  return {
    ...actual,
    asStored: (doc: Parameters<typeof actual.asStored>[0]) => {
      control.calls++;
      if (control.failCapture) throw new Error('capture blew up');
      return actual.asStored(doc);
    },
  };
});

describe('DocumentService.insertMany — the Undo capture never costs the write', () => {
  let client: MongoClient;
  let tmp: TempDb;
  let pool: MongoPool;
  let log: Logger;
  let svc: DocumentService;
  let dbName: string;

  beforeAll(async () => {
    client = await MongoClient.connect(getSharedMongoUri());
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(() => {
    tmp = createTempDb();
    pool = new MongoPool({
      repo: makeReader([makeConnection('c1', uriToHostPort(getSharedMongoUri()))]),
      vault: new SecretsVault(tmp.db, createSafeStorageMock()),
    });
    log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    svc = new DocumentService(pool, { log });
    dbName = `capture_${randomUUID().slice(0, 8)}`;
    control.failCapture = false;
    control.calls = 0;
  });

  afterEach(async () => {
    await client.db(dbName).dropDatabase();
    svc.dispose();
    await pool.disconnectAll();
    tmp.cleanup();
  });

  const insert = (docs: unknown[]) =>
    svc.insertMany({ connectionId: 'c1', dbName, collection: 'c', docsJson: JSON.stringify(docs) });

  it('reports a landed insert as a success, without Undo, when the capture fails', async () => {
    control.failCapture = true;
    const res = await insert([{ _id: 1 }, { _id: 2 }]);

    expect(res.insertedCount).toBe(2);
    expect(undoCaptureOf(res)).toBeUndefined();
    expect(await client.db(dbName).collection('c').countDocuments()).toBe(2);
    expect(log.warn).toHaveBeenCalledWith('audit.capture', 'Pre-image not captured; this Operation cannot be undone', {
      message: 'capture blew up',
    });
  });

  it('keeps the capture when it succeeds', async () => {
    const res = await insert([{ _id: 1 }]);
    // Stored form: the JS number comes back as the Int32 the server holds.
    expect(undoCaptureOf(res)).toEqual({ insertedDocs: [{ _id: new Int32(1) }] });
  });

  it('converts nothing when the batch is over the capture ceiling', async () => {
    const res = await insert(Array.from({ length: 1001 }, (_, i) => ({ _id: i })));
    expect(res.insertedCount).toBe(1001);
    expect(undoCaptureOf(res)).toBeUndefined();
    expect(control.calls).toBe(0);
  });
});
