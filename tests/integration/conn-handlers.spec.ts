import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { createRouter } from '../../electron/ipc/router';
import { registerConnChannels } from '../../electron/ipc/handlers/conn';
import { IPC_CHANNELS } from '../../shared/ipc';
import { ConflictError, NotFoundError, ValidationError } from '../../electron/errors';
import { ConnectionService, connectionReader } from '../../electron/mongo/ConnectionService';
import { ConnectionRepo } from '../../electron/db/repositories/ConnectionRepo';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { createTempDb, type TempDb } from '../helpers/db';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import type { Envelope } from '../../shared/ipc';
import type { Connection, ConnectionInput, ConnectionSummary, ProbeResult } from '@shared/types';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';
import { createPickedCredentialPaths } from '../../electron/security/credentialPaths';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

// The router never reads the event (`_evt` in router.ts), so the shim stands
// one in rather than constructing a real Electron event.

function createShim() {
  const handlers = new Map<string, Handler>();
  return {
    ipcMain: {
      handle(channel: string, fn: Handler) {
        handlers.set(channel, fn);
      },
    } as const,
    async invoke<T>(channel: string, payload: unknown): Promise<Envelope<T>> {
      const h = handlers.get(channel);
      if (!h) throw new Error(`no handler for ${channel}`);
      return (await h(invokeEvent, payload)) as Envelope<T>;
    },
  };
}

function fakeConnection(over: Partial<Connection> = {}): Connection {
  return {
    id: 'c1',
    name: 'test',
    color: '#1A6835',
    connectionType: 'standard',
    readOnly: false,
    host: 'localhost',
    port: 27017,
    authMech: 'none',
    tls: { enabled: false, verify: true },
    advanced: {
      connectTimeoutMs: 5000,
      socketTimeoutMs: 5000,
      serverSelectionTimeoutMs: 5000,
      readPreference: 'primary',
      maxPoolSize: 5,
      directConnection: false,
    },
    hasPasswordStored: false,
    hasSshPasswordStored: false,
    hasSshPassphraseStored: false,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    ...over,
  } as Connection;
}

function stubSvc(overrides: Partial<ConnectionService> = {}): ConnectionService {
  const base: Partial<ConnectionService> = {
    list: () => [] as ConnectionSummary[],
    get: () => fakeConnection(),
    create: async (input) => fakeConnection({ name: input.name }),
    update: async (id) => fakeConnection({ id }),
    delete: async () => undefined,
    touchUsed: () => undefined,
    storedCredentialPaths: () => [],
    parseUri: () => ({ input: {}, warnings: [] }),
    test: async () => ({ ok: true, serverVersion: '7.0.0', topology: 'Single' }) as ProbeResult,
  };
  return { ...base, ...overrides } as ConnectionService;
}

/**
 * P1-13: handler-layer integration tests for SECRET_INPUT-carrying channels.
 * Drives `createRouter` directly so Zod + envelope + error-mapping glue is
 * exercised end-to-end. Service is stubbed so each test isolates the
 * handler/router behavior, not the underlying business logic.
 */
