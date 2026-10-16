import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { Envelope } from '../../shared/ipc';

// app.ts / shell.ts import `dialog` / `shell` from 'electron' at module scope.
// Outside a real Electron process that resolves to a bare path string, so a
// bare `import ... from 'electron'` blows up at load time — mock it first,
// same fix as tests/integration/shell-open-external.spec.ts, then pull
// everything else in via dynamic import so it binds to the mock.
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
  },
  shell: { openExternal: vi.fn(async () => undefined) },
}));

const { createRouter } = await import('../../electron/ipc/router');
const { IPC_CHANNELS } = await import('../../shared/ipc');
const { registerConnChannels } = await import('../../electron/ipc/handlers/conn');
const { registerConnExportChannels } = await import('../../electron/ipc/handlers/connExport');
const { registerConnImportChannels } = await import('../../electron/ipc/handlers/connImport');
const { registerAppChannels } = await import('../../electron/ipc/handlers/app');
const { registerMongoChannels } = await import('../../electron/ipc/handlers/mongo');
const { registerMetaChannels } = await import('../../electron/ipc/handlers/meta');
const { registerIndexChannels } = await import('../../electron/ipc/handlers/indexes');
const { registerCollectionAdminChannels } = await import(
  '../../electron/ipc/handlers/collectionAdmin'
);
const { registerUserChannels } = await import('../../electron/ipc/handlers/users');
const { registerPrefsChannels } = await import('../../electron/ipc/handlers/prefs');
const { registerSecretsChannels } = await import('../../electron/ipc/handlers/secrets');
const { registerTabsChannels } = await import('../../electron/ipc/handlers/tabs');
const { registerQueryChannels } = await import('../../electron/ipc/handlers/query');
const { registerDocChannels } = await import('../../electron/ipc/handlers/doc');
const { registerSavedChannels } = await import('../../electron/ipc/handlers/saved');
const { registerRecentChannels } = await import('../../electron/ipc/handlers/recent');
const { registerAuditChannels } = await import('../../electron/ipc/handlers/audit');
const { registerDataChannels } = await import('../../electron/ipc/handlers/data');
const { registerAggChannels } = await import('../../electron/ipc/handlers/agg');
const { registerShellChannels } = await import('../../electron/ipc/handlers/shell');
const { registerMshellChannels } = await import('../../electron/ipc/handlers/mshell');
const { registerScriptChannels } = await import('../../electron/ipc/handlers/script');
const { registerRefsChannels } = await import('../../electron/ipc/handlers/refs');
const { registerUpdatesChannels } = await import('../../electron/ipc/handlers/updates');
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';
import { createPickedCredentialPaths } from '../../electron/security/credentialPaths';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

// Same shim as tests/integration/tabs-handlers.spec.ts, plus a `channels()`
// accessor so this spec can assert on the *set* of what got registered, not
// just invoke a channel it already knows the name of.

function createShim() {
  const handlers = new Map<string, Handler>();
  return {
    ipcMain: {
      handle(channel: string, fn: Handler) {
        // Real `ipcMain.handle` throws synchronously on a second handler for
        // the same channel — mirror that so a duplicate registration surfaces
        // as a loud boot-time failure here too, instead of a silent overwrite.
        if (handlers.has(channel)) {
          throw new Error(`duplicate ipcMain.handle registration for channel: ${channel}`);
        }
        handlers.set(channel, fn);
      },
    } as const,
    channels(): string[] {
      return [...handlers.keys()];
    },
    has(channel: string): boolean {
      return handlers.has(channel);
    },
    async invoke<T>(channel: string, payload: unknown): Promise<Envelope<T>> {
      const h = handlers.get(channel);
      if (!h) throw new Error(`no handler for ${channel}`);
      return (await h(invokeEvent, payload)) as Envelope<T>;
    },
  };
}

// Every registerXxxChannels function takes ~18 different service types.
// Rather than hand-write 18 stubs, hand each registration a Proxy that
// answers any property access with a fresh async no-op — covers every
// `svc.method(...)` call site without knowing the service shapes.
const stubSvc = <T,>(): T => new Proxy({}, { get: () => vi.fn(async () => ({})) }) as T;

// Channels main pushes to the renderer via `webContents.send(...)`, never
// passed to `ipcMain.handle` / `router.register`. Structurally excluded from
// "every IPC_CHANNELS value is registered" — see mongo.ts:49, prefs.ts:33,
// mshell.ts:59. This is NOT the hardcoded channel list the issue forbids:
// the coverage assertion below still walks `Object.entries(IPC_CHANNELS)`
// live, so a newly added invoke channel is covered automatically (proved by
// mutation #2 in the PR description) — only the known one-way event
// names listed here are carved out.
const PUSH_EVENT_CHANNELS = new Set<string>([
  IPC_CHANNELS.mongoStatusEvent,
  IPC_CHANNELS.prefsThemeEvent,
  IPC_CHANNELS.mshellOutputEvent,
  IPC_CHANNELS.dataImportProgressEvent,
  IPC_CHANNELS.appMenuCommandEvent,
  IPC_CHANNELS.updatesStateEvent,
]);

