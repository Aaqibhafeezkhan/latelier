import React from 'react';
import { UnstyledButton } from '@mantine/core';
import { SpotlightRoot, createSpotlight, useSpotlight } from '@mantine/spotlight';
import { useRovingHighlight } from '../hooks/useRovingHighlight';
import { useHints } from '../hints/HintsContext';
import { useFeatureHint } from '../hints/useFeatureHint';
import { FeatureHint } from '../hints/FeatureHint';
import { api, getErrorMessage } from '../api/atelier';
import { notify } from '../theme/notifications';
import { useRegistrySnapshot } from './useRegistrySnapshot';
import { formatShortcut } from './shortcutLabel';
import { isMacRenderer } from '../utils/platform';
import { usePaletteContext } from './PaletteContext';
import { displayText, type Range, type RowKind } from './rank';
import {
  ACTION_LIST_HINTS,
  SCOPES,
  SCOPE_CAP,
  SCOPE_LABEL,
  actionList,
  cycleScope,
  fieldStepHints,
  fieldStepList,
  footerHints,
  layoutPalette,
  pushHistory,
  rowAction,
  stepHistory,
  type ActionEntry,
  type Aside,
  type Entry,
  type FieldStepEntry,
  type FooterHints,
  type KeyHint,
  type MoreEntry,
  type RowEntry,
  type Scope,
  type VerbEntry,
  failureTitle,
} from './layout';
import { verbLine } from './verbs';
import { useLatest } from './useLatest';
import { _resetPaletteOpenerForTests, setPaletteOpener } from './paletteOpener';
import { _resetPaletteOpenForTests, setPaletteOpen } from './paletteOpenState';
import type { FieldStep, ObjectAction, PaletteContext, PaletteObject, StepField } from './types';

const MRU_CAP = 8;
const MRU_PREF_KEY = 'ui.commandPalette.mru';

// ── Dedicated Spotlight store ────────────────────────────────────────────────
// Use a private store instead of the package's default. The public CJS bundle
// doesn't export the module-level `spotlightStore`, so calling `getState()` on
// the re-exported binding is unreliable across bundlers. `createSpotlight()`
// gives us both the store and a control trio in one call — the store flows
// into `<SpotlightRoot store={...}>` and the controls back the imperative API.
const [paletteStore, paletteControls] = createSpotlight();

/** Test-only: reset the palette open/query state between tests. */
// eslint-disable-next-line react-refresh/only-export-components
export function _resetPaletteStoreForTests(): void {
  _resetPaletteOpenerForTests();
  _resetPaletteOpenForTests();
  paletteStore.setState({
    opened: false,
    empty: false,
    selected: -1,
    listId: '',
    query: '',
    registeredActions: new Set(),
  });
}

// ── Imperative API (kept identical so TitleBar callers need no changes) ──────

interface PaletteApi {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: () => boolean;
}

type ApiRef = React.MutableRefObject<PaletteApi | null>;

const ApiRefCtx = React.createContext<ApiRef | null>(null);

const NOOP_API: PaletteApi = {
  open: () => {},
  close: () => {},
  toggle: () => {},
  isOpen: () => false,
};

/**
 * Imperative open/close handle on the palette. Exposed so the existing
 * `⌘K` button in `<TitleBar>` can keep working without re-implementing the
 * keyboard shortcut. Returns a stable proxy that reads the current palette
 * api via a ref — safe to call during render even before the palette mounts.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function usePaletteApi(): PaletteApi {
  const ref = React.useContext(ApiRefCtx);
  return React.useMemo<PaletteApi>(
    () => ({
      open: () => ref?.current?.open() ?? NOOP_API.open(),
      close: () => ref?.current?.close() ?? NOOP_API.close(),
      toggle: () => ref?.current?.toggle() ?? NOOP_API.toggle(),
      isOpen: () => ref?.current?.isOpen() ?? false,
    }),
    [ref],
  );
}

// ── Pieces of a row ───────────────────────────────────────────────────────────

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const VISUALLY_HIDDEN: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};

const KBD: React.CSSProperties = {
  fontSize: 'var(--atelier-fs-xs)',
  padding: '1px 6px',
  border: '1px solid var(--atelier-border-med)',
  borderRadius: 'var(--atelier-radius-xs)',
  color: 'var(--atelier-text-muted)',
  background: 'var(--atelier-surface-raised)',
  whiteSpace: 'nowrap',
  flex: 'none',
};

function Kbd({ children }: { children: React.ReactNode }) {
  return <span style={KBD}>{children}</span>;
}

function Svg({ children, size = 16 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      {children}
    </svg>
  );
}

const COLLECTION_ICON_PATHS = (
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 10h18M9 10v10" />
  </>
);

const TRASH_ICON = (
  <Svg size={14}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </Svg>
);

const KIND_ICON: Record<RowKind, React.ReactNode> = {
  collection: <Svg>{COLLECTION_ICON_PATHS}</Svg>,
  database: (
    <Svg>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </Svg>
  ),
  connection: (
    <Svg>
      <rect x="3" y="4" width="18" height="7" rx="1" />
      <rect x="3" y="13" width="18" height="7" rx="1" />
    </Svg>
  ),
  tab: (
    <Svg>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9h8V5" />
    </Svg>
  ),
  saved: (
    <Svg>
      <path d="M6 3h12v18l-6-4-6 4z" />
    </Svg>
  ),
  action: (
    <Svg>
      <path d="M9 18l6-6-6-6" />
    </Svg>
  ),
};

/**
 * `text` with the matched ranges emphasised. The pieces are hidden from
 * assistive technology and the whole text follows once, unbroken, so the
 * row's name reads as the title and not as a run of fragments.
 */
function Highlighted({ text, ranges }: { text: string; ranges: Range[] }) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <span key={start} data-match style={{ color: 'var(--atelier-accent-ink)', fontWeight: 600 }}>
        {text.slice(start, end)}
      </span>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return (
    <>
      <span aria-hidden="true">{parts}</span>
      <span style={VISUALLY_HIDDEN}>{text}</span>
    </>
  );
}