describe('conn:* handlers via router', () => {
  let shim: ReturnType<typeof createShim>;
  let svc: ConnectionService;

  beforeEach(() => {
    shim = createShim();
  });

  function setupWith(overrides: Partial<ConnectionService> = {}) {
    svc = stubSvc(overrides);
    const router = createRouter(shim.ipcMain, testSenderCheck);
    registerConnChannels(router, svc, createPickedCredentialPaths());
  }

  it('conn:list returns an envelope wrapping the service result', async () => {
    const summaries: ConnectionSummary[] = [
      {
        id: 'c1',
        name: 'one',
        color: '#1A6835',
        host: 'localhost',
        port: 27017,
        connectionType: 'standard',
        readOnly: false,
        status: 'disconnected',
      },
    ];
    setupWith({ list: () => summaries });
    const env = await shim.invoke<ConnectionSummary[]>(IPC_CHANNELS.connList, undefined);
    expect(env).toEqual({ ok: true, data: summaries });
  });

  it('conn:create validates the input — missing required fields fail with VALIDATION code', async () => {
    setupWith();
    const env = await shim.invoke<Connection>(IPC_CHANNELS.connCreate, {
      // missing host / port / authMech / advanced etc.
      name: 'incomplete',
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('conn:create with a valid SECRET_INPUT payload reaches the service and returns a Connection envelope', async () => {
    const createSpy = vi.fn(async () => fakeConnection({ name: 'with-secret' }));
    setupWith({ create: createSpy });
    const env = await shim.invoke<Connection>(IPC_CHANNELS.connCreate, {
      name: 'with-secret',
      color: '#1A6835',
      connectionType: 'standard',
      readOnly: false,
      host: 'localhost',
      port: 27017,
      authMech: 'scram256',
      authUsername: 'user',
      password: 'plaintext-secret',
      authDatabase: 'admin',
      tls: { enabled: false, verify: true },
      advanced: {
        connectTimeoutMs: 5000,
        socketTimeoutMs: 5000,
        serverSelectionTimeoutMs: 5000,
        readPreference: 'primary',
        maxPoolSize: 5,
        directConnection: false,
      },
    });
    expect(env.ok).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);
    if (env.ok) expect(env.data.name).toBe('with-secret');
  });

  it('conn:update maps NotFoundError to NOT_FOUND code', async () => {
    setupWith({
      update: async () => {
        throw new NotFoundError('no such connection', { id: 'missing' });
      },
    });
    const env = await shim.invoke<Connection>(IPC_CHANNELS.connUpdate, {
      id: 'missing',
      patch: { name: 'whatever' },
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('NOT_FOUND');
  });

  it('conn:update maps ConflictError to CONFLICT code', async () => {
    setupWith({
      update: async () => {
        throw new ConflictError('duplicate name', { field: 'name' });
      },
    });
    const env = await shim.invoke<Connection>(IPC_CHANNELS.connUpdate, {
      id: 'c1',
      patch: { name: 'dupe' },
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('CONFLICT');
  });

  it('conn:test forwards the probe result through the envelope', async () => {
    const probe: ProbeResult = { ok: true, serverVersion: '7.0.0', topology: 'Single' };
    const testSpy = vi.fn(async () => probe);
    setupWith({ test: testSpy });
    const env = await shim.invoke<ProbeResult>(IPC_CHANNELS.connTest, {
      name: 'probe',
      color: '#1A6835',
      connectionType: 'standard',
      readOnly: false,
      host: 'localhost',
      port: 27017,
      authMech: 'none',
      tls: { enabled: false, verify: true },
      advanced: {
        connectTimeoutMs: 5000,
        socketTimeoutMs: 5000,
        serverSelectionTimeoutMs: 5000,
        readPreference: 'primary',
        maxPoolSize: 5,
        directConnection: false,
      },
    });
    expect(env).toEqual({ ok: true, data: probe });
    expect(testSpy).toHaveBeenCalledTimes(1);
  });

  it('conn:get with missing id fails Zod (VALIDATION)', async () => {
    setupWith();
    const env = await shim.invoke<Connection>(IPC_CHANNELS.connGet, { id: '' });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('conn:delete maps ValidationError thrown by the service', async () => {
    setupWith({
      delete: async () => {
        throw new ValidationError('cannot delete active connection', { id: 'c1' });
      },
    });
    const env = await shim.invoke<{ id: string }>(IPC_CHANNELS.connDelete, { id: 'c1' });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });
});

/**
 * `conn:getUri` builds the navigator's "Copy connection string" from the
 * saved connection. A real `ConnectionService` over a real vault, because the
 * property under test is that the stored password never reaches the URI, and a
 * stubbed `Connection` never holds a password to leak.
 */
describe('conn:getUri', () => {
  const PASSWORD = 'p@ss:w/rd%42';
  let tmp: TempDb;
  let shim: ReturnType<typeof createShim>;
  let svc: ConnectionService;

  beforeEach(() => {
    tmp = createTempDb();
    shim = createShim();
    const repo = new ConnectionRepo(tmp.db);
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    const pool = new MongoPool({ repo: connectionReader(repo, vault), vault });
    svc = new ConnectionService({ repo, vault, pool });
    registerConnChannels(createRouter(shim.ipcMain, testSenderCheck), svc, createPickedCredentialPaths());
  });

  afterEach(() => tmp.cleanup());

  it('returns the URI with the username and without the stored password', async () => {
    const { advanced, tls } = fakeConnection();
    const conn = await svc.create({
      name: 'Secured',
      color: '#1A6835',
      connectionType: 'standard',
      readOnly: false,
      host: 'localhost',
      port: 27017,
      tls,
      advanced,
      authMech: 'scram256',
      authUsername: 'alice',
      authDatabase: 'admin',
      password: PASSWORD,
    } satisfies ConnectionInput);
    expect(svc.get(conn.id).hasPasswordStored).toBe(true);

    const env = await shim.invoke<{ uri: string }>(IPC_CHANNELS.connGetUri, { id: conn.id });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.data.uri).toBe('mongodb://alice@localhost:27017/?authSource=admin&authMechanism=SCRAM-SHA-256&readPreference=primary&tls=false');
    expect(env.data.uri).not.toContain(PASSWORD);
    expect(env.data.uri).not.toContain(encodeURIComponent(PASSWORD));
  });

  it('maps an unknown id to NOT_FOUND', async () => {
    const env = await shim.invoke(IPC_CHANNELS.connGetUri, { id: 'nope' });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('NOT_FOUND');
  });
});
