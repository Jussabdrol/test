# Working on BOP

## Read before editing

1. Read `README.md`, `docs/architecture.md` and `docs/development.md`.
2. Check `git status`, the current branch and the user's requested scope.
3. Read `database/README.md` before touching schema, SQL or startup.
4. Read `docs/security-and-follow-ups.md` before touching authentication,
   authorization, SAML, uploads, external requests or AI execution.

## Put changes in the right place

- Route handlers belong in `src/server/routes/<domain>.js`.
- Register routes in `src/server/app.js` in deliberate order. Use the shared app:
  `middleware/route-handling.js` wraps registrations for validation/transactions.
  Moving endpoints to an Express Router requires preserving that behavior.
- Put reused domain operations and integrations in `src/server/services/`.
  Existing task/action/checklist operations returned by route registration are
  shared with the AI assistant; keep both callers on the same implementation.
- Keep process listeners and network startup in `src/server/start.js`.
  Importing `app.js` must not initialize a database or listen on a port.
- Edit browser code in `src/client/`, never generated `public/app.js`.
  Add every fragment exactly once to `src/client/manifest.json`.
- The browser fragments form one classic script. Preserve declaration order,
  shared state and inline-handler names. Do not wrap an individual fragment in
  an ES module/IIFE without migrating its callers and testing browser startup.
- Keep technical docs in `docs/`, test helpers in `test/support/`, reference
  workbooks in `templates/`. Keep the root focused on entry points and tooling.

## Preserve these boundaries

- Tenant-owned reads, writes and referenced IDs must be checked within the
  request's organization. A record ID alone is not an authorization check.
- Preserve session-version checks, CSRF binding, module permissions and admin
  checks. Client-side visibility is not authorization.
- Parameterize SQL values. Dynamic table/column names must come from a fixed
  server-side allowlist. The adapter's SQL translation is a compatibility layer,
  not a sanitizer for interpolated values.
- Keep related writes in `db.transaction`; use `db.deferUntilCommit` for effects
  that must not occur on rollback. Retain the request transaction wrapper.
- Keep Supabase service-role keys and OpenAI keys on the server. Never put real
  credentials, `.env`, customer exports or database backups in version control.
- Preserve upload validation, attachment downloads and webhook address checks.
- Do not run historical SQL as a batch. File order is not a migration plan.
  Database schema changes require a separate reviewed migration and restore plan.

## Validation

```sh
npm ci --ignore-scripts
npm run verify
```

Use `npm test` so `test/support/isolate-env.js` is loaded. It blocks the real
PostgreSQL pool and external network connections. Integration tests explicitly
install PGlite; do not replace this with a real database for convenience.

For changes to routes or module boundaries, retain endpoint paths/methods and
middleware order and exercise authorized and unauthorized paths. For UI changes,
also check the affected screen in a browser. For data workflows, test tenant
boundaries, rollback and repeated/concurrent submissions where relevant.

Do not run `npm start`, `npm run dev`, Docker Compose or deployment commands merely
to run tests: application startup modifies its configured database. Production
operations need authorization from the task. A push may trigger deployment if the
hosting service tracks that branch; inspect configuration for deployment tasks.

## Delivery

Keep changes scoped and commits reviewable. Update the module map and runbook when
paths or operating steps change. Report checks that ran, any checks that could not
run, and material remaining limitations. Do not claim these regression tests are
a full security audit or a real PostgreSQL concurrency/load test.
