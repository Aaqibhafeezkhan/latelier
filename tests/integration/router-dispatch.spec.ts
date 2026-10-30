import { describe, it, expect, beforeEach } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { createRouter } from '../../electron/ipc/router';
import { zodValidator } from '../../electron/ipc/validators';
import { ValidationError, NotFoundError } from '../../electron/errors';
import type { Envelope } from '@shared/ipc';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';

/**
 * Minimal ipcMain shim mirroring Electron's handle() contract.
 */
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

describe('router', () => {
  let shim: ReturnType<typeof createShim>;

  beforeEach(() => {
    shim = createShim();
  });

  it('dispatches a successful call', async () => {
    const router = createRouter(shim.ipcMain, testSenderCheck);
    router.register(
      'test:echo',
      zodValidator(z.object({ x: z.number() })),
      (input) => ({ doubled: input.x * 2 }),
    );
    const env = await shim.invoke<{ doubled: number }>('test:echo', { x: 21 });
    expect(env).toEqual({ ok: true, data: { doubled: 42 } });
  });

  it('validation failure returns VALIDATION envelope', async () => {
    const router = createRouter(shim.ipcMain, testSenderCheck);
    router.register(
      'test:v',
      zodValidator(z.object({ x: z.number() })),
      () => ({ ok: true }),
    );
    const env = await shim.invoke<unknown>('test:v', { x: 'nope' });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  });

  it('maps AppError subclasses to the right codes', async () => {
    const router = createRouter(shim.ipcMain, testSenderCheck);
    router.register(
      'test:nf',
      zodValidator(z.object({}).passthrough()),
      () => { throw new NotFoundError('gone'); },
    );
    router.register(
      'test:val',
      zodValidator(z.object({}).passthrough()),
      () => { throw new ValidationError('bad', { field: 'X' }); },
    );

    const nf = await shim.invoke<unknown>('test:nf', {});
    expect(nf.ok).toBe(false);
    if (!nf.ok) expect(nf.error.code).toBe('NOT_FOUND');

    const val = await shim.invoke<unknown>('test:val', {});
    expect(val.ok).toBe(false);
    if (!val.ok) expect(val.error.details).toEqual({ field: 'X' });
  });

  it('unknown throws collapse to INTERNAL without leaking stack', async () => {
    const router = createRouter(shim.ipcMain, testSenderCheck);
    router.register(
      'test:boom',
      zodValidator(z.object({}).passthrough()),
      () => { throw new Error('internal-kaboom'); },
    );
    const env = await shim.invoke<unknown>('test:boom', {});
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe('INTERNAL');
      expect(env.error.message).toBe('internal-kaboom');
      expect((env.error as unknown as { stack?: unknown }).stack).toBeUndefined();
    }
  });

  it('awaits async handlers', async () => {
    const router = createRouter(shim.ipcMain, testSenderCheck);
    router.register(
      'test:async',
      zodValidator(z.object({}).passthrough()),
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { done: true };
      },
    );
    const env = await shim.invoke<{ done: boolean }>('test:async', {});
    expect(env).toEqual({ ok: true, data: { done: true } });
  });

  describe('quiet channels', () => {
    // Records every line by tag, so a test can see what the router itself wrote.
    function recordingLogger() {
      const lines: Array<{ level: string; tag: string; msg: string; data?: unknown }> = [];
      const at = (level: string) => (tag: string, msg: string, data?: unknown) => void lines.push({ level, tag, msg, data });
      return { lines, log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } };
    }

    function setup() {
      const { lines, log } = recordingLogger();
      const router = createRouter(shim.ipcMain, testSenderCheck, log);
      const schema = zodValidator(z.object({ x: z.number() }).passthrough());
      router.register('test:loud', schema, () => ({}));
      router.register('test:quiet', schema, () => ({}), { quiet: true });
      return lines;
    }

    it('writes no request or success line for a quiet channel; a normal one still writes both', async () => {
      const lines = setup();
      await shim.invoke('test:quiet', { x: 1 });
      expect(lines).toEqual([]);
      await shim.invoke('test:loud', { x: 1 });
      expect(lines.map((l) => `${l.level} ${l.tag} ${l.msg}`)).toEqual([
        'debug ipc.req test:loud',
        'info ipc.ok test:loud',
      ]);
    });

    it('still logs a refused quiet call, without any of its payload', async () => {
      const lines = setup();
      const payload = { x: 'nope', connectionId: 'c-secret', filter: { pw: 'f-secret' } };
      await shim.invoke('test:quiet', payload);
      await shim.invoke('test:loud', payload);
      const errs = lines.filter((l) => l.tag === 'ipc.err');
      expect(errs.map((l) => l.msg)).toEqual(['test:quiet', 'test:loud']);
      expect(errs[0]!.data).toMatchObject({ code: 'VALIDATION' });
      expect(JSON.stringify(errs[0]!.data)).not.toMatch(/secret/);
      // The normal channel keeps its request summary on the error line.
      expect(JSON.stringify(errs[1]!.data)).toContain('c-secret');
    });
  });
});
