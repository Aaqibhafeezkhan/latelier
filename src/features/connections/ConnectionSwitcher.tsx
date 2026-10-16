import React from 'react';
import { Button, Group, Kbd, Popover, Text, TextInput, VisuallyHidden } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { I } from '../../icons';
import { STATUS_PRESENTATION, matchesConnectionQuery } from './connectionStatus';
import { useRovingHighlight } from '../../hooks/useRovingHighlight';
import { RowActionIcon } from './RowActionIcon';
import { formatShortcut } from '../../commands/shortcutLabel';
import { isMacRenderer } from '../../utils/platform';
import type { ConnectionSummary } from '@shared/types';

/**
 * The tracer bullet for switching Connections without leaving the
 * Data View. Search-first, not a menu (deliberately no "show search past N
 * connections" threshold — that was prototyped and rejected because it makes
 * the popover's shape change under the user as they add Connections).
 *
 * Status is read straight off `ConnectionSummary['status']` — no parallel
 * status vocabulary. `connections` is the same array `Workspace` already
 * subscribes to via `useConnections()`, so live status updates (connect /
 * fail / disconnect) reach this component for free; it does not own a
 * subscription of its own.
 *
 * The keyboard contract below is the reason the search-first shape
 * won the prototype: find-and-switch has to be one uninterrupted gesture.
 *
 *   ↑ / ↓   move through the filtered list (wraps at both ends)
 *   ↵       connect to the highlighted Connection and make it active
 *   ⌘↵      open the highlighted Connection's management screen
 *   ⌫       on an empty search, disconnect the highlighted Connection
 *   Esc     close, changing nothing
 *
 * Focus never leaves the search field for arrow/Enter navigation — the
 * highlight roves via `aria-activedescendant`, the combobox pattern, so
 * typing and navigating are the same gesture. That is also why the `role="option"`
 * rows themselves are not tab stops (the per-row edit button is a
 * deliberate, narrow exception — see `ConnectionRow`).
 *
 * The handler is bound to the dropdown, never to the document. That placement
 * is what keeps arrows out of every other text-entry surface in the Data View
 * — the query bar, the script editor, a rename field: the Switcher simply
 * never sees those keys. Inside the dropdown the search field is the only
 * element that can hold a caret, and taking its arrows is the point.
 *
 * Two more affordances joined later, both plain click/Tab targets rather than
 * extensions to the arrow-key contract above: "Manage connections" (pinned
 * above the list, unaffected by search) and a per-row edit button that opens
 * the Connection form as a modal, prefilled.
 *
 * The remaining ADR 0001 actions — manage, disconnect, delete — joined as
 * the same kind of inline, highlighted-row-only icon buttons rather than the
 * per-row `⋯` menu the ADR originally specified (rejected by the prototype;
 * see the ADR's Prototype findings). Manage and disconnect already had a
 * keyboard path (⌘↵, ⌫); this gives them a pointer one too, and gives delete
 * — which has no keyboard shortcut, deliberately, since it's destructive and
 * asks for confirmation regardless — its only path.
 *
 * `⌘E` — and the "Manage connections" button that does the same — opens the
 * full Connections table: comparing two similarly-named Connections, reading
 * detail, managing several in a row, and the list-wide actions (add, import,
 * export) that would crowd this popover. It *closes* the popover rather than
 * stacking on it (ADR 0001: only one list of Connections is ever on screen),
 * so this reuses `close()`, the same as every other action here that leaves
 * the Switcher.
 */
