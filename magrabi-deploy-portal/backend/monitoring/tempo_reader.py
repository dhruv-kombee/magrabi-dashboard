"""Bounded GET-only portal Tempo adapter with an injected authenticated HTTP session.

No credential loading, connection at construction, logger, retries, redirects, global session,
or arbitrary URL/query support. Calling this adapter IS a live read if given a real session;
tests provide fake responses and prohibit socket creation. Not wired into the running portal.
"""
from __future__ import annotations

import re
import threading
import time
from urllib.parse import urlsplit

from .trace_model import MAX_BYTES, validate_trace_id

LOWER_GRAFANA_HOST = "grafana-lower.test-magrabi.com"
CLUSTER_TEMPO_ORIGIN = "http://tempo.observability.svc.cluster.local:3200"


class TraceBackendError(RuntimeError):
    pass


class TempoTraceReader:
    def __init__(self, *, get, base_url: str, datasource_uid="tempo-lower", concurrency=1, clock=time.monotonic, transport="grafana"):
        if not callable(get) or not callable(clock):
            raise ValueError("injected_http_get_and_clock_required")
        if not isinstance(base_url, str):
            raise ValueError("invalid_tempo_origin")
        parsed = urlsplit(base_url)
        if transport not in ("grafana", "cluster"):
            raise ValueError("invalid_tempo_transport")
        expected_origin = "https://" + LOWER_GRAFANA_HOST if transport == "grafana" else CLUSTER_TEMPO_ORIGIN
        if (base_url.rstrip("/") != expected_origin or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
            raise ValueError("invalid_tempo_origin")
        # Phase one is intentionally the single verified Lower Tempo datasource. Keeping it
        # fixed also prevents the reader and Grafana split-view links from selecting different
        # trace stores. A datasource migration must update the shared integration contract.
        if datasource_uid != "tempo-lower":
            raise ValueError("unsupported_datasource_uid")
        if type(concurrency) is not int or concurrency not in (1, 2):
            raise ValueError("invalid_concurrency_limit")
        self._get = get
        self._url_prefix = (expected_origin + "/api/datasources/proxy/uid/" + datasource_uid + "/api/traces/"
            if transport == "grafana" else expected_origin + "/api/traces/")
        self._slots = threading.BoundedSemaphore(concurrency)
        self._clock = clock

    def __call__(self, trace_id, *, environment, max_bytes=MAX_BYTES, timeout_seconds=10):
        trace_id = validate_trace_id(trace_id)
        if environment != "sit":
            raise TraceBackendError("unsupported_environment")
        if type(max_bytes) is not int or not 1 <= max_bytes <= MAX_BYTES:
            raise TraceBackendError("invalid_read_limit")
        if type(timeout_seconds) is not int or not 1 <= timeout_seconds <= 15:
            raise TraceBackendError("invalid_read_timeout")
        if not self._slots.acquire(blocking=False):
            raise TraceBackendError("trace_reader_busy")
        response = None
        deadline = self._clock() + timeout_seconds
        try:
            # The isolated runtime supplies http_transport with an async whole-stream timeout.
            # Other injected transports must enforce their own total deadline; these elapsed
            # checks alone cannot interrupt a blocking GET or chunk read.
            response = self._get(self._url_prefix + trace_id, headers={"Accept": "application/json"},
                allow_redirects=False, stream=True, timeout=(min(3, timeout_seconds), timeout_seconds))
            if self._clock() >= deadline:
                raise TraceBackendError("trace_read_deadline")
            if response.status_code == 404:
                return None
            if response.status_code != 200:
                raise TraceBackendError("trace_read_http_error")
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if content_type != "application/json":
                raise TraceBackendError("trace_read_content_type")
            length = response.headers.get("Content-Length")
            if length is not None and (not re.fullmatch(r"[0-9]{1,12}", length) or int(length) > max_bytes):
                raise TraceBackendError("trace_read_size_limit")
            body = bytearray()
            for chunk in response.iter_content(chunk_size=8192):
                if self._clock() >= deadline:
                    raise TraceBackendError("trace_read_deadline")
                if not chunk:
                    continue
                if not isinstance(chunk, bytes) or len(body) + len(chunk) > max_bytes:
                    raise TraceBackendError("trace_read_size_limit")
                body.extend(chunk)
            if self._clock() >= deadline:
                raise TraceBackendError("trace_read_deadline")
            return bytes(body)
        except TraceBackendError:
            raise
        except Exception:
            # Transport exceptions may include credential-bearing URLs or response content.
            raise TraceBackendError("trace_read_failed") from None
        finally:
            try:
                if response is not None:
                    response.close()
            except Exception:
                pass
            self._slots.release()
