import type { IpcMainInvokeEvent } from 'electron';
import type { Envelope } from '@shared/ipc';
import { invokeEvent } from './ipcSender';
import type { Handler as RouteHandler, RegisterOptions, Router, Validator } from '../../electron/ipc/router';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

/** An `ipcMain` stand-in for `createRouter` plus `invoke(channel, payload?)`: like Electron it refuses a second handler per channel and hands back a structured clone of the `Envelope`; it throws on an unregistered channel. */
export function createIpcShim() {
  const handlers = new Map<string, Handler>();
  return {
    ipcMain: {
      handle(channel: string, fn: Handler) {
        if (handlers.has(channel)) {
          throw new Error(`Attempted to register a second handler for '${channel}'`);
        }
        handlers.set(channel, fn);
      },
    } as const,
    async invoke<T>(channel: string, payload?: unknown): Promise<Envelope<T>> {
      const h = handlers.get(channel);
      if (!h) throw new Error(`no handler for ${channel}`);
      return structuredClone(await h(invokeEvent, payload)) as Envelope<T>;
    },
  };
}

/** `Router.register` without the channel-signature check, for the router's own tests that register made-up `test:*` channels. */
export interface UntypedRouter {
  register<I, O>(channel: string, validate: Validator<I>, handler: RouteHandler<I, O>, opts?: RegisterOptions): void;
}

export const untypedRouter = (router: Router): UntypedRouter => router as unknown as UntypedRouter;
