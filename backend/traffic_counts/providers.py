"""Bounded GET-only telemetry readers. Authentication uses server environment only.

No live calls at import, no local credential files, no raw logs in returned data.
The caller owns daily bucketing/caching and passes disjoint windows <= one hour.
"""
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
import importlib.util
import hashlib
import json
import math
import os
import re
import time
import threading
from urllib.parse import urlparse

import requests

from .catalog import AZURE_RESOURCES, BACKEND_BRANDS, CLASS_LABELS, CLASSES, SOURCES

MAX_BYTES = 4 * 1024 * 1024
MAX_SERIES = 10000
EXACT_ZERO_CODES = ("200", "500", "501", "502", "503", "504")
GROUP_CODES = ("1xx", "2xx", "3xx", "4xx", "5xx")
FILTER_VERSION = "storefront-3-merged-probes-saleor"
_AZURE_CREDENTIAL = None
_AZURE_CREDENTIAL_KEY = None
_AZURE_CREDENTIAL_LOCK = threading.Lock()
STATUS_RE = r'^[^ ]+ - [^ ]+ \[[^\]]+\] "[^"\n]*" (?P<http_code>[0-9]{3}) [^ ]+'
BACKEND_RE = r'" [0-9]{3} [^ ]+ "[^"\n]*" "[^"\n]*" [0-9]+ [0-9.]+ \[(?P<backend>[^\]]*)\]'
PATH_RE = r'^[^ ]+ - [^ ]+ \[[^\]]+\] "[A-Z]+ (?P<request_path>[^ ?]+)[^ ]* HTTP/[^" ]+"'
UA_RE = r'^[^ ]+ - [^ ]+ \[[^\]]+\] "[^"\n]*" [0-9]{3} [^ ]+ "[^"\n]*" "(?P<request_ua>[^"\n]*)"'
MONITOR_UAS = (
    "site24x7", "kube-probe", "blackbox", "healthcheck", "health-check", "health check",
    "pingdom", "uptimerobot", "uptime-kuma", "azure front door health probe",
    "microsoft azure application insights availability", "prometheus", "edge health probe", "azure-health-probe",
)
AUTOMATION_UAS = (
    "next.js middleware", "reactornetty", "reactor-netty", "node-fetch", "undici", "axios",
    "python-requests", "python-httpx", "aiohttp", "curl/", "wget/", "go-http-client", "java/",
    "apache-httpclient", "postmanruntime", "insomnia", "k6/", "locust", "jmeter", "playwright",
    "puppeteer", "headlesschrome", "selenium", "saleor/",
)
BOT_UAS = (
    "googlebot", "bingbot", "gptbot", "claudebot", "amazonbot", "applebot", "duckduckbot", "yandexbot",
    "petalbot", "ahrefsbot", "semrushbot", "baiduspider", "bytespider", "dataforseobot", "dotbot",
    "mj12bot", "blexbot", "yahoo! slurp", "facebookexternalhit", "meta-externalagent", "meta-externalads",
    "chatgpt-user", "googleother", "google-inspectiontool", "bingpreview", "yandeximages", "yandexmetrika",
    "apple-pubsub", "telegrambot", "twitterbot", "pinterestbot", "linkedinbot", "whatsapp", "discordbot",
    "slackbot", "screaming frog seo spider",
)
MONITOR_PATHS = ("/monitoring", "/monitoring/", "/health", "/health/", "/healthz", "/healthz/",
                 "/health/live", "/health/ready", "/ready", "/readyz", "/livez", "/metrics", "/metrics/")


class ProviderError(Exception):
    """Only static safe codes enter API responses; external response bodies never do."""


def _sdk_available():
    try:
        return importlib.util.find_spec("azure.identity") is not None
    except (ImportError, ValueError):
        return False


