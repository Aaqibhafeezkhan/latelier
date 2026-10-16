import { createContext, use } from 'react';
import type { CollectionTabState } from '@shared/types';
import type { IndexSuggestion } from '../../utils/indexSuggestion';

/**
 * Actions exposed to any subtree inside a `<CollectionWorkspaceProvider>`.
 *
 * The provider's parent owns the underlying state (page-level `useState` for
 * modals, `useWorkspaceTabs` for the tab slice). Children just call into the
 * surface declared here — they don't know whether they're attached to a real
 * tab, a saved-query preview, or a synthetic snapshot.
 *
 * Stability: all callbacks are stable refs across renders. Memoise them at
 * the provider's parent (`useCallback` / `useMemo`) so subtree re-renders
 * aren't triggered by action-identity churn.
 */
/** How an inline field write ended; `message` is what the editor shows. */
export type UpdateFieldOutcome = { ok: true } | { ok: false; message: string };

export interface CollectionWorkspaceActions {
  /** Merge a partial state patch (debounced through `api.tabs.update`). */
  patch: (p: Partial<CollectionTabState>) => void;
  /** Functional patch — receives current state, returns patch. */
  patchWith: (fn: (s: CollectionTabState) => Partial<CollectionTabState>) => void;
  /** Trigger a find run. Optional override merges into the in-flight patch. */
  run: (override?: Partial<CollectionTabState>) => void;
  /** Cancel the in-flight find, if any. A no-op otherwise. */
  cancel: () => void;
  /**
   * Open the Document Editor on one document. `focusPath` (W18 §8's
   * "open the Document Editor on that field") scrolls that top-level row
   * into view and focuses it once the editor mounts, instead of leaving the
   * editor at its default scroll position.
   */
  openEdit: (doc: unknown, focusPath?: string) => void;
  /** Open the per-document delete confirmation. */
  openDelete: (doc: unknown) => void;
  /** Open the delete-all-matching confirmation, scoped to the tab's current query filter. */
  openDeleteAll: () => void;
  /** Open the update-all-matching confirmation, scoped to the tab's current query filter. */
  openUpdateAll: () => void;
  /** Open the insert-document drawer. */
  openInsert: () => void;
  /** Open the save-query modal. */
  openSave: () => void;
  /**
   * Make the builder pane visible. Any action that targets
   * `state.activeBuilderTab` from outside the pane must call this first —
   * while collapsed the pane is unmounted, so switching its tab alone is a
   * silent no-op. Optional: providers with no builder pane (saved-query
   * preview, ScriptTab's synthetic provider) simply omit it.
   */
  expandBuilder?: () => void;
  /**
   * Inline single-field edit (W18 §8, Quick Edit) — writes `fieldPath`
   * through the Document Editor's own guarded save path (`documentDiff.ts`'s
   * `buildUpdateRequest`: a one-path `$set`/`$unset` with a compare-and-set
   * guard), without opening the editor. `newValue` is the field's own typed
   * value — a `string`, a `boolean`, or a revived BSON numeric instance
   * (`Int32`/`Long`/`Double`/`Decimal128`) — never a re-typed string for a
   * non-string field, so the loaded BSON type survives the round trip.
   * Optional because it's a leaf-only affordance: read-only providers
   * (saved-query preview, ScriptTab's synthetic result provider) simply omit
   * it, and consumers must treat a missing `updateField` the same as
   * `isReadOnly` — no affordance shown. Returns the write's settlement and
   * never rejects: the boolean toggle has no separate draft to gate a second
   * click on, so it disables itself until this resolves, and the text/number
   * editor keeps the typed value open with `message` when the write failed.
   * The failure is also reported through `notify.error`.
   */
  updateField?: (doc: unknown, fieldPath: string, newValue: unknown) => Promise<UpdateFieldOutcome>;
  /**
   * Open the Document Editor's insert mode pre-filled with `doc`'s EJSON
   * minus `_id` ("Duplicate document"). Optional for the same reason as
   * `updateField`.
   */
  openDuplicate?: (doc: unknown) => void;
  /**
   * Switches to the Structure view and opens `IndexesTab`'s create-index
   * drawer prefilled from `suggestion` (`null` prefills nothing — every
   * `suggestIndex` refusal still opens the drawer, just empty). Driven by
   * `ExplainDrawer`'s "Create an index for this query" on a COLLSCAN.
   * Optional like `expandBuilder`: providers with no Structure view (saved-
   * query preview, ScriptTab's synthetic provider) simply omit it, and
   * `QueryBar` passes no `onCreateIndex` to `ExplainDrawer` when it's absent.
   */
  openCreateIndex?: (suggestion: IndexSuggestion | null) => void;
}

/**
 * Identity + target metadata for the active collection workspace. `tabId` may
 * be a synthetic id (e.g. `'preview'`) when the provider is constructed for a
 * non-tab consumer like a saved-query preview.
 */
export interface CollectionWorkspaceMeta {
  connectionId: string;
  dbName: string;
  collection: string;
  tabId: string;
  isLoading: boolean;
  /**
   * Read-only consumers (preview, snapshot) set this so leaf components can
   * short-circuit destructive UI without per-leaf prop wiring.
   */
  isReadOnly?: boolean;
}

/**
 * Single context value the provider exposes — split into `state` (the data),
 * `actions` (mutators), and `meta` (identity / flags). This `{ state, actions,
 * meta }` shape lets synthetic consumers (saved-query preview, aggregation
 * snapshot) construct a provider value without re-implementing leaf logic.
 */
export interface CollectionWorkspaceContextValue {
  state: CollectionTabState;
  actions: CollectionWorkspaceActions;
  meta: CollectionWorkspaceMeta;
}

export const CollectionWorkspaceContext =
  createContext<CollectionWorkspaceContextValue | null>(null);

/**
 * Subtree hook for accessing the active collection workspace. Throws when
 * called outside a provider so missing-wrapper bugs surface at the call site
 * instead of as silent null-deref later.
 */
export function useCollectionWorkspace(): CollectionWorkspaceContextValue {
  const value = use(CollectionWorkspaceContext);
  if (!value) {
    throw new Error(
      'useCollectionWorkspace must be called inside <CollectionWorkspaceProvider>',
    );
  }
  return value;
}

// Re-export the provider so consumers can satisfy spec X11's single-import
// contract: `import { CollectionWorkspaceProvider, useCollectionWorkspace }
// from './context'`. The provider lives in a sibling .tsx file because the
// react-refresh lint rule wants component-only files.
export { CollectionWorkspaceProvider } from './CollectionWorkspaceProvider';
