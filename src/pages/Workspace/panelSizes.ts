/**
 * Builder-panel geometry. The split sizes are percent of the horizontal split;
 * the collapsed rail is pixels.
 *
 * Extracted because these numbers have to agree in two places that sit
 * ~1800 lines apart in `Workspace.tsx`: the `<Panel>` props, and the layout
 * handler that decides whether a size is worth persisting. As bare literals,
 * `collapsedSize={4}` and a guard testing `pct < 1` disagreed with each other
 * and nothing said so.
 *
 * react-resizable-panels reads a plain number as pixels and only a string as
 * percent, so a percent goes to a `<Panel>` size prop through `asPercent`.
 */

/** A percent for a `<Panel>` size prop, which would read the bare number as pixels. */
export const asPercent = (pct: number): string => `${pct}%`;

/** Smallest width a user can drag the builder to. */
export const BUILDER_MIN_PCT = 15;

/**
 * Width of the collapsed rail, in pixels: 4 px is what the expand notch needs,
 * and 4% would be tens of pixels too wide. Non-zero so the notch has somewhere
 * to live, which is exactly why `pct === 0` is not a usable test for "collapsed".
 */
export const BUILDER_COLLAPSED_PX = 4;

/** Fallback split when nothing is stored: 26 ≈ 348 / 1344. */
export const BUILDER_DEFAULT_PCT = 26;

/**
 * Did the user choose this width, or did we?
 *
 * Hardening, not a fix for corrupted data — the persisted split was
 * measured and never actually corrupted, so this replaces a guard rather
 * than repairing damage.
 * It is still the better rule. The old one was
 * `if (builderCollapsed || pct < 1) return`, and both halves are unsound:
 * `collapsedSize` is 4, so `< 1` never fires on a collapse, which left the
 * whole thing resting on a React state flag read inside a callback that
 * `toggleBuilder` can trigger synchronously, before the re-render.
 *
 * Geometry does not have that problem. A drag cannot produce a width below
 * `minSize`, so anything below it came from us — true whenever the handler
 * happens to run.
 */
export function isUserChosenBuilderSplit(pct: number | undefined): pct is number {
  return typeof pct === 'number' && Number.isFinite(pct) && pct >= BUILDER_MIN_PCT;
}
