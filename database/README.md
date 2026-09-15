# Database ownership and lifecycle

## Runtime source of truth

- [`src/server/database/schema.js`](../src/server/database/schema.js) exports
  the current schema SQL and default threat feed definitions.
- [`src/server/database/index.js`](../src/server/database/index.js) owns the
  PostgreSQL adapter, connection pool, startup schema initialization, incremental
  migrations and seed behavior.
- Test databases are PGlite instances created under `test/support/`.

These runtime files were moved without changing SQL, schema order or seed data.
The server's startup calls `initDatabase()` which probes the database, runs
`initSchema()`, `runMigrations()` and `seedData()`.

**Startup is a write operation.** Existing migration code can drop/recreate old
AI use-case tables when it detects an `actor` column. Seed code can create
accounts with fixed historical passwords. Do not start an unfamiliar checkout
against a valuable database just to inspect the app.

## Historical SQL in `legacy/`

These nine files were preserved byte-for-byte and relocated from the root.
They overlap the runtime schema and represent different historical states.
There is no migration ledger or verified universal execution order.

| File | Original purpose |
| --- | --- |
| `supabase-migration.sql` | Historical initial multi-tenant schema |
| `add-organization-id.sql` | Retrofit organization columns and tenant tables |
| `rls-policies.sql` | Historical Supabase RLS policies and helpers |
| `task-instances-migration.sql` | Replace completion records with task instances |
| `add-process-id-to-actions.sql` | Process links and plan bundles |
| `process-kpis-migration.sql` | Link KPIs to processes |
| `suppliers-migration.sql` | Supplier tables |
| `management-review-migration.sql` | Management review tables |
| `add-indexes.sql` | Performance indexes |

Do not glob-execute this directory or wire it to application startup/CI. In
particular, the task-instance script removes old completion structures. File
comments describing reruns as safe do not establish that they match a current
database. Keep these files as history until a separate migration project
reconciles actual deployed schema and migration history.

## Future database changes

1. Inspect the target schema and the current application expectations.
2. Separate the change from folder cleanup; define data preservation and rollback.
3. Establish a migration baseline/ledger before adopting an automatic runner.
4. Test on an isolated database with representative synthetic data.
5. Review tenant constraints, grants, RLS and privileged access paths.
6. Apply only the reviewed migration to an authorized target with a restore plan.

The application connects through `pg` and scopes requests itself. The historical
RLS script is not automatically applied at startup, and PGlite tests do not
validate policies using real Supabase JWTs. Supabase client privileges and RLS need
their own verification; see [Supabase's RLS guide](https://supabase.com/docs/guides/database/postgres/row-level-security).
