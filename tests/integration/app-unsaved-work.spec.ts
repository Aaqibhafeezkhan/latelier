import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

vi.mock('electron', () => ({ dialog: {}, shell: {} }));

// Imports must come after the mock so the handler binds to the stub.
const { createRouter } = await import('../../electron/ipc/router');
const { registerAppChannels } = await import('../../electron/ipc/handlers/app');
const { IPC_CHANNELS } = await import('../../shared/ipc');
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';
import { createPickedCredentialPaths } from '../../electron/security/credentialPaths';
import type { UnsavedWorkStore } from '../../electron/quitGuard';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;
type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

describe('app:setUnsavedWork', () => {
  const handlers = new Map<string, Handler>();
  let store: UnsavedWorkStore;
  const report = async (payload: unknown) =>
    (await handlers.get(IPC_CHANNELS.appSetUnsavedWork)!(invokeEvent, payload)) as Envelope<void>;

  function register(unsaved?: UnsavedWorkStore) {
    handlers.clear();
    const router = createRouter({ handle: (c: string, fn: Handler) => void handlers.set(c, fn) }, testSenderCheck);
    registerAppChannels(router, () => null, new Set(), createPickedCredentialPaths(), undefined, unsaved);
  }

  beforeEach(() => {
    store = { connectionForm: 0, pipelines: 0 };
    register(store);
  });

  it('sets each source in the store, each report replacing the last', async () => {
    expect((await report({ source: 'connectionForm', count: 1 })).ok).toBe(true);
    expect((await report({ source: 'pipelines', count: 3 })).ok).toBe(true);
    expect(store).toEqual({ connectionForm: 1, pipelines: 3 });
    await report({ source: 'pipelines', count: 0 });
    expect(store).toEqual({ connectionForm: 1, pipelines: 0 });
  });

  it.each([
    ['an unknown source', { source: 'scripts', count: 1 }],
    ['a negative count', { source: 'pipelines', count: -1 }],
    ['a fractional count', { source: 'pipelines', count: 1.5 }],
    ['a count over the cap', { source: 'pipelines', count: 1001 }],
    ['a missing count', { source: 'pipelines' }],
  ])('rejects %s without touching the store', async (_label, payload) => {
    const res = await report(payload);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('VALIDATION');
    expect(store).toEqual({ connectionForm: 0, pipelines: 0 });
  });

  it('accepts the cap itself', async () => {
    expect((await report({ source: 'pipelines', count: 1000 })).ok).toBe(true);
    expect(store.pipelines).toBe(1000);
  });

  it('fails as INTERNAL when no store was given', async () => {
    register();
    const res = await report({ source: 'connectionForm', count: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INTERNAL');
  });
});

describe('app:flushDone', () => {
  const handlers = new Map<string, Handler>();
  const done = async (payload: unknown) =>
    (await handlers.get(IPC_CHANNELS.appFlushDone)!(invokeEvent, payload)) as Envelope<void>;

  function register(onFlushDone?: () => void) {
    handlers.clear();
    const router = createRouter({ handle: (c: string, fn: Handler) => void handlers.set(c, fn) }, testSenderCheck);
    registerAppChannels(router, () => null, new Set(), createPickedCredentialPaths(), undefined, undefined, onFlushDone);
  }

  it('hands the answer to the sink', async () => {
    const sink = vi.fn();
    register(sink);
    expect((await done({})).ok).toBe(true);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a string', 'x'],
    ['a number', 42],
    ['an array', [1]],
  ])('rejects %s without calling the sink', async (_label, payload) => {
    const sink = vi.fn();
    register(sink);
    const res = await done(payload);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('VALIDATION');
    expect(sink).not.toHaveBeenCalled();
  });

  it('fails as INTERNAL when no sink was given', async () => {
    register();
    const res = await done({});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INTERNAL');
  });
});
