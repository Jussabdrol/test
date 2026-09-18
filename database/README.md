# Database ownership and lifecycle

## Runtime source of truth

Production `initDatabase()` verifies connectivity, required columns and the
`2026-09-security-v1` marker. It performs no DDL or account seeding. TLS certificate
verification is required; supply `SUPABASE_DB_CA` only if the target uses a private
CA. Connection-string SSL flags cannot disable verification.

`src/server/database/schema.js` is the synthetic test schema; only `NODE_ENV=test`
initializes it. Do not set that environment in a deployed service. Fresh production
installation requires a separately reviewed schema baseline and deliberate admin
provisioning; starting the server is not a provisioning mechanism.

Reviewed changes live in `supabase/migrations/`. The first security migration
preserves business rows, closes browser Data API privileges and records a schema
marker. See [rollout and recovery](../docs/security/database-rollout.md).

## Historical SQL in `legacy/`

These nine files were preserved byte-for-byte and relocated from the root.
They overlap the runtime schema and represent different historical states.
These historical files have no verified universal execution order.

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
3. Record reviewed upgrades in the migration ledger; never auto-run historical SQL.
4. Test on an isolated database with representative synthetic data.
5. Review tenant constraints, grants, RLS and privileged access paths.
6. Apply only the reviewed migration to an authorized target with a restore plan.

The application connects through `pg` and scopes requests itself. The historical
RLS script is not automatically applied at startup, and PGlite tests do not
validate policies using real Supabase JWTs. Supabase client privileges and RLS need
their own verification; see [Supabase's RLS guide](https://supabase.com/docs/guides/database/postgres/row-level-security).
