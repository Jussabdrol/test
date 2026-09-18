-- BOP uses its server-side PostgreSQL connection for business data. Browser
-- clients use the Express API, never PostgREST. Auth and private Storage remain
-- available through their own APIs; service_role/postgres grants are preserved.
-- No customer rows are deleted or rewritten by this migration.
SET lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS public.bop_schema_versions (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', item.tablename);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated', item.tablename);
  END LOOP;
END $$;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('current_user_org_id','is_superadmin','set_updated_at') LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public', item.signature);
  END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS bop_use_cases_org_idx ON public.use_cases(organization_id);
CREATE INDEX IF NOT EXISTS bop_use_cases_owner_idx ON public.use_cases(owner_id);
CREATE INDEX IF NOT EXISTS bop_use_cases_implementation_owner_idx ON public.use_cases(implementation_owner_id);
CREATE INDEX IF NOT EXISTS bop_use_cases_approved_by_idx ON public.use_cases(approved_by_id);
CREATE INDEX IF NOT EXISTS bop_use_case_approvals_case_idx ON public.use_case_approvals(use_case_id);
CREATE INDEX IF NOT EXISTS bop_use_case_approvals_approver_idx ON public.use_case_approvals(approved_by_id);
CREATE INDEX IF NOT EXISTS bop_use_case_members_user_idx ON public.use_case_members(user_id);
INSERT INTO public.bop_schema_versions(version) VALUES ('2026-09-security-v1') ON CONFLICT DO NOTHING;
NOTIFY pgrst, 'reload schema';
