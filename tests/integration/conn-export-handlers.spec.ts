import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { createRouter } from '../../electron/ipc/router';
import { registerConnExportChannels } from '../../electron/ipc/handlers/connExport';
import { IPC_CHANNELS } from '../../shared/ipc';
import { ValidationError } from '../../electron/errors';
import type { ConnectionExportService } from '../../electron/services/ConnectionExportService';
import type { Envelope } from '../../shared/ipc';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

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

const PASS = 'twelve chars!!';

describe('conn:export handler', () => {
  let shim: ReturnType<typeof createShim>;
  let svc: {
    export: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    shim = createShim();
    svc = {
      export: vi.fn(async () => ({ written: 1, omittedSecrets: [] })),
    };
    registerConnExportChannels(
      createRouter(shim.ipcMain, testSenderCheck),
      svc as unknown as ConnectionExportService,
    );
  });

  const code = (env: Envelope<unknown>) => (env.ok ? null : env.error.code);

  describe('conn:export', () => {
    it('passes a valid payload to the service', async () => {
      const payload = { ids: ['a', 'b'], includeSecrets: true, passphrase: PASS };
      const env = await shim.invoke(IPC_CHANNELS.connExport, payload);
      expect(env).toEqual({ ok: true, data: { written: 1, omittedSecrets: [] } });
      expect(svc.export).toHaveBeenCalledWith(payload);
    });

    it('accepts no passphrase when passwords are not included', async () => {
      const env = await shim.invoke(IPC_CHANNELS.connExport, { ids: ['a'], includeSecrets: false });
      expect(env.ok).toBe(true);
    });

    it('rejects a passphrase under 12 characters', async () => {
      const env = await shim.invoke(IPC_CHANNELS.connExport, { ids: ['a'], includeSecrets: true, passphrase: 'x'.repeat(11) });
      expect(code(env)).toBe('VALIDATION');
      expect(svc.export).not.toHaveBeenCalled();
    });

    it('accepts a 12-character passphrase', async () => {
      const env = await shim.invoke(IPC_CHANNELS.connExport, { ids: ['a'], includeSecrets: true, passphrase: 'x'.repeat(12) });
      expect(env.ok).toBe(true);
    });

    it('rejects includeSecrets without a passphrase', async () => {
      const env = await shim.invoke(IPC_CHANNELS.connExport, { ids: ['a'], includeSecrets: true });
      expect(code(env)).toBe('VALIDATION');
      expect(env.ok ? '' : env.error.message).toContain('passphrase');
      expect(svc.export).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown key', { ids: ['a'], includeSecrets: false, extra: 1 }],
      ['no ids', { ids: [], includeSecrets: false }],
      ['an empty id', { ids: [''], includeSecrets: false }],
      ['a missing includeSecrets', { ids: ['a'] }],
      ['a non-object', 'nope'],
    ])('rejects %s', async (_label, payload) => {
      expect(code(await shim.invoke(IPC_CHANNELS.connExport, payload))).toBe('VALIDATION');
      expect(svc.export).not.toHaveBeenCalled();
    });

    it('never echoes the passphrase back in an error', async () => {
      svc.export.mockRejectedValueOnce(new ValidationError('nope'));
      const env = await shim.invoke(IPC_CHANNELS.connExport, { ids: ['a'], includeSecrets: true, passphrase: PASS });
      expect(JSON.stringify(env)).not.toContain(PASS);
    });
  });
});
