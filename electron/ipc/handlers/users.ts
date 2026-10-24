import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { Router } from '../router.ts';
import { NonEmpty, zodValidator } from '../validators.ts';
import type { UserService } from '../../mongo/UserService.ts';

const ListInput = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty.optional(),
});

const GetInput = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty,
  username: NonEmpty,
});

const RoleListInput = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty,
});

const Mechanism = z.union([
  z.literal('SCRAM-SHA-1'),
  z.literal('SCRAM-SHA-256'),
  z.literal('MONGODB-X509'),
  z.literal('PLAIN'),
  z.literal('GSSAPI'),
  z.literal('MONGODB-AWS'),
  z.literal('MONGODB-OIDC'),
]);

const RoleRef = z.object({
  role: NonEmpty,
  db: NonEmpty,
});

const CreateInput = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty,
  username: NonEmpty,
  password: NonEmpty,
  roles: z.array(RoleRef).min(1),
  mechanisms: z.array(Mechanism).optional(),
  customData: z.string().optional(),
});

const UpdateInput = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty,
  username: NonEmpty,
  patch: z.object({
    roles: z.array(RoleRef).optional(),
    password: NonEmpty.optional(),
    customData: z.string().optional(),
    mechanisms: z.array(Mechanism).optional(),
  }),
});

const DropInput = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty,
  username: NonEmpty,
});

const RoleCreateInput = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty,
  role: NonEmpty,
  privileges: z.string(),
  // A role, unlike a user, may inherit nothing.
  roles: z.array(RoleRef),
});

const RoleUpdateInput = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty,
  role: NonEmpty,
  patch: z.object({
    privileges: z.string().optional(),
    roles: z.array(RoleRef).optional(),
  }),
});

const RoleDropInput = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty,
  role: NonEmpty,
});

export function registerUserChannels(router: Router, svc: UserService): void {
  router.register(IPC_CHANNELS.userList, zodValidator(ListInput), (input) => svc.list(input));
  router.register(IPC_CHANNELS.userGet, zodValidator(GetInput), (input) => svc.get(input));
  // SECRET_INPUT: 'user:create' payload carries plaintext password.
  router.register(IPC_CHANNELS.userCreate, zodValidator(CreateInput), (input) =>
    svc.create(input),
  );
  // SECRET_INPUT: 'user:update' patch may carry plaintext password.
  router.register(IPC_CHANNELS.userUpdate, zodValidator(UpdateInput), (input) =>
    svc.update(input),
  );
  router.register(IPC_CHANNELS.userDrop, zodValidator(DropInput), (input) => svc.drop(input));
  router.register(IPC_CHANNELS.roleList, zodValidator(RoleListInput), (input) =>
    svc.listRoles(input),
  );
  router.register(IPC_CHANNELS.roleCreate, zodValidator(RoleCreateInput), (input) =>
    svc.createRole(input),
  );
  router.register(IPC_CHANNELS.roleUpdate, zodValidator(RoleUpdateInput), (input) =>
    svc.updateRole(input),
  );
  router.register(IPC_CHANNELS.roleDrop, zodValidator(RoleDropInput), (input) =>
    svc.dropRole(input),
  );
}
