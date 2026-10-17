import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { createRouter } from '../../electron/ipc/router';
import { registerCollectionAdminChannels } from '../../electron/ipc/handlers/collectionAdmin';
import { IPC_CHANNELS } from '../../shared/ipc';
import { ConflictError, NotFoundError } from '../../electron/errors';
import type { CollectionAdminService } from '../../electron/mongo/CollectionAdminService';
import type { Envelope } from '../../shared/ipc';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';

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

function stubSvc(overrides: Partial<CollectionAdminService> = {}): CollectionAdminService {
  const base: Partial<CollectionAdminService> = {
    create: async (input) => ({ name: input.collection }),
    drop: async () => ({ dropped: true }),
    rename: async (input) => ({ name: input.newName }),
    dropDatabase: async () => ({ dropped: true as const }),
    modify: async () => ({ ok: true as const }),
  };
  return { ...base, ...overrides } as CollectionAdminService;
}

describe('collection:* / database:* handlers via router', () => {
  let shim: ReturnType<typeof createShim>;

  function setupWith(overrides: Partial<CollectionAdminService> = {}) {
    const svc = stubSvc(overrides);
    const router = createRouter(shim.ipcMain, testSenderCheck);
    registerCollectionAdminChannels(router, svc);
  }

  beforeEach(() => {
    shim = createShim();
  });

  it('collection:create rejects an empty name via Zod', async () => {
    setupWith();
    const env = await shim.invoke(IPC_CHANNELS.collectionCreate, {
      connectionId: 'c1',
      dbName: 'app',
      collection: '',
      options: {},
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('collection:create rejects a non-numeric capped size via Zod', async () => {
    setupWith();
    const env = await shim.invoke(IPC_CHANNELS.collectionCreate, {
      connectionId: 'c1',
      dbName: 'app',
      collection: 'orders',
      options: { capped: true, size: 'lots' },
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('collection:create with a valid payload forwards to the service', async () => {
    const spy = vi.fn(async (input: { collection: string }) => ({ name: input.collection }));
    setupWith({ create: spy as CollectionAdminService['create'] });
    const env = await shim.invoke(IPC_CHANNELS.collectionCreate, {
      connectionId: 'c1',
      dbName: 'app',
      collection: 'orders',
      options: { capped: true, size: 1000 },
    });
    expect(env).toEqual({ ok: true, data: { name: 'orders' } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('collection:create maps ConflictError to CONFLICT', async () => {
    setupWith({
      create: async () => {
        throw new ConflictError('collection already exists');
      },
    });
    const env = await shim.invoke(IPC_CHANNELS.collectionCreate, {
      connectionId: 'c1',
      dbName: 'app',
      collection: 'orders',
      options: {},
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('CONFLICT');
  });

  it('collection:drop rejects an empty collection via Zod', async () => {
    setupWith();
    const env = await shim.invoke(IPC_CHANNELS.collectionDrop, {
      connectionId: 'c1',
      dbName: 'app',
      collection: '',
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('collection:drop with a valid payload forwards to the service', async () => {
    const spy = vi.fn(async () => ({ dropped: true }));
    setupWith({ drop: spy });
    const env = await shim.invoke(IPC_CHANNELS.collectionDrop, {
      connectionId: 'c1',
      dbName: 'app',
      collection: 'orders',
    });
    expect(env).toEqual({ ok: true, data: { dropped: true } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('collection:rename rejects an empty newName via Zod', async () => {
    setupWith();
    const env = await shim.invoke(IPC_CHANNELS.collectionRename, {
      connectionId: 'c1',
      dbName: 'app',
      collection: 'orders',
      newName: '',
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('collection:rename maps NotFoundError to NOT_FOUND', async () => {
    setupWith({
      rename: async () => {
        throw new NotFoundError('source collection missing');
      },
    });
    const env = await shim.invoke(IPC_CHANNELS.collectionRename, {
      connectionId: 'c1',
      dbName: 'app',
      collection: 'ghost',
      newName: 'renamed',
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('NOT_FOUND');
  });

  it('database:drop rejects an empty dbName via Zod', async () => {
    setupWith();
    const env = await shim.invoke(IPC_CHANNELS.databaseDrop, {
      connectionId: 'c1',
      dbName: '',
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('database:drop with a valid payload forwards to the service', async () => {
    const spy = vi.fn(async () => ({ dropped: true as const }));
    setupWith({ dropDatabase: spy });
    const env = await shim.invoke(IPC_CHANNELS.databaseDrop, {
      connectionId: 'c1',
      dbName: 'app',
    });
    expect(env).toEqual({ ok: true, data: { dropped: true } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  describe('collection:modify', () => {
    const target = { connectionId: 'c1', dbName: 'app', collection: 'orders' };

    it.each([
      ['empty options', {}],
      ['viewOn without pipeline', { viewOn: 'src' }],
      ['pipeline without viewOn', { pipeline: '[]' }],
      ['validator mixed with view keys', { validator: '{}', viewOn: 'src', pipeline: '[]' }],
      ['validationLevel mixed with view keys', { validationLevel: 'strict', viewOn: 'src', pipeline: '[]' }],
      ['an unknown validationAction', { validationAction: 'ignore' }],
    ])('rejects %s with VALIDATION and never reaches the service', async (_label, options) => {
      const spy = vi.fn(async () => ({ ok: true as const }));
      setupWith({ modify: spy });
      const env = await shim.invoke(IPC_CHANNELS.collectionModify, { ...target, options });
      expect(env.ok).toBe(false);
      if (!env.ok) expect(env.error.code).toBe('VALIDATION');
      expect(spy).not.toHaveBeenCalled();
    });

    it.each([
      ['validation keys', { validator: '{}', validationLevel: 'moderate', validationAction: 'warn' }],
      ['view keys', { viewOn: 'src', pipeline: '[]' }],
      ['the errorAndLog action', { validationAction: 'errorAndLog' }],
    ])('forwards a valid payload with %s to the service', async (_label, options) => {
      const spy = vi.fn(async () => ({ ok: true as const }));
      setupWith({ modify: spy });
      const env = await shim.invoke(IPC_CHANNELS.collectionModify, { ...target, options });
      expect(env).toEqual({ ok: true, data: { ok: true } });
      expect(spy).toHaveBeenCalledWith({ ...target, options });
    });
  });

  it('collection:create rejects a pipeline without viewOn via Zod', async () => {
    const spy = vi.fn(async () => ({ name: 'v' }));
    setupWith({ create: spy });
    const env = await shim.invoke(IPC_CHANNELS.collectionCreate, {
      connectionId: 'c1',
      dbName: 'app',
      collection: 'v',
      options: { pipeline: '[]' },
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
    expect(spy).not.toHaveBeenCalled();
  });

  it('collection:create forwards viewOn + pipeline to the service', async () => {
    const spy = vi.fn(async (input: { collection: string }) => ({ name: input.collection }));
    setupWith({ create: spy as CollectionAdminService['create'] });
    const payload = { connectionId: 'c1', dbName: 'app', collection: 'v', options: { viewOn: 'src', pipeline: '[]' } };
    const env = await shim.invoke(IPC_CHANNELS.collectionCreate, payload);
    expect(env).toEqual({ ok: true, data: { name: 'v' } });
    expect(spy).toHaveBeenCalledWith(payload);
  });
});
