import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Db, MongoClient } from 'mongodb';
import { Double } from 'bson';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { UserService } from '../../electron/mongo/UserService';
import { ejsonParse } from '../../electron/mongo/ejson';
import { STATS_TIMEOUT_MS } from '../../electron/mongo/timeouts';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, type TempDb } from '../helpers/db';
import {
  getSharedMongoUri,
  uriToHostPort,
  makeConnection,
  makeReader,
} from '../helpers/mongo';

const SEED_DB = 'user_test';

async function seedUsers(uri: string): Promise<void> {
  const c = new MongoClient(uri);
  try {
    await c.connect();
    const db = c.db(SEED_DB);
    // Clean up first to make this test re-runnable.
    try {
      await db.command({ dropAllUsersFromDatabase: 1 });
    } catch {
      /* ignore */
    }
    await db.command({
      createUser: 'app_reader',
      pwd: 'pw1',
      roles: [{ role: 'read', db: SEED_DB }],
      mechanisms: ['SCRAM-SHA-256'],
    });
    await db.command({
      createUser: 'app_writer',
      pwd: 'pw2',
      roles: [{ role: 'readWrite', db: SEED_DB }],
      mechanisms: ['SCRAM-SHA-256'],
    });
  } finally {
    await c.close();
  }
}

async function teardownUsers(uri: string): Promise<void> {
  const c = new MongoClient(uri);
  try {
    await c.connect();
    try {
      await c.db(SEED_DB).command({ dropAllUsersFromDatabase: 1 });
    } catch {
      /* ignore */
    }
  } finally {
    await c.close();
  }
}

