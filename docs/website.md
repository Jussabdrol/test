# Public website

The existing Railway service serves the English sales site at `/`, license
information at `/start`, and the protected organization console at `/console`.
After login, users enter `/console`. Existing API URLs and organization access
are unchanged. `/billing` explains that online billing is not activated yet.

The website shares `public/brand.css` with the console: original Inter typography,
Dancing Script Bop wordmark, #111827 primary, #f5f5f5 background, white cards,
#e5e7eb borders and 8/12/16px radii. `public/website/style.css` contains website
layout. Product illustrations contain sample data, never customer records.

Website browser source is `src/client/website.js`, listed in the client manifest
and also emitted separately as `public/website.js`. Public pages never load the
application bundle. `routes/website.js` registers the public pages and catalog;
security middleware explicitly allowlists their public resources.

Proposed commercial model: Bop Complete at EUR 149/month or EUR 1,490/year per
organization, excluding VAT. All core modules and team accounts are included.
Unlimited AI usage is not included. These are introductory pricing decisions,
not validated willingness-to-pay research.

The initially deployed website-only release required no migration, environment change or new
Railway service. The existing `go-bop.com` domain remains attached to the current
service. Rollback is a normal revert of this website release.

Online checkout is explicitly disabled and its fields cannot be submitted.
The catalog returns `enabled: false`; this release has no purchase, account
provisioning or payment endpoint. The complete prepared Stripe integration and
additive private billing ledger are in PR #104 / `codex/bop-commercial-website`.
Applying its production migration requires the owner's explicit approval.

Before payments can go live, the owner must set up and verify a Stripe merchant
account, configure product/tax/portal/webhook settings and supply actual seller
terms and a privacy notice. Then integrate PR #104 and run real Stripe test-mode
acceptance checks before enabling purchases. The prepared integration has only
been tested against an isolated Stripe double.

Validation: `npm run verify`; desktop and mobile browser checks of English copy,
shared branding, feature tabs, yearly pricing, navigation and disabled checkout.

The prepared activation branch includes the billing routes and migration described
in [website and billing](website-and-billing.md). Do not deploy that branch before
the separately approved migration and merchant setup.
