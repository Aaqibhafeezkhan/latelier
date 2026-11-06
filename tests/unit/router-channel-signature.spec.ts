import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { Router } from '../../electron/ipc/router';
import { zodValidator } from '../../electron/ipc/validators';

// The real check here is `tsc -b`, which compiles this file under
// tsconfig.test.json: every `@ts-expect-error` below must sit on a line that
// fails to compile, or the build fails. Each one is a registration that
// disagrees with the channel's signature in `ChannelSig`. The constants come
// from IPC_CHANNELS, as production handlers use them, so a looser fallback
// signature on `register` would let these compile and break the build.
function registerAll(router: Router): void {
  const docsInput = zodValidator(z.object({ url: z.string() }));

  router.register(IPC_CHANNELS.docsOpenExternal, docsInput, () => ({ opened: true as const }));

  // @ts-expect-error the renderer is promised `{ opened: true }`
  router.register(IPC_CHANNELS.docsOpenExternal, docsInput, () => ({ opened: false }));

  // @ts-expect-error preload sends `url` as a string, which this schema refuses
  router.register(IPC_CHANNELS.docsOpenExternal, zodValidator(z.object({ url: z.number() })), () => ({ opened: true as const }));

  // @ts-expect-error the schema requires a field preload never sends
  router.register(IPC_CHANNELS.docsOpenExternal, zodValidator(z.object({ url: z.string(), tab: z.string() })), () => ({ opened: true as const }));

  // @ts-expect-error a bare function validator states nothing it accepts
  router.register(IPC_CHANNELS.docsOpenExternal, (raw: unknown) => raw as { url: string }, () => ({ opened: true as const }));

  // @ts-expect-error a schema of `any` would accept every wire type, so it accepts none
  router.register(IPC_CHANNELS.docsOpenExternal, zodValidator(z.any()), () => ({ opened: true as const }));

  // @ts-expect-error a schema built for another channel's payload
  router.register(IPC_CHANNELS.docsOpenExternal, zodValidator(z.object({ id: z.string() })), () => ({ opened: true as const }));

  // @ts-expect-error a push-event channel is sent by main, never invoked
  router.register(IPC_CHANNELS.updatesStateEvent, docsInput, () => ({ opened: true as const }));

  // @ts-expect-error not a channel at all
  router.register('docs:openAnything', docsInput, () => ({ opened: true as const }));
}

describe('router.register channel signatures', () => {
  it('compiles only the registration that matches the signature (see tsc -b)', () => {
    const channels: string[] = [];
    registerAll({ register: (channel: string) => void channels.push(channel) });
    expect(channels).toEqual([
      'docs:openExternal',
      'docs:openExternal',
      'docs:openExternal',
      'docs:openExternal',
      'docs:openExternal',
      'docs:openExternal',
      'docs:openExternal',
      'updates:state-event',
      'docs:openAnything',
    ]);
  });
});
