# Claude Code Instructions — Magrabi Deployment Portal

The single source of truth for rules, verification disciplines, and permissions is:
[AGENTS.md](file:///c:/Users/Admin/OneDrive/Desktop/Magrabi_deployment_portal/AGENTS.md)

## Quick Reference
1. **First Action Every Session**:
   - Read [ENVIRONMENT_RUNBOOK.md](file:///c:/Users/Admin/OneDrive/Desktop/Magrabi_deployment_portal/ENVIRONMENT_RUNBOOK.md)
   - Read [work_log/00_MASTER_CONTEXT.md](file:///c:/Users/Admin/OneDrive/Desktop/Magrabi_deployment_portal/work_log/00_MASTER_CONTEXT.md)
   - Confirm current state in one line.
2. **Git Discipline**:
   - `work_log/` and `.secrets/` must remain in `.gitignore`. Never commit them.
3. **Verification**:
   - Measure settled state, never premature status.
   - Separate measured facts from inferences.
4. **Permissions**:
   - Local: Pre-authorized.
   - Non-prod / Staging: State mutating commands first.
   - Production: Read-only by default; explicit confirmation required for mutating commands.
   - Secrets: Never print secret values or echo exception details.
5. **Zero External Mutations (Absolute Invariant)**:
   - Strictly READ-ONLY data fetching and feeding the dashboard.
   - NEVER modify, reconfigure, delete, capture, or refund on ANY external platform (Saleor, Macula OMS, Checkout.com, Paymob, Tabby, Tamara, Azure, AKS, Grafana, Sentry, GA4, Clarity).
