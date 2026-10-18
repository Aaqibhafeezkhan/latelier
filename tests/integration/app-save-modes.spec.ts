import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { useUmask022 } from '../helpers/umask';

const showSaveDialog = vi.fn();

vi.mock('electron', () => ({
  dialog: { showSaveDialog: (...args: unknown[]) => showSaveDialog(...args) },
  shell: {},
}));

// Imports must come after the mock so the handler binds to the stub.
const { createRouter } = await import('../../electron/ipc/router');
const { registerAppChannels } = await import('../../electron/ipc/handlers/app');
const { IPC_CHANNELS } = await import('../../shared/ipc');
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';
import { createPickedCredentialPaths } from '../../electron/security/credentialPaths';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;

const mode = (p: string): number => fs.statSync(p).mode & 0o777;

describe.skipIf(process.platform === 'win32')('app save handlers file modes', () => {
  const handlers = new Map<string, Handler>();
  let tmpDir: string;
  let restoreUmask: () => void;

  beforeEach(() => {
    restoreUmask = useUmask022();
    handlers.clear();
    showSaveDialog.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-save-modes-'));
    const router = createRouter({ handle: (c: string, fn: Handler) => void handlers.set(c, fn) }, testSenderCheck);
    registerAppChannels(router, () => null, new Set(), createPickedCredentialPaths());
  });

  afterEach(() => {
    restoreUmask();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('app:saveFile creates a newly saved file with mode 0600', async () => {
    const filePath = path.join(tmpDir, 'export.json');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath });

    const save = handlers.get(IPC_CHANNELS.appSaveFile)!;
    const result = await save(invokeEvent, {
      defaultName: 'export.json',
      content: '{"test": "data"}',
    });

    expect(result).toEqual({ ok: true, data: { path: filePath } });
    expect(mode(filePath)).toBe(0o600);
  });

  it('app:saveFile tightens an existing 0644 file to 0600 when overwriting it', async () => {
    const filePath = path.join(tmpDir, 'existing.json');
    // Create an existing file with a different mode
    fs.writeFileSync(filePath, '{"old": "data"}', { mode: 0o644 });
    expect(mode(filePath)).toBe(0o644);

    showSaveDialog.mockResolvedValue({ canceled: false, filePath });

    const save = handlers.get(IPC_CHANNELS.appSaveFile)!;
    const result = await save(invokeEvent, {
      defaultName: 'export.json',
      content: '{"test": "data"}',
    });

    expect(result).toEqual({ ok: true, data: { path: filePath } });
    expect(mode(filePath)).toBe(0o600);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"test": "data"}');
  });
});

describe.skipIf(process.platform === 'win32')('app diagnostic bundle file mode', () => {
  const handlers = new Map<string, Handler>();
  let tmpDir: string;
  let restoreUmask: () => void;

  beforeEach(() => {
    restoreUmask = useUmask022();
    handlers.clear();
    showSaveDialog.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-diag-modes-'));
    const mockDiagnostic = {
      defaultFilename: () => 'diagnostic.json',
      serialize: () => Promise.resolve('{"diagnostic": "data"}'),
    } as unknown as import('../../electron/services/DiagnosticService').DiagnosticService;
    const router = createRouter({ handle: (c: string, fn: Handler) => void handlers.set(c, fn) }, testSenderCheck);
    registerAppChannels(router, () => null, new Set(), createPickedCredentialPaths(), mockDiagnostic);
  });

  afterEach(() => {
    restoreUmask();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('app:diagnosticBundle creates a newly saved file with mode 0600', async () => {
    const filePath = path.join(tmpDir, 'diagnostic.json');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath });

    const bundle = handlers.get(IPC_CHANNELS.appDiagnosticBundle)!;
    const result = await bundle(invokeEvent, {});

    expect(result).toEqual({ ok: true, data: { path: filePath } });
    expect(mode(filePath)).toBe(0o600);
  });
});
