import crypto from 'node:crypto';
import { SystemError } from '../errors.ts';

/** Two independent 32-byte keys: one encrypts cells, one keys the blind index. */
export interface ColumnKeys {
  enc: Buffer;
  mac: Buffer;
}

export const COLUMN_KEY_BYTES = 32;
const FORMAT_VERSION = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + NONCE_BYTES;
const PAD_BLOCK = 32;
const PAD_MARKER = 0x80;

/**
 * Columns whose plaintext length is itself revealing. A short literal in the
 * value-suggestion cache ("yes", a 4-digit PIN) would otherwise be readable
 * from the ciphertext length alone; the JSON columns are long and varied
 * enough that their length says little. Decided by the cipher, not the
 * caller, so a repository cannot pad on write and forget to strip on read.
 */
const PADDED_COLUMNS: ReadonlySet<string> = new Set(['recent_field_values.value']);

/**
 * Columns that never held plaintext: migration 016 rebuilt them empty. A TEXT
 * cell there can only be written by someone editing the file, so it is
 * refused rather than read as legacy plaintext, which would let them plant
 * chosen text past the AAD binding.
 */
const SEALED_ONLY_COLUMNS: ReadonlySet<string> = new Set(['recent_field_values.value']);

/**
 * Always appends a marker byte, then zeros up to the next block. A value that
 * already fills whole blocks gets a full extra one, so every input — trailing
 * NULs and trailing marker bytes included — round-trips exactly.
 */
function pad(plain: Buffer): Buffer {
  const out = Buffer.alloc((Math.floor(plain.length / PAD_BLOCK) + 1) * PAD_BLOCK);
  plain.copy(out);
  out[plain.length] = PAD_MARKER;
  return out;
}

/** Null when the padding is malformed; the caller turns that into the coded error. */
function unpad(padded: Buffer): Buffer | null {
  const end = padded.lastIndexOf(PAD_MARKER);
  if (end < 0 || !padded.subarray(end + 1).every((b) => b === 0)) return null;
  return padded.subarray(0, end);
}

/**
 * Encrypts Mongo-derived values at the repository boundary. A cell is
 * `version || nonce || AES-256-GCM(text) || tag`, authenticated against the
 * table, column and row id it was written for, so a cell moved anywhere else
 * fails to open instead of decrypting into the wrong place.
 */
export class ColumnCipher {
  private readonly enc: Buffer;
  private readonly mac: Buffer;

  constructor(keys: ColumnKeys) {
    if (keys.enc.length !== COLUMN_KEY_BYTES || keys.mac.length !== COLUMN_KEY_BYTES) {
      throw new SystemError('COLUMN_KEY_UNREADABLE', 'Column keys must be 32 bytes each.');
    }
    this.enc = keys.enc;
    this.mac = keys.mac;
  }

  static generate(): ColumnKeys {
    return { enc: crypto.randomBytes(COLUMN_KEY_BYTES), mac: crypto.randomBytes(COLUMN_KEY_BYTES) };
  }

  seal(table: string, column: string, id: string, plaintext: string): Buffer {
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.enc, nonce);
    cipher.setAAD(aad(table, column, id));
    let body: Buffer = Buffer.from(plaintext);
    if (PADDED_COLUMNS.has(`${table}.${column}`)) body = pad(body);
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    return Buffer.concat([Buffer.of(FORMAT_VERSION), nonce, ciphertext, cipher.getAuthTag()]);
  }

  /** A string is a legacy plaintext cell and is returned as-is, except in a sealed-only column. */
  open(table: string, column: string, id: string, cell: string | Buffer): string {
    const fail = (reason: string) =>
      new SystemError('COLUMN_DECRYPT_FAILED', 'A stored value could not be decrypted.', {
        table,
        column,
        id,
        reason,
      });
    if (typeof cell === 'string') {
      if (SEALED_ONLY_COLUMNS.has(`${table}.${column}`)) throw fail('plaintext cell in a sealed-only column');
      return cell;
    }
    if (cell.length < HEADER_BYTES + TAG_BYTES) throw fail('truncated cell');
    if (cell[0] !== FORMAT_VERSION) throw fail('unknown format version');
    // The tag slice is always TAG_BYTES long, so a truncated-tag forgery
    // cannot be expressed in this format.
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.enc, cell.subarray(1, HEADER_BYTES));
    decipher.setAAD(aad(table, column, id));
    decipher.setAuthTag(cell.subarray(cell.length - TAG_BYTES));
    const head = decipher.update(cell.subarray(HEADER_BYTES, cell.length - TAG_BYTES));
    let plain: Buffer;
    try {
      // GCM verifies the tag only here; `head` is dropped on failure, so a
      // forged cell never yields partial plaintext.
      plain = Buffer.concat([head, decipher.final()]);
    } catch {
      throw fail('authentication failed');
    }
    if (!PADDED_COLUMNS.has(`${table}.${column}`)) return plain.toString('utf8');
    const unpadded = unpad(plain);
    if (!unpadded) throw fail('malformed padding');
    return unpadded.toString('utf8');
  }

  /**
   * Deterministic keyed hash for equality lookups (the value-suggestion
   * cache's UNIQUE index). Scoped, so the same literal under two fields or
   * connections hashes differently and the index reveals no cross-field
   * equality.
   */
  blind(scope: readonly string[], value: string): string {
    return crypto.createHmac('sha256', this.mac).update([...scope, value].join('\0')).digest('base64url');
  }
}

function aad(table: string, column: string, id: string): Buffer {
  return Buffer.from(`${table}.${column}:${id}`);
}
