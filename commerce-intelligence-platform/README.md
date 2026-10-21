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
| **Saleor Core** | `SALEOR_ENDPOINT`, `SALEOR_APP_TOKEN` (or `SALEOR_USERNAME`, `SALEOR_PASSWORD`) | Orders, daily order trends, 24-hour intraday run-rate, country breakdown, payment charge status, gross revenue by currency |
| **Macula OMS** | `MACULA_API_URL`, `MACULA_API_KEY` (or `MACULA_USERNAME`, `MACULA_PASSWORD`) | Received OMS orders, sync delay reconciliation delta, payment gateway attribution, Apple Pay / KNET method mix |
| **Payment Gateways** | `CHECKOUT_SECRET_KEY`, `TABBY_SECRET_KEY`, `TAMARA_API_TOKEN`, `PAYMOB_API_KEY` | 14-day rolling gateway success rates, transaction attempt volume, failure classifications |
| **Edge & Traffic** | `AZURE_FRONT_DOOR_ENDPOINT`, `AZURE_FRONT_DOOR_API_KEY` | Real-time RPS throughput, HTTP status code distribution (2xx, 3xx, 4xx, 5xx), edge latency |
| **APM & Infra** | `GRAFANA_URL`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`, `PROMETHEUS_URL` | p50 / p95 / p99 API and checkout latency curves, database connections, pod CPU/memory utilization |
| **Alert Notifications** | `TEAMS_WEBHOOK_URL`, `ALERT_EMAIL_RECIPIENTS`, `SMTP_*` | Automated rule evaluation with dispatch to Microsoft Teams channels and operations email lists |

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
- **Zero Hardcoded Credentials**: No secrets or API tokens exist in code or git history; all configuration is loaded strictly via environment variables.
- **No Production Mutation**: Only read operations (`GET` or read-only `POST /search`) are executed.

