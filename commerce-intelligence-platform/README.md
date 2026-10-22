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

All credentials are parameterized and completely optional at startup:
- If a connector's credentials are not yet entered, the dashboard displays a clear `PENDING .ENV` notice and uses deterministic sample baselines without crashing.
- As soon as valid credentials are added to `.env` and the server restarted, the live production adapter activates immediately.

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
| **Saleor Core** | `SALEOR_GRAPHQL_URL`, `SALEOR_USERNAME`, `SALEOR_PASSWORD` | Verified orders, daily totals, country breakdown, payment charge status, gross revenue by currency |
| **Macula OMS** | `MACULA_API_URL`, `MACULA_TOKEN` or `MACULA_USERNAME` and `MACULA_PASSWORD` | Verified OMS receipt count; payment attribution from a sample of at most 100 orders |
| **Payment Gateways** | `CHECKOUT_SECRET_KEY`, `TABBY_SECRET_KEY`, `TAMARA_API_TOKEN`, `PAYMOB_API_KEY` | Direct connector response status where implemented; success-rate charts are illustrative until verified gateway metrics are mapped |
| **Edge & Traffic** | `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` | Azure Monitor connection status; the existing traffic chart is illustrative until the metric response is mapped |
| **APM & Infra** | `ECOM_GRAFANA_TOKEN` or `ECOM_GRAFANA_USER` and `ECOM_GRAFANA_PASSWORD` | Grafana health status; the existing latency and infrastructure chart values are illustrative until metric queries are implemented |
| **Alert Notifications** | `TEAMS_WEBHOOK_URL`, `ALERT_EMAIL_RECIPIENTS`, `SMTP_*` | Automated rule evaluation with dispatch to Microsoft Teams channels and operations email lists |
| **Commerce Assist** | `GEMINI_API_KEY`, `GEMINI_MODEL`, `ASSISTANT_MAX_HISTORY` | Gemini 3.1 Flash-Lite answers grounded in approved platform telemetry; a built-in answer engine remains available without an API key |

---

## 3. Operational Trend Charts

The platform includes 8 purpose-built trend charts designed for operational clarity:

1. **Intraday 24-Hour Run-Rate** (*Overview*): Cumulative order trajectory comparing Today vs. Yesterday vs. 30-day baseline across hours 00:00 to 23:00.
2. **Saleor-to-OMS Sync Reconciliation Delta** (*Overview*): Real-time delta curve tracking handoff delays between Saleor order placement and Macula OMS fulfillment intake.
3. **Multi-Gateway 14-Day Success Rate Trend** (*Orders & Payments*): Comparative rolling success rate percentages across Checkout.com, Tabby, Tamara, and Paymob.
4. **Native Currency Revenue Trend** (*Orders & Payments*): Gross order value trends separated by currency (AED, SAR, EGP, QAR, KWD) with zero artificial FX mixing.
5. **End-to-End Funnel Conversion Trend** (*Customer Journey*): Daily conversion percentage tracking from Add-to-Cart to Confirmed Order.
6. **Edge Traffic Throughput & Error Spikes** (*Traffic & Errors*): Dual-axis line chart for Edge RPS throughput alongside HTTP 5xx error rates.
7. **API & Checkout Latency Percentiles** (*Infrastructure & APM*): Tri-curve latency tracking (p50 median, p95 degraded edge, p99 tail outliers).
8. **Live Connector Status & Key Audit Matrix** (*Data Sources*): Real-time audit of configured environment keys, connection status (`OK` or `PENDING .ENV`), and required parameters.

---

## 4. Safety Invariants

- **Read-Only Data Fetching**: Under NO circumstances does any code mutate, modify, update, reconfigure, or delete any resource, order, transaction, or setting on any external platform.
- **No Hardcoded Credential Fallbacks**: Current configuration loads credentials from the environment. Previously embedded Grafana password values should be rotated.
- **No Production Mutation**: Only read operations (`GET` or read-only `POST /search`) are executed.

---

## 5. Commerce Assist

The dashboard includes a responsive assistant that opens from a compact launcher. Clicking outside the panel or pressing Escape minimizes it. It supports follow-up questions, copy, contextual prompts, and multiple saved conversations with search, rename, and delete. History is stored in the current browser because the dashboard does not yet have user sign-in. The active filters apply by default; explicit country, brand, or common date phrases in a question update the answer scope. Approved read-only sources are queried on the server and cached for up to 30 seconds. Only verified summary fields are returned to the browser, model, or export.

Each answer includes an expandable “Sources used” panel with the connector name, exact data fields, status, and timestamp. The assistant distinguishes measured data from connector status and illustrative charts. It reports a metric as unavailable when the adapter has not mapped a verified value. It does not treat the difference between Saleor and OMS counts as a confirmed per-order sync failure. Questions outside the commerce platform are refused without querying connectors or the model.

Answers now lead with a concise response to the actual question. A multi-part order request can include the exact count, a previous-window comparison, and plain-language definitions in that order. Key figures follow the answer; the full metric/value/source table is collapsed under “View supporting data.” Country breakdowns appear only when requested. “Last month” is explicitly identified as the platform’s rolling 30-day window, not the prior calendar month. PDF, Excel, and Word reports carry the same focused answer and evidence; Excel has a filterable `Data table` sheet. Currency values retain their codes and are never combined across currencies.

Answers can be downloaded as styled PDF, Excel, or Word files with source evidence. Add `GEMINI_API_KEY` from Google AI Studio to the server environment to enable Gemini 3.1 Flash-Lite. The key is never sent to the browser, and no web-search tool is enabled. Without the key, the assistant uses the platform answer engine.

Natural wording such as “what is the todays sell,” “How are we doing today?”, or a misspelled Saudi sales question is treated as a sales request. Gemini proposes a structured intent, country, brand, and period; the server validates the proposal and gives explicit wording priority over model hints. A sales answer puts **Macula OMS received orders** first, then separately labels **Saleor placed orders and gross placed-order value**. Saleor value is not called OMS-received revenue. A question explicitly asking for Macula orders queries Macula only; if that feed is unavailable, the assistant does not substitute Saleor counts. When the user’s topic is genuinely ambiguous, the assistant asks a follow-up with selectable, scope-preserving questions before fetching data. The per-answer visual displays **Query scope** separately from **Dashboard filters** and the snapshot time. Gemini receives only verified evidence for answer wording, and unsupported numeric claims are rejected. If Gemini is unavailable, deterministic parsing and a labeled platform answer remain available. Questions outside the platform are blocked before connectors or Gemini are called.

The dashboard’s country performance table and daily order series are Saleor placed-order views, and are labeled accordingly. Macula OMS status and received counts are shown only when the Macula feed is verified. “Why do Saleor and Macula differ?” receives a stage-aware comparison when both feeds are live, or an explicit availability warning otherwise. A matching Saleor and Macula count cannot be assumed without order-ID reconciliation; live snapshots can also differ by refresh time.

