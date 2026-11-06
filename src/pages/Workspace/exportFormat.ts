import { Double, EJSON, Long, Timestamp } from 'bson';
import { ejsonParse, isExactSentinel, isPlainDocument } from '../../utils/ejson';
import type { ResolvedColumn } from './views/tableColumns';
import { getValueAtPath } from './views/tableColumns';

export type ExportFormat = 'json' | 'jsonl' | 'csv';

export interface ExportColumn {
  header: string;
  path: string;
}

/**
 * The Fields control's visible, ordered columns (field + computed), reduced
 * to the (header, dotted-path) pairs a CSV export walks. A computed column's
 * header is its label when set, else its raw path — same fallback
 * `FieldsControl`'s own list uses.
 */
export function exportColumnsFrom(resolved: ResolvedColumn[]): ExportColumn[] {
  return resolved.map((c) =>
    c.kind === 'field' ? { header: c.field, path: c.field } : { header: c.label ?? c.path, path: c.path },
  );
}

/**
 * `documents` arrive off the IPC wire already Canonical EJSON (a plain
 * `JSON.parse` of the wire text — see `electron/preload.ts`), so re-deriving
 * real BSON classes for Relaxed output means round-tripping through the same
 * revival `ejsonParse` already trusts for user-typed text.
 *
 * Exported (not just an internal helper): `query:export`'s streaming writer
 * canonicalizes each document the same way (`ejsonEncode(doc, false)`) before
 * handing it to a per-document version of this same Relaxed conversion, so
 * its output matches this module's byte-for-byte, except that it keeps a Long
 * past 2^53 inside a Code's scope exact where this module rounds it.
 */
export function revive(doc: unknown): unknown {
  return keepWideNumbersExact(ejsonParse(JSON.stringify(doc)));
}

// Past this magnitude a number's printed digits no longer fit int64, so an
// importer reads the token back as a double, and a double of this size is
// exactly the one it started as.
const INT64_LIMIT = 2 ** 63;

/**
 * bson's Relaxed writer prints a number as a bare JSON token, and an importer
 * reads a bare integer token past 2^53 as a Long. Two kinds of value do not
 * survive that, so they are swapped for their canonical one-key spelling,
 * which every EJSON reader takes back as the same type and value:
 *
 * - a `Long` past the safe-integer range, which bson prints as a JS number
 *   (`9007199254740993` comes out as `9007199254740992`);
 * - an integral `Double` from 2^53 up to int64, which would come back as a
 *   `Long`, and with the digits JavaScript prints for it
 *   (`1760000000000000768` prints as `1760000000000000800`), not its own.
 *
 * `$numberDouble` carries the exact integer value. A double past int64 needs
 * nothing: its digits (or its exponent form, from 1e21) read back as the same
 * double. Everything else stays as bson wrote it.
 *
 * Both kinds reach this walk as the right sentinel, because `find` and
 * `query:export` read every number as its stored type (`EXACT_BSON`).
 *
 * It walks plain documents and arrays. Any other BSON value is left as it is,
 * so a number inside a `Code`'s `$scope` (CodeWithScope is deprecated) is not
 * reached and still rounds.
 */
function keepWideNumbersExact(node: unknown): unknown {
  // bson's Timestamp extends Long, and a real epoch (t >= 2^21) is no safe
  // integer, so without this it would be written as a Long and re-imported as
  // one. Relaxed already prints it as `$timestamp`, which round-trips.
  if (node instanceof Timestamp) return node;
  if (node instanceof Long) {
    return Number.isSafeInteger(node.toNumber()) ? node : { $numberLong: node.toString() };
  }
  if (node instanceof Double) {
    const v = node.valueOf();
    const wide = Number.isInteger(v) && !Number.isSafeInteger(v) && Math.abs(v) < INT64_LIMIT;
    return wide ? { $numberDouble: BigInt(v).toString() } : node;
  }
  if (Array.isArray(node)) return node.map(keepWideNumbersExact);
  if (!isPlainDocument(node)) return node; // a BSON value of some other type
  // Object.create(null), not {}: see `walkRevive` in utils/ejson.ts.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = keepWideNumbersExact(v);
  return out;
}

