"""Bounded SIT metrics / retained trace discovery. No runtime credentials or cluster writes.

Prometheus's instant result timestamp is NOT source freshness. Separate timestamp(metric)
signals gate every health observation. Empty/error/stale inputs never become healthy zeroes.
"""
import copy
import json
import math
import re
import threading
import time
from urllib.parse import urlencode, urlsplit, parse_qs

from .dashboard_catalog import COMPONENTS, ENDPOINTS, EDGES, NAMESPACES, MAPPING_VERIFIED_AT
from .trace_model import SIT_SERVICES
from .tempo_reader import CLUSTER_TEMPO_ORIGIN

PROMETHEUS_ORIGIN = "http://prometheus-server.loki.svc.cluster.local:80"
MAX_RESPONSE = 750_000
MAX_SAMPLE_AGE = 120
NS = '{namespace=~"' + "|".join(NAMESPACES) + '"}'
# Escape literal dots for PromQL's RE2 string representation.
HOSTS = "|".join(e["host"].replace(".", r"\\.") for e in ENDPOINTS)
INGRESS_JOB = "sit-ingress-endpoints"
INGRESS = '{job="' + INGRESS_JOB + '",host=~"' + HOSTS + '"}'
COLLECTOR = '{job="' + INGRESS_JOB + '"}'
CONTROLLER = '{namespace="ingress-basic",deployment="nginx-ingress-controller-ingress-nginx-controller"}'
COLLECTION_SIGNALS = ("collector_targets", "collector_up", "collector_expected", "collector_at",
    "collector_expected_at", "collector_window_up", "collector_window_samples")

def signal(expr, label):
    return 'label_replace((' + expr + '), "monitoring_signal", "' + label + '", "", "")'

METRIC_QUERY = " or ".join([
    signal("kube_deployment_spec_replicas" + NS, "desired"),
    signal("kube_deployment_status_replicas_available" + NS, "ready"),
    signal("timestamp(kube_deployment_spec_replicas" + NS + ")", "desired_at"),
    signal("timestamp(kube_deployment_status_replicas_available" + NS + ")", "ready_at"),
    signal("sum by (host, status) (increase(nginx_ingress_controller_requests" + INGRESS + "[5m]))", "requests"),
    signal("min by (host) (timestamp(nginx_ingress_controller_requests" + INGRESS + "))", "requests_at"),
    signal("histogram_quantile(0.95, sum by (host, le) (rate(nginx_ingress_controller_request_duration_seconds_bucket" + INGRESS + "[5m])))", "p95"),
    signal("min by (host) (timestamp(nginx_ingress_controller_request_duration_seconds_bucket" + INGRESS + "))", "p95_at"),
    signal("count(up" + COLLECTOR + ")", "collector_targets"),
    signal("sum(up" + COLLECTOR + ")", "collector_up"),
    signal("max(kube_deployment_spec_replicas" + CONTROLLER + ")", "collector_expected"),
    signal("min(timestamp(up" + COLLECTOR + "))", "collector_at"),
    signal("min(timestamp(kube_deployment_spec_replicas" + CONTROLLER + "))", "collector_expected_at"),
    signal("min(min_over_time(up" + COLLECTOR + "[5m]))", "collector_window_up"),
    signal("min(count_over_time(up" + COLLECTOR + "[5m]))", "collector_window_samples"),
])

def trace_query(component_id):
    c = COMPONENTS.get(component_id)
    if not c or c["namespace"] not in SIT_SERVICES or c["service"] not in SIT_SERVICES[c["namespace"]]:
        raise ValueError("trace_search_not_configured")
    return ('{resource.k8s.namespace.name="' + c["namespace"]
        + '" && resource.service.name="' + c["service"] + '"}')

TRACE_QUERIES = {trace_query(id) for id, c in COMPONENTS.items() if c["namespace"] in SIT_SERVICES and c["service"] in SIT_SERVICES[c["namespace"]]}

def metrics_url(now):
    return PROMETHEUS_ORIGIN + "/api/v1/query?" + urlencode({"query": METRIC_QUERY, "time": str(int(now)), "timeout": "5s"})

def search_url(component_id, now):
    return CLUSTER_TEMPO_ORIGIN + "/api/search?" + urlencode({"q": trace_query(component_id), "start": str(int(now) - 900),
        "end": str(int(now) - 180), "limit": "10"})

