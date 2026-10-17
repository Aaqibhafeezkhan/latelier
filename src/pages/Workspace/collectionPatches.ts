// `prev` stays an argument (not read from a ref): patchCollectionStateWith merges against the latest pending patch, so same-tick patches don't clobber each other.
import type { CollectionTabState, SchemaTabState } from '@shared/types';
import { DEFAULT_SCHEMA_TAB_STATE } from '@shared/defaults';
import { ownSet } from '../../utils/ownProperty';

export function columnResizePatch(
  prev: CollectionTabState,
  field: string,
  width: number,
): Partial<CollectionTabState> {
  return { columns: { ...(prev.columns ?? {}), [field]: { width } } };
}

// `delete` (not `= false`) keeps the persisted expandedRows object proportional to what's actually expanded.
// `docId` can collide with Object.prototype member names (e.g. '__proto__'), so writes go through `ownSet`.
export function rowExpandPatch(
  prev: CollectionTabState,
  docId: string,
  expanded: boolean,
): Partial<CollectionTabState> {
  const next = { ...(prev.expandedRows ?? {}) };
  if (expanded) ownSet(next, docId, true);
  else delete next[docId];
  return { expandedRows: next };
}

// Defaults first so `patch` always wins on a first-ever schema patch for a tab.
export function schemaPatch(
  prev: CollectionTabState,
  patch: Partial<SchemaTabState>,
): Partial<CollectionTabState> {
  return { schema: { ...(prev.schema ?? DEFAULT_SCHEMA_TAB_STATE), ...patch } };
}

// `filterDraft: undefined` deletes the drawer's persisted tree on merge, so the
// rows of the filter just cleared can't come back on the next tab switch.
export const CLEAR_FILTER_PATCH: Partial<CollectionTabState> = { queryRaw: '{}', filterDraft: undefined };
