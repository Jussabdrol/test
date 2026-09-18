# Security boundaries and remaining work

## Security release, 18 September 2026

- Browser `anon` and `authenticated` roles have no public-schema table, sequence
  or function privileges. RLS is enabled on every public table. BOP uses its
  authenticated backend; service-role credentials remain server-only.
- Organization admins cannot assign platform roles or modify platform accounts.
  Direct APIs, shared relationship pickers and summaries enforce module access.
  Viewers cannot write. Every authenticated request checks current account status,
  role, expiry, organization status and session version.
- Local password hashes are authoritative when present. An outdated provider
  password cannot bypass a local reset. Provider-only accounts must match the
  previously linked Supabase UID. No automatic email-based account linking.
- Legacy SAML is blocked, including its configuration endpoint. Restoring SSO
  requires a maintained implementation and IdP-based security tests.
- Production startup verifies the schema marker and performs no DDL or seeding.
  PostgreSQL TLS verifies certificates; database statements have a timeout.
- Document conversion uses a patched dependency, sanitized text/table HTML and a
  worker with time/memory/concurrency limits. Embedded images and arbitrary styles
  are removed from edited Word exports. Uploads are limited to 20 MB and checked
  for expected file signatures; these checks are not malware scanning.
- Sensitive AI prompts/tool arguments are no longer printed to logs. AI history,
  request frequency and concurrency are bounded. Rate counters are in memory and
  apply to the current single Railway replica; they reset on restart.

See [database rollout/recovery](security/database-rollout.md) for the separately
applied migration. The live standard-account passwords were rotated and their
sessions revoked out of band. No live credentials are stored in this repository.

## Open production-readiness items

| Priority | Area | Required follow-up |
| --- | --- | --- |
| High | Disaster recovery | User explicitly deferred backup setup. Configure automatic database **and Storage object** backups, retention and an isolated restore drill. JSON exports are not disaster-recovery backups. |
| Medium | Browser CSP/CDNs | Inline handlers and external browser libraries remain. Migrate event handlers, pin/self-host audited browser assets and remove unsafe-inline/unsafe-eval after browser compatibility testing. npm audit does not audit CDN scripts. |
| Medium | Monitoring | Railway `/health` checks deployment readiness. Add independent ongoing uptime/error alerting with an agreed destination and incident procedure. |
| Medium | AI capacity/billing | Use durable shared quotas before multiple replicas or usage-based billing. In-memory limits are abuse mitigation, not accounting. Review provider data handling for customer contracts. |
| Medium | Upload processing | Add malware scanning and isolated Office/archive extraction with decompression bounds. Signature validation alone cannot establish a document is safe. |
| Medium | Supabase Auth | Leaked-password protection remains disabled. Local password authority means provider policy alone would not cover all BOP accounts. Plan a unified Auth migration and breached-password checks. |
| Medium | Least privilege | The backend still uses its existing privileged PostgreSQL connection. Provision a dedicated runtime DB role, test all routes, and reserve schema ownership for migrations. |
| Medium | Release protection | Require CI and protected deployment branches using repository administration access; current connector cannot configure branch protection. |
| Future | SSO and fresh installations | Provide maintained SAML/OIDC integration and an explicit fresh-schema/admin provisioning workflow before offering these features. |

Preserve session-bound CSRF, tenant-aware references, transactions, post-commit
side effects, protected downloads and webhook destination validation. Regression
tests cover selected attack paths and business workflows; they are not a full
penetration test, load test or independent security certification.

## Validation

`npm run verify` runs the deterministic client build, syntax/lint checks and
isolated PGlite/HTTP/unit tests. Database tests apply the security migration twice,
verify browser-role read/write denials and backend access, and preserve user data.
The 18 September dependency update removed the two reported high-severity
`html-to-docx`/`image-size` advisories. Re-run `npm audit --omit=dev` before releases.
