import type { Database } from 'better-sqlite3';

export interface Migration {
  /** Version number extracted from the filename (e.g., 001 -> 1). */
  version: number;
  /** Filename for logging. */
  name: string;
  /** Full SQL body. */
  sql: string;
}

/**
 * Load migration files at build time via Vite's import.meta.glob.
 * In non-Vite test environments this function's consumers inject migrations
 * directly (via `runMigrations(db, migrations)`).
 */
export function loadMigrations(): Migration[] {
  type RawModule = { default: string };
  const modules = (import.meta as unknown as {
    glob: (pattern: string, opts: { query: string; import: string; eager: true }) => Record<string, RawModule | string>;
  }).glob('./migrations/*.sql', { query: '?raw', import: 'default', eager: true });

  const out: Migration[] = [];
  for (const [pathname, mod] of Object.entries(modules)) {
    // Match on the basename with an anchored prefix rather than on the whole
    // path with `(\d+)-[^/]+\.sql$` — `[^/]+` and `\.sql$` overlap, so that
    // pattern backtracks super-linearly (S8786).
    const name = pathname.slice(pathname.lastIndexOf('/') + 1);
    const match = /^(\d+)-/.exec(name);
    if (!match || !name.endsWith('.sql')) continue;
    const version = Number(match[1]);
    const sql = typeof mod === 'string' ? mod : (mod as RawModule).default;
    out.push({ version, name, sql });
  }
  out.sort((a, b) => a.version - b.version);
  return out;
}

/**
 * Versions must be exactly 1..N in order. A duplicate would be skipped forever
 * once its twin ran (the runner filters on version), and a gap hides a file.
 */
export function assertMigrationSequence(migrations: Migration[]): void {
  migrations.forEach((m, i) => {
    const prev = migrations[i - 1];
    if (prev && m.version === prev.version) {
      throw new Error(`duplicate migration version ${m.version}: ${prev.name}, ${m.name}`);
    }
    if (m.version !== i + 1) {
      throw new Error(`migration version gap: expected ${i + 1}, found ${m.version} (${m.name})`);
    }
  });
}

/**
 * Apply any migrations newer than the DB's current schema_version.
 * Each migration runs in its own transaction — failures roll back.
 * Returns how many migrations ran.
 */
export function runMigrations(db: Database, migrations: Migration[]): number {
  assertMigrationSequence(migrations);
  // Ensure schema_version exists. The first migration may create it; to handle
  // fresh DBs safely we read conditionally.
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();

  let current = 0;
  if (hasTable) {
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      | { version: number }
      | undefined;
    current = row?.version ?? 0;
  }

  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) return 0;

  // Disable foreign-key enforcement for the duration of the migration loop.
  // Some migrations rebuild tables (DROP + CREATE + RENAME) to work around
  // SQLite's inability to alter a CHECK constraint in place; with FKs on,
  // DROP TABLE would cascade-delete dependent rows. PRAGMA foreign_keys is a
  // no-op inside a transaction, so it must be set before each migration tx.
  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  if (fkWasOn) db.pragma('foreign_keys = OFF');
  try {
    for (const m of pending) {
      const tx = db.transaction(() => {
        // ponytail: compares counts, so orphans from older FK-off rebuilds don't
        // brick boot; a migration that fixes and re-breaks rows goes unnoticed.
        const before = db.pragma('foreign_key_check') as unknown[];
        db.exec(m.sql);
        const after = db.pragma('foreign_key_check') as unknown[];
        if (after.length > before.length) {
          throw new Error(
            `migration ${m.name} introduced ${after.length - before.length} foreign key violation(s): ${JSON.stringify(after.slice(0, 3))}`,
          );
        }
      });
      tx();
      const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
        | { version: number }
        | undefined;
      if (!row || row.version < m.version) {
        throw new Error(
          `migration ${m.name} did not advance schema_version to ${m.version}`,
        );
      }
    }
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
  return pending.length;
}
