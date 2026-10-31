import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import type { Router } from '../router.ts';
import { zodValidator } from '../validators.ts';
import { PLAINTEXT_FALLBACK_KEY } from '../prefKeys.ts';
import type { AppStateService } from '../../services/AppStateService.ts';

const SetPlaintextFallbackInput = z.object({ enabled: z.boolean() });

/**
 * `confirm` shows main's own native warning (see `electron/main.ts`). The
 * renderer's modal is only UX — a compromised renderer can skip it — so this
 * prompt is what actually gates turning the fallback on. Turning it off needs
 * no prompt.
 */
export function registerSecretsChannels(
  router: Router,
  appState: AppStateService,
  confirm: () => Promise<boolean>,
  status: () => { columnKeyProtected: boolean },
): void {
  // Read-only and input-free: Settings shows whether local data is protected.
  router.register(IPC_CHANNELS.secretsStatus, zodValidator(z.undefined().or(z.null()).optional()), () => status());

  router.register(
    IPC_CHANNELS.secretsSetPlaintextFallback,
    zodValidator(SetPlaintextFallbackInput),
    async ({ enabled }) => {
      if (!enabled) {
        appState.set(PLAINTEXT_FALLBACK_KEY, false);
        return { enabled: false };
      }
      if (!(await confirm())) {
        return { enabled: appState.get<boolean>(PLAINTEXT_FALLBACK_KEY) === true };
      }
      appState.set(PLAINTEXT_FALLBACK_KEY, true);
      return { enabled: true };
    },
  );
}
