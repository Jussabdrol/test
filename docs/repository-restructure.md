# Repository restructuring — 2026-09-15

## Baseline and scope

The repository had no `main` branch. This change creates it from the existing
default branch `claude/continue-app-development-SPU8e`, commit
`560cd0f5ece6637bbee4c2ffe564fd522a73449d`. Existing branches/history are retained.
Hosting configuration is not retargeted and no live database operation is needed.

## What moved

| Before | After |
| --- | --- |
| `server.js` (~7,000 lines) | Stable entry point plus `src/server/app.js`, `start.js`, middleware, services and domain routes |
| `db.js`, `schema.js` | `src/server/database/index.js`, `schema.js` |
| `lib/` | Role-specific `src/server/services/`, `middleware/`, `routes/`, `shared/` |
| `public/app.js` (~11,600 lines) | Ordered source fragments in `src/client/`; generated bundle at the same public URL |
| `public/relationships-ui.js` | `src/client/relationships.js`, final fragment in the bundle |
| Root SQL files | `database/legacy/`, with a guide explaining their historical status |
| Root workbook | `templates/import/BOP_Import_Template.xlsx` |
| Flat tests | `test/unit/`, `test/integration/`, `test/support/` |
| Previous improvement notes | `docs/history/production-improvements.md` |

The root retains package/lock files, the stable server entry point, Docker,
Compose and Cloud Build configuration, and standard contributor/tooling files.

## Development safeguards

- README, architecture map, developer runbook and `AGENTS.md` establish where new
  work belongs and which security/data contracts must be retained.
- Browser build uses only Node built-ins and preserves the existing script order.
- ESLint catches undefined references and selected JavaScript correctness errors;
  syntax checking now includes every JavaScript source and test.
- Unit and integration tests are separated. A preload blocks real PostgreSQL
  clients and external sockets; tests use PGlite or an explicit pool double.
- CI checks Node 22 and 24 and builds/smoke-loads the container without starting
  its database lifecycle.
- `.env` variants, generated code and temporary outputs are ignored; container
  packaging excludes development-only artifacts.

## Behavior retained and targeted correction

All 185 Express route registrations retain their paths, methods and order. The
shared request/transaction wrapper stays on the same app instance. Startup signal
handlers now live in the executable startup module so importing the app for tests
does not attach process-level error handlers or open a listener.

Linting identified an existing undefined `orgId` in AI-chat metadata queries.
Those three queries now use `req.orgId`; a provider-free unit test confirms that
the organization's categories and users reach the model context.

No SQL statements, runtime schema, seeds, policies or workbook bytes changed.
The assembled browser script is byte-for-byte the original `app.js` followed by
the original relationship extension. The HTML now loads that single bundle.

## Validation

- Before restructuring: 18 isolated regression tests passed.
- After restructuring: 22 isolated tests passed on local Node 24.
- Clean locked install, complete syntax checks and ESLint passed.
- Route path/method/order comparison matched all 185 baseline registrations.
- Byte comparisons matched all nine historical SQL files, both runtime database
  files, the workbook and the combined browser sources.
- HTTP tests checked anonymous redirect, login HTML, authenticated HTML and local
  JavaScript/CSS asset paths after relocation.
- `git diff --check` passed.

Docker is unavailable on the local workstation, so the added CI container job
performs packaging verification on GitHub. Consult the checks on the actual
commit for CI results. No live Supabase, SAML, OpenAI, Storage or deployment smoke
test was performed. Remaining security/dependency concerns are recorded in
[security-and-follow-ups.md](security-and-follow-ups.md).
