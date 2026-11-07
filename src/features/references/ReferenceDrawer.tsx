import React from 'react';
import { ActionIcon, Button, Group, Text, Tooltip } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { I } from '../../icons';
import { api, getErrorMessage, isIpcError } from '../../api/atelier';
import { isRecord, toDisplayValue } from '../../utils/displayValue';
import type { ReferenceResolveResult, ReferenceRule } from '@shared/types';
import { isSameReferenceTarget, makeFrameId, renderDisplayTemplate } from './display';
import { useReferenceRules } from './useReferenceRules';
import { ReferenceChip } from './ReferenceChip';

export interface ReferenceFrame {
  id: string;
  rule: ReferenceRule;
  /** Value from the source field — still in EJSON-encoded object shape. */
  value: unknown;
  label: string;
}

export interface ReferenceDrawerProps {
  stack: ReferenceFrame[];
  pinned: boolean;
  onPush: (frame: ReferenceFrame) => void;
  onPop: () => void;
  onClose: () => void;
  onTogglePin: () => void;
  width: number;
}

interface LoadedFrame {
  result: ReferenceResolveResult | null;
  loading: boolean;
  error: string | null;
  /** Opened from a list with its document in hand, so there is nothing to resolve. */
  picked?: boolean;
}

export function ReferenceDrawer({
  stack,
  pinned,
  onPush,
  onPop,
  onClose,
  onTogglePin,
  width,
}: ReferenceDrawerProps) {
  const T = themeVars;
  const [loaded, setLoaded] = React.useState<Record<string, LoadedFrame>>({});
  const topFrame = stack[stack.length - 1];

  // Drop entries that are no longer in the stack so navigating deeply doesn't
  // leak every resolved doc for the session.
  React.useEffect(() => {
    const ids = new Set(stack.map((f) => f.id));
    setLoaded((prev) => {
      let changed = false;
      const next: Record<string, LoadedFrame> = {};
      for (const [id, entry] of Object.entries(prev)) {
        if (ids.has(id)) next[id] = entry;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [stack]);

  React.useEffect(() => {
    if (!topFrame || loaded[topFrame.id]?.picked) return;
    let cancelled = false;
    setLoaded((prev) => {
      if (prev[topFrame.id]) return prev;
      return { ...prev, [topFrame.id]: { result: null, loading: true, error: null } };
    });
    void (async () => {
      try {
        const result = await api.refs.resolve({
          ruleId: topFrame.rule.id,
          valueEjson: JSON.stringify(topFrame.value),
        });
        if (cancelled) return;
        setLoaded((prev) => ({
          ...prev,
          [topFrame.id]: { result, loading: false, error: null },
        }));
      } catch (err) {
        if (cancelled) return;
        setLoaded((prev) => ({
          ...prev,
          [topFrame.id]: {
            result: null,
            loading: false,
            error: isIpcError(err) ? err.message : getErrorMessage(err, 'Failed to resolve'),
          },
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topFrame?.id]);

  const nestedRules = useReferenceRules(
    topFrame?.rule.connectionId ?? null,
    topFrame?.rule.targetDb ?? null,
    topFrame?.rule.targetCollection ?? null,
  );

  if (!topFrame) return null;

  const frame = loaded[topFrame.id];
  const docs = frame?.result?.documents ?? [];
  const isList = docs.length > 1;
  const singleDoc = docs.length === 1 ? docs[0] : null;
  const docRecord = isRecord(singleDoc) ? singleDoc : null;
  const title =
    docRecord && topFrame.rule.displayTemplate
      ? renderDisplayTemplate(topFrame.rule.displayTemplate, docRecord)
      : isList
        ? `${docs.length} matches in ${topFrame.rule.targetCollection}`
        : topFrame.rule.targetCollection;

  const handleNestedClick = (rule: ReferenceRule, field: string, value: unknown) => {
    if (isSameReferenceTarget(topFrame, rule, value)) return;
    onPush({ id: makeFrameId(rule), rule, value, label: field });
  };

  // Drilling into one element of a multi-doc list opens the document already in
  // hand. Resolving again by its targetField could not: the field may be dotted
  // or outside the rule's projection, and a value two documents share would only
  // resolve back to this list.
  const handleListPick = (doc: Record<string, unknown>) => {
    const id = makeFrameId(topFrame.rule);
    const result = { ruleId: topFrame.rule.id, found: true, documents: [doc], durationMs: 0 };
    setLoaded((prev) => ({ ...prev, [id]: { result, loading: false, error: null, picked: true } }));
    const label =
      (topFrame.rule.displayTemplate
        ? renderDisplayTemplate(topFrame.rule.displayTemplate, doc)
        : '') ||
      topFrame.rule.targetCollection;
    onPush({
      id,
      rule: topFrame.rule,
      value: doc[topFrame.rule.targetField] ?? doc._id,
      label,
    });
  };

  return (
    <div
      role="complementary"
      aria-label="Reference drawer"
      style={{
        width,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: `1px solid ${T.borderMed}`,
        background: T.surface,
        boxShadow: T.shadowLg,
        height: '100%',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <Group
        gap={themeVars.gapXs}
        wrap="nowrap"
        style={{
          padding: '8px 10px',
          borderBottom: `1px solid ${T.border}`,
          background: T.surfaceRaised,
          flexShrink: 0,
        }}
      >
        <Tooltip label={stack.length > 1 ? 'Back' : 'Top of stack'} withArrow>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            onClick={onPop}
            disabled={stack.length <= 1}
            aria-label="Back"
          >
            {I.chevL}
          </ActionIcon>
        </Tooltip>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <BreadcrumbTrail stack={stack} />
        </div>
        <Tooltip label={pinned ? 'Unpin (close on tab switch)' : 'Pin open'} withArrow>
          <Button
            variant={pinned ? 'light' : 'default'}
            size="compact-xs"
            onClick={onTogglePin}
            aria-pressed={pinned}
          >
            {pinned ? 'Pinned' : 'Pin'}
          </Button>
        </Tooltip>
        <Tooltip label="Close" withArrow>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            onClick={onClose}
            aria-label="Close reference drawer"
          >
            {I.close}
          </ActionIcon>
        </Tooltip>
      </Group>

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        <div
          style={{
            padding: '10px 12px',
            borderBottom: `1px solid ${T.border}`,
            background: T.surface,
          }}
        >
          <Text fz={T.fsXs} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.06em' }}>
            {topFrame.rule.targetDb}.{topFrame.rule.targetCollection}
          </Text>
          <Text size="sm" fw={600} mt={4}>
            {title}
          </Text>
        </div>

        {frame?.loading && (
          <div style={{ padding: 14, color: T.textMuted, fontSize: T.fsSm }}>Loading…</div>
        )}
        {frame?.error && (
          <div style={{ padding: 14, color: T.warn, fontSize: T.fsSm }}>{frame.error}</div>
        )}
        {frame && !frame.loading && !frame.error && frame.result && !frame.result.found && (
          <div style={{ padding: 14, color: T.textMuted, fontSize: T.fsSm }}>
            No matching document.
          </div>
        )}
        {frame && !frame.loading && !frame.error && isList && (
          <DocList
            docs={docs}
            displayTemplate={topFrame.rule.displayTemplate}
            onPick={handleListPick}
          />
        )}
        {frame && !frame.loading && !frame.error && !isList && docRecord && (
          <DocFields
            doc={docRecord}
            rulesByField={nestedRules.byField}
            onFollow={handleNestedClick}
          />
        )}
      </div>
    </div>
  );
}

function BreadcrumbTrail({ stack }: { stack: ReferenceFrame[] }) {
  return (
    <Group gap={themeVars.gapXs} wrap="nowrap" style={{ overflow: 'hidden' }}>
      {stack.map((f, i) => {
        const last = i === stack.length - 1;
        return (
          <React.Fragment key={f.id}>
            {i > 0 && (
              <Text size="xs" c="dimmed" span>
                {'›'}
              </Text>
            )}
            <Text size="xs" c={last ? undefined : 'dimmed'} fw={last ? 600 : 400} truncate>
              {f.label}
            </Text>
          </React.Fragment>
        );
      })}
    </Group>
  );
}

interface DocListProps {
  docs: unknown[];
  displayTemplate?: string | null;
  onPick: (doc: Record<string, unknown>) => void;
}

/**
 * Render a multi-doc result as a clickable list. Each row resolves its label
 * via the rule's display template (falling back to `_id` / first scalar
 * field), and clicking pushes a child frame for that single doc.
 */
function DocList({ docs, displayTemplate, onPick }: DocListProps) {
  const T = themeVars;
  return (
    <div>
      {docs.map((doc, idx) => {
        if (!isRecord(doc)) {
          return (
            <div
              key={idx}
              style={{
                padding: '8px 12px',
                borderBottom: `1px solid ${T.border}`,
                fontSize: T.fsSm,
                color: T.textMuted,
                fontStyle: 'italic',
              }}
            >
              (non-object document)
            </div>
          );
        }
        const label =
          (displayTemplate ? renderDisplayTemplate(displayTemplate, doc) : '') ||
          fallbackLabel(doc);
        return (
          <Button
            key={idx}
            onClick={() => onPick(doc)}
            variant="subtle"
            color="gray"
            size="compact-sm"
            fz={T.fsSm}
            fw={400}
            fullWidth
            radius={0}
            justify="space-between"
            rightSection={<span style={{ color: T.accent }}>↗</span>}
            styles={{
              root: { borderBottom: `1px solid ${T.border}`, color: T.text },
              inner: { width: '100%' },
              // `minWidth: 0` is what actually lets the label ellipse: it is a
              // nowrap flex item, so without it the display-template text
              // pushes the ↗ out instead of truncating.
              label: {
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: 'block',
                height: 'auto',
                textAlign: 'left',
              },
            }}
          >
            {label}
          </Button>
        );
      })}
    </div>
  );
}

function fallbackLabel(doc: Record<string, unknown>): string {
  const id = doc._id;
  if (id !== undefined && id !== null) {
    const dv = toDisplayValue(id);
    return dv.display;
  }
  // Pick the first non-object scalar so the list isn't a sea of "{n}"s.
  for (const [, v] of Object.entries(doc)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      return String(v);
    }
  }
  return '(unnamed)';
}

interface DocFieldsProps {
  doc: Record<string, unknown>;
  rulesByField: Map<string, ReferenceRule>;
  onFollow: (rule: ReferenceRule, field: string, value: unknown) => void;
}

function DocFields({ doc, rulesByField, onFollow }: DocFieldsProps) {
  const T = themeVars;
  const entries = Object.entries(doc);
  if (entries.length === 0) {
    return (
      <div style={{ padding: 14, color: T.textMuted, fontSize: T.fsSm, fontStyle: 'italic' }}>
        Document is empty.
      </div>
    );
  }

  return (
    <div>
      {entries.map(([field, value]) => {
        const dv = toDisplayValue(value);
        const rule = rulesByField.get(field);
        return (
          <div
            key={field}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: themeVars.gapXs,
              padding: '6px 12px',
              borderBottom: `1px solid ${T.border}`,
              fontSize: T.fsXs,
            }}
          >
            <span
              style={{
                color: T.textMuted,
                fontFamily: 'monospace',
                minWidth: 100,
                maxWidth: 160,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {field}
            </span>
            <span
              style={{
                color: T.text,
                fontFamily: 'monospace',
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {dv.type === 'string' ? `"${dv.display}"` : dv.display}
            </span>
            {rule && (
              <ReferenceChip
                rule={rule}
                onHover={() => {}}
                onLeave={() => {}}
                onClick={() => onFollow(rule, field, value)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
