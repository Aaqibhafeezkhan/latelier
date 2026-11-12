export type CommandGroup =
  | 'general'
  | 'navigation'
  | 'connection'
  | 'workspace'
  | 'query'
  | 'view'
  | 'references'
  | 'aggregation';

export const GROUP_ORDER: readonly CommandGroup[] = [
  'general',
  'navigation',
  'connection',
  'workspace',
  'query',
  'view',
  'references',
  'aggregation',
];

export const GROUP_LABEL: Record<CommandGroup, string> = {
  general: 'General',
  navigation: 'Navigation',
  connection: 'Connection',
  workspace: 'Workspace',
  query: 'Query',
  view: 'View',
  references: 'References',
  aggregation: 'Aggregation',
};

export interface PaletteContext {
  pathname: string;
  connectionId: string | null;
}

/** The parts of a row built from the query itself. */
export interface QueryRow {
  title: string;
  subtitle: string;
  /** The part of `title` shown in the monospace font and the accent ink. */
  emphasis: string;
  /** Runs instead of the command's own `perform`: it knows the query. */
  perform: () => void | Promise<void>;
}

export interface Command {
  id: string;
  title: string;
  subtitle?: string;
  group: CommandGroup;
  keywords?: string[];
  shortcut?: string;
  when?: (ctx: PaletteContext) => boolean;
  /** Listed only once the user types: one row per collection would flood the empty palette. */
  hideWhenEmptyQuery?: boolean;
  /**
   * What every title match reads instead of the title, and what a row shows
   * as its title text when set. Set when the title carries a fixed prefix, so
   * `Open: ` is not text every row of the family shares.
   */
  matchText?: string;
  /**
   * A row that exists only for a query it recognises: returns its parts, or
   * null when the query is not for it. Never listed on an empty query, never
   * ranked, never recorded as recent; when it answers it is listed first.
   */
  forQuery?: (query: string) => QueryRow | null;
  /**
   * An on/off setting: the row shows a switch, and performing it flips the
   * state and leaves the palette open on the row. The title names the setting,
   * not the change (`Dark mode`, not `Toggle dark mode`).
   */
  toggle?: { checked: boolean };
  /**
   * Why the command cannot run here, or null when it can. A reason lists the
   * row greyed with the reason as its subtitle, and Enter does nothing. Unlike
   * `when`, which removes a command that does not apply here at all.
   */
  disabledReason?: (ctx: PaletteContext) => string | null;
  perform: (ctx: PaletteContext) => void | Promise<void>;
  /** Set on the row an object registers as (`useRegisterObjects`): the object it stands for. */
  object?: PaletteObject;
}

// ── Objects (X07 §13.4) ──────────────────────────────────────────────────────

export type ObjectKind = 'connection' | 'database' | 'collection' | 'tab' | 'saved';

export interface ObjectAction {
  /** Unique within the object. */
  id: string;
  /** The verb that selects this action from the query, lower case: `open`, `drop`. */
  verb: string;
  /** Row title in the action list: `Open`, `Drop collection…`. */
  title: string;
  /** Confirmed by its own dialog; styled as destructive and never the default. */
  destructive?: boolean;
  /** The object's alternate action, performed by `⌘↵`; at most one per object, never destructive. */
  alternate?: boolean;
  disabledReason?: (ctx: PaletteContext) => string | null;
  perform: (ctx: PaletteContext) => void | Promise<void>;
  /**
   * Opens a field step inside the palette instead of performing. Returns
   * null when the step can't open here: `perform` runs instead.
   */
  fieldStep?: () => FieldStep | null;
}

/** A field the step lists: its path and the label of its dominant type. */
export interface StepField {
  path: string;
  type: string;
}

/** A step listing a collection's sampled fields, then fixed starter rows (X07 §13.6). */
export interface FieldStep {
  /** The second chip: `Filter by field`. */
  title: string;
  /** Called once when the step opens. */
  loadFields: () => Promise<StepField[]>;
  starters: readonly { id: string; label: string }[];
  chooseField: (field: StepField) => void | Promise<void>;
  chooseStarter: (id: string) => void | Promise<void>;
}

export interface PaletteObject {
  /** Stable and unique across kinds; what the MRU stores. */
  id: string;
  kind: ObjectKind;
  /** Shown as the row title and matched as the match text. */
  name: string;
  subtitle?: string;
  /** What the row's tag reads, at its right (`Open tab`, `Query`); shown instead of `Recent`. */
  tag?: string;
  keywords?: string[];
  /** The first action is the default, performed on Enter. */
  actions: ObjectAction[];
}
