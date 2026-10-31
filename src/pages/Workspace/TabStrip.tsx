import React from 'react';
import { ActionIcon, Tooltip, UnstyledButton } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { I } from '../../icons';
import { ContextMenu } from '../../components/ContextMenu';
import type { ConnectionSummary, WorkspaceTab } from '@shared/types';
import { groupTabsByConnection } from './tabGroups';
import { isDormant } from '../../state/connections';
import { isContextMenuKey, anchorFromRect } from '../../utils/contextMenuKey';

interface TabStripProps {
  tabs: WorkspaceTab[];
  /** Every saved Connection, for the group chips. Tabs of a Connection that
   *  isn't in this list still render — the list loads asynchronously. */
  connections: ConnectionSummary[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onOpenNewScript: () => void;
  onTogglePin: (id: string) => void;
  /** Close `ids` as one action (Close others / Close to the right); `keepId` is the tab the menu was opened on. */
  onCloseMany: (ids: string[], keepId: string) => void;
  /** Show this collection tab's row in the navigator. */
  onReveal: (id: string) => void;
}

/** A tab's read-only marker (spec §4.4). The group chip has carried one
 *  for longer, but the strip scrolls: the chip can sit off-screen while the tab
 *  you are looking at — the one that says which query is about to run — does
 *  not. Same visual language as the chip's, deliberately. */
function ReadOnlyBadge() {
  return (
    <Tooltip label="Read-only connection" withArrow>
      <span
        aria-label="Read-only"
        style={{
          fontSize: 9,
          color: themeVars.warnText,
          border: `1px solid ${themeVars.warnBorder}`,
          background: themeVars.warnSoft,
          borderRadius: 3,
          padding: '0 3px',
        }}
      >
        RO
      </span>
    </Tooltip>
  );
}

export function TabStrip({
  tabs,
  connections,
  activeId,
  onActivate,
  onClose,
  onReorder,
  onOpenNewScript,
  onTogglePin,
  onCloseMany,
  onReveal,
}: TabStripProps) {
  const T = themeVars;
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [dragOverId, setDragOverId] = React.useState<string | null>(null);
  const [menu, setMenu] = React.useState<{
    tabId: string;
    x: number;
    y: number;
    // #55/#69 — set for both a keyboard open (Shift+F10 / ContextMenu key)
    // and a mouse-driven right-click, so `ContextMenu` always has somewhere
    // to hand focus back to on close instead of stranding it on `<body>`.
    returnFocusTo?: HTMLElement | null;
  } | null>(null);
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(() => new Set());
  const stripRef = React.useRef<HTMLDivElement>(null);

  // The strip never overflows vertically, so a plain vertical wheel/trackpad
  // gesture over it should scroll it sideways like a horizontal-only strip —
  // native `overflow-x: auto` only responds to deltaX. React's synthetic
  // wheel listener is passive, so preventDefault() there just warns; attach
  // a real, non-passive listener instead.
  React.useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || e.deltaY === 0) return;
      // preventDefault() cancels the browser's native scroll for the whole
      // event, not just the vertical part, so a diagonal gesture's deltaX
      // must be applied here too or it's silently dropped.
      el.scrollLeft += e.deltaY + e.deltaX;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const toggleGroupCollapsed = (connectionId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(connectionId)) next.delete(connectionId);
      else next.add(connectionId);
      return next;
    });
  };

  /** A tab's Connection is a property of the tab; dragging is not how you
   *  would change it. So a drop across groups is refused (X16 §4.4). */
  const sameGroup = (aId: string | null, bId: string) => {
    const a = tabs.find((t) => t.id === aId);
    const b = tabs.find((t) => t.id === bId);
    return !!a && !!b && a.connectionId === b.connectionId;
  };

  const handleDrop = (targetId: string) => {
    const source = tabs.find((t) => t.id === dragId);
    const target = tabs.find((t) => t.id === targetId);
    setDragId(null);
    setDragOverId(null);
    if (!source || !target || source === target) return;
    if (source.connectionId !== target.connectionId) return;

    // Permute inside the group (on-screen, pinned-first order — that's what
    // the person dragged), then write the group back into the slots it
    // occupies in *raw-position* order, not the pinned-sorted `tabs` prop.
    // `tabs` floats every pinned tab — of any Connection — ahead of every
    // unpinned one, so writing the final id list off `tabs` itself would
    // hand `reorder()` a pinned-first order and it renumbers `position`
    // sequentially in exactly the order it receives. That would put every
    // pinned tab's `position` ahead of every unpinned tab's, globally, and
    // `groupTabsByConnection` reads raw `position` to decide group order
    // (that grouping's own invariant) — so group order would break the moment
    // anyone drags within a group after anything anywhere is pinned.
    // `position` is untouched by pinning (`setPinned` only flips the
    // `pinned` column; `reorder()` is the only writer of `position`, and it
    // only runs from here), so sorting `tabs` by raw `position` recovers the
    // order every tab outside the dragged group must keep.
    const group = tabs
      .filter((t) => t.connectionId === source.connectionId)
      .map((t) => t.id);
    const from = group.indexOf(source.id);
    const to = group.indexOf(target.id);
    group.splice(from, 1);
    group.splice(to, 0, source.id);

    const byPosition = [...tabs].sort((a, b) => a.position - b.position);
    let next = 0;
    onReorder(
      byPosition.map((t) =>
        t.connectionId === source.connectionId ? group[next++] : t.id,
      ),
    );
  };

  const menuTab = menu ? tabs.find((t) => t.id === menu.tabId) : null;

  const groups = React.useMemo(
    () =>
      groupTabsByConnection(tabs).map((group) => ({
        ...group,
        connection: connections.find((c) => c.id === group.connectionId) ?? null,
      })),
    [tabs, connections],
  );

  // Bulk closes read the strip's on-screen (grouped) order, never the stored
  // one, and leave pinned tabs alone. A collapsed group's tabs are not on
  // screen, so they are not closed either.
  const bulkTargets = React.useMemo(() => {
    if (!menuTab) return { others: [], right: [] };
    const onScreen = groups
      .filter((g) => g.connectionId === menuTab.connectionId || !collapsedGroups.has(g.connectionId))
      .flatMap((g) => g.tabs);
    const at = onScreen.findIndex((t) => t.id === menuTab.id);
    const closable = (t: WorkspaceTab) => t.id !== menuTab.id && !t.pinned;
    return {
      others: onScreen.filter(closable).map((t) => t.id),
      right: onScreen.slice(at + 1).filter(closable).map((t) => t.id),
    };
  }, [groups, menuTab, collapsedGroups]);

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label="Open tabs"
      data-hint-anchor="startup.restore"
      // -1: a keyboard-menu close (see the `returnFocusTo` comment below)
      // needs this container to be a valid `.focus()` target, but it is not
      // itself a roving-tabindex stop — the tabs are.
      tabIndex={-1}
      style={{
        height: 34,
        display: 'flex',
        alignItems: 'stretch',
        borderBottom: `1px solid ${T.border}`,
        background: T.surface,
        flexShrink: 0,
        paddingLeft: 8,
        overflowX: 'auto',
      }}
    >
      {groups.map(({ connectionId, connection, tabs: groupTabs }) => {
        // Not a name: a Connection missing from the list is unresolved (it
        // loads asynchronously, and the window before it resolves is
        // deliberate), and a plausible-looking label would be
        // indistinguishable from a real Connection. The parenthetical says
        // "state", like '(empty)' below.
        const name = connection?.name ?? '(unresolved connection)';
        const readOnly = connection?.readOnly ?? false;
        // X16.5, spec §4.4 — a *Dormant* Connection's tabs stay muted but
        // clickable (never disabled). Strictly Dormant: Connecting and
        // Failed are separate states that carry their own signals on the
        // navigator root, so muting them like this would erase the difference.
        // `isDormant` also reads `false` while `connection` is still
        // unresolved: an unresolved tab must not flash muted before its
        // Connection has even loaded.
        const dormant = isDormant(connection);
        const collapsed = collapsedGroups.has(connectionId);
        const groupActive = groupTabs.some((t) => t.id === activeId);
        const groupColor = connection?.color ?? T.border;
        return (
          <div
            key={connectionId}
            role="group"
            aria-label={readOnly ? `${name} (read-only)` : name}
            style={{
              display: 'flex',
              alignItems: 'stretch',
              // The divider between groups.
              borderRight: `2px solid ${T.borderMed}`,
              marginRight: 8,
            }}
          >
            {/* The Tab Group header: the name is the identity, the filled colour
                is the second cue — two Connections can share a palette
                family. One button, so a click anywhere on it toggles the
                group. Lit when the group holds the Focused Tab. */}
            <button
              type="button"
              onClick={() => toggleGroupCollapsed(connectionId)}
              aria-expanded={!collapsed}
              // The visible Connection name is the accessible name (Label in Name);
              // `aria-expanded` carries the state.
              aria-label={name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 10px',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                border: 'none',
                // Solid text on both fills: muted text on the tint fell under 4.5:1.
                color: T.text,
                background: `color-mix(in srgb, ${groupColor} ${groupActive ? 55 : 22}%, ${T.bg})`,
                borderLeft: `3px solid ${connection?.color ?? T.border}`,
                transition: 'background 120ms',
              }}
            >
              <span
                aria-hidden
                style={{
                  display: 'inline-flex',
                  fontSize: 10,
                  transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                  transition: 'transform 120ms',
                }}
              >
                {I.chevD}
              </span>
              <span>{name}</span>
              {readOnly && <ReadOnlyBadge />}
            </button>
            {!collapsed && groupTabs.map((tab) => {
              const active = tab.id === activeId;
              const over =
                dragOverId === tab.id && dragId !== tab.id && sameGroup(dragId, tab.id);
              const label =
                tab.kind === 'script'
                  ? tab.state.title || 'Script'
                  : tab.collection || '(empty)';
              const closeLabel = `Close ${
                tab.kind === 'script'
                  ? tab.state.title || 'script'
                  : tab.collection || 'tab'
              }`;
              return (
                <div
                  key={tab.id}
                  data-tab-id={tab.id}
                  data-hint-anchor={active ? 'tabs.pin' : undefined}
                  // e2e-reliable signal for "Dormant" — the inline muted
                  // style alone is too fragile for Playwright to assert on.
                  data-dormant={dormant || undefined}
                  draggable
                  onDragStart={() => setDragId(tab.id)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverId(tab.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setDragOverId(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDrop(tab.id);
                  }}
                  onClick={() => onActivate(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onActivate(tab.id);
                    } else if (isContextMenuKey(e)) {
                      // #55 — the tab is already the widget's own focusable
                      // element (unlike the grid/tree surfaces), so it is
                      // both the anchor and the default focus-return target —
                      // right for Pin/Unpin and for Escape/click-outside,
                      // which leave this exact tab in place. Close tab is the
                      // one item that destroys it; see its own
                      // `focusReturnTo` override below.
                      e.preventDefault();
                      setMenu({
                        tabId: tab.id,
                        ...anchorFromRect(e.currentTarget.getBoundingClientRect()),
                        returnFocusTo: e.currentTarget,
                      });
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    // #69 — same target the keyboard path above uses: the
                    // tab is right-clicked while it already has (or is) the
                    // sensible focus-return element, so Escape/click-away no
                    // longer strands focus on `<body>` after a right-click.
                    setMenu({
                      tabId: tab.id,
                      x: e.clientX,
                      y: e.clientY,
                      returnFocusTo: e.currentTarget,
                    });
                  }}
                  role="tab"
                  aria-selected={active}
                  // The Connection is in the name too: a tab that only says
                  // "orders" does not tell a screen-reader user which server
                  // the query would run against.
                  aria-label={
                    readOnly ? `${label} — ${name} (read-only)` : `${label} — ${name}`
                  }
                  tabIndex={active ? 0 : -1}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '0 12px',
                    fontSize: 12,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    background: active ? T.surfaceRaised : 'transparent',
                    // Dormant wins over the active highlight's full-contrast
                    // text: the tab you're looking at can be the one whose
                    // Connection just dropped, and that pane is about to show
                    // the not-connected state, not the grid the color would
                    // otherwise imply is current.
                    color: dormant ? T.textGhost : active ? T.text : T.textMuted,
                    borderRight: `1px solid ${T.border}`,
                    // Connection colour on every tab, dim until it is the
                    // Focused Tab.
                    borderBottom: active
                      ? `2px solid ${connection?.color ?? T.accent}`
                      : over
                        ? `2px solid ${T.accentBorder}`
                        : `2px solid color-mix(in srgb, ${groupColor} 35%, transparent)`,
                    opacity: dragId === tab.id ? 0.6 : dormant ? 0.6 : 1,
                  }}
                >
                  {tab.pinned && (
                    <Tooltip label="Pinned" withArrow>
                      <span
                        style={{ fontSize: 9, color: T.accent, lineHeight: 1 }}
                        aria-label="Pinned"
                      >
                        ●
                      </span>
                    </Tooltip>
                  )}
                  {tab.kind === 'script' && <span style={{ fontSize: 11 }}>⌥</span>}
                  <span>{label}</span>
                  {readOnly && <ReadOnlyBadge />}
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(tab.id);
                    }}
                    onKeyDown={(e) => {
                      // Enter/Space already fire onClick on a <button>; stop
                      // propagation so the parent tab's keydown handler doesn't
                      // re-activate the tab we're about to close.
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                      }
                    }}
                    aria-label={closeLabel}
                  >
                    {I.close}
                  </ActionIcon>
                </div>
              );
            })}
          </div>
        );
      })}
      <Tooltip label="New script tab" withArrow>
        <UnstyledButton
          onClick={onOpenNewScript}
          aria-label="New script tab"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            padding: '0 10px',
            color: T.textMuted,
            fontSize: 11,
          }}
        >
          + Script
        </UnstyledButton>
      </Tooltip>

      {menu && menuTab && (
        <ContextMenu
          menu={{
            x: menu.x,
            y: menu.y,
            returnFocusTo: menu.returnFocusTo,
            items: [
              {
                kind: 'item',
                label: menuTab.pinned ? 'Unpin tab' : 'Pin tab',
                onClick: () => onTogglePin(menu.tabId),
              },
              {
                kind: 'item',
                label: 'Close tab',
                onClick: () => onClose(menu.tabId),
                // #70 — overrides `menu.returnFocusTo` (the tab itself):
                // Close destroys that exact DOM node, once `tabs.close`
                // resolves and the tab unmounts, so focusing it is a silent
                // no-op and focus drops to <body>. The strip container is
                // the one thing that survives — for the tab that closed,
                // the last tab, and the only tab alike. A thunk (not
                // `stripRef.current` directly) — see `focusReturnTo`'s own
                // docstring for why a bare ref read here is refused at lint.
                focusReturnTo: () => stripRef.current,
              },
              {
                kind: 'item',
                label: 'Close others',
                onClick: () => onCloseMany(bulkTargets.others, menu.tabId),
                disabled: bulkTargets.others.length === 0,
                disabledTitle: 'No other unpinned tabs',
              },
              {
                kind: 'item',
                label: 'Close to the right',
                onClick: () => onCloseMany(bulkTargets.right, menu.tabId),
                disabled: bulkTargets.right.length === 0,
                disabledTitle: 'No unpinned tabs to the right',
              },
              ...(menuTab.kind === 'collection'
                ? [
                    {
                      kind: 'item' as const,
                      label: 'Reveal in sidebar',
                      onClick: () => onReveal(menu.tabId),
                    },
                  ]
                : []),
            ],
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
