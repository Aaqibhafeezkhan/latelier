import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { UpdateService, shouldCheckForUpdates, type UpdaterLike } from '../../electron/services/UpdateService';
import { ValidationError } from '../../electron/errors';
import type { Logger } from '../../electron/log';
import type { UpdateState } from '../../shared/types';
import { createQuitGate, type RunningWork } from '../../electron/quitGuard';

function fakeUpdater(check: () => Promise<unknown> = async () => undefined) {
  const ee = new EventEmitter();
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: vi.fn((event: string, listener: (arg: unknown) => void) => ee.on(event, listener)),
    checkForUpdates: vi.fn(check),
    quitAndInstall: vi.fn(),
  };
  return { updater: updater as unknown as UpdaterLike & typeof updater, ee };
}

function fakeLog() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
}

const idle: RunningWork = { scripts: 0, shellCommands: 0, imports: 0, aggregations: 0 };

function setup(
  opts: {
    enabled?: boolean;
    check?: () => Promise<unknown>;
    running?: RunningWork;
    confirm?: (message: string) => Promise<boolean>;
  } = {},
) {
  const { updater, ee } = fakeUpdater(opts.check);
  const load = vi.fn(async () => updater);
  const log = fakeLog();
  const emitted: UpdateState[] = [];
  const confirm = vi.fn(opts.confirm ?? (async () => true));
  const gate = createQuitGate({ counts: () => opts.running ?? idle, confirm });
  const svc = new UpdateService(load, log, (s) => emitted.push(s), opts.enabled ?? true, gate);
  return { svc, updater, ee, load, log, emitted, confirm, gate };
}

describe('shouldCheckForUpdates', () => {
  it.each([
    ['darwin', true, undefined, true],
    ['win32', true, undefined, true],
    ['linux', true, undefined, false],
    ['darwin', false, undefined, false],
    ['win32', false, undefined, false],
    ['darwin', true, '/tmp/throwaway', false],
    ['win32', true, '/tmp/throwaway', false],
    ['linux', false, '/tmp/throwaway', false],
  ] as const)('%s packaged=%s override=%s -> %s', (platform, isPackaged, userDataOverride, expected) => {
    expect(shouldCheckForUpdates({ isPackaged, userDataOverride, platform })).toBe(expected);
  });

  it('treats an empty override as unset', () => {
    expect(shouldCheckForUpdates({ isPackaged: true, userDataOverride: '', platform: 'darwin' })).toBe(true);
  });
});

