import ConnectionString from 'mongodb-connection-string-url';
import type { MapTarget, MappingCollection, MappingField } from '@shared/types';
import { ValidationError } from '../../errors.ts';
import { parseHostPort } from '../../mongo/uri-parse.ts';
import { parseLine, type ParsedLine } from '../connectionBulkAdd.ts';
import type { SecretValues } from '../connectionExportFormat.ts';
import type { CandidateRow } from './candidateRow.ts';

/** The mapping targets, in the order the Field Mapping screen lists them (C14 §5.3). */
export const MAP_TARGETS: readonly MapTarget[] = [
  'name', 'connectionString', 'host', 'port', 'username',
  'password', 'authDatabase', 'defaultDb', 'tls',
];

const MAX_DEPTH = 5;
/** Leaves deeper than this below the row are not offered; it also bounds the recursion. */
const MAX_ROW_DEPTH = 20;
const MAX_ROWS = 500;
const MAX_FIELDS = 200;
const MASK = '••••';
const DEFAULT_PORT = 27017;

type Row = Record<string, unknown>;
type Scalar = string | number | boolean;

export interface FoundCollection {
  /** Dot path to the array; '' for the top level, or for a lone top-level object. */
  at: string;
  rows: Row[];
  /** Rows left out beyond the cap. */
  truncatedRows?: number;
}

/** A connection string anywhere in a text, any case. Linear: no nested quantifier. */
const CONNECTION_STRING = /mongodb(\+srv)?:\/\//i;
/** Longer keys are skipped: nobody maps them, and hashing them per leaf is a cost a file controls. */
const MAX_KEY_LENGTH = 256;

/**
 * A key that may not become part of a path or `at`: it holds a connection
 * string (and so possibly a password), or it is too long to be a field name.
 */
function unsafeKey(key: string): boolean {
  return key.length > MAX_KEY_LENGTH || CONNECTION_STRING.test(key);
}

function isObject(v: unknown): v is Row {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Every non-empty array of objects within five levels of the top, largest
 * first (ties keep document order). A collection's own rows are not searched
 * for more: their arrays are fields of the row. With none, a top-level object
 * is the one row. Throws `ValidationError` when there is nothing to map.
 *
 * Keys are joined with `.`, so a dotted key, an empty key or a `"0"` key can
 * give two arrays the same `at`. Picking by `at` could then import the other
 * one, so every array at such a path is left out; `ambiguous` counts those
 * paths.
 */
export function findCollections(value: unknown): { collections: FoundCollection[]; ambiguous: number } {
  const found: { at: string; rows: Row[] }[] = [];
  const walk = (node: unknown, path: string[]): void => {
    if (Array.isArray(node) && node.length > 0 && node.every(isObject)) {
      found.push({ at: path.join('.'), rows: node });
      return;
    }
    if (path.length === MAX_DEPTH || node === null) return;
    // Stryker disable next-line ConditionalExpression: walking a string instead of skipping it is unobservable — its entries are single characters, which hold no array, so no collection is ever found under one; the check only saves the work.
    if (typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) if (!unsafeKey(key)) walk(child, [...path, key]);
  };
  walk(value, []);
  if (found.length === 0 && isObject(value)) found.push({ at: '', rows: [value] });
  if (found.length === 0) throw new ValidationError('No connections found in this file.');
  const ambiguous = repeated(found.map((c) => c.at));
  const kept = found.filter((c) => !ambiguous.has(c.at));
  if (kept.length === 0) {
    throw new ValidationError("The lists of connections in this file can't be told apart: each has the same path as another list.");
  }
  kept.sort((a, b) => b.rows.length - a.rows.length);
  const collections = kept.map(({ at, rows }) =>
    rows.length > MAX_ROWS
      ? { at, rows: rows.slice(0, MAX_ROWS), truncatedRows: rows.length - MAX_ROWS }
      : { at, rows },
  );
  return { collections, ambiguous: ambiguous.size };
}

/** The values that occur more than once. */
function repeated(values: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const v of values) (seen.has(v) ? twice : seen).add(v);
  return twice;
}

