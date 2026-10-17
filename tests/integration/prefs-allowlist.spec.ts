import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, type Envelope } from '@shared/ipc';
import { createRouter } from '../../electron/ipc/router';
import { registerPrefsChannels } from '../../electron/ipc/handlers/prefs';
import { registerSecretsChannels } from '../../electron/ipc/handlers/secrets';
import { PLAINTEXT_FALLBACK_KEY } from '../../electron/ipc/prefKeys';
import { AppStateRepo } from '../../electron/db/repositories/AppStateRepo';
import { AppStateService } from '../../electron/services/AppStateService';
import { createTempDb, type TempDb } from '../helpers/db';
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

const UUID = '3f2b8c1e-9a4d-4e57-8b0c-1d2e3f4a5b6c';

const ROUND_TRIPS: Array<[string, unknown]> = [
  ['ui.showSystemDbs', true],
  ['ui.users.lastDb', 'admin'],
  ['ui.hints.dismissed', { dismissedIds: ['tabs.pin'], resetAt: '2026-01-01T00:00:00.000Z' }],
  ['ui.workspace.defaultPageSize', 50],
  ['ui.workspace.leftWidth', 240],
  ['ui.workspace.refDrawerWidth', 320],
  ['ui.workspace.innerHSplit', 61.5],
  ['ui.workspace.shellSplit', 40],
  ['ui.workspace.sidebarCollapsed', true],
  ['ui.workspace.builderCollapsed', false],
  ['ui.workspace.restoreTabs', false],
  ['ui.workspace.documentEditorSize', { width: 600, height: 400 }],
  ['ui.commandPalette.mru', ['tab.new', 'tab.open:shop:orders']],
  [`ui.workspace.navigator.connExpanded:${UUID}`, true],
];

