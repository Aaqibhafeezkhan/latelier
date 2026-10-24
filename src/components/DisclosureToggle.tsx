import React from 'react';
import { themeVars } from '../theme/themeVars';
import { UnstyledButton } from '@mantine/core';
import { I } from '../icons';

/**
 * X19 #54 — the keyboard-operable half of a click-to-expand table row.
 *
 * IndexesTab and UsersTab both expand a detail row by making the whole
 * `<Table.Tr>` clickable with no `role`/`tabIndex`/`onKeyDown` — unreachable
 * from a keyboard. The fix is a real `<button aria-expanded>` carrying the
 * chevron, per specs/X19-keyboard-operability.md: Mantine ships no
 * expandable-row primitive, and a focusable `<tr>` is the wrong shape when
 * the chevron already is the visual affordance.
 *
 * This button carries no `onClick` of its own. A click bubbles once to the
 * row's own `onClick` (which still toggles on a click anywhere in the row,
 * unchanged), and Enter/Space on the focused button fire that same native
 * click — so mouse and keyboard both end up at the one toggle, and the
 * button itself never unmounts across a toggle, keeping focus in place.
 */
export function DisclosureToggle({
  open,
  children,
}: {
  open: boolean;
  children: React.ReactNode;
}) {
  const T = themeVars;
  return (
    <UnstyledButton
      type="button"
      aria-expanded={open}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        maxWidth: '100%',
        font: 'inherit',
        color: 'inherit',
      }}
    >
      <span style={{ color: T.textGhost, display: 'flex', flexShrink: 0 }}>
        {open ? I.chevD : I.chevR}
      </span>
      {children}
    </UnstyledButton>
  );
}
