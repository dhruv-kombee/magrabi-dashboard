# Magrabi Deployment Portal — Environment Runbook

Living architectural and environmental record of the Magrabi Deployment Portal infrastructure, services, and operational wiring.

> **Operational Guidelines:**
> - Update this file in place as system architecture evolves. Never append contradictions.
> - Each section maintains a `Last Verified` date-stamp and confidence indicator (`VERIFIED: LIVE` or `SPECIFIED: ARCHITECTURE`).
> - Incident logs and transient trial narratives belong in `work_log/`, not in this document.

---

## 1. System Overview & Core Architecture

- **Project Name**: Magrabi Dashboard & Commerce Intelligence Workspace
- **Purpose**: Unified monorepo housing two decoupled, independently runnable applications:
  1. **Magrabi Deployment Portal** (`magrabi-deploy-portal/`): Automated release orchestrator, deployment verification, and ADO pipeline management.
  2. **Commerce Intelligence Platform** (`commerce-intelligence-platform/`): Dedicated real-time monitoring and analytics web application for Magrabi and DoctorM commerce operations.
- **Topology**:
  - **Commerce Intelligence Frontend**: Dedicated standalone React 19 + TypeScript + Vite application running on port `5174`, completely isolated from deployment management.
  - **Deployment Portal Frontend**: React 19 + TypeScript + Vite single-page application (`magrabi-deploy-portal/frontend`) running on port `5173`.
  - **Backend Orchestrator / API Service**: Flask application (`magrabi-deploy-portal/backend/app.py`) running on port `5151` for deployment workflows and Traffic Counts API.
  - **Monitoring Subsystem**: Separate containerized service (`observability/magrabi-monitoring-sit`) deployed via ADO pipeline 165, served under `/monitoring`, `/monitoring-assets`, and `/api/monitoring/v1`.
- **Last Verified**: 2026-10-15 | Confidence: VERIFIED: LIVE

---

## 2. Environments Inventory

| Environment | Purpose | Ingress / Hostname | Cluster / Resource Group | Namespace | Image / Digest | Last Verified |
|---|---|---|---|---|---|---|
| **Live Operational** | Active deployment management & monitoring | `https://deploy-portal.test-magrabi.com` | `aks-ecom-common-uaenorth-001` / `rg-mepu-common-uaenorth-001` | `deploy-portal` | `crmepucommonuaenorth001.azurecr.io/magrabi-deploy-portal:93` (digest: `sha256:d64e7070b209...`) | 2026-10-15 |
| **Proposed Commerce Test** | Isolated Commerce Intelligence development & UAT | `https://deploy-portal-commerce-test.test-magrabi.com` (Pending provisioning) | `aks-ecom-common-uaenorth-001` (or dedicated test node pool) | `deploy-portal-commerce-test` | Dedicated image tag/prefix; separate test pipeline | 2026-10-15 |
| **Local Workstation** | Offline development, fixture execution & unit testing | `localhost:5151` (Backend) / `localhost:5173` (Vite dev) | Local workstation | N/A | Local venv / Node | 2026-10-15 |

---

## 3. Network, Routing & Ingress Specifications

- **Azure Subscription**: E-commerce / `72bde893-fa26-4129-a31f-648b81a48153` (Tenant: `cc9b4a8c-1b70-4347-acd3-80d32f102f2f`).
- **Live Edge Configuration**:
  - Azure Front Door Profile: `frontdoor-mepu-common-uaenorth-001`
  - Endpoint: `ep-mepu-common`
  - Route: `rt-deploy-portal`
  - Origin Group: `og-deploy-portal`
  - Forwarding Protocol: `HttpOnly`
  - Domain Validation: ManagedCertificate, Approved
- **Path Routing on Host**:
  - `/` -> `magrabi-deploy-portal:80` (container port 5151)
  - `/monitoring`, `/monitoring-assets`, `/api/monitoring/v1` -> `magrabi-monitoring-sit:80` (container port 5152)
  - `/rum` -> `alloy-rum:12347`
- **Isolation Constraint**: The test portal must have a dedicated Front Door route, origin group, and hostname. Never overwrite or re-point `rt-deploy-portal`.
- **Last Verified**: 2026-10-15 | Confidence: VERIFIED: LIVE

---

## 4. Pipeline & Deployment Integration

- **Main Deployment Portal Release**:
  - Documented existing release path is manual ACR build (`crmepucommonuaenorth001`) and targeted `kubectl set image`.
  - Active GitHub repository remote: `https://github.com/dhruv-kombee/magrabi-dashboard.git` (branch `main`). Formal upstream baseline confirmation with Sanskar Gupta remains pending.
  - Dedicated test pipeline must be created in Azure DevOps for Commerce Intelligence test releases; do not deploy unreviewed builds to production.
- **Monitoring Component Release**:
  - ADO Pipeline ID: `165` (`magrabi-observability`)
  - Repository: `https://dev.azure.com/MGRDevOps-Ecomm/ECom/_git/magrabi-observability`
  - Target: `observability/magrabi-monitoring-sit`
  - Verified baseline: Build 17349, commit `0352a20746e68365baf8c7a77fe617e5a1d00367`.
- **Image & Artifact Pinning Policy**:
  - Never pin to `latest`.
  - All deployments must reference immutable image digests or distinct commit tags.
- **Last Verified**: 2026-10-15 | Confidence: VERIFIED: LIVE

---

## 5. Storage & Secrets Boundaries

