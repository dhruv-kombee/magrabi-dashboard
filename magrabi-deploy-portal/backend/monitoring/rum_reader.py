"""Real-user monitoring numbers per website, read from Loki. Read-only, bounded, exact queries only.

WHAT THIS IS
  Seven LogQL instant queries over the last hour against the Faro stream the RUM edge (alloy-rum)
  writes: observed TTFB measurements, sessions, JavaScript errors, and the p75 of LCP, INP, CLS and TTFB, grouped by
  the browser app that sent them and the page host they were measured on. Every query string is
  fixed at import time and allowlisted by the transport; nothing here is built from user input.

WHY BOTH app AND host
  A site's browser build carries one app name, but one build can serve several hosts (the storefront
  image also serves beta.magrabi.com). A number reaches a website tile only when the app name AND
  the page host both match the catalogue, so a tile never inherits another host's visitors.

NOTHING IS ASSUMED FRESH OR HEALTHY
  An unobserved site is None, never a zero. Missing session/TTFB rows cannot establish that those
  instruments run. Only an absent exception count may be zero, when current-window session or
  measurement evidence exists for that exact site and the exception query succeeded. These are
  retained observations, not a complete visitor census. The payload is "available" only when all
  seven queries answered AND at least one approved site has attributable evidence. This is a SEPARATE route from the endpoint dashboard on
  purpose: the dashboard's strict decoder is untouched, so a Loki problem can only blank the RUM
  line, never the whole dashboard.
"""
import copy
import math
import re
import threading
import time
from urllib.parse import urlencode, urlsplit, parse_qs

from .dashboard_catalog import ENDPOINTS, RUM_APPS

LOKI_ORIGIN = "http://loki-stack.loki.svc.cluster.local:3100"
WINDOW_SECONDS = 3600
MAX_RESPONSE = 400_000
MAX_ROWS = 500
CACHE_SECONDS = 60
NAME = re.compile(r"[a-z][a-z0-9-]{0,79}")
HOST = re.compile(r"[a-z0-9-]+-sit\.test-magrabi\.com")

# Stream labels are the ones alloy-rum lifts from each payload (source, app_name, app_namespace,
# app_environment, kind). page_url and session_id are line fields, parsed with logfmt. The page
# host is derived with label_format so the numbers group by (app, host) in one query.
_STREAM = '{source="faro",app_environment="sit"%s}'
_HOST = ' | label_format page_host=`{{ regexReplaceAll "^https?://([^/]+).*" .page_url "${1}" }}`'
_BY = "by (app_name, page_host)"
_WINDOW = "[1h]"


def _count(kind, line_filter=""):
    return ("sum " + _BY + " (count_over_time(" + _STREAM % (',kind="' + kind + '"') + " | logfmt" + line_filter
            + _HOST + " " + _WINDOW + "))")


def _p75(field):
    return ("quantile_over_time(0.75, " + _STREAM % ',kind="measurement"' + ' | logfmt | value_' + field + '=~".+"'
            + _HOST + " | unwrap value_" + field + " " + _WINDOW + ") " + _BY)


QUERIES = {
    # Legacy API key retained for compatibility: observed TTFB measurements, NOT total page loads.
    # Delivery, browser lifecycle and instrumentation can omit or repeat measurements.
    "page_loads": _count("measurement", ' | value_ttfb=~".+"'),
    "sessions": ("count " + _BY + " (sum by (app_name, page_host, session_id) (count_over_time("
                 + _STREAM % "" + ' | logfmt | session_id=~".+"' + _HOST + " " + _WINDOW + ")))"),
    "js_errors": _count("exception"),
    "lcp_p75_ms": _p75("lcp"),
    "inp_p75_ms": _p75("inp"),
    "cls_p75": _p75("cls"),
    "ttfb_p75_ms": _p75("ttfb"),
}
COUNTS = ("page_loads", "sessions", "js_errors")
QUERY_TEXTS = frozenset(QUERIES.values())
SITES = tuple((e["host"], RUM_APPS[e["host"]]) for e in ENDPOINTS if e["type"] == "website" and e["host"] in RUM_APPS)


def rum_url(signal, now):
    return LOKI_ORIGIN + "/loki/api/v1/query?" + urlencode({"query": QUERIES[signal], "time": str(int(now))})


