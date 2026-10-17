import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { Router } from '../router.ts';
import { zodValidator } from '../validators.ts';
import type { UpdateService } from '../../services/UpdateService.ts';

const NoInput = z.undefined().or(z.null()).or(z.object({}).strict());

export function registerUpdatesChannels(router: Router, svc: UpdateService): void {
  router.register(IPC_CHANNELS.updatesGetState, zodValidator(NoInput), () => svc.getState());
  router.register(IPC_CHANNELS.updatesRestart, zodValidator(NoInput), async () => ({
    restarting: await svc.restart(),
  }));
}
