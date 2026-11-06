import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CompletionContext as RealCompletionContext,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { javascriptLanguage } from '@codemirror/lang-javascript';
import {
  mongoCompletionSource,
  mongoCompletions,
} from '../../src/components/scriptEditor/mongoCompletions';
import {
  invalidateSampleSchemaCache,
  setSampleSchemaCacheTtl,
} from '../../src/features/fieldSuggestions/sources';
import { api } from '../../src/api/atelier';
import { parsedJsState } from '../helpers/parsedState';

vi.mock('../../src/api/atelier', () => ({
  api: {
    meta: {
      sampleSchema: vi.fn(async () => ({
        docs: [
          { name: 'alice', age: 30, address: { city: 'NYC' } },
          { name: 'bob', age: 25, address: { city: 'SF' } },
        ],
      })),
    },
  },
  isIpcError: () => false,
}));

/**
 * The source only reads `matchBefore`, `pos`, and `explicit` off
 * CompletionContext. Build the smallest stub that satisfies that surface
 * so we can exercise the four completion branches without spinning up an
 * EditorState in node.
 */
function fakeCtx(line: string, opts: { explicit?: boolean } = {}): CompletionContext {
  const pos = line.length;
  return {
    pos,
    explicit: opts.explicit ?? false,
    matchBefore(re: RegExp): { from: number; to: number; text: string } | null {
      // Mirror CodeMirror's matchBefore: anchor regex at end-of-buffer.
      const sticky = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let match: RegExpExecArray | null = null;
      let probe: RegExpExecArray | null;
      sticky.lastIndex = 0;
      while ((probe = sticky.exec(line))) {
        if (probe.index + probe[0].length === pos) match = probe;
        if (probe.index === sticky.lastIndex) sticky.lastIndex++;
      }
      if (!match || match[0].length === 0) return null;
      return { from: match.index, to: match.index + match[0].length, text: match[0] };
    },
  } as unknown as CompletionContext;
}

function labels(result: CompletionResult | null): string[] {
  return result?.options.map((o) => o.label) ?? [];
}

