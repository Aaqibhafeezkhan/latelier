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
   * What the fuzzy (subsequence) match reads instead of the title. Set when
   * the title carries a fixed prefix, so `Open: ` is not a subsequence every
   * row of the family shares.
   */
  fuzzyText?: string;
  perform: (ctx: PaletteContext) => void | Promise<void>;
}
