import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IpcApi } from '@shared/ipc';
import { readLaunchTabCount, resetLaunchRestore } from '../../src/hints/launchRestore';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

afterEach(() => {
  resetLaunchRestore();
  uninstallAtelierMock();
});

describe('readLaunchTabCount', () => {
  it('reads as nothing restored, and says why in the main log, when the tab list fails', async () => {
    const log = vi.fn<IpcApi['app']['log']>(async () => undefined);
    installAtelierMock({
      tabs: {
        list: async () => {
          throw { code: 'INTERNAL', message: 'db locked' };
        },
      },
      app: { log },
    });

    expect(await readLaunchTabCount()).toBe(0);
    expect(log).toHaveBeenCalledWith({
      level: 'warn',
      message: 'listing the restored tabs failed: db locked',
      source: 'component',
    });
  });
});