describe('mongoCompletionSource', () => {
  const source = mongoCompletionSource({
    getCollections: () => ['users', 'orders', 'sessions'],
  });

  it('suggests collection names after `db.`', () => {
    const result = source(fakeCtx('db.')) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(labels(result)).toEqual(['users', 'orders', 'sessions']);
    expect(result!.from).toBe(3); // caret position; partial is empty
    expect(result!.validFor).toEqual(/^[\w$]*$/);
  });

  it('does not treat `dbx.` as a `db.<coll>` prefix', () => {
    // The collMatch regex is anchored with `^db\.` — a longer identifier
    // that merely starts with "db" must not match.
    const result = source(fakeCtx('dbx.')) as CompletionResult | null;
    expect(result).toBeNull();
  });

  it('replaces the partial token after `db.us`', () => {
    const result = source(fakeCtx('db.us')) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(labels(result)).toContain('users');
    expect(result!.from).toBe(3); // start of "us"
  });

  it('skips `db.<coll>` branch when the collection list is empty', () => {
    const empty = mongoCompletionSource({ getCollections: () => [] });
    const result = empty(fakeCtx('db.')) as CompletionResult | null;
    expect(result).toBeNull();
  });

  it('suggests collection methods after `db.users.`', () => {
    const result = source(fakeCtx('db.users.')) as CompletionResult | null;
    expect(result).not.toBeNull();
    const found = labels(result);
    expect(found).toEqual(expect.arrayContaining(['find', 'findOne', 'aggregate', 'insertOne', 'updateMany']));
    expect(result!.validFor).toEqual(/^[\w$]*$/);
  });

  it('does not treat a single-segment `db.users` as a method position', () => {
    // methodMatch requires two dots; one dot alone is the collection branch,
    // not the method branch — those two branches must stay distinct.
    const result = source(fakeCtx('db.users')) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(labels(result)).toEqual(['users', 'orders', 'sessions']);
  });

  it('narrows methods after `db.users.fin`', () => {
    const result = source(fakeCtx('db.users.fin')) as CompletionResult | null;
    expect(result).not.toBeNull();
    // Source returns the full list — CodeMirror filters by `validFor` /
    // prefix matching on the renderer side. Our contract is just the `from`.
    expect(result!.from).toBe('db.users.'.length);
    expect(labels(result)).toContain('find');
  });

  it('suggests MQL operators after `$`', () => {
    const result = source(fakeCtx('{ $')) as CompletionResult | null;
    expect(result).not.toBeNull();
    const found = labels(result);
    expect(found).toEqual(expect.arrayContaining(['$match', '$group', '$gte', '$in', '$or']));
    expect(result!.from).toBe(2); // start of `$`
    expect(result!.validFor).toEqual(/^\$[\w$]*$/);
  });

  it('does not treat a dotted `$op.sub` token as an operator position', () => {
    // The `$<op>` branch only fires when the whole matched token is exactly
    // `$…` with no dot path. Neither methodMatch/collMatch (no `db.`
    // prefix) nor the bare-identifier branch (also dot-free only) match
    // this token, so the result is null.
    const result = source(fakeCtx('$op.sub')) as CompletionResult | null;
    expect(result).toBeNull();
  });

  it('narrows operators after `$gr`', () => {
    const result = source(fakeCtx('$gr')) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(labels(result)).toContain('$group');
    expect(result!.from).toBe(0);
  });

  it('suggests sandbox globals on a bare identifier', () => {
    const result = source(fakeCtx('Obj')) as CompletionResult | null;
    expect(result).not.toBeNull();
    const found = labels(result);
    expect(found).toEqual(expect.arrayContaining(['db', 'ObjectId', 'EJSON', 'print', 'use', 'ISODate']));
    expect(result!.validFor).toEqual(/^[\w$]*$/);
  });

  it('returns null on whitespace without explicit trigger', () => {
    expect(source(fakeCtx('   '))).toBeNull();
  });

  it('returns globals on explicit Ctrl-Space at empty caret', () => {
    const result = source(fakeCtx('', { explicit: true })) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(labels(result)).toContain('db');
    expect(result!.from).toBe(0);
    expect(result!.validFor).toEqual(/^[\w$]*$/);
  });

  it('does not match methodMatch when "db." is not at the start of the token', () => {
    // methodMatch is anchored with `^db\.` — a leading extra character must
    // not let it match a `db.<coll>.<method>` substring anywhere inside.
    const result = source(fakeCtx('xdb.users.find')) as CompletionResult | null;
    expect(result).toBeNull();
  });

  it('does not match collMatch when "db." is not at the start of the token', () => {
    // Same anchor requirement as methodMatch, one level up: `xdb.users`
    // (single dot) must not be treated as `db.<partial coll>`.
    const result = source(fakeCtx('xdb.users')) as CompletionResult | null;
    expect(result).toBeNull();
  });

  it('does not match methodMatch or collMatch on a token with an extra path segment', () => {
    // `db.a.b.c` has three segments after `db`; neither the two-segment
    // methodMatch nor the one-segment collMatch may match a partial prefix
    // of it (that would require dropping their trailing `$` anchor).
    const result = source(fakeCtx('db.a.b.c')) as CompletionResult | null;
    expect(result).toBeNull();
  });

  it('does not treat a bare identifier containing "$" as an operator position', () => {
    // The `$<op>` branch requires the whole token to start with `$`
    // (`^\$[\w$]*$`) — `a$foo` must fall through to the bare-identifier
    // (globals) branch instead of the operator catalog.
    const result = source(fakeCtx('a$foo')) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(labels(result)).toContain('db');
    expect(labels(result)).not.toContain('$match');
  });
});

function realCtx(doc: string, cursor: string = '█'): CompletionContext {
  const pos = doc.indexOf(cursor);
  if (pos < 0) throw new Error(`cursor token ${cursor} not found in doc`);
  const stripped = doc.slice(0, pos) + doc.slice(pos + cursor.length);
  return new RealCompletionContext(parsedJsState(stripped), pos, false);
}

