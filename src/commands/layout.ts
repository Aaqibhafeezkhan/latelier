import {
  QUERY_ROW_LABEL,
  groupRows,
  kindOf,
  matchText,
  rankCapped,
  rankCommands,
  type RankedRow,
  type Range,
  type RowKind,
  type VerbQuery,
} from './rank';
import { VERB_KINDS, capitalize, parseVerb, type ParsedVerb } from './verbs';
import type { Command, ObjectAction, ObjectKind, PaletteContext, PaletteObject, StepField } from './types';

// The palette's layout (X07 §13.3): scopes, capped groups, row tags, the
// footer's key hints and the session's query history. Pure, so the component
// only draws what this returns.

export type Scope = 'all' | 'collections' | 'actions' | 'saved' | 'tabs';

export const SCOPES: readonly Scope[] = ['all', 'collections', 'actions', 'saved', 'tabs'];

export const SCOPE_LABEL: Record<Scope, string> = {
  all: 'All',
  collections: 'Collections',
  actions: 'Actions',
  saved: 'Saved',
  tabs: 'Tabs',
};

/** Rows per kind in All, and rows in a single scope (X07 §13.7 rule 3). */
export const ALL_CAP = 5;
export const SCOPE_CAP = 50;

/**
 * Per kind: its group's label in All, the noun of its `Show <n> more` line, and
 * the scope its rows are listed in (Connections have none).
 */
export const KIND_LAYOUT: Record<
  RowKind,
  { group: string; noun: string; one: string; scope: Exclude<Scope, 'all'> | null }
> = {
  collection: { group: 'Collections', noun: 'collections', one: 'collection', scope: 'collections' },
  database: { group: 'Databases', noun: 'databases', one: 'database', scope: 'collections' },
  connection: { group: 'Connections', noun: 'connections', one: 'connection', scope: null },
  tab: { group: 'Tabs', noun: 'tabs', one: 'tab', scope: 'tabs' },
  saved: { group: 'Saved', noun: 'saved', one: 'saved', scope: 'saved' },
  action: { group: 'Actions', noun: 'actions', one: 'action', scope: 'actions' },
};

/** The order of the kinds' groups in All on a typed query, as the agreed artboards draw them. */
export const KIND_ORDER: readonly RowKind[] = ['collection', 'database', 'tab', 'saved', 'connection', 'action'];

/** The tag naming a row's kind under RECENT. */
const RECENT_KIND_TAG: Partial<Record<RowKind, string>> = {
  collection: 'Collection',
  connection: 'Connection',
};

/** The scope `delta` steps away, wrapping. */
export function cycleScope(scope: Scope, delta: number): Scope {
  const n = SCOPES.length;
  return SCOPES[(((SCOPES.indexOf(scope) + delta) % n) + n) % n]!;
}

/** What sits at the right of a row. */
export type Aside =
  | { type: 'switch'; checked: boolean }
  | { type: 'key'; keys: string }
  | { type: 'tag'; label: string }
  /** The action a verb in the query selects, as a tag: red and outlined when destructive. */
  | { type: 'action'; label: string; destructive: boolean }
  | null;

export interface RowEntry {
  type: 'row';
  id: string;
  index: number;
  row: RankedRow;
  cmd: Command;
  kind: RowKind;
  aside: Aside;
  /** Why it cannot run here; null when it can. */
  disabled: string | null;
}

export interface MoreEntry {
  type: 'more';
  id: string;
  index: number;
  kind: RowKind;
  scope: Scope;
  label: string;
}

/** A verb typed alone: one row per kind that has it, leading to where those objects are listed. */
export interface VerbEntry {
  type: 'verb';
  id: string;
  index: number;
  kind: ObjectKind;
  /** `Open a collection…` */
  title: string;
  /** The characters of `title` the typed word matched. */
  ranges: Range[];
  /** `Collections scope ›` */
  destination: string;
  /** A scope, or `connections` for All with Connections only. */
  target: Exclude<Scope, 'all'> | 'connections';
  /** The verb word as typed. */
  typed: string;
  /** A name to keep typing, from the first collection with the verb (`shop.or`); null when none has it. */
  example: string | null;
}

