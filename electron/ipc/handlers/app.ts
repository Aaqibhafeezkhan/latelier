import { dialog, shell, type BrowserWindow, type FileFilter } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { IPC_CHANNELS, type PickFilePurpose } from '@shared/ipc';
import type { Router } from '../router.ts';
import { zodValidator } from '../validators.ts';
import { SystemError } from '../../errors.ts';
import { writePrivateFile } from '../../utils/privateFs.ts';
import type { DiagnosticService } from '../../services/DiagnosticService.ts';
import { parseAllowedExternalUrl } from '../../security/externalUrl.ts';
import type { PickedCredentialPaths } from '../../security/credentialPaths.ts';
import type { UnsavedWorkStore } from '../../quitGuard.ts';
import type { Logger, RateGate } from '../../log.ts';

const PickFileInput = z.enum(['tls-ca', 'tls-client-cert', 'ssh-key', 'data-import']);
const OpenExternalInput = z.string().url();
// Hosts the renderer may open in the system browser: the project repo (the
// troubleshooting drawer's doc link) and MongoDB's site. A new link to another
// host must be added here. GitHub is not path-pinned, so a repo rename cannot
// silently break the drawer link.
const EXTERNAL_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.mongodb.com']);
const SaveFileInput = z.object({
  defaultName: z.string().optional(),
  content: z.string(),
});
const NoInput = z.undefined().or(z.null()).or(z.object({}));
const SetUnsavedWorkInput = z.object({
  source: z.enum(['connectionForm', 'pipelines']),
  count: z.number().int().min(0).max(1000),
});
const LogInput = z.object({
  level: z.enum(['warn', 'error']),
  message: z.string().max(2000),
  source: z.enum(['window.error', 'unhandledrejection', 'errorBoundary', 'component']),
  stack: z.string().max(8000).optional(),
});

const PURPOSE_FILTERS: Record<PickFilePurpose, Electron.FileFilter[]> = {
  'tls-ca': [
    { name: 'Certificates', extensions: ['pem', 'crt', 'cer'] },
    { name: 'All files', extensions: ['*'] },
  ],
  'tls-client-cert': [
    { name: 'Certificates / keys', extensions: ['pem', 'crt', 'key', 'p12', 'pfx'] },
    { name: 'All files', extensions: ['*'] },
  ],
  'ssh-key': [
    { name: 'Private keys', extensions: ['pem', 'key', 'ppk'] },
    { name: 'All files', extensions: ['*'] },
  ],
  // No "All files" entry: `data:import` refuses any other extension anyway.
  'data-import': [
    { name: 'JSON / JSON Lines / CSV', extensions: ['json', 'jsonl', 'ndjson', 'csv'] },
  ],
};

const SAVE_FILTER_NAMES: Record<string, string> = { json: 'JSON', jsonl: 'JSON Lines', csv: 'CSV' };

/**
 * The save dialog's type filter follows the suggested file's extension: on
 * macOS a filter that doesn't list the extension being saved rewrites or
 * rejects it, so a CSV export must not be offered only a JSON filter.
 */
export function saveFilters(defaultName: string): FileFilter[] {
  const ext = path.extname(defaultName).slice(1).toLowerCase();
  const all = { name: 'All files', extensions: ['*'] };
  const name = Object.hasOwn(SAVE_FILTER_NAMES, ext) ? SAVE_FILTER_NAMES[ext] : undefined;
  return name ? [{ name, extensions: [ext] }, all] : [all];
}

/**
 * A full page load (a reload, or the page after a crash) gets a fresh
 * `app:log` allowance, so the errors of the page that replaced a looping one
 * still land. The app's own route changes are hash navigations: same-document,
 * and they keep the window they are in.
 */
export function resetGateOnFreshPage(
  webContents: { on(event: 'did-start-navigation', listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void): unknown },
  gate: RateGate,
): void {
  webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) gate.reset();
  });
}

/**
 * `pickedImports` collects every path the open dialog returned for
 * `data-import`: the data channels read a file only when it is in here, so
 * the renderer can hand back a file the user picked but never name another.
 * `pickedCredentialPaths` does the same for the TLS CA, TLS client-cert and SSH
 * key dialogs; the connection channels accept such a path only if it is in
 * there. Both are required, not optional, for the same reason the router's
 * sender check is.
 *
 * `unsaved` is the store the quit gate reads; the renderer's reports land in
 * it. Optional like `diagnostic`, and the channel fails the same way without it.
 * `onFlushDone` receives the renderer's answer to a flush request (see
 * `awaitRendererFlush`); optional and failing the same way.
 * `rendererLog` is where `app:log` lines go, through a rate gate main resets
 * on each fresh page; optional and failing the same way.
 */