/**
 * Dot path → scalar leaf, in document order, at most 20 segments deep. A `Map`,
 * so a `__proto__` key stays data. A path two leaves share (see
 * `findCollections`) is in `ambiguous` and left out of `values`: which leaf it
 * means can't be told, so neither is shown or read.
 */
function flattenRow(row: Row): { values: Map<string, Scalar>; ambiguous: Set<string> } {
  const leaves: [string, Scalar][] = [];
  const walk = (node: object, prefix: string, depth: number): void => {
    for (const [key, child] of Object.entries(node)) {
      if (unsafeKey(key)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof child === 'object' && child !== null) {
        if (depth < MAX_ROW_DEPTH) walk(child, path, depth + 1);
      } else if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') {
        leaves.push([path, child]);
      }
    }
  };
  walk(row, '', 1);
  const ambiguous = repeated(leaves.map(([path]) => path));
  return { values: new Map(leaves.filter(([path]) => !ambiguous.has(path))), ambiguous };
}

/**
 * The last segment that is a key rather than an array index, so a list of
 * secrets under `apiKeys` is masked like a single one.
 */
function lastKey(path: string): string {
  const segments = path.split('.');
  let i = segments.length - 1;
  while (i > 0 && /^\d+$/.test(segments[i]!)) i--;
  return segments[i]!.toLowerCase();
}

// `pw` is a common short form of password. `auth` is left out on purpose: authSource and authMechanism samples are useful to see.
const SECRET_PARTS = ['pass', 'pw', 'pwd', 'secret', 'token', 'key', 'credential'];

/**
 * The sample the renderer may see. Masking happens here so a raw secret never
 * leaves this module: a secret-looking key hides the whole value, and a
 * connection string loses its password and secret parameters.
 */
function sampleFor(path: string, value: Scalar): { sample: string; masked: boolean } {
  const name = lastKey(path);
  if (SECRET_PARTS.some((part) => name.includes(part))) return { sample: MASK, masked: true };
  const text = String(value);
  // Case-insensitive and anywhere on purpose: anything holding a connection
  // string is either stripped or hidden, even one the parser would refuse.
  if (!CONNECTION_STRING.test(text)) return { sample: text, masked: false };
  // Spaces and invisible characters around the string are not part of it.
  const bare = trimInvisible(text);
  // Text around the string (a note, a second string, one inside a parameter)
  // is hidden whole: where each string ends inside it cannot be told reliably.
  // Text before the string fails the parse below; a second one is caught here.
  if (CONNECTION_STRING.test(bare.slice(1))) return { sample: MASK, masked: true };
  let cs: ConnectionString;
  try {
    cs = new ConnectionString(bare);
  } catch {
    // Fail closed: an unparseable string may still hold a password we cannot locate.
    return { sample: MASK, masked: true };
  }
  // The secrets Compass treats as such: the userinfo password,
  // tlsCertificateKeyFilePassword, proxyPassword and AWS_SESSION_TOKEN inside
  // authMechanismProperties. Every parameter is checked whatever its case and
  // however often it repeats, and a properties value holding the token goes
  // whole, so nothing of the token can survive a malformed list.
  let masked = cs.password !== '';
  const kept = new URLSearchParams();
  for (const [key, value] of cs.searchParams) {
    const k = key.toLowerCase();
    const secret = SECRET_PARAMS.has(k) || (k === 'authmechanismproperties' && /aws_session_token/i.test(value));
    if (secret) masked = true;
    else kept.append(key, value);
  }
  if (!masked) return { sample: text, masked: false };
  cs.password = '';
  cs.search = kept.toString();
  return { sample: cs.toString(), masked: true };
}

/** Zero-width characters `trim()` leaves in place (it already removes U+FEFF). */
const ZERO_WIDTH = new Set(['\u200B', '\u200C', '\u200D', '\u2060']);

/**
 * `trim()` that also drops zero-width characters; a loop, since `\s+$`
 * backtracks quadratically. Only called on text holding a connection string,
 * so both loops stop at a visible character without a bounds check.
 */