export type Entry = RowEntry | MoreEntry | VerbEntry;

export interface LayoutGroup {
  key: string;
  /** Null for a single scope's list, which has no header. */
  label: string | null;
  entries: Entry[];
}

export interface Layout {
  groups: LayoutGroup[];
  /** Every entry in the order drawn; `entry.index` is its position here. */
  entries: Entry[];
  /** Matches per scope, but All, on a typed query; null on an empty one. */
  counts: Record<Exclude<Scope, 'all'>, number> | null;
  /** In a single scope, the matches past the ones listed. */
  hidden: number;
  /** The verb the query starts with, when it selects actions; null otherwise. */
  verb: ParsedVerb | null;
}

/** The row's right-hand side: a switch, then a kind tag under RECENT, the object's tag, the shortcut, `Recent`. */
export function asideFor(row: RankedRow, kind: RowKind, underRecent: boolean): Aside {
  const { cmd, action } = row;
  if (action) return { type: 'action', label: action.title, destructive: action.destructive === true };
  if (cmd.toggle) return { type: 'switch', checked: cmd.toggle.checked };
  const kindTag = RECENT_KIND_TAG[kind];
  if (underRecent && kindTag) return { type: 'tag', label: kindTag };
  if (cmd.object?.tag) return { type: 'tag', label: cmd.object.tag };
  if (cmd.shortcut) return { type: 'key', keys: cmd.shortcut };
  if (row.recent && !underRecent) return { type: 'tag', label: 'Recent' };
  return null;
}

/** The action an object row performs on Enter: the verb's, else the default; undefined for a command. */
export function rowAction(row: RankedRow): ObjectAction | undefined {
  return row.action ?? row.cmd.object?.actions[0];
}

/** Where a verb typed alone leads, per kind. */
const VERB_TARGET: Record<(typeof VERB_KINDS)[number]['kind'], VerbEntry['target']> = {
  collection: 'collections',
  connection: 'connections',
  tab: 'tabs',
  saved: 'saved',
};

/**
 * Lays the palette out for a query in a scope. `connectionsOnly` narrows All
 * to Connection objects (performing `<Verb> a connection…`).
 */
