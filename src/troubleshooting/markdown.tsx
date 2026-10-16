import React from 'react';
import { themeVars } from '../theme/themeVars';
import { api } from '../api/atelier';
import { notify } from '../theme/notifications';
import { parseInline } from './parseInline';

/**
 * Inline-markdown renderer. See `parseInline` for supported syntax.
 *
 * Links are routed through `app:openExternal` (https-only on the main side).
 * The href stays for keyboard / screen-reader accessibility, but the click
 * is intercepted.
 */
export function InlineMarkdown({ source }: { source: string }) {
  const T = themeVars;
  const nodes = parseInline(source);
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.kind) {
          case 'text':
            return <React.Fragment key={i}>{n.value}</React.Fragment>;
          case 'bold':
            return (
              <strong key={i} style={{ color: T.text, fontWeight: 600 }}>
                {n.value}
              </strong>
            );
          case 'italic':
            return (
              <em key={i} style={{ color: T.text, fontStyle: 'italic' }}>
                {n.value}
              </em>
            );
          case 'code':
            return (
              <code
                key={i}
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: '0.92em',
                  background: T.surfaceRaised,
                  border: `1px solid ${T.border}`,
                  borderRadius: T.rx,
                  padding: '1px 4px',
                }}
              >
                {n.value}
              </code>
            );
          case 'link':
            return (
              <a
                key={i}
                href={n.href}
                onClick={(e) => {
                  e.preventDefault();
                  void api.app.openExternal(n.href).catch(() => {
                    notify.error('Could not open the link');
                  });
                }}
                style={{ color: T.accent, textDecoration: 'underline' }}
              >
                {n.label}
              </a>
            );
        }
      })}
    </>
  );
}
