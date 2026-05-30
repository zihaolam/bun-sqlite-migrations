import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { parseSqlContent } from './migrator'
import {
  MIGRATIONS_TABLE,
  ensureMigrationsTable,
  getDatabaseVersion,
  migrate,
  type Migration,
} from './migration'

const pad = (n: number): string => n.toString().padStart(4, '0')

const makeMigration = (version: number): Migration => ({
  version,
  name: `${pad(version)}_t_${version}.sql`,
  up: [`CREATE TABLE t_${version} (id INTEGER PRIMARY KEY)`],
  down: `DROP TABLE t_${version}`,
})

const readPragmaUserVersion = (db: Database): number =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

const readAppliedNames = (db: Database, tableName: string = MIGRATIONS_TABLE): string[] =>
  (
    db
      .prepare(`SELECT name FROM ${tableName} ORDER BY name ASC`)
      .all() as { name: string }[]
  ).map((r) => r.name)

test('Should parse sql file', () => {
  const sqlFileContent = `
-- Erstelle eine temporäre Tabelle mit der neuen Spalte
CREATE TABLE "Log_temp" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S.%sZ', 'now')),
    "message" TEXT NOT NULL
);

-- Kopiere die Daten aus der alten Tabelle in die temporäre Tabelle
INSERT INTO "Log_temp" ("createdAt", "message")
SELECT "createdAt", "message"
FROM "Log";



-- Lösche die alte Tabelle
DROP TABLE "Log";

-- Benenne die temporäre Tabelle in den ursprünglichen Tabellennamen um
ALTER TABLE "Log_temp" RENAME TO "Log";
`

  const sqls = parseSqlContent(sqlFileContent)
  expect(sqls).toHaveLength(4)

  expect(sqls[0]).toBe(`-- Erstelle eine temporäre Tabelle mit der neuen Spalte
CREATE TABLE "Log_temp" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S.%sZ', 'now')),
    "message" TEXT NOT NULL
);`)

  expect(sqls[1])
    .toBe(`-- Kopiere die Daten aus der alten Tabelle in die temporäre Tabelle
INSERT INTO "Log_temp" ("createdAt", "message")
SELECT "createdAt", "message"
FROM "Log";`)

  expect(sqls[2]).toBe(`-- Lösche die alte Tabelle
DROP TABLE "Log";`)

  expect(sqls[3])
    .toBe(`-- Benenne die temporäre Tabelle in den ursprünglichen Tabellennamen um
ALTER TABLE "Log_temp" RENAME TO "Log";`)
})

test('Should drop a standalone leading line-comment block', () => {
  const sqlFileContent = `-- past_paper_segments tweaks:
--   1. clip_key → url ...
--   2. add \`index\` ...

alter table past_paper_segments rename column clip_key to url;

alter table past_paper_segments add column "index" integer not null default 0;
`

  const sqls = parseSqlContent(sqlFileContent)
  expect(sqls).toHaveLength(2)
  expect(sqls[0]).toBe('alter table past_paper_segments rename column clip_key to url;')
  expect(sqls[1]).toBe(
    'alter table past_paper_segments add column "index" integer not null default 0;',
  )
})

test('Fresh DB: applying migrations populates __migrations__ with names, in order', () => {
  const db = new Database(':memory:')
  const migrations = [makeMigration(1), makeMigration(2), makeMigration(3)]

  migrate(db, migrations)

  expect(readAppliedNames(db)).toEqual([
    '0001_t_1.sql',
    '0002_t_2.sql',
    '0003_t_3.sql',
  ])
  expect(readPragmaUserVersion(db)).toBe(0)
  expect(getDatabaseVersion(db)).toBe(3)

  // Idempotent re-run inserts no new rows.
  migrate(db, migrations)
  expect(readAppliedNames(db)).toEqual([
    '0001_t_1.sql',
    '0002_t_2.sql',
    '0003_t_3.sql',
  ])
})

