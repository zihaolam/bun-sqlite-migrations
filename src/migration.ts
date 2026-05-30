import type { Database } from "bun:sqlite";

export type Migration = {
  version: number;
  up: string[];
  down: string;
};

/**
 * Name of the bookkeeping table that records which migrations have been
 * applied. Created on demand by `ensureMigrationsTable`.
 */
export const MIGRATIONS_TABLE = "__migrations__";

/**
 * DDL for the bookkeeping table.
 *
 *   version    — the migration version that was applied (primary key).
 *   applied_at — unix epoch in MILLISECONDS at the time the row was inserted.
 *                Bootstrapped rows (see `bootstrapFromUserVersion`) all share a
 *                single "now" timestamp because the original application times
 *                are not recoverable from `PRAGMA user_version`.
 */
const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  version    INTEGER NOT NULL PRIMARY KEY,
  applied_at INTEGER NOT NULL
)`;

export const migrate = (
  db: Database,
  migrations: Migration[],
  targetVersion: number = getMaximumVersion(migrations),
): void => {
  ensureMigrationsTable(db);
  bootstrapFromUserVersion(db);

  const maxVersion = getMaximumVersion(migrations);

  const migrate = db.transaction((targetVersion: number, maxVersion: number) => {
    const currentVersion = getDatabaseVersion(db);
    if (maxVersion < currentVersion) {
      return true;
    } else {
      if (currentVersion === targetVersion) {
        return true;
      } else if (currentVersion < targetVersion) {
        upgrade();
        return false;
      } else {
        downgrade();
        return false;
      }
    }
  });

  while (true) {
    const done: boolean = migrate.immediate(targetVersion, maxVersion);
    if (done) break;
  }

  function upgrade() {
    const currentVersion = getDatabaseVersion(db);
    const targetVersion = currentVersion + 1;

    const migration = migrations.find((x) => x.version === targetVersion);
    if (!migration) {
      throw new Error(`Cannot find migration for version ${targetVersion}`);
    }

    try {
      for (const up of migration.up) {
        db.run(up);
      }
    } catch (error: unknown) {
      console.error(`Upgrade from version ${currentVersion} to version ${targetVersion} failed.`);
      throw error;
    }
    recordMigrationApplied(db, targetVersion);
  }

  function downgrade() {
    const currentVersion = getDatabaseVersion(db);
    const targetVersion = currentVersion - 1;

    const migration = migrations.find((x) => x.version === currentVersion);
    if (!migration) {
      throw new Error(`Cannot find migration for version ${targetVersion}`);
    }

    try {
      db.run(migration.down);
    } catch (e) {
      console.error(`Downgrade from version ${currentVersion} to version ${targetVersion} failed.`);
      throw e;
    }
    recordMigrationReverted(db, currentVersion);
  }
};

export const getMaximumVersion = (migrations: Migration[]): number => {
  return migrations.reduce((max, cur) => Math.max(cur.version, max), 0);
};

/**
 * Returns the highest applied migration version, or 0 if none have been
 * applied. Assumes `ensureMigrationsTable` has been called.
 */
export const getDatabaseVersion = (db: Database): number => {
  const row = db
    .prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM ${MIGRATIONS_TABLE}`)
    .get() as { version: number } | undefined;
  if (!row || typeof row.version !== "number") {
    throw new Error(
      `Unexpected result when reading ${MIGRATIONS_TABLE}: "${JSON.stringify(row)}".`,
    );
  }
  return row.version;
};

/**
 * Idempotently creates the bookkeeping table.
 */
export const ensureMigrationsTable = (db: Database): void => {
  db.run(CREATE_TABLE_SQL);
};

/**
 * One-time, silent migration of the tracking mechanism itself.
 *
 * Predicate: bootstrap runs when `__migrations__` is empty AND
 * `PRAGMA user_version > 0`. Both conditions must hold, which makes it
 * idempotent:
 *   - On first run against a legacy DB the rows are seeded and the pragma is
 *     zeroed, so the predicate becomes false.
 *   - On a brand-new DB `user_version` is 0, so nothing happens.
 *   - On any subsequent run `__migrations__` already has rows, so nothing
 *     happens.
 *
 * Bootstrapped rows all carry the same "now" timestamp; the original times
 * are not recoverable.
 */
export const bootstrapFromUserVersion = (db: Database): void => {
  const countRow = db
    .prepare(`SELECT COUNT(*) AS n FROM ${MIGRATIONS_TABLE}`)
    .get() as { n: number };
  if (countRow.n > 0) return;

  const pragmaRow = db.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  const userVersion =
    pragmaRow && typeof pragmaRow.user_version === "number" ? pragmaRow.user_version : 0;
  if (userVersion <= 0) return;

  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO ${MIGRATIONS_TABLE} (version, applied_at) VALUES (?, ?)`,
  );
  for (let v = 1; v <= userVersion; v++) {
    insert.run(v, now);
  }
  db.run("PRAGMA user_version = 0");
};

const recordMigrationApplied = (db: Database, version: number): void => {
  db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (version, applied_at) VALUES (?, ?)`).run(
    version,
    Date.now(),
  );
};

const recordMigrationReverted = (db: Database, version: number): void => {
  db.prepare(`DELETE FROM ${MIGRATIONS_TABLE} WHERE version = ?`).run(version);
};
