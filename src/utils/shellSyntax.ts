import { parseExpressionAt, type AnyNode, type Expression } from 'acorn';

/**
 * Shell Syntax → Canonical EJSON, as a *text* transform.
 *
 * ADR 0004 chose rewriting source spans over evaluating the AST into JavaScript
 * values. Evaluating loses integer precision silently: `9007199254740993`
 * becomes `…992` the instant it passes through a JS double, and the user gets
 * the wrong rows with no error. So every literal is copied from the source
 * characters, and nothing numeric is ever routed through `Number`.
 *
 * Because the transform splices spans instead of reprinting, the user's line
 * breaks and indentation survive a repair.
 */

export type RepairOutcome =
  | { kind: 'unchanged' }
  | { kind: 'repaired'; text: string }
  | { kind: 'failed'; reason: string; index?: number };

type Edit = { start: number; end: number; replacement: string };

class UnsupportedSyntax extends Error {
  index: number;

  constructor(reason: string, index: number) {
    super(reason);
    this.index = index;
  }
}

/**
 * mongosh value constructors that map to a single EJSON sentinel.
 *
 * No `ISODate` (or `Date`) entry: `sentinelText` special-cases both names
 * before this map is ever consulted (its own `$date` branch, allowNumber:
 * false), so an entry here would be dead — never read, and its removal
 * changes nothing about how `new Date(...)`/`ISODate(...)` are handled.
 */
const SENTINELS: Record<string, { key: string; numericArg: boolean }> = {
  ObjectId: { key: '$oid', numericArg: false },
  NumberLong: { key: '$numberLong', numericArg: true },
  NumberDecimal: { key: '$numberDecimal', numericArg: true },
  NumberInt: { key: '$numberInt', numericArg: true },
};

const NODE_LABELS: Record<string, string> = {
  MemberExpression: 'a property access',
  TemplateLiteral: 'a template literal',
  BinaryExpression: 'an arithmetic or comparison expression',
  ArrowFunctionExpression: 'a function',
  FunctionExpression: 'a function',
  SpreadElement: 'a spread element',
  ConditionalExpression: 'a conditional expression',
  AssignmentExpression: 'an assignment',
};

/**
 * Drop the `(line:column)` acorn appends to its own parse errors.
 *
 * Every other `reason` in this module carries no position, and `refusalMessage`
 * prefixes one derived from `index`. Left in place, acorn's suffix put a second
 * position in the same sentence disagreeing with the first by one, because
 * acorn counts columns from 0 and the displayed one counts from 1.
 *
 * The suffix is redundant, not merely noisy: acorn throws the same offset as
 * `err.pos`, which is what `index` already carries.
 */
function stripAcornPosition(message: string | undefined): string | undefined {
  // `trimEnd()` first, then a pattern whose only variable-length part is a
  // single optional space: `/\s*\(\d+:\d+\)\s*$/` had two unbounded `\s*`
  // runs and an unanchored start, which backtracks super-linearly (S8786).
  // acorn's own format is `message (line:col)`, one space, no trailing blanks.
  //
  // That last clause is why `trimEnd()` and the `?.` both carry surviving
  // mutants: acorn never emits a trailing blank and never throws without a
  // message, so swapping `trimEnd` for `trimStart` or dropping the optional
  // chaining cannot change any reachable result. Both are kept because the
  // `\s*$` they replaced did handle that shape, and dropping them would be a
  // quiet behaviour regression rather than a simplification. The intended
  // behaviour is pinned in `redos-rewrites.property.spec.ts`; no assertion is
  // bolted on here to force an unkillable mutant red.
  return message?.trimEnd().replace(/ ?\(\d+:\d+\)$/, '');
}

/**
 * Repairs Shell Syntax into Canonical EJSON, or explains why it cannot.
 *
 * Returns `unchanged` when the text already parses strictly — the repair rule
 * lives here so no call site re-implements it.
 */
