import React from 'react';
import { themeVars } from '../../theme/themeVars';
import { useRovingHighlight } from '../../hooks/useRovingHighlight';
import { useHints } from '../../hints/HintsContext';
import { HINT_REGISTRY } from '../../hints/registry';
import { CLASS_BADGE, findOperatorDocs } from './operators';
import { OperatorDocPanel } from './OperatorDocPanel';
import { groupOperatorRows } from './operatorGroups';
import { OPERATOR_PANEL_SIZE, placeFloatingPanel } from './placement';
import type { Suggestion } from './types';

function labelFor(s: Suggestion): string {
  if (s.kind === 'field') return s.path;
  if (s.kind === 'operator') return s.name;
  return s.display;
}

/**
 * The symbol and English name for an operator row (ADR 0004), as one string:
 * `> greater than`, or just `is one of` where the operator has no symbol.
 *
 * Only the query operators carry these, so a stage row is unchanged.
 */
function nameFor(s: Suggestion): string {
  if (s.kind !== 'operator' || !s.label) return '';
  return s.symbol ? `${s.symbol} ${s.label}` : s.label;
}

function badgeFor(s: Suggestion): string {
  if (s.kind === 'field') return s.type ?? '';
  if (s.kind === 'operator') return CLASS_BADGE[s.class] ?? s.class;
  return s.type ?? '';
}

interface Props {
  items: Suggestion[];
  anchorRef: React.RefObject<HTMLElement | null>;
  /**
   * Element that receives keyboard navigation (arrows/Enter/Tab/Escape).
   * Defaults to `anchorRef`. Set separately when the anchor is a zero-size
   * position marker and the focusable input is elsewhere (e.g., a textarea).
   */
  keyboardRef?: React.RefObject<HTMLElement | null>;
  onSelect: (s: Suggestion) => void;
  onClose: () => void;
  /** When false, the component renders nothing. */
  open: boolean;
  /** #130 — the listbox's accessible name; the builder's operator box passes its own. */
  label?: string;
  /**
   * Lay operator rows out under a header per operator class (Comparison,
   * Logical, ...). Opt-in: the caller decides when grouping makes sense, which
   * is only while the list is the unfiltered catalog. A typed token ranks the
   * list by relevance, and headers over a relevance order would mislead.
   * Highlight, Enter and ARIA selection stay flat across the groups.
   */
  groupOperators?: boolean;
}

const KEYBOARD_HINT = HINT_REGISTRY['suggestions.keyboard'];