def _grafana_settings():
    url = os.getenv("TRAFFIC_GRAFANA_URL", "").rstrip("/")
    try:
        parsed = urlparse(url)
        allowed = (parsed.scheme == "https" and parsed.hostname == "ecom-grafana.test-magrabi.com"
                   and parsed.port in (None, 443) and not parsed.username and not parsed.password
                   and not parsed.path and not parsed.params and not parsed.query and not parsed.fragment)
    except ValueError:
        allowed = False
    if not allowed:
        raise ProviderError("source_not_configured")
    token = os.getenv("TRAFFIC_GRAFANA_TOKEN")
    user, password = os.getenv("TRAFFIC_GRAFANA_USERNAME"), os.getenv("TRAFFIC_GRAFANA_PASSWORD")
    if token:
        return url, {"Authorization": "Bearer " + token}, None
    if user and password:
        return url, {}, (user, password)
    raise ProviderError("source_not_configured")


def configured_sources():
    try:
        _grafana_settings()
        grafana = True
    except ProviderError:
        grafana = False
    explicit = tuple(os.getenv(k) for k in (
        "AZURE_MONITOR_TENANT_ID", "AZURE_MONITOR_CLIENT_ID", "AZURE_MONITOR_CLIENT_SECRET"))
    workload = all(os.getenv(k) for k in ("AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_FEDERATED_TOKEN_FILE"))
    environment = all(os.getenv(k) for k in ("AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"))
    azure = _sdk_available() and (all(explicit) if any(explicit) else workload or environment)
    return {source: azure if source in AZURE_RESOURCES else grafana for source in SOURCES}


def _azure_token():
    global _AZURE_CREDENTIAL, _AZURE_CREDENTIAL_KEY
    try:
        from azure.identity import ClientSecretCredential, DefaultAzureCredential
        names = ("AZURE_MONITOR_TENANT_ID", "AZURE_MONITOR_CLIENT_ID", "AZURE_MONITOR_CLIENT_SECRET")
        values = [os.getenv(n) for n in names]
        if any(values) and not all(values):
            raise ProviderError("source_not_configured")
        key = hashlib.sha256(json.dumps(values + [os.getenv(n) for n in (
            "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_FEDERATED_TOKEN_FILE"
        )]).encode()).digest()
        with _AZURE_CREDENTIAL_LOCK:
            if _AZURE_CREDENTIAL is None or _AZURE_CREDENTIAL_KEY != key:
                if all(values):
                    credential = ClientSecretCredential(*values, connection_timeout=5, read_timeout=20, retry_total=0)
                else:
                    credential = DefaultAzureCredential(exclude_interactive_browser_credential=True,
                        exclude_cli_credential=True, exclude_powershell_credential=True,
                        exclude_developer_cli_credential=True, exclude_shared_token_cache_credential=True,
                        exclude_visual_studio_code_credential=True,
                        connection_timeout=5, read_timeout=20, retry_total=0)
                _AZURE_CREDENTIAL, _AZURE_CREDENTIAL_KEY = credential, key
            # SDK caches tokens, avoiding a new authentication exchange for every hourly chunk.
            return _AZURE_CREDENTIAL.get_token("https://management.azure.com/.default").token
    except ProviderError:
        raise
    except ImportError:
        raise ProviderError("source_not_configured") from None
    except Exception:
        raise ProviderError("authentication_failed") from None


def _get_json(url, params, headers=None, auth=None):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ("management.azure.com", "ecom-grafana.test-magrabi.com"):
        raise ProviderError("invalid_source_url")
    for attempt in range(2):
        try:
            started = time.monotonic()
            with requests.get(url, params=params, headers=headers, auth=auth, timeout=(5, 25),
                              verify=True, allow_redirects=False, stream=True) as response:
                status = response.status_code
                if status in (408, 429, 500, 502, 503, 504) and attempt == 0:
                    time.sleep(0.15)
                    continue
                if status in (401, 403):
                    raise ProviderError("access_denied")
                if status != 200:
                    raise ProviderError("upstream_unavailable")
                content = bytearray()
                for chunk in response.iter_content(chunk_size=65536):
                    content.extend(chunk)
                    if len(content) > MAX_BYTES:
                        raise ProviderError("response_too_large")
                    if time.monotonic() - started > 30:
                        raise ProviderError("upstream_timeout")
                result = json.loads(content)
                if not isinstance(result, dict):
                    raise ProviderError("invalid_upstream_response")
                return result
        except ProviderError:
            raise
        except requests.RequestException:
            if attempt == 0:
                time.sleep(0.15)
                continue
            raise ProviderError("upstream_unavailable") from None
        except (ValueError, TypeError):
            raise ProviderError("invalid_upstream_response") from None
    raise ProviderError("upstream_unavailable")


