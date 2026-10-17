import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseConnectionUri } from '../../electron/mongo/uri-parse';
import { ValidationError } from '../../electron/errors';

// Builds a case-swapped variant of a fixed string — used below to prove the
// module's query-key and authMechanism-value lookups are genuinely
// case-insensitive over the whole input space, not just the exact casing
// the hand-written examples happen to use.
function caseVariant(base: string): fc.Arbitrary<string> {
  return fc
    .array(fc.boolean(), { minLength: base.length, maxLength: base.length })
    .map((flags) => base.split('').map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase())).join(''));
}

// A hostile-alphabet tail biased toward the characters that matter to a
// mongodb:// URI (%, @, :, /, ?, &, =) plus a few percent-escapes that are
// syntactically plausible but not valid UTF-8 once decoded — the class of
// input that found the pathname decodeURIComponent gap this module already
// guards against.
const hostileCharArb = fc.constantFrom(...'%0123456789abcdefzZ@:/.?&=#-_ \t'.split(''));
const hostileTailArb = fc.array(hostileCharArb, { maxLength: 30 }).map((cs) => cs.join(''));
const tailArb = fc.oneof(fc.string({ maxLength: 30 }), hostileTailArb);
const schemeArb = fc.constantFrom('', 'mongodb://', 'mongodb+srv://');
// A bare fc.string() would almost never happen to start with "mongodb://",
// so it would only ever exercise the two early empty/scheme guards.
// Prefixing a real scheme onto an arbitrary tail is what gets generated
// input past those guards and into ConnectionString parsing, the
// decodeURIComponent calls, and the option lookups.
const rawUriArb = fc.tuple(schemeArb, tailArb).map(([scheme, tail]) => scheme + tail);

describe('parseConnectionUri property: total over hostile input', () => {
  // Every throw in this module is an explicit `new ValidationError(...)` —
  // the empty/scheme/no-host guards, the try/catch around `new
  // ConnectionString(...)`, the try/catch around the path's
  // decodeURIComponent, and the unsupported-authMechanism guard. Nothing
  // else should ever propagate: not a raw URIError from a malformed
  // percent-escape, not a TypeError from an unexpected shape.
  it('never throws anything but ValidationError; a non-throw always returns the ParsedUri shape', () => {
    fc.assert(
      fc.property(rawUriArb, (raw) => {
        let result;
        try {
          result = parseConnectionUri(raw);
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          return;
        }
        expect(Array.isArray(result.warnings)).toBe(true);
        expect(typeof result.input).toBe('object');
      }),
      { numRuns: 60 },
    );
  });
});

describe('parseConnectionUri property: query-parameter key casing is ignored', () => {
  it('maxPoolSize is recognized under any casing of its key', () => {
    fc.assert(
      fc.property(caseVariant('maxpoolsize'), fc.nat({ max: 1000 }), (key, value) => {
        const { input } = parseConnectionUri(`mongodb://localhost/?${key}=${value}`);
        expect(input.advanced?.maxPoolSize).toBe(value);
      }),
      { numRuns: 30 },
    );
  });

  const DROPPED_OPTIONS = [
    'retrywrites', 'w', 'wtimeoutms', 'journal', 'replicaset', 'loadbalanced', 'readconcernlevel',
    'tlsinsecure', 'tlsallowinvalidhostnames',
  ];
  const droppedKeyVariantArb = fc
    .constantFrom(...DROPPED_OPTIONS)
    .chain((canonical) => caseVariant(canonical).map((key) => ({ canonical, key })));

  it('every dropped option is warned about regardless of the casing it was pasted with', () => {
    fc.assert(
      fc.property(droppedKeyVariantArb, ({ canonical, key }) => {
        const { warnings } = parseConnectionUri(`mongodb://localhost/?${key}=x`);
        expect(warnings).toContainEqual({ code: 'OPTION_DROPPED', detail: canonical });
      }),
      { numRuns: 30 },
    );
  });
});

