"""Bounded retained trace samples attributable to one exact SIT website.

One row is ONE TRACE with one selected, host-proven site span, not one HTTP request or every
visitor. The current window includes recent data but Tempo indexing/sampling can omit traces.
Search metadata is untrusted discovery only. Whole-trace scope plus span-level site attribution
must pass before returning a row. Raw names, URLs, sessions and arbitrary paths never leave here.
"""
import copy
import json
import re
import threading
import time
from urllib.parse import parse_qs, urlencode, urlsplit

from .dashboard_catalog import ENDPOINTS, RUM_APPS
from .request_budget import RequestBudget
from .tempo_reader import CLUSTER_TEMPO_ORIGIN, TempoTraceReader
from .trace_model import (SIT_SERVICES, TracePolicy, decode_payload, summarize_trace,
                          validate_trace_id, _attrs, _identifier)

WINDOW_SECONDS = 300
CACHE_SECONDS = 10
MAX_CANDIDATES = 4
MAX_SEARCH_BYTES = 100_000
MAX_DETAIL_BYTES = 2_000_000
MAX_REFRESH_SECONDS = 8  # Must remain below the start-anchored ten-second freshness horizon.
METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"})
SAFE_SEGMENTS = frozenset({"api", "graphql", "products", "product", "collections", "collection",
    "search", "category", "categories", "cart", "checkout", "account", "health", "healthz",
    "ready", "readyz", "login", "ae-en", "ae-ar", "sa-en", "sa-ar", "eg-en", "eg-ar"})
URL_KEYS = ("url.full", "http.url")
PAGE_KEYS = ("page.url", "page_url", "document.url")
ATTR_KEYS = frozenset((*URL_KEYS, *PAGE_KEYS, "http.host", "server.address", "http.route",
    "http.method", "http.request.method"))


class TrafficDeadline(ValueError):
    """Fixed error code only; no provider exception or payload is exposed."""

# Only declared trace service identities are eligible. Missing identities are not guessed from a
# Kubernetes Service name (which differs from OTEL_SERVICE_NAME in several apps).
SITES = {}
for _endpoint in ENDPOINTS:
    if _endpoint["host"] not in RUM_APPS:
        continue
    _namespace = _endpoint["component_ids"][0].split("/", 1)[0]
    _server_names = {
        "magrabi-ui-sit.test-magrabi.com": ("storefront", "storefront-checkout"),
        "doctorm-ui-sit.test-magrabi.com": ("doctorm-storefront", "doctorm-storefront-checkout"),
        "magrabi-retail-ui-sit.test-magrabi.com": ("retail-storefront",),
    }.get(_endpoint["host"], tuple(c.split("/", 1)[1] for c in _endpoint["component_ids"]))
    SITES[_endpoint["host"]] = {"namespace": _namespace, "browser": RUM_APPS[_endpoint["host"]],
        "servers": tuple(n for n in _server_names if n in SIT_SERVICES.get(_namespace, ()))}


def site_query(host):
    if host not in SITES:
        raise ValueError("site_not_configured")
    site = SITES[host]
    services = " || ".join('resource.service.name=' + json.dumps(s) for s in (site["browser"], *site["servers"]))
    environments = " || ".join('resource.' + key + '=' + json.dumps(value)
        for key in ("deployment.environment", "deployment.environment.name") for value in ("sit", site["namespace"]))
    # Fixed catalogue hosts only; all string/regex literals are JSON escaped for TraceQL.
    pattern = "https://" + re.escape(host) + "(?::443)?(/.*)?"
    authorities = ['span.' + key + '=' + json.dumps(host) for key in ("http.host", "server.address")]
    authorities += ['span.' + key + '=~' + json.dumps(pattern) for key in (*PAGE_KEYS, *URL_KEYS)]
    return ('{resource.k8s.namespace.name=' + json.dumps(site["namespace"]) + ' && (' + services
        + ') && (' + environments + ') && (' + " || ".join(authorities) + ')}')


QUERY_TEXTS = frozenset(site_query(host) for host in SITES)


def search_url(host, now):
    return CLUSTER_TEMPO_ORIGIN + "/api/search?" + urlencode({"q": site_query(host),
        "start": str(int(now) - WINDOW_SECONDS), "end": str(int(now)), "limit": str(MAX_CANDIDATES)})


def transport_profile(url, now=None):
    now = time.time() if now is None else now
    try:
        p = urlsplit(url)
        if (p.scheme + "://" + p.netloc != CLUSTER_TEMPO_ORIGIN or p.path != "/api/search"
                or p.fragment or p.username or p.password):
            return None
        q = parse_qs(p.query, strict_parsing=True)
        if set(q) != {"q", "start", "end", "limit"} or any(len(v) != 1 for v in q.values()):
            return None
        if q["q"][0] not in QUERY_TEXTS or q["limit"] != [str(MAX_CANDIDATES)]:
            return None
        if not all(re.fullmatch(r"\d{10}", q[k][0]) for k in ("start", "end")):
            return None
        start, end = int(q["start"][0]), int(q["end"][0])
        if end - start == WINDOW_SECONDS and abs(end - now) < 30:
            return MAX_SEARCH_BYTES, 3.0
    except (ValueError, TypeError, KeyError):
        pass
    return None


