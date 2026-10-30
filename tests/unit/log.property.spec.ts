import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { compareLogFiles, redactSecrets } from '../../electron/log';

// Mirrors REDACTED_KEYS in electron/log.ts — kept in sync manually since the
// source set isn't exported.
const REDACTED_NAMES = [
  'password', 'pwd', 'sshpassword', 'sshpassphrase',
  'passphrase', 'secret', 'token', 'apikey', 'authorization', 'ssh_password', 'ssh_passphrase',
];

// A redacted-key name in a random casing — case-insensitivity is part of the
// contract under test.
const redactedKey = fc
  .tuple(fc.constantFrom(...REDACTED_NAMES), fc.boolean())
  .map(([name, upper]) => (upper ? name.toUpperCase() : name));

const benignKey = fc
  .string({ minLength: 1, maxLength: 8 })
  .filter((s) => !REDACTED_NAMES.includes(s.toLowerCase()));

const objectKey = fc.oneof({ arbitrary: benignKey, weight: 3 }, { arbitrary: redactedKey, weight: 1 });

const leaf = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));

// Non-empty userinfo free of the URI separators, so the expected masking is
// unambiguous; '@' is allowed in the password on purpose.
const userinfoChar = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => !/[/\s]/.test(s));
const uriWithCreds = fc
  .tuple(
    fc.constantFrom('mongodb', 'mongodb+srv', 'MONGODB', 'MongoDB+Srv'),
    userinfoChar,
    userinfoChar,
    fc.constantFrom('host', 'h1:27017,h2:27017', 'cluster.example.net'),
  )
  // The fixed 'Zq9' prefix keeps the credentials from ever matching text that
  // legitimately survives masking (scheme, host, port, path).
  .map(([scheme, user, pass, host]) => ({ userinfo: `${user}:Zq9${pass}`, uri: `${scheme}://${user}:Zq9${pass}@${host}/db?x=1` }));

// Three levels of object nesting, with arrays of objects at each level, so a
// redacted-key field can land at the top, nested inside a plain object, or
// nested inside an array of objects.
const innerObject = fc.dictionary(objectKey, leaf, { maxKeys: 4 });
const midValue = fc.oneof(leaf, innerObject, fc.array(innerObject, { maxLength: 3 }));
const midObject = fc.dictionary(objectKey, midValue, { maxKeys: 4 });
const topValue = fc.oneof(leaf, midObject, fc.array(midObject, { maxLength: 3 }));
const tree = fc.dictionary(objectKey, topValue, { maxKeys: 5 });

// Walks `original` and `output` in parallel: every field whose key matches a
// REDACTED_NAMES entry (case-insensitively) must be exactly '<redacted>' in
// the output; every other field must be structurally unchanged.
function checkRedacted(original: unknown, output: unknown): void {
  if (original === null || typeof original !== 'object') {
    expect(output).toEqual(original);
    return;
  }
  if (Array.isArray(original)) {
    const out = output as unknown[];
    expect(out.length).toBe(original.length);
    original.forEach((v, i) => checkRedacted(v, out[i]));
    return;
  }
  const obj = original as Record<string, unknown>;
  const out = output as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (REDACTED_NAMES.includes(k.toLowerCase())) {
      expect(out[k]).toBe('<redacted>');
    } else {
      checkRedacted(v, out[k]);
    }
  }
}

// The same object reused as the value of several properties within one
// generated value — proves the redaction result is memoized per input
// reference, so a secret reached through a second alias is caught too, not
// just the first occurrence walk() happens to visit.
const sharedReferenceValue = innerObject.map((shared) => ({
  first: shared,
  second: shared,
  nested: { third: shared },
}));

// A self-referencing (cyclic) object — proves walk() terminates instead of
// recursing forever, and replaces the cycle with a marker rather than
// returning the original, still-secret-bearing object.
const cyclicReferenceValue = innerObject.map((base) => {
  const obj: Record<string, unknown> = { ...base };
  obj.self = obj;
  return obj;
});

describe('redactSecrets property: redaction invariant', () => {
  it('redacts every REDACTED_KEYS field regardless of value type or nesting depth, and leaves everything else unchanged', () => {
    fc.assert(
      fc.property(tree, (value) => {
        checkRedacted(value, redactSecrets(value));
      }),
    );
  });

  it('redacts a secret reached through every alias of a shared reference, not just the first', () => {
    fc.assert(
      fc.property(sharedReferenceValue, (value) => {
        const out = redactSecrets(value) as Record<string, unknown>;
        checkRedacted(value, out);
        expect(out.first).toBe(out.second);
        expect((out.nested as Record<string, unknown>).third).toBe(out.first);
      }),
    );
  });

  it('replaces a cyclic self-reference with a circular marker instead of looping or leaking the original', () => {
    fc.assert(
      fc.property(cyclicReferenceValue, (value) => {
        const out = redactSecrets(value) as Record<string, unknown>;
        const rest = Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'self'));
        checkRedacted(rest, out);
        expect(out.self).toBe('[Circular]');
        expect(out.self).not.toBe(value);
      }),
    );
  });
});