describe('mongoCompletionSource — field-position branch', () => {
  const source = mongoCompletionSource({
    getCollections: () => ['users', 'orders'],
    getFieldContext: () => ({ connectionId: 'c1', dbName: 'mydb' }),
  });

  beforeEach(() => {
    invalidateSampleSchemaCache();
    setSampleSchemaCacheTtl();
  });

  it('suggests fields inside db.users.find({ █ })', async () => {
    const result = (await source(realCtx('db.users.find({ █ })'))) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(labels(result)).toEqual(expect.arrayContaining(['name', 'age', 'address.city']));
    // Logical query operators are merged in alongside fields.
    expect(labels(result)).toEqual(expect.arrayContaining(['$or', '$and', '$nor', '$expr']));
    expect(result!.validFor).toEqual(/^[\w$.]*$/);
    // The connection/db/collection context passed to sampleSchemaSource must
    // be built from the caller's fieldCtx + the detected collection, not
    // left empty.
    expect(api.meta.sampleSchema).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'mydb',
      collection: 'users',
      size: 100,
    });
    // FIELD_SLOT_OPERATOR_COMPLETIONS is filtered down to
    // {$or,$and,$nor,$expr} — an operator outside that set (e.g. the
    // aggregation-stage `$match`) must not leak into the field-position
    // merge, or the filter would be a no-op.
    expect(labels(result)).not.toContain('$match');
  });

  it('suggests fields after a partial identifier', async () => {
    const result = (await source(realCtx('db.users.find({ na█ })'))) as CompletionResult | null;
    expect(result).not.toBeNull();
    // CodeMirror filters by `from`/`validFor` — our contract is the range.
    const text = 'db.users.find({ ';
    expect(result!.from).toBe(text.length);
    expect(labels(result)).toContain('name');
  });

  it('suggests fields inside aggregate $match stage', async () => {
    const result = (await source(
      realCtx('db.orders.aggregate([{ $match: { █ } }])'),
    )) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(labels(result)).toEqual(expect.arrayContaining(['name', 'age']));
  });

  it('suggests fields inside updateOne $set payload', async () => {
    const result = (await source(
      realCtx('db.users.updateOne({ a: 1 }, { $set: { █ } })'),
    )) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(labels(result)).toEqual(expect.arrayContaining(['name', 'age']));
  });

  it('suggests fields inside a nested $or array element', async () => {
    const result = (await source(
      realCtx('db.users.find({ $or: [{ █ }] })'),
    )) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(labels(result)).toEqual(expect.arrayContaining(['name', 'age']));
  });

  it('suggests fields inside an $elemMatch sub-filter', async () => {
    const result = (await source(
      realCtx('db.users.find({ tags: { $elemMatch: { █ } } })'),
    )) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(labels(result)).toEqual(expect.arrayContaining(['name', 'age']));
  });

  it('suggests fields inside $or nested under aggregate $match', async () => {
    const result = (await source(
      realCtx('db.orders.aggregate([{ $match: { $or: [{ █ }] } }])'),
    )) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(labels(result)).toEqual(expect.arrayContaining(['name', 'age']));
  });

  it('returns no field branch for the value slot', async () => {
    const result = await source(realCtx('db.users.find({ name: █ })'));
    // The field branch returns null; the source then falls through to other
    // branches. With cursor right after `:`, no other branch matches either.
    // Either way: no field suggestions.
    if (result) {
      expect(labels(result as CompletionResult)).not.toEqual(
        expect.arrayContaining(['name', 'age']),
      );
    }
  });

  it('returns no field branch for the top-level update document', async () => {
    // updateOne arg 1 keys are operators ($set/$inc/...), not field names.
    const result = await source(realCtx('db.users.updateOne({}, { █ })'));
    if (result) {
      const found = labels(result as CompletionResult);
      expect(found).not.toContain('name');
      expect(found).not.toContain('age');
    }
  });

  it('returns no field branch for the top-level aggregation stage object', async () => {
    // The outer `{ █ }` here is a stage spec; its keys are stage operators.
    const result = await source(realCtx('db.orders.aggregate([{ █ }])'));
    if (result) {
      const found = labels(result as CompletionResult);
      expect(found).not.toContain('name');
    }
  });

  it('skips field branch when there is no enclosing db.<coll> call', async () => {
    const result = await source(realCtx('const x = { █ }'));
    if (result) {
      const found = labels(result as CompletionResult);
      expect(found).not.toEqual(expect.arrayContaining(['name', 'age']));
    }
  });

  it('skips field branch when getFieldContext returns null', async () => {
    const noCtxSource = mongoCompletionSource({
      getCollections: () => [],
      getFieldContext: () => null,
    });
    const result = await noCtxSource(realCtx('db.users.find({ █ })'));
    // No field branch fires; the regex-based branches don't match an empty
    // slot either, so the source returns null.
    expect(result).toBeNull();
  });

  it('handles a string-literal property key', async () => {
    const result = (await source(
      realCtx('db.users.find({ "na█" })'),
    )) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(labels(result)).toContain('name');
    // Inside a string slot we don't merge operator suggestions.
    expect(labels(result)).not.toContain('$or');
    expect(result!.validFor).toEqual(/^[^"'\n]*$/);
  });
});

// ─── Catalog data — exact-match golden tests ────────────────────────────────
//
// The branch-level tests above only check that expected labels are present
// (`arrayContaining`), which proves the branches fire but never proves the
// exact `info`/`type`/`apply` text on each catalog entry — a typo or a
// deleted entry in COLLECTION_METHODS/GLOBALS wouldn't fail any of them.
// These pin the full catalogs exactly, mirroring their source declarations.

