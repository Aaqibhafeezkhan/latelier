import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { Router } from '../router.ts';
import { CollectionTargetSchema, NonEmpty, zodValidator } from '../validators.ts';
import type { QueryService } from '../../mongo/QueryService.ts';
import type { ReadPreferenceMode } from '@shared/types';

const READ_PREFERENCES = [
  'primary',
  'primaryPreferred',
  'secondary',
  'secondaryPreferred',
  'nearest',
] as const satisfies readonly ReadPreferenceMode[];

/**
 * `FindMatchOptions` (W14 §9): collation and hint stay text here and are
 * parsed main-side by `QueryService`, like `filter`/`sort`. Shared by every
 * channel that must see the same documents as the find on screen.
 */
const MatchOptionsShape = {
  collation: z.string().optional(),
  hint: z.string().optional(),
  readPreference: z.enum(READ_PREFERENCES).optional(),
};

export const FindInputSchema = CollectionTargetSchema.extend({
  ...MatchOptionsShape,
  filter: NonEmpty,
  projection: z.string().optional(),
  sort: z.string().optional(),
  limit: z.number().int().min(1).max(1000),
  // Cap deep pagination: Mongo walks and discards `skip` docs server-side, so
  // an unbounded skip is an O(n) scan with no time ceiling. 10M is far past any
  // realistic GUI paging while still bounding the pathological case.
  skip: z.number().int().min(0).max(10_000_000),
  ejsonRelaxed: z.boolean().optional(),
  cancelToken: z.string().optional(),
  maxTimeMS: z.number().int().min(1).optional(),
});

export const CountInputSchema = CollectionTargetSchema.extend({
  ...MatchOptionsShape,
  filter: NonEmpty,
  ejsonRelaxed: z.boolean().optional(),
});

const FindOneInputSchema = CollectionTargetSchema.extend({
  filter: NonEmpty,
  projection: z.string().optional(),
  sort: z.string().optional(),
});

export const ExplainInputSchema = CollectionTargetSchema.extend({
  ...MatchOptionsShape,
  filter: NonEmpty,
  projection: z.string().optional(),
  sort: z.string().optional(),
  ejsonRelaxed: z.boolean().optional(),
  verbosity: z.enum(['queryPlanner', 'executionStats', 'allPlansExecution']),
});

const CancelInputSchema = z.object({
  token: NonEmpty,
});

const ExportColumnSchema = z.object({
  header: z.string(),
  path: NonEmpty,
});

export const ExportInputSchema = CollectionTargetSchema.extend({
  ...MatchOptionsShape,
  filter: NonEmpty,
  sort: z.string().optional(),
  projection: z.string().optional(),
  limit: z.number().int().min(1).optional(),
  format: z.enum(['json', 'jsonl', 'csv']),
  relaxed: z.boolean().optional(),
  columns: z.array(ExportColumnSchema).optional(),
  defaultName: z.string().optional(),
}).refine((v) => v.format !== 'csv' || (v.columns && v.columns.length > 0), {
  message: 'columns are required for a CSV export',
  path: ['columns'],
});

/**
 * Opens the save dialog and returns the chosen path, or `null` on cancel.
 * A closure rather than an injected `dialog`/`BrowserWindow` pair so
 * `query.ts` never imports `electron` itself — see `app.ts`'s `saveFile`,
 * which this mirrors (same cancel shape, same `saveFilters` type filter).
 */
export type PickSavePath = (defaultName: string) => Promise<string | null>;

export function registerQueryChannels(
  router: Router,
  svc: QueryService,
  pickSavePath: PickSavePath,
): void {
  router.register(
    IPC_CHANNELS.queryFind,
    zodValidator(FindInputSchema),
    (input) => svc.find(input),
  );

  router.register(
    IPC_CHANNELS.queryCount,
    zodValidator(CountInputSchema),
    (input) => svc.count(input),
  );

  router.register(
    IPC_CHANNELS.queryFindOne,
    zodValidator(FindOneInputSchema),
    (input) => svc.findOne(input),
  );

  router.register(
    IPC_CHANNELS.queryExplain,
    zodValidator(ExplainInputSchema),
    (input) => svc.explain(input),
  );

  router.register(
    IPC_CHANNELS.queryCancel,
    zodValidator(CancelInputSchema),
    ({ token }) => {
      svc.cancel(token);
      return undefined;
    },
  );

  router.register(
    IPC_CHANNELS.queryExport,
    zodValidator(ExportInputSchema),
    async (input) => {
      const defaultName = input.defaultName ?? `${input.collection}.${input.format}`;
      const path = await pickSavePath(defaultName);
      if (path === null) return { path: null, written: 0, truncated: false };
      const { written, truncated } = await svc.exportToFile(input, path);
      return { path, written, truncated };
    },
  );
}
