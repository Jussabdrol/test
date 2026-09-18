# Database security rollout

The 20260918145726 migration is metadata-only: it preserves all business rows,
existing service_role/postgres grants and Auth/Storage APIs. BOP browser source
has no direct PostgREST queries. The server connects as postgres through Supavisor.

Validation: the PGlite migration test applies the change twice, checks that anon
and authenticated cannot SELECT/UPDATE security fields or read/write use cases,
and confirms service_role access and preservation of existing users.

Apply the SQL as one transaction through Supabase migrations before deploying the
application. Check the /health endpoint and authenticated backend reads after it.
A five-second lock timeout aborts instead of waiting indefinitely.

Recovery: no data restore is necessary for this metadata-only change. If a newly
identified integration needs access, grant only its named backend role the required
tables after investigating. Do not restore the old anonymous/authenticated ALL
privileges; that reopens the confirmed vulnerabilities. The existing server-side
postgres/service_role paths retain access throughout. For unexpected errors,
rollback the migration transaction before committing. After commit, add a reviewed
forward migration for the specific missing grant. Keep the old app serving while
investigating; it continues to use the same retained backend access.

The bop_schema_versions marker gates the new production startup, which no longer
executes historical schema SQL or creates accounts. Do not run database/legacy
SQL as an upgrade. Initial schema provisioning for a new empty environment needs
a separate baseline; this migration targets the already-existing BOP schema.
