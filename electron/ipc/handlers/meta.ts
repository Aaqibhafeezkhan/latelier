import { z } from 'zod';
import { SCHEMA_SAMPLE_MAX } from '@shared/defaults';
import { IPC_CHANNELS } from '@shared/ipc';
import type { Router } from '../router.ts';
import { CollectionTargetSchema, NonEmpty, zodValidator } from '../validators.ts';
import type { MetaService } from '../../mongo/MetaService.ts';

const ListDbsInput = z.object({
  connectionId: NonEmpty,
  includeSystem: z.boolean().optional(),
});

const ListCollsInput = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty,
});

const SampleSchemaInput = CollectionTargetSchema.extend({
  size: z.number().int().min(1).max(SCHEMA_SAMPLE_MAX).optional(),
});

export function registerMetaChannels(router: Router, svc: MetaService): void {
  router.register(
    IPC_CHANNELS.metaListDatabases,
    zodValidator(ListDbsInput),
    (input) => svc.listDatabases(input),
  );

  router.register(
    IPC_CHANNELS.metaListCollections,
    zodValidator(ListCollsInput),
    (input) => svc.listCollections(input),
  );

  router.register(
    IPC_CHANNELS.metaSampleSchema,
    zodValidator(SampleSchemaInput),
    (input) => svc.sampleSchema(input),
  );

  router.register(
    IPC_CHANNELS.metaCollectionDetails,
    zodValidator(CollectionTargetSchema),
    (input) => svc.collectionDetails(input),
  );
}
