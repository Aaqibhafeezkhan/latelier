import ConnectionString from 'mongodb-connection-string-url';
import type { MapTarget, MappingCollection, MappingField } from '@shared/types';
import { ValidationError } from '../../errors.ts';
import { parseLine, type ParsedLine } from '../connectionBulkAdd.ts';
import type { SecretValues } from '../connectionExportFormat.ts';
import type { CandidateRow } from './candidateRow.ts';

/** The mapping targets, in the order the Field Mapping screen lists them (C14 §5.3). */
export const MAP_TARGETS: readonly MapTarget[] = [
  'name', 'connectionString', 'host', 'port', 'username',
  'password', 'authDatabase', 'defaultDb', 'tls',
];

const MAX_DEPTH = 5;
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

function isObject(v: unknown): v is Row {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Every non-empty array of objects within five levels of the top, largest
 * first (ties keep document order). With none, a top-level object is the one
 * row. Throws `ValidationError` when there is nothing to map.
 */
export function findCollections(value: unknown): FoundCollection[] {
  const found: { at: string; rows: Row[] }[] = [];
  const walk = (node: unknown, path: string[]): void => {
    if (Array.isArray(node) && node.length > 0 && node.every(isObject)) {
      found.push({ at: path.join('.'), rows: node });
    }
    if (path.length === MAX_DEPTH || node === null) return;
    // Stryker disable next-line ConditionalExpression: walking a string instead of skipping it is unobservable — its entries are single characters, which hold no array, so no collection is ever found under one; the check only saves the work.
    if (typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) walk(child, [...path, key]);
  };
  walk(value, []);
  if (found.length === 0 && isObject(value)) found.push({ at: '', rows: [value] });
  if (found.length === 0) throw new ValidationError('No connections found in this file.');
  found.sort((a, b) => b.rows.length - a.rows.length);
  return found.map(({ at, rows }) =>
    rows.length > MAX_ROWS
      ? { at, rows: rows.slice(0, MAX_ROWS), truncatedRows: rows.length - MAX_ROWS }
      : { at, rows },
  );
}

/** Dot path → scalar leaf, in document order. A `Map`, so a `__proto__` key stays data. */
function flattenRow(row: Row): Map<string, Scalar> {
  const out = new Map<string, Scalar>();
  // ponytail: recursive, so a row nested thousands of levels deep overflows the stack; make it iterative if real files ever do that.
  const walk = (node: unknown, prefix: string): void => {
    for (const [key, child] of Object.entries(node as object)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof child === 'object' && child !== null) walk(child, path);
      else if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') out.set(path, child);
    }
  };
  walk(row, '');
  return out;
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

const SECRET_PARTS = ['pass', 'pwd', 'secret', 'token', 'key', 'credential'];

/**
 * The sample the renderer may see. Masking happens here so a raw secret never
 * leaves this module: a secret-looking key hides the whole value, and a
 * connection string loses its password and secret parameters.
 */
function sampleFor(path: string, value: Scalar): { sample: string; masked: boolean } {
  const name = lastKey(path);
  if (SECRET_PARTS.some((part) => name.includes(part))) return { sample: MASK, masked: true };
  const text = String(value);
  // Case-insensitive on purpose: anything shaped like a connection string is
  // either stripped or hidden, even one the parser would later refuse.
  if (!/^\s*mongodb(\+srv)?:\/\//i.test(text)) return { sample: text, masked: false };
  let cs: ConnectionString;
  try {
    cs = new ConnectionString(text.trim());
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
function buildFields(rows: readonly Row[]): MappingField[] {
  const firsts = new Map<string, Scalar>();
  for (const row of rows) {
    for (const [path, value] of flattenRow(row)) {
      if (!firsts.has(path) && firsts.size < MAX_FIELDS) firsts.set(path, value);
    }
  }
  const taken = new Set<MapTarget>();
  return [...firsts].map(([path, value]) => {
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
}

/** What `conn:importOpen` shows for an Unknown JSON file. */
export function buildCollections(value: unknown): MappingCollection[] {
  return findCollections(value).map(({ at, rows, truncatedRows }) => ({
    at,
    rows: rows.length,
    fields: buildFields(rows),
    ...(truncatedRows ? { truncatedRows } : {}),
  }));
}

const asText = (v: Scalar): string | undefined => (typeof v === 'string' ? v : undefined);

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
  const values: ReadonlyMap<string | undefined, Scalar> = flattenRow(row);
  const warnings: string[] = [];
  const read = <T>(target: MapTarget, accept: (v: Scalar) => T | undefined, what: string): T | undefined => {
    const path = mapping[target];
    const raw = values.get(path);
    if (raw === undefined || raw === '') return undefined;
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
    const host = read('host', asText, 'text');
    const port = read('port', asPort, 'a port number from 1 to 65535') ?? DEFAULT_PORT;
    if (host === undefined) return unusable(nameHint, warnings, 'No connection string or host in this row.');
    // The parser's own defaults for a bare standard string, so a mapped Host
    // and Port give the same Connection a pasted mongodb://host:port would.
    line = parseLine('mongodb://localhost') as ParsedLine;
    line.input.host = host;
    line.input.port = port;
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
