import type { PaletteObject, StepField } from '../../commands/types';
import type { CondNode, SchemaSampleEntry } from '@shared/types';
import type { DisplayType } from '../../utils/displayValue';
import type { WorkspaceTabsState } from '../../state/workspaceTabs';
import type { NavigatorDialogRequest } from './DbCollectionNavigator';
import { requestTab, type FilterRequest } from './tabRequest';
import { FILTER_TEMPLATES } from './filterTemplates';
import { FIELD_OPS, valTypeFromDisplayType } from './builder';
import { notify } from '../../theme/notifications';

// `inferType`'s vocabulary (schemaSummary.ts) as the field step's type tag.
const TYPE_LABEL: Record<string, string> = {
  string: 'String',
  number: 'Number',
  long: 'Int64',
  decimal: 'Decimal128',
  boolean: 'Boolean',
  date: 'Date',
  objectid: 'ObjectId',
  null: 'Null',
  object: 'Object',
  array: 'Array',
  regex: 'Regex',
  binary: 'Binary',
  timestamp: 'Timestamp',
  undefined: 'Undefined',
};

/** The most frequent type in a field's histogram; the first listed wins a tie. */
export function dominantType(types: Record<string, number>): string {
  let top = '';
  let topCount = 0;
  for (const [type, count] of Object.entries(types)) {
    if (count > topCount) {
      top = type;
      topCount = count;
    }
  }
  return top;
}

/**
 * One blank-valued condition on `path`, typed as the sample mostly has it
 * (a string when it was not sampled), on the first operator of its type.
 */
export function fieldCondition(path: string, type: string | undefined): CondNode {
  // A null-typed field still wants a value typed: `$eq: null` would print at once.
  const valType = type === 'null' ? 'string' : valTypeFromDisplayType(type as DisplayType | undefined);
  return { kind: 'cond', field: path, op: FIELD_OPS[valType][0]!, valType, value: '' };
}

/**
 * A collection as a palette object (X07 §13.4). Each action calls what the
 * navigator's collection menu or the tab itself calls; none is reimplemented.
 */