/** JSON array export — one file, pretty-printed. Canonical is a direct
 * stringify (the documents are already in that shape); Relaxed re-derives
 * through bson's own Relaxed EJSON writer so ints/doubles/dates come out
 * unwrapped rather than copying `ejsonStringifyReadable`'s lossless-only
 * subset (a deliberate export mode, not a display convenience). It still
 * keeps a Long or a Double past 2^53 exact: see `keepWideNumbersExact`. */
export function serializeJsonArray(documents: unknown[], relaxed: boolean): string {
  if (!relaxed) return JSON.stringify(documents, null, 2);
  const revived = documents.map(revive);
  // `{ relaxed: true }` is spelled out even though bson's own default is
  // already Relaxed (verified: `EJSON.stringify(v, ..., {})` and
  // `EJSON.stringify(v, ..., { relaxed: true })` are byte-identical) — a
  // mutation-test-confirmed equivalent, kept explicit so this call still
  // reads correctly if bson's default ever changes.
  // Stryker disable next-line ObjectLiteral: {relaxed: true} and {} are byte-identical bson output — verified with a node EJSON.stringify probe
  return EJSON.stringify(revived as Parameters<typeof EJSON.stringify>[0], undefined, 2, {
    relaxed: true,
  });
}

/** One document per line, LF-terminated (including the last line) — the
 * shape most JSONL tooling (`mongoimport`, `jq -c`) expects. Empty input is
 * the empty string, not a lone newline. */
export function serializeJsonl(documents: unknown[], relaxed: boolean): string {
  if (documents.length === 0) return '';
  const lines = documents.map((doc) =>
    relaxed
      ? // Same equivalence note as `serializeJsonArray`: `{ relaxed: true }`
        // matches bson's own default, verified rather than assumed.
        // Stryker disable next-line ObjectLiteral: {relaxed: true} and {} are byte-identical bson output — verified with a node EJSON.stringify probe
        EJSON.stringify(revive(doc) as Parameters<typeof EJSON.stringify>[0], undefined, undefined, {
          relaxed: true,
        })
      : JSON.stringify(doc),
  );
  return lines.join('\n') + '\n';
}

/**
 * Millis-since-epoch date sentinel (`{"$date":{"$numberLong":"…"}}`,
 * Canonical form) or an already-relaxed `{"$date":"<ISO>"}` → an ISO string,
 * or `null` when the shape doesn't decode. Mirrors `ejsonStringifyReadable`'s
 * `isoDate` in `src/utils/ejson.ts` — kept separate because that one returns
 * a re-wrapped sentinel and this one wants the bare string for a CSV cell.
 */
function dateSentinelToIso(obj: Record<string, unknown>): string | null {
  const inner = obj.$date;
  if (typeof inner === 'string') return inner;
  if (
    inner &&
    typeof inner === 'object' &&
    typeof (inner as Record<string, unknown>).$numberLong === 'string'
  ) {
    // Stryker disable BlockStatement: an empty catch falls through to an implicit `undefined` return, and `?? JSON.stringify(obj)` at the call site treats null/undefined identically (verified: `undefined ?? 'x'` === `null ?? 'x'`)
    try {
      return new Date(Number((inner as Record<string, unknown>).$numberLong)).toISOString();
    } catch {
      // Explicit `return null` rather than an implicit `undefined` reads
      // clearer against the function's declared `string | null` return —
      // but the two are behaviorally equivalent at every call site, since
      // `dateSentinelToIso(obj) ?? JSON.stringify(obj)` treats `null` and
      // `undefined` identically (nullish coalescing, verified).
      return null;
    }
    // Stryker restore BlockStatement
  }
  return null;
}