test('Bootstrap: user_version=3 seeds first 3 sorted names; pragma reset to 0', () => {
  const db = new Database(':memory:')
  db.run('PRAGMA user_version = 3')

  const migrations = [makeMigration(1), makeMigration(2), makeMigration(3), makeMigration(4)]
  migrate(db, migrations, 3)

  expect(readAppliedNames(db)).toEqual([
    '0001_t_1.sql',
    '0002_t_2.sql',
    '0003_t_3.sql',
  ])
  expect(readPragmaUserVersion(db)).toBe(0)
})

test('Self-migration: OLD-shape table with 3 rows is rewritten to new shape; second call no-ops', () => {
  const db = new Database(':memory:')
  // Pre-populate with the OLD schema and 3 rows.
  db.run(
    `CREATE TABLE ${MIGRATIONS_TABLE} (
      version    INTEGER NOT NULL PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
  )
  const oldTs = 1700000000000
  const insertOld = db.prepare(
    `INSERT INTO ${MIGRATIONS_TABLE} (version, applied_at) VALUES (?, ?)`,
  )
  insertOld.run(1, oldTs)
  insertOld.run(2, oldTs)
  insertOld.run(3, oldTs)

  const migrations = [makeMigration(1), makeMigration(2), makeMigration(3)]
  // Pre-create the tables the migrations would create so up-migrations don't conflict.
  // Actually — once self-migration sees 3 rows applied, migrate() will not re-apply them.
  // But to be safe we use a target of 3.
  migrate(db, migrations, 3)

  // The bookkeeping table should now have a `name` column with the right names.
  expect(readAppliedNames(db)).toEqual([
    '0001_t_1.sql',
    '0002_t_2.sql',
    '0003_t_3.sql',
  ])
  // applied_at preserved from old rows.
  const rows = db
    .prepare(`SELECT name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY name`)
    .all() as { name: string; applied_at: number }[]
  expect(rows.map((r) => r.applied_at)).toEqual([oldTs, oldTs, oldTs])

  // Second call must be a no-op (table already current; no rows added).
  migrate(db, migrations, 3)
  expect(readAppliedNames(db)).toEqual([
    '0001_t_1.sql',
    '0002_t_2.sql',
    '0003_t_3.sql',
  ])
})

test('Orphan row: OLD-shape with unknown version throws and leaves table intact', () => {
  const db = new Database(':memory:')
  db.run(
    `CREATE TABLE ${MIGRATIONS_TABLE} (
      version    INTEGER NOT NULL PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
  )
  const oldTs = 1700000000000
  const insertOld = db.prepare(
    `INSERT INTO ${MIGRATIONS_TABLE} (version, applied_at) VALUES (?, ?)`,
  )
  insertOld.run(1, oldTs)
  insertOld.run(2, oldTs)
  insertOld.run(99, oldTs) // orphan

  const migrations = [makeMigration(1), makeMigration(2), makeMigration(3)]

  expect(() => migrate(db, migrations)).toThrow(/orphan|no corresponding migration|version=99/i)

  // Table is still the OLD shape with all 3 rows.
  const cols = db
    .prepare(`PRAGMA table_info(${MIGRATIONS_TABLE})`)
    .all() as { name: string }[]
  const colNames = cols.map((c) => c.name).sort()
  expect(colNames).toEqual(['applied_at', 'version'])

  const versions = (
    db
      .prepare(`SELECT version FROM ${MIGRATIONS_TABLE} ORDER BY version`)
      .all() as { version: number }[]
  ).map((r) => r.version)
  expect(versions).toEqual([1, 2, 99])

  // No `_new` leftover.
  const leftover = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(`${MIGRATIONS_TABLE}_new`)
  expect(leftover).toBeNull()
})

test('targetVersion = N converges to migrations[N-1].name', () => {
  const db = new Database(':memory:')
  const migrations = [makeMigration(1), makeMigration(2), makeMigration(3)]
  migrate(db, migrations)
  expect(readAppliedNames(db)).toEqual([
    '0001_t_1.sql',
    '0002_t_2.sql',
    '0003_t_3.sql',
  ])

  // Roll back to N=1 → only migrations[0].name remains.
  migrate(db, migrations, 1)

  expect(readAppliedNames(db)).toEqual(['0001_t_1.sql'])
  expect(getDatabaseVersion(db)).toBe(1)
  expect(readPragmaUserVersion(db)).toBe(0)
})

test('Custom tableName: only the custom table exists and is populated with names', () => {
  const db = new Database(':memory:')
  const migrations = [makeMigration(1), makeMigration(2), makeMigration(3)]

  migrate(db, migrations, undefined, { tableName: 'schema_migrations' })

  const customRows = db
    .prepare('SELECT name FROM schema_migrations ORDER BY name ASC')
    .all() as { name: string }[]
  expect(customRows.map((r) => r.name)).toEqual([
    '0001_t_1.sql',
    '0002_t_2.sql',
    '0003_t_3.sql',
  ])

  // Default table must NOT have been created.
  const defaultExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    )
    .get(MIGRATIONS_TABLE)
  expect(defaultExists).toBeNull()
})

