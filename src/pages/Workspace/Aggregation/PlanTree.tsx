import React from 'react';
import { themeVars } from '../../../theme/themeVars';
import { buildPlanTree, type PlanNode } from '../../../utils/explainSummary';

const chipStyle = (T: typeof themeVars): React.CSSProperties => ({
  fontSize: 10,
  padding: '1px 6px',
  borderRadius: T.rs,
  background: T.surface,
  color: T.textMuted,
  border: `1px solid ${T.border}`,
});

function Row({ node }: { node: PlanNode }) {
  const T = themeVars;
  const figures: string[] = [];
  if (node.nReturned !== undefined) figures.push(`nReturned: ${node.nReturned}`);
  if (node.docsExamined !== undefined) figures.push(`docsExamined: ${node.docsExamined}`);
  if (node.keysExamined !== undefined) figures.push(`keysExamined: ${node.keysExamined}`);
  if (node.timeMs !== undefined) figures.push(`~${node.timeMs}ms`);

  return (
    <li data-stage={node.stage} data-collscan={node.collscan} style={{ listStyle: 'none' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px',
          marginBottom: 3,
          borderRadius: T.rs,
          border: `1px solid ${node.collscan ? T.warnBorder : T.border}`,
          background: node.collscan ? T.warnSoft : T.surfaceRaised,
          color: node.collscan ? T.warnText : T.text,
          fontSize: 11,
        }}
      >
        <strong style={{ fontFamily: '"JetBrains Mono", monospace', fontWeight: 600 }}>
          {node.stage}
        </strong>
        {node.shardName !== undefined && <span style={chipStyle(T)}>shard {node.shardName}</span>}
        {node.indexName !== undefined && <span>{node.indexName}</span>}
        {node.keyPattern !== undefined && (
          <code style={{ fontSize: 10, color: T.textMuted }}>{JSON.stringify(node.keyPattern)}</code>
        )}
        {figures.map((f) => (
          <span key={f} style={chipStyle(T)}>
            {f}
          </span>
        ))}
      </div>
      {node.children.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {node.children.map((child, i) => (
            <Row key={i} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The plan's stages as a nested list (rows are read-only, so a plain list rather than a tree widget) — one row per stage with the figures
 * that stage reported. Renders nothing for a plan `buildPlanTree` does not
 * recognize, so the caller's raw plan view stays the fallback.
 */
export function PlanTree({ plan }: { plan: unknown }) {
  const root = React.useMemo(() => buildPlanTree(plan), [plan]);
  if (!root) return null;
  return (
    <ul
      aria-label="Plan stages"
      style={{ margin: '0 0 10px', padding: 0, fontFamily: 'inherit' }}
    >
      <Row node={root} />
    </ul>
  );
}
