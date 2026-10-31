import { api } from '../../api/atelier';
import { logFailure } from '../../utils/rendererLog';

/**
 * Tells main whether the connection form holds unsaved changes, so quitting
 * or closing the window asks first and names it (F06). A failed report only
 * costs that question, so it is logged, not surfaced.
 */
export function reportConnectionFormDirty(dirty: boolean): void {
  api.app
    .setUnsavedWork({ source: 'connectionForm', count: dirty ? 1 : 0 })
    .catch((err) => logFailure('reporting the connection form as unsaved', err));
}