/** A row built from the query: its title with the emphasised value in the monospace font. */
function QueryRowTitle({ title, emphasis }: { title: string; emphasis: string }) {
  const at = title.indexOf(emphasis);
  if (at === -1) return <>{title}</>;
  return (
    <>
      {title.slice(0, at)}
      <span style={{ fontFamily: MONO, fontSize: 'var(--atelier-fs-sm)', color: 'var(--atelier-accent-ink)' }}>
        {emphasis}
      </span>
      {title.slice(at + emphasis.length)}
    </>
  );
}

function Switch({ checked }: { checked: boolean }) {
  return (
    <span
      data-switch={checked ? 'on' : 'off'}
      aria-hidden="true"
      style={{
        width: 28,
        height: 16,
        borderRadius: 8,
        background: checked ? 'var(--atelier-accent)' : 'var(--atelier-border-med)',
        position: 'relative',
        flex: 'none',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 14 : 2,
          width: 12,
          height: 12,
          borderRadius: 6,
          background: 'var(--atelier-accent-text)',
        }}
      />
    </span>
  );
}

/** The failure toast's look, from its artboard: an error icon and a red border. */
const FAILURE_TOAST = {
  icon: (
    <Svg size={18}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
    </Svg>
  ),
  styles: {
    root: { border: '1px solid var(--atelier-red-border)' },
    icon: { background: 'transparent', color: 'var(--atelier-red)' },
  },
};

const ACTION_TAG: React.CSSProperties = {
  fontSize: 'var(--atelier-fs-sm)',
  borderRadius: 'var(--atelier-radius-xs)',
  padding: '1px 8px',
  whiteSpace: 'nowrap',
  flex: 'none',
};

function AsideView({ aside }: { aside: Aside }) {
  if (!aside) return null;
  if (aside.type === 'switch') return <Switch checked={aside.checked} />;
  if (aside.type === 'action') {
    return (
      <span
        data-action-tag={aside.destructive ? 'destructive' : 'plain'}
        style={{
          ...ACTION_TAG,
          color: aside.destructive ? 'var(--atelier-red)' : 'var(--atelier-accent-ink)',
          border: `1px solid ${aside.destructive ? 'var(--atelier-red-border)' : 'var(--atelier-accent-border)'}`,
          background: aside.destructive ? 'var(--atelier-red-soft)' : 'var(--atelier-accent-soft)',
        }}
      >
        {aside.label}
      </span>
    );
  }
  return <Kbd>{aside.type === 'key' ? formatShortcut(aside.keys, isMacRenderer()) : aside.label}</Kbd>;
}

const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--atelier-gap-sm)',
  padding: '8px 16px',
  width: '100%',
  textAlign: 'left',
  fontFamily: 'inherit',
  fontSize: 'var(--atelier-fs-md)',
  color: 'var(--atelier-text)',
};

interface EntryProps {
  entry: Entry;
  id: string;
  isCursor: boolean;
  onActivate: (entry: Entry) => void;
  onHover: (index: number) => void;
}

function RowView({ entry, id, isCursor, onActivate, onHover }: EntryProps & { entry: RowEntry }) {
  const { cmd, row, disabled } = entry;
  const { fromQuery } = row;
  const subtitle = disabled ?? cmd.subtitle;
  const tone = disabled === null ? undefined : 'var(--atelier-text-ghost)';
  return (
    <UnstyledButton
      id={id}
      type="button"
      role="option"
      tabIndex={-1}
      // A click must leave focus in the search input, which owns the keyboard.
      onMouseDown={(e) => e.preventDefault()}
      aria-selected={isCursor}
      aria-disabled={disabled === null ? undefined : true}
      aria-checked={cmd.toggle ? cmd.toggle.checked : undefined}
      data-action
      data-kind={entry.kind}
      data-cursor={isCursor || undefined}
      onClick={() => onActivate(entry)}
      onMouseEnter={() => onHover(entry.index)}
      style={{ ...ROW_STYLE, background: isCursor ? 'var(--atelier-accent-soft)' : 'transparent', color: tone ?? ROW_STYLE.color }}
    >
      <span style={{ color: tone ?? 'var(--atelier-text-muted)', display: 'flex', flex: 'none' }}>{KIND_ICON[entry.kind]}</span>
      {fromQuery ? (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--atelier-gap-xs)', flex: 1, minWidth: 0 }}>
          <span data-title={cmd.title} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <QueryRowTitle title={cmd.title} emphasis={fromQuery.emphasis} />
          </span>
          <span style={{ fontSize: 'var(--atelier-fs-sm)', color: 'var(--atelier-text-muted)' }}>{cmd.subtitle}</span>
        </span>
      ) : (
        <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <span data-title={displayText(cmd)}>
            {/* A greyed row is all in the ghost colour: no accent emphasis. */}
            <Highlighted text={displayText(cmd)} ranges={disabled === null ? row.ranges : []} />
          </span>
          {subtitle && (
            <span
              data-subtitle={subtitle}
              style={{ color: tone ?? 'var(--atelier-text-muted)', fontSize: 'var(--atelier-fs-sm)', marginLeft: 8 }}
            >
              {/* A disabled row's subtitle is its reason, which the query did not match. */}
              <Highlighted text={subtitle} ranges={disabled === null ? row.subtitleRanges : []} />
            </span>
          )}
        </span>
      )}
      <AsideView aside={entry.aside} />
    </UnstyledButton>
  );
}

function MoreView({ entry, id, isCursor, onActivate, onHover }: EntryProps & { entry: MoreEntry }) {
  return (
    <UnstyledButton
      id={id}
      type="button"
      role="option"
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      aria-selected={isCursor}
      data-more={entry.scope}
      data-cursor={isCursor || undefined}
      onClick={() => onActivate(entry)}
      onMouseEnter={() => onHover(entry.index)}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        fontFamily: 'inherit',
        color: 'var(--atelier-accent-ink)',
        fontSize: 'var(--atelier-fs-sm)',
        padding: '6px 16px 6px 42px',
        background: isCursor ? 'var(--atelier-accent-soft)' : 'transparent',
      }}
    >
      {entry.label}
    </UnstyledButton>
  );
}