/**
 * One CSV cell's text for a resolved field value (T22 decision: ObjectId →
 * hex, Date → ISO, every other object/array → its EJSON text). `isExactSentinel`
 * is the same classifier `schemaSummary.ts:inferType` and `ejson.ts:relaxLosslessly`
 * use, so a value that isn't unambiguously one BSON sentinel falls through to
 * the generic "nested object" case rather than being misread.
 */
export function csvCellValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  // Covers string/number/boolean in one branch: `String()` on a string
  // returns the string itself, so there's no separate case to spell out.
  if (typeof v !== 'object') return String(v);
  if (!Array.isArray(v) && isExactSentinel(v as Record<string, unknown>)) {
    const obj = v as Record<string, unknown>;
    if ('$oid' in obj) return String(obj.$oid);
    if ('$date' in obj) return dateSentinelToIso(obj) ?? JSON.stringify(obj);
    // Int32/Double are scalars in every driver's own type system — a CSV
    // cell showing `{"$numberInt":"30"}` instead of `30` would defeat the
    // point of exporting to a spreadsheet. `Number(text)` round-trips both
    // exactly (int32's whole range and a double's decimal text both parse
    // back to the identical JS number) — no `plainNumber`-style lossless
    // guard needed here, because a CSV cell is a terminal rendering, not
    // something this export re-parses back into EJSON.
    if (typeof obj.$numberInt === 'string') return obj.$numberInt;
    if (typeof obj.$numberDouble === 'string') return String(Number(obj.$numberDouble));
    if (typeof obj.$numberLong === 'string' && Number.isSafeInteger(Number(obj.$numberLong))) return obj.$numberLong;
    // A wider $numberLong, and $numberDecimal/binary/regex/timestamp/…, stay
    // wrapped: a Long or Decimal128 can exceed what a JS number holds exactly,
    // so a spreadsheet would silently corrupt the bare value (ADR 0004) — this
    // falls through to the generic "nested object" rendering below instead.
  }
  return JSON.stringify(v);
}

/** RFC-4180-style escaping: a field is quoted only when it needs to be
 * (contains a comma, a double quote, or a newline), with embedded quotes
 * doubled. Untouched fields stay unquoted, matching how the sweep triage's
 * example columns (plain strings/numbers) would look in a spreadsheet. */
export function csvEscape(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** CSV export — header row from `columns`, then one row per document, values
 * resolved by dotted path (`getValueAtPath`, shared with `TableView`'s own
 * column rendering so the two never disagree about what a path resolves to).
 * LF line endings, matching `serializeJsonl`. */
// A spreadsheet runs a cell that starts with one of these as a formula, so a
// stored string like `=HYPERLINK(...)` would execute on open. Only raw
// strings are neutralized; numbers keep their sign.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function neutralizeFormula(cell: string, raw: unknown): string {
  return typeof raw === 'string' && FORMULA_LEAD.test(cell) ? `'${cell}` : cell;
}

/** The header row alone, no trailing newline. Headers are field names from
 * the data, so they get the same formula-neutralization treatment as a cell. */
export function csvHeaderLine(columns: ExportColumn[]): string {
  return columns.map((c) => csvEscape(neutralizeFormula(c.header, c.header))).join(',');
}

/** One document's row, no trailing newline. Split out from `serializeCsv` so
 * a streaming writer (`query:export`) can emit a row at a time instead of
 * building the whole document array in memory first. */
export function csvRowLine(doc: unknown, columns: ExportColumn[]): string {
  return columns
    .map((c) => {
      const raw = getValueAtPath(doc, c.path);
      return csvEscape(neutralizeFormula(csvCellValue(raw), raw));
    })
    .join(',');
}

export function serializeCsv(documents: unknown[], columns: ExportColumn[]): string {
  const lines = [csvHeaderLine(columns), ...documents.map((doc) => csvRowLine(doc, columns))];
  return lines.join('\n') + '\n';
}

export function exportFileExtension(format: ExportFormat): string {
  return format === 'json' ? 'json' : format === 'jsonl' ? 'jsonl' : 'csv';
}