export interface ConnectionSwitcherProps {
  connections: ConnectionSummary[];
  /**
   * X16.4 — the Focused Tab's Connection, and the trigger's subject
   * alone. It is deliberately *not* what marks the rows: several Connections
   * can be open at once (§4.6), so "is this one connected" is a per-row fact
   * the row reads off its own `status`.
   */
  focusedConnectionId: string | null;
  /** Connects the Connection. Opens no tab — §4.6. */
  onSwitch: (id: string) => void;
  /** ⌘↵ / the management screen for one Connection. Closes the popover. */
  onManage: (id: string) => void;
  /** ⌫ on an empty search. Deliberately leaves the popover open. */
  onDisconnect: (id: string) => void;
  /** A row's edit affordance. Opens the same form, prefilled. Closes the popover. */
  onEdit: (id: string) => void;
  /**
   * a row's delete affordance. Confirmation happens in a modal over
   * the Data View, not inside the popover, so this closes the popover
   * immediately, same as manage/edit/add — unlike `onDisconnect`.
   */
  onDelete: (id: string) => void;
  /**
   * `⌘E` / "Manage connections". Opens the expanded
   * Connections table. Closes the popover — the two are never on screen
   * together (ADR 0001). Carries the typed search along: expanding to tell
   * "Prod — US East" and "Prod — EU West" apart is exactly the scenario a
   * user has usually just typed toward, and `close()` clears `query` on this
   * component, so the caller only gets one chance to see it.
   *
   * Also carries this instance's own trigger element, so the table can
   * return focus to the trigger that actually opened it when it closes.
   * Both variants (`title` in the TitleBar, `cta` in the Data View's empty
   * state) can be mounted at once — a selector matching "the Switcher
   * trigger" can't tell which one a keyboard user actually used.
   */
  onExpand: (query: string, trigger: HTMLElement | null) => void;
  /**
   * `'title'` (default) is the compact inline trigger docked in the
   * TitleBar. `'cta'` renders the same popover behind a full-size
   * call-to-action button; the Data View's empty state uses it so the
   * Switcher is reachable from there too (ADR 0001: "both open the
   * switcher").
   */
  variant?: 'title' | 'cta';
}

/** `⌘E` / `Ctrl+E`: open the full Connections table. */
const isExpandShortcut = (e: React.KeyboardEvent) =>
  (e.metaKey || e.ctrlKey) && (e.key === 'e' || e.key === 'E');

