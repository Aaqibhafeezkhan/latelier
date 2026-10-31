import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { createRouter } from '../../electron/ipc/router';
import { registerSavedChannels } from '../../electron/ipc/handlers/saved';
import { registerTabsChannels } from '../../electron/ipc/handlers/tabs';
import { registerRecentChannels } from '../../electron/ipc/handlers/recent';
import { SavedQueryRepo } from '../../electron/db/repositories/SavedQueryRepo';
import { SavedQueryService } from '../../electron/services/SavedQueryService';
import { WorkspaceTabRepo } from '../../electron/db/repositories/WorkspaceTabRepo';
import { WorkspaceStateService } from '../../electron/services/WorkspaceStateService';
import { RecentQueryRepo } from '../../electron/db/repositories/RecentQueryRepo';
import { RecentQueryService } from '../../electron/services/RecentQueryService';
import { RecentFieldValueRepo } from '../../electron/db/repositories/RecentFieldValueRepo';
import { RecentFieldValueService } from '../../electron/services/RecentFieldValueService';
import { createTempDb, insertConnectionRow, type TempDb, createTempCipher } from '../helpers/db';
import { createIpcShim } from '../helpers/ipcShim';
import { testSenderCheck } from '../helpers/ipcSender';

/**
 * Every table with a foreign key to `connections` that a channel can write
 * with a renderer-supplied `connectionId`. SQLite refuses the row, and the
 * repo has to turn that into the NOT_FOUND the pool and `conn:*` channels
 * already answer for an unknown connection, not let the raw
 * `FOREIGN KEY constraint failed` cross IPC as INTERNAL.
 *
 * `refs:create` is covered in refs-handlers.spec.ts. Not here, on purpose:
 * `recent_queries` rows are written after a run on a connection the pool
 * already resolved (fire-and-forget, never part of a reply), `audit_log`
 * rows by the router's audit sink (a failed write is logged and the envelope
 * stands), and `connection_secrets` only after `ConnectionService` has
 * loaded or inserted the connection row.
 */
const REAL = 'fk-real-conn';
const GHOST = 'fk-no-such-conn';

const FIND_PAYLOAD = {
  kind: 'find',
  builder: { projection: [], sort: '', limit: '' },
  queryRaw: '{}',
};

const cases: Array<{
  channel: string;
  /** The table a successful call inserts one row into. */
  table: string;
  payload: (connectionId: string) => unknown;
}> = [
  {
    channel: IPC_CHANNELS.savedCreate,
    table: 'saved_queries',
    payload: (connectionId) => ({
      connectionId,
      dbName: 'd',
      collection: 'c',
      kind: 'find',
      name: 'q',
      payload: FIND_PAYLOAD,
    }),
  },
  {
    channel: IPC_CHANNELS.tabsOpenCollection,
    table: 'workspace_tabs',
    payload: (connectionId) => ({ connectionId, dbName: 'd', collection: 'c' }),
  },
  {
    channel: IPC_CHANNELS.tabsOpenAggregation,
    table: 'workspace_tabs',
    payload: (connectionId) => ({ connectionId, dbName: 'd', collection: 'c' }),
  },
  {
    channel: IPC_CHANNELS.tabsOpenDefault,
    table: 'workspace_tabs',
    payload: (connectionId) => ({ connectionId, dbName: 'd', collection: 'c' }),
  },
  {
    // The placeholder-tab branch: no db, no collection.
    channel: IPC_CHANNELS.tabsOpenDefault,
    table: 'workspace_tabs',
    payload: (connectionId) => ({ connectionId }),
  },
  {
    channel: IPC_CHANNELS.tabsOpenScript,
    table: 'workspace_tabs',
    payload: (connectionId) => ({ connectionId }),
  },
  {
    channel: IPC_CHANNELS.recentRecordFieldValues,
    table: 'recent_field_values',
    payload: (connectionId) => ({
      connectionId,
      dbName: 'd',
      collection: 'c',
      entries: [{ field: 'name', value: 'x', valType: 'string', op: '$eq' }],
    }),
  },
];

describe('writes naming an unknown connection answer NOT_FOUND, not INTERNAL', () => {
  let tmp: TempDb;
  const shim = createIpcShim();

  beforeAll(() => {
    tmp = createTempDb();
    insertConnectionRow(tmp.db, REAL);
    const router = createRouter(shim.ipcMain, testSenderCheck);
    const savedSvc = new SavedQueryService(new SavedQueryRepo(tmp.db, createTempCipher()));
    registerSavedChannels(router, savedSvc);
    registerTabsChannels(router, new WorkspaceStateService(new WorkspaceTabRepo(tmp.db, createTempCipher()), savedSvc));
    registerRecentChannels(
      router,
      new RecentQueryService(new RecentQueryRepo(tmp.db, createTempCipher())),
      new RecentFieldValueService(new RecentFieldValueRepo(tmp.db, createTempCipher())),
    );
  });

  afterAll(() => {
    tmp.cleanup();
  });

  const count = (table: string): number =>
    (tmp.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it.each(cases.map((c, i) => [`${c.channel} #${i}`, c] as const))(
    '%s',
    async (_name, { channel, payload }) => {
      const env = await shim.invoke(channel, payload(GHOST));
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe('NOT_FOUND');
      expect(env.error.message).toBe(`connection ${GHOST} not found`);
    },
  );

  it('stored nothing for the unknown connection', () => {
    expect(count('saved_queries')).toBe(0);
    expect(count('workspace_tabs')).toBe(0);
    expect(count('recent_field_values')).toBe(0);
  });

  // The control: the same payloads against a connection that exists insert
  // exactly one row, so the NOT_FOUND above is the foreign key and not a broken
  // payload. The tables are emptied first because the tab channels reuse an
  // open tab for the same target (or, with no target, any tab of the
  // connection) instead of inserting, which would let a control pass without
  // ever reaching the repo.
  it.each(cases.map((c, i) => [`${c.channel} #${i}`, c] as const))(
    'inserts one row for the same payload against an existing connection: %s',
    async (_name, { channel, table, payload }) => {
      for (const t of ['saved_queries', 'workspace_tabs', 'recent_field_values']) {
        tmp.db.prepare(`DELETE FROM ${t}`).run();
      }
      const env = await shim.invoke(channel, payload(REAL));
      expect(env.ok).toBe(true);
      expect(count(table)).toBe(1);
    },
  );
});

// `rethrowMissingConnection` reads any foreign-key violation on these tables as
// "the connection does not exist", which holds only while `connection_id` is
// the sole foreign key. A later migration that adds a second one must fail
// here, not ship as a mislabelled NOT_FOUND.
describe('tables written with a caller-supplied connectionId have connection_id as their only foreign key', () => {
  it.each(['saved_queries', 'workspace_tabs', 'reference_rules', 'recent_field_values', 'recent_queries'])(
    '%s',
    (table) => {
      const tmp = createTempDb();
      try {
        const fks = tmp.db.prepare(`PRAGMA foreign_key_list(${table})`).all();
        expect(fks).toHaveLength(1);
        expect(fks[0]).toMatchObject({ from: 'connection_id', table: 'connections' });
      } finally {
        tmp.cleanup();
      }
    },
  );
});
