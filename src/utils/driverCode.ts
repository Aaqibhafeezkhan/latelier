import { isEjsonDocument, isExactSentinel } from './ejson';
import { parseJsonKeepingBigInts } from './bigIntJson';

/**
 * Copy as code (#23): a find or an aggregate as a snippet for mongosh, the
 * Node.js driver or PyMongo.
 *
 * Inputs are Canonical EJSON text. That is not shell syntax: pasted into
 * mongosh, `{"$oid": "…"}` reads as an unknown query operator, and a bare
 * `9007199254740993` rounds. So each exact sentinel travels as a string
 * literal through the language's own EJSON parser, which keeps its BSON type,
 * and everything else is a plain literal.
 *
 * Only the sentinel, never the whole document: the drivers' parsers revive
 * looser shapes than the app does — bson's EJSON.parse turns
 * `{"$regex": "^A", "$ne": "x"}` into a regex and drops `$ne`, where the app's
 * `ejsonParse` keeps that operator document.
 */
export type CodeLang = 'mongosh' | 'node' | 'python';

export const CODE_LANGS: readonly { lang: CodeLang; label: string }[] = [
  { lang: 'mongosh', label: 'mongosh' },
  { lang: 'node', label: 'Node.js' },
  { lang: 'python', label: 'Python' },
];

/**
 * The find as run. Of the find options (W14 §9) only the collation and the
 * hint are carried: a collation changes which documents match, and the hint
 * goes with it as the plan the screen was produced by. `maxTimeMS` and the
 * read preference change neither the documents nor their order, and a pasted
 * snippet runs in a session with its own, so they are left out.
 */
export interface FindCodeInput {
  collection: string;
  filter: string;
  projection?: string;
  sort?: string;
  collation?: string;
  hint?: string;
  skip: number;
  limit: number;
}

export interface AggregateCodeInput {
  collection: string;
  pipelineJson: string;
}

/**
 * A JSON string literal: also a valid JavaScript and Python string literal,
 * since JSON.stringify escapes quotes, backslashes and control characters.
 */
const str = (s: string): string => JSON.stringify(s);

type Syntax = {
  nul: string;
  yes: string;
  no: string;
  negZero: string;
  inf: string;
  negInf: string;
  key: (k: string) => string;
  sentinel: (json: string) => string;
};

const JS: Syntax = {
  nul: 'null',
  yes: 'true',
  no: 'false',
  negZero: '-0',
  inf: 'Infinity',
  negInf: '-Infinity',
  // `"__proto__": v` in an object literal sets the prototype instead of adding
  // the field; a computed key adds it.
  key: (k) => (k === '__proto__' ? `[${str(k)}]` : str(k)),
  sentinel: (json) => `EJSON.parse(${str(json)}, { relaxed: false })`,
};
const PY: Syntax = {
  nul: 'None',
  yes: 'True',
  no: 'False',
  negZero: '-0.0',
  // A JSON number past the double range parses to ±Infinity; Python has no
  // `Infinity` name, so the bare spelling would raise NameError.
  inf: "float('inf')",
  negInf: "float('-inf')",
  key: str,
  sentinel: (json) => `json_util.loads(${str(json)})`,
};

/** A JSON value as a literal, every exact sentinel through the driver's parser. */
function literal(node: unknown, syn: Syntax): string {
  if (node === null) return syn.nul;
  if (typeof node === 'boolean') return node ? syn.yes : syn.no;
  if (typeof node === 'number') {
    if (Object.is(node, -0)) return syn.negZero;
    if (node === Infinity) return syn.inf;
    if (node === -Infinity) return syn.negInf;
    return String(node);
  }
  if (typeof node === 'string') return str(node);
  if (Array.isArray(node)) return `[${node.map((v) => literal(v, syn)).join(',')}]`;
  const obj = node as Record<string, unknown>;
  if (isExactSentinel(obj)) return plainNumber(obj) ?? syn.sentinel(JSON.stringify(obj));
  return `{${Object.entries(obj).map(([k, v]) => `${syn.key(k)}:${literal(v, syn)}`).join(',')}}`;
}

/**
 * A number sentinel both languages already send as that type, as a bare
 * number: every driver encodes an int32-range integer as Int32 and a
 * fractional number as Double. An integral `$numberDouble` stays a sentinel,
 * since a bare `1` would go out as an Int32.
 */
function plainNumber(obj: Record<string, unknown>): string | null {
  const int = String(obj.$numberInt);
  if (/^-?\d+$/.test(int)) return int;
  const dbl = Number(obj.$numberDouble);
  return Number.isFinite(dbl) && !Number.isInteger(dbl) ? String(dbl) : null;
}

/**
 * The parsed text, with any bare integer beyond 2^53 already a `$numberLong`
 * sentinel — the Long the app itself runs it as.
 */
const parse = (text: string): unknown => parseJsonKeepingBigInts(text);