def dashboard_transport_profile(url, now=None):
    """Return a profile only for one exact query or one fixed service search and fresh window."""
    now = time.time() if now is None else now
    parsed = urlsplit(url)
    if parsed.fragment or parsed.username or parsed.password:
        return None
    try:
        q = parse_qs(parsed.query, strict_parsing=True)
        if any(len(v) != 1 for v in q.values()): return None
        if parsed.scheme + "://" + parsed.netloc == PROMETHEUS_ORIGIN and parsed.path == "/api/v1/query":
            if set(q) == {"query", "time", "timeout"} and q["query"] == [METRIC_QUERY] and q["timeout"] == ["5s"] and re.fullmatch(r"\d{10}", q["time"][0]) and abs(int(q["time"][0]) - now) < 60:
                return MAX_RESPONSE, 7.0
        if parsed.scheme + "://" + parsed.netloc == CLUSTER_TEMPO_ORIGIN and parsed.path == "/api/search":
            if set(q) == {"q", "start", "end", "limit"} and q["q"][0] in TRACE_QUERIES and q["limit"] == ["10"] and all(re.fullmatch(r"\d{10}", q[k][0]) for k in ("start", "end")):
                start, end = int(q["start"][0]), int(q["end"][0])
                if end - start == 720 and abs(end + 180 - now) < 60: return MAX_RESPONSE, 7.0
    except (ValueError, KeyError, TypeError):
        pass
    return None

def read_json(get, url):
    response = None
    try:
        response = get(url, headers={"Accept": "application/json"}, allow_redirects=False, stream=True, timeout=(2, 7))
        if response.status_code != 200 or response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise ValueError("dashboard_backend_unavailable")
        body = bytearray()
        for chunk in response.iter_content(8192):
            body.extend(chunk)
            if len(body) > MAX_RESPONSE: raise ValueError("dashboard_backend_limit")
        return json.loads(body)
    except Exception:
        raise ValueError("dashboard_backend_unavailable") from None
    finally:
        if response is not None: response.close()

def numeric(value):
    try:
        if type(value) not in (int, float, str): return None
        n = float(value)
        return n if math.isfinite(n) and 0 <= n <= 1e12 else None
    except (ValueError, OverflowError): return None