function ConnectionRow({
  optionId,
  conn,
  isConnected,
  isHighlighted,
  onSelect,
  onHighlight,
  onManage,
  onDisconnect,
  onEdit,
  onDelete,
}: {
  /** DOM id of this option — what `aria-activedescendant` points at. Not `conn.id`. */
  optionId: string;
  conn: ConnectionSummary;
  isConnected: boolean;
  isHighlighted: boolean;
  onSelect: (id: string) => void;
  onHighlight: () => void;
  onManage: (id: string) => void;
  /** Raw prop, not the popover-closing wrapper — matches the ⌫ shortcut's "stays open" behavior. */
  onDisconnect: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const T = themeVars;
  const presentation = STATUS_PRESENTATION[conn.status];
  const descriptionId = `${optionId}-description`;
  return (
    <div
      id={optionId}
      role="option"
      // Combobox pattern: this row is never a tab stop of its own. Focus
      // stays on the search field; the highlight roves via
      // `aria-activedescendant` (see the file header). tabIndex={-1}, not
      // 0 — 0 would add nine rows to the tab order and fight the search
      // field for the highlight. The row-action buttons rendered below
      // are real `<button>`s and keep their own tab stops regardless — an
      // ancestor's tabIndex={-1} doesn't remove descendants from the tab
      // order.
      tabIndex={-1}
      aria-label={conn.name}
      // `aria-selected` is the Connection that is *connected*, the listbox's
      // value — not the keyboard highlight. The highlight is the search
      // field's `aria-activedescendant`, so the two never fight over one
      // attribute. X16.4 — several rows can carry it at once, which is
      // what `aria-multiselectable` on the listbox announces.
      aria-selected={isConnected}
      // Host and status ride as the *description*, not folded into the name:
      // the name is the Connection's identity and shouldn't churn as a server
      // connects. Screen readers read a description straight
      // after the name, so arrowing onto a row announces both which host it
      // points at and whether it's live.
      aria-describedby={descriptionId}
      onClick={() => onSelect(conn.id)}
      // Keep the pointer and the keyboard pointing at the same row. Without
      // this, hovering row 5 and pressing ↵ acts on row 1. `onMouseMove`, not
      // `onMouseEnter`: scrolling the highlighted row into view slides rows
      // under a stationary cursor, and enter/leave would read that as intent.
      onMouseMove={isHighlighted ? undefined : onHighlight}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 10px 7px 12px',
        cursor: 'pointer',
        background: isHighlighted
          ? T.accentSoft
          : isConnected
            ? T.surfaceActive
            : 'transparent',
      }}
    >
      {/* Row-edge status band — not a third small dot. Distinct color per
          connecting / connected / error / never-tried (unknown). */}
      <div
        // `data-`, not `aria-label`: this is a role-less div, where aria-label
        // is ignored by assistive tech. It never conveyed status to anyone —
        // its only real consumer was the spec — so name it for what it is.
        // The band carries status visually; the description below carries the
        // same fact for everyone else.
        data-status={conn.status}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: presentation.band,
        }}
      />
      {/* The non-visual half of the band, plus the host that tells two
          similarly-named Connections apart. Rendered rather than
          stuffed into an attribute so it stays real text that
          `aria-describedby` can point at and that re-renders when a status
          event lands. */}
      <VisuallyHidden id={descriptionId}>
        {`${conn.host}. ${presentation.spoken}${conn.readOnly ? '. Read-only connection' : ''}`}
      </VisuallyHidden>
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: conn.color,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text
          truncate
          style={{ fontSize: 12, fontWeight: 600, color: T.text }}
        >
          {conn.name}
        </Text>
        <Text
          truncate
          style={{ fontSize: 10, color: T.textMuted, fontFamily: 'ui-monospace, monospace' }}
        >
          {conn.host}
        </Text>
      </div>
      {conn.readOnly && (
        <span
          aria-hidden
          title="Read-only connection"
          style={{ display: 'flex', color: T.textMuted, flexShrink: 0 }}
        >
          {I.lock}
        </span>
      )}
      {isConnected && (
        <span aria-label="Connected" style={{ display: 'flex', color: T.accent, flexShrink: 0 }}>
          {I.check}
        </span>
      )}
      {/*
        Row actions. Rendered only on the highlighted row (ADR
        0001: "inline icon actions on the highlighted row"), not on all nine —
        besides matching the ADR, that keeps this to at most a handful of
        extra tab stops at a time rather than one set per row. Real
        `<button>`s, so each is a tab stop on its own: `role="option"` rows
        are otherwise not (the search field owns keyboard input via
        `aria-activedescendant`, see the file header), but that contract is
        about the *row* competing with the roving highlight, not about every
        descendant, and Mantine's `Popover` doesn't focus-trap, so Tab already
        leaves the dropdown today — this adds stops before that exit, which is
        how a keyboard-only user reaches these actions without a mouse. A
        nested interactive element inside `role="option"` is outside what ARIA
        guarantees screen readers expose in the listbox's own browse mode, so
        this is a keyboard-first affordance, not a verified screen-reader one
        — narrowing that gap is follow-up work, not blocking here.

        Order — manage, disconnect, edit, delete — puts the destructive action
        last and furthest from the others, on purpose: the four sit 20px apart
        in a 300px popover, and delete is the one action here a stray click
        should not land on by proximity alone.
      */}
      {/*
        X16 §4.3 — Cancel, and the one row action that is *not* gated on
        the highlight. The highlighted-row rule (ADR 0001) exists to keep nine
        rows from carrying four actions each; it assumes the user is already
        looking at the row they mean. A connect that is hanging is the case
        where they are not: only one row can be highlighted, the state is
        transient, and the whole point of the action is that the app has locked
        up on a host the user cannot reach. Cancel is the existing
        `mongo:disconnect` for that id — no cancel channel exists.
      */}
      {conn.status === 'connecting' && (
        <RowActionIcon
          label={`Cancel connecting to ${conn.name}`}
          onClick={() => onDisconnect(conn.id)}
        >
          {I.close}
        </RowActionIcon>
      )}
      {isHighlighted && (
        <>
          <RowActionIcon label={`Manage ${conn.name}`} onClick={() => onManage(conn.id)}>
            {I.gear}
          </RowActionIcon>
          {/* Matches the ⌫ shortcut: only rows with a client to drop (the
              disconnect acceptance criterion). A connecting row already carries Cancel
              above, which is the same call under the name that fits. */}
          {presentation.live && conn.status !== 'connecting' && (
            <RowActionIcon label={`Disconnect ${conn.name}`} onClick={() => onDisconnect(conn.id)}>
              {I.plugOff}
            </RowActionIcon>
          )}
          <RowActionIcon label={`Edit ${conn.name}`} onClick={() => onEdit(conn.id)}>
            {I.edit}
          </RowActionIcon>
          <RowActionIcon label={`Delete ${conn.name}`} color="red" onClick={() => onDelete(conn.id)}>
            {I.trash}
          </RowActionIcon>
        </>
      )}
    </div>
  );
}

