import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const openExternalSpy = vi.fn(async (url: string) => {
  void url;
  return undefined;
});

vi.mock('electron', () => ({
  shell: { openExternal: (url: string) => openExternalSpy(url) },
}));

// Imports must come after the mock so the handler binds to the stub.
const { createRouter } = await import('../../electron/ipc/router');
const { registerDocsChannels } = await import('../../electron/ipc/handlers/docs');
const { IPC_CHANNELS } = await import('../../shared/ipc');
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
    async invoke<T>(channel: string, payload: unknown) {
      const h = handlers.get(channel);
      if (!h) throw new Error(`no handler for ${channel}`);
      return (await h(invokeEvent, payload)) as { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
    },
  };
}

describe('docs:openExternal', () => {
  let shim: ReturnType<typeof createShim>;

  beforeEach(() => {
    openExternalSpy.mockClear();
    shim = createShim();
    const router = createRouter(shim.ipcMain, testSenderCheck);
    registerDocsChannels(router);
  });

  it('opens a MongoDB docs URL via electron.shell.openExternal', async () => {
    const url = 'https://www.mongodb.com/docs/manual/reference/operator/aggregation/match/';
    const env = await shim.invoke<{ opened: true }>(IPC_CHANNELS.docsOpenExternal, { url });
    expect(env).toEqual({ ok: true, data: { opened: true } });
    expect(openExternalSpy).toHaveBeenCalledWith(url);
  });

  it('opens the normalised href, not the raw string', async () => {
    const env = await shim.invoke<{ opened: true }>(IPC_CHANNELS.docsOpenExternal, {
      url: 'https://WWW.MongoDB.com/docs/manual/',
    });
    expect(env.ok).toBe(true);
    expect(openExternalSpy).toHaveBeenCalledWith('https://www.mongodb.com/docs/manual/');
  });

  it.each([
    ['userinfo trick', 'https://www.mongodb.com@evil.example/docs/'],
    ['userinfo on the real host', 'https://user@www.mongodb.com/docs/'],
    ['explicit port', 'https://www.mongodb.com:8443/docs/'],
    ['a path outside /docs/', 'https://www.mongodb.com/pricing'],
    ['a path that only looks like /docs/', 'https://www.mongodb.com/docs-evil/'],
    ['a dot-segment escape out of /docs/', 'https://www.mongodb.com/docs/../pricing'],
    ['a different MongoDB host', 'https://mongodb.com/docs/'],
    ['a subdomain lookalike', 'https://www.mongodb.com.evil.example/docs/'],
  ])('rejects %s', async (_label, url) => {
    const env = await shim.invoke<unknown>(IPC_CHANNELS.docsOpenExternal, { url });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
    expect(openExternalSpy).not.toHaveBeenCalled();
  });

  it('rejects URLs outside the MongoDB docs prefix', async () => {
    const env = await shim.invoke<unknown>(IPC_CHANNELS.docsOpenExternal, {
      url: 'https://evil.example.com/phishing',
    });
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe('VALIDATION');
    }
    expect(openExternalSpy).not.toHaveBeenCalled();
  });

  it('rejects plain http docs URLs', async () => {
    const env = await shim.invoke<unknown>(IPC_CHANNELS.docsOpenExternal, {
      url: 'http://www.mongodb.com/docs/manual/',
    });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
    expect(openExternalSpy).not.toHaveBeenCalled();
  });

  it('rejects non-string payloads via zod', async () => {
    const env = await shim.invoke<unknown>(IPC_CHANNELS.docsOpenExternal, { url: 123 });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
    expect(openExternalSpy).not.toHaveBeenCalled();
  });
});
