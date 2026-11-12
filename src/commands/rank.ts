import {
  GROUP_LABEL,
  type Command,
  type CommandGroup,
  type ObjectAction,
  type ObjectKind,
  type PaletteContext,
  type QueryRow,
} from './types';

export const RECENT_LABEL = 'Recent';
export const QUERY_ROW_LABEL = 'In the tab in front';

/** Half-open character range `[start, end)` into a row's display text. */
export type Range = [number, number];

/** Match classes, strongest first (X07 §13.2). */
export const MATCH_CLASS = ['exact', 'wordStart', 'initials', 'substring', 'keyword', 'subsequence'] as const;
export type MatchClass = (typeof MATCH_CLASS)[number];

const EXACT = 0;
const WORD_START = 1;
const INITIALS = 2;
const SUBSTRING = 3;
const KEYWORD = 4;
const SUBSEQUENCE = 5;

export interface RankedRow {
  cmd: Command;
  /** In the MRU. */
  recent: boolean;
  /** The weakest class among the query's tokens; null on an empty query. */
  cls: MatchClass | null;
  /** Matched characters of `displayText(cmd)`. */
  ranges: Range[];
  /** Matched characters of `cmd.subtitle`, for the tokens the title did not match. */
  subtitleRanges: Range[];
  /** Set on a row built from the query itself (the pasted `_id` row). */
  fromQuery?: QueryRow;
  /** On an object listed for a verb in the query: the action that verb selects. */
  action?: ObjectAction;
}

/** A query whose first word is a verb: objects match on `rest` and need an action for `verb`. */
export interface VerbQuery {
  verb: string;
  rest: string[];
  /**
   * The verb was the last word. It may as well end a name (`orders pipeline`,
   * `weekly export`), so an object without its action is not hidden: it is
   * matched on the whole query, as a command is.
   */
  trailing?: boolean;
}

/** A ranked row placed in the list: `index` is its position in the displayed order. */
export interface RenderRow {
  cmd: Command;
  index: number;
  row: RankedRow;
}

export interface RenderGroup {
  key: string;
  label: string;
  rows: RenderRow[];
}

/** The text a row shows as its title, and the one its ranges refer to. */
export function displayText(cmd: Command): string {
  return cmd.matchText ?? cmd.title;
}

function isVisible(cmd: Command, ctx: PaletteContext): boolean {
  if (!cmd.when) return true;
  try {
    return cmd.when(ctx);
  } catch (e) {
    if (import.meta.env.DEV) {
      console.warn(`[commandRegistry] when() threw for "${cmd.id}":`, e);
    }
    return false;
  }
}

// ── Per-registration precomputation ──────────────────────────────────────────

interface Prepared {
  /** Lower-cased match text, the same length as the original. */
  text: string;
  /** Offsets where a word starts. */
  starts: number[];
  sub: string;
  kw: string;
  /** The command this was last matched to; a different object with the same id is checked by text. */
  cmd: Command | null;
  /** What this was built from, to tell whether a command still has the same text. */
  source: string;
  subtitle: string | undefined;
  keywords: string[] | undefined;
}

const SEPARATORS = new Set([' ', '.', '_', '-', ':', '/', '→']);
// Segments end at these only: `_`, `-` and a case change start a word inside one.
const SEGMENT_SEPARATORS = new Set([' ', '.', ':', '/', '→']);

function isSegmentStart(text: string, at: number): boolean {
  return at === 0 || SEGMENT_SEPARATORS.has(text.charAt(at - 1));
}

function isSegmentEnd(text: string, end: number): boolean {
  return end === text.length || SEGMENT_SEPARATORS.has(text.charAt(end));
}

function isLower(c: string): boolean {
  return c !== c.toUpperCase();
}

function isUpper(c: string): boolean {
  return c !== c.toLowerCase();
}

/** Lower-cased without changing the length, so ranges stay valid on the original. */
function lowerKeepingLength(s: string): string {
  const lower = s.toLowerCase();
  if (lower.length === s.length) return lower;
  let out = '';
  for (const c of s) {
    const l = c.toLowerCase();
    out += l.length === c.length ? l : c;
  }
  return out;
}

// §13.7 rule 4: prepared once, not on every keystroke. Keyed on the id, with the
// text that feeds the preparation kept in the record: ranking finds its command
// by identity (one lookup), and a registration that rebuilds the same commands
// as new objects (the workspace does on every change) finds them done. One
// record per registered id.
const preparedById = new Map<string, Prepared>();

function sameKeywords(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((k, i) => k === b[i]);
}