def _url_host(value):
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\x00-\x20\\]", value):
        return None
    try:
        p = urlsplit(value)
        if p.scheme != "https" or p.username is not None or p.password is not None or p.port not in (None, 443):
            return None
        return p.hostname
    except ValueError:
        return None


def _host_proven(attrs, host, browser):
    # For browser requests, an explicit document/page host takes precedence over the API called.
    # For server spans only that server request's authority/URL is relevant, never a page/referrer.
    keys = tuple(k for k in PAGE_KEYS if k in attrs) if browser else ()
    if keys:
        observed = [_url_host(attrs[k]) for k in keys]
    else:
        observed = [_url_host(attrs[k]) for k in URL_KEYS if k in attrs]
        observed += [_url_host("https://" + attrs[k]) if isinstance(attrs[k], str) and
            not re.search(r"[/\\?#@]", attrs[k]) else None for k in ("http.host", "server.address") if k in attrs]
    return bool(observed) and all(h == host for h in observed)


def safe_route(value):
    """Only allowlisted static segments and anonymous template markers; opaque paths are hidden."""
    if not isinstance(value, str) or len(value) > 512 or re.search(r"[\x00-\x20\\]", value):
        return None
    path = value.split("?", 1)[0].split("#", 1)[0]
    if not path.startswith("/") or path.startswith("//"):
        return None
    if path == "/":
        return "/"
    segments = path.strip("/").split("/")
    if len(segments) > 8:
        return None
    safe = []
    for segment in segments:
        if segment in SAFE_SEGMENTS:
            safe.append(segment)
        elif re.fullmatch(r"(?:\{[A-Za-z][A-Za-z0-9_]{0,30}\}|\[[A-Za-z][A-Za-z0-9_]{0,30}\]|:[A-Za-z][A-Za-z0-9_]{0,30})", segment):
            safe.append(":param")
        else:
            return None
    return "/" + "/".join(safe)


def attributed_row(raw, trace_id, host, now, policy):
    site = SITES[host]
    summary = summarize_trace(raw, trace_id, policy)  # Reject mixed/unapproved traces whole.
    doc = decode_payload(raw)
    public = {s["span_id"]: s for s in summary["spans"]}
    matches, attributes_by_span = [], {}
    for batch in doc.get("resourceSpans", doc.get("batches", [])):
        identity = _attrs(batch.get("resource", {}).get("attributes", []), {
            "service.name", "k8s.namespace.name", "deployment.environment", "deployment.environment.name"}, identity=True)
        environment = [identity[k] for k in ("deployment.environment", "deployment.environment.name") if k in identity]
        service = identity.get("service.name")
        if (identity.get("k8s.namespace.name") != site["namespace"] or not environment
                or any(v not in ("sit", site["namespace"]) for v in environment)):
            continue
        browser = service == site["browser"]
        if not browser and service not in site["servers"]:
            continue
        for scope in batch.get("scopeSpans", batch.get("instrumentationLibrarySpans", [])):
            for span in scope.get("spans", []):
                sid = _identifier(span.get("spanId"), 8, policy.id_encoding)
                selected = public[sid]
                if not browser and selected["kind"] != "server":
                    continue
                attrs = _attrs(span.get("attributes", []), ATTR_KEYS)
                if sid in attributes_by_span and attributes_by_span[sid] != attrs:
                    raise ValueError("conflicting_site_span_attributes")
                attributes_by_span[sid] = attrs
                if not _host_proven(attrs, host, browser):
                    continue
                start_ns, end_ns = int(span["startTimeUnixNano"]), int(span["endTimeUnixNano"])
                at = start_ns // 1_000_000_000
                if not int(now) - WINDOW_SECONDS <= at <= int(now) or end_ns > (int(now) + 5) * 1_000_000_000:
                    continue
                methods = [attrs[k] for k in ("http.method", "http.request.method") if k in attrs]
                method = methods[0] if methods and all(m == methods[0] and m in METHODS for m in methods) else None
                # Only the route template is considered. URL path is never copied into the API.
                route = safe_route(attrs.get("http.route"))
                http_status = selected["http_status_code"]
                error = (True if selected["otel_status"] == "error" or (http_status is not None and http_status >= 400)
                    else False if selected["otel_status"] == "ok" or http_status is not None else None)
                matches.append((start_ns, sid, {"trace_id": validate_trace_id(trace_id), "at": at,
                    "kind": "browser" if browser else "server", "route": route, "method": method,
                    "status": http_status, "duration_ms": selected["duration_ms"],
                    "error": error, "measurement": "selected_site_span",
                    "attribution": "browser_reported" if browser else "server_reported"}))
    # Deterministic one-row-per-trace policy; not every request/span in a multi-request trace.
    return min(matches, key=lambda item: (item[0], item[1]))[2] if matches else None


