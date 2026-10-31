import { UnstyledButton } from '@mantine/core';
import { themeVars } from '../../../theme/themeVars';
import { I } from '../../../icons';
import type { Stage } from '@shared/types';
import { OP_COLOR, isKnownOp } from './pipeline';
import { brightenBadgeForDark } from '../../../features/fieldSuggestions/operators';

interface Props {
  stages: Stage[];
  activeId: number | null;
  collection: string;
  stageCounts: Record<number, number>;
  staleStageIds: ReadonlySet<number>;
  outputCount: number | null;
  outputStale: boolean;
  darkMode: boolean;
  onSelect: (id: number) => void;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function opColor(op: string, dark: boolean) {
  return brightenBadgeForDark(
    OP_COLOR[op] ?? { bg: 'rgba(100,100,100,0.15)', text: '#888' },
    dark,
  );
}

export function PipelineOutline({
  stages,
  activeId,
  collection,
  stageCounts,
  staleStageIds,
  outputCount,
  outputStale,
  darkMode,
  onSelect,
}: Props) {
  const T = themeVars;
  const activeCount = stages.filter((s) => s.enabled).length;

  return (
    <div
      style={{
        width: 200,
        borderRight: `1px solid ${T.border}`,
        display: 'flex',
        flexDirection: 'column',
        background: T.surface,
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '8px 12px',
          borderBottom: `1px solid ${T.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>Pipeline</span>
        <div style={{ display: 'flex', gap: 5 }}>
          <span
            style={{
              fontSize: 10,
              color: T.accent,
              background: T.accentSoft,
              borderRadius: T.rx,
              padding: '1px 5px',
            }}
          >
            {activeCount} active
          </span>
          {outputCount !== null && (
            <span
              style={{
                fontSize: 10,
                color: T.textGhost,
                background: T.surfaceRaised,
                borderRadius: T.rx,
                padding: '1px 5px',
                border: `1px solid ${T.border}`,
              }}
            >
              {fmt(outputCount)} out
            </span>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '5px 12px',
            fontSize: 12,
            color: T.textMuted,
          }}
        >
          <span style={{ color: T.textGhost, display: 'flex' }}>{I.db}</span>
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {collection || '(source)'}
          </span>
        </div>

        {stages.map((stage, idx) => {
          const c = opColor(stage.op, darkMode);
          const count = stageCounts[stage.id];
          const stale = staleStageIds.has(stage.id);
          return (
            <div key={stage.id}>
              <div style={{ display: 'flex', justifyContent: 'center', height: 12 }}>
                <div style={{ borderLeft: `1.5px dashed ${T.border}`, height: '100%' }} />
              </div>
              <UnstyledButton
                type="button"
                onClick={() => onSelect(stage.id)}
                aria-label={`Jump to stage ${idx + 1} (${stage.op})`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  width: '100%',
                  padding: '5px 12px',
                  font: 'inherit',
                  opacity: stage.enabled ? 1 : 0.5,
                  background: activeId === stage.id ? T.accentSoft : 'transparent',
                  borderLeft:
                    activeId === stage.id ? `2px solid ${T.accent}` : '2px solid transparent',
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    color: T.textGhost,
                    width: 14,
                    textAlign: 'center',
                    flexShrink: 0,
                  }}
                >
                  {idx + 1}
                </span>
                <span
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    fontWeight: 600,
                    color: c.text,
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {stage.op}
                  {!isKnownOp(stage.op) && (
                    <span
                      title="Unknown op"
                      style={{
                        marginLeft: 4,
                        fontSize: 9,
                        color: T.warn,
                      }}
                    >
                      ⚠
                    </span>
                  )}
                </span>
                {typeof count === 'number' && (
                  <span
                    title={stale ? 'Stage edited after last run — counts are stale' : undefined}
                    style={{
                      fontSize: 10,
                      color: T.textGhost,
                      flexShrink: 0,
                      textDecoration: stage.enabled ? 'none' : 'line-through',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {fmt(count)}
                    {stale ? ' ⚠' : ''}
                  </span>
                )}
              </UnstyledButton>
            </div>
          );
        })}

        <div style={{ display: 'flex', justifyContent: 'center', height: 12 }}>
          <div style={{ borderLeft: `1.5px dashed ${T.border}`, height: '100%' }} />
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '5px 12px',
            fontSize: 12,
            color: T.accent,
          }}
        >
          <span style={{ display: 'flex', color: T.accent }}>{I.arrowR}</span>
          <span style={{ flex: 1 }}>Output</span>
          {outputCount !== null && (
            <span style={{ fontSize: 10 }}>
              {fmt(outputCount)}
              {outputStale ? ' ⚠' : ''}
            </span>
          )}
        </div>

        <div style={{ padding: '8px 12px', borderTop: `1px solid ${T.border}`, marginTop: 8 }}>
          <div style={{ fontSize: 10, color: T.textMuted, lineHeight: 1.6 }}>
            <div>Source: {collection}</div>
            <div>Stages: {stages.length}</div>
            <div>Output: {outputCount === null ? '—' : fmt(outputCount)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
