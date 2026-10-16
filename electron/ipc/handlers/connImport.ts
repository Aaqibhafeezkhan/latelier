import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ImportWizardService } from '../../services/ImportWizardService.ts';
import { MAX_URI_LENGTH, MAX_URI_LINES } from '../../services/connectionBulkAdd.ts';
import { MAP_TARGETS } from '../../services/import/unknownJson.ts';
import type { Router } from '../router.ts';
import { NonEmpty, zodValidator } from '../validators.ts';

/** Bounds every per-row array of a commit; no import holds more rows than this. */
const MAX_ROWS = 1000;
/** A field path is dot-joined keys from the file; this only stops an absurd payload. */
const MAX_PATH_LENGTH = 4096;

const Index = z.number().int().min(0);
const Path = z.string().max(MAX_PATH_LENGTH);

const OpenInput = z.undefined().or(z.null()).or(z.strictObject({}));

const MapInput = z.strictObject({
  token: NonEmpty,
  // '' is the top level: a top-level array, or a lone top-level object.
  at: Path,
  mapping: z
    .partialRecord(z.enum(MAP_TARGETS as [string, ...string[]]), Path.min(1))
    // C14 §5.3: each path goes to at most one target.
    .refine((m) => new Set(Object.values(m)).size === Object.values(m).length, {
      message: 'A field can be mapped to one target only',
    }),
});

const UrisInput = z.strictObject({
  uris: z.array(z.string().min(1).max(MAX_URI_LENGTH)).min(1).max(MAX_URI_LINES),
});

const CommitInput = z.strictObject({
  token: NonEmpty,
  indices: z
    .array(Index)
    .min(1)
    .max(MAX_ROWS)
    .refine((ix) => new Set(ix).size === ix.length, { message: 'Each connection can only be imported once' }),
  passphrase: z.string().min(1).optional(),
  withoutSecrets: z.boolean().optional(),
  readOnly: z.boolean(),
  credentials: z
    .array(
      z.strictObject({
        index: Index,
        username: z.string().max(128).optional(),
        password: z.string().optional(),
      }),
    )
    .max(MAX_ROWS),
  directConnection: z.array(z.strictObject({ index: Index, value: z.boolean() })).max(MAX_ROWS),
});

/**
 * The Import Wizard (C14 §8). Main owns the dialog and the file: no path, no
 * file contents and no plaintext secret is in any result.
 */
export function registerConnImportChannels(router: Router, svc: ImportWizardService): void {
  router.register(IPC_CHANNELS.connImportOpen, zodValidator(OpenInput), () => svc.importOpen());

  // Field paths and targets only; the values stay in main.
  router.register(IPC_CHANNELS.connImportMap, zodValidator(MapInput), (input) => svc.importMap(input));

  // SECRET_INPUT: 'conn:importUris' payload is connection strings that may embed passwords.
  router.register(IPC_CHANNELS.connImportUris, zodValidator(UrisInput), ({ uris }) =>
    svc.importUris(uris),
  );

  // SECRET_INPUT: 'conn:importCommit' payload carries the export passphrase and typed passwords.
  router.register(IPC_CHANNELS.connImportCommit, zodValidator(CommitInput), (input) =>
    svc.importCommit(input),
  );
}
