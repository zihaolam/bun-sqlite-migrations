import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { parseSqlContent } from './migrator'
import {
  MIGRATIONS_TABLE,
  bootstrapFromUserVersion,
  ensureMigrationsTable,
  getDatabaseVersion,
  migrate,
  type Migration,
} from './migration'

const makeMigration = (version: number): Migration => ({
  version,
  up: [`CREATE TABLE t_${version} (id INTEGER PRIMARY KEY)`],
  down: `DROP TABLE t_${version}`,
})

const readPragmaUserVersion = (db: Database): number =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

const readAppliedVersions = (db: Database): number[] =>
  (
    db
      .prepare(`SELECT version FROM ${MIGRATIONS_TABLE} ORDER BY version ASC`)
      .all() as { version: number }[]
  ).map((r) => r.version)

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

test('Fresh DB: applying migrations populates __migrations__ and leaves user_version at 0', () => {
  const db = new Database(':memory:')
  const migrations = [makeMigration(1), makeMigration(2), makeMigration(3)]

  migrate(db, migrations)

  expect(readAppliedVersions(db)).toEqual([1, 2, 3])
  expect(readPragmaUserVersion(db)).toBe(0)
  expect(getDatabaseVersion(db)).toBe(3)

  // Idempotent re-run inserts no new rows.
  migrate(db, migrations)
  expect(readAppliedVersions(db)).toEqual([1, 2, 3])
})

test('Bootstrap: legacy user_version seeds __migrations__ and zeroes the pragma; second call is a no-op', () => {
  const db = new Database(':memory:')
  db.run('PRAGMA user_version = 3')

  // First call seeds.
  ensureMigrationsTable(db)
  bootstrapFromUserVersion(db)

  expect(readAppliedVersions(db)).toEqual([1, 2, 3])
  expect(readPragmaUserVersion(db)).toBe(0)

  const beforeSecond = db
    .prepare(`SELECT version, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version`)
    .all()

  // Second call must be a no-op (predicate fails because table is non-empty).
  bootstrapFromUserVersion(db)
  const afterSecond = db
    .prepare(`SELECT version, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version`)
    .all()
  expect(afterSecond).toEqual(beforeSecond)
  expect(readPragmaUserVersion(db)).toBe(0)
})

test('Down-migration removes the row for the version that was rolled back', () => {
  const db = new Database(':memory:')
  const migrations = [makeMigration(1), makeMigration(2), makeMigration(3)]
  migrate(db, migrations)
  expect(readAppliedVersions(db)).toEqual([1, 2, 3])

  // Roll back to version 1.
  migrate(db, migrations, 1)

  expect(readAppliedVersions(db)).toEqual([1])
  expect(getDatabaseVersion(db)).toBe(1)
  expect(readPragmaUserVersion(db)).toBe(0)
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