describe('UpdateService.start', () => {
  it('does nothing when disabled: the updater is never even loaded', async () => {
    const { svc, load, log } = setup({ enabled: false });
    await svc.start();
    expect(load).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(svc.getState()).toEqual({ status: 'idle' });
  });

  it('enables background download and install-on-quit, then checks once', async () => {
    const { svc, updater } = setup();
    await svc.start();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('logs a rejected check at warn with the updater tag and keeps state idle', async () => {
    const { svc, log } = setup({ check: async () => { throw new Error('offline'); } });
    await expect(svc.start()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('updater', 'update check failed', { err: 'Error: offline' });
    expect(svc.getState()).toEqual({ status: 'idle' });
  });

  it('logs a failure to load the updater instead of throwing', async () => {
    const log = fakeLog();
    const gate = createQuitGate({ counts: () => idle, confirm: async () => true });
    const svc = new UpdateService(async () => { throw new Error('no module'); }, log, () => {}, true, gate);
    await expect(svc.start()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith('updater', 'update check failed', { err: 'Error: no module' });
  });

  it('logs the updater error event at warn without changing state', async () => {
    const { svc, ee, log, emitted } = setup();
    await svc.start();
    ee.emit('error', new Error('bad feed'));
    expect(log.warn).toHaveBeenCalledWith('updater', 'updater error', { err: 'Error: bad feed' });
    expect(svc.getState()).toEqual({ status: 'idle' });
    expect(emitted).toEqual([]);
  });
});

describe('UpdateService state and restart', () => {
  it('moves to ready with the version and emits it when a download finishes', async () => {
    const { svc, ee, emitted } = setup();
    await svc.start();
    ee.emit('update-downloaded', { version: '1.2.3' });
    expect(svc.getState()).toEqual({ status: 'ready', version: '1.2.3' });
    expect(emitted).toEqual([{ status: 'ready', version: '1.2.3' }]);
  });

  it('restart installs silently and relaunches, exactly once, without asking when nothing runs', async () => {
    const running = { ...idle };
    const { svc, ee, updater, confirm, gate } = setup({ running });
    await svc.start();
    ee.emit('update-downloaded', { version: '1.2.3' });
    await expect(svc.restart()).resolves.toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(confirm).not.toHaveBeenCalled();
    // Nothing was asked, so nothing was approved: work started afterwards is still asked about.
    running.scripts = 1;
    expect(gate.check()).toBe('hold');
  });

  it('restart refuses with a ValidationError naming the state when nothing is ready', async () => {
    const { svc, updater, confirm } = setup({ running: { ...idle, scripts: 1 } });
    await svc.start();
    await expect(svc.restart()).rejects.toThrow(ValidationError);
    await expect(svc.restart()).rejects.toThrow(/state: idle/);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });
});

// The installer starts inside `quitAndInstall`, before the app's quit event, so
// the running-work question has to be answered before it is called.
describe('UpdateService.restart over running work', () => {
  async function ready(opts: Parameters<typeof setup>[0]) {
    const s = setup(opts);
    await s.svc.start();
    s.ee.emit('update-downloaded', { version: '1.2.3' });
    s.emitted.length = 0;
    return s;
  }

  it('asks first, and Cancel installs nothing, keeps the update ready and offers Restart again', async () => {
    const { svc, updater, confirm, emitted } = await ready({
      running: { ...idle, shellCommands: 1 },
      confirm: async () => false,
    });
    await expect(svc.restart()).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith('This will stop 1 running shell command.');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(svc.getState()).toEqual({ status: 'ready', version: '1.2.3' });
    expect(emitted).toEqual([{ status: 'ready', version: '1.2.3' }]);

    // Restart is usable again: a second click asks again.
    await svc.restart();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('Quit installs once, and the quit that follows is let through without a second dialog', async () => {
    const { svc, updater, confirm, gate, emitted } = await ready({
      running: { ...idle, scripts: 2 },
      confirm: async () => true,
    });
    await expect(svc.restart()).resolves.toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(emitted).toEqual([]);
    // What the window close and `before-quit` consult next.
    expect(gate.check()).toBe('allow');
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('an install that fails after Quit takes the approval back and offers Restart again', async () => {
    const running = { ...idle, scripts: 1 };
    const { svc, ee, updater, confirm, gate, emitted } = await ready({ running, confirm: async () => true });
    // electron-updater reports every failed install through its error event,
    // from inside quitAndInstall, and then does not quit.
    updater.quitAndInstall.mockImplementation(() => {
      ee.emit('error', new Error('No update filepath provided'));
    });

    await expect(svc.restart()).resolves.toBe(false);
    expect(gate.check()).toBe('hold');
    expect(svc.getState()).toEqual({ status: 'ready', version: '1.2.3' });
    expect(emitted).toEqual([{ status: 'ready', version: '1.2.3' }]);

    // The next attempt asks again rather than riding the old yes.
    await svc.restart();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('an updater error with no restart under way leaves an earlier approval alone', async () => {
    const { ee, gate } = await ready({ running: { ...idle, scripts: 1 }, confirm: async () => true });
    await gate.ask();
    ee.emit('error', new Error('bad feed'));
    expect(gate.check()).toBe('allow');
  });

  it('a second restart while the question is open asks nothing more and installs nothing', async () => {
    let answer: (yes: boolean) => void = () => {};
    const { svc, updater, confirm } = await ready({
      running: { ...idle, imports: 1 },
      confirm: () => new Promise<boolean>((r) => { answer = r; }),
    });
    const first = svc.restart();
    await expect(svc.restart()).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    answer(true);
    await expect(first).resolves.toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
