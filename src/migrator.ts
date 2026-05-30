import { readFileSync, readdirSync } from "fs";
import { basename } from "path";
import type { Migration } from "./migration";

export const readMigrationFiles = (path: string): string[] => {
  const sqlFiles = readdirSync(path, { withFileTypes: true })
    .filter((file) => file.isFile() && file.name.endsWith(".sql"))
    .map((sqlFile) => `${path}/${sqlFile.name}`)
    .sort();

  return sqlFiles;
};

export const getMigrations = (path: string): Migration[] => {
  const migrationFilesPaths = readMigrationFiles(path);

  const migrations: Migration[] = [];

  for (const [i, filePath] of migrationFilesPaths.entries()) {
    const fileContent = readFileSync(filePath, { encoding: "utf8" });

    const up = parseSqlContent(fileContent);
    const name = basename(filePath);

    const migration: Migration = {
      up,
      down: "",
      version: i + 1,
      name,
    };
    migrations.push(migration);
  }

  return migrations;
};

/**
 * A single .sql file can contain multiple sql statements
 * splitted by an empty line
 */
export const parseSqlContent = (content: string): string[] => {
  const parts = content
    .split(/\n\n/gm)
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .filter((v) => !isCommentOnly(v));
  return parts;
};

/**
 * Returns true when the chunk contains no executable SQL once SQL comments
 * (both `--` line comments and `/* *\/` block comments) and whitespace are
 * stripped. Used to drop standalone header comment blocks that would otherwise
 * be handed to bun:sqlite's `.run()` and trigger "Query contained no valid SQL
 * statement; likely empty query."
 */
const isCommentOnly = (chunk: string): boolean => {
  const stripped = chunk
    // Block comments — non-greedy, dot-all so newlines inside are consumed.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Line comments — to end of line.
    .replace(/--[^\n]*/g, "")
    .trim();
  return stripped.length === 0;
};
