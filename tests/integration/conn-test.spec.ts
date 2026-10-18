import { describe, it, expect, afterEach, beforeAll, beforeEach } from 'vitest';
import { ConnectionRepo } from '../../electron/db/repositories/ConnectionRepo';
import {
  ConnectionService,
  connectionReader,
} from '../../electron/mongo/ConnectionService';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { MongoPool } from '../../electron/mongo/MongoPool';
import type { ConnectionInput } from '@shared/types';
import { createTempDb, type TempDb } from '../helpers/db';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { getSharedMongoUri, uriToHostPort } from '../helpers/mongo';

function testInput(
  hp: { host: string; port: number },
  overrides: Partial<ConnectionInput> = {},
): ConnectionInput {
  return {
    name: 'probe-test',
    color: '#1A6835',
    connectionType: 'standard',
    readOnly: false,
    host: hp.host,
    port: hp.port,
    authMech: 'none',
    tls: { enabled: false, verify: true },
    advanced: {
      connectTimeoutMs: 5000,
      socketTimeoutMs: 5000,
      serverSelectionTimeoutMs: 5000,
      readPreference: 'primary',
      maxPoolSize: 5,
      directConnection: true,
    },
    ...overrides,
  };
}

describe('ConnectionService.test', () => {
  let tmp: TempDb;
  let svc: ConnectionService;
  let hp: { host: string; port: number };

  beforeAll(async () => {
    hp = uriToHostPort(getSharedMongoUri());
  });

  beforeEach(() => {
    tmp = createTempDb();
    const repo = new ConnectionRepo(tmp.db);
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const pool = new MongoPool({ repo: connectionReader(repo, vault), vault });
    svc = new ConnectionService({ repo, vault, pool });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('returns ok for a reachable server', async () => {
    const r = await svc.test(testInput(hp));
    expect(r.ok).toBe(true);
    expect(r.serverVersion).toMatch(/^\d/);
    expect(typeof r.roundTripMs).toBe('number');
  });

  it('does not persist a connection row or secret', async () => {
    await svc.test(
      testInput(hp, {
        authMech: 'scram256',
        authUsername: 'test',
        password: 'ignored',
      }),
    );
    const rows = tmp.db.prepare('SELECT COUNT(*) AS c FROM connections').get() as { c: number };
    const secrets = tmp.db.prepare('SELECT COUNT(*) AS c FROM connection_secrets').get() as { c: number };
    expect(rows.c).toBe(0);
    expect(secrets.c).toBe(0);
  });

  it('returns errorCode for unreachable host', async () => {
    const r = await svc.test(testInput({ host: '127.0.0.1', port: 1 }, {
      advanced: {
        connectTimeoutMs: 1000,
        socketTimeoutMs: 1000,
        serverSelectionTimeoutMs: 1000,
        readPreference: 'primary',
        maxPoolSize: 1,
        directConnection: true,
      },
    }));
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBeDefined();
    expect(r.errorCode).not.toBe('AUTH');
  });

  it('refuses SSH without touching the network', async () => {
    const r = await svc.test(
      testInput(hp, { ssh: { enabled: true, host: 'bastion.example.com', port: 22 } }),
    );
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/SSH tunnels/i);
  });

  it('allows SCRAM input without a password (probe may test wrong creds)', async () => {
    // Memory mongo has no auth set up, so a SCRAM probe errors — but it should
    // not be rejected at validation time for missing password.
    const r = await svc.test(
      testInput(hp, { authMech: 'scram256', authUsername: 'someone' }),
    );
    expect(r).toBeDefined();
    // The pool layer may say ok or AUTH depending on memory mongo config;
    // either outcome is fine for this test, the point is it didn't throw VALIDATION.
  });
});