export function SuggestionPopover({
  items,
  anchorRef,
  keyboardRef,
  onSelect: onSelectProp,
  onClose,
  open,
  label = 'Field suggestions',
  groupOperators = false,
}: Props) {
  const T = themeVars;
  // A footer line, not a floating hint: `useFeatureHint` would compete for
  // the one floating slot, and this hint belongs inside the list it explains.
  // Gone for good after the first pick, back after Settings → Reset hints.
  const hints = useHints();
  const showKeyboardHint = hints.loaded && !hints.isDismissed('suggestions.keyboard');
  const { dismiss: dismissHint } = hints;
  const onSelect = React.useCallback(
    (s: Suggestion) => {
      if (showKeyboardHint) dismissHint('suggestions.keyboard');
      onSelectProp(s);
    },
    [showKeyboardHint, dismissHint, onSelectProp],
  );
  const { index: highlight, setIndex: setHighlight, move: moveHighlight } =
    useRovingHighlight(items.length);
  const [pos, setPos] = React.useState<{ top: number; left: number; width: number } | null>(null);
  const [panelPos, setPanelPos] = React.useState<{ top: number; left: number } | null>(null);
  const listboxRef = React.useRef<HTMLDivElement>(null);
  const panelId = React.useId();
  const groupIdBase = React.useId();
  const groups = React.useMemo(
    () => (groupOperators ? groupOperatorRows(items) : []),
    [groupOperators, items],
  );

  // Whether the user has actually walked the list with the arrow keys.
  //
  // The highlight starts at 0 so there's always something to show, but an
  // auto-highlight the user never asked for must not swallow Enter: WAI-ARIA's
  // combobox pattern (`aria-autocomplete="list"`) has Enter commit the typed
  // text unless an option is *actively* selected. Without this, typing a
  // complete `{ name: 1 }` into the projection input and pressing Enter
  // committed `{ name: 1 }_id` — the popover took the key first and pasted
  // whatever happened to rank first. Tab is deliberately still unconditional:
  // it means "complete this", and there's nothing else it could mean here.
  //
  // Reset on close and on every new `items` identity — `useSuggestions`
  // rebuilds the list when the token changes, so typing another character
  // stands the user's selection down along with the ranking it was made in.
  // Adjusted during render rather than in an effect (React's "adjust state
  // when a prop changes"), the same shape `QueryBar`'s `advancedSync` uses:
  // an effect would let one keystroke's stale `engaged` reach a keydown.
  const [engaged, setEngaged] = React.useState(false);
  const [engagedFor, setEngagedFor] = React.useState({ items, open });
  if (engagedFor.items !== items || engagedFor.open !== open) {
    setEngagedFor({ items, open });
    if (engaged) setEngaged(false);
  }

  // Position below the anchor on open / resize.
  React.useEffect(() => {
    if (!open) return;
    const el = anchorRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setPos({ top: r.bottom + 2, left: r.left, width: Math.max(r.width, 180) });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorRef]);

  // Whether the list is on screen — the render below returns null otherwise.
  const shown = open && items.length > 0 && pos !== null;

  // Escape belongs to the innermost thing showing. Mantine's Modal and Drawer
  // close on a capture-phase window listener that runs before this input's
  // own handler and skips any target carrying this attribute, so it is set
  // exactly while the list is on screen. (A Mantine Popover's capture-phase
  // Escape ignores the attribute; a popover hosting one of these inputs has
  // to close on bubble-phase Escape and honour `defaultPrevented` instead —
  // see `FieldsControl`.) A layout effect, not a passive one: the attribute
  // must land in the same commit as the list, or an Escape pressed before the
  // passive flush reaches the Modal and discards the draft.
  React.useLayoutEffect(() => {
    const el = (keyboardRef ?? anchorRef).current;
    if (!el || !shown) return;
    el.setAttribute('data-mantine-stop-propagation', 'true');
    return () => el.removeAttribute('data-mantine-stop-propagation');
  }, [shown, anchorRef, keyboardRef]);

  // Keyboard navigation bound to the anchor element so focus can stay on the input.
  // A layout effect for the same reason as the attribute above: a passive
  // one can trail the commit, and a key pressed in that gap reads the list
  // the screen no longer shows. An Escape right after the list hides is then
  // claimed for an invisible list, and the enclosing control stays open.
  React.useLayoutEffect(() => {
    if (!open) return;
    const el = (keyboardRef ?? anchorRef).current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (!open) return;
      if (items.length === 0 && e.key !== 'Escape') return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setEngaged(true);
        moveHighlight(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setEngaged(true);
        moveHighlight(-1);
      } else if (
        e.key === 'Tab' ||
        // ⌘/Ctrl+Enter is Run, never Select: leave it to bubble.
        (e.key === 'Enter' && engaged && !e.metaKey && !e.ctrlKey)
      ) {
        const pick = items[highlight];
        if (pick) {
          e.preventDefault();
          onSelect(pick);
        }
      } else if (e.key === 'Escape') {
        // Claimed only when there is a list to dismiss. With nothing on
        // screen the key is left to whatever encloses the input, or the user
        // presses Escape once for an invisible list and sees nothing happen.
        if (shown) e.preventDefault();
        onClose();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [open, items, highlight, engaged, moveHighlight, anchorRef, keyboardRef, onSelect, onClose, shown]);

  // Resolve the docs entry for the highlighted item, if any.
  const current = items[highlight];
  const docOp = React.useMemo(() => {
    if (!current || current.kind !== 'operator') return null;
    return findOperatorDocs(current.name, current.class);
  }, [current]);
  const showPanel = !!docOp && !!docOp.description;

  // Position the side panel once the listbox renders. Highlight changes don't
  // move the listbox, so they're intentionally not in the deps.
  React.useEffect(() => {
    if (!open || !showPanel || !pos) return;
    const box = listboxRef.current?.getBoundingClientRect();
    if (!box) return;
    const p = placeFloatingPanel(
      { top: box.top, left: box.left, width: box.width, height: box.height },
      OPERATOR_PANEL_SIZE,
      'right',
    );
    setPanelPos((prev) =>
      prev && prev.top === p.top && prev.left === p.left
        ? prev
        : { top: p.top, left: p.left },
    );
  }, [open, showPanel, pos, items.length]);

  if (!open || items.length === 0 || !pos) return null;

  const renderRow = (s: Suggestion, i: number) => {
    const label = labelFor(s);
    const name = nameFor(s);
    const badge = badgeFor(s);
    const active = i === highlight;
    const describedBy =
      active && showPanel && s.kind === 'operator' ? panelId : undefined;
    return (
      <div
        key={`${s.kind}:${label}:${i}`}
        role="option"
        // Same reasoning as the listbox above: rows are never a tab
        // stop, only ever reached via aria-activedescendant.
        tabIndex={-1}
        // W15 §5 — `aria-selected` follows what Enter will do,
        // not what is tinted. Enter was made to refuse an auto-highlight
        // the user never chose, but every row still announced itself as
        // selected, so a screen-reader user was told an option was
        // selected while Enter deliberately passed it by. The
        // background stays on the highlighted row regardless — it means
        // "Enter would land here if you chose it", which is true — but
        // the ARIA state is only claimed once `engaged` makes it so.
        // Hovering sets `highlight` and not `engaged` on purpose:
        // making hover engage would re-arm Enter and undo that fix, so a
        // hovered row reads unselected while a click still selects it.
        aria-selected={active && engaged}
        aria-describedby={describedBy}
        onMouseEnter={() => setHighlight(i)}
        onClick={() => onSelect(s)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '4px 10px',
          fontSize: 11,
          fontFamily: 'monospace',
          background: active ? T.accentSoft : 'transparent',
          color: T.text,
          cursor: 'pointer',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        {name && (
          <span
            style={{
              fontSize: 10,
              color: T.textMuted,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              marginLeft: 'auto',
            }}
          >
            {name}
          </span>
        )}
        {badge && (
          <span
            style={{
              fontSize: 9,
              color: T.textGhost,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              flexShrink: 0,
            }}
          >
            {badge}
          </span>
        )}
      </div>
    );
  };

  // Flat list, or the same rows folded under their class headers. The row
  // index `i` is the position in `items` either way, so the highlight and
  // Enter never see the grouping.
  const rows: React.ReactNode[] = [];
  for (let i = 0; i < items.length; ) {
    const gi = groups.findIndex((g) => g.start === i);
    if (gi === -1) {
      rows.push(renderRow(items[i]!, i));
      i += 1;
      continue;
    }
    const g = groups[gi]!;
    const headerId = `${groupIdBase}-group-${gi}`;
    rows.push(
      <div key={headerId} role="group" aria-labelledby={headerId}>
        <div
          id={headerId}
          style={{
            padding: '4px 10px 2px',
            fontSize: 9,
            color: T.textGhost,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {g.label}
        </div>
        {items.slice(g.start, g.end).map((row, k) => renderRow(row, g.start + k))}
      </div>,
    );
    i = g.end;
  }

  return (
    <>
      <div
        // Positioning box for the list and the hint footer under it. The
        // footer sits outside the listbox (only options belong in one) and
        // outside its scroll area, so a long list never scrolls it away.
        // Same mousedown guard as the listbox: a press here must not blur
        // the input and close the popover. Presentational: the handler only
        // suppresses focus movement, this box is not itself a control.
        role="presentation"
        onMouseDown={(e) => e.preventDefault()}
        style={{
          position: 'fixed',
          top: pos.top,
          left: pos.left,
          minWidth: pos.width,
          maxWidth: 320,
          background: T.surface,
          border: `1px solid ${T.borderMed}`,
          borderRadius: T.rs,
          boxShadow: T.shadow,
          zIndex: 1000,
        }}
      >
        <div
          ref={listboxRef}
          role="listbox"
          // Combobox pattern (see the file header): DOM focus stays on the
          // input, this listbox is only ever reached via aria-activedescendant.
          // tabIndex={-1}, not 0 — 0 would put the popover in the tab order,
          // and tabbing out of the input would land inside a listbox that
          // closes on blur.
          tabIndex={-1}
          aria-label={label}
          onMouseDown={(e) => e.preventDefault()}
          style={{
            maxHeight: 240,
            overflowY: 'auto',
            padding: '2px 0',
          }}
        >
          {rows}
        </div>
        {showKeyboardHint && (
          <div
            role="note"
            aria-label={KEYBOARD_HINT.title}
            style={{
              borderTop: `1px solid ${T.border}`,
              padding: '3px 10px',
              fontSize: 10,
              color: T.textMuted,
            }}
          >
            {KEYBOARD_HINT.body}
          </div>
        )}
      </div>
      {showPanel && panelPos && (
        <div
          // Positioning box only — the doc content underneath already
          // carries its own `role="note"` + `aria-label` (OperatorDocPanel),
          // so this wrapper has nothing of its own to announce.
          // `presentation` isn't inherited by descendants (unlike
          // `aria-hidden`), so that note and its "Learn more" link stay
          // exposed. The mousedown guard is not decorative: this panel can
          // contain a real `<a>` (OperatorDocPanel's "Learn more"), and
          // without preventDefault, mousedown on it would blur the query
          // input and unmount the popover before the click ever lands
          // (see `QueryBar.tsx`'s note on the sibling listbox guard above).
          role="presentation"
          style={{
            position: 'fixed',
            top: panelPos.top,
            left: panelPos.left,
            zIndex: 1001,
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <OperatorDocPanel op={docOp} variant="side" id={panelId} />
        </div>
      )}
    </>
  );
}
