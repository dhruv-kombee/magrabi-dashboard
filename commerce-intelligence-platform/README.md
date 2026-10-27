# MAGRABi · Commerce Intelligence Platform

A dedicated, standalone real-time commerce intelligence and monitoring platform built with React 19, TypeScript, Vite, and a high-performance native Node.js read-only backend.

---

## 1. Quick Start

### Prerequisites
- **Node.js**: v18+ (tested on Node v20/v24)
- **npm**: v9+

### Environment Configuration
Copy the provided `.env.example` to `.env` and fill in credentials for your live services:
```powershell
cd commerce-intelligence-platform
cp .env.example .env
```

Connector credentials are parameterized and optional. Missing connector credentials produce `NOT_CONFIGURED`; non-empty credentials produce only `CONFIGURED_BUT_NOT_VERIFIED` until a read-only source request succeeds and required fields are validated. Dashboard authentication is required: without the username, password hash, and session-signing secret, every commerce API responds with `503` and no dashboard data is exposed. Synthetic fixtures remain in explicitly labelled demo panels and are never substituted into live connector responses.

The dashboard opens with all brands and business countries for the current Dubai reporting day. The filter/date controls and dashboard Excel/CSV export buttons are hidden only on the User management page; they remain available on other dashboard pages. Assistant question scope and assistant report downloads remain available.

### Configure Dashboard Login

Run the interactive setup once from a real terminal:

```powershell
npm run auth:configure
```

The command asks for the initial admin username and a password of at least 12 characters. Password input is hidden; only a scrypt hash is stored in the workspace's gitignored `.secrets/dashboard-auth.env`. After signing in, the admin can create, reset, and remove dashboard-managed viewer accounts from **User management**, and assign each managed viewer access to any combination of dashboard sections. New viewers start with every section selected; existing accounts without saved permissions retain their previous section access. Deployment-environment accounts remain protected and cannot be changed here. Permissions are enforced by the API as well as the navigation. **User management** remains admin-only, and Commerce Assistant is available to viewers only when every dashboard section is assigned. The default inactive-session timeout is 10 minutes; selecting **Remember me** keeps the signed session active for 30 days by default. Set `AUTH_REMEMBER_ME_DAYS` to configure the remembered-session timeout (1–365 days). Restart the app after changing credentials.

The sign-in page includes an accessible **Show/Hide password** control. It only changes how the entered value is displayed in the browser; it does not change how the server hashes or verifies the password.

For containers or hosted environments, provide `AUTH_ADMIN_USERNAME`, `AUTH_ADMIN_PASSWORD_HASH`, `AUTH_VIEWER_USERNAME`, `AUTH_VIEWER_PASSWORD_HASH`, `AUTH_SESSION_SECRET` (at least 32 characters), and `AUTH_SESSION_TIMEOUT_MINUTES=10` through the platform's secret-management mechanism. Legacy `AUTH_USERNAME` and `AUTH_PASSWORD_HASH` remain accepted as the admin account during migration. Never bake these values into the image or repository.

To generate those deployment variables without printing passwords, hashes, or the signing secret, run:

```powershell
npm run auth:configure:deployment
```

The command securely prompts only for the bootstrap administrator and writes `.secrets/dashboard-auth-deployment.env`. Import that file using the deployment platform's protected secret/environment-variable interface, then restart or redeploy the application. The administrator can create viewer accounts from the dashboard afterward. Do not commit, display, paste into chat, or store the generated file outside an approved secret store.

Dashboard-managed viewer accounts are stored as scrypt hashes in `AUTH_MANAGED_USERS_FILE`. The default local path is the gitignored workspace `.secrets/dashboard-users.json`. On Render, the default path is `/var/data/dashboard-users.json`; attach a persistent disk to the web service with mount path `/var/data` so viewer accounts can be created and survive restarts and releases. If you mount the disk elsewhere, set `AUTH_MANAGED_USERS_FILE` to a file under that mount. Render disks are available to only one service instance, so keep the service at one instance while using this file store.

