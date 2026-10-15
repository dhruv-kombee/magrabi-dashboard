"""Live service map from the Collector's service_graph connector. Read-only, bounded, no writes.

WHAT THIS IS
  One PromQL query against the same Prometheus the endpoint dashboard already uses, returning the
  observed call graph: who called whom, how often, how often it failed, and how slow it was. Unlike
  dashboard_catalog's EDGES - which are *configured* topology - every edge here was observed in a
  real trace.

WHY THE NUMBERS ARE EXACT EVEN THOUGH TRACES ARE SAMPLED
  The connector runs on a pre-tail-sampling branch, so it counts 100% of spans. The stored traces a
  user drills into are the sampled subset. Rates on this map are therefore complete; a trace opened
  from it may not be.

FRESHNESS IS NOT ASSUMED
  Prometheus returns an instant vector with the query's own timestamp, which says nothing about when
  the sample was scraped. A separate timestamp() signal gates every edge, exactly as
  dashboard_reader does. Missing or stale input becomes "unknown", never a healthy zero.

IDENTITIES COME FROM TELEMETRY, SO THEY ARE UNTRUSTED
  client/server names originate in application spans. They are validated against a strict pattern and
  a hard row cap before being echoed, and no other label is ever copied into the response.
"""
import math
import re
import threading
import time
from urllib.parse import urlencode

from .dashboard_catalog import NAMESPACES

PROMETHEUS_ORIGIN = "http://prometheus-server.loki.svc.cluster.local:80"
MAX_RESPONSE = 750_000
MAX_ROWS = 2000
MAX_NODES = 60
MAX_EDGES = 200
MAX_SAMPLE_AGE = 180
WINDOW = "5m"
SCOPE = '{monitoring_scope="sit"}'
# Anchored, and deliberately narrower than a hostname: a service or peer identity, nothing else.
NAME = re.compile(r"[a-z0-9][a-z0-9._-]{0,79}")
CONNECTION_TYPES = ("", "database", "messaging_system", "virtual_node")
# The connector labels a peer "unknown" when a client span expired from its pairing store
# without a matching server span. That is an unpaired-call artifact, not a service, and drawing
# it as a box - red, because those calls look failed - invents a component that does not exist.
PLACEHOLDER_PEERS = frozenset({"unknown", "unspecified", "none"})
BY = "client, server, client_k8s_namespace_name, server_k8s_namespace_name, connection_type"


def signal(expr, label):
    return 'label_replace((' + expr + '), "monitoring_signal", "' + label + '", "", "")'


MAP_QUERY = " or ".join([
    signal("sum by (" + BY + ") (rate(traces_service_graph_request_total" + SCOPE + "[" + WINDOW + "]))", "calls"),
    signal("sum by (" + BY + ") (rate(traces_service_graph_request_failed_total" + SCOPE + "[" + WINDOW + "]))", "failed"),
    signal("histogram_quantile(0.95, sum by (" + BY + ", le) (rate(traces_service_graph_request_server_seconds_bucket"
           + SCOPE + "[" + WINDOW + "])))", "p95"),
    signal("min by (" + BY + ") (timestamp(traces_service_graph_request_total" + SCOPE + "))", "at"),
])

SIGNALS = ("calls", "failed", "p95", "at")


def map_url(now):
    return PROMETHEUS_ORIGIN + "/api/v1/query?" + urlencode(
        {"query": MAP_QUERY, "time": str(int(now)), "timeout": "5s"})


def transport_profile(url, now=None):
    """Allow exactly this one query, with a current timestamp. Anything else gets no profile."""
    from urllib.parse import urlsplit, parse_qs
    now = time.time() if now is None else now
    parsed = urlsplit(url)
    if parsed.fragment or parsed.username or parsed.password:
        return None
    if parsed.scheme + "://" + parsed.netloc != PROMETHEUS_ORIGIN or parsed.path != "/api/v1/query":
        return None
    try:
        q = parse_qs(parsed.query, strict_parsing=True)
    except (ValueError, KeyError):
        return None
    if any(len(v) != 1 for v in q.values()) or set(q) != {"query", "time", "timeout"}:
        return None
    if q["query"] != [MAP_QUERY] or q["timeout"] != ["5s"]:
        return None
    if not re.fullmatch(r"\d{10}", q["time"][0]) or abs(int(q["time"][0]) - now) >= 60:
        return None
    return MAX_RESPONSE, 7.0


def numeric(value):
    try:
        if type(value) not in (int, float, str):
            return None
        n = float(value)
        return n if math.isfinite(n) and -1e12 <= n <= 1e12 else None
    except (ValueError, OverflowError):
        return None


def _node_id(name, namespace, kind):
    return (namespace + "/" + name) if kind == "service" else ("external/" + name)


