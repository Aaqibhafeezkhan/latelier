import React from 'react';
import { notify } from '../../../theme/notifications';
import { confirmDestructive } from '../../../utils/confirm';
import { condFromDragged } from '../builder';
import type { CollectionWorkspaceContextValue } from '../context';
import { andAtRoot, parseFilter, printFilter } from '../filterTree';

/**
 * Non-drag discovery path onto the Query Builder: the same root-level insert
 * the pane's own drop does. Confirms whenever the Filter drawer is open —
 * deliberate over-warn, since it may hold newer local input this patch
 * (direct to state.queryRaw) can't see and would silently discard.
 */
export function useAddToFilter({
  state,
  actions,
}: Pick<CollectionWorkspaceContextValue, 'state' | 'actions'>) {
  return React.useCallback(
    async (fieldPath: string, value: unknown) => {
      if (state.activeBuilderTab === 'Builder') {
        const proceed = await confirmDestructive({
          title: 'Add to filter?',
          body: 'The filter drawer is open and may hold edits that haven\'t been applied yet. Adding this field will replace the drawer\'s content.',
          confirmLabel: 'Add',
        });
        if (!proceed) return;
      }
      const parsed = parseFilter(state.queryRaw);
      if (!parsed.ok) {
        notify.error("Nothing added — the filter bar's text isn't valid JSON.");
        return;
      }
      const nextRoot = andAtRoot(parsed.root, condFromDragged({ field: fieldPath, value }));
      const printed = printFilter(nextRoot);
      if (!printed.ok) {
        notify.error('Nothing added — the filter could not be updated.');
        return;
      }
      actions.expandBuilder?.();
      actions.patch({ queryRaw: printed.json });
    },
    [state.queryRaw, state.activeBuilderTab, actions],
  );
}