describe('redactSecrets property: URI userinfo in strings', () => {
  // Wraps a URI string at a random depth: bare, in an object, in an array, nested.
  const wrap = (uri: string, depth: number): unknown =>
    depth === 0 ? uri : depth === 1 ? { k: uri } : depth === 2 ? [uri] : { a: [{ b: `see ${uri} end` }] };

  it('never lets the userinfo through, at any depth or inside surrounding text', () => {
    fc.assert(
      fc.property(uriWithCreds, fc.integer({ min: 0, max: 3 }), ({ uri, userinfo }, depth) => {
        const out = JSON.stringify(redactSecrets(wrap(uri, depth)));
        expect(out).toContain('://***@');
        // JSON.stringify escapes quotes and control characters, so compare escaped forms.
        expect(out).not.toContain(JSON.stringify(userinfo).slice(1, -1));
      }),
    );
  });
});

describe('redactSecrets property: URI query secrets', () => {
  const secretValue = fc.stringMatching(/^[A-Za-z0-9_.~%-]{4,24}$/);
  const secretParam = fc.constantFrom(
    'password', 'proxyPassword', 'tlsCertificateKeyFilePassword', 'sslPEMKeyPassword',
  ).chain((n) => fc.constantFrom(n, n.toUpperCase(), n.toLowerCase()));
  const scheme = fc.constantFrom('mongodb', 'mongodb+srv', 'MONGODB');
  // Percent-encode a random subset of the name's characters: the driver decodes them.
  const encoded = (name: string) =>
    fc.array(fc.boolean(), { minLength: name.length, maxLength: name.length }).map((flips) =>
      [...name].map((c, i) => (flips[i] ? `%${c.charCodeAt(0).toString(16).padStart(2, '0')}` : c)).join(''));

  it('never lets a secret parameter value through, however its name is percent-encoded', () => {
    fc.assert(
      fc.property(scheme, secretParam.chain(encoded), secretValue, (sch, name, value) => {
        const out = JSON.stringify(redactSecrets({ k: `${sch}://h/?${name}=${value}&tls=true` }));
        expect(out).not.toContain(value);
        expect(out).toContain('tls=true');
      }),
    );
  });

  it('never lets a secret parameter value through, wherever it sits in the query', () => {
    fc.assert(
      fc.property(scheme, secretParam, secretValue, fc.boolean(), fc.boolean(), (sch, name, value, first, aws) => {
        const secret = aws ? `authMechanismProperties=AWS_SESSION_TOKEN:${value}` : `${name}=${value}`;
        const query = first ? `${secret}&tls=true` : `tls=true&${secret}`;
        const out = JSON.stringify(redactSecrets({ k: `see ${sch}://h/?${query} end` }));
        expect(out).not.toContain(value);
        expect(out).toContain('tls=true');
      }),
    );
  });
});

describe('compareLogFiles (property)', () => {
  // A log file as the writer names it: part 0 is the bare name, and only the
  // current prefix has numbered parts.
  const logFile = fc
    .record({
      date: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31'), noInvalidDate: true }),
      part: fc.nat({ max: 120 }),
      legacy: fc.boolean(),
    })
    .map(({ date, part, legacy }) => {
      const day = date.toISOString().slice(0, 10);
      const p = legacy ? 0 : part;
      return {
        name: legacy ? `mongolab.${day}.log` : p === 0 ? `latelier.${day}.log` : `latelier.${day}.${p}.log`,
        key: [day, p, legacy ? 0 : 1] as const,
      };
    });

  it('sorts names exactly as their (date, part, legacy first) keys sort', () => {
    fc.assert(
      fc.property(fc.uniqueArray(logFile, { selector: (f) => f.name, maxLength: 12 }), (files) => {
        const byKey = [...files].sort((a, b) =>
          a.key[0] !== b.key[0] ? (a.key[0] < b.key[0] ? -1 : 1) : a.key[1] - b.key[1] || a.key[2] - b.key[2]);
        expect(files.map((f) => f.name).sort(compareLogFiles)).toEqual(byKey.map((f) => f.name));
      }),
    );
  });
});