def snapshot(raw, now):
    """Build the map payload. Anything not verifiable becomes unknown rather than a zero."""
    available = (isinstance(raw, dict) and raw.get("status") == "success"
                 and isinstance(raw.get("data"), dict) and raw["data"].get("resultType") == "vector"
                 and isinstance(raw["data"].get("result"), list) and not raw.get("warnings")
                 and len(raw["data"]["result"]) <= MAX_ROWS)
    rows = raw["data"]["result"] if available else []

    edges = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("metric"), dict):
            continue
        labels, value = row["metric"], row.get("value")
        if not isinstance(value, list) or len(value) != 2:
            continue
        n = numeric(value[1])
        if n is None:
            continue
        sig = labels.get("monitoring_signal")
        if sig not in SIGNALS:
            continue
        client, server = labels.get("client"), labels.get("server")
        if not isinstance(client, str) or not isinstance(server, str):
            continue
        if not NAME.fullmatch(client) or not NAME.fullmatch(server) or client == server:
            continue
        if client in PLACEHOLDER_PEERS or server in PLACEHOLDER_PEERS:
            continue
        conn = labels.get("connection_type", "")
        if conn not in CONNECTION_TYPES:
            continue
        client_ns = labels.get("client_k8s_namespace_name", "")
        server_ns = labels.get("server_k8s_namespace_name", "")
        # A namespace is only accepted if it is one we actually deploy; anything else is dropped
        # rather than echoed, so a span cannot inject an arbitrary namespace into the map.
        client_ns = client_ns if client_ns in NAMESPACES else ""
        server_ns = server_ns if server_ns in NAMESPACES else ""
        key = (client, client_ns, server, server_ns, conn)
        edge = edges.setdefault(key, {})
        # Duplicate scrape jobs can disagree. Do not silently take the last value.
        if sig in edge and edge[sig] != n:
            edge[sig] = None
        elif sig not in edge:
            edge[sig] = n

    def fresh(t):
        return t is not None and 0 <= now - t <= MAX_SAMPLE_AGE

    nodes, out_edges = {}, []
    for (client, client_ns, server, server_ns, conn), v in sorted(edges.items())[:MAX_EDGES]:
        valid = fresh(v.get("at")) and v.get("calls") is not None
        calls = v.get("calls") if valid else None
        failed = v.get("failed") if valid else None
        if calls is not None and failed is not None and failed > calls:
            failed = None
        p95 = v.get("p95") if valid else None
        # The client side is always a real workload; the server side may be a database or an
        # external host the connector inferred as a virtual node.
        client_kind = "service" if client_ns else "external"
        server_kind = "service" if server_ns else ("database" if conn == "database" else "external")
        source = _node_id(client, client_ns, client_kind)
        target = _node_id(server, server_ns, server_kind)
        error_rate = None
        if calls is not None and failed is not None and calls > 0:
            error_rate = min(1.0, failed / calls)
        out_edges.append({
            "source": source, "target": target, "connection_type": conn or "service",
            "calls_per_min": round(calls * 60, 4) if calls is not None else None,
            "failed_per_min": round(failed * 60, 4) if failed is not None else None,
            "error_rate": round(error_rate, 6) if error_rate is not None else None,
            "p95_ms": round(min(p95 * 1000, 1e12), 3) if p95 is not None and p95 >= 0 else None,
        })
        for node_id, name, ns, kind in ((source, client, client_ns, client_kind),
                                        (target, server, server_ns, server_kind)):
            node = nodes.setdefault(node_id, {"id": node_id, "namespace": ns or None, "service": name,
                                              "kind": kind, "calls_per_min": 0.0, "failed_per_min": 0.0,
                                              "p95_ms": None, "observed": False})
            if kind != "external" or node["kind"] == "external":
                node["kind"] = kind

    # Roll edge measurements up to the server side of each edge: that is the traffic a service
    # received, which is what a tile should report.
    for edge in out_edges:
        node = nodes.get(edge["target"])
        if node is None:
            continue
        if edge["calls_per_min"] is None:
            continue
        node["observed"] = True
        node["calls_per_min"] += edge["calls_per_min"]
        node["failed_per_min"] += edge["failed_per_min"] or 0.0
        if edge["p95_ms"] is not None:
            node["p95_ms"] = edge["p95_ms"] if node["p95_ms"] is None else max(node["p95_ms"], edge["p95_ms"])

    out_nodes = []
    for node in sorted(nodes.values(), key=lambda n: n["id"])[:MAX_NODES]:
        observed = node.pop("observed")
        calls = round(node["calls_per_min"], 4) if observed else None
        failed = round(node["failed_per_min"], 4) if observed else None
        rate = (min(1.0, failed / calls) if observed and calls else 0.0 if observed else None)
        node["calls_per_min"], node["failed_per_min"] = calls, failed
        node["error_rate"] = round(rate, 6) if rate is not None else None
        # Never invent green. No fresh observation means unknown, not healthy.
        node["health"] = ("unknown" if not observed else
                          "error" if (failed or 0) > 0 else
                          "idle" if calls == 0 else "healthy")
        out_nodes.append(node)

    expiries = [v["at"] + MAX_SAMPLE_AGE for v in edges.values() if fresh(v.get("at"))]
    return {"schema_version": 1, "environment": "sit", "generated_at": int(now),
            "window_seconds": 300, "observation": "observed_calls_before_sampling",
            "telemetry": "available" if available else "unavailable",
            "valid_until": min(expiries, default=now + 30),
            "nodes": out_nodes, "edges": out_edges}


class ServiceMapReader:
    """Same shape as DashboardReader: one in-flight request, a short cache, no background work."""

    def __init__(self, get, clock=time.time):
        self.get, self.clock = get, clock
        self._lock = threading.Lock()
        self._cache, self._cached_at = None, 0

    def service_map(self):
        import copy
        now = self.clock()
        if not self._lock.acquire(blocking=False):
            raise ValueError("service_map_busy")
        try:
            if self._cache is not None and 0 <= now - self._cached_at < 30 and now < self._cache["valid_until"]:
                return copy.deepcopy(self._cache)
            from .dashboard_reader import read_json
            try:
                raw = read_json(self.get, map_url(now))
            except Exception:
                raw = None
            self._cache = snapshot(raw, now)
            self._cached_at = now
            return copy.deepcopy(self._cache)
        finally:
            self._lock.release()
