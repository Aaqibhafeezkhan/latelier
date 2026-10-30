import { beforeEach, describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ColumnCipher } from '../../electron/db/columnCipher';

let cipher: ColumnCipher;
beforeEach(() => {
  cipher = new ColumnCipher({ enc: Buffer.alloc(32, 7), mac: Buffer.alloc(32, 9) });
});

const CELLS = [
  ['recent_queries', 'payload_json'],
  ['recent_field_values', 'value'],
  ['audit_log', 'summary_json'],
  ['saved_queries', 'payload_json'],
  ['workspace_tabs', 'state_json'],
] as const;

const cellArb = fc.constantFrom(...CELLS);
const textArb = fc.oneof(fc.string({ unit: 'binary' }), fc.string({ unit: 'grapheme' }), fc.constant(''));

// A literal `{ __proto__: … }` sets the prototype instead of creating a key, so
// the own-property form is built from JSON text.
const protoJsonArb = fc
  .jsonValue()
  .map((v) => JSON.stringify(JSON.parse(`{"__proto__":${JSON.stringify(v)},"filter":{"__proto__":{"x":1}}}`)));

describe('ColumnCipher properties', () => {
  it('open(seal(s)) === s for arbitrary unicode, empty and __proto__-carrying JSON', () => {
    fc.assert(
      fc.property(cellArb, fc.uuid(), fc.oneof(textArb, protoJsonArb), ([table, column], id, s) => {
        expect(cipher.open(table, column, id, cipher.seal(table, column, id, s))).toBe(s);
      }),
    );
  });

  it('the __proto__ JSON really carries an own __proto__ key', () => {
    fc.assert(
      fc.property(protoJsonArb, (s) => {
        expect(Object.hasOwn(JSON.parse(s) as object, '__proto__')).toBe(true);
      }),
      { numRuns: 20 },
    );
  });

  it('open with any other id throws COLUMN_DECRYPT_FAILED', () => {
    fc.assert(
      fc.property(cellArb, fc.uuid(), fc.uuid(), textArb, ([table, column], id, other, s) => {
        fc.pre(id !== other);
        const cell = cipher.seal(table, column, id, s);
        expect(() => cipher.open(table, column, other, cell)).toThrow(
          expect.objectContaining({ code: 'COLUMN_DECRYPT_FAILED' }),
        );
      }),
    );
  });

  it('ciphertext never contains the plaintext bytes', () => {
    fc.assert(
      fc.property(cellArb, fc.uuid(), fc.string({ minLength: 8 }), ([table, column], id, s) => {
        const plain = Buffer.from(s, 'utf8');
        expect(cipher.seal(table, column, id, s).includes(plain)).toBe(false);
      }),
    );
  });

  it('blind(scope, a) === blind(scope, b) iff a === b', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { minLength: 4, maxLength: 4 }), textArb, textArb, (scope, a, b) => {
        expect(cipher.blind(scope, a) === cipher.blind(scope, b)).toBe(a === b);
      }),
    );
  });
});
