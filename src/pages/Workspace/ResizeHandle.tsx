import React from 'react';
import { themeVars } from '../../theme/themeVars';
import { resizeKeyStep } from './resizeKeyStep';

const ARROW_OPPOSITE: Record<string, string> = {
  ArrowLeft: 'ArrowRight',
  ArrowRight: 'ArrowLeft',
  ArrowUp: 'ArrowDown',
  ArrowDown: 'ArrowUp',
};

interface ResizeHandleProps {
  /**
   * Which side of the handle owns the size.
   *
   * Horizontal (col-resize):
   * - `left`: panel sits left of the handle. Dragging right grows the panel.
   * - `right`: panel sits right of the handle. Dragging right shrinks it.
   *
   * Vertical (row-resize):
   * - `top`: panel sits below the handle. Dragging up grows the panel
   *   (used for the bottom shell pane).
   * - `bottom`: panel sits above the handle. Dragging down grows the panel.
   */
  edge: 'left' | 'right' | 'top' | 'bottom';
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  onCommit?: (next: number) => void;
  ariaLabel?: string;
}

export function ResizeHandle({
  edge,
  value,
  min,
  max,
  onChange,
  onCommit,
  ariaLabel,
}: ResizeHandleProps) {
  const T = themeVars;
  const [hover, setHover] = React.useState(false);
  const [active, setActive] = React.useState(false);

  const horizontal = edge === 'left' || edge === 'right';
  // `resizeKeyStep`'s "increase" key is ArrowRight on the horizontal axis but
  // ArrowUp on the vertical one — the same sign as a positive `deltaPx` for
  // the former, the opposite sign for the latter (mouse Y grows downward, so
  // "up" is the negative direction). The mouse handler below (`:60`) grows
  // the panel on positive `deltaPx` for `left`/`bottom`. So the two axes need
  // opposite inversion rules to keep agreeing with the same mouse handler:
  // horizontal inverts everywhere *except* `left`, vertical inverts only at
  // `bottom`. Collapsing this to `edge === 'right' || edge === 'bottom'`
  // would look arbitrary and is exactly how it drifted the first time.
  const mouseGrowsOnPositiveDelta = edge === 'left' || edge === 'bottom';
  const invertArrow = horizontal ? !mouseGrowsOnPositiveDelta : mouseGrowsOnPositiveDelta;

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startCoord = horizontal ? e.clientX : e.clientY;
    const startValue = value;
    setActive(true);
    const prevBodyCursor = document.body.style.cursor;
    const prevBodySelect = document.body.style.userSelect;
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    let latest = startValue;
    const onMove = (me: MouseEvent) => {
      const cur = horizontal ? me.clientX : me.clientY;
      const deltaPx = cur - startCoord;
      // Edges where the panel sits on the trailing side of the handle
      // (right/top) need the delta inverted: dragging toward the panel
      // shrinks it.
      const delta = edge === 'left' || edge === 'bottom' ? deltaPx : -deltaPx;
      const next = Math.min(max, Math.max(min, startValue + delta));
      latest = next;
      onChange(next);
    };
    const onUp = () => {
      document.body.style.cursor = prevBodyCursor;
      document.body.style.userSelect = prevBodySelect;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setActive(false);
      onCommit?.(latest);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Keyboard equivalent of the drag above. `value`/`min`/`max` are already
  // the props the mouse path clamps against, so the shared step helper needs
  // no extra wiring here (see `resizeKeyStep.ts`) — a key it doesn't own
  // (anything but Arrow/Home/End) comes back `null` and is left to bubble.
  //
  // `edge` is a concept `resizeKeyStep` doesn't have (and its other two
  // callers, `OutputPanel` and `useResizableSplit`, have no edge at all), so
  // the inversion happens here by swapping the physical key before handing
  // it to the shared helper, rather than teaching the helper about edges.
  // Home/End name an absolute value (the min/the max) rather than a
  // direction, so they're deliberately left un-swapped — inverting them
  // would make Home grow the panel on one edge and shrink it on the other.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const key = invertArrow ? (ARROW_OPPOSITE[e.key] ?? e.key) : e.key;
    const next = resizeKeyStep(key, horizontal ? 'horizontal' : 'vertical', value, min, max);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(next);
    onCommit?.(next);
  };

  const visible = hover || active;

  return (
    <div
      role="separator"
      className="resize-separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-label={ariaLabel ?? 'Resize panel'}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onKeyDown={onKeyDown}
      style={{
        ...(horizontal ? { width: 4 } : { height: 4 }),
        flexShrink: 0,
        cursor: horizontal ? 'col-resize' : 'row-resize',
        background: visible ? T.accent : 'transparent',
        transition: active ? undefined : 'background 120ms',
        position: 'relative',
        zIndex: 2,
      }}
    />
  );
}