describe('UserService', () => {
  let hp: { host: string; port: number };
  let tmp: TempDb;
  let pool: MongoPool;
  let svc: UserService;
  const connId = 'conn-user';

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());
    await seedUsers(getSharedMongoUri());
  });

  afterAll(async () => {
    await teardownUsers(getSharedMongoUri());
  });

  afterEach(async () => {
    await pool?.disconnectAll();
    tmp?.cleanup();
  });

  function setup(): void {
    tmp = createTempDb();
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const conn = makeConnection(connId, hp, { defaultDb: SEED_DB });
    pool = new MongoPool({ repo: makeReader([conn]), vault });
    svc = new UserService(pool);
  }

  it('lists users scoped to a single database', async () => {
    setup();
    const users = await svc.list({ connectionId: connId, dbName: SEED_DB });
    const usernames = users.map((u) => u.username).sort();
    expect(usernames).toContain('app_reader');
    expect(usernames).toContain('app_writer');
    const reader = users.find((u) => u.username === 'app_reader')!;
    expect(reader.db).toBe(SEED_DB);
    expect(reader.external).toBe(false);
    expect(reader.roles).toEqual([{ role: 'read', db: SEED_DB }]);
    expect(reader.mechanisms).toContain('SCRAM-SHA-256');
  });

  it('lists users across all databases when dbName is omitted', async () => {
    setup();
    const users = await svc.list({ connectionId: connId });
    const seeded = users.filter((u) => u.db === SEED_DB);
    expect(seeded.length).toBeGreaterThanOrEqual(2);
  });

  it('get() returns the requested user; missing user surfaces NOT_FOUND', async () => {
    setup();
    const reader = await svc.get({
      connectionId: connId,
      dbName: SEED_DB,
      username: 'app_reader',
    });
    expect(reader.username).toBe('app_reader');

    let code: string | undefined;
    try {
      await svc.get({ connectionId: connId, dbName: SEED_DB, username: 'no_such_user' });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('NOT_FOUND');
  });

  it('listRoles() returns built-in roles for the admin db', async () => {
    setup();
    const roles = await svc.listRoles({ connectionId: connId, dbName: 'admin' });
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.some((r) => r.role === 'readWriteAnyDatabase' && r.isBuiltin)).toBe(true);
  });

  it('create / update / drop full lifecycle', async () => {
    setup();
    const lifecycleDb = 'user_lifecycle';
    // Create
    await svc.create({
      connectionId: connId,
      dbName: lifecycleDb,
      username: 'lc_user',
      password: 'pw',
      roles: [{ role: 'read', db: lifecycleDb }],
    });
    let users = await svc.list({ connectionId: connId, dbName: lifecycleDb });
    const before = users.find((u) => u.username === 'lc_user')!;
    expect(before.roles).toEqual([{ role: 'read', db: lifecycleDb }]);

    // Update — replace roles, no password change.
    await svc.update({
      connectionId: connId,
      dbName: lifecycleDb,
      username: 'lc_user',
      patch: { roles: [{ role: 'readWrite', db: lifecycleDb }] },
    });
    users = await svc.list({ connectionId: connId, dbName: lifecycleDb });
    const after = users.find((u) => u.username === 'lc_user')!;
    expect(after.roles).toEqual([{ role: 'readWrite', db: lifecycleDb }]);

    // Drop
    await svc.drop({ connectionId: connId, dbName: lifecycleDb, username: 'lc_user' });
    users = await svc.list({ connectionId: connId, dbName: lifecycleDb });
    expect(users.find((u) => u.username === 'lc_user')).toBeUndefined();
  });

  it('shows a Double past 2^53 in customData as a Double, not a rounded Long', async () => {
    setup();
    const customDb = 'user_custom_double';
    await svc.create({
      connectionId: connId,
      dbName: customDb,
      username: 'cd_user',
      password: 'pw',
      roles: [{ role: 'read', db: customDb }],
      customData: '{"big":{"$numberDouble":"1760000000000000768"},"small":{"$numberInt":"5"}}',
    });
    try {
      const user = await svc.get({ connectionId: connId, dbName: customDb, username: 'cd_user' });
      expect(JSON.parse(user.customData!)).toEqual({
        big: { $numberDouble: '1760000000000000768.0' },
        small: { $numberInt: '5' },
      });
      const shown = ejsonParse<{ big: Double }>(user.customData!);
      expect(shown.big).toBeInstanceOf(Double);
      expect(shown.big.valueOf()).toBe(1760000000000000768);
    } finally {
      await svc.drop({ connectionId: connId, dbName: customDb, username: 'cd_user' });
    }
  });

  it('create() returns CONFLICT on duplicate username', async () => {
    setup();
    const dupDb = 'user_dup';
    await svc.create({
      connectionId: connId,
      dbName: dupDb,
      username: 'dup',
      password: 'pw',
      roles: [{ role: 'read', db: dupDb }],
    });
    let code: string | undefined;
    try {
      await svc.create({
        connectionId: connId,
        dbName: dupDb,
        username: 'dup',
        password: 'pw2',
        roles: [{ role: 'read', db: dupDb }],
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('CONFLICT');
    await svc.drop({ connectionId: connId, dbName: dupDb, username: 'dup' });
  });

  it('drop() returns NOT_FOUND when the user does not exist', async () => {
    setup();
    let code: string | undefined;
    try {
      await svc.drop({
        connectionId: connId,
        dbName: SEED_DB,
        username: 'no_such_user_at_all',
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('NOT_FOUND');
  });

  it('update() with empty patch surfaces VALIDATION', async () => {
    setup();
    let code: string | undefined;
    try {
      await svc.update({
        connectionId: connId,
        dbName: SEED_DB,
        username: 'app_reader',
        patch: {},
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('VALIDATION');
  });

  // create/update/drop take a write grant (which refuses first);
  // list()/get() are reads and must stay unguarded. Registers a
  // second, read-only connection against the same shared server so each test
  // proves both the rejection AND that the identical call still works on the
  // writable connection (regression guard).
  describe('read-only connection guard', () => {
    const rwConnId = 'user-guard-rw';
    const roConnId = 'user-guard-ro';

    function setupGuard(): void {
      tmp = createTempDb();
      const vault = new SecretsVault(tmp.db, createSafeStorageMock());
      const rwConn = makeConnection(rwConnId, hp, { defaultDb: SEED_DB });
      const roConn = makeConnection(roConnId, hp, { defaultDb: SEED_DB, readOnly: true });
      pool = new MongoPool({ repo: makeReader([rwConn, roConn]), vault });
      svc = new UserService(pool);
    }

    it('list() and get() still work on the read-only connection', async () => {
      setupGuard();
      const users = await svc.list({ connectionId: roConnId, dbName: SEED_DB });
      expect(users.map((u) => u.username)).toContain('app_reader');

      const reader = await svc.get({ connectionId: roConnId, dbName: SEED_DB, username: 'app_reader' });
      expect(reader.username).toBe('app_reader');
    });

    it('create rejects on the read-only connection and succeeds on the writable one', async () => {
      setupGuard();
      const guardDb = 'user_ro_guard_create';
      await expect(
        svc.create({
          connectionId: roConnId,
          dbName: guardDb,
          username: 'ro_guard_user',
          password: 'pw',
          roles: [{ role: 'read', db: guardDb }],
        }),
      ).rejects.toMatchObject({ code: 'READ_ONLY' });
      const afterReject = await svc.list({ connectionId: rwConnId, dbName: guardDb });
      expect(afterReject.find((u) => u.username === 'ro_guard_user')).toBeUndefined();

      await svc.create({
        connectionId: rwConnId,
        dbName: guardDb,
        username: 'ro_guard_user',
        password: 'pw',
        roles: [{ role: 'read', db: guardDb }],
      });
      const afterCreate = await svc.list({ connectionId: rwConnId, dbName: guardDb });
      expect(afterCreate.find((u) => u.username === 'ro_guard_user')).toBeDefined();
    });

    it('update rejects on the read-only connection and succeeds on the writable one', async () => {
      setupGuard();
      const guardDb = 'user_ro_guard_update';
      await svc.create({
        connectionId: rwConnId,
        dbName: guardDb,
        username: 'ro_guard_update_user',
        password: 'pw',
        roles: [{ role: 'read', db: guardDb }],
      });

      await expect(
        svc.update({
          connectionId: roConnId,
          dbName: guardDb,
          username: 'ro_guard_update_user',
          patch: { roles: [{ role: 'readWrite', db: guardDb }] },
        }),
      ).rejects.toMatchObject({ code: 'READ_ONLY' });
      let users = await svc.list({ connectionId: rwConnId, dbName: guardDb });
      expect(users.find((u) => u.username === 'ro_guard_update_user')?.roles).toEqual([
        { role: 'read', db: guardDb },
      ]);

      await svc.update({
        connectionId: rwConnId,
        dbName: guardDb,
        username: 'ro_guard_update_user',
        patch: { roles: [{ role: 'readWrite', db: guardDb }] },
      });
      users = await svc.list({ connectionId: rwConnId, dbName: guardDb });
      expect(users.find((u) => u.username === 'ro_guard_update_user')?.roles).toEqual([
        { role: 'readWrite', db: guardDb },
      ]);
    });

    it('drop rejects on the read-only connection and succeeds on the writable one', async () => {
      setupGuard();
      const guardDb = 'user_ro_guard_drop';
      await svc.create({
        connectionId: rwConnId,
        dbName: guardDb,
        username: 'ro_guard_drop_user',
        password: 'pw',
        roles: [{ role: 'read', db: guardDb }],
      });

      await expect(
        svc.drop({ connectionId: roConnId, dbName: guardDb, username: 'ro_guard_drop_user' }),
      ).rejects.toMatchObject({ code: 'READ_ONLY' });
      let users = await svc.list({ connectionId: rwConnId, dbName: guardDb });
      expect(users.find((u) => u.username === 'ro_guard_drop_user')).toBeDefined();

      await svc.drop({ connectionId: rwConnId, dbName: guardDb, username: 'ro_guard_drop_user' });
      users = await svc.list({ connectionId: rwConnId, dbName: guardDb });
      expect(users.find((u) => u.username === 'ro_guard_drop_user')).toBeUndefined();
    });
  });

  // list/get/create/update/drop/listRoles used to send admin commands with no
  // maxTimeMS at all. `db.command`'s options object doesn't carry maxTimeMS
  // (only CSOT's `timeoutMS`, the mechanism this ticket's spec correction
  // rejects) — the bound has to be a field on the command document itself, so
  // assert it landed there rather than in the options argument.
  describe('every admin command carries maxTimeMS', () => {
    it('list/get/listRoles/create/update/drop all send maxTimeMS on the command document', async () => {
      setup();
      const cmdDb = 'user_maxtimems_db';
      // Warm the connection first — connect()'s own buildInfo probe also
      // goes through Db.prototype.command and would otherwise show up in
      // the spy with no maxTimeMS, which isn't this service's concern.
      await svc.list({ connectionId: connId, dbName: SEED_DB });

      const commandSpy = vi.spyOn(Db.prototype, 'command');

      await svc.list({ connectionId: connId, dbName: SEED_DB });
      await svc.get({ connectionId: connId, dbName: SEED_DB, username: 'app_reader' });
      await svc.listRoles({ connectionId: connId, dbName: 'admin' });
      await svc.create({
        connectionId: connId,
        dbName: cmdDb,
        username: 'maxtimems_user',
        password: 'pw',
        roles: [{ role: 'read', db: cmdDb }],
      });
      await svc.update({
        connectionId: connId,
        dbName: cmdDb,
        username: 'maxtimems_user',
        patch: { roles: [{ role: 'readWrite', db: cmdDb }] },
      });
      await svc.drop({ connectionId: connId, dbName: cmdDb, username: 'maxtimems_user' });

      expect(commandSpy.mock.calls.length).toBeGreaterThan(0);
      for (const call of commandSpy.mock.calls) {
        const cmd = call[0] as { maxTimeMS?: number };
        expect(cmd.maxTimeMS).toBe(STATS_TIMEOUT_MS);
      }
      commandSpy.mockRestore();
    });
  });
});
