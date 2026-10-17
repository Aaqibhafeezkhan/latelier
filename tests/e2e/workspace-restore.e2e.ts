import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));

test('workspace tabs survive a quit + relaunch', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-e2e-'));

  // --- first launch: seed a connection + open two tabs --------------------
  const first = await electron.launch({
    args: [path.resolve(here, '../..', 'dist-electron/main.js')],
    env: {
      ...process.env,
      ATELIER_USER_DATA_DIR: userDataDir,
      NODE_ENV: 'test',
    },
  });
  try {
    const win = await first.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const seeded = await win.evaluate(async () => {
      const api = (window as unknown as {
        atelier: {
          conn: { create: (input: unknown) => Promise<{ id: string }> };
          tabs: {
            openCollection: (input: {
              connectionId: string;
              dbName: string;
              collection: string;
            }) => Promise<{ id: string }>;
            setActive: (id: string) => Promise<unknown>;
          };
        };
      }).atelier;
      const c = await api.conn.create({
        name: 'Seed',
        color: '#1A6835',
        connectionType: 'standard',
        host: '127.0.0.1',
        port: 27017,
        authMech: 'none',
        tls: { enabled: false, verify: true },
        advanced: {
          connectTimeoutMs: 3000,
          socketTimeoutMs: 3000,
          serverSelectionTimeoutMs: 3000,
          readPreference: 'primary',
          maxPoolSize: 1,
          directConnection: true,
        },
      });
      const a = await api.tabs.openCollection({
        connectionId: c.id,
        dbName: 'db',
        collection: 'alpha',
      });
      const b = await api.tabs.openCollection({
        connectionId: c.id,
        dbName: 'db',
        collection: 'beta',
      });
      await api.tabs.setActive(a.id);
      return { connectionId: c.id, active: a.id, other: b.id };
    });
    expect(seeded.active).toBeTruthy();
  } finally {
    await first.close();
  }

  // --- relaunch: tabs should still be there with active restored ----------
  const second = await electron.launch({
    args: [path.resolve(here, '../..', 'dist-electron/main.js')],
    env: {
      ...process.env,
      ATELIER_USER_DATA_DIR: userDataDir,
      NODE_ENV: 'test',
    },
  });
  try {
    const win = await second.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const state = await win.evaluate(async () => {
      const api = (window as unknown as {
        atelier: {
          tabs: {
            list: () => Promise<
              Array<{
                id: string;
                collection: string;
                isActive: boolean;
                position: number;
              }>
            >;
          };
        };
      }).atelier;
      return await api.tabs.list();
    });

    expect(state.map((t) => t.collection)).toEqual(['alpha', 'beta']);
    const active = state.filter((t) => t.isActive);
    expect(active.length).toBe(1);
    expect(active[0]!.collection).toBe('alpha');
  } finally {
    await second.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('with "Reopen tabs on launch" off, a relaunch starts with no tabs', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-e2e-'));
  const launch = () =>
    electron.launch({
      args: [path.resolve(here, '../..', 'dist-electron/main.js')],
      env: { ...process.env, ATELIER_USER_DATA_DIR: userDataDir, NODE_ENV: 'test' },
    });

  const first = await launch();
  try {
    const win = await first.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const opened = await win.evaluate(async () => {
      const api = (window as unknown as {
        atelier: {
          conn: { create: (input: unknown) => Promise<{ id: string }> };
          tabs: {
            openCollection: (input: {
              connectionId: string;
              dbName: string;
              collection: string;
            }) => Promise<{ id: string }>;
            list: () => Promise<unknown[]>;
          };
          prefs: { set: (key: string, value: unknown) => Promise<unknown> };
        };
      }).atelier;
      const c = await api.conn.create({
        name: 'Seed',
        color: '#1A6835',
        connectionType: 'standard',
        host: '127.0.0.1',
        port: 27017,
        authMech: 'none',
        tls: { enabled: false, verify: true },
        advanced: {
          connectTimeoutMs: 3000,
          socketTimeoutMs: 3000,
          serverSelectionTimeoutMs: 3000,
          readPreference: 'primary',
          maxPoolSize: 1,
          directConnection: true,
        },
      });
      await api.tabs.openCollection({ connectionId: c.id, dbName: 'db', collection: 'alpha' });
      await api.prefs.set('ui.workspace.restoreTabs', false);
      return (await api.tabs.list()).length;
    });
    expect(opened).toBe(1);
  } finally {
    await first.close();
  }

  const second = await launch();
  try {
    const win = await second.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const remaining = await win.evaluate(async () => {
      const api = (window as unknown as {
        atelier: { tabs: { list: () => Promise<unknown[]> } };
      }).atelier;
      return await api.tabs.list();
    });
    expect(remaining).toEqual([]);
  } finally {
    await second.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
