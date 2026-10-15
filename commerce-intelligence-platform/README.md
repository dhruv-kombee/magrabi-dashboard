# MAGRABi · Commerce Intelligence Platform

A dedicated, standalone real-time commerce intelligence and monitoring dashboard built with React 19, TypeScript, and Vite.

This project is **completely independent** from `magrabi-deploy-portal`. It runs on its own dedicated Vite dev server on port `5174` and has zero coupling with the Azure DevOps release orchestrator or backend.

---

## Quick Start

### 1. Prerequisites
- **Node.js**: v18+ (v20+ recommended)
- **npm**: v9+

### 2. Installation
Navigate to this directory and install dependencies:
```powershell
cd commerce-intelligence-platform
npm install
```

### 3. Run Development Server
Start the dedicated development server on port **5174**:
```powershell
npm run dev
```

Open your browser at:
```
http://localhost:5174
```

### 4. Build for Production
To create an optimized production build:
```powershell
npm run build
```

To preview the production build locally:
```powershell
npm run preview
```

---

## Monitoring Modules Included

| Section | Focus Areas | Key Metrics |
|---|---|---|
| **Overview** | Executive summary, real-time KPI tiles | Orders, revenue, conversion rate, payment success rate |
| **Orders & Payments** | Transaction monitoring & gateways | Success vs. Failed vs. Pending, Cash/Card split, gateway breakdown |
| **Customer Journey** | Step-by-step funnel visualization | Drop-off rates across Search, PDP, Cart, Checkout, Confirmation |
| **Traffic & Errors** | Traffic layers & application errors | Front Door, CDN, Ingress, Macula routing; GraphQL & timeout errors |
| **Infrastructure & APM** | Service health & telemetry | Kubernetes pod status, memory/CPU utilization, latency (p50/p95/p99) |
| **Data Sources** | Live dependency health check | Integration uptime, endpoint status, latency tracking |
| **Alerts & Rules** | Active operational alerts | Severity tags (P1/P2/P3), triggered rules, incident details |

---

## Architecture & Features

- **Framework**: React 19 + TypeScript + Vite 8
- **Styling**: Modular CSS (`CommerceDashboard.module.css`) with curated, ergonomic dark/light contrast tokens and responsive grid layout.
- **Visualizations**: Lightweight native SVG area charts, step charts, and donut progress metrics (no bloated third-party charting libraries).
- **Interactivity**: Timezone selector (Dubai GST, UTC, IST), Brand filter (All, Magrabi, Doctor M), Country filter (AE, SA, EG, QA, KW), interactive drill-down inspector drawer, and 1-click CSV data export.
- **Safety**: Pure client-side telemetry and monitoring visualization; completely isolated from production live mutation paths.
