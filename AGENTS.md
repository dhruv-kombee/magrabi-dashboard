# Magrabi Deployment Portal — Operating Rules & Way of Working

This repository houses the **Magrabi Deployment Portal**. All coding agents (Antigravity, Codex, Claude Code, Cursor, and human contributors) follow these operating disciplines.

---

## 1. Source of Truth & Project Rules Architecture

Different tools auto-load different files. To avoid synchronization drift:
- **Canonical Source of Truth**: This file (`AGENTS.md`).
- **Claude Code**: Loaded via [CLAUDE.md](file:///c:/Users/Admin/OneDrive/Desktop/Magrabi_deployment_portal/CLAUDE.md) (points to this file).
- **Cursor**: Loaded via [.cursorrules](file:///c:/Users/Admin/OneDrive/Desktop/Magrabi_deployment_portal/.cursorrules) (points to this file).

Before answering any substantive question or writing implementation code:
1. Consult [ENVIRONMENT_RUNBOOK.md](file:///c:/Users/Admin/OneDrive/Desktop/Magrabi_deployment_portal/ENVIRONMENT_RUNBOOK.md) and [work_log/00_MASTER_CONTEXT.md](file:///c:/Users/Admin/OneDrive/Desktop/Magrabi_deployment_portal/work_log/00_MASTER_CONTEXT.md) first. Never ask a human to re-explain context already on disk.
2. Ensure `work_log/` and `.secrets/` are in `.gitignore` before writing into them.
3. Confirm in one line what you read and your understanding of the current state.

---

## 2. The Five Knowledge Stores

Every fact has a specific home determined by its **lifetime**:

| Store | Holds | Lifetime | Rule |
|---|---|---|---|
| [ENVIRONMENT_RUNBOOK.md](file:///c:/Users/Admin/OneDrive/Desktop/Magrabi_deployment_portal/ENVIRONMENT_RUNBOOK.md) | Living description of environments, wiring, routing, topology | Until system changes | Update in-place; section timestamps; no incident narratives |
| `work_log/YYYY-MM-DD_topic.md` | Incident logs, investigations, trial runs, conclusions | Permanent, append-only | Keep retracted theories with rationale; log continuously |
| [work_log/00_MASTER_CONTEXT.md](file:///c:/Users/Admin/OneDrive/Desktop/Magrabi_deployment_portal/work_log/00_MASTER_CONTEXT.md) | 2-minute briefing of project state, active priorities | Rewritten as reality changes | High-level summary of where the project is right now |
| `work_log/_agent_context/` | Session handovers and milestone checkpoints | Until next session handoff | Record local changes, deployed state, boundaries |
| `.secrets/` | Credentials, tokens, keys, fingerprints | Strictly gitignored | Never print, log, or commit secret values |
| `.claude/skills/` & `.agents/skills/` | Repeatable procedures & operational playbooks | Until procedure changes | Any procedure executed twice becomes a skill |

### Core Store Invariants
- **Runbook is not a diary**: Detailed logs go to `work_log/`. The runbook receives only durable facts.
- **Correct the runbook in place**: Never append contradictory blocks.
- **Record retracted theories with 'why'**: Documenting dead ends prevents recurring investigations.
- **Explicit confidence tagging**: Separate facts confirmed by live inspection or user statement from inferred hypotheses.
- **Date-stamp durable facts**: Use absolute dates (`YYYY-MM-DD`), never relative terms ("last week").

---

## 3. Verification Discipline

A knowledge store with confident incorrect statements is a liability. Adhere strictly to these rules:

1. **Verify before asking**: Exhaust read-only probes before escalating questions to a human. Include a control case.
2. **Re-fetch authoritative sources**: Never infer from cached listings or adjacent table columns; query the specific authoritative entity directly.
3. **Empty result is a gap, not health**: If a query returns 0 items, verify the query by forcing it to return expected data before trusting the zero.
4. **Null is not zero**: Missing fields mean unmeasured values; query the exact endpoint providing the metric.
5. **Measure after settling**: Asynchronous processes (pipelines, container pull, rollout status, DNS/CDN caching) take time to settle. Never declare success or failure prematurely.
6. **Label measured vs. inferred**: Clearly distinguish between verified telemetry/logs and unproven assumptions.
7. **Root causes require proof**: Never state a root cause until conclusively proven with evidence.
8. **Investigate to exact file and line**: Never stop at "somewhere in the component".
9. **Prove negatives rigorously**: Grep the exact git ref/branch; do not assume absent search results prove absence.
10. **Map dependencies bidirectionally**: Inspect both callers and callees before editing shared configurations.
11. **Adversarial self-verification**: Verify changes before reporting completion; verify the running workload, not merely a passing pipeline step.

---

## 4. Secrets Discipline

1. All credentials and sensitive tokens live in `.secrets/`, which is gitignored.
2. **Zero plaintext printing**: Never print, echo, or log a secret value in terminal outputs, files, or chat.
3. **Compare by hash**: Compare values via SHA-256 prefixes (`sha256(value)[:16]`).
4. **Fingerprint configurations**: Save pre/post operation fingerprints in `.secrets/_fingerprints.json` to prove configuration integrity.
5. **Error redaction**: Scripts handling secret data must catch exceptions and redact error messages to prevent credential leaks in stack traces.
6. **Format escaping & parsing**:
   - Use structured parsers (JSON, YAML), never raw regex or `sed`.
   - Mind variable escaping across `.env`, docker-compose, and Kubernetes manifests (e.g., `$$` vs `$`).
7. **Immediate disclosure**: If a secret is inadvertently exposed in logs or transcript, flag it immediately for revocation and rotation.

---

## 5. Durability of Changes

1. Any configuration or application change must be stored in the repository (manifests, environment values, infrastructure as code, code repositories).
2. Direct patches, ad-hoc console edits, or manual server modifications are **only diagnostic proofs**. The durable version must be committed in the same session.
3. Parameterize all configurations across environments using environment values files (`dev`, `staging`, `prod`).

---

## 6. Permission Boundaries (Magrabi Deployment Portal)

| Tier | Scope | Permissions |
|---|---|---|
| **Tier 1: Pre-Authorized** | Local workspace (`Magrabi_deployment_portal`), local unit tests, documentation, `work_log/` updates, local commits, skill definitions | Execute autonomously; report outcome. |
| **Tier 2: State Command First** | Shared Dev / Staging / Test environments, deployment sandbox pipelines | Read operations are free. Mutating operations (deploy, rebuild, restart, delete) require stating the exact command before running. |
| **Tier 3: Explicit Confirmation Required** | Remote repository push (`git push`), Production (`prod`) infrastructure, live database migrations, production traffic routing | Read-only inspection allowed. Any mutation, deployment, remote push, container exec, or secret rotation strictly requires explicit human confirmation. |
| **Tier 4: Prohibited Actions** | Production as a test dependency, bypassing branch protections or PR review gates, committing secrets, pushing code without explicit user instruction | Never permitted. |

---

## 7. Reporting & Handoff Standard

When completing a task, configuration change, or deployment:
1. **Exact Change Specification**: Provide object, file, PR/commit hash, environment, and line numbers.
2. **Manual Replication**: Provide the exact UI click-path or terminal command for a human operator to repeat.
3. **Format**: Plain language, no jargon, no emojis (use `OK`, `FAIL`, `PENDING`). Use absolute file paths with clickable links.
4. **Session Handover**: Checkpoint state into `work_log/_agent_context/` before handoffs or context compaction.
