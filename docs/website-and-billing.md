# Website and licensing

The existing Railway service serves the English public site at `/`, onboarding at
`/start`, payment status at `/welcome`, and the authenticated console at `/console`.
`/login` redirects to `/console` after successful login. Existing API paths remain.
`/billing` links organization administrators to Stripe's customer portal.

The website and console share `public/brand.css`: original Inter typography,
Dancing Script Bop wordmark, #111827 primary, #f5f5f5 background, white cards,
#e5e7eb borders and 8/12/16px radii. Website layout is in `public/website/style.css`.
Website browser source is `src/client/website.js`, listed once in the manifest and
also emitted as `public/website.js`. Public routes never load the application bundle.
Product illustrations contain synthetic examples, not customer data.

## Commercial model

Bop Complete: EUR 149/month or EUR 1,490/year, excluding VAT, for one organization.
All core modules and team accounts are included; unlimited AI usage is not promised.
Prices are introductory product decisions, not validated willingness-to-pay research.
Amounts are fixed server-side in `services/commerce.js`, never accepted from the
browser. Keep the matching website display amounts aligned when changing prices.
Price changes affect new subscriptions; do not silently change existing contracts.

## Release and migration

Apply `supabase/migrations/20260919111330_commerce_licensing.sql` before deploying
this code. It creates an empty additive billing table with organization and owner
foreign keys, uniqueness, RLS and explicit browser-role privilege revocation. It
updates no customer rows and adds no browser-accessible policy. There is no startup
DDL. Existing organizations without a license row retain existing access.

Reviewed against production integer IDs and tested with PGlite, including browser
role denial, repeated and concurrent submissions, unpaid confirmations, expiry,
renewals, cancellation, cookie forgery and webhook signature rejection. PGlite is
not a real PostgreSQL load test. Real Stripe end-to-end testing is still required
before accepting money, because no payment account is connected at initial release.

Rollback before any paid customers: revert the application release and leave the
empty table in place; no restoration of business data is needed. After payments
begin, keep the ledger and license enforcement. Disable new checkout if necessary,
but do not revert to code that bypasses existing paid entitlements. Reconcile with
Stripe before manually correcting billing records. Never drop a populated ledger.

## Enable payments (owner setup required)

1. Create/verify the merchant's Stripe account, legal business identity and payout
   bank account. Supply the actual seller's license terms and privacy notice.
   This release does not invent a legal entity, address or legal commitments.
2. In Stripe test mode, create the Bop Complete product. Configure Stripe Tax and
   applicable registrations. Checkout uses automatic tax, billing addresses and tax
   IDs; merchant tax obligations require the merchant's own review.
3. Configure the customer portal for invoice access, payment-method updates and
   cancellation **at period end**. Do not enable plan/quantity/price changes there:
   this version sells a fixed organization license and does not support upgrades.
4. Set Railway variables `STRIPE_SECRET_KEY`, `STRIPE_PRODUCT_ID`,
   `STRIPE_WEBHOOK_SECRET`, `BOP_PUBLIC_URL`, `BOP_TERMS_URL`, `BOP_PRIVACY_URL`.
   Store secrets only in Railway. Match test/live credentials and product modes.
5. Add the webhook `https://go-bop.com/api/commerce/webhook` using the Stripe API
   version bundled with pinned stripe-node 22.6.2. Subscribe to
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`
   and `invoice.payment_failed`.
6. Set `BOP_CHECKOUT_ENABLED=true` only in the test environment first. Exercise real
   Stripe test checkout, cancellation, delayed payment, failed payment, duplicate
   delivery, renewal and portal cancellation. Verify the organization becomes
   available once and its administrator can sign in. Verify the correct VAT.
7. Switch to verified live credentials and a live product/webhook, then enable new
   checkout. Monitor webhook errors and reconcile subscription status in Stripe.

Without all settings, `/api/commerce/catalog` reports `enabled: false`, purchase
fields stay disabled and no customer details are submitted. The public website,
license comparison and existing login remain usable. The checkout flag controls
new purchases only; it never disables license checks or webhook processing.

## Lifecycle and operational limits

A checkout reserves an inactive organization and a pending administrator with a
bcrypt password hash. A retry requires the same credentials and billing interval.
Row locks and Stripe idempotency prevent duplicate purchases for that reservation.
No existing active account is linked based solely on a submitted email address.
Abandoned reservations are retained; support must verify the requester before
releasing a reserved email. Add a retention/cleanup procedure before broad launch.

The signed raw-body webhook re-reads current Checkout and Subscription objects,
under a license row lock. Only a paid initial checkout plus a paid current invoice
and active subscription grants access. Renewals extend `access_until`; failed
payments cannot extend it. A billing outage cannot grant indefinite access. All
organization users are checked against the license on protected requests.

The welcome page reads status through a signed HTTP-only cookie. It cannot grant
access. It polls for one minute and offers a retry if confirmation is delayed.
Organization admins can open the billing portal even after license expiry;
ordinary members cannot create portal sessions or access another tenant's billing.

Pending webhook deliveries must be retried by Stripe. Support must investigate
persistent failures, refunds and disputes in Stripe: this initial version does not
automate refunds, chargebacks, plan changes, dunning communications or email
verification/password recovery. These limitations must be handled before scaling
self-service sales; they do not prevent the website launch with checkout disabled.