export function layoutPalette(
  all: Command[],
  query: string,
  ctx: PaletteContext,
  recentIds: string[],
  scope: Scope,
  connectionsOnly = false,
): Layout {
  const typed = query.trim() !== '';
  const parsed = typed ? parseVerb(query) : null;
  const narrowed = connectionsOnly && scope === 'all';
  const groups: LayoutGroup[] = [];
  const entries: Entry[] = [];
  const rowEntry = (row: RankedRow, underRecent: boolean): RowEntry => {
    const kind = kindOf(row.cmd);
    return {
      type: 'row',
      id: row.cmd.id,
      index: entries.length,
      row,
      cmd: row.cmd,
      kind,
      // The pasted `_id` row carries the Enter key cap, as its artboard draws it.
      aside: row.fromQuery ? { type: 'key', keys: '↵' } : asideFor(row, kind, underRecent),
      disabled: (row.cmd.object ? rowAction(row)!.disabledReason : row.cmd.disabledReason)?.(ctx) ?? null,
    };
  };
  const addMore = (group: LayoutGroup, kind: RowKind, more: number) => {
    const { noun, one, scope: target } = KIND_LAYOUT[kind];
    if (more <= 0 || !target) return;
    const entry: MoreEntry = {
      type: 'more',
      id: `more:${kind}`,
      index: entries.length,
      kind,
      scope: target,
      label: `Show ${more} more ${more === 1 ? one : noun}`,
    };
    group.entries.push(entry);
    entries.push(entry);
  };
  const addGroup = (key: string, label: string | null, rows: RankedRow[], underRecent = false): LayoutGroup => {
    const group: LayoutGroup = { key, label, entries: [] };
    for (const row of rows) {
      const entry = rowEntry(row, underRecent);
      group.entries.push(entry);
      entries.push(entry);
    }
    groups.push(group);
    return group;
  };

  if (scope === 'all' && !typed) {
    for (const g of groupRows(rankCommands(all, query, ctx, recentIds))) {
      addGroup(g.key, g.label, g.rows.map((r) => r.row), g.key === 'recent');
    }
    return { groups, entries, counts: null, hidden: 0, verb: null };
  }

  // A verb alone in All: a row per kind that has it, then the commands the word matches.
  if (parsed && parsed.rest.length === 0 && scope === 'all' && !narrowed) {
    const { verb, typed: word } = parsed;
    const title = capitalize(verb);
    const group: LayoutGroup = { key: 'verb', label: `${title}…`, entries: [] };
    const example = exampleName(all, verb);
    for (const { kind, noun, destination } of VERB_KINDS) {
      const has = all.some((c) => c.object?.kind === kind && c.object.actions.some((a) => a.verb === verb));
      if (!has) continue;
      const entry: VerbEntry = {
        type: 'verb',
        id: `verb:${kind}`,
        index: entries.length,
        kind,
        title: `${title} ${noun}…`,
        ranges: word === verb ? [[0, verb.length]] : [],
        destination,
        target: VERB_TARGET[kind],
        typed: word,
        example,
      };
      group.entries.push(entry);
      entries.push(entry);
    }
    if (group.entries.length > 0) groups.push(group);
    const ranked = rankCapped(all, query, ctx, recentIds, ALL_CAP, (kind) => (kind === 'action' ? kind : null));
    for (const bucket of ranked.buckets) {
      addMore(addGroup(bucket.key, KIND_LAYOUT.action.group, bucket.rows), 'action', bucket.total - bucket.rows.length);
    }
    return { groups, entries, counts: countsOf(ranked.counts), hidden: 0, verb: null };
  }

  const verbQuery: VerbQuery | null = parsed ? { verb: parsed.verb, rest: parsed.rest, trailing: parsed.trailing } : null;
  const single = scope !== 'all' || narrowed;
  const bucketOf = (kind: RowKind): string | null => {
    if (narrowed) return kind === 'connection' ? kind : null;
    if (scope !== 'all') return KIND_LAYOUT[kind].scope === scope ? scope : null;
    return kind;
  };
  const ranked = rankCapped(all, query, ctx, recentIds, single ? SCOPE_CAP : ALL_CAP, bucketOf, verbQuery);
  // The line reads a verb only when a name follows it (X07 §13.4); a verb
  // alone in a scope still lists that scope's objects that have it.
  const verb = parsed && parsed.rest.length > 0 ? parsed : null;
  const counts = typed ? countsOf(ranked.counts) : null;

  if (single) {
    const bucket = ranked.buckets[0];
    if (bucket) addGroup(bucket.key, null, bucket.rows);
    return { groups, entries, counts, hidden: bucket ? bucket.total - bucket.rows.length : 0, verb };
  }

  if (ranked.fromQuery.length > 0) addGroup('pasted', QUERY_ROW_LABEL, ranked.fromQuery);
  // A fixed kind order on a typed query, so the groups do not reshuffle
  // between keystrokes; each group keeps its rank order (X07 §13.2).
  const byKind = [...ranked.buckets].sort(
    (a, b) => KIND_ORDER.indexOf(a.key as RowKind) - KIND_ORDER.indexOf(b.key as RowKind),
  );
  for (const bucket of byKind) {
    const kind = bucket.key as RowKind;
    addMore(addGroup(kind, KIND_LAYOUT[kind].group, bucket.rows), kind, bucket.total - bucket.rows.length);
  }
  return { groups, entries, counts, hidden: 0, verb };
}

/**
 * The start of the first collection with `verb`, to suggest typing after it:
 * its database and the collection's first two letters (`shop.or`).
 */
function exampleName(all: Command[], verb: string): string | null {
  const first = all.find((c) => c.object?.kind === 'collection' && c.object.actions.some((a) => a.verb === verb));
  if (!first) return null;
  const name = first.object!.name;
  const dot = name.indexOf('.');
  return name.slice(0, dot + 3);
}

/** Matches per scope, from matches per kind. */
function countsOf(byKind: Map<RowKind, number>): NonNullable<Layout['counts']> {
  const counts = { collections: 0, actions: 0, saved: 0, tabs: 0 };
  for (const [kind, n] of byKind) {
    const s = KIND_LAYOUT[kind].scope;
    if (s) counts[s] += n;
  }
  return counts;
}

