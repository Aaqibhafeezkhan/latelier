import { useEffect } from 'react';
import { api, getErrorMessage } from '../../api/atelier';
import { logFailure } from '../../utils/rendererLog';
import { notify } from '../../theme/notifications';
import type { UpdateState } from '@shared/types';

const TOAST_ID = 'update-ready';

function showReady(version: string): void {
  notify.info(`Version ${version} is ready`, {
    id: TOAST_ID,
    autoClose: false,
    action: {
      label: 'Restart to update',
      onClick: () => {
        api.updates.restart().catch((e: unknown) => {
          notify.error(
            `${getErrorMessage(e, 'The update could not be applied')}. It will be applied when you quit.`,
          );
        });
      },
    },
  });
}

/** Renders nothing: surfaces one non-modal toast once an update has downloaded. */
export function UpdateReadyPrompt() {
  useEffect(() => {
    const onState = (s: UpdateState) => {
      if (s.status === 'ready') showReady(s.version);
    };
    // The push can fire before this mounts, so ask once, then listen.
    api.updates
      .getState()
      .then(onState)
      // The prompt is optional: a failed read leaves it unshown, and an update
      // that is ready still installs on quit.
      .catch((err) => logFailure('reading the update state', err));
    return api.updates.onState(onState);
  }, []);
  return null;
}
