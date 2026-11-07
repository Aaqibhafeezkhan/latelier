/**
 * Below this window width the pane cannot spare room for both side panels, so
 * one shows at a time. The choice made down there lives only for the session:
 * the stored layout is what the window returns to once it is wide again.
 */
export const ONE_PANEL_BELOW_PX = 1100;

/** The drawer's width while it is the one panel showing. */
export const ONE_PANEL_BUILDER_PX = 277;

export type SidePanel = 'navigator' | 'builder';

/**
 * The panel showing while the window is narrow. `choice` is undefined until the
 * user toggles something; before that the stored layout decides, and the
 * navigator wins when it has both open.
 */
export function narrowOpenPanel(
  choice: SidePanel | null | undefined,
  navigatorCollapsed: boolean,
  builderCollapsed: boolean,
): SidePanel | null {
  if (choice !== undefined) return choice;
  if (!navigatorCollapsed) return 'navigator';
  return builderCollapsed ? null : 'builder';
}

/** What opening or closing `panel` leaves showing: opening one closes the other. */
export function toggleNarrowPanel(open: SidePanel | null, panel: SidePanel, collapsed: boolean): SidePanel | null {
  if (!collapsed) return panel;
  return open === panel ? null : open;
}
