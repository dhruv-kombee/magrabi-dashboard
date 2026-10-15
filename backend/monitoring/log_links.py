"""Pure, credential-free portal Grafana links for a previously scoped trace summary.

No Loki request occurs here. Link existence is not proof of retained logs or UI access.
Raw log display in the portal is intentionally not implemented by this helper.
"""
import json
import re
from urllib.parse import urlencode

from .tempo_reader import LOWER_GRAFANA_HOST
from .trace_model import TraceError, SIT_SERVICES, validate_trace_id
from .dashboard_catalog import RUM_APPS

BROWSER_SERVICES = frozenset(RUM_APPS.values())
MAX_LOG_QUERIES = 10  # Nine approved browser apps plus one historical Promtail query.
MAX_LOG_LINES = 100


def _log_queries(nodes, trace_id, loki_uid):
    """Generate exact queries only from validated trace identities, never URL/log attributes."""
    server_namespaces = sorted({n["namespace"] for n in nodes if n["service"] not in BROWSER_SERVICES})
    browser_pairs = sorted({(n["namespace"], n["service"]) for n in nodes if n["service"] in BROWSER_SERVICES})
    expressions = []
    if server_namespaces:
        # Preserve historical server-only selector bytes. These finite namespace names contain
        # no regex metacharacters; JSON quoting still escapes all string literal boundaries.
        if len(server_namespaces) == 1:
            selector = '{namespace=' + json.dumps(server_namespaces[0]) + '}'
        else:
            selector = '{namespace=~' + json.dumps("|".join(server_namespaces)) + '}'
        expressions.append(selector + ' |= ' + json.dumps(trace_id))
    for namespace, service in browser_pairs:
        # Faro's receiver uses app_namespace, not Promtail's namespace label. Keep each browser
        # name/namespace paired: cross-product regexes could query another site's stream.
        selector = '{source="faro",app_name=' + json.dumps(service) + ',app_namespace=' + json.dumps(namespace) + ',app_environment="sit"}'
        expressions.append(selector + ' |= ' + json.dumps(trace_id))
    if not 1 <= len(expressions) <= MAX_LOG_QUERIES:
        raise TraceError("log_query_count_limit")
    limit = MAX_LOG_LINES // len(expressions)
    return [{"refId": chr(65 + i), "datasource": {"type": "loki", "uid": loki_uid},
             "expr": expr, "queryType": "range", "maxLines": limit} for i, expr in enumerate(expressions)]


def build_log_links(summary, *, loki_uid, tempo_uid="tempo-lower"):
    for uid in (loki_uid, tempo_uid):
        if not isinstance(uid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", uid):
            raise TraceError("invalid_datasource_uid")
    trace_id = validate_trace_id(summary["trace_id"])
    if summary.get("environment") != "sit" or not summary.get("nodes"):
        raise TraceError("trace_scope_not_verified")
    for node in summary["nodes"]:
        if node.get("namespace") not in SIT_SERVICES or node.get("service") not in SIT_SERVICES[node["namespace"]]:
            raise TraceError("trace_scope_not_verified")
    times = [summary["start_time_unix_nano"], summary["end_time_unix_nano"]]
    if any(not isinstance(x, str) or not re.fullmatch(r"[0-9]{1,20}", x) for x in times):
        raise TraceError("invalid_span_time")
    start, end = (int(x) for x in times)
    if not 0 < start <= end <= (1 << 64) - 1:
        raise TraceError("invalid_span_time")
    # At most thirty minutes including the two-minute shifts each side. Do not silently
    # cut a long trace's log range or generate an unbounded Loki scan.
    if end - start > 26 * 60 * 1_000_000_000:
        return {"status": "trace_window_exceeds_log_link_limit", "logs_verified": False}
    window = {"from": str(max(0, start // 1_000_000 - 120_000)), "to": str((end + 999_999) // 1_000_000 + 120_000)}
    if int(window["to"]) - int(window["from"]) > 30 * 60 * 1000:
        return {"status": "trace_window_exceeds_log_link_limit", "logs_verified": False}
    # Namespace/service pairs were verified against SIT_SERVICES above. Browser identity is
    # still self-reported; these links seek retained records, not proof of a real user/site.
    namespaces = sorted({node["namespace"] for node in summary["nodes"]})
    queries = _log_queries(summary["nodes"], trace_id, loki_uid)
    log_pane = {"datasource": loki_uid, "queries": queries, "range": window}
    # Grafana 12.3.1 (the deployed version) executes only the "traceql" query group and routes an all-hex
    # query to its trace-by-ID path; the legacy "traceId" mode is typed but never executed (No data).
    trace_pane = {"datasource": tempo_uid, "queries": [{"refId": "A", "datasource": {"type": "tempo", "uid": tempo_uid},
        "queryType": "traceql", "query": trace_id}], "range": window}
    def url(panes):
        return "https://" + LOWER_GRAFANA_HOST + "/explore?" + urlencode({
            "schemaVersion": "1", "orgId": "1", "panes": json.dumps(panes, separators=(",", ":"))})
    return {"status": "links_generated_not_verified", "logs_verified": False, "ui_access_verified": False,
        "logs_url": url({"logs": log_pane}), "trace_and_logs_url": url({"logs": log_pane, "trace": trace_pane}),
        "range_ms": window, "namespace": ",".join(namespaces), "max_lines": MAX_LOG_LINES,
        "query_count": len(queries), "max_lines_per_query": MAX_LOG_LINES // len(queries),
        "note": "Requires Grafana authorization; logs remain in Grafana and may not be retained."}
