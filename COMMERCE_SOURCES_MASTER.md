# Commerce Intelligence — Master Source Catalog & Connection Checklist

This document is the **authoritative reference catalog** for all data sources in the Magrabi Commerce Intelligence Platform. 
Whenever a dashboard UI section, metric tile, or screenshot is referenced, use this catalog to determine the exact source system, connection protocol, required credentials, and responsible team.

> [!CAUTION]
> ### STRICT INVARIANT: ZERO EXTERNAL MUTATIONS — READ-ONLY INGESTION ONLY
> Our sole objective is to **fetch and feed data** to the internal dashboard. Under NO circumstances will this platform, any script, or any AI agent modify, reconfigure, update, or delete any resource, setting, or transaction on ANY external platform (Saleor, Macula OMS, Checkout.com, Paymob, Tabby, Tamara, Azure Front Door, CDN, WAF, AKS, Grafana, Sentry, GA4, Clarity). All external connectors must be strictly least-privilege read-only.

---

## 1. Orders, Payments & Customer Journey

| UI Metric / Tile | System | How We Connect | Access / Credentials Required | Purpose / Used For | Source Owner |
|---|---|---|---|---|---|
| **Portal Host / Routing** | Deployment Portal | Existing React 19 / Vite application | Repository access + local dev / test portal | Host and render the Commerce Intelligence platform | DevOps / Core Team |
| **Orders Placed · Saleor** | [Saleor Core](https://docs.saleor.io/api-usage/authentication) | GraphQL API (`/graphql/`) or read-only replica | Service / App Token with `MANAGE_ORDERS: READ` | Placed orders count, channels, checkouts, and payment attempt events | Saleor Lead / DBA |
| **Received in OMS** | Macula / OMS | API (`POST /api/v1/order/search`) OR read-only Mongo view | Service token / OAuth OR restricted `mongo-prod.omni_order` view reader | Actual received orders, fulfillment status, and sync-delay / exception reconciliation | Macula OMS Lead / DBA |
| **Tabby Payments** | [Tabby](https://docs.tabby.ai/api-reference/payments/retrieve-a-payment) | Payment inquiry API / approved webhook feed | Merchant secret / API credential (read-only facade) or export feed | Tabby payment authorization, capture, decline, and expiration outcomes | Payments / Finance |
| **Tamara Payments** | [Tamara](https://docs.tamara.co/docs/direct-quick-start-guide) | Payment inquiry API / approved webhook feed | Merchant API bearer token or reporting-feed access | Tamara BNPL payment lifecycle status and reconciliation | Payments / Finance |
| **Card Payments (UAE/KSA)** | [Checkout.com](https://api-reference.checkout.com/) | Payment details / search / reporting APIs | Restricted secret API key (`gateway:payment-details`, `reports:view`) or OAuth | Successful, failed, and pending card transactions; decline reason breakdown | Payments / Finance |
| **Egypt Payments (Card/Wallet)** | [Paymob](https://developers.paymob.com/paymob-docs/payments-and-features/core-features/transaction-inquiry-and-reports) | Transaction inquiry API + verified callback feed | Merchant API authentication / HMAC secret for callback verification | Paymob transaction outcomes, wallet splits, and decline codes | Payments / Finance |
| **Apple Pay / KNET** | Gateway Methods | Through configured gateway (Checkout.com / Paymob) | Gateway reporting access + method mapping (No Apple .p8 or B2C key needed) | Method-wise transaction volume and authorization success rates | Payments / Gateways |
| **Cash on Delivery (COD)** | Saleor / OMS | Existing order/payment feed from Saleor/OMS | Existing order-read access (tagged with COD payment method) | COD placed orders, pending collection, and delivery reconciliation | OMS / Saleor |
| **Funnel Drop-offs & Conversion** | Storefronts (Magrabi & DoctorM) | First-party client beacon / event ingestion | Frontend PR access + approved `/api/events/journey` endpoint | Step-by-step conversion funnel (Search → PDP → Cart → Checkout → Placed) | Frontend Team / DevOps |

> **Payment Access Invariant:** Do not assume merchant keys are read-only. Where granular read-only permissions cannot be restricted, request an owner-managed reporting feed rather than exposing payment-capable credentials to the dashboard.

---

## 2. Traffic, Infrastructure, Telemetry & Analytics

| UI Metric / Tile | System | How We Connect | Access / Credentials Required | Purpose / Used For | Source Owner |
|---|---|---|---|---|---|
| **Main Front Door Edge Traffic** | Azure Front Door | Azure Monitor Metrics API | Dedicated Managed Identity / Service Principal with Monitoring Reader | Total edge requests, HTTP response status families (2xx, 3xx, 4xx, 5xx), edge latency | Azure / DevOps |
| **Storefront CDN Assets** | Separate ECom CDN | Azure Monitor Metrics API | Managed Identity with Monitoring Reader scoped to CDN resource | Static asset request volumes, bandwidth, and edge hit/miss status | Azure / DevOps |
| **WAF & Security Blocked Requests** | Azure WAF / Log Analytics | Log Analytics Query API (`/v1/workspaces/.../query`) | Azure Identity with Log Analytics Reader on designated workspace | WAF rule triggers, suspicious client traffic, bot challenges, geo-IP detail | Security / DevOps |
| **Macula Routing Gateway** | Macula Application Gateway | Azure Monitor Metrics & Access Logs | Scoped metrics / access-log query permissions | Gateway traffic volume, response status groups, and routing health | Macula DevOps |
| **Production Pod & Ingress Logs** | Production Grafana (ECom) | Grafana API (`/api/datasources/proxy/...`) | Dedicated Service-Account token + Datasource UIDs (Loki / Prometheus) | HTTP error codes, ingress logs, CPU/Memory telemetry, HPA replica counts | Observability Team |
| **Test / Staging Telemetry** | Lower-Environment Grafana | Grafana API → Loki / Prometheus | Separate UAT Service-Account token + Datasource UIDs | Development and UAT environment verification and log validation | Observability Team |
| **OMS System Telemetry** | Macula Grafana | Grafana Datasource Query API | Dedicated Service-Account token + secure TLS endpoint | Macula batch processor, singlemicro, and integrations health | Macula DevOps |
| **Kubernetes Health & APM** | AKS Clusters | Prometheus / kube-state-metrics (via Grafana) | Scoped read-only Kubernetes identity (No cluster-admin) | Pod status, restarts, memory/CPU saturation, crash loops, node capacity | Platform / DevOps |
| **Saleor PostgreSQL Database** | Azure Database for PostgreSQL | Azure Monitor Metrics + read replica diagnostic views | Metrics Reader identity + restricted read-only database user | Database CPU, active connections, lock waits, transaction latency | DBA / Platform |
| **Distributed Tracing (APM)** | APM / Tracing Backend | OpenTelemetry collector / Trace query API | Trace query credentials; OTel SDK collector ingestion policy | End-to-end request latency waterfalls, cross-service bottle-neck tracing | Core Engineering |
| **Application Exceptions & Crashes** | Sentry | Sentry REST API (`/api/0/projects/.../issues/`) | Read-scoped integration token (`event:read`, `project:read`) | Production application exceptions, unhandled errors, stack traces | Frontend / Backend Lead |
| **UX Friction & Session Insights** | Microsoft Clarity *(Optional)* | Clarity Data Export API + Replay Links | Project API token + Project Viewer invite | Rage clicks, dead clicks, quick backs, excessive scrolling, UX friction | Analytics / UX Lead |
| **Visitor & Channel Acquisition** | Google Analytics 4 (GA4) *(Optional)* | Google Analytics Data API (`v1beta`) | Google Cloud Service Account JSON with `analytics.readonly` role | Sessions, traffic channels, new users, landing page trends | Digital Marketing / Analytics |

---

## 3. Microsoft Clarity UX Metrics Reference

When analyzing user experience friction or Clarity panels, map metrics to the following:

| Clarity Metric | Diagnostic Benefit for Dashboard |
|---|---|
| **Sessions & Pages per Session** | Detect macro shifts in browsing engagement and traffic volume drops. |
| **Device, Browser, OS, Country** | Isolate whether anomalies concentrate on mobile vs desktop, Safari/iOS, or a specific market. |
| **Rage Clicks & Dead Clicks** | Pinpoint broken UI buttons, unresponsive payment triggers, or non-interactive elements mistaken for links. |
| **Script Errors & Error Clicks** | Highlight client-side JavaScript crashes directly linked to checkout drop-offs. |
| **Quick Backs & Excessive Scrolling** | Flag confusing navigation, empty search results, or poor product listing usability. |
| **Scroll Depth & Engagement Time** | Verify whether shoppers actually reach checkout CTAs, size selectors, or payment info. |
| **Popular Pages & Referrers** | Identify top traffic acquisition landing pages requiring operational monitoring. |

---

## 4. Alerts, Storage & CI/CD Deployment

| Component | System | How We Connect | Access / Permissions Required | Purpose / Used For |
|---|---|---|---|---|
| **Incident Notifications** | Microsoft Teams | Incoming Webhook / Power Automate Workflow | Approved Workflow endpoint URL; designated channel | Automated operational breach, critical latency, and recovery alerts |
| **Email Escalations** | Email Service / M365 | Send-only SMTP relay or Microsoft Graph Mail API | Scoped send-only service credential; approved sender address | Executive daily digests, weekly health reports, and P1 escalation notices |
| **Reporting Store** | Dedicated Reporting DB | PostgreSQL (Dashboard-owned) | Read/Write application user; separate schema migration role | Aggregates, 35-day historical trend baselines, collector progress, alert states |
| **Credential Security** | Azure Key Vault | Azure Key Vault SDK / MSI | Scoped Key Vault Secrets User role | Storing connector secrets, tokens, and DB connection strings securely |
| **Source Control & CI** | Azure DevOps / Git | Git CLI / ADO Pipelines | Repository PR access; dedicated test pipeline permissions | Version governance, code reviews, automated CI unit test verification |
| **Container Images** | Azure Container Registry (ACR) | Docker / Helm / AKS pull secret | ACR push permission for CI; ACR pull permission for AKS | Building and distributing immutable versioned container images |
| **Isolated Test Hosting** | AKS Namespace & Ingress | Scoped Kubernetes deployment | Dedicated namespace, separate hostname, isolated storage PVC | Hosting test releases without modifying live production infrastructure |

---

## 5. Standard Handoff Protocol for Any Source

Whenever requesting a source connection from any system owner, collect these 6 fields:
1. **System & Environment**: System name, environment (`Production` vs `UAT`).
2. **Channel / Scope**: Brand (`Magrabi` / `DoctorM`), country (`AE`, `SA`, `EG`, `QA`, `KW`), and merchant/store identifiers.
3. **API / Endpoint URL**: Base URL and official API documentation link.
4. **Authentication**: Service-account token, API key, or Managed Identity reference (must be stored in `.secrets/`).
5. **Permissions**: Strict read-only scope (no write, update, delete, charge, or refund permissions).
6. **Rate Limits & Retention**: Request quotas, rate limits, and historical retention window (minimum 35 days for weekly baseline comparisons).
