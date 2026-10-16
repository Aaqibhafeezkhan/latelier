import React from 'react';
import { themeVars } from '../../theme/themeVars';
import { useIsDark } from '../../ThemeContext';
import { api } from '../../api/atelier';
import { notify } from '../../theme/notifications';
import {
  classColor,
  CLASS_BADGE,
  CLASS_LABEL,
  type OperatorDef,
} from './operators';
import { OPERATOR_PANEL_SIZE } from './placement';

interface OperatorDocPanelProps {
  op: OperatorDef | null;
  /** 'side' — companion to a popover/dropdown. 'tooltip' — standalone. */
  variant?: 'side' | 'tooltip';
  /** Panel id used by the consumer to wire aria-describedby. */
  id?: string;
}

function openDocsUrl(url: string): void {
  // Electron route only. The <a href> stays for a11y (announced as "link",
  // middle-click/context-menu copy), but the click is cancelled and routed
  // through the URL-restricted IPC.
  void api.shell.openExternal({ url }).catch(() => {
    notify.error('Could not open the link');
  });
}

export function OperatorDocPanel({
  op,
  variant = 'side',
  id,
}: OperatorDocPanelProps) {
  const T = themeVars;
  const dark = useIsDark();

  const outerStyle: React.CSSProperties = {
    width: OPERATOR_PANEL_SIZE.width,
    maxHeight: 360,
    overflowY: 'auto',
    background: T.surface,
    border: `1px solid ${T.borderMed}`,
    borderRadius: T.r,
    boxShadow: T.shadowLg,
    padding: variant === 'tooltip' ? 12 : 10,
    color: T.text,
    boxSizing: 'border-box',
  };

  if (!op) {
    return (
      <div role="note" aria-label="No operator documentation" id={id} style={outerStyle}>
        <div style={{ fontSize: 12, color: T.textMuted, textAlign: 'center', padding: 12 }}>
          No documentation available
        </div>
      </div>
    );
  }

  const color = classColor(op.class, dark);
  const badge = CLASS_BADGE[op.class] ?? op.class;

  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: T.textMuted,
    marginTop: 10,
    marginBottom: 4,
  };

  const blockStyle: React.CSSProperties = {
    background: T.surfaceRaised,
    border: `1px solid ${T.border}`,
    borderRadius: T.rx,
    padding: '6px 8px',
    fontSize: 11,
    fontFamily: 'JetBrains Mono, monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: T.text,
    margin: 0,
  };

  return (
    <div
      role="note"
      aria-label={`Documentation for ${op.name}`}
      id={id}
      style={outerStyle}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 13,
            fontWeight: 600,
            color: T.text,
          }}
        >
          {op.name}
        </span>
        <span
          style={{
            padding: '2px 6px',
            borderRadius: T.rx,
            fontSize: 9,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            background: color.bg,
            color: color.text,
            fontWeight: 600,
          }}
        >
          {badge}
        </span>
      </div>

      {op.description && (
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.5,
            color: T.text,
            marginTop: 6,
          }}
        >
          {op.description}
        </div>
      )}

      {op.syntax && (
        <>
          <div style={labelStyle}>Syntax</div>
          <pre style={blockStyle}>{op.syntax}</pre>
        </>
      )}

      {op.example && (
        <>
          <div style={labelStyle}>Example</div>
          <pre style={blockStyle}>{op.example}</pre>
        </>
      )}

      <div
        style={{
          marginTop: 10,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 10, color: T.textMuted }}>
          Class: {CLASS_LABEL[op.class] ?? op.class}
        </span>
        {op.url && (
          <a
            href={op.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => {
              e.preventDefault();
              openDocsUrl(op.url!);
            }}
            style={{
              color: T.accent,
              textDecoration: 'none',
              fontSize: 10,
              cursor: 'pointer',
            }}
          >
            Learn more →
          </a>
        )}
      </div>
    </div>
  );
}