export function repairToCanonicalEjson(text: string): RepairOutcome {
  if (text.trim() === '') return { kind: 'failed', reason: 'The input is empty.' };

  try {
    JSON.parse(text);
    return { kind: 'unchanged' };
  } catch {
    // Not Canonical EJSON yet — try to repair it.
  }
  // Strict JSON padded with Unicode spaces `JSON.parse` refuses (NBSP, BOM,
  // em space) repairs to the trimmed text byte for byte — the text the
  // filter's Run gate accepts and `currentFilterJson` sends — rather than to
  // `walk`'s re-rendering of it, which rewrites escapes like `\u00e9`.
  const trimmed = text.trim();
  if (parsesAsJson(trimmed)) return { kind: 'repaired', text: trimmed };

  let root: Expression;
  try {
    // Stryker disable next-line ObjectLiteral: the installed acorn version defaults to ecmaVersion 2020 when the option is omitted (verified with node: parseExpressionAt(text, 0, {}) throws/parses identically to passing `{ ecmaVersion: 2020 }` explicitly) — acorn only warns that omitting it will stop being allowed in a future release, it does not yet parse differently.
    root = parseExpressionAt(text, 0, { ecmaVersion: 2020 });
  } catch (e) {
    const err = e as { message?: string; pos?: number };
    return {
      kind: 'failed',
      // Stryker disable next-line StringLiteral: acorn always throws with a message for a real parse failure, so `stripAcornPosition` never returns undefined here in practice; the `?? '...'` fallback only guards against a malformed thrown value that isn't a real acorn error.
      reason: stripAcornPosition(err.message) ?? 'The text could not be read.',
      index: err.pos,
    };
  }

  // `{a: 1} nonsense` parses as a complete expression followed by junk. Fail
  // closed rather than silently querying only the part that parsed.
  if (root.end < text.trimEnd().length) {
    return { kind: 'failed', reason: 'There is unexpected text after the value.', index: root.end };
  }

  const edits: Edit[] = [];
  try {
    walk(root, text, edits);
  } catch (e) {
    // Stryker disable next-line ConditionalExpression: every `throw` reachable from `walk` (grepped across this file) constructs `UnsupportedSyntax`, so the `throw e` rethrow below is unreachable for any input today; it is kept so a future bug elsewhere in `walk` surfaces as a real crash instead of being mislabeled as a clean parse failure.
    if (e instanceof UnsupportedSyntax) return { kind: 'failed', reason: e.message, index: e.index };
    throw e;
  }

  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  }
  // Acorn skips the same Unicode spaces around Shell Syntax, so `{a: 1}`
  // padded with them repairs to trimmed text rather than failing the check
  // below. Only then: ASCII whitespace `JSON.parse` accepts stays as typed.
  if (!parsesAsJson(out)) out = out.trim();

  // Last line of defence: never hand back text the rest of the app cannot read.
  if (!parsesAsJson(out)) {
    return { kind: 'failed', reason: 'The text uses syntax this application does not support.' };
  }
  return { kind: 'repaired', text: out };
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
  } catch {
    return false;
  }
  return true;
}

/**
 * The blur/Run glue shared by every X14 consumer (T2 filter bar, T3 sort and
 * projection, T4 stage bodies).
 *
 * `commit` fires only for a real `repaired` outcome, so `unchanged` text is
 * never re-patched and stays byte-identical, and `failed` text is left exactly
 * as the user typed it. `text` is what the caller should act on right now —
 * a state patch is async, so a Run in the same tick has to use this rather
 * than re-read state.
 *
 * `outcome` is returned rather than swallowed: T5 needs the `reason`
 * and `index` to render the inline error.
 */
export function repairOnCommit(
  text: string,
  commit: (repaired: string) => void,
): { text: string; outcome: RepairOutcome } {
  const outcome = repairToCanonicalEjson(text);
  if (outcome.kind === 'repaired') {
    commit(outcome.text);
    return { text: outcome.text, outcome };
  }
  return { text, outcome };
}

/**
 * X14 §5 (T5) — a `failed` outcome as one line of user-facing text.
 *
 * The transform's `reason` is carried **verbatim**; this function only prefixes
 * the 1-based line and column that `index` points at, so a typo forty lines
 * into a stage body does not have to be found by eye.
 *
 * Prefixed rather than appended on purpose: acorn's messages read as a
 * continuation of the location, not the other way round. Acorn's own trailing
 * `(line:column)` used to make that a second, 0-based position disagreeing with
 * this one; `stripAcornPosition` removes it at the source, so this
 * function is the only authority on where the problem is.
 *
 * Blank text is not a refusal to show. The transform reports empty input as
 * `failed` so its callers commit nothing, but "no sort" and "no projection"
 * are legitimate states — the guard lives here so no surface re-implements it.
 */
export function refusalMessage(text: string, outcome: RepairOutcome): string | null {
  if (outcome.kind !== 'failed') return null;
  if (text.trim() === '') return null;
  if (outcome.index === undefined) return outcome.reason;
  const before = text.slice(0, Math.min(outcome.index, text.length));
  const line = before.split('\n').length;
  const column = before.length - (before.lastIndexOf('\n') + 1) + 1;
  return `Line ${line}, column ${column}: ${outcome.reason}`;
}

