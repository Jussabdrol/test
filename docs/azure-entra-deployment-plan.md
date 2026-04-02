# Azure Entra ID Deployment Plan
### Single-Tenant Enterprise Deployment — "Let The Framework"

**Prepared for:** Customer Azure Environment  
**Date:** 2026-04-02  
**Scope:** Migrate from Google Cloud Run + Supabase to a fully Microsoft-governed Azure stack, single-tenant, authenticated via Azure Entra ID.

---

## 1. Executive Summary

The application is a Node.js/Express full-stack business process management tool currently running on:

| Current | Azure Replacement |
|---|---|
| Google Cloud Run | Azure Container Apps |
| Google Container Registry | Azure Container Registry (ACR) |
| Google Cloud Build | Azure DevOps Pipelines |
| Supabase Auth | Azure Entra ID (OIDC via MSAL) |
| Supabase PostgreSQL | Azure Database for PostgreSQL – Flexible Server |
| Supabase Storage | Azure Blob Storage |
| OpenAI API | Azure OpenAI Service |
| (none) | Azure Key Vault (secrets management) |

The deployment will be **single-tenant** — one Entra ID tenant, one org, no public sign-up. All users are provisioned and governed by the customer's IT/Identity team.

---

## 2. Prerequisites

Before work begins, the customer must provide:

- [ ] An active Azure subscription with Owner or Contributor + User Access Administrator roles
- [ ] An Azure Entra ID (formerly AAD) tenant — confirmed single-tenant
- [ ] Permission to register an App Registration in Entra ID
- [ ] A domain name (or acceptance to use `*.azurecontainerapps.io` initially)
- [ ] An Azure DevOps organisation (or GitHub repo with Azure access) for CI/CD
- [ ] A list of initial users (for manual provisioning or AD group assignment)
- [ ] Data migration window/approval if moving any existing Supabase data

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   Azure Entra ID (Tenant)                │
│   App Registration  │  Users/Groups  │  Conditional CA  │
└──────────────┬──────────────────────────────────────────┘
               │  OIDC / OAuth 2.0 (Authorization Code + PKCE)
               ▼
┌─────────────────────────────────────────────────────────┐
│              Azure Container Apps (Environment)          │
│                                                          │
│   ┌─────────────────────────────────────────────────┐   │
│   │   Container App: ltf-app                        │   │
│   │   Image: ACR → node:20-alpine                   │   │
│   │   Port 3000 | Min 1, Max 10 replicas            │   │
│   │   Managed Identity (no stored credentials)     │   │
│   └─────────────────────────────────────────────────┘   │
└──────┬──────────────────┬─────────────────┬─────────────┘
       │                  │                 │
       ▼                  ▼                 ▼
 Azure Database     Azure Blob         Azure Key Vault
 for PostgreSQL     Storage            (secrets)
 Flexible Server    (file uploads)
       │
  Azure Private
  DNS / VNet
  (optional hardening)
```

---

## 4. Project Phases

---

### Phase 1 — Azure Foundation (Week 1)

**Goal:** Provision all Azure infrastructure so the team can start deploying.

#### 1.1 Resource Group & Naming Convention
- Create a Resource Group, e.g. `rg-ltf-prod`
- Agree on a naming convention: `<service>-ltf-<env>` (e.g. `ca-ltf-prod`, `pg-ltf-prod`)

#### 1.2 Azure Container Registry
- Create ACR: `acrltfprod` (Premium SKU for private endpoints if needed)
- Enable Admin user disabled — use Managed Identity for pull access

#### 1.3 Azure Database for PostgreSQL – Flexible Server
- SKU: `General Purpose, Standard_D2s_v3` (scale up/down as needed)
- PostgreSQL version: 15 (matches Supabase's underlying PG version)
- Enable Azure AD authentication (in addition to password auth during migration)
- Create database: `ltf`
- Private endpoint or VNet integration recommended for production
- Enable automated backups (7–35 day retention)

#### 1.4 Azure Blob Storage
- Create Storage Account: `saltfprod`
- Container: `uploads` (equivalent to Supabase Storage bucket)
- Access: Private — app accesses via Managed Identity (no connection strings)
- Enable soft-delete and versioning

#### 1.5 Azure Key Vault
- Create Key Vault: `kv-ltf-prod`
- Store all application secrets here (DB connection string, session secret, etc.)
- Grant the Container App's Managed Identity `Key Vault Secrets User` role

#### 1.6 Azure Container Apps Environment
- Create a Container Apps Environment: `cae-ltf-prod`
- Region: choose based on customer's data residency requirements (e.g. `westeurope`, `uksouth`)
- Log Analytics workspace attached for observability

**Deliverable:** All Azure resources provisioned. Terraform/Bicep IaC scripts committed to repo.

---

### Phase 2 — Entra ID Integration (Week 1–2)

**Goal:** Replace Supabase Auth with Azure Entra ID as the single identity provider.

#### 2.1 App Registration
- Register a new App in Entra ID: `LTF App`
- Account type: **Accounts in this organizational directory only** (single-tenant)
- Redirect URI: `https://<app-url>/auth/callback`
- Enable ID tokens + access tokens under Authentication
- Note: `Application (client) ID`, `Directory (tenant) ID`

