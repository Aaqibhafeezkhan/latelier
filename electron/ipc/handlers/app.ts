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
 * `pickedImports` collects every path the open dialog returned for
 * `data-import`: the data channels read a file only when it is in here, so
 * the renderer can hand back a file the user picked but never name another.
 * `pickedCredentialPaths` does the same for the TLS CA, TLS client-cert and SSH
 * key dialogs; the connection channels accept such a path only if it is in
 * there. Both are required, not optional, for the same reason the router's
 * sender check is.
 */
export function registerAppChannels(
  router: Router,
  getWindow: () => BrowserWindow | null,
  pickedImports: Set<string>,
  pickedCredentialPaths: PickedCredentialPaths,
  diagnostic?: DiagnosticService,
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
}