function walk(node: AnyNode, text: string, edits: Edit[]): void {
  switch (node.type) {
    case 'ObjectExpression': {
      for (const prop of node.properties) {
        if (prop.type !== 'Property') {
          throw new UnsupportedSyntax('A spread element is not supported here.', prop.start);
        }
        if (prop.computed || prop.kind !== 'init' || prop.method) {
          throw new UnsupportedSyntax('This is not a plain field and value.', prop.start);
        }
        if (prop.shorthand) {
          throw new UnsupportedSyntax('A field must have a value.', prop.start);
        }
        edits.push({ start: prop.key.start, end: prop.key.end, replacement: keyText(prop.key, text) });
        walk(prop.value as AnyNode, text, edits);
      }
      if (node.properties.length > 0) {
        dropTrailingComma(text, node.properties[node.properties.length - 1]!.end, node.end - 1, edits);
      }
      return;
    }

    case 'ArrayExpression': {
      for (const element of node.elements) {
        if (element === null) {
          throw new UnsupportedSyntax('An array cannot have an empty slot.', node.start);
        }
        walk(element as AnyNode, text, edits);
      }
      if (node.elements.length > 0) {
        dropTrailingComma(text, node.elements[node.elements.length - 1]!.end, node.end - 1, edits);
      }
      return;
    }

    case 'Literal': {
      if (node.regex) {
        edits.push({ start: node.start, end: node.end, replacement: regexText(node.regex, node.start) });
        return;
      }
      if (node.bigint) {
        throw new UnsupportedSyntax('A BigInt literal is not supported. Use NumberLong("…").', node.start);
      }
      if (typeof node.value === 'string') {
        edits.push({ start: node.start, end: node.end, replacement: JSON.stringify(node.value) });
      }
      // Numbers, booleans and null are already written the way JSON wants them,
      // and a number's digits must survive untouched.
      return;
    }

    // `-1` and `+1` are unary expressions, not numeric literals.
    case 'UnaryExpression': {
      const arg = node.argument;
      if ((node.operator !== '-' && node.operator !== '+') || arg.type !== 'Literal' || typeof arg.value !== 'number') {
        throw new UnsupportedSyntax(`The operator "${node.operator}" is not supported.`, node.start);
      }
      const digits = text.slice(arg.start, arg.end);
      edits.push({
        start: node.start,
        end: node.end,
        replacement: node.operator === '-' ? `-${digits}` : digits,
      });
      return;
    }

    case 'NewExpression':
    case 'CallExpression': {
      const callee = node.callee;
      if (callee.type !== 'Identifier') {
        throw new UnsupportedSyntax('Only the MongoDB value constructors can be called here.', node.start);
      }
      edits.push({ start: node.start, end: node.end, replacement: sentinelText(node, callee.name, text) });
      return;
    }

    case 'Identifier': {
      throw new UnsupportedSyntax(
        `"${node.name}" is a bare word. Write a quoted string, a number, or a MongoDB value such as ObjectId("…").`,
        node.start,
      );
    }

    default: {
      const label = NODE_LABELS[node.type] ?? `a ${node.type}`;
      throw new UnsupportedSyntax(`This application does not support ${label} here.`, node.start);
    }
  }
}

/**
 * The regex flags MongoDB understands. An allowlist rather than a list of the
 * JavaScript-only ones, so a later `ecmaVersion` bump cannot quietly let a new
 * flag through: `d` and `v` are unparseable at 2020 today, and both would be
 * meaningless to the server the day acorn starts accepting them.
 */
const MONGO_REGEX_FLAGS = new Set(['i', 'm', 's', 'u']);

/** Plain-English names for the JavaScript flags a user is most likely to paste. */
const REGEX_FLAG_NAMES: Record<string, string> = {
  g: 'global',
  y: 'sticky',
  // Stryker disable next-line StringLiteral: unreachable today per the MONGO_REGEX_FLAGS comment above — acorn at ecmaVersion 2020 cannot even parse a `d` flag, so this entry is intentionally forward-compatible dead weight, not a mistake to delete.
  d: 'indices',
  // Stryker disable next-line StringLiteral: same as `d` above — unreachable until acorn parses the `v` flag, kept for when it does.
  v: 'unicode sets',
};

/**
 * `/^acme/i` → `{"$regularExpression":{"pattern":"^acme","options":"i"}}`.
 *
 * The half of Tier 3 that fits ADR 0004's text-transform rule. Acorn hands the
 * pattern and the flags back as raw source text, so no `RegExp` is ever
 * constructed and nothing is evaluated — the same discipline the numeric
 * literals get, for the same reason.
 *
 * `$regularExpression` rather than the `$regex` / `$options` operator pair:
 * only the former is Canonical EJSON. `src/utils/ejson.ts` revives it to a real
 * `BSONRegExp` and re-serializes it byte-identically, which is what the
 * "stored text is always Canonical EJSON" invariant needs. The operator pair
 * survives the round trip too, but as a plain object — it reads the same inside
 * a filter and is not a BSON value anywhere else.
 *
 * Flags are sorted because `bson` sorts them on the way back out. Emitting
 * `/^a/mi` verbatim would make a saved query's text differ from the text that
 * produced it the first time it was reloaded.
 */