const jsArg = (text: string): string => literal(parse(text), JS);
const pyArg = (text: string): string => literal(parse(text), PY);

/** The direction words a find sort accepts (`builder.ts`'s SORT_DIRECTIONS). */
const SORT_WORDS: Record<string, number> = { '1': 1, asc: 1, ascending: 1, '-1': -1, desc: -1, descending: -1 };

/**
 * PyMongo sends a string direction as is and the server refuses it, where the
 * Node driver maps "desc" to -1 itself. Only runs past `sortProblem`, so
 * every string is one of these words.
 */
function pySort(text: string): string {
  const doc = parse(text) as Record<string, unknown>;
  const dirs = Object.entries(doc).map(([k, v]) => [k, typeof v === 'string' ? SORT_WORDS[v.toLowerCase()] : v]);
  return literal(Object.fromEntries(dirs), PY);
}

/**
 * A hint that parses to a plain document is a key pattern, any other text an
 * index name — the rule main's `parseHint` runs the query by, so the snippet
 * names the index the screen used. Not "opens with `{`": a quoted `"{x"`
 * arrives here as the index name `{x`, and a sentinel such as `{"$oid":…}`
 * is no plain document.
 */
const isKeyPattern = isEjsonDocument;

export function findCode(lang: CodeLang, input: FindCodeInput): string {
  const { collection, filter, projection, sort, collation, hint, skip, limit } = input;
  // The driver reads limit 0 as "no limit": emitting one would paste an
  // unbounded cursor for a page the app shows as empty.
  if (limit <= 0) throw new Error(`findCode: limit must be positive, got ${limit}`);

  if (lang === 'mongosh') {
    let code = `db.getCollection(${str(collection)}).find(${jsArg(filter)}`;
    if (projection) code += `, ${jsArg(projection)}`;
    code += ')';
    if (sort) code += `.sort(${jsArg(sort)})`;
    if (collation) code += `.collation(${jsArg(collation)})`;
    if (hint) code += `.hint(${isKeyPattern(hint) ? jsArg(hint) : str(hint)})`;
    if (skip > 0) code += `.skip(${skip})`;
    return `${code}.limit(${limit})`;
  }

  if (lang === 'node') {
    const lines = [`const filter = ${jsArg(filter)};`];
    const opts: string[] = [];
    if (projection) {
      lines.push(`const projection = ${jsArg(projection)};`);
      opts.push('projection');
    }
    if (sort) {
      lines.push(`const sort = ${jsArg(sort)};`);
      opts.push('sort');
    }
    if (collation) {
      lines.push(`const collation = ${jsArg(collation)};`);
      opts.push('collation');
    }
    if (hint) {
      lines.push(`const hint = ${isKeyPattern(hint) ? jsArg(hint) : str(hint)};`);
      opts.push('hint');
    }
    if (skip > 0) opts.push(`skip: ${skip}`);
    opts.push(`limit: ${limit}`);
    lines.push(`const cursor = db.collection(${str(collection)}).find(filter, { ${opts.join(', ')} });`);
    return withEjsonImport(lines);
  }

  const lines = ['from bson import json_util', '', `query = ${pyArg(filter)}`];
  const args = ['query'];
  if (projection) {
    lines.push(`projection = ${pyArg(projection)}`);
    args.push('projection');
  }
  if (sort) {
    lines.push(`sort = list(${pySort(sort)}.items())`);
    args.push('sort=sort');
  }
  if (collation) {
    lines.push(`collation = ${pyArg(collation)}`);
    args.push('collation=collation');
  }
  if (hint) {
    // PyMongo refuses a dict as an index specifier, as it does for sort.
    lines.push(`hint = ${isKeyPattern(hint) ? `list(${pyArg(hint)}.items())` : str(hint)}`);
    args.push('hint=hint');
  }
  if (skip > 0) args.push(`skip=${skip}`);
  args.push(`limit=${limit}`);
  lines.push(`cursor = db[${str(collection)}].find(${args.join(', ')})`);
  return lines.join('\n');
}

/** Prefixes the bson import only when the snippet actually calls `EJSON.`. */
function withEjsonImport(lines: string[]): string {
  const body = lines.join('\n');
  return body.includes('EJSON.') ? `const { EJSON } = require('bson');\n\n${body}` : body;
}

export function aggregateCode(lang: CodeLang, input: AggregateCodeInput): string {
  const { collection, pipelineJson } = input;
  if (lang === 'mongosh') {
    return `db.getCollection(${str(collection)}).aggregate(${jsArg(pipelineJson)})`;
  }
  if (lang === 'node') {
    return withEjsonImport([
      `const pipeline = ${jsArg(pipelineJson)};`,
      `const cursor = db.collection(${str(collection)}).aggregate(pipeline);`,
    ]);
  }
  return [
    'from bson import json_util',
    '',
    `pipeline = ${pyArg(pipelineJson)}`,
    `cursor = db[${str(collection)}].aggregate(pipeline)`,
  ].join('\n');
}