test('Default tableName still creates __migrations__ when no options passed', () => {
  const db = new Database(':memory:')
  const migrations = [makeMigration(1), makeMigration(2)]

  migrate(db, migrations)

  const defaultExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    )
    .get(MIGRATIONS_TABLE) as { name: string } | null
  expect(defaultExists?.name).toBe(MIGRATIONS_TABLE)
  expect(readAppliedNames(db)).toEqual(['0001_t_1.sql', '0002_t_2.sql'])
})

test('Bootstrap honours custom tableName', () => {
  const db = new Database(':memory:')
  db.run('PRAGMA user_version = 3')

  const migrations = [makeMigration(1), makeMigration(2), makeMigration(3)]
  migrate(db, migrations, undefined, { tableName: 'schema_migrations' })

  const customRows = db
    .prepare('SELECT name FROM schema_migrations ORDER BY name ASC')
    .all() as { name: string }[]
  expect(customRows.map((r) => r.name)).toEqual([
    '0001_t_1.sql',
    '0002_t_2.sql',
    '0003_t_3.sql',
  ])
  expect(readPragmaUserVersion(db)).toBe(0)

  // Default table must not exist.
  const defaultExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    )
    .get(MIGRATIONS_TABLE)
  expect(defaultExists).toBeNull()
})

test('Invalid tableName throws and does not mutate the database', () => {
  const db = new Database(':memory:')
  const migrations = [makeMigration(1)]

  expect(() =>
    migrate(db, migrations, undefined, { tableName: 'drop; drop' }),
  ).toThrow(/Invalid migrations table name/)

  // No bookkeeping table and no migration-created table should exist.
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[]
  const names = tables.map((t) => t.name)
  expect(names).not.toContain(MIGRATIONS_TABLE)
  expect(names).not.toContain('t_1')
})

test('ensureMigrationsTable creates the new shape', () => {
  const db = new Database(':memory:')
  ensureMigrationsTable(db)
  const cols = db
    .prepare(`PRAGMA table_info(${MIGRATIONS_TABLE})`)
    .all() as { name: string }[]
  const colNames = cols.map((c) => c.name).sort()
  expect(colNames).toEqual(['applied_at', 'name'])
})

test('Should drop a standalone block-comment chunk', () => {
  const sqlFileContent = `/*
 * Header describing the migration.
 * Multiple lines.
 */

CREATE TABLE foo (id INTEGER PRIMARY KEY);
`

  const sqls = parseSqlContent(sqlFileContent)
  expect(sqls).toHaveLength(1)
  expect(sqls[0]).toBe('CREATE TABLE foo (id INTEGER PRIMARY KEY);')
})
