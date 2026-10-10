import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildCollections } from '../../electron/services/import/unknownJson';

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

const secretWord = fc.constantFrom('pass', 'pwd', 'secret', 'token', 'key', 'credential').chain(anyCase);
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
));

const uriKey = fc.constantFrom('uri', 'conn', 'notes', 'connectionString', 'primary');

const filler = clean(fc.dictionary(
  fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom('host', 'port', 'name', 'user', 'db', 'tls')),
  fc.jsonValue({ maxDepth: 2 }),
  { maxKeys: 4 },
));

const row = fc.tuple(filler, fc.array(keyedSecret, { maxLength: 2 }), fc.option(fc.tuple(uriKey, uriSecret)))
  .map(([f, secrets, uri]) => Object.assign({}, f, ...secrets, uri ? { [uri[0]]: uri[1] } : {}));

const file = fc.tuple(fc.array(row, { minLength: 1, maxLength: 5 }), fc.constantFrom('top', 'nested', 'lone'))
  .map(([rows, shape]) => (shape === 'top' ? rows : shape === 'nested' ? { data: { servers: rows } } : rows[0]!));

const SECRET_PARTS = ['pass', 'pwd', 'secret', 'token', 'key', 'credential'];
function secretPath(path: string): boolean {
  const segments = path.split('.');
  while (segments.length > 1 && /^\d+$/.test(segments.at(-1)!)) segments.pop();
  const last = segments.at(-1)!.toLowerCase();
  return SECRET_PARTS.some((p) => last.includes(p));
}

describe('buildCollections — masking properties', () => {
  it('never lets a planted secret into its output', () => {
    fc.assert(fc.property(file, (value) => {
      expect(JSON.stringify(buildCollections(value))).not.toContain(PREFIX);
    }), { numRuns: 500 });
  });

  it('shows •••• for every path whose last key looks secret', () => {
    fc.assert(fc.property(file, (value) => {
      for (const c of buildCollections(value)) {
        for (const f of c.fields) {
          if (secretPath(f.path)) expect(f).toMatchObject({ sample: '••••', masked: true });
        }
      }
    }), { numRuns: 300 });
  });
});