const EXPECTED_COLLECTION_METHOD_COMPLETIONS = [
  { label: 'find', type: 'method', info: 'find(filter, options) — returns a cursor', apply: 'find' },
  {
    label: 'findOne',
    type: 'method',
    info: 'findOne(filter, options) — returns a single doc',
    apply: 'findOne',
  },
  {
    label: 'aggregate',
    type: 'method',
    info: 'aggregate(pipeline, options) — returns a cursor',
    apply: 'aggregate',
  },
  {
    label: 'countDocuments',
    type: 'method',
    info: 'countDocuments(filter, options)',
    apply: 'countDocuments',
  },
  { label: 'count', type: 'method', info: 'alias for countDocuments', apply: 'count' },
  {
    label: 'estimatedDocumentCount',
    type: 'method',
    info: 'estimatedDocumentCount(options)',
    apply: 'estimatedDocumentCount',
  },
  {
    label: 'distinct',
    type: 'method',
    info: 'distinct(field, filter, options)',
    apply: 'distinct',
  },
  { label: 'insertOne', type: 'method', info: 'insertOne(doc, options)', apply: 'insertOne' },
  { label: 'insertMany', type: 'method', info: 'insertMany(docs, options)', apply: 'insertMany' },
  {
    label: 'updateOne',
    type: 'method',
    info: 'updateOne(filter, update, options)',
    apply: 'updateOne',
  },
  {
    label: 'updateMany',
    type: 'method',
    info: 'updateMany(filter, update, options)',
    apply: 'updateMany',
  },
  {
    label: 'replaceOne',
    type: 'method',
    info: 'replaceOne(filter, replacement, options)',
    apply: 'replaceOne',
  },
  { label: 'deleteOne', type: 'method', info: 'deleteOne(filter, options)', apply: 'deleteOne' },
  {
    label: 'deleteMany',
    type: 'method',
    info: 'deleteMany(filter, options)',
    apply: 'deleteMany',
  },
  {
    label: 'findOneAndUpdate',
    type: 'method',
    info: 'findOneAndUpdate(filter, update, options)',
    apply: 'findOneAndUpdate',
  },
  {
    label: 'findOneAndReplace',
    type: 'method',
    info: 'findOneAndReplace(filter, replacement, options)',
    apply: 'findOneAndReplace',
  },
  {
    label: 'findOneAndDelete',
    type: 'method',
    info: 'findOneAndDelete(filter, options)',
    apply: 'findOneAndDelete',
  },
  {
    label: 'bulkWrite',
    type: 'method',
    info: 'bulkWrite(operations, options)',
    apply: 'bulkWrite',
  },
  {
    label: 'createIndex',
    type: 'method',
    info: 'createIndex(spec, options)',
    apply: 'createIndex',
  },
  {
    label: 'createIndexes',
    type: 'method',
    info: 'createIndexes(specs, options)',
    apply: 'createIndexes',
  },
  { label: 'dropIndex', type: 'method', info: 'dropIndex(name, options)', apply: 'dropIndex' },
  { label: 'dropIndexes', type: 'method', info: 'dropIndexes(options)', apply: 'dropIndexes' },
  {
    label: 'listIndexes',
    type: 'method',
    info: 'listIndexes(options) — returns a cursor',
    apply: 'listIndexes',
  },
  {
    label: 'indexes',
    type: 'method',
    info: 'indexes(options) — returns array of index info',
    apply: 'indexes',
  },
  { label: 'indexExists', type: 'method', info: 'indexExists(name)', apply: 'indexExists' },
  { label: 'rename', type: 'method', info: 'rename(newName, options)', apply: 'rename' },
  {
    label: 'drop',
    type: 'method',
    info: 'drop(options) — drop the collection',
    apply: 'drop',
  },
  { label: 'stats', type: 'method', info: 'stats(options) — collection stats', apply: 'stats' },
  {
    label: 'watch',
    type: 'method',
    info: 'watch(pipeline, options) — change stream',
    apply: 'watch',
  },
  {
    label: 'mapReduce',
    type: 'method',
    info: 'mapReduce(map, reduce, options)',
    apply: 'mapReduce',
  },
];