def snapshot(raw, now):
    by_component, by_host, collection = {}, {}, {}
    available = isinstance(raw, dict) and raw.get("status") == "success" and isinstance(raw.get("data"), dict)
    rows = raw.get("data", {}).get("result") if available else None
    available = available and raw["data"].get("resultType") == "vector" and isinstance(rows, list) and len(rows) <= 2000 and not raw.get("warnings")
    deployments = {(c["namespace"], c["deployment"]) for c in COMPONENTS.values() if c["deployment"]}
    hosts = {e["host"] for e in ENDPOINTS}
    for row in rows if available else []:
        if not isinstance(row, dict) or not isinstance(row.get("metric"), dict): continue
        labels, value = row["metric"], row.get("value")
        if not isinstance(value, list) or len(value) != 2: continue
        n = numeric(value[1])
        if n is None: continue
        sig = labels.get("monitoring_signal")
        key = (labels.get("namespace"), labels.get("deployment"))
        if sig in COLLECTION_SIGNALS:
            if sig in collection and collection[sig] != n: collection[sig] = None
            elif sig not in collection: collection[sig] = n
        elif sig in ("desired", "ready", "desired_at", "ready_at") and key in deployments:
            values = by_component.setdefault(key, {})
            # Duplicate scrape jobs can disagree; don't silently take the last and turn green.
            if sig in values and values[sig] != n: values[sig] = None
            elif sig not in values: values[sig] = n
        elif labels.get("host") in hosts:
            values = by_host.setdefault(labels["host"], {})
            if sig == "requests" and isinstance(labels.get("status"), str) and re.fullmatch(r"[1-5][0-9]{2}", labels["status"]):
                values.setdefault("counts", {})[labels["status"]] = n
            elif sig in ("requests_at", "p95", "p95_at"): values[sig] = n

    def fresh(t): return t is not None and 0 <= now - t <= MAX_SAMPLE_AGE
    # A healthy subset of controllers must not make endpoint totals appear complete.
    # Require every desired replica to be discovered/up, a clean warm-up window, and
    # fresh underlying target + expected-replica samples. Missing/failed scrapes fail closed.
    collection_valid = (all(collection.get(k) is not None for k in COLLECTION_SIGNALS)
        and fresh(collection.get("collector_at")) and fresh(collection.get("collector_expected_at"))
        and collection["collector_expected"].is_integer() and collection["collector_expected"] > 0
        and collection["collector_targets"] == collection["collector_up"] == collection["collector_expected"]
        and collection["collector_window_up"] == 1 and collection["collector_window_samples"] >= 5)
    components = []
    for c in COMPONENTS.values():
        values = by_component.get((c["namespace"], c["deployment"]), {})
        desired, ready = values.get("desired"), values.get("ready")
        valid = (fresh(values.get("desired_at")) and fresh(values.get("ready_at")) and desired is not None and ready is not None
            and desired.is_integer() and ready.is_integer())
        health = "unknown" if not valid else "idle" if desired == 0 else "error" if ready < desired else "healthy"
        components.append({**c, "desired": int(desired) if valid else None, "ready": int(ready) if valid else None, "health": health,
            "trace_search": c["namespace"] in SIT_SERVICES and c["service"] in SIT_SERVICES[c["namespace"]]})
    component_map = {c["id"]: c for c in components}
    endpoints = []
    for e in ENDPOINTS:
        values = by_host.get(e["host"], {})
        counts = values.get("counts", {})
        valid = collection_valid and fresh(values.get("requests_at")) and bool(counts)
        total = sum(counts.values()) if valid else None
        e4 = sum(v for k, v in counts.items() if k.startswith("4")) if valid else None
        e5 = sum(v for k, v in counts.items() if k.startswith("5")) if valid else None
        reachable = set(e["component_ids"])
        for _ in range(len(COMPONENTS)):
            size = len(reachable)
            for edge in EDGES:
                if edge['evidence'] == 'configured_dependency' and edge['source'] in reachable: reachable.add(edge['target'])
            if size == len(reachable): break
        children = [component_map[id]["health"] for id in reachable]
        dependency_issue = any(component_map[id]['health'] == 'error' for id in reachable - set(e['component_ids']))
        health = ("error" if "error" in children or (valid and e4 + e5 > 0) else "unknown" if not valid or "unknown" in children
            else "idle" if total == 0 or "idle" in children else "healthy")
        latency = values.get("p95") if fresh(values.get("p95_at")) and valid and total > 0 else None
        endpoints.append({**e, "health": health, "requests": total, "errors_4xx": e4, "errors_5xx": e5,
            "p95_ms": min(latency * 1000, 1e12) if latency is not None else None, "dependency_issue": dependency_issue})
    expiries = [t + MAX_SAMPLE_AGE for values in [*by_component.values(), *by_host.values(), collection]
        for key, t in values.items() if key.endswith('_at') and fresh(t)]
    return {"schema_version": 1, "environment": "sit", "generated_at": int(now), "window_seconds": 300,
        "health_valid_until": min(expiries, default=now + 30),
        "telemetry": "available" if available else "unavailable", "ingress_collection": "complete" if collection_valid else "unknown",
        "mapping_verified_at": MAPPING_VERIFIED_AT,
        "endpoints": endpoints, "components": components, "edges": copy.deepcopy(EDGES)}

class DashboardReader:
    def __init__(self, get, clock=time.time):
        self.get, self.clock = get, clock
        self._lock = threading.Lock()
        self._cache, self._cached_at = None, 0
        self._search_lock = threading.Lock()
        self._search_at = 0

    def dashboard(self):
        now = self.clock()
        if not self._lock.acquire(blocking=False): raise ValueError("dashboard_busy")
        try:
            if self._cache is not None and 0 <= now - self._cached_at < 30 and now < self._cache['health_valid_until']:
                return copy.deepcopy(self._cache)
            try: raw = read_json(self.get, metrics_url(now))
            except Exception: raw = None
            self._cache = snapshot(raw, now)
            self._cached_at = now
            return copy.deepcopy(self._cache)
        finally: self._lock.release()

    def traces(self, component_id):
        trace_query(component_id)  # Scope check before any network work.
        if not self._search_lock.acquire(blocking=False): raise ValueError("search_busy")
        try:
            now = self.clock()
            if now - self._search_at < 5: raise ValueError("search_rate_limited")
            self._search_at = now
            raw = read_json(self.get, search_url(component_id, now))
            rows = raw.get("traces") if isinstance(raw, dict) else None
            if not isinstance(rows, list) or len(rows) > 10: raise ValueError("search_unavailable")
            ids = set()
            for row in rows:
                id = row.get("traceID") if isinstance(row, dict) else None
                if isinstance(id, str) and re.fullmatch(r"[a-f0-9]{1,32}", id) and int(id, 16): ids.add(id.zfill(32))
            # Do not echo rootServiceName/rootTraceName/spanSets: they may carry private data.
            # A candidate matches a SIT span; full-trace policy remains enforced when opened.
            return {"environment": "sit", "traces": [{"trace_id": id} for id in sorted(ids)], "scope": "candidates_whole_trace_checked_on_open"}
        finally: self._search_lock.release()
