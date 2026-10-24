import React from 'react';
import { ActionIcon } from '@mantine/core';
import { I } from '../../../icons';
import { isRecord, toDisplayValue, type DisplayType, type DisplayValue } from '../../../utils/displayValue';
import { childKey, escapeKeySegment } from '../views/fieldPathKey';
import { TYPE_HUES, TYPE_THEMED } from '../typeColors';

/**
 * Generic, self-contained collapsible JSON tree — renders an arbitrary
 * `unknown` value (not bound to a document list, builder drag-drop, or
 * per-row actions like `TreeView`). Built for `ExplainDrawer` so the explain
 * plan gets syntax-highlighted, expand/collapse rendering per A06-save-explain
 * §"Drawer UI" instead of a raw `<pre>` dump.
 *
 * Expansion state is local `useState` — ephemeral, not persisted to
 * `workspace_tabs.state_json` (the drawer itself is transient).
 *
 * Default expansion: top-level keys are always visible; any nested
 * object/array starts collapsed until its own toggle is clicked.
 */
export interface JsonTreeProps {
  value: unknown;
  /** Field names to visually emphasize (e.g. summary-relevant explain keys). */
  highlightKeys?: Set<string>;
}

function TypeBadge({ type }: { type: DisplayType }) {
  const colors = TYPE_HUES[type] ?? TYPE_THEMED[type] ?? {
    bg: 'var(--atelier-surface-raised)',
    fg: 'var(--atelier-text-muted)',
  };
  return (
    <span
      style={{
        fontSize: 9,
        padding: '1px 5px',
        borderRadius: 'var(--atelier-radius-xs)',
        background: colors.bg,
        color: colors.fg,
        fontWeight: 600,
        letterSpacing: '0.03em',
        textTransform: 'uppercase',
        flexShrink: 0,
      }}
    >
      {type}
    </span>
  );
}

function formatLeaf(dv: DisplayValue): string {
  return dv.type === 'string' ? `"${dv.display}"` : dv.display;
}

interface JsonNodeProps {
  name: string;
  value: unknown;
  depth: number;
  path: string;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  highlightKeys?: Set<string>;
}

function JsonNodeImpl({ name, value, depth, path, expandedPaths, onToggle, highlightKeys }: JsonNodeProps) {
  const dv = toDisplayValue(value);
  const isExpandable = dv.type === 'object' || dv.type === 'array';
  const isExpanded = isExpandable && expandedPaths.has(path);
  const highlighted = highlightKeys?.has(name) ?? false;

  const childEntries: Array<[string, unknown]> = React.useMemo(() => {
    if (!isExpanded) return [];
    if (dv.type === 'array' && Array.isArray(value)) {
      return value.map((v, i): [string, unknown] => [String(i), v]);
    }
    if (dv.type === 'object' && isRecord(value)) {
      return Object.entries(value);
    }
    return [];
  }, [isExpanded, dv.type, value]);

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 0',
          paddingLeft: depth * 16,
          fontSize: 11,
        }}
      >
        {isExpandable ? (
          <ActionIcon
            variant="subtle"
            color="gray"
            size={14}
            onClick={() => onToggle(path)}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
            aria-expanded={isExpanded}
            style={{
              color: 'var(--atelier-text-ghost)',
              flexShrink: 0,
              transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: 'transform 120ms',
            }}
          >
            {I.chevD}
          </ActionIcon>
        ) : (
          <span style={{ width: 14, flexShrink: 0 }} />
        )}
        <span
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            color: highlighted ? 'var(--atelier-warn)' : 'var(--atelier-text-muted)',
            fontWeight: highlighted ? 700 : 400,
            flexShrink: 0,
          }}
        >
          {name}:
        </span>
        <span
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            color: 'var(--atelier-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
          title={formatLeaf(dv)}
        >
          {formatLeaf(dv)}
        </span>
        <TypeBadge type={dv.type} />
      </div>
      {isExpanded &&
        childEntries.map(([k, v]) => (
          <JsonNode
            key={childKey(path, k)}
            name={k}
            value={v}
            depth={depth + 1}
            path={childKey(path, k)}
            expandedPaths={expandedPaths}
            onToggle={onToggle}
            highlightKeys={highlightKeys}
          />
        ))}
    </>
  );
}

// Same comparator convention as `TreeView.tsx`'s `FieldNode`: `expandedPaths`
// is a new `Set` instance on every toggle (identity always changes), which
// would otherwise defeat `React.memo` and re-render every node in the tree
// on a single toggle. Skip re-render unless THIS node's own expansion state
// changed, or (when expanded) a descendant path's expansion state changed —
// descendant paths are always prefixed with `${path}.` since paths are built
// by dot-joining escaped segments from the root (`fieldPathKey.ts`, #86), so
// a bare `.` at that boundary is always a real level separator, never one
// escaped inside a name — this also covers deeper descendants, not just
// immediate children.
const JsonNode = React.memo(JsonNodeImpl, (prev, next) => {
  // Cheap identity checks first.
  if (
    prev.value !== next.value ||
    prev.name !== next.name ||
    prev.path !== next.path ||
    prev.depth !== next.depth ||
    prev.onToggle !== next.onToggle ||
    prev.highlightKeys !== next.highlightKeys
  ) {
    return false;
  }
  if (prev.expandedPaths !== next.expandedPaths) {
    const wasExpanded = prev.expandedPaths.has(prev.path);
    const isExpanded = next.expandedPaths.has(next.path);
    if (wasExpanded !== isExpanded) return false;
    if (isExpanded) {
      const prefix = `${next.path}.`;
      for (const p of prev.expandedPaths) {
        if (p.startsWith(prefix) && !next.expandedPaths.has(p)) return false;
      }
      for (const p of next.expandedPaths) {
        if (p.startsWith(prefix) && !prev.expandedPaths.has(p)) return false;
      }
    }
  }
  return true;
});

export function JsonTree({ value, highlightKeys }: JsonTreeProps) {
  const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(() => new Set());

  const onToggle = React.useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const rootEntries: Array<[string, unknown]> = React.useMemo(() => {
    if (Array.isArray(value)) return value.map((v, i): [string, unknown] => [String(i), v]);
    if (isRecord(value)) return Object.entries(value);
    return [];
  }, [value]);

  if (rootEntries.length === 0) {
    const dv = toDisplayValue(value);
    return (
      <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: 'var(--atelier-text)' }}>
        {formatLeaf(dv)}
      </div>
    );
  }

  return (
    <div>
      {rootEntries.map(([k, v]) => (
        <JsonNode
          key={escapeKeySegment(k)}
          name={k}
          value={v}
          depth={0}
          path={escapeKeySegment(k)}
          expandedPaths={expandedPaths}
          onToggle={onToggle}
          highlightKeys={highlightKeys}
        />
      ))}
    </div>
  );
}
