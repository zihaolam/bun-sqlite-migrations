import type { Database } from "bun:sqlite";

export type Migration = {
  version: number;
  up: string[];
  down: string;
};

/**
 * Default name of the bookkeeping table that records which migrations have
 * been applied. Callers can override this per-call via `migrate(db, migs,
 * targetVersion?, { tableName })`.
 */
export const MIGRATIONS_TABLE = "__migrations__";

/**
 * Options accepted by `migrate()`.
 *
 *   tableName — name of the bookkeeping table. Defaults to
 *               `MIGRATIONS_TABLE` (`"__migrations__"`). Must match
 *               `/^[A-Za-z_][A-Za-z0-9_]*$/` because it is interpolated
 *               directly into DDL/DML; any other value is rejected with
 *               an `Error` before the database is touched.
 */
export type MigrateOptions = {
  tableName?: string;
};

/**
 * Allowed shape for a configurable table name. The name is interpolated
 * verbatim into SQL (it cannot be parameter-bound), so we reject anything
 * outside a conservative identifier alphabet rather than try to escape.
 */
const VALID_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const assertValidTableName = (name: string): void => {
  if (!VALID_TABLE_NAME.test(name)) {
    throw new Error(
      `Invalid migrations table name: ${JSON.stringify(name)}. ` +
        `Table name must match /^[A-Za-z_][A-Za-z0-9_]*$/ ` +
        `(start with a letter or underscore; letters, digits, and underscores only).`,
    );
  }
};

export const migrate = (
  db: Database,
  migrations: Migration[],
  targetVersion: number = getMaximumVersion(migrations),
  options: MigrateOptions = {},
): void => {
  const tableName = options.tableName ?? MIGRATIONS_TABLE;
  assertValidTableName(tableName);

  ensureMigrationsTable(db, tableName);
  bootstrapFromUserVersion(db, tableName);

  const maxVersion = getMaximumVersion(migrations);

  const migrate = db.transaction((targetVersion: number, maxVersion: number) => {
    const currentVersion = getDatabaseVersion(db, tableName);
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
    const currentVersion = getDatabaseVersion(db, tableName);
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
    recordMigrationApplied(db, targetVersion, tableName);
  }

  function downgrade() {
    const currentVersion = getDatabaseVersion(db, tableName);
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
    recordMigrationReverted(db, currentVersion, tableName);
  }
};

export const getMaximumVersion = (migrations: Migration[]): number => {
  return migrations.reduce((max, cur) => Math.max(cur.version, max), 0);
};

/**
 * Returns the highest applied migration version, or 0 if none have been
 * applied. Assumes `ensureMigrationsTable` has been called.
 */
export const getDatabaseVersion = (
  db: Database,
  tableName: string = MIGRATIONS_TABLE,
): number => {
  assertValidTableName(tableName);
  const row = db
    .prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM ${tableName}`)
    .get() as { version: number } | undefined;
  if (!row || typeof row.version !== "number") {
    throw new Error(
      `Unexpected result when reading ${tableName}: "${JSON.stringify(row)}".`,
    );
  }
  return row.version;
};

/**
 * Idempotently creates the bookkeeping table.
 *
 * The table has two columns:
 *   version    — the migration version that was applied (primary key).
 *   applied_at — unix epoch in MILLISECONDS at the time the row was inserted.
 *                Bootstrapped rows (see `bootstrapFromUserVersion`) all share
 *                a single "now" timestamp because the original application
 *                times are not recoverable from `PRAGMA user_version`.
 */
export const ensureMigrationsTable = (
  db: Database,
  tableName: string = MIGRATIONS_TABLE,
): void => {
  assertValidTableName(tableName);
  db.run(
    `CREATE TABLE IF NOT EXISTS ${tableName} (
      version    INTEGER NOT NULL PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
  );
};

/**
 * One-time, silent migration of the tracking mechanism itself.
 *
 * Predicate: bootstrap runs when the bookkeeping table is empty AND
 * `PRAGMA user_version > 0`. Both conditions must hold, which makes it
 * idempotent:
 *   - On first run against a legacy DB the rows are seeded and the pragma is
 *     zeroed, so the predicate becomes false.
 *   - On a brand-new DB `user_version` is 0, so nothing happens.
 *   - On any subsequent run the table already has rows, so nothing happens.
 *
 * Bootstrapped rows all carry the same "now" timestamp; the original times
 * are not recoverable.
 */
export const bootstrapFromUserVersion = (
  db: Database,
  tableName: string = MIGRATIONS_TABLE,
): void => {
  assertValidTableName(tableName);
  const countRow = db
    .prepare(`SELECT COUNT(*) AS n FROM ${tableName}`)
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
    `INSERT INTO ${tableName} (version, applied_at) VALUES (?, ?)`,
  );
  for (let v = 1; v <= userVersion; v++) {
    insert.run(v, now);
  }
  db.run("PRAGMA user_version = 0");
};

const recordMigrationApplied = (
  db: Database,
  version: number,
  tableName: string,
): void => {
  db.prepare(`INSERT INTO ${tableName} (version, applied_at) VALUES (?, ?)`).run(
    version,
    Date.now(),
  );
};

const recordMigrationReverted = (
  db: Database,
  version: number,
  tableName: string,
): void => {
  db.prepare(`DELETE FROM ${tableName} WHERE version = ?`).run(version);
};
