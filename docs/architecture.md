# Architecture and module map

## Runtime

```text
server.js → src/server/start.js → src/server/app.js
                                 ├─ middleware/security.js
                                 ├─ middleware/route-handling.js
                                 ├─ routes/* → services/* → database/index.js
                                 └─ public/index.html → public/app.js

src/client/manifest.json → scripts/build-client.js → public/app.js
```

The repository is one deployable Express application. It has no monorepo package
manager, bundler dependency, transpiler or separate frontend server.

## Server composition

`app.js` installs asynchronous error handling and the request wrapper first,
then security middleware and static serving, then domain routes. API 404, SPA
fallback and the error handler remain last. Domain registration functions take
explicit dependencies; `app.js` is the place to inspect their wiring.

Authentication/session state and the health endpoint are configured in
`middleware/security.js`. The health endpoint probes the database and returns 503
when it is unavailable. The shared route wrapper validates selected workflows,
serializes them per organization and sends JSON only after a successful commit.
This wrapper is installed on the app instance, not globally on all Express Routers.

The PostgreSQL adapter retains its legacy `prepare().all/get/run` interface and
SQL compatibility translation. `AsyncLocalStorage` routes implicit and explicit
calls through the active transaction. Startup behavior is described separately in
[the database guide](../database/README.md).

## Domain map

Paths below are relative to `src/server/routes/` and `src/client/` respectively.

| Area | Server routes | Client sources |
| --- | --- | --- |
| Login, tenants, session | `auth.js`, `../middleware/security.js` | `core.js`, `account.js` |
| Operational planning | `tasks.js`, `task-instances.js`, `actions.js`, `plan-bundles.js` | `operations/`, `dashboard.js` |
| Audits and findings | `audits.js`, `checklist.js`, `non-conformities.js` | `audits/` |
| Requirements | `requirements.js` | `requirements.js` |
| Threats, risks, treatment, SoA | `threats.js`, `risks.js`, `treatments.js`, `soa.js` | Matching domain files |
| Mission, KPIs, architecture, AI use cases | `organization.js` | `organization/`, `ai/use-cases.js` |
| Suppliers | `suppliers.js` | `organization/architecture.js` |
| Documents and conversion | `documents.js` | `documents.js` |
| Cross-links and attention overview | `links.js`, `relationships.js`, `overview.js` | `relationships.js`, `core.js` |
| Administration and SSO | `admin.js`, `saml.js` | `admin.js` |
| Management reviews | `management-reviews.js` | `management-reviews.js` |
| AI assistant and import | `agent.js`, `imports.js` | `ai/agent.js` |

## Shared services

- `entities.js`: fixed entity registry, tenant-aware lookup and link helpers.
- `recurrence.js`: calendar recurrence and date validation.
- `planning.js`: task instance generation, input helpers and process events.
- `storage.js`: upload filtering, private storage operations and download URLs.
- `webhooks.js`: address validation and post-commit delivery.
- `audit-log.js`: shared audit record writes.
- `openai.js`: lazy OpenAI client initialization.
- `config/supabase.js`: server-side Supabase clients.

Tasks, actions and checklist route registration currently return shared operation
functions for the assistant. This preserves the existing transaction and
validation paths. A later change can move each operation to a service with its
own tests; avoid duplicating the SQL in the assistant.

## Browser composition

`scripts/build-client.js` concatenates the explicitly ordered files in
`src/client/manifest.json` into `public/app.js`. This file is generated and ignored
by Git. Build happens before start, development and tests, and during Docker build.
The historical relationship extension is now the final fragment in that bundle.
The build retains a classic script's shared lexical scope and hoisting; inline
HTML handlers and cross-domain calls still work without a framework migration.

`public/index.html`, `login.html`, CSS and `flowchart-editor.mjs` remain served
assets. The flowchart editor is an existing ES module with external dependencies.
CSS selectors, page markup and public URLs are deliberately stable.

Frontend fragments are not isolated ES modules yet. The manifest and complete
bundle linting make dependencies visible while allowing one screen at a time to
be migrated later. Changes to initialization and globals need browser validation.
