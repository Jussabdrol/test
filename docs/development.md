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

## Operational planning regression checks

See [the operational planning review](operational-planning-review.md) for the
verified workflows, changed yearly-response semantics and remaining scheduling
limitations. Run `npm run verify` after combining planning and security changes.
Browser verification must use a disposable database with synthetic fixtures;
never start the normal application against a production database for this purpose.

## Website release

The sales website lives at `/`; the protected application lives at `/console`.
This website-only release requires no database migration. Online checkout stays
disabled pending merchant setup and approval of the separately prepared license
migration. See [website release](website.md).

## Console experience release

The console presentation is isolated in `public/experience.css` and
`src/client/experience.js`. Shared website branding is unchanged. Mission Control
uses the existing attention and KPI APIs; risk/document dossiers are read-only
views that open existing edit, download, treatment and relationship actions.
There is no schema, server, permission or workflow migration.

Run `npm run verify`, then exercise the console with the isolated PGlite fixture:
Mission Control tabs; attention → risk → document; edit/save through existing
forms; risk filters and heat map; document search and column visibility; mobile
navigation and keyboard focus. Test rapid searches and navigating away while a
dossier request is pending. After rollout verify authenticated `/console`,
`/experience.css` and `/app.js` against the tested files, health and affected API
reads. Do not create or edit customer records for a smoke test.

Rollback: revert the experience release with a normal Git revert. Keep the website
release and all security/planning fixes. No data rollback is needed.

## Yearly Plan tabs and filters

Yearly Plan contains Task timeline and Manage series, using the Mission Control
accessible tab pattern. The legacy `switchView('tasks')` entry opens Manage series
inside Yearly Plan and retains its operational-planning permission mapping.
Search (title/process/role), role, priority and process scope are shared between
the tabs. Occurrence status and year apply to the timeline, including its totals
and upcoming list; active/inactive applies only to the series list, across all
years. Reset filters clears both tab-specific statuses and shared scope, returning
to active series and all occurrence statuses without changing the selected year.

The process/bundle selector also remains available in the combined Tasks workspace.
Changing a bundle refreshes its active view. Saving or deactivating a series uses
the existing workflows and refreshes the selected Yearly Plan tab.

Validate with `npm run verify` and the isolated PGlite browser fixture: shared
filters across both tabs; empty results and reset; completed/skipped/open status;
year switching; arrow-key tab navigation; create/edit series then return to the
timeline; legacy task shortcuts; process scope across Tasks tabs;
and mobile filter stacking. No schema or server API change is required.

## Tasks workspace

The Operational Planning navigation now has Yearly Plan and Tasks. Tasks combines
Control tickets (individual scheduled executions) and Follow-up actions using the
same accessible tab pattern as Mission Control. Legacy `task-log` and `actions`
shortcuts select the corresponding tab and retain operational-planning permissions.

Process/bundle scope, series, role, priority and search persist between tabs.
Ticket status, scheduled dates and completed-by apply only to tickets; action
status applies only to follow-ups. Defaults show open tickets and open/in-progress
actions. Reset clears both tab-specific filters and shared scope. Ticket results
use the existing API's 2,000-record limit; when reached, the UI explicitly asks for
a narrower series/date range and labels totals/search as covering loaded tickets.

Opening a ticket shows its exact scheduled date, notes, evidence and linked actions.
The follow-up shortcut focuses on that instance, includes resolved actions and
temporarily hides shared filters without discarding them. Back to all follow-ups
restores those filters. Creating a follow-up here inherits the authoritative
instance/task IDs, role and process. Completion, skipping, reopening, evidence and
action mutations use existing APIs; no database or server migration is needed.

Run `npm run verify`. The client tests cover filter persistence, instance linkage,
resolved-action visibility, invalid dates, empty bundles, stale requests, retries
and escaped ticket detail. Browser checks must use isolated synthetic fixtures:
open ticket → follow-ups → new linked action; back to shared filters; completion
and post-completion navigation; start/resolve actions; keyboard tabs; mobile layout.
Rollback is a normal Git revert; there is no data migration to undo.


## Operational Planning layout

Search and process scope stay in the primary toolbar in Yearly Plan and Tasks.
More filters expands the role/priority controls (and series in Tasks). Its count
and a plain-language active-filter summary remain visible when collapsed; reset
keeps the existing full reset behavior. Disclosure state survives tab switches.
Bundle creation/editing is available from Process bundle options beside the scope
selector. All scheduled dates and statuses remain available in their own tab.

Yearly totals use one semantic summary row. Due work expands below the timeline,
retaining the full overdue/upcoming list and its existing actions. Tables use
neutral labels, with overdue/critical work emphasized. There are no API changes.
Validate expanded and collapsed filters, active summaries, reset, bundle controls,
Due work actions, all four planning tabs and mobile/tablet navigation.
