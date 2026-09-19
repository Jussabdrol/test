-- Additive only. Apply before deploying the support routes. No customer tables change.
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id SERIAL PRIMARY KEY,
  reference UUID NOT NULL UNIQUE,
  submission_id UUID NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 100),
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  organization TEXT NOT NULL DEFAULT '' CHECK (length(organization) <= 150),
  topic TEXT NOT NULL CHECK (topic IN ('product','technical','account','privacy','feedback')),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 5 AND 160),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 20 AND 5000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  internal_notes TEXT NOT NULL DEFAULT '' CHECK (length(internal_notes) <= 10000),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_tickets_status_id_idx ON public.support_tickets(status, id DESC);
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
-- Only the trusted server connection handles tickets. No browser/Data API access.
REVOKE ALL ON public.support_tickets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.support_tickets_id_seq FROM PUBLIC, anon, authenticated;