#### 2.2 Client Secret / Certificate
- Create a client secret (or preferably an x509 certificate) for the server-to-Entra communication
- Store in Key Vault as `entra-client-secret`

#### 2.3 App Roles (Authorization)
Replicate the existing role model in Entra ID App Roles:

| Current role | Entra App Role |
|---|---|
| `superadmin` | `LTF.SuperAdmin` |
| `admin` | `LTF.Admin` |
| (default) | `LTF.User` |

- Assign roles to users or AD groups in **Enterprise Applications → Users and groups**

#### 2.4 Server-Side Auth Code Changes

The existing `server.js` uses Supabase Auth. Replace with **MSAL Node** (`@azure/msal-node`):

```
npm install @azure/msal-node @azure/identity @azure/storage-blob
```

Key changes in `server.js`:
- Replace `supabase.auth.signInWithPassword()` → MSAL Authorization Code flow (PKCE)
- Replace `supabase.auth.getUser()` → validate Entra ID JWT (verify `iss`, `aud`, `tid` claims)
- Keep existing session cookie mechanism — populate it from the Entra ID token claims
- Map Entra ID App Role claims → existing internal `role` field (no DB schema change needed)
- Remove Supabase auth fallback (`bcryptjs` local auth) — Entra ID is the sole provider

#### 2.5 Frontend Auth Changes

- Replace any Supabase client-side auth calls with redirect to `/auth/login` (server-initiated OIDC flow)
- Silent token refresh: use MSAL's token cache server-side; refresh before expiry

#### 2.6 Conditional Access (Customer IT task)
Recommend customer configure:
- MFA required for all app users
- Compliant device policy (if applicable)
- Sign-in risk policy (Identity Protection)

**Deliverable:** Users can log in with their existing Microsoft/Entra credentials. Roles are assigned via AD groups.

---

### Phase 3 — Data Layer Migration (Week 2)

**Goal:** Move from Supabase PostgreSQL + Storage to Azure equivalents.

#### 3.1 Database Migration

1. Export schema from Supabase: `pg_dump --schema-only`
2. Review and apply schema to Azure PostgreSQL (run existing migration SQL files in order):
   - `add-indexes.sql`
   - `add-organization-id.sql`
   - `add-process-id-to-actions.sql`
   - `management-review-migration.sql`
   - `process-kpis-migration.sql`
3. Export data: `pg_dump --data-only` from Supabase
4. Import to Azure PostgreSQL: `psql -h <host> -U <user> -d ltf < data.sql`
5. Verify row counts across all tables
6. Update `DATABASE_URL` / `PG_*` env vars to point to Azure PostgreSQL

> **Note:** Supabase Row-Level Security (RLS) policies are PostgreSQL-native — they will migrate as-is. Validate each policy post-migration.

#### 3.2 File Storage Migration

1. List all files in Supabase Storage bucket
2. Download with `supabase storage download` or via the S3-compatible API
3. Upload to Azure Blob Storage container `uploads` using `azcopy`
4. Update all storage references in `server.js`:
   - Replace `supabase.storage.from('bucket').upload()` → Azure Blob Storage SDK (`@azure/storage-blob`)
   - Replace signed URL generation → Azure SAS token or Blob CDN URL
5. Update `multer` destination to pipe directly to Azure Blob Storage (use `multer-azure-blob-storage` or stream to `BlobServiceClient`)

#### 3.3 Remove Supabase SDK Dependency

Once auth and storage are migrated:
- Remove `@supabase/supabase-js` from `package.json`
- Remove `SUPABASE_URL` and `SUPABASE_ANON_KEY` env vars
- Retain `pg` driver for direct database access (already in use)

**Deliverable:** Application reads/writes data from Azure PostgreSQL and Azure Blob Storage. No Supabase dependency remains.

---

### Phase 4 — Application Containerisation & CI/CD (Week 2–3)

**Goal:** Replace Google Cloud Build pipeline with Azure DevOps.

#### 4.1 Azure Container Registry — Image Build

