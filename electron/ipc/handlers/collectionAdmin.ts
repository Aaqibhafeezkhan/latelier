import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { Router } from '../router.ts';
import { CollectionTargetSchema, NonEmpty, zodValidator } from '../validators.ts';
import type { CollectionAdminService } from '../../mongo/CollectionAdminService.ts';

const CreateOptions = z.object({
  capped: z.boolean().optional(),
  size: z.number().int().positive().optional(),
  max: z.number().int().positive().optional(),
  timeseries: z
    .object({
      timeField: NonEmpty,
      metaField: z.string().optional(),
      granularity: z.enum(['seconds', 'minutes', 'hours']).optional(),
    })
    .optional(),
  expireAfterSeconds: z.number().int().nonnegative().optional(),
  collation: z.string().optional(),
  validator: z.string().optional(),
  validationLevel: z.enum(['off', 'strict', 'moderate']).optional(),
  validationAction: z.enum(['error', 'warn', 'errorAndLog']).optional(),
  viewOn: NonEmpty.optional(),
  pipeline: z.string().optional(),
}).refine((o) => o.pipeline === undefined || o.viewOn !== undefined, {
  message: 'pipeline requires viewOn',
  path: ['pipeline'],
});

const CreateInput = CollectionTargetSchema.extend({
  options: CreateOptions,
});

const ModifyOptions = z
  .object({
    validator: z.string().optional(),
    validationLevel: z.enum(['off', 'strict', 'moderate']).optional(),
    validationAction: z.enum(['error', 'warn', 'errorAndLog']).optional(),
    viewOn: NonEmpty.optional(),
    pipeline: z.string().optional(),
  })
  .superRefine((o, ctx) => {
    const isView = o.viewOn !== undefined || o.pipeline !== undefined;
    const isValidation =
      o.validator !== undefined || o.validationLevel !== undefined || o.validationAction !== undefined;
    if (!isView && !isValidation) {
      ctx.addIssue({ code: 'custom', message: 'nothing to modify' });
    }
    // collMod rewrites a view's definition whole, so half of one is refused here.
    if ((o.viewOn === undefined) !== (o.pipeline === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'viewOn and pipeline go together', path: ['viewOn'] });
    }
    if (isView && isValidation) {
      ctx.addIssue({ code: 'custom', message: 'a view has no validation rules' });
    }
  });

const ModifyInput = CollectionTargetSchema.extend({
  options: ModifyOptions,
});

const DropInput = CollectionTargetSchema;

const RenameInput = CollectionTargetSchema.extend({
  newName: NonEmpty,
});

const DatabaseDropInput = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty,
});

export function registerCollectionAdminChannels(
  router: Router,
  svc: CollectionAdminService,
): void {
  router.register(
    IPC_CHANNELS.collectionCreate,
    zodValidator(CreateInput),
    (input) => svc.create(input),
  );

  router.register(
    IPC_CHANNELS.collectionDrop,
    zodValidator(DropInput),
    (input) => svc.drop(input),
  );

  router.register(
    IPC_CHANNELS.collectionRename,
    zodValidator(RenameInput),
    (input) => svc.rename(input),
  );

  router.register(
    IPC_CHANNELS.collectionModify,
    zodValidator(ModifyInput),
    (input) => svc.modify(input),
  );

  router.register(
    IPC_CHANNELS.databaseDrop,
    zodValidator(DatabaseDropInput),
    (input) => svc.dropDatabase(input),
  );
}
