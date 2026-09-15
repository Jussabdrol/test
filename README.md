# BOP — Business Orchestration Platform

BOP is a multi-tenant compliance application for operational planning, audits,
risks, requirements, documents, suppliers, management reviews and AI governance.
It uses Express, PostgreSQL/Supabase and a vanilla JavaScript browser interface.

## Start here

- **Agents:** read [AGENTS.md](AGENTS.md) before changing code.
- **Developers:** follow [local development and validation](docs/development.md).
- **Architecture:** use the [module map](docs/architecture.md) to find the right file.
- **Database:** read [database lifecycle and historical SQL](database/README.md).
- **Known constraints:** see [security and follow-up work](docs/security-and-follow-ups.md).
- **Restructuring:** see [what moved and what was verified](docs/repository-restructure.md).

## Quick verification — no cloud account needed

Use Node.js 22.13+ (CI checks Node 22 and 24) and npm.

```sh
npm ci --ignore-scripts
npm run verify
```

Tests use an in-memory PostgreSQL engine (PGlite), synthetic fixtures and a local
HTTP server. The test preload blocks real PostgreSQL clients and external network
connections. No production credentials are needed.

## Run locally

```sh
cp .env.example .env
# Fill in credentials for a dedicated development Supabase project.
npm run dev
```

`npm run dev` builds the browser script, loads `.env`, and starts the server.
**Startup initializes and updates the configured database and seeds accounts.**
Review [database/README.md](database/README.md) before starting it against any
existing database. Use the test suite first if you only need to verify code.

`npm start` builds the browser script and uses environment variables supplied by
the host; it does not load `.env`. `node server.js` remains the deployment entry
point; run `npm run build` first when invoking it directly.

## Repository layout

```text
src/
  server/
    app.js             Express composition and route registration
    start.js           HTTP startup, signals and database lifecycle
    config/            External service configuration
    middleware/        Authentication, authorization and request transactions
    routes/            HTTP endpoints grouped by business domain
    services/          Shared domain logic and external integrations
    database/          PostgreSQL adapter, runtime schema and startup migrations
    shared/            Shared error types
  client/              Browser source fragments and their ordered manifest
public/                HTML, CSS, flowchart module and generated app.js
database/legacy/       Preserved historical SQL; not an automatic migration queue
templates/import/      Reference import workbook
test/                  Unit tests, HTTP integration tests and isolated test support
scripts/               Dependency-free browser build and syntax checks
docs/                  Architecture, operating instructions and technical history
server.js              Stable deployment entry point
```

Docker, Compose and Cloud Build configuration remain at the repository root so
existing build discovery works. The restructuring was based on commit `560cd0f`
of `claude/continue-app-development-SPU8e`; `main` was created from that history.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Assemble `public/app.js` from the ordered client manifest |
| `npm run check` | Build, check all JavaScript syntax, then run ESLint |
| `npm test` | Build and run isolated unit and HTTP integration tests |
| `npm run verify` | Run all required checks |
| `npm run dev` | Build and run using `.env` |
| `npm start` | Build and run using the host environment |

There is no frontend framework migration, API redesign or database migration in
this restructuring. Existing larger domain modules can now be extracted further
without adding new code to a single repository-wide file.