export function registerAppChannels(
  router: Router,
  getWindow: () => BrowserWindow | null,
  pickedImports: Set<string>,
  pickedCredentialPaths: PickedCredentialPaths,
  diagnostic?: DiagnosticService,
  unsaved?: UnsavedWorkStore,
  onFlushDone?: () => void,
  rendererLog?: { log: Logger; gate: RateGate },
): void {
  router.register(
    IPC_CHANNELS.appPickFile,
    zodValidator(PickFileInput),
    async (purpose) => {
      const win = getWindow();
      const result = await dialog.showOpenDialog(win ?? undefined as unknown as BrowserWindow, {
        properties: ['openFile'],
        filters: PURPOSE_FILTERS[purpose],
      });
      if (result.canceled || result.filePaths.length === 0) return { path: null };
      const picked = result.filePaths[0]!;
      if (purpose === 'data-import') pickedImports.add(picked);
      else pickedCredentialPaths.record(purpose, picked);
      return { path: picked };
    },
  );

  router.register(
    IPC_CHANNELS.appOpenExternal,
    zodValidator(OpenExternalInput),
    async (url) => {
      const parsed = parseAllowedExternalUrl(url, EXTERNAL_HOSTS);
      await shell.openExternal(parsed.href);
      return { opened: true };
    },
  );

  router.register(
    IPC_CHANNELS.appSaveFile,
    zodValidator(SaveFileInput),
    async ({ defaultName, content }) => {
      const win = getWindow();
      const result = await dialog.showSaveDialog(
        win ?? (undefined as unknown as BrowserWindow),
        {
          defaultPath: defaultName ?? 'export.json',
          filters: saveFilters(defaultName ?? 'export.json'),
        },
      );
      if (result.canceled || !result.filePath) return { path: null };
      try {
        await fs.mkdir(path.dirname(result.filePath), { recursive: true });
        // Export file contents can include user data; write owner-only (0600).
        await writePrivateFile(result.filePath, content);
      } catch (err) {
        throw new SystemError(
          'INTERNAL',
          `failed to write file: ${(err as Error).message}`,
        );
      }
      return { path: result.filePath };
    },
  );

  router.register(
    IPC_CHANNELS.appDiagnosticBundle,
    zodValidator(NoInput),
    async () => {
      if (!diagnostic) {
        throw new SystemError('INTERNAL', 'diagnostic service not available');
      }
      const win = getWindow();
      const dialogOpts = {
        defaultPath: diagnostic.defaultFilename(),
        filters: [
          { name: 'JSON', extensions: ['json'] },
          { name: 'All files', extensions: ['*'] },
        ],
      };
      // Use the parented overload when we have a window; fall back to the
      // window-less overload otherwise. Avoids casting `undefined` to
      // BrowserWindow.
      const result = await (win
        ? dialog.showSaveDialog(win, dialogOpts)
        : dialog.showSaveDialog(dialogOpts));
      if (result.canceled || !result.filePath) return { path: null };
      const content = await diagnostic.serialize();
      try {
        await fs.mkdir(path.dirname(result.filePath), { recursive: true });
        // Diagnostic bundle contains connection metadata; write owner-only (0600).
        await writePrivateFile(result.filePath, content);
      } catch (err) {
        throw new SystemError(
          'INTERNAL',
          `failed to write diagnostic bundle: ${(err as Error).message}`,
        );
      }
      return { path: result.filePath };
    },
  );

  router.register(
    IPC_CHANNELS.appSetUnsavedWork,
    zodValidator(SetUnsavedWorkInput),
    async ({ source, count }) => {
      if (!unsaved) throw new SystemError('INTERNAL', 'unsaved-work store not available');
      unsaved[source] = count;
    },
  );

  router.register(
    IPC_CHANNELS.appFlushDone,
    zodValidator(NoInput),
    async () => {
      if (!onFlushDone) throw new SystemError('INTERNAL', 'flush acknowledgement sink not available');
      onFlushDone();
    },
  );

  // A render loop can throw on every frame, so the renderer gets a fixed
  // number of lines per window and the disk does not fill. A dropped line
  // still answers ok: the renderer has nothing useful to do with a refusal,
  // and must not log the refusal itself. The notice of the first drop is
  // written past the gate, or it would be dropped with the rest.
  router.register(
    IPC_CHANNELS.appLog,
    zodValidator(LogInput),
    async ({ level, message, source, stack }) => {
      if (!rendererLog) throw new SystemError('INTERNAL', 'renderer log sink not available');
      const verdict = rendererLog.gate.take();
      if (verdict.allow) {
        rendererLog.log[level]('renderer', message, { source, stack });
      } else if (verdict.firstDrop) {
        rendererLog.log.warn(
          'renderer',
          `renderer log rate limit reached; dropping until ${new Date(verdict.until).toISOString()}`,
        );
      }
    },
    // The gate above decides what is logged; the router's own per-call lines would bypass it.
    { quiet: true },
  );
}