describe('prefs key allowlist and the main-confirmed plaintext switch', () => {
  let tmp: TempDb | null = null;
  afterEach(() => {
    tmp?.cleanup();
    tmp = null;
  });

  function setup(confirmAnswer = true) {
    tmp = createTempDb();
    const appState = new AppStateService(new AppStateRepo(tmp.db));
    const handlers = new Map<string, Handler>();
    const router = createRouter(
      { handle: (ch: string, fn: Handler) => handlers.set(ch, fn) },
      testSenderCheck,
    );
    const confirm = vi.fn(async () => confirmAnswer);
    registerPrefsChannels(router, appState, () => null);
    registerSecretsChannels(router, appState, confirm);
    const invoke = async <T>(ch: string, payload?: unknown): Promise<Envelope<T>> =>
      (await handlers.get(ch)!(invokeEvent, payload)) as Envelope<T>;
    return { appState, invoke, confirm };
  }

  function expectValidation(env: Envelope<unknown>) {
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error.code).toBe('VALIDATION');
  }

  it.each(ROUND_TRIPS)('%s round-trips through prefs:set and prefs:get', async (key, value) => {
    const { invoke } = setup();
    const set = await invoke(IPC_CHANNELS.prefsSet, { key, value });
    expect(set.ok).toBe(true);
    const got = await invoke<unknown>(IPC_CHANNELS.prefsGet, { key });
    expect(got.ok && got.data).toEqual(value);
  });

  it('rejects an unknown key for set and get, and writes nothing', async () => {
    const { appState, invoke } = setup();
    expectValidation(await invoke(IPC_CHANNELS.prefsSet, { key: 'ui.unknown', value: 1 }));
    expectValidation(await invoke(IPC_CHANNELS.prefsGet, { key: 'ui.unknown' }));
    expect(appState.get('ui.unknown')).toBeNull();
  });

  it('rejects the plaintext switch through prefs:set, and leaves it unset', async () => {
    const { appState, invoke } = setup();
    expectValidation(
      await invoke(IPC_CHANNELS.prefsSet, { key: PLAINTEXT_FALLBACK_KEY, value: true }),
    );
    expect(appState.get(PLAINTEXT_FALLBACK_KEY)).toBeNull();
  });

  it('still lets the renderer read the plaintext switch', async () => {
    const { appState, invoke } = setup();
    appState.set(PLAINTEXT_FALLBACK_KEY, true);
    const got = await invoke<boolean>(IPC_CHANNELS.prefsGet, { key: PLAINTEXT_FALLBACK_KEY });
    expect(got.ok && got.data).toBe(true);
  });

  it.each(['window.bounds', 'window.maximized', 'theme.mode', 'maintenance.lastRunAt'])(
    'main-only key %s is neither readable nor writable',
    async (key) => {
      const { appState, invoke } = setup();
      appState.set(key, 'secret');
      expectValidation(await invoke(IPC_CHANNELS.prefsSet, { key, value: 'x' }));
      expectValidation(await invoke(IPC_CHANNELS.prefsGet, { key }));
      expect(appState.get(key)).toBe('secret');
    },
  );

  it('prefs:set cannot bypass the theme enum', async () => {
    const { appState, invoke } = setup();
    expectValidation(await invoke(IPC_CHANNELS.prefsSet, { key: 'theme.mode', value: 'junk' }));
    expect(appState.get('theme.mode')).toBeNull();
  });

  it('accepts the dynamic key for a UUID and rejects any other suffix', async () => {
    const { invoke } = setup();
    const prefix = 'ui.workspace.navigator.connExpanded:';
    expect((await invoke(IPC_CHANNELS.prefsSet, { key: prefix + UUID, value: false })).ok).toBe(true);
    expectValidation(await invoke(IPC_CHANNELS.prefsSet, { key: prefix + 'junk', value: true }));
    expectValidation(await invoke(IPC_CHANNELS.prefsGet, { key: prefix + UUID + 'x' }));
  });

  it('rejects a value of the wrong type and does not persist it', async () => {
    const { appState, invoke } = setup();
    expectValidation(
      await invoke(IPC_CHANNELS.prefsSet, { key: 'ui.workspace.leftWidth', value: 'wide' }),
    );
    expectValidation(
      await invoke(IPC_CHANNELS.prefsSet, { key: 'ui.hints.dismissed', value: { dismissedIds: 7 } }),
    );
    expect(appState.get('ui.workspace.leftWidth')).toBeNull();
    expect(appState.get('ui.hints.dismissed')).toBeNull();
  });

  it('bounds the palette history: strings only, at most 16 of them', async () => {
    const { appState, invoke } = setup();
    const key = 'ui.commandPalette.mru';
    expectValidation(await invoke(IPC_CHANNELS.prefsSet, { key, value: ['ok', 7] }));
    expectValidation(
      await invoke(IPC_CHANNELS.prefsSet, { key, value: Array.from({ length: 17 }, () => 'a') }),
    );
    expect(appState.get(key)).toBeNull();
  });

  describe('secrets:set-plaintext-fallback', () => {
    it('writes only after the main-process confirmation is accepted', async () => {
      const { appState, invoke, confirm } = setup(true);
      const env = await invoke<{ enabled: boolean }>(IPC_CHANNELS.secretsSetPlaintextFallback, {
        enabled: true,
      });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(env.ok && env.data).toEqual({ enabled: true });
      expect(appState.get(PLAINTEXT_FALLBACK_KEY)).toBe(true);
    });

    it('does not write when the confirmation is cancelled', async () => {
      const { appState, invoke, confirm } = setup(false);
      const env = await invoke<{ enabled: boolean }>(IPC_CHANNELS.secretsSetPlaintextFallback, {
        enabled: true,
      });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(env.ok && env.data).toEqual({ enabled: false });
      expect(appState.get(PLAINTEXT_FALLBACK_KEY)).toBeNull();
    });

    it('reports the value still in force when a cancelled enable meets an already-enabled switch', async () => {
      const { appState, invoke } = setup(false);
      appState.set(PLAINTEXT_FALLBACK_KEY, true);
      const env = await invoke<{ enabled: boolean }>(IPC_CHANNELS.secretsSetPlaintextFallback, {
        enabled: true,
      });
      expect(env.ok && env.data).toEqual({ enabled: true });
      expect(appState.get(PLAINTEXT_FALLBACK_KEY)).toBe(true);
    });

    it('disables without asking', async () => {
      const { appState, invoke, confirm } = setup(false);
      appState.set(PLAINTEXT_FALLBACK_KEY, true);
      const env = await invoke<{ enabled: boolean }>(IPC_CHANNELS.secretsSetPlaintextFallback, {
        enabled: false,
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(env.ok && env.data).toEqual({ enabled: false });
      expect(appState.get(PLAINTEXT_FALLBACK_KEY)).toBe(false);
    });

    it('rejects a non-boolean payload without asking or writing', async () => {
      const { appState, invoke, confirm } = setup(true);
      expectValidation(await invoke(IPC_CHANNELS.secretsSetPlaintextFallback, { enabled: 'yes' }));
      expect(confirm).not.toHaveBeenCalled();
      expect(appState.get(PLAINTEXT_FALLBACK_KEY)).toBeNull();
    });
  });
});
