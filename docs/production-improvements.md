# Improvements for the actual BOP production source

Repository: `Jussabdrol/test`.
Branch: `claude/continue-app-development-SPU8e`.
Base commit: `f1ece6be3047f85201964a8a15b7bbb7154d83ad` (PR #99).

This change set was prepared against the current production repository. The earlier Azure extraction is superseded. Authentication, Supabase Storage, CSRF protection, permissions, task instances, process events, AI inventories and the current operational planning UI remain based on this repository.

## Behavior changes

| Area | Result |
|---|---|
| Operational planning | Monthly, quarterly and yearly recurrence clamps to valid dates and retains the original day. Sunday and zero targets remain valid. The completion form carries the expected due date and prevents double submission. Repeated instance completion/skip requires reopening first. |
| Follow-up actions | Task execution and process references are checked within the organization. An execution determines its task. Reopening clears resolution metadata. Linked review decisions follow the action status. |
| Management reviews | Concurrent promotion of one decision produces one action. Decision status follows a linked action, and deletion of that action resets the decision to open. |
| Audits | Changing a checklist assessment preserves existing NCR corrective work. UI and AI checklist assessment share the same NCR/audit workflow. |
| Risk, SoA and KPIs | Reference and value validation rejects invalid relationships and values before writes. Native treatment, requirement and KPI/process relationships can be followed in both directions. |
| Architecture and suppliers | Shared relationship panels show existing workflow links, supplier metadata links and process groups. Parent cycles are rejected. AI model and dataset linking remains supported. |
| Documents | Existing document-control references appear alongside explicit links. Word/Excel conversion is regression-tested; the current Supabase upload implementation is retained. |
| AI use cases | Nested team/approval endpoints check the parent organization. Owner/member/approver references must belong to that organization. Direct use-case updates enforce the existing stage requirements. |
| AI assistant | Task completion, checklist assessment and action updates use the same service functions as the UI. Dashboard task/date queries match the current schema. |
| Mission Control | Searchable and filterable attention list across overdue work, high risks, suppliers, reviews, AI use-case reviews and untriaged threats, with links to records. |
| Shared infrastructure | Implicit and explicit database calls participate in the same transaction, including nested operations. Selected multi-record workflows serialize per organization and acknowledge after commit. Webhooks/process events start after successful commit. API errors return JSON. |

The entity registry supports 25 identifiers, including the existing `usecase` / `ai_usecase` aliases. Existing ArchiMate relationship types and notes are preserved. The current database permits one link per endpoint pair; attempting a different relationship type returns a conflict instead of replacing it silently.

## Verification

- 14 local regression tests pass, using an isolated PGlite PostgreSQL engine and synthetic data.
- 23 production module entry points and all registered linkable entity types are exercised.
- Concurrent HTTP workflows, rollback, separate transaction clients, tenant boundaries, recurrence, AI workflows and Word/Excel conversion are covered.
- JavaScript syntax checks pass.
- Desktop and 390px mobile layout checked; search and navigation to the exact linked process checked in the browser.
- Local execution used Node 24. The Dockerfile and proposed CI target Node 22, supported by the current Supabase libraries. A Node 22 container build and hosted CI have not run here.

The PGlite API suite has one database connection; a separate test verifies independent client routing. It does not replace a production PostgreSQL load or race test.

## Deployment verification

Use the pull request checks to verify the Node 22 runtime before merging. After deployment, verify the health endpoint, real login, storage, task completion, review promotion and module access. The schema change only reorders existing table declarations for fresh installations; it does not introduce a new migration.

Infrastructure observations and the separate security follow-up are maintained outside this source change. This is a tested first change set, not a statement that every module and security path has been exhaustively audited.
