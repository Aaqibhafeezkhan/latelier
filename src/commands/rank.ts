import {
  GROUP_LABEL,
  GROUP_ORDER,
  type Command,
  type CommandGroup,
  type PaletteContext,
} from './types';

export const RECENT_LABEL = 'Recent';

export interface RankedRow {
  cmd: Command;
  bucket: 'recent' | 'prefix' | 'substring' | 'keyword' | 'fuzzy';
}

export interface RenderGroup {
  key: string;
  label: string;
  rows: { cmd: Command; index: number }[];
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

/** True when every character of `needle` appears in `haystack`, in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const ch of needle) {
    at = haystack.indexOf(ch, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}

/**
 * Filter commands by `when(ctx)`, then rank by query against title/subtitle/
 * keywords. Recent commands win over query-based buckets so a freshly-used
 * command stays one keystroke away.
 */
export function rankCommands(
  all: Command[],
  query: string,
  ctx: PaletteContext,
  recentIds: string[],
): RankedRow[] {
  const q = query.trim().toLowerCase();
  const recentSet = new Set(recentIds);
  const visible = all.filter((cmd) => isVisible(cmd, ctx));

  if (!q) {
    // Hidden from the catalog only: a recently used one still shows as Recent.
    const listed = visible.filter((cmd) => !cmd.hideWhenEmptyQuery);
    const visibleById = new Map(visible.map((cmd) => [cmd.id, cmd]));
    const out: RankedRow[] = [];
    const seen = new Set<string>();
    for (const id of recentIds) {
      const cmd = visibleById.get(id);
      if (cmd) {
        out.push({ cmd, bucket: 'recent' });
        seen.add(id);
      }
    }
    for (const cmd of listed) {
      if (!seen.has(cmd.id)) out.push({ cmd, bucket: 'substring' });
    }
    return out;
  }

  // A subsequence of one character is a substring, so a single key never
  // reaches the fuzzy bucket and needs no length guard of its own.
  const compact = q.replace(/\s/g, '');
  const rows: RankedRow[] = [];
  for (const cmd of visible) {
    const title = cmd.title.toLowerCase();
    const subtitle = cmd.subtitle?.toLowerCase() ?? '';
    const keywords = (cmd.keywords ?? []).join(' ').toLowerCase();
    let bucket: RankedRow['bucket'] | null = null;
    if (title.startsWith(q)) bucket = 'prefix';
    else if (title.includes(q)) bucket = 'substring';
    else if (subtitle.includes(q) || keywords.includes(q)) bucket = 'keyword';
    else if (isSubsequence(compact, (cmd.fuzzyText ?? cmd.title).toLowerCase())) bucket = 'fuzzy';
    if (bucket === null) continue;
    if (recentSet.has(cmd.id)) bucket = 'recent';
    rows.push({ cmd, bucket });
  }
  const order: Record<RankedRow['bucket'], number> = {
    recent: 0,
    prefix: 1,
    substring: 2,
    keyword: 3,
    fuzzy: 4,
  };
  rows.sort((a, b) => order[a.bucket] - order[b.bucket]);
  return rows;
}

/**
 * Bucket the ranked rows into header groups. Recent rows render first under a
 * dedicated header; the rest follow `GROUP_ORDER`. Each row carries its
 * original ranked-list index so the cursor can stay in lockstep with key
 * navigation.
 */
export function groupRows(rows: RankedRow[]): RenderGroup[] {
  const recent: RenderGroup = { key: 'recent', label: RECENT_LABEL, rows: [] };
  const byGroup = new Map<CommandGroup, RenderGroup>();
  rows.forEach(({ cmd, bucket }, index) => {
    if (bucket === 'recent') {
      recent.rows.push({ cmd, index });
      return;
    }
    let g = byGroup.get(cmd.group);
    if (!g) {
      g = { key: cmd.group, label: GROUP_LABEL[cmd.group], rows: [] };
      byGroup.set(cmd.group, g);
    }
    g.rows.push({ cmd, index });
  });
  const out: RenderGroup[] = [];
  if (recent.rows.length > 0) out.push(recent);
  for (const g of GROUP_ORDER) {
    const r = byGroup.get(g);
    if (r) out.push(r);
  }
  return out;
}
