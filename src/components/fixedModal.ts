import type React from 'react';

/**
 * Styles that hold a Modal to one height whatever its content, so switching
 * a tab or a step never moves the title, the close button or the footer. The
 * body becomes a flex column: put the content in a `flex: 1; minHeight: 0`
 * region that scrolls, and dock the footer under it. The cap keeps the dialog
 * on screen in a short window.
 */
export function fixedModalStyles(height: number): { content: React.CSSProperties; body: React.CSSProperties } {
  return {
    content: { height: `min(${height}px, calc(100dvh - 80px))`, display: 'flex', flexDirection: 'column' },
    body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
  };
}
