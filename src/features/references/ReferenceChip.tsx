import React from 'react';
import { themeVars } from '../../theme/themeVars';
import type { ReferenceRule } from '@shared/types';

interface ReferenceChipProps {
  rule: ReferenceRule;
  onHover: (rect: DOMRect) => void;
  onLeave: () => void;
  onClick: (rect: DOMRect) => void;
  /** `-1` takes the chip out of the Tab order while keeping it clickable. */
  tabIndex?: number;
}

/**
 * Subtle arrow icon rendered next to a field value when a reference rule
 * matches. Hovering opens a preview popover (handled by the parent); clicking
 * opens the reference drawer.
 */
export function ReferenceChip({ rule, onHover, onLeave, onClick, tabIndex }: ReferenceChipProps) {
  const T = themeVars;
  const ref = React.useRef<HTMLButtonElement>(null);
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverTimer = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };

  React.useEffect(() => clearHoverTimer, []);

  const handleEnter = () => {
    clearHoverTimer();
    // Tiny delay so flicking the mouse across the row doesn't spam resolves.
    hoverTimer.current = setTimeout(() => {
      if (!ref.current) return;
      onHover(ref.current.getBoundingClientRect());
    }, 220);
  };

  const handleLeave = () => {
    clearHoverTimer();
    onLeave();
  };

  return (
    <button
      ref={ref}
      type="button"
      tabIndex={tabIndex}
      aria-label={`Open reference to ${rule.targetCollection}`}
      title={`→ ${rule.targetCollection}`}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onFocus={handleEnter}
      onBlur={handleLeave}
      onMouseDown={(e) => e.stopPropagation()}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        clearHoverTimer();
        if (!ref.current) return;
        onClick(ref.current.getBoundingClientRect());
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 16,
        minWidth: 16,
        padding: '0 4px',
        background: T.accentSoft,
        border: `1px solid ${T.accentBorder}`,
        borderRadius: 3,
        color: T.accentInk,
        cursor: 'pointer',
        fontSize: T.fsXs,
        fontWeight: 600,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      ↗
    </button>
  );
}