function VerbView({ entry, id, isCursor, onActivate, onHover }: EntryProps & { entry: VerbEntry }) {
  return (
    <UnstyledButton
      id={id}
      type="button"
      role="option"
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      aria-selected={isCursor}
      data-verb={entry.target}
      data-cursor={isCursor || undefined}
      onClick={() => onActivate(entry)}
      onMouseEnter={() => onHover(entry.index)}
      style={{ ...ROW_STYLE, background: isCursor ? 'var(--atelier-accent-soft)' : 'transparent' }}
    >
      <span style={{ color: 'var(--atelier-text-muted)', display: 'flex', flex: 'none' }}>{KIND_ICON[entry.kind]}</span>
      <span data-title={entry.title} style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <Highlighted text={entry.title} ranges={entry.ranges} />
      </span>
      <span style={{ fontSize: 'var(--atelier-fs-xs)', color: 'var(--atelier-text-ghost)', flex: 'none' }}>
        {entry.destination}
      </span>
    </UnstyledButton>
  );
}

function EntryView(props: EntryProps) {
  const { entry } = props;
  if (entry.type === 'more') return <MoreView {...props} entry={entry} />;
  if (entry.type === 'verb') return <VerbView {...props} entry={entry} />;
  return <RowView {...props} entry={entry} />;
}

interface ActionRowProps {
  entry: ActionEntry;
  id: string;
  isCursor: boolean;
  onActivate: (entry: ActionEntry) => void;
  onHover: (index: number) => void;
}

function ActionRowView({ entry, id, isCursor, onActivate, onHover }: ActionRowProps) {
  const { action, disabled } = entry;
  const tone = disabled !== null ? 'var(--atelier-text-ghost)' : action.destructive ? 'var(--atelier-red)' : undefined;
  return (
    <UnstyledButton
      id={id}
      type="button"
      role="option"
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      aria-selected={isCursor}
      aria-disabled={disabled === null ? undefined : true}
      data-palette-action={action.id}
      data-destructive={action.destructive || undefined}
      data-cursor={isCursor || undefined}
      onClick={() => onActivate(entry)}
      onMouseEnter={() => onHover(entry.index)}
      style={{
        ...ROW_STYLE,
        padding: '7px 16px',
        background: isCursor ? 'var(--atelier-accent-soft)' : 'transparent',
        color: tone ?? ROW_STYLE.color,
      }}
    >
      {action.destructive && <span style={{ display: 'flex', flex: 'none' }}>{TRASH_ICON}</span>}
      <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <span data-title={action.title}>
          <Highlighted text={action.title} ranges={disabled === null ? entry.ranges : []} />
        </span>
        {disabled !== null && (
          <span data-subtitle style={{ fontSize: 'var(--atelier-fs-sm)', marginLeft: 8 }}>
            {disabled}
          </span>
        )}
      </span>
      {entry.tag && (
        <span style={{ fontSize: 'var(--atelier-fs-xs)', color: 'var(--atelier-text-ghost)', flex: 'none' }}>
          {entry.tag}
        </span>
      )}
      {entry.keys && <Kbd>{formatShortcut(entry.keys, isMacRenderer())}</Kbd>}
    </UnstyledButton>
  );
}

const GROUP_HEAD: React.CSSProperties = {
  padding: '10px 16px 4px',
  fontSize: 'var(--atelier-fs-xs)',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--atelier-text-muted)',
};

interface StepRowProps {
  entry: FieldStepEntry;
  id: string;
  isCursor: boolean;
  onActivate: (entry: FieldStepEntry) => void;
  onHover: (index: number) => void;
}

/** A field step row: a field path in the monospace font with its type tag, or a starter's label. */
function StepRowView({ entry, id, isCursor, onActivate, onHover }: StepRowProps) {
  const field = entry.type === 'field' ? entry.field : null;
  const text = entry.type === 'field' ? entry.field.path : entry.label;
  return (
    <UnstyledButton
      id={id}
      type="button"
      role="option"
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      aria-selected={isCursor}
      data-step-row={entry.type}
      data-cursor={isCursor || undefined}
      onClick={() => onActivate(entry)}
      onMouseEnter={() => onHover(entry.index)}
      style={{ ...ROW_STYLE, padding: '7px 16px', background: isCursor ? 'var(--atelier-accent-soft)' : 'transparent' }}
    >
      <span
        data-title={text}
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          ...(field ? { fontFamily: MONO, fontSize: 'var(--atelier-fs-sm)' } : null),
        }}
      >
        <Highlighted text={text} ranges={entry.ranges} />
      </span>
      {field && (
        <span
          data-field-type
          style={{
            fontSize: 'var(--atelier-fs-xs)',
            color: 'var(--atelier-text-muted)',
            border: '1px solid var(--atelier-border-med)',
            borderRadius: 'var(--atelier-radius-xs)',
            padding: '0 6px',
            flex: 'none',
          }}
        >
          {field.type}
        </span>
      )}
    </UnstyledButton>
  );
}

const CHIP: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--atelier-gap-xs)',
  background: 'var(--atelier-surface-active)',
  border: '1px solid var(--atelier-border-med)',
  borderRadius: 'var(--atelier-radius-xs)',
  padding: '2px 8px',
  fontSize: 'var(--atelier-fs-sm)',
  color: 'var(--atelier-text)',
  whiteSpace: 'nowrap',
  flex: 'none',
};

/** The object an action list is for: its kind icon and name, and a collection's Connection. */
function ObjectChip({ obj }: { obj: PaletteObject }) {
  const label = obj.kind === 'collection' && obj.subtitle ? `${obj.name} · ${obj.subtitle}` : obj.name;
  return (
    <span data-object-chip style={CHIP}>
      <span style={{ display: 'flex', transform: 'scale(0.8125)', transformOrigin: 'center' }}>{KIND_ICON[obj.kind]}</span>
      {label}
    </span>
  );
}

const BAR_BORDER = '1px solid var(--atelier-border)';

