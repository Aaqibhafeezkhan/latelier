import React from 'react';
import { themeVars } from '../theme/themeVars';
import { I } from '../icons';
import {
  ActionIcon,
  Alert,
  Badge as MantineBadge,
  Button,
  Drawer,
  Group,
  Modal,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { api, isIpcError } from '../api/atelier';
import { confirmDestructive } from '../utils/confirm';
import { DisclosureToggle } from '../components/DisclosureToggle';
import { SubmitButton } from '../components/SubmitButton';
import { useDialogFocusReturn } from '../hooks/useDialogFocusReturn';
import type {
  IndexCreateInput,
  IndexFieldDirection,
  IndexInfo,
} from '@shared/types';
import type { IndexSuggestion } from '../utils/indexSuggestion';
import { humanBytes } from '../utils/humanBytes';

/**
 * A one-shot request from `ExplainDrawer`'s "Create an index for this
 * query" (W16 Tier 4) to open the create-index drawer prefilled.
 * `requestId` changes on every click, even when `suggestion` doesn't
 * (two COLLSCAN refusals in a row are both `null`) — `IndexesTab`'s effect
 * keys on it so a second click reopens the drawer instead of being a no-op
 * against an unchanged prop.
 */
export interface IndexCreateRequest {
  requestId: string;
  suggestion: IndexSuggestion | null;
}

function humanCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function humanTtl(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function renderKey(key: IndexInfo['key']): string {
  const inner = key
    .map((k: { field: string; direction: IndexFieldDirection }) => {
      const dir =
        typeof k.direction === 'number' ? String(k.direction) : `'${k.direction}'`;
      return `${k.field}: ${dir}`;
    })
    .join(', ');
  return `{ ${inner} }`;
}

function indexBadges(idx: IndexInfo): Array<{ label: string; tone?: 'accent' | 'warn' }> {
  if (idx.isIdIndex) return [{ label: 'default' }];
  const out: Array<{ label: string; tone?: 'accent' | 'warn' }> = [];
  if (idx.unique) out.push({ label: 'unique', tone: 'accent' });
  if (idx.sparse) out.push({ label: 'sparse' });
  if (typeof idx.expireAfterSeconds === 'number') {
    out.push({ label: `ttl ${humanTtl(idx.expireAfterSeconds)}`, tone: 'warn' });
  }
  if (idx.partialFilterExpression) out.push({ label: 'partial' });
  if (idx.collation) out.push({ label: 'collation' });
  if (idx.hidden) out.push({ label: 'hidden', tone: 'warn' });
  const specials: IndexFieldDirection[] = ['text', 'hashed', '2d', '2dsphere', 'geoHaystack'];
  for (const k of idx.key) {
    if (typeof k.direction === 'string' && specials.includes(k.direction)) {
      out.push({ label: k.direction });
      break;
    }
  }
  if (out.length === 0) out.push({ label: 'standard' });
  return out;
}

function IndexBadge({ label, tone }: { label: string; tone?: 'accent' | 'warn' }) {
  const color = tone === 'accent' ? 'green' : tone === 'warn' ? 'orange' : 'gray';
  return (
    <MantineBadge
      size="xs"
      variant="light"
      color={color}
      style={{ textTransform: 'none', fontFamily: 'inherit', fontWeight: 400 }}
    >
      {label}
    </MantineBadge>
  );
}

export function IndexesTab({
  connectionId,
  dbName,
  collection,
  viewOn,
  initialCreate,
  onInitialCreateConsumed,
  onChanged,
}: {
  connectionId: string;
  dbName: string;
  collection: string;
  /**
   * Set when the namespace is a view: the collection it reads from. The server
   * rejects `listIndexes` on a view, so no list is requested and no create or
   * drop is offered.
   */
  viewOn?: string;
  /** See `IndexCreateRequest`. Omitted (or `null`) outside the ExplainDrawer flow. */
  initialCreate?: IndexCreateRequest | null;
  /**
   * Called once the request above has opened the drawer, so the caller can
   * null it out. Without this, navigating away from Structure and back
   * (which unmounts and remounts this component — see `PanelBody`'s
   * `collection.view === 'structure' &&` guard) would find the same
   * `initialCreate` still set and reopen the drawer on a click from months
   * ago. Omitted for the same reason `initialCreate` can be omitted.
   */
  onInitialCreateConsumed?: () => void;
  /** An index was created or dropped, so figures derived from them (the statistics header) are stale. */
  onChanged?: () => void;
}) {
  const T = themeVars;
  const target = React.useMemo(() => ({ dbName, collection }), [dbName, collection]);
  const [indexes, setIndexes] = React.useState<IndexInfo[] | null>(null);
  const [loadingIndexes, setLoadingIndexes] = React.useState(false);
  const [indexError, setIndexError] = React.useState<{ message: string; code?: string } | null>(
    null,
  );
  const [expandedRow, setExpandedRow] = React.useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [createPrefill, setCreatePrefill] = React.useState<IndexSuggestion | null>(null);
  // Only set for the `initialCreate` open path — see that effect below for
  // why the drawer's own default focus-return capture can't be trusted
  // there. `null` for the plain "+ New index" click: `document.activeElement`
  // at that mount is the button itself, which is exactly right already.
  const [createReturnFocusTo, setCreateReturnFocusTo] = React.useState<HTMLElement | null>(null);
  const [dropName, setDropName] = React.useState<string | null>(null);
  // Captured alongside `dropName`, in the same click handler that sets it —
  // reading a ref's `.current` has to happen in an event handler or effect,
  // never during render (`react-hooks/refs`), so this can't be
  // `scrollRegionRef.current` inline in the JSX below.
  const [dropReturnFocus, setDropReturnFocus] = React.useState<HTMLElement | null>(null);
  // Focus-return target for a successful drop: the row is gone by then, but
  // this scroll region is mounted for the tab's whole lifetime. Not the
  // "Refresh" button, the obvious-looking alternative — it's `disabled={loadingIndexes}`,
  // and the success path kicks off a reload, so it is disabled at the exact
  // moment focus would land there. A disabled focused button drops focus to
  // <body> itself — the same disabled-button focus loss documented at
  // FieldsControl.tsx:84-91 — which is the bug this exists to fix.
  const scrollRegionRef = React.useRef<HTMLDivElement>(null);

  // Only the latest request may write state: a slow reply for a collection the
  // tab has since left must not overwrite the one now on screen.
  const latest = React.useRef(0);

  const loadIndexes = React.useCallback(
    async (t: { dbName: string; collection: string }) => {
      const id = ++latest.current;
      setLoadingIndexes(true);
      setIndexError(null);
      try {
        const rows = await api.index.list({
          connectionId,
          dbName: t.dbName,
          collection: t.collection,
        });
        if (id === latest.current) setIndexes(rows);
      } catch (err) {
        if (id === latest.current) {
          if (isIpcError(err)) {
            setIndexError({ message: err.message, code: err.code });
          } else {
            setIndexError({ message: String(err) });
          }
          setIndexes(null);
        }
      } finally {
        if (id === latest.current) setLoadingIndexes(false);
      }
    },
    [connectionId],
  );

  /* eslint-disable react-hooks/set-state-in-effect */
  React.useEffect(() => {
    if (viewOn !== undefined) return;
    void loadIndexes(target);
    setExpandedRow(null);
    const request = latest;
    return () => {
      request.current++;
    };
  }, [target, loadIndexes, viewOn]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Opens the create-index drawer prefilled from ExplainDrawer's "Create an
  // index for this query" (W16 Tier 4). `onInitialCreateConsumed` nulls the
  // request at its source right away — see that prop's own doc comment for
  // why a remount must not find it still set.
  //
  // `useDialogFocusReturn`'s default capture (`document.activeElement` at
  // `CreateIndexDrawer`'s own first render) is wrong here and `returnFocusTo`
  // has to override it: the click that led here was on a button inside
  // `ExplainDrawer`, in the Documents view, which the Structure-view switch
  // this same click triggers then unmounts. The previously-focused trigger
  // is gone from the DOM by the time this drawer mounts, so the browser has
  // already reset focus to `<body>` — capturing that gives Escape/Cancel a
  // `trigger.focus()` that's a silent no-op instead of a real return target.
  // `scrollRegionRef` is mounted for this tab's whole lifetime, same
  // fallback `DropConfirmDialog`'s `returnFocusTo` uses below for the
  // equivalent "the opener won't exist when this closes" case.
  // Deliberately keyed on `requestId` alone, not the whole `initialCreate`
  // object: two refused clicks in a row both carry `suggestion: null`, and
  // keying on the object would rely on the caller giving each click a new
  // object identity rather than on anything this effect actually checks.
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  React.useEffect(() => {
    if (!initialCreate) return;
    setCreatePrefill(initialCreate.suggestion);
    setCreateReturnFocusTo(scrollRegionRef.current);
    setDrawerOpen(true);
    onInitialCreateConsumed?.();
  }, [initialCreate?.requestId, onInitialCreateConsumed]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  // `flex: 'none'` + `overflow: 'visible'`, not the `flex: 1; overflow:
  // hidden` this used before it moved into the collection tab's Structure
  // view (W16 Tier 2, ADR 0003): that assumed a flex parent with a definite
  // height to fill and its own internal scroller. `StructureView` is a
  // plain scrolling block instead — one scroller for the whole pane — so
  // this lays out at its natural content height and lets the page provide
  // the only scrollbar.
  if (viewOn !== undefined) {
    return (
      <div style={{ padding: '10px 16px', fontSize: 12, color: T.textMuted, borderBottom: `1px solid ${T.border}` }}>
        Views have no indexes of their own. This view uses the indexes of {viewOn}, the collection it reads from.
      </div>
    );
  }

  return (
    <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', overflow: 'visible', position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 16px',
          borderBottom: `1px solid ${T.border}`,
          background: T.surface,
        }}
      >
        <div style={{ flex: 1 }} />

        <Button
          size="compact-xs"
          variant="filled"
          onClick={() => {
            setCreatePrefill(null);
            setCreateReturnFocusTo(null);
            setDrawerOpen(true);
          }}
        >
          + New index
        </Button>

        <Button
          size="compact-xs"
          variant="subtle"
          onClick={() => void loadIndexes(target)}
          leftSection={I.sync}
          disabled={loadingIndexes}
        >
          Refresh
        </Button>
      </div>

      <div
        ref={scrollRegionRef}
        tabIndex={-1}
        role="region"
        aria-label="Indexes"
        style={{ overflowY: 'visible' }}
      >
        {indexError && (
          <Alert
            role="alert"
            color="orange"
            variant="light"
            m="sm"
            styles={{ message: { fontSize: 12 } }}
          >
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <Text size="xs">
                {indexError.code === 'UNAUTHORIZED'
                  ? `This connection lacks the privilege to read indexes on ${target.dbName}.${target.collection}.`
                  : indexError.message}
              </Text>
              <Button
                variant="subtle"
                size="compact-xs"
                ml="auto"
                style={{ flexShrink: 0 }}
                onClick={() => void loadIndexes(target)}
              >
                Retry
              </Button>
            </Group>
          </Alert>
        )}

        {!indexError && loadingIndexes && !indexes && (
          <div style={{ padding: 20, color: T.textMuted, fontSize: 13 }}>Loading indexes…</div>
        )}

        {drawerOpen && (
          <CreateIndexDrawer
            target={target}
            onCancel={() => {
              setDrawerOpen(false);
              setCreatePrefill(null);
            }}
            onCreated={() => {
              setDrawerOpen(false);
              setCreatePrefill(null);
              void loadIndexes(target);
              onChanged?.();
            }}
            connectionId={connectionId}
            initialFields={createPrefill?.keys.map((k) => ({ field: k.field, direction: k.direction }))}
            reason={createPrefill?.reason}
            returnFocusTo={createReturnFocusTo}
          />
        )}

        {dropName && (
          <DropConfirmDialog
            indexName={dropName}
            onCancel={() => setDropName(null)}
            onDropped={() => {
              setDropName(null);
              void loadIndexes(target);
              onChanged?.();
            }}
            returnFocusTo={dropReturnFocus}
            connectionId={connectionId}
            dbName={target.dbName}
            collection={target.collection}
          />
        )}

        {!indexError && indexes && (
          <Table
            striped
            highlightOnHover
            withTableBorder
            withColumnBorders={false}
            styles={{
              table: { fontSize: 12 },
              th: {
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                fontWeight: 600,
                color: T.textMuted,
                padding: '8px 12px',
              },
              td: { padding: '8px 12px', verticalAlign: 'middle' },
            }}
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Key</Table.Th>
                <Table.Th>Options</Table.Th>
                <Table.Th>Size</Table.Th>
                <Table.Th>Use</Table.Th>
                <Table.Th style={{ width: 36 }} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {indexes.map((idx) => {
                const isOpen = expandedRow === idx.name;
                return (
                  <React.Fragment key={idx.name}>
                    <Table.Tr
                      onClick={() => setExpandedRow(isOpen ? null : idx.name)}
                      style={{ cursor: 'pointer' }}
                    >
                      <Table.Td>
                        <DisclosureToggle open={isOpen}>
                          <span
                            style={{
                              fontFamily: 'monospace',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              color: T.text,
                            }}
                            title={idx.name}
                          >
                            {idx.name}
                          </span>
                        </DisclosureToggle>
                      </Table.Td>
                      <Table.Td>
                        <Text
                          size="xs"
                          c="dimmed"
                          style={{
                            fontFamily: 'monospace',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={renderKey(idx.key)}
                        >
                          {renderKey(idx.key)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="wrap">
                          {indexBadges(idx).map((b) => (
                            <IndexBadge key={b.label} label={b.label} tone={b.tone} />
                          ))}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Text
                          size="xs"
                          c="dimmed"
                          style={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                          {typeof idx.sizeBytes === 'number' ? humanBytes(idx.sizeBytes) : '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text
                          size="xs"
                          c="dimmed"
                          style={{ fontVariantNumeric: 'tabular-nums' }}
                          title={idx.usage ? `since ${idx.usage.since}` : undefined}
                        >
                          {idx.usage ? humanCount(idx.usage.ops) : '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Group justify="flex-end">
                          {!idx.isIdIndex && (
                            <ActionIcon
                              aria-label={`Drop index ${idx.name}`}
                              variant="subtle"
                              color="red"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDropName(idx.name);
                                setDropReturnFocus(scrollRegionRef.current);
                              }}
                              title="Drop index"
                            >
                              {I.trash}
                            </ActionIcon>
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>

                    {isOpen && (
                      <Table.Tr>
                        <Table.Td
                          colSpan={6}
                          style={{
                            background: T.surfaceRaised,
                            paddingLeft: 38,
                          }}
                        >
                          <Stack gap={6} py={4}>
                            <Text size="xs" c="dimmed">
                              <span style={{ color: T.textMuted }}>Version</span>
                              {' · v'}
                              {idx.version}
                            </Text>
                            {idx.partialFilterExpression && (
                              <Text
                                size="xs"
                                c="dimmed"
                                style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}
                              >
                                <span style={{ color: T.textMuted, fontFamily: 'inherit' }}>
                                  partialFilterExpression
                                </span>
                                {' · '}
                                {idx.partialFilterExpression}
                              </Text>
                            )}
                            {idx.collation && (
                              <Text
                                size="xs"
                                c="dimmed"
                                style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}
                              >
                                <span style={{ color: T.textMuted, fontFamily: 'inherit' }}>collation</span>
                                {' · '}
                                {idx.collation}
                              </Text>
                            )}
                            {idx.usage && (
                              <Text size="xs" c="dimmed">
                                <span style={{ color: T.textMuted }}>Usage</span>
                                {' · '}
                                {idx.usage.ops.toLocaleString()} ops since{' '}
                                {new Date(idx.usage.since).toLocaleString()}
                              </Text>
                            )}
                          </Stack>
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </React.Fragment>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </div>

    </div>
  );
}

const DIRECTION_OPTIONS: IndexFieldDirection[] = [
  1,
  -1,
  'text',
  'hashed',
  '2d',
  '2dsphere',
];

interface FieldRow {
  field: string;
  direction: IndexFieldDirection;
}

// Hoisted so the dirty check below compares against the same literals the fields open with.
const DEFAULT_FIELDS: FieldRow[] = [{ field: '', direction: 1 }];
const DEFAULT_PARTIAL_FILTER = '{}';
const DEFAULT_COLLATION = '{}';

function CreateIndexDrawer({
  target,
  connectionId,
  onCancel,
  onCreated,
  initialFields,
  reason,
  returnFocusTo,
}: {
  target: { dbName: string; collection: string };
  connectionId: string;
  onCancel: () => void;
  onCreated: () => void;
  /** Prefill from `suggestIndex` (ExplainDrawer's "Create an index for this query"). Omitted for the plain "+ New index" open. */
  initialFields?: FieldRow[];
  /** The prefill's rationale line, shown above the fields when `initialFields` is set. */
  reason?: string;
  /**
   * Overrides `useDialogFocusReturn`'s default capture. Required for the
   * `initialFields` open path — see that effect's own comment in
   * `IndexesTab` for why the default (`document.activeElement` at this
   * component's own first render) is `<body>` there, not a useful target.
   * `null` for the plain "+ New index" open, where the default capture is
   * already correct.
   */
  returnFocusTo?: HTMLElement | null;
}) {
  const T = themeVars;
  const close = useDialogFocusReturn(onCancel, returnFocusTo);
  // The baseline both the initial value and the dirty check compare
  // against — a prefilled drawer that the user hasn't touched must not
  // read as dirty, or closing it prompts "Discard changes?" over nothing.
  const baselineFields =
    initialFields && initialFields.length > 0 ? initialFields : DEFAULT_FIELDS;
  const [fields, setFields] = React.useState<FieldRow[]>(baselineFields);
  const [name, setName] = React.useState('');
  const [unique, setUnique] = React.useState(false);
  const [sparse, setSparse] = React.useState(false);
  const [ttlEnabled, setTtlEnabled] = React.useState(false);
  const [ttlSeconds, setTtlSeconds] = React.useState('');
  const [partialEnabled, setPartialEnabled] = React.useState(false);
  const [partialFilter, setPartialFilter] = React.useState(DEFAULT_PARTIAL_FILTER);
  const [collationEnabled, setCollationEnabled] = React.useState(false);
  const [collation, setCollation] = React.useState(DEFAULT_COLLATION);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // The server rejects an empty field name but accepts whitespace, so block blank ones here rather than after a round trip.
  const canSubmit = fields.every((f) => f.field.trim() !== '');

  const isDirty =
    JSON.stringify(fields) !== JSON.stringify(baselineFields) ||
    name !== '' ||
    unique ||
    sparse ||
    ttlEnabled ||
    ttlSeconds !== '' ||
    partialEnabled ||
    partialFilter !== DEFAULT_PARTIAL_FILTER ||
    collationEnabled ||
    collation !== DEFAULT_COLLATION;

  const requestClose = async () => {
    if (!isDirty) return close();
    const discard = await confirmDestructive({
      title: 'Discard changes?',
      body: 'This closes the editor and loses what you typed.',
      confirmLabel: 'Discard',
    });
    if (discard) close();
  };

  const updateField = (i: number, patch: Partial<FieldRow>) => {
    setFields((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const removeField = (i: number) => {
    setFields((rows) => (rows.length === 1 ? rows : rows.filter((_, idx) => idx !== i)));
  };

  const submit = async () => {
    if (submitting || !canSubmit) return;
    setError(null);
    if (ttlEnabled) {
      if (fields.length !== 1) {
        setError('TTL indexes require exactly one field.');
        return;
      }
      const dir = fields[0]!.direction;
      if (dir !== 1 && dir !== -1) {
        setError('TTL indexes require an ascending or descending key.');
        return;
      }
      const n = Number(ttlSeconds);
      if (!Number.isFinite(n) || n < 0) {
        setError('expireAfterSeconds must be a non-negative number.');
        return;
      }
    }
    if (partialEnabled) {
      try {
        JSON.parse(partialFilter);
      } catch {
        setError('partialFilterExpression: invalid JSON.');
        return;
      }
    }
    if (collationEnabled) {
      try {
        JSON.parse(collation);
      } catch {
        setError('collation: invalid JSON.');
        return;
      }
    }

    const options: IndexCreateInput['options'] = {};
    if (name.trim()) options.name = name.trim();
    if (unique) options.unique = true;
    if (sparse) options.sparse = true;
    if (ttlEnabled) options.expireAfterSeconds = Number(ttlSeconds);
    if (partialEnabled) options.partialFilterExpression = partialFilter;
    if (collationEnabled) options.collation = collation;

    setSubmitting(true);
    try {
      await api.index.create({
        connectionId,
        dbName: target.dbName,
        collection: target.collection,
        fields,
        options,
      });
      onCreated();
    } catch (err) {
      setError(isIpcError(err) ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      opened
      onClose={() => void requestClose()}
      position="right"
      size={380}
      title={`New index — ${target.dbName}.${target.collection}`}
      padding="md"
      closeOnClickOutside={false}
      // minHeight: 0 lets the flex scroll region shrink below content — jsdom does no layout, only e2e catches a regression here.
      styles={{
        content: { display: 'flex', flexDirection: 'column' },
        body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
      }}
    >
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Section title="Fields">
          {initialFields && reason && (
            <div
              data-testid="create-index-reason"
              style={{
                fontSize: 11,
                color: T.textMuted,
                marginBottom: 8,
                lineHeight: 1.4,
              }}
            >
              {reason}
            </div>
          )}
          {fields.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input
                aria-label={`Field ${i + 1}`}
                value={f.field}
                onChange={(e) => updateField(i, { field: e.target.value })}
                placeholder="field name"
                style={inputStyle(T)}
              />
              <select
                aria-label={`Direction ${i + 1}`}
                value={String(f.direction)}
                onChange={(e) => {
                  const v = e.target.value;
                  const dir: IndexFieldDirection =
                    v === '1' || v === '-1' ? (Number(v) as 1 | -1) : (v as IndexFieldDirection);
                  updateField(i, { direction: dir });
                }}
                style={{ ...inputStyle(T), maxWidth: 110 }}
              >
                {DIRECTION_OPTIONS.map((d) => (
                  <option key={String(d)} value={String(d)}>
                    {d === 1 ? 'asc (1)' : d === -1 ? 'desc (-1)' : d}
                  </option>
                ))}
              </select>
              <button
                onClick={() => removeField(i)}
                disabled={fields.length === 1}
                aria-label={`Remove field ${i + 1}`}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: fields.length === 1 ? T.textGhost : T.textMuted,
                  cursor: fields.length === 1 ? 'not-allowed' : 'pointer',
                  fontSize: 14,
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            onClick={() => setFields((rows) => [...rows, { field: '', direction: 1 }])}
            style={{
              background: 'transparent',
              border: `1px dashed ${T.border}`,
              borderRadius: T.rs,
              padding: '4px 8px',
              fontSize: 11,
              color: T.textMuted,
              cursor: 'pointer',
            }}
          >
            + Add field
          </button>
        </Section>

        <Section title="Options">
          <Check label="Unique" checked={unique} onChange={setUnique} />
          <Check label="Sparse" checked={sparse} onChange={setSparse} />
          <Check label="TTL — expire after" checked={ttlEnabled} onChange={setTtlEnabled}>
            {ttlEnabled && (
              <input
                aria-label="expireAfterSeconds"
                value={ttlSeconds}
                onChange={(e) => setTtlSeconds(e.target.value)}
                placeholder="seconds"
                style={{ ...inputStyle(T), maxWidth: 100, marginLeft: 6 }}
              />
            )}
          </Check>
          <Check
            label="Partial filter (EJSON)"
            checked={partialEnabled}
            onChange={setPartialEnabled}
          />
          {partialEnabled && (
            <textarea
              aria-label="partialFilterExpression"
              value={partialFilter}
              onChange={(e) => setPartialFilter(e.target.value)}
              rows={3}
              style={{ ...inputStyle(T), fontFamily: 'monospace', resize: 'vertical' }}
            />
          )}
          <Check label="Collation (EJSON)" checked={collationEnabled} onChange={setCollationEnabled} />
          {collationEnabled && (
            <textarea
              aria-label="collation"
              value={collation}
              onChange={(e) => setCollation(e.target.value)}
              rows={2}
              style={{ ...inputStyle(T), fontFamily: 'monospace', resize: 'vertical' }}
            />
          )}
        </Section>

        <Section title="Name (optional)">
          <input
            aria-label="Index name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="server generates one if blank"
            style={inputStyle(T)}
          />
        </Section>

        {error && (
          <div
            role="alert"
            style={{
              padding: '8px 10px',
              borderRadius: T.rs,
              border: `1px solid ${T.warn}`,
              background: 'rgba(184,76,20,0.08)',
              color: T.warn,
              fontSize: 11,
            }}
          >
            {error}
          </div>
        )}
      </div>

      <div
        style={{
          paddingTop: 12,
          borderTop: `1px solid ${T.border}`,
          display: 'flex',
          gap: 8,
          justifyContent: 'flex-end',
        }}
      >
        <Button
          variant="subtle"
          size="compact-xs"
          onClick={() => void requestClose()}
          disabled={submitting}
        >
          Cancel
        </Button>
        <SubmitButton
          variant="filled"
          size="compact-xs"
          onClick={() => void submit()}
          disabled={!canSubmit}
          submitting={submitting}
        >
          {submitting ? 'Creating…' : 'Create index'}
        </SubmitButton>
      </div>
    </Drawer>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const T = themeVars;
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: T.textMuted,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
  children,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  const T = themeVars;
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        color: T.text,
        marginBottom: 4,
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: T.accent }}
      />
      <span>{label}</span>
      {children}
    </label>
  );
}

function inputStyle(T: typeof themeVars): React.CSSProperties {
  return {
    flex: 1,
    border: `1px solid ${T.border}`,
    borderRadius: T.rs,
    padding: '4px 8px',
    fontSize: 12,
    color: T.text,
    background: T.surfaceRaised,
    outline: 'none',
    fontFamily: 'inherit',
  };
}

function DropConfirmDialog({
  indexName,
  connectionId,
  dbName,
  collection,
  onCancel,
  onDropped,
  returnFocusTo,
}: {
  indexName: string;
  connectionId: string;
  dbName: string;
  collection: string;
  onCancel: () => void;
  onDropped: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  const close = useDialogFocusReturn(onCancel);
  // Separate call on purpose, not a shared one with `close` above: `close`
  // keeps the render-time captured trigger — the "Drop index" `ActionIcon`
  // still exists after a Cancel and is the better target there. `finish`
  // needs the scroll container instead, because the row (and its ActionIcon)
  // is gone by the time a successful drop reloads the list. This call's own
  // `useState` capture of `document.activeElement` is dead weight since
  // `returnFocusTo` always wins when passed — don't collapse these into one.
  const finish = useDialogFocusReturn(onDropped, returnFocusTo);
  const [typed, setTyped] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const matches = typed === indexName;

  const submit = async () => {
    if (!matches || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.index.drop({ connectionId, dbName, collection, name: indexName });
      finish();
    } catch (err) {
      setError(isIpcError(err) ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      opened
      onClose={close}
      title={`Drop index "${indexName}"?`}
      centered
      size="md"
      aria-label="Drop index"
    >
      <Stack gap="sm">
        <Text size="xs" c="dimmed" lh={1.5}>
          This is permanent. Queries that relied on this index may slow down.
        </Text>
        <Stack gap={6}>
          <Text size="xs" c="dimmed">
            Type the index name to confirm:
          </Text>
          <TextInput
            aria-label="Confirm index name"
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
            size="xs"
            styles={{ input: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' } }}
          />
        </Stack>
        {error && (
          <Alert color="red" variant="light" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" size="compact-xs" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <SubmitButton variant="filled" color="red" size="compact-xs" onClick={() => void submit()} disabled={!matches} submitting={submitting}>
            {submitting ? 'Dropping…' : 'Drop'}
          </SubmitButton>
        </Group>
      </Stack>
    </Modal>
  );
}