function regexText(regex: { pattern: string; flags: string }, start: number): string {
  for (const flag of regex.flags) {
    if (MONGO_REGEX_FLAGS.has(flag)) continue;
    const name = REGEX_FLAG_NAMES[flag];
    throw new UnsupportedSyntax(
      `The regular expression flag "${flag}"${name ? ` (${name})` : ''} has no MongoDB equivalent. Remove it.`,
      start,
    );
  }
  // Code-unit order, not `localeCompare`: these flags go out as canonical
  // EJSON, and a locale-dependent order would make the same regex serialize
  // differently on different machines.
  // Stryker disable next-line EqualityOperator,ConditionalExpression: a valid regex never repeats a flag, so every pair compared here is guaranteed unequal — `<=`/`>=` collapsing to `<`/`>`, or forcing the second ternary branch to a fixed `true`/`false`, is unobservable. Verified exhaustively over every permutation of every subset of MONGO_REGEX_FLAGS (the only flags that ever reach this comparator): the real comparator and all four mutants sort every one identically.
  const options = [...regex.flags].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('');
  return `{"$regularExpression":{"pattern":${JSON.stringify(regex.pattern)},"options":${JSON.stringify(options)}}}`;
}

/** An object key, as a double-quoted JSON string. */
function keyText(key: AnyNode, text: string): string {
  if (key.type === 'Identifier') return JSON.stringify(key.name);
  if (key.type === 'Literal' && typeof key.value === 'string') return JSON.stringify(key.value);
  if (key.type === 'Literal' && typeof key.value === 'number') return `"${text.slice(key.start, key.end)}"`;
  throw new UnsupportedSyntax('A field name must be a word or a quoted string.', key.start);
}

/** `ObjectId("abc")` → `{"$oid":"abc"}`, by copying the argument's source text. */
function sentinelText(
  node: { type: string; start: number; arguments: readonly AnyNode[] },
  name: string,
  text: string,
): string {
  if (name === 'Date' || name === 'ISODate') {
    if (node.arguments.length === 0) return `{"$date":${JSON.stringify(new Date().toISOString())}}`;
    return `{"$date":${argText(node, text, false)}}`;
  }

  const sentinel = SENTINELS[name];
  if (!sentinel) {
    throw new UnsupportedSyntax(`"${name}" is not a MongoDB value this application knows.`, node.start);
  }
  if (node.arguments.length === 0) {
    throw new UnsupportedSyntax(`${name}() needs an argument.`, node.start);
  }
  return `{"${sentinel.key}":${argText(node, text, sentinel.numericArg)}}`;
}

/**
 * The single argument of a value constructor, as a double-quoted JSON string.
 * A numeric argument keeps its digits verbatim — that is the whole point.
 */
function argText(
  node: { start: number; arguments: readonly AnyNode[] },
  text: string,
  allowNumber: boolean,
): string {
  if (node.arguments.length !== 1) {
    throw new UnsupportedSyntax('This value takes exactly one argument.', node.start);
  }
  const arg = node.arguments[0]!;
  if (arg.type === 'Literal' && typeof arg.value === 'string') return JSON.stringify(arg.value);
  if (allowNumber) {
    if (arg.type === 'Literal' && typeof arg.value === 'number') {
      return `"${text.slice(arg.start, arg.end)}"`;
    }
    if (
      arg.type === 'UnaryExpression' &&
      arg.operator === '-' &&
      arg.argument.type === 'Literal' &&
      typeof arg.argument.value === 'number'
    ) {
      return `"-${text.slice(arg.argument.start, arg.argument.end)}"`;
    }
    throw new UnsupportedSyntax('This value takes a quoted string or a number.', arg.start);
  }
  throw new UnsupportedSyntax('This value takes a quoted string.', arg.start);
}

/** Removes the comma between the last element and the closing bracket, if any. */
function dropTrailingComma(text: string, lastEnd: number, closeIndex: number, edits: Edit[]): void {
  const offset = text.slice(lastEnd, closeIndex).lastIndexOf(',');
  if (offset >= 0) edits.push({ start: lastEnd + offset, end: lastEnd + offset + 1, replacement: '' });
}
