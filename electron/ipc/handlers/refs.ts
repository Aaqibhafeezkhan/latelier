import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { Router } from '../router.ts';
import { NonEmpty, zodValidator } from '../validators.ts';
import type { ReferenceRulesService } from '../../services/ReferenceRulesService.ts';

// A namespace is both names or neither: `dbName` alone used to fall through
// to the whole connection's rules, answering a question nobody asked.
const ListInputSchema = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty.optional(),
  collection: NonEmpty.optional(),
}).refine((i) => (i.dbName === undefined) === (i.collection === undefined), {
  message: 'dbName and collection must be given together',
});

const GetInputSchema = z.object({ id: NonEmpty });
const DeleteInputSchema = z.object({ id: NonEmpty });

const CreateInputSchema = z.object({
  connectionId: NonEmpty,
  sourceDb: NonEmpty,
  sourceCollection: NonEmpty,
  sourceField: NonEmpty,
  targetDb: NonEmpty,
  targetCollection: NonEmpty,
  targetField: NonEmpty.optional(),
  projection: z.array(z.string()).optional(),
  displayTemplate: z.string().optional(),
  enabled: z.boolean().optional(),
});

const UpdateInputSchema = z.object({
  id: NonEmpty,
  patch: z.object({
    targetDb: NonEmpty.optional(),
    targetCollection: NonEmpty.optional(),
    targetField: NonEmpty.optional(),
    projection: z.array(z.string()).optional(),
    displayTemplate: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
});

const ResolveInputSchema = z.object({
  ruleId: NonEmpty,
  valueEjson: z.string(),
});

const AutodetectInputSchema = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty,
  collection: NonEmpty,
  sampleDocs: z.array(z.unknown()).optional(),
});

export function registerRefsChannels(
  router: Router,
  svc: ReferenceRulesService,
): void {
  router.register(
    IPC_CHANNELS.refsList,
    zodValidator(ListInputSchema),
    ({ connectionId, dbName, collection }) => {
      if (dbName && collection) {
        return svc.listForCollection(connectionId, dbName, collection);
      }
      return svc.list(connectionId);
    },
  );

  router.register(
    IPC_CHANNELS.refsGet,
    zodValidator(GetInputSchema),
    ({ id }) => svc.get(id),
  );

  router.register(
    IPC_CHANNELS.refsCreate,
    zodValidator(CreateInputSchema),
    (input) => svc.create(input),
  );

  router.register(
    IPC_CHANNELS.refsUpdate,
    zodValidator(UpdateInputSchema),
    ({ id, patch }) => svc.update(id, patch),
  );

  router.register(
    IPC_CHANNELS.refsDelete,
    zodValidator(DeleteInputSchema),
    ({ id }) => {
      svc.delete(id);
      return undefined;
    },
  );

  router.register(
    IPC_CHANNELS.refsResolve,
    zodValidator(ResolveInputSchema),
    (input) => svc.resolve(input),
  );

  router.register(
    IPC_CHANNELS.refsAutodetect,
    zodValidator(AutodetectInputSchema),
    (input) => svc.autodetect(input),
  );
}
