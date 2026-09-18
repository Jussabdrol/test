# Development, checks and deployment

## Install and verify

Use Node 22.13+; `.nvmrc` selects Node 22. CI exercises both Node 22 and 24.
Commit `package-lock.json` alongside dependency changes. Install exactly the
locked dependencies with `npm ci --ignore-scripts`, then run `npm run verify`.

`verify` performs a deterministic browser build, syntax checks of every JavaScript
file, ESLint correctness checks and the unit/HTTP integration suite. ESLint checks
the assembled browser script because client fragments intentionally share scope.
Run `npm run build` after browser edits when using plain `node server.js`.

## Test isolation

The test preload clears service credentials and replaces `pg.Pool` with a class
that throws. Tests must explicitly install their own pool. Integration tests use
`test/support/database.js`, backed by PGlite in memory; transaction unit tests use
a controlled pool double. External sockets are blocked, while localhost HTTP is
allowed. Tests have a 60-second per-test-file limit.

The database adapter prints its historical Supabase/seed messages even under
PGlite. Those messages describe application initialization, not the transport
used by tests. `test/unit/test-isolation.test.js` checks the protective preload.

Coverage includes organization isolation, links, recurrence, repeated/concurrent
workflow requests, rollback, CSRF, login, health, module entry points, document
conversion, AI field context and static asset paths. PGlite has one connection;
this suite is not evidence of production database throughput or real Supabase
Auth, Storage, SAML or external AI behavior.

## Development server

1. Provision a dedicated development database/project.
2. Read [database lifecycle](../database/README.md), and provision the development schema explicitly.
3. Copy `.env.example` to `.env` and fill in development credentials.
4. Run `npm run dev` and open `http://localhost:3000` (or the configured port).
5. Rebuild/restart after changes. There is no automatic watcher.

`npm start` expects the environment to be supplied by the host. Its prestart
builds the browser script. The production session secret must be at least 32
characters. Do not use checked-in example values as real production secrets.

## Containers and hosting

`Dockerfile` installs production dependencies, copies source and runs the
dependency-free browser build before starting `node server.js`.
`.dockerignore` excludes development-only files, `.env`, logs and local modules.

`docker compose up --build` uses `.env` and connects to its configured database;
it does not provision a disposable database. Root Docker/Compose/Cloud Build
filenames remain stable for existing deployment discovery. Cloud Build contains
the pre-existing build/push/Cloud Run deployment configuration. Do not execute it
as a verification step.

The source contains references to both Railway and Cloud Run. Actual service
settings and tracked deployment branches are external configuration. Creating
`main` does not retarget a hosting service; deployment changes are a separate
operation. This restructuring does not require running any SQL script.

## Release verification and recovery

After an authorized deployment, verify `/health`, real login, tenant switching,
task completion, review-to-action promotion, document upload/download and the
affected screens. Use a test tenant and approved credentials.

For a source regression, revert the affected change with a normal Git revert and
run the regression checks again. Do not redeploy pre-security code casually: it
re-enables legacy startup writes, SAML and authorization weaknesses. Keep the Data
API migration and credential rotation in place. Follow the metadata recovery plan
in [the database runbook](security/database-rollout.md).