function trimInvisible(text: string): string {
  const edge = (c: string): boolean => c.trim() === '' || ZERO_WIDTH.has(c);
  let start = 0;
  let end = text.length;
  while (edge(text[start]!)) start++;
  while (edge(text[end - 1]!)) end--;
  return text.slice(start, end);
}

const SECRET_PARAMS = new Set(['tlscertificatekeyfilepassword', 'proxypassword']);

const SYNONYMS: Record<MapTarget, readonly string[]> = {
  connectionString: ['uri', 'url', 'connectionstring', 'connection_string', 'mongouri', 'mongourl'],
  host: ['host', 'hostname', 'server'],
  port: ['port'],
  username: ['user', 'username', 'login'],
  password: ['password', 'pass', 'pwd'],
  authDatabase: ['authsource', 'authdb', 'authdatabase'],
  defaultDb: ['db', 'database', 'dbname'],
  name: ['name', 'label', 'title'],
  tls: ['tls', 'ssl'],
};

function isConnectionString(v: Scalar): v is string {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t.startsWith('mongodb://') || t.startsWith('mongodb+srv://');
}

/**
 * The fields of one collection (C14 §5.2–5.4): up to 200 paths in document
 * order, each with the first row's value as its sample and a suggested target.
 * A target is suggested for one path only, the first; a connection-string
 * value outranks the path's key name.
 */
function buildFields(rows: readonly Row[]): { fields: MappingField[]; ambiguous: number } {
  const flat = rows.map(flattenRow);
  // A path ambiguous in any row is left out for all: mapped, it would silently read nothing from that row.
  const ambiguous = new Set(flat.flatMap((f) => [...f.ambiguous]));
  const firsts = new Map<string, Scalar>();
  for (const { values } of flat) {
    for (const [path, value] of values) {
      if (!ambiguous.has(path) && !firsts.has(path) && firsts.size < MAX_FIELDS) firsts.set(path, value);
    }
  }
  const taken = new Set<MapTarget>();
  const fields = [...firsts].map(([path, value]) => {
    const name = lastKey(path);
    const target = isConnectionString(value)
      ? 'connectionString'
      : MAP_TARGETS.find((t) => SYNONYMS[t].includes(name));
    const field: MappingField = { path, ...sampleFor(path, value) };
    if (target && !taken.has(target)) {
      taken.add(target);
      field.suggested = target;
    }
    return field;
  });
  return { fields, ambiguous: ambiguous.size };
}

/** What `conn:importOpen` shows for an Unknown JSON file. */
export function buildCollections(value: unknown): MappingCollection[] {
  return findCollections(value).collections.map(({ at, rows, truncatedRows }) => {
    const { fields, ambiguous } = buildFields(rows);
    return {
      at,
      rows: rows.length,
      fields,
      ...(truncatedRows ? { truncatedRows } : {}),
      ...(ambiguous ? { ambiguousFields: ambiguous } : {}),
    };
  });
}

/** The only targets whose value stays out of the renderer: secrets go to `secrets`, a string's to the parser. */
const SECRET_TARGETS: ReadonlySet<MapTarget> = new Set(['password', 'connectionString']);

const asText = (v: Scalar): string | undefined => (typeof v === 'string' ? v : undefined);

function asHost(v: Scalar): { host: string; port?: number } | undefined {
  if (typeof v !== 'string') return undefined;
  const parsed = parseHostPort(v, true);
  return 'problem' in parsed ? undefined : parsed;
}

/** Digits only, so a number or numeric string that is a whole port; 1.5, -1, '0x10' and '1e3' are not. */
function asPort(v: Scalar): number | undefined {
  const n = /^\d+$/.test(String(v)) ? Number(v) : Number.NaN;
  return n >= 1 && n <= 65535 ? n : undefined;
}

function asBool(v: Scalar): boolean | undefined {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return undefined;
}

/** The string names `tls` or `ssl` itself; otherwise its TLS value is only the parser's default. */
function setsTls(uri: string): boolean {
  const q = uri.indexOf('?');
  if (q === -1) return false;
  return [...new URLSearchParams(uri.slice(q + 1)).keys()].some((k) => {
    const lower = k.toLowerCase();
    return lower === 'tls' || lower === 'ssl';
  });
}