function Footer({ hints }: { hints: FooterHints }) {
  const mac = isMacRenderer();
  const hint = (h: KeyHint) => (
    <span key={h.keys || h.label} style={{ display: 'flex', gap: 'var(--atelier-gap-xs)', alignItems: 'center' }}>
      {h.keys && <Kbd>{formatShortcut(h.keys, mac)}</Kbd>}
      {h.label}
      {h.strong && <b style={{ color: 'var(--atelier-text)', fontWeight: 600 }}>{h.strong}</b>}
    </span>
  );
  return (
    <div
      data-palette-footer
      style={{
        display: 'flex',
        gap: 'var(--atelier-gap-lg)',
        padding: '8px 16px',
        borderTop: BAR_BORDER,
        fontSize: 'var(--atelier-fs-xs)',
        color: 'var(--atelier-text-muted)',
        alignItems: 'center',
        minHeight: 35,
        boxSizing: 'border-box',
      }}
    >
      {hints.left.map(hint)}
      <span style={{ flex: 1 }} />
      {hints.right.map(hint)}
    </div>
  );
}

// ── Inner palette content (rendered inside SpotlightRoot) ─────────────────────

interface PaletteContentProps {
  onClose: () => void;
  recentIds: string[];
  recordRecent: (id: string) => void;
  initialScope: Scope;
  /** The session's earlier queries, newest first. */
  history: readonly string[];
}

const setQuery = (query: string) => paletteStore.setState((s) => ({ ...s, query }));

