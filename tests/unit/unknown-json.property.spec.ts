import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { MapTarget } from '@shared/types';
import { buildCollections, combineRow, MAP_TARGETS } from '../../electron/services/import/unknownJson';

// Every planted secret starts with this prefix and is otherwise alphanumeric,
// so percent-encoding cannot disguise a leak and a plain substring search over
// the serialized output finds any copy of it.
const PREFIX = 'ZQX9';
const marker = fc.stringMatching(/^[A-Za-z0-9]{4,16}$/).map((s) => `${PREFIX}${s}`);
const clean = <T>(a: fc.Arbitrary<T>) => a.filter((v) => !JSON.stringify(v).includes(PREFIX));

/** Each character upper- or lower-cased at random. */
const anyCase = (word: string) =>
  fc.array(fc.boolean(), { minLength: word.length, maxLength: word.length })
    .map((flips) => [...word].map((c, i) => (flips[i] ? c.toUpperCase() : c.toLowerCase())).join(''));

const secretWord = fc.constantFrom('pass', 'pw', 'pwd', 'secret', 'token', 'key', 'credential').chain(anyCase);
const secretKey = fc.tuple(fc.constantFrom('', 'db', 'api', 'ssh_', 'my.'), secretWord, fc.constantFrom('', 's', 'word', 'Value'))
  .map(([a, b, c]) => `${a}${b}${c}`);

/** A secret under a secret-looking key: as a scalar, in a list, or one level down. */
const keyedSecret = fc.tuple(secretKey, marker, fc.constantFrom('scalar', 'list', 'nested'))
  .map(([key, m, shape]) => (shape === 'scalar' ? { [key]: m } : shape === 'list' ? { [key]: [m, m] } : { auth: { [key]: m } }));

const host = fc.constantFrom('h', 'db.example.com', 'a:27018,b:27019');
const otherParams = fc.constantFrom('', '&appName=x', '&authSource=admin');
const props = (m: string) => fc.constantFrom(
  `AWS_SESSION_TOKEN:${m}`,
  `SERVICE_NAME:x,AWS_SESSION_TOKEN:${m}`,
  `AWS_SESSION_TOKEN:${m},SERVICE_NAME:x`,
);

/** A connection string carrying the secret where Compass keeps one. */
const uriSecret = marker.chain((m) => fc.oneof(
  fc.tuple(host, otherParams).map(([h, p]) => `mongodb://alice:${m}@${h}/app?tls=true${p}`),
  fc.tuple(host, anyCase('tlsCertificateKeyFilePassword'), otherParams)
    .map(([h, k, p]) => `mongodb://${h}/?${k}=${m}${p}`),
  fc.tuple(host, anyCase('proxyPassword'), fc.boolean())
    .map(([h, k, twice]) => `mongodb://${h}/?proxyHost=p&${k}=${m}${twice ? `&${k}=${m}` : ''}`),
  fc.tuple(host, anyCase('tlsCertificateKeyFilePassword'), anyCase('proxyPassword'), anyCase('proxyPassword'))
    .map(([h, k, p1, p2]) => `mongodb://${h}/?${p1}=${m}&${k}=${m}&${p2}=${m}`),
  fc.tuple(host, anyCase('authMechanismProperties'), anyCase('AWS_SESSION_TOKEN'), props(m), fc.boolean())
    .map(([h, k, t, v, twice]) =>
      `mongodb://${h}/?authMechanism=MONGODB-AWS&${k}=${v.replace('AWS_SESSION_TOKEN', t)}${twice ? `&${k}=${t}:${m}` : ''}`),
  // Unencoded characters make the string unparseable; it must be hidden, not shown.
  fc.constantFrom('/', ':', '@', '?').map((c) => `mongodb://alice:${m}${c}x@h/app`),
  fc.constant(`mongodb+srv://alice:${m}@cluster.example.com:27017/app`),
  fc.constant(`MONGODB://alice:${m}@h`),
  // A userinfo holding '/' or ':' after a digits-only start once read as an
  // SRV host and came back in the parser's error and warning.
  fc.tuple(fc.stringMatching(/^[0-9]{1,5}$/), fc.constantFrom('/', ':'), fc.constantFrom('mongodb://', 'mongodb+srv://'))
    .map(([digits, sep, scheme]) => `${scheme}alice:${digits}${sep}${m}@cluster.example.net`),
));

const invisible = fc.constantFrom('', ' ', '\u200B', '\uFEFF', '\u200C\u200D', '\u2060', '\n');
/** The string as a value holds it: alone, behind invisible characters, or inside other text. */
const wrappedUri = fc.oneof(
  uriSecret,
  fc.tuple(invisible, uriSecret, invisible).map(([a, u, b]) => `${a}${u}${b}`),
  fc.tuple(fc.constantFrom('see ', 'primary: ', 'mongodb://h and '), uriSecret, fc.constantFrom('', ' then failover'))
    .map(([a, u, b]) => `${a}${u}${b}`),
);