/** Drops the cached preparations of ids `keep` rejects, so the cache follows the registry. */
export function prunePrepared(keep: (id: string) => boolean): void {
  for (const id of preparedById.keys()) if (!keep(id)) preparedById.delete(id);
}

let builds = 0;

/** How many times a command's match text has been prepared from scratch, for tests and diagnostics. */
export function preparationsBuilt(): number {
  return builds;
}

/** How many ids have a cached preparation. */
export function preparedCount(): number {
  return preparedById.size;
}

/**
 * Works out a command's match text, word starts and keywords now, so the first
 * keystroke after a registration finds them ready. The registry calls this when
 * it receives a command; ranking falls back to it for a command that never went
 * through the registry.
 */
export function prepareCommand(cmd: Command): void {
  if (!cmd.forQuery) prepare(cmd);
}

function prepare(cmd: Command): Prepared {
  const byId = preparedById.get(cmd.id);
  if (byId?.cmd === cmd) return byId;
  const source = displayText(cmd);
  if (
    byId &&
    byId.source === source &&
    byId.subtitle === cmd.subtitle &&
    sameKeywords(byId.keywords, cmd.keywords)
  ) {
    byId.cmd = cmd;
    return byId;
  }
  builds++;
  const p = build(source, cmd.subtitle, cmd.keywords, cmd);
  preparedById.set(cmd.id, p);
  return p;
}

function build(source: string, subtitle: string | undefined, keywords: string[] | undefined, cmd: Command | null): Prepared {
  const starts: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source.charAt(i);
    if (SEPARATORS.has(c)) continue;
    const prev = i > 0 ? source.charAt(i - 1) : '';
    if (i === 0 || SEPARATORS.has(prev) || (isLower(prev) && isUpper(c))) {
      starts.push(i);
    }
  }
  return {
    text: lowerKeepingLength(source),
    starts,
    sub: subtitle?.toLowerCase() ?? '',
    kw: (keywords ?? []).join(' ').toLowerCase(),
    cmd,
    source,
    subtitle,
    keywords,
  };
}

// ── Matching ─────────────────────────────────────────────────────────────────

/** The class of `token` against `p`, its ranges pushed to `out` when given; -1 for no match. */
function matchToken(p: Prepared, token: string, out: Range[] | null): number {
  const { text, starts } = p;
  const len = token.length;
  const first = text.indexOf(token);
  if (first !== -1) {
    if (len === text.length) {
      out?.push([0, len]);
      return EXACT;
    }
    let wordAt = -1;
    for (let i = first; i !== -1; i = text.indexOf(token, i + 1)) {
      if (!p.starts.includes(i)) continue;
      if (isSegmentStart(text, i) && isSegmentEnd(text, i + len)) {
        out?.push([i, i + len]);
        return EXACT;
      }
      if (wordAt === -1) wordAt = i;
    }
    if (wordAt !== -1) {
      out?.push([wordAt, wordAt + len]);
      return WORD_START;
    }
  }
  if (len >= 2) {
    for (let k = 0; k + len <= starts.length; k++) {
      let all = true;
      for (let i = 0; i < len; i++) {
        if (text.charAt(starts[k + i]!) !== token.charAt(i)) {
          all = false;
          break;
        }
      }
      if (all) {
        for (let i = 0; i < len; i++) out?.push([starts[k + i]!, starts[k + i]! + 1]);
        return INITIALS;
      }
    }
  }
  if (first !== -1) {
    out?.push([first, first + len]);
    return SUBSTRING;
  }
  if (p.sub.includes(token) || p.kw.includes(token)) return KEYWORD;
  // A one-character subsequence is a substring, which already missed.
  if (len >= 2) {
    const at: number[] = [];
    let from = 0;
    for (const ch of token) {
      from = text.indexOf(ch, from);
      if (from === -1) return -1;
      at.push(from);
      from += 1;
    }
    for (const i of at) out?.push([i, i + 1]);
    return SUBSEQUENCE;
  }
  return -1;
}

function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length < 2) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Range[] = [[ranges[0]![0], ranges[0]![1]]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1]!;
    const [s, e] = ranges[i]!;
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/**
 * A matched row. Its ranges are worked out when first read, so ranking 50,000
 * matches does not build 50,000 range lists nobody looks at.
 */
class MatchedRow implements RankedRow {
  readonly cmd: Command;
  readonly recent: boolean;
  readonly cls: MatchClass;
  readonly action: ObjectAction | undefined;
  private readonly tokens: string[];
  private computed: Range[] | undefined;
  private computedSub: Range[] | undefined;

