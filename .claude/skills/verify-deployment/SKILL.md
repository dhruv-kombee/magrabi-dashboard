---
name: verify-deployment
description: Repeatable procedure for verifying deployments on Magrabi Deployment Portal, enforcing settling delays, workload inspection, and verification discipline.
---

# Verify Deployment Procedure

Execute this repeatable procedure to verify any deployment to Dev, Staging, or Production environments.

## 1. Principles
- **A green pipeline is not a verified deployment**: CI/CD jobs passing only proves the pipeline ran. You must verify the running workload.
- **Wait for Settling**: Schedulers, container pulls, health check probes, rolling updates, and caches take time to settle. Never probe immediately after pipeline completion. Minimum settling window: **30 seconds**.

---

## 2. Step-by-Step Verification Protocol

### Step 1: Record Pre-Verification Baseline
1. Record target environment, commit SHA, and expected container image tag.
2. Note expected artifact version (ensure it is pinned to an immutable SHA/version, never `latest`).

### Step 2: Settle Delay
- Wait at least 30 seconds after pipeline completion or container restart before taking authoritative measurements.

### Step 3: Authoritative Single-Shot Probes
1. **Container / Workload Status**:
   - Verify pod/container status is running and ready.
   - Verify image tag matches the target commit, not a previously cached version.
2. **HTTP Health & Readiness Endpoint**:
   - Query `/healthz`, `/ready`, or equivalent health probe directly.
   - Confirm HTTP status code `200 OK` and inspect response body payload (version, uptime, database connectivity).
3. **Control Comparison**:
   - Compare response with a known-good control probe.
   - Verify non-empty and non-null metric values.

### Step 4: Configuration Fingerprint Verification
- Compare configuration SHA-256 hash before and after deployment against `.secrets/_fingerprints.json`.

---

## 3. Deployment Traps to Avoid
- **Line Ending Drift**: Always strip `\r` before comparing list diffs between Windows and Linux containers.
- **Buffered Log Timestamps**: Clustered microsecond log timestamps indicate buffered I/O, not simultaneous execution.
- **Stale Container Pulls**: Verify that image pull policies force fresh pulls if tags are reused (or better: always enforce unique immutable tags).
- **Silent Deploy Skips**: Verify deploy flags were true in configuration and workload actually updated.
