# Traffic Counts

Local implementation added 14 October 2026. **Not deployed.** The target is
`/insights?section=traffic` in the existing portal, next to the unchanged checkout funnel.

## Use

Choose From/To and IST or UTC, select sources, then Run report. The end is exclusive.
Quick choices include the last hour, 24 hours, or five completed calendar days. Maximum range
is seven days per run within the last 93 days; log retention may be shorter. Whole-minute
timestamps are required, not silently rounded. Recent data can arrive late.

Source tabs show a window summary, daily counts and expandable individual response codes.
CSV export is Excel-compatible and includes scope, source, timezone, coverage and notes. It
does not combine sources into one total. Optional live mode reads a rolling hour every five
minutes while the tab is visible. Default is off. HTTP success is not order/payment success.

## Sources and interpretation

| Source | Read mechanism | Scope / limitations |
|---|---|---|
| Main Front Door | Azure Monitor RequestCount, Total, status + endpoint dimensions | Shared profile includes prod/beta/API/assets. Not brand-only or human-only. |
| Separate ECom CDN | Azure Monitor RequestCount | Independent edge profile. Do not add it to ingress or other edge counts. |
| ECom ingress | Server-side Loki counts of final status parsed from access lines | Recorded logs, including internal/probes/beta; not proof of lossless ingestion. Upstream retries do not become final 5xx counts. |
| Macula gateway | Azure Monitor ResponseStatus | Groups only. 2xx is not exact 200. Group remainder remains unclassified. TotalRequests is a different counter and is not substituted. |
| Filtered storefront | Allowlisted production ingress backends + UA/path classes | Retained browser-like + unknown. Declared probes/telemetry/scripts/crawlers excluded heuristically. Not verified customers. |

`backend/traffic_counts/catalog.py` contains the explicit source URLs and backend-to-brand map.
The filtered view includes Magrabi, DoctorM, Rivoli and separately labelled retail sites. Known
Edge Health Probe, Azure health probe and Saleor client signatures are included. `/monitoring`
can be genuine browser telemetry: its exclusion does not establish that customer errors vanished.

## Backend and dedicated script

- `backend/traffic_counts/providers.py`: bounded, fixed-origin HTTPS reads. No raw log retrieval.
- `backend/traffic_counts/service.py`: date validation, daily aggregation, asynchronous single-flight
  collection and sanitized on-disk cache. No work starts at import or from a timer.
- `backend/traffic_counts/routes.py`: authenticated admin/viewer routes, same-origin report creation.
- `backend/traffic_counts_cli.py`: standalone reusable collector; does not import `app.py`.
- `frontend/src/trafficCounts/`: UI, validation, polling and rendering.

Example from the portal folder, with credentials already supplied securely as environment variables:

```powershell
python -P backend/traffic_counts_cli.py --start 2026-10-09T00:00:00+05:30 --end 2026-10-14T00:00:00+05:30 --timezone Asia/Kolkata --output traffic-09-13-oct.csv
```

Use repeated `--source` for a subset: `frontdoor_main`, `ecom_cdn`, `ecom_ingress`,
`macula_gateway`, `filtered_storefront`. JSON output is also supported. Existing output files
are never overwritten. Exit 0 means all selected sources complete; 2 means partial/unavailable.
Local output contains aggregate counts only. Do not commit the cache or operational reports.

## Server configuration

Never put credentials in the browser, image or source files.

| Setting | Purpose |
|---|---|
| TRAFFIC_REPORTS_DIR | Persistent directory. Defaults beside RUNS_DIR, therefore `/data/traffic_reports` in the deployed portal. |
| TRAFFIC_GRAFANA_URL | Exactly `https://ecom-grafana.test-magrabi.com` |
| TRAFFIC_GRAFANA_TOKEN | Dedicated read-only service-account token preferred |
| TRAFFIC_GRAFANA_USERNAME / TRAFFIC_GRAFANA_PASSWORD | Optional server-side Basic authentication alternative |
| AZURE_MONITOR_TENANT_ID / AZURE_MONITOR_CLIENT_ID / AZURE_MONITOR_CLIENT_SECRET | Explicit Azure metrics-reader identity; SDK caches tokens |
| Standard Azure workload-identity environment | Supported alternative; not automatically provisioned or granted roles |

The Azure reader needs metrics read access on the three catalogued resources only. Grafana
needs permission to query the existing Loki datasource. Neither provider creates identities,
changes roles, changes logging, or writes to Azure/Grafana. Configured means settings present,
not permissions verified. Missing access is displayed as unavailable, never as zero.

Fresh read-only deployment preflight on 14 October: live portal image `:93`, one ready replica,
no custom serviceAccountName, and envFrom only `deploy-portal-ado`, `deploy-portal-auth`,
`deploy-portal-insights`. No traffic or Azure-monitor credential Secret is currently wired.
The existing `id-deploy-portal-keyvault` has Key Vault roles, not metrics-reader roles.
Do not silently enable unrelated pending Key Rotation functionality to wire this feature.

## Bounds and freshness

- Existing supported topology: one portal replica, one Gunicorn worker. One report at a time;
  duplicate requests share work, other ranges receive Busy. Do not scale this feature's collector
  horizontally without a distributed job lock.
- Disjoint chunks no longer than one hour, also split at reporting midnight; maximum runtime
  one hour. Loki instant queries use an explicit evaluation timestamp and server-side counts.
- Fixed response origins, TLS verification, no redirects, timeouts, limited retries, 4MiB
  response cap, 10,000-series ceiling. Overflow/incomplete data is not silently accepted.
- Two report objects in memory, 20 report files and up to 2,000 cached chunks retained. Aggregate
  report cap 2MB and 500 rows per table. Overlarge reports fail explicitly and require narrowing.
- Recent chunks cached for five minutes; older chunks for one hour; failures 30 seconds. Filter
  version is part of the key. Auth/transport failures stop a source after three failing chunks.
  Missing old logs do not stop subsequent retained chunks.
- Interrupted jobs are marked failed after restart and never auto-resume. Re-run explicitly to
  reuse eligible successful chunks. The page stops its polling when unmounted.
- Successful query coverage is not a guarantee that logging captured every request. Missing
  values remain null/dashes and partial observations are labelled. All-source totals are forbidden.

## Verification and release boundary

Unit tests use synthetic injected providers and an isolated Flask host. **Do not import `app.py`
for testing:** unrelated portal deployment/approval background workers start on import.

```powershell
python -P -m unittest discover -s backend/traffic_counts/tests -p "test_*.py" -v
node --test frontend/tests/trafficCounts.test.mjs
```

Root verified five live sources read-only for 13 October 12:00–12:10 UTC with TLS verification:
Front Door 50,697; separate CDN 112; ECom ingress 32,241; Macula 1,000; retained storefront 4,250.
These are overlapping layers, not a combined total. Smoke testing used local authenticated access,
not credentials in the deployed portal. Source-permission and memory checks must be repeated
after configuration/deployment; offline tests cannot establish the live 256Mi memory margin.

The frontend production build and local headless-browser preview use saved sanitized counts and
intercepted APIs. They are not proof that the hosted portal has been deployed.

Before any release, follow the project portal-release procedure: verify live source/bundle against
the local tree, isolate unrelated unreleased edits, back up current state, choose an unused image
tag and agree exact deployment/configuration commands. Current standing instructions require
explicit command approval, including `kubectl exec` used for read-only file hashes. No image build,
remote credential/RBAC configuration, rollout or monitoring-container release has been performed.
