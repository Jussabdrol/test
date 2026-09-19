# Public website and self-service offer

The existing Railway service serves the English website at `/`, an illustrative
interactive tour at `/tour`, practical setup instructions at `/guides`, product
security/scope information at `/security`, and written support at `/contact`.
The protected organization console remains at `/console`; login routes and tenant
APIs are unchanged. `/start`, `/welcome` and `/billing` explain availability.

The offer is intended for international small teams that already own their ISO
management system. It includes software, self-guided setup and written product
support. It does not include implementation consulting, booked demos, training,
custom development, certification guarantees, unlimited AI or a 24/7 response SLA.
This supersedes the earlier founder-led demo/consultancy recommendation.

Bop Complete remains a planned EUR 149/month or EUR 1,490/year per organization,
excluding VAT and without per-user charges. These are proposed prices, not
validated willingness-to-pay research. Checkout stays disabled:
`/api/commerce/catalog` returns `enabled: false`; no purchasing, provisioning,
payment or email marketing endpoint is introduced. A ticket is not a registration
or reservation. Do not buy traffic before the payment and onboarding flows work.

## Sources and presentation

Edit `public/website/*.html` and `public/website/style.css`; the shared brand
wordmark/fonts come from `public/brand.css`. The website uses a warm paper and sage
palette. All product previews are clearly labelled illustrations with example data.
`src/client/website.js` is emitted as `public/website.js` and included in the shared
manifest. Public pages do not load the console bundle. Page routes and public
resources have an explicit security allowlist. Canonical metadata and the XML
sitemap index the homepage, tour, guides and scope page. Utility/contact pages
have `noindex`. No tracking vendor or cookie-based marketing is introduced.

## Support tickets

The contact form POSTs to `/api/support/tickets` through the existing session-bound
CSRF protection. It uses a honeypot, input limits and 10 requests/IP/hour. The
existing trusted proxy setting remains unchanged. The limiter is in-memory on the
current single Railway replica: before adding replicas or responding to sustained
abuse, use a shared limiter and consider a challenge. It is not bot-proof.

A client UUID and unique database constraint prevent duplicate tickets on retries.
The same submission key with a different payload is rejected. Public responses
contain only the random ticket reference; there is no public ticket lookup.
The current form keeps the retry key for the loaded page, not across reloads.

Superadmins see the queue above organizations in the MSP portal, implemented in
`src/client/support.js` and `src/server/routes/support.js`. List and PATCH endpoints
explicitly require the current superadmin role; tenant administrators have no
access. Filters, cursor pagination, status and internal notes are supported.
Updates compare revisions to prevent overwriting a concurrent change. Refresh
updates counts/filter results; saving leaves other tickets' unsaved notes intact.

“Reply by email” opens the administrator's configured mail application. No mail is
sent by saving a ticket, no confirmation email is promised, and there is no
outbound mail service or threaded customer inbox in this release. The browser
shows a receipt/reference after the database confirms the message. No background
notifications are configured: the operator must check the queue.

## Rollout and recovery

Apply `supabase/migrations/20260919141357_support_tickets.sql` separately before
merging the application release. This additive migration creates one private table
and its indexes, with RLS enabled and all anon/authenticated/PUBLIC privileges
revoked. Existing tenant tables and data are untouched. Bop's existing trusted
PostgreSQL server connection accesses it. The migration is safe to retry and has
a five-second lock timeout. Check RLS and grants after applying it.

Rollback: revert the application commit and retain the private ticket table so
already received requests are preserved. Do not drop the table or reopen Data API
access as a rollback. If the migration transaction fails, keep the existing release
running and investigate; no historical SQL or restore of customer tables is needed.
If ticket storage is unavailable, the form returns 503 and never claims delivery.
The queue contains personal information; handle privacy requests from its privacy
category and define a retention/deletion policy before scaling intake.

Before payments go live, the owner still needs a verified Stripe merchant account,
actual seller terms/privacy details and test-mode acceptance of checkout, account
creation, failed payments, invoices and cancellation. The prepared billing work
in PR #104 has not been activated by this change.

Validation: `npm run verify` with isolated PGlite fixtures; browser checks at desktop
and 390px mobile width for pricing, tour, contact submission and the MSP queue.
Tests cover CSRF, validation, concurrent retries, role/session restrictions,
optimistic updates, migration retry and Data API denial. These are regression
checks, not a full security audit or a real PostgreSQL load/concurrency test.