class TrafficReader:
    """Separate global budget/cache/lock, no background polling and no retry or pagination."""
    def __init__(self, get, clock=time.time, monotonic=time.monotonic, policy=None):
        self.clock, self.monotonic = clock, monotonic
        self.get = RequestBudget(burst=MAX_CANDIDATES + 1, per_second=0.5, clock=monotonic).wrap(get)
        self.read_trace = TempoTraceReader(get=self.get, base_url=CLUSTER_TEMPO_ORIGIN, transport="cluster", clock=monotonic)
        self.policy = policy or TracePolicy(SIT_SERVICES, id_encoding="base64")
        self._lock, self._cache = threading.Lock(), {}

    def _check_deadline(self, deadline):
        if self.monotonic() >= deadline:
            raise TrafficDeadline("traffic_refresh_deadline")

    def _search(self, host, now, deadline):
        response = None
        search_deadline = min(deadline, self.monotonic() + 3.0)
        try:
            self._check_deadline(search_deadline)
            remaining = search_deadline - self.monotonic()
            if remaining <= 0:
                raise TrafficDeadline("traffic_refresh_deadline")
            response = self.get(search_url(host, now), headers={"Accept": "application/json"},
                allow_redirects=False, stream=True, timeout=(min(2, remaining), remaining))
            self._check_deadline(search_deadline)
            if response.status_code != 200 or response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise ValueError("traffic_backend_unavailable")
            body = bytearray()
            for chunk in response.iter_content(8192):
                self._check_deadline(search_deadline)
                body.extend(chunk)
                if len(body) > MAX_SEARCH_BYTES:
                    raise ValueError("traffic_backend_limit")
            self._check_deadline(search_deadline)
            raw = json.loads(body)
            rows = raw.get("traces") if isinstance(raw, dict) else None
            if not isinstance(rows, list) or len(rows) > MAX_CANDIDATES or raw.get("warnings"):
                raise ValueError("traffic_backend_unavailable")
            # Never echo rootTraceName, rootServiceName or arbitrary search attributes.
            ids = sorted({validate_trace_id(row.get("traceID")) for row in rows if isinstance(row, dict)})
            self._check_deadline(search_deadline)
            return ids
        finally:
            if response is not None:
                response.close()

    def requests(self, host):
        site_query(host)  # Fail closed before consuming a budget or making a network call.
        if not self._lock.acquire(blocking=False):
            raise ValueError("traffic_busy")
        try:
            now = int(self.clock())
            cached = self._cache.get(host)
            if cached and cached["generated_at"] <= now < cached["valid_until"]:
                return copy.deepcopy(cached)
            deadline, rows, failed = self.monotonic() + MAX_REFRESH_SECONDS, [], False
            try:
                ids = self._search(host, now, deadline)
                self._check_deadline(deadline)
                for trace_id in ids:
                    # TempoTraceReader's timeout contract is integer seconds. Do not start a read
                    # that cannot fit the remaining whole-refresh allowance.
                    remaining = min(2, int(deadline - self.monotonic()))
                    if remaining < 1:
                        raise TrafficDeadline("traffic_refresh_deadline")
                    try:
                        raw = self.read_trace(trace_id, environment="sit", max_bytes=MAX_DETAIL_BYTES, timeout_seconds=remaining)
                        self._check_deadline(deadline)
                        if raw is None:
                            failed = True
                            continue
                        row = attributed_row(raw, trace_id, host, now, self.policy)
                        self._check_deadline(deadline)
                        if row:
                            rows.append(row)
                    except TrafficDeadline:
                        raise
                    except Exception:
                        # Backend errors, failed validation, scope conflicts and malformed attributes
                        # carry no user-visible exception text and do not become healthy data.
                        failed = True
                        self._check_deadline(deadline)
                self._check_deadline(deadline)
            except TrafficDeadline:
                failed, rows = True, []
            except Exception:
                failed = True
            # A fake/nonconforming transport or CPU-bound parsing can overrun its own deadline;
            # also handle wall-clock jumps. Never extend old telemetry's expiry to hide latency.
            if self.monotonic() >= deadline or int(self.clock()) >= now + CACHE_SECONDS:
                failed, rows = True, []
            result = {"schema_version": 1, "environment": "sit", "host": host, "generated_at": now,
                "valid_until": now + CACHE_SECONDS, "window_seconds": WINDOW_SECONDS,
                "window_start": now - WINDOW_SECONDS, "window_end": now,
                "telemetry": "unavailable" if failed else "available",
                "observation": "retained_site_traces_only", "coverage": "incomplete",
                "empty_reason": "none_attributed_or_not_yet_retained" if not rows else None,
                "rows": sorted(rows, key=lambda row: (-row["at"], row["trace_id"]))}
            self._cache[host] = result
            return copy.deepcopy(result)
        finally:
            self._lock.release()
