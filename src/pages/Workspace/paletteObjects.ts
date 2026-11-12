import type { PaletteObject } from '../../commands/types';
import type { SavedQuerySummary, WorkspaceTab } from '@shared/types';
import type { NavigatorDialogRequest } from './DbCollectionNavigator';
import { tabLabel } from './tabActions';

// Tab, Saved and Database palette objects (X07 §13.4, §13.5). Each action
// calls what the same control calls elsewhere in the app; none is
// reimplemented here, the handlers come in from Workspace.

/** An open tab, named as its tab is. */
export function tabObject(args: {
  tab: WorkspaceTab;
  connectionName: string | undefined;
  activate: (id: string) => void | Promise<void>;
  close: (id: string) => void | Promise<void>;
  setPinned: (id: string, pinned: boolean) => void | Promise<void>;
}): PaletteObject {
  const { tab } = args;
  const where = tab.kind === 'collection' && tab.dbName ? [tab.dbName, args.connectionName] : [args.connectionName];
  return {
    id: `tab:${tab.id}`,
    kind: 'tab',
    name: tabLabel(tab),
    subtitle: where.filter(Boolean).join(' · ') || undefined,
    tag: 'Open tab',
    actions: [
      { id: 'switch', verb: 'open', title: 'Switch to', perform: () => args.activate(tab.id) },
      { id: 'close', verb: 'close', title: 'Close', perform: () => args.close(tab.id) },
      {
        id: 'pin',
        verb: 'pin',
        title: tab.pinned ? 'Unpin' : 'Pin',
        perform: () => args.setPinned(tab.id, !tab.pinned),
      },
    ],
  };
}

/** The saved kinds the palette lists, and the tag each one reads. */
const SAVED_TAG: Partial<Record<SavedQuerySummary['kind'], string>> = { find: 'Query', aggregation: 'Pipeline' };

/** Whether the palette lists this saved entry: queries and pipelines, not scripts. */
export function isPaletteSaved(saved: SavedQuerySummary): boolean {
  return SAVED_TAG[saved.kind] !== undefined;
}

/** A saved query or pipeline, with its namespace as the subtitle. */
export function savedObject(args: {
  saved: SavedQuerySummary;
  /** Loads it; with `run`, runs it too. */
  open: (saved: SavedQuerySummary, run: boolean) => void | Promise<void>;
  rename: (saved: SavedQuerySummary) => void | Promise<void>;
  remove: (saved: SavedQuerySummary) => void | Promise<void>;
}): PaletteObject {
  const { saved } = args;
  return {
    id: `saved:${saved.id}`,
    kind: 'saved',
    name: saved.name,
    subtitle: `${saved.dbName}.${saved.collection}`,
    tag: SAVED_TAG[saved.kind],
    actions: [
      { id: 'open', verb: 'open', title: 'Open', perform: () => args.open(saved, false) },
      { id: 'run', verb: 'run', title: 'Run', alternate: true, perform: () => args.open(saved, true) },
      { id: 'rename', verb: 'rename', title: 'Rename…', perform: () => args.rename(saved) },
      { id: 'delete', verb: 'delete', title: 'Delete…', destructive: true, perform: () => args.remove(saved) },
    ],
  };
}

/** A database of a connected Connection; its default reveals its row in the navigator. */
export function databaseObject(args: {
  connectionId: string;
  db: string;
  connectionName: string | undefined;
  requestDialog: (request: NavigatorDialogRequest) => void;
  /** Expands the database in the navigator, scrolls to its row and focuses it. */
  reveal: (connectionId: string, db: string) => void;
}): PaletteObject {
  const { connectionId, db, requestDialog } = args;
  const dialog = (kind: 'createCollection' | 'dropDatabase') => () =>
    requestDialog({ connectionId, dbName: db, dialog: kind });
  return {
    id: `database:${connectionId}:${db}`,
    kind: 'database',
    name: db,
    subtitle: args.connectionName ? `${args.connectionName} · database` : 'database',
    keywords: ['database'],
    actions: [
      // Not `open`: that verb would list every database beside the collections it opens.
      { id: 'reveal', verb: 'reveal', title: 'Reveal in navigator', perform: () => args.reveal(connectionId, db) },
      { id: 'create-collection', verb: 'create', title: 'Create collection…', perform: dialog('createCollection') },
      { id: 'drop', verb: 'delete', title: 'Drop database…', destructive: true, perform: dialog('dropDatabase') },
    ],
  };
}