// ── Action list ──────────────────────────────────────────────────────────────

export interface ActionEntry {
  action: ObjectAction;
  index: number;
  /** Matched characters of the title. */
  ranges: Range[];
  disabled: string | null;
  /** The key cap at the right: `↵` on the default, `⌘↵` on the alternate. */
  keys: string | null;
  /** The tag before it: `reuses the open tab`, `asks to confirm`. */
  tag: string | null;
}

/**
 * An object's actions for the action list (X07 §13.4): filtered by `query`
 * with the palette's matcher, in their declared order, destructive ones last.
 */
export function actionList(obj: PaletteObject, query: string, ctx: PaletteContext): ActionEntry[] {
  const [first] = obj.actions;
  const ordered = [...obj.actions.filter((a) => !a.destructive), ...obj.actions.filter((a) => a.destructive)];
  const out: ActionEntry[] = [];
  for (const action of ordered) {
    const ranges = matchText(action.title, query);
    if (ranges === null) continue;
    const isDefault = action === first;
    let tag: string | null = null;
    if (action.destructive) tag = 'asks to confirm';
    else if (isDefault && obj.kind === 'collection') tag = 'reuses the open tab';
    else if (action.fieldStep) tag = '›';
    out.push({
      action,
      index: out.length,
      ranges,
      disabled: action.disabledReason?.(ctx) ?? null,
      keys: isDefault ? '↵' : action.alternate ? '⌘↵' : null,
      tag,
    });
  }
  return out;
}

/** The kind an action acts on, as the failure toast names it. */
const KIND_NOUN: Record<ObjectKind, string> = {
  collection: 'collection',
  database: 'database',
  connection: 'connection',
  tab: 'tab',
  saved: 'saved query',
};

/** Words that already name what an action acts on: `Drop collection…`, `Open in new tab`. */
const NOUN_WORD = /\b(collection|database|connection|tab)\b/i;

/** Actions titled with a noun, not a verb: what they do is open it. */
const NOUN_TITLED = new Set(['schema', 'indexes']);

/**
 * An object action's title as the failure toast names it (X07 §13.3,
 * `Couldn't run "Export collection…"`): the title with the kind it acts on
 * put after its verb. A title that names a kind already reads as it is.
 */
export function failureTitle(kind: ObjectKind, action: ObjectAction): string {
  const { title } = action;
  if (NOUN_WORD.test(title)) return title;
  const noun = KIND_NOUN[kind];
  if (NOUN_TITLED.has(action.verb)) return `Open ${noun} ${title.toLowerCase()}`;
  const ellipsis = title.endsWith('…') ? '…' : '';
  const base = title.slice(0, title.length - ellipsis.length);
  const space = base.indexOf(' ');
  // `Switch to` takes its noun after the preposition.
  const named =
    space === -1 || base.endsWith(' to')
      ? `${base} ${noun}`
      : `${base.slice(0, space)} ${noun}${base.slice(space)}`;
  return named + ellipsis;
}

/** The action list's footer. */
export const ACTION_LIST_HINTS: FooterHints = {
  left: [
    { keys: '↵', label: 'Run action' },
    { keys: 'esc', label: 'Back to results' },
    { keys: '←', label: 'Back, on an empty input' },
  ],
  right: [],
};

// ── Field step ───────────────────────────────────────────────────────────────

export type FieldStepEntry =
  | { type: 'field'; field: StepField; index: number; ranges: Range[] }
  | { type: 'starter'; id: string; label: string; index: number; ranges: Range[] };

/**
 * The field step's rows (X07 §13.6): the sampled fields, then the starters,
 * each filtered by `query` with the palette's matcher and kept in its own
 * order (the sample's, the templates'). `fields` is null while the sample loads.
 */
export function fieldStepList(
  fields: readonly StepField[] | null,
  starters: readonly { id: string; label: string }[],
  query: string,
): { fields: FieldStepEntry[]; starters: FieldStepEntry[] } {
  const out: { fields: FieldStepEntry[]; starters: FieldStepEntry[] } = { fields: [], starters: [] };
  let index = 0;
  for (const field of fields ?? []) {
    const ranges = matchText(field.path, query);
    if (ranges !== null) out.fields.push({ type: 'field', field, index: index++, ranges });
  }
  for (const { id, label } of starters) {
    const ranges = matchText(label, query);
    if (ranges !== null) out.starters.push({ type: 'starter', id, label, index: index++, ranges });
  }
  return out;
}