describe('parseConnectionUri property: authMechanism value casing is ignored', () => {
  const AUTH_MECH_MAP: Record<string, string> = {
    'SCRAM-SHA-256': 'scram256',
    'SCRAM-SHA-1': 'scram1',
    'MONGODB-X509': 'x509',
    'MONGODB-AWS': 'awsiam',
  };
  const mechVariantArb = fc
    .constantFrom(...Object.keys(AUTH_MECH_MAP))
    .chain((canonical) => caseVariant(canonical).map((value) => ({ canonical, value })));

  it('every supported mechanism is matched no matter how it was cased', () => {
    fc.assert(
      fc.property(mechVariantArb, ({ canonical, value }) => {
        const { input } = parseConnectionUri(
          `mongodb://user:pw@localhost/?authMechanism=${encodeURIComponent(value)}`,
        );
        expect(input.authMech).toBe(AUTH_MECH_MAP[canonical]);
      }),
      { numRuns: 30 },
    );
  });
});

describe('parseConnectionUri property: parseIntParam fallback semantics (maxPoolSize)', () => {
  // maxPoolSize, connectTimeoutMs, socketTimeoutMs and serverSelectionTimeoutMs
  // all go through the same private parseIntParam helper — this pins its
  // behavior through one representative field rather than four copies of an
  // identical property.
  const rawValueArb = fc.oneof(
    fc.nat({ max: 1_000_000 }).map(String),
    fc.integer({ min: -1_000_000, max: -1 }).map(String),
    fc.string({ maxLength: 12 }),
  );

  it('is always a non-negative integer; a non-negative finite numeric string echoes back exactly, anything else falls back to 100', () => {
    fc.assert(
      fc.property(rawValueArb, (raw) => {
        const { input } = parseConnectionUri(`mongodb://localhost/?maxPoolSize=${encodeURIComponent(raw)}`);
        const got = input.advanced!.maxPoolSize!;
        expect(Number.isInteger(got)).toBe(true);
        expect(got).toBeGreaterThanOrEqual(0);
        const n = Number(raw);
        const expected = raw !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : 100;
        expect(got).toBe(expected);
      }),
      { numRuns: 40 },
    );
  });
});

describe('parseConnectionUri property: credential file paths never reach the input', () => {
  it('whatever path tlsCAFile or tlsCertificateKeyFile carries, only the re-pick marker survives', () => {
    // A marker prefix keeps the path from colliding with anything else in the input.
    const pathArb = fc.string({ minLength: 1, maxLength: 40 }).map((s) => `/zz-marker-${encodeURIComponent(s)}`);
    fc.assert(
      fc.property(
        pathArb,
        pathArb,
        caseVariant('tlscafile'),
        caseVariant('tlscertificatekeyfile'),
        (ca, cert, caKey, certKey) => {
          const { input, repick, warnings } = parseConnectionUri(
            `mongodb://h/?tls=true&${caKey}=${ca}&${certKey}=${cert}`,
          );
          const out = JSON.stringify({ input, warnings });
          expect(out).not.toContain('zz-marker-');
          expect(repick).toEqual(['tlsCa', 'tlsClientCert']);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('parseConnectionUri property: refusals never echo the password', () => {
  it('a bad port or host error message omits the password', () => {
    const pwArb = fc.stringMatching(/^[A-Za-z0-9]{8,16}$/);
    fc.assert(
      fc.property(pwArb, fc.constantFrom(':abc', ':0', ':65536', '&tls=true'), (pw, bad) => {
        try {
          parseConnectionUri(`mongodb://u:${pw}@h${bad}/db`);
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as Error).message).not.toContain(pw);
          return;
        }
        expect.unreachable('bad host/port should be refused');
      }),
      { numRuns: 40 },
    );
  });
});

describe('parseConnectionUri property: unparseable userinfo is never echoed', () => {
  // Passwords mixing '/', ':' and a digits-only start are what made the SRV
  // port strip read the userinfo as a host, and the library quote it back.
  const pwArb = fc
    .tuple(fc.stringMatching(/^[0-9]{0,5}$/), fc.array(fc.constantFrom(...'/:Ab9'.split('')), { minLength: 1, maxLength: 10 }))
    .map(([digits, rest]) => `${digits}${rest.join('')}ZQX9`);
  it('neither an error nor a warning repeats the password', () => {
    fc.assert(
      fc.property(fc.constantFrom('mongodb://', 'mongodb+srv://'), pwArb, fc.constantFrom('', ':27017'), (scheme, pw, port) => {
        try {
          const { warnings } = parseConnectionUri(`${scheme}alice:${pw}@cluster.example.net${port}/db`);
          expect(JSON.stringify(warnings)).not.toContain('ZQX9');
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as Error).message).not.toContain('ZQX9');
        }
      }),
      { numRuns: 200 },
    );
  });
});
