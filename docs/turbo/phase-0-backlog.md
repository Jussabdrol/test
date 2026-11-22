# Turbo: phase 0 backlog (foundation)

Turbo is the planned guided-implementation layer on top of Bop: an organization
answers an intake, an AI guide drafts documents from templates, a person approves
each draft, and approved content lands in the existing Bop modules. Phase 0 does
not build any of that. It closes the gaps that must be shut before a paying
organization stores its policies here.

This file is the working backlog for phase 0. It lists work packages, their
acceptance criteria and the actions only the owner can take.

## Working agreements

- Every work package gets its own branch and its own pull request against the
  repository's default branch. Nothing is pushed to the default branch or `main`
  directly. The owner reviews and merges.
- No package applies SQL, starts the application against a configured database,
  or runs deployment commands. Migrations are delivered as files for separate,
  explicit approval, as [AGENTS.md](../../AGENTS.md) requires.
- No credentials, customer exports, backups or licensed template content enter
  version control. The repository is public.
- Each pull request reports which checks ran and what could not be checked.
- A reviewer that did not write the change reads every diff before the pull
  request is opened.

## Exit gate for phase 0

Phase 1 starts only when both hold:

1. A stranger can pay and sign in to a fresh organization without manual work by
   the owner.
2. A restore drill into an isolated project has succeeded and is recorded.

## Work packages

| ID | Package | Branch | State |
| --- | --- | --- | --- |
| P0-1 | Backup and restore tooling with a restore-drill runbook | `claude/turbo-backup-restore` | In progress |
| P0-2 | Reconcile the prepared Stripe licensing work (PR #104) with the current default branch | `claude/turbo-billing-reconcile` | In progress |
| P0-3 | Durable per-organization AI usage accounting with a ceiling | not started | Open |
| P0-4 | Independent uptime and error alerting | not started | Open |
| P0-5 | Short market scan of guided ISO 27001 implementation offers | not started | Open |

### P0-1 Backup and restore

Closes the high-priority disaster-recovery item in
[security and follow-ups](../security-and-follow-ups.md).

Acceptance criteria:

- A documented, repeatable way to take a logical database backup and a copy of
  the private Storage bucket, with a manifest that records what was captured and
  a checksum per file.
- A documented restore drill into an isolated project, including the checks that
  prove the restore is usable (schema marker, row counts per tenant table, a
  sample of Storage objects).
- Retention rules are stated and the pruning logic is covered by tests.
- Backup output can never be committed: the output location is ignored by Git.
- Nothing in the package runs against a database during `npm run verify`.

### P0-2 Billing reconcile

PR #104 prepared Stripe subscriptions and automatic activation of a reserved
organization after a verified payment. It was written against commit `ff8940c`
and has diverged from the default branch since.

Acceptance criteria:

- The licensing work applies cleanly on the current default branch, with the
  support-ticket, security and Sphere changes that landed after it preserved.
- Checkout stays disabled by default. No behaviour changes for existing tenants
  while it is disabled.
- The commerce migration is unchanged in intent, stays additive, and is still
  delivered for separate owner approval.
- `npm run verify` passes, including the commerce integration tests.
- The pull request states what still needs a real Stripe test-mode run.

### P0-3 Durable AI usage accounting

AI rate counters live in server memory and reset on restart. Turbo will spend
more AI budget per organization than the current assistant, so usage must be
recorded in the database with a ceiling per organization before phase 1 ends.
Needs a reviewed migration.

### P0-4 Alerting

`/health` only tells the host whether a deployment is ready. An external check
with an agreed destination and an incident note is still missing.

### P0-5 Market scan

A one-page comparison of what a small organization currently pays for a first
ISO 27001 implementation, with and without an adviser, and which offers include
guided drafting. Feeds the pricing decision in phase 3.

## Owner actions

These cannot be done from a branch:

- Enable automatic database backups in the Supabase project and decide retention.
- Run the first restore drill, or grant access to an isolated project for it.
- Verify the Stripe merchant account and create the product, tax and portal setup.
- Approve or reject the commerce migration.
- Confirm which branch the hosting service deploys from, and protect it.
- Provide a development Supabase project and a second hosting service for testing.

## Verification note for sandboxed agents

`package.json` installs `xlsx` from `cdn.sheetjs.com`. Sandboxes that only allow
the npm registry cannot fetch it, so `npm ci` fails there. Checks in such a
sandbox ran with the registry build of `xlsx` as a local stand-in, without
changing `package.json` or the lockfile. CI remains the authoritative run.
