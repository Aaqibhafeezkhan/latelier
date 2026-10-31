import type { Database } from 'better-sqlite3';
import { SystemError } from '../errors.ts';
import type { Logger } from '../log.ts';
import type { SafeStorageLike } from '../secrets/SecretsVault.ts';
import { COLUMN_KEY_BYTES, ColumnCipher, type ColumnKeys } from './columnCipher.ts';
import { isVacuumPending, markVacuumPending, runOwedVacuum, truncateWal } from './sqlite.ts';

export interface LoadedColumnKeys {
  keys: ColumnKeys;
  /** False when the key sits in the database unwrapped because no usable keychain exists. */
  protected: boolean;
}

interface KeyRow {
  wrapped: Buffer;
  is_plaintext: number;
}

/** The four tables whose encrypted column can still hold plaintext from before the upgrade. */
const LEGACY_COLUMNS = [
  ['recent_queries', 'payload_json'],
  ['audit_log', 'summary_json'],
  ['saved_queries', 'payload_json'],
  ['workspace_tabs', 'state_json'],
] as const;

/** Every table "Reset protected data" empties; the key goes with the cells it sealed. */
const PROTECTED_TABLES = [
  'recent_queries',
  'recent_field_values',
  'audit_log',
  'workspace_tabs',
  'saved_queries',
  'column_keys',
] as const;

export interface ColumnKeyDialogCopy {
  /** `unreachable`: the keychain cannot be asked right now; `gone`: it answered and cannot decrypt. */
  kind: 'unreachable' | 'gone';
  message: string;
  detail: string;
}

/**
 * Copy for the boot dialog shown when the column key cannot be unwrapped.
 * Decided by availability alone, never by Electron's error text. An
 * unavailable keychain is almost always temporary on every platform — a
 * denied macOS prompt lasts until relaunch, a Linux keyring can be locked,
 * missing from an SSH session or behind a dead D-Bus — so that copy steers
 * away from Reset, which would wipe data over a condition that fixes itself.
 */
export function columnKeyDialogCopy(encryptionAvailable: boolean, platform: NodeJS.Platform): ColumnKeyDialogCopy {
  const what = 'It encrypts your saved queries, query history, value suggestions, audit log and open tabs.';
  const reset =
    'Reset protected data deletes all of those and creates a new key. Connections are kept; a saved password the keychain can no longer read will need re-entering.';
  if (!encryptionAvailable) {
    const retry =
      platform === 'darwin'
        ? "macOS keeps refusing until the app is relaunched. Quit, reopen L'Atelier and click Always Allow when macOS asks."
        : "Quit and start L'Atelier again from your normal desktop session, with your keyring unlocked.";
    return {
      kind: 'unreachable',
      message: "The OS keychain that holds your local data key can't be reached right now.",
      detail: `${what}\n\n${retry}\n\nOnly if the keychain is gone for good: ${reset}`,
    };
  }
  return {
    kind: 'gone',
    message: 'The key that protects your local data is no longer in the OS keychain.',
    detail: `${what}\n\nThe keychain item was removed or reset, the user profile moved, or the keyring password changed. If you can restore it, quit and do that first.\n\n${reset}`,
  };
}

function unreadable(message: string, safeStorage: SafeStorageLike, cause?: unknown): SystemError {
  return new SystemError('COLUMN_KEY_UNREADABLE', message, {
    ...(cause === undefined ? {} : { cause: cause instanceof Error ? cause.message : String(cause) }),
    // Lets the boot dialog tell a denied macOS keychain from a key that is gone.
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  });
}

/** A key of the wrong length is never truncated or padded: it would seal with a different key. */
function split(raw: Buffer, safeStorage: SafeStorageLike): ColumnKeys {
  if (raw.length !== 2 * COLUMN_KEY_BYTES) {
    throw unreadable('The stored column key has the wrong length.', safeStorage);
  }
  return {
    enc: Buffer.from(raw.subarray(0, COLUMN_KEY_BYTES)),
    mac: Buffer.from(raw.subarray(COLUMN_KEY_BYTES)),
  };
}

/**
 * Null when the keychain refuses: on macOS the first encryptString is what
 * shows the Keychain prompt, and Deny makes it throw. That is handled like a
 * missing keychain, because columns must keep persisting either way.
 */
