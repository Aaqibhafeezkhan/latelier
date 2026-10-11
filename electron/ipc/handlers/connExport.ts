import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ConnectionExportService } from '../../services/ConnectionExportService.ts';
import type { Router } from '../router.ts';
import { NonEmpty, zodValidator } from '../validators.ts';

/** The Export Passphrase floor (C13 §2); the renderer enforces the same and the entry-twice rule. */
const MIN_PASSPHRASE_LENGTH = 12;

const ExportInput = z
  .strictObject({
    ids: z.array(NonEmpty).min(1),
    includeSecrets: z.boolean(),
    passphrase: z.string().min(MIN_PASSPHRASE_LENGTH).optional(),
  })
  .refine((v) => !v.includeSecrets || v.passphrase !== undefined, {
    path: ['passphrase'],
    message: 'An Export Passphrase is required to include passwords',
  });

/**
 * Kept apart from `conn.ts` so that file's signature and its test fixtures stay
 * as they are. Neither the file's path nor any decrypted secret is in any
 * payload or result: main owns the dialogs and the file.
 */
export function registerConnExportChannels(router: Router, svc: ConnectionExportService): void {
  // SECRET_INPUT: 'conn:export' payload carries the Export Passphrase.
  router.register(IPC_CHANNELS.connExport, zodValidator(ExportInput), (input) =>
    svc.export(input),
  );
}
