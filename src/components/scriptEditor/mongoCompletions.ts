import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { javascriptLanguage } from '@codemirror/lang-javascript';
import type { Extension } from '@codemirror/state';
import { OPERATORS, type OperatorDef } from '../../features/fieldSuggestions/operators';
import { sampleSchemaSource } from '../../features/fieldSuggestions/sources';
import type { FieldSuggestion } from '../../features/fieldSuggestions/types';
import { detectFieldPosition } from './fieldPositionDetector';
import { logFailure } from '../../utils/rendererLog';

/**
 * Collection methods exposed via the `db.<coll>` proxy in `ScriptService`.
 * Mirrors the public surface of the MongoDB driver `Collection` plus the
 * mongosh-flavoured aliases the proxy honours (`count` → `countDocuments`).
 *
 * `info` doubles as the popover detail text.
 */
const COLLECTION_METHODS: ReadonlyArray<{ name: string; info: string }> = [
  { name: 'find', info: 'find(filter, options) — returns a cursor' },
  { name: 'findOne', info: 'findOne(filter, options) — returns a single doc' },
  { name: 'aggregate', info: 'aggregate(pipeline, options) — returns a cursor' },
  { name: 'countDocuments', info: 'countDocuments(filter, options)' },
  { name: 'count', info: 'alias for countDocuments' },
  { name: 'estimatedDocumentCount', info: 'estimatedDocumentCount(options)' },
  { name: 'distinct', info: 'distinct(field, filter, options)' },
  { name: 'insertOne', info: 'insertOne(doc, options)' },
  { name: 'insertMany', info: 'insertMany(docs, options)' },
  { name: 'updateOne', info: 'updateOne(filter, update, options)' },
  { name: 'updateMany', info: 'updateMany(filter, update, options)' },
  { name: 'replaceOne', info: 'replaceOne(filter, replacement, options)' },
  { name: 'deleteOne', info: 'deleteOne(filter, options)' },
  { name: 'deleteMany', info: 'deleteMany(filter, options)' },
  { name: 'findOneAndUpdate', info: 'findOneAndUpdate(filter, update, options)' },
  { name: 'findOneAndReplace', info: 'findOneAndReplace(filter, replacement, options)' },
  { name: 'findOneAndDelete', info: 'findOneAndDelete(filter, options)' },
  { name: 'bulkWrite', info: 'bulkWrite(operations, options)' },
  { name: 'createIndex', info: 'createIndex(spec, options)' },
  { name: 'createIndexes', info: 'createIndexes(specs, options)' },
  { name: 'dropIndex', info: 'dropIndex(name, options)' },
  { name: 'dropIndexes', info: 'dropIndexes(options)' },
  { name: 'listIndexes', info: 'listIndexes(options) — returns a cursor' },
  { name: 'indexes', info: 'indexes(options) — returns array of index info' },
  { name: 'indexExists', info: 'indexExists(name)' },
  { name: 'rename', info: 'rename(newName, options)' },
  { name: 'drop', info: 'drop(options) — drop the collection' },
  { name: 'stats', info: 'stats(options) — collection stats' },
  { name: 'watch', info: 'watch(pipeline, options) — change stream' },
  { name: 'mapReduce', info: 'mapReduce(map, reduce, options)' },
];

/**
 * Globals injected into the vm sandbox by `ScriptService`. Kept in sync with
 * the `sandbox` object there. `info` shows in the completion popover.
 */
