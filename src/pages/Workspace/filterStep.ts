import type { CollectionTabState } from '@shared/types';

/**
 * A filter replaced from outside the drawer (the palette's pasted `_id` row)
 * that the drawer's undo history should still hold as one step: `from` is what
 * the tab held before, `to` the text it was replaced with.
 *
 * Renderer memory only, one per tab. The drawer may be collapsed (unmounted)
 * when the replacement happens, so the step waits here until a drawer reads
 * it; a drawer ignores one whose `to` is no longer the tab's text.
 */
export interface FilterStep {
  to: string;
  from: { queryRaw: string; filterDraft: CollectionTabState['filterDraft'] };
}

const steps = new Map<string, FilterStep>();

export function recordFilterStep(tabId: string, step: FilterStep): void {
  steps.set(tabId, step);
}

/** The step recorded for `tabId`, when it is the one that produced `queryRaw`. */
export function peekFilterStep(tabId: string, queryRaw: string): FilterStep | undefined {
  const step = steps.get(tabId);
  return step?.to === queryRaw ? step : undefined;
}

export function clearFilterStep(tabId: string): void {
  steps.delete(tabId);
}
