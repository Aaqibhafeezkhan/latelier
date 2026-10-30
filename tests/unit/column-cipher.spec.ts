import crypto from 'node:crypto';
import { beforeEach, describe, it, expect } from 'vitest';
import { ColumnCipher, type ColumnKeys } from '../../electron/db/columnCipher';

const KEYS: ColumnKeys = { enc: Buffer.alloc(32, 1), mac: Buffer.alloc(32, 2) };
// Built per test: Stryker loads this module once, so a constructor mutant
// only shows up when construction happens inside a test.
let cipher: ColumnCipher;
beforeEach(() => {
  cipher = new ColumnCipher(KEYS);
});
const ID = '0b4f3c1e-2d5a-4e6f-8a9b-0c1d2e3f4a5b';
const OVERHEAD = 1 + 12 + 16;

/** Encrypts `body` in the cell format directly, to build cells `seal` never writes. */
function handBuilt(table: string, column: string, id: string, body: Buffer, version = 1): Buffer {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEYS.enc, nonce, { authTagLength: 16 });
  c.setAAD(Buffer.from(`${table}.${column}:${id}`));
  const ct = Buffer.concat([c.update(body), c.final()]);
  return Buffer.concat([Buffer.of(version), nonce, ct, c.getAuthTag()]);
}

function expectDecryptFailed(fn: () => unknown, reason: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toMatchObject({
    code: 'COLUMN_DECRYPT_FAILED',
    message: 'A stored value could not be decrypted.',
    details: { reason },
  });
}