const GLOBALS: ReadonlyArray<{ name: string; type: Completion['type']; info: string }> = [
  { name: 'db', type: 'variable', info: 'database proxy — `db.<collection>` to access a collection' },
  { name: 'use', type: 'function', info: 'use(name) — switch the db proxy to a different database' },
  { name: 'print', type: 'function', info: 'print(...args) — append to the print buffer' },
  { name: 'printjson', type: 'function', info: 'printjson(value) — print a value as EJSON' },
  { name: 'signal', type: 'variable', info: 'AbortSignal bound to the cancel token' },
  { name: 'console', type: 'variable', info: 'console.log / .error / .warn — pipe into the print buffer' },
  { name: 'EJSON', type: 'namespace', info: 'EJSON — bson Extended JSON serializer' },
  { name: 'ObjectId', type: 'class', info: 'new ObjectId(hexString?)' },
  { name: 'ISODate', type: 'function', info: 'ISODate(s?) — Date constructor mongosh-style' },
  { name: 'Long', type: 'class', info: 'bson Long (64-bit integer)' },
  { name: 'Decimal128', type: 'class', info: 'bson Decimal128' },
  { name: 'Double', type: 'class', info: 'bson Double' },
  { name: 'Int32', type: 'class', info: 'bson Int32' },
  { name: 'Binary', type: 'class', info: 'bson Binary' },
  { name: 'Code', type: 'class', info: 'bson Code' },
  { name: 'MaxKey', type: 'class', info: 'bson MaxKey' },
  { name: 'MinKey', type: 'class', info: 'bson MinKey' },
  { name: 'Timestamp', type: 'class', info: 'bson Timestamp' },
  { name: 'UUID', type: 'class', info: 'bson UUID' },
  { name: 'NumberLong', type: 'function', info: 'NumberLong(v) — Long.fromString' },
  { name: 'NumberDecimal', type: 'function', info: 'NumberDecimal(v) — Decimal128.fromString' },
  { name: 'NumberInt', type: 'function', info: 'NumberInt(v) — new Int32' },
];

const METHOD_COMPLETIONS: readonly Completion[] = COLLECTION_METHODS.map((m) => ({
  label: m.name,
  type: 'method',
  info: m.info,
  apply: m.name,
}));

const GLOBAL_COMPLETIONS: readonly Completion[] = GLOBALS.map((g) => ({
  label: g.name,
  type: g.type,
  info: g.info,
}));

/**
 * One catalog entry per unique operator name. The OPERATORS array contains
 * duplicates (e.g. `$type` appears as both query and aggregation); we collapse
 * by name and prefer the entry that carries a description, so the popover
 * surfaces the richest summary available.
 */
const OPERATOR_COMPLETIONS: readonly Completion[] = (() => {
  const byName = new Map<string, OperatorDef>();
  for (const op of OPERATORS) {
    const existing = byName.get(op.name);
    if (!existing || (!existing.description && op.description)) {
      byName.set(op.name, op);
    }
  }
  return [...byName.values()].map((op) => ({
    label: op.name,
    type: 'keyword',
    detail: op.class,
    info: op.summary ?? op.description ?? undefined,
  }));
})();

/**
 * Logical query operators that are valid as keys in a filter object alongside
 * field names — surfaced inside the field-position branch so the user can
 * pick `$or` without having to type `$` first.
 */
const FIELD_SLOT_OPERATORS: ReadonlySet<string> = new Set(['$or', '$and', '$nor', '$expr']);
const FIELD_SLOT_OPERATOR_COMPLETIONS: readonly Completion[] = OPERATOR_COMPLETIONS.filter(
  (c) => FIELD_SLOT_OPERATORS.has(c.label),
);

export interface MongoCompletionOpts {
  /**
   * Reads the latest collection-name list. Called on every completion attempt
   * — keep it cheap. Returning an empty array suppresses `db.<coll>`
   * completion, leaving CodeMirror's default JS source to handle it.
   */
  getCollections: () => readonly string[];
  /**
   * Reads the latest connection/db context for field-name completion.
   * Returning null disables the field-position branch (e.g., when the tab
   * has no active connection yet).
   */
  getFieldContext?: () => { connectionId: string; dbName: string } | null;
}

function fieldSuggestionsToCompletions(
  suggestions: readonly FieldSuggestion[],
): Completion[] {
  return suggestions.map<Completion>((s) => ({
    label: s.path,
    type: 'property',
    detail: s.type,
    boost: Math.min(s.frequency ?? 0, 50) / 50,
  }));
}

