import type { Database } from "bun:sqlite";

export type Migration = {
  version: number;
  name: string;
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

/**
 * Returns the migrations array sorted by `name` ascending. With 4-digit
 * zero-padded prefixes (e.g. `0001_foo.sql`) lex-sort matches numeric order.
 */
const sortByName = (migrations: Migration[]): Migration[] =>
  [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

export const migrate = (
  db: Database,
  migrations: Migration[],
  targetVersion: number = migrations.length,
  options: MigrateOptions = {},
): void => {
  const tableName = options.tableName ?? MIGRATIONS_TABLE;
  assertValidTableName(tableName);

  const sorted = sortByName(migrations);

  ensureMigrationsTable(db, tableName);
  selfMigrateOldSchema(db, sorted, tableName);
  bootstrapFromUserVersion(db, sorted, tableName);

  // targetVersion = N means "converge to migrations[N-1]". 0 means empty.
  if (targetVersion < 0 || targetVersion > sorted.length) {
    throw new Error(
      `targetVersion ${targetVersion} is out of range (0..${sorted.length}).`,
    );
  }

  const step = db.transaction((targetIndex: number) => {
    const appliedCount = countApplied(db, tableName);
    if (appliedCount === targetIndex) {
      return true;
    } else if (appliedCount < targetIndex) {
      upgrade(appliedCount);
      return false;
    } else {
      downgrade(appliedCount);
      return false;
    }
  });

  while (true) {
    const done: boolean = step.immediate(targetVersion);
    if (done) break;
  }

  function upgrade(appliedCount: number) {
    const migration = sorted[appliedCount];
    if (!migration) {
      throw new Error(`Cannot find migration at sorted index ${appliedCount}`);
    }

    try {
      for (const up of migration.up) {
        db.run(up);
      }
    } catch (error: unknown) {
      console.error(
        `Upgrade to migration "${migration.name}" failed.`,
      );
      throw error;
    }
    recordMigrationApplied(db, migration.name, tableName);
  }

  function downgrade(appliedCount: number) {
    // The most recently applied migration is the one we revert.
    const lastName = getMostRecentAppliedName(db, tableName);
    if (lastName === undefined) {
      throw new Error(
        `Cannot downgrade: no migrations applied (appliedCount=${appliedCount}).`,
      );
    }
    const migration = sorted.find((m) => m.name === lastName);
    if (!migration) {
      throw new Error(
        `Cannot find migration for applied name "${lastName}". ` +
          `It may have been removed from the migrations array.`,
      );
    }

    try {
      db.run(migration.down);
    } catch (e) {
      console.error(`Downgrade of migration "${migration.name}" failed.`);
      throw e;
    }
    recordMigrationReverted(db, migration.name, tableName);
  }
};

/**
 * Legacy helper — kept for back-compat. Returns the count of migrations
 * (which under the prior name-as-version regime was the max version).
 */
export const getMaximumVersion = (migrations: Migration[]): number => {
  return migrations.reduce((max, cur) => Math.max(cur.version, max), 0);
};

/**
 * Returns the number of applied migrations in the bookkeeping table.
 */
export const getDatabaseVersion = (
  db: Database,
  tableName: string = MIGRATIONS_TABLE,
): number => {
  assertValidTableName(tableName);
  return countApplied(db, tableName);
};

const countApplied = (db: Database, tableName: string): number => {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${tableName}`)
    .get() as { n: number } | undefined;
  if (!row || typeof row.n !== "number") {
    throw new Error(
      `Unexpected result when reading ${tableName}: "${JSON.stringify(row)}".`,
    );
  }
  return row.n;
};

const getMostRecentAppliedName = (
  db: Database,
  tableName: string,
): string | undefined => {
  const row = db
    .prepare(`SELECT name FROM ${tableName} ORDER BY name DESC LIMIT 1`)
    .get() as { name: string } | undefined;
  return row?.name;
};

/**
 * Idempotently creates the bookkeeping table.
 *
 * The table has two columns:
 *   name       — the migration filename (primary key).
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
      name       TEXT NOT NULL PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
  );
};

/**
 * Detects an OLD-shape `(version INTEGER PRIMARY KEY, applied_at)` bookkeeping
 * table and rewrites it to the new `(name TEXT PRIMARY KEY, applied_at)`
 * shape, using the supplied (sorted) migrations array to map version → name.
 *
 * - Table has column `name`     → already current, no-op.
 * - Table has only `version`    → migrate in one savepoint.
 * - Table has neither           → throw.
 *
 * Any applied `version` with no corresponding entry in `migrations` is an
 * orphan; we throw without mutating the table.
 */
const selfMigrateOldSchema = (
  db: Database,
  sortedMigrations: Migration[],
  tableName: string,
): void => {
  assertValidTableName(tableName);
  const cols = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as { name: string }[];
  if (cols.length === 0) {
    // Should not happen because ensureMigrationsTable ran first, but guard.
    return;
  }
  const colNames = new Set(cols.map((c) => c.name));
  if (colNames.has("name")) return;
  if (!colNames.has("version")) {
    throw new Error(
      `Bookkeeping table "${tableName}" has unrecognized schema ` +
        `(columns: ${[...colNames].join(", ")}). Expected "name" or legacy "version".`,
    );
  }

  // Build a version → name lookup from the sorted migrations.
  const versionToName = new Map<number, string>();
  for (const m of sortedMigrations) {
    versionToName.set(m.version, m.name);
  }

  const legacyRows = db
    .prepare(`SELECT version, applied_at FROM ${tableName}`)
    .all() as { version: number; applied_at: number }[];

  // Validate up-front so we throw before touching anything.
  for (const row of legacyRows) {
    if (!versionToName.has(row.version)) {
      throw new Error(
        `Cannot self-migrate "${tableName}": legacy row version=${row.version} ` +
          `has no corresponding migration in the supplied migrations array.`,
      );
    }
  }

  const newTable = `${tableName}_new`;
  assertValidTableName(newTable);

  const run = db.transaction(() => {
    db.run(
      `CREATE TABLE ${newTable} (
        name       TEXT NOT NULL PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`,
    );
    const insert = db.prepare(
      `INSERT INTO ${newTable} (name, applied_at) ` +
        `SELECT ?, applied_at FROM ${tableName} WHERE version = ?`,
    );
    for (const row of legacyRows) {
      const name = versionToName.get(row.version)!;
      insert.run(name, row.version);
    }
    db.run(`DROP TABLE ${tableName}`);
    db.run(`ALTER TABLE ${newTable} RENAME TO ${tableName}`);
  });
  run.immediate();
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
 * are not recoverable. The first `user_version` migrations (by sorted name)
 * are seeded.
 */
export const bootstrapFromUserVersion = (
  db: Database,
  sortedMigrations: Migration[] = [],
  tableName: string = MIGRATIONS_TABLE,
): void => {
  assertValidTableName(tableName);
  const n = countApplied(db, tableName);
  if (n > 0) return;

  const pragmaRow = db.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  const userVersion =
    pragmaRow && typeof pragmaRow.user_version === "number" ? pragmaRow.user_version : 0;
  if (userVersion <= 0) return;

  if (userVersion > sortedMigrations.length) {
    throw new Error(
      `Cannot bootstrap from user_version=${userVersion}: only ` +
        `${sortedMigrations.length} migrations supplied.`,
    );
  }

  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO ${tableName} (name, applied_at) VALUES (?, ?)`,
  );
  for (let i = 0; i < userVersion; i++) {
    insert.run(sortedMigrations[i]!.name, now);
  }
  db.run("PRAGMA user_version = 0");
};

const recordMigrationApplied = (
  db: Database,
  name: string,
  tableName: string,
): void => {
  db.prepare(`INSERT INTO ${tableName} (name, applied_at) VALUES (?, ?)`).run(
    name,
    Date.now(),
  );
};

const recordMigrationReverted = (
  db: Database,
  name: string,
  tableName: string,
): void => {
  db.prepare(`DELETE FROM ${tableName} WHERE name = ?`).run(name);
};