export function collectionObject(args: {
  connectionId: string;
  db: string;
  coll: string;
  isView: boolean;
  connectionName: string | undefined;
  /** The live tab state, read when an action runs. */
  tabs: () => WorkspaceTabsState;
  showStructure: (tabId: string, section: 'Indexes' | 'Schema') => void;
  requestDialog: (request: NavigatorDialogRequest) => void;
  /** Whether the Connection is dormant, read when an action runs. */
  dormant: () => boolean;
  /** Whether tab `tabId` has a find in flight, read when an action runs. */
  running: (tabId: string) => boolean;
  /** The collection's schema sample, through the field suggestions' cache. */
  sampleSchema: () => Promise<SchemaSampleEntry[]>;
  /** Shows tab `tabId`'s filter drawer and hands it `request`; nothing runs. */
  startQuery: (tabId: string, request: FilterRequest) => void;
}): PaletteObject {
  const { connectionId, db, coll, isView, tabs, showStructure, requestDialog } = args;
  const input = { connectionId, dbName: db, collection: coll };
  const openReusing = () => tabs().openCollection({ ...input, reuseExisting: true });
  // Worded like `doc.insert`'s reason on a view.
  const onView = (what: string) => () => (isView ? `This is a view, so ${what}` : null);
  const dialog = (kind: NavigatorDialogRequest['dialog']) => () => requestDialog({ ...input, dialog: kind });
  // A dormant tab shows its Connect pane, not the query bar or the result bar:
  // say so, once, and queue nothing.
  const connectFirst = (then: string): boolean => {
    if (!args.dormant()) return false;
    notify.info(`Connect to ${args.connectionName ?? 'the connection'} first, then ${then}.`);
    return true;
  };
  const appendTo = async (request: FilterRequest) => {
    const tab = await openReusing();
    if (!connectFirst('query')) args.startQuery(tab.id, request);
  };
  // The dominant type of each sampled path, for the condition a choice appends.
  const sampledTypes = new Map<string, string>();
  return {
    // Connection-qualified, so the same namespace on another Connection is
    // not "recent". The id of the v1 row, so a stored MRU still names it.
    id: `tab.open:${connectionId}:${db}:${coll}`,
    kind: 'collection',
    name: `${db}.${coll}`,
    subtitle: args.connectionName,
    actions: [
      { id: 'open', verb: 'open', title: 'Open', perform: async () => void (await openReusing()) },
      {
        id: 'open-new-tab',
        verb: 'open',
        title: 'Open in new tab',
        alternate: true,
        perform: async () => void (await tabs().openCollection(input)),
      },
      {
        id: 'query',
        verb: 'query',
        title: 'Query…',
        perform: () => appendTo({ node: null, focus: 'field' }),
      },
      {
        id: 'filter-field',
        verb: 'filter',
        title: 'Filter by field…',
        // Reached where the step does not open, which says to connect first;
        // anywhere else it is Query….
        perform: () => appendTo({ node: null, focus: 'field' }),
        // Not on a dormant Connection: a sample of it would fail, and be cached as empty.
        fieldStep: () =>
          args.dormant()
            ? null
            : {
                title: 'Filter by field',
                loadFields: async (): Promise<StepField[]> => {
                  const entries = await args.sampleSchema();
                  return entries.map((e) => {
                    const type = dominantType(e.types);
                    sampledTypes.set(e.path, type);
                    return { path: e.path, type: TYPE_LABEL[type] ?? type };
                  });
                },
                starters: FILTER_TEMPLATES.map(({ id, label }) => ({ id, label })),
                chooseField: (field) =>
                  appendTo({ node: fieldCondition(field.path, sampledTypes.get(field.path)), focus: 'value' }),
                chooseStarter: (id) => {
                  const tpl = FILTER_TEMPLATES.find((t) => t.id === id);
                  if (!tpl) throw new Error(`No filter starter "${id}"`);
                  return appendTo({ node: tpl.build(new Date()), focus: 'field' });
                },
              },
      },
      { id: 'aggregate', verb: 'aggregate', title: 'Aggregate', perform: async () => void (await tabs().openAggregation(input)) },
      { id: 'schema', verb: 'schema', title: 'Schema', perform: async () => showStructure((await openReusing()).id, 'Schema') },
      { id: 'indexes', verb: 'indexes', title: 'Indexes', perform: async () => showStructure((await openReusing()).id, 'Indexes') },
      {
        id: 'export',
        verb: 'export',
        title: 'Export…',
        // The tab's own Export dialog, under its menu item's rule: only a
        // settled result with documents exports. Anything else says why, once,
        // and queues nothing.
        perform: async () => {
          // The opened tab is the stored row, which never carries a result:
          // the result lives in the live tab state.
          const opened = await openReusing();
          const live = tabs().tabs.find((t) => t.id === opened.id);
          const tab = live?.kind === 'collection' ? live : opened;
          if (connectFirst('export')) return;
          if ((tab.state.activeView ?? 'documents') !== 'documents') tabs().setActiveView(tab.id, 'documents');
          const run = tab.state.lastRun;
          if (!run || run.error || args.running(tab.id)) notify.info('Run the query, then choose Export again');
          else if (run.documents.length === 0) notify.info('The query matched no documents, so there is nothing to export.');
          else requestTab('export', tab.id);
        },
      },
      {
        id: 'import',
        verb: 'import',
        title: 'Import…',
        disabledReason: onView("documents can't be imported here"),
        perform: dialog('import'),
      },
      {
        id: 'rename',
        verb: 'rename',
        title: 'Rename…',
        disabledReason: onView("it can't be renamed here"),
        perform: dialog('rename'),
      },
      {
        id: 'drop',
        verb: 'delete',
        title: 'Drop collection…',
        destructive: true,
        disabledReason: onView("it can't be dropped here"),
        perform: dialog('drop'),
      },
    ],
  };
}