/** Keys that must never become a path or `at`: a connection string, or one past 256 characters. */
const badKey = fc.oneof(
  wrappedUri,
  marker.map((m) => `${'k'.repeat(257)}${m}`),
);
const keyedBadKey = fc.tuple(badKey, fc.constantFrom('object', 'collection', 'scalar'))
  .map(([key, shape]) => ({ [key]: shape === 'object' ? { host: 'h' } : shape === 'collection' ? [{ host: 'h' }, { host: 'i' }] : 1 }));

const uriKey = fc.constantFrom('uri', 'conn', 'notes', 'connectionString', 'primary');

const filler = clean(fc.dictionary(
  fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom('host', 'port', 'name', 'user', 'db', 'tls')),
  fc.jsonValue({ maxDepth: 2 }),
  { maxKeys: 4 },
));

const row = fc.tuple(
  filler,
  fc.array(keyedSecret, { maxLength: 2 }),
  fc.option(fc.tuple(uriKey, wrappedUri)),
  fc.array(keyedBadKey, { maxLength: 2 }),
).map(([f, secrets, uri, bad]) => Object.assign({}, f, ...secrets, uri ? { [uri[0]]: uri[1] } : {}, ...bad));

const file = fc.tuple(fc.array(row, { minLength: 1, maxLength: 5 }), fc.constantFrom('top', 'nested', 'lone'))
  .map(([rows, shape]) => (shape === 'top' ? rows : shape === 'nested' ? { data: { servers: rows } } : rows[0]!));

const SECRET_PARTS = ['pass', 'pw', 'pwd', 'secret', 'token', 'key', 'credential'];
function secretPath(path: string): boolean {
  const segments = path.split('.');
  while (segments.length > 1 && /^\d+$/.test(segments.at(-1)!)) segments.pop();
  const last = segments.at(-1)!.toLowerCase();
  return SECRET_PARTS.some((p) => last.includes(p));
}

// Generating the nested files, not building from them, takes the time here:
// 500 runs is about 1.5s locally (0.2s of it in buildCollections) and about 6s
// on a CI runner, past the 5s default.
const PROPERTY_TIMEOUT = { timeout: 30_000 };

describe('buildCollections — masking properties', () => {
  it('never lets a planted secret into its output', PROPERTY_TIMEOUT, () => {
    fc.assert(fc.property(file, (value) => {
      expect(JSON.stringify(buildCollections(value))).not.toContain(PREFIX);
    }), { numRuns: 500 });
  });

  it('shows •••• for every path whose last key looks secret', PROPERTY_TIMEOUT, () => {
    fc.assert(fc.property(file, (value) => {
      for (const c of buildCollections(value)) {
        for (const f of c.fields) {
          if (secretPath(f.path)) expect(f).toMatchObject({ sample: '••••', masked: true });
        }
      }
    }), { numRuns: 300 });
  });
});

/** Every dot path in a row, leaves and containers alike, so mappings can also miss. */
function allPaths(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return [path, ...allPaths(v, path)];
  });
}

/**
 * Host values the parser refuses, marked with their own prefix: they are not
 * secrets (the mapping screen shows them, and Name may take one), but none may
 * become the row's host.
 */
const HOST_PREFIX = 'HSTX';
const badHost = fc.stringMatching(/^[A-Za-z0-9]{4,12}$/).map((s) => `${HOST_PREFIX}${s}`)
  .chain((m) => fc.constantFrom(`u:${m}@h`, `h:${m}`, `${m} x`, `h/${m}`, `${m},h`, `h:1${m}`));
const combineRowArb = fc.tuple(row, fc.option(fc.tuple(fc.constantFrom('host', 'server', 'addr'), badHost)))
  .map(([r, h]) => (h ? { ...r, [h[0]]: h[1] } : r));

const rowWithMapping = combineRowArb.chain((r) => {
  const paths = ['absent', ...allPaths(r)];
  const target = fc.constantFrom(...paths);
  const shape = Object.fromEntries(MAP_TARGETS.map((t) => [t, target])) as Record<MapTarget, fc.Arbitrary<string>>;
  return fc.tuple(fc.constant(r), fc.record(shape, { requiredKeys: [] }));
});

describe('combineRow — secret properties', () => {
  it('keeps every planted secret out of the row, whatever the mapping, except in `secrets`', PROPERTY_TIMEOUT, () => {
    fc.assert(fc.property(rowWithMapping, ([r, mapping]) => {
      const shown: Partial<ReturnType<typeof combineRow>> = combineRow(r, mapping);
      delete shown.secrets;
      expect(JSON.stringify(shown)).not.toContain(PREFIX);
      expect(shown.input!.host ?? '').not.toContain(HOST_PREFIX);
    }), { numRuns: 1000 });
  });
});
