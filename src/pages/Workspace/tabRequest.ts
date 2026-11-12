// One-shot requests to a collection tab, raised from outside it (the palette)
// and honoured by the tab's own control, so the dialog or run is the one that
// control opens: the ResultBar's Export dialog, the QueryBar's Explain, the
// Aggregation tab's Run, the filter drawer's own append, the Saved list's rename.
import type { FilterNode } from '@shared/types';

export type TabRequestKind = 'export' | 'explain' | 'runPipeline' | 'filter' | 'renameSaved';

const pending: Record<TabRequestKind, string | null> = {
  export: null,
  explain: null,
  runPipeline: null,
  filter: null,
  renameSaved: null,
};
const listeners = new Set<() => void>();

/** Asks tab `tabId` to act on `kind` once; replaces an older request of that kind. */
export function requestTab(kind: TabRequestKind, tabId: string): void {
  pending[kind] = tabId;
  for (const l of listeners) l();
}

/** Whether tab `tabId` has a `kind` request waiting. */
export function tabRequested(kind: TabRequestKind, tabId: string): boolean {
  return pending[kind] === tabId;
}

/** Clears tab `tabId`'s `kind` request, so it cannot fire twice. */
export function consumeTabRequest(kind: TabRequestKind, tabId: string): void {
  if (pending[kind] === tabId) pending[kind] = null;
}

export function subscribeTabRequests(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** What the palette asks of a tab's filter drawer (X07 §13.6). */
export interface FilterRequest {
  /** One condition appended at the root of the filter; null appends nothing. */
  node: FilterNode | null;
  /** Where the caret goes: the appended row's field or value input, or the filter's first field. */
  focus: 'field' | 'value';
}

let filterRequest: FilterRequest | null = null;

/** Asks tab `tabId`'s filter drawer to take `request` once, as an edit of its own. */
export function requestFilter(tabId: string, request: FilterRequest): void {
  filterRequest = request;
  requestTab('filter', tabId);
}

/** Tab `tabId`'s waiting filter request, left in place; a new object for each request. */
export function peekFilterRequest(tabId: string): FilterRequest | null {
  return tabRequested('filter', tabId) ? filterRequest : null;
}

/** Tab `tabId`'s waiting filter request, consumed; null when there is none. */
export function takeFilterRequest(tabId: string): FilterRequest | null {
  if (!tabRequested('filter', tabId)) return null;
  consumeTabRequest('filter', tabId);
  const request = filterRequest;
  filterRequest = null;
  return request;
}

let renameSavedId: string | null = null;

/** Asks tab `tabId`'s Saved list to put saved entry `savedId` in its rename input once. */
export function requestSavedRename(tabId: string, savedId: string): void {
  renameSavedId = savedId;
  requestTab('renameSaved', tabId);
}

/** The saved entry tab `tabId`'s Saved list is asked to rename, left in place. */
export function peekSavedRename(tabId: string): string | null {
  return tabRequested('renameSaved', tabId) ? renameSavedId : null;
}

/** Clears tab `tabId`'s rename request, so it cannot fire twice. */
export function consumeSavedRename(tabId: string): void {
  if (!tabRequested('renameSaved', tabId)) return;
  consumeTabRequest('renameSaved', tabId);
  renameSavedId = null;
}

/** Test-only. */
export function _resetTabRequestsForTests(): void {
  pending.export = null;
  pending.explain = null;
  pending.runPipeline = null;
  pending.filter = null;
  pending.renameSaved = null;
  filterRequest = null;
  renameSavedId = null;
}
