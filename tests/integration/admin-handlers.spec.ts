import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRouter } from '../../electron/ipc/router';
import { registerAdminChannels } from '../../electron/ipc/handlers/admin';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { MonitorService } from '../../electron/mongo/MonitorService';
import { createIpcShim } from '../helpers/ipcShim';
import { testSenderCheck } from '../helpers/ipcSender';

function stubSvc(): MonitorService {
  return {
    currentOp: vi.fn(async () => ({ ops: [] })),
    killOp: vi.fn(async () => ({ ok: true as const })),
    profileStatus: vi.fn(async () => ({ level: 0 as const, slowms: 100 })),
    setProfileLevel: vi.fn(async () => ({ ok: true as const })),
    profileTail: vi.fn(async () => ({ docs: [] })),
  } as unknown as MonitorService;
}

describe('admin:* handlers via router', () => {
  let shim: ReturnType<typeof createIpcShim>;
  let svc: MonitorService;

  beforeEach(() => {
    shim = createIpcShim();
    svc = stubSvc();
    registerAdminChannels(createRouter(shim.ipcMain, testSenderCheck), svc);
  });

  async function rejects(channel: string, payload: unknown): Promise<void> {
    const env = await shim.invoke(channel, payload);
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  }

  it('admin:currentOp passes the filters through', async () => {
    const env = await shim.invoke(IPC_CHANNELS.adminCurrentOp, {
      connectionId: 'c1',
      activeOnly: true,
      minSecsRunning: 5,
    });
    expect(env).toEqual({ ok: true, data: { ops: [] } });
    expect(svc.currentOp).toHaveBeenCalledWith({ connectionId: 'c1', activeOnly: true, minSecsRunning: 5 });
  });

  it('admin:currentOp rejects an empty connectionId and a negative or fractional minSecsRunning', async () => {
    await rejects(IPC_CHANNELS.adminCurrentOp, { connectionId: '' });
    await rejects(IPC_CHANNELS.adminCurrentOp, { connectionId: 'c1', minSecsRunning: -1 });
    await rejects(IPC_CHANNELS.adminCurrentOp, { connectionId: 'c1', minSecsRunning: 1.5 });
  });

  it('admin:killOp takes the opid as a non-empty string', async () => {
    await rejects(IPC_CHANNELS.adminKillOp, { connectionId: 'c1', opid: '' });
    await rejects(IPC_CHANNELS.adminKillOp, { connectionId: 'c1', opid: 42 });
    const env = await shim.invoke(IPC_CHANNELS.adminKillOp, { connectionId: 'c1', opid: 'shard01:42' });
    expect(env.ok).toBe(true);
    expect(svc.killOp).toHaveBeenCalledWith({ connectionId: 'c1', opid: 'shard01:42' });
  });

  it('admin:profileStatus needs a dbName', async () => {
    await rejects(IPC_CHANNELS.adminProfileStatus, { connectionId: 'c1', dbName: '' });
    const env = await shim.invoke(IPC_CHANNELS.adminProfileStatus, { connectionId: 'c1', dbName: 'app' });
    expect(env).toEqual({ ok: true, data: { level: 0, slowms: 100 } });
  });

  it('admin:setProfileLevel accepts only 0, 1 or 2 and a non-negative integer slowms', async () => {
    await rejects(IPC_CHANNELS.adminSetProfileLevel, { connectionId: 'c1', dbName: 'app', level: 3 });
    await rejects(IPC_CHANNELS.adminSetProfileLevel, { connectionId: 'c1', dbName: 'app', level: -1 });
    await rejects(IPC_CHANNELS.adminSetProfileLevel, {
      connectionId: 'c1', dbName: 'app', level: 1, slowms: -5,
    });
    const env = await shim.invoke(IPC_CHANNELS.adminSetProfileLevel, {
      connectionId: 'c1', dbName: 'app', level: 1, slowms: 0,
    });
    expect(env.ok).toBe(true);
    expect(svc.setProfileLevel).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'app', level: 1, slowms: 0 });
  });

  it('admin:profileTail caps limit at 100', async () => {
    await rejects(IPC_CHANNELS.adminProfileTail, { connectionId: 'c1', dbName: 'app', limit: 101 });
    await rejects(IPC_CHANNELS.adminProfileTail, { connectionId: 'c1', dbName: 'app', limit: 0 });
    const env = await shim.invoke(IPC_CHANNELS.adminProfileTail, { connectionId: 'c1', dbName: 'app', limit: 100 });
    expect(env).toEqual({ ok: true, data: { docs: [] } });
  });
});