  constructor(cmd: Command, recent: boolean, cls: MatchClass, tokens: string[], action: ObjectAction | undefined) {
    this.cmd = cmd;
    this.recent = recent;
    this.cls = cls;
    this.tokens = tokens;
    this.action = action;
  }

  get ranges(): Range[] {
    if (!this.computed) this.compute();
    return this.computed!;
  }

  get subtitleRanges(): Range[] {
    if (!this.computedSub) this.compute();
    return this.computedSub!;
  }

  /**
   * Both range lists at once. A token the title matched only as a keyword is
   * looked for in the subtitle, the only one of the two the row shows; one
   * found in a hidden keyword alone has nothing to emphasise.
   */
  private compute(): void {
    const out: Range[] = [];
    const sub: Range[] = [];
    const p = prepare(this.cmd);
    // Keeps the length, so a range read here lands on the subtitle as shown.
    const subtitle = lowerKeepingLength(this.cmd.subtitle ?? '');
    for (const token of this.tokens) {
      if (matchToken(p, token, out) !== KEYWORD) continue;
      const at = subtitle.indexOf(token);
      if (at !== -1) sub.push([at, at + token.length]);
    }
    this.computed = mergeRanges(out);
    this.computedSub = mergeRanges(sub);
  }
}

// Sort keys pack (class, recency, text length, registration index) into one
// number below 2^53, so 50,000 rows sort as a typed array rather than through
// a comparator.
const INDEX_BITS = 24;
const INDEX_SPAN = 2 ** INDEX_BITS;
const LENGTH_SPAN = 1024;
const RECENT_SPAN = 16;
const NOT_RECENT = RECENT_SPAN - 1;
const MAX_COMMANDS = INDEX_SPAN;

interface Prepass {
  trimmed: string;
  visible: Command[];
  recentAt: Map<string, number>;
  verb: VerbQuery | null;
}

function prepass(
  all: Command[],
  query: string,
  ctx: PaletteContext,
  recentIds: string[],
  verb: VerbQuery | null = null,
): Prepass {
  const visible = all.filter((cmd) => isVisible(cmd, ctx));
  if (visible.length > MAX_COMMANDS) {
    throw new Error(`rankCommands: ${visible.length} commands exceed the ${MAX_COMMANDS} the sort key holds`);
  }
  const recentAt = new Map<string, number>();
  recentIds.forEach((id, i) => {
    if (!recentAt.has(id)) recentAt.set(id, i);
  });
  return { trimmed: query.trim(), visible, recentAt, verb };
}

/** The empty-query list: recent rows in MRU order, then the catalog in registration order. */
function emptyQueryRows({ visible }: Prepass, recentIds: string[]): RankedRow[] {
  // Hidden from the catalog only: a recently used one still shows as Recent.
  const byId = new Map(visible.map((cmd) => [cmd.id, cmd]));
  const out: RankedRow[] = [];
  const seen = new Set<string>();
  for (const id of recentIds) {
    const cmd = byId.get(id);
    if (cmd && !cmd.forQuery && !seen.has(id)) {
      out.push({ cmd, recent: true, cls: null, ranges: [], subtitleRanges: [] });
      seen.add(id);
    }
  }
  for (const cmd of visible) {
    if (cmd.hideWhenEmptyQuery || cmd.forQuery || seen.has(cmd.id)) continue;
    out.push({ cmd, recent: false, cls: null, ranges: [], subtitleRanges: [] });
  }
  return out;
}

interface Matches {
  tokens: string[];
  fromQuery: RankedRow[];
  /** Match class per position in `visible`, for matched positions. */
  classes: Uint8Array;
}

/**
 * Matches every visible command against the typed query, handing each match's
 * sort key to `onMatch`. Keys pack (class, recency, text length, registration
 * index): a smaller key ranks first.
 */
