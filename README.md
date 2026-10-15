# Magrabi Dashboard & Commerce Intelligence Workspace

This repository houses two independent, decoupled projects:

```
Magrabi_deployment_portal/
├── commerce-intelligence-platform/    # Standalone Commerce Intelligence & Monitoring Web App
│   ├── src/                           # Native React 19 + TypeScript + SVG monitoring modules
│   ├── package.json                   # Independent dependencies (Vite dev port: 5174)
│   └── README.md                      # Dedicated documentation & quick start
│
├── magrabi-deploy-portal/             # Azure DevOps Deployment & Release Governance Portal
│   ├── backend/                       # Python Flask API & deployment orchestrator (port: 5151)
│   ├── frontend/                      # React 19 deployment portal SPA (port: 5173)
│   ├── Dockerfile                     # Multi-stage container build
│   └── k8s/                           # AKS deployment manifests & keyvault mappings
│
├── ENVIRONMENT_RUNBOOK.md             # Authoritative infrastructure & environment specifications
├── AGENTS.md                          # Operating disciplines, safety tiers & secret rules
└── work_log/                          # Append-only chronological investigation & task logs
```

---

## 1. How to Run the Projects

### Project A: Commerce Intelligence Platform (Standalone)
A dedicated, real-time commerce intelligence and monitoring dashboard covering transactions, funnel drop-offs, application errors, and infrastructure health.

```powershell
# 1. Navigate to the commerce project
cd commerce-intelligence-platform

# 2. Install dependencies (if not already installed)
npm install

# 3. Start the standalone dev server
npm run dev
```
- **Local URL**: `http://localhost:5174`
- **Features**: Real-time KPI tiles, Orders & Payments funnel, Customer Journey drop-offs, Traffic & Errors breakdown, APM & Pod health, Data Sources status, Alerts & Rules, Drawer Inspector, CSV Export.

---

### Project B: Magrabi Deployment Portal
The original deployment governance orchestrator for managing and inspecting Azure DevOps pipeline releases.

#### Step 1: Start the Backend (Port 5151)
In a PowerShell terminal:
```powershell
cd magrabi-deploy-portal
$env:ADO_ORG = "mock-org"
$env:ADO_PAT = "mock-pat"
py -3 -m flask --app backend/app.py run --port 5151
```

#### Step 2: Start the Frontend (Port 5173)
In a second terminal:
```powershell
cd magrabi-deploy-portal/frontend
npm run dev
```
- **Local URL**: `http://localhost:5173`
- **Default Local Credentials**:
  - `admin` / `admin` (Administrator)
  - `viewer` / `admin` (Viewer)

---

## Safety & Data Boundary
- **Zero Live Mutations**: Neither application modifies production databases or live operational systems when running locally.
- **Secrets Policy**: Secrets live strictly in `.secrets/` (gitignored). No tokens or credentials are committed to Git.