/** The field step's footer: what Enter adds, and the way back. */
export function fieldStepHints(entry: FieldStepEntry | undefined): FooterHints {
  const left: KeyHint[] = [];
  if (entry) {
    const name = entry.type === 'field' ? entry.field.path : entry.label;
    left.push({ keys: '↵', label: `Add "${name}" to the filter (nothing runs)` });
  }
  left.push({ keys: 'esc', label: 'Back to actions' });
  return { left, right: [] };
}

// ── Footer ───────────────────────────────────────────────────────────────────

export interface KeyHint {
  /** Mac glyphs, formatted for the platform where drawn; empty for a hint with no key. */
  keys: string;
  label: string;
  /** Drawn after the label in the body text colour, at weight 600. */
  strong?: string;
}

export interface FooterHints {
  left: KeyHint[];
  right: KeyHint[];
}

/** What Enter does on an entry; null when it does nothing. */
function enterLabel(entry: Entry): string | null {
  if (entry.type !== 'row') return 'Switch scope';
  if (entry.disabled !== null) return null;
  if (entry.row.fromQuery) return 'Find';
  if (entry.cmd.toggle) return 'Toggle';
  const action = rowAction(entry.row);
  if (!action) return 'Run';
  return action.destructive ? `${action.title} (opens its confirm dialog)` : action.title;
}

/** The keys an object row adds after Enter: its alternate, and its action list. */
function objectHints(entry: Entry): KeyHint[] {
  if (entry.type !== 'row' || !entry.cmd.object) return [];
  if (entry.row.action) return [{ keys: '⌥↵', label: 'All actions' }];
  const alt = entry.cmd.object.actions.find((a) => a.alternate);
  const hints: KeyHint[] = [];
  if (alt) hints.push({ keys: '⌘↵', label: alt.title });
  hints.push({ keys: '⌥↵', label: 'Actions' });
  return hints;
}

/**
 * The footer's key hints for the highlighted entry. A list per side, so a
 * later key (`⌘↵`, `⌥↵`) is one more entry rather than a new layout.
 */
export function footerHints(scope: Scope, typed: boolean, entry: Entry | undefined): FooterHints {
  const left: KeyHint[] = [];
  const label = entry ? enterLabel(entry) : null;
  if (label) left.push({ keys: '↵', label });
  if (entry) left.push(...objectHints(entry));
  if (entry?.type === 'verb') {
    left.push(
      entry.example === null
        ? { keys: '', label: 'Keep typing a name after', strong: entry.typed }
        : { keys: '', label: 'Keep typing a name:', strong: `${entry.typed} ${entry.example}` },
    );
  }
  const right: KeyHint[] = [];
  if (scope !== 'all') right.push({ keys: '⇧Tab', label: SCOPE_LABEL[cycleScope(scope, -1)] });
  else if (!typed) right.push({ keys: '⌘P', label: 'Collections' });
  return { left, right };
}

// ── Query history ────────────────────────────────────────────────────────────

/** Earlier queries kept for `↑`, per session. */
export const HISTORY_CAP = 20;

/** `history` with `query` as its newest entry; a blank query changes nothing. */
export function pushHistory(history: readonly string[], query: string): string[] {
  const q = query.trim();
  if (!q) return [...history];
  return [q, ...history.filter((h) => h !== q)].slice(0, HISTORY_CAP);
}

/**
 * One step through the history from position `at` (-1: not browsing, the
 * input empty). `older` is `↑`. Returns the new position and the query it
 * puts in the input, or null at the oldest entry.
 */
export function stepHistory(
  history: readonly string[],
  at: number,
  direction: 'older' | 'newer',
): { at: number; query: string } | null {
  const next = direction === 'older' ? at + 1 : at - 1;
  if (next >= history.length || next < -1) return null;
  return { at: next, query: next === -1 ? '' : history[next]! };
}