def transport_profile(url, now=None):
    """Allow exactly the seven fixed queries with a current timestamp. Anything else gets no profile."""
    now = time.time() if now is None else now
    parsed = urlsplit(url)
    if parsed.fragment or parsed.username or parsed.password:
        return None
    if parsed.scheme + "://" + parsed.netloc != LOKI_ORIGIN or parsed.path != "/loki/api/v1/query":
        return None
    try:
        q = parse_qs(parsed.query, strict_parsing=True)
    except (ValueError, KeyError):
        return None
    if any(len(v) != 1 for v in q.values()) or set(q) != {"query", "time"}:
        return None
    if q["query"][0] not in QUERY_TEXTS:
        return None
    if not re.fullmatch(r"\d{10}", q["time"][0]) or abs(int(q["time"][0]) - now) >= 60:
        return None
    return MAX_RESPONSE, 7.0


def numeric(value):
    try:
        if type(value) not in (int, float, str):
            return None
        n = float(value)
        return n if math.isfinite(n) and 0 <= n <= 1e12 else None
    except (ValueError, OverflowError):
        return None


def parse(raw):
    """One query's instant vector -> {(app, host): value}. None when the response is not usable."""
    if not (isinstance(raw, dict) and raw.get("status") == "success" and isinstance(raw.get("data"), dict)
            and raw["data"].get("resultType") == "vector" and isinstance(raw["data"].get("result"), list)
            and len(raw["data"]["result"]) <= MAX_ROWS and not raw.get("warnings")):
        return None
    values = {}
    for row in raw["data"]["result"]:
        if not isinstance(row, dict) or not isinstance(row.get("metric"), dict):
            continue
        labels, value = row["metric"], row.get("value")
        if not isinstance(value, list) or len(value) != 2:
            continue
        n = numeric(value[1])
        app, host = labels.get("app_name"), labels.get("page_host")
        if n is None or not isinstance(app, str) or not isinstance(host, str):
            continue
        if not NAME.fullmatch(app) or not HOST.fullmatch(host):
            continue
        key = (app, host)
        # Duplicate rows for one identity must not silently pick a winner.
        values[key] = None if key in values and values[key] != n else n
    return values


def snapshot(results, now):
    """results: signal -> raw response (or None). Missing signals are None for every site."""
    parsed = {signal: parse(results.get(signal)) for signal in QUERIES}
    available = all(parsed[signal] is not None for signal in QUERIES)
    any_site_evidence = False
    sites = []
    for host, app in SITES:
        key = (app, host)
        observed = {signal: parsed[signal].get(key) if parsed[signal] is not None else None for signal in QUERIES}
        # A positive integral count or a measured percentile (including zero CLS) is evidence.
        # An explicit zero count alone does not establish that a site's SDK was instrumented.
        evidence = {signal for signal, value in observed.items() if value is not None and
                    (signal not in COUNTS or (value > 0 and value.is_integer()))}
        any_site_evidence = any_site_evidence or bool(evidence)
        browser_activity = bool(evidence - {"js_errors"})
        site = {"host": host, "app": app}
        for signal in QUERIES:
            table = parsed[signal]
            if table is None:
                site[signal] = None
            elif signal in COUNTS:
                value = observed[signal]
                if signal == "js_errors" and key not in table and browser_activity:
                    value = 0.0  # No retained exceptions among an observed site's browser records.
                site[signal] = int(value) if value is not None and value.is_integer() and (value > 0 or browser_activity) else None
            else:
                value = table.get((app, host))
                site[signal] = round(value, 3) if value is not None else None
        sites.append(site)
    return {"schema_version": 1, "environment": "sit", "generated_at": int(now), "window_seconds": WINDOW_SECONDS,
            "valid_until": int(now) + CACHE_SECONDS, "telemetry": "available" if available and any_site_evidence else "unavailable",
            "sites": sites}


class RumReader:
    """Same shape as ServiceMapReader: one in-flight refresh, a short cache, no background work."""

    def __init__(self, get, clock=time.time):
        self.get, self.clock = get, clock
        self._lock = threading.Lock()
        self._cache, self._cached_at = None, 0

    def rum(self):
        now = self.clock()
        if not self._lock.acquire(blocking=False):
            raise ValueError("rum_busy")
        try:
            if self._cache is not None and 0 <= now - self._cached_at < CACHE_SECONDS:
                return copy.deepcopy(self._cache)
            from .dashboard_reader import read_json
            results = {}
            for signal in QUERIES:
                try:
                    results[signal] = read_json(self.get, rum_url(signal, now))
                except Exception:
                    results[signal] = None
            self._cache = snapshot(results, now)
            self._cached_at = now
            return copy.deepcopy(self._cache)
        finally:
            self._lock.release()