function tryWrap(keys: ColumnKeys, safeStorage: SafeStorageLike, log: Pick<Logger, 'warn'>): Buffer | null {
  try {
    return safeStorage.encryptString(Buffer.concat([keys.enc, keys.mac]).toString('base64'));
  } catch (err) {
    log.warn('db', 'keychain refused to wrap the column key', { message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Loads the column key, creating it on first run. Modelled on the secrets
 * vault: wrapped by the keychain when one is usable, stored raw with
 * `is_plaintext = 1` when not — columns cannot refuse to persist the way the
 * vault refuses a password, because tabs and saved queries must survive. A
 * wrapped key that no longer decrypts throws `COLUMN_KEY_UNREADABLE` and is
 * left untouched: regenerating it would orphan every sealed cell silently.
 */
export function loadOrCreateColumnKeys(
  db: Database,
  safeStorage: SafeStorageLike,
  log: Pick<Logger, 'info' | 'warn'>,
): LoadedColumnKeys {
  const row = db.prepare('SELECT wrapped, is_plaintext FROM column_keys WHERE id = 1').get() as KeyRow | undefined;
  const available = safeStorage.isEncryptionAvailable();

  if (!row) {
    const keys = ColumnCipher.generate();
    const wrapped = available ? tryWrap(keys, safeStorage, log) : null;
    db.prepare('INSERT INTO column_keys (id, wrapped, is_plaintext, created_at) VALUES (1, ?, ?, ?)').run(
      wrapped ?? Buffer.concat([keys.enc, keys.mac]),
      wrapped ? 0 : 1,
      new Date().toISOString(),
    );
    if (!wrapped) log.warn('db', 'no usable keychain, column key stored unprotected');
    return { keys, protected: wrapped !== null };
  }

  if (row.is_plaintext !== 1) {
    let encoded: string;
    try {
      encoded = safeStorage.decryptString(row.wrapped);
    } catch (err) {
      throw unreadable('The column key could not be decrypted by the OS keychain.', safeStorage, err);
    }
    return { keys: split(Buffer.from(encoded, 'base64'), safeStorage), protected: true };
  }

  const keys = split(row.wrapped, safeStorage);
  const wrapped = available ? tryWrap(keys, safeStorage, log) : null;
  if (!wrapped) {
    log.warn('db', 'no usable keychain, column key stays unprotected');
    return { keys, protected: false };
  }
  db.prepare('UPDATE column_keys SET wrapped = ?, is_plaintext = 0 WHERE id = 1').run(wrapped);
  // The raw key's page image is still in the WAL until it is folded in.
  truncateWal(db);
  log.info('db', 'column key wrapped by the keychain');
  return { keys, protected: true };
}

/**
 * Seals every cell still holding plaintext from before the upgrade. Safe to
 * run on every boot: a converted cell is a BLOB and no longer matches.
 *
 * The VACUUM is what actually erases the old plaintext. Rows written before
 * `secure_delete` existed leave stale copies in page slack and on freelist
 * pages that an UPDATE plus checkpoint never touch, and the VACUUM inside
 * `openDatabase` ran before this step, while the rows were still plaintext.
 */
export function encryptLegacyRows(db: Database, cipher: ColumnCipher, log: Pick<Logger, 'info' | 'warn'>): number {
  const converted = db.transaction(() => {
    let count = 0;
    for (const [table, column] of LEGACY_COLUMNS) {
      const rows = db
        .prepare(`SELECT id, ${column} AS cell FROM ${table} WHERE typeof(${column}) = 'text'`)
        .all() as Array<{ id: string; cell: string }>;
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
      for (const { id, cell } of rows) update.run(cipher.seal(table, column, id, cell), id);
      count += rows.length;
    }
    // Committed with the conversion, so a VACUUM that fails below, or a crash
    // before it, is retried on the next boot.
    if (count > 0) markVacuumPending(db);
    return count;
  })();
  if (converted > 0) log.info('db', 'encrypted legacy rows', { converted });
  if (converted > 0 || isVacuumPending(db)) runOwedVacuum(db, 'after encrypting legacy rows', log);
  return converted;
}

/**
 * The "Reset protected data" answer to an unreadable key at boot: every sealed
 * cell and the key itself go in one transaction, then the file is rebuilt so
 * nothing of them stays on disk. Connections and their passwords are kept.
 */
export function resetProtectedData(db: Database, log: Pick<Logger, 'warn'>): void {
  db.transaction(() => {
    for (const table of PROTECTED_TABLES) db.prepare(`DELETE FROM ${table}`).run();
    markVacuumPending(db);
  })();
  runOwedVacuum(db, 'after resetting protected data', log);
}
