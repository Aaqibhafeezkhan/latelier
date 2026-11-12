import type { CollectionTab, SavedQuerySummary } from '@shared/types';
import type { WorkspaceTabsState } from '../../state/workspaceTabs';
import { getErrorMessage, isIpcError } from '../../api/atelier';
import { notify } from '../../theme/notifications';
import { confirmDestructive } from '../../utils/confirm';

// What the saved-queries UI does with a saved query, shared with the palette's
// Saved objects so the two cannot drift apart.

/** The question the saved list asks before deleting one; true to go ahead. */
export function confirmDeleteSaved(target: Pick<SavedQuerySummary, 'name'>): Promise<boolean> {
  return confirmDestructive({
    title: `Delete "${target.name}"?`,
    body: 'This removes the saved query. This action cannot be undone.',
    confirmLabel: 'Delete',
  });
}

/** Gives every open pipeline tab of saved pipeline `savedId` its new name. */
export function renameOpenPipelines(
  tabs: Pick<WorkspaceTabsState, 'tabs' | 'patchAggregationState'>,
  savedId: string,
  name: string,
): void {
  for (const t of tabs.tabs) {
    if (t.kind === 'collection' && t.state.aggregation?.savedId === savedId) tabs.patchAggregationState(t.id, { name });
  }
}

/**
 * Opens a saved pipeline on its collection's Aggregation view. Main loads the
 * stored stages and refuses a pipeline deleted since the list loaded: that
 * says so rather than leave the click doing nothing. Null when the tab kept
 * its unsaved edits instead, or the open failed.
 */
export function openSavedPipeline(
  tabs: Pick<WorkspaceTabsState, 'openAggregation'>,
  saved: Pick<SavedQuerySummary, 'id' | 'name' | 'connectionId' | 'dbName' | 'collection'>,
): Promise<CollectionTab | null> {
  return tabs
    .openAggregation({
      connectionId: saved.connectionId,
      dbName: saved.dbName,
      collection: saved.collection,
      savedId: saved.id,
      name: saved.name,
    })
    .catch((e: unknown) => {
      notify.error(
        // Main's NOT_FOUND text names the row by its id.
        isIpcError(e) && e.code === 'NOT_FOUND' ? 'It no longer exists.' : getErrorMessage(e, String(e)),
        { title: `Could not open “${saved.name}”` },
      );
      return null;
    });
}