function matchTyped({ trimmed, visible, recentAt, verb }: Prepass, onMatch: (key: number, cmd: Command) => void): Matches {
  const tokens = trimmed.toLowerCase().split(/\s+/);
  const fromQuery: RankedRow[] = [];
  const classes = new Uint8Array(visible.length);
  visible.forEach((cmd, index) => {
    if (cmd.forQuery) {
      const row = cmd.forQuery(trimmed);
      if (row) {
        fromQuery.push({
          cmd: { ...cmd, title: row.title, subtitle: row.subtitle, perform: row.perform },
          recent: false,
          cls: null,
          ranges: [],
          subtitleRanges: [],
          fromQuery: row,
        });
      }
      return;
    }
    // A verb in the query lists the objects that have it, matched on what follows.
    if (verb && !verb.trailing && cmd.object && !verbAction(cmd, verb)) return;
    const p = prepare(cmd);
    let cls = EXACT;
    for (const token of tokensFor(cmd, tokens, verb)) {
      const c = matchToken(p, token, null);
      if (c === -1) return;
      if (c > cls) cls = c;
    }
    const pos = recentAt.get(cmd.id);
    const recency = pos === undefined ? NOT_RECENT : Math.min(pos, NOT_RECENT - 1);
    const length = Math.min(p.text.length, LENGTH_SPAN - 1);
    classes[index] = cls;
    onMatch(((cls * RECENT_SPAN + recency) * LENGTH_SPAN + length) * INDEX_SPAN + index, cmd);
  });
  return { tokens, fromQuery, classes };
}

/** The action a verb selects on an object row; undefined on a command or without a verb. */
function verbAction(cmd: Command, verb: VerbQuery | null): ObjectAction | undefined {
  if (!verb || !cmd.object) return undefined;
  return cmd.object.actions.find((a) => a.verb === verb.verb);
}

/** Commands match the whole query; objects with the verb's action, under a verb, the other tokens. */
function tokensFor(cmd: Command, tokens: string[], verb: VerbQuery | null): string[] {
  return verbAction(cmd, verb) ? verb!.rest : tokens;
}

/** The row a sort key names. */
function rowFor(key: number, { visible, verb }: Prepass, { classes, tokens }: Matches): RankedRow {
  const at = key % INDEX_SPAN;
  const recency = Math.floor(key / INDEX_SPAN / LENGTH_SPAN) % RECENT_SPAN;
  const cmd = visible[at]!;
  return new MatchedRow(
    cmd,
    recency !== NOT_RECENT,
    MATCH_CLASS[classes[at]!]!,
    tokensFor(cmd, tokens, verb),
    verbAction(cmd, verb),
  );
}

/**
 * Filter commands by `when(ctx)`, then rank by query (X07 §13.2). Every
 * whitespace-separated token must match; a row's class is its weakest token's.
 * Inside a class a recently used row comes first, then the shorter text, then
 * registration order. Returns every match: the palette reads `rankCapped`.
 */
export function rankCommands(
  all: Command[],
  query: string,
  ctx: PaletteContext,
  recentIds: string[],
): RankedRow[] {
  const pre = prepass(all, query, ctx, recentIds);
  if (!pre.trimmed) return emptyQueryRows(pre, recentIds);
  const keys = new Float64Array(pre.visible.length);
  let matched = 0;
  const m = matchTyped(pre, (key) => {
    keys[matched++] = key;
  });
  const rows: RankedRow[] = [...m.fromQuery];
  for (const key of keys.subarray(0, matched).sort()) rows.push(rowFor(key, pre, m));
  return rows;
}

// ── Kinds and capped ranking ─────────────────────────────────────────────────

/** What a row is, for the palette's scopes and its groups on a typed query. */
export type RowKind = ObjectKind | 'action';

/** A row's kind: its object's, or `action` for a command. */
export function kindOf(cmd: Command): RowKind {
  return cmd.object?.kind ?? 'action';
}

export interface Bucket {
  key: string;
  /** Its best rows, at most the cap, in rank order. */
  rows: RankedRow[];
  /** Every match the bucket holds, kept or not. */
  total: number;
}

export interface CappedRanking {
  /** Rows built from the query itself (the pasted `_id` row). */
  fromQuery: RankedRow[];
  /** Matches per kind, every kind counted whatever the buckets hold. */
  counts: Map<RowKind, number>;
  /** The buckets that matched, ordered by their best row. */
  buckets: Bucket[];
}

/** The `cap` smallest keys seen, kept sorted: partial selection, never a full sort. */
class TopKeys {
  readonly keys: Float64Array;
  size = 0;
  total = 0;

  constructor(cap: number) {
    this.keys = new Float64Array(cap);
  }

  offer(key: number): void {
    this.total++;
    const { keys } = this;
    let i = this.size;
    if (i === keys.length) {
      if (key >= keys[i - 1]!) return;
      i--;
    } else {
      this.size++;
    }
    while (i > 0 && keys[i - 1]! > key) {
      keys[i] = keys[i - 1]!;
      i--;
    }
    keys[i] = key;
  }
}

