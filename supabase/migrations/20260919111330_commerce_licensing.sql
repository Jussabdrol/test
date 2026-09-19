-- Additive billing ledger. Existing organizations remain on their existing access model.
-- Rollback: disable NEW checkout, retain this ledger for paid entitlements and reconciliation.
CREATE TABLE IF NOT EXISTS public.bop_licenses (
  id UUID PRIMARY KEY,
  organization_id INTEGER NOT NULL UNIQUE REFERENCES public.organizations(id),
  owner_id INTEGER NOT NULL UNIQUE REFERENCES public.users(id),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('month','year')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','expired','cancelled')),
  stripe_session_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  accepted_terms_url TEXT,
  accepted_privacy_url TEXT,
  terms_accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checkout_attempt INTEGER NOT NULL DEFAULT 0,
  access_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.bop_licenses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bop_licenses FROM PUBLIC, anon, authenticated;
-- Only the existing trusted backend connection can access billing records.
CREATE INDEX IF NOT EXISTS bop_licenses_customer_idx ON public.bop_licenses(stripe_customer_id);
