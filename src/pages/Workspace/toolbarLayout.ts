/**
 * Which form each results toolbar takes at a given width. These functions take
 * the bar's width and nothing else on purpose: a stale query, a run in flight or
 * results arriving cannot change a control's form, because they cannot reach here.
 *
 * Null means the width is not known (no layout, as in jsdom): room for everything.
 *
 * The numbers are the widest the bar's fixed parts can be at each step, measured
 * in the running app at the theme's control sizes. Whatever is left over goes to
 * the count, which truncates before any control moves.
 */

export type CountForm = 'full' | 'range' | 'total';

export interface ResultBarLayout {
  /** full: "60 results · 2 ms · showing 1–50". range: "1–50 of 60". total: "60 results". */
  count: CountForm;
  /** Fields, Insert and Documents as icons with tooltips. The view switch keeps its words. */
  iconControls: boolean;
  /** The query-plan badge takes count room the narrowest bars do not have. */
  planBadge: boolean;
  /** Reachable only by dragging the panes: two rows beat clipping. */
  wrap: boolean;
}

const COUNT_FULL_MIN = 900;
const COUNT_RANGE_MIN = 640;
const LABELS_MIN = 760;
const PLAN_BADGE_MIN = 640;
const ONE_ROW_MIN = 500;

export function resultBarLayout(width: number | null): ResultBarLayout {
  const w = width ?? Number.POSITIVE_INFINITY;
  let count: CountForm = 'total';
  if (w >= COUNT_FULL_MIN) count = 'full';
  else if (w >= COUNT_RANGE_MIN) count = 'range';
  return {
    count,
    iconControls: w < LABELS_MIN,
    planBadge: w >= PLAN_BADGE_MIN,
    wrap: w < ONE_ROW_MIN,
  };
}

export type OutputBarActions = 'labels' | 'icons' | 'menu';

const OUTPUT_LABELS_MIN = 760;
const OUTPUT_ICONS_MIN = 520;

/** The aggregation output bar: labels, then icons, then one menu for all four actions. */
export function outputBarActions(width: number | null): OutputBarActions {
  const w = width ?? Number.POSITIVE_INFINITY;
  if (w >= OUTPUT_LABELS_MIN) return 'labels';
  return w >= OUTPUT_ICONS_MIN ? 'icons' : 'menu';
}
