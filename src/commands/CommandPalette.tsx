import React from 'react';
import { UnstyledButton } from '@mantine/core';
import {
  SpotlightRoot,
  SpotlightSearch,
  SpotlightActionsList,
  createSpotlight,
  useSpotlight,
} from '@mantine/spotlight';
import { useRovingHighlight } from '../hooks/useRovingHighlight';
import { useHints } from '../hints/HintsContext';
import { useFeatureHint } from '../hints/useFeatureHint';
import { FeatureHint } from '../hints/FeatureHint';
import { api } from '../api/atelier';
import { notify } from '../theme/notifications';
import { useRegistrySnapshot } from './useRegistrySnapshot';
import { formatShortcut } from './shortcutLabel';
import { isMacRenderer } from '../utils/platform';
import { usePaletteContext } from './PaletteContext';
import { groupRows, rankCommands } from './rank';
import { GROUP_LABEL } from './types';
import type { Command } from './types';

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

// ── Action item renderer ──────────────────────────────────────────────────────

interface ActionItemProps {
  cmd: Command;
  id: string;
  index: number;
  isCursor: boolean;
  onActivate: (cmd: Command) => void;
  onHover: (index: number) => void;
}

function ActionItem({ cmd, id, isCursor, onActivate, onHover, index }: ActionItemProps) {
  return (
    <UnstyledButton
      id={id}
      type="button"
      role="option"
      aria-selected={isCursor}
      data-action
      data-selected={isCursor || undefined}
      data-cursor={isCursor || undefined}
      onClick={() => onActivate(cmd)}
      onMouseEnter={() => onHover(index)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 16px',
        width: '100%',
        background: 'transparent',
        textAlign: 'left',
        fontFamily: 'inherit',
        fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {cmd.title}
        </span>
        {cmd.subtitle && (
          <span
            style={{
              fontSize: 11,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'var(--atelier-text-muted)',
            }}
          >
            {cmd.subtitle}
          </span>
        )}
      </div>
      {cmd.shortcut && (
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: 'var(--atelier-text-ghost)',
          }}
        >
          {formatShortcut(cmd.shortcut, isMacRenderer())}
        </span>
      )}
    </UnstyledButton>
  );
}

// ── Inner palette content (rendered inside SpotlightRoot) ─────────────────────

interface PaletteContentProps {
  onClose: () => void;
  recentIds: string[];
  recordRecent: (id: string) => void;
}

function PaletteContent({ onClose, recentIds, recordRecent }: PaletteContentProps) {
  const ctx = usePaletteContext();
  const all = useRegistrySnapshot();
  const { query } = useSpotlight(paletteStore);

  const ranked = React.useMemo(
    () => rankCommands(all, query, ctx, recentIds),
    [all, query, ctx, recentIds],
  );
  const groups = React.useMemo(() => groupRows(ranked), [ranked]);
  const listId = React.useId();
  const optionId = (cmdId: string) => `${listId}-opt-${cmdId}`;

  // `resetKey: query` resets the cursor to 0 whenever the query changes,
  // without touching state during render or using an effect — this component
  // doesn't own the search input's onChange (Spotlight's own store does), so
  // it can't reset imperatively the way ConnectionSwitcher's search field does.
  const { index: safeCursor, setIndex: setCursor, move: moveCursor } =
    useRovingHighlight(ranked.length, query);

  // Keyboard moves the cursor with the focus staying in the search input, so
  // the highlighted row has to be scrolled into view by hand. (Optional call:
  // jsdom has no scrollIntoView.)
  const activeId = ranked[safeCursor] ? optionId(ranked[safeCursor].cmd.id) : undefined;
  React.useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const perform = React.useCallback(
    async (cmd: Command) => {
      onClose();
      recordRecent(cmd.id);
      try {
        await cmd.perform(ctx);
      } catch (e) {
        if (import.meta.env.DEV) {
          console.error(`[commandRegistry] perform() threw for "${cmd.id}":`, e);
        }
      }
    },
    [onClose, ctx, recordRecent],
  );

  // SpotlightSearch handles ArrowDown/ArrowUp/Enter via its built-in store
  // bindings, but those rely on the package's default store. Our private
  // store + custom action rows means we handle keyboard nav here. Home/End
  // round out the keyboard contract the legacy palette exposed.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
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
      setCursor(Math.max(0, ranked.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = ranked[safeCursor];
      if (row) void perform(row.cmd);
    }
  };

  return (
    // Plain grouping wrapper — no handler of its own (S6848). Keyboard nav
    // is bound to the search input below, the one element that ever holds
    // focus here (SpotlightSearch passes onKeyDown through to the native
    // <input> it renders).
    <div>
      <SpotlightSearch
        placeholder="Search actions, connections…"
        aria-label="Search commands"
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        onKeyDown={onKeyDown}
      />
      <SpotlightActionsList id={listId} role="listbox" aria-label="Commands">
        {ranked.length === 0 ? (
          <div
            style={{
              padding: '24px 16px',
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--atelier-text-muted)',
            }}
          >
            {query.trim() ? `No matches for "${query.trim()}"` : 'No actions available here yet.'}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.key} role="group" aria-labelledby={`${listId}-grp-${group.key}`}>
              <div
                id={`${listId}-grp-${group.key}`}
                style={{
                  padding: '8px 16px 4px',
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--atelier-text-muted)',
                }}
              >
                {group.key === 'recent'
                  ? group.label
                  : GROUP_LABEL[group.key as keyof typeof GROUP_LABEL] ?? group.label}
              </div>
              {group.rows.map(({ cmd, index }) => (
                <ActionItem
                  key={cmd.id}
                  cmd={cmd}
                  id={optionId(cmd.id)}
                  index={index}
                  isCursor={index === safeCursor}
                  onActivate={perform}
                  onHover={setCursor}
                />
              ))}
            </div>
          ))
        )}
      </SpotlightActionsList>
    </div>
  );
}

// ── CommandPalette shell ──────────────────────────────────────────────────────

interface PaletteShellProps {
  registerApi: (api: PaletteApi) => void;
}

export function CommandPalette({ registerApi }: PaletteShellProps) {
  const [recentIds, setRecentIds] = React.useState<string[]>([]);

  const hints = useHints();
  const paletteOpenedCount = hints.getSessionEventCount('palette', 'opened');
  const discoverHint = useFeatureHint('palette.discover', paletteOpenedCount === 0);
  const { opened } = useSpotlight(paletteStore);

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
        store={paletteStore}
        shortcut="mod + K"
        // Mantine's Modal applies `aria-label` to the outer root, not the
        // `role="dialog"` content element, so it never names the dialog. The
        // dialog's accessible name comes from its title (rendered as
        // `aria-labelledby`). Keep the legacy name "Command palette" — relied
        // on by the F04 e2e — while hiding the header so the palette stays
        // visually title-less.
        title="Command palette"
        styles={{ header: { display: 'none' } }}
        size={540}
        yOffset={80}
      >
        {/* Only mount palette content while opened — keeps registry memos and
            keyboard handlers off the render path when the modal is closed. */}
        {opened && (
          <PaletteContent
            onClose={closePalette}
            recentIds={recentIds}
            recordRecent={recordRecent}
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