export function ConnectionSwitcher({
  connections,
  focusedConnectionId,
  onSwitch,
  onManage,
  onDisconnect,
  onEdit,
  onDelete,
  onExpand,
  variant = 'title',
}: ConnectionSwitcherProps) {
  const T = themeVars;
  const [opened, setOpened] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const baseId = React.useId();
  const listboxId = `${baseId}-listbox`;
  // with zero saved Connections there is nothing to search, so
  // opening focuses "Manage connections" — the way to add one — instead of
  // the search field (ADR
  // 0001's "add-mode when zero connections exist"). Read at open time via
  // `connections.length`, not a separate prop — the Switcher already knows
  // its own connection count, and this stays correct however it was opened
  // (TitleBar trigger or the empty state's `variant="cta"` one).
  const addMode = connections.length === 0;
  const optionId = (connectionId: string) => `${baseId}-opt-${connectionId}`;
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const wasOpenRef = React.useRef(false);
  const keyboardMoveRef = React.useRef(false);

  const focusedConnection = connections.find((c) => c.id === focusedConnectionId) ?? null;
  // the title trigger's status ring + accessible-name suffix. `null`
  // when no tab is open: there is no Connection to show or announce.
  const focusedPresentation = focusedConnection
    ? STATUS_PRESENTATION[focusedConnection.status]
    : null;

  const filtered = React.useMemo(
    () => connections.filter((c) => matchesConnectionQuery(c, query)),
    [connections, query],
  );

  // `useRovingHighlight` clamps at render — `connections` can shrink under a
  // standing highlight (a delete elsewhere in the app, a list refresh), so the
  // highlight always names a row that is currently on screen, and ↵ can never
  // act on a Connection the user can no longer see.
  const { index: highlight, setIndex: setHighlightIndex, move: moveHighlight } =
    useRovingHighlight(filtered.length);
  const highlighted = filtered[highlight] ?? null;
  const highlightedId = highlighted ? optionId(highlighted.id) : undefined;

  // Keep the highlighted row in view when ↑/↓ walk past the scroll edge.
  // Keyboard moves only: the pointer moves the highlight too, and scrolling
  // the list under a cursor that is already on the row it picked would shift
  // the user's aim mid-gesture.
  //
  // The flag is set by the arrow keys and cleared by the pointer, never by
  // this effect. Clearing it here would leave it stuck on whenever an arrow
  // press doesn't change the highlighted id — ↓ on a single-row list wraps
  // onto itself — and the next pointer move would inherit the stale `true`
  // and scroll after all.
  React.useEffect(() => {
    if (!opened || !highlightedId || !keyboardMoveRef.current) return;
    document.getElementById(highlightedId)?.scrollIntoView({ block: 'nearest' });
  }, [opened, highlightedId]);

  // Hand focus back to the trigger when the popover closes, so a keyboard user
  // lands back on the control they opened instead of at <body> — the top of
  // the Data View's tab order, several tab stops from where they were.
  //
  // Not Mantine's `returnFocus`, which saves its return target in a passive
  // effect after open: the search field's `autoFocus` can win that race, and
  // in the component suite (no transitions) it does — Mantine saves the search
  // field and Escape lands on <body>. `FieldsControl` & co. can use the prop
  // because nothing in their dropdowns autofocuses.
  //
  // Deferred rather than checked in the effect body: a click on a
  // non-focusable area closes the popover on mousedown, and Chromium's own
  // mousedown default action blurs to <body> only *after* that — a synchronous
  // check sees focus still in the dropdown and misses it (#79).
  React.useEffect(() => {
    if (opened) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    const activeElementAtClose = document.activeElement;
    const timeout = window.setTimeout(() => {
      // Only reclaim focus nobody else has taken: a click on another control
      // elsewhere in the Data View keeps focus there. Focus still where it was
      // at close is ours too — after ↵ selects a row it is still on the search
      // field, and the dropdown takes it down to <body> when its exit
      // transition unmounts it (`conn-switcher-keyboard.e2e.ts`).
      //
      // A surface opened by the same gesture (the Edit modal, the table) is
      // left alone only because Mantine's `FocusTrap` claims focus on a 0ms
      // timer, ahead of this 10ms one. A surface that took focus later than
      // 10ms would lose it back to the trigger.
      const current = document.activeElement;
      if (current === document.body || current === activeElementAtClose) {
        triggerRef.current?.focus();
      }
    }, 10);
    return () => window.clearTimeout(timeout);
  }, [opened]);

  // Clearing on *close* rather than only on select is what makes reopening
  // safe. `query` and `highlightIndex` live on this component, which stays
  // mounted while only the dropdown unmounts, so a filter typed and then
  // dismissed (Escape, outside click, second click on the trigger) would
  // otherwise still be applied the next time the popover opens — showing a
  // filtered list, or the "no matches" empty state, to a user who thinks they
  // are looking at all their Connections. The highlight is the same story one
  // step on: reopening must start at the top of the list, not wherever the
  // last walk stopped.
  const close = () => {
    setOpened(false);
    setQuery('');
    setHighlightIndex(0);
  };

  const handleSelect = (id: string) => {
    close();
    onSwitch(id);
  };

  const handleManage = (id: string) => {
    close();
    onManage(id);
  };

  const handleEdit = (id: string) => {
    close();
    onEdit(id);
  };

  const handleDelete = (id: string) => {
    close();
    onDelete(id);
  };

  const handleExpand = () => {
    // `close()` schedules `setQuery('')` — a state update, not a mutation —
    // so this closure's own `query` binding still holds what was typed until
    // the next render. Passing it as an argument here, rather than letting
    // `onExpand` read it back off this component, is what carries it across
    // that reset at all.
    close();
    onExpand(query, triggerRef.current);
  };

  /**
   * The keyboard contract — see the contract block at the top of the file.
   *
   * Two separate decisions per key, deliberately not collapsed into one:
   *
   * `stopPropagation` says "this key belongs to the Switcher while it is
   * open". That has to hold even when there is nothing to act on — the
   * Data View's window listeners sit behind this popover, `AggregationTab`
   * binds ⌘↵ there and never checks `defaultPrevented`, and a search that
   * matched nothing is exactly when a stray ⌘↵ would run the pipeline
   * underneath a popover showing "no matches".
   *
   * `preventDefault` says "we handled it instead of the browser", and is only
   * right when we really did.
   */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.stopPropagation();
        if (!highlighted) return;
        e.preventDefault();
        keyboardMoveRef.current = true;
        // One expression for both directions, so "wraps at both ends" has a
        // single boundary to get right rather than two mirrored ones.
        moveHighlight(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      case 'Enter': {
        // Mid-composition, Enter belongs to the IME: it commits the candidate
        // the user is building. Taking it would connect to whatever row is
        // highlighted and throw the half-typed name away — so anyone naming a
        // Connection in Japanese, Chinese or Korean could not search at all.
        // The renderer is always modern Chromium, so `isComposing` is enough;
        // no `keyCode === 229` fallback is needed here.
        if (e.nativeEvent.isComposing) return;
        e.stopPropagation();
        if (!highlighted) return;
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) handleManage(highlighted.id);
        else handleSelect(highlighted.id);
        return;
      }
      case 'Backspace': {
        // Only on an empty search — otherwise ⌫ is ordinary text editing, and
        // stealing it would make the search field unusable.
        if (query !== '') return;
        e.stopPropagation();
        // Only rows with a client to drop. ⌫ acts on the *highlighted* row,
        // which on open is row 1 — not whatever the user was looking at — and
        // it is one keystroke with no prompt. Restricting it to live rows is
        // what keeps a reflexive "clear the field" ⌫ from silently killing a
        // production client the user never selected. Idle rows already had
        // nothing to disconnect, so nothing is lost. (Matches the prototype,
        // ADR 0001.)
        if (!highlighted || !STATUS_PRESENTATION[highlighted.status].live) return;
        e.preventDefault();
        // Stays open on purpose: the row's status band is the feedback the
        // user came for, and dropping one client is often not the last thing
        // they want to do here.
        onDisconnect(highlighted.id);
        return;
      }
      case 'e':
      case 'E': {
        // No modifier: ordinary text entry into the search field, same as
        // every other letter — must fall through untouched.
        if (!isExpandShortcut(e)) return;
        e.stopPropagation();
        e.preventDefault();
        handleExpand();
        return;
      }
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (next) setOpened(true);
    else close();
  };

  /**
   * Recovers focus when a row action button disappears out from under it.
   * The whole cluster is gated on `isHighlighted` (a row's actions render
   * only while it's the highlighted one), so a button holding focus vanishes
   * whenever the highlight moves off its row — and that can happen two ways:
   * the mouse moving over a different row while this one is Tab-focused, or
   * (disconnect specifically) a status event repainting this row to
   * non-live after a click, since disconnect is the one action that doesn't
   * close the popover first. Either way, with nothing else to claim it, focus
   * drops to `<body>` — and since `handleKeyDown` lives on this dropdown,
   * every keyboard path into the still-open popover, Escape included, goes
   * dead until the user clicks out or reopens it.
   *
   * Polling `document.activeElement` after the renders that can cause this
   * — rather than reacting to a native blur/focusout event — covers both
   * triggers with one check and needs no listener wired to whichever button
   * happens to be involved. `document.body` (not merely "focus left this
   * button") is what keeps this from fighting a deliberate Tab-out: Mantine's
   * `Popover` doesn't focus-trap (see the row-actions comment above), so
   * Tab-ing past the last button hands focus to a real next element
   * elsewhere on the page — never to `<body>`. Only an involuntary loss
   * lands there.
   */
  React.useLayoutEffect(() => {
    if (!opened) return;
    if (document.activeElement === document.body) searchRef.current?.focus();
  }, [opened, connections, highlight]);

  return (
    <Popover
      opened={opened}
      onChange={handleOpenChange}
      position="bottom-start"
      shadow="md"
      withinPortal
      width={300}
    >
      <Popover.Target>
        {variant === 'cta' ? (
          // the Data View's empty-state trigger (ADR 0001: "the
          // Switcher [is reachable] from both the empty state and the
          // TitleBar"). Same popover, same handlers as the title variant —
          // only the button chrome differs, so the two entry points can never
          // disagree about what opening "the Switcher" means.
          //
          // The caller only ever mounts this variant inside the empty state,
          // which itself only renders when no tab is open and nothing is
          // connected — so unlike the title variant, there is no
          // "Connection: <name>" case to announce here. A fixed name (rather
          // than deriving one from `focusedConnection`, which would collide
          // with the title variant's own accessible name whenever both are on
          // screen) is what lets a query for either trigger resolve to
          // exactly one match.
          <Button
            ref={triggerRef}
            variant="light"
            size="sm"
            aria-label="Select a connection"
            onClick={() => handleOpenChange(!opened)}
            rightSection={
              <span aria-hidden style={{ display: 'flex' }}>
                {I.chevD}
              </span>
            }
          >
            Select a connection
          </Button>
        ) : (
          <Button
            ref={triggerRef}
            variant="default"
            size="compact-xs"
            // Without this the accessible name is bare user data — a screen
            // reader announces "Prod, button" with no hint that it opens a
            // Connection picker, and with nothing selected it announces just
            // "none selected". The Focused Tab's Connection stays in the
            // name because it is this control's value, the way a combobox
            // announces its selection. The status sentence is folded in here
            // rather than left to a visually-hidden child: once `aria-label`
            // is set, an element's accessible name comes from that attribute
            // alone — assistive tech never falls back to reading its content
            // — so status has to ride the label itself to reach anyone who
            // can't see the ring. Still starts with "Connection: <name>", so
            // the `/^Connection:/` and `Connection: ${name}` e2e locators
            // (Playwright's string match is "contains", not "equals") match
            // unchanged.
            aria-label={
              focusedConnection
                ? `Connection: ${focusedConnection.name}. ${focusedPresentation!.spoken}${
                    focusedConnection.readOnly ? '. Read-only connection' : ''
                  }`
                : 'Connection: none selected'
            }
            onClick={() => handleOpenChange(!opened)}
            leftSection={
              focusedConnection ? (
                <span
                  aria-hidden
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: '50%',
                    background: focusedConnection.color,
                    // Status rides the ring, not a second dot — same
                    // reasoning as the row-edge band: one dot per row,
                    // status is its halo.
                    boxShadow: `0 0 0 2px color-mix(in srgb, ${focusedPresentation!.band} 30%, transparent)`,
                  }}
                />
              ) : undefined
            }
            rightSection={
              <span aria-hidden style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {focusedConnection?.readOnly && (
                  <span title="Read-only connection" style={{ display: 'flex', color: T.textMuted }}>
                    {I.lock}
                  </span>
                )}
                {I.chevD}
              </span>
            }
            styles={{ label: { fontWeight: focusedConnection ? 600 : 500 } }}
          >
            {/* ADR 0001's "Select a connection ▾" copy, replacing the
                bare em dash: this is the TitleBar's "no Connection active"
                trigger the acceptance criteria asks for, not new wiring. */}
            {focusedConnection?.name ?? 'Select a connection'}
          </Button>
        )}
      </Popover.Target>
      <Popover.Dropdown p={0} onKeyDown={handleKeyDown}>
        <div style={{ padding: 8, borderBottom: `1px solid ${T.border}` }}>
          <TextInput
            ref={searchRef}
            autoFocus={!addMode}
            size="xs"
            aria-label="Search connections"
            placeholder="Search connections…"
            // Focus never leaves this field; the highlight roves through the
            // listbox by id. The full combobox pattern, not just
            // `aria-activedescendant`: ARIA permits activedescendant on a bare
            // textbox, but NVDA and JAWS generally only announce the moves on
            // a `combobox`, so without the role the roving highlight is silent
            // for exactly the people it exists to serve.
            //
            // `aria-expanded` is always true because this input only exists
            // while the dropdown is mounted — the combobox and its popup are
            // born and die together, the same shape as a command palette.
            role="combobox"
            aria-expanded
            aria-haspopup="listbox"
            aria-controls={listboxId}
            aria-activedescendant={highlightedId}
            leftSection={I.search}
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              // A new search is a new list — start it from the top.
              setHighlightIndex(0);
            }}
          />
        </div>
        {/*
          "Manage connections". Pinned above the listbox, not filtered by
          `query` and not part of the roving highlight: a search that matches
          nothing must still lead somewhere a Connection can be created, and
          folding it into the arrow-key contract would mean rewriting
          `handleKeyDown`'s wrap-at-both-ends math to special-case a
          non-Connection row. A plain tab-reachable button costs neither.
          `onKeyDown` stopPropagation is load-bearing, not defensive: this
          button sits inside `Popover.Dropdown`, whose own `onKeyDown` is
          `handleKeyDown` below — without stopping it here, Tab-ing to this
          button and pressing Enter would hit `handleKeyDown`'s Enter case
          instead of this button's click, switching to whatever row is
          highlighted (and closing its tabs) rather than opening the table.
          ⌘E is let through: this button is where focus lands with zero
          Connections, and the legend promises ⌘E works anywhere in here.
        */}
        <Button
          variant="subtle"
          size="compact-xs"
          h={36}
          autoFocus={addMode}
          onClick={handleExpand}
          onKeyDown={(e) => {
            if (!isExpandShortcut(e)) e.stopPropagation();
          }}
          leftSection={
            <span aria-hidden style={{ display: 'flex' }}>
              {I.expand}
            </span>
          }
          fullWidth
          justify="flex-start"
          style={{ borderRadius: 0, borderBottom: `1px solid ${T.border}` }}
        >
          Manage connections
        </Button>
        <div
          id={listboxId}
          role="listbox"
          aria-label="Connections"
          // X16.4 — the marked rows are every *connected* Connection,
          // and there can be several.
          aria-multiselectable
          style={{ maxHeight: 340, overflowY: 'auto' }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: '18px 12px', fontSize: 12, color: T.textMuted, textAlign: 'center' }}>
              {/*
                `filtered` is empty both when a search matched nothing and when
                there is nothing to search. Only the first case should name the
                query — otherwise a first-run user with no saved Connections is
                told `No connections match ""`.
              */}
              {connections.length === 0
                ? 'No connections yet'
                : <>No connections match &quot;{query}&quot;</>}
            </div>
          ) : (
            filtered.map((c, i) => (
              <ConnectionRow
                key={c.id}
                optionId={optionId(c.id)}
                conn={c}
                isConnected={c.status === 'connected'}
                isHighlighted={i === highlight}
                onSelect={handleSelect}
                onManage={handleManage}
                onDisconnect={onDisconnect}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onHighlight={() => {
                  keyboardMoveRef.current = false;
                  setHighlightIndex(i);
                }}
              />
            ))
          )}
        </div>
        {/*
          The footer is how the keyboard path is learned from the mouse path:
          a user who only ever clicks still reads it every time they open the
          Switcher. It stays in the accessibility tree — hiding keyboard help
          from the users most likely to want it would be backwards — but named,
          so it reads as a shortcut legend rather than loose strings trailing
          the list.
        */}
        {/* Three entries, not six: the rest are taught by the row action
            tooltips and the expanded table, not by rote memorization here. */}
        <Group
          gap={8}
          px={10}
          py={7}
          role="note"
          aria-label="Keyboard shortcuts"
          style={{ borderTop: `1px solid ${T.border}`, background: T.surfaceRaised }}
        >
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}><Kbd>↑↓</Kbd> navigate</Text>
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}><Kbd>{formatShortcut('↵', isMacRenderer())}</Kbd> connect</Text>
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}><Kbd>{formatShortcut('⌘E', isMacRenderer())}</Kbd> manage</Text>
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
}
