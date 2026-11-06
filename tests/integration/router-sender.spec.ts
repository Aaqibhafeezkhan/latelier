import { describe, it, expect, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { createRouter } from '../../electron/ipc/router';
import {
  appFrame,
  foreignInvokeEvent,
  invokeEvent,
  testSenderCheck,
} from '../helpers/ipcSender';
import { senderCheck } from '../../electron/ipc/senderGuard';
import { untypedRouter } from '../helpers/ipcShim';

/**
 * Sender validation at the boundary it actually protects — a registered channel
 * on a real `createRouter`, not the predicate in isolation.
 *
 * The unit tests in `tests/unit/senderGuard.spec.ts` prove the predicate is
 * right. They cannot prove the router applies it, or that it runs before the
 * handler, or that a denial comes back as an `Envelope` the renderer can read.
 * That gap is why this file exists: the production wiring could have dropped
 * the guard entirely and every unit test would have stayed green.
 */

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

function createShim() {
  const handlers = new Map<string, Handler>();
  return {
    ipcMain: {
      handle(channel: string, fn: Handler) {
        handlers.set(channel, fn);
      },
    } as Pick<IpcMain, 'handle'>,
    invoke: (channel: string, evt: IpcMainInvokeEvent, payload?: unknown) =>
      handlers.get(channel)!(evt, payload),
  };
}

describe('createRouter — sender validation', () => {
  it('runs the handler for the app’s own frame', async () => {
    const shim = createShim();
    const handler = vi.fn(() => ({ value: 1 }));
    untypedRouter(createRouter(shim.ipcMain, testSenderCheck)).register(
      'test:channel',
      (raw) => raw as unknown,
      handler,
    );

    const result = await shim.invoke('test:channel', invokeEvent, { a: 1 });

    expect(handler).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, data: { value: 1 } });
  });

  it('refuses a foreign frame without reaching the handler', async () => {
    const shim = createShim();
    const handler = vi.fn();
    untypedRouter(createRouter(shim.ipcMain, testSenderCheck)).register(
      'test:channel',
      (raw) => raw as unknown,
      handler,
    );

    const result = await shim.invoke('test:channel', foreignInvokeEvent, { a: 1 });

    // Both halves matter. A denial that still ran the handler is no protection,
    // and one that threw instead of answering would hang the renderer's await
    // rather than surfacing an error it can switch on.
    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: { code: 'UNTRUSTED_SENDER', message: 'IPC request from an untrusted sender' },
    });
  });

  it('refuses the app’s own frame once it holds a foreign document', async () => {
    // The case frame identity alone cannot catch: one object, the window's
    // current main frame, now serving someone else's page.
    const navigated = { url: 'https://evil.example/' } as unknown as typeof appFrame;
    const check = senderCheck(() => navigated, (url) => url === 'file:///app/dist/index.html');

    const shim = createShim();
    const handler = vi.fn();
    untypedRouter(createRouter(shim.ipcMain, check)).register('test:channel', (raw) => raw as unknown, handler);

    const result = await shim.invoke(
      'test:channel',
      { senderFrame: navigated } as IpcMainInvokeEvent,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } });
  });

  it('never logs the payload of a refused request', async () => {
    // A denial is the one case where the request body is least trustworthy, so
    // the guard runs before `ipc.req` writes anything.
    const shim = createShim();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    untypedRouter(createRouter(shim.ipcMain, testSenderCheck, log)).register(
      'test:channel',
      (raw) => raw as unknown,
      vi.fn(),
    );

    await shim.invoke('test:channel', foreignInvokeEvent, { secret: 'do-not-log-me' });

    expect(log.debug).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('ipc.denied', 'test:channel', {
      url: 'https://evil.example/',
    });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('do-not-log-me');
  });
});
