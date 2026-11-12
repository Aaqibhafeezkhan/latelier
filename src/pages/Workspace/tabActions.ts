import type { ConnectionSummary, WorkspaceTab } from '@shared/types';
import type { WorkspaceTabsState } from '../../state/workspaceTabs';
import { isKnownNotConnected } from '../../state/connections';
import { confirmDestructive } from '../../utils/confirm';

// What a tab's own controls do, shared by the tab strip, its keyboard
// shortcut and the palette's Tab objects so they cannot drift apart.

/** The tab's name, as its tab strip button shows it. */
export function tabLabel(tab: WorkspaceTab): string {
  return tab.kind === 'script' ? tab.state.title || 'Script' : tab.collection || '(empty)';
}

/** Closes tab `id`, asking first when it holds unsaved pipeline edits. */
export async function closeTabGuarded(tabs: Pick<WorkspaceTabsState, 'tabs' | 'close'>, id: string): Promise<void> {
  const t = tabs.tabs.find((x) => x.id === id);
  if (t?.kind === 'collection' && t.state.aggregation?.dirty) {
    const proceed = await confirmDestructive({
      title: 'Discard unsaved pipeline changes?',
      body: 'This tab has pipeline edits that have not been saved. Closing it discards them.',
      confirmLabel: 'Discard and close',
    });
    if (!proceed) return;
  }
  await tabs.close(id);
}

/**
 * Brings tab `id` to the front. Activating a dormant tab is the wake gesture:
 * it connects the tab's Connection, as clicking the navigator root does.
 */
export function activateTab(
  args: {
    tabs: Pick<WorkspaceTabsState, 'tabs' | 'activeId' | 'setActive'>;
    connections: ConnectionSummary[];
    recordSessionEvent: (event: string, key: string) => void;
    openConnection: (id: string) => void;
  },
  id: string,
): Promise<void> {
  const { tabs, connections } = args;
  if (id !== tabs.activeId) args.recordSessionEvent('tabSwitch', '*');
  const target = tabs.tabs.find((t) => t.id === id);
  if (target) {
    const conn = connections.find((c) => c.id === target.connectionId);
    if (isKnownNotConnected(conn)) args.openConnection(target.connectionId);
  }
  return tabs.setActive(id);
}
