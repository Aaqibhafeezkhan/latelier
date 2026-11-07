import { themeVars } from '../../theme/themeVars';
import type { ReferenceResolveResult, ReferenceRule } from '@shared/types';
import { renderDisplayTemplate } from './display';
import { isRecord, toDisplayValue } from '../../utils/displayValue';

interface ReferenceHoverPopoverProps {
  rule: ReferenceRule;
  anchorRect: DOMRect;
  result: ReferenceResolveResult | null;
  loading: boolean;
  error: string | null;
}

const MAX_PREVIEW_FIELDS = 5;

export function ReferenceHoverPopover({
  rule,
  anchorRect,
  result,
  loading,
  error,
}: ReferenceHoverPopoverProps) {
  const T = themeVars;

  const top = anchorRect.bottom + 4;
  const left = Math.max(8, anchorRect.left - 20);

  // Show the first matched doc; surface "+N more" when the source was an
  // array reference that resolved to multiple targets. Click leads to the
  // drawer where the user can browse the full list.
  const docs = result?.documents ?? [];
  const firstDoc = docs[0];
  const docRecord = isRecord(firstDoc) ? firstDoc : null;
  const extraCount = Math.max(0, docs.length - 1);

  const displayTitle =
    docRecord && rule.displayTemplate
      ? renderDisplayTemplate(rule.displayTemplate, docRecord)
      : null;

  const previewEntries: Array<[string, unknown]> = docRecord
    ? Object.entries(docRecord)
        .filter(([k]) => k !== '_id')
        .slice(0, MAX_PREVIEW_FIELDS)
    : [];

  return (
    <div
      role="tooltip"
      style={{
        position: 'fixed',
        top,
        left,
        minWidth: 220,
        maxWidth: 340,
        background: T.surface,
        border: `1px solid ${T.borderMed}`,
        borderRadius: T.r,
        boxShadow: T.shadow,
        padding: '10px 12px',
        zIndex: 1500,
        fontSize: T.fsXs,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: themeVars.gapXs,
          marginBottom: 8,
          color: T.textMuted,
          fontSize: T.fsXs,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        <span>→ {rule.targetCollection}</span>
        {extraCount > 0 && (
          <span
            style={{
              padding: '1px 6px',
              borderRadius: 8,
              background: T.accentSoft,
              border: `1px solid ${T.accentBorder}`,
              color: T.accentInk,
              fontSize: T.fsXs,
              letterSpacing: 0,
            }}
          >
            +{extraCount} more
          </span>
        )}
      </div>
      {loading && <div style={{ color: T.textMuted }}>Loading…</div>}
      {error && <div style={{ color: T.warn, fontSize: T.fsXs }}>{error}</div>}
      {!loading && !error && result && !result.found && (
        <div style={{ color: T.textMuted }}>No matching document.</div>
      )}
      {!loading && !error && docRecord && (
        <>
          {displayTitle && (
            <div
              style={{
                color: T.text,
                fontSize: T.fsSm,
                fontWeight: 600,
                marginBottom: 6,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {displayTitle}
            </div>
          )}
          {previewEntries.length === 0 && (
            <div style={{ color: T.textMuted }}>(empty projection)</div>
          )}
          {previewEntries.map(([field, value]) => {
            const dv = toDisplayValue(value);
            return (
              <div
                key={field}
                style={{
                  display: 'flex',
                  gap: themeVars.gapXs,
                  padding: '2px 0',
                  overflow: 'hidden',
                }}
              >
                <span style={{ color: T.textMuted, fontFamily: 'monospace', flexShrink: 0 }}>
                  {field}:
                </span>
                <span
                  style={{
                    color: T.text,
                    fontFamily: 'monospace',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {dv.type === 'string' ? `"${dv.display}"` : dv.display}
                </span>
              </div>
            );
          })}
          <div
            style={{
              marginTop: 8,
              color: T.textGhost,
              fontSize: T.fsXs,
              fontStyle: 'italic',
            }}
          >
            Click to open
          </div>
        </>
      )}
    </div>
  );
}
