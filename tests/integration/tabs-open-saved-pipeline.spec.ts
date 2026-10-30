import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import type { CollectionTab, SavedQuery } from '@shared/types';
import { createRouter } from '../../electron/ipc/router';
import { registerSavedChannels } from '../../electron/ipc/handlers/saved';
import { registerTabsChannels } from '../../electron/ipc/handlers/tabs';
import { SavedQueryRepo } from '../../electron/db/repositories/SavedQueryRepo';
import { SavedQueryService } from '../../electron/services/SavedQueryService';
import { WorkspaceTabRepo } from '../../electron/db/repositories/WorkspaceTabRepo';
import { WorkspaceStateService } from '../../electron/services/WorkspaceStateService';
import { createTempDb, insertConnectionRow, type TempDb, createTempCipher } from '../helpers/db';
import { createIpcShim } from '../helpers/ipcShim';
import { testSenderCheck } from '../helpers/ipcSender';

/**
 * `tabs:openAggregation` with a `savedId`, through the real router, zod
 * validators, services and a temp SQLite file. The service spec skips the
 * router, and `tabs-handlers.spec.ts` stubs the service, so neither shows that
 * a refused open crosses as a typed code instead of INTERNAL, or that the stages
 * a tab opens with are the ones `saved:create` stored.
 */
const CONN = 'open-saved-conn';
const STAGES = [{ id: 2, op: '$match', body: '{ status: "open" }', enabled: true }];

describe('tabs:openAggregation with a savedId, via router', () => {
  let tmp: TempDb;
  let shim: ReturnType<typeof createIpcShim>;

  async function createSaved(overrides: Record<string, unknown> = {}): Promise<SavedQuery> {
    const env = await shim.invoke<SavedQuery>(IPC_CHANNELS.savedCreate, {
      connectionId: CONN,
      dbName: 'shop',
      collection: 'orders',
      kind: 'aggregation',
      name: 'open orders',
      payload: { kind: 'aggregation', stages: STAGES },
      ...overrides,
    });
    if (!env.ok) throw new Error(`saved:create failed: ${env.error.code} ${env.error.message}`);
    return env.data;
  }

  const open = (savedId: string) =>
    shim.invoke<CollectionTab>(IPC_CHANNELS.tabsOpenAggregation, {
      connectionId: CONN,
      dbName: 'shop',
      collection: 'orders',
      savedId,
      name: 'open orders',
    });

  const tabCount = () =>
    (tmp.db.prepare('SELECT COUNT(*) AS n FROM workspace_tabs').get() as { n: number }).n;

  beforeEach(() => {
    tmp = createTempDb();
    insertConnectionRow(tmp.db, CONN);
    shim = createIpcShim();
    const router = createRouter(shim.ipcMain, testSenderCheck);
    const savedSvc = new SavedQueryService(new SavedQueryRepo(tmp.db, createTempCipher()));
    registerSavedChannels(router, savedSvc);
    registerTabsChannels(router, new WorkspaceStateService(new WorkspaceTabRepo(tmp.db, createTempCipher()), savedSvc));
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('opens the tab with the stored stages', async () => {
    const row = await createSaved();

    const env = await open(row.id);

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.state.aggregation).toMatchObject({ stages: STAGES, savedId: row.id });
  });

  it('answers NOT_FOUND for an unknown saved id and opens no tab', async () => {
    const env = await open('no-such-row');

    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('NOT_FOUND');
    expect(tabCount()).toBe(0);
  });

  it('answers VALIDATION for a saved query that is not a pipeline and opens no tab', async () => {
    const find = await createSaved({
      kind: 'find',
      name: 'a find',
      payload: { kind: 'find', builder: { projection: [], sort: '', limit: '' }, queryRaw: '{}' },
    });

    const env = await open(find.id);

    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('VALIDATION');
    expect(env.error.message).toContain('"a find"');
    expect(tabCount()).toBe(0);
  });

  it('answers VALIDATION for a pipeline stored with malformed stages and opens no tab', async () => {
    const row = await createSaved();
    tmp.db
      .prepare('UPDATE saved_queries SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'aggregation', stages: 'abc' }), row.id);

    const env = await open(row.id);

    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe('VALIDATION');
    expect(env.error.message).toContain('"open orders" is unreadable');
    expect(tabCount()).toBe(0);
  });
});
