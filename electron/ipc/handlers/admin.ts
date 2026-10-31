import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { Router } from '../router.ts';
import { NonEmpty, zodValidator } from '../validators.ts';
import type { MonitorService } from '../../mongo/MonitorService.ts';

const Level = z.union([z.literal(0), z.literal(1), z.literal(2)]);

const CurrentOpInput = z.object({
  connectionId: NonEmpty,
  activeOnly: z.boolean().optional(),
  minSecsRunning: z.number().int().min(0).optional(),
});

const KillOpInput = z.object({
  connectionId: NonEmpty,
  opid: NonEmpty,
});

const DbInput = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty,
});

const SetProfileLevelInput = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty,
  level: Level,
  slowms: z.number().int().min(0).optional(),
});

const ProfileTailInput = z.object({
  connectionId: NonEmpty,
  dbName: NonEmpty,
  limit: z.number().int().min(1).max(100).optional(),
});

export function registerAdminChannels(router: Router, svc: MonitorService): void {
  router.register(IPC_CHANNELS.adminCurrentOp, zodValidator(CurrentOpInput), (input) =>
    svc.currentOp(input),
  );
  router.register(IPC_CHANNELS.adminKillOp, zodValidator(KillOpInput), (input) =>
    svc.killOp(input),
  );
  router.register(IPC_CHANNELS.adminProfileStatus, zodValidator(DbInput), (input) =>
    svc.profileStatus(input),
  );
  router.register(IPC_CHANNELS.adminSetProfileLevel, zodValidator(SetProfileLevelInput), (input) =>
    svc.setProfileLevel(input),
  );
  router.register(IPC_CHANNELS.adminProfileTail, zodValidator(ProfileTailInput), (input) =>
    svc.profileTail(input),
  );
}
