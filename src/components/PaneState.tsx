import type { ReactNode } from 'react';
import { Group } from '@mantine/core';
import { themeVars } from '../theme/themeVars';

interface PaneStateProps {
  /** What happened, as a sentence. */
  title: ReactNode;
  /** More about it. With `tone="error"` it is the raw error, kept whole and scrollable. */
  detail?: ReactNode;
  tone?: 'neutral' | 'error';
  /** The next action. */
  actions?: ReactNode;
}

/**
 * What a results pane shows instead of rows: empty, no match, a refused query,
 * a failed connect. Fills its pane, so a long error has room and nothing around
 * it moves.
 */
export function PaneState({ title, detail, tone = 'neutral', actions }: PaneStateProps) {
  const T = themeVars;
  const isError = tone === 'error';
  return (
    <div
      data-testid="pane-state"
      role={isError ? 'alert' : undefined}
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: themeVars.gapSm,
        padding: '16px 24px',
        overflow: 'hidden',
        textAlign: 'center',
        fontSize: T.fsMd,
        color: T.textMuted,
      }}
    >
      <div style={{ flexShrink: 0, fontWeight: 600, color: isError ? T.redText : T.text }}>{title}</div>
      {detail !== undefined &&
        (isError ? (
          // Focusable because it scrolls: a keyboard user has to be able to read all of it.
          <div
            tabIndex={0}
            style={{
              flex: '0 1 auto',
              minHeight: 0,
              width: '100%',
              maxWidth: 640,
              overflow: 'auto',
              padding: '8px 10px',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: T.fsSm,
              lineHeight: 1.5,
              textAlign: 'left',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              color: T.text,
              background: T.surfaceRaised,
              border: `1px solid ${T.border}`,
              borderRadius: T.rs,
            }}
          >
            {detail}
          </div>
        ) : (
          <div style={{ flexShrink: 0, maxWidth: 480 }}>{detail}</div>
        ))}
      {actions && (
        <Group gap="xs" justify="center" style={{ flexShrink: 0 }}>
          {actions}
        </Group>
      )}
    </div>
  );
}