Replace `cloudbuild.yaml` with an Azure DevOps pipeline (`azure-pipelines.yml`):

```yaml
trigger:
  branches:
    include: [main]

pool:
  vmImage: ubuntu-latest

variables:
  ACR_NAME: acrltfprod
  IMAGE_NAME: ltf-app
  TAG: $(Build.BuildId)

stages:
  - stage: Build
    jobs:
      - job: BuildAndPush
        steps:
          - task: Docker@2
            inputs:
              containerRegistry: 'ACR-ServiceConnection'
              repository: $(IMAGE_NAME)
              command: buildAndPush
              dockerfile: Dockerfile
              tags: $(TAG)

  - stage: Deploy
    jobs:
      - job: DeployToContainerApps
        steps:
          - task: AzureContainerApps@1
            inputs:
              azureSubscription: 'Azure-ServiceConnection'
              containerAppName: ca-ltf-prod
              resourceGroup: rg-ltf-prod
              imageToDeploy: $(ACR_NAME).azurecr.io/$(IMAGE_NAME):$(TAG)
```

#### 4.2 Environment Variables / Secrets Injection

All secrets come from Key Vault via Container Apps secret references — no plaintext in pipeline or container config:

| Variable | Source |
|---|---|
| `DATABASE_URL` | Key Vault → `pg-connection-string` |
| `SESSION_SECRET` | Key Vault → `session-secret` |
| `ENTRA_CLIENT_ID` | App Registration Client ID (non-secret, can be plain env var) |
| `ENTRA_TENANT_ID` | Tenant ID (non-secret) |
| `ENTRA_CLIENT_SECRET` | Key Vault → `entra-client-secret` |
| `AZURE_STORAGE_ACCOUNT` | Key Vault or plain env var |
| `AZURE_OPENAI_ENDPOINT` | Key Vault → `openai-endpoint` |
| `AZURE_OPENAI_KEY` | Key Vault → `openai-key` |

#### 4.3 Container App Configuration

```bash
az containerapp create \
  --name ca-ltf-prod \
  --resource-group rg-ltf-prod \
  --environment cae-ltf-prod \
  --image acrltfprod.azurecr.io/ltf-app:latest \
  --registry-identity system \
  --min-replicas 1 \
  --max-replicas 10 \
  --cpu 1.0 \
  --memory 2.0Gi \
  --ingress external \
  --target-port 3000
```

Managed Identity is used to pull from ACR and access Key Vault — no stored credentials.

**Deliverable:** Push to `main` triggers a build, image is pushed to ACR, Container App is updated automatically.

---

### Phase 5 — Azure OpenAI Migration (Week 3)

**Goal:** Replace direct OpenAI API calls with Azure OpenAI Service.

- Create Azure OpenAI resource in the same region
- Deploy a model (e.g. `gpt-4o` or `gpt-4-turbo`)
- Update `server.js` OpenAI client initialisation:

```js
// Before
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// After
import OpenAI from 'openai';
const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: { 'api-version': '2024-02-01' },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_KEY },
});
```

- The OpenAI SDK supports Azure OpenAI natively — minimal code change
- Store endpoint and key in Key Vault

**Deliverable:** AI chat agent runs through Azure OpenAI — data stays within the customer's Azure tenant.

---

### Phase 6 — Security Hardening (Week 3–4)

**Goal:** Meet enterprise security baseline before go-live.

#### 6.1 Network Security
- [ ] Deploy Container Apps in a VNet-integrated environment
- [ ] PostgreSQL: Private endpoint only (no public access)
- [ ] Blob Storage: Private endpoint + disable public blob access
- [ ] Key Vault: Private endpoint + firewall — only allow Container Apps subnet
- [ ] Application Gateway or Azure Front Door for WAF (Web Application Firewall)

#### 6.2 Identity & Access
- [ ] No service principal secrets stored in code or pipelines (all via Managed Identity)
- [ ] Apply least-privilege RBAC on all resources
- [ ] Enable Entra ID Privileged Identity Management (PIM) for admin roles
- [ ] Audit logging: Entra ID sign-in logs → Log Analytics

#### 6.3 Data Security
- [ ] Encryption at rest: Azure-managed keys (or customer-managed keys via Key Vault if required)
- [ ] TLS 1.2+ enforced on all endpoints
- [ ] PostgreSQL SSL required (`sslmode=require`)
- [ ] Enable Microsoft Defender for Cloud on the subscription

#### 6.4 Application Security
- [ ] Review and harden HTTP security headers (`helmet.js` already likely in use)
- [ ] Validate `tid` (tenant ID) claim in every Entra ID token — reject tokens from other tenants
- [ ] CSRF protection on state-changing endpoints
- [ ] Dependency audit: `npm audit` and set up Dependabot / Azure DevOps dependency scanning