function PaletteContent({ onClose, recentIds, recordRecent, initialScope, history }: PaletteContentProps) {
  const ctx = usePaletteContext();
  const all = useRegistrySnapshot();
  const { query } = useSpotlight(paletteStore);
  const [scope, setScope] = React.useState<Scope>(initialScope);
  // Set by `<Verb> a connection…`: All lists Connection objects only, until the
  // query is cleared or the scope changes.
  const [connectionsOnly, setConnectionsOnly] = React.useState(false);
  // The object whose action list is open, by id so a re-registration keeps it.
  const [actionsOfId, setActionsOfId] = React.useState<string | null>(null);
  const [actionQuery, setActionQuery] = React.useState('');
  // The field step open over the action list (X07 §13.6), held as it was
  // opened so a re-registration of its object does not sample again.
  const [step, setStep] = React.useState<{ obj: PaletteObject; action: ObjectAction; step: FieldStep } | null>(null);
  const [stepQuery, setStepQuery] = React.useState('');
  // null while the sample loads.
  const [stepFields, setStepFields] = React.useState<StepField[] | null>(null);
  // Where `↑` left the history; it holds while the input still shows that entry.
  const [historyAt, setHistoryAt] = React.useState(-1);
  // The query the palette reopened on is the newest entry, so `↑` from an
  // empty input starts at the one before it.
  const [startAt] = React.useState(() => (history.length > 0 && history[0] === query ? 0 : -1));
  const browsing = historyAt >= 0 && history[historyAt] === query;
  const typed = query.trim() !== '';

  // Clearing the query ends Connections only (adjusted while rendering, not in an effect).
  if (!typed && connectionsOnly) setConnectionsOnly(false);
  const narrowed = connectionsOnly && typed;

  const layout = React.useMemo(
    () => layoutPalette(all, query, ctx, recentIds, scope, narrowed),
    [all, query, ctx, recentIds, scope, narrowed],
  );
  const { entries } = layout;
  const listId = React.useId();
  const optionId = (entry: Entry) => `${listId}-opt-${entry.id}`;

  // A new query or scope is a new list: the cursor goes back to the top.
  const listKey = `${scope}\u0000${narrowed}\u0000${query}`;
  const { index: safeCursor, setIndex, move } = useRovingHighlight(entries.length, listKey);

  const actionsOf = React.useMemo(
    () => (actionsOfId === null ? null : (all.find((c) => c.id === actionsOfId)?.object ?? null)),
    [all, actionsOfId],
  );
  const actionEntries = React.useMemo(
    () => (actionsOf ? actionList(actionsOf, actionQuery, ctx) : []),
    [actionsOf, actionQuery, ctx],
  );
  const actionsKey = `${actionsOfId ?? ''}\u0000${actionQuery}`;
  const actionCursor = useRovingHighlight(actionEntries.length, actionsKey);
  const actionOptionId = (entry: ActionEntry) => `${listId}-act-${entry.action.id}`;

  React.useEffect(() => {
    if (!step) return undefined;
    let live = true;
    step.step.loadFields().then(
      (fields) => {
        if (live) setStepFields(fields);
      },
      (err: unknown) => {
        // A sample that fails lists no fields; the starters still stand.
        console.warn('[palette] could not sample fields', err);
        if (live) setStepFields([]);
      },
    );
    return () => {
      live = false;
    };
  }, [step]);
  const stepList = React.useMemo(
    () => (step ? fieldStepList(stepFields, step.step.starters, stepQuery) : { fields: [], starters: [] }),
    [step, stepFields, stepQuery],
  );
  const stepEntries = React.useMemo(() => [...stepList.fields, ...stepList.starters], [stepList]);
  const stepCursor = useRovingHighlight(stepEntries.length, `${stepQuery}\u0000${stepFields === null}`);
  const stepOptionId = (entry: FieldStepEntry) =>
    `${listId}-step-${entry.type === 'field' ? `f-${entry.field.path}` : `s-${entry.id}`}`;

  // A toggle keeps the cursor on its row even when re-registering moves it,
  // for as long as the list is the one it was toggled in: a new query or
  // scope puts the cursor back on the best row.
  const followRef = React.useRef<{ id: string; listKey: string } | null>(null);
  React.useEffect(() => {
    const follow = followRef.current;
    if (follow === null) return;
    if (follow.listKey !== listKey) {
      followRef.current = null;
      return;
    }
    const at = entries.findIndex((e) => e.type === 'row' && e.id === follow.id);
    if (at !== -1 && at !== safeCursor) setIndex(at);
  }, [entries, safeCursor, setIndex, listKey]);
  const setCursor = (index: number) => {
    followRef.current = null;
    setIndex(index);
  };
  const moveCursor = (delta: number) => {
    followRef.current = null;
    move(delta);
  };
  const switchScope = (next: Scope) => {
    followRef.current = null;
    setConnectionsOnly(false);
    setScope(next);
  };

  // A toggle enters the MRU when the palette closes, so its row does not jump
  // into RECENT under the cursor while the palette is open.
  const toggledRef = React.useRef(new Set<string>());
  const recordRecentRef = useLatest(recordRecent);
  React.useEffect(() => {
    const toggled = toggledRef.current;
    const record = recordRecentRef;
    return () => {
      for (const id of toggled) record.current(id);
    };
  }, [recordRecentRef]);

  const inputRef = React.useRef<HTMLInputElement>(null);
  // The last query comes back selected, so typing replaces it.
  React.useEffect(() => {
    inputRef.current?.select();
  }, []);

  const inActions = actionsOf !== null;
  const inStep = step !== null;
  const cursorEntry = entries[safeCursor];
  const actionEntry = actionEntries[actionCursor.index];
  const stepEntry = stepEntries[stepCursor.index];
  const activeId = inStep
    ? stepEntry
      ? stepOptionId(stepEntry)
      : undefined
    : inActions
    ? actionEntry
      ? actionOptionId(actionEntry)
      : undefined
    : cursorEntry
      ? optionId(cursorEntry)
      : undefined;
  // Keyboard moves the cursor with the focus staying in the search input, so
  // the highlighted row has to be scrolled into view by hand. (Optional call:
  // jsdom has no scrollIntoView.)
  React.useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const run = React.useCallback(
    async (perform: (ctx: PaletteContext) => void | Promise<void>, title: string) => {
      try {
        await perform(ctx);
      } catch (e) {
        notify.error(getErrorMessage(e, 'The command failed.'), {
          title: `Couldn't run "${title}"`,
          ...FAILURE_TOAST,
        });
      }
    },
    [ctx],
  );

  /** Closes the palette, records `id` as the most recent, then performs. */
  const performAndClose = (id: string | null, perform: (ctx: PaletteContext) => void | Promise<void>, title: string) => {
    onClose();
    // Toggles flipped on this open go in first, so the command performed now
    // ends up the most recent.
    for (const t of toggledRef.current) recordRecent(t);
    toggledRef.current.clear();
    if (id !== null) recordRecent(id);
    void run(perform, title);
  };

  const performAction = (obj: PaletteObject, action: ObjectAction) => {
    if (action.disabledReason?.(ctx)) return;
    const opened = action.fieldStep?.();
    if (opened) {
      // Over the object's action list, so Escape goes back to it.
      setActionsOfId(obj.id);
      setActionQuery('');
      setStepQuery('');
      setStepFields(null);
      setStep({ obj, action, step: opened });
      return;
    }
    // Every action of an object bumps the object.
    performAndClose(obj.id, action.perform, failureTitle(obj.kind, action));
  };

  const openActions = (obj: PaletteObject) => {
    setActionQuery('');
    setActionsOfId(obj.id);
  };
  const chooseInStep = (entry: FieldStepEntry) => {
    if (!step) return;
    const { obj, action, step: s } = step;
    const choose = entry.type === 'field' ? () => s.chooseField(entry.field) : () => s.chooseStarter(entry.id);
    performAndClose(obj.id, choose, failureTitle(obj.kind, action));
  };
  const closeStep = () => {
    setStep(null);
    setStepQuery('');
  };
  const onStepKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' || ((e.key === 'ArrowLeft' || e.key === 'Backspace') && stepQuery === '')) {
      e.preventDefault();
      closeStep();
    } else if (e.key === 'Tab') {
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      stepCursor.move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      stepCursor.move(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      stepCursor.setIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      stepCursor.setIndex(Math.max(0, stepEntries.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (stepEntry) chooseInStep(stepEntry);
    }
  };

  const closeActions = () => {
    setActionsOfId(null);
    setActionQuery('');
  };

  const activate = (entry: Entry) => {
    if (entry.type === 'more') {
      switchScope(entry.scope);
      return;
    }
    if (entry.type === 'verb') {
      if (entry.target === 'connections') {
        followRef.current = null;
        setConnectionsOnly(true);
      } else {
        switchScope(entry.target);
      }
      return;
    }
    if (entry.disabled !== null) return;
    const { cmd } = entry;
    const obj = cmd.object;
    if (obj) {
      performAction(obj, rowAction(entry.row)!);
      return;
    }
    if (cmd.toggle) {
      followRef.current = { id: cmd.id, listKey };
      toggledRef.current.add(cmd.id);
      void run(cmd.perform, cmd.title);
      return;
    }
    // A row built from the query is not a command to come back to.
    performAndClose(cmd.forQuery ? null : cmd.id, cmd.perform, cmd.title);
  };

  /**
   * `⌘↵`: an object's alternate, where it has one; a command performs as on
   * Enter. A row listed for a verb has no alternate: the footer offers none.
   */
  const activateAlternate = (entry: Entry) => {
    if (entry.type !== 'row' || !entry.cmd.object) {
      activate(entry);
      return;
    }
    if (entry.row.action) return;
    const obj = entry.cmd.object;
    const alt = obj.actions.find((a) => a.alternate);
    if (alt) performAction(obj, alt);
  };

  const recall = (direction: 'older' | 'newer') => {
    const step = stepHistory(history, browsing ? historyAt : startAt, direction);
    if (!step) return;
    setHistoryAt(step.at);
    setQuery(step.query);
  };

  const onActionKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' || ((e.key === 'ArrowLeft' || e.key === 'Backspace') && actionQuery === '')) {
      e.preventDefault();
      closeActions();
    } else if (e.key === 'Tab') {
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      actionCursor.move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      actionCursor.move(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      actionCursor.setIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      actionCursor.setIndex(Math.max(0, actionEntries.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (actionsOf && actionEntry && actionEntry.disabled === null) performAction(actionsOf, actionEntry.action);
    }
  };

  // The input is the one element that ever holds focus here, so every key
  // the palette answers is bound on it.
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (inStep) {
      onStepKeyDown(e);
      return;
    }
    if (inActions) {
      onActionKeyDown(e);
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    const objectAtCursor = cursorEntry?.type === 'row' ? cursorEntry.cmd.object : undefined;
    const input = e.currentTarget;
    const caretAtEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
    if (e.key === 'Tab') {
      e.preventDefault();
      switchScope(cycleScope(scope, e.shiftKey ? -1 : 1));
    } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      switchScope('collections');
    } else if (e.key === 'ArrowUp' && (browsing || query === '') && history.length > 0) {
      e.preventDefault();
      recall('older');
    } else if (e.key === 'ArrowDown' && browsing) {
      e.preventDefault();
      recall('newer');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveCursor(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveCursor(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setCursor(Math.max(0, entries.length - 1));
    } else if (objectAtCursor && ((e.key === 'Enter' && e.altKey) || (e.key === 'ArrowRight' && caretAtEnd))) {
      e.preventDefault();
      openActions(objectAtCursor);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!cursorEntry) return;
      if (mod) activateAlternate(cursorEntry);
      else activate(cursorEntry);
    }
  };

  const onlyFromQuery = entries.length > 0 && entries.every((e) => e.type === 'row' && e.row.fromQuery);
  const emptyText = typed
    ? `No matches for "${query.trim()}"`
    : scope === 'all'
      ? 'No actions available here yet.'
      : `Type to search ${SCOPE_LABEL[scope].toLowerCase()}.`;
  const line = layout.verb ? verbLine(layout.verb) : null;

  const searchRow = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--atelier-gap-sm)',
        padding: '12px 16px',
        borderBottom: BAR_BORDER,
        color: 'var(--atelier-text-muted)',
      }}
    >
      {step ? (
        <>
          <button
            type="button"
            aria-label="Back to actions"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={closeStep}
            style={{ background: 'transparent', border: 0, color: 'inherit', padding: 0, display: 'flex', cursor: 'pointer' }}
          >
            <Svg>
              <path d="M15 18l-6-6 6-6" />
            </Svg>
          </button>
          <span data-object-chip style={CHIP}>
            {step.obj.name}
          </span>
          <span data-step-chip style={CHIP}>
            {step.step.title}
          </span>
        </>
      ) : actionsOf ? (
        <>
          <button
            type="button"
            aria-label="Back to results"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={closeActions}
            style={{ background: 'transparent', border: 0, color: 'inherit', padding: 0, display: 'flex', cursor: 'pointer' }}
          >
            <Svg>
              <path d="M15 18l-6-6 6-6" />
            </Svg>
          </button>
          <ObjectChip obj={actionsOf} />
        </>
      ) : (
        <Svg>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4-4" />
        </Svg>
      )}
      <input
        ref={inputRef}
        data-autofocus
        className="atelier-palette-input"
        value={inStep ? stepQuery : inActions ? actionQuery : query}
        onChange={(e) => {
          const v = e.currentTarget.value;
          if (inStep) setStepQuery(v);
          else if (inActions) setActionQuery(v);
          else setQuery(v);
        }}
        placeholder={inStep ? 'Filter fields…' : inActions ? 'Filter actions…' : 'Search collections, actions, tabs…'}
        aria-label={inStep ? 'Filter fields' : inActions ? 'Filter actions' : 'Search commands'}
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        // In the action list and the field step Escape goes back one step; the modal's own
        // Escape listener skips an event from an element marked this way.
        data-mantine-stop-propagation={inActions || inStep ? 'true' : undefined}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoComplete="off"
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 0,
          outline: 0,
          color: 'var(--atelier-text)',
          font: 'inherit',
          fontSize: 'var(--atelier-fs-lg)',
        }}
      />
      <Kbd>esc</Kbd>
    </div>
  );

  if (step) {
    const stepRows = (list: FieldStepEntry[]) =>
      list.map((entry) => (
        <StepRowView
          key={stepOptionId(entry)}
          entry={entry}
          id={stepOptionId(entry)}
          isCursor={entry.index === stepCursor.index}
          onActivate={chooseInStep}
          onHover={stepCursor.setIndex}
        />
      ));
    const muted: React.CSSProperties = { ...ROW_STYLE, padding: '7px 16px', color: 'var(--atelier-text-muted)' };
    // The fields group stays while it has a status to show, or a field that matches.
    const showFields = stepFields === null || stepFields.length === 0 || stepList.fields.length > 0;
    return (
      <div>
        {searchRow}
        <div
          id={listId}
          role="listbox"
          aria-label={`Fields of ${step.obj.name}`}
          style={{ maxHeight: 'min(460px, calc(100vh - 260px))', overflowY: 'auto', padding: '0 0 4px' }}
        >
          {showFields && (
            <div role="group" aria-labelledby={`${listId}-grp-fields`}>
              <div id={`${listId}-grp-fields`} style={GROUP_HEAD}>
                Fields · sampled
              </div>
              {stepFields === null ? (
                <div role="status" style={muted}>
                  Sampling fields…
                </div>
              ) : stepFields.length === 0 ? (
                <div role="status" style={muted}>
                  No fields sampled
                </div>
              ) : (
                stepRows(stepList.fields)
              )}
            </div>
          )}
          {!showFields && stepList.starters.length === 0 && (
            <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 'var(--atelier-fs-sm)', color: 'var(--atelier-text-muted)' }}>
              {`No matches for "${stepQuery.trim()}"`}
            </div>
          )}
          {stepList.starters.length > 0 && (
            <div role="group" aria-labelledby={`${listId}-grp-starters`}>
              <div id={`${listId}-grp-starters`} style={GROUP_HEAD}>
                Starters
              </div>
              {stepRows(stepList.starters)}
            </div>
          )}
        </div>
        <Footer hints={fieldStepHints(stepEntry)} />
      </div>
    );
  }

  if (actionsOf) {
    const firstDestructive = actionEntries.findIndex((a) => a.action.destructive);
    return (
      <div>
        {searchRow}
        <div
          id={listId}
          role="listbox"
          aria-label={`Actions for ${actionsOf.name}`}
          style={{ maxHeight: 'min(460px, calc(100vh - 260px))', overflowY: 'auto', padding: '4px 0' }}
        >
          {actionEntries.length === 0 ? (
            <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 'var(--atelier-fs-sm)', color: 'var(--atelier-text-muted)' }}>
              {`No actions match "${actionQuery.trim()}"`}
            </div>
          ) : (
            actionEntries.map((entry) => (
              <React.Fragment key={entry.action.id}>
                {entry.index === firstDestructive && firstDestructive > 0 && (
                  <div role="separator" style={{ height: 1, background: 'var(--atelier-border)', margin: '4px 0' }} />
                )}
                <ActionRowView
                  entry={entry}
                  id={actionOptionId(entry)}
                  isCursor={entry.index === actionCursor.index}
                  onActivate={(a) => {
                    if (a.disabled === null) performAction(actionsOf, a.action);
                  }}
                  onHover={actionCursor.setIndex}
                />
              </React.Fragment>
            ))
          )}
        </div>
        <Footer hints={ACTION_LIST_HINTS} />
      </div>
    );
  }

  return (
    <div>
      {searchRow}
      <div
        style={{ display: 'flex', gap: 'var(--atelier-gap-xs)', padding: '8px 12px', borderBottom: BAR_BORDER, alignItems: 'center' }}
      >
        {/* `display: contents` lets the Connections-only chip sit after All
            while staying outside the tablist, which holds tabs only. */}
        <div role="tablist" aria-label="Scope" style={{ display: 'contents' }}>
          {SCOPES.map((s, i) => {
            const selected = s === scope;
            return (
              <button
                key={s}
                type="button"
                role="tab"
                tabIndex={-1}
                aria-selected={selected}
                aria-controls={listId}
                // The input keeps the focus: a click selects the scope, nothing more.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => switchScope(s)}
                style={{
                  order: i === 0 ? 0 : 2,
                  background: selected ? 'var(--atelier-accent-soft)' : 'transparent',
                  border: 0,
                  color: selected ? 'var(--atelier-accent-ink)' : 'var(--atelier-text-muted)',
                  fontWeight: selected ? 600 : 400,
                  font: 'inherit',
                  fontSize: 'var(--atelier-fs-sm)',
                  padding: '4px 10px',
                  borderRadius: 'var(--atelier-radius-sm)',
                  cursor: 'pointer',
                }}
              >
                {SCOPE_LABEL[s]}
                {layout.counts && s !== 'all' && (
                  <span
                    data-count
                    style={{
                      fontSize: 'var(--atelier-fs-xs)',
                      marginLeft: 5,
                      color: 'var(--atelier-text-ghost)',
                      fontWeight: 400,
                    }}
                  >
                    {layout.counts[s]}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {narrowed && (
          <span data-connections-only style={{ ...CHIP, order: 1 }}>
            Connections only
            <button
              type="button"
              tabIndex={-1}
              aria-label="Remove Connections only"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setConnectionsOnly(false)}
              style={{ background: 'transparent', border: 0, padding: 0, color: 'var(--atelier-text-muted)', cursor: 'pointer', display: 'flex' }}
            >
              <Svg size={12}>
                <path d="M6 6l12 12M18 6L6 18" />
              </Svg>
            </button>
          </span>
        )}
        {!typed && (
          <>
            <span style={{ flex: 1, order: 3 }} />
            <span style={{ order: 3, fontSize: 'var(--atelier-fs-xs)', color: 'var(--atelier-text-ghost)' }}>
              Tab to switch scope
            </span>
          </>
        )}
      </div>
      {line && (
        <div data-verb-line style={{ fontSize: 'var(--atelier-fs-sm)', color: 'var(--atelier-text-muted)', padding: '8px 16px 0' }}>
          {line.before}
          <b style={{ color: layout.verb?.destructive ? 'var(--atelier-red)' : 'var(--atelier-text)', fontWeight: 600 }}>
            {line.verb}
          </b>
          {line.after}
        </div>
      )}
      <div
        id={listId}
        role="listbox"
        aria-label={scope === 'all' ? 'Results' : SCOPE_LABEL[scope]}
        style={{
          maxHeight: 'min(460px, calc(100vh - 260px))',
          overflowY: 'auto',
          padding: scope === 'all' && !narrowed ? '0 0 4px' : '4px 0',
        }}
      >
        {entries.length === 0 ? (
          <div
            style={{
              padding: '24px 16px',
              textAlign: 'center',
              fontSize: 'var(--atelier-fs-sm)',
              color: 'var(--atelier-text-muted)',
            }}
          >
            {emptyText}
          </div>
        ) : (
          layout.groups.map((group) => {
            const views = group.entries.map((entry) => (
              <EntryView
                key={entry.id}
                entry={entry}
                id={optionId(entry)}
                isCursor={entry.index === safeCursor}
                onActivate={activate}
                onHover={setCursor}
              />
            ));
            if (group.label === null) return <React.Fragment key={group.key}>{views}</React.Fragment>;
            return (
              <div key={group.key} role="group" aria-labelledby={`${listId}-grp-${group.key}`}>
                <div id={`${listId}-grp-${group.key}`} style={GROUP_HEAD}>
                  {group.label}
                </div>
                {views}
              </div>
            );
          })
        )}
        {onlyFromQuery && (
          <div
            style={{
              padding: '20px 16px',
              textAlign: 'center',
              fontSize: 'var(--atelier-fs-sm)',
              color: 'var(--atelier-text-muted)',
            }}
          >
            No other matches
          </div>
        )}
      </div>
      {layout.hidden > 0 && (
        <div
          data-row-limit
          style={{
            padding: '8px 16px',
            fontSize: 'var(--atelier-fs-sm)',
            color: 'var(--atelier-text-muted)',
            borderTop: BAR_BORDER,
            background: 'var(--atelier-surface-raised)',
          }}
        >
          Showing the best {SCOPE_CAP} · keep typing to narrow {layout.hidden} more
        </div>
      )}
      <Footer hints={footerHints(scope, typed, cursorEntry)} />
    </div>
  );
}

// ── CommandPalette shell ──────────────────────────────────────────────────────

interface PaletteShellProps {
  registerApi: (api: PaletteApi) => void;
}

export function CommandPalette({ registerApi }: PaletteShellProps) {
  const [recentIds, setRecentIds] = React.useState<string[]>([]);
  // Session only: never persisted.
  const [history, setHistory] = React.useState<string[]>([]);
  // The scope the next open lands on: All, except through ⌘P.
  const [openScope, setOpenScope] = React.useState<Scope>('all');

  const hints = useHints();
  const paletteOpenedCount = hints.getSessionEventCount('palette', 'opened');
  const discoverHint = useFeatureHint('palette.discover', paletteOpenedCount === 0);
  const { opened } = useSpotlight(paletteStore);
  React.useEffect(() => setPaletteOpen(opened), [opened]);

  const openPalette = React.useCallback(() => {
    hints.recordSessionEvent('palette', 'opened');
    paletteControls.open();
  }, [hints]);

  const closePalette = React.useCallback(() => {
    paletteControls.close();
  }, []);

  const togglePalette = React.useCallback(() => {
    if (paletteStore.getState().opened) {
      paletteControls.close();
    } else {
      hints.recordSessionEvent('palette', 'opened');
      paletteControls.open();
    }
  }, [hints]);

  // A query the palette closes on, after a perform or not, is one to come back to.
  const onPaletteClose = React.useCallback(() => {
    const { query } = paletteStore.getState();
    setHistory((h) => pushHistory(h, query));
    setOpenScope('all');
  }, []);

  // ⌘P opens on Collections. The same rules as ⌘N and ⌘, (GlobalCommands): a
  // dialog that is already open keeps the key, and in a text field only ⌘
  // reaches it, since a bare Ctrl+P is macOS's previous-line.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'p') return;
      const origin = e.target instanceof HTMLElement ? e.target : null;
      if (origin?.closest('[role="dialog"], [role="alertdialog"]')) return;
      if (origin?.closest('input, textarea, select, [contenteditable]') && !e.metaKey) return;
      e.preventDefault();
      hints.recordSessionEvent('palette', 'opened');
      setOpenScope('collections');
      paletteControls.open();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hints]);

  // Capture phase, registered once: focus has usually moved onto the search
  // input before Mantine reports the palette open, so the opener has to be
  // known beforehand. See paletteOpener.ts.
  React.useEffect(() => {
    const track = (e: FocusEvent) => setPaletteOpener(e.target);
    document.addEventListener('focusin', track, true);
    return () => document.removeEventListener('focusin', track, true);
  }, []);

  React.useEffect(() => {
    registerApi({
      open: openPalette,
      close: closePalette,
      toggle: togglePalette,
      isOpen: () => paletteStore.getState().opened,
    });
  }, [registerApi, openPalette, closePalette, togglePalette]);

  // History is a convenience: a failed read or write leaves the palette fully
  // usable. A failed read is logged, like the theme's; a failed write is a toast,
  // like the layout's. Stale ids are dropped by rankCommands.
  // Nothing is written until the stored history has been read and merged, so a
  // command run early never overwrites it; after a failed read, never.
  const [historyRead, setHistoryRead] = React.useState<'pending' | 'done' | 'failed'>('pending');
  React.useEffect(() => {
    let active = true;
    api.prefs
      .get<unknown>(MRU_PREF_KEY)
      .then((stored) => {
        if (!active) return;
        if (Array.isArray(stored) && stored.every((v): v is string => typeof v === 'string')) {
          // Merged behind anything performed while the read was in flight.
          setRecentIds((prev) =>
            [...prev, ...stored.filter((id) => !prev.includes(id))].slice(0, MRU_CAP),
          );
        }
        setHistoryRead('done');
      })
      .catch((err: unknown) => {
        console.warn('[palette] could not load the command history', err);
        if (active) setHistoryRead('failed');
      });
    return () => {
      active = false;
    };
  }, []);

  // Written from an effect, not the state updater (StrictMode runs updaters
  // twice), and only after a perform — the seed is never written back.
  const recentDirtyRef = React.useRef(false);
  React.useEffect(() => {
    if (historyRead !== 'done' || !recentDirtyRef.current) return;
    recentDirtyRef.current = false;
    void api.prefs.set(MRU_PREF_KEY, recentIds).catch(() => {
      notify.error('Could not save the command history', { id: 'palette-history-save-failed' });
    });
  }, [recentIds, historyRead]);

  const recordRecent = React.useCallback((id: string) => {
    recentDirtyRef.current = true;
    setRecentIds((prev) => {
      const next = [id, ...prev.filter((p) => p !== id)];
      return next.slice(0, MRU_CAP);
    });
  }, []);

  return (
    <>
      <SpotlightRoot
        data-command-palette
        store={paletteStore}
        shortcut="mod + K"
        // The last query comes back on the next open (X07 §13.3).
        clearQueryOnClose={false}
        onSpotlightClose={onPaletteClose}
        // Mantine's Modal applies `aria-label` to the outer root, not the
        // `role="dialog"` content element, so it never names the dialog. The
        // dialog's accessible name comes from its title (rendered as
        // `aria-labelledby`). Keep the legacy name "Command palette" — relied
        // on by the F04 e2e — while hiding the header so the palette stays
        // visually title-less.
        title="Command palette"
        styles={{
          header: { display: 'none' },
          content: {
            background: 'var(--atelier-surface)',
            border: '1px solid var(--atelier-border-med)',
            borderRadius: 'var(--atelier-radius)',
            boxShadow: 'var(--atelier-shadow-lg)',
            color: 'var(--atelier-text)',
            fontSize: 'var(--atelier-fs-md)',
            overflow: 'hidden',
          },
          body: { padding: 0 },
        }}
        size={640}
        yOffset={80}
      >
        {/* Only mount palette content while opened — keeps registry memos and
            keyboard handlers off the render path when the modal is closed. */}
        {opened && (
          <PaletteContent
            onClose={closePalette}
            recentIds={recentIds}
            recordRecent={recordRecent}
            initialScope={openScope}
            history={history}
          />
        )}
      </SpotlightRoot>
      <FeatureHint
        id="palette.discover"
        visible={discoverHint.visible}
        onDismiss={discoverHint.dismiss}
        onCta={openPalette}
      />
    </>
  );
}

// ── CommandPaletteRoot ────────────────────────────────────────────────────────

/**
 * Wraps `<CommandPalette>` and exposes its imperative API to descendants
 * via `usePaletteApi()`. Mount once near the App root.
 */
export function CommandPaletteRoot({ children }: { children: React.ReactNode }) {
  const apiRef = React.useRef<PaletteApi | null>(null);
  const registerApi = React.useCallback((next: PaletteApi) => {
    apiRef.current = next;
  }, []);
  return (
    <ApiRefCtx.Provider value={apiRef}>
      {children}
      <CommandPalette registerApi={registerApi} />
    </ApiRefCtx.Provider>
  );
}