/**
 * CodeMirror completion source for the W12 script editor. Layered:
 *
 *   1. field-position keys   → sampled field names (from sampleSchemaSource)
 *   2. `db.<coll>.<method>`  → driver method names
 *   3. `db.<word>`           → live collection names (from getCollections)
 *   4. `$<word>`             → MQL operators (from `OPERATORS` catalog)
 *   5. bare identifier       → sandbox globals (db, EJSON, ObjectId, …)
 *
 * Each branch returns its own `from` so CodeMirror replaces the right token.
 * Returning `null` lets the default JS source handle JS keywords/locals.
 */
export function mongoCompletionSource(
  opts: MongoCompletionOpts,
): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | Promise<CompletionResult | null> | null => {
    // Field-position branch first — runs off the syntax tree, so it works
    // even when matchBefore would return null (cursor in whitespace inside
    // an empty filter object).
    const fieldCtx = opts.getFieldContext?.();
    if (fieldCtx) {
      const slot = detectFieldPosition(ctx.state, ctx.pos);
      if (slot) {
        const suggestionCtx = {
          connectionId: fieldCtx.connectionId,
          dbName: fieldCtx.dbName,
          collection: slot.collection,
        };
        const validFor = slot.insideString ? /^[^"'\n]*$/ : /^[\w$.]*$/;
        return Promise.resolve(sampleSchemaSource(suggestionCtx)).then(
          (suggestions): CompletionResult => {
            const fields = suggestions.filter((s): s is FieldSuggestion => s.kind === 'field');
            const fieldOptions = fieldSuggestionsToCompletions(fields);
            const options: Completion[] = slot.insideString
              ? fieldOptions
              : [...fieldOptions, ...FIELD_SLOT_OPERATOR_COMPLETIONS];
            return {
              from: slot.from,
              to: slot.to,
              options,
              validFor,
            };
          },
          (err) => {
            logFailure('completing field names', err);
            return null;
          },
        );
      }
    }

    // Match characters that can appear in `db.coll.method` or `$op` —
    // letters, digits, `_`, `$`, `.`. Stops at whitespace/punctuation.
    const match = ctx.matchBefore(/[\w$.]+/);
    if (!match) {
      // Allow explicit Ctrl-Space at an empty caret to surface globals.
      if (ctx.explicit) {
        return {
          from: ctx.pos,
          options: GLOBAL_COMPLETIONS as Completion[],
          validFor: /^[\w$]*$/,
        };
      }
      return null;
    }
    const text = match.text;

    // db.<coll>.<method>
    const methodMatch = /^db\.([\w$]+)\.([\w$]*)$/.exec(text);
    if (methodMatch) {
      const partial = methodMatch[2];
      return {
        from: match.to - partial.length,
        options: METHOD_COMPLETIONS as Completion[],
        validFor: /^[\w$]*$/,
      };
    }

    // db.<coll>
    const collMatch = /^db\.([\w$]*)$/.exec(text);
    if (collMatch) {
      const partial = collMatch[1];
      const colls = opts.getCollections();
      if (colls.length === 0) return null;
      return {
        from: match.to - partial.length,
        options: colls.map<Completion>((name) => ({
          label: name,
          type: 'class',
          boost: 1,
        })),
        validFor: /^[\w$]*$/,
      };
    }

    // $<op> — operator names. Only fire when the prefix is exactly `$…`
    // (no dot path), otherwise we'd cover `db.$op` which isn't meaningful.
    if (/^\$[\w$]*$/.test(text)) {
      return {
        from: match.from,
        options: OPERATOR_COMPLETIONS as Completion[],
        validFor: /^\$[\w$]*$/,
      };
    }

    // Bare identifier — only suggest globals when there's no dot. CodeMirror's
    // default JS source still runs, so JS keywords/locals merge in alongside.
    if (/^[\w$]+$/.test(text)) {
      return {
        from: match.from,
        options: GLOBAL_COMPLETIONS as Completion[],
        validFor: /^[\w$]*$/,
      };
    }

    return null;
  };
}

/**
 * CodeMirror extension that registers the Mongo completion source on the
 * JavaScript language. Default JS keyword/scope completions still apply;
 * results are merged by the autocomplete extension.
 */
export function mongoCompletions(opts: MongoCompletionOpts): Extension {
  return javascriptLanguage.data.of({
    autocomplete: mongoCompletionSource(opts),
  });
}