describe('IPC channel registration — full router coverage', () => {
  let shim: ReturnType<typeof createShim>;

  beforeEach(() => {
    shim = createShim();
    const router = createRouter(shim.ipcMain, testSenderCheck);

    registerConnChannels(router, stubSvc<Parameters<typeof registerConnChannels>[1]>(), createPickedCredentialPaths());
    registerConnExportChannels(router, stubSvc<Parameters<typeof registerConnExportChannels>[1]>());
    registerConnImportChannels(router, stubSvc<Parameters<typeof registerConnImportChannels>[1]>());
    // appDiagnosticBundle's `diagnostic` param is left undefined on purpose:
    // it's optional, and the handler already treats "no diagnostic service"
    // as a controlled INTERNAL error — that still exercises registration +
    // the envelope path without needing a stub.
    registerAppChannels(router, () => null, new Set(), createPickedCredentialPaths());
    registerMongoChannels(
      router,
      stubSvc<Parameters<typeof registerMongoChannels>[1]>(),
      () => null,
    );
    registerMetaChannels(router, stubSvc<Parameters<typeof registerMetaChannels>[1]>());
    registerIndexChannels(router, stubSvc<Parameters<typeof registerIndexChannels>[1]>());
    registerCollectionAdminChannels(
      router,
      stubSvc<Parameters<typeof registerCollectionAdminChannels>[1]>(),
    );
    registerUserChannels(router, stubSvc<Parameters<typeof registerUserChannels>[1]>());
    registerPrefsChannels(
      router,
      stubSvc<Parameters<typeof registerPrefsChannels>[1]>(),
      () => null,
    );
    registerSecretsChannels(
      router,
      stubSvc<Parameters<typeof registerSecretsChannels>[1]>(),
      async () => false,
    );
    registerTabsChannels(router, stubSvc<Parameters<typeof registerTabsChannels>[1]>());
    registerQueryChannels(
      router,
      stubSvc<Parameters<typeof registerQueryChannels>[1]>(),
      async () => null,
    );
    registerDocChannels(router, stubSvc<Parameters<typeof registerDocChannels>[1]>());
    registerSavedChannels(router, stubSvc<Parameters<typeof registerSavedChannels>[1]>());
    registerRecentChannels(
      router,
      stubSvc<Parameters<typeof registerRecentChannels>[1]>(),
      stubSvc<Parameters<typeof registerRecentChannels>[2]>(),
    );
    registerAuditChannels(router, stubSvc<Parameters<typeof registerAuditChannels>[1]>());
    registerDataChannels(router, stubSvc<Parameters<typeof registerDataChannels>[1]>(), new Set());
    registerAggChannels(router, stubSvc<Parameters<typeof registerAggChannels>[1]>());
    registerShellChannels(router);
    registerMshellChannels(router, stubSvc<Parameters<typeof registerMshellChannels>[1]>());
    registerScriptChannels(router, stubSvc<Parameters<typeof registerScriptChannels>[1]>());
    registerRefsChannels(router, stubSvc<Parameters<typeof registerRefsChannels>[1]>());
    registerUpdatesChannels(router, stubSvc<Parameters<typeof registerUpdatesChannels>[1]>());
  });

  it('registers every non-event IPC_CHANNELS value on the router', () => {
    const missing = Object.entries(IPC_CHANNELS)
      .filter(([, channel]) => !PUSH_EVENT_CHANNELS.has(channel))
      .filter(([, channel]) => !shim.has(channel))
      .map(([key, channel]) => `${key} (${channel})`);

    expect(missing).toEqual([]);
  });

  it('registers no channel that is absent from IPC_CHANNELS (catches typo\'d literals)', () => {
    const known = new Set(Object.values<string>(IPC_CHANNELS));
    const unexpected = shim.channels().filter((channel) => !known.has(channel));

    expect(unexpected).toEqual([]);
  });

  it('offers every importable extension in the data-import picker', async () => {
    const { dialog } = await import('electron');
    await shim.invoke(IPC_CHANNELS.appPickFile, 'data-import');
    // Called as (window, options); the mocked type only knows the one-argument overload.
    const options = (vi.mocked(dialog.showOpenDialog).mock.lastCall as unknown[]).at(-1) as Electron.OpenDialogOptions;
    expect(options.filters!.flatMap((f) => f.extensions)).toEqual(['json', 'jsonl', 'ndjson', 'csv']);
  });

  const coveredEntries = Object.entries(IPC_CHANNELS).filter(
    ([, channel]) => !PUSH_EVENT_CHANNELS.has(channel),
  );

  it.each(coveredEntries)(
    'channel %s (%s) returns a well-formed Envelope for an invalid payload, never throws',
    async (_key, channel) => {
      const env = await shim.invoke<unknown>(channel, undefined);

      expect(env).toBeTypeOf('object');
      expect(typeof env.ok).toBe('boolean');
      if (!env.ok) {
        expect(typeof env.error.code).toBe('string');
        expect(env.error.code.length).toBeGreaterThan(0);
        // CLAUDE.md: never leak a raw Error (with its stack) across the IPC
        // boundary — IpcError has no `stack` field at all.
        expect((env.error as unknown as Record<string, unknown>).stack).toBeUndefined();
      }
    },
  );
});
