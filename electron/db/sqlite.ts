import path from 'node:path';
import fs from 'node:fs';
import { ensurePrivateDir, ensurePrivateFile } from '../utils/privateFs.ts';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { loadMigrations, runMigrations, type Migration } from './migrationRunner.ts';
import type { Logger } from '../log.ts';

export const DB_FILENAME = 'latelier.db';
/** The name builds before the rename used; older userData folders still hold it. */
export const LEGACY_DB_FILENAME = 'mongolab.db';

export interface OpenDatabaseOptions {
  /** Absolute path to the userData directory. */
  userDataDir: string;
  /** Override migrations (tests inject their own). */
  migrations?: Migration[];
  /** Override the filename (default DB_FILENAME). */
  filename?: string;
  /** Receives a warning when the post-migration WAL checkpoint could not finish. */
  log?: Pick<Logger, 'warn'>;
}

/**
 * Folds the WAL into the main file and truncates it, so pages freed under
 * `secure_delete` (zeroed) are the only copy left on disk. Returns false when
 * SQLite reports the checkpoint was blocked by another connection.
 */
export function truncateWal(db: Database): boolean {
  const [row] = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
  return row?.busy === 0;
}

/**
 * Rebuilds the file so bytes freed before `secure_delete` was on (older
 * installs) or left in page slack by an in-place rewrite do not linger, then
 * folds and truncates the WAL that the rebuild wrote. VACUUM needs free disk
 * about the size of the database and the work before it has committed, so
 * with a logger a failure is reported rather than thrown. `when` names the
 * step in the log line. Returns whether the VACUUM itself succeeded.
 */
export function vacuumAndTruncateWal(db: Database, when: string, log?: Pick<Logger, 'warn'>): boolean {
  let vacuumed = true;
  try {
    db.exec('VACUUM');
  } catch (err) {
    if (!log) throw err;
    log.warn('db', `vacuum ${when} failed`, { message: String(err) });
    vacuumed = false;
  }
  if (!truncateWal(db)) log?.warn('db', `wal checkpoint ${when} was blocked`);
  return vacuumed;
}

/**
 * `app_state` key present while a VACUUM that must erase plaintext is still
 * owed. A failed VACUUM (disk full) after work that has already committed
 * would otherwise never be retried: the next boot has nothing left to
 * convert and no migration to run. It lives in `app_state` because that is
 * where main keeps its own maintenance state, it survives "Reset protected
 * data" (which empties `column_keys`), and the renderer can neither read nor
 * write it (it is not on the prefs allowlist). Only its presence counts.
 */
export const VACUUM_PENDING_KEY = 'db.vacuumPending';