- **Live PVC Mount**: `deploy-portal-runs` (1Gi, `ReadWriteOnce`, `managed-csi`) mounted at `/data`.
- **Secret References (Live)**: `deploy-portal-ado`, `deploy-portal-auth`, `deploy-portal-insights`.
- **Isolation Rule**:
  - Test portal must never mount the live `deploy-portal-runs` PVC.
  - Test backend must never discover or load live ADO write credentials (`.secrets/azuredevops.env`).
  - Reporting database for Commerce Intelligence must be dashboard-owned (e.g. dedicated PostgreSQL schema/instance), never writing to source production operational databases.
- **Last Verified**: 2026-10-15 | Confidence: VERIFIED: LIVE

---

## 6. Commerce Assist Architecture

- **Frontend**: Responsive React assistant panel embedded in the Commerce Intelligence Platform. It submits the active brand, country, timezone, and reporting window with each question. Versioned browser-local storage retains conversations until the user deletes them or clears browser data.
- **Backend API**: `POST /api/commerce/assistant/query` on the existing Node service.
- **Approved Data Scope**: Saleor Core, Macula OMS, payment-gateway telemetry, Azure edge traffic, Grafana/infrastructure telemetry, and connector configuration status exposed by the Commerce Intelligence backend.
- **Grounding Boundary**: Answers use a server-gathered snapshot of explicit, verified fields. Raw gateway responses, secrets, URLs, and illustrative chart metrics are excluded from model input and exports. Equivalent requests share a 30-second scoped cache.
- **Question Understanding**: Every in-platform question can be planned by Gemini as structured intent, country, brand, period, comparison need, and requested metric definitions using the current text and short user-question history. The server validates this plan against allowed values; explicit current-question wording wins over model hints and old conversation context. Deterministic parsing covers multi-part count/definition requests when Gemini is unavailable. The interpreted query scope is shown on each answer, independently of dashboard filters. Ambiguous either-or questions are not sent to connectors; the assistant asks a scoped follow-up with selectable choices. Obvious outside-platform topics are rejected before model or connector calls.
- **Optional Model Integration**: `GEMINI_API_KEY` and `GEMINI_MODEL` enable Gemini 3.1 Flash-Lite via the server-side `generateContent` endpoint. No browser receives the API key and no web-search tool is enabled. Without the key, the built-in platform answer engine remains active.
- **Fallback Visibility**: Transient Gemini errors are retried; the response and UI identify whether Gemini interpreted the request and whether Gemini answered or a verified platform answer was used, without exposing credential values. Answer-generation input contains only the reference answer, scope, and verified evidence; numbers absent from that material cause a fallback to the deterministic answer.
- **Source Provenance**: Each answer includes explicit source evidence with the connector, field values used, feed status, and snapshot time. Out-of-platform questions are refused before connector or model access.
- **Answer Presentation & Exports**: The direct answer appears first, followed by compact key figures; the full metric/value/source table is collapsed until requested. Answer-specific evidence excludes unrequested country breakdowns, and export audit fields include only relevant verified facts. A “last month” request uses and labels a rolling 30-day window, while “prior-window orders” refers to the immediately preceding same-length period. PDF, XLSX (filterable data-table sheet), and DOCX reports carry the same focused evidence; reports are not persisted by the backend.
- **Order-Stage Provenance**: Sales answers lead with verified Macula OMS received orders, then show Saleor placed orders and gross placed-order value separately. Explicit Macula-only requests never substitute Saleor. The dashboard country performance and daily-order views are Saleor placed-order views. Macula count failures remain unavailable rather than zero; no daily sync trend or 100% reconciliation claim is generated without verified OMS daily points and matched order IDs.
- **Current Macula Status (2026-10-22)**: VERIFIED: LIVE local probe: credentials are configured, but the login response did not provide a token and the Macula summary returned `FAIL`. The exact cause (credentials versus changed login flow) is unverified. Do not describe Macula as connected until a new read-only probe succeeds.
- **External Permissions**: All connectors remain read-only. Commerce Assist has no mutation or notification tools.
- **Last Verified**: 2026-10-22 | Confidence: VERIFIED: LOCAL BUILD + LIVE ASSISTANT/MACULA PROBES + TARGETED UNIT TESTS + DESKTOP/MOBILE AND PDF/XLSX/DOCX QA

---

## 7. Commerce Intelligence Dashboard Authentication

- **Access Boundary**: All `/api/commerce/*` data endpoints require a valid dashboard session. Static application assets remain public but contain no connector credentials or operational data.
- **Credential Storage**: The login username, scrypt password hash, and session-signing secret are server-side only. Local interactive setup writes them to the gitignored `.secrets/dashboard-auth.env`; hosted environments must inject the same values through their secret-management mechanism.
- **Session Controls**: Authentication uses a signed `HttpOnly`, `SameSite=Strict` cookie. The idle timeout is 10 minutes and is renewed only by real browser activity; automatic dashboard requests do not renew it. Logout clears the cookie, invalid or tampered cookies are rejected, and failed login attempts are throttled.
- **Response Security**: API responses are marked `no-store`; the production server adds frame, MIME-sniffing, referrer, permissions, and content-security-policy headers.
- **Deployment State**: Code and local HTTP behavior are verified. Operator-chosen credentials are not yet configured and no deployment has occurred.
- **Last Verified**: 2026-10-26 | Confidence: VERIFIED: LOCAL UNIT TESTS + PRODUCTION BUILD + HTTP AUTH FLOW
