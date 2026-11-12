import type { ObjectKind } from './types';

// The verbs a query can start with (X07 §13.4): each with its aliases, and the
// past participle the verb line reads ("only things that can be deleted").

interface VerbSpec {
  verb: string;
  aliases: readonly string[];
  participle: string;
}

export const VERBS: readonly VerbSpec[] = [
  { verb: 'open', aliases: ['go', 'switch', 'show'], participle: 'opened' },
  { verb: 'edit', aliases: ['modify'], participle: 'edited' },
  { verb: 'delete', aliases: ['remove', 'drop'], participle: 'deleted' },
  { verb: 'close', aliases: [], participle: 'closed' },
  { verb: 'rename', aliases: [], participle: 'renamed' },
  { verb: 'run', aliases: ['execute'], participle: 'run' },
  { verb: 'query', aliases: ['find'], participle: 'queried' },
  { verb: 'filter', aliases: [], participle: 'filtered' },
  { verb: 'aggregate', aliases: ['pipeline'], participle: 'aggregated' },
  { verb: 'schema', aliases: ['structure'], participle: 'inspected' },
  { verb: 'indexes', aliases: ['index'], participle: 'indexed' },
  { verb: 'export', aliases: [], participle: 'exported' },
  { verb: 'import', aliases: [], participle: 'imported' },
  { verb: 'pin', aliases: ['unpin'], participle: 'pinned' },
  { verb: 'disconnect', aliases: [], participle: 'disconnected' },
];

let byWord: Map<string, VerbSpec> | null = null;

/** Verbs and aliases to their verb, built on first use. */
function lookup(word: string): VerbSpec | undefined {
  if (!byWord) {
    byWord = new Map();
    for (const spec of VERBS) {
      byWord.set(spec.verb, spec);
      for (const alias of spec.aliases) byWord.set(alias, spec);
    }
  }
  return byWord.get(word);
}

/** Verbs whose actions are destructive: their line and tags are drawn in red. */
const DESTRUCTIVE_VERBS = new Set(['delete']);

export interface ParsedVerb {
  /** The canonical verb: `delete`. */
  verb: string;
  /** The word as typed, lower case: `drop`. */
  typed: string;
  participle: string;
  destructive: boolean;
  /** The other tokens, lower case; empty for a verb typed alone. */
  rest: string[];
  /** Read from the last token rather than the first (`prod open`). */
  trailing: boolean;
}

/**
 * The query read as a verb and the other tokens, or null when it has none. The
 * verb is the first token, else the last (`prod open`, X07 §13.10): a name
 * typed first then its verb reads the same as the other way round. A single
 * token is only ever a leading verb, so a lone word has nothing to follow it.
 */
export function parseVerb(query: string): ParsedVerb | null {
  const tokens = query.trim().toLowerCase().split(/\s+/);
  let typed = tokens[0]!;
  let spec = lookup(typed);
  let rest = tokens.slice(1);
  const trailing = !spec;
  if (trailing) {
    // With one token the last is the first, which already missed.
    typed = tokens[tokens.length - 1]!;
    spec = lookup(typed);
    rest = tokens.slice(0, -1);
  }
  if (!spec) return null;
  return {
    verb: spec.verb,
    typed,
    participle: spec.participle,
    destructive: DESTRUCTIVE_VERBS.has(spec.verb),
    rest,
    trailing,
  };
}

/** `open` → `Open`. */
export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Kinds in the order a verb alone lists them, with the noun and where each row leads. */
export const VERB_KINDS: readonly { kind: Exclude<ObjectKind, 'database'>; noun: string; destination: string }[] = [
  { kind: 'collection', noun: 'a collection', destination: 'Collections scope ›' },
  { kind: 'connection', noun: 'a connection', destination: 'All, connections only ›' },
  { kind: 'tab', noun: 'a tab', destination: 'Tabs scope ›' },
  { kind: 'saved', noun: 'a saved query', destination: 'Saved scope ›' },
];

/** The verb line under the scope row: `Read as the verb delete (from "drop"): …`, in its three parts. */
export function verbLine(parsed: ParsedVerb): { before: string; verb: string; after: string } {
  const from = parsed.typed === parsed.verb ? '' : ` (from “${parsed.typed}”)`;
  return {
    before: 'Read as the verb ',
    verb: parsed.verb,
    after: `${from}: only things that can be ${parsed.participle} are listed`,
  };
}
