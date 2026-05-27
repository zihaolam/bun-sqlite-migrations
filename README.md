# bun-sqlite-migrations

Simple function for migration management for [bun:sqlite](https://bun.sh/docs/api/sqlite)

## Getting started

```sh
bun add @zihaolam/bun-sqlite-migrations
```

### Example

Add your `.sql` files into `./migrations`, e.g.:

- `0001_init.sql`
- `0002_add_users_table.sql`
- `0003_add_column_gender_to_users_table.sql`

> Only the sorting matters. The index of the last executed migration will be stored into the database.

```ts
import { migrate, getMigrations } from '@zihaolam/bun-sqlite-migrations'

const db = new Database(`data.db`)
migrate(db, getMigrations('./migrations'))
```

**Verify**:

```sh
sqlite3 data.db "PRAGMA user_version;"
# should return the number of migrations which were executed
3
```

## Development

```sh
bun install
bun test          # run the test suite
bun run check-types
bun run check-format
```

## Packaging & publishing

The package is published from the compiled output in `dist/`, not from the
TypeScript source. The build has two steps, both wrapped by `bun run build`:

- `build:js` — `bun build` bundles `src/index.ts` to `dist/index.js` with a
  minified, source-mapped ESM output.
- `build:types` — `tsc --project tsconfig.build.json` emits the `.d.ts` type
  declarations next to the JS (Bun's bundler does not generate these).

```sh
bun run build     # produces dist/index.js, dist/index.js.map and dist/*.d.ts
```

`package.json` points consumers at the built files via `main`, `types` and the
`exports` map, and `"files": ["dist"]` ensures only `dist/` is published (note
that `dist/` is gitignored, so the `files` field is what gets it into the npm
tarball).

To publish a new release:

```sh
# 1. Bump the version (npm refuses to republish an existing version)
npm version patch        # or: minor / major

# 2. Build + publish — prepublishOnly rebuilds dist automatically
bun publish --access public
```

`--access public` is required because the package is published under the
`@zihaolam` scope. You can preview exactly what will be shipped with
`npm pack --dry-run` before publishing.