---

### Phase 7 — Testing & UAT (Week 4)

**Goal:** Validate the deployment end-to-end before handing over to users.

#### 7.1 Functional Testing
- [ ] Login with Entra ID credentials → role correctly mapped
- [ ] Create/read/update/delete processes, actions, KPIs
- [ ] File upload to Azure Blob Storage
- [ ] Excel import (BOP_Import_Template.xlsx)
- [ ] AI chat agent responds correctly
- [ ] Multi-user isolation (org_id scoping still works)
- [ ] Health check endpoint (`/health`) returns 200

#### 7.2 Security Testing
- [ ] Attempt login with a user from a different tenant — must be rejected
- [ ] Attempt accessing another user's org data — must be blocked by RLS
- [ ] Penetration test or OWASP ZAP scan on the staging URL

#### 7.3 Performance Testing
- [ ] Load test with realistic concurrent users (Azure Load Testing or k6)
- [ ] Verify auto-scaling triggers at expected thresholds

#### 7.4 User Acceptance Testing
- [ ] Customer nominates 3–5 power users for UAT
- [ ] UAT sign-off document completed

---

### Phase 8 — Go-Live & Handover (Week 5)

#### 8.1 DNS Cutover
- Point customer domain (e.g. `ltf.contoso.com`) to Container Apps ingress URL
- Configure custom domain + managed TLS certificate in Container Apps

#### 8.2 User Provisioning
- Customer IT assigns all users to the Entra ID Enterprise App
- Assign correct App Roles (LTF.Admin / LTF.User) via AD groups

#### 8.3 Monitoring Setup
- Application Insights connected to Container App for request tracing, exception tracking
- Azure Monitor alerts: CPU > 80%, memory > 80%, HTTP 5xx rate, failed logins
- Log Analytics dashboard for the customer's ops team

#### 8.4 Documentation Handover
- [ ] Architecture diagram (draw.io / Visio)
- [ ] Runbook: how to deploy a new version
- [ ] Runbook: how to add/remove users
- [ ] Runbook: how to restore from backup
- [ ] IaC repo (Bicep/Terraform) with README

#### 8.5 Decommission Supabase & Google Cloud
- Confirm Azure deployment stable for 2 weeks minimum before decommissioning
- Export final data backup from Supabase before teardown
- Delete Google Cloud project resources

---

## 5. Effort Estimate

| Phase | Effort |
|---|---|
| Phase 1 – Azure Foundation | 2–3 days |
| Phase 2 – Entra ID Integration | 3–4 days |
| Phase 3 – Data Layer Migration | 2–3 days |
| Phase 4 – CI/CD Pipeline | 1–2 days |
| Phase 5 – Azure OpenAI | 0.5 days |
| Phase 6 – Security Hardening | 2–3 days |
| Phase 7 – Testing & UAT | 3–4 days |
| Phase 8 – Go-Live & Handover | 1–2 days |
| **Total** | **~3–4 weeks** |

Estimates assume one developer familiar with both the codebase and Azure. Add buffer for customer IT dependency (Entra ID provisioning, network approvals).

---

## 6. Key Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Entra ID App Registration delayed by customer IT | Medium | High | Start Phase 2 discovery in parallel with Phase 1 infra work |
| RLS policies behave differently after migration | Low | High | Thorough data layer testing in staging before prod cutover |
| Network policy blocks Container App → PostgreSQL | Medium | Medium | Test connectivity early; use private endpoints from day 1 |
| OpenAI model availability in chosen Azure region | Low | Medium | Check Azure OpenAI regional availability before region selection |
| User resistance to Entra ID login change | Low | Low | Communicate SSO benefit (same Microsoft credentials, no new password) |

---

## 7. Customer Responsibilities

| # | Task | Owner |
|---|---|---|
| 1 | Provide Azure subscription access | Customer IT |
| 2 | Create/nominate Entra ID tenant | Customer IT |
| 3 | Approve App Registration | Customer IT Admin |
| 4 | Assign users to Enterprise App | Customer IT |
| 5 | Configure Conditional Access policies | Customer IT / Security |
| 6 | Approve network/firewall rules | Customer IT / Network |
| 7 | UAT sign-off | Customer Business |
| 8 | Arrange data migration window | Customer IT |

---

## 8. Out of Scope

- Multi-tenancy enablement (single org only per this engagement)
- Mobile app development
- Custom Entra ID branding (can be done by customer IT independently)
- SIEM integration beyond Log Analytics
- Disaster Recovery to a second region (can be a follow-on engagement)
