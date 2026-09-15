# Security boundaries and follow-up work

This restructuring makes code easier to locate and verify. It is not a complete
security audit. The following observations come from the existing source and
should guide scoped follow-up changes.

| Priority | Area | Follow-up and acceptance criteria |
| --- | --- | --- |
| High | Startup seeding | Replace fixed historical account passwords with a deliberate bootstrap flow. Verify fresh installation, existing users and recovery before changing behavior. |
| High | Schema lifecycle | Replace ad hoc startup migrations with an explicit ledger and tested data-preserving upgrades. The legacy use-case rebuild contains destructive DDL. |
| High | Tenant authorization | Inventory every endpoint, privileged SQL call, RLS policy and Storage operation. Add tests for ordinary members, administrators, tenant switching and forbidden foreign IDs. |
| High | SAML | Replace/review the hand-written XML signature verifier; source comments acknowledge missing canonicalization. Test issuer, audience, recipient, timing, replay and signature-wrapping cases with a real IdP. |
| High | Database TLS | Review `rejectUnauthorized: false` against the actual hosting connection/certificate configuration, then enable verified TLS with connectivity tests. |
| Medium | Browser globals/CSP | Migrate screen by screen to explicit modules and delegated events. Remove permissive inline/eval CSP directives only after migrating their consumers. |
| Medium | AI logging and boundaries | Review prompt/tool-argument logging and sensitive data retention. Preserve server-side permission checks and shared workflow operations; add external-provider contract tests with synthetic data. |
| Medium | Large domain modules | Extract use cases/KPIs/architecture from `routes/organization.js`, shared workflow services from route factories and independent browser state incrementally. |
| Medium | External dependencies | Review CDN imports and locked dependency advisories. Upgrade with focused compatibility tests instead of applying a forced major-version audit fix. |

Existing defenses to preserve include session-version invalidation, signed
session-bound CSRF tokens, tenant-aware lookups, transactional workflow responses,
post-commit side effects, upload allow/deny rules, attachment downloads, and
webhook destination validation. Tests cover selected paths, not every possible
combination.

Supabase service-role operations bypass RLS and must remain server-side. RLS and
grants need to be checked independently of application middleware, as described
in [the Supabase RLS documentation](https://supabase.com/docs/guides/database/postgres/row-level-security).
No live database, storage policy, identity provider or production secret was
changed as part of this repository reorganization.

## Dependency audit at restructuring

On 2026-09-15, `npm audit --omit=dev` reported two high-severity affected packages:
`image-size` and its direct consumer `html-to-docx`. The underlying parser
denial-of-service advisories are [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
and [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq).
These production dependencies predate this change. npm's proposed fix changes the
direct package version incompatibly; upgrading/replacing the document converter
requires a separate compatibility and security change. The existing conversion
regressions pass but do not establish that these parsers are safe for every input.