def _integer(value):
    if isinstance(value, bool):
        raise ProviderError("invalid_upstream_response")
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError):
        raise ProviderError("invalid_upstream_response") from None
    if not math.isfinite(number) or number < 0 or not number.is_integer() or number > 2**53-1:
        raise ProviderError("invalid_upstream_response")
    return int(number)


def _iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _safe_scope(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", value):
        raise ProviderError("invalid_upstream_response")
    return value


def _row(scope, counts, total=None, unclassified=0, **extra):
    return {"scope": scope, "counts": dict(counts), "total": sum(counts.values()) if total is None else total,
            "unclassified": unclassified, **extra}


def _azure_series(body, start, end, metric_name):
    if body.get("nextLink") or body.get("@odata.nextLink"):
        raise ProviderError("response_truncated")
    try:
        echoed = [datetime.fromisoformat(v.replace("Z", "+00:00")) for v in body["timespan"].split("/")]
        if len(echoed) != 2 or any(v.tzinfo is None for v in echoed) or echoed != [start, end]:
            raise ValueError()
    except (KeyError, AttributeError, TypeError, ValueError):
        raise ProviderError("metric_timespan_mismatch") from None
    metrics = body.get("value")
    if not isinstance(metrics, list) or len(metrics) != 1:
        raise ProviderError("metric_data_missing")
    metric = metrics[0]
    if metric.get("name", {}).get("value") != metric_name:
        raise ProviderError("invalid_upstream_response")
    if metric.get("errorCode", "Success") != "Success":
        raise ProviderError("upstream_unavailable")
    if body.get("interval") not in (None, "PT1M"):
        raise ProviderError("metric_interval_mismatch")
    series = metric.get("timeseries")
    if not isinstance(series, list) or len(series) >= MAX_SERIES:
        raise ProviderError("response_truncated")
    rows = []
    for series_row in series:
        dims = {m["name"]["value"].lower(): m["value"] for m in series_row.get("metadatavalues", [])}
        bins = {}
        missing = False
        for point in series_row.get("data", []):
            try:
                at = datetime.fromisoformat(point["timeStamp"].replace("Z", "+00:00"))
            except (KeyError, TypeError, ValueError):
                raise ProviderError("invalid_upstream_response") from None
            if at.tzinfo is None:
                raise ProviderError("invalid_upstream_response")
            if not start <= at < end:
                continue
            if at in bins or at.second or at.microsecond:
                raise ProviderError("invalid_upstream_response")
            if point.get("total") is None:
                missing = True
                continue
            bins[at] = _integer(point["total"])
        rows.append((dims, bins, missing))
    return rows


def _azure_collect(source, start, end):
    group_mode = source == "macula_gateway"
    metric = "ResponseStatus" if group_mode else "RequestCount"
    dimension = "HttpStatusGroup" if group_mode else "HttpStatus"
    expected = int((end-start).total_seconds() // 60)
    headers = {"Authorization": "Bearer " + _azure_token()}
    url = "https://management.azure.com" + AZURE_RESOURCES[source] + "/providers/Microsoft.Insights/metrics"
    params = {"api-version": "2018-01-01", "metricnames": metric, "aggregation": "Total",
              "interval": "PT1M", "timespan": _iso(start)+"/"+_iso(end), "top": str(MAX_SERIES)}
    control = _azure_series(_get_json(url, params, headers), start, end, metric)
    observed = len(control[0][1]) if len(control) == 1 else 0
    if len(control) != 1 or control[0][0] or control[0][2] or observed != expected:
        return _missing(source, "metric_data_incomplete", expected, observed, partial=observed > 0)
    total = sum(control[0][1].values())
    split = _azure_series(_get_json(url, params | {"$filter": dimension + " eq '*'"}, headers), start, end, metric)
    counts = Counter()
    for dims, bins, missing in split:
        code = dims.get(dimension.lower(), "")
        if (group_mode and code not in GROUP_CODES) or (not group_mode and not re.fullmatch(r"0|[1-5][0-9]{2}", code)):
            raise ProviderError("invalid_upstream_response")
        if missing or len(bins) != expected or code in counts:
            return _missing(source, "metric_data_incomplete", expected, observed, partial=True)
        counts[code] = sum(bins.values())
    remainder = total - sum(counts.values())
    if remainder < 0 or (not group_mode and remainder != 0) or (total and not split):
        return _missing(source, "metric_reconciliation_failed", expected, observed, partial=True)
    for code in GROUP_CODES if group_mode else EXACT_ZERO_CODES:
        counts.setdefault(code, 0)
    rows = [_row("All traffic", counts, total=total, unclassified=remainder)]
    if not group_mode:
        details = _azure_series(_get_json(url, params | {"$filter": "Endpoint eq '*' and HttpStatus eq '*'"}, headers), start, end, metric)
        endpoints = defaultdict(Counter)
        seen = set()
        for dims, bins, missing in details:
            endpoint = _safe_scope(dims.get("endpoint"))
            code = dims.get("httpstatus", "")
            if not re.fullmatch(r"0|[1-5][0-9]{2}", code) or (endpoint, code) in seen:
                raise ProviderError("invalid_upstream_response")
            seen.add((endpoint, code))
            if missing or len(bins) != expected:
                return _missing(source, "metric_data_incomplete", expected, observed, partial=True)
            endpoints[endpoint][code] = sum(bins.values())
        detail_counts = Counter()
        for values in endpoints.values():
            detail_counts.update(values)
        if detail_counts != +counts:
            # Counter equality treats zero-valued keys as absent on supported Python versions.
            if any(detail_counts[k] != counts[k] for k in set(detail_counts) | set(counts)):
                return _missing(source, "metric_reconciliation_failed", expected, observed, partial=True)
        rows.extend(_row("Endpoint: " + key, value) for key, value in sorted(endpoints.items()))
    return {"status": "complete", "rows": rows, "notes": list(SOURCES[source]["notes"]),
            "coverage": {"expected": expected, "observed": observed}}


def _contains(terms):
    return "or " + " ".join('(contains ' + json.dumps(term) + ' $ua)' for term in terms)


def _classifier():
    paths = "or " + " ".join('(eq .request_path ' + json.dumps(path) + ')' for path in MONITOR_PATHS)
    return ('{{$ua := lower .request_ua}}{{if or (' + _contains(MONITOR_UAS) + ') (' + paths + ')}}monitoring_telemetry'
            '{{else if or (eq $ua "node") (' + _contains(AUTOMATION_UAS) + ')}}internal_or_script_automation'
            '{{else if ' + _contains(BOT_UAS) + '}}declared_bot_or_crawler'
            '{{else if contains "mozilla/" $ua}}retained_browser_like{{else}}retained_unknown{{end}}')


def _loki_query(filtered, seconds):
    parse = '| regexp `' + STATUS_RE + '` | regexp `' + BACKEND_RE + '` | http_code!=""'
    selector = '{job="ingress-nginx-access"}'
    group = "http_code,backend"
    if filtered:
        pattern = "|".join(BACKEND_BRANDS)
        selector += ' |~ `\\[(' + pattern + ')\\]`'
        parse += ' | backend=~`' + pattern + '` | regexp `' + PATH_RE + '` | regexp `' + UA_RE + '`'
        parse += ' | label_format traffic_class=`' + _classifier() + '`'
        group += ",traffic_class"
    return 'sum by(' + group + ')(count_over_time(' + selector + ' ' + parse + ' [' + str(seconds) + 's]))'


def _loki_collect(source, start, end):
    filtered = source == "filtered_storefront"
    url, headers, auth = _grafana_settings()
    duration = int((end-start).total_seconds())
    # Integer arithmetic avoids float rounding of nanosecond timestamps.
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    end_ns = ((end-epoch).days * 86400 + (end-epoch).seconds) * 10**9 - 1
    body = _get_json(url + "/api/datasources/proxy/uid/loki/loki/api/v1/query",
        {"query": _loki_query(filtered, duration), "time": str(end_ns)}, headers, auth)
    if body.get("status") != "success" or body.get("error") or body.get("warnings"):
        raise ProviderError("log_query_incomplete")
    data = body.get("data", {})
    results = data.get("result")
    if data.get("resultType") != "vector" or not isinstance(results, list):
        raise ProviderError("invalid_upstream_response")
    if not results:
        # An empty log response is not proof of zero traffic or intact ingestion.
        return _missing(source, "log_data_missing", 1, 0)
    if len(results) >= MAX_SERIES:
        raise ProviderError("response_truncated")
    counts = Counter()
    details = defaultdict(Counter)
    scoped = Counter()
    class_counts = defaultdict(Counter)
    seen = set()
    for item in results:
        labels = item.get("metric", {})
        code = labels.get("http_code", "")
        if not re.fullmatch(r"[1-5][0-9]{2}", code):
            raise ProviderError("invalid_upstream_response")
        backend = _safe_scope(labels.get("backend") or "UNKNOWN")
        value = item.get("value", [])
        if not isinstance(value, list) or len(value) != 2:
            raise ProviderError("invalid_upstream_response")
        try:
            stamp = float(value[0])
            if not math.isfinite(stamp) or abs(stamp - end_ns / 10**9) > 1:
                raise ProviderError("query_time_mismatch")
        except (TypeError, ValueError, OverflowError):
            raise ProviderError("invalid_upstream_response") from None
        number = _integer(value[1])
        cls = labels.get("traffic_class", "")
        key = (backend, code, cls)
        if key in seen:
            raise ProviderError("invalid_upstream_response")
        seen.add(key)
        if filtered:
            if backend not in BACKEND_BRANDS or cls not in CLASSES:
                raise ProviderError("invalid_upstream_response")
            brand = BACKEND_BRANDS[backend]
            details[(brand, cls)][code] += number
            class_counts[cls][code] += number
            scoped[code] += number
            if cls.startswith("retained_"):
                counts[code] += number
        else:
            counts[code] += number
            details[backend][code] += number
    for code in EXACT_ZERO_CODES:
        counts.setdefault(code, 0)
    rows = [_row("All traffic", counts)]
    if filtered:
        rows[0]["trafficClass"] = "retained"
        for cls in CLASSES:
            rows.append(_row("Class: " + CLASS_LABELS[cls], class_counts[cls], trafficClass=cls))
        brands = sorted({key[0] for key in details})
        for brand in brands:
            for cls in CLASSES:
                rows.append(_row(brand + " / " + CLASS_LABELS[cls], details[(brand, cls)], trafficClass=cls))
    else:
        rows.extend(_row("Backend: " + backend, value) for backend, value in sorted(details.items()))
    notes = list(SOURCES[source]["notes"])
    if filtered:
        notes.append("Filter version: " + FILTER_VERSION)
    return {"status": "complete", "rows": rows, "notes": notes,
            "coverage": {"expected": 1, "observed": 1}}


def _missing(source, error, expected=1, observed=0, partial=False):
    codes = GROUP_CODES if source == "macula_gateway" else EXACT_ZERO_CODES
    return {"status": "partial" if partial else "unavailable",
            "rows": [{"scope": "All traffic", "counts": {code: None for code in codes},
                      "total": None, "unclassified": None}],
            "notes": list(SOURCES.get(source, {}).get("notes", [])) + ["Missing data is not zero traffic."],
            "coverage": {"expected": expected, "observed": observed}, "error": error}


def collect(source_id, start, end):
    if source_id not in SOURCES:
        return _missing(source_id, "unknown_source")
    try:
        if not isinstance(start, datetime) or not isinstance(end, datetime) or start.tzinfo is None or end.tzinfo is None:
            raise ProviderError("invalid_window")
        start, end = start.astimezone(timezone.utc), end.astimezone(timezone.utc)
        seconds = (end-start).total_seconds()
        if not 0 < seconds <= 3600 or start.microsecond or end.microsecond:
            raise ProviderError("invalid_window")
        if source_id in AZURE_RESOURCES:
            if start.second or end.second or seconds % 60:
                raise ProviderError("minute_aligned_window_required")
            return _azure_collect(source_id, start, end)
        return _loki_collect(source_id, start, end)
    except ProviderError as exc:
        return _missing(source_id, str(exc))
    except Exception:
        # No parser, SDK, network or credential detail may leak through API error messages.
        return _missing(source_id, "provider_failed")
