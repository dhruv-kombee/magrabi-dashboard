# Magrabi Deployment Portal — Environment Runbook

Living architectural and environmental record of the Magrabi Deployment Portal infrastructure, services, and operational wiring.

> **Operational Guidelines:**
> - Update this file in place as system architecture evolves. Never append contradictions.
> - Each section maintains a `Last Verified` date-stamp and confidence indicator (`VERIFIED: LIVE` or `SPECIFIED: ARCHITECTURE`).
> - Incident logs and transient trial narratives belong in `work_log/`, not in this document.

---

## 1. System Overview & Core Architecture

- **Project Name**: Magrabi Deployment Portal (extending with Commerce Intelligence)
- **Purpose**: Unified orchestrator and governance portal for automating application deployments, tracking pipeline releases, managing environment configurations, and hosting the Commerce Intelligence analytics dashboard for Magrabi and DoctorM retail brands.
- **Topology**:
  - **Portal Frontend**: React 19 + TypeScript + Vite single-page application serving operational deployment tools, live monitoring insights, and Commerce Intelligence dashboards.
  - **Backend Orchestrator / API Service**: Flask application (`backend/app.py`) serving deployment workflows, Traffic Counts API, and Commerce Intelligence query endpoints.
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
  - Canonical repository remote for main portal is pending confirmation with Sanskar Gupta.
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