describe('ColumnCipher', () => {
  it('round-trips text through seal and open', () => {
    const text = '{"filter":{"email":"ada@example.com"},"note":"ünï ✓ 🚀"}';
    const cell = cipher.seal('saved_queries', 'payload_json', ID, text);
    expect(Buffer.isBuffer(cell)).toBe(true);
    expect(cipher.open('saved_queries', 'payload_json', ID, cell)).toBe(text);
  });

  it('writes version byte 1, a fresh nonce per write, and plaintext + 29 bytes', () => {
    const a = cipher.seal('audit_log', 'summary_json', ID, 'abc');
    const b = cipher.seal('audit_log', 'summary_json', ID, 'abc');
    expect(a[0]).toBe(1);
    expect(a.length).toBe(3 + OVERHEAD);
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
  });

  it('opens a cell built by hand in the documented format', () => {
    const cell = handBuilt('workspace_tabs', 'state_json', ID, Buffer.from('{"a":1}'));
    expect(cipher.open('workspace_tabs', 'state_json', ID, cell)).toBe('{"a":1}');
  });

  it('round-trips the empty string at exactly the minimum cell length', () => {
    const cell = cipher.seal('recent_queries', 'payload_json', ID, '');
    expect(cell.length).toBe(OVERHEAD);
    expect(cipher.open('recent_queries', 'payload_json', ID, cell)).toBe('');
  });

  it('returns a legacy string cell as-is', () => {
    expect(cipher.open('saved_queries', 'payload_json', ID, '{"legacy":true}')).toBe('{"legacy":true}');
    expect(cipher.open('recent_queries', 'payload_json', ID, 'plain\u0080\0')).toBe('plain\u0080\0');
  });

  it('refuses a TEXT cell in recent_field_values.value, which never held legacy plaintext', () => {
    expectDecryptFailed(
      () => cipher.open('recent_field_values', 'value', ID, 'planted'),
      'plaintext cell in a sealed-only column',
    );
    // Same column name under another table is still a legacy cell.
    expect(cipher.open('recent_field_values', 'field', ID, 'f')).toBe('f');
    expect(cipher.open('other', 'value', ID, 'v')).toBe('v');
  });

  it('rejects a cell opened under another table, column or id', () => {
    const cell = cipher.seal('saved_queries', 'payload_json', ID, 'x');
    expectDecryptFailed(() => cipher.open('recent_queries', 'payload_json', ID, cell), 'authentication failed');
    expectDecryptFailed(() => cipher.open('saved_queries', 'name', ID, cell), 'authentication failed');
    expectDecryptFailed(() => cipher.open('saved_queries', 'payload_json', `${ID}x`, cell), 'authentication failed');
  });

  it('binds table, column and id with their separators, not just their concatenation', () => {
    const cell = handBuilt('a', 'b', 'c', Buffer.from('v'));
    expect(cipher.open('a', 'b', 'c', cell)).toBe('v');
    expectDecryptFailed(() => cipher.open('a.b', '', 'c', cell), 'authentication failed');
  });

  it('rejects a flipped bit in the nonce, the ciphertext or the tag', () => {
    const cell = cipher.seal('saved_queries', 'payload_json', ID, 'some secret text');
    for (const at of [1, 13, cell.length - 1]) {
      const bad = Buffer.from(cell);
      bad[at] = bad[at]! ^ 0x01;
      expectDecryptFailed(() => cipher.open('saved_queries', 'payload_json', ID, bad), 'authentication failed');
    }
  });

  it('rejects an unknown version byte', () => {
    const cell = cipher.seal('saved_queries', 'payload_json', ID, 'x');
    cell[0] = 2;
    expectDecryptFailed(() => cipher.open('saved_queries', 'payload_json', ID, cell), 'unknown format version');
  });

  it('rejects a cell shorter than header and tag with the coded error', () => {
    const cell = cipher.seal('saved_queries', 'payload_json', ID, '');
    expectDecryptFailed(
      () => cipher.open('saved_queries', 'payload_json', ID, cell.subarray(0, OVERHEAD - 1)),
      'truncated cell',
    );
    expectDecryptFailed(() => cipher.open('saved_queries', 'payload_json', ID, Buffer.alloc(0)), 'truncated cell');
  });

  it('carries the cell coordinates in the error details', () => {
    const cell = cipher.seal('saved_queries', 'payload_json', ID, 'x');
    expect(() => cipher.open('workspace_tabs', 'state_json', 'other', cell)).toThrow(
      expect.objectContaining({ details: { table: 'workspace_tabs', column: 'state_json', id: 'other', reason: 'authentication failed' } }),
    );
  });

  it('refuses keys that are not 32 bytes each', () => {
    expect(() => new ColumnCipher({ enc: Buffer.alloc(31), mac: Buffer.alloc(32) })).toThrow(
      expect.objectContaining({ code: 'COLUMN_KEY_UNREADABLE' }),
    );
    expect(() => new ColumnCipher({ enc: Buffer.alloc(32), mac: Buffer.alloc(33) })).toThrow(
      expect.objectContaining({ code: 'COLUMN_KEY_UNREADABLE', message: 'Column keys must be 32 bytes each.' }),
    );
    expect(() => new ColumnCipher({ enc: Buffer.alloc(32), mac: Buffer.alloc(32) })).not.toThrow();
  });

  it('generate yields two distinct 32-byte keys, fresh on each call', () => {
    const a = ColumnCipher.generate();
    const b = ColumnCipher.generate();
    expect(a.enc.length).toBe(32);
    expect(a.mac.length).toBe(32);
    expect(a.enc.equals(a.mac)).toBe(false);
    expect(a.enc.equals(b.enc)).toBe(false);
    expect(() => new ColumnCipher(a)).not.toThrow();
  });

  describe('blind', () => {
    it('is the base64url HMAC-SHA256 of the NUL-joined scope and value', () => {
      const expected = crypto
        .createHmac('sha256', KEYS.mac)
        .update('conn\0db\0coll\0field\0value')
        .digest('base64url');
      expect(cipher.blind(['conn', 'db', 'coll', 'field'], 'value')).toBe(expected);
    });

    it('is deterministic and sensitive to scope, value and key', () => {
      const scope = ['c', 'd', 'e', 'f'];
      expect(cipher.blind(scope, 'v')).toBe(cipher.blind(scope, 'v'));
      expect(cipher.blind(scope, 'v')).not.toBe(cipher.blind(scope, 'w'));
      expect(cipher.blind(scope, 'v')).not.toBe(cipher.blind(['c', 'd', 'e', 'g'], 'v'));
      const other = new ColumnCipher({ enc: KEYS.enc, mac: Buffer.alloc(32, 3) });
      expect(other.blind(scope, 'v')).not.toBe(cipher.blind(scope, 'v'));
    });
  });

  describe('recent_field_values padding', () => {
    // Called inside tests only, after beforeEach built `cipher`.
    const seal = (v: string) => cipher.seal('recent_field_values', 'value', ID, v);
    const open = (cell: Buffer) => cipher.open('recent_field_values', 'value', ID, cell);

    it('pads to the next 32-byte multiple, a full block when already aligned', () => {
      expect(seal('').length).toBe(32 + OVERHEAD);
      expect(seal('a'.repeat(31)).length).toBe(32 + OVERHEAD);
      expect(seal('a'.repeat(32)).length).toBe(64 + OVERHEAD);
      expect(seal('a'.repeat(33)).length).toBe(64 + OVERHEAD);
      // Counted in UTF-8 bytes: 16 two-byte characters fill one block.
      expect(seal('é'.repeat(16)).length).toBe(64 + OVERHEAD);
    });

    it('does not pad any other column', () => {
      expect(cipher.seal('recent_queries', 'value', ID, 'abc').length).toBe(3 + OVERHEAD);
      expect(cipher.seal('saved_queries', 'payload_json', ID, 'abc').length).toBe(3 + OVERHEAD);
    });

    it('round-trips exactly, trailing NULs and marker bytes included', () => {
      for (const v of ['', 'yes', '1234', 'a'.repeat(32), 'ends\0\0', '\u0080', 'x\u0080\0', '\0'.repeat(40)]) {
        expect(open(seal(v))).toBe(v);
      }
    });

    it('rejects an authentic cell whose padding is malformed', () => {
      const noMarker = handBuilt('recent_field_values', 'value', ID, Buffer.alloc(32));
      expectDecryptFailed(() => open(noMarker), 'malformed padding');
      const tail = Buffer.alloc(32);
      tail[3] = 0x80;
      tail[10] = 0x01;
      expectDecryptFailed(() => open(handBuilt('recent_field_values', 'value', ID, tail)), 'malformed padding');
    });

    it('strips everything from the last marker on', () => {
      const body = Buffer.alloc(32);
      Buffer.from('ab').copy(body);
      body[2] = 0x80;
      expect(open(handBuilt('recent_field_values', 'value', ID, body))).toBe('ab');
    });
  });
});