export function markVacuumPending(db: Database): void {
  db.prepare(
    `INSERT INTO app_state (key, value_json, updated_at) VALUES (?, 'true', ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(VACUUM_PENDING_KEY, new Date().toISOString());
}

export function isVacuumPending(db: Database): boolean {
  return db.prepare('SELECT 1 FROM app_state WHERE key = ?').get(VACUUM_PENDING_KEY) !== undefined;
}

/** Runs the owed VACUUM and clears the marker only when it succeeded. */
export function runOwedVacuum(db: Database, when: string, log: Pick<Logger, 'warn'>): boolean {
  if (!vacuumAndTruncateWal(db, when, log)) return false;
  db.prepare('DELETE FROM app_state WHERE key = ?').run(VACUUM_PENDING_KEY);
  truncateWal(db);
  return true;
}

/**
 * Moves a database left under the pre-rename name to DB_FILENAME and returns
 * the filename to open. Must run before openDatabase: ensurePrivateFile creates
 * an empty DB_FILENAME, after which the legacy file would never be adopted.
 *
 * The rename moves the main file alone, so the WAL is folded in first — a bare
 * open and close does not read the WAL and a rename then drops every row still
 * in it. Leftover side files after close mean another connection holds the
 * database; renaming under it would split its writes from the main file, so the
 * old name is kept for this run and the rename is retried on the next start.
 * An existing DB_FILENAME always wins and the legacy file is left untouched.
 * A WAL is not tied to its database file, so a stray `-wal`/`-shm` under the
 * new name would be replayed onto the legacy data; the rename waits for those
 * to be gone.
 */
export function adoptLegacyDatabase(userDataDir: string, log: Pick<Logger, 'info' | 'warn'>): string {
  const current = path.join(userDataDir, DB_FILENAME);
  const legacy = path.join(userDataDir, LEGACY_DB_FILENAME);
  if (fs.existsSync(current)) {
    if (fs.existsSync(legacy)) log.warn('db', 'legacy database left in place, the current one already exists', { legacy: LEGACY_DB_FILENAME });
    return DB_FILENAME;
  }
  if (!fs.existsSync(legacy)) return DB_FILENAME;
  const strays = ['-wal', '-shm'].filter((s) => fs.existsSync(current + s));
  if (strays.length > 0) {
    log.warn('db', 'side files of a missing current database are present, keeping the legacy name for this run', { strays });
    return LEGACY_DB_FILENAME;
  }
  try {
    // timeout 0: a database held by another process fails fast instead of
    // stalling boot on the busy handler; the rename is retried next start.
    const old = new BetterSqlite3(legacy, { fileMustExist: true, timeout: 0 });
    let folded: boolean;
    try {
      folded = truncateWal(old);
    } finally {
      old.close();
    }
    const leftovers = ['-wal', '-shm'].filter((s) => fs.existsSync(legacy + s));
    if (!folded || leftovers.length > 0) {
      log.warn('db', 'legacy database is in use, keeping its name for this run', { busy: !folded, leftovers });
      return LEGACY_DB_FILENAME;
    }
    fs.renameSync(legacy, current);
  } catch (err) {
    log.warn('db', 'could not rename the legacy database, keeping its name for this run', { message: String(err) });
    return LEGACY_DB_FILENAME;
  }
  log.info('db', 'renamed the legacy database', { from: LEGACY_DB_FILENAME, to: DB_FILENAME });
  return DB_FILENAME;
}

export function openDatabase(opts: OpenDatabaseOptions): Database {
  const filename = opts.filename ?? DB_FILENAME;
  ensurePrivateDir(opts.userDataDir);
  const dbPath = path.join(opts.userDataDir, filename);
  // Before SQLite opens the file, so it creates `-wal`/`-shm` at the same
  // owner-only mode; side files left by an older install are tightened below.
  ensurePrivateFile(dbPath);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) ensurePrivateFile(dbPath + suffix);
  }

  const db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Per-connection, and on before migrations so a migration that scrubs data
  // zeroes the bytes it frees instead of leaving them in a free page.
  db.pragma('secure_delete = ON');
  // VACUUM builds its copy in a temp database; on disk that copy would hold
  // every still-plaintext row of an upgrade in a file nothing scrubs.
  db.pragma('temp_store = MEMORY');

  const migrations = opts.migrations ?? loadMigrations();
  // An upgrade's migrations may scrub data, so the file is rebuilt after them.
  // A failed VACUUM leaves the marker, so the post-open step retries it. With
  // a logger, neither failure fails the boot: the migrations have committed.
  if (runMigrations(db, migrations) > 0) {
    if (!vacuumAndTruncateWal(db, 'after migrations', opts.log)) {
      try {
        markVacuumPending(db);
      } catch (err) {
        if (!opts.log) throw err;
        opts.log.warn('db', 'could not record the owed vacuum', { message: String(err) });
      }
    }
  } else if (!truncateWal(db)) {
    opts.log?.warn('db', 'wal checkpoint after migrations was blocked');
  }

  return db;
}

/**
 * The dev reset: empties the live database instead of deleting its files.
 * Deleting connections cascades to connection_secrets, saved_queries,
 * recent_queries, workspace_tabs, reference_rules, audit_log and
 * recent_field_values. `column_keys` stays, so the cipher the repositories
 * hold keeps matching the (now empty) data. Every service keeps its handle,
 * which is why this works where reopening the file did not.
 */
export function resetDatabaseInPlace(db: Database, log: Pick<Logger, 'warn'>): void {
  db.transaction(() => {
    db.prepare('DELETE FROM connections').run();
    db.prepare('DELETE FROM app_state').run();
    markVacuumPending(db);
  })();
  runOwedVacuum(db, 'after the dev reset', log);
}

export function closeDatabase(db: Database): void {
  try {
    db.close();
  } catch {
    // ignore double-close
  }
}

export function withTransaction<T>(db: Database, fn: () => T): T {
  const tx = db.transaction(fn);
  return tx();
}