const EXPECTED_GLOBAL_COMPLETIONS = [
  {
    label: 'db',
    type: 'variable',
    info: 'database proxy — `db.<collection>` to access a collection',
  },
  {
    label: 'use',
    type: 'function',
    info: 'use(name) — switch the db proxy to a different database',
  },
  { label: 'print', type: 'function', info: 'print(...args) — append to the print buffer' },
  { label: 'printjson', type: 'function', info: 'printjson(value) — print a value as EJSON' },
  { label: 'signal', type: 'variable', info: 'AbortSignal bound to the cancel token' },
  {
    label: 'console',
    type: 'variable',
    info: 'console.log / .error / .warn — pipe into the print buffer',
  },
  { label: 'EJSON', type: 'namespace', info: 'EJSON — bson Extended JSON serializer' },
  { label: 'ObjectId', type: 'class', info: 'new ObjectId(hexString?)' },
  { label: 'ISODate', type: 'function', info: 'ISODate(s?) — Date constructor mongosh-style' },
  { label: 'Long', type: 'class', info: 'bson Long (64-bit integer)' },
  { label: 'Decimal128', type: 'class', info: 'bson Decimal128' },
  { label: 'Double', type: 'class', info: 'bson Double' },
  { label: 'Int32', type: 'class', info: 'bson Int32' },
  { label: 'Binary', type: 'class', info: 'bson Binary' },
  { label: 'Code', type: 'class', info: 'bson Code' },
  { label: 'MaxKey', type: 'class', info: 'bson MaxKey' },
  { label: 'MinKey', type: 'class', info: 'bson MinKey' },
  { label: 'Timestamp', type: 'class', info: 'bson Timestamp' },
  { label: 'UUID', type: 'class', info: 'bson UUID' },
  { label: 'NumberLong', type: 'function', info: 'NumberLong(v) — Long.fromString' },
  {
    label: 'NumberDecimal',
    type: 'function',
    info: 'NumberDecimal(v) — Decimal128.fromString',
  },
  { label: 'NumberInt', type: 'function', info: 'NumberInt(v) — new Int32' },
];

describe('mongoCompletionSource — catalog exact match', () => {
  const source = mongoCompletionSource({
    getCollections: () => ['users'],
  });

  it('returns the exact COLLECTION_METHODS catalog after `db.users.`', () => {
    const result = source(fakeCtx('db.users.')) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(result!.options).toEqual(EXPECTED_COLLECTION_METHOD_COMPLETIONS);
  });

  it('returns the exact GLOBALS catalog on explicit Ctrl-Space at an empty caret', () => {
    const result = source(fakeCtx('', { explicit: true })) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(result!.options).toEqual(EXPECTED_GLOBAL_COMPLETIONS);
  });

  it('returns the exact GLOBALS catalog for a bare identifier', () => {
    const result = source(fakeCtx('Obj')) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(result!.options).toEqual(EXPECTED_GLOBAL_COMPLETIONS);
  });

  it('returns collection-name completions with type "class" and boost 1', () => {
    const result = source(fakeCtx('db.')) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(result!.options).toEqual([
      { label: 'users', type: 'class', boost: 1 },
    ]);
  });
});

describe('mongoCompletions extension', () => {
  it('registers mongoCompletionSource on the JavaScript language data facet', () => {
    // Use the bare `javascriptLanguage` (not the full `javascript()`
    // support bundle, which also wires its own local-completion source) so
    // the only 'autocomplete' provider active here is ours — an empty `{}`
    // extension (the mutant this guards against) would leave `sources`
    // empty.
    const state = EditorState.create({
      doc: 'db.',
      extensions: [javascriptLanguage, mongoCompletions({ getCollections: () => ['users'] })],
    });
    const sources = state.languageDataAt<
      (ctx: CompletionContext) => CompletionResult | Promise<CompletionResult | null> | null
    >('autocomplete', 3);
    expect(sources).toHaveLength(1);
    const result = sources[0](fakeCtx('db.')) as CompletionResult | null;
    expect(result).not.toBeNull();
    expect(labels(result)).toEqual(['users']);
  });
});

describe('fieldSuggestionsToCompletions boost — via the field-position branch', () => {
  const source = mongoCompletionSource({
    getCollections: () => [],
    getFieldContext: () => ({ connectionId: 'c1', dbName: 'mydb' }),
  });

  beforeEach(() => {
    invalidateSampleSchemaCache();
    setSampleSchemaCacheTtl();
  });

  it('clamps a field suggestion boost to 1 when frequency exceeds 50', async () => {
    // `alice`/`bob` fixtures each appear once per sampled doc across the two
    // docs in the mocked sampleSchema response, so `name`/`age` naturally
    // have a frequency of 2 → boost 2/50 = 0.04. Pin the exact boost rather
    // than just checking the label is present.
    const result = (await source(realCtx('db.users.find({ █ })'))) as CompletionResult | null;
    expect(result).not.toBeNull();
    const nameOption = result!.options.find((o) => o.label === 'name');
    expect(nameOption).toMatchObject({ label: 'name', type: 'property', detail: 'string' });
    expect(nameOption!.boost).toBeCloseTo(2 / 50, 5);
  });
});
