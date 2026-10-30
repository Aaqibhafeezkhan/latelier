import { useEffect } from 'react';
import { api } from '../../api/atelier';
import { logFailure } from '../../utils/rendererLog';
import { flushAll } from '../../state/pendingFlush';

/**
 * Renders nothing: answers main's flush request before it quits. Main ends
 * the app with `app.exit`, which skips the page's unload events, so the
 * held-back tab edits go out here instead (a window close or a reload does
 * fire `pagehide`, which the tab state listens for itself). It answers even with
 * nothing registered (no Workspace mounted), so main does not wait out its
 * timeout for nothing.
 */
export function FlushOnQuit() {
  useEffect(
    () =>
      api.app.onFlushRequest(() => {
        // A refused answer only costs main its timeout wait; the log says why.
        flushAll()
          .finally(() => api.app.flushDone())
          .catch((err) => logFailure('flushing tabs on quit', err));
      }),
    [],
  );
  return null;
}
