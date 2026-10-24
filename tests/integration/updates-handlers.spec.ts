import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { createRouter } from '../../electron/ipc/router';
import { registerUpdatesChannels } from '../../electron/ipc/handlers/updates';
import { UpdateService, type UpdaterLike } from '../../electron/services/UpdateService';
import { IPC_CHANNELS, type Envelope } from '../../shared/ipc';
import { createQuitGate } from '../../electron/quitGuard';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

function createShim() {
  const handlers = new Map<string, Handler>();
  return {
    ipcMain: { handle: (c: string, fn: Handler) => void handlers.set(c, fn) } as const,
    async invoke<T>(channel: string, payload: unknown): Promise<Envelope<T>> {
      const h = handlers.get(channel);
      if (!h) throw new Error(`no handler for ${channel}`);
      return (await h(invokeEvent, payload)) as Envelope<T>;
    },
  };
}

describe('updates:* handlers', () => {
  let shim: ReturnType<typeof createShim>;
  let quitAndInstall: ReturnType<typeof vi.fn>;
  let fire: (version: string) => void;
  let svc: UpdateService;
  let quitAnswer: boolean;
  let shellCommands: number;
  let failInstall: (err: Error) => void;
  let gate: ReturnType<typeof createQuitGate>;

  beforeEach(async () => {
    shim = createShim();
    quitAndInstall = vi.fn();
    let downloaded: ((i: { version: string }) => void) | undefined;
    let errored: ((err: Error) => void) | undefined;
    const updater = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      on: (event: string, l: never) => {
        if (event === 'update-downloaded') downloaded = l;
        if (event === 'error') errored = l;
      },
      checkForUpdates: async () => undefined,
      quitAndInstall,
    } as unknown as UpdaterLike;
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    quitAnswer = true;
    shellCommands = 0;
    gate = createQuitGate({
      counts: () => ({ scripts: 0, shellCommands, imports: 0, aggregations: 0, unsavedForms: 0, unsavedPipelines: 0 }),
      confirm: async () => quitAnswer,
    });
    svc = new UpdateService(async () => updater, log, () => {}, true, gate);
    await svc.start();
    fire = (version) => downloaded?.({ version });
    failInstall = (err) => errored?.(err);
    registerUpdatesChannels(createRouter(shim.ipcMain, testSenderCheck), svc);
  });

  it('getState returns the service state in an ok envelope', async () => {
    expect(await shim.invoke(IPC_CHANNELS.updatesGetState, undefined)).toEqual({
      ok: true,
      data: { status: 'idle' },
    });
    fire('2.0.0');
    expect(await shim.invoke(IPC_CHANNELS.updatesGetState, {})).toEqual({
      ok: true,
      data: { status: 'ready', version: '2.0.0' },
    });
  });

  it('restart installs and answers ok when an update is ready', async () => {
    fire('2.0.0');
    expect(await shim.invoke(IPC_CHANNELS.updatesRestart, {})).toEqual({
      ok: true,
      data: { restarting: true },
    });
    expect(quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('restart answers restarting: false and installs nothing when the quit question is cancelled', async () => {
    fire('2.0.0');
    shellCommands = 1;
    quitAnswer = false;
    expect(await shim.invoke(IPC_CHANNELS.updatesRestart, {})).toEqual({
      ok: true,
      data: { restarting: false },
    });
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  it('restart answers restarting: false and asks again next time when the install fails after Quit', async () => {
    fire('2.0.0');
    shellCommands = 1;
    // electron-updater reports a failed install through `error`, from inside
    // quitAndInstall, and then does not quit.
    quitAndInstall.mockImplementation(() => failInstall(new Error('No update filepath provided')));
    expect(await shim.invoke(IPC_CHANNELS.updatesRestart, {})).toEqual({
      ok: true,
      data: { restarting: false },
    });
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
    expect(gate.check()).toBe('hold');
  });

  it('restart answers a VALIDATION error envelope when nothing is ready', async () => {
    const env = await shim.invoke(IPC_CHANNELS.updatesRestart, {});
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  it('a payload with unexpected fields is a VALIDATION error, never a throw', async () => {
    fire('2.0.0');
    const env = await shim.invoke(IPC_CHANNELS.updatesRestart, { force: true });
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
    expect(quitAndInstall).not.toHaveBeenCalled();
  });
});