### Run in Development
```powershell
npm run dev
```
Open [http://localhost:5174](http://localhost:5174). Both Vite frontend and live backend API routes (`/api/commerce/*`) are active.

### Run in Production
Build the static bundle and launch the standalone production server:
```powershell
npm run build
npm start
```
The production server runs on port `5174` (or whatever `PORT` is defined in `.env`), serving the compiled single-page application and all read-only API connectors.

### Run via Docker
```powershell
docker build -t magrabi-commerce-platform .
docker run -p 5174:5174 --env-file .env magrabi-commerce-platform
```

---

## 2. Parameterized Connectors (`.env`)

| Category | Environment Variables | Read-Only Live Capability |
|---|---|---|
| **Dashboard Login** | `AUTH_ADMIN_USERNAME`, `AUTH_ADMIN_PASSWORD_HASH`, `AUTH_VIEWER_USERNAME`, `AUTH_VIEWER_PASSWORD_HASH`, `AUTH_SESSION_SECRET`, `AUTH_SESSION_TIMEOUT_MINUTES` | Server-enforced admin/viewer roles, signed HTTP-only session cookie, failed-login throttling, and 10-minute inactivity expiry |
| **Saleor Core** | `SALEOR_GRAPHQL_URL`, `SALEOR_USERNAME`, `SALEOR_PASSWORD` | Diagnostic-only placed-order data for explicit reconciliation checks |
| **Macula OMS** | `MACULA_API_URL`, `MACULA_TOKEN` or `MACULA_USERNAME` and `MACULA_PASSWORD` | Verified OMS receipt count; payment attribution from a sample of at most 100 orders |
| **Payment Gateways** | Provider credential plus an approved read-only `*_REPORT_PATH` where no stable default exists | Authentication and response-shape verification; success metrics remain unavailable until provider fields are mapped |
| **Edge & Traffic** | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | Service-principal authentication and validated Azure Monitor request/latency datapoints |
| **APM & Infra** | Grafana credentials, `PROMETHEUS_DATASOURCE_UID`, and approved `GRAFANA_*_QUERY` values | Grafana health is separated from validated Prometheus metric queries |
| **GA4 & Clarity** | `GA4_SERVICE_ACCOUNT_JSON`, `GA4_PROPERTIES`, `CLARITY_PROJECTS` | Separate read-only GA4 commerce-event counts and cached Clarity aggregate UX signals |
| **Alert Notifications** | `TEAMS_WEBHOOK_URL`, `ALERT_EMAIL_RECIPIENTS`, `SMTP_*` | Rule simulation only; delivery stays disabled unless a future operator explicitly enables `ALERT_DELIVERY_ENABLED` |
| **Commerce Assist** | `GEMINI_API_KEY`, `GEMINI_MODEL`, `ASSISTANT_MAX_HISTORY` | Gemini 3.1 Flash-Lite answers grounded in approved platform telemetry; a built-in answer engine remains available without an API key |

---

## 3. Operational Trend Charts

The platform includes 8 purpose-built trend charts designed for operational clarity:

1. **Intraday 24-Hour Run-Rate** (*Overview*): Cumulative order trajectory comparing Today vs. Yesterday vs. 30-day baseline across hours 00:00 to 23:00.
2. **Macula OMS received-order trend** (*Overview*): Daily received-order totals from the OMS. Saleor comparison charts are not mounted in the primary dashboard.
3. **Multi-Gateway 14-Day Success Rate Trend** (*Orders & Payments*): Comparative rolling success rate percentages across Checkout.com, Tabby, Tamara, and Paymob.
4. **Native Currency Revenue Trend** (*Orders & Payments*): Gross order value trends separated by currency (AED, SAR, EGP, QAR, KWD) with zero artificial FX mixing.
5. **End-to-End Funnel Conversion Trend** (*Customer Journey*): Daily conversion percentage tracking from Add-to-Cart to Confirmed Order.
6. **Edge Traffic Throughput & Error Spikes** (*Traffic & Errors*): Dual-axis line chart for Edge RPS throughput alongside HTTP 5xx error rates.
7. **API & Checkout Latency Percentiles** (*Infrastructure & APM*): Tri-curve latency tracking (p50 median, p95 degraded edge, p99 tail outliers).
8. **Live Connector Status & Key Audit Matrix** (*Data Sources*): Real-time audit of configured environment keys, connection status (`OK` or `PENDING .ENV`), and required parameters.

### GA4 and Clarity read-only setup

The Customer journey section shows each configured GA4 property separately and reports standard commerce-event counts for the selected date range. These are event counts, not deduplicated journey IDs, conversion rates, or confirmed orders. While this section is open, the browser checks for updated analytics every five minutes. GA4 results are cached for five minutes. The Clarity panel shows project-level aggregate UX metrics for the previous three days in UTC, cached for 24 hours to respect its API quota. Neither source feeds the technical Traffic & errors metrics or replaces the OMS order ledger.

1. In Google Cloud, enable the Google Analytics Data API and create a service account for the dashboard. Grant that service account the **Viewer** role on each intended GA4 property (read-only). Do not provide a Google account password.
2. Provide the service account JSON privately to the server through the gitignored `.env` file or the deployment secret manager as `GA4_SERVICE_ACCOUNT_JSON`. Add up to two property IDs, distinct labels, and each property's reporting timezone in `GA4_PROPERTIES`, for example:
   `[{ "id": "000000000", "label": "Magrabi Store", "timezone": "Asia/Dubai" }, { "id": "000000001", "label": "DoctorM Store", "timezone": "Asia/Riyadh" }]`
3. A Clarity project admin can issue a project-scoped Data Export API token. Store each token only in server-side `CLARITY_PROJECTS`, with a non-secret display label, for example:
   `[{ "label": "Magrabi Store", "token": "set-locally" }, { "label": "DoctorM Store", "token": "set-locally" }]`
4. Restart the backend after setting credentials. The dashboard reports configuration separately from live verification; a source is marked live only after its API response and expected fields validate.

Clarity's official export is limited to the previous 1–3 days, 1,000 rows, and 10 requests per project per day. This integration requests aggregate data for the previous three days and caches it in each server process for 24 hours by default; a multi-replica deployment needs a shared cache to coordinate the per-project quota. GA4 reports use the configured property's reporting timezone, report calendar days rather than partial hours, and may have reporting delays. Missing event rows are shown as “Not returned”; the dashboard does not invent zeros. Tokens and service-account credentials must never be pasted into chat, committed, exposed to the browser, or placed in `VITE_*` variables.

---

## 4. Safety Invariants

- **Read-Only Data Fetching**: Under NO circumstances does any code mutate, modify, update, reconfigure, or delete any resource, order, transaction, or setting on any external platform.
- **No Hardcoded Credential Fallbacks**: Current configuration loads credentials from the environment. Previously embedded Grafana password values should be rotated.
- **No Production Mutation**: Source operations are limited to `GET`, GraphQL queries/token creation, authentication-token creation, and Macula's read-only `POST /search` contract.
- **No false health**: Configuration, authentication, source health, metric availability, and freshness are reported separately.

---

## 5. Commerce Assist

The dashboard includes a responsive assistant that opens from a compact launcher. Clicking outside the panel or pressing Escape minimizes it. It supports follow-up questions, copy, contextual prompts, and multiple saved conversations with search, rename, and delete. History is stored in the authenticated user's current browser and is not synchronized between users. The active filters apply by default; explicit country, brand, or common date phrases in a question update the answer scope. Approved read-only sources are queried on the server and cached for up to 30 seconds. Only verified summary fields are returned to the browser, model, or export.

Each answer includes an expandable “Sources used” panel with the connector name, exact data fields, status, and timestamp. The assistant distinguishes measured data from connector status and illustrative charts. It reports a metric as unavailable when the adapter has not mapped a verified value. It does not treat the difference between Saleor and OMS counts as a confirmed per-order sync failure. Questions outside the commerce platform are refused without querying connectors or the model.

Answers now lead with a concise response to the actual question. A multi-part order request can include the exact count, a previous-window comparison, and plain-language definitions in that order. Key figures follow the answer; the full metric/value/source table is collapsed under “View supporting data.” Country breakdowns appear only when requested. “Last month” is explicitly identified as the platform’s rolling 30-day window, not the prior calendar month. PDF, Excel, and Word reports carry the same focused answer and evidence; Excel has a filterable `Data table` sheet. Currency values retain their codes and are never combined across currencies.

Answers can be downloaded as styled PDF, Excel, or Word files with source evidence. Add `GEMINI_API_KEY` from Google AI Studio to the server environment to enable Gemini 3.1 Flash-Lite. The key is never sent to the browser, and no web-search tool is enabled. Without the key, the assistant uses the platform answer engine.

Natural wording such as “what is the todays sell,” “How are we doing today?”, or a misspelled Saudi sales question is treated as a sales request. Gemini proposes a structured intent, country, brand, and period; the server validates the proposal and gives explicit wording priority over model hints. Sales and order answers use **Macula OMS received orders** only. Saleor is queried only for an explicit reconciliation or source-status question, and is never substituted when Macula is unavailable. When the user’s topic is genuinely ambiguous, the assistant asks a follow-up with selectable, scope-preserving questions before fetching data. The per-answer visual displays **Query scope** separately from **Dashboard filters** and the snapshot time. Gemini receives only verified evidence for answer wording, and unsupported numeric claims are rejected. If Gemini is unavailable, deterministic parsing and a labeled platform answer remain available. Questions outside the platform are blocked before connectors or Gemini are called.

The dashboard’s headline count, country performance table, and daily order series are Macula OMS received-order views. Saleor remains diagnostic-only. “Why do Saleor and Macula differ?” receives a stage-aware comparison when both feeds are live, or an explicit availability warning otherwise. A matching Saleor and Macula count cannot be assumed without order-ID reconciliation and aligned snapshot times.