/**
 * Ranks as `rankCommands` does, but keeps only the `cap` best rows of each
 * bucket (X07 §13.7 rule 3): `bucketOf` names the bucket a kind's rows go to,
 * or null to count them without keeping any. Rows past the cap are counted,
 * never built. On an empty query the buckets hold the empty-query list in its
 * own order.
 */
export function rankCapped(
  all: Command[],
  query: string,
  ctx: PaletteContext,
  recentIds: string[],
  cap: number,
  bucketOf: (kind: RowKind) => string | null,
  verb: VerbQuery | null = null,
): CappedRanking {
  if (!(cap >= 1)) throw new Error(`rankCapped: the cap must be at least 1, got ${cap}`);
  const pre = prepass(all, query, ctx, recentIds, verb);
  const counts = new Map<RowKind, number>();
  const count = (kind: RowKind) => counts.set(kind, (counts.get(kind) ?? 0) + 1);

  if (!pre.trimmed) {
    const byKey = new Map<string, Bucket>();
    for (const row of emptyQueryRows(pre, recentIds)) {
      const kind = kindOf(row.cmd);
      count(kind);
      const key = bucketOf(kind);
      if (key === null) continue;
      let bucket = byKey.get(key);
      if (!bucket) byKey.set(key, (bucket = { key, rows: [], total: 0 }));
      bucket.total++;
      if (bucket.rows.length < cap) bucket.rows.push(row);
    }
    return { fromQuery: [], counts, buckets: [...byKey.values()] };
  }

  const tops = new Map<string, TopKeys>();
  const m = matchTyped(pre, (key, cmd) => {
    const kind = kindOf(cmd);
    count(kind);
    const name = bucketOf(kind);
    if (name === null) return;
    let top = tops.get(name);
    if (!top) tops.set(name, (top = new TopKeys(cap)));
    top.offer(key);
  });
  const ordered = [...tops.entries()].sort((a, b) => a[1].keys[0]! - b[1].keys[0]!);
  return {
    fromQuery: m.fromQuery,
    counts,
    buckets: ordered.map(([key, top]) => ({
      key,
      total: top.total,
      rows: Array.from(top.keys.subarray(0, top.size), (k) => rowFor(k, pre, m)),
    })),
  };
}

// The tab in front owns the first four; the empty palette lists them first.
const GROUP_PRIORITY: readonly CommandGroup[] = [
  'query',
  'view',
  'references',
  'aggregation',
  'workspace',
  'connection',
  'navigation',
  'general',
];

/**
 * Bucket the ranked rows into header groups: a row built from the query first,
 * then Recent (empty query only), then the groups: in `GROUP_PRIORITY` order on
 * an empty query, by their best row on a typed one.
 * Each row's `index` is its position in the displayed order, so the cursor
 * stays in lockstep with what is on screen.
 */
export function groupRows(rows: RankedRow[]): RenderGroup[] {
  // A typed query ranks rows across groups; the groups follow their best row,
  // so the first row drawn is the best match. Only the empty query has a fixed order.
  const typed = rows.some((row) => row.cls !== null);
  const queryRows: RankedRow[] = [];
  const recent: RankedRow[] = [];
  const byGroup = new Map<CommandGroup, RankedRow[]>();
  for (const row of rows) {
    if (row.fromQuery) queryRows.push(row);
    else if (row.recent && row.cls === null) recent.push(row);
    else {
      const list = byGroup.get(row.cmd.group) ?? [];
      list.push(row);
      byGroup.set(row.cmd.group, list);
    }
  }
  const out: RenderGroup[] = [];
  let index = 0;
  const push = (key: string, label: string, list: RankedRow[]) => {
    if (list.length === 0) return;
    out.push({ key, label, rows: list.map((row) => ({ cmd: row.cmd, index: index++, row })) });
  };
  push('pasted', QUERY_ROW_LABEL, queryRows);
  push('recent', RECENT_LABEL, recent);
  for (const g of typed ? byGroup.keys() : GROUP_PRIORITY) push(g, GROUP_LABEL[g], byGroup.get(g) ?? []);
  return out;
}

// ── Free text ────────────────────────────────────────────────────────────────

/**
 * Matches `query` against a short text with the palette's matcher, for lists
 * too small to cache (an object's actions). Returns the matched ranges, `[]`
 * for an empty query, or null when a token misses.
 */
export function matchText(text: string, query: string): Range[] | null {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];
  const p = build(text, undefined, undefined, null);
  const out: Range[] = [];
  for (const token of trimmed.split(/\s+/)) {
    if (matchToken(p, token, out) === -1) return null;
  }
  return mergeRanges(out);
}