/**
 * One row of the chosen collection as a candidate (C14 §5.5). A mapped
 * connection string is the base and the other mapped fields only fill what it
 * lacks; without one, Host and Port build a standard Connection. Warnings name
 * the path, never the value. Secrets go to `secrets`, never `input`.
 */
export function combineRow(row: Row, mapping: Partial<Record<MapTarget, string>>): CandidateRow {
  // Widened so an unmapped target's `undefined` path simply finds nothing.
  const values: ReadonlyMap<string | undefined, Scalar> = flattenRow(row).values;
  const warnings: string[] = [];
  const read = <T>(target: MapTarget, accept: (v: Scalar) => T | undefined, what: string): T | undefined => {
    const path = mapping[target];
    const raw = values.get(path);
    if (raw === undefined || raw === '') return undefined;
    // What the mapping screen hides must not come back through a field that is shown.
    if (!SECRET_TARGETS.has(target) && sampleFor(path!, raw).masked) {
      warnings.push(`${path} was ignored: it holds a secret; map it to Password or Connection string.`);
      return undefined;
    }
    const v = accept(raw);
    if (v === undefined) warnings.push(`${path} was ignored: it isn't ${what}.`);
    return v;
  };

  const nameHint = read('name', asText, 'text') ?? '';
  const uri = read('connectionString', (v) => (isConnectionString(v) ? v : undefined), 'a connection string');
  let line: ParsedLine;
  if (uri !== undefined) {
    const parsed = parseLine(uri);
    if (!parsed.ok) return unusable(nameHint, warnings, parsed.reason);
    line = parsed;
  } else {
    // The parser's own host rules: `host:port` splits, anything else a host
    // name can't hold is refused.
    const host = read('host', asHost, 'a valid host');
    const port = read('port', asPort, 'a port number from 1 to 65535');
    if (host === undefined) return unusable(nameHint, warnings, 'No connection string or host in this row.');
    if (host.port !== undefined && port !== undefined && port !== host.port) {
      warnings.push(`${mapping.port} was ignored: the host already sets a different port.`);
    }
    // The parser's own defaults for a bare standard string, so a mapped Host
    // and Port give the same Connection a pasted mongodb://host:port would.
    line = parseLine('mongodb://localhost') as ParsedLine;
    line.input.host = host.host;
    line.input.port = host.port ?? port ?? DEFAULT_PORT;
  }

  const input = line.input;
  const secrets: SecretValues = {};
  if (input.password) secrets.password = input.password;
  delete input.password;

  const conflict = (target: MapTarget): void => {
    warnings.push(`${mapping[target]} was ignored: the connection string already sets a different value.`);
  };
  const fill = (target: MapTarget, current: string | undefined, set: (v: string) => void): void => {
    const v = read(target, asText, 'text');
    if (v === undefined) return;
    if (!current) set(v);
    else if (current !== v) conflict(target);
  };
  fill('username', input.authUsername, (v) => {
    input.authUsername = v;
    if (input.authMech === 'none') input.authMech = 'default';
  });
  fill('password', secrets.password, (v) => (secrets.password = v));
  fill('authDatabase', input.authDatabase, (v) => (input.authDatabase = v));
  fill('defaultDb', input.defaultDb, (v) => (input.defaultDb = v));
  const tls = read('tls', asBool, 'true or false');
  if (tls !== undefined) {
    if (uri === undefined || !setsTls(uri)) input.tls!.enabled = tls;
    else if (input.tls!.enabled !== tls) conflict('tls');
  }

  return {
    input,
    secrets,
    nameHint,
    explicitDirect: line.explicitDirect,
    multiHost: line.multiHost,
    warnings: [...line.warnings, ...warnings],
    repick: line.repick,
    defaultTicked: true,
  };
}

function unusable(nameHint: string, warnings: string[], reason: string): CandidateRow {
  return {
    input: {},
    secrets: {},
    nameHint,
    explicitDirect: false,
    multiHost: false,
    warnings,
    repick: [],
    defaultTicked: false,
    unusable: reason,
  };
}
